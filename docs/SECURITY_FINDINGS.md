# Security findings

Baseline: commit `555feac` (`main`), audited on branch `security-hardening`, 31 Oct 2026.
Every finding below was verified by reading the code at that commit; none is taken from
documentation. Status is updated in [REMEDIATION_REPORT.md](./REMEDIATION_REPORT.md).

Severity: **Critical** = money or authority can be taken without authorization. **High** = a
security property the project claims does not hold. **Medium** = defence-in-depth gap or
misleading result. **Low** = hygiene.

| ID | Severity | Area | Finding (as found at baseline) | Where |
|---|---|---|---|---|
| F-01 | Critical | Intent | Authorization was financial only. Any in-budget product could enter a cart and be bought; nothing tied cart lines to what the human asked for. | `cart/service.ts`, `checkout/service.ts`, `policy/engine.ts` |
| F-02 | Critical | Auth | Requests with no credentials became a default `BUYER_AGENT` (`SANDBOX_DEFAULT`) with cart and checkout scopes, in every environment. | `middleware/auth.ts` `extractPrincipal` |
| F-03 | Critical | Auth | An invalid bearer token silently fell back to the same default principal. | `middleware/auth.ts` |
| F-04 | Critical | Auth | Legacy `x-gateway-secret` header compared (non-constant-time) against a fallback secret published in the repo; together with `x-buyer-agent-id` it let anyone act as any agent. | `middleware/auth.ts` |
| F-05 | Critical | API | `POST /v1/demo/simulate-payment-success` (marks any order paid), `/simulate-payment-failure` and `/inject-failure` were unauthenticated and registered in production. | `server.ts` |
| F-06 | Critical | Ownership | Cart read/add/remove, checkout and order read performed no ownership check; several handlers never read the principal. | `server.ts` |
| F-07 | Critical | Payments | Provider errors became success: `fetchRazorpayPayment` → `authorized`, `captureRazorpayPayment` → `captured`, refund create/fetch → `processed`, order creation → invented `order_test_…` id. | `payments/adapters/razorpay.ts` |
| F-08 | High | Mandates | Ed25519 signature covered only `token:agent:merchant:ceiling:nonce`; categories, per-txn limit, expiry, currency, task were unsigned and could be widened by anyone with DB write. | `policy/mandates.ts`, `db/seed.ts` |
| F-09 | High | Keys | `POST /v1/mandates` accepted a raw `private_key_pem` in the request body, falling back to `AGENT_TEST_PRIVATE_KEY`. | `server.ts` |
| F-10 | High | Webhooks | With no merchant id, secret lookup matched every merchant's secrets (`merchant_id = $1 OR merchant_id IS NULL` with `$1` null → all rows), so one merchant's secret authenticated another's payments. | `webhooks/secrets.ts` |
| F-11 | High | Secrets | Hardcoded fallback JWT secret, gateway secret, webhook secret and Razorpay key; nothing failed at startup in production. | `middleware/auth.ts`, `webhooks/*`, `payments/adapters/razorpay.ts` |
| F-12 | High | Mandates | Cart/quote hash binding was skipped whenever either side was absent (`row.cart_hash && cartHash && …`). | `policy/mandates.ts` |
| F-13 | High | Checkout | `startCheckout` read the cart through the global pool (`getCart`) inside its transaction, without locking the cart, so lines could change during quote construction. | `checkout/service.ts` |
| F-14 | High | Merchant isolation | `addToCart` did not check that the variant belongs to the cart's merchant. | `cart/service.ts` |
| F-15 | High | Provenance | `hashLeafData` used `JSON.stringify(data, Object.keys(data).sort())`; the replacer array drops nested keys not present at top level, so nested product fields were not committed. No leaf/node domain separation. | `audit/provenance.ts` |
| F-16 | Medium | Audit | `verifyAuditLedger` walked all events in one global sequence although sequences are per merchant, so multi-merchant ledgers verify incorrectly. | `audit/ledger.ts` |
| F-17 | Medium | Auth | Gateway nonces were not consumed in `extractPrincipal` (`consumeNonce: false`), allowing replay inside the 60 s window; the in-memory nonce set was cleared at 10,000 entries. | `middleware/auth.ts` |
| F-18 | Medium | API | Mandate read/revoke, reconciliation, audit read/verify/checkpoint/outbox and all Arena routes were unauthenticated. CORS was `*`. | `server.ts` |
| F-19 | Medium | Agent | Seller-written descriptions were passed to the model inside tool results with no marking as untrusted; the agent kept calling tools after an authorization failure. | `agent/buyer-agent.ts` |
| F-20 | Medium | Simulated rail | The simulated autonomous rail was enabled whenever `NODE_ENV !== 'production'`, i.e. by default. | `checkout/service.ts` |
| F-21 | Medium | Supply chain | `npm audit`: high advisories in `fastify`, `@fastify/static`, `zod` (declared, unused), `fast-uri`, `follow-redirects`, `brace-expansion`; dashboard dev tooling (`vite`, `source-map-js`, `postcss-selector-parser`). | lockfiles |
| F-22 | Low | Auth | Human tokens were mapped to a hardcoded buyer-agent id. | `middleware/auth.ts` |

Baseline verification: `npm test` 71/71 passed, `tsc` clean, both builds succeed — the
findings above are design and logic flaws that the existing tests did not exercise.
