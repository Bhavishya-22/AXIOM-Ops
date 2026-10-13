import { prisma } from './prisma.js';
import { SERVICES } from '@axiomops/shared';

export interface EvidenceNode {
  nodeId: string;
  service: string;
  level: string;
  signal: string | null;
  signalKind: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  messageSample: string;
  isDiagnostic: boolean;
  isEarliestError?: boolean;
  representativeLogIds: string[]; // max 3
  allLogIds: string[]; // server-held complete map
}

export interface CompactPromptNode {
  nodeId: string;
  service: string;
  signal: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  representativeLogIds: string[];
}

export interface EvidencePack {
  nodes: EvidenceNode[];
  compactNodes: CompactPromptNode[];
  nodeMap: Map<string, string[]>; // nodeId -> allLogIds
  logMap: Map<string, any>; // logId -> raw Log record
  scopedServices: string[];
  windowStart: Date;
  windowEnd: Date;
  sessionId: string;
}

/**
 * Traverses dependsOn edges in both directions up to depth 3 from ticket services.
 */
export function traverseServiceScope(ticketServices: string[], maxDepth: number = 3): string[] {
  const scoped = new Set<string>(ticketServices);
  let frontier = new Set<string>(ticketServices);

  // Build reverse adjacency graph (downstream dependents)
  const dependents: Record<string, string[]> = {};
  for (const [svc, def] of Object.entries(SERVICES)) {
    for (const dep of def.dependsOn) {
      if (!dependents[dep]) dependents[dep] = [];
      dependents[dep].push(svc);
    }
  }

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier = new Set<string>();
    for (const svc of frontier) {
      const def = SERVICES[svc];
      if (def) {
        // Upstream dependencies
        for (const up of def.dependsOn) {
          if (!scoped.has(up)) {
            scoped.add(up);
            nextFrontier.add(up);
          }
        }
      }
      // Downstream dependents
      const down = dependents[svc] || [];
      for (const dSvc of down) {
        if (!scoped.has(dSvc)) {
          scoped.add(dSvc);
          nextFrontier.add(dSvc);
        }
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(scoped);
}

/**
 * Builds session-scoped evidence pack with semantic compression,
 * capping at ~60 nodes without ever dropping a diagnostic node.
 */
export async function buildEvidencePack(params: {
  sessionId: string;
  ticketServices: string[];
  windowStart: Date;
  windowEnd: Date;
  maxNodes?: number;
}): Promise<EvidencePack> {
  const { sessionId, ticketServices, windowStart, windowEnd, maxNodes = 60 } = params;
  const scopedServices = traverseServiceScope(ticketServices);

  // Query logs strictly scoped by sessionId, services, and window
  const logs = await prisma.log.findMany({
    where: {
      sessionId,
      service: { in: scopedServices },
      ts: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { ts: 'asc' },
  });

  const nodeMap = new Map<string, string[]>();
  const logMap = new Map<string, any>();
  for (const l of logs) {
    logMap.set(l.id, l);
  }

  // Find earliest technical error timestamp
  let earliestErrorTs = Infinity;
  let earliestErrorLogId: string | null = null;
  for (const l of logs) {
    if (l.level === 'ERROR' && l.ts.getTime() < earliestErrorTs) {
      earliestErrorTs = l.ts.getTime();
      earliestErrorLogId = l.id;
    }
  }

  // Semantic compression: group into buckets
  // 1. Diagnostic / supporting / error rows grouped by (service, signal, 30s-window) or (service, messageHash)
  // 2. Routine INFO rows collapsed per service
  const groups = new Map<string, any[]>();

  for (const log of logs) {
    let groupKey: string;
    const isSignalBearing = Boolean(log.signal);
    const isError = log.level === 'ERROR' || log.level === 'WARN';

    if (isSignalBearing) {
      // 30s bucket per (service, signal)
      const bucket30s = Math.floor(log.ts.getTime() / 30000);
      groupKey = `${log.service}:sig:${log.signal}:${bucket30s}`;
    } else if (isError) {
      const bucket30s = Math.floor(log.ts.getTime() / 30000);
      groupKey = `${log.service}:err:${log.messageHash}:${bucket30s}`;
    } else {
      // Routine healthy info collapsed per service
      groupKey = `${log.service}:routine:summary`;
    }

    const list = groups.get(groupKey) ?? [];
    list.push(log);
    groups.set(groupKey, list);
  }

  let nodeCounter = 1;
  const rawNodes: EvidenceNode[] = [];

  for (const [, items] of groups) {
    if (items.length === 0) continue;
    const first = items[0];
    const last = items[items.length - 1];
    const isDiagnostic = items.some((i) => i.signalKind === 'diagnostic');
    const hasEarliestError = items.some((i) => i.id === earliestErrorLogId);

    const nodeId = `node_${nodeCounter++}`;
    const allLogIds = items.map((i) => i.id);
    const representativeLogIds = allLogIds.slice(0, 3);

    nodeMap.set(nodeId, allLogIds);

    rawNodes.push({
      nodeId,
      service: first.service,
      level: first.level,
      signal: first.signal,
      signalKind: first.signalKind,
      count: items.length,
      firstSeen: first.ts.toISOString(),
      lastSeen: last.ts.toISOString(),
      messageSample: first.message,
      isDiagnostic,
      isEarliestError: hasEarliestError,
      representativeLogIds,
      allLogIds,
    });
  }

  // Node Cap of ~60: Diagnostic nodes must NEVER be dropped!
  // Sort diagnostic nodes first, then supporting/errors, then routine
  rawNodes.sort((a, b) => {
    if (a.isDiagnostic && !b.isDiagnostic) return -1;
    if (!a.isDiagnostic && b.isDiagnostic) return 1;
    if (a.signal && !b.signal) return -1;
    if (!a.signal && b.signal) return 1;
    return b.count - a.count;
  });

  const cappedNodes = rawNodes.slice(0, maxNodes);

  // Compact payload nodes for LLM
  const compactNodes: CompactPromptNode[] = cappedNodes.map((n) => ({
    nodeId: n.nodeId,
    service: n.service,
    signal: n.signal,
    count: n.count,
    firstSeen: n.firstSeen,
    lastSeen: n.lastSeen,
    representativeLogIds: n.representativeLogIds,
  }));

  return {
    nodes: cappedNodes,
    compactNodes,
    nodeMap,
    logMap,
    scopedServices,
    windowStart,
    windowEnd,
    sessionId,
  };
}
