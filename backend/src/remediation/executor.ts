import { prisma } from '../prisma.js';
import { buildExecutionContext, assertExecutionAllowed } from '../policy/execution-guard.js';
import { runVerification, VerificationOutcome } from '../verify/verifier.js';
import { pollAllServicesMetrics } from '../metric-poller.js';

export interface ExecuteRemediationOptions {
  brokenMode?: boolean;
}

/**
 * Execute remediation state machine per Section 12:
 * pending -> apply_sent -> apply_confirmed -> verifying -> finished
 */
export async function executeRemediation(
  remediationRunId: string,
  options: ExecuteRemediationOptions = {}
): Promise<any> {
  const run = await prisma.remediationRun.findUnique({
    where: { id: remediationRunId },
    include: {
      incident: true,
      investigation: {
        include: { ticket: true },
      },
    },
  });

  if (!run) {
    throw new Error(`RemediationRun ${remediationRunId} not found`);
  }

  const { incident, investigation } = run;
  const simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000';
  const controlToken = process.env.CONTROL_TOKEN || 'dev-control-token-456';

  // 1. Independent execution guard assertion immediately before touching simulator
  const ctx = await buildExecutionContext({
    kind: 'L2',
    ids: {
      investigationId: run.investigationId,
      demoUserId: run.approvedBy,
    },
  });

  const guardResult = assertExecutionAllowed(ctx);
  if (!guardResult.allowed) {
    await prisma.remediationRun.update({
      where: { id: run.id },
      data: {
        status: 'refused',
        executionState: 'finished',
        outcome: 'verification_failed',
        activeIncidentId: null,
      },
    });

    await prisma.auditEvent.create({
      data: {
        actor: 'system',
        type: 'execution_guard_refused',
        incidentId: run.incidentId,
        investigationId: run.investigationId,
        remediationRunId: run.id,
        payloadJson: {
          reason: guardResult.reason,
          disposition: guardResult.disposition,
        },
      },
    });

    throw new Error(`Execution disallowed by guard: ${guardResult.reason}`);
  }

  // 2. Persist state: apply_sent before calling the simulator
  await prisma.remediationRun.update({
    where: { id: run.id },
    data: { executionState: 'apply_sent' },
  });

  // Snapshot applied counters and incident metrics
  await pollAllServicesMetrics(simulatorUrl).catch(() => {});
  const latestSamples = await prisma.metricSample.findMany({
    where: { sessionId: incident.sessionId },
    orderBy: { ts: 'desc' },
  });

  const appliedCounters: Record<string, any> = {};
  for (const sample of latestSamples) {
    if (!appliedCounters[sample.service]) {
      appliedCounters[sample.service] = {
        requestsTotal: sample.requestsTotal,
        successesTotal: sample.successesTotal,
        errorsTotal: sample.errorsTotal,
        ...(typeof sample.scenarioCountersJson === 'object' && sample.scenarioCountersJson !== null
          ? (sample.scenarioCountersJson as Record<string, any>)
          : {}),
      };
    }
  }

  // 3. Make HTTP call to simulator fix endpoint
  const brokenQuery = options.brokenMode ? '?mode=broken' : '';
  const fixUrl = `${simulatorUrl}/control/fix/${run.actionId}${brokenQuery}`;
  const fixRes = await fetch(fixUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      scenarioRunId: incident.scenarioRunId,
      attemptId: run.id,
      mode: options.brokenMode ? 'broken' : undefined,
    }),
  });

  if (!fixRes.ok) {
    const errorText = await fixRes.text().catch(() => '');
    throw new Error(`Simulator fix failed with status ${fixRes.status}: ${errorText}`);
  }

  const fixData = (await fixRes.json().catch(() => ({}))) as any;
  const appliedAt = new Date();

  // 4. Persist apply_confirmed
  await prisma.remediationRun.update({
    where: { id: run.id },
    data: {
      executionState: 'apply_confirmed',
      appliedAt,
      appliedCountersJson: appliedCounters,
      incidentMetricsJson: latestSamples.slice(0, 5) as any,
    },
  });

  await prisma.auditEvent.create({
    data: {
      actor: run.approvedBy,
      actorRole: run.approverRole,
      type: 'action_applied',
      incidentId: run.incidentId,
      investigationId: run.investigationId,
      remediationRunId: run.id,
      payloadJson: {
        actionId: run.actionId,
        attemptId: run.id,
        mode: fixData?.mode || 'normal',
      },
    },
  });

  // 5. Persist state: verifying
  await prisma.remediationRun.update({
    where: { id: run.id },
    data: { executionState: 'verifying' },
  });

  // 6. Polling verification loop: poll every 3 s up to 30 s
  let finalOutcome: VerificationOutcome | null = null;
  const maxPolls = 10;
  const pollIntervalMs = 3000;

  for (let poll = 0; poll < maxPolls; poll++) {
    // Wait interval
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    await pollAllServicesMetrics(simulatorUrl).catch(() => {});

    finalOutcome = await runVerification({
      actionId: run.actionId,
      sessionId: incident.sessionId,
      appliedAt,
      appliedCounters,
      baselineMetrics: {},
      simulatorUrl,
      controlToken,
      attemptId: run.id,
      scenarioRunId: incident.scenarioRunId || 'run-default',
    });

    if (finalOutcome.outcome === 'resolved') {
      break;
    }
  }

  if (!finalOutcome) {
    finalOutcome = {
      outcome: 'verification_failed',
      checks: [],
      metricChecks: [],
      reasons: ['verification_timeout_without_samples'],
    };
  }

  // 7. Snapshot after-metrics
  await pollAllServicesMetrics(simulatorUrl).catch(() => {});
  const afterSamples = await prisma.metricSample.findMany({
    where: { sessionId: incident.sessionId },
    orderBy: { ts: 'desc' },
    take: 5,
  });

  const isResolved = finalOutcome.outcome === 'resolved';

  // 8. Update RemediationRun to finished & clear activeIncidentId
  const updatedRun = await prisma.remediationRun.update({
    where: { id: run.id },
    data: {
      executionState: 'finished',
      status: finalOutcome.outcome,
      outcome: finalOutcome.outcome,
      verificationJson: finalOutcome as any,
      afterMetricsJson: afterSamples as any,
      activeIncidentId: null, // frees the one_active_remediation slot
    },
  });

  await prisma.auditEvent.create({
    data: {
      actor: 'system',
      type: 'verification_finished',
      incidentId: run.incidentId,
      investigationId: run.investigationId,
      remediationRunId: run.id,
      payloadJson: {
        outcome: finalOutcome.outcome,
        checks: finalOutcome.checks as any,
        reasons: finalOutcome.reasons,
      } as any,
    },
  });

  // 9. Close incident and ticket only on resolved
  if (isResolved) {
    await prisma.incident.update({
      where: { id: run.incidentId },
      data: {
        status: 'resolved',
        openSlot: null,
        resolvedAt: new Date(),
      },
    });

    // Linked tickets resolve with same evidence
    await prisma.ticket.updateMany({
      where: { incidentId: run.incidentId },
      data: { status: 'resolved' },
    });

    await prisma.auditEvent.create({
      data: {
        actor: 'system',
        type: 'incident_resolved',
        incidentId: run.incidentId,
        investigationId: run.investigationId,
        remediationRunId: run.id,
        payloadJson: {
          runId: run.id,
          actionId: run.actionId,
          resolvedAt: new Date(),
        },
      },
    });
  } else {
    // Escalate if at max attempts
    const attemptsCount = await prisma.remediationRun.count({
      where: { incidentId: run.incidentId },
    });

    if (attemptsCount >= 2) {
      await prisma.auditEvent.create({
        data: {
          actor: 'system',
          type: 'escalation_required',
          incidentId: run.incidentId,
          investigationId: run.investigationId,
          remediationRunId: run.id,
          payloadJson: {
            reason: 'Maximum attempts reached without recovery (limit 2)',
            totalAttempts: attemptsCount,
            outcome: finalOutcome.outcome,
          },
        },
      });
    }
  }

  return updatedRun;
}

/**
 * Startup reconciliation per Section 12 table:
 * - pending: safe to execute
 * - apply_sent: query fix-status and reconcile, never apply blindly
 * - apply_confirmed / verifying: resume if applied < 2 min ago, else fail with interrupted
 */
export async function startupRemediationReconciliation(simulatorUrl?: string, controlToken?: string): Promise<void> {
  const activeRuns = await prisma.remediationRun.findMany({
    where: {
      OR: [
        { status: 'in_progress' },
        { executionState: { not: 'finished' } },
      ],
    },
    include: {
      incident: true,
    },
  });

  const simUrl = simulatorUrl || process.env.SIMULATOR_URL || 'http://localhost:4000';
  const token = controlToken || process.env.CONTROL_TOKEN || 'dev-control-token-456';

  for (const run of activeRuns) {
    try {
      if (run.executionState === 'pending') {
        // Safe to send again
        executeRemediation(run.id).catch((err) => {
          console.error(`[Reconciliation] Error resuming pending run ${run.id}:`, err);
        });
      } else if (run.executionState === 'apply_sent') {
        // Query fix status from simulator
        const scenarioRunId = run.incident.scenarioRunId || 'run-default';
        const res = await fetch(`${simUrl}/control/fix-status/${scenarioRunId}/${run.actionId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (res.ok) {
          // Fix was applied, advance and verify
          await prisma.remediationRun.update({
            where: { id: run.id },
            data: { executionState: 'verifying' },
          });
          executeRemediation(run.id).catch(() => {});
        } else {
          // Never sent or receipt missing, safe to re-execute
          executeRemediation(run.id).catch(() => {});
        }
      } else if (run.executionState === 'verifying' || run.executionState === 'apply_confirmed') {
        const appliedAt = run.appliedAt ? run.appliedAt.getTime() : 0;
        const elapsedMs = Date.now() - appliedAt;
        if (appliedAt > 0 && elapsedMs < 120_000) {
          // Resume verification
          executeRemediation(run.id).catch(() => {});
        } else {
          // Interrupted timeout
          await prisma.remediationRun.update({
            where: { id: run.id },
            data: {
              executionState: 'finished',
              status: 'verification_failed',
              outcome: 'verification_failed',
              activeIncidentId: null,
              verificationJson: {
                outcome: 'verification_failed',
                reasons: ['interrupted_timeout_after_crash'],
              },
            },
          });
        }
      }
    } catch (err) {
      console.error(`[Reconciliation] Error handling run ${run.id}:`, err);
    }
  }
}
