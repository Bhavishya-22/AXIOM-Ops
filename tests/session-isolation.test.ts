import { describe, it, expect } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { buildEvidencePack } from '../backend/src/evidence-builder.js';
import { scoreHypothesis } from '../backend/src/scorer.js';
import { createHash } from 'crypto';

describe('Session Isolation (Section 20 & Section 5/8)', () => {
  const pfx = 'si_' + Date.now() + '_';
  const session1 = 'sess_iso_1_' + Date.now();
  const session2 = 'sess_iso_2_' + Date.now();
  const now = new Date('2026-10-13T12:00:00Z');

  function makeHash(msg: string) {
    return createHash('sha256').update(msg).digest('hex').slice(0, 16);
  }

  it('ensures second incident diagnosis contains none of the first session data', async () => {
    // Session 1: Redis down
    await prisma.log.create({
      data: {
        id: `${pfx}log_sess1_redis`,
        ts: new Date(now.getTime() + 1000),
        service: 'redis-cache',
        category: 'cache',
        team: 'Infrastructure',
        level: 'ERROR',
        message: 'connection refused to cache node',
        signal: 'redis_conn_refused',
        signalKind: 'diagnostic',
        messageHash: makeHash('connection refused to cache node'),
        sessionId: session1,
        serviceSeq: 1,
        class: 'incident',
        expiresAt: new Date(now.getTime() + 3600000),
        origin: 'simulator',
      },
    });

    // Session 2: IdP down
    await prisma.log.create({
      data: {
        id: `${pfx}log_sess2_idp`,
        ts: new Date(now.getTime() + 2000),
        service: 'identity-provider',
        category: 'auth',
        team: 'Identity',
        level: 'ERROR',
        message: 'idp unreachable: upstream auth service error',
        signal: 'idp_unreachable',
        signalKind: 'diagnostic',
        messageHash: makeHash('idp unreachable: upstream auth service error'),
        sessionId: session2,
        serviceSeq: 1,
        class: 'incident',
        expiresAt: new Date(now.getTime() + 3600000),
        origin: 'simulator',
      },
    });

    // Build evidence pack strictly for Session 2
    const pack2 = await buildEvidencePack({
      sessionId: session2,
      ticketServices: ['checkout'],
      windowStart: now,
      windowEnd: new Date(now.getTime() + 10000),
    });

    expect(pack2.sessionId).toBe(session2);
    expect(pack2.logMap.has(`${pfx}log_sess1_redis`)).toBe(false);
    expect(pack2.logMap.has(`${pfx}log_sess2_idp`)).toBe(true);

    const scorer2 = scoreHypothesis(pack2);
    expect(scorer2.rootCauses).toEqual(['idp_down']);
    expect(scorer2.rootCauses).not.toContain('redis_unavailable');
  });
});
