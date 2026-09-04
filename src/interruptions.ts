import { llm, voice } from '@livekit/agents';
import type { CallState } from './state.ts';

/** Appended to each interrupted assistant message as the model sees it. */
export const INTERRUPTION_MARKER =
  ' [you were cut off here - the caller never heard the rest of this sentence]';

/**
 * Annotate interrupted assistant messages with an explicit cut-off marker.
 *
 * When the caller interrupts, the framework commits only the words actually
 * spoken and flags the chat item `interrupted` - but no provider formatter
 * surfaces that flag, so the model sees a bare half-sentence and its
 * strongest instinct is to complete it verbatim (observed in production as
 * recaps resuming mid-sentence and repeating across turns). The marker names
 * the truncation so the model responds to the caller instead of finishing
 * the sentence. Interrupted items are replaced, never mutated: `copy()` is
 * shallow, and the marker must not leak into the real conversation history.
 *
 * @param chatCtx - The chat context for one LLM request.
 * @returns A copy in which every interrupted assistant message carries the
 * marker; untouched items are shared by reference with the original.
 */
export function markInterruptions(chatCtx: llm.ChatContext): llm.ChatContext {
  const copy = chatCtx.copy();
  const items = copy.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type !== 'message' || item.role !== 'assistant' || !item.interrupted) continue;
    const text = item.textContent;
    if (!text || text.endsWith(INTERRUPTION_MARKER)) continue;
    items[i] = llm.ChatMessage.create({
      id: item.id,
      role: 'assistant',
      content: [text + INTERRUPTION_MARKER],
      interrupted: true,
      createdAt: item.createdAt,
    });
  }
  return copy;
}

/**
 * `llmNode` hook for `voice.Agent.create`: applies the interruption marker to
 * the request context, then delegates to the SDK's default LLM node. Purely a
 * per-request view - the session's stored history is untouched.
 */
export function interruptionAwareLlmNode(
  ctx: voice.AgentContext<CallState>,
  chatCtx: llm.ChatContext,
  toolCtx: llm.ToolContext<CallState>,
  modelSettings: voice.ModelSettings,
) {
  return voice.Agent.default.llmNode(
    ctx.agent,
    markInterruptions(chatCtx),
    toolCtx as llm.ToolContext,
    modelSettings,
  );
}
