import 'dotenv/config';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import pg from 'pg';

/**
 * One command from a cold machine to the Arena in a browser:
 *   npm run demo                      check Postgres + Ollama, migrate, seed, build, load Gemma, serve, open
 *   npm run demo -- --reset-counter   also clear the "times fooled" counter (do this right before judging)
 *   npm run demo -- --no-open         don't open a browser tab
 *
 * Each check stops with the exact command that fixes it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboardDir = path.join(root, 'dashboard');
const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT) || 4000;
const databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/manifest_db';
const started = Date.now();

// The Arena needs its demo routes and the simulated payment rail. These are switched on here,
// explicitly, for this process only; nothing else turns them on, and config refuses them in
// production. Sandbox auth stays off: the Arena pages use no authenticated routes.
const DEMO_FLAGS = { BOUND_DEMO_ROUTES: 'true', BOUND_SIMULATED_PAYMENTS: 'true', BOUND_SANDBOX_AUTH: 'false' } as const;
if (process.env.NODE_ENV === 'production') {
  console.error('\n  ✗ npm run demo is a local demo and refuses to run with NODE_ENV=production.');
  process.exit(1);
}
for (const [k, v] of Object.entries(DEMO_FLAGS)) process.env[k] ??= v;

const ok = (label: string, detail: string, since: number) =>
  console.log(`  ✓ ${label.padEnd(10)} ${detail}  (${((Date.now() - since) / 1000).toFixed(1)}s)`);

function fail(label: string, problem: string, fix: string): never {
  console.error(`  ✗ ${label.padEnd(10)} ${problem}\n\n    Fix: ${fix}\n`);
  process.exit(1);
}

/** Homebrew names Postgres by version (postgresql@17); use whichever is installed in the fix hint. */
function postgresStartHint(): string {
  const list = spawnSync('brew', ['services', 'list'], { encoding: 'utf8' });
  const names = (list.stdout || '').split('\n').map(l => l.split(/\s+/)[0]).filter(n => /^postgresql(@\d+)?$/.test(n));
  const newest = names.sort().pop();
  return newest ? `brew services start ${newest}` : 'start PostgreSQL (brew services start postgresql@17, or Postgres.app)';
}

async function checkPostgres() {
  const t = Date.now();
  const url = new URL(databaseUrl);
  const dbName = url.pathname.slice(1);
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err: any) {
    fail('Postgres', `not reachable at ${url.host} (${err.code || err.message})`, postgresStartHint());
  }
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await client.end();
  ok('Postgres', `${dbName}${exists.rowCount === 0 ? ' (created)' : ''}`, t);
}

async function checkPortFree() {
  const free = await new Promise<boolean>(resolve => {
    const probe = net.createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '0.0.0.0');
  });
  if (!free) fail('Port', `${port} is already in use (another Bound server?)`, `open http://localhost:${port}, or stop it: kill $(lsof -ti tcp:${port})`);
}

async function checkOllama(model: string, baseUrl: string) {
  const t = Date.now();
  const ollamaRoot = baseUrl.replace(/\/v1$/, '');
  let tags: any;
  try {
    const res = await fetch(`${ollamaRoot}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.log(`  ! Model      ${baseUrl} is not Ollama; skipping model checks`);
      return false;
    }
    tags = await res.json();
  } catch {
    fail('Ollama', `not reachable at ${ollamaRoot}`, 'brew services start ollama   (or: ollama serve)');
  }
  const names: string[] = (tags.models || []).map((m: any) => m.name);
  if (!names.includes(model)) fail('Model', `${model} is not downloaded`, `ollama pull ${model}   (one time, ~7-10 GB)`);
  ok('Ollama', `${model} downloaded`, t);
  return true;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

function buildDashboardIfStale() {
  const t = Date.now();
  const built = path.join(dashboardDir, 'dist', 'index.html');
  const sources = [path.join(dashboardDir, 'src'), path.join(dashboardDir, 'index.html'), path.join(dashboardDir, 'tailwind.config.js')];
  const sourceTime = Math.max(...sources.map(p => (fs.statSync(p).isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs)));

  if (fs.existsSync(built) && fs.statSync(built).mtimeMs >= sourceTime) {
    ok('Dashboard', 'up to date', t);
    return;
  }
  if (!fs.existsSync(path.join(dashboardDir, 'node_modules'))) {
    console.log('    installing dashboard dependencies (first run only)…');
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dashboardDir, encoding: 'utf8' });
    if (install.status !== 0) fail('Dashboard', 'npm install failed', `cd dashboard && npm install\n\n${install.stderr}`);
  }
  const build = spawnSync('npm', ['run', 'build'], { cwd: dashboardDir, encoding: 'utf8' });
  if (build.status !== 0) fail('Dashboard', 'build failed', `cd dashboard && npm run build\n\n${build.stdout}\n${build.stderr}`);
  ok('Dashboard', 'built', t);
}

async function loadModel(model: string, baseUrl: string) {
  const t = Date.now();
  const { warmModel } = await import('../agent/llm.js');
  await warmModel();
  const ps: any = await fetch(`${baseUrl.replace(/\/v1$/, '')}/api/ps`).then(r => r.json()).catch(() => null);
  const loaded = ps?.models?.find((m: any) => m.name === model);
  const gb = loaded ? loaded.size / 1024 ** 3 : 0;
  ok('Gemma', loaded ? `${model} loaded in memory (${gb.toFixed(1)} GB, kept warm 30 min)` : `${model} warm-up sent`, t);

  // Seen in rehearsal: Ollama's footprint grew from 10 GB to 18 GB on a 16 GB Mac and runs slowed 2x
  const ramGb = os.totalmem() / 1024 ** 3;
  if (gb > ramGb * 0.8) {
    console.log(`  ! Memory     Ollama is using ${gb.toFixed(1)} GB of ${ramGb.toFixed(0)} GB RAM; runs will be slow.\n               Fix: brew services restart ollama, then rerun npm run demo`);
  }
}

async function main() {
  console.log('\nBound · Trick my shopper\n');
  console.log(`  Demo mode: demo routes ${process.env.BOUND_DEMO_ROUTES}, simulated payments ${process.env.BOUND_SIMULATED_PAYMENTS}, sandbox auth ${process.env.BOUND_SANDBOX_AUTH}`);
  console.log('             local only (127.0.0.1); no real money can move.\n');
  const { llmModel, llmBaseUrl } = await import('../agent/llm.js');
  const model = llmModel();
  const baseUrl = llmBaseUrl();

  await checkPostgres();
  await checkPortFree();
  const isOllama = await checkOllama(model, baseUrl);

  let t = Date.now();
  const { runMigrations } = await import('../db/migrate.js');
  const { seedDatabase } = await import('../db/seed.js');
  const quiet = console.log;
  console.log = () => {}; // migrate/seed narrate every step; keep the launcher output short
  try {
    await runMigrations();
    await seedDatabase();
  } finally {
    console.log = quiet;
  }
  ok('Database', 'migrated and seeded (fresh mandates, stock, audit chain)', t);

  buildDashboardIfStale();
  if (isOllama) await loadModel(model, baseUrl);

  t = Date.now();
  const { pool } = await import('../db/pool.js');
  if (args.has('--reset-counter')) await pool.query('DELETE FROM arena_runs');
  const { getArenaStats } = await import('../arena/service.js');
  const stats = await getArenaStats();
  ok('Arena', args.has('--reset-counter')
    ? 'counter cleared'
    : `counter at ${stats.fooled} fooled / ${stats.runs} runs${stats.runs ? '  (add --reset-counter to clear)' : ''}`, t);

  const { startServer } = await import('../server.js');
  const quietStart = console.log;
  console.log = () => {};
  await startServer();
  console.log = quietStart;

  const url = `http://localhost:${port}`;
  console.log(`\n  Ready in ${((Date.now() - started) / 1000).toFixed(1)}s → ${url}   (Ctrl+C to stop)\n`);
  if (!args.has('--no-open') && process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch(err => {
  console.error('\n  ✗ Demo failed to start:', err?.message || err);
  process.exit(1);
});
