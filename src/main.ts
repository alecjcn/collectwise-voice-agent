import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import { ParticipantKind } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createVerificationAgent } from './agents/verificationAgent.ts';
import { openDb } from './db/db.ts';
import { Repository } from './db/repository.ts';
import { DEFAULT_DB_PATH, seedIfEmpty } from './db/seed.ts';
import type { CallState } from './state.ts';
import { createCallState, locateCallerByPhone } from './state.ts';
import { Tracer } from './trace.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

// One process-wide database connection; each call gets its own CallState.
const repo = new Repository(openDb(DEFAULT_DB_PATH));
const seeded = seedIfEmpty(repo);
if (seeded > 0) console.log(`Seeded ${seeded} sample accounts into ${DEFAULT_DB_PATH}`);

export default defineAgent({
  entry: async (ctx) => {
    const callId = `${ctx.room.name ?? 'room'}-${Date.now()}`;
    const trace = new Tracer({ callId, dir: process.env.TRACE_DIR ?? 'logs' });
    trace.event('call_started', { room: ctx.room.name });

    const userData = createCallState({ callId, repo, trace });

    // Voice AI pipeline on LiveKit Inference: AssemblyAI STT, Gemma LLM,
    // Fish Audio TTS, and the LiveKit turn detector.
    const session = new voice.AgentSession<CallState>({
      userData,

      llm: new inference.LLM({ model: process.env.LLM_MODEL ?? 'google/gemma-4-31b-it' }),

      stt: new inference.STT({
        model: 'assemblyai/universal-3-5-pro',
        language: 'en',
      }),

      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
      }),

      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        interruption: { mode: 'adaptive' },
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode lets the LLM emit inline delivery tags that the Fish
      // Audio TTS renders (emotion, pacing) without showing in transcripts.
      expressive: true,
    });

    // Mirror the conversation into the trace for post-call review.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if ('role' in ev.item && ev.item.textContent) {
        trace.event('transcript', { role: ev.item.role, text: ev.item.textContent });
      }
    });

    // If the caller hangs up before a disposition is recorded, record one so
    // every call has exactly one outcome row.
    ctx.addShutdownCallback(async () => {
      if (!userData.outcomeRecorded) {
        const outcome = userData.escalated ? 'escalated' : 'incomplete';
        repo.recordOutcome({
          callId,
          accountId: userData.accountId,
          outcome,
          notes: 'Auto-recorded at call end',
        });
        trace.event('outcome', { outcome, auto: true });
      }
      trace.event('call_ended', {});
    });

    // Join the room, then identify the caller before the session starts.
    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    // Caller ID: real telephony calls carry the caller's number as the
    // sip.phoneNumber participant attribute; for browser/dev calls, the
    // INCOMING_NUMBER env var mocks it. If the number matches an account,
    // prefill the account id + first name (nothing more) so Nancy can go
    // straight to right-party confirmation. Unknown numbers fall back to
    // asking for an account number or the phone number on file.
    const sipNumber =
      participant.kind === ParticipantKind.SIP
        ? participant.attributes['sip.phoneNumber']
        : undefined;
    const incomingNumber = sipNumber ?? process.env.INCOMING_NUMBER;
    const locatedAccount = incomingNumber
      ? locateCallerByPhone(userData, incomingNumber)
      : undefined;

    // Calls always begin in the unverified state.
    await session.start({
      agent: createVerificationAgent(
        userData.debtorFirstName ? { locatedFirstName: userData.debtorFirstName } : undefined,
      ),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        noiseCancellation: audioEnhancement({ model: 'quailVfS' }),
      },
    });

    // Greet the caller on joining
    session.generateReply({
      instructions: locatedAccount
        ? `Greet the caller: introduce yourself as Nancy from Alpha Bank and politely ask whether you are speaking with ${userData.debtorFirstName}. Do not mention any account details or why you are asking.`
        : 'Greet the caller: introduce yourself as Nancy from Alpha Bank and ask how you can help them today. Do not mention any account details.',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
  }),
);
