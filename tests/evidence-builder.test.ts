import { describe, it, expect } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { buildEvidencePack } from '../backend/src/evidence-builder.js';
import { createHash } from 'crypto';

describe('Evidence Builder Invariants (Section 20 & Section 11)', () => {
  const pfx = 'eb_' + Date.now() + '_';
  const testSession = 'sess_evid_test_' + Date.now();
  const otherSession = 'sess_evid_other_' + Date.now();
  const baseTime = new Date('2026-10-13T12:00:00Z');

  function makeHash(msg: string) {
    return createHash('sha256').update(msg).digest('hex').slice(0, 16);
  }

  it('dedupes repeated errors, respects window and session scope, keeps diagnostic INFO rows, and retains diagnostic nodes under cap', async () => {
    const logsData = [];

    // Diagnostic INFO row (version changed)
    logsData.push({
      id: `${pfx}log_info_deploy`,
      ts: new Date(baseTime.getTime() + 1000),
      service: 'payments',
      category: 'payment',
      team: 'Payments',
      level: 'INFO',
      message: 'deployed v2.4.1',
      signal: 'version_changed',
      signalKind: 'diagnostic',
      messageHash: makeHash('deployed v2.4.1'),
      sessionId: testSession,
      serviceSeq: 1,
      class: 'routine',
      expiresAt: new Date(baseTime.getTime() + 3600000),
      origin: 'simulator',
    });

    // Diagnostic ERROR row (redis connection refused)
    logsData.push({
      id: `${pfx}log_redis_err`,
      ts: new Date(baseTime.getTime() + 5000),
      service: 'redis-cache',
      category: 'cache',
      team: 'Infrastructure',
      level: 'ERROR',
      message: 'connection refused to cache node',
      signal: 'redis_conn_refused',
      signalKind: 'diagnostic',
      messageHash: makeHash('connection refused to cache node'),
      sessionId: testSession,
      serviceSeq: 2,
      class: 'incident',
      expiresAt: new Date(baseTime.getTime() + 3600000),
      origin: 'simulator',
    });

    // Multiple duplicate error logs to test compression
    for (let i = 1; i <= 5; i++) {
      logsData.push({
        id: `${pfx}log_dup_checkout_${i}`,
        ts: new Date(baseTime.getTime() + 6000 + i * 200),
        service: 'checkout',
        category: 'api',
        team: 'Commerce',
        level: 'ERROR',
        message: 'request failed with status 503',
        signal: 'checkout_5xx',
        signalKind: 'supporting',
        messageHash: makeHash('request failed with status 503'),
        sessionId: testSession,
        serviceSeq: 10 + i,
        class: 'incident',
        expiresAt: new Date(baseTime.getTime() + 3600000),
        origin: 'simulator',
      });
    }

    // Row outside window (too early)
    logsData.push({
      id: `${pfx}log_too_early`,
      ts: new Date(baseTime.getTime() - 60000),
      service: 'payments',
      category: 'payment',
      team: 'Payments',
      level: 'ERROR',
      message: 'out of window error',
      signal: 'payment_timeout',
      signalKind: 'supporting',
      messageHash: makeHash('out of window error'),
      sessionId: testSession,
      serviceSeq: 99,
      class: 'routine',
      expiresAt: new Date(baseTime.getTime() + 3600000),
      origin: 'simulator',
    });

    // Row from other session (must NEVER be included)
    logsData.push({
      id: `${pfx}log_other_session`,
      ts: new Date(baseTime.getTime() + 2000),
      service: 'redis-cache',
      category: 'cache',
      team: 'Infrastructure',
      level: 'ERROR',
      message: 'connection refused from other session',
      signal: 'redis_conn_refused',
      signalKind: 'diagnostic',
      messageHash: makeHash('other session error'),
      sessionId: otherSession,
      serviceSeq: 1,
      class: 'incident',
      expiresAt: new Date(baseTime.getTime() + 3600000),
      origin: 'simulator',
    });

    // Insert 70 routine/noise logs to exceed the 60 node cap
    for (let i = 1; i <= 70; i++) {
      logsData.push({
        id: `${pfx}log_routine_noise_${i}`,
        ts: new Date(baseTime.getTime() + 10000 + i * 500),
        service: 'payments',
        category: 'payment',
        team: 'Payments',
        level: 'INFO',
        message: `routine payment ping ${i}`,
        signal: null,
        signalKind: null,
        messageHash: makeHash(`routine payment ping ${i}`),
        sessionId: testSession,
        serviceSeq: 100 + i,
        class: 'routine',
        expiresAt: new Date(baseTime.getTime() + 3600000),
        origin: 'simulator',
      });
    }

    await prisma.log.createMany({ data: logsData });

    const pack = await buildEvidencePack({
      sessionId: testSession,
      ticketServices: ['checkout'],
      windowStart: baseTime,
      windowEnd: new Date(baseTime.getTime() + 60000),
      maxNodes: 60,
    });

    // 1. Never includes other session logs
    expect(pack.logMap.has(`${pfx}log_other_session`)).toBe(false);

    // 2. Never includes logs outside window
    expect(pack.logMap.has(`${pfx}log_too_early`)).toBe(false);

    // 3. Keeps version-changed INFO row
    expect(pack.nodes.some((n) => n.signal === 'version_changed')).toBe(true);

    // 4. Retains diagnostic nodes under the 60-node cap
    const diagNode = pack.nodes.find((n) => n.signal === 'redis_conn_refused');
    expect(diagNode).toBeDefined();
    expect(diagNode?.isDiagnostic).toBe(true);
    expect(pack.nodes.length).toBeLessThanOrEqual(60);

    // 5. Server-held nodeMap resolves to original log IDs
    expect(pack.nodeMap.has(diagNode!.nodeId)).toBe(true);
    expect(pack.nodeMap.get(diagNode!.nodeId)).toContain(`${pfx}log_redis_err`);

    // 6. Compact prompt nodes have at most 3 representative log IDs
    const compactCheckout = pack.compactNodes.find((c) => c.signal === 'checkout_5xx');
    expect(compactCheckout).toBeDefined();
    expect(compactCheckout!.representativeLogIds.length).toBeLessThanOrEqual(3);
    expect(compactCheckout!.count).toBe(5);
  });
});
