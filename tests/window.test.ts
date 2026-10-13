import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { computeEvidenceWindow, expandEvidenceWindow } from '../backend/src/window.js';

describe('Evidence Window Computation & Pinning (Section 20 & Section 13)', () => {
  const testSession = 'sess_win_test_' + Date.now();
  const baseTime = new Date('2026-10-13T12:00:00Z');

  beforeEach(async () => {
    await prisma.deployEvent.deleteMany();
    await prisma.incident.deleteMany({ where: { sessionId: 'previous_session' } });
  });

  it('computes window start with 5-minute margin, bounded by deploy events and previous incident resolvedAt', async () => {
    const detectedAt = new Date(baseTime.getTime() + 10 * 60 * 1000); // 12:10:00
    const investigationStartedAt = new Date(baseTime.getTime() + 10 * 60 * 1000 + 5000); // 12:10:05

    // Case 1: Standard 5-minute margin (12:10 - 5m = 12:05)
    const win1 = await computeEvidenceWindow({
      detectedAt,
      investigationStartedAt,
      scopedServices: ['checkout'],
      sessionId: testSession,
    });
    expect(win1.windowStart.getTime()).toBe(detectedAt.getTime() - 5 * 60 * 1000);

    // Case 2: Deploy event occurred 8 minutes ago (12:02:00)
    const deployTs = new Date(detectedAt.getTime() - 8 * 60 * 1000);
    await prisma.deployEvent.create({
      data: {
        service: 'payments',
        fromVersion: 'v2.4.0',
        toVersion: 'v2.4.1',
        ts: deployTs,
      },
    });

    const win2 = await computeEvidenceWindow({
      detectedAt,
      investigationStartedAt,
      scopedServices: ['checkout', 'payments'],
      sessionId: testSession,
    });
    expect(win2.windowStart.getTime()).toBe(deployTs.getTime());

    // Case 3: Previous incident resolved 6 minutes ago (12:04:00)
    // Window must NEVER start before previous resolvedAt!
    const previousResolvedAt = new Date(detectedAt.getTime() - 6 * 60 * 1000);
    await prisma.incident.create({
      data: {
        sessionId: 'previous_session',
        status: 'resolved',
        detectedAt: new Date(previousResolvedAt.getTime() - 600000),
        resolvedAt: previousResolvedAt,
        openSlot: null,
      },
    });

    const win3 = await computeEvidenceWindow({
      detectedAt,
      investigationStartedAt,
      scopedServices: ['checkout', 'payments'],
      sessionId: testSession,
    });
    expect(win3.windowStart.getTime()).toBe(previousResolvedAt.getTime());
  });

  it('one-step expansion widens window up to 2x duration, bounded by previous resolvedAt', () => {
    const start = new Date('2026-10-13T12:05:00Z');
    const end = new Date('2026-10-13T12:10:00Z'); // 5-minute duration
    const prevResolved = new Date('2026-10-13T12:03:00Z');

    const widened = expandEvidenceWindow(start, end, prevResolved);
    // Doubled duration is 10 min before end (12:00:00), but bounded by prevResolved (12:03:00)
    expect(widened.toISOString()).toBe(prevResolved.toISOString());
  });
});
