import { voice } from '@livekit/agents';
import type { CallState } from './state.ts';

/** How long the line may stay silent after the disposition before hanging up. */
export const POST_OUTCOME_SILENCE_MS = 15_000;

/**
 * Deterministic hangup backstop for a call whose business is finished.
 *
 * The prompts require the goodbye and the end_call tool in the same reply,
 * but a small model occasionally emits the goodbye text alone, which would
 * leave the caller on a silent open line indefinitely. Once the call's
 * outcome is recorded there is nothing left to negotiate, so when the agent
 * is done speaking and the caller stays silent past the timeout, the session
 * is closed in code. Any speech from either side resets the countdown, so a
 * caller with one more question is never cut off mid-conversation.
 */
export function armPostOutcomeWatchdog(
  session: voice.AgentSession<CallState>,
  state: CallState,
  options?: { silenceMs?: number },
): void {
  const silenceMs = options?.silenceMs ?? POST_OUTCOME_SILENCE_MS;
  let agentListening = false;
  let userSpeaking = false;
  let timer: NodeJS.Timeout | undefined;

  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const rearm = () => {
    disarm();
    if (!state.outcomeRecorded || !agentListening || userSpeaking) return;
    timer = setTimeout(() => {
      state.trace.event('silence_hangup', {
        afterMs: silenceMs,
        note: 'outcome recorded and line silent; closing session',
      });
      void session.close().catch(() => {});
    }, silenceMs);
  };

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    agentListening = ev.newState === 'listening';
    rearm();
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    userSpeaking = ev.newState === 'speaking';
    rearm();
  });
  session.on(voice.AgentSessionEventTypes.Close, disarm);
}
