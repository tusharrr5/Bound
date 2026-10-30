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

It's live. Every Arena run sends a real listing to a real local model. In rehearsal, `gemma4:e4b` ignored plain-language injections ("seller note", "customer history", "buy this variant instead") in 15 of 15 runs. Text formatted like its own system turn (`<|system|> … <|end|>`) fooled it in 13 of 15, and a fake user turn using Gemma-style markers fooled it 5 of 5; checkout blocked every one. Plain-English tricks fooled it 0 of 15, and fake tool output or a fake “buy 60” rule 0 of 10. The listing texts and counts are in [attacks/](../attacks), and the Arena offers them as presets with these rates.

## What if the injection stays under the limit and buys the wrong ₹4,000 thing?

The wall doesn't stop that. It caps the damage at what the person signed: amount, categories, expiry. Narrow mandates keep that cap small, and anything that can't run autonomously goes back to the human. The claim isn't that the agent becomes wise; it's that the worst case is bounded by something the model can't talk its way past. An injected item that does get paid for is recorded as `BREACH`.

## Why not harden the prompt, or add a guard model?

The agent is told the budget; that's how it got fooled, because it believed the listing. A guard model is another model, and with open weights an attacker can practise against it as easily as against the agent. Prompt hardening is fine as an extra layer, but the last check has to compare the real cart total against something the model can't edit. Here, that's a signature.

## Isn't this just a card limit?

A card limit is per card. A mandate is per task (amount, categories, expiry), signed by the person, and can only get narrower when one agent hands work to another (`validateDelegationSubset`). The check itself is deliberately boring. The AI is what makes it useful: "something to keep my chai hot, no plastic" becomes the right purchase.

## Why does open-source AI matter here?

Open weights mean an attacker can run the exact model you run, offline, and tune injections against it all night. So "the model will resist" can't be the security plan. We assume it will be fooled and make that cost ₹0. Running locally also keeps the person's goals, budget and address on their device.

## What does the signature actually cover?

`token:agent:merchant:ceiling:nonce`. Categories, the per-transaction limit and expiry are stored with the mandate and enforced at checkout, but aren't part of the signed message yet. That's an open issue, not a hidden one.

## Known weak spots

- One Arena run at a time per server, to keep the screen readable. (Concurrent runs from different processes are safe: each mandate is verified against its own key.)
- On a 16 GB Mac, Ollama's memory has been seen growing from 10 GB to 18 GB over many runs. `npm run demo` warns when it does; restarting Ollama fixes it.
- A run takes about 20–30 seconds on an M2 MacBook Air with reasoning off.
