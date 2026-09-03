import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { INTERRUPTION_MARKER, markInterruptions } from '../interruptions.ts';

function ctxWith(
  ...messages: { role: 'user' | 'assistant'; text: string; interrupted?: boolean }[]
): llm.ChatContext {
  const ctx = llm.ChatContext.empty();
  for (const m of messages) {
    ctx.addMessage({ role: m.role, content: m.text, interrupted: m.interrupted ?? false });
  }
  return ctx;
}

describe('markInterruptions', () => {
  it('appends the marker to interrupted assistant messages only', () => {
    const ctx = ctxWith(
      {
        role: 'assistant',
        text: 'Your plan is twenty four months with payments of one',
        interrupted: true,
      },
      { role: 'user', text: 'Okay. That works.' },
      { role: 'assistant', text: 'You are all set.' },
    );
    const marked = markInterruptions(ctx);

    const texts = marked.items
      .filter((i) => i.type === 'message')
      .map((i) => (i.type === 'message' ? (i.textContent ?? '') : ''));
    expect(texts[0]).toBe(
      `Your plan is twenty four months with payments of one${INTERRUPTION_MARKER}`,
    );
    expect(texts[1]).toBe('Okay. That works.');
    expect(texts[2]).toBe('You are all set.');
  });

  it('never mutates the original chat context', () => {
    const ctx = ctxWith({ role: 'assistant', text: 'cut off mid', interrupted: true });
    markInterruptions(ctx);

    const original = ctx.items[0]!;
    expect(original.type === 'message' && original.textContent).toBe('cut off mid');
  });

  it('does not double-mark an already marked message', () => {
    const ctx = ctxWith({
      role: 'assistant',
      text: `cut off mid${INTERRUPTION_MARKER}`,
      interrupted: true,
    });
    const marked = markInterruptions(markInterruptions(ctx));

    const item = marked.items[0]!;
    const text = item.type === 'message' ? (item.textContent ?? '') : '';
    expect(text.match(/\[you were cut off here/g)).toHaveLength(1);
  });

  it('leaves interrupted user messages untouched', () => {
    const ctx = ctxWith({ role: 'user', text: 'wait, I', interrupted: true });
    const marked = markInterruptions(ctx);

    const item = marked.items[0]!;
    expect(item.type === 'message' && item.textContent).toBe('wait, I');
  });
});
