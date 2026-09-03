import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createVerificationAgent } from './agents/verificationAgent.ts';
import { openDb } from './db/db.ts';
import { Repository } from './db/repository.ts';
import { DEFAULT_DB_PATH, seedIfEmpty } from './db/seed.ts';
import type { CallState } from './state.ts';
import { createCallState, locateCallerByPhone } from './state.ts';
import { Tracer } from './trace.ts';

dotenv.config({ path: '.env.local' });

// One process-wide database connection; each call gets its own CallState.
const repo = new Repository(openDb(DEFAULT_DB_PATH));
seedIfEmpty(repo);

/**
 * The caller's phone number: the `sip.phoneNumber` participant attribute on
 * telephony calls, or the INCOMING_NUMBER env var as a mock for browser and
 * local testing. Undefined when neither is available.
 */
function resolveIncomingNumber(participant: RemoteParticipant): string | undefined {
  const sipNumber =
    participant.kind === ParticipantKind.SIP
      ? participant.attributes['sip.phoneNumber']
      : undefined;
  return sipNumber ?? process.env.INCOMING_NUMBER;
}

/** Voice pipeline on LiveKit Inference; LLM_MODEL and STT_MODEL env vars override. */
function createSession(userData: CallState): voice.AgentSession<CallState> {
  return new voice.AgentSession<CallState>({
    userData,
    llm: new inference.LLM({ model: process.env.LLM_MODEL ?? 'openai/gpt-4.1-mini' }),
    stt: new inference.STT({
      model: process.env.STT_MODEL ?? 'assemblyai/universal-3-5-pro',
      language: 'en',
    }),
    tts: new inference.TTS({
      model: process.env.TTS_MODEL ?? 'fishaudio/s2.1-pro',
      voice: process.env.TTS_VOICE ?? 'fa4c9eb3dccc4806b382b40d61c6b10a',
    }),
    turnHandling: {
      turnDetection: new inference.TurnDetector(),
      interruption: { mode: 'adaptive' },
      // Correctness over snappiness: replies generate only from committed
      // turns, and dictation pauses (account numbers, dollar amounts) get an
      // extra beat to coalesce before the turn commits. Preemptive generation
      // kept producing replies to half-spoken amounts.
      preemptiveGeneration: { enabled: false },
      endpointing: { minDelay: 800 },
    },
    // Expressive mode lets the LLM emit inline delivery tags for the TTS.
    expressive: true,
  });
}

export default defineAgent({
  entry: async (ctx) => {
    const callId = `${ctx.room.name ?? 'room'}-${Date.now()}`;
    const trace = new Tracer(callId, { dir: process.env.TRACE_DIR ?? 'logs' });
    trace.event('call_started', { room: ctx.room.name });

    const userData = createCallState({ callId, repo, trace });
    const session = createSession(userData);

    // Mirror both sides of the conversation into the trace.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if ('role' in ev.item && ev.item.textContent) {
        trace.event('transcript', { role: ev.item.role, text: ev.item.textContent });
      }
    });

    // Every call must end with exactly one outcome row, even on a hang-up.
    ctx.addShutdownCallback(async () => {
      if (!userData.outcomeRecorded) {
        const outcome = userData.escalated ? 'escalated' : 'incomplete';
        repo.recordOutcome({
          callId,
          accountId: userData.account?.id,
          outcome,
          notes: 'Auto-recorded at call end',
        });
        trace.event('outcome', { outcome, auto: true });
      }
      trace.event('call_ended', {});
    });

    // Identify the caller by phone number before the conversation starts. A
    // match lets Nancy open with right-party confirmation; otherwise she asks
    // for an account number. Caller ID locates but never verifies.
    await ctx.connect();
    let incomingNumber: string | undefined;
    try {
      incomingNumber = resolveIncomingNumber(await ctx.waitForParticipant());
    } catch {
      // Console mode has no room connection; use the INCOMING_NUMBER mock.
      incomingNumber = process.env.INCOMING_NUMBER;
    }
    const account = incomingNumber ? locateCallerByPhone(userData, incomingNumber) : undefined;

    // Calls always begin in the unverified state.
    await session.start({
      agent: createVerificationAgent(account ? { locatedName: account.debtorName } : undefined),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: audioEnhancement({ model: 'quailVfS' }),
      },
    });

    session.generateReply({
      instructions: account
        ? `Greet the caller: introduce yourself as Nancy from Alpha Bank and politely ask whether you are speaking with ${account.debtorName}. Do not mention any account details or why you are asking.`
        : 'Greet the caller: introduce yourself as Nancy from Alpha Bank, ask who you are speaking with, and ask how you can help them today. Do not mention any account details.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
