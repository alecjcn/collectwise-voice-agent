import type { voice } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallState } from '../state.ts';
import { POST_OUTCOME_SILENCE_MS, armPostOutcomeWatchdog } from '../watchdog.ts';
import { createTestState } from './helpers.ts';

/** Minimal stand-in for an AgentSession: the emitter surface plus close(). */
function fakeSession() {
  const emitter = new EventEmitter();
  const close = vi.fn(async () => {});
  return {
    session: Object.assign(emitter, { close }) as unknown as voice.AgentSession<CallState>,
    emit: (event: string, payload?: unknown) => emitter.emit(event, payload),
    close,
  };
}

describe('post-outcome silence watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a silent session once the outcome is recorded', () => {
    const state = createTestState();
    const { session, emit, close } = fakeSession();
    armPostOutcomeWatchdog(session, state);

    state.outcomeRecorded = true;
    emit('agent_state_changed', { newState: 'listening' });

    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never fires while no outcome is recorded', () => {
    const state = createTestState();
    const { session, emit, close } = fakeSession();
    armPostOutcomeWatchdog(session, state);

    emit('agent_state_changed', { newState: 'listening' });
    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS * 10);
    expect(close).not.toHaveBeenCalled();
  });

  it('resets when the caller speaks, then re-arms when the line goes quiet', () => {
    const state = createTestState();
    const { session, emit, close } = fakeSession();
    armPostOutcomeWatchdog(session, state);

    state.outcomeRecorded = true;
    emit('agent_state_changed', { newState: 'listening' });
    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS - 1000);

    // The caller has one more question; the agent answers it.
    emit('user_state_changed', { newState: 'speaking' });
    emit('agent_state_changed', { newState: 'thinking' });
    emit('user_state_changed', { newState: 'listening' });
    emit('agent_state_changed', { newState: 'speaking' });
    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS * 2);
    expect(close).not.toHaveBeenCalled();

    // Quiet again: the countdown restarts from zero.
    emit('agent_state_changed', { newState: 'listening' });
    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('disarms when the session closes on its own', () => {
    const state = createTestState();
    const { session, emit, close } = fakeSession();
    armPostOutcomeWatchdog(session, state);

    state.outcomeRecorded = true;
    emit('agent_state_changed', { newState: 'listening' });
    emit('close');
    vi.advanceTimersByTime(POST_OUTCOME_SILENCE_MS * 2);
    expect(close).not.toHaveBeenCalled();
  });
});
