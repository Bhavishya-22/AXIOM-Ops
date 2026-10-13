import { prisma } from './prisma.js';

export interface ScoredHistoricalCase {
  id: string;
  title: string;
  rootCause: string;
  actionId: string;
  resolutionSteps: string[];
  signals: string[];
  services: string[];
  overlapScore: number;
}

export const SEED_CASES = [
  {
    id: 'case_redis_cache_node_failure',
    title: 'Redis Cache Node Connection Refused',
    symptoms: ['High cache miss rate', 'Downstream 503 errors on checkout'],
    signals: ['redis_conn_refused', 'cache_miss_spike', 'checkout_5xx'],
    services: ['redis-cache', 'checkout', 'payments'],
    categories: ['cache', 'api'],
    rootCause: 'redis_unavailable',
    resolutionSteps: ['Restart redis cluster node', 'Verify cache hit ratio returns to baseline'],
    actionId: 'restart_redis',
    status: 'verified',
  },
  {
    id: 'case_orders_db_pool_exhaustion',
    title: 'Database Connection Pool Exhaustion on Orders DB',
    symptoms: ['Connection wait latency high', 'Order checkout timeouts'],
    signals: ['db_pool_exhausted', 'db_slow_query', 'payment_timeout'],
    services: ['orders-db', 'payments'],
    categories: ['database', 'payment'],
    rootCause: 'db_pool_exhausted',
    resolutionSteps: ['Increase database max connection pool size', 'Monitor active connections'],
    actionId: 'increase_db_pool',
    status: 'verified',
  },
  {
    id: 'case_bad_deploy_payments_schema',
    title: 'Bad Deployment Payload Schema Incompatibility',
    symptoms: ['Validation errors on payment intents after release v2.4.1'],
    signals: ['version_changed', 'validation_error_spike', 'payments_5xx'],
    services: ['payments'],
    categories: ['payment'],
    rootCause: 'bad_deploy',
    resolutionSteps: ['Rollback payments deployment to previous schema-compatible release v2.4.0'],
    actionId: 'rollback_deploy',
    status: 'verified',
  },
  {
    id: 'case_payment_gateway_upstream_502',
    title: 'External Payment Gateway Outage',
    symptoms: ['502 Bad Gateway from payment partner', 'Checkout timeout spikes'],
    signals: ['gateway_unreachable', 'gateway_latency_high', 'payment_timeout'],
    services: ['payments', 'payment-gateway'],
    categories: ['payment', 'external'],
    rootCause: 'payment_gateway_down',
    resolutionSteps: ['Initiate automated failover to secondary payment gateway route'],
    actionId: 'failover_gateway',
    status: 'verified',
  },
  {
    id: 'case_idp_jwks_unreachable',
    title: 'Identity Provider JWKS Endpoint Unreachable',
    symptoms: ['Token validation failures across API gateways'],
    signals: ['idp_unreachable', 'auth_upstream_error', 'checkout_5xx'],
    services: ['identity-provider', 'checkout'],
    categories: ['auth', 'api'],
    rootCause: 'idp_down',
    resolutionSteps: ['Failover authentication traffic to secondary identity provider'],
    actionId: 'failover_idp',
    status: 'verified',
  },
  // Distractor / proposed case (must NEVER be retrieved because status is proposed)
  {
    id: 'case_unverified_proposed_distractor',
    title: 'Unverified Proposed Distractor Case',
    symptoms: ['Intermittent timeout'],
    signals: ['redis_conn_refused', 'payment_timeout'],
    services: ['redis-cache', 'payments'],
    categories: ['cache'],
    rootCause: 'redis_unavailable',
    resolutionSteps: ['Untested experimental fix'],
    actionId: 'restart_redis',
    status: 'proposed',
  },
];

export async function seedHistoricalCases(): Promise<void> {
  for (const c of SEED_CASES) {
    await prisma.historicalCase.upsert({
      where: { id: c.id },
      update: { ...c },
      create: { ...c },
    });
  }
}

/**
 * Retrieves top-3 verified historical cases based on signal and service overlap.
 * Proposed cases are strictly excluded from retrieval.
 */
export async function retrieveTopHistoricalCases(
  signals: string[],
  services: string[],
  topN: number = 3
): Promise<ScoredHistoricalCase[]> {
  // Only query VERIFIED cases
  const verifiedCases = await prisma.historicalCase.findMany({
    where: {
      status: 'verified',
    },
  });

  const scored: ScoredHistoricalCase[] = [];

  for (const c of verifiedCases) {
    const signalMatches = c.signals.filter((s) => signals.includes(s)).length;
    const serviceMatches = c.services.filter((s) => services.includes(s)).length;
    const score = signalMatches * 2 + serviceMatches;

    if (score > 0) {
      scored.push({
        id: c.id,
        title: c.title,
        rootCause: c.rootCause,
        actionId: c.actionId,
        resolutionSteps: c.resolutionSteps,
        signals: c.signals,
        services: c.services,
        overlapScore: score,
      });
    }
  }

  scored.sort((a, b) => b.overlapScore - a.overlapScore);
  return scored.slice(0, topN);
}

/**
 * Saves a verified recovery as a proposed HistoricalCase per Section 15.
 * It is proposed only, and retrievable only after reviewer confirmation.
 */
export async function writeProposedHistoricalCase(params: {
  incidentId: string;
  investigationId: string;
  remediationRunId: string;
  rootCause: string;
  actionId: string;
  services: string[];
  signals: string[];
  symptoms: string[];
  evidenceSnapshotJson?: any;
  verifierOutcome?: any;
}) {
  const { createHash } = await import('crypto');
  const evidenceHash = createHash('sha256')
    .update(JSON.stringify(params.evidenceSnapshotJson || {}))
    .digest('hex');

  return prisma.historicalCase.create({
    data: {
      title: `Recovered Incident ${params.incidentId} - ${params.rootCause}`,
      symptoms: params.symptoms,
      signals: params.signals,
      services: params.services,
      categories: ['incident_recovery'],
      rootCause: params.rootCause,
      actionId: params.actionId,
      resolutionSteps: [`Executed action ${params.actionId} with verified recovery`],
      status: 'proposed', // Proposed only! Not retrievable by retrieveTopHistoricalCases
      evidenceHash,
      provenanceJson: {
        incidentId: params.incidentId,
        investigationId: params.investigationId,
        remediationRunId: params.remediationRunId,
        verifierOutcome: params.verifierOutcome,
        proposedAt: new Date(),
      },
    },
  });
}

/**
 * Promotes a proposed case to verified status after reviewer confirmation.
 */
export async function confirmHistoricalCase(caseId: string, reviewerId: string) {
  return prisma.historicalCase.update({
    where: { id: caseId },
    data: {
      status: 'verified',
      provenanceJson: {
        reviewerId,
        confirmedAt: new Date(),
      },
    },
  });
}

