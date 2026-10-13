import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { IncidentDetector } from '../backend/src/detector.js';

describe('Automatic Incident Detector (Section 20 & Section 16)', () => {
  let detector: IncidentDetector;

  beforeEach(async () => {
    detector = new IncidentDetector();
    // Resolve any currently open incident so test can test cleanly
    await prisma.incident.updateMany({
      where: { openSlot: 1 },
      data: { openSlot: null, status: 'resolved', resolvedAt: new Date() },
    });
  });

  it('does NOT trigger on business-outcome spikes (benign declines are not errors)', async () => {
    const session = 'sess_det_benign_' + Date.now();
    const now = new Date();

    // Baseline sample
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'payments',
        ts: new Date(now.getTime() - 50000),
        requestsTotal: 100,
        successesTotal: 100,
        errorsTotal: 0,
        businessOutcomesTotal: 20,
      },
    });

    // Spike of declines (businessOutcomesTotal increases by 50, but errorsTotal is 0)
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'payments',
        ts: now,
        requestsTotal: 150,
        successesTotal: 150,
        errorsTotal: 0,
        businessOutcomesTotal: 70,
      },
    });

    const res = await detector.evaluateOnce(session);
    expect(res.breached).toBe(false);

    const openIncident = await prisma.incident.findFirst({
      where: { sessionId: session, openSlot: 1 },
    });
    expect(openIncident).toBeNull();
  });

  it('requires TWO consecutive breaches of >= 20% error rate with >= 10 requests over 60s', async () => {
    const session = 'sess_det_breach_' + Date.now();
    const now = new Date();

    // Initial sample
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: new Date(now.getTime() - 40000),
        requestsTotal: 50,
        successesTotal: 50,
        errorsTotal: 0,
        businessOutcomesTotal: 0,
      },
    });

    // Breach 1: 20 requests, 10 errors (50% error rate >= 20%)
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: new Date(now.getTime() - 20000),
        requestsTotal: 70,
        successesTotal: 60,
        errorsTotal: 10,
        businessOutcomesTotal: 0,
      },
    });

    // First evaluation: breach 1 recorded, but requires TWO consecutive breaches
    const res1 = await detector.evaluateOnce(session);
    expect(res1.breached).toBe(false);

    // Breach 2: more errors
    await prisma.metricSample.create({
      data: {
        sessionId: session,
        service: 'checkout',
        ts: now,
        requestsTotal: 90,
        successesTotal: 70,
        errorsTotal: 20,
        businessOutcomesTotal: 0,
      },
    });

    // Second evaluation: breach 2 triggers incident!
    const res2 = await detector.evaluateOnce(session);
    expect(res2.breached).toBe(true);
    expect(res2.service).toBe('checkout');

    const openIncidents = await prisma.incident.findMany({
      where: { sessionId: session, openSlot: 1 },
      include: {
        tickets: {
          include: {
            investigations: true,
          },
        },
      },
    });

    expect(openIncidents.length).toBe(1);
    expect(openIncidents[0].tickets.length).toBe(1);
    expect(openIncidents[0].tickets[0].investigations.length).toBe(1);

    // Concurrent / immediate third poll respects open incident slot and cooldown
    const res3 = await detector.evaluateOnce(session);
    expect(res3.breached).toBe(false);
  });

  it('creates exactly one incident, ticket, investigation across 3 consecutive resets of a scenario', async () => {
    for (let run = 1; run <= 3; run++) {
      // 1. Reset / resolve previous incident
      await prisma.incident.updateMany({
        where: { openSlot: 1 },
        data: { openSlot: null, status: 'resolved', resolvedAt: new Date() },
      });
      detector.resetCooldowns();

      // 2. Start new session with breaches
      const session = `sess_det_reset_run_${run}_${Date.now()}`;
      const now = new Date();

      await prisma.metricSample.create({
        data: {
          sessionId: session,
          service: 'checkout',
          ts: new Date(now.getTime() - 40000),
          requestsTotal: 10,
          successesTotal: 10,
          errorsTotal: 0,
          businessOutcomesTotal: 0,
        },
      });

      // Sample at breach 1
      await prisma.metricSample.create({
        data: {
          sessionId: session,
          service: 'checkout',
          ts: new Date(now.getTime() - 20000),
          requestsTotal: 30,
          successesTotal: 20,
          errorsTotal: 10,
          businessOutcomesTotal: 0,
        },
      });

      await detector.evaluateOnce(session);

      // Sample at breach 2
      await prisma.metricSample.create({
        data: {
          sessionId: session,
          service: 'checkout',
          ts: now,
          requestsTotal: 50,
          successesTotal: 30,
          errorsTotal: 20,
          businessOutcomesTotal: 0,
        },
      });

      const res = await detector.evaluateOnce(session);
      expect(res.breached).toBe(true);

      const activeIncident = await prisma.incident.findFirst({
        where: { openSlot: 1 },
        include: {
          tickets: {
            include: { investigations: true },
          },
        },
      });

      expect(activeIncident).toBeDefined();
      expect(activeIncident?.tickets.length).toBe(1);
      expect(activeIncident?.tickets[0].investigations.length).toBe(1);
    }
  }, 30000);
});
