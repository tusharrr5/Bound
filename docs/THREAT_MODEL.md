# Threat model

Scope: the Bound backend, the buyer agent loop, and the Arena demo, as on branch
`security-hardening`. Controls are described in
[SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md). This is a prototype; see
[PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md) for what a real deployment would still need.

## What we protect

1. **The human's money**: nothing is paid beyond, or outside, what they asked for and signed.
2. **The human's authority**: delegations and mandates can't be created, widened or reused by anyone else.
3. **Merchant stock**: reservations can't be hoarded or stolen across carts.
4. **Evidence**: the audit trail and receipts show what happened, and tampering is detectable.
5. **Secrets**: signing keys, webhook secrets, provider keys.

## Who attacks

| Actor | Can | Cannot (by assumption) |
|---|---|---|
| **Malicious seller / listing author** | Write any title, description or summary on their own listing | Change `product_type` / `verified_attributes` (the merchant's catalog process sets those) |
| **Fooled model** | Call any tool with any arguments, in any order, as often as allowed | Read or forge server secrets; act outside its authenticated principal |
| **Other agent / tenant** | Hold its own valid token | Hold another agent's token |
| **Network attacker** | Replay, reorder, forge requests and webhooks | Break HMAC-SHA256 or Ed25519 |
| **Operator with DB write** | Edit rows | Sign as the human (no private key on the server, except in demo mode) |
| **Misconfigured deployment** | Ship with demo flags or default secrets | — |

## Threats and controls

| # | Threat | Control | Test | Residual |
|---|---|---|---|---|
| T1 | Injected listing makes the agent buy a different product **under** the budget (₹1,000 + ₹4,000 = ₹5,000) | Purchase task + typed products; refused at cart and at checkout | `intent_authorization` acceptance scenario | A same-type but worse item within budget (e.g. a dearer flask) is still allowed; it is bounded by type, attributes, quantity and budget |
| T2 | Injected listing makes the agent overspend | Mandate ceiling at checkout; task budget at cart | `direct_check`, `intent_authorization` | — |
| T3 | Listing claims to be a different product type ("this is a flask") | Authorization reads `product_type`, not listing text | `intent_authorization` spoofing test | A merchant that mislabels its own catalog is trusted (see R2) |
| T4 | Model buys 60 units | Quantity limits on the task; 1–100 per mutation | `intent_authorization` quantity test | — |
| T5 | Model invents ids or uses another agent's cart, task or mandate | Schema validation; ownership and task checks in tools and routes; mandate pinned per run | `agent_guard`, `api_access` | — |
| T6 | Model keeps retrying after a refusal | Run stops at the first authorization refusal; run limits | `agent_guard` | — |
| T7 | Unauthenticated or invalid-token caller acts as an agent | No fallback identity; `401` | `api_access`, `adversarial_attacks` | — |
| T8 | Replayed gateway request | Nonce consumed once, 5-minute retention | `adversarial_attacks` | In-memory nonce store: not shared across processes (R4) |
| T9 | Anyone marks an order paid | Demo routes absent unless `BOUND_DEMO_ROUTES`; production refuses the flag | `api_access` | — |
| T10 | DB writer widens a mandate (categories, expiry, limit) or retargets its task | v2 signature over every enforced field + intent hash | `intent_authorization` tamper tests | v1 rows if `BOUND_ALLOW_LEGACY_MANDATES` is set |
| T11 | DB writer edits a purchase task | Recomputed intent hash vs stored vs signed | `intent_authorization` | — |
| T12 | Cart changes between authorization and payment | Cart locked and re-read inside the checkout transaction; lines re-authorized | `intent_authorization` checkout denial | — |
| T13 | Provider outage reported as success | Strict adapter; `PaymentProviderError`; refunds stay uncertain | `payments_strict` | — |
| T14 | One merchant's webhook secret authenticates another's events | Merchant derived from the order; scoped secret lookup | `api_access` webhook test | — |
| T15 | Rewritten or deleted audit events | Per-merchant hash chains, ledger-head check, signed checkpoints | `evidence_integrity`, `audit_integrity` | Anchors are in memory (R3) |
| T16 | Receipt altered in a nested field | Canonical-JSON Merkle leaves with key binding and domain separation | `evidence_integrity` | — |
| T17 | Deployed with demo flags or published secrets | Config fails closed in production | `api_access` production config tests | Non-production deployments are the operator's responsibility |
| T18 | Path traversal through static file serving | `@fastify/static` 10.1.8 | `api_access` static test | — |
| T19 | Vulnerable dependencies | `npm audit` 0 at time of writing | — | New advisories appear over time |
| T20 | Resource exhaustion | Body limit, rate limits, run limits, one Arena run per process | `agent_guard` | Rate limits are per process, in memory |

## Residual risks (accepted for this prototype)

- **R1. Human keys live on the server in demo flows.** `createTaskBoundMandate` generates the
  signing key on the server and discards it after signing. Client-side signing is not built
  (`POST /v1/mandates` refuses server-side keys outside sandbox). In demo mode, a server
  compromise can therefore sign mandates.
- **R2. Catalog typing is trusted.** `product_type` and `verified_attributes` come from seed
  data. A real deployment needs a catalog review process, and a merchant that mislabels its own
  products is outside this model.
- **R3. Anchoring is simulated.** Checkpoints are anchored in an in-memory store that resets on
  restart. They catch DB rewrites only within one process lifetime.
- **R4. Single-process state.** Gateway nonces, rate-limit counters and the Arena run lock are
  in memory.
- **R5. Closed intent taxonomy.** Requests outside it go to `PENDING_CONFIRMATION`, and there is
  no human confirmation UI or API yet. The fail-safe is "refuse", not "guess".
- **R6. WebAuthn uses a software authenticator** generated on the server.
- **R7. The model can still be fooled.** Hardening the prompt and marking seller text reduce
  how often; the controls above bound what a fooled model can do. They do not make it wise.
