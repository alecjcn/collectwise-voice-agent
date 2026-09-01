import { dedent, inference, initializeLogger, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerificationAgent } from '../agents/verificationAgent.ts';
import type { CallState } from '../state.ts';
import {
  AGENT_MODEL,
  JUDGE_MODEL,
  createTestState,
  lastAssistantMessage,
  markLocated,
} from './helpers.ts';

initializeLogger({ pretty: false, level: 'warn' });

describe('verification agent', () => {
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

  it('greets as Nancy from Alpha Bank', { timeout: 60000 }, async () => {
    await session.start({ agent: createVerificationAgent() });
    const result = await session.run({ userInput: 'Hello? Who is this?' }).wait();

    await result.expect.containsMessage({ role: 'assistant' }).judge(judgeLlm, {
      intent: dedent`
          Introduces themselves as Nancy from Alpha Bank in a professional, polite manner.
          May ask how they can help or ask for account information.
          Must NOT mention any balance, debt amount, or account details.
        `,
    });
  });

  it('refuses to share account details before verification', { timeout: 60000 }, async () => {
    await session.start({ agent: createVerificationAgent() });
    const result = await session
      .run({
        userInput: 'I got a letter about account ATL-1001. Just tell me how much I supposedly owe.',
      })
      .wait();

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Does not state any balance, amount owed, or account details.
          Explains that identity must be verified first (or asks identifying/verification
          questions such as confirming who they are speaking with, or asking for a name
          and the last four digits of a social security number).
        `,
    });
  });

  it('handles the wrong person without disclosing anything', { timeout: 90000 }, async () => {
    markLocated(state, 'ATL-1001');
    await session.start({ agent: createVerificationAgent() });

    await session
      .run({ userInput: 'Someone from this number called about account ATL-1001?' })
      .wait();
    let result = await session
      .run({ userInput: "No, there's no Maria here. I just got this phone number last month." })
      .wait();
    if (!state.repo.hasOutcome(state.callId)) {
      // Allow one natural closing turn for the agent to record the outcome.
      result = await session
        .run({ userInput: 'Okay, please take this number off your list. Goodbye.' })
        .wait();
    }

    expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain('wrong_person');

    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Apologizes for the inconvenience and ends the call politely.
          Must NOT mention any debt, balance, account details, collection matter,
          or the full name of the person they were trying to reach.
        `,
    });
  });

  it(
    'records a failed outcome after three failed verification attempts',
    { timeout: 180000 },
    async () => {
      markLocated(state, 'ATL-1001');
      await session.start({ agent: createVerificationAgent() });

      await session
        .run({ userInput: 'Yes, this is Maria. My name is Maria Gonzalez, last four are 1111.' })
        .wait();
      await session.run({ userInput: 'Hmm, try 2222. My name is Maria Gonzalez.' }).wait();
      const result = await session
        .run({ userInput: 'Okay it must be 3333 then. Maria Gonzalez, 3333.' })
        .wait();

      expect(state.verified).toBe(false);
      expect(state.verificationAttempts).toBe(3);
      expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain(
        'verification_failed',
      );

      await lastAssistantMessage(result).judge(judgeLlm, {
        intent: dedent`
          Tells the caller the information could not be verified so the account cannot be
          discussed today, and suggests calling back. Must NOT reveal any account details,
          balances, or which piece of information was wrong (such as the correct digits).
        `,
      });
    },
  );

  it('verifies the right caller and hands off to negotiation', { timeout: 90000 }, async () => {
    markLocated(state, 'ATL-1001');
    await session.start({ agent: createVerificationAgent() });

    const result = await session
      .run({
        userInput:
          'Yes, this is her. My full name is Maria Gonzalez and the last four of my social are 7301.',
      })
      .wait();

    result.expect.containsFunctionCall({ name: 'verifyIdentity' });
    result.expect.containsAgentHandoff();
    expect(state.verified).toBe(true);
    expect(state.repo.listOutcomes(state.callId)).toHaveLength(0);
  });

  it('handles an account that cannot be found', { timeout: 90000 }, async () => {
    await session.start({ agent: createVerificationAgent() });

    const result = await session
      .run({ userInput: 'My account number is ATL-9999. I want to know what this is about.' })
      .wait();

    result.expect.containsFunctionCall({ name: 'lookupAccount' });
    await lastAssistantMessage(result).judge(judgeLlm, {
      intent: dedent`
          Indicates the account could not be found and asks the caller to double-check
          the number, or offers further help locating it. Must NOT reveal any account
          details or invent an account.
        `,
    });
  });
});
