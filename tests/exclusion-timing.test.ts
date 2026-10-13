import { describe, it, expect } from 'vitest';
import { isCandidateExcluded, indexSignals } from '../backend/src/scorer.js';
import { CAUSES } from '../backend/src/registry/causes.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';

function mockPack(nodes: any[]): EvidencePack {
  return {
    nodes,
    compactNodes: [],
    nodeMap: new Map(),
    logMap: new Map(),
    scopedServices: ['redis-cache'],
    windowStart: new Date('2026-10-13T12:00:00Z'),
    windowEnd: new Date('2026-10-13T12:05:00Z'),
    sessionId: 'test_exclusion_sess',
  };
}

describe('Candidate Exclusion Timing (Section 20 & Section 4/7)', () => {
  const redisCause = CAUSES['redis_unavailable'];

  it('does NOT exclude Redis when healthy probes occur BEFORE the first diagnostic failure', () => {
    const pack = mockPack([
      // Healthy baseline probes from 12:00:00 to 12:00:40
      {
        nodeId: 'n_health',
        service: 'redis-cache',
        level: 'INFO',
        signal: 'redis_health_ok',
        signalKind: 'health',
        count: 5,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'ping ok',
        isDiagnostic: false,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // First diagnostic failure starts at 12:01:00 (after baseline)
      {
        nodeId: 'n_diag',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:01:00.000Z',
        lastSeen: '2026-10-13T12:01:20.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const sig = indexSignals(pack);
    const excluded = isCandidateExcluded(redisCause, sig);
    expect(excluded).toBe(false);
  });

  it('does NOT exclude Redis when healthy probes occur AFTER the last diagnostic failure (recovery / post-apply)', () => {
    const pack = mockPack([
      // Diagnostic failure occurs from 12:00:00 to 12:00:30
      {
        nodeId: 'n_diag',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 3,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:30.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // Health probes occur after recovery starting at 12:01:00
      {
        nodeId: 'n_health',
        service: 'redis-cache',
        level: 'INFO',
        signal: 'redis_health_ok',
        signalKind: 'health',
        count: 5,
        firstSeen: '2026-10-13T12:01:00.000Z',
        lastSeen: '2026-10-13T12:01:40.000Z',
        messageSample: 'ping ok',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const sig = indexSignals(pack);
    const excluded = isCandidateExcluded(redisCause, sig);
    expect(excluded).toBe(false);
  });

  it('DOES exclude Redis when sustained healthy probes span >= 30s overlapping the failure window', () => {
    const pack = mockPack([
      // Diagnostic failure from 12:00:10 to 12:00:20
      {
        nodeId: 'n_diag',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:10.000Z',
        lastSeen: '2026-10-13T12:00:20.000Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // Sustained health from 12:00:00 to 12:00:40 (span 40s >= 30s, overlapping)
      {
        nodeId: 'n_health',
        service: 'redis-cache',
        level: 'INFO',
        signal: 'redis_health_ok',
        signalKind: 'health',
        count: 6,
        firstSeen: '2026-10-13T12:00:00.000Z',
        lastSeen: '2026-10-13T12:00:40.000Z',
        messageSample: 'ping ok',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const sig = indexSignals(pack);
    const excluded = isCandidateExcluded(redisCause, sig);
    expect(excluded).toBe(true);
  });
});
