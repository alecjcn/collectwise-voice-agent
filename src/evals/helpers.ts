import type { voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { openDb } from '../db/db.ts';
import { type Account, Repository } from '../db/repository.ts';
import { seedIfEmpty } from '../db/seed.ts';
import { type CallState, createCallState } from '../state.ts';
import { Tracer } from '../trace.ts';

// LiveKit Inference credentials for the agent LLM and the judge.
dotenv.config({ path: '.env.local' });

/** The model driving the agent under test — same default as production. */
export const AGENT_MODEL = process.env.LLM_MODEL ?? 'google/gemma-4-31b-it';

/** The judge model used to grade agent responses in evals. */
export const JUDGE_MODEL = 'openai/gpt-4.1-mini';

/**
 * Assertion helper for the last SUBSTANTIVE assistant message in a run:
 * tool calls may happen after the agent speaks, and small models occasionally
 * emit a stray content-free token (for example "}") as a trailing message, so
 * skip anything without letters.
 */
export function lastAssistantMessage(result: voice.testing.RunResult) {
  for (let i = result.events.length - 1; i >= 0; i--) {
    const event = result.events[i]!;
    if (event.type === 'message' && event.item.role === 'assistant') {
      const text = event.item.textContent ?? '';
      if (!/[a-z]/i.test(text)) continue;
      return result.expect.at(i).isMessage({ role: 'assistant' });
    }
  }
  throw new Error('Run contains no substantive assistant message');
}

let testCounter = 0;

/**
 * Fresh, isolated call state for a test: an in-memory SQLite database with the
 * seed accounts, and a silent tracer. Mirrors exactly what main.ts builds for
 * a real call.
 */
export function createTestState(): CallState {
  const repo = new Repository(openDb(':memory:'));
  seedIfEmpty(repo);
  const callId = `test-${++testCounter}`;
  return createCallState({ callId, repo, trace: new Tracer({ callId, silent: true }) });
}

/**
 * Mark the state as already verified for the given seed account, as if the
 * caller had passed the verification phase. Used to test the negotiation
 * agent in isolation.
 */
export function markVerified(state: CallState, accountNumber = 'ATL-1001'): Account {
  const account = state.repo.findAccountByNumber(accountNumber);
  if (!account) throw new Error(`Seed account ${accountNumber} not found`);
  state.accountId = account.id;
  state.debtorFirstName = account.debtorName.split(/\s+/)[0]!;
  state.verified = true;
  return account;
}

/**
 * Locate an account for the state without verifying, as if lookupAccount had
 * succeeded and the caller confirmed they are the account holder.
 */
export function markLocated(state: CallState, accountNumber = 'ATL-1001'): Account {
  const account = state.repo.findAccountByNumber(accountNumber);
  if (!account) throw new Error(`Seed account ${accountNumber} not found`);
  state.accountId = account.id;
  state.debtorFirstName = account.debtorName.split(/\s+/)[0]!;
  return account;
}
