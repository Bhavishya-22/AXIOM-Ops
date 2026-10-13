import { prisma } from '../prisma.js';
import { SIGNAL_RULES } from '@axiomops/shared';

export type DuplicateLinkEvaluation = 'linked' | 'possible_duplicate' | 'none';

export async function evaluateDuplicateLinking(params: {
  ticketServices: string[];
  ticketCreatedAt: Date;
  ticketText: string;
  incidentId: string;
}): Promise<{ linkStatus: DuplicateLinkEvaluation; reason: string }> {
  const { ticketServices, ticketCreatedAt, ticketText, incidentId } = params;

  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      tickets: {
        include: {
          investigations: {
            where: { status: 'done' },
            orderBy: { investigationStartedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  if (!incident || incident.status !== 'open') {
    return { linkStatus: 'none', reason: 'No active open incident' };
  }

  // (1) Check services overlap from incident's linked tickets
  const incidentServices: string[] = Array.from(
    new Set(incident.tickets.flatMap((t) => t.services))
  );

  const servicesOverlap = ticketServices.some((s) => incidentServices.includes(s));
  if (!servicesOverlap) {
    return { linkStatus: 'possible_duplicate', reason: 'No overlapping services with active incident' };
  }

  // (2) Check ticket time is inside incident window
  const windowStart = incident.startedAt || incident.detectedAt;
  const windowEnd = incident.resolvedAt || new Date();

  const inWindow = ticketCreatedAt >= windowStart && ticketCreatedAt <= windowEnd;
  if (!inWindow) {
    return { linkStatus: 'possible_duplicate', reason: 'Ticket creation timestamp outside incident window' };
  }

  // (3) Check text or evidence matches incident's diagnostic or supporting signals
  const latestInvestigation = incident.tickets
    .flatMap((t) => t.investigations)
    .sort((a, b) => b.investigationStartedAt.getTime() - a.investigationStartedAt.getTime())[0];

  const diagnosticSignals: string[] = [];

  if (latestInvestigation && latestInvestigation.evidenceSnapshotJson) {
    const snapshot = latestInvestigation.evidenceSnapshotJson as any;
    if (Array.isArray(snapshot.compactNodes)) {
      for (const node of snapshot.compactNodes) {
        if (node.signal) diagnosticSignals.push(node.signal);
      }
    }
  }

  const textLower = ticketText.toLowerCase();
  let matchesSignal = false;

  // Check matching against signal rules patterns
  for (const [sig, rule] of Object.entries(SIGNAL_RULES)) {
    if (diagnosticSignals.includes(sig) || incidentServices.includes(rule.service)) {
      if (Array.isArray(rule.patterns) && rule.patterns.some((p) => p.test(textLower))) {
        matchesSignal = true;
        break;
      }
    }
  }

  // Direct keyword matching on known incident symptoms
  if (
    /redis|connection refused|cache miss|pool exhausted|timeout|gateway|502|idp|auth|jwks|version mismatch/i.test(
      textLower
    )
  ) {
    matchesSignal = true;
  }

  if (matchesSignal) {
    return {
      linkStatus: 'linked',
      reason: 'Conservative duplicate linking criteria met (service overlap, window match, signal match)',
    };
  }

  // If service and window overlap, but signature match does not hold -> possible_duplicate!
  return {
    linkStatus: 'possible_duplicate',
    reason: 'Overlaps service and window but signature does not decisively match',
  };
}
