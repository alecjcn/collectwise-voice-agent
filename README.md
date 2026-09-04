# Atlas Recovery Voice Agent (CollectWise take-home)

A LiveKit voice agent — **Nancy from Alpha Bank** — that handles inbound consumer calls about
past-due accounts for Atlas Recovery: locates the account, verifies identity, explains the
balance, negotiates payment within hard policy limits, handles disputes/hardship/escalations,
and records every call's outcome with structured traces.

Built with **Node.js / TypeScript**, **LiveKit Agents** (LiveKit Cloud + LiveKit Inference),
and **SQLite** (Node's built-in `node:sqlite` — zero native dependencies, money stored as
integer cents).

## Try the deployed agent

The agent is live on LiveKit Cloud (agent `CA_g34CJcavaJ6w`, project `collectwise`). There
are three ways to reach it — all need a microphone; allow the mic when prompted.

**1. Hosted demo page (no setup):**

**→ https://alecjcn.github.io/collectwise-voice-agent/demo/**

A static page hosting LiveKit Cloud's [Agent Embed Widget](https://docs.livekit.io/agents/start/embed.md)
([demo/index.html](demo/index.html), served via GitHub Pages). Click the widget button in
the corner and talk to Nancy. Every visitor gets their own token, room, and session, so any
number of evaluators can test concurrently with no shared state. The seed accounts to
role-play with are listed right on the page.

**2. A single-conversation link** (needs the repo + your LiveKit credentials, see Setup):

```bash
pnpm demo:link
```

This prints a `meet.livekit.io` URL whose join token targets a randomly named room; the
deployed agent auto-dispatches into every newly created room. One link = one conversation:
join tokens pin a single room name, so use a fresh link each time.

**3. The LiveKit Cloud Agent Console** (project members): cloud.livekit.io → collectwise →
Agents → `CA_g34CJcavaJ6w` → Test in Console.

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

## Run your own copy

Requires Node.js ≥ 24 (for the built-in `node:sqlite`) and pnpm ≥ 10 — both are pinned in
`package.json` (`engines`, `packageManager`, and a Volta pin), so `corepack enable` or
Volta picks the right versions automatically.

**1. Clone and install:**

```bash
git clone https://github.com/alecjcn/collectwise-voice-agent.git
cd collectwise-voice-agent
pnpm install
```

The deterministic test layer runs immediately, with **no credentials** — a good first check
that the clone is healthy:

```bash
pnpm test:unit
```

**2. Add your LiveKit credentials.** Everything past the deterministic layer runs models
through LiveKit Inference on your own LiveKit Cloud project. Copy `.env.example` to
`.env.local` and fill in your own `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
(the file also documents the optional `LLM_MODEL` / `STT_MODEL` / `TTS_MODEL` / `TTS_VOICE`
and `INCOMING_NUMBER` knobs). If you use the LiveKit CLI, it can write the file for you:

```bash
lk cloud auth && lk app env -w -d .env.local
```

**3. Seed the database** (idempotent; also runs automatically at agent startup):

```bash
pnpm db:seed
```

**4. Run the agent locally** — hot reload, auto-seeds an empty DB:

```bash
pnpm dev
```

Point any LiveKit frontend at your project to talk to the local worker; `pnpm demo:link`
mints a fresh browser link against it. To try the recognized-caller path locally, set
`INCOMING_NUMBER` in `.env.local` to a seed number (e.g. `+15550104821` for Maria) — off
telephony this stands in for the `sip.phoneNumber` a real inbound call would carry.

**5. Console mode** — a terminal REPL against the agent, no browser or frontend needed
(handy for quick prompt iteration):

```bash
lk agent console
```

**6. Deploy to your own LiveKit Cloud project.** The committed `livekit.toml` pins **this**
submission's agent id, so delete it first; `lk agent create` recreates it for your project.

```bash
rm livekit.toml && lk agent create   # first deploy: creates the agent + livekit.toml
lk agent deploy                      # subsequent deploys
lk agent status                      # health, replicas, last-observed
lk agent logs                        # tail live logs (includes [trace] lines)
```

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
pnpm test        # everything (deterministic + LLM evals) — a few minutes, bills inference
pnpm test:unit   # deterministic only (policy math, DB, guardrails) — no LLM, no creds, seconds
pnpm eval        # LLM behavioral evals only
```

**What to expect.** `pnpm test:unit` (39 tests) is fast, offline, and always green — pure
policy math, the DB layer, the lookup input checks, and the interruption-marker transform.
`pnpm test` adds the LLM evals and needs `.env.local`; it takes a few minutes and bills
inference usage to your project. A committed sample run is in
[examples/eval-output.txt](examples/eval-output.txt).

Following LiveKit's [testing guidance](https://docs.livekit.io/agents/build/testing.md),
the evals cover **both layers**:

- **Turn level** — the LiveKit test framework asserts on exactly what happened in a turn:
  which tools were called (`containsFunctionCall`), the arguments they carried, and the
  agent handoffs (`containsAgentHandoff`).
- **Multi-turn** — driven conversations run the agent across many turns (lookup → confirm →
  verify → handoff → negotiate → finalize) and assert on the cumulative outcome. LiveKit's
  Cloud simulation runner is Python-only today, so these are scripted in Vitest instead.

Every eval asserts on **three independent layers**: what the agent _says_ (an LLM judge
over the whole turn, not just the last message), which tools it _calls_, and what actually
hit the _database_. The DB assertions are the hard backstop — they don't depend on model
phrasing, so a guardrail can never silently regress behind a lenient judge.

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

One system: a single LiveKit Cloud agent built from the included Dockerfile, no
docker-compose or side services — SQLite lives in the container and is seeded at startup.
The `lk agent` commands are in [Run your own copy](#run-your-own-copy). The agent uses
automatic dispatch (no name pinning), so it joins every room created in the project; that
is what lets the hosted widget, `pnpm demo:link`, and the Agent Console all reach the same
deployment. Verified end to end: joining a room dispatches the agent in about a second and
Nancy speaks first.

**Tradeoff:** the container's SQLite database is ephemeral and re-seeded on each deploy /
restart, which is fine for a prototype. Production would swap `db/db.ts` for Postgres behind
the same `Repository` interface — it's the only file that knows the engine.

## Further improvements

Directions this prototype is deliberately shaped to grow into, roughly in priority order:

- **Langfuse as the control plane for models and prompts.** Move the STT / TTS / LLM
  choices and every prompt out of the code and into Langfuse-managed config, so voice,
  model, and wording can be tuned and versioned without a redeploy, and A/B'd per cohort.
  Its prompt-management and experiment tooling would also replace the ad-hoc `LLM_MODEL`
  env knob and the manual model trial documented above with something measurable.
- **Langfuse tracing in production.** The semantic trace already emitted per call
  (`tool_call`, `verification`, `plan_decision`, `outcome`, …) maps cleanly onto Langfuse
  spans. Shipping it there would give searchable, per-call conversation traces with latency
  and cost attribution across the STT-LLM-TTS pipeline — the natural next step beyond
  stdout and LiveKit Cloud's session view.
- **Real caller identification over SIP.** On telephony the inbound `sip.phoneNumber` is
  available before the first word; the caller-ID lookup is already wired to it (mocked by
  `INCOMING_NUMBER` off-telephony). Wiring a real SIP trunk would let Nancy open with
  right-party confirmation on genuine calls, not just the demo path.
- **Per-client prompts from trunk metadata.** A collections platform serves many creditors.
  SIP trunk / dispatch metadata can carry the client identity into the job, letting the
  agent load client-specific persona, disclosures, and policy limits dynamically — one
  deployment, many branded agents — rather than the single hard-coded Alpha Bank persona.
- **Stronger identity and real payment execution.** A second verification factor
  (DOB/address) beyond SSN last-four, a live warm transfer for escalations (the `TODO(POC)`
  in `tools/shared.ts`), and actual secure payment-link generation instead of the recorded
  promise.

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
