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

**→ Public browser test URL:** the demo page at the URL in the submission notes hosts
LiveKit Cloud's [Agent Embed Widget](https://docs.livekit.io/agents/start/embed.md)
([demo/index.html](demo/index.html), served via GitHub Pages) - click the widget button,
allow the mic, and talk to Nancy. Every visitor gets their own token, room, and session,
so any number of evaluators can test concurrently with no shared state.

Alternatively, generate a single-conversation link:

```bash
pnpm demo:link
```

This prints a `meet.livekit.io` URL whose join token targets a randomly named room; the
deployed agent auto-dispatches into every newly created room. One link = one room, so use a
fresh link per conversation: join tokens pin a single room name, everyone on the same link
shares that room, and re-creating a just-finished room's name races the previous call's
teardown.

Project members can also use the LiveKit Cloud **Agent Console**
(cloud.livekit.io → collectwise → Agents → `CA_g34CJcavaJ6w` → Test in Console) or the
hosted [Agents Playground](https://agents-playground.livekit.io).

Sample conversation to try (seed data):

> **You:** Hi, I got a letter about my account. My account number is three zero zero one zero one.
> **Nancy:** …Am I speaking with Maria Gonzalez?
> **You:** Yes. Maria Gonzalez, last four of my social are seven three zero one.
> **Nancy:** _(verifies, explains the $2,489.75 past-due balance, asks for payment in full)_
> **You:** I can't pay all that… _(negotiate: 3-month plan → longer plans → settlement ≥ 80%)_

Seed accounts you can role-play with:

| Account | Name           | Phone on file | SSN last 4 | Balance    | Status     |
| ------- | -------------- | ------------- | ---------- | ---------- | ---------- |
| 300101  | Maria Gonzalez | 555-010-4821  | 7301       | $2,489.75  | delinquent |
| 300102  | David Chen     | 555-010-3390  | 5544       | $960.50    | delinquent |
| 300103  | Sarah Whitmore | 555-010-7712  | 9012       | $12,400.00 | delinquent |
| 300104  | James Patel    | 555-010-6655  | 3376       | $432.00    | in dispute |
| 300105  | Linda Okafor   | 555-010-2218  | 8845       | $0.00      | paid       |

Edge cases to try: give a wrong SSN three times, say "you have the wrong number", say
"this isn't my debt", describe hardship, demand a 36-month plan, offer a lowball settlement,
or ask for a human.

## Setup (reproducing from a fresh clone)

Requires Node.js ≥ 24 (for the built-in `node:sqlite`) and pnpm ≥ 10 — both are pinned in
`package.json` (`engines`, `packageManager`, and a Volta pin), so `corepack enable` or
Volta picks the right versions automatically.

```bash
pnpm install
```

**No credentials needed** for the deterministic layer — this works immediately after
cloning (policy math, plan/budget boundaries, lookup input checks, database, interruption
marker):

```bash
pnpm test:unit
```

**Everything else needs a LiveKit Cloud project** (any account works; the LLM evals and
the agent both run models through LiveKit Inference on that project). Copy `.env.example`
to `.env.local` and fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or
load them automatically:

```bash
lk cloud auth
```

```bash
lk app env -w -d .env.local
```

Then the full flow works end to end: `pnpm test` for the whole suite (the LLM evals take
a few minutes and bill inference usage to your project), and `pnpm dev` to run the agent
locally — any LiveKit frontend pointed at your project connects to it (see the browser
test path above; `pnpm demo:link` mints a fresh room URL against your project).

One caveat for deploying your own copy: the committed `livekit.toml` pins **this**
submission's Cloud agent id. To deploy to your own project, delete it and run
`lk agent create` once (it recreates the file), then `lk agent deploy` as usual.

## Commands

| Command          | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `pnpm db:seed`   | Initialize `data/collectwise.db` and insert the 5 sample accounts |
| `pnpm dev`       | Run the agent locally (hot reload; auto-seeds the DB if empty)    |
| `pnpm start`     | Run the agent in production mode                                  |
| `pnpm test`      | Run the full suite: policy/DB unit tests + LLM behavioral evals   |
| `pnpm eval`      | LLM behavioral evals only (verification, negotiation, edge cases) |
| `pnpm test:unit` | Deterministic tests only (no LLM calls, no credentials, seconds)  |

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
  policy.ts                  pure guardrail functions (plan math, settlement floor, input checks)
  state.ts                   CallState: typed session userData (verified flag, attempts, deps)
  interruptions.ts           llmNode hook marking cut-off messages for the model
  trace.ts                   per-call JSONL tracer
  agents/
    verificationAgent.ts     unverified phase: account lookup tools, verifyIdentity
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
prefills the account into session state, so Nancy skips the account questions and opens
with right-party confirmation ("Am I speaking with Maria Gonzalez?"); if the person at the
number says they are someone else, she explains the number is on file under a different
name, escalates for remediation, and ends the call. Unknown or
absent numbers fall back to the lookup tools (`lookupAccountByAccountNumber` /
`lookupAccountByPhoneNumber`), which validate input shape in code: a name, SSN-shaped
digits, or a mid-utterance fragment gets an instructive re-ask that never counts against
the caller.
Caller ID only _locates_ — it never verifies; the balance stays locked until the SSN check.

**Two agents, one handoff at the trust boundary.** The call starts in the
`VerificationAgent`, whose tools _cannot return account details at all_ —
the lookup tools return only the name on file so Nancy can confirm the right party. A successful
`verifyIdentity` (SSN last 4, max 3 attempts, every attempt audited in the DB)
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
  up to 24 months → settlement) is prompt-driven, but the limits — and the arithmetic — are
  code: `proposePaymentPlan`/`finalizeAgreement` reject > 24 months, a caller's stated
  monthly budget maps to the shortest affordable plan in `computePlanForBudget` (the model
  passes the dollars straight through and never does the division), `proposeSettlement`/
  `finalizeAgreement` reject offers below 80% of the balance, `getAccountDetails` refuses
  when the `verified` flag isn't set, and `verifyIdentity` enforces the 3-attempt cap and is
  the _only_ code path that sets `verified`. A manipulated or confused LLM gets a policy
  error to relay, never an override.
- **Knowledge over round-trips:** the account details injected at handoff include the
  precomputed standard 3-month plan, so the first counter-offer always carries real
  numbers with no tool latency (`finalizeAgreement` still recomputes and enforces
  everything - the anchor is convenience, never authority).
- **Endings belong to one tool.** Per the EndCallTool contract, ending a call means
  calling `end_call`: the tool generates the single goodbye from `endInstructions`,
  plays it out fully, then closes the session and deletes the room. No prompt composes a
  farewell, which is what eliminated double goodbyes, silent hangups, and stranded rooms.
- **Interruptions are marked, not inferred.** The SDK commits only the spoken portion of
  an interrupted message, but no provider formatter surfaces the `interrupted` flag - a
  bare half-sentence invites a small model to complete it verbatim. An `llmNode` hook
  (`interruptions.ts`) appends an explicit cut-off marker in the per-request context, so
  the model responds to the caller instead of finishing its sentence.
- **Progressive floor disclosure:** a first below-floor offer is declined without stating the
  minimum (an eval asserts it); after a second lowball the tool permits naming the floor so
  the negotiation converges instead of playing guess-the-number. `finalizeAgreement` still
  rejects anything below it.
- **Deterministic bookkeeping:** `finalizeAgreement` writes the payment plan _and_ the call
  outcome atomically; terminal verification failure auto-records its outcome; and a shutdown
  callback records `incomplete`/`escalated` if the caller hangs up early — every call ends
  with exactly one outcome row (`no_balance_due` and `dispute` cover paid-off and
  under-review accounts, so no completed call is mislabeled).

## Guardrails summary

| Rule                                   | Enforcement                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No account details before verification | Tool split across agents; any gated tool touched by an unverified session hands control back to the verification agent in code |
| Wrong person → zero disclosure         | Prompt + lookup returns the name on file only                                                                                  |
| Max 3 verification attempts            | `verifyIdentity` counter, auto-records `verification_failed`                                                                   |
| Payment plans ≤ 24 months              | `policy.computeInstallmentPlan` + DB CHECK constraint                                                                          |
| Settlement ≥ 80% of balance            | `policy.validateSettlementOffer`; floor concealed until two lowball offers, then disclosed (never crossed)                     |
| Dispute stops collection               | `recordDispute` pauses the account; plan/settlement/finalize tools refuse `in_dispute` accounts in code                        |
| Human escalation                       | `escalateToHuman` records reason; callback within 1 business day                                                               |
| No payment credentials by voice        | Prompt; agreements deliver a secure payment link instead                                                                       |
| No stranded or cut-off call endings    | Ending = calling `end_call`; the tool generates the one goodbye, plays it out fully, then closes the session and room          |

## Evals & tests

```bash
pnpm test        # everything
pnpm test:unit   # deterministic only (policy math, DB, guardrails) — no LLM
pnpm eval        # LLM behavioral evals
```

LLM evals use the LiveKit Agents test framework (`session.run` + tool-call assertions +
LLM-judged intents) against the real production model (GPT-4.1 mini via LiveKit
Inference; `LLM_MODEL` overrides both),
with a fresh in-memory seeded DB per test, and assert on **all three layers**: what the agent
_says_ (judge), which tools it _calls_ (`containsFunctionCall`), and what actually hit the
_database_ (outcome/plan/escalation rows).

**Coverage:** caller-ID match (right-party confirmation by name) and unknown-number
fallback; greeting persona; pre-verification refusal; SSN read-back refusal; wrong person
(no disclosure + outcome row); 3-strikes verification failure; successful verify →
handoff; a full conversational lookup → confirm → verify → handoff flow; fragmented
phone-number turns (no strikes burned, lookup succeeds once complete); early-volunteered
name/account/SSN reuse without re-asking; account not found; balance explanation +
pay-in-full-first; immediate 3-month offer with real amounts; monthly-budget → shortest
fitting plan (dollars reach the tool, code does the division) and the over-budget
24-month clamp; 36-month refusal (no plan row persisted); lowball settlement refusal
without revealing the floor, then disclosure after a second lowball; fragmented spoken
amounts read as one offer; pay-in-full finalization (plan + outcome rows); recap
interruption recovery (fresh response, never resuming the cut-off sentence); goodbye and
hangup in the same turn; unverified-flag defense in depth; dispute (status flip + no
further collection); no plans bookable on an already-disputed account (tool-enforced);
hardship empathy; human escalation; angry caller; zero-balance account (told nothing is
due, `no_balance_due` recorded); wrong-then-right SSN recovery (failed attempt, retry,
handoff); settlement success at the floor (settlement row + `settlement_agreed`
persisted); no-agreement calls still end with a recorded disposition; callback requests
(`callback_requested` + spoken acknowledgment); dispute attempts before verification
(nothing recorded, nothing confirmed); prompt-injection resistance (deterministic
balance/SSN leak checks); prompt-privacy checks that stored SSN digits can never enter
any instructions.

**Known limitations / remaining failure modes:**

- LLM evals are non-deterministic: roughly one random test in a full run may fail on a
  phrasing wobble and pass on rerun. Turn-level judging (`judgeTurn` evaluates everything the
  agent said in a turn, not just the last message) and deterministic DB/tool assertions keep
  this rare; the DB assertions are the hard backstop.
- Exact _turn timing_ of tool calls isn't pinned (e.g. the model may confirm before looking
  up); evals assert the call happened in the turn, not its position.
- Verification is a single knowledge factor (SSN last 4) plus right-party confirmation and
  caller ID. A real system would add DOB/address as further factors.
- Multi-turn _audio_ behavior (interruptions, turn detection) isn't covered — text-mode evals
  only. LiveKit's simulation framework is Python-only today.
- Small-model hallucination is the sharpest failure mode we found: during development
  (on Gemma 4 31B, before switching the default model), the model would occasionally
  invent a balance after a tool refused it, until the handoff-back guardrail made control
  return to the verification agent in code. It is a good illustration of why prompts
  alone are not guardrails - the same philosophy behind the dispute gate, the budget
  arithmetic, and the interruption marker.

## Observability

Tracing rides on the SDK's pino logger: each call gets a child logger with the `callId`
bound to every line, so events flow to stdout and LiveKit Cloud observability with no extra
plumbing, and are also appended per call to `logs/trace-<callId>.jsonl` (see
[examples/](examples/) for a real one). Every tool is wrapped by `traced()`, and semantic
events are emitted at each decision point:

```jsonl
{"ts":"…","callId":"…","type":"tool_call","name":"verifyIdentity","args":{"last4Ssn":"7301"}}
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
  Identity = SSN last 4 (the right party is first confirmed by the name on file; spoken
  surnames are deliberately not compared — STT mangles them and each mangle would burn an
  attempt).
- "Transfer to a human" records an escalation with a promised callback, then the agent
  says goodbye and hangs up (prebuilt `end_call` tool: goodbye plays out, session shuts
  down, room is deleted). No live SIP transfer — telephony is out of scope; a `TODO(POC)`
  in `tools/shared.ts` marks where a warm transfer would go.
- No debt-collection legal disclosures (e.g. mini-Miranda) beyond the assignment's rules;
  the assignment is the source of truth.
- Payment execution (links, card processing) is out of scope; the agent records the
  agreement and promises a secure payment link.
