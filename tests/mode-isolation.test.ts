import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { IncidentDetector } from '../backend/src/detector.js';
import { createIncidentTransaction } from '../backend/src/incident-lifecycle.js';

describe('Mode Isolation (Section 20 & Section 10/16)', () => {
  beforeEach(async () => {
    await prisma.incident.updateMany({
      where: { openSlot: 1 },
      data: { openSlot: null, status: 'resolved', resolvedAt: new Date() },
    });
  });

  it('Mode B does NOT auto-create any incident on breach; incident created only upon human click', async () => {
    const origMode = process.env.DETECTOR_MODE;
    process.env.DETECTOR_MODE = 'B';

    try {
      const detector = new IncidentDetector();
      detector.start(); // Mode B should not set timer

      const session = 'sess_mode_b_' + Date.now();
      const now = new Date();

      // Ingest error metrics
      await prisma.metricSample.create({
        data: {
          sessionId: session,
          service: 'checkout',
          ts: new Date(now.getTime() - 30000),
          requestsTotal: 20,
          successesTotal: 10,
          errorsTotal: 10,
          businessOutcomesTotal: 0,
        },
      });
      await prisma.metricSample.create({
        data: {
          sessionId: session,
          service: 'checkout',
          ts: now,
          requestsTotal: 40,
          successesTotal: 20,
          errorsTotal: 20,
          businessOutcomesTotal: 0,
        },
      });

      // Assert no automatic open incident exists
      let openIncident = await prisma.incident.findFirst({
        where: { openSlot: 1 },
      });
      expect(openIncident).toBeNull();

      // Human clicks "Report issue"
      const humanClickTime = new Date();
      const result = await createIncidentTransaction({
        sessionId: session,
        services: ['checkout'],
        humanDetectedAt: humanClickTime,
        title: 'Manual report on checkout',
      });

      expect(result.incident).toBeDefined();
      expect(result.incident.humanDetectedAt).toBeDefined();
      expect(new Date(result.incident.humanDetectedAt).getTime()).toBe(humanClickTime.getTime());
      expect(result.ticket.source).toBe('user');
      expect(result.investigation).toBeDefined();

      detector.stop();
    } finally {
      process.env.DETECTOR_MODE = origMode;
    }
  });
});
