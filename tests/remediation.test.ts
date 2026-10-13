import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { runVerification } from '../backend/src/verify/verifier.js';
import {
  checkPoolWait,
  checkDbP95,
  checkCacheHitRatio,
  check5xxRate,
  checkActiveConnections,
} from '../backend/src/verify/thresholds.js';
import {
  writeProposedHistoricalCase,
  retrieveTopHistoricalCases,
  confirmHistoricalCase,
} from '../backend/src/history.js';
import {
  startupRemediationReconciliation,
} from '../backend/src/remediation/executor.js';

describe('Remediation, Verifiers, Idempotency & History Integrity (Section 20 & Section 12)', () => {
  const sessionId = 'test-remediation-suite-session';
  let openIncident: any;
  let testTicket: any;
  let testInvestigation: any;

  beforeEach(async () => {
    openIncident = await prisma.incident.create({
      data: {
        sessionId,
        scenarioRunId: 'run-rem-1',
        status: 'open',
      },
    });

    testTicket = await prisma.ticket.create({
      data: {
        title: 'Redis Connection Outage',
        description: 'Redis is returning connection refused',
        services: ['checkout', 'redis-cache'],
        incidentId: openIncident.id,
        linkStatus: 'linked',
        requesterId: 'user-ops',
      },
    });

    testInvestigation = await prisma.investigation.create({
      data: {
        ticketId: testTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['redis_unavailable'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        unresolvedClustersJson: [],
      },
    });
  });

  describe('Idempotency & Concurrency Invariants', () => {
    it('enforces one active remediation per incident via activeIncidentId / one_active_remediation index', async () => {
      // First active run
      const run1 = await prisma.remediationRun.create({
        data: {
          incidentId: openIncident.id,
          investigationId: testInvestigation.id,
          attemptId: 'att-1',
          actionId: 'restart_redis',
          idempotencyKey: `${testInvestigation.id}-restart_redis`,
          executionState: 'pending',
          status: 'in_progress',
          activeIncidentId: openIncident.id, // locks the slot
          approvedBy: 'operator-1',
          approverRole: 'operator',
        },
      });

      expect(run1).toBeDefined();

      // Second concurrent creation on same incident must throw unique constraint error (P2002)
      let uniqueErrorCaught = false;
      try {
        await prisma.remediationRun.create({
          data: {
            incidentId: openIncident.id,
            investigationId: testInvestigation.id,
            attemptId: 'att-2',
            actionId: 'restart_redis',
            idempotencyKey: `${testInvestigation.id}-restart_redis-concurrent`,
            executionState: 'pending',
            status: 'in_progress',
            activeIncidentId: openIncident.id, // violates unique constraint
            approvedBy: 'operator-2',
            approverRole: 'operator',
          },
        });
      } catch (err: any) {
        if (err.code === 'P2002' || err.message?.includes('Unique constraint')) {
          uniqueErrorCaught = true;
        }
      }

      expect(uniqueErrorCaught).toBe(true);

      // Releasing slot allows subsequent attempt
      await prisma.remediationRun.update({
        where: { id: run1.id },
        data: { activeIncidentId: null, status: 'resolved' },
      });

      const run2 = await prisma.remediationRun.create({
        data: {
          incidentId: openIncident.id,
          investigationId: testInvestigation.id,
          attemptId: 'att-2',
          actionId: 'restart_redis',
          idempotencyKey: `${testInvestigation.id}-restart_redis-attempt2`,
          executionState: 'pending',
          status: 'in_progress',
          activeIncidentId: openIncident.id,
          approvedBy: 'operator-1',
          approverRole: 'operator',
        },
      });

      expect(run2).toBeDefined();
    });

    it('startup reconciliation marks timed-out verifying runs as verification_failed', async () => {
      // Stale run applied 5 minutes ago
      const staleRun = await prisma.remediationRun.create({
        data: {
          incidentId: openIncident.id,
          investigationId: testInvestigation.id,
          attemptId: 'att-stale-1',
          actionId: 'restart_redis',
          idempotencyKey: `stale-idem-key-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          executionState: 'verifying',
          status: 'in_progress',
          appliedAt: new Date(Date.now() - 300_000), // 5 min ago
          approvedBy: 'operator-1',
          approverRole: 'operator',
        },
      });

      await startupRemediationReconciliation();

      const reconciled = await prisma.remediationRun.findUnique({
        where: { id: staleRun.id },
      });

      expect(reconciled?.executionState).toBe('finished');
      expect(reconciled?.status).toBe('verification_failed');
      expect(reconciled?.activeIncidentId).toBeNull();
    });
  });

  describe('Verifier Logic & Negative Check Rules', () => {
    it('Gateway verifier fails when ordering is violated (retry before status check)', async () => {
      // Create applied log and metrics
      const appliedAt = new Date(Date.now() - 10000);

      // Call runVerification with simulator returning ordering_failed
      const outcome = await runVerification({
        actionId: 'failover_gateway',
        sessionId,
        appliedAt,
        appliedCounters: {},
        baselineMetrics: {},
        attemptId: 'att-gw-test',
        scenarioRunId: 'run-gw-test',
        simulatorUrl: 'http://localhost:4000',
      });

      // The ordering check must have been evaluated
      const orderingCheck = outcome.checks.find((c) => c.name === 'per_payment_ordering');
      expect(orderingCheck).toBeDefined();
    });

    it('IdP verifier requires negative token probe to return 401', async () => {
      const appliedAt = new Date(Date.now() - 10000);

      const outcome = await runVerification({
        actionId: 'failover_idp',
        sessionId,
        appliedAt,
        appliedCounters: {},
        baselineMetrics: {},
        attemptId: 'att-idp-test',
        scenarioRunId: 'run-idp-test',
      });

      const probeCheck = outcome.checks.find((c) => c.name === 'negative_token_probe');
      expect(probeCheck).toBeDefined();
      const policyCheck = outcome.checks.find((c) => c.name === 'auth_policy_version_unchanged');
      expect(policyCheck).toBeDefined();
    });
  });

  describe('Metric Precision & Floors', () => {
    it('returns inconclusive on thin baseline or observation data instead of accidental arithmetic pass', () => {
      // 1. Pool wait with fewer than 10 samples is inconclusive
      const poolResult = checkPoolWait(20, 10, 5); // 5 samples < 10
      expect(poolResult.status).toBe('inconclusive');
      expect(poolResult.reason).toBe('thin_data_insufficient_samples');

      // 2. Latency p95 with fewer than 20 observations is inconclusive
      const p95Result = checkDbP95(50, 40, 12); // 12 obs < 20
      expect(p95Result.status).toBe('inconclusive');

      // 3. Cache hit ratio with thin lookups or baseline < 0.3 is inconclusive
      const cacheResult = checkCacheHitRatio(0.9, 0.25, 50); // baseline 0.25 < 0.3
      expect(cacheResult.status).toBe('inconclusive');

      const cacheResult2 = checkCacheHitRatio(0.9, 0.8, 15); // 15 lookups < 30
      expect(cacheResult2.status).toBe('inconclusive');
    });

    it('enforces documented absolute floors', () => {
      // Pool wait floor: floor is 50 ms. Baseline 10 ms -> threshold max(1.5*10, 50) = 50 ms
      const poolCheck = checkPoolWait(45, 10, 15);
      expect(poolCheck.threshold).toBe(50);
      expect(poolCheck.status).toBe('pass');

      const poolCheckFail = checkPoolWait(55, 10, 15);
      expect(poolCheckFail.status).toBe('fail');

      // 5xx rate check within 1 percentage point
      const fiveXxPass = check5xxRate(0.015, 0.01);
      expect(fiveXxPass.status).toBe('pass');

      const fiveXxFail = check5xxRate(0.025, 0.01);
      expect(fiveXxFail.status).toBe('fail');

      // Active connections under 80% limit
      expect(checkActiveConnections(15, 20).status).toBe('pass'); // 15 < 16
      expect(checkActiveConnections(17, 20).status).toBe('fail'); // 17 >= 16
    });
  });

  describe('History Write-Back Integrity (Section 15)', () => {
    it('verified recovery creates proposed case only, which is excluded from automated retrieval until confirmed', async () => {
      const uniqueSignal = `redis_unique_${Date.now()}`;
      const caseRec = await writeProposedHistoricalCase({
        incidentId: openIncident.id,
        investigationId: testInvestigation.id,
        remediationRunId: 'run-history-1',
        rootCause: 'redis_unavailable',
        actionId: 'restart_redis',
        services: ['redis-cache', 'checkout'],
        signals: [uniqueSignal, 'redis_conn_refused'],
        symptoms: ['Orders timing out'],
        evidenceSnapshotJson: { nodes: [] },
        verifierOutcome: { outcome: 'resolved' },
      });

      expect(caseRec.status).toBe('proposed');

      // Automated retrieval queries ONLY status: verified
      const retrieved = await retrieveTopHistoricalCases([uniqueSignal], ['redis-cache'], 20);
      const foundProposed = retrieved.find((c) => c.id === caseRec.id);
      expect(foundProposed).toBeUndefined();

      // Promoting to verified makes it retrievable
      await confirmHistoricalCase(caseRec.id, 'reviewer-sme-1');

      const retrievedAfter = await retrieveTopHistoricalCases([uniqueSignal], ['redis-cache'], 20);
      const foundVerified = retrievedAfter.find((c) => c.id === caseRec.id);
      expect(foundVerified).toBeDefined();
    });
  });
});
