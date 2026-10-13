import { describe, it, expect } from 'vitest';
import { scoreHypothesis } from '../backend/src/scorer.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';

function mockPack(nodes: any[]): EvidencePack {
  return {
    nodes,
    compactNodes: [],
    nodeMap: new Map(),
    logMap: new Map(),
    scopedServices: ['checkout', 'payments'],
    windowStart: new Date('2026-10-13T12:00:00Z'),
    windowEnd: new Date('2026-10-13T12:05:00Z'),
    sessionId: 'test_deploy_sess',
  };
}

describe('Bad Deploy Candidate Formation (Section 20 & Section 4/7)', () => {
  it('does NOT form bad_deploy candidate when only checkout_5xx is present with version_changed', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'version_changed',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:00:00Z',
        messageSample: 'deployed v2.4.1',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      // checkout_5xx is downstream, NOT on payments itself
      {
        nodeId: 'n2',
        service: 'checkout',
        level: 'ERROR',
        signal: 'checkout_5xx',
        signalKind: 'supporting',
        count: 5,
        firstSeen: '2026-10-13T12:00:10Z',
        lastSeen: '2026-10-13T12:00:20Z',
        messageSample: 'status 503',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const res = scoreHypothesis(pack);
    // Bad deploy cannot form without payments' own support signals
    expect(res.status).not.toBe('diagnosed');
    expect(res.rootCauses).toBeUndefined();
  });

  it('forms bad_deploy candidate when payments own support signal (payments_5xx) is present', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'version_changed',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:00:00Z',
        messageSample: 'deployed v2.4.1',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'payments',
        level: 'ERROR',
        signal: 'payments_5xx',
        signalKind: 'supporting',
        count: 5,
        firstSeen: '2026-10-13T12:00:05Z',
        lastSeen: '2026-10-13T12:00:20Z',
        messageSample: 'request failed with status 500',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('diagnosed');
    expect(res.rootCauses).toEqual(['bad_deploy']);
  });

  it('forms bad_deploy candidate when validation_error_spike is present on payments', () => {
    const pack = mockPack([
      {
        nodeId: 'n1',
        service: 'payments',
        level: 'INFO',
        signal: 'version_changed',
        signalKind: 'diagnostic',
        count: 1,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:00:00Z',
        messageSample: 'deployed v2.4.1',
        isDiagnostic: true,
        representativeLogIds: ['l1'],
        allLogIds: ['l1'],
      },
      {
        nodeId: 'n2',
        service: 'payments',
        level: 'ERROR',
        signal: 'validation_error_spike',
        signalKind: 'supporting',
        count: 12,
        firstSeen: '2026-10-13T12:00:05Z',
        lastSeen: '2026-10-13T12:00:20Z',
        messageSample: 'validation error on order payload',
        isDiagnostic: false,
        representativeLogIds: ['l2'],
        allLogIds: ['l2'],
      },
    ]);

    const res = scoreHypothesis(pack);
    expect(res.status).toBe('diagnosed');
    expect(res.rootCauses).toEqual(['bad_deploy']);
  });
});
