import 'dotenv/config';
import { runBuyerAgent } from '../agent/buyer-agent.js';
import { LlmUnavailableError, llmBaseUrl } from '../agent/llm.js';
import { pool } from '../db/pool.js';
import { createTaskBoundMandate, ArenaTaskError } from '../arena/service.js';

const CLI_AGENT = '22222222-2222-2222-2222-222222222222';

/**
 * Runs the buyer agent once from the terminal against the local model.
 * Usage: npm run demo:agent -- "something to keep my chai hot at my desk, under ₹2,000"
 */
async function main() {
  const goal = process.argv.slice(2).join(' ').trim()
    || 'Find a compact espresso coffee machine under ₹5,000 and buy it with my mandate.';

  console.log(`🛒 Goal: ${goal}`);
  console.log(`🧠 Model server: ${llmBaseUrl()}\n`);

  const started = Date.now();
  // The goal becomes a purchase task; the mandate is signed over it. The agent can buy only that.
  const correlationId = `corr_cli_${Date.now()}`;
  const mandate = await createTaskBoundMandate({ correlationId, goal, buyerAgentId: CLI_AGENT, ceilingMinor: 1_000_000, allowedCategories: [] });
  console.log(`🔏 Authorized: ${mandate.task.allowedProductTypes.join(', ')} up to ₹${(mandate.ceilingMinor / 100).toLocaleString('en-IN')}\n`);
  const result = await runBuyerAgent(goal, {
    buyerAgentId: CLI_AGENT, correlationId, mandateTokenId: mandate.mandateTokenId,
    spendingLimitMinor: mandate.ceilingMinor, purchaseTaskId: mandate.task.id
  });

  for (const step of result.steps) {
    const timing = step.modelMs != null ? ` (model ${(step.modelMs / 1000).toFixed(1)}s, ${step.promptTokens ?? '?'} prompt tokens)` : '';
    if (step.tool) {
      console.log(`[${step.stepIndex}] ${step.tool} ${JSON.stringify(step.toolCall?.input)}${timing}`);
      console.log(`    → ${step.observation}`);
    } else if (step.finalMessage) {
      console.log(`[${step.stepIndex}] ${step.finalMessage}${timing}`);
    }
  }

  console.log(`\nModel: ${result.model}`);
  console.log(`Status: ${result.finalStatus}${result.orderId ? ` (order ${result.orderId})` : ''}${result.stopReason ? ` (${result.stopReason.code})` : ''}`);
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch(err => {
    if (err instanceof LlmUnavailableError || err instanceof ArenaTaskError) {
      console.error(`❌ ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  })
  .finally(() => pool.end());
