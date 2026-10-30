# Test coverage

```bash
createdb bound_test
DATABASE_URL=postgresql://localhost:5432/bound_test npm run db:migrate
DATABASE_URL=postgresql://localhost:5432/bound_test npm test
```

Tests reseed the database they run against. Point them at a dedicated database, never at one
you care about. Files run serially because they share it. No test needs the model or Razorpay:
the model is replaced by a scripted stub, and the Razorpay SDK is mocked.

Last run: **165 passed, 0 failed, 12 files**, on `security-hardening`.

| File | Tests | Proves |
|---|---:|---|
| `tests/security/intent_authorization.test.ts` | 25 | ₹1,000 warmer + injected ₹4,000 espresso = ₹5,000 is refused at the cart and at checkout; legitimate espresso shopping works; listing text can't spoof a type; untyped products need a human; attribute, quantity and budget limits; cross-merchant and invented ids; ambiguous requests stay pending; budget comes from the caller; cross-agent use; task tampering (including a recomputed hash); untasked mandates; task mismatch; v2 tamper of each signed field; v1 downgrade; cart-hash fail-closed; nonce uniqueness |
| `tests/security/api_access.test.ts` | 31 | No sandbox fallback; invalid token → 401; retired gateway header; demo routes absent; owner-only carts, checkout and orders; input validation; agents can't self-delegate; no private keys in bodies; operator-only audit; CORS allowlist; webhook secrets scoped per merchant; 8 production config refusals; no static path traversal |
| `tests/security/agent_guard.test.ts` | 8 | Run stops at the first refusal, with no checkout and no further model turns; honest purchase completes; seller text sits under `seller_listing`; malformed calls rejected and run stopped; call and per-turn limits; foreign or untasked carts refused; mandate pinned per run; identity never taken from arguments |
| `tests/security/payments_strict.test.ts` | 6 | Network failure, provider rejection and outage throw from every adapter operation; no keys → `NOT_CONFIGURED`; simulated results labelled; placeholder keys treated as none |
| `tests/security/adversarial_attacks.test.ts` | 12 | WebAuthn assertions (software authenticator), gateway replay, self-delegation, tenant isolation |
| `tests/audit/evidence_integrity.test.ts` | 24 | Nested title, variant, quantity, price and merchant tampering breaks the proof; key binding; leaf/node separation; proofs for 1–9 leaves; empty and single trees; odd-node promotion; reorder and duplicate keys; receipts commit to each line; interleaved merchant chains; 20 concurrent appends; per-merchant checkpoints; tamper detection; deletion from the end of a chain |
| `tests/audit/audit_integrity.test.ts` | 8 | Hash chain, outbox atomicity, simulated anchor tamper detection, 100 concurrent writes |
| `tests/policy/policy_engine.test.ts` | 16 | Delegation narrowing, revocation cascade, mandate budgets, state machines |
| `tests/webhooks/webhook_verification.test.ts` | 15 | HMAC, dedup, secret rotation, out-of-order events |
| `tests/concurrency/reservation_race.test.ts` | 11 | 20 buyers for 1 unit, lock ordering, hoarding limits |
| `tests/arena/direct_check.test.ts` | 4 | With no model, the ₹49,999 item is refused at the cart and only the flask is paid; honest carts pay; earlier runs' mandates stay valid; presets are consistent |
| `tests/pricing/money_rounding.test.ts` | 5 | Basis-point arithmetic and rounding |

## Mutation checks

A test that passes whatever the code does proves nothing, so the key controls were switched
off on purpose to confirm their tests fail:

| Control disabled | Failing tests |
|---|---|
| `authorizeLineForTask` always allows | 9 in `intent_authorization` |
| Agent stop rule (`stopCodeOf` returns nothing) | 3 in `agent_guard` |

## Not covered by automated tests

- **Live model behaviour.** How often Gemma is fooled is measured by hand
  (`npm run arena:measure`) and recorded in [attacks/README.md](../attacks/README.md). It varies
  between runs.
- **Real Razorpay Test Mode calls.** The adapter is tested against a mocked SDK only.
- **The dashboard UI.** It is type-checked and built, not tested in a browser automatically.
- **Multi-process deployments** (shared nonces, rate limits).
- **Load and fuzzing** beyond the concurrency suites.
