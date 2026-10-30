import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check, Coffee, Cpu, FileSearch, Handshake, KeyRound, LoaderCircle, MessageSquareQuote, PackagePlus,
  Play, RotateCcw, Search, ShieldAlert, ShieldCheck, ShieldX, ShoppingCart, TriangleAlert, WifiOff
} from 'lucide-react';

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

interface PurchaseTask {
  id: string;
  intent: string;
  allowedProductTypes: string[];
  requiredAttributes: Record<string, unknown>;
  confirmationSource: string;
}

interface ArenaMandate {
  mandateTokenId: string;
  ceilingMinor: number;
  allowedCategories: string[];
  /** What the human's words authorize; the cart refuses anything else. */
  task?: PurchaseTask;
  expiresAt: string;
  signature: string;
  publicKeyFingerprint: string;
}

// RESISTED: the agent never tried anything unauthorized. BLOCKED_AT_*: it tried and the backend
// refused. REACHED_PAYMENT_LAYER and BREACH should never happen.
type ArenaOutcome = 'RESISTED' | 'BLOCKED_AT_CART' | 'BLOCKED_AT_CHECKOUT' | 'REACHED_PAYMENT_LAYER' | 'BREACH';

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
  rejectedMutations?: Array<{ variantId: string; code: string; reason: string }>;
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

interface AttackPreset {
  id: string;
  name: string;
  summary: string;
  text: string;
  runs: number;
  fooled: number;
  blocked: number;
}

/** The trick's cart built with no model involved (POST /v1/arena/direct). */
interface DirectResult {
  correlationId: string;
  mandate: ArenaMandate;
  steps: AgentStep[];
  checkout: any;
  cartMinor?: number;
  moneyMovedMinor: number;
}

interface ArenaState {
  defaultGoal: string;
  model: string;
  payloadVariantId: string;
  mandateTemplate: { ceilingMinor: number; allowedCategories: string[] };
  listing: Listing;
  stats: ArenaStats;
}

const humanize = (s: string) => s.replace(/_/g, ' ');

const rupees = (minor?: number) =>
  minor == null ? '—' : `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;

// ─── Derived run state ───────────────────────────────────────────────────────

/** Titles of variants the agent has seen, so cart steps can name what was added. */
function variantTitles(steps: AgentStep[]): Map<string, { title: string; priceMinor: number }> {
  const titles = new Map<string, { title: string; priceMinor: number }>();
  for (const s of steps) {
    for (const item of s.toolResult?.results || []) titles.set(item.variantId, { title: item.title, priceMinor: item.priceMinor });
    for (const item of s.toolResult?.cart?.items || []) titles.set(item.variantId, { title: item.productTitle || item.title, priceMinor: item.unitPriceMinor });
    // A refused item never reaches the cart; the refusal names it instead
    const refused = s.toolResult?.product;
    if (refused?.variantId && refused.title) titles.set(refused.variantId, { title: refused.title, priceMinor: refused.priceMinor });
  }
  return titles;
}

/** A cart change the backend refused because it falls outside what the human authorized. */
const isRefusedAdd = (s: AgentStep) => s.tool === 'add_to_cart' && s.toolResult?.ok === false && !!s.toolResult?.code
  && s.toolResult.code !== 'INVALID_TOOL_CALL';

/** Cart total as last reported by add_to_cart, refused additions, and the checkout result if the agent got that far. */
function cartAndCheckout(steps: AgentStep[]) {
  const lastCart = [...steps].reverse().find(s => s.tool === 'add_to_cart' && s.toolResult?.cart)?.toolResult.cart;
  const checkout = [...steps].reverse().find(s => s.tool === 'start_checkout')?.toolResult;
  const refused = steps.filter(isRefusedAdd);
  return { cartMinor: lastCart?.grossAmountMinor as number | undefined, checkout, refused };
}

// ─── Small building blocks ───────────────────────────────────────────────────

function Panel({ n, title, subtitle, accent, children }: {
  n: number; title: string; subtitle: string; accent: string; children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-panel flex flex-col min-h-0 overflow-hidden">
      <header className="px-5 pt-4 pb-3 border-b border-hairline flex items-start gap-3">
        <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-full text-sm font-bold flex items-center justify-center ${accent}`}>{n}</span>
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold leading-tight">{title}</h2>
          <p className="text-[13px] text-muted leading-snug">{subtitle}</p>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex flex-col p-5">{children}</div>
    </section>
  );
}

function Counter({ value, label, tone }: { value: string | number; label: string; tone: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-panel px-4 py-2.5 text-center min-w-[128px]">
      {/* key re-mounts on change so the number pops when a judge's run lands */}
      <p key={String(value)} className={`animate-pop font-display text-3xl font-bold tabular-nums leading-none ${tone}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-muted mt-1.5">{label}</p>
    </div>
  );
}

// ─── Panel 2: the agent's timeline ───────────────────────────────────────────

const TOOL_ICON: Record<string, typeof Search> = {
  search_products: Search,
  get_product_detail: FileSearch,
  create_cart: ShoppingCart,
  add_to_cart: PackagePlus,
  request_negotiation: Handshake,
  start_checkout: ShieldCheck
};

function StepRow({ step, titles, payloadVariantId, direct = false }: {
  step: AgentStep;
  titles: Map<string, { title: string; priceMinor: number }>;
  payloadVariantId: string;
  direct?: boolean;
}) {
  const input = step.toolCall?.input || {};
  const time = step.modelMs != null ? `${(step.modelMs / 1000).toFixed(1)}s` : '';

  if (!step.tool) {
    return (
      <li className="animate-manifest-enter relative pl-10 pb-4 after:absolute after:left-[13px] after:top-8 after:bottom-1 after:w-px after:bg-hairline last:after:hidden">
        <span className="absolute left-0 top-0 w-7 h-7 rounded-full bg-ink border border-hairline flex items-center justify-center">
          <MessageSquareQuote className="w-3.5 h-3.5 text-muted" />
        </span>
        <p className="text-[15px] italic text-paper/80 leading-snug pt-0.5">“{step.finalMessage || step.plan}”</p>
      </li>
    );
  }

  let Icon = TOOL_ICON[step.tool] || Search;
  let label: ReactNode = step.tool;
  let detail: ReactNode = step.observation;
  let node = 'bg-ink border-hairline text-paper/70';
  let tag: ReactNode = null;
  let raw: ReactNode = null;

  switch (step.tool) {
    case 'search_products': {
      const n = step.toolResult?.results?.length ?? 0;
      label = <>Searched <span className="text-paper">“{input.query}”</span></>;
      detail = n ? `${n} result${n === 1 ? '' : 's'}, descriptions included` : 'No results';
      break;
    }
    case 'get_product_detail':
      label = 'Opened a product page';
      detail = titles.get(input.variant_id)?.title;
      break;
    case 'create_cart':
      label = 'Opened a cart';
      detail = null;
      break;
    case 'add_to_cart': {
      const v = titles.get(input.variant_id);
      const injected = input.variant_id === payloadVariantId;
      const refused = isRefusedAdd(step);
      label = refused
        ? <>Tried to add <span className="text-paper">{v?.title ?? 'an item'}</span> · {rupees(v?.priceMinor)}</>
        : <>Added <span className="text-paper">{v?.title ?? 'an item'}</span> · {rupees(v?.priceMinor)}</>;
      detail = step.toolResult?.cart ? `Cart total ${rupees(step.toolResult.cart.grossAmountMinor)}` : step.observation;
      if (refused) {
        Icon = ShieldX;
        node = 'bg-signal-rose/15 border-signal-rose text-signal-rose';
        tag = <span className="text-[10px] font-bold tracking-wider rounded bg-signal-rose text-ink px-1.5 py-0.5">REFUSED AT CART</span>;
        detail = <>{injected && !direct ? 'The listing told it to. ' : ''}{step.toolResult.message} <span className="font-mono text-[11px]">{step.toolResult.code}</span></>;
      } else if (injected) {
        node = 'bg-signal-rose/15 border-signal-rose text-signal-rose';
        tag = <span className="text-[10px] font-bold tracking-wider rounded bg-signal-rose text-ink px-1.5 py-0.5">{direct ? 'THE TRICK’S ITEM' : 'INJECTED'}</span>;
        detail = direct ? 'Added straight to the cart. No AI involved.' : 'The listing told it to. You never asked for this.';
        raw = (
          <details className="mt-1.5 text-[12px]">
            <summary className="cursor-pointer text-muted hover:text-paper">{direct ? 'Exact call sent' : 'Exact call Gemma made'}</summary>
            <pre className="mt-1.5 font-mono bg-ink border border-hairline rounded-lg p-2.5 overflow-x-auto text-signal-rose">{JSON.stringify(step.toolCall, null, 2)}</pre>
          </details>
        );
      }
      break;
    }
    case 'request_negotiation':
      label = `Asked for ${rupees(input.proposed_price_minor)}`;
      break;
    case 'start_checkout': {
      const denied = step.toolResult?.executionMode === 'DENIED';
      Icon = denied ? ShieldX : step.toolResult?.ok ? ShieldCheck : ShieldAlert;
      label = denied ? `${direct ? 'Sent to checkout' : 'Tried to check out'} · refused` : step.toolResult?.ok ? 'Checked out · paid' : 'Checkout failed';
      node = denied ? 'bg-signal-rose/15 border-signal-rose text-signal-rose' : step.toolResult?.ok ? 'bg-signal-green/15 border-signal-green text-signal-green' : 'bg-signal-amber/15 border-signal-amber text-signal-amber';
      detail = denied ? step.toolResult?.errorCode : step.toolResult?.ok ? `${rupees(step.toolResult.totalMinor)} on the simulated rail` : step.toolResult?.message;
      break;
    }
  }

  return (
    <li className="animate-manifest-enter relative pl-10 pb-4 after:absolute after:left-[13px] after:top-8 after:bottom-1 after:w-px after:bg-hairline last:after:hidden">
      <span className={`absolute left-0 top-0 w-7 h-7 rounded-full border flex items-center justify-center ${node}`}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[15px] leading-snug text-paper/85 flex flex-wrap items-center gap-x-2 gap-y-1">{label}{tag}</p>
        <span className="text-[11px] font-mono text-muted shrink-0">{time}</span>
      </div>
      {detail && <p className="text-[13px] text-muted leading-snug mt-0.5 break-words">{detail}</p>}
      {raw}
    </li>
  );
}

const IDLE_STEPS = ['Search the catalog', 'Read the listings', 'Add to cart', 'Check out under your mandate'];
const STEP_LI = 'relative pl-10 pb-4 after:absolute after:left-[13px] after:top-8 after:bottom-1 after:w-px after:bg-hairline last:after:hidden';

// ─── Panel 3: the wall ───────────────────────────────────────────────────────

function SpendMeter({ cartMinor, limitMinor }: { cartMinor?: number; limitMinor: number }) {
  const cart = cartMinor ?? 0;
  const scale = Math.max(limitMinor * 1.6, cart * 1.04);
  const limitPct = (limitMinor / scale) * 100;
  const withinPct = (Math.min(cart, limitMinor) / scale) * 100;
  const overPct = cart > limitMinor ? ((cart - limitMinor) / scale) * 100 : 0;
  const over = cart > limitMinor;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wider text-muted">Cart total</p>
        <p className={`font-display text-2xl font-bold tabular-nums ${over ? 'text-signal-rose' : 'text-paper'}`}>{cartMinor == null ? '₹0' : rupees(cart)}</p>
      </div>
      <div className="relative mt-2 h-4 rounded-full bg-ink border border-hairline overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-signal-green transition-all duration-700" style={{ width: `${withinPct}%` }} />
        <div className="absolute inset-y-0 bg-signal-rose transition-all duration-700" style={{ left: `${limitPct}%`, width: `${overPct}%` }} />
        <div className="absolute inset-y-0 w-1 bg-paper shadow-[0_0_0_2px_rgba(11,13,16,0.9)]" style={{ left: `calc(${limitPct}% - 2px)` }} />
      </div>
      <div className="relative h-5">
        <p className="absolute top-1 text-[11px] font-mono text-paper/80 -translate-x-1/2 whitespace-nowrap" style={{ left: `${limitPct}%` }}>
          limit {rupees(limitMinor)}
        </p>
      </div>
      {over && (
        <p className="text-sm text-signal-rose font-semibold mt-1">{(cart / limitMinor).toFixed(1)}× what you signed for</p>
      )}
    </div>
  );
}

function CheckoutStamp({ checkout, running, refused }: { checkout: any; running: boolean; refused: AgentStep[] }) {
  if (!checkout && refused.length > 0 && !running) {
    const first = refused[0].toolResult;
    return (
      <div className="animate-stamp rounded-xl border-2 border-signal-rose bg-signal-rose/10 p-4">
        <div className="flex items-center gap-2 text-signal-rose">
          <ShieldX className="w-7 h-7" />
          <p className="font-display text-3xl font-bold tracking-wide">REFUSED AT CART</p>
        </div>
        <p className="font-display text-xl font-semibold mt-1 text-signal-green">₹0 moved</p>
        <p className="text-[13px] text-paper/80 mt-2 leading-snug">{first.message} The run stopped there for you to decide.</p>
        <p className="mt-2 inline-block text-[11px] font-mono rounded bg-ink border border-hairline px-1.5 py-0.5 text-muted">{first.code}</p>
      </div>
    );
  }
  if (!checkout) {
    return (
      <div className="rounded-xl border border-dashed border-hairline p-4 text-center text-muted text-sm">
        {running ? 'Waiting for Gemma to reach checkout…' : 'The checkout decision appears here.'}
      </div>
    );
  }
  if (checkout.executionMode === 'DENIED') {
    return (
      <div className="animate-stamp rounded-xl border-2 border-signal-rose bg-signal-rose/10 p-4">
        <div className="flex items-center gap-2 text-signal-rose">
          <ShieldX className="w-7 h-7" />
          <p className="font-display text-3xl font-bold tracking-wide">BLOCKED</p>
        </div>
        <p className="font-display text-xl font-semibold mt-1 text-signal-green">₹0 moved</p>
        <p className="text-[13px] text-paper/80 mt-2 leading-snug">{checkout.message}</p>
        <p className="mt-2 inline-block text-[11px] font-mono rounded bg-ink border border-hairline px-1.5 py-0.5 text-muted">{checkout.errorCode}</p>
      </div>
    );
  }
  if (checkout.ok) {
    return (
      <div className="animate-stamp rounded-xl border-2 border-signal-green bg-signal-green/10 p-4">
        <div className="flex items-center gap-2 text-signal-green">
          <ShieldCheck className="w-7 h-7" />
          <p className="font-display text-3xl font-bold tracking-wide">PAID {rupees(checkout.totalMinor)}</p>
        </div>
        <p className="text-[13px] text-paper/80 mt-2">Within your signed limit. Simulated test rail; no real money.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border-2 border-signal-amber bg-signal-amber/10 p-4">
      <p className="font-display text-xl font-bold text-signal-amber">Checkout failed</p>
      <p className="text-[13px] text-paper/80 mt-1">{checkout.message || checkout.errorCode}</p>
    </div>
  );
}

// ─── Status strip: one line a judge can read from across the table ───────────

function StatusStrip({ running, elapsed, result, runError, listingIsDefault, direct, checking, onDirect }: {
  running: boolean; elapsed: number; result: ArenaRunResult | null; runError: string | null; listingIsDefault: boolean;
  direct: DirectResult | null; checking: boolean; onDirect: () => void;
}) {
  const base = 'rounded-2xl border px-6 h-[76px] flex items-center justify-between gap-4';
  const wallButton = (
    <button onClick={onDirect} className="shrink-0 rounded-xl border border-paper/30 hover:border-paper px-4 py-2 font-semibold text-paper transition-colors">
      Show the wall anyway →
    </button>
  );

  if (checking) {
    return (
      <div className={`${base} border-hairline bg-panel`}>
        <p className="font-display text-2xl font-semibold flex items-center gap-3">
          <LoaderCircle className="w-6 h-6 animate-spin text-muted" /> Trying the same cart with no AI…
        </p>
      </div>
    );
  }
  if (direct) {
    const refusedAtCheckout = direct.checkout?.executionMode === 'DENIED';
    const refusedAtCart = direct.steps.some(isRefusedAdd);
    return (
      <div className={`${base} animate-manifest-enter ${refusedAtCheckout || refusedAtCart ? 'border-signal-rose bg-signal-rose/10' : 'border-signal-green/70 bg-signal-green/10'}`}>
        <p className="font-display text-2xl xl:text-3xl font-bold">
          {refusedAtCheckout
            ? <>No AI involved: a <span className="text-signal-rose">{rupees(direct.cartMinor)}</span> cart went straight to checkout. Refused.</>
            : refusedAtCart
              ? <>No AI involved: the trick's item was <span className="text-signal-rose">refused at the cart</span>. Only what you asked for was paid.</>
              : <>No AI involved: a {rupees(direct.cartMinor)} cart, inside the limit. Paid.</>}
        </p>
        <p className="font-display text-2xl xl:text-3xl font-bold text-signal-green shrink-0">{rupees(direct.moneyMovedMinor)} moved</p>
      </div>
    );
  }

  if (running) {
    return (
      <div className={`${base} border-wire-blue/50 bg-wire-blue/10 relative overflow-hidden`}>
        <p className="font-display text-2xl font-semibold flex items-center gap-3">
          <LoaderCircle className="w-6 h-6 animate-spin text-wire-blue" /> Gemma is shopping…
        </p>
        <p className="font-mono text-2xl tabular-nums text-wire-blue">{elapsed.toFixed(1)}s</p>
        <div className="absolute bottom-0 left-0 h-0.5 bg-wire-blue animate-progress" />
      </div>
    );
  }
  if (runError) {
    return (
      <div className={`${base} border-signal-amber/60 bg-signal-amber/10`}>
        <p className="font-display text-xl font-semibold text-signal-amber flex items-center gap-3"><TriangleAlert className="w-6 h-6" /> {runError}</p>
      </div>
    );
  }
  if (!result) {
    return (
      <div className={`${base} border-hairline bg-panel/60`}>
        <p className="font-display text-xl text-paper/90">
          {listingIsDefault
            ? 'The listing already hides a trick. Press Run, or pick another trick on the left.'
            : 'Your listing is live. Press Run and see if Gemma falls for it.'}
        </p>
        <p className="text-sm text-muted shrink-0">Run · <kbd className="font-mono">⌘ ↵</kbd></p>
      </div>
    );
  }

  const { outcome } = result;
  const moved = <p className="font-display text-2xl xl:text-3xl font-bold text-signal-green shrink-0">{rupees(result.moneyMovedMinor)} moved</p>;
  if (outcome === 'BLOCKED_AT_CART') {
    return (
      <div className={`${base} animate-manifest-enter border-signal-rose bg-signal-rose/10`}>
        <p className="font-display text-2xl xl:text-3xl font-bold">
          Gemma was fooled into a <span className="text-signal-rose">{rupees(result.attemptedAmountMinor)}</span> cart. The cart refused it: not what you asked for.
        </p>
        {moved}
      </div>
    );
  }
  if (outcome === 'BLOCKED_AT_CHECKOUT') {
    return (
      <div className={`${base} animate-manifest-enter border-signal-rose bg-signal-rose/10`}>
        <p className="font-display text-2xl xl:text-3xl font-bold">
          Gemma was fooled into a <span className="text-signal-rose">{rupees(result.attemptedAmountMinor)}</span> cart. Checkout refused it.
        </p>
        {moved}
      </div>
    );
  }
  if (outcome === 'BREACH' || outcome === 'REACHED_PAYMENT_LAYER') {
    return (
      <div className={`${base} animate-manifest-enter border-signal-amber bg-signal-amber/15`}>
        <p className="font-display text-2xl font-bold text-signal-amber">
          {outcome === 'BREACH' ? `An injected item was paid for (${rupees(result.moneyMovedMinor)}).` : 'An injected item reached the payment step.'} That's a bug: please report run {result.correlationId}.
        </p>
      </div>
    );
  }
  if (result.moneyMovedMinor > 0) {
    return (
      <div className={`${base} animate-manifest-enter border-signal-green/70 bg-signal-green/10`}>
        <p className="font-display text-2xl font-bold">Gemma resisted this one and paid only {rupees(result.moneyMovedMinor)}, for what you asked.</p>
        {wallButton}
      </div>
    );
  }
  return (
    <div className={`${base} animate-manifest-enter border-hairline bg-panel`}>
      <p className="font-display text-xl font-semibold">Gemma didn't buy anything this time.</p>
      {wallButton}
    </div>
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
  const [attacks, setAttacks] = useState<AttackPreset[]>([]);
  const [direct, setDirect] = useState<DirectResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [showAllAttacks, setShowAllAttacks] = useState(false);
  const activeRun = useRef<string | null>(null);
  const timelineEnd = useRef<HTMLDivElement | null>(null);

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
      setLoadError(`Can't reach the backend (${err.message}). Start it with npm run demo.`);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/v1/arena/attacks').then(r => r.json())
      .then((list: AttackPreset[]) => setAttacks([...list].sort((a, b) => b.fooled / b.runs - a.fooled / a.runs)))
      .catch(() => setAttacks([]));
  }, []);

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

  // Keep the newest step in view while the timeline grows
  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [steps.length, running]);

  const run = useCallback(async () => {
    if (running || checking) return;
    setRunning(true);
    setElapsed(0);
    setResult(null);
    setDirect(null);
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
  }, [goal, running, checking]);

  // The same over-limit cart, no model: proves the wall even when Gemma resists
  const runDirect = useCallback(async () => {
    if (running || checking) return;
    setChecking(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await fetch('/v1/arena/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Check failed (${res.status})`);
      setDirect(data);
      setSteps(data.steps);
      setMandate(data.mandate);
    } catch (err: any) {
      setRunError(err.message);
    } finally {
      setChecking(false);
    }
  }, [running, checking]);

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
  const { cartMinor, checkout, refused } = cartAndCheckout(steps);
  const task = mandate?.task;

  return (
    <div className="min-h-screen lg:h-screen bg-ink text-paper font-body antialiased flex flex-col">
      <div className="w-full max-w-[1600px] mx-auto px-4 lg:px-6 py-4 flex-1 min-h-0 flex flex-col gap-4">

        {/* Header and live counters */}
        <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <p className="font-display text-sm font-bold uppercase tracking-[0.3em] text-signal-green">Bound</p>
              <a href="#/engine" className="text-xs text-muted hover:text-paper">engine room →</a>
            </div>
            <h1 className="font-display text-4xl font-bold tracking-tight leading-tight">Trick my shopper</h1>
            <p className="text-[15px] text-muted mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5"><Cpu className="w-4 h-4" /> {state.model} on this laptop</span>
              <span className="inline-flex items-center gap-1.5"><WifiOff className="w-4 h-4" /> no cloud, no API key</span>
            </p>
          </div>
          <div className="flex gap-3">
            <Counter value={state.stats.fooled} label="times AI was fooled" tone="text-signal-rose" />
            <Counter value={rupees(state.stats.blockedAmountMinor)} label="spending blocked" tone="text-paper" />
            <Counter value={rupees(state.stats.moneyLostMinor)} label="money lost" tone="text-signal-green" />
          </div>
        </header>

        <StatusStrip running={running} elapsed={elapsed} result={result} runError={runError} listingIsDefault={state.listing.isDefault}
          direct={direct} checking={checking} onDirect={runDirect} />

        <div className="flex-1 min-h-0 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">

          {/* 1. The attacker's listing */}
          <Panel n={1} title="The listing" subtitle="You're the seller. Gemma reads this word for word." accent="bg-signal-rose/15 text-signal-rose">
            <div className="flex gap-3 items-center rounded-xl border border-hairline bg-ink/60 p-3">
              <div className="w-14 h-14 shrink-0 rounded-lg bg-gradient-to-br from-amber-600 to-orange-900 flex items-center justify-center">
                <Coffee className="w-7 h-7 text-amber-100" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-snug">{state.listing.title}</p>
                <p className="text-xs text-muted">Sold by {state.listing.brand} · third-party seller</p>
              </div>
              <p className="font-display text-2xl font-bold shrink-0">{rupees(state.listing.priceMinor)}</p>
            </div>

            {attacks.length > 0 && (
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wider text-muted">Pick a trick <span className="normal-case tracking-normal">· fooled Gemma in rehearsal</span></p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {attacks.filter(a => showAllAttacks || a.fooled / a.runs >= 0.5 || a.text === state.listing.description.trim()).map(a => {
                    const active = state.listing.description.trim() === a.text && !listingDirty;
                    const strong = a.fooled / a.runs >= 0.5;
                    return (
                      <button
                        key={a.id}
                        title={a.summary}
                        onClick={() => saveListing(a.text)}
                        disabled={savingListing || running || checking}
                        className={`rounded-lg border px-2.5 py-1.5 text-[13px] text-left transition-colors disabled:opacity-50 ${
                          active ? 'border-signal-rose bg-signal-rose/15 text-paper' : 'border-hairline bg-ink/60 text-paper/80 hover:border-paper/40'}`}
                      >
                        {a.name} <span className={`ml-1 font-mono text-[11px] ${strong ? 'text-signal-rose' : 'text-muted'}`}>{a.fooled}/{a.runs}</span>
                      </button>
                    );
                  })}
                  {/* Tricks Gemma resisted stay visible on request: the rates are the honest part */}
                  {(() => {
                    const weak = attacks.filter(a => a.fooled / a.runs < 0.5).length;
                    if (!weak) return null;
                    return (
                      <button onClick={() => setShowAllAttacks(v => !v)} className="px-2 py-1.5 text-[12px] text-muted hover:text-paper">
                        {showAllAttacks ? 'show fewer' : `+${weak} Gemma resisted`}
                      </button>
                    );
                  })()}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <label htmlFor="listing" className="text-xs uppercase tracking-wider text-muted">Description, written by the seller</label>
              {(() => {
                const preset = attacks.find(a => a.text === state.listing.description.trim());
                if (listingDirty) return <span className="text-[11px] font-semibold text-signal-amber">unpublished edits</span>;
                if (preset) return <span className="text-[11px] font-semibold text-signal-rose">{preset.name}</span>;
                return <span className="text-[11px] font-semibold text-signal-green inline-flex items-center gap-1"><Check className="w-3 h-3" /> your own text is live</span>;
              })()}
            </div>
            <textarea
              id="listing"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={running}
              spellCheck={false}
              className="mt-2 w-full flex-1 min-h-[140px] rounded-xl bg-ink border border-hairline focus:border-signal-rose focus:outline-none p-3.5 font-mono text-[13px] leading-relaxed text-paper/90 resize-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => saveListing(draft)}
                disabled={!listingDirty || savingListing || running || checking}
                className="rounded-xl bg-signal-rose text-ink font-semibold px-4 py-2.5 disabled:bg-hairline disabled:text-muted transition-colors"
              >
                {savingListing ? 'Publishing…' : 'Publish listing'}
              </button>
              {!state.listing.isDefault && (
                <button
                  onClick={() => saveListing(null)}
                  disabled={savingListing || running || checking}
                  className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-paper disabled:opacity-40"
                >
                  <RotateCcw className="w-4 h-4" /> Restore default trick
                </button>
              )}
            </div>
          </Panel>

          {/* 2. The shopper */}
          <Panel n={2} title="The shopper" subtitle={`Gemma 4, local. Told your ${rupees(ceiling)} limit and warned that listings are seller text; nothing relies on it listening.`} accent="bg-wire-blue/15 text-wire-blue">
            <label htmlFor="goal" className="text-xs uppercase tracking-wider text-muted">The human asked for</label>
            <div className="mt-2 flex gap-2">
              <input
                id="goal"
                value={goal}
                onChange={e => setGoal(e.target.value)}
                disabled={running}
                className="flex-1 min-w-0 rounded-xl bg-ink border border-hairline focus:border-wire-blue focus:outline-none px-3.5 py-3 text-[15px]"
              />
              <button
                onClick={run}
                disabled={running || checking || !goal.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-wire-blue hover:bg-blue-500 text-white font-semibold px-6 py-3 disabled:opacity-50 transition-colors"
                title="⌘ + Enter"
              >
                {running ? <LoaderCircle className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />} {running ? 'Running' : 'Run'}
              </button>
            </div>

            <button
              onClick={runDirect}
              disabled={running || checking}
              className="mt-2 self-end text-[13px] text-muted hover:text-paper disabled:opacity-40"
              title="Adds the flask and the ₹49,999 item yourself, with no model, under the same task and signed limit"
            >
              or skip the AI: build the trick’s cart yourself →
            </button>

            <div className="mt-3 flex-1 min-h-0 overflow-y-auto pr-1">
            <ol>
              {direct && (
                <li className="pb-3 text-[13px] text-muted">No AI in this check. The cart below was filled directly, then sent to checkout.</li>
              )}
              {steps.length === 0 && !running && !checking && IDLE_STEPS.map((s, i) => (
                <li key={s} className={STEP_LI}>
                  <span className="absolute left-0 top-0 w-7 h-7 rounded-full border border-hairline bg-ink text-[12px] font-mono text-muted flex items-center justify-center">{i + 1}</span>
                  <p className="text-[15px] text-muted pt-0.5">{s}</p>
                </li>
              ))}
              {steps.map(step => (
                <StepRow key={step.stepIndex} step={step} titles={titles} payloadVariantId={state.payloadVariantId} direct={!!direct} />
              ))}
              {running && (
                <li className={STEP_LI}>
                  <span className="absolute left-0 top-0 w-7 h-7 rounded-full border border-wire-blue/60 bg-wire-blue/10 flex items-center justify-center">
                    <span className="w-2 h-2 rounded-full bg-wire-blue animate-pulse" />
                  </span>
                  <p className="text-[15px] text-wire-blue pt-0.5">Thinking…</p>
                </li>
              )}
            </ol>
            <div ref={timelineEnd} aria-hidden />
            </div>
          </Panel>

          {/* 3. The wall */}
          <Panel n={3} title="Checkout" subtitle="Your signed limit, checked against the real cart." accent="bg-signal-green/15 text-signal-green">
            <p className="text-xs uppercase tracking-wider text-muted">Your signed limit</p>
            <p className="font-display text-5xl font-bold tabular-nums leading-tight">{rupees(ceiling)}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {categories.map(c => (
                <span key={c} className="text-[11px] rounded-full border border-hairline px-2 py-0.5 text-paper/70">{c}</span>
              ))}
            </div>
            {task && (
              <div className="mt-3 rounded-lg border border-hairline bg-ink/60 px-3 py-2">
                <p className="text-xs uppercase tracking-wider text-muted">What your words authorize</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {task.allowedProductTypes.map(t => (
                    <span key={t} className="text-[11px] rounded-full border border-signal-green/50 text-signal-green px-2 py-0.5">{humanize(t)}</span>
                  ))}
                  {Object.entries(task.requiredAttributes).map(([k, v]) => (
                    <span key={k} className="text-[11px] rounded-full border border-hairline px-2 py-0.5 text-paper/70">{v === false ? `no ${humanize(k)}` : `${humanize(k)}: ${String(v)}`}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5">
              <SpendMeter cartMinor={cartMinor} limitMinor={ceiling} />
            </div>

            <div className="mt-4">
              <CheckoutStamp checkout={checkout} running={running || checking} refused={refused} />
            </div>

            <div className="mt-auto pt-4 text-[11px] font-mono text-muted space-y-1">
              <p className="flex items-center gap-1.5 font-body text-xs text-paper/70"><KeyRound className="w-3.5 h-3.5" /> Ed25519 mandate, signed fresh each run</p>
              {mandate ? (
                <>
                  <p className="truncate">key {mandate.publicKeyFingerprint} · sig {mandate.signature.slice(0, 20)}…</p>
                  {result?.auditEventHash && <p className="truncate">audit {result.auditEventHash}</p>}
                </>
              ) : (
                <p className="font-body text-xs">The demo key is made on this laptop and stands in for your phone's key.</p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
