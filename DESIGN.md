# Atlas Recovery Voice Agent — Design

CollectWise take-home: a LiveKit voice agent ("Nancy" from Alpha Bank) that handles inbound
consumer calls about delinquent accounts for Atlas Recovery.

## Goals

- Verify identity before disclosing anything, negotiate within hard policy limits, handle the
  required edge cases, and leave a durable, reviewable trail (DB rows + structured traces).
- Stay small: this is a 3–5 hour prototype. Clear boundaries over production completeness.

## Architecture

### Two agents, one handoff at the trust boundary

The conversation has exactly one hard permission boundary: **unverified → verified**. That maps
cleanly onto LiveKit's agent-handoff pattern (per the workflows guide: "different permissions"
is a primary reason to split agents):

```
inbound call
   │
   ▼
VerificationAgent (unverified)                NegotiationAgent (verified)
  tools:                                        tools:
    lookupAccount      ── no PII returned         getAccountDetails   ── gated on verified flag
    verifyIdentity     ── on success ─────────▶   proposePaymentPlan  ── ≤ 24 months enforced
    escalateToHuman         llm.handoff()         proposeSettlement   ── ≥ 80% floor enforced
    recordCallOutcome                             finalizeAgreement   ── persists plan + outcome
                                                  recordDispute
                                                  escalateToHuman
                                                  recordCallOutcome
```

Why not more agents (e.g., a separate "hardship" or "dispute" agent)? Each split adds handoff
latency and context-management overhead; dispute/hardship/anger are conversational modes of the
same negotiation phase with the same tool permissions, so they live in the NegotiationAgent's
instructions. Why not a single agent? The unverified state must be _unable_ to leak account
details — the cleanest guarantee is that the unverified agent's tools cannot return them at all.

Guardrails are enforced in **two layers**:

1. **Prompts** shape behavior (negotiation ladder, tone, when to call which tool).
2. **Tools** enforce policy (`src/policy.ts`): the settlement floor, the 24-month cap, the
   verified gate on account details, and the verification attempt limit are all checked in
   code. A confused or manipulated LLM cannot exceed them — the tool returns a policy error
   the agent must relay.

### Session state

Typed `userData` on the `AgentSession` (`CallState` in `src/state.ts`): `callId`, the cached
`account` row (the single source for id/name/balance), `verified`, `verificationAttempts`,
`lookupFailures`, `escalated`, `outcomeRecorded`, plus injected dependencies (`repo`,
`trace`). `userData` is never visible
to the LLM — data reaches a prompt only where code puts it: pre-verification, only the first
name; post-verification, the account details are injected into the NegotiationAgent's
instructions at handoff (no tool round-trip for the first verified turn). Injecting the repository and tracer through `userData`
means tests run against an isolated in-memory DB with zero mocking frameworks.

### Voice pipeline

Unchanged from the starter (already tuned for voice): LiveKit Inference with AssemblyAI STT,
Gemma 4 31B LLM (configurable via `LLM_MODEL`), Fish Audio TTS with expressive mode, LiveKit
turn detector, ai-coustics noise cancellation.

## Data layer

Node 24's built-in `node:sqlite` (`DatabaseSync`) — zero native dependencies, works unchanged in
the existing Dockerfile, `:memory:` for tests. Money is **integer cents** everywhere.

Tables (`src/db/db.ts`):

- `accounts` — account_number, debtor_name, phone_number, last4_ssn, balance_cents, status,
  client_name (spec fields; status CHECK-constrained).
- `verification_attempts` — audit of every verify call (call_id, account_id, success).
- `payment_plans` — plan_type (pay_in_full | installments | settlement), total_cents,
  num_installments (CHECK 1–24), installment_cents.
- `call_outcomes` — final disposition per call (CHECK-constrained enum), notes.
- `escalations` — reason + details per escalation.

Repository functions (`src/db/repository.ts`) take validated inputs and return plain typed
objects; the schema's CHECK constraints are a last line of defense behind `policy.ts`.

## Policy (pure, unit-tested)

`src/policy.ts`: `computeInstallmentPlan` (ceil per-month, last payment absorbs the remainder so
installments sum exactly to the balance), `minSettlementCents` (ceil of 80%),
`validateSettlementOffer`, `namesMatch` (token-based, tolerant of middle names/case),
`normalizePhone`, `formatCents`. Constants: `MAX_PLAN_MONTHS = 24`,
`MIN_SETTLEMENT_RATIO = 0.8`, `MAX_VERIFICATION_ATTEMPTS = 3`.

## Conversation design (prompting strategy)

- **Shared voice rules** (`src/prompts.ts`): plain-text-only output, brief turns, spell out
  numbers, professional/calm/concise tone, honesty about being an AI assistant if asked.
- **VerificationAgent**: greet as Nancy from Alpha Bank → locate the account (caller ID via
  `sip.phoneNumber`, mocked by `INCOMING_NUMBER`; else account number or phone via the
  lookup tool) → confirm right party using first name only → verify full name + SSN last 4 →
  hand off. Explicit rules for: wrong person (no disclosure, record outcome, end), 3 failed
  attempts (record `verification_failed`, end), account not found (retry once, then
  escalate/record), human request (escalate). The prompt never contains account data;
  `lookupAccount` returns only the first name.
- **NegotiationAgent**: explain balance/status in plain language, then a strict ladder:
  pay in full → 3-month plan → longer plans up to 24 months (ask what monthly amount is
  affordable) → settlement at ≥ 80% only if the caller cannot do any plan. The agent is told to
  negotiate counter-offers and never volunteer the floor. Disputes stop collection immediately
  (`recordDispute` → validation notice + escalation). Hardship gets empathy + plans +
  escalation to a hardship review. No payment credentials are ever collected by voice — a
  secure payment link is "sent" (out of scope, documented assumption).
- Agreements are committed atomically by `finalizeAgreement` (persists the plan and the call
  outcome in one tool call) so a distracted model can't book a plan without an outcome row.

## Observability

`src/trace.ts`: a thin per-call `Tracer` over the SDK's pino logger — a child logger binds
`callId` to every line, so events reach stdout (pretty in dev, JSON in production) and
LiveKit Cloud observability automatically; a JSONL file per call
(`logs/trace-<callId>.jsonl`) is also written for offline inspection. Every tool is wrapped by `traced()` which logs `tool_call`,
`tool_result` / `tool_error`, and `handoff` events automatically; tools additionally emit
semantic events: `verification` (per attempt + status), `state_transition`
(unverified → verified), `plan_decision`, `escalation`, `outcome`. The DB rows are the
durable record; the trace is the debugging record.

## Evals & tests

- `src/evals/policy.test.ts` — deterministic unit tests for all policy math and guardrails
  (no LLM).
- `src/evals/verification.test.ts` — LLM evals: greeting persona, refuses pre-verification
  disclosure, wrong-person handling, attempt limit, account-not-found, successful handoff.
- `src/evals/negotiation.test.ts` — LLM evals: balance explanation, asks for full payment
  first, offers 3-month plan, respects 24-month cap and settlement floor (tool errors relayed,
  not overridden), finalizes agreements.
- `src/evals/edge-cases.test.ts` — LLM evals: dispute, hardship, human request, angry caller.

LLM evals use the test framework (`session.run` + `isFunctionCall` / `judge`) with a fresh
in-memory DB per test; the judge model is `openai/gpt-4.1-mini` via LiveKit Inference.

## Deployment

Single system — one LiveKit Cloud agent deployment from the existing Dockerfile
(`lk agent create` / `lk agent deploy`). SQLite is seeded at startup inside the container;
ephemeral, which is acceptable for a prototype (documented tradeoff — production would use
Postgres). Evaluators interact through a hosted browser frontend (documented in README);
local `pnpm dev` + the same frontend is the fallback path.

## Assumptions & tradeoffs

- Caller identifies their account by account number or the phone number on file (no SIP caller
  ID in scope). Identity = full name + SSN last 4.
- "Transfer to a human" records an escalation and promises a callback — no live SIP transfer
  (out of scope per the assignment).
- No FDCPA-specific disclosures (mini-Miranda etc.) beyond privacy-driven behavior; the
  assignment's rules are the source of truth.
- SQLite-in-container is ephemeral in cloud deploys; fine for evaluation, not production.
