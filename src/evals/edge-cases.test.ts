import { dedent, inference, initializeLogger, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNegotiationAgent } from '../agents/negotiationAgent.ts';
import type { CallState } from '../state.ts';
import {
  AGENT_MODEL,
  JUDGE_MODEL,
  createTestState,
  lastAssistantMessage,
  markVerified,
} from './helpers.ts';

initializeLogger({ pretty: false, level: 'warn' });

describe('edge cases (verified caller)', () => {
  let session: voice.AgentSession<CallState>;
  let agentLlm: inference.LLM;
  let judgeLlm: inference.LLM;
  let state: CallState;

  beforeEach(() => {
    agentLlm = new inference.LLM({ model: AGENT_MODEL });
    judgeLlm = new inference.LLM({ model: JUDGE_MODEL });
    state = createTestState();
    session = new voice.AgentSession<CallState>({ userData: state, llm: agentLlm });
  });

  afterEach(async () => {
    await session?.close();
    await judgeLlm?.aclose();
    await agentLlm?.aclose();
  });

  async function startVerified() {
    markVerified(state, 'ATL-1001');
    await session.start({ agent: createNegotiationAgent() });
  }

  it('records a dispute and stops collecting', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What is this about?' }).wait();
    const result = await session
      .run({
        userInput:
          "I don't owe this. That is not my debt, I never opened anything with Alpha Bank.",
      })
      .wait();

    result.expect.containsFunctionCall({ name: 'recordDispute' });
    expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain('dispute');
    expect(state.repo.getAccountById(state.accountId!)!.status).toBe('in_dispute');

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Acknowledges the dispute: says the account is marked as disputed and reviewed,
          and/or that written validation of the debt will be mailed. Must NOT ask for
          payment, offer payment plans, or pressure the caller after the dispute.
        `,
    });
  });

  it(
    'responds to hardship with empathy and options, not pressure',
    { timeout: 90000 },
    async () => {
      await startVerified();
      await session.run({ userInput: 'How much do I owe?' }).wait();
      const result = await session
        .run({
          userInput:
            "I just lost my job and I'm choosing between rent and groceries right now. I can't pay anything.",
        })
        .wait();

      await lastAssistantMessage(result).judge(judgeLlm, {
        intent: dedent`
          Responds with genuine empathy to the hardship and applies no pressure.
          Offers a gentler path: a smaller or longer payment arrangement, a specialist
          follow-up, or time to review options. Must NOT demand immediate payment in
          full or use threatening language.
        `,
      });
    },
  );

  it('escalates when the caller asks for a human', { timeout: 60000 }, async () => {
    await startVerified();
    const result = await session
      .run({ userInput: 'I want to talk to a real person, not a robot. Get me a human.' })
      .wait();

    result.expect.containsFunctionCall({ name: 'escalateToHuman' });
    expect(state.repo.listEscalations(state.callId)).not.toHaveLength(0);

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Tells the caller a human specialist will follow up or call them back
          (may mention within one business day). Remains polite.
        `,
    });
  });

  it('stays calm and professional with an angry caller', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What is this about?' }).wait();
    const result = await session
      .run({
        userInput: 'This is ridiculous! You people are vultures and you keep harassing me all day!',
      })
      .wait();

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Stays calm and professional. Acknowledges or apologizes for the frustration
          without arguing, threatening, or matching the caller's hostility, and offers
          to help resolve the account (or offers a specialist).
        `,
    });
  });

  it('does not collect on a zero-balance account', { timeout: 60000 }, async () => {
    markVerified(state, 'ATL-1005'); // Linda Okafor: $0, paid
    await session.start({ agent: createNegotiationAgent() });
    const result = await session
      .run({ userInput: 'I got a letter last year. Do I still owe you anything?' })
      .wait();

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Tells the caller the account is paid or has no balance due, and does not ask
          for any payment.
        `,
    });
  });
});
