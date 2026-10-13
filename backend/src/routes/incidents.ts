import { Router } from 'express';
import { prisma } from '../prisma.js';
import { createIncidentTransaction } from '../incident-lifecycle.js';
import { runInvestigationPipeline } from '../investigation-pipeline.js';

export const incidentsRouter = Router();

// GET /incidents/active
incidentsRouter.get('/active', async (_req, res) => {
  try {
    const incident = await prisma.incident.findFirst({
      where: { openSlot: 1 },
      include: {
        tickets: {
          include: {
            investigations: {
              orderBy: { investigationStartedAt: 'desc' },
            },
          },
        },
      },
    });

    if (!incident) {
      return res.status(200).json({ incident: null });
    }

    return res.status(200).json({ incident });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /incidents/report (Mode B: manual incident report)
incidentsRouter.post('/report', async (req, res) => {
  const { title, description, services = ['checkout'], sessionId: customSessionId } = req.body;

  try {
    // If sessionId not provided, take latest sessionId from metric samples or logs
    let sessionId = customSessionId;
    if (!sessionId) {
      const latestMetric = await prisma.metricSample.findFirst({
        orderBy: { ts: 'desc' },
        select: { sessionId: true },
      });
      sessionId = latestMetric?.sessionId || 'manual_session_' + Date.now();
    }

    const now = new Date();
    const result = await createIncidentTransaction({
      sessionId,
      services,
      detectedAt: now,
      humanDetectedAt: now,
      title: title || `Manual report on ${services.join(', ')}`,
      description: description || 'Reported manually via Mode B cockpit',
    });

    // Write audit event
    await prisma.auditEvent.create({
      data: {
        incidentId: result.incident.id,
        ticketId: result.ticket?.id,
        actor: 'user',
        actorRole: 'operator',
        type: 'incident_reported_mode_b',
        evidenceLogIds: [],
        payloadJson: { services, humanDetectedAt: now },
      },
    });

    // If auto-investigation created, start pipeline
    if (!result.isExisting && result.investigation) {
      if (req.query.sync === 'true') {
        await runInvestigationPipeline(result.investigation.id);
      } else {
        runInvestigationPipeline(result.investigation.id).catch((e) =>
          console.error('[ModeB] Background investigation error:', e)
        );
      }
    }

    return res.status(201).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /incidents/:id/audit
incidentsRouter.get('/:id/audit', async (req, res) => {
  const { id } = req.params;
  try {
    const events = await prisma.auditEvent.findMany({
      where: { incidentId: id },
      orderBy: { ts: 'asc' },
    });
    return res.status(200).json({ events });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
