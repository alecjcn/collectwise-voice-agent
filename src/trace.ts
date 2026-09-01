import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type TraceEventType =
  | 'call_started'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'handoff'
  | 'state_transition'
  | 'verification'
  | 'plan_decision'
  | 'escalation'
  | 'outcome'
  | 'transcript'
  | 'call_ended';

export interface TracerOptions {
  callId: string;
  /** Directory for the JSONL trace file. Omit (with silent) for tests. */
  dir?: string;
  /** Suppress console output (used in tests). */
  silent?: boolean;
}

/**
 * Per-call structured trace. Every event is appended as one JSON line to
 * logs/trace-<callId>.jsonl and echoed to the console in dev, giving a
 * reviewable record of state transitions, tool activity, and decisions.
 */
export class Tracer {
  readonly callId: string;
  private readonly filePath?: string;
  private readonly silent: boolean;

  constructor(options: TracerOptions) {
    this.callId = options.callId;
    this.silent = options.silent ?? false;
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.filePath = join(options.dir, `trace-${options.callId}.jsonl`);
    }
  }

  event(type: TraceEventType, data: Record<string, unknown> = {}): void {
    const entry = { ts: new Date().toISOString(), callId: this.callId, type, ...data };
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      } catch {
        // Tracing must never break a live call.
      }
    }
    if (!this.silent) {
      console.log(`[trace] ${type} ${JSON.stringify(data)}`);
    }
  }
}
