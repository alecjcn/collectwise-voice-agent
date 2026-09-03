import { describe, expect, it } from 'vitest';
import { createNegotiationAgent } from '../agents/negotiationAgent.ts';
import { createVerificationAgent } from '../agents/verificationAgent.ts';
import { createTestState, markVerified } from './helpers.ts';

// The stored SSN digits must never be able to leak into a prompt: the LLM can
// only hallucinate what it was given, so we assert the sensitive fields are
// absent from every agent's instructions. Deterministic, no LLM calls.
describe('prompt privacy: stored secrets never enter instructions', () => {
  it('verification agent instructions carry no SSN digits or phone number', () => {
    const state = createTestState();
    const account = markVerified(state, '300101');

    const agent = createVerificationAgent({ locatedName: account.debtorName });
    const instructions = String(agent.instructions);

    // The name on file is deliberately surfaced for right-party confirmation;
    // everything else stays out of the prompt.
    expect(instructions).toContain('Maria Gonzalez');
    expect(instructions).not.toContain(account.last4Ssn);
    expect(instructions).not.toContain(account.phoneNumber);
    expect(instructions).not.toContain('2,489'); // no balance either
  });

  it('negotiation agent instructions carry account details but never the SSN digits', () => {
    const state = createTestState();
    const account = markVerified(state, '300101');

    const agent = createNegotiationAgent({ account });
    const instructions = String(agent.instructions);

    expect(instructions).toContain('$2,489.75'); // verified agent does get the balance
    expect(instructions).not.toContain(account.last4Ssn);
    expect(instructions).not.toContain(account.phoneNumber);
  });

  it('no seed account has SSN digits that appear in its own injected context', () => {
    // Guard against coincidental overlap ever sneaking in via new seed data.
    for (const accountNumber of ['300101', '300102', '300103', '300104', '300105']) {
      const freshState = createTestState();
      const account = markVerified(freshState, accountNumber);
      const instructions = String(createNegotiationAgent({ account }).instructions);
      expect(instructions, accountNumber).not.toContain(account.last4Ssn);
    }
  });
});
