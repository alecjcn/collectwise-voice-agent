# Atlas Recovery Voice Agent (CollectWise take-home)

A LiveKit voice agent — **Nancy from Alpha Bank** — that handles inbound consumer calls about
past-due accounts for Atlas Recovery: locates the account, verifies identity, explains the
balance, negotiates payment within hard policy limits, handles disputes/hardship/escalations,
and records every call's outcome with structured traces.

Built with **Node.js / TypeScript**, **LiveKit Agents** (LiveKit Cloud + LiveKit Inference),
and **SQLite** (Node's built-in `node:sqlite` — zero native dependencies, money stored as
integer cents).

## Try the deployed agent

The agent is deployed to LiveKit Cloud (agent `CA_g34CJcavaJ6w`, project `collectwise`).
Test it from your browser (microphone required) — open the link and allow the mic:

**→ Public browser test URL:**
`https://meet.livekit.io/custom?liveKitUrl=wss://collectwise-heaar9h7.livekit.cloud&token=<JOIN_TOKEN>`

Generate a `<JOIN_TOKEN>` (any identity, any room name) with the CLI — the deployed agent
auto-dispatches into every new room in the project:

```bash
lk token create --join --room atlas-demo --identity evaluator --valid-for 720h
```

A ready-to-click URL with a pre-generated token is provided in the take-home submission
notes rather than committed to git (the token grants room access). Note that everyone using
the same token shares one room — generate a fresh token and room name for a private session.

Project members can also use the LiveKit Cloud **Agent Console**
(cloud.livekit.io → collectwise → Agents → `CA_g34CJcavaJ6w` → Test in Console) or the
hosted [Agents Playground](https://agents-playground.livekit.io).

Sample conversation to try (seed data):

> **You:** Hi, I got a letter about my account. My account number is A T L one zero zero one.
> **Nancy:** …Am I speaking with Maria?
> **You:** Yes. Maria Gonzalez, last four of my social are seven three zero one.
> **Nancy:** _(verifies, explains the $2,489.75 past-due balance, asks for payment in full)_
> **You:** I can't pay all that… _(negotiate: 3-month plan → longer plans → settlement ≥ 80%)_

Seed accounts you can role-play with:

| Account  | Name           | Phone on file | SSN last 4 | Balance    | Status     |
| -------- | -------------- | ------------- | ---------- | ---------- | ---------- |
| ATL-1001 | Maria Gonzalez | 555-010-4821  | 7301       | $2,489.75  | delinquent |
| ATL-1002 | David Chen     | 555-010-3390  | 5544       | $960.50    | delinquent |
| ATL-1003 | Sarah Whitmore | 555-010-7712  | 9012       | $12,400.00 | delinquent |
| ATL-1004 | James Patel    | 555-010-6655  | 3376       | $432.00    | in dispute |
| ATL-1005 | Linda Okafor   | 555-010-2218  | 8845       | $0.00      | paid       |

Edge cases to try: give a wrong SSN three times, say "you have the wrong number", say
"this isn't my debt", describe hardship, demand a 36-month plan, offer a lowball settlement,
or ask for a human.

## Setup

Requires Node.js ≥ 24 and pnpm ≥ 10.

```bash
pnpm install
```

Copy `.env.example` to `.env.local` and fill in your LiveKit Cloud credentials
(`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), or load them automatically:

```bash
lk cloud auth
```

```bash
lk app env -w -d .env.local
```

## Commands

| Command          | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `pnpm db:seed`   | Initialize `data/collectwise.db` and insert the 5 sample accounts |
| `pnpm dev`       | Run the agent locally (hot reload; auto-seeds the DB if empty)    |
| `pnpm start`     | Run the agent in production mode                                  |
| `pnpm test`      | Run the full suite: policy/DB unit tests + LLM behavioral evals   |
| `pnpm eval`      | LLM behavioral evals only (verification, negotiation, edge cases) |
| `pnpm test:unit` | Deterministic tests only (no LLM calls, sub-second)               |

Seeding is idempotent and also happens automatically at agent startup, so `pnpm dev` alone is
enough to run locally. To talk to the locally running agent, use the same frontend as the
deployed test path (it connects to your LiveKit Cloud project, which dispatches whichever
agent worker is connected — local or deployed).

## Architecture

See [DESIGN.md](DESIGN.md) for the full design. The short version:

```
src/
  main.ts                    entrypoint: pipeline wiring, per-call state, trace + outcome fallback
  prompts.ts                 persona, voice rules, per-phase instructions
  policy.ts                  pure guardrail functions (plan math, settlement floor, name match)
  state.ts                   CallState: typed session userData (verified flag, attempts, deps)
  trace.ts                   per-call JSONL tracer
  agents/
    verificationAgent.ts     unverified phase: lookupAccount, verifyIdentity (+ shared tools)
    negotiationAgent.ts      verified phase: account details, plans, settlements, disputes
  tools/shared.ts            escalateToHuman, recordCallOutcome, traced() wrapper
  db/
    db.ts                    node:sqlite schema (CHECK constraints as last line of defense)
    repository.ts            typed queries; integer cents everywhere
    seed.ts                  sample accounts + `pnpm db:seed` CLI
  evals/                     unit tests + LLM behavioral evals
```

**Caller identification first.** At call start the agent reads the caller's phone number —
on a real inbound call this is the `sip.phoneNumber` participant attribute; for browser and
local testing the `INCOMING_NUMBER` env var mocks it. A match against the accounts table
prefills only the account id and first name into session state, so Nancy skips the account
questions and opens with right-party confirmation ("Am I speaking with Maria?"). Unknown or
absent numbers fall back to the `lookupAccount` tool (account number or phone on file).
Caller ID only _locates_ — it never verifies; the balance stays locked until the SSN check.

**Two agents, one handoff at the trust boundary.** The call starts in the
`VerificationAgent`, whose tools _cannot return account details at all_ —
`lookupAccount` returns only a first name so Nancy can confirm the right party. A successful
`verifyIdentity` (full name + SSN last 4, max 3 attempts, every attempt audited in the DB)
flips the `verified` flag and hands off to the `NegotiationAgent` via `llm.handoff()`,
carrying the chat context. This is the "different permissions" agent-split pattern from the
LiveKit workflows guide: the unverified state can't leak what it never has.

**State** lives in typed session `userData` (`CallState`): account id, verified flag,
attempt counters, escalation/outcome flags — plus the injected repository and tracer, which
is what lets every test run against an isolated in-memory database.

**Deployment shape: one system.** A single LiveKit Cloud agent deployment built from the
Dockerfile; SQLite lives inside the container and is seeded at startup. No docker-compose or
separate services — the DB is embedded, LiveKit Cloud provides transport/models/scaling.

## Prompting strategy

- **Layered prompts:** every agent gets shared `VOICE_RULES` (plain text only, 1–3 sentences,
  spell out numbers, professional/calm tone, honest if asked whether it's an AI) plus a
  phase-specific instruction block with a numbered conversation flow and explicit edge-case
  rules. Splitting by phase keeps each prompt small — better latency and adherence than one
  mega-prompt.
- **Prompts steer, tools enforce.** The negotiation ladder (full payment → 3-month plan →
  up to 24 months → settlement) is prompt-driven, but the limits are code:
  `proposePaymentPlan`/`finalizeAgreement` reject > 24 months, `proposeSettlement`/
  `finalizeAgreement` reject offers below 80% of the balance, `getAccountDetails` refuses
  when the `verified` flag isn't set, and `verifyIdentity` enforces the 3-attempt cap and is
  the _only_ code path that sets `verified`. A manipulated or confused LLM gets a policy
  error to relay, never an override.
- **The floor is never disclosed:** tool rejections instruct the model to decline and invite
  a higher offer without stating the minimum; an eval asserts it.
- **Deterministic bookkeeping:** `finalizeAgreement` writes the payment plan _and_ the call
  outcome atomically; terminal verification failure auto-records its outcome; and a shutdown
  callback records `incomplete`/`escalated` if the caller hangs up early — every call ends
  with exactly one outcome row.

## Guardrails summary

| Rule                                   | Enforcement                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No account details before verification | Tool split across agents; any gated tool touched by an unverified session hands control back to the verification agent in code |
| Wrong person → zero disclosure         | Prompt + lookup returns first name only                                                                                        |
| Max 3 verification attempts            | `verifyIdentity` counter, auto-records `verification_failed`                                                                   |
| Payment plans ≤ 24 months              | `policy.computeInstallmentPlan` + DB CHECK constraint                                                                          |
| Settlement ≥ 80% of balance            | `policy.validateSettlementOffer`, floor never revealed                                                                         |
| Dispute stops collection               | `recordDispute` pauses account, records outcome, prompt stops asks                                                             |
| Human escalation                       | `escalateToHuman` records reason; callback within 1 business day                                                               |
| No payment credentials by voice        | Prompt; agreements deliver a secure payment link instead                                                                       |

## Evals & tests

```bash
pnpm test        # everything
pnpm test:unit   # deterministic only (policy math, DB, guardrails) — no LLM
pnpm eval        # LLM behavioral evals
```

LLM evals use the LiveKit Agents test framework (`session.run` + tool-call assertions +
LLM-judged intents) against the real production model (Gemma 4 31B via LiveKit Inference),
with a fresh in-memory seeded DB per test, and assert on **all three layers**: what the agent
_says_ (judge), which tools it _calls_ (`containsFunctionCall`), and what actually hit the
_database_ (outcome/plan/escalation rows).

**Coverage:** caller-ID match (right-party confirmation by first name) and unknown-number
fallback; greeting persona; pre-verification refusal; wrong person (no disclosure +
outcome row); 3-strikes verification failure; successful verify → handoff; account not found;
balance explanation + pay-in-full-first; 3-month plan offer; 36-month refusal (and no plan row
persisted); lowball settlement refusal without revealing the floor; pay-in-full finalization
(plan + outcome rows); unverified-flag defense in depth; dispute (status flip + no further
collection); hardship empathy; human escalation; angry caller; zero-balance account.

**Known limitations / remaining failure modes:**

- LLM evals are non-deterministic; judge intents are written leniently but a small model can
  occasionally phrase itself into a failure. Deterministic DB/tool assertions are the backstop.
- Exact _turn timing_ of tool calls isn't pinned (e.g. the model may confirm before looking
  up); evals assert the call happened in the turn, not its position.
- Verification compares name tokens + SSN last 4 only — no fuzzy matching for STT
  mis-transcriptions of names (a real system would verify against DOB/address too and handle
  transcription distance).
- Multi-turn _audio_ behavior (interruptions, turn detection) isn't covered — text-mode evals
  only. LiveKit's simulation framework is Python-only today.
- Small-model hallucination is the sharpest failure mode we found: before the
  handoff-back guardrail existed, Gemma would occasionally invent a balance after a tool
  refused it. The structural fix (control returns to the verification agent) closed it, but
  it is a good illustration of why prompts alone are not guardrails.

## Observability

Every call writes a JSONL trace to `logs/trace-<callId>.jsonl` (see
[examples/](examples/) for a real one). Every tool is wrapped by `traced()`, and semantic
events are emitted at each decision point:

```jsonl
{"ts":"…","callId":"…","type":"tool_call","name":"verifyIdentity","args":{"fullName":"Maria Gonzalez","last4Ssn":"7301"}}
{"ts":"…","callId":"…","type":"verification","attempt":1,"success":true}
{"ts":"…","callId":"…","type":"state_transition","from":"unverified","to":"verified"}
{"ts":"…","callId":"…","type":"handoff","via":"verifyIdentity","to":"negotiation"}
{"ts":"…","callId":"…","type":"plan_decision","action":"proposed","months":3,"monthlyCents":82992}
{"ts":"…","callId":"…","type":"outcome","outcome":"payment_plan_agreed"}
```

Event types: `call_started`, `transcript` (both roles), `tool_call` / `tool_result` /
`tool_error`, `verification`, `state_transition`, `handoff`, `plan_decision`, `escalation`,
`outcome`, `call_ended`. The database is the durable record (verification attempts, plans,
outcomes, escalations); the trace is the debugging record. LiveKit Cloud's Agent
Observability adds session-level audio/latency insight on top.

## Deployment

Deployed as a single LiveKit Cloud agent from the included Dockerfile:

```bash
lk agent create   # first deploy: creates the agent + livekit.toml
```

```bash
lk agent deploy   # subsequent deploys
```

```bash
lk agent status   # check status
```

```bash
lk agent logs     # tail live logs (includes [trace] lines)
```

**Browser test path:** the agent uses automatic dispatch (no agent name pinning), so it
joins every room created in the project. Any LiveKit frontend pointed at the project works;
the documented path is LiveKit Meet's custom-connect URL described at the top of this
README (`meet.livekit.io/custom?liveKitUrl=...&token=...` with a token from
`lk token create`). Verified end to end: joining a room dispatches the deployed agent in
about one second and Nancy speaks first.

If the deployed path is unavailable, run `pnpm dev` locally with the same `.env.local` —
the same browser frontend connects to your local worker.

**Tradeoff:** the container's SQLite database is ephemeral and re-seeded on each deploy /
restart, which is fine for evaluating a prototype. Production would swap `db/db.ts` for
Postgres behind the same `Repository` interface (it's the only file that knows the engine).

## Assumptions

- Caller ID (`sip.phoneNumber`, mocked by `INCOMING_NUMBER` off-telephony) locates the
  account; callers whose number isn't on file identify by account number or phone number.
  Identity = full name + SSN last 4 in all cases.
- "Transfer to a human" records an escalation with a promised callback — no live SIP
  transfer (telephony explicitly out of scope in the assignment).
- No debt-collection legal disclosures (e.g. mini-Miranda) beyond the assignment's rules;
  the assignment is the source of truth.
- Payment execution (links, card processing) is out of scope; the agent records the
  agreement and promises a secure payment link.
