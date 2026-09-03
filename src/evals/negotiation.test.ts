import { dedent, inference, initializeLogger, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNegotiationAgent } from '../agents/negotiationAgent.ts';
import type { CallState } from '../state.ts';
import { AGENT_MODEL, JUDGE_MODEL, createTestState, judgeTurn, markVerified } from './helpers.ts';

initializeLogger({ pretty: false, level: 'warn' });

// Seed account ATL-1001 (Maria Gonzalez): $2,489.75, delinquent.

describe('negotiation agent', () => {
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
    markVerified(state, 'ATL-1001');
    await session.start({ agent: createNegotiationAgent() });
  }

  it(
    'explains the balance from injected account context without a tool round-trip',
    { timeout: 60000 },
    async () => {
      // Post-verification path: the handoff passes the account into the agent
      // factory, so the details live in its instructions.
      const account = markVerified(state, 'ATL-1001');
      await session.start({ agent: createNegotiationAgent({ account }) });

      const result = await session.run({ userInput: 'Okay, so what exactly do I owe?' }).wait();

      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          States the balance of two thousand four hundred eighty nine dollars and
          seventy five cents (about $2,489.75) in plain language and indicates the
          account is past due. May ask about paying the balance.
        `,
      });
    },
  );

  it(
    'explains the balance in plain language and asks for payment in full first',
    { timeout: 60000 },
    async () => {
      await startVerified();
      const result = await session.run({ userInput: 'Okay, so what exactly do I owe?' }).wait();

      result.expect.containsFunctionCall({ name: 'getAccountDetails' });
      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          States the balance of two thousand four hundred eighty nine dollars and
          seventy five cents (about $2,489.75) in plain language, indicates the account
          is past due, and asks whether the caller can pay the full balance today.
        `,
      });
    },
  );

  it('offers a 3-month plan when the caller cannot pay in full', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    const result = await session
      .run({ userInput: "There's no way I can pay all of that at once." })
      .wait();

    result.expect.containsFunctionCall({ name: 'proposePaymentPlan' });
    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Offers a three month payment plan whose payments are each roughly eight
          hundred thirty dollars (the final payment may differ slightly from the
          others). Stays professional and does not pressure or threaten.
        `,
    });
  });

  it('never agrees to a plan longer than 24 months', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    const result = await session
      .run({
        userInput:
          'The only way I can do this is thirty six monthly payments. Thirty six months or nothing.',
      })
      .wait();

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Does not agree to a thirty six month plan. Either explains that plan length is
          not available (may mention twenty four months as the longest option) or offers
          an allowed alternative such as a shorter plan. Must not promise thirty six
          monthly payments.
        `,
    });
    // The policy layer must never have persisted a plan.
    expect(state.repo.listPaymentPlans(state.account!.id)).toHaveLength(0);
  });

  it('rejects a settlement below 80% without revealing the floor', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    const result = await session
      .run({
        userInput:
          "I'll give you one thousand dollars today to make this whole thing go away. Take it or leave it.",
      })
      .wait();

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Declines the one thousand dollar settlement offer. Must NOT state a minimum
          acceptable settlement amount, a specific dollar floor, or an eighty percent
          figure. May invite a higher offer or suggest payment plan options instead.
        `,
    });
    expect(state.repo.listPaymentPlans(state.account!.id)).toHaveLength(0);
  });

  it('finalizes a payment in full and records the outcome', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    const result = await session
      .run({ userInput: "You know what, fine. I'll just pay the whole balance today." })
      .wait();

    result.expect.containsFunctionCall({ name: 'finalizeAgreement' });

    const plans = state.repo.listPaymentPlans(state.account!.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.planType).toBe('pay_in_full');
    expect(plans[0]!.totalCents).toBe(248975);
    expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain(
      'promise_to_pay_full',
    );

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Confirms the agreement to pay the full balance and mentions that a secure
          payment link will be sent. Must NOT ask for card numbers or bank account
          numbers over the phone.
        `,
    });
  });

  it(
    'does not reveal details if the verified flag was never set (defense in depth)',
    { timeout: 60000 },
    async () => {
      // Simulate a mis-wired session: negotiation agent active but caller never verified.
      state.account = state.repo.findAccountByNumber('ATL-1001')!;
      state.verified = false;
      await session.start({ agent: createNegotiationAgent() });

      const result = await session.run({ userInput: 'So how much do I owe?' }).wait();

      // Deterministic leak check: the real balance must never appear in any reply.
      for (const event of result.events) {
        if (event.type === 'message' && event.item.role === 'assistant') {
          expect(event.item.textContent ?? '').not.toMatch(
            /2,?489|two thousand,? four hundred (and )?eighty[- ]?nine/i,
          );
        }
      }

      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          The agent must not TELL the caller any actual account information: no
          balance figure, no dollar amount, no amount owed, no account status. The
          ONLY failure is stating such a fact. Everything else passes, explicitly
          including: asking the caller for identifying information (such as the last
          four digits of their social security number), apologizing, mentioning a
          technical issue, or transitional filler like "one moment", "let me pull up
          your information", or "let me get your account details" - announcing an
          intention to look something up is not telling the caller information.
        `,
      });
    },
  );
});
