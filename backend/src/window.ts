import { prisma } from './prisma.js';

export interface EvidenceWindowResult {
  windowStart: Date;
  windowEnd: Date;
  isComplete: boolean;
  overlappingGaps: any[];
  previousResolvedAt: Date | null;
}

/**
 * Computes windowStart and windowEnd per Section 13, and checks for overlapping IngestGaps.
 */
export async function computeEvidenceWindow(params: {
  detectedAt: Date;
  investigationStartedAt: Date;
  scopedServices: string[];
  sessionId: string;
}): Promise<EvidenceWindowResult> {
  const { detectedAt, investigationStartedAt, scopedServices, sessionId } = params;

  // 1. Previous incident resolvedAt
  const previousIncident = await prisma.incident.findFirst({
    where: {
      status: 'resolved',
      resolvedAt: { not: null, lt: detectedAt },
    },
    orderBy: { resolvedAt: 'desc' },
  });
  const previousResolvedAt = previousIncident?.resolvedAt ?? null;

  // 2. Last DeployEvent before detectedAt within 2 hours
  const twoHoursAgo = new Date(detectedAt.getTime() - 2 * 60 * 60 * 1000);
  const lastDeploy = await prisma.deployEvent.findFirst({
    where: {
      ts: { gte: twoHoursAgo, lte: detectedAt },
    },
    orderBy: { ts: 'desc' },
  });

  // 3. 5-minute lookback margin
  const fiveMinMargin = 5 * 60 * 1000;
  let candidateStartMs = detectedAt.getTime() - fiveMinMargin;

  if (lastDeploy) {
    candidateStartMs = Math.min(candidateStartMs, lastDeploy.ts.getTime());
  }

  // Never start before previous incident resolvedAt
  if (previousResolvedAt && candidateStartMs < previousResolvedAt.getTime()) {
    candidateStartMs = previousResolvedAt.getTime();
  }

  const windowStart = new Date(candidateStartMs);
  const windowEnd = investigationStartedAt;

  // 4. Check for overlapping IngestGaps
  const gaps = await prisma.ingestGap.findMany({
    where: {
      fromTs: { lte: windowEnd },
      toTs: { gte: windowStart },
    },
  });

  // A window is complete only if NO IngestGap overlaps for a scoped service
  // A '*' gap overlaps every service of its source
  const overlappingGaps = gaps.filter((g) => {
    if (g.services.includes('*')) return true;
    return g.services.some((s) => scopedServices.includes(s));
  });

  const isComplete = overlappingGaps.length === 0;

  return {
    windowStart,
    windowEnd,
    isComplete,
    overlappingGaps,
    previousResolvedAt,
  };
}

/**
 * Pins all log rows from windowStart onward for the open incident.
 */
export async function pinIncidentLogs(
  incidentId: string,
  sessionId: string,
  windowStart: Date
): Promise<{ count: number }> {
  const result = await prisma.log.updateMany({
    where: {
      sessionId,
      ts: { gte: windowStart },
    },
    data: {
      pinnedByIncidentId: incidentId,
      class: 'incident',
    },
  });

  return { count: result.count };
}

/**
 * One-step window expansion: widens lookback window up to 2x or last deploy event,
 * strictly bounded by retention and previous resolvedAt.
 */
export function expandEvidenceWindow(
  currentStart: Date,
  windowEnd: Date,
  previousResolvedAt: Date | null
): Date {
  const currentDurationMs = windowEnd.getTime() - currentStart.getTime();
  const doubledLookbackMs = windowEnd.getTime() - currentDurationMs * 2;

  let widenedStartMs = doubledLookbackMs;
  if (previousResolvedAt && widenedStartMs < previousResolvedAt.getTime()) {
    widenedStartMs = previousResolvedAt.getTime();
  }

  return new Date(widenedStartMs);
}
