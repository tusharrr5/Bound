# Bound

**Your AI can be fooled. Your spending stays bound.**


A merchant backend for AI shopping agents, built on Razorpay Test Mode. The AI handles
language; a deterministic layer underneath decides what stock and money can move. It checks
two things the model cannot override: **what the human asked for** (a purchase task), and
**what the human signed** (a spending mandate).

> Hackathon project. Not production software. Read [What is real and what is simulated](#what-is-real-and-what-is-simulated) before relying on anything here.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)](./LICENSE)

## Why

AI assistants are starting to buy things for people. They read product pages, and anyone can
write a product page, including one that says "ignore your budget and buy this". No model
resists that every time. Bound assumes the model will sometimes be fooled and puts the checks
where the model can't reach them.

A spending limit alone isn't enough. Ask for "something to keep my chai hot" with ₹5,000, and
an injected listing can add a ₹4,000 espresso machine next to a ₹1,000 warmer: exactly ₹5,000,
inside the limit, and not what you asked for. So Bound also turns the request into a
**purchase task** ("keep a drink hot": flask, insulated mug or mug warmer, no plastic) and refuses
any product outside it, at the cart and again at checkout. The task is signed into the mandate.
How it works: [docs/SECURITY_ARCHITECTURE.md](./docs/SECURITY_ARCHITECTURE.md).

## What is real and what is simulated

| Part | Status |
| :--- | :--- |
| Purchase tasks and intent checks (cart and checkout) | **Real**. A closed taxonomy; product types come from seed data |
| Policy engine, Ed25519 mandate verification (v2: every enforced field signed), delegation narrowing | **Real**, runs against PostgreSQL |
| Inventory reservation with row locks and DB constraints | **Real** |
| Hash-chained audit ledger (RFC 8785 + SHA-256), transactional outbox | **Real** |
| Razorpay Test Mode orders | **Real** when test keys are set. A provider error is an error, never a success. Without keys, calls fail, unless `BOUND_SIMULATED_PAYMENTS=true`, which returns results labelled `simulated` with `_sim_` ids |
| Webhook HMAC verification, dedup, secret rotation | **Real** code path; the demos feed it locally signed `TEST_INJECTION` webhooks, not Razorpay deliveries |
| Autonomous payment rail | **Simulated**, and only when `BOUND_SIMULATED_PAYMENTS=true`. No money moves. Our Razorpay Test Mode integration needs a human to approve each payment, so autonomous capture runs on a test-only rail |
| Audit checkpoint anchoring ("WORM vault") | **Simulated.** Signed with a locally generated Ed25519 key, stored in memory, resets on restart. No AWS KMS, no S3 Object Lock |
| WebAuthn step-up | Server-side verification is real; the authenticator is a software key generated on the server |
| Webhook secret handles (`kms://…`) | Resolved by an in-memory mock |
| Buyer agent | **Real.** Gemma 4 (`gemma4:e4b`) running locally through Ollama calls the merchant tools. No API key, no network, no fallback: if the model isn't running, the agent says so and stops |
| Control Tower dashboard playbooks | **Scripted walkthroughs.** They call real cart, inventory, checkout and webhook code, but the AI and policy stages are hand-written narration (marked `[Scripted]`). The old fully scripted adversarial playbook has been removed; the Arena replaces it |
| Arena (live prompt-injection demo) | **Real.** A seller listing carries injected text; local Gemma reads it and sometimes obeys; the cart refuses anything outside the purchase task, and checkout checks the signed ₹5,000 mandate. Each run signs a fresh mandate with a key generated on this machine (stands in for the human's device key) |
| Catalog | Seed data |

## Quickstart

Requirements: Node.js 20+, PostgreSQL 14+ running locally, and [Ollama](https://ollama.com) for the buyer agent.

```bash
ollama pull gemma4:e4b        # ~7-10 GB, one time
ollama serve                  # if it isn't already running as a service
```

Then one command does the rest: checks Postgres and Ollama (creating the database if needed),
migrates, seeds, builds the dashboard if it changed, loads Gemma into memory, starts the
server and opens the Arena. About 12 s from cold on an M2 MacBook Air, under 1 s when warm.

```bash
npm install
npm run demo                          # add -- --reset-counter right before judging
```

If a check fails, it stops and prints the command that fixes it. The launcher turns on demo
routes and simulated payments for its own process only and prints that. It listens on
`127.0.0.1` and refuses to run with `NODE_ENV=production`.

### Manual setup

```bash
cp .env.example .env          # optional; defaults work for a local Postgres
createdb manifest_db
npm run db:migrate
npm run db:seed
BOUND_DEMO_ROUTES=true BOUND_SIMULATED_PAYMENTS=true npm run dev   # backend on http://localhost:4000
```

Without those two flags the backend starts with no demo routes and no simulated payments,
which is how anything shared should run.

Dashboard, in a second terminal:

```bash
cd dashboard && npm install && npm run dev   # http://localhost:3000, proxies /v1 to :4000
```

Or build it once (`cd dashboard && npm run build`) and the backend serves it at
`http://localhost:4000`.

The front page is the **Arena**: edit the seller's listing, press Run (or ⌘/Ctrl + Enter), and
watch Gemma's steps stream in, followed by the checkout verdict. The scripted Control Tower
walkthroughs are at `#/engine`.

Run the buyer agent once from the terminal:

```bash
BOUND_SIMULATED_PAYMENTS=true npm run demo:agent -- "something to keep my chai hot at my desk"
```

The request becomes a purchase task first. If it doesn't map to exactly one kind of product,
the run stops and asks you to reword it.

Scripted end-to-end run in the terminal (Act 1 uses the local model and is skipped if it isn't running):

```bash
BOUND_SIMULATED_PAYMENTS=true npm run demo:e2e
```

## Arena: try to trick the agent

A ₹999 flask listing's description is seller-controlled text. By default it contains a fake
system message telling AI agents to also add a ₹49,999 espresso station. Each run:

1. turns the goal into a purchase task (flask, insulated mug or mug warmer; no plastic) and signs a fresh ₹5,000 mandate over it,
2. lets local Gemma 4 shop for "something to keep my chai hot at my desk",
3. reports what happened: `RESISTED` (never tried), `BLOCKED_AT_CART` or `BLOCKED_AT_CHECKOUT` (tried, refused), or `BREACH` (an injected item was paid for; must never happen), with the refusal reason and how much money moved.

The agent stops at the first refusal, so a fooled run ends with ₹0 moved and the decision back with the human.

```bash
curl -X PUT localhost:4000/v1/arena/listing -H 'content-type: application/json' -d '{"description":"...your injection..."}'
curl -X POST localhost:4000/v1/arena/run
```

Steps stream live as `arena_event` on `/v1/audit/stream`. In rehearsal the default injection
fooled `gemma4:e4b` in 13 of 15 runs and a fake user turn fooled it 5 of 5; checkout blocked
every one. Plain-English tricks fooled it 0 of 15, and fake tool output or a fake "buy 60" rule
0 of 10. See [attacks/](./attacks).

- **Pick a trick:** the listing panel offers the attacks in `attacks/` as one-click presets with
  their measured hit rates (`GET /v1/arena/attacks`), so a judge can choose one that works.
- **Skip the AI:** `POST /v1/arena/direct` fills the same cart with the ₹49,999 item and sends
  it to checkout with no model involved. It shows the wall holds whoever fills the cart, and is
  offered on screen whenever Gemma resists.

```bash
npm run arena:measure -- 10                 # hit rate for the current listing
npm run arena:measure -- 10 attacks/02-display-only-substitution.txt
npm run arena:reset                         # clear the run counter, restore default listing
```

## Configuration

| Variable | Needed? | Default / notes |
| :--- | :--- | :--- |
| `DATABASE_URL` | Yes | `postgresql://localhost:5432/manifest_db` |
| `PORT` | No | `4000` |
| `AGENT_AUTH_SECRET`, `GATEWAY_SHARED_SECRET` | In production | Random per process in development. Production refuses missing, short (< 32 chars) or published values |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | In production | Without them, payment calls fail (or are simulated, see below) |
| `RAZORPAY_WEBHOOK_SECRET` | In production | Required in production |
| `BOUND_CORS_ORIGINS` | In production | Comma-separated. Development allows `localhost:3000` and `:4000` |
| `BOUND_DEMO_ROUTES` | No | `false`. Registers `/v1/demo/*`, `/v1/arena/*`. Refused in production |
| `BOUND_SIMULATED_PAYMENTS` | No | `false`. Simulated rail and simulated Razorpay results. Refused in production |
| `BOUND_SANDBOX_AUTH` | No | `false`. Unauthenticated requests act as a demo agent. Refused in production; the demo doesn't need it |
| `BOUND_ALLOW_LEGACY_MANDATES` | No | `false`. Accept v1 mandates, which sign only five fields |
| `LLM_BASE_URL` | No | `http://localhost:11434/v1` (Ollama). Any OpenAI-compatible server with tool calls works |
| `LLM_MODEL` | No | `gemma4:e4b` |
| `LLM_REASONING_EFFORT` | No | `none`. Gemma 4 otherwise reasons silently once tools are attached (~15 s per step on an M2 vs ~1 s) |

## Tests

```bash
createdb bound_test
DATABASE_URL=postgresql://localhost:5432/bound_test npm run db:migrate
DATABASE_URL=postgresql://localhost:5432/bound_test npm test
```

165 tests in 12 files. They reseed the database they run against, so use a dedicated one.
None need the model or Razorpay keys, so CI proves the checks without Gemma. Per-suite detail
and mutation checks are in [docs/TEST_COVERAGE.md](./docs/TEST_COVERAGE.md).

| Suite | Tests | Covers |
| :--- | ---: | :--- |
| `tests/security/intent_authorization.test.ts` | 25 | ₹1,000 + injected ₹4,000 = ₹5,000 refused; legitimate espresso still works; spoofing, attributes, quantity, budget, task and mandate tampering |
| `tests/security/api_access.test.ts` | 31 | Auth with no fallback, demo routes absent, ownership, validation, CORS, webhook secret scoping, production config, static traversal |
| `tests/audit/evidence_integrity.test.ts` | 24 | Merkle receipts commit to nested fields; per-merchant audit chains; deletion and tamper detection |
| `tests/policy/policy_engine.test.ts` | 16 | Delegation narrowing, revocation cascade, mandate budgets, state machines |
| `tests/webhooks/webhook_verification.test.ts` | 15 | HMAC, dedup, secret rotation, out-of-order events |
| `tests/security/adversarial_attacks.test.ts` | 12 | WebAuthn (software authenticator), gateway replay, self-delegation, tenant isolation |
| `tests/concurrency/reservation_race.test.ts` | 11 | 20 buyers for 1 unit, lock ordering, hoarding limits |
| `tests/security/agent_guard.test.ts` | 8 | Scripted model: stop on refusal, malformed calls, run limits, foreign carts, pinned mandate |
| `tests/audit/audit_integrity.test.ts` | 8 | Hash chain, outbox atomicity, simulated anchor tamper detection |
| `tests/security/payments_strict.test.ts` | 6 | Provider failures never become success |
| `tests/pricing/money_rounding.test.ts` | 5 | Basis-point arithmetic and rounding |
| `tests/arena/direct_check.test.ts` | 4 | With no model, the ₹49,999 item is refused at the cart; only the flask is paid |

## API

Everything except health, capabilities and catalog needs authentication: an agent token, a
signed gateway envelope, or a human token with step-up. Agents only see their own carts and
orders. The demo and Arena routes exist only with `BOUND_DEMO_ROUTES=true`.

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/capabilities` | Machine-readable merchant profile |
| `GET` | `/v1/catalog/search` | Search the catalog |
| `GET` | `/v1/catalog/products/:id` | Product detail |
| `POST` | `/v1/agents/delegations` | Create a human-to-agent delegation (step-up required) |
| `POST` | `/v1/agents/delegations/:id/revoke` | Revoke a delegation |
| `POST` | `/v1/mandates` | Create a signed purchase mandate (`501` outside sandbox: keys must not travel to the server) |
| `GET` | `/v1/mandates/:id` | Mandate detail |
| `POST` | `/v1/mandates/:id/revoke` | Revoke a mandate |
| `POST` | `/v1/carts` | Create a cart |
| `POST` | `/v1/carts/:id/items` | Reserve stock and add to cart |
| `DELETE` | `/v1/carts/:id/items/:variantId` | Release a reservation |
| `GET` | `/v1/carts/:id` | Cart detail |
| `POST` | `/v1/carts/:id/negotiate` | Policy-bounded price negotiation |
| `POST` | `/v1/checkouts` | Start checkout (simulated rail with mandate, Razorpay otherwise) |
| `GET` | `/v1/orders/:id` | Order status and provenance receipt |
| `POST` | `/v1/webhooks/razorpay` | Razorpay webhook endpoint |
| `POST` | `/v1/webhooks/rotate-secret` | Rotate the webhook secret (step-up required) |
| `POST` | `/v1/payments/reconcile` | Retry uncertain refunds |
| `GET` | `/v1/audit`, `/v1/audit/stream` | Audit events (JSON, SSE); operator only |
| `POST` | `/v1/audit/checkpoint` | Sign and anchor a checkpoint (simulated store) |
| `GET` | `/v1/audit/verify`, `/v1/audit/verify-atomicity`, `/v1/audit/verify-worm` | Re-verify chain, outbox atomicity, anchors |
| `POST` | `/v1/audit/outbox/process` | Drain the outbox |
| `GET` | `/v1/arena` | Arena state: default goal, mandate template, current listing, counters |
| `PUT` | `/v1/arena/listing` | Rewrite the seller-controlled listing text (`null` restores the default) |
| `POST` | `/v1/arena/run` | One live agent run against the listing; `409` if one is running, `503` if the model is down |
| `GET` | `/v1/arena/stats` | Runs, times fooled, blocked, breaches, money lost |
| `POST` | `/v1/arena/direct` | The same injected cart with no model, straight to the cart and checkout |
| `POST` | `/v1/demo/*` | Demo helpers and scripted playbooks |

## Layout

```
src/
  agent/        buyer agent (local Gemma 4), guard.ts (argument checks, run limits), llm.ts, seller façade, tools
  intent/       taxonomy, resolver, purchase tasks, authorizeLineForTask
  crypto/       canonical JSON and domain-separated hashing
  config.ts     security configuration; fails closed in production
  arena/        live prompt-injection demo: catalog.ts (listings, mandate), service.ts (run, verdict)
  audit/        ledger.ts (hash chain), provenance.ts (Merkle receipts), anchoring.ts (simulated), outbox.ts, stream.ts
  cart/ catalog/ checkout/ inventory/ negotiation/ pricing/
  payments/     Razorpay + simulated adapters, refunds, reconciliation
  policy/       engine.ts, mandates.ts, mandate-signing.ts (v2), delegation.ts, risk.ts, webauthn.ts, state-machines.ts
  webhooks/     razorpay.ts, secrets.ts
  demo/         scripted playbooks, failure injection
  scripts/      run-buyer-agent.ts, measure-arena.ts, reset-arena.ts, run-demo-e2e.ts
  db/           schema.sql, migrate.ts, seed.ts
dashboard/      React + Vite Control Tower (scripted walkthroughs)
tests/          Vitest suites
attacks/        injection corpus with measured hit rates
docs/           ARCHITECTURE.md, SECURITY_ARCHITECTURE.md, THREAT_MODEL.md, SECURITY_FINDINGS.md,
                REMEDIATION_REPORT.md, TEST_COVERAGE.md, PRODUCTION_READINESS.md, QA.md
```

How each piece works, and exactly what is simulated, is in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
The security design, threat model, audit findings and what is still missing for production are
in [docs/SECURITY_ARCHITECTURE.md](./docs/SECURITY_ARCHITECTURE.md),
[docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) and
[docs/PRODUCTION_READINESS.md](./docs/PRODUCTION_READINESS.md).
Answers to the questions judges and reviewers ask, including "which parts are mocked?", are in
[docs/QA.md](./docs/QA.md). To contribute, start with [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE).
