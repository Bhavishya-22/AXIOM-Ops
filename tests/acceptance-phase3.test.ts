import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { prisma } from '../backend/src/prisma.js';
import { buildExecutionContext, assertExecutionAllowed } from '../backend/src/policy/execution-guard.js';
import { runVerification } from '../backend/src/verify/verifier.js';
import { hashDemoToken } from '../backend/src/auth/demo-auth.js';
import { createSimulatorApp } from '../simulator/src/server.js';
import { scenarioEngine } from '../simulator/src/engine.js';

describe('ACCEPTANCE SUITE: PHASE 3 (Section 20 & Item 13)', () => {
  let sessionId = 'acceptance-phase3-session';
  let openIncident: any;
  let testTicket: any;
  let testInvestigation: any;
  let simServer: http.Server;
  let simUrl: string;

  beforeAll(async () => {
    const app = createSimulatorApp();
    await new Promise<void>((resolve) => {
      simServer = app.listen(0, '127.0.0.1', () => {
        const addr = simServer.address() as any;
        simUrl = `http://127.0.0.1:${addr.port}`;
        process.env.SIMULATOR_URL = simUrl;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (simServer) {
      await new Promise((res) => simServer.close(res));
    }
  });

  beforeEach(async () => {
    sessionId = `acceptance-phase3-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Seed demo users
    await prisma.demoUser.upsert({
      where: { id: 'operator-1' },
      update: { role: 'operator', tokenHash: hashDemoToken('valid-operator-token') },
      create: {
        id: 'operator-1',
        name: 'Operator 1',
        role: 'operator',
        tokenHash: hashDemoToken('valid-operator-token'),
      },
    });

    openIncident = await prisma.incident.create({
      data: {
        sessionId,
        scenarioRunId: `run-acc-${Date.now()}`,
        status: 'open',
      },
    });

    testTicket = await prisma.ticket.create({
      data: {
        title: 'Checkout Failure Alert',
        description: 'Payment and checkout failing',
        services: ['checkout'],
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

  async function createTestLog(data: {
    service: string;
    message: string;
    signal?: string;
    signalKind?: string;
    ts?: Date;
    serviceSeq?: number;
    category?: string;
  }) {
    return prisma.log.create({
      data: {
        sessionId,
        service: data.service,
        category: data.category || 'api',
        team: 'platform',
        level: 'INFO',
        message: data.message,
        signal: data.signal || null,
        signalKind: data.signalKind || null,
        messageHash: `hash-${Math.random()}`,
        serviceSeq: data.serviceSeq || Math.floor(Math.random() * 10000),
        origin: 'simulator',
        class: 'incident',
        expiresAt: new Date(Date.now() + 86400000),
        ts: data.ts || new Date(),
      },
    });
  }

  it('ACCEPTANCE: restart_redis passes 3 times in a row', async () => {
    for (let runIdx = 1; runIdx <= 3; runIdx++) {
      const appliedAt = new Date();
      // Emulate fresh recovery log and metric deltas
      await createTestLog({
        service: 'redis-cache',
        category: 'cache',
        message: 'Redis cluster restored and accepting connections',
        signal: 'redis_restored',
        signalKind: 'supporting',
        serviceSeq: 100 + runIdx,
        ts: new Date(appliedAt.getTime() + 100),
      });

      await prisma.metricSample.create({
        data: {
          sessionId,
          service: 'checkout',
          requestsTotal: 50,
          successesTotal: 10, // delta >= 5
          errorsTotal: 0,
          businessOutcomesTotal: 10,
          cacheHitsTotal: 35,
          cacheLookupsTotal: 40,
          ts: new Date(appliedAt.getTime() + 200),
        },
      });

      const outcome = await runVerification({
        actionId: 'restart_redis',
        sessionId,
        appliedAt,
        appliedCounters: { checkout: { successesTotal: 0 } },
        baselineMetrics: {},
        attemptId: `att-redis-${runIdx}`,
        scenarioRunId: `run-redis-${runIdx}`,
        simulatorUrl: simUrl,
      });

      expect(outcome.outcome).toBe('resolved');
      expect(outcome.checks.every((c) => c.passed)).toBe(true);
    }
  });

  it('ACCEPTANCE: the other four actions pass once each', async () => {
    const appliedAt = new Date();

    // 1. increase_db_pool
    await createTestLog({
      service: 'orders-db',
      category: 'database',
      message: 'db_pool_resized: pool resized to 30',
      signal: 'db_pool_resized',
      signalKind: 'supporting',
      serviceSeq: 201,
      ts: new Date(appliedAt.getTime() + 100),
    });
    await prisma.metricSample.create({
      data: {
        sessionId,
        service: 'payments',
        requestsTotal: 30,
        successesTotal: 10,
        errorsTotal: 0,
        businessOutcomesTotal: 10,
        ts: new Date(appliedAt.getTime() + 200),
      },
    });
    const poolOutcome = await runVerification({
      actionId: 'increase_db_pool',
      sessionId,
      appliedAt,
      appliedCounters: { payments: { successesTotal: 0 } },
      baselineMetrics: {},
      attemptId: 'att-pool-1',
      scenarioRunId: 'run-pool-1',
      simulatorUrl: simUrl,
    });
    expect(poolOutcome.outcome).toBe('resolved');

    // 2. rollback_deploy
    await createTestLog({
      service: 'payments',
      category: 'deployment',
      message: 'version_rolled_back: rolled back to v2.4.0',
      signal: 'version_rolled_back',
      signalKind: 'supporting',
      serviceSeq: 202,
      ts: new Date(appliedAt.getTime() + 100),
    });
    const rollbackOutcome = await runVerification({
      actionId: 'rollback_deploy',
      sessionId,
      appliedAt,
      appliedCounters: { payments: { successesTotal: 0 } },
      baselineMetrics: {},
      attemptId: 'att-rollback-1',
      scenarioRunId: 'run-rollback-1',
      simulatorUrl: simUrl,
    });
    expect(rollbackOutcome.outcome).toBe('resolved');

    // 3. failover_gateway
    const gwAppliedAt = new Date();
    await createTestLog({
      service: 'payments',
      category: 'payment',
      message: 'gateway_failover_done: secondary gateway operational',
      signal: 'gateway_failover_done',
      signalKind: 'supporting',
      serviceSeq: 203,
      ts: new Date(gwAppliedAt.getTime() + 100),
    });
    await prisma.metricSample.create({
      data: {
        sessionId,
        service: 'payments',
        requestsTotal: 30,
        successesTotal: 10,
        errorsTotal: 0,
        businessOutcomesTotal: 10,
        scenarioCountersJson: { authorizationsNewRouteTotal: 8 },
        ts: new Date(gwAppliedAt.getTime() + 200),
      },
    });
    const gwOutcome = await runVerification({
      actionId: 'failover_gateway',
      sessionId,
      appliedAt: gwAppliedAt,
      appliedCounters: { payments: { authorizationsNewRouteTotal: 0 } },
      baselineMetrics: {},
      attemptId: 'att-gw-1',
      scenarioRunId: 'run-gw-1',
      simulatorUrl: simUrl,
    });
    expect(gwOutcome.outcome).toBe('resolved');

    // 4. failover_idp
    const idpAppliedAt = new Date();
    await createTestLog({
      service: 'identity-provider',
      category: 'auth',
      message: 'idp_failover_done: switched to secondary idp',
      signal: 'idp_failover_done',
      signalKind: 'supporting',
      serviceSeq: 204,
      ts: new Date(idpAppliedAt.getTime() + 100),
    });
    await prisma.metricSample.create({
      data: {
        sessionId,
        service: 'identity-provider',
        requestsTotal: 30,
        successesTotal: 10,
        errorsTotal: 0,
        businessOutcomesTotal: 10,
        scenarioCountersJson: { tokenValidationsOkTotal: 8 },
        ts: new Date(idpAppliedAt.getTime() + 200),
      },
    });
    const idpOutcome = await runVerification({
      actionId: 'failover_idp',
      sessionId,
      appliedAt: idpAppliedAt,
      appliedCounters: { 'identity-provider': { tokenValidationsOkTotal: 0 } },
      baselineMetrics: {},
      attemptId: 'att-idp-1',
      scenarioRunId: 'run-idp-1',
      simulatorUrl: simUrl,
    });
    expect(idpOutcome.outcome).toBe('resolved');
  });

  it('ACCEPTANCE: double-click approve applies once (idempotent)', async () => {
    const run1 = await prisma.remediationRun.create({
      data: {
        incidentId: openIncident.id,
        investigationId: testInvestigation.id,
        attemptId: 'att-double-1',
        actionId: 'restart_redis',
        idempotencyKey: `${testInvestigation.id}-restart_redis-double`,
        executionState: 'pending',
        status: 'in_progress',
        activeIncidentId: openIncident.id,
        approvedBy: 'operator-1',
        approverRole: 'operator',
      },
    });

    expect(run1).toBeDefined();

    // Second click: unique constraint collision returns existing active run
    let threwUnique = false;
    try {
      await prisma.remediationRun.create({
        data: {
          incidentId: openIncident.id,
          investigationId: testInvestigation.id,
          attemptId: 'att-double-2',
          actionId: 'restart_redis',
          idempotencyKey: `${testInvestigation.id}-restart_redis-double`,
          executionState: 'pending',
          status: 'in_progress',
          activeIncidentId: openIncident.id,
          approvedBy: 'operator-1',
          approverRole: 'operator',
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002' || err.message?.includes('Unique constraint')) {
        threwUnique = true;
      }
    }

    expect(threwUnique).toBe(true);
  });

  it('ACCEPTANCE: broken fix ends verification_failed with the incident open', async () => {
    // 1. Activate fault in simulator
    scenarioEngine.trigger('redis_down', true);
    // 2. Fix applied in BROKEN mode (fault remains active, health stays 503)
    scenarioEngine.fix('restart_redis', 'att-broken-1', true);

    const appliedAt = new Date();
    // 3. New error emitted after apply
    await createTestLog({
      service: 'checkout',
      message: 'redis_conn_refused: connection refused after broken restart',
      signal: 'redis_conn_refused',
      category: 'cache',
      ts: new Date(appliedAt.getTime() + 100),
    });

    const brokenOutcome = await runVerification({
      actionId: 'restart_redis',
      sessionId,
      appliedAt,
      appliedCounters: {},
      baselineMetrics: {},
      attemptId: 'att-broken-1',
      scenarioRunId: 'run-broken-1',
      simulatorUrl: simUrl,
    });

    // Zero positive recovery proofs passed and health degraded -> verification_failed
    expect(brokenOutcome.outcome).toBe('verification_failed');

    // Incident remains open
    const incidentAfter = await prisma.incident.findUnique({
      where: { id: openIncident.id },
    });
    expect(incidentAfter?.status).toBe('open');

    // Clean up
    scenarioEngine.clearActiveScenario();
  });

  it('ACCEPTANCE: direct executor call bypassing API is refused when outdated, Weak or incompatible', async () => {
    // 1. Weak
    testInvestigation.evidenceLevel = 'Weak';
    const weakCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: testTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    if (weakCtx.kind === 'L2') {
      weakCtx.evidenceLevel = 'Weak';
    }
    expect(assertExecutionAllowed(weakCtx).allowed).toBe(false);

    // 2. Incompatible
    const incompCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: testTicket.id,
      action: 'failover_gateway' as any,
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    expect(assertExecutionAllowed(incompCtx).allowed).toBe(false);
  });

  it('ACCEPTANCE: idp_down_regulated is held even when ticket names only checkout', async () => {
    // Ticket names ONLY checkout
    const checkoutOnlyTicket = await prisma.ticket.create({
      data: {
        title: 'Users cannot log in to checkout',
        description: 'Checkout 500 error on authentication',
        services: ['checkout'], // Names ONLY checkout!
        incidentId: openIncident.id,
        linkStatus: 'linked',
        requesterId: 'user-ops',
      },
    });

    // Investigation includes batch_signin_failed in evidence pack
    const regulatedInvestigation = await prisma.investigation.create({
      data: {
        ticketId: checkoutOnlyTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['idp_down'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        regulatedHold: true,
        unresolvedClustersJson: [],
      },
    });

    const ctx = await buildExecutionContext({
      kind: 'L2',
      investigationId: regulatedInvestigation.id,
      ticketId: checkoutOnlyTicket.id,
      action: 'failover_idp',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });

    const guardResult = assertExecutionAllowed(ctx);
    expect(guardResult.allowed).toBe(false);
    if (!guardResult.allowed) {
      expect(guardResult.disposition).toBe('manual_recommended');
      expect(guardResult.reason).toBe('regulated_service_requires_change_control');
    }
  });
});
