import { dedent, inference, initializeLogger, llm, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNegotiationAgent } from '../agents/negotiationAgent.ts';
import type { CallState } from '../state.ts';
import { AGENT_MODEL, JUDGE_MODEL, createTestState, judgeTurn, markVerified } from './helpers.ts';

initializeLogger({ pretty: false, level: 'warn' });

// Seed account 300101 (Maria Gonzalez): $2,489.75, delinquent.

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
    markVerified(state, '300101');
    await session.start({ agent: createNegotiationAgent() });
  }

  it(
    'explains the balance from injected account context without a tool round-trip',
    { timeout: 60000 },
    async () => {
      // Post-verification path: the handoff passes the account into the agent
      // factory, so the details live in its instructions.
      const account = markVerified(state, '300101');
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

    // The standard opener is precomputed into the account context, so the
    // offer must arrive immediately, with real amounts and no tool round-trip.
    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Offers a three month payment plan whose payments are each roughly eight
          hundred thirty dollars (the final payment may differ slightly from the
          others). Stays professional and does not pressure or threaten.
        `,
    });
  });

  it(
    'turns a stated monthly budget into the shortest fitting plan, in code',
    { timeout: 90000 },
    async () => {
      await startVerified();
      await session.run({ userInput: 'What do I owe?' }).wait();
      await session
        .run({ userInput: "I can't pay that all at once, and three months is too fast." })
        .wait();
      const result = await session
        .run({ userInput: 'I could comfortably do one hundred fifty dollars a month.' })
        .wait();

      // The caller's dollar figure must reach the tool as dollars: the
      // dollars-to-months arithmetic belongs to policy code, not the model.
      const budgetCalls = result.events.filter(
        (e) => e.type === 'function_call' && e.item.name === 'proposePaymentPlan',
      );
      expect(budgetCalls.length).toBeGreaterThan(0);
      for (const call of budgetCalls) {
        if (call.type !== 'function_call') continue;
        const args = JSON.parse(String(call.item.args ?? '{}')) as {
          monthlyAmountDollars?: number;
        };
        expect(args.monthlyAmountDollars).toBe(150);
      }

      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          Offers a seventeen month payment plan with monthly payments of about one
          hundred forty six dollars (roughly $146.46). Describing it as sixteen
          monthly payments plus a slightly different final payment IS a seventeen
          month plan and passes. The only failures are: offering a plan whose
          monthly payment exceeds one hundred fifty dollars, or offering a plan
          longer than twenty four months.
        `,
      });
    },
  );

  it(
    'offers the closest allowed payment when the budget needs more than 24 months',
    { timeout: 90000 },
    async () => {
      await startVerified();
      await session.run({ userInput: 'What do I owe?' }).wait();
      await session.run({ userInput: "There's no way. I just lost my job." }).wait();
      const result = await session
        .run({ userInput: 'The most I could do is one hundred dollars a month.' })
        .wait();

      // $100/month on $2,489.75 needs 25 months; the tool must clamp to the
      // 24-month maximum and surface $103.74 as the closest allowed payment.
      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          Offers a twenty four month payment plan with monthly payments of about one
          hundred three dollars and seventy four cents. Referring to the caller's one
          hundred dollar figure while explaining (for example "with one hundred
          dollars a month, the closest plan is...") is fine and expected. The only
          two failures are: offering a plan whose stated monthly payment IS one
          hundred dollars or less, or offering a plan longer than twenty four
          months.
        `,
      });
    },
  );

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
    let result = await session
      .run({
        userInput:
          "I'll give you one thousand dollars today to make this whole thing go away. Take it or leave it.",
      })
      .wait();
    // The agent may confirm the amount before checking it; answer like a caller.
    const checkedOffer = () =>
      result.events.some((e) => e.type === 'function_call' && e.item.name === 'proposeSettlement');
    if (!checkedOffer()) {
      result = await session.run({ userInput: 'Yes, one thousand dollars.' }).wait();
    }

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Declines the one thousand dollar settlement offer. Must NOT state a minimum
          acceptable settlement amount, a specific dollar floor, or an eighty percent
          figure. May invite a higher offer or suggest payment plan options instead.
        `,
    });
    expect(state.repo.listPaymentPlans(state.account!.id)).toHaveLength(0);
  });

  it(
    'discloses the floor after two lowball offers, never sooner',
    { timeout: 120000 },
    async () => {
      await startVerified();
      await session.run({ userInput: 'What do I owe?' }).wait();
      // The model may confirm each amount before checking it, so drive the two
      // lowball offers with confirmations until both rejections land (bounded).
      const offers = [
        'I can offer one thousand dollars to settle.',
        'Yes, one thousand dollars even. Can you take it?',
        'Okay, one thousand five hundred. Final offer.',
        'Yes, one thousand five hundred dollars.',
      ];
      let result!: voice.testing.RunResult;
      for (const userInput of offers) {
        result = await session.run({ userInput }).wait();
        if (state.settlementRejections >= 2) break;
      }

      // Two below-floor offers recorded -> the tool permits naming the minimum.
      expect(state.settlementRejections).toBeGreaterThanOrEqual(2);
      await judgeTurn(judgeLlm, result, {
        intent: dedent`
        Declines the offer and tells the caller the minimum acceptable settlement:
        one thousand nine hundred ninety one dollars and eighty cents ($1,991.80).
        Must not accept any amount below that.
      `,
      });
    },
  );

  it('reads a fragmented spoken amount as a single offer', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    // STT splits one spoken amount ("nineteen hundred dollars") into fragments;
    // the agent must read them as one offer, never as $900 or $1,000 alone.
    const result = await session
      .run({ userInput: 'Could I settle this instead? How about $1,000. 900.' })
      .wait();

    for (const event of result.events) {
      if (event.type === 'function_call' && event.item.name === 'proposeSettlement') {
        const args = JSON.parse(String(event.item.args ?? '{}')) as { amountDollars?: number };
        expect(args.amountDollars).toBe(1900);
      }
    }
    await judgeTurn(judgeLlm, result, {
      intent: dedent`
        Treats the caller's words as ONE settlement offer of one thousand nine
        hundred dollars ($1,900) - either by asking the caller to confirm that
        single amount, or by responding to a $1,900 offer (declining it without
        stating any minimum is a valid response). Must NOT treat the fragments as
        separate offers such as $1,000 or $900, and must NOT accept any amount.
      `,
    });
  });

  it('accepts and finalizes a settlement at or above the floor', { timeout: 150000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    // $2,000 on $2,489.75 is above the 80% floor ($1,991.80): acceptable.
    // Drive through the model's confirmation beats until it finalizes.
    const turns = [
      "I can't pay all of that, but I could do two thousand dollars today to settle it. Can you take that?",
      "Yes, two thousand dollars, let's do it.",
      'Yes, I confirm.',
    ];
    let result!: voice.testing.RunResult;
    for (const userInput of turns) {
      result = await session.run({ userInput }).wait();
      if (state.outcomeRecorded) break;
    }

    // Hard backstop: the settlement is persisted with the agreed amount.
    const plans = state.repo.listPaymentPlans(state.account!.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.planType).toBe('settlement');
    expect(plans[0]!.totalCents).toBe(200000);
    expect(state.repo.listOutcomes(state.callId).map((o) => o.outcome)).toContain(
      'settlement_agreed',
    );

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          Confirms the two thousand dollar settlement resolves the account and/or
          mentions the secure payment link. Must NOT ask for card or bank numbers
          over the phone, and must not state a different settlement amount.
        `,
    });
  });

  it('records no_agreement when the caller refuses every option', { timeout: 150000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    // Refuse everything; the call must still end with a recorded disposition.
    const turns = [
      "I'm not paying that. Not in full, not in a plan, nothing.",
      'No plans, no settlements. I have no intention of paying this. We are done here.',
      "No. Nothing. Stop offering things. Just close it out, I'm not agreeing to anything.",
    ];
    let result!: voice.testing.RunResult;
    for (const userInput of turns) {
      result = await session.run({ userInput }).wait();
      if (state.outcomeRecorded) break;
    }

    // The disposition must be recorded, and never as an agreement.
    const outcomes = state.repo.listOutcomes(state.callId).map((o) => o.outcome);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(
      outcomes.every((o) => o === 'no_agreement' || o === 'escalated'),
      `unexpected outcomes: ${outcomes.join(', ')}`,
    ).toBe(true);
    expect(state.repo.listPaymentPlans(state.account!.id)).toHaveLength(0);

    await judgeTurn(judgeLlm, result, {
      intent: dedent`
          The only failures are: continued pressure to pay, hostile or threatening
          language, or claiming the caller agreed to something. Everything else
          passes, explicitly including a brief polite close such as thanking the
          caller for their time.
        `,
    });
  });

  it('finalizes a payment in full and records the outcome', { timeout: 90000 }, async () => {
    await startVerified();
    await session.run({ userInput: 'What do I owe?' }).wait();
    const result = await session
      .run({ userInput: "You know what, fine. I'll just pay the whole balance today." })
      .wait();

    result.expect.containsFunctionCall({ name: 'finalizeAgreement' });
    // The caller must get to respond to the recap before the call can end.
    const endedSameTurn = result.events.some(
      (e) => e.type === 'function_call' && e.item.name === 'end_call',
    );
    expect(endedSameTurn).toBe(false);

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
    'hangs up in the same turn as the goodbye after the caller wraps up',
    { timeout: 120000 },
    async () => {
      await startVerified();
      await session.run({ userInput: 'What do I owe?' }).wait();
      // Finalize + recap turn (end_call must NOT fire here; asserted elsewhere).
      await session
        .run({ userInput: "You know what, fine. I'll just pay the whole balance today." })
        .wait();
      // The caller acknowledges the recap; the agent typically wraps up here,
      // often with a farewell of its own.
      await session.run({ userInput: "Okay, alright, that's fine." }).wait();
      // The caller returns the farewell. Ending the call means calling
      // end_call (which generates the goodbye itself); an agent that answers
      // with farewell text alone leaves the caller in a silent, open room.
      const result = await session.run({ userInput: 'Yep, thanks. You too.' }).wait();

      result.expect.containsFunctionCall({ name: 'end_call' });
    },
  );

  it(
    'responds to an interruption instead of resuming the cut-off sentence',
    { timeout: 150000 },
    async () => {
      const account = markVerified(state, '300101');
      const agent = createNegotiationAgent({ account });
      await session.start({ agent });

      // Drive a real conversation to the agreement recap.
      await session
        .run({
          userInput:
            "There's no way I can pay that all at once. Could I do monthly payments over two years?",
        })
        .wait();
      await session.run({ userInput: "Yes, that works for me. Let's set that up." }).wait();
      expect(state.outcomeRecorded).toBe(true);

      // Reproduce what the framework commits when the caller interrupts
      // playout: the recap message is truncated to the words actually spoken
      // (cut mid-sentence) and flagged interrupted. No other signal exists.
      const chatCtx = agent.chatCtx.copy();
      const recap = [...chatCtx.items]
        .reverse()
        .find(
          (item): item is llm.ChatMessage =>
            item.type === 'message' && item.role === 'assistant' && !!item.textContent,
        );
      expect(recap).toBeDefined();
      const words = (recap!.textContent ?? '').split(/\s+/);
      expect(words.length).toBeGreaterThan(8);
      const spoken = words
        .slice(0, Math.ceil(words.length * 0.6))
        .join(' ')
        .replace(/[.,;!?]+$/, '');
      recap!.content = [spoken];
      recap!.interrupted = true;
      await agent.updateChatCtx(chatCtx);

      // The caller interrupted the recap to confirm the terms.
      const result = await session.run({ userInput: 'Okay. Alright. Yeah. That works.' }).wait();

      // A verbatim resume continues the cut-off sentence in lowercase; a real
      // response starts a fresh sentence.
      const firstReply = result.events.find(
        (e) => e.type === 'message' && e.item.role === 'assistant' && e.item.textContent,
      );
      expect(firstReply).toBeDefined();
      expect((firstReply!.type === 'message' && firstReply!.item.textContent) || '').toMatch(
        /^\s*[A-Z]/,
      );

      await judgeTurn(judgeLlm, result, {
        intent: dedent`
          Context: the agent was reciting the final agreement recap when the caller
          interrupted it mid-sentence to say the terms work for them, so the agent's
          previous message was cut off. The turn being judged is what the agent said
          next. A passing turn moves the call to its close in any reasonable way: a
          brief confirmation the agreement is set, a mention of the secure payment
          link, a goodbye, or any combination - a goodbye alone passes. The ONLY
          failures are: (a) the turn reads as a continuation of the cut-off sentence
          rather than a fresh response to the caller, or (b) the turn re-recites the
          full plan terms in detail again as if the caller had not already confirmed
          them.
        `,
      });
    },
  );

  it(
    'does not reveal details if the verified flag was never set (defense in depth)',
    { timeout: 60000 },
    async () => {
      // Simulate a mis-wired session: negotiation agent active but caller never verified.
      state.account = state.repo.findAccountByNumber('300101')!;
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
