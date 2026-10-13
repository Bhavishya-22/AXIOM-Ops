import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'net';
import { createServer } from '../backend/src/server.js';
import { prisma } from '../backend/src/prisma.js';
import { gapTracker } from '../backend/src/gap-tracker.js';
import { randomUUID } from 'crypto';

describe('Log Ingestion (POST /ingest) Contract & Security Tests (Item 2 & Section 8)', () => {
  let server: any;
  let baseUrl: string;
  const token = 'dev-ingest-token-123';
  const sessionId = `test-ingest-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    process.env.INGEST_TOKEN = token;
    const app = createServer();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  it('rejects request with missing or invalid token with 401', async () => {
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'simulator', logs: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects oversized batch (> 256 KB) with 400 and records IngestGap with ["*"]', async () => {
    const initialGaps = await prisma.ingestGap.count();

    // Create large message to push payload over 256 KB
    const bigMessage = 'a'.repeat(950);
    const bigLogs = Array.from({ length: 300 }).map((_, i) => ({
      ts: new Date().toISOString(),
      service: 'checkout',
      level: 'INFO',
      message: bigMessage,
      sessionId,
      serviceSeq: i + 1,
      origin: 'oversized-source',
    }));

    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ source: 'oversized-source', logs: bigLogs }),
    });

    expect(res.status).toBe(400);

    // Assert: IngestGap recorded for all services of source ["*"]
    const newGap = await prisma.ingestGap.findFirst({
      where: { source: 'oversized-source', reason: 'rejected_batch' },
      orderBy: { createdAt: 'desc' },
    });
    expect(newGap).not.toBeNull();
    expect(newGap?.services).toEqual(['*']);
  });

  it('rejects stale timestamp (< now - 5m) with 400 and records IngestGap ["*"]', async () => {
    const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'stale-source',
        logs: [
          {
            ts: staleTime,
            service: 'checkout',
            level: 'INFO',
            message: 'stale log line',
            sessionId,
            serviceSeq: 100,
            origin: 'stale-source',
          },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const gap = await prisma.ingestGap.findFirst({
      where: { source: 'stale-source', reason: 'rejected_batch' },
      orderBy: { createdAt: 'desc' },
    });
    expect(gap).not.toBeNull();
    expect(gap?.services).toEqual(['*']);
  });

  it('rejects future timestamp (> now + 30s) with 400 and records IngestGap ["*"]', async () => {
    const futureTime = new Date(Date.now() + 60 * 1000).toISOString();
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'future-source',
        logs: [
          {
            ts: futureTime,
            service: 'payments',
            level: 'INFO',
            message: 'future log line',
            sessionId,
            serviceSeq: 101,
            origin: 'future-source',
          },
        ],
      }),
    });

    expect(res.status).toBe(400);

    const gap = await prisma.ingestGap.findFirst({
      where: { source: 'future-source', reason: 'rejected_batch' },
      orderBy: { createdAt: 'desc' },
    });
    expect(gap).not.toBeNull();
    expect(gap?.services).toEqual(['*']);
  });

  it('ignores spoofed caller signal field and executes backend-only signal tagging', async () => {
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'simulator',
        logs: [
          {
            ts: new Date().toISOString(),
            service: 'redis-cache',
            level: 'ERROR',
            message: 'connection refused to cache node:6379',
            sessionId,
            serviceSeq: 10,
            origin: 'simulator',
            signal: 'SPOOFED_SIGNAL_NAME', // caller tries to spoof
            signalKind: 'benign',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const savedLog = await prisma.log.findFirst({
      where: { sessionId, service: 'redis-cache', serviceSeq: 10 },
    });

    expect(savedLog).not.toBeNull();
    // Must be tagged via backend rule, NOT caller's spoofed value!
    expect(savedLog?.signal).toBe('redis_conn_refused');
    expect(savedLog?.signalKind).toBe('diagnostic');
  });

  it('sanitizes control characters and redacts secrets before storing', async () => {
    const rawMessage =
      'User john.doe@example.com paid with card 4111-2222-3333-4444 using Bearer secret_token_xyz and sk-abcdef123456789012\r\ninjection';

    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: 'simulator',
        logs: [
          {
            ts: new Date().toISOString(),
            service: 'payments',
            level: 'INFO',
            message: rawMessage,
            sessionId,
            serviceSeq: 20,
            origin: 'simulator',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const savedLog = await prisma.log.findFirst({
      where: { sessionId, service: 'payments', serviceSeq: 20 },
    });

    expect(savedLog).not.toBeNull();
    expect(savedLog?.message).not.toContain('john.doe@example.com');
    expect(savedLog?.message).toContain('[REDACTED_EMAIL]');
    expect(savedLog?.message).not.toContain('4111-2222-3333-4444');
    expect(savedLog?.message).toContain('[REDACTED_CARD]');
    expect(savedLog?.message).not.toContain('secret_token_xyz');
    expect(savedLog?.message).toContain('Bearer [REDACTED]');
    expect(savedLog?.message).not.toContain('sk-abcdef123456789012');
    expect(savedLog?.message).toContain('[REDACTED_KEY]');
    expect(savedLog?.message).not.toContain('\r\n');
  });

  it('idempotently handles duplicate rows on (origin, sessionId, service, serviceSeq)', async () => {
    const logItem = {
      ts: new Date().toISOString(),
      service: 'checkout',
      level: 'INFO',
      message: 'duplicate test row',
      sessionId,
      serviceSeq: 30,
      origin: 'simulator',
    };

    // First insert
    const res1 = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ source: 'simulator', logs: [logItem] }),
    });
    const body1 = (await res1.json()) as any;
    expect(res1.status).toBe(200);
    expect(body1.accepted).toBe(1);
    expect(body1.duplicates).toBe(0);

    // Second insert with identical row (retransmission)
    const res2 = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ source: 'simulator', logs: [logItem] }),
    });
    const body2 = (await res2.json()) as any;
    expect(res2.status).toBe(200);
    expect(body2.accepted).toBe(0);
    expect(body2.duplicates).toBe(1);
  });

  it('tolerates out-of-order rows inside the 10-second reorder window without creating gaps', async () => {
    const customTracker = new (gapTracker.constructor as any)(500); // 500ms reorder window for test speed
    const svc = 'checkout';
    const src = 'test-reorder-src';
    const sess = 'sess-reorder';
    const now = new Date();

    // Sequence 1 arrives
    await customTracker.trackSequence(src, sess, svc, 1, now);
    // Sequence 3 arrives out-of-order before Sequence 2
    await customTracker.trackSequence(src, sess, svc, 3, now);
    // Sequence 2 arrives within tolerance window
    await customTracker.trackSequence(src, sess, svc, 2, now);

    // Wait past window
    await new Promise((resolve) => setTimeout(resolve, 600));
    await customTracker.flushExpiredGaps();

    // Verify: No IngestGap was created for missing sequence!
    const gaps = await prisma.ingestGap.findMany({
      where: { source: src, reason: 'missing_sequence' },
    });
    expect(gaps).toHaveLength(0);
  });

  it('records an IngestGap for the specific affected service when a sequence number is missing after window', async () => {
    const customTracker = new (gapTracker.constructor as any)(100); // 100ms window for fast test
    const svc = 'orders-db';
    const src = 'test-gap-src';
    const sess = 'sess-gap';
    const now = new Date();

    // Sequence 1 arrives
    await customTracker.trackSequence(src, sess, svc, 1, now);
    // Sequence 5 arrives (sequences 2, 3, 4 are missing!)
    await customTracker.trackSequence(src, sess, svc, 5, now);

    // Wait past window
    await new Promise((resolve) => setTimeout(resolve, 200));
    await customTracker.flushExpiredGaps();

    // Verify: IngestGap recorded specifically for orders-db only!
    const gap = await prisma.ingestGap.findFirst({
      where: { source: src, reason: 'missing_sequence' },
      orderBy: { createdAt: 'desc' },
    });
    expect(gap).not.toBeNull();
    expect(gap?.services).toEqual(['orders-db']);
  });
});
