# Bound Architecture

This is the deep reference for the deterministic layer that sits underneath the AI agents.
Each section says what the code does, where it lives, and what is simulated.
If a sentence here disagrees with the code, the code wins; please open an issue.

## Design rule

AI agents handle language: understanding a request, searching, comparing, negotiating.
Everything that moves stock, money, or state is decided by deterministic code that the
model cannot argue with: pricing math, mandate checks, inventory locks, state transitions,
and the audit log.

## 1. Capability discovery

`GET /v1/capabilities` ([src/agent/capabilities.ts](../src/agent/capabilities.ts)) returns a
machine-readable profile so a buyer agent can learn, before transacting, that the Razorpay rail
is interactive (a human must authorise payment) and that autonomous purchases only run on the
test-only simulated rail. `audit.kms_worm_storage` reports `SIMULATED`.

## 2. Buyer agent and seller agent

- **Buyer agent** ([src/agent/buyer-agent.ts](../src/agent/buyer-agent.ts)): calls the merchant
  tools in [src/agent/tools.ts](../src/agent/tools.ts) through a local open model: Gemma 4
  (`gemma4:e4b`) served by Ollama, via the OpenAI-compatible client in
  [src/agent/llm.ts](../src/agent/llm.ts). The system prompt is deliberately not hardened
  against prompt injection; the spending limit is enforced at checkout instead. If the model
  server is down the agent raises `LlmUnavailableError`; there is no fallback planner.
- **Seller agent** ([src/agent/seller-agent.ts](../src/agent/seller-agent.ts)): a façade that
  formats dialogue and explanations. It contains no model; every decision is delegated to the
  engines below.
- **Margin confidentiality**: negotiation responses never reveal the merchant's margin floor.

## 3. Two payment rails

| Rail | When | What actually happens |
| :--- | :--- | :--- |
| `MOCK_SIMULATED_RAIL` | Checkout with a valid signed purchase mandate | Simulated capture ([src/payments/adapters/mock.ts](../src/payments/adapters/mock.ts)). No money moves. Allowed when `NODE_ENV !== 'production'` or `ENABLE_SIMULATED_PAYMENT_RAIL=true`. |
| `RAZORPAY_STANDARD` | Checkout without a mandate | Creates a Razorpay Test Mode order ([src/payments/adapters/razorpay.ts](../src/payments/adapters/razorpay.ts)) and requires a human to pay. If the Razorpay call fails (e.g. no keys), it falls back to a locally generated `order_test_…` id with a console warning. |

Our Razorpay Test Mode integration needs a human to approve each payment, so autonomous
capture runs on a simulated, test-only rail.

## 4. Razorpay webhook verification

[src/webhooks/razorpay.ts](../src/webhooks/razorpay.ts):
- Constant-time HMAC-SHA256 over the raw body; invalid signatures are rejected fail-closed and logged.
- Deduplication on the provider event id.
- Amount and currency are checked against the stored order before state changes.
- The Razorpay payments API is queried only on one path (a late `authorized` event for a
  reservation whose stock is gone). If that call fails, it currently falls back to
  `status: 'authorized'` silently; this is a known issue.
- The demo playbooks and `npm run demo:e2e` generate and sign their own webhooks with the test
  secret. They are labelled `TEST_INJECTION`, not Razorpay deliveries.

## 5. Webhook secret rotation

[src/webhooks/secrets.ts](../src/webhooks/secrets.ts): verifies against the primary secret,
then falls back to the previous secret within its grace window. The database stores secret
handles, not plaintext. The handle resolver is an in-memory mock; `kms://` handles are not
resolved against a real KMS.

## 6. WebAuthn step-up

[src/policy/webauthn.ts](../src/policy/webauthn.ts) implements the server side of an assertion
check: challenge with TTL, RP-ID hash, UP/UV flags, and a signature over
`authenticatorData || SHA-256(clientDataJSON)`. The demo and tests use a **software
authenticator whose key pair is generated on the server**. There is no browser passkey flow yet.

## 7. Signed mandates and delegation narrowing

- Purchase mandates are Ed25519-signed ([src/policy/mandates.ts](../src/policy/mandates.ts)).
  **The signature covers** `token:agent:merchant:ceiling:nonce`. Categories, SKU prefixes, the
  per-transaction limit and expiry are stored with the mandate and enforced at checkout, but are
  **not** part of the signed message yet, so someone with database write access could widen them.
  Covering them is an open issue.
- `validateDelegationSubset` ([src/policy/delegation.ts](../src/policy/delegation.ts)): a child
  delegation can never exceed its parent: amount ≤ parent, expiry ≤ parent, categories ⊆ parent.
- Revoking a parent invalidates child mandates; lowering a parent ceiling constrains children;
  agents cannot delegate to themselves (`403 AGENT_CANNOT_SELF_DELEGATE`).

## 8. Policy engine

[src/policy/engine.ts](../src/policy/engine.ts) combines four answers into one decision:
unit economics (margin floor), authorization (mandate valid?), rail capability (can it run
autonomously?), and risk. Any denial wins; otherwise the result is `AUTO_EXECUTABLE` or
`REQUIRES_USER_ACTION`.

A denied checkout rolls back its transaction, so nothing is reserved, ordered or paid. The
denial is then written to the audit ledger outside that transaction (`checkout.denied`); before
this fix, the policy engine's own audit event was rolled back with everything else.

## 9. Five state machines

[src/policy/state-machines.ts](../src/policy/state-machines.ts) keeps checkout, reservation,
payment, order and refund lifecycles separate:

1. `CheckoutStatus`: `OPEN → AWAITING_AUTH → PAID / CANCELLED / PAYMENT_ATTEMPT_FAILED`
2. `ReservationStatus`: `ACTIVE → COMMITTED / RELEASED / EXPIRED`
3. `PaymentStatus`: `PENDING → AUTHORIZED → CAPTURED → REFUNDED / PARTIALLY_REFUNDED`
4. `OrderStatus`: `PENDING_CONFIRMATION → CONFIRMED → PROCESSING → SHIPPED → DELIVERED`, or `FULFILMENT_EXCEPTION`
5. `RefundStatus`: `REQUIRED → SUBMITTED → PROCESSING → PROCESSED`, or `REFUND_UNCERTAIN` on timeout

## 10. Inventory reservation

[src/inventory/reservation.ts](../src/inventory/reservation.ts):
- `SELECT … FOR UPDATE` row locks held only while the reservation row is written; the hold
  itself lasts 10 minutes. Tests assert lock time under 50 ms.
- Multi-SKU reservations lock in ascending variant id order to avoid deadlocks (`reserveMultiStock`).
- Database constraints: `reserved_qty <= stock_qty`, `stock_qty >= 0`, `reserved_qty >= 0`.
- Release is idempotent.

## 11. Hoarding (Sybil) defense

Reservations on scarce SKUs are grouped by linked identity. A `DEFINITE_LINK` (same principal,
agent, or payment hash) is limited to one active reservation per SKU; a `PROBABILISTIC_LINK`
raises risk instead of blocking.

## 12. Audit ledger, outbox and checkpoints

- **Hash chain** ([src/audit/ledger.ts](../src/audit/ledger.ts)): each event is SHA-256 over
  RFC 8785 canonical JSON, linked to the previous hash. `GET /v1/audit/verify` re-walks the chain.
- **Transactional outbox** ([src/audit/outbox.ts](../src/audit/outbox.ts)): state changes and
  their outbox rows commit in the same transaction. Draining (`POST /v1/audit/outbox/process`)
  and the atomicity check (`GET /v1/audit/verify-atomicity`) run **on demand**; there is no
  background daemon.
- **Merkle provenance receipts** ([src/audit/provenance.ts](../src/audit/provenance.ts)):
  per-order Merkle tree with inclusion proofs.
- **Checkpoint anchoring** ([src/audit/anchoring.ts](../src/audit/anchoring.ts)): **simulated.**
  The chain head is signed with an Ed25519 key generated in-process and stored in an in-memory
  write-once map. It detects database rows rewritten after a checkpoint, but only within one
  process lifetime. There is no AWS KMS key and no S3 Object Lock bucket; the `kmsKeyArn` and
  `wormRetentionPolicy` fields are kept so a real adapter can slot in later.

## 13. Fulfilment exceptions and refunds

- A late `authorized` webhook on an expired hold re-checks stock; if it is gone, the payment is
  not captured and a refund path starts.
- A capture after stock is exhausted moves the order to `FULFILMENT_EXCEPTION` and creates a
  compensation refund ([src/payments/refunds.ts](../src/payments/refunds.ts)).
- Refund timeouts go to `REFUND_UNCERTAIN` and are retried by
  [src/payments/reconciliation.ts](../src/payments/reconciliation.ts) (`POST /v1/payments/reconcile`).

## 14. Money arithmetic

[src/pricing/atomic-evaluator.ts](../src/pricing/atomic-evaluator.ts): all amounts are integer
paise; discounts are basis points; `roundDivision` rounds half-up. No floating point touches money.

## Gateway request signing

[src/middleware/auth.ts](../src/middleware/auth.ts) accepts internal requests signed with
`X-Gateway-Timestamp`, `X-Gateway-Nonce` and
`X-Gateway-Signature = HMAC-SHA256(secret, timestamp.nonce.method.path.sha256(body))`, with a
freshness window and nonce replay protection.

## Arena: live prompt-injection demo

[src/arena/](../src/arena) runs the buyer agent against a seller-controlled listing and reports
what happened, using only the real engines above.

- **Listing:** the ChaiKeeper flask's description (`PUT /v1/arena/listing`) is the injection
  surface. Search results pass descriptions to the model untouched.
- **Mandate:** each run generates an Ed25519 key, binds it to the Arena buyer agent, and signs a
  fresh ₹5,000 mandate for Kitchen / Drinkware / Coffee Machines. The key stands in for the
  human's device key and is discarded after signing. The mandate records its `key_id`, and
  verification uses exactly that key, so runs from different processes never invalidate each
  other. Each server still runs one Arena run at a time (`409` otherwise) to keep the screen readable.
- **Direct check:** `runDirectCheck()` builds the same over-limit cart without the model and
  sends it through the real checkout. It backs the "skip the AI" button and the
  `tests/arena/direct_check.test.ts` suite, which proves the wall in CI with no model.
- **Agent:** local Gemma 4, told the signed limit, with no injection hardening in its prompt.
- **Verdict** ([service.ts](../src/arena/service.ts) `judgeRun`): *fooled* if the agent added the
  payload variant or checkout was denied for a mandate reason (`MANDATE_EXHAUSTED`,
  `CATEGORY_DISALLOWED`, …). Outcomes: `BLOCKED`, `FOOLED_NO_CHECKOUT`, `PURCHASED`,
  `NO_PURCHASE`, and `BREACH` (fooled and an injected item was paid for; should never happen).
- **Record:** every run is written to `arena_runs` and to the audit ledger (`arena.run`); open
  carts are released so repeated runs don't trip the hoarding limits.

Catalog search matches *any* query term, ranked by how many match, so natural-language agent
queries ("metal chai warmer") find results.
