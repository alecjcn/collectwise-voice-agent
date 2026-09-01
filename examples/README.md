# Example output

- **`trace-example-negotiated-plan.jsonl`** — a real per-call trace produced by
  `node scripts/generate-example-trace.ts`, which drives the actual agents through a scripted
  text conversation: account lookup → identity verification → handoff → balance explanation →
  pay-in-full ask → 3-month plan declined → caller counter-offers ~$250/month → 10-month plan
  finalized (`payment_plan_agreed` outcome + `payment_plans` row). Every live call writes the
  same format to `logs/trace-<callId>.jsonl`.

- **`eval-output.txt`** — output of `pnpm test`: 24 deterministic unit tests
  (policy math, guardrails, DB) plus 17 LLM behavioral evals (verification, negotiation,
  edge cases) with judge reasoning.
