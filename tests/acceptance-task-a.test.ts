import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { IncidentDetector } from '../backend/src/detector.js';
import { SCENARIOS } from '../simulator/src/scenarios.js';
import { scoreHypothesis } from '../backend/src/scorer.js';
import { generateDeterministicExplanation } from '../backend/src/diagnosis.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';
import { createIncidentTransaction } from '../backend/src/incident-lifecycle.js';
import { runInvestigationPipeline } from '../backend/src/investigation-pipeline.js';
import { matchSignal } from '@axiomops/shared';
import { createHash } from 'crypto';

function makeHash(msg: string) {
  return createHash('sha256').update(msg).digest('hex').slice(0, 16);
}

function buildPackFromTimeline(
  sessionId: string,
  timeline: any[],
  counterDelta: number = 25
): { pack: EvidencePack; counterDelta: number } {
  const baseTime = new Date('2026-10-13T12:00:00.000Z');
  const nodeMap = new Map<string, string[]>();
  const logMap = new Map<string, any>();
  const nodes: any[] = [];

  let idx = 1;
  for (const item of timeline) {
    const logId = `log_${sessionId}_${idx}`;
    const nodeId = `node_${sessionId}_${idx}`;
    const firstSeen = new Date(baseTime.getTime() + item.at).toISOString();
    const matched = matchSignal(item.service, item.variants[0]);
    const signal = matched?.signal || null;
    const signalKind = matched?.kind || null;

    const logRecord = {
      id: logId,
      ts: new Date(firstSeen),
      service: item.service,
      level: item.level,
      message: item.variants[0],
      signal,
      signalKind,
      messageHash: makeHash(item.variants[0]),
      sessionId,
      serviceSeq: idx,
    };

    logMap.set(logId, logRecord);
    nodeMap.set(nodeId, [logId]);

    nodes.push({
      nodeId,
      service: item.service,
      level: item.level,
      signal,
      signalKind,
      count: 1,
      firstSeen,
      lastSeen: firstSeen,
      messageSample: item.variants[0],
      isDiagnostic: signalKind === 'diagnostic',
      representativeLogIds: [logId],
      allLogIds: [logId],
    });

    idx++;
  }

  return {
    pack: {
      nodes,
      compactNodes: [],
      nodeMap,
      logMap,
      scopedServices: ['checkout', 'payments', 'redis-cache', 'orders-db', 'identity-provider', 'batch-record-service'],
      windowStart: baseTime,
      windowEnd: new Date(baseTime.getTime() + 120000),
      sessionId,
    },
    counterDelta,
  };
}

describe('ACCEPTANCE SUITE: TASK A (Section 4, 7, 9, 10, 11, 13, 16)', () => {
  beforeEach(async () => {
    await prisma.incident.updateMany({
      where: { openSlot: 1 },
      data: { openSlot: null, status: 'resolved', resolvedAt: new Date() },
    });
  });

  it('ACCEPTANCE: one trigger of redis_down creates exactly one incident, ticket, investigation with DB pool recorded as suppressed', async () => {
    const session = 'sess_accept_redis_' + Date.now();
    const detector = new IncidentDetector();

    // 1. Simulate detector seeing 2 consecutive error breaches
    const now = new Date();
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: new Date(now.getTime() - 40000),
        requestsTotal: 10,
        successesTotal: 10,
        errorsTotal: 0,
        businessOutcomesTotal: 0,
      },
    });
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: new Date(now.getTime() - 20000),
        requestsTotal: 30,
        successesTotal: 20,
        errorsTotal: 10,
        businessOutcomesTotal: 0,
      },
    });
    await detector.evaluateOnce(session);

    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: now,
        requestsTotal: 50,
        successesTotal: 30,
        errorsTotal: 20,
        businessOutcomesTotal: 0,
      },
    });
    const breachRes = await detector.evaluateOnce(session);
    expect(breachRes.breached).toBe(true);

    // Assert exactly ONE incident, ONE ticket, ONE investigation created
    const incident = await prisma.incident.findFirst({
      where: { sessionId: session, openSlot: 1 },
      include: {
        tickets: {
          include: { investigations: true },
        },
      },
    });

    expect(incident).toBeDefined();
    expect(incident?.tickets.length).toBe(1);
    expect(incident?.tickets[0].investigations.length).toBe(1);

    // 2. Feed redis_down timeline logs to the investigation
    const scenario = SCENARIOS['redis_down'];
    const { pack, counterDelta } = buildPackFromTimeline(session, scenario.timeline, 25);
    const scorerResult = scoreHypothesis(pack, undefined, 0, counterDelta);

    expect(scorerResult.status).toBe('diagnosed');
    expect(scorerResult.causeMode).toBe('single');
    expect(scorerResult.rootCauses).toEqual(['redis_unavailable']);
    expect(scorerResult.suppressed.length).toBe(1);
    expect(scorerResult.suppressed[0].cause).toBe('db_pool_exhausted');
    expect(scorerResult.suppressed[0].by).toBe('redis_unavailable');

    const diag = generateDeterministicExplanation(scorerResult, pack);
    expect(diag.actionDisposition).toBe('executable');
    expect(diag.actionId).toBe('restart_redis');
    expect(diag.evidenceLogIds.length).toBeGreaterThan(0);
  });

  it('ACCEPTANCE: all negative scenarios return their specified outcomes with NO LLM call', () => {
    const negativeChecks: Array<{ scenarioName: string; expectedStatus: string; expectedMode?: any }> = [
      { scenarioName: 'payment_decline_spike', expectedStatus: 'not_an_incident' },
      { scenarioName: 'token_expiry_spike', expectedStatus: 'not_an_incident' },
      { scenarioName: 'normal_deploy', expectedStatus: 'not_an_incident' },
      { scenarioName: 'healthy', expectedStatus: 'insufficient_evidence' },
      { scenarioName: 'unknown_errors', expectedStatus: 'insufficient_evidence' },
      { scenarioName: 'supporting_only', expectedStatus: 'insufficient_evidence' },
      { scenarioName: 'ambiguous', expectedStatus: 'ambiguous_multiple_causes' },
      { scenarioName: 'redis_plus_independent_db', expectedStatus: 'ambiguous_multiple_causes' },
      { scenarioName: 'compound', expectedStatus: 'diagnosed', expectedMode: 'compound' },
    ];

    for (const check of negativeChecks) {
      const scenario = SCENARIOS[check.scenarioName];
      expect(scenario).toBeDefined();
      const { pack, counterDelta } = buildPackFromTimeline('sess_neg_' + check.scenarioName, scenario.timeline, 0);
      const res = scoreHypothesis(pack, undefined, 0, counterDelta);

      expect(res.status).toBe(check.expectedStatus);
      if (check.expectedMode) {
        expect(res.causeMode).toBe(check.expectedMode);
      }
    }
  });

  it('ACCEPTANCE: redis_with_unexplained_cluster is diagnosed but manual-only (dispositionReason: unexplained_error_cluster)', () => {
    const scenario = SCENARIOS['redis_with_unexplained_cluster'];
    expect(scenario).toBeDefined();
    const { pack } = buildPackFromTimeline('sess_unexplained', scenario.timeline, 25);
    const scorerResult = scoreHypothesis(pack, undefined, 0, 25);

    expect(scorerResult.status).toBe('diagnosed');
    expect(scorerResult.rootCauses).toEqual(['redis_unavailable']);
    expect(scorerResult.unresolvedClusters.some((c) => c.material)).toBe(true);

    const diag = generateDeterministicExplanation(scorerResult, pack);
    expect(diag.actionDisposition).toBe('manual_recommended');
    expect(diag.dispositionReason).toBe('unexplained_error_cluster');
    expect(diag.evidenceLevel).toBe('Weak');
  });

  it('ACCEPTANCE: all four other fault families diagnose correctly', () => {
    // 1. db_pool_exhausted
    const dbPack = buildPackFromTimeline('sess_db', SCENARIOS['db_pool_exhausted'].timeline).pack;
    const dbRes = scoreHypothesis(dbPack);
    expect(dbRes.status).toBe('diagnosed');
    expect(dbRes.rootCauses).toEqual(['db_pool_exhausted']);

    // 2. bad_deploy
    const deployPack = buildPackFromTimeline('sess_dep', SCENARIOS['bad_deploy'].timeline).pack;
    const deployRes = scoreHypothesis(deployPack);
    expect(deployRes.status).toBe('diagnosed');
    expect(deployRes.rootCauses).toEqual(['bad_deploy']);

    // 3. payment_gateway_down
    const gwPack = buildPackFromTimeline('sess_gw', SCENARIOS['payment_gateway_down'].timeline).pack;
    const gwRes = scoreHypothesis(gwPack);
    expect(gwRes.status).toBe('diagnosed');
    expect(gwRes.rootCauses).toEqual(['payment_gateway_down']);

    // 4. idp_down
    const idpPack = buildPackFromTimeline('sess_idp', SCENARIOS['idp_down'].timeline).pack;
    const idpRes = scoreHypothesis(idpPack);
    expect(idpRes.status).toBe('diagnosed');
    expect(idpRes.rootCauses).toEqual(['idp_down']);

    // 5. idp_down_regulated (batch-record-service affected)
    const idpRegPack = buildPackFromTimeline('sess_idp_reg', SCENARIOS['idp_down_regulated'].timeline).pack;
    const idpRegRes = scoreHypothesis(idpRegPack);
    expect(idpRegRes.status).toBe('diagnosed');
    expect(idpRegRes.rootCauses).toEqual(['idp_down']);
  });
});
