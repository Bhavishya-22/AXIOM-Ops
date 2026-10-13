import { Router } from 'express';
import { prisma } from '../prisma.js';
import { runInvestigationPipeline } from '../investigation-pipeline.js';
import { classifyTicket } from '../l1/classifier.js';
import { evaluateDuplicateLinking } from '../l1/duplicate-linker.js';
import { createIdentityChallenge, executeSessionResetRunbook } from '../l1/session-reset.js';
import { SEED_RUNBOOKS } from '../l1/runbooks.js';

export const ticketsRouter = Router();

// POST /tickets
ticketsRouter.post('/', async (req, res) => {
  const {
    title,
    description = '',
    services = ['checkout'],
    incidentId = null,
    requesterId = null,
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    // 1. Classifier and triage per Section 15
    const classification = classifyTicket(title, description, services);
    const assignedType = req.body.ticketType || classification.ticketType;

    // 2. Conservative duplicate linking per Section 15
    let finalIncidentId = incidentId;
    let linkStatus = incidentId ? 'linked' : 'none';

    // If an open incident exists, evaluate conservative duplicate criteria
    const openIncident = await prisma.incident.findFirst({
      where: { status: 'open' },
      orderBy: { detectedAt: 'desc' },
    });

    if (openIncident) {
      const linkEval = await evaluateDuplicateLinking({
        ticketServices: services,
        ticketCreatedAt: new Date(),
        ticketText: `${title} ${description}`,
        incidentId: openIncident.id,
      });

      if (linkEval.linkStatus === 'linked') {
        finalIncidentId = openIncident.id;
        linkStatus = 'linked';
      } else if (linkEval.linkStatus === 'possible_duplicate') {
        // Kept separate as possible_duplicate until confirmed
        linkStatus = 'possible_duplicate';
      }
    }

    const ticket = await prisma.ticket.create({
      data: {
        title,
        description,
        services,
        ticketType: assignedType,
        incidentId: finalIncidentId || null,
        linkStatus,
        source: 'user',
        requesterId,
        status: classification.isNotAnIncident ? 'resolved' : 'open',
      },
    });

    await prisma.auditEvent.create({
      data: {
        incidentId: finalIncidentId || null,
        ticketId: ticket.id,
        actor: 'user',
        actorRole: 'operator',
        type: 'ticket_created',
        evidenceLogIds: [],
        payloadJson: {
          title,
          services,
          incidentId: finalIncidentId,
          classification: classification.ticketType,
          linkStatus,
          isNotAnIncident: classification.isNotAnIncident,
        },
      },
    });

    return res.status(201).json({
      ticket,
      classification,
      runbook: classification.runbook,
      explanation: classification.explanation,
    });
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

// POST /tickets/:id/identity-challenge (Item 10)
ticketsRouter.post('/:id/identity-challenge', async (req, res) => {
  const { id } = req.params;

  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const userId = ticket.requesterId || req.body.userId || 'user-default';
    const challenge = await createIdentityChallenge(userId);

    await prisma.auditEvent.create({
      data: {
        ticketId: ticket.id,
        actor: 'system',
        type: 'identity_challenge_issued',
        payloadJson: {
          challengeId: challenge.challengeId,
          userId: challenge.userId,
          simulated: true,
        },
      },
    });

    return res.status(200).json({
      ...challenge,
      note: 'Simulated one-time-code identity proof; production uses SSO and MFA.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /tickets/:id/run-runbook (Item 10)
ticketsRouter.post('/:id/run-runbook', async (req, res) => {
  const { id } = req.params;
  const { runbookId = 'reset_user_session', challengeId, code } = req.body;

  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (runbookId === 'reset_user_session') {
      if (!challengeId || !code) {
        return res.status(400).json({
          error: 'Missing required identity proof (challengeId and code are required)',
        });
      }

      const result = await executeSessionResetRunbook({
        ticketId: id,
        challengeId,
        code,
      });

      return res.status(200).json(result);
    }

    // For other runbooks (e.g. how-tos)
    const runbook = SEED_RUNBOOKS[runbookId];
    if (!runbook) {
      return res.status(404).json({ error: `Runbook ${runbookId} not found` });
    }

    return res.status(200).json({
      runbook,
      message: 'Runbook instructions returned. Awaiting user confirmation to resolve.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// POST /tickets/:id/confirm-resolve
ticketsRouter.post('/:id/confirm-resolve', async (req, res) => {
  const { id } = req.params;

  try {
    const updated = await prisma.ticket.update({
      where: { id },
      data: { status: 'resolved' },
    });

    await prisma.auditEvent.create({
      data: {
        ticketId: id,
        actor: 'user',
        actorRole: 'operator',
        type: 'ticket_confirmed_resolved',
        payloadJson: { confirmedAt: new Date() },
      },
    });

    return res.status(200).json({ ticket: updated, status: 'resolved' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
