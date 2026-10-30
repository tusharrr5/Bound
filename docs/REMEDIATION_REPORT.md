# Remediation report

Baseline `555feac` (`main`). Work on branch `security-hardening`. Findings are defined in
[SECURITY_FINDINGS.md](./SECURITY_FINDINGS.md).

"Fixed" means changed in code and covered by a test that fails without the change, unless the
row says otherwise. Test counts are from `npm test` on an isolated database (`bound_test`).

## Commits

| Commit | Scope |
|---|---|
| `1eeada8` | Intent-bound purchase tasks, v2 mandate signatures, checkout consistency |
| `5229a0b` | Fail-closed auth and config, route ownership, strict payment adapter, merchant-scoped webhooks |
| `012bc53` | Merkle leaf fix, per-merchant audit chains and checkpoints |
| `e6cc7fc` | Agent loop guards, Arena UI, demo launcher flags, task-bound scripts and playbook |
| `7026857` | Dependency upgrades; `npm audit` clean |

## Findings

| ID | Status | What changed | Tests |
|---|---|---|---|
| F-01 | **Fixed** | Purchase tasks with a deterministic resolver; typed products; `authorizeLineForTask` at cart and at checkout | `intent_authorization` (25), including the ₹1,000 + ₹4,000 = ₹5,000 scenario |
| F-02 | **Fixed** | No sandbox principal unless `BOUND_SANDBOX_AUTH=true`; production refuses it | `api_access`, `adversarial_attacks` |
| F-03 | **Fixed** | An invalid token is `401 INVALID_TOKEN` | `api_access` |
| F-04 | **Fixed** | `x-gateway-secret` removed; only signed envelopes | `api_access`, `adversarial_attacks` |
| F-05 | **Fixed** | Demo and simulation routes are not registered unless `BOUND_DEMO_ROUTES=true`; production refuses it | `api_access` (6 routes → 404) |
| F-06 | **Fixed** | Owner checks on every cart, checkout and order route and in the agent tools | `api_access`, `agent_guard` |
| F-07 | **Fixed** | Strict adapter; errors throw `PaymentProviderError`; simulated results labelled | `payments_strict` (6) |
| F-08 | **Fixed** | v2 signature over all enforced fields plus task and intent hash; v1 refused by default | `intent_authorization` (field tamper, downgrade) |
| F-09 | **Fixed** | `private_key_pem` in a request body → `501` outside sandbox | `api_access` |
| F-10 | **Fixed** | Merchant derived from the order; scoped secret lookup | `api_access` |
| F-11 | **Fixed** | `config.ts`: production refuses missing, short or published secrets; dev uses random per-process secrets | `api_access` (8 production config cases) |
| F-12 | **Fixed** | Cart/quote hash bindings fail closed | `intent_authorization` |
| F-13 | **Fixed** | Cart locked and read inside the checkout transaction; lines re-authorized | `intent_authorization` (checkout denial on an injected line) |
| F-14 | **Fixed** | `addToCart` refuses a variant from another merchant (`MERCHANT_MISMATCH`) | `intent_authorization` |
| F-15 | **Fixed** | Canonical-JSON leaves with key binding; leaf/node domain separation; odd-node promotion; duplicate keys refused | `evidence_integrity` (19 Merkle tests) |
| F-16 | **Fixed** | Per-merchant sequence uniqueness and chain walk; ledger-head check; merchant-bound checkpoints | `evidence_integrity` (5 ledger tests) |
| F-17 | **Fixed** | Nonces consumed once and kept for 5 minutes | `adversarial_attacks` |
| F-18 | **Fixed** | Operator or human auth on mandate, audit and reconciliation routes; Arena behind demo flag; CORS allowlist | `api_access` |
| F-19 | **Fixed** | Seller text grouped under `seller_listing`; schema validation; run limits; stop on first authorization refusal | `agent_guard` (8; 3 fail with the stop rule disabled) |
| F-20 | **Fixed** | Simulated rail only with `BOUND_SIMULATED_PAYMENTS=true` | `payments_strict`, `api_access` production config |
| F-21 | **Fixed** (at time of writing) | `npm audit fix`; `@fastify/static` 10.1.8; vitest 5; unused `zod` removed | `api_access` static traversal test; `npm audit` → 0 for backend and dashboard |
| F-22 | **Fixed** | Human tokens carry no agent id | `api_access` (human routes) |

## Found and fixed along the way

- Playbook 1 looked up SKU `COFFEE-ESPR-BLK`, which isn't in the seed, so it would have
  crashed. It also reported "payment captured" whatever checkout returned. It now buys
  `BREW-42-BLK` under a task-bound mandate and reports the real result.
- The audit unique constraint on `sequence_number` was global although sequences are per
  merchant. It is now `(merchant_id, sequence_number)`.
- `verifyPurchaseMandate` selected two columns with the same alias (`delegation_version`).

## Verified

- `npm test`: **165 / 165 passed**, 12 files, run serially (`--no-file-parallelism`) against `bound_test`.
- `tsc --noEmit` is clean; the dashboard type-checks and builds.
- Mutation checks: with intent authorization disabled, 9 tests in `intent_authorization` fail;
  with the agent stop rule disabled, 3 tests in `agent_guard` fail.
- `npm audit`: 0 vulnerabilities (backend and dashboard).
- Live Gemma runs on the hardened branch: see [attacks/README.md](../attacks/README.md).

## Not done

See the residual risks in [THREAT_MODEL.md](./THREAT_MODEL.md) and the blockers in
[PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md). The main ones: client-side mandate
signing, a human confirmation flow for ambiguous tasks, real anchoring, and shared state for
nonces and rate limits.
