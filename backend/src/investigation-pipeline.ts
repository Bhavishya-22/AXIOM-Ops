import { prisma } from './prisma.js';
import { computeEvidenceWindow, pinIncidentLogs } from './window.js';
import { buildEvidencePack, traverseServiceScope } from './evidence-builder.js';
import { scoreHypothesis } from './scorer.js';
import {
  generateDeterministicExplanation,
  validateDiagnosisOutput,
  executeLlmDiagnosis,
  computeEvidenceLevel,
  DiagnosisOutput,
} from './diagnosis.js';
import { retrieveTopHistoricalCases } from './history.js';
import { SERVICES } from '@axiomops/shared';

/**
 * Executes the complete investigation pipeline for an investigation record.
 */
export async function runInvestigationPipeline(investigationId: string): Promise<DiagnosisOutput> {
  const investigation = await prisma.investigation.findUnique({
    where: { id: investigationId },
    include: {
      ticket: {
        include: {
          incident: true,
        },
      },
    },
  });

  if (!investigation) {
    throw new Error(`Investigation with ID '${investigationId}' not found.`);
  }

  const { ticket } = investigation;
  const incident = ticket.incident;
  const sessionId = incident?.sessionId || 'default_session';
  const detectedAt = incident?.detectedAt || investigation.investigationStartedAt;
  const investigationStartedAt = investigation.investigationStartedAt;
  const scopedServices = traverseServiceScope(ticket.services);

  try {
    // 1. Window computation & log pinning
    const windowResult = await computeEvidenceWindow({
      detectedAt,
      investigationStartedAt,
      scopedServices,
      sessionId,
    });

    if (incident) {
      await pinIncidentLogs(incident.id, sessionId, windowResult.windowStart);
    }

    // 2. Build Evidence Pack
    const pack = await buildEvidencePack({
      sessionId,
      ticketServices: ticket.services,
      windowStart: windowResult.windowStart,
      windowEnd: windowResult.windowEnd,
    });

    // Write AuditEvent: evidence_assembled
    await prisma.auditEvent.create({
      data: {
        incidentId: incident?.id,
        ticketId: ticket.id,
        investigationId: investigation.id,
        actor: 'system',
        type: 'evidence_assembled',
        evidenceLogIds: pack.nodes.slice(0, 5).map((n) => n.nodeId),
        payloadJson: {
          nodeCount: pack.nodes.length,
          windowStart: pack.windowStart,
          windowEnd: pack.windowEnd,
          isComplete: windowResult.isComplete,
        },
      },
    });

    // 3. Hypothesis Scorer
    const scorerResult = scoreHypothesis(pack);

    // Write AuditEvent: hypothesis_scored
    await prisma.auditEvent.create({
      data: {
        incidentId: incident?.id,
        ticketId: ticket.id,
        investigationId: investigation.id,
        actor: 'system',
        type: 'hypothesis_scored',
        evidenceLogIds: [],
        payloadJson: {
          classification: scorerResult.classification,
          status: scorerResult.status,
          causeMode: scorerResult.causeMode,
          shortlist: scorerResult.shortlist,
          suppressed: scorerResult.suppressed as any,
        } as any,
      },
    });

    // 4. Retrieve Historical Cases
    const presentSignals = pack.nodes.filter((n) => n.signal).map((n) => n.signal as string);
    const topHistorical = await retrieveTopHistoricalCases(presentSignals, pack.scopedServices, 3);

    let diag: DiagnosisOutput;

    // 5. LLM Call or Deterministic Explanation
    if (scorerResult.status === 'diagnosed' && scorerResult.causeMode === 'single') {
      const llmOutput = await executeLlmDiagnosis({
        pack,
        shortlist: scorerResult.shortlist || [],
        historyCases: topHistorical,
        startedAtMs: investigationStartedAt.getTime(),
      });

      if (llmOutput) {
        const val = validateDiagnosisOutput(llmOutput, scorerResult, pack, topHistorical);
        if (val.valid) {
          const rootCause = llmOutput.rootCauseCategory;
          const levelInfo = computeEvidenceLevel({
            causeId: rootCause,
            pack,
            citedLogIds: llmOutput.evidenceLogIds,
            isSeparated: true,
            hasMaterialCluster: scorerResult.unresolvedClusters.some((c) => c.material),
            isEvidenceComplete: windowResult.isComplete,
            matchedCase: topHistorical.find((c) => c.id === llmOutput.historicalCaseId) || null,
          });

          diag = {
            classification: 'incident',
            diagnosisStatus: 'diagnosed',
            causeMode: 'single',
            actionDisposition: 'executable',
            dispositionReason: null,
            rootCauses: [rootCause],
            explanation: llmOutput.explanation,
            evidenceLogIds: llmOutput.evidenceLogIds,
            evidenceLevel: levelInfo.level,
            levelReasons: levelInfo.reasons,
            historicalCaseId: llmOutput.historicalCaseId || null,
            actionId: llmOutput.actionId || null,
            prevention: llmOutput.prevention || [],
            missingEvidence: [],
          };
        } else {
          // Validation failed, fallback to deterministic
          diag = generateDeterministicExplanation(scorerResult, pack);
        }
      } else {
        // Deterministic template
        diag = generateDeterministicExplanation(scorerResult, pack);
        // Attach best matching historical case if available
        if (topHistorical.length > 0 && diag.rootCauses.length > 0) {
          const matched = topHistorical.find((c) => c.rootCause === diag.rootCauses[0]);
          if (matched) {
            diag.historicalCaseId = matched.id;
          }
        }
      }
    } else {
      diag = generateDeterministicExplanation(scorerResult, pack);
    }

    // 6. Execution Guard & Regulatory Hold Checks
    // Check if any error row in the pack affects a regulated service (e.g. batch-record-service)
    const hasRegulatedError = pack.nodes.some(
      (n) => SERVICES[n.service]?.regulated && (n.level === 'ERROR' || n.level === 'WARN')
    );
    const regulatedHold = hasRegulatedError;

    if (regulatedHold) {
      diag.actionDisposition = 'manual_recommended';
      diag.dispositionReason = 'regulated_service_requires_change_control';
    }

    // If material cluster exists or evidence incomplete, downgrade disposition and level
    if (scorerResult.unresolvedClusters.some((c) => c.material)) {
      diag.actionDisposition = 'manual_recommended';
      diag.dispositionReason = 'unexplained_error_cluster';
      diag.evidenceLevel = 'Weak';
    }

    if (!windowResult.isComplete) {
      diag.actionDisposition = 'manual_recommended';
      diag.dispositionReason = 'evidence_gap';
      diag.evidenceLevel = 'Weak';
    }

    // Unlinked tickets are manual-only
    if (!incident) {
      diag.actionDisposition = 'manual_recommended';
      diag.dispositionReason = 'unscoped_evidence_unlinked_ticket';
    }

    // 7. Persist Investigation Outcome
    const outcomeAt = new Date();
    await prisma.investigation.update({
      where: { id: investigation.id },
      data: {
        status: 'done',
        classification: diag.classification,
        diagnosisStatus: diag.diagnosisStatus,
        causeMode: diag.causeMode,
        actionDisposition: diag.actionDisposition,
        dispositionReason: diag.dispositionReason,
        rootCauses: diag.rootCauses,
        suppressedJson: scorerResult.suppressed as any,
        unresolvedClustersJson: scorerResult.unresolvedClusters as any,
        effectiveImpactJson: pack.scopedServices as any,
        regulatedHold,
        evidenceComplete: windowResult.isComplete,
        evidenceLevel: diag.evidenceLevel,
        levelReasonsJson: diag.levelReasons as any,
        evidenceSnapshotJson: {
          compactNodes: pack.compactNodes,
          windowStart: pack.windowStart,
          windowEnd: pack.windowEnd,
        } as any,
        resultJson: {
          explanation: diag.explanation,
          actionId: diag.actionId,
          historicalCaseId: diag.historicalCaseId,
          prevention: diag.prevention,
          missingEvidence: diag.missingEvidence,
        } as any,
        outcomeAt,
      },
    });

    // 8. Update Ticket status
    let ticketStatus = ticket.status;
    if (diag.diagnosisStatus === 'diagnosed') {
      ticketStatus = diag.actionDisposition === 'executable' ? 'awaiting_approval' : 'investigating';
    } else if (diag.diagnosisStatus === 'not_an_incident') {
      ticketStatus = 'not_an_incident';
    } else if (diag.diagnosisStatus === 'insufficient_evidence') {
      ticketStatus = 'insufficient_evidence';
    } else if (diag.diagnosisStatus === 'ambiguous_multiple_causes') {
      ticketStatus = 'ambiguous';
    }

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: ticketStatus },
    });

    // 9. Write AuditEvent: diagnosis_completed
    await prisma.auditEvent.create({
      data: {
        incidentId: incident?.id,
        ticketId: ticket.id,
        investigationId: investigation.id,
        actor: 'system',
        type: 'diagnosis_completed',
        evidenceLogIds: diag.evidenceLogIds,
        payloadJson: {
          diagnosisStatus: diag.diagnosisStatus,
          causeMode: diag.causeMode,
          rootCauses: diag.rootCauses,
          actionId: diag.actionId,
          actionDisposition: diag.actionDisposition,
          dispositionReason: diag.dispositionReason,
          evidenceLevel: diag.evidenceLevel,
          regulatedHold,
        },
      },
    });

    return diag;
  } catch (err: any) {
    console.error(`[InvestigationPipeline] Error running investigation ${investigationId}:`, err);
    await prisma.investigation.update({
      where: { id: investigation.id },
      data: {
        status: 'failed',
        outcomeAt: new Date(),
        dispositionReason: err.message || 'internal_error',
      },
    });

    await prisma.auditEvent.create({
      data: {
        incidentId: incident?.id,
        ticketId: ticket.id,
        investigationId: investigation.id,
        actor: 'system',
        type: 'investigation_failed',
        evidenceLogIds: [],
        payloadJson: { error: err.message },
      },
    });

    throw err;
  }
}

/**
 * Startup sweep to mark any dangling 'running' investigations as 'failed'.
 */
export async function startupInvestigationSweep(): Promise<number> {
  const stale = await prisma.investigation.findMany({
    where: { status: 'running' },
  });

  for (const inv of stale) {
    await prisma.investigation.update({
      where: { id: inv.id },
      data: {
        status: 'failed',
        outcomeAt: new Date(),
        dispositionReason: 'interrupted_by_server_restart',
      },
    });

    await prisma.auditEvent.create({
      data: {
        investigationId: inv.id,
        actor: 'system',
        type: 'investigation_stale_aborted',
        evidenceLogIds: [],
        payloadJson: { reason: 'server_restart' },
      },
    });
  }

  return stale.length;
}
