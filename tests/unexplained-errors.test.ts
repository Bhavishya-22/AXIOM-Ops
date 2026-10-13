import { describe, it, expect } from 'vitest';
import { scoreHypothesis } from '../backend/src/scorer.js';
import { generateDeterministicExplanation } from '../backend/src/diagnosis.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';

function mockPack(nodes: any[]): EvidencePack {
  const nodeMap = new Map<string, string[]>();
  const logMap = new Map<string, any>();
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n.allLogIds);
    for (const lId of n.allLogIds) {
      logMap.set(lId, { id: lId, signal: n.signal });
    }
  }

  return {
    nodes,
    compactNodes: [],
    nodeMap,
    logMap,
    scopedServices: ['checkout', 'payments', 'redis-cache', 'orders-db'],
    windowStart: new Date('2026-10-13T12:00:00Z'),
    windowEnd: new Date('2026-10-13T12:05:00Z'),
    sessionId: 'test_unexplained_sess',
  };
}

describe('Unexplained Error Accounting (Section 20 & Section 7)', () => {
  it('forces manual-only and Weak level when an unexplained error cluster appears on payments during Redis down', () => {
    const pack = mockPack([
      // Redis primary diagnostic signal
      {
        nodeId: 'n_redis',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'connection refused to cache node',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // 3 instances of a novel unrecognised technical error on payments
      {
        nodeId: 'n_unexplained',
        service: 'payments',
        level: 'ERROR',
        signal: null,
        signalKind: null,
        count: 3,
        firstSeen: '2026-10-13T12:00:10Z',
        lastSeen: '2026-10-13T12:00:40Z',
        messageSample: 'corrupt memory segment in worker heap',
        isDiagnostic: false,
        representativeLogIds: ['l_heap1', 'l_heap2', 'l_heap3'],
        allLogIds: ['l_heap1', 'l_heap2', 'l_heap3'],
      },
    ]);

    const scorerResult = scoreHypothesis(pack);
    expect(scorerResult.status).toBe('diagnosed');
    expect(scorerResult.rootCauses).toEqual(['redis_unavailable']);
    expect(scorerResult.unresolvedClusters.some((c) => c.material)).toBe(true);

    const diag = generateDeterministicExplanation(scorerResult, pack);
    expect(diag.actionDisposition).toBe('manual_recommended');
    expect(diag.dispositionReason).toBe('unexplained_error_cluster');
    expect(diag.evidenceLevel).toBe('Weak');
    expect(diag.levelReasons).toContain('material_unresolved_error_cluster_present');
  });

  it('does NOT block execution for an isolated single unmatched error line (count = 1)', () => {
    const pack = mockPack([
      {
        nodeId: 'n_redis',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 5,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:01:00Z',
        messageSample: 'connection refused to cache node',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n_isolated',
        service: 'payments',
        level: 'ERROR',
        signal: null,
        signalKind: null,
        count: 1,
        firstSeen: '2026-10-13T12:00:15Z',
        lastSeen: '2026-10-13T12:00:15Z',
        messageSample: 'isolated glitch',
        isDiagnostic: false,
        representativeLogIds: ['l_iso'],
        allLogIds: ['l_iso'],
      },
    ]);

    const scorerResult = scoreHypothesis(pack);
    expect(scorerResult.status).toBe('diagnosed');
    expect(scorerResult.unresolvedClusters.length).toBe(0);

    const diag = generateDeterministicExplanation(scorerResult, pack);
    expect(diag.actionDisposition).toBe('executable');
    expect(diag.evidenceLevel).toBe('Moderate');
  });
});
