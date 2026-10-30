import { FastifyReply } from 'fastify';

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
  evidence?: Record<string, unknown>;
}

type SSEClient = {
  id: string;
  reply: FastifyReply;
};

const clients = new Map<string, SSEClient>();

export function registerSSEClient(id: string, reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  clients.set(id, { id, reply });

  // Send initial connected heartbeat
  reply.raw.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Bound Live Audit Stream', timestamp: new Date().toISOString() })}\n\n`);

  reply.raw.on('close', () => {
    clients.delete(id);
  });
}

export function broadcastAuditEvent(event: any) {
  const data = `event: audit_event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.reply.raw.write(data);
    } catch (err) {
      clients.delete(id);
    }
  }
}

export function broadcastFlowEvent(flowEvent: ManifestFlowEvent) {
  const data = `event: flow_event\ndata: ${JSON.stringify(flowEvent)}\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.reply.raw.write(data);
    } catch (err) {
      clients.delete(id);
    }
  }
}

/** Live Arena run updates (run_started, step, run_finished, run_failed) on the same SSE stream. */
export function broadcastArenaEvent(type: string, payload: unknown) {
  const data = `event: arena_event\ndata: ${JSON.stringify({ type, payload, timestamp: new Date().toISOString() })}\n\n`;
  for (const [id, client] of clients.entries()) {
    try {
      client.reply.raw.write(data);
    } catch (err) {
      clients.delete(id);
    }
  }
}
