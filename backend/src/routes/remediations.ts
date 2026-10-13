import { Router, Request, Response } from 'express';
import { prisma } from '../prisma.js';
import { authenticateDemoToken } from '../auth/demo-auth.js';
import { buildExecutionContext, assertExecutionAllowed } from '../policy/execution-guard.js';
import { executeRemediation } from '../remediation/executor.js';
import { CAUSES } from '../registry/causes.js';
import { ActionId } from '@axiomops/shared';

export const remediationsRouter = Router();

// GET /remediations/:id
remediationsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const remediation = await prisma.remediationRun.findUnique({
      where: { id },
      include: {
        incident: true,
        investigation: true,
        auditEvents: {
          orderBy: { ts: 'asc' },
        },
      },
    });

    if (!remediation) {
      return res.status(404).json({ error: 'Remediation run not found' });
    }

    return res.status(200).json({ remediation });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to process approval on an investigation
 */
export async function handleApproveInvestigation(
  req: Request,
  res: Response,
  investigationId: string
) {
  // 1. Authenticate demo token and derive approverRole strictly from DemoUser table
  const authHeader = req.headers.authorization;
  const user = await authenticateDemoToken(authHeader);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: valid demo token required' });
  }

  try {
    const investigation = await prisma.investigation.findUnique({
      where: { id: investigationId },
      include: {
        ticket: {
          include: { incident: true },
        },
      },
    });

    if (!investigation) {
      return res.status(404).json({ error: 'Investigation not found' });
    }

    const incidentId = investigation.ticket?.incidentId;

    const rootCause = investigation.rootCauses?.[0];
    const causeDef = rootCause ? CAUSES[rootCause] : undefined;
    const actionId = (causeDef?.compatibleAction || '') as ActionId;

    // 2. Build execution context from stored rows only
    const ctx = await buildExecutionContext({
      kind: 'L2',
      ids: {
        investigationId,
        demoUserId: user.id,
      },
      action: actionId,
    });

    // 3. Evaluate shared execution guard
    const guardResult = assertExecutionAllowed(ctx);

    if (!guardResult.allowed) {
      const effectiveImpact = 'effectiveImpact' in guardResult ? guardResult.effectiveImpact : undefined;

      // Audit rejected approval
      await prisma.auditEvent.create({
        data: {
          actor: user.id,
          actorRole: user.role,
          type: 'approval_rejected',
          investigationId,
          ticketId: investigation.ticketId,
          incidentId: incidentId || null,
          payloadJson: {
            reason: guardResult.reason,
            disposition: guardResult.disposition,
            effectiveImpact,
          },
        },
      });

      // Special handling for regulated hold (Section 14 & Item 7)
      if (guardResult.reason === 'regulated_service_requires_change_control') {
        await prisma.investigation.update({
          where: { id: investigationId },
          data: {
            regulatedHold: true,
            dispositionReason: 'regulated_service_requires_change_control',
          },
        });

        await prisma.auditEvent.create({
          data: {
            actor: 'system',
            type: 'change_control_required',
            investigationId,
            ticketId: investigation.ticketId,
            incidentId: incidentId || null,
            payloadJson: {
              diagnosis: investigation.rootCauses,
              impactServices: effectiveImpact,
              recommendedAction: causeDef?.compatibleAction,
              owningTeam: 'identity-and-access',
              regulatedHold: true,
            },
          },
        });

        return res.status(409).json({
          error: 'Execution disallowed by policy: regulated service requires change control',
          reason: guardResult.reason,
          disposition: guardResult.disposition,
          regulatedHold: true,
          effectiveImpact,
        });
      }

      // Other 409 policy rejections: unlinked tickets, outdated, Weak, gaps, material clusters, etc.
      return res.status(409).json({
        error: 'Execution disallowed by policy',
        reason: guardResult.reason,
        disposition: guardResult.disposition,
        effectiveImpact,
      });
    }

    // 4. Guard passed: prepare idempotency and action
    const idempotencyKey =
      (req.body?.idempotencyKey as string) || `${investigationId}-${actionId}`;

    // Return existing run if idempotencyKey already processed
    const existingRun = await prisma.remediationRun.findUnique({
      where: { idempotencyKey },
    });
    if (existingRun) {
      return res.status(200).json({
        remediation: existingRun,
        idempotencyReplay: true,
      });
    }

    if (!incidentId) {
      return res.status(409).json({ error: 'Ticket must have linked incident' });
    }

    // 5. Create RemediationRun protected by activeIncidentId / one_active_remediation index
    try {
      const run = await prisma.remediationRun.create({
        data: {
          incidentId,
          investigationId,
          attemptId: `att-${Date.now()}`,
          actionId,
          idempotencyKey,
          executionState: 'pending',
          status: 'in_progress',
          activeIncidentId: incidentId, // Enforces one active remediation per incident
          approvedBy: user.id,
          approverRole: user.role, // Server-derived role
          approvedAt: new Date(),
        },
      });

      // Audit approval granted
      await prisma.auditEvent.create({
        data: {
          actor: user.id,
          actorRole: user.role,
          type: 'approval_granted',
          incidentId,
          investigationId,
          ticketId: investigation.ticketId,
          remediationRunId: run.id,
          payloadJson: {
            actionId,
            idempotencyKey,
            approverRole: user.role,
          },
        },
      });

      const isBroken = req.query.mode === 'broken' || req.body?.mode === 'broken';
      const isSync = req.query.sync === 'true' || req.body?.sync === 'true';

      if (isSync) {
        const completed = await executeRemediation(run.id, { brokenMode: isBroken });
        return res.status(200).json({ remediation: completed });
      } else {
        executeRemediation(run.id, { brokenMode: isBroken }).catch((err) => {
          console.error(`[Remediation] Execution error for run ${run.id}:`, err);
        });
        return res.status(200).json({ remediation: run });
      }
    } catch (err: any) {
      // Catch unique violation (P2002) for one_active_remediation / activeIncidentId
      if (err.code === 'P2002') {
        const activeRun = await prisma.remediationRun.findFirst({
          where: {
            incidentId,
            status: 'in_progress',
          },
        });
        if (activeRun) {
          return res.status(200).json({
            remediation: activeRun,
            note: 'active_remediation_already_running',
          });
        }
      }
      throw err;
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
