import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { runRetentionCleanup } from '../backend/src/retention.js';
import { randomUUID } from 'crypto';

describe('Log Retention Lifecycle (Item 3 & Section 13)', () => {
  const testSessionId = `test-retention-${randomUUID().slice(0, 8)}`;
  let pinnedLogId: string;

  it('deletes expired unpinned routine rows while preserving pinned rows', async () => {
    const pastDate = new Date(Date.now() - 60000); // 1 minute in the past

    // 1. Create an unpinned routine log that is already expired
    const routineLog = await prisma.log.create({
      data: {
        ts: new Date(),
        service: 'checkout',
        category: 'api',
        team: 'Commerce',
        level: 'INFO',
        message: 'routine health ping to expire',
        messageHash: 'hash-routine-1',
        sessionId: testSessionId,
        serviceSeq: 1,
        class: 'routine',
        expiresAt: pastDate,
        pinnedByIncidentId: null,
        origin: 'simulator',
      },
    });

    // 2. Create a pinned log that also has an expired date, but is pinned
    const pinnedLog = await prisma.log.create({
      data: {
        ts: new Date(),
        service: 'checkout',
        category: 'api',
        team: 'Commerce',
        level: 'ERROR',
        message: 'critical fault pinned by incident',
        messageHash: 'hash-pinned-1',
        sessionId: testSessionId,
        serviceSeq: 2,
        class: 'incident',
        expiresAt: pastDate,
        pinnedByIncidentId: 'inc_test_123',
        origin: 'simulator',
      },
    });
    pinnedLogId = pinnedLog.id;

    // 3. Execute retention cleanup
    const { deletedCount } = await runRetentionCleanup();
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // 4. Assert: unpinned row was deleted
    const foundRoutine = await prisma.log.findUnique({
      where: { id: routineLog.id },
    });
    expect(foundRoutine).toBeNull();

    // 5. Assert: pinned row survived!
    const foundPinned = await prisma.log.findUnique({
      where: { id: pinnedLog.id },
    });
    expect(foundPinned).not.toBeNull();
    expect(foundPinned?.pinnedByIncidentId).toBe('inc_test_123');
  });

  afterAll(async () => {
    if (pinnedLogId) {
      await prisma.log.deleteMany({
        where: { id: pinnedLogId },
      });
    }
  });
});
