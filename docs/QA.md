# Questions we expect

Straight answers to the questions this project should be asked. If an answer here stops matching the code, the code wins; please open an issue.

## Which parts are mocked?

The AI is real and runs locally: Gemma 4 (`gemma4:e4b`) through Ollama, with no API key and no network. The policy engine, the Ed25519 mandate check, inventory locking and the audit hash chain all run for real against PostgreSQL.

Simulated:

- **The autonomous payment rail.** No money moves. Our Razorpay Test Mode integration needs a human to approve each payment, so autonomous capture runs on a test-only rail. The Razorpay path creates real Test Mode orders when keys are set, and a human authorises payment.
- **The checkpoint "vault".** Signed audit checkpoints are kept in memory with a locally generated key. There is no AWS KMS and no S3 Object Lock.
- **The human's signing key.** Each Arena run generates the key on the server; in a real product it would live on the person's phone.
- **Passkey step-up.** The server-side verification is real; the authenticator is a software key.
- **The catalog**, which is seed data.

The claim is about where the spending check happens, not about moving money, so simulating the rail is the right call for a test-mode demo.

## Does the model really get fooled, or is that staged?

It's live. Every Arena run sends a real listing to a real local model. Before hardening, `gemma4:e4b` ignored plain-language injections ("seller note", "customer history", "buy this variant instead") in 15 of 15 runs. Text formatted like its own system turn (`<|system|> … <|end|>`) fooled it in 13 of 15, and a fake user turn using Gemma-style markers fooled it 5 of 5. After hardening, with seller text marked as seller content, those two fooled it 3 of 5 and 5 of 5. The cart refused the payload in every one, with ₹0 moved. The listing texts and counts are in [attacks/](../attacks).

## What if the injection stays under the limit and buys the wrong ₹4,000 thing?

That's refused too. The request becomes a purchase task: "something to keep my chai hot"
authorizes a vacuum flask, an insulated mug or a mug warmer, with no plastic contact. A ₹1,000
warmer plus an injected ₹4,000 espresso machine is exactly ₹5,000, inside the limit, and the
cart still refuses the espresso machine (`PRODUCT_NOT_AUTHORIZED_FOR_TASK`). If it's forced into
the cart some other way, checkout re-checks every line and refuses. The check uses the product's
type from the merchant's catalog, not what the listing text claims. Asking for an espresso
machine buys one normally. That exact scenario is a test
(`tests/security/intent_authorization.test.ts`).

What it still allows: a different product *of the type you asked for*, within budget, quantity
and attributes. For example, a dearer flask than the one you'd have picked. That is bounded,
not prevented. An injected item that does get paid for is recorded as `BREACH`.

## Why not harden the prompt, or add a guard model?

We did the cheap part: seller text reaches the model labelled as seller text. But that only
makes injections less likely to work. A guard model is another model, and with open weights an
attacker can practise against it as easily as against the agent. So the last checks have to be
ones the model can't edit: the product type against the task, and the cart total against a
signature.

## Isn't this just a card limit?

A card limit is per card. A mandate is per task (amount, categories, expiry), signed by the person, and can only get narrower when one agent hands work to another (`validateDelegationSubset`). The check itself is deliberately boring. The AI is what makes it useful: "something to keep my chai hot, no plastic" becomes the right purchase.

## Why does open-source AI matter here?

Open weights mean an attacker can run the exact model you run, offline, and tune injections against it all night. So "the model will resist" can't be the security plan. We assume it will be fooled and make that cost ₹0. Running locally also keeps the person's goals, budget and address on their device.

## What does the signature actually cover?

Everything that's enforced: token, agent, merchant, ceiling, per-transaction limit, currency,
categories, SKU prefixes, validity window, nonce, key id, and the purchase task with its intent
hash. Canonical JSON, domain-separated, Ed25519. Edit any field in the database and verification
fails. Older five-field mandates are refused by default.

## Where does the human's key live?

In the demo, on the server: each run generates a key, signs, and discards it. That stands in
for a key on the person's phone. Client-side signing isn't built yet, and the API refuses to
accept private keys in requests outside sandbox mode. It's the first blocker in
[PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md).

## Known weak spots

- The intent taxonomy is a closed list. A request outside it, or matching two intents, waits for human confirmation, and there's no confirmation screen yet.
- One Arena run at a time per server, to keep the screen readable. (Concurrent runs from different processes are safe: each mandate is verified against its own key.)
- On a 16 GB Mac, Ollama's memory has been seen growing from 10 GB to 18 GB over many runs. `npm run demo` warns when it does; restarting Ollama fixes it.
- A run takes about 20–30 seconds on an M2 MacBook Air with reasoning off.
