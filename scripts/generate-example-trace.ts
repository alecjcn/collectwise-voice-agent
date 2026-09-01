// Generates a real end-to-end trace by driving the agents through a scripted
// text conversation (same machinery as the evals). Writes the JSONL trace to
// examples/. Usage: node scripts/generate-example-trace.ts
import { inference, initializeLogger, voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { createVerificationAgent } from '../src/agents/verificationAgent.ts';
import { openDb } from '../src/db/db.ts';
import { Repository } from '../src/db/repository.ts';
import { seedIfEmpty } from '../src/db/seed.ts';
import { type CallState, createCallState } from '../src/state.ts';
import { Tracer } from '../src/trace.ts';

dotenv.config({ path: '.env.local' });
initializeLogger({ pretty: false, level: 'error' });

const repo = new Repository(openDb(':memory:'));
seedIfEmpty(repo);

const callId = 'example-negotiated-plan';
const trace = new Tracer({ callId, dir: 'examples', silent: true });
const state: CallState = createCallState({ callId, repo, trace });

const llm = new inference.LLM({ model: process.env.LLM_MODEL ?? 'google/gemma-4-31b-it' });
const session = new voice.AgentSession<CallState>({ userData: state, llm });

session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
  if ('role' in ev.item && ev.item.textContent) {
    trace.event('transcript', { role: ev.item.role, text: ev.item.textContent });
  }
});

trace.event('call_started', { room: 'example' });
await session.start({ agent: createVerificationAgent() });

const turns = [
  'Hi, I got a letter from you about my account. My account number is ATL-1001.',
  'Yes, this is Maria. Maria Gonzalez, and the last four of my social are 7301.',
  "Oh wow, that's a lot. There's no way I can pay all of that today.",
  'Even three months is too much for me right now. I could maybe do about two hundred fifty a month.',
  'Yes, ten months works. Let’s do that.',
];

for (const userInput of turns) {
  console.log(`USER: ${userInput}`);
  const result = await session.run({ userInput }).wait();
  for (const event of result.events) {
    if (event.type === 'message' && event.item.role === 'assistant') {
      console.log(`NANCY: ${event.item.textContent}`);
    }
  }
}

trace.event('call_ended', {});
await session.close();
await llm.aclose();
console.log(`\nTrace written to examples/trace-${callId}.jsonl`);
console.log('Outcomes:', repo.listOutcomes(callId));
console.log('Plans:', state.accountId !== undefined ? repo.listPaymentPlans(state.accountId) : []);
