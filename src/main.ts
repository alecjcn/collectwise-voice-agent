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

/**
 * Build the voice session for one call: STT, LLM, and TTS on LiveKit
 * Inference (the `*_MODEL` / `TTS_VOICE` env vars override each stage).
 * Turn handling favors correctness over snappiness - preemptive generation
 * is off and endpointing gets an extra beat so spoken numbers (accounts,
 * amounts) coalesce before a turn commits.
 *
 * @param userData - The call's state, exposed to every tool via `ctx.userData`.
 */
function createSession(userData: CallState): voice.AgentSession<CallState> {
  // Would use a factory pattern and langfuse configs or configs set in trunk metadata to
  // determine the tts, stt, etc in production to avoid redeployment and enable faster testing
  return new voice.AgentSession<CallState>({
    userData,
    llm: new inference.LLM({ model: process.env.LLM_MODEL ?? 'openai/gpt-4.1-mini' }),
    stt: new inference.STT({
      model: process.env.STT_MODEL ?? 'assemblyai/universal-3-5-pro',
      language: 'en',
    }),
    tts: new inference.TTS({
      model: process.env.TTS_MODEL ?? 'fishaudio/s2.1-pro',
      voice: process.env.TTS_VOICE ?? '9a9cf47702da476aa4629e2506d4a857',
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

/**
 * Per-call entrypoint. Lifecycle: create the trace and call state → wire
 * session events (transcript mirroring, close → room teardown) → register
 * the outcome fallback → resolve caller ID → start in the unverified
 * verification agent → speak the greeting.
 */
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

    // When the session closes, delete the room and end the job immediately.
    // Both matter for rejoining the same link: the stale room must go so a
    // rejoin creates a fresh room, and the job must end promptly because Cloud
    // dispatch dedupes a recreated room name against a still-live job (the job
    // otherwise lingers ~40s uploading its session report, during which
    // rejoins get no agent).
    session.on(voice.AgentSessionEventTypes.Close, () => {
      void ctx.deleteRoom().catch(() => {});
      ctx.shutdown('session closed');
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
        ? `Greet the caller warmly in one natural line that introduces you and confirms the right party, for example: "Hello, this is Nancy from Alpha Bank - am I speaking with ${account.debtorName}?" Do not mention any account details or why you are asking.`
        : 'Greet the caller warmly, for example: "Hello, this is Nancy from Alpha Bank. Who am I speaking with today, and how can I help you?" Do not mention any account details.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
