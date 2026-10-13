import { Router } from 'express';
import { prisma } from '../prisma.js';
import { runInvestigationPipeline } from '../investigation-pipeline.js';

export const ticketsRouter = Router();

// POST /tickets
ticketsRouter.post('/', async (req, res) => {
  const {
    title,
    description = '',
    services = ['checkout'],
    incidentId = null,
    ticketType = 'incident_report',
    requesterId = null,
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const ticket = await prisma.ticket.create({
      data: {
        title,
        description,
        services,
        ticketType,
        incidentId: incidentId || null,
        linkStatus: incidentId ? 'linked' : 'none',
        source: 'user',
        requesterId,
        status: 'open',
      },
    });

    await prisma.auditEvent.create({
      data: {
        incidentId: incidentId || null,
        ticketId: ticket.id,
        actor: 'user',
        actorRole: 'operator',
        type: 'ticket_created',
        evidenceLogIds: [],
        payloadJson: { title, services, incidentId },
      },
    });

    return res.status(201).json({ ticket });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /tickets
ticketsRouter.get('/', async (_req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        incident: true,
        investigations: {
          orderBy: { investigationStartedAt: 'desc' },
        },
      },
    });
    return res.status(200).json({ tickets });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /tickets/:id
ticketsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        incident: true,
        investigations: {
          orderBy: { investigationStartedAt: 'desc' },
        },
        auditEvents: {
          orderBy: { ts: 'asc' },
        },
      },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    return res.status(200).json({ ticket });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /tickets/:id/investigate
ticketsRouter.post('/:id/investigate', async (req, res) => {
  const { id } = req.params;

  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { incident: true },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const investigation = await prisma.investigation.create({
      data: {
        ticketId: ticket.id,
        status: 'running',
        investigationStartedAt: new Date(),
        rootCauses: [],
      },
    });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'investigating' },
    });

    await prisma.auditEvent.create({
      data: {
        incidentId: ticket.incidentId,
        ticketId: ticket.id,
        investigationId: investigation.id,
        actor: 'user',
        actorRole: 'operator',
        type: 'investigation_started',
        evidenceLogIds: [],
        payloadJson: { ticketId: ticket.id, investigationId: investigation.id },
      },
    });

    if (req.query.sync === 'true') {
      const diag = await runInvestigationPipeline(investigation.id);
      const updated = await prisma.investigation.findUnique({
        where: { id: investigation.id },
      });
      return res.status(201).json({ investigation: updated, diagnosis: diag });
    } else {
      runInvestigationPipeline(investigation.id).catch((err) => {
        console.error(`[InvestigateRoute] Error running investigation ${investigation.id}:`, err);
      });
      return res.status(201).json({ investigation });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
