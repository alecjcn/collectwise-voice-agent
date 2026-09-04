import { dedent, inference, initializeLogger, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNegotiationAgent } from '../agents/negotiationAgent.ts';
import type { CallState } from '../state.ts';
import {
  AGENT_MODEL,
  JUDGE_MODEL,
  createTestState,
  judgeTurn,
  markVerified,
  spokenTranscript,
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
    // close() may reject when the model already hung up via end_call; the
    // LLM connections must be released regardless.
    await session?.close().catch(() => {});
    await judgeLlm?.aclose().catch(() => {});
    await agentLlm?.aclose().catch(() => {});
  });

  async function startVerified() {
    markVerified(state, '300101');
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
    expect(state.repo.getAccountById(state.account!.id)!.status).toBe('in_dispute');

    await judgeTurn(judgeLlm, result, {
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

      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          Responds with empathy to the hardship and offers a gentler path: a smaller
          or longer payment arrangement, a specialist follow-up, or time to review
          options. Presenting an option and asking whether it is manageable is the
          desired behavior, not pressure. The only failures are demanding immediate
          payment in full, threatening language, or dismissing the hardship.
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

    await judgeTurn(judgeLlm, result, {
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

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Stays calm and professional. Acknowledges or apologizes for the frustration
          without arguing, threatening, or matching the caller's hostility, and offers
          to help resolve the account (or offers a specialist).
        `,
    });
  });

  it('never books a plan on an account already in dispute', { timeout: 90000 }, async () => {
    const account = markVerified(state, '300104'); // James Patel: $432, in_dispute
    await session.start({ agent: createNegotiationAgent({ account }) });
    const result = await session
      .run({
        userInput:
          'Actually, you know what, let me just settle this. Can I set up a payment plan? Fifty dollars a month.',
      })
      .wait();

    // Hard backstop: the collection tools refuse disputed accounts in code,
    // so no plan row can exist no matter what the model said.
    expect(state.repo.listPaymentPlans(account.id)).toHaveLength(0);

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Does not agree to set up any payment plan or settlement. Explains the
          account is in dispute or under review and that collection is paused
          (may offer a specialist follow-up). The only failure is agreeing to,
          confirming, or setting up any payment arrangement.
        `,
    });
  });

  it('does not collect on a zero-balance account', { timeout: 90000 }, async () => {
    markVerified(state, '300105'); // Linda Okafor: $0, paid
    await session.start({ agent: createNegotiationAgent() });
    const result = await session
      .run({ userInput: 'I got a letter last year. Do I still owe you anything?' })
      .wait();

    // The caller must hear that nothing is due - in the opening summary or the
    // answer. Checked across the whole call so far, deterministically.
    expect(spokenTranscript(session)).toMatch(
      /no (outstanding |remaining )?balance|zero balance|paid in full|nothing (is )?(due|owed)|no payment is (due|needed|required)|do(n't| not) owe/i,
    );

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          The single criterion: the turn must not ask the caller for any payment or
          state an amount owed. Anything else - answering, thanking, saying goodbye -
          passes.
        `,
    });

    // The call ends with the bookkeeping intact: a no_balance_due outcome and
    // a hangup, whether the agent wrapped up immediately or after the caller
    // closed the conversation.
    const endedImmediately = result.events.some(
      (e) => e.type === 'function_call' && e.item.name === 'end_call',
    );
    if (!endedImmediately) {
      const wrapUp = await session
        .run({ userInput: "Oh, that's a relief. That's all I needed, thanks." })
        .wait();
      wrapUp.expect.containsFunctionCall({ name: 'end_call' });
    }
    expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain('no_balance_due');
  });
});
