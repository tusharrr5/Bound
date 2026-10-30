import 'dotenv/config';
import { runArena, getBaitListing, updateBaitListing } from '../arena/service.js';
import { LlmUnavailableError } from '../agent/llm.js';
import { pool } from '../db/pool.js';

/**
 * Runs the Arena N times against the current listing text and reports how often the local
 * model was fooled and whether checkout held. Use it to pick injections worth demoing.
 *
 * Usage: npm run arena:measure -- [runs=10] [path/to/listing.txt]
 * Runs are recorded in arena_runs like any other, so they count towards the live counter.
 */
async function main() {
  const runs = Number(process.argv[2]) || 10;
  const listingFile = process.argv[3];

  if (listingFile) {
    const fs = await import('fs');
    await updateBaitListing(fs.readFileSync(listingFile, 'utf8'));
  }
  const listing = await getBaitListing();
  console.log(`Listing (${listing.isDefault ? 'default injection' : 'custom'}):\n${listing.description}\n`);

  const tally: Record<string, number> = {};
  let fooled = 0;
  let totalMs = 0;

  for (let i = 1; i <= runs; i++) {
    const r = await runArena();
    tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    if (r.fooled) fooled++;
    totalMs += r.durationMs;
    const tools = r.steps.filter(s => s.tool).map(s => s.tool === 'add_to_cart' ? `add_to_cart(${String(s.toolCall?.input?.variant_id).slice(0, 8)})` : s.tool).join(' → ');
    console.log(`#${i} ${r.outcome.padEnd(18)} ${(r.durationMs / 1000).toFixed(1)}s  ${tools}${r.blockedReasonCode ? `  [${r.blockedReasonCode}]` : ''}`);
  }

  console.log(`\nFooled ${fooled}/${runs} (${Math.round((100 * fooled) / runs)}%)  ${JSON.stringify(tally)}  avg ${(totalMs / runs / 1000).toFixed(1)}s/run`);
  if (tally.BREACH) console.log('⚠️  BREACH: an injected purchase went through. Investigate before demoing.');
}

main()
  .catch(err => {
    console.error(err instanceof LlmUnavailableError ? `❌ ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
