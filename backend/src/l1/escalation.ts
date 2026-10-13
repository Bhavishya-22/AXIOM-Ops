import { CAUSES } from '../registry/causes.js';

export interface EscalationPacket {
  owningTeam: string;
  citedEvidenceIds: string[];
  candidateCauses: string[];
  separatingEvidence: string;
  dispositionReason: string;
  actionRecommended: string;
}

export function buildEscalationPacket(params: {
  rootCauses: string[];
  candidateCauses?: string[];
  evidenceSnapshotJson?: any;
  dispositionReason?: string | null;
  actionDisposition?: string | null;
}): EscalationPacket {
  const {
    rootCauses = [],
    candidateCauses = [],
    evidenceSnapshotJson = {},
    dispositionReason = 'manual_action_recommended',
  } = params;

  // Extract cited evidence IDs
  const citedEvidenceIds: string[] = [];
  if (evidenceSnapshotJson && Array.isArray(evidenceSnapshotJson.nodes)) {
    for (const node of evidenceSnapshotJson.nodes) {
      if (Array.isArray(node.logIds)) {
        citedEvidenceIds.push(...node.logIds.slice(0, 3));
      }
    }
  }

  // Derive owning team
  const primaryCause = rootCauses[0] || candidateCauses[0] || 'unknown';
  let owningTeam = 'core-infrastructure';

  if (primaryCause.includes('redis') || primaryCause.includes('cache')) {
    owningTeam = 'caching-and-data-storage';
  } else if (primaryCause.includes('db') || primaryCause.includes('pool')) {
    owningTeam = 'database-reliability';
  } else if (primaryCause.includes('deploy')) {
    owningTeam = 'release-engineering';
  } else if (primaryCause.includes('gateway') || primaryCause.includes('payment')) {
    owningTeam = 'payments-platform';
  } else if (primaryCause.includes('idp') || primaryCause.includes('auth')) {
    owningTeam = 'identity-and-access';
  }

  // Separating evidence
  const candidates = candidateCauses.length > 0 ? candidateCauses : rootCauses;
  let separatingEvidence = 'Examine raw service logs and counter deltas across downstream and upstream boundaries.';
  if (candidates.includes('redis_unavailable') && candidates.includes('db_pool_exhausted')) {
    separatingEvidence = 'Verify whether cache_fallback_to_db mechanism preceded pool exhaustion, and observe dbFallbackQueriesTotal counter delta >= 20.';
  } else if (candidates.includes('bad_deploy')) {
    separatingEvidence = 'Check schema compatibility flag and compare 5xx error rate between previous and active deployed versions.';
  } else if (candidates.includes('payment_gateway_down')) {
    separatingEvidence = 'Inspect gateway route 502/timeout latency buckets and secondary failover endpoint health.';
  }

  const causeDef = CAUSES[primaryCause];
  const actionRecommended = causeDef?.compatibleAction || 'manual_investigation_required';

  return {
    owningTeam,
    citedEvidenceIds: Array.from(new Set(citedEvidenceIds)).slice(0, 10),
    candidateCauses: candidates,
    separatingEvidence,
    dispositionReason: dispositionReason || 'manual_action_recommended',
    actionRecommended,
  };
}
