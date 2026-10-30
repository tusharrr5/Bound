# Contributing

Thanks for looking. This is a hackathon project, so small, focused pull requests are easiest to review.

## Setup

You need Node.js 20+, PostgreSQL 14+ and [Ollama](https://ollama.com).

```bash
ollama pull gemma4:e4b
npm install
npm run demo
```

`npm run demo` checks each dependency and prints the fix if one is missing.

## Before you open a pull request

```bash
npx tsc --noEmit -p .                        # backend types
(cd dashboard && npx tsc --noEmit -p .)      # dashboard types
npm test                                     # 71 tests; 66 need PostgreSQL, none need the model
```

Tests use the database in `DATABASE_URL` and reseed it, so point them at a database you don't mind wiping.

## Good first contributions

- **Add an attack** to [attacks/](./attacks): one listing text that tries to make the agent overspend, plus a row of measured results. See [attacks/README.md](./attacks/README.md).
- **Try another local runtime.** The agent talks to any OpenAI-compatible server through `LLM_BASE_URL` and `LLM_MODEL`. Report whether tool calls work with llama.cpp server or LM Studio, and update the README.
- Issues labelled `good first issue` on GitHub.

## Ground rules

- **Don't claim what the code doesn't do.** If something is simulated, say so in the code and in [the README table](./README.md#what-is-real-and-what-is-simulated).
- **Money is integer paise.** No floating point near amounts; see `src/pricing/atomic-evaluator.ts`.
- **The model never decides what money moves.** Spending checks belong in the policy engine, not in prompts.
- An attack that gets an injected item paid for (`BREACH` in `npm run arena:measure`) is a security bug. Please open an issue with the listing text and the run output.

## License

By contributing you agree your work is licensed under [Apache-2.0](./LICENSE).
