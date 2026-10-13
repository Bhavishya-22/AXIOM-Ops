import { Router } from 'express';
import { pollAllServicesMetrics } from '../metric-poller.js';
import { incidentDetector } from '../detector.js';
import { prisma } from '../prisma.js';

export const scenariosRouter = Router();

scenariosRouter.post('/:name/trigger', async (req, res) => {
  const { name } = req.params;
  const simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000';
  const controlToken = process.env.CONTROL_TOKEN || 'dev-control-token-456';
  const skipBaseline = req.query.skipBaselineCheck !== 'false';

  try {
    const response = await fetch(`${simulatorUrl}/control/trigger/${name}?skipBaselineCheck=${skipBaseline}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${controlToken}`,
      },
      body: JSON.stringify({ skipBaselineCheck: skipBaseline }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Accelerate live detection cycles for responsive interactive demo
    setTimeout(async () => {
      try {
        await pollAllServicesMetrics();
        await incidentDetector.evaluateOnce(data.sessionId);
        setTimeout(async () => {
          await pollAllServicesMetrics();
          await incidentDetector.evaluateOnce(data.sessionId);
        }, 1200);
      } catch {}
    }, 600);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(502).json({
      error: 'Failed to contact simulator',
      details: err.message,
    });
  }
});

scenariosRouter.post('/control/reset', async (_req, res) => {
  const simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000';
  const controlToken = process.env.CONTROL_TOKEN || 'dev-control-token-456';

  try {
    const response = await fetch(`${simulatorUrl}/control/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${controlToken}`,
      },
    });

    const data = await response.json();

    // Clear open incident slot on reset so system returns to clean nominal baseline
    await prisma.incident.updateMany({
      where: { openSlot: 1 },
      data: { openSlot: null, status: 'resolved', resolvedAt: new Date() },
    }).catch(() => {});

    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(502).json({
      error: 'Failed to contact simulator',
      details: err.message,
    });
  }
});
