import { useState, useEffect } from 'react';
import {
  Bot, ShieldCheck, AlertTriangle, CheckCircle2, 
  Play, RefreshCw, Lock, Zap, 
  Layers, Sparkles, Cpu,
  Clock, Award, Copy, CheckCheck, Eye
} from 'lucide-react';

export type ManifestFlowStage = 'A2A' | 'POLICY' | 'INVENTORY' | 'PAYMENT' | 'ORDER' | 'AUDIT';
export type ManifestFlowStatus = 'WAITING' | 'ACTIVE' | 'SUCCESS' | 'WARNING' | 'FAILED' | 'RECOVERING';

export interface ManifestFlowEvent {
  correlationId: string;
  sequence: number;
  stage: ManifestFlowStage;
  eventType: string;
  status: ManifestFlowStatus;
  timestamp: string;
  summary: string;
  evidence?: Record<string, any>;
}

export interface AuditEvent {
  id: string;
  sequenceNumber: number;
  correlationId: string;
  actor: string;
  action: string;
  decision: 'AUTO_EXECUTABLE' | 'REQUIRES_USER_ACTION' | 'DENIED' | null;
  humanReadable: string;
  policyRuleId?: string;
  prevEventHash: string;
  currentHash: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

interface StageState {
  status: ManifestFlowStatus;
  summary: string;
  evidence: Record<string, any>;
  lastUpdated: string;
}

const INITIAL_STAGES: Record<ManifestFlowStage, StageState> = {
  A2A: {
    status: 'WAITING',
    summary: 'Awaiting autonomous buyer agent negotiation & intent',
    evidence: {
      buyerGoal: 'Pending initiation',
      sellerInterpretation: 'Standing by for A2A handshake',
      protocol: 'MANIFEST_A2A',
      privateEconomics: '🔒 REDACTED'
    },
    lastUpdated: '-'
  },
  POLICY: {
    status: 'WAITING',
    summary: 'Standing by for deterministic policy evaluation',
    evidence: {
      authorization: 'PENDING',
      paymentCapability: 'STANDBY',
      risk: 'STANDBY',
      executionPlan: 'STANDBY'
    },
    lastUpdated: '-'
  },
  INVENTORY: {
    status: 'WAITING',
    summary: 'Inventory kernel ready for atomic row-locking',
    evidence: {
      identityConfidence: 'STANDBY',
      holdLimit: '1 / SKU',
      activeHolds: '0 / 1',
      dbLockDurationMs: '-',
      reservationTtl: '10:00',
      stockStatus: 'AVAILABLE'
    },
    lastUpdated: '-'
  },
  PAYMENT: {
    status: 'WAITING',
    summary: 'Payment rail dispatcher ready for interactive or simulated capture',
    evidence: {
      paymentRail: 'STANDBY',
      environment: 'TEST_ONLY',
      paymentStatus: 'PENDING'
    },
    lastUpdated: '-'
  },
  ORDER: {
    status: 'WAITING',
    summary: 'Five deterministic state machines standing by',
    evidence: {
      checkoutState: 'OPEN',
      reservationState: 'NONE',
      paymentState: 'PENDING',
      orderState: 'PENDING',
      refundState: 'NONE'
    },
    lastUpdated: '-'
  },
  AUDIT: {
    status: 'WAITING',
    summary: 'Hash-chained audit ledger ready (checkpoint anchors are simulated, in-memory)',
    evidence: {
      auditEvent: 'PENDING',
      canonicalization: 'RFC 8785'
    },
    lastUpdated: '-'
  }
};

export default function App() {
  const [stages, setStages] = useState<Record<ManifestFlowStage, StageState>>(INITIAL_STAGES);
  const [activeCorrelationId, setActiveCorrelationId] = useState<string>('corr_init_' + Date.now().toString().substring(7));
  const [selectedStage, setSelectedStage] = useState<ManifestFlowStage>('A2A');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [runningPlaybook, setRunningPlaybook] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'merkle' | 'webhook' | 'worm' | 'outbox'>('merkle');
  const [copiedCorr, setCopiedCorr] = useState<boolean>(false);

  // ─── 1. Connect to Real SSE Stream ──────────────────────────────────────────
  useEffect(() => {
    fetchInitialData();

    const eventSource = new EventSource('/v1/audit/stream');

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.addEventListener('audit_event', (event) => {
      try {
        const parsed: AuditEvent = JSON.parse(event.data);
        setAuditEvents((prev) => {
          if (prev.some(e => e.id === parsed.id)) return prev;
          return [parsed, ...prev.slice(0, 49)];
        });
      } catch (err) {
        console.error('Error parsing audit event', err);
      }
    });

    eventSource.addEventListener('flow_event', (event) => {
      try {
        const flow: ManifestFlowEvent = JSON.parse(event.data);
        setActiveCorrelationId(flow.correlationId);

        setStages((prev) => ({
          ...prev,
          [flow.stage]: {
            status: flow.status,
            summary: flow.summary,
            evidence: {
              ...(prev[flow.stage]?.evidence || {}),
              ...(flow.evidence || {})
            },
            lastUpdated: new Date().toLocaleTimeString()
          }
        }));

        setSelectedStage(flow.stage);
      } catch (err) {
        console.error('Error parsing flow event', err);
      }
    });

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const fetchInitialData = async () => {
    try {
      const auditRes = await fetch('/v1/audit?limit=25');
      if (auditRes.ok) {
        const data = await auditRes.json();
        setAuditEvents(data);
      }
    } catch (err) {
      console.error('Failed to fetch initial audit trail', err);
    }
  };

  // ─── 2. Execute Real Backend Playbooks ──────────────────────────────────────
  const runPlaybook = async (endpoint: string, playbookKey: string) => {
    if (runningPlaybook) return;
    setRunningPlaybook(playbookKey);

    // Reset stages to waiting before the real events start flowing
    setStages(INITIAL_STAGES);

    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.correlationId) {
          setActiveCorrelationId(data.correlationId);
        }
      }
    } catch (err) {
      console.error(`Failed to execute playbook ${playbookKey}:`, err);
    } finally {
      setRunningPlaybook(null);
    }
  };

  const copyCorrelationId = () => {
    navigator.clipboard.writeText(activeCorrelationId);
    setCopiedCorr(true);
    setTimeout(() => setCopiedCorr(false), 2000);
  };

  const getStatusBadge = (status: ManifestFlowStatus) => {
    switch (status) {
      case 'SUCCESS':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-700/50">SUCCESS ✓</span>;
      case 'ACTIVE':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-cyan-950 text-cyan-300 border border-cyan-700/50 animate-pulse">ACTIVE ◉</span>;
      case 'WARNING':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-950 text-amber-300 border border-amber-700/50">EXCEPTION ⚠️</span>;
      case 'FAILED':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-rose-950 text-rose-300 border border-rose-700/50">BLOCKED ✕</span>;
      case 'RECOVERING':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-900 text-amber-200 border border-amber-500/50 animate-pulse">RECOVERING 🔄</span>;
      default:
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-slate-900 text-slate-400 border border-slate-700/50">WAITING</span>;
    }
  };



  return (
    <div className="min-h-screen bg-[#07090C] text-slate-100 font-sans antialiased selection:bg-cyan-500/30">
      
      {/* ─── 1. TOP HEADER & SYSTEM INVARIANTS STRIP ───────────────────────── */}
      <header className="border-b border-slate-800/80 bg-[#0B0E14]/90 backdrop-blur sticky top-0 z-50">
        <div className="max-w-[1720px] mx-auto px-4 lg:px-8 py-3 flex flex-col md:flex-row items-center justify-between gap-3">
          
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                  BOUND <span className="text-xs px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-800/50 font-mono">CONTROL TOWER</span>
                </h1>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-slate-900 border border-slate-700/60 text-slate-300">
                  <span className={`w-2 h-2 rounded-full ${sseConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
                  {sseConnected ? 'LIVE FEED' : 'CONNECTING'}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">Apex Global Retail (seed data) • Razorpay Test Mode</p>
            </div>
          </div>

          {/* Active Correlation ID */}
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-lg font-mono text-xs text-slate-300">
            <span className="text-slate-500">CORRELATION:</span>
            <span className="text-cyan-300 font-semibold">{activeCorrelationId}</span>
            <button 
              onClick={copyCorrelationId}
              className="ml-1 text-slate-400 hover:text-white transition-colors" 
              title="Copy Correlation ID"
            >
              {copiedCorr ? <CheckCheck className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* Honesty badge: this screen is a scripted walkthrough, not the live AI demo */}
          <div className="flex items-center gap-3">
            <div className="px-2.5 py-1 rounded bg-amber-950/60 border border-amber-700/60 text-amber-300 text-[11px] font-mono font-semibold">
              SCRIPTED WALKTHROUGH · partly hardcoded narration
            </div>
            <a href="#/" className="text-xs font-semibold text-cyan-300 hover:text-white">← Live Arena</a>
          </div>

        </div>
      </header>

      <main className="max-w-[1720px] mx-auto px-4 lg:px-8 py-6 space-y-6">

        {/* ─── 2. HERO: VISUAL TRANSACTION STORY PIPELINE ───────────────────── */}
        <section className="bg-[#0B0E14] border border-slate-800/90 rounded-xl p-5 shadow-2xl relative overflow-hidden">
          
          <div className="flex items-center justify-between pb-4 border-b border-slate-800/60 mb-5">
            <div>
              <h2 className="text-sm font-bold tracking-wider text-slate-200 uppercase flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                Live Transaction Story Pipeline
              </h2>
              <p className="text-xs text-slate-400">
                Projection of backend events. Stages marked [Scripted] are hand-written narration; inventory, checkout, webhook processing and the audit chain run real code.
              </p>
            </div>
            <div className="text-[11px] font-mono text-slate-400 flex items-center gap-2">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> Committed</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" /> Active</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" /> Recovering</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> Blocked</span>
            </div>
          </div>

          {/* The 6 Interconnected Stages Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3 relative">
            
            {/* Stage 1: A2A Protocol */}
            <div 
              onClick={() => setSelectedStage('A2A')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'A2A' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 1</span>
                {getStatusBadge(stages.A2A.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <Bot className="w-4 h-4 text-cyan-400" />
                A2A Protocol
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                <div className="text-slate-400 flex justify-between">
                  <span>ACTORS:</span>
                  <span className="text-slate-200 font-semibold">BUYER ↔ SELLER</span>
                </div>
                <div className="text-slate-400 flex justify-between">
                  <span>DISCOUNT:</span>
                  <span className="text-cyan-300 font-semibold">{stages.A2A.evidence.negotiationStatus || 'ACCEPTED (5%)'}</span>
                </div>
                <div className="text-slate-400 flex justify-between">
                  <span>ECONOMICS:</span>
                  <span className="text-amber-400 font-semibold">🔒 REDACTED</span>
                </div>
                <div className="text-slate-500 text-[10px] truncate pt-1 border-t border-slate-800/80">
                  Protocol: {stages.A2A.evidence.protocol || 'MANIFEST_A2A'}
                </div>
              </div>
            </div>

            {/* Stage 2: Policy Gate */}
            <div 
              onClick={() => setSelectedStage('POLICY')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'POLICY' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 2</span>
                {getStatusBadge(stages.POLICY.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                Policy Gate
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-400">AUTH:</span>
                  <span className={stages.POLICY.evidence.authorization === 'DENIED ✕' ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {stages.POLICY.evidence.authorization || 'AUTHORIZED ✓'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">CAPABILITY:</span>
                  <span className="text-cyan-300 font-semibold">{stages.POLICY.evidence.paymentCapability || 'AUTO_EXECUTABLE'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">RISK:</span>
                  <span className="text-emerald-400 font-semibold">{stages.POLICY.evidence.risk || 'ALLOW ✓'}</span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">EXEC PLAN:</span>
                  <span className="text-cyan-300 font-semibold">{stages.POLICY.evidence.executionPlan || 'AUTO_EXECUTABLE'}</span>
                </div>
              </div>
            </div>

            {/* Stage 3: Inventory Hold */}
            <div 
              onClick={() => setSelectedStage('INVENTORY')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'INVENTORY' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 3</span>
                {getStatusBadge(stages.INVENTORY.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                Inventory Hold
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-400">CONFIDENCE:</span>
                  <span className="text-cyan-300 font-semibold">{stages.INVENTORY.evidence.identityConfidence || 'DEFINITE_LINK'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">HOLD LIMIT:</span>
                  <span className="text-slate-200 font-semibold">1 / SKU</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">DB LOCK:</span>
                  <span className="text-emerald-400 font-semibold">{stages.INVENTORY.evidence.dbLockDurationMs || '< 15 ms'} (RELEASED)</span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">TTL HOLD:</span>
                  <span className="text-amber-400 font-semibold">{stages.INVENTORY.evidence.reservationTtl || '10:00 (ACTIVE)'}</span>
                </div>
              </div>
            </div>

            {/* Stage 4: Payment & Provenance (Rail-Aware) */}
            <div 
              onClick={() => setSelectedStage('PAYMENT')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'PAYMENT' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 4</span>
                {getStatusBadge(stages.PAYMENT.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                Payment & Rail
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                {stages.PAYMENT.evidence.paymentRail === 'RAZORPAY_STANDARD' ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-slate-400">RAIL:</span>
                      <span className="text-cyan-300 font-semibold">RAZORPAY_STANDARD</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">HMAC:</span>
                      <span className="text-emerald-400 font-semibold">VERIFIED ✓</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">API MATCH:</span>
                      <span className="text-emerald-400 font-semibold">GET /v1/pay... ✓</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-slate-800/80">
                      <span className="text-slate-400">PAYMENT:</span>
                      <span className="text-emerald-400 font-bold">CAPTURED ✓</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <span className="text-slate-400">RAIL:</span>
                      <span className="text-cyan-300 font-semibold">MOCK_SIMULATED_RAIL</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">AUTHORITY:</span>
                      <span className="text-emerald-400 font-semibold">MANDATE TOKEN ✓</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">FUNDS MOVED:</span>
                      <span className="text-slate-400 font-semibold">NO (TEST ONLY)</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-slate-800/80">
                      <span className="text-slate-400">STATUS:</span>
                      <span className="text-emerald-400 font-bold">CAPTURED ✓</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Stage 5: Commerce State Resolution */}
            <div 
              onClick={() => setSelectedStage('ORDER')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'ORDER' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 5</span>
                {getStatusBadge(stages.ORDER.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <CheckCircle2 className="w-4 h-4 text-cyan-400" />
                State Resolution
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-400">CHECKOUT:</span>
                  <span className="text-emerald-400 font-semibold">{stages.ORDER.evidence.checkoutState || 'COMPLETED'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">RESERVATION:</span>
                  <span className="text-emerald-400 font-semibold">{stages.ORDER.evidence.reservationState || 'COMMITTED'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">ORDER:</span>
                  <span className={stages.ORDER.evidence.orderStatus === 'FULFILMENT_EXCEPTION' ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {stages.ORDER.evidence.orderState || stages.ORDER.evidence.orderStatus || 'CONFIRMED ✓'}
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">REFUND:</span>
                  <span className={stages.ORDER.evidence.refundState && stages.ORDER.evidence.refundState !== 'NONE' ? 'text-amber-400 font-semibold' : 'text-slate-500'}>
                    {stages.ORDER.evidence.refundState || '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Stage 6: Audit, Provenance & Immutable Anchor */}
            <div 
              onClick={() => setSelectedStage('AUDIT')}
              className={`p-4 rounded-lg border transition-all cursor-pointer relative ${
                selectedStage === 'AUDIT' 
                  ? 'bg-slate-900/95 border-cyan-500/80 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/50' 
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">STAGE 6</span>
                {getStatusBadge(stages.AUDIT.status)}
              </div>
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-2">
                <Lock className="w-4 h-4 text-cyan-400" />
                Audit Chain
              </h3>
              <div className="space-y-1.5 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-400">EVENT:</span>
                  <span className="text-emerald-400 font-semibold">SEALED ✓</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">RFC 8785:</span>
                  <span className="text-emerald-400 font-semibold">CANONICAL ✓</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">SIGNER:</span>
                  <span className="text-slate-300 font-semibold">Ed25519 (local key)</span>
                </div>
                <div className="flex justify-between pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">ANCHOR:</span>
                  <span className="text-amber-400 font-bold">SIMULATED</span>
                </div>
              </div>
            </div>

          </div>

          {/* Real-time Summary Banner */}
          <div className="mt-4 px-4 py-2.5 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span className="font-mono text-slate-400">LATEST EVENT:</span>
              <span className="font-mono text-slate-200 font-semibold">{stages[selectedStage]?.summary}</span>
            </div>
            <span className="text-slate-500 font-mono text-[11px]">Click any stage card above for deep evidence inspection</span>
          </div>

        </section>

        {/* ─── 3. CURRENT ACTIVE STAGE DETAILS (PROGRESSIVE DISCLOSURE) ──────── */}
        <section className="bg-[#0B0E14] border border-slate-800 rounded-xl p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">
                Stage Detail & Evidence Inspector: <span className="text-cyan-400 font-mono">{selectedStage}</span>
              </h3>
            </div>
            <span className="text-xs text-slate-500 font-mono">Last event: {stages[selectedStage]?.lastUpdated}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 bg-slate-950 p-4 rounded-lg border border-slate-800/80 font-mono text-xs space-y-2">
              <div className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider pb-1 border-b border-slate-900">
                Stage Execution Summary & State Projection
              </div>
              <p className="text-slate-200 text-sm leading-relaxed">{stages[selectedStage]?.summary}</p>
              
              <div className="pt-2">
                <div className="text-[11px] text-slate-400 font-semibold mb-1">EVIDENCE PAYLOAD:</div>
                <pre className="bg-[#06080B] p-3 rounded border border-slate-800/80 text-[11px] text-cyan-300 overflow-x-auto">
                  {JSON.stringify(stages[selectedStage]?.evidence || {}, null, 2)}
                </pre>
              </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800/80 font-mono text-xs space-y-3">
              <div className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider pb-1 border-b border-slate-900">
                Architectural Invariant Guarantee
              </div>
              {selectedStage === 'A2A' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Zero Margin Leakage</p>
                  <p className="text-slate-400">Internal margin floors (1200 bps) are protected. Explanations return privacy-preserving policy statements.</p>
                </div>
              )}
              {selectedStage === 'POLICY' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Deterministic Authorization</p>
                  <p className="text-slate-400">Evaluates Ed25519 mandate, budget envelope, and category whitelists strictly below the LLM reasoning layer.</p>
                </div>
              )}
              {selectedStage === 'INVENTORY' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Row-Lock Decoupling</p>
                  <p className="text-slate-400">PostgreSQL row lock released in &lt;15ms. Holds inventory hold TTL for 10 minutes without table contention.</p>
                </div>
              )}
              {selectedStage === 'PAYMENT' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Dual-Rail Transparency</p>
                  <p className="text-slate-400">Explicitly separates interactive Razorpay rails from test-only simulated autonomous payment rails.</p>
                </div>
              )}
              {selectedStage === 'ORDER' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Independent State Machines</p>
                  <p className="text-slate-400">Enforces 5 distinct lifecycles across Checkout, Reservation, Payment, Order, and Refund states.</p>
                </div>
              )}
              {selectedStage === 'AUDIT' && (
                <div className="text-slate-300 space-y-1.5 text-[11px]">
                  <p className="text-emerald-400 font-semibold">✓ Hash-Chained Audit Ledger</p>
                  <p className="text-slate-400">Checkpoints are signed with a locally generated Ed25519 key and stored in an in-memory write-once map (simulated; resets on restart). No AWS KMS or S3 Object Lock is used.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ─── 4. PLAYBOOKS PANEL (REAL API EXECUTION FOR JUDGES) ────────────── */}
        <section className="bg-[#0B0E14] border border-slate-800 rounded-xl p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide flex items-center gap-2">
                <Play className="w-4 h-4 text-cyan-400" />
                Scripted Walkthroughs
              </h3>
              <p className="text-xs text-slate-400">Each run calls real cart, inventory, checkout and webhook code, but the AI and policy stages are hand-written narration. The live prompt-injection demo is the Arena (POST /v1/arena/run), which runs local Gemma 4 against the real policy engine.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            
            {/* Playbook 1 */}
            <button
              disabled={runningPlaybook !== null}
              onClick={() => runPlaybook('/v1/demo/playbook/autonomous', 'autonomous')}
              className={`p-3.5 rounded-lg border text-left flex flex-col justify-between transition-all ${
                runningPlaybook === 'autonomous'
                  ? 'bg-cyan-950 border-cyan-500 ring-2 ring-cyan-500/40'
                  : 'bg-slate-900/80 hover:bg-slate-850 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-cyan-400 font-bold">PLAYBOOK 1</span>
                  <Bot className="w-3.5 h-3.5 text-cyan-400" />
                </div>
                <h4 className="text-xs font-bold text-white mb-1">Autonomous Signed Mandate</h4>
                <p className="text-[11px] text-slate-400 line-clamp-2">
                  TEST-ONLY delegated payment under Ed25519 mandate (AP2-inspired).
                </p>
              </div>
              <div className="mt-3 flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400">
                <span>Auto Execution</span>
                <span className="text-cyan-400 font-bold flex items-center gap-0.5">RUN ➔</span>
              </div>
            </button>

            {/* Playbook 2 */}
            <button
              disabled={runningPlaybook !== null}
              onClick={() => runPlaybook('/v1/demo/playbook/razorpay', 'razorpay')}
              className={`p-3.5 rounded-lg border text-left flex flex-col justify-between transition-all ${
                runningPlaybook === 'razorpay'
                  ? 'bg-cyan-950 border-cyan-500 ring-2 ring-cyan-500/40'
                  : 'bg-slate-900/80 hover:bg-slate-850 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-emerald-400 font-bold">PLAYBOOK 2 (DEFAULT)</span>
                  <Award className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <h4 className="text-xs font-bold text-white mb-1">Razorpay Interactive Checkout</h4>
                <p className="text-[11px] text-slate-400 line-clamp-2">
                  Standard rail requiring human step-up + verified webhook ingestion.
                </p>
              </div>
              <div className="mt-3 flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400">
                <span>Interactive Rail</span>
                <span className="text-emerald-400 font-bold flex items-center gap-0.5">RUN ➔</span>
              </div>
            </button>

            {/* Playbook 3 */}
            <button
              disabled={runningPlaybook !== null}
              onClick={() => runPlaybook('/v1/demo/playbook/failure-recovery', 'recovery')}
              className={`p-3.5 rounded-lg border text-left flex flex-col justify-between transition-all ${
                runningPlaybook === 'recovery'
                  ? 'bg-cyan-950 border-cyan-500 ring-2 ring-cyan-500/40'
                  : 'bg-slate-900/80 hover:bg-slate-850 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-amber-400 font-bold">PLAYBOOK 3</span>
                  <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                </div>
                <h4 className="text-xs font-bold text-white mb-1">Failure ➔ Retry ➔ Recovery</h4>
                <p className="text-[11px] text-slate-400 line-clamp-2">
                  Preserves 10m stock hold during card decline, recovers with UPI Intent.
                </p>
              </div>
              <div className="mt-3 flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400">
                <span>Hold Preserved</span>
                <span className="text-amber-400 font-bold flex items-center gap-0.5">RUN ➔</span>
              </div>
            </button>

            {/* Playbook 4 */}
            <button
              disabled={runningPlaybook !== null}
              onClick={() => runPlaybook('/v1/demo/playbook/fulfilment-compensation', 'compensation')}
              className={`p-3.5 rounded-lg border text-left flex flex-col justify-between transition-all ${
                runningPlaybook === 'compensation'
                  ? 'bg-cyan-950 border-cyan-500 ring-2 ring-cyan-500/40'
                  : 'bg-slate-900/80 hover:bg-slate-850 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-amber-300 font-bold">PLAYBOOK 4</span>
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
                </div>
                <h4 className="text-xs font-bold text-white mb-1">Fulfilment ➔ Auto-Refund</h4>
                <p className="text-[11px] text-slate-400 line-clamp-2">
                  Late capture on exhausted stock triggers sub-second automated refund initiation.
                </p>
              </div>
              <div className="mt-3 flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400">
                <span>Auto Compensation</span>
                <span className="text-amber-300 font-bold flex items-center gap-0.5">RUN ➔</span>
              </div>
            </button>

          </div>
        </section>

        {/* ─── 5. LOWER TIER: LIVE SSE STREAM & TECHNICAL INSPECTOR ─────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Live Event Stream (SSE) */}
          <div className="lg:col-span-5 bg-[#0B0E14] border border-slate-800 rounded-xl p-4 flex flex-col h-[480px]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wide flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                Live SSE Audit Stream
              </h3>
              <span className="text-[10px] font-mono text-slate-500">{auditEvents.length} events logged</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 font-mono text-xs">
              {auditEvents.length === 0 ? (
                <div className="text-center py-12 text-slate-500">Waiting for live events...</div>
              ) : (
                auditEvents.map((evt) => (
                  <div key={evt.id} className="p-2.5 rounded bg-slate-950/80 border border-slate-800/80 text-[11px] space-y-1 hover:border-slate-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-cyan-400 font-semibold font-mono">#{evt.sequenceNumber} • {evt.action}</span>
                      <span className="text-slate-500 text-[10px]">{new Date(evt.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-slate-300 text-[11px] font-sans">{evt.humanReadable}</p>
                    <div className="text-[10px] text-slate-500 truncate flex justify-between pt-1 border-t border-slate-900">
                      <span>Actor: {evt.actor}</span>
                      <span>Hash: {evt.currentHash?.substring(0, 12)}...</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Technical Inspector Tabs */}
          <div className="lg:col-span-7 bg-[#0B0E14] border border-slate-800 rounded-xl p-4 flex flex-col h-[480px]">
            
            {/* Inspector Navigation Tabs */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveTab('merkle')}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                    activeTab === 'merkle' ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Hash Chain
                </button>
                <button
                  onClick={() => setActiveTab('webhook')}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                    activeTab === 'webhook' ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Razorpay Webhook & API
                </button>
                <button
                  onClick={() => setActiveTab('worm')}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                    activeTab === 'worm' ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Checkpoint Anchors
                </button>
                <button
                  onClick={() => setActiveTab('outbox')}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                    activeTab === 'outbox' ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Outbox Atomicity
                </button>
              </div>
              <span className="text-[10px] font-mono text-amber-400">Static illustration · sample values</span>
            </div>

            {/* Tab Contents */}
            <div className="flex-1 overflow-y-auto bg-slate-950 p-3.5 rounded border border-slate-800/80 font-mono text-xs text-slate-300">
              
              {activeTab === 'merkle' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-emerald-400 text-[11px] font-bold pb-2 border-b border-slate-900">
                    <span>RFC 8785 CANONICAL SHA-256 HASH CHAIN</span>
                    <span className="text-amber-400">ILLUSTRATIVE</span>
                  </div>
                  <pre className="text-cyan-300 text-[11px] leading-relaxed">
{`{
  "protocol": "RFC8785_CANONICAL_JSON",
  "hashAlgorithm": "SHA-256",
  "chainHead": "${stages.AUDIT.evidence.auditChainHead || '(run a walkthrough to populate)'}",
  "signingKey": "local:ed25519:audit-checkpoint-dev-key",
  "signatureAlgorithm": "Ed25519"
}`}
                  </pre>
                </div>
              )}

              {activeTab === 'webhook' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-emerald-400 text-[11px] font-bold pb-2 border-b border-slate-900">
                    <span>RAZORPAY WEBHOOK VERIFICATION (SHAPE)</span>
                    <span className="text-amber-400">ILLUSTRATIVE</span>
                  </div>
                  <pre className="text-cyan-300 text-[11px] leading-relaxed">
{`{
  "source": "RAZORPAY_NETWORK",
  "signatureVerification": "CONSTANT_TIME_HMAC_SHA256_MATCH",
  "eventId": "${stages.PAYMENT.evidence.eventId || 'evt_rzp_net_' + Date.now()}",
  "providerCrossVerification": {
    "endpoint": "GET /v1/payments/pay_net_...",
    "status": "captured",
    "amountMinor": 349900,
    "currency": "INR",
    "accountId": "acc_test_demo"
  },
  "secretRotationPolicy": {
    "primarySecret": "ACTIVE",
    "dualVerificationGracePeriod": "24_HOURS",
    "plaintextStorage": "ZERO (secret handles only; resolver is an in-memory mock)"
  }
}`}
                  </pre>
                </div>
              )}

              {activeTab === 'worm' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-emerald-400 text-[11px] font-bold pb-2 border-b border-slate-900">
                    <span>SIMULATED WORM STORE (IN-MEMORY)</span>
                    <span className="text-amber-400">ILLUSTRATIVE</span>
                  </div>
                  <pre className="text-cyan-300 text-[11px] leading-relaxed">
{`{
  "vaultDestination": "memory://simulated-worm/checkpoints/",
  "signingKey": "local:ed25519:audit-checkpoint-dev-key",
  "checkpointSignature": "${stages.AUDIT.evidence.checkpointSignature || '(run a walkthrough to populate)'}",
  "dbMatchesAnchor": "${stages.AUDIT.evidence.dbMatchesAnchor || '(run a walkthrough to populate)'}",
  "note": "Write-once only within this process; a real deployment needs KMS + S3 Object Lock"
}`}
                  </pre>
                </div>
              )}

              {activeTab === 'outbox' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-emerald-400 text-[11px] font-bold pb-2 border-b border-slate-900">
                    <span>TRANSACTIONAL OUTBOX ATOMICITY MONITOR</span>
                    <span className="text-amber-400">ILLUSTRATIVE</span>
                  </div>
                  <pre className="text-cyan-300 text-[11px] leading-relaxed">
{`{
  "pattern": "TRANSACTIONAL_OUTBOX_ACID_COMMIT",
  "ghostStateRisk": "ZERO (Commerce Mutation + Outbox Committed in Same ACID Transaction)"
}`}
                  </pre>
                </div>
              )}

            </div>
          </div>

        </div>

      </main>

    </div>
  );
}
