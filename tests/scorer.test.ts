import { describe, it, expect } from 'vitest';
import { scoreHypothesis } from '../backend/src/scorer.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';
import { CAUSES } from '../backend/src/registry/causes.js';

function mockPack(nodes: any[]): EvidencePack {
  return {
    nodes,
    compactNodes: [],
    nodeMap: new Map(),
    logMap: new Map(),
    scopedServices: ['checkout', 'payments', 'redis-cache', 'orders-db', 'identity-provider'],
    windowStart: new Date('2026-10-13T12:00:00Z'),
    windowEnd: new Date('2026-10-13T12:05:00Z'),
    sessionId: 'test_scorer_sess',
  };
}

describe('Hypothesis Scorer: Classification Rules (Section 20 & Section 7)', () => {
  it('classifies empty signal set as insufficient_evidence', () => {
    const pack = mockPack([]);
    const res = scoreHypothesis(pack);
    expect(res.classification).toBe('incident');
    expect(res.status).toBe('insufficient_evidence');
  });

  it('classifies benign-only signals as not_an_incident', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'payment_declined',
        signalKind: 'benign',
        count: 10,
        firstSeen: '2026-10-13T12:01:00Z',
        lastSeen: '2026-10-13T12:02:00Z',
        messageSample: 'card declined by issuer',
        isDiagnostic: false,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
    ]);
    const res = scoreHypothesis(pack);
    expect(res.classification).toBe('not_an_incident');
    expect(res.status).toBe('not_an_incident');
    expect(res.reason).toBe('benign_business_outcomes_only');
  });

  it('classifies normal deploy (version_changed + deploy_health_ok, no errors) as not_an_incident', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'version_changed',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:10Z',
        lastSeen: '2026-10-13T12:00:10Z',
        messageSample: 'deployed v2.4.1',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'payments',
        level: 'INFO',
        signal: 'deploy_health_ok',
        signalKind: 'health',
        count: 4,
        firstSeen: '2026-10-13T12:00:30Z',
        lastSeen: '2026-10-13T12:02:30Z',
        messageSample: 'post-deploy check ok',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);
    const res = scoreHypothesis(pack);
    expect(res.classification).toBe('not_an_incident');
    expect(res.status).toBe('not_an_incident');
    expect(res.reason).toBe('normal_deploy_verified');
  });

  it('classifies version_changed with open observation window and no errors as insufficient_evidence', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'version_changed',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:10Z',
        lastSeen: '2026-10-13T12:00:10Z',
        messageSample: 'deployed v2.4.1',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
    ]);
    const res = scoreHypothesis(pack);
    expect(res.classification).toBe('incident');
    expect(res.status).toBe('insufficient_evidence');
    expect(res.reason).toBe('version_changed_observation_window_open');
  });

  it('classifies supporting-only signals (5xx and timeouts, no diagnostic signal) as insufficient_evidence', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'checkout',
        level: 'ERROR',
        signal: 'checkout_5xx',
        signalKind: 'supporting',
        count: 15,
        firstSeen: '2026-10-13T12:01:00Z',
        lastSeen: '2026-10-13T12:02:00Z',
        messageSample: 'status 503',
        isDiagnostic: false,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'payments',
        level: 'ERROR',
        signal: 'payment_timeout',
        signalKind: 'supporting',
        count: 8,
        firstSeen: '2026-10-13T12:01:10Z',
        lastSeen: '2026-10-13T12:02:10Z',
        messageSample: 'upstream timeout',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);
    const res = scoreHypothesis(pack);
    expect(res.classification).toBe('incident');
    expect(res.status).toBe('insufficient_evidence');
    expect(res.reason).toBe('supporting_signals_only_no_diagnostic');
  });
});

describe('Hypothesis Scorer: Cascade Collapse & Mechanisms (Section 20 & Section 7)', () => {
  it('collapses DB pool cascade to Redis when fallback event and counter delta >= 20 are present and ordered', () => {
    const pack = mockPack([
      // Redis fault at t=0
      {
        nodeId: 'n_redis',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:30.000Z',
        messageSample: 'connection refused to cache node',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // Mechanism: cache_fallback_to_db at t=3s
      {
        nodeId: 'n_fallback',
        service: 'orders-db',
        level: 'WARN',
        signal: 'cache_fallback_to_db',
        signalKind: 'supporting',
        count: 10,
        firstSeen: '2026-10-13T12:00:03.000Z',
        lastSeen: '2026-10-13T12:00:15.000Z',
        messageSample: 'cache fallback: serving reads from db',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
      // Cascade symptom: db_pool_exhausted at t=6s
      {
        nodeId: 'n_db',
        service: 'orders-db',
        level: 'ERROR',
        signal: 'db_pool_exhausted',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:06.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'pool exhausted',
        isDiagnostic: true,
        representativeLogIds: ['l3'],
        allLogIds: ['l3'],
      },
    ]);

    // Delta = 25 (>= 20)
    const res = scoreHypothesis(pack, CAUSES, 0, 25);
    expect(res.status).toBe('diagnosed');
    expect(res.causeMode).toBe('single');
    expect(res.rootCauses).toEqual(['redis_unavailable']);
    expect(res.suppressed.length).toBe(1);
    expect(res.suppressed[0].cause).toBe('db_pool_exhausted');
    expect(res.suppressed[0].by).toBe('redis_unavailable');
  });

  it('does NOT collapse when fallback counter delta < 20, returning ambiguous_multiple_causes', () => {
    const pack = mockPack([
      {
        nodeId: 'n_redis',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:30.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n_fallback',
        service: 'orders-db',
        level: 'WARN',
        signal: 'cache_fallback_to_db',
        signalKind: 'supporting',
        count: 10,
        firstSeen: '2026-10-13T12:00:03.000Z',
        lastSeen: '2026-10-13T12:00:15.000Z',
        messageSample: 'cache fallback',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
      {
        nodeId: 'n_db',
        service: 'orders-db',
        level: 'ERROR',
        signal: 'db_pool_exhausted',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:06.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'pool exhausted',
        isDiagnostic: true,
        representativeLogIds: ['l3'],
        allLogIds: ['l3'],
      },
    ]);

    // Counter delta is only 15 (< 20)
    const res = scoreHypothesis(pack, CAUSES, 0, 15);
    expect(res.status).toBe('ambiguous_multiple_causes');
    expect(res.shortlist).toContain('redis_unavailable');
    expect(res.shortlist).toContain('db_pool_exhausted');
  });

  it('does NOT collapse when fallback event is missing (redis_plus_independent_db), returning ambiguous', () => {
    const pack = mockPack([
      {
        nodeId: 'n_redis',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:30.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n_db',
        service: 'orders-db',
        level: 'ERROR',
        signal: 'db_pool_exhausted',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:04.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'pool exhausted',
        isDiagnostic: true,
        representativeLogIds: ['l3'],
        allLogIds: ['l3'],
      },
    ]);

    const res = scoreHypothesis(pack, CAUSES, 0, 25);
    expect(res.status).toBe('ambiguous_multiple_causes');
    expect(res.shortlist).toEqual(['redis_unavailable', 'db_pool_exhausted']);
  });

  it('keeps db_pool_exhausted alone as single diagnosed cause when Redis is healthy', () => {
    const pack = mockPack([
      {
        nodeId: 'n_db',
        service: 'orders-db',
        level: 'ERROR',
        signal: 'db_pool_exhausted',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:04.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'pool exhausted',
        isDiagnostic: true,
        representativeLogIds: ['l3'],
        allLogIds: ['l3'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('diagnosed');
    expect(res.causeMode).toBe('single');
    expect(res.rootCauses).toEqual(['db_pool_exhausted']);
  });
});

describe('Hypothesis Scorer: Independence & Compound Causes (Section 20 & Section 7)', () => {
  it('identifies compound cause when two independent faults both have private support signals', () => {
    const pack = mockPack([
      // Redis fault with private support (cache_miss_spike)
      {
        nodeId: 'n1',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'checkout',
        level: 'WARN',
        signal: 'cache_miss_spike',
        signalKind: 'supporting',
        count: 4,
        firstSeen: '2026-10-13T12:00:05Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'cache miss',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
      // Payment gateway fault with private support (gateway_latency_high)
      {
        nodeId: 'n3',
        service: 'payments',
        level: 'ERROR',
        signal: 'gateway_unreachable',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'gateway unreachable',
        isDiagnostic: true,
        representativeLogIds: ['l3'],
        allLogIds: ['l3'],
      },
      {
        nodeId: 'n4',
        service: 'payments',
        level: 'WARN',
        signal: 'gateway_latency_high',
        signalKind: 'supporting',
        count: 4,
        firstSeen: '2026-10-13T12:00:02Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'latency high',
        isDiagnostic: false,
        representativeLogIds: ['l4'],
        allLogIds: ['l4'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('diagnosed');
    expect(res.causeMode).toBe('compound');
    expect(res.rootCauses).toContain('redis_unavailable');
    expect(res.rootCauses).toContain('payment_gateway_down');
  });

  it('returns ambiguous_multiple_causes when two diagnostic signals lack private support', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'payments',
        level: 'ERROR',
        signal: 'gateway_unreachable',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'gateway unreachable',
        isDiagnostic: true,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('ambiguous_multiple_causes');
    expect(res.shortlist).toContain('redis_unavailable');
    expect(res.shortlist).toContain('payment_gateway_down');
  });
});

describe('Hypothesis Scorer: Safety Invariants (Section 20 & Section 7)', () => {
  it('returns insufficient_evidence (no_eligible_cause_after_exclusions) when all candidates are excluded', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:01:00.000Z',
        lastSeen: '2026-10-13T12:01:05.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // Sustained health probe on redis-cache spanning 35s overlapping diagnostic window
      {
        nodeId: 'n2',
        service: 'redis-cache',
        level: 'INFO',
        signal: 'redis_health_ok',
        signalKind: 'health',
        count: 5,
        firstSeen: '2026-10-13T12:00:50.000Z',
        lastSeen: '2026-10-13T12:01:30.000Z',
        messageSample: 'ping ok',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('insufficient_evidence');
    expect(res.reason).toBe('no_eligible_cause_after_exclusions');
  });
});
