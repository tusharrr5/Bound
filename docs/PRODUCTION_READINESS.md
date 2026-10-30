# Production readiness

**Level: hardened prototype.** Suitable for a local demo and for code review. **Not suitable
for real payments or real users.** No software is free of vulnerabilities, and this page lists
what we know is missing, not everything that could go wrong.

## Ready

- Authorization that doesn't trust the model: purchase tasks, typed products, v2 mandates,
  and checkout re-verification.
- Fail-closed configuration: production refuses demo flags and missing, short or published secrets.
- Authenticated, owner-scoped API with rate and body limits.
- A strict payment adapter that never reports a provider failure as success.
- Per-merchant tamper-evident audit chains and corrected Merkle receipts.
- 165 automated tests, including mutation-checked security tests; `npm audit` clean at the time of writing.

## Blockers before any real deployment

| # | Blocker | Why it matters |
|---|---|---|
| 1 | **Client-side mandate signing.** The human's key must stay on their device (passkey or secure enclave). Today demo flows generate it on the server, and the API refuses server-side keys otherwise, so there is no production path to create a mandate. | Otherwise a server compromise can sign spending authority. |
| 2 | **Human confirmation flow** for `PENDING_CONFIRMATION` tasks, and an API for humans to create tasks. | Without it, ambiguous requests can't proceed at all. |
| 3 | **Catalog typing process.** `product_type` and `verified_attributes` must come from a reviewed merchant pipeline, not seed data. | Intent enforcement is only as good as the product labels. |
| 4 | **Real anchoring** (KMS-held key, object-lock storage) instead of the in-memory store. | Checkpoints currently reset on restart. |
| 5 | **Shared state** for gateway nonces, rate limits and the Arena lock (e.g. Redis). | Replay protection and limits are per process. |
| 6 | **Real WebAuthn** with browser authenticators. | Step-up currently uses a software key. |
| 7 | **Real Razorpay Test Mode verification** end to end, then a live-mode review with Razorpay. | The adapter is tested against a mock. |
| 8 | **Secrets management** (KMS or a vault) for auth, gateway and webhook secrets; webhook secret handles are resolved by an in-memory mock. | — |
| 9 | **Operational basics**: TLS termination, structured logging without secrets, monitoring and alerting, backups, migrations with rollback, CI running the suite. | — |
| 10 | **Independent security review** and penetration test. | This audit was done by the same team that wrote the code. |

## Running it safely today

- `npm run demo` runs locally on `127.0.0.1` with demo routes and simulated payments on, and
  prints that. No real money can move.
- Never set `BOUND_SANDBOX_AUTH`, `BOUND_DEMO_ROUTES` or `BOUND_SIMULATED_PAYMENTS` on anything
  reachable by others.
- Run tests against a dedicated database; they reseed it.
