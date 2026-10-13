import { prisma } from './prisma.js';
import { Prisma } from '@prisma/client';

export interface CreateIncidentResult {
  incident: any;
  ticket: any;
  investigation: any;
  isExisting: boolean;
}

/**
 * Creates Incident, auto-Ticket, and auto-Investigation in one transactional operation.
 * Enforces database invariants (openSlot=1, Ticket.autoKey=incidentId, Investigation.autoKey=ticketId).
 * On unique violation, returns the existing open incident structure.
 */
export async function createIncidentTransaction(params: {
  sessionId: string;
  scenarioRunId?: string | null;
  services?: string[];
  detectedAt?: Date;
  humanDetectedAt?: Date | null;
  title?: string;
  description?: string;
  baselineMetricsJson?: any;
}): Promise<CreateIncidentResult> {
  const {
    sessionId,
    scenarioRunId,
    services = ['checkout'],
    detectedAt = new Date(),
    humanDetectedAt = null,
    title,
    description,
    baselineMetricsJson,
  } = params;

  try {
    return await prisma.$transaction(async (tx) => {
      // Check if open incident already exists
      const existingOpen = await tx.incident.findFirst({
        where: { openSlot: 1 },
        include: {
          tickets: {
            include: {
              investigations: true,
            },
          },
        },
      });

      if (existingOpen) {
        const ticket = existingOpen.tickets[0] || null;
        const investigation = ticket?.investigations[0] || null;
        return {
          incident: existingOpen,
          ticket,
          investigation,
          isExisting: true,
        };
      }

      // 1. Create Incident with openSlot: 1
      const incident = await tx.incident.create({
        data: {
          sessionId,
          scenarioRunId: scenarioRunId ?? null,
          openSlot: 1,
          status: 'open',
          detectedAt,
          startedAt: detectedAt,
          humanDetectedAt: humanDetectedAt ?? null,
          baselineMetricsJson: baselineMetricsJson ?? null,
        },
      });

      // 2. Create auto-ticket
      const ticketTitle =
        title ||
        (humanDetectedAt
          ? `User reported incident on ${services.join(', ')}`
          : `Auto-detected service anomaly on ${services.join(', ')}`);

      const ticket = await tx.ticket.create({
        data: {
          title: ticketTitle,
          description: description || 'Technical error rate breach detected on telemetry',
          services,
          ticketType: 'incident_report',
          status: 'investigating',
          incidentId: incident.id,
          linkStatus: 'linked',
          source: humanDetectedAt ? 'user' : 'auto',
          autoKey: incident.id, // unique invariant
        },
      });

      // 3. Create auto-investigation
      const investigation = await tx.investigation.create({
        data: {
          ticketId: ticket.id,
          status: 'running',
          investigationStartedAt: new Date(),
          autoKey: ticket.id, // unique invariant
          rootCauses: [],
        },
      });

      return {
        incident,
        ticket,
        investigation,
        isExisting: false,
      };
    });
  } catch (err: any) {
    // Handle Prisma unique constraint violation (P2002) concurrently
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existingOpen = await prisma.incident.findFirst({
        where: { openSlot: 1 },
        include: {
          tickets: {
            include: {
              investigations: true,
            },
          },
        },
      });

      if (existingOpen) {
        const ticket = existingOpen.tickets[0] || null;
        const investigation = ticket?.investigations[0] || null;
        return {
          incident: existingOpen,
          ticket,
          investigation,
          isExisting: true,
        };
      }
    }
    throw err;
  }
}
