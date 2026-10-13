import { prisma } from '../prisma.js';
import { SERVICES } from '@axiomops/shared';
import { CAUSES } from '../registry/causes.js';
import {
  ALLOWLIST,
  ActionId,
  ExecutionContext,
  GuardResult,
  Role,
  EvidenceLevel,
} from '@axiomops/shared';

/**
 * Builds typed ExecutionContext strictly from stored database rows.
 * Request bodies are never used to build this context.
 */
export interface BuildExecutionContextInput {
  kind: 'L2' | 'L1';
  ids?: {
    investigationId?: string;
    ticketId?: string;
    demoUserId?: string;
    challengeId?: string;
  };
  investigationId?: string;
  ticketId?: string;
  action?: string;
  approval?: { demoUserId: string; role: Role; at: Date } | null;
  identityProof?: {
    challengeId: string;
    userId: string;
    verifiedAt: Date;
    consumedAt: Date | null;
  } | null;
}

/**
 * Builds typed ExecutionContext strictly from stored database rows.
 * Request bodies are never used to build this context.
 */
export async function buildExecutionContext(input: BuildExecutionContextInput): Promise<ExecutionContext> {
  const kind = input.kind;
  const investigationId = input.ids?.investigationId || input.investigationId;
  const passedTicketId = input.ids?.ticketId || input.ticketId;
  let approval = input.approval;

  if (kind === 'L1') {
    if (!passedTicketId) {
      throw new Error('ticketId is required for L1 execution context.');
    }
    const ticket = await prisma.ticket.findUnique({
      where: { id: passedTicketId },
      include: { incident: true },
    });

    if (!ticket) {
      throw new Error(`Ticket '${passedTicketId}' not found in database.`);
    }

    return {
      kind: 'L1',
      action: 'reset_user_session',
      ticket: {
        id: ticket.id,
        title: ticket.title,
        description: ticket.description,
        services: ticket.services,
        ticketType: ticket.ticketType,
        status: ticket.status,
        incidentId: ticket.incidentId,
        requesterId: ticket.requesterId,
      },
      identityProof: input.identityProof || null,
    };
  }

  // L2 Context
  if (!investigationId) {
    throw new Error('investigationId is required to build L2 execution context.');
  }

  const investigation = await prisma.investigation.findUnique({
    where: { id: investigationId },
    include: { ticket: { include: { incident: true } } },
  });

  if (!investigation) {
    throw new Error(`Investigation '${investigationId}' not found in database.`);
  }

  const ticket = investigation.ticket;
  const incident = investigation.ticket?.incident;
  if (!incident) {
    throw new Error(`Investigation '${investigationId}' is associated with an unlinked ticket.`);
  }

  const rootCause = investigation.rootCauses[0];
  const causeDef = CAUSES[rootCause];
  const action = (input.action || causeDef?.compatibleAction || '') as ActionId;

  const demoUserId = input.ids?.demoUserId || approval?.demoUserId;
  if (demoUserId && !approval) {
    const demoUser = await prisma.demoUser.findUnique({ where: { id: demoUserId } });
    if (demoUser) {
      approval = {
        demoUserId: demoUser.id,
        role: demoUser.role as Role,
        at: new Date(),
      };
    }
  }

  // Find latest diagnosed investigation for this ticket
  const latestDiagnosed = await prisma.investigation.findFirst({
    where: {
      ticketId: ticket.id,
      status: 'done',
      diagnosisStatus: 'diagnosed',
    },
    orderBy: { investigationStartedAt: 'desc' },
  });

  const unresolvedClusters = (investigation.unresolvedClustersJson as any) || [];

  return {
    kind: 'L2',
    action: action as ActionId,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      services: ticket.services,
      ticketType: ticket.ticketType,
      status: ticket.status,
      incidentId: ticket.incidentId,
      requesterId: ticket.requesterId,
    },
    incident: {
      id: incident.id,
      scenarioRunId: incident.scenarioRunId,
      sessionId: incident.sessionId,
      openSlot: incident.openSlot,
      status: incident.status,
      detectedAt: incident.detectedAt,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
    },
    investigation: {
      id: investigation.id,
      ticketId: investigation.ticketId,
      status: investigation.status,
      classification: investigation.classification,
      diagnosisStatus: investigation.diagnosisStatus,
      causeMode: investigation.causeMode,
      actionDisposition: investigation.actionDisposition,
      dispositionReason: investigation.dispositionReason,
      rootCauses: investigation.rootCauses,
      regulatedHold: investigation.regulatedHold,
      evidenceComplete: investigation.evidenceComplete,
      evidenceLevel: investigation.evidenceLevel as EvidenceLevel | null,
    },
    latestEligibleInvestigationId: latestDiagnosed?.id || '',
    evidenceLevel: investigation.evidenceLevel as EvidenceLevel | null,
    evidenceComplete: investigation.evidenceComplete,
    unresolvedClusters,
    approval: approval || null,
  };
}

/**
 * Computes evidence-derived effectiveImpactServices:
 * - ticket.services
 * - incident-scoped services showing technical error rows in the evidence pack
 * - action's target service
 * - services of chosen cause's symptomSignatures that show errors
 */
export function effectiveImpactServices(ctx: ExecutionContext): string[] {
  const impact = new Set<string>(ctx.ticket.services);

  if (ctx.kind === 'L2') {
    const rootCause = ctx.investigation.rootCauses[0];
    const causeDef = CAUSES[rootCause];
    if (causeDef) {
      if (causeDef.targetService) {
        impact.add(causeDef.targetService);
      }
      if (causeDef.symptomSignatures) {
        for (const sig of causeDef.symptomSignatures) {
          impact.add(sig.service);
        }
      }
    }

    // Add any service in unresolvedClusters
    for (const cluster of ctx.unresolvedClusters) {
      impact.add(cluster.service);
    }
  } else {
    // L1 action target service
    impact.add('checkout');
    impact.add('identity-provider');
  }

  return Array.from(impact);
}

/**
 * Shared execution guard: evaluated independently by the Approve API,
 * the remediation executor, and the L1 runbook engine immediately before touching simulator.
 * Fails closed: any failed prerequisite refuses execution.
 */
export function assertExecutionAllowed(ctx: ExecutionContext): GuardResult {
  // Fail-closed sanity check
  if (!ctx || !ctx.ticket) {
    return { allowed: false, disposition: 'refused', reason: 'incomplete_context' };
  }

  const impact = effectiveImpactServices(ctx);

  // 1. Regulated-service hold for BOTH L2 and L1
  const regulatedService = impact.find((s) => SERVICES[s]?.regulated);
  if (regulatedService || (ctx.kind === 'L2' && ctx.investigation.regulatedHold)) {
    return {
      allowed: false,
      disposition: 'manual_recommended',
      reason: 'regulated_service_requires_change_control',
      effectiveImpact: impact,
    };
  }

  // 2. L2 prerequisites
  if (ctx.kind === 'L2') {
    const { action, ticket, incident, investigation, latestEligibleInvestigationId, approval } = ctx;

    if (!ALLOWLIST.includes(action)) {
      return { allowed: false, disposition: 'refused', reason: 'action_not_allowlisted' };
    }

    const rootCause = investigation.rootCauses[0];
    const causeDef = CAUSES[rootCause];
    if (!causeDef) {
      return { allowed: false, disposition: 'refused', reason: 'unknown_root_cause' };
    }

    if (causeDef.compatibleAction !== action) {
      return { allowed: false, disposition: 'refused', reason: 'action_incompatible_with_cause' };
    }

    if (!causeDef.executable) {
      return { allowed: false, disposition: 'refused', reason: 'action_not_supported_executable' };
    }

    if (investigation.diagnosisStatus !== 'diagnosed') {
      return { allowed: false, disposition: 'refused', reason: 'investigation_not_diagnosed' };
    }

    if (investigation.causeMode !== 'single') {
      return { allowed: false, disposition: 'refused', reason: 'compound_or_non_single_cause' };
    }

    if (investigation.actionDisposition !== 'executable') {
      return { allowed: false, disposition: 'refused', reason: 'action_disposition_not_executable' };
    }

    if (!ticket.incidentId || ticket.incidentId !== incident.id) {
      return { allowed: false, disposition: 'refused', reason: 'unlinked_ticket' };
    }

    if (incident.status !== 'open') {
      return { allowed: false, disposition: 'refused', reason: 'incident_closed' };
    }

    if (latestEligibleInvestigationId !== investigation.id) {
      return { allowed: false, disposition: 'refused', reason: 'outdated_investigation' };
    }

    if (ctx.evidenceLevel === 'Weak' || !ctx.evidenceLevel) {
      return { allowed: false, disposition: 'refused', reason: 'weak_evidence_level' };
    }

    if (!ctx.evidenceComplete) {
      return { allowed: false, disposition: 'refused', reason: 'evidence_gap' };
    }

    if (ctx.unresolvedClusters.some((c) => c.material)) {
      return { allowed: false, disposition: 'refused', reason: 'material_unresolved_cluster' };
    }

    if (!approval || !approval.demoUserId || !approval.role) {
      return { allowed: false, disposition: 'refused', reason: 'missing_approval' };
    }
  } else {
    // 3. L1 prerequisites
    if (ctx.action !== 'reset_user_session') {
      return { allowed: false, disposition: 'refused', reason: 'unsupported_l1_action' };
    }

    const { identityProof, ticket } = ctx;
    if (!identityProof) {
      return { allowed: false, disposition: 'refused', reason: 'missing_identity_proof' };
    }

    if (identityProof.consumedAt !== null) {
      return { allowed: false, disposition: 'refused', reason: 'identity_proof_already_consumed' };
    }

    if (!ticket.requesterId || identityProof.userId !== ticket.requesterId) {
      return { allowed: false, disposition: 'refused', reason: 'identity_proof_user_mismatch' };
    }
  }

  return { allowed: true };
}
