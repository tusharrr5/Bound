# Security architecture

How Bound decides what an AI agent may buy, and where each decision is enforced. Threats are in
[THREAT_MODEL.md](./THREAT_MODEL.md); what changed from the audited baseline is in
[REMEDIATION_REPORT.md](./REMEDIATION_REPORT.md). If this page disagrees with the code, the code
wins.

## The rule

The model is untrusted. It reads seller-written text and can be talked into anything. So no
decision about money, stock or authority depends on what the model says. The model can only
*propose* tool calls; deterministic server code decides whether each one may happen.

## Four questions, four places

A purchase goes through only if all four answers are yes. Each one is checked on the server,
from data the model cannot write.

| Question | Decided by | From | Enforced at |
|---|---|---|---|
| Is the caller who it claims to be? | `middleware/auth.ts` | Signed token or signed gateway envelope | Every non-public route |
| Is this the caller's cart / order? | `server.ts` `ownedCart`, `agent/tools.ts` `cartForRun` | `carts.buyer_agent_id`, `orders.buyer_agent_id` | Every cart, checkout and order access |
| Did the human ask for this product? | `intent/authorize.ts` `authorizeLineForTask` | The purchase task + merchant-verified `product_type` and `verified_attributes` | `addToCart`, and again for every line at checkout |
| Is it within what the human signed? | `policy/mandates.ts` `verifyPurchaseMandate` | v2 Ed25519 signature over every enforced field | Checkout |

### 1. Purchase tasks: what the human asked for

A human request ("something to keep my chai hot, no plastic") becomes a **purchase task**
(`purchase_tasks`, [intent/tasks.ts](../src/intent/tasks.ts)):

- `intent/resolver.ts` maps the words to exactly one intent in a closed taxonomy
  ([intent/taxonomy.ts](../src/intent/taxonomy.ts)), e.g. `keep_beverage_hot` →
  `vacuum_flask`, `insulated_mug`, `mug_warmer`; "no plastic" → `plastic_contact: false`.
- If the words match no intent or more than one, the task is `PENDING_CONFIRMATION` and cannot
  authorize anything until a human picks. The resolver never guesses.
- Budget, quantity limits, merchant, agent and expiry are fixed when the task is created. The
  budget comes from the human's side, never from the model.
- The task's authorization fields are hashed (`intent_hash`, domain `bound.purchase-task.v1`)
  and that hash is inside the mandate signature. Editing a task row afterwards is detected.

The product side of the comparison is `products.product_type` and
`products.verified_attributes`. These are set by the merchant's catalog process, not by the
listing's title or description. A listing that *says* it is a flask, or that tells the agent to
buy something else, changes nothing: the check reads the typed column.

`authorizeLineForTask` refuses, in this order: a tampered or inactive or expired task, a
different agent or merchant, an untyped product (needs a human), an excluded or
non-allowlisted variant, a product type outside the task (`PRODUCT_NOT_AUTHORIZED_FOR_TASK`),
a missing or wrong required attribute, too many units, or a line that would push the cart over
the task budget.

**The acceptance scenario.** Task: "keep my chai hot", ₹5,000. The agent adds a ₹1,000 chai
warmer (allowed), then a seller-injected ₹4,000 espresso machine. The total is exactly ₹5,000,
so a spending limit alone would let it through. The cart refuses the espresso machine with
`PRODUCT_NOT_AUTHORIZED_FOR_TASK`. If it is forced into the table directly, checkout refuses the
whole cart. A separate task that says "espresso machine" buys one normally.
(`tests/security/intent_authorization.test.ts`)

### 2. Mandates v2: what the human signed

A mandate ([policy/mandate-signing.ts](../src/policy/mandate-signing.ts)) is Ed25519 over
canonical JSON with domain tag `bound.mandate.v2`, covering: token, agent, merchant, ceiling,
per-transaction limit, currency, categories, SKU prefixes, not-before, expiry, nonce, key id,
purchase task id and the task's intent hash.

- Any change to any of those fields breaks the signature.
- v1 mandates (which signed only five fields) are refused with
  `SIGNATURE_VERSION_UNSUPPORTED` unless `BOUND_ALLOW_LEGACY_MANDATES=true`.
- A mandate names its key; verification uses exactly that key.
- Cart and quote hash bindings fail closed: if the mandate is bound to a hash, a missing or
  different hash is refused.
- An autonomous checkout needs a task-bound cart and a mandate for the same task
  (`AUTONOMOUS_CHECKOUT_REQUIRES_TASK`, `MANDATE_TASK_MISMATCH`).

### 3. Checkout: one consistent read

`startCheckout` locks the cart row (`SELECT … FOR UPDATE`) inside its transaction, reads every
line through that transaction, re-authorizes every line against the task, verifies the mandate,
and only then quotes. A denial rolls back and is written to the audit log as `checkout.denied`.

## Identity and access

- **No default identity.** No credentials gives `401`, and so does an invalid token. The old
  sandbox fallback exists only when `BOUND_SANDBOX_AUTH=true`, which production refuses.
- **Agent tokens** are HMAC-signed with a secret from config. **Gateway envelopes** are
  HMAC-signed over timestamp, nonce, method, path and body hash. Each nonce is consumed once and
  kept for 5 minutes. The old `x-gateway-secret` header is gone.
- **Human-only actions** (delegations, mandate creation, secret rotation) need a human
  principal with step-up. Agents get `403 AGENT_CANNOT_SELF_DELEGATE`.
- **Private keys never travel in requests.** `POST /v1/mandates` with `private_key_pem` returns
  `501 CLIENT_SIDE_SIGNING_REQUIRED` outside sandbox mode.
- **Ownership.** Another agent's cart or order is `404`. Audit, reconciliation and outbox routes
  need an operator (`ops:read`).
- **Edges.** CORS allowlist, 256 KB body limit, rate limits (global, plus tighter limits on
  checkout and agent runs), and error responses with no internal detail.

## The agent loop

[agent/buyer-agent.ts](../src/agent/buyer-agent.ts) and [agent/guard.ts](../src/agent/guard.ts):

- Every tool call is validated against a strict per-tool schema before it runs: types, UUID
  ids, ranges, and no unknown fields. A malformed call gets `INVALID_TOOL_CALL`; three end the run.
- Each run is bounded: 16 tool calls, 4 per turn, 6 cart changes, 2 carts, 1 checkout, 10 model turns.
- The first authorization refusal ends the run (`BLOCKED_BY_POLICY`). A fooled agent does not
  get to try again; the human decides.
- Identity comes from the principal, never from tool arguments. The cart must belong to the
  agent and to the run's task. Checkout uses only the mandate issued for the run.
- Seller text reaches the model under `seller_listing`, separate from the platform's facts (id,
  price, stock). The prompt says that text is not instructions. **Security does not depend on
  the model honouring that.**

## Payments

[payments/adapters/razorpay.ts](../src/payments/adapters/razorpay.ts) runs in one of three modes,
chosen once at startup:

- **razorpay** (keys set): every provider error is thrown as `PaymentProviderError`
  (`REJECTED` or `UNAVAILABLE`). It is never reported as authorized, captured or processed.
- **simulated** (no keys, `BOUND_SIMULATED_PAYMENTS=true`): synthetic results are marked
  `simulated: true`, with ids prefixed `order_sim_` or `rfnd_sim_`.
- **unconfigured**: every call fails with `NOT_CONFIGURED`.

The simulated autonomous rail at checkout is also gated on `BOUND_SIMULATED_PAYMENTS`.
Reconciliation keeps a refund `REFUND_UNCERTAIN` when the provider cannot answer.

Webhooks: the merchant is derived from the order the event refers to, and only that merchant's
secrets (plus platform secrets) are tried. An event for an unknown order matches platform
secrets only.

## Evidence

- **Audit ledger**: one hash chain per merchant, plus a system chain. Sequence numbers are
  unique per merchant. `verifyAuditLedger` walks each chain from genesis and checks that each
  ledger head matches the end of its chain, which detects events deleted from the end.
- **Checkpoints**: per merchant; the v3 signature payload includes the merchant id.
- **Merkle receipts**: each leaf is `domainHash('bound.merkle.leaf.v1', {key, data})` over
  canonical JSON, so nested product fields are committed. Internal nodes use a separate tag. An
  odd node is promoted, not duplicated, and duplicate keys are refused.
- **Anchoring is simulated**: an in-memory store with a locally generated key. See
  [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md).

## Configuration

[src/config.ts](../src/config.ts) is loaded before anything reads the environment.

| Flag | Default | Effect | Production |
|---|---|---|---|
| `BOUND_SANDBOX_AUTH` | off | Unauthenticated requests act as a fixed demo agent | refused |
| `BOUND_DEMO_ROUTES` | off | Registers `/v1/demo/*`, `/v1/arena/*`, `/internal/test/*`; demo mode counts as operator for audit reads | refused |
| `BOUND_SIMULATED_PAYMENTS` | off | Simulated rail and simulated Razorpay adapter | refused |
| `BOUND_ALLOW_LEGACY_MANDATES` | off | Accept v1 (five-field) mandate signatures | allowed, not advised |

In production, missing secrets, secrets shorter than 32 characters, or values published in this
repository stop startup. So do a missing CORS allowlist, missing Razorpay keys and a missing
webhook secret. In development, unset secrets get a random value per process. `npm run demo`
turns on demo routes and simulated payments for its own process, prints that, and refuses
`NODE_ENV=production`.
