import { describe, it, expect } from 'vitest';
import { validateDiagnosisOutput } from '../backend/src/diagnosis.js';
import { EvidencePack } from '../backend/src/evidence-builder.js';
import { ScorerResult } from '../backend/src/scorer.js';
import { LlmOutput } from '@axiomops/shared';

function mockPack(): EvidencePack {
  const nodeMap = new Map<string, string[]>();
  const logMap = new Map<string, any>();

  nodeMap.set('node_redis_1', ['log_real_1', 'log_real_2']);
  logMap.set('log_real_1', { id: 'log_real_1', signal: 'redis_conn_refused' });
  logMap.set('log_real_2', { id: 'log_real_2', signal: 'redis_conn_refused' });

  return {
    nodes: [
      {
        nodeId: 'node_redis_1',
        service: 'redis-cache',
        level: 'ERROR',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        count: 2,
        firstSeen: '2026-10-13T12:00:00Z',
        lastSeen: '2026-10-13T12:00:30Z',
        messageSample: 'connection refused',
        isDiagnostic: true,
        representativeLogIds: ['log_real_1', 'log_real_2'],
        allLogIds: ['log_real_1', 'log_real_2'],
      },
    ],
    compactNodes: [],
    nodeMap,
    logMap,
    scopedServices: ['redis-cache', 'checkout'],
    windowStart: new Date('2026-10-13T12:00:00Z'),
    windowEnd: new Date('2026-10-13T12:05:00Z'),
    sessionId: 'test_val_sess',
  };
}

const baseScorer: ScorerResult = {
  classification: 'incident',
  status: 'diagnosed',
  causeMode: 'single',
  shortlist: ['redis_unavailable'],
  rootCauses: ['redis_unavailable'],
  suppressed: [],
  unresolvedClusters: [],
};

describe('Server-Side Diagnosis Output Validation (Section 20 & Section 11)', () => {
  const pack = mockPack();

  it('accepts a valid diagnosed output citing real IDs and compatible action', () => {
    const output: LlmOutput = {
      status: 'diagnosed',
      candidates: [
        {
          category: 'redis_unavailable',
          reasoning: 'Primary cache failure observed on redis node',
          evidenceLogIds: ['node_redis_1'],
        },
      ],
      rootCauseCategory: 'redis_unavailable',
      explanation: 'Redis connection refused caused downstream errors',
      evidenceLogIds: ['node_redis_1'],
      historicalCaseId: null,
      actionId: 'restart_redis',
      prevention: ['Improve alerting'],
      missingEvidence: [],
    };

    const res = validateDiagnosisOutput(output, baseScorer, pack, []);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('rejects output citing fake log or node IDs not in the evidence pack', () => {
    const output: LlmOutput = {
      status: 'diagnosed',
      candidates: [
        {
          category: 'redis_unavailable',
          reasoning: 'Test',
          evidenceLogIds: ['node_fake_999'],
        },
      ],
      rootCauseCategory: 'redis_unavailable',
      explanation: 'Fake cite',
      evidenceLogIds: ['node_fake_999'],
      historicalCaseId: null,
      actionId: 'restart_redis',
      prevention: [],
      missingEvidence: [],
    };

    const res = validateDiagnosisOutput(output, baseScorer, pack, []);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('does not resolve'))).toBe(true);
  });

  it('rejects output with rootCauseCategory outside the scorer shortlist', () => {
    const output: LlmOutput = {
      status: 'diagnosed',
      candidates: [
        {
          category: 'db_pool_exhausted',
          reasoning: 'Hallucinated cause',
          evidenceLogIds: ['node_redis_1'],
        },
      ],
      rootCauseCategory: 'db_pool_exhausted', // Not in shortlist
      explanation: 'Wrong cause',
      evidenceLogIds: ['node_redis_1'],
      historicalCaseId: null,
      actionId: 'increase_db_pool',
      prevention: [],
      missingEvidence: [],
    };

    const res = validateDiagnosisOutput(output, baseScorer, pack, []);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('not in scorer shortlist'))).toBe(true);
  });

  it('rejects incompatible action for the cause', () => {
    const output: LlmOutput = {
      status: 'diagnosed',
      candidates: [
        {
          category: 'redis_unavailable',
          reasoning: 'Incompatible action',
          evidenceLogIds: ['node_redis_1'],
        },
      ],
      rootCauseCategory: 'redis_unavailable',
      explanation: 'Incompatible action',
      evidenceLogIds: ['node_redis_1'],
      historicalCaseId: null,
      actionId: 'rollback_deploy', // Incompatible with redis_unavailable
      prevention: [],
      missingEvidence: [],
    };

    const res = validateDiagnosisOutput(output, baseScorer, pack, []);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('not compatible'))).toBe(true);
  });

  it('accepts a valid abstention with null actionId and non-empty missingEvidence', () => {
    const abstentionOutput: LlmOutput = {
      status: 'insufficient_evidence',
      candidates: [],
      rootCauseCategory: 'unknown',
      explanation: 'Evidence insufficient to diagnose',
      evidenceLogIds: [],
      historicalCaseId: null,
      actionId: null,
      prevention: [],
      missingEvidence: ['diagnostic_signal_required'],
    };

    const res = validateDiagnosisOutput(abstentionOutput, baseScorer, pack, []);
    expect(res.valid).toBe(true);
  });

  it('rejects insufficient_evidence with non-null actionId or empty missingEvidence', () => {
    const invalidAbstention: LlmOutput = {
      status: 'insufficient_evidence',
      candidates: [],
      rootCauseCategory: 'unknown',
      explanation: 'Invalid',
      evidenceLogIds: [],
      historicalCaseId: null,
      actionId: 'restart_redis', // must be null
      prevention: [],
      missingEvidence: [], // must not be empty
    };

    const res = validateDiagnosisOutput(invalidAbstention, baseScorer, pack, []);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('ActionId must be null'))).toBe(true);
    expect(res.errors.some((e) => e.includes('missingEvidence must be non-empty'))).toBe(true);
  });
});
