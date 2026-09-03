import { log } from '@livekit/agents';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Semantic event types recorded for every call. */
export type TraceEventType =
  | 'call_started'
  | 'caller_lookup'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'handoff'
  | 'state_transition'
  | 'verification'
  | 'plan_decision'
  | 'escalation'
  | 'end_call'
  | 'outcome'
  | 'transcript'
  | 'call_ended';

/**
 * Per-call trace built on the SDK's pino logger: a child logger binds the
 * `callId` to every line, so events flow to stdout (pretty in dev, JSON in
 * production) and to LiveKit Cloud observability with no extra plumbing.
 *
 * When a directory is given, events are also appended to
 * `<dir>/trace-<callId>.jsonl` for offline, per-call inspection.
 */
export class Tracer {
  readonly callId: string;
  private readonly logger: ReturnType<typeof log>;
  private readonly filePath?: string;

  constructor(callId: string, options?: { dir?: string }) {
    this.callId = callId;
    this.logger = log().child({ callId });
    if (options?.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.filePath = join(options.dir, `trace-${callId}.jsonl`);
    }
  }

  /** Record one semantic event. Must never throw into a live call. */
  event(type: TraceEventType, data: Record<string, unknown> = {}): void {
    this.logger.info({ trace: type, ...data }, `[trace] ${type}`);
    if (!this.filePath) return;
    try {
      const line = { ts: new Date().toISOString(), callId: this.callId, type, ...data };
      appendFileSync(this.filePath, JSON.stringify(line) + '\n');
    } catch (error) {
      this.logger.warn({ error }, 'failed to append trace file');
    }
  }
}
