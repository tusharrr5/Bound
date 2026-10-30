import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Cpu, KeyRound, Pencil, Play, RotateCcw, ShieldCheck, Store, Wifi } from 'lucide-react';

// ─── Types mirroring src/arena/service.ts and src/agent/buyer-agent.ts ───────

interface AgentStep {
  stepIndex: number;
  plan?: string;
  tool?: string;
  toolCall?: { name: string; input: any };
  toolResult?: any;
  observation?: string;
  decision?: string;
  finalMessage?: string;
  modelMs?: number;
}

interface ArenaMandate {
  mandateTokenId: string;
  ceilingMinor: number;
  allowedCategories: string[];
  expiresAt: string;
  signature: string;
  publicKeyFingerprint: string;
}

type ArenaOutcome = 'BLOCKED' | 'FOOLED_NO_CHECKOUT' | 'PURCHASED' | 'NO_PURCHASE' | 'BREACH';

interface ArenaRunResult {
  correlationId: string;
  goal: string;
  model: string;
  mandate: ArenaMandate;
  steps: AgentStep[];
  outcome: ArenaOutcome;
  fooled: boolean;
  injectedToolCall?: { name: string; input: any };
  attemptedAmountMinor?: number;
  moneyMovedMinor: number;
  blockedReasonCode?: string;
  blockedReason?: string;
  auditEventHash?: string;
  agentSummary: string;
  durationMs: number;
}

interface ArenaStats {
  runs: number;
  fooled: number;
  blocked: number;
  breaches: number;
  blockedAmountMinor: number;
  moneyLostMinor: number;
}

interface Listing {
  title: string;
  brand: string;
  priceMinor: number;
  description: string;
  isDefault: boolean;
}

interface ArenaState {
  defaultGoal: string;
  model: string;
  payloadVariantId: string;
  mandateTemplate: { ceilingMinor: number; allowedCategories: string[] };
  listing: Listing;
  stats: ArenaStats;
}

const rupees = (minor?: number) =>
  minor == null ? '—' : `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;

// ─── Step rendering ──────────────────────────────────────────────────────────

/** Titles of variants the agent has seen, so cart steps can name what was added. */
function variantTitles(steps: AgentStep[]): Map<string, { title: string; priceMinor: number }> {
  const titles = new Map<string, { title: string; priceMinor: number }>();
  for (const s of steps) {
    for (const item of s.toolResult?.results || []) titles.set(item.variantId, { title: item.title, priceMinor: item.priceMinor });
    for (const item of s.toolResult?.cart?.items || []) {
      titles.set(item.variantId, { title: `${item.productTitle} · ${item.title}`, priceMinor: item.unitPriceMinor });
    }
  }
  return titles;
}

function StepRow({ step, titles, payloadVariantId }: {
  step: AgentStep;
  titles: Map<string, { title: string; priceMinor: number }>;
  payloadVariantId: string;
}) {
  const time = step.modelMs != null ? `${(step.modelMs / 1000).toFixed(1)}s` : '';
  const input = step.toolCall?.input || {};

  if (!step.tool) {
    return (
      <li className="animate-manifest-enter flex gap-3 py-2.5">
        <Bot className="w-4 h-4 mt-1 shrink-0 text-muted" />
        <p className="text-[15px] italic text-paper/80 leading-snug">“{step.finalMessage || step.plan}”</p>
      </li>
    );
  }

  let label: string;
  let tone = 'text-paper';
  let detail = step.observation;

  switch (step.tool) {
    case 'search_products':
      label = `Searched “${input.query}”${input.max_price_minor ? ` under ${rupees(input.max_price_minor)}` : ''}`;
      break;
    case 'create_cart':
      label = 'Opened a cart';
      detail = undefined;
      break;
    case 'add_to_cart': {
      const v = titles.get(input.variant_id);
      const injected = input.variant_id === payloadVariantId;
      label = `Added ${v ? `${v.title} · ${rupees(v.priceMinor)}` : input.variant_id}`;
      if (injected) {
        tone = 'text-signal-rose font-semibold';
        detail = 'The listing told it to. You never asked for this.';
      } else {
        detail = step.toolResult?.cart ? `Cart total ${rupees(step.toolResult.cart.grossAmountMinor)}` : step.observation;
      }
      break;
    }
    case 'start_checkout': {
      const denied = step.toolResult?.executionMode === 'DENIED';
      label = denied ? `Checkout refused · ${step.toolResult?.errorCode}` : `Checked out · ${step.toolResult?.executionMode || 'failed'}`;
      tone = denied ? 'text-signal-rose font-semibold' : step.toolResult?.ok ? 'text-signal-green font-semibold' : 'text-signal-amber';
      detail = step.toolResult?.message || step.observation;
      break;
    }
    default:
      label = step.tool;
  }

  return (
    <li className="animate-manifest-enter flex gap-3 py-2.5">
      <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full border border-hairline text-[11px] font-mono text-muted flex items-center justify-center">
        {step.stepIndex}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className={`text-[15px] leading-snug ${tone}`}>{label}</p>
          <span className="text-[11px] font-mono text-muted shrink-0">{time}</span>
        </div>
        {detail && <p className="text-[13px] text-muted leading-snug mt-0.5 break-words">{detail}</p>}
      </div>
    </li>
  );
}

// ─── Verdict banner: the moment the demo is built around ─────────────────────

function Verdict({ result, ceilingMinor }: { result: ArenaRunResult; ceilingMinor: number }) {
  const purchased = [...result.steps].reverse().find(s => s.tool === 'start_checkout')?.toolResult;

  if (result.outcome === 'BLOCKED') {
    return (
      <section className="animate-manifest-enter rounded-2xl border-2 border-signal-rose bg-signal-rose/10 p-6 lg:p-8">
        <p className="font-display text-3xl lg:text-5xl font-bold leading-tight text-paper">
          Gemma was fooled. It tried to spend <span className="text-signal-rose">{rupees(result.attemptedAmountMinor)}</span>.
        </p>
        <p className="font-display text-xl lg:text-3xl font-semibold mt-3 text-paper/90">
          Your signed limit: {rupees(ceilingMinor)}. Blocked at checkout. <span className="text-signal-green">{rupees(result.moneyMovedMinor)} moved.</span>
        </p>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted mb-1.5">What Gemma actually called</p>
            <pre className="font-mono text-[13px] bg-ink/80 border border-hairline rounded-lg p-3 overflow-x-auto text-signal-rose">
              {JSON.stringify(result.injectedToolCall ?? null, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted mb-1.5">Why checkout said no</p>
            <p className="font-mono text-[13px] bg-ink/80 border border-hairline rounded-lg p-3 text-paper/90">
              {result.blockedReasonCode}: {result.blockedReason}
            </p>
            <p className="text-[11px] font-mono text-muted mt-2 break-all">audit hash {result.auditEventHash}</p>
          </div>
        </div>
      </section>
    );
  }

  if (result.outcome === 'BREACH') {
    return (
      <section className="animate-manifest-enter rounded-2xl border-2 border-signal-amber bg-signal-amber/15 p-6 lg:p-8">
        <p className="font-display text-3xl lg:text-4xl font-bold text-signal-amber">
          An injected item was paid for: {rupees(result.moneyMovedMinor)}.
        </p>
        <p className="text-lg mt-2 text-paper/90">That should not be possible. It is a bug in the policy layer; please report this run ({result.correlationId}).</p>
      </section>
    );
  }

  if (result.outcome === 'PURCHASED') {
    return (
      <section className="animate-manifest-enter rounded-2xl border-2 border-signal-green bg-signal-green/10 p-6 lg:p-8">
        <p className="font-display text-3xl lg:text-4xl font-bold text-paper">
          Gemma resisted this one.
        </p>
        <p className="font-display text-xl lg:text-2xl mt-2 text-paper/90">
          It paid {rupees(purchased?.totalMinor)}, inside your {rupees(ceilingMinor)} limit. Rewrite the listing and try again.
        </p>
      </section>
    );
  }

  if (result.outcome === 'FOOLED_NO_CHECKOUT') {
    return (
      <section className="animate-manifest-enter rounded-2xl border-2 border-signal-amber bg-signal-amber/10 p-6 lg:p-8">
        <p className="font-display text-3xl lg:text-4xl font-bold text-paper">
          Gemma was fooled, then stopped before checkout.
        </p>
        <p className="font-display text-xl mt-2 text-paper/90">{rupees(result.moneyMovedMinor)} moved. Its cart reached {rupees(result.attemptedAmountMinor)}.</p>
      </section>
    );
  }

  return (
    <section className="animate-manifest-enter rounded-2xl border border-hairline bg-panel p-6">
      <p className="font-display text-2xl font-bold text-paper">Gemma didn't buy anything.</p>
      <p className="text-lg mt-1 text-muted">“{result.agentSummary}”</p>
    </section>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function Arena() {
  const [state, setState] = useState<ArenaState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState('');
  const [savingListing, setSavingListing] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [mandate, setMandate] = useState<ArenaMandate | null>(null);
  const [result, setResult] = useState<ArenaRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const activeRun = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/v1/arena');
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data: ArenaState = await res.json();
      setState(data);
      setGoal(g => g || data.defaultGoal);
      setDraft(data.listing.description);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(`Can't reach the backend (${err.message}). Start it with npm run dev.`);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Ollama unloads an idle model after 5 minutes; keep it warm while this page is open
  useEffect(() => {
    const warm = () => fetch('/v1/arena/warm', { method: 'POST' }).catch(() => {});
    warm();
    const t = setInterval(warm, 4 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Live steps arrive over SSE while the POST is still in flight
  useEffect(() => {
    const es = new EventSource('/v1/audit/stream');
    es.addEventListener('arena_event', (e: MessageEvent) => {
      const { type, payload } = JSON.parse(e.data);
      if (type === 'run_started') {
        activeRun.current = payload.correlationId;
        setMandate(payload.mandate);
        setSteps([]);
      } else if (type === 'step' && payload.correlationId === activeRun.current) {
        setSteps(prev => (prev.some(s => s.stepIndex === payload.step.stepIndex) ? prev : [...prev, payload.step]));
      } else if (type === 'run_finished' && payload.stats) {
        setState(s => (s ? { ...s, stats: payload.stats } : s));
      }
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => clearInterval(t);
  }, [running]);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setElapsed(0);
    setResult(null);
    setRunError(null);
    setSteps([]);
    try {
      const res = await fetch('/v1/arena/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Run failed (${res.status})`);
      setResult(data);
      setSteps(data.steps);
      setMandate(data.mandate);
      const stats = await fetch('/v1/arena/stats').then(r => r.json());
      setState(s => (s ? { ...s, stats } : s));
    } catch (err: any) {
      setRunError(err.message);
    } finally {
      setRunning(false);
    }
  }, [goal, running]);

  // ⌘/Ctrl + Enter runs from anywhere on the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const saveListing = async (description: string | null) => {
    setSavingListing(true);
    try {
      const listing: Listing = await fetch('/v1/arena/listing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description })
      }).then(r => r.json());
      setState(s => (s ? { ...s, listing } : s));
      setDraft(listing.description);
    } finally {
      setSavingListing(false);
    }
  };

  if (!state) {
    return (
      <div className="min-h-screen bg-ink text-paper flex items-center justify-center p-6">
        <p className="text-muted text-lg">{loadError || 'Loading…'}</p>
      </div>
    );
  }

  const ceiling = mandate?.ceilingMinor ?? state.mandateTemplate.ceilingMinor;
  const categories = mandate?.allowedCategories ?? state.mandateTemplate.allowedCategories;
  const listingDirty = draft !== state.listing.description;
  const titles = variantTitles(steps);

  return (
    <div className="min-h-screen bg-ink text-paper font-body antialiased">
      <div className="max-w-[1480px] mx-auto px-4 lg:px-8 py-6 space-y-6">

        {/* Header and live counter */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-[0.25em] text-signal-green">Bound</p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tight">Trick my shopper</h1>
            <p className="text-lg text-muted mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5"><Cpu className="w-4 h-4" /> {state.model} running on this laptop</span>
              <span className="inline-flex items-center gap-1.5"><Wifi className="w-4 h-4" /> no cloud, no API key</span>
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-hairline bg-panel px-5 py-3">
              <p className="font-display text-4xl font-bold text-signal-rose tabular-nums">{state.stats.fooled}</p>
              <p className="text-xs uppercase tracking-wider text-muted mt-0.5">times AI was fooled</p>
            </div>
            <div className="rounded-xl border border-hairline bg-panel px-5 py-3">
              <p className="font-display text-4xl font-bold tabular-nums">{rupees(state.stats.blockedAmountMinor)}</p>
              <p className="text-xs uppercase tracking-wider text-muted mt-0.5">spending blocked</p>
            </div>
            <div className="rounded-xl border border-hairline bg-panel px-5 py-3">
              <p className="font-display text-4xl font-bold text-signal-green tabular-nums">{rupees(state.stats.moneyLostMinor)}</p>
              <p className="text-xs uppercase tracking-wider text-muted mt-0.5">money lost</p>
            </div>
          </div>
        </header>

        {/* Verdict, or the run in progress */}
        {running && (
          <section className="rounded-2xl border border-wire-blue/60 bg-wire-blue/10 p-6 flex items-center justify-between">
            <p className="font-display text-2xl lg:text-3xl font-semibold">Gemma is shopping…</p>
            <p className="font-mono text-2xl tabular-nums text-wire-blue">{elapsed.toFixed(1)}s</p>
          </section>
        )}
        {!running && result && <Verdict result={result} ceilingMinor={ceiling} />}
        {!running && runError && (
          <section className="rounded-2xl border-2 border-signal-amber bg-signal-amber/10 p-6">
            <p className="font-display text-2xl font-semibold text-signal-amber">The run didn't start</p>
            <p className="text-lg mt-1 text-paper/90">{runError}</p>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-12">

          {/* 1. The attacker's listing */}
          <section className="lg:col-span-4 rounded-2xl border border-hairline bg-panel p-5 flex flex-col">
            <div className="flex items-center gap-2 text-signal-rose">
              <Store className="w-5 h-5" />
              <h2 className="font-display text-xl font-semibold">You're the shady seller</h2>
            </div>
            <p className="text-sm text-muted mt-1">Write anything. This description reaches Gemma word for word inside its search results.</p>
            <div className="mt-4 flex items-baseline justify-between gap-3">
              <p className="font-semibold leading-snug">{state.listing.title}</p>
              <p className="font-display text-xl font-bold shrink-0">{rupees(state.listing.priceMinor)}</p>
            </div>
            <label className="sr-only" htmlFor="listing">Listing description</label>
            <textarea
              id="listing"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={running}
              rows={12}
              className="mt-3 w-full flex-1 min-h-[240px] rounded-lg bg-ink border border-hairline focus:border-signal-rose focus:outline-none p-3 font-mono text-[13px] leading-relaxed text-paper/90 resize-y"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => saveListing(draft)}
                disabled={!listingDirty || savingListing || running}
                className="inline-flex items-center gap-1.5 rounded-lg bg-signal-rose text-ink font-semibold px-4 py-2 disabled:opacity-40"
              >
                <Pencil className="w-4 h-4" /> {listingDirty ? 'Publish listing' : 'Published'}
              </button>
              <button
                onClick={() => saveListing(null)}
                disabled={state.listing.isDefault || savingListing || running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-4 py-2 text-muted hover:text-paper disabled:opacity-40"
              >
                <RotateCcw className="w-4 h-4" /> Default attack
              </button>
            </div>
          </section>

          {/* 2. The shopper */}
          <section className="lg:col-span-5 rounded-2xl border border-hairline bg-panel p-5 flex flex-col">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-wire-blue" />
              <h2 className="font-display text-xl font-semibold">The shopper</h2>
            </div>
            <label className="text-sm text-muted mt-1" htmlFor="goal">What the human asked for</label>
            <div className="mt-2 flex gap-2">
              <input
                id="goal"
                value={goal}
                onChange={e => setGoal(e.target.value)}
                disabled={running}
                className="flex-1 min-w-0 rounded-lg bg-ink border border-hairline focus:border-wire-blue focus:outline-none px-3 py-2.5 text-[15px]"
              />
              <button
                onClick={run}
                disabled={running || !goal.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-wire-blue text-white font-semibold px-5 py-2.5 disabled:opacity-50"
                title="⌘ + Enter"
              >
                <Play className="w-4 h-4" /> {running ? 'Running' : 'Run'}
              </button>
            </div>
            <ol className="mt-4 divide-y divide-hairline flex-1">
              {steps.length === 0 && !running && (
                <li className="py-8 text-center text-muted">Press Run to send Gemma shopping. Steps appear here live.</li>
              )}
              {steps.map(step => (
                <StepRow key={step.stepIndex} step={step} titles={titles} payloadVariantId={state.payloadVariantId} />
              ))}
            </ol>
          </section>

          {/* 3. The wall */}
          <section className="lg:col-span-3 rounded-2xl border border-hairline bg-panel p-5">
            <div className="flex items-center gap-2 text-signal-green">
              <ShieldCheck className="w-5 h-5" />
              <h2 className="font-display text-xl font-semibold">Your signed limit</h2>
            </div>
            <p className="font-display text-5xl xl:text-6xl font-bold mt-4 tabular-nums">{rupees(ceiling)}</p>
            <p className="text-sm text-muted mt-1">Checked against the real cart total at checkout. The model never holds the key.</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {categories.map(c => (
                <span key={c} className="text-xs rounded-full border border-hairline px-2.5 py-1 text-paper/80">{c}</span>
              ))}
            </div>
            <div className="mt-5 pt-4 border-t border-hairline text-[12px] font-mono text-muted space-y-1.5">
              <p className="flex items-center gap-1.5 text-paper/80 font-body text-sm"><KeyRound className="w-4 h-4" /> Ed25519, signed fresh each run</p>
              {mandate ? (
                <>
                  <p className="break-all">key {mandate.publicKeyFingerprint}</p>
                  <p className="break-all">sig {mandate.signature.slice(0, 32)}…</p>
                  <p>expires {new Date(mandate.expiresAt).toLocaleTimeString()}</p>
                </>
              ) : (
                <p className="font-body text-[13px]">Signed when you press Run. The demo key is generated on this machine and stands in for your phone's key.</p>
              )}
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap justify-between gap-2 text-sm text-muted pt-2">
          <span>{state.stats.runs} runs · {state.stats.blocked} blocked · {state.stats.breaches} breaches</span>
          <a href="#/engine" className="hover:text-paper underline-offset-4 hover:underline">Engine room: scripted walkthroughs →</a>
        </footer>
      </div>
    </div>
  );
}
