import { prisma } from '../prisma.js';
import { buildExecutionContext, assertExecutionAllowed } from '../policy/execution-guard.js';

export interface IdentityChallengeResult {
  challengeId: string;
  code: string;
  userId: string;
}

export interface RunbookExecutionResult {
  success: boolean;
  ticketId: string;
  runbookId: string;
  message: string;
  autoResolved: boolean;
  details?: any;
}

/**
 * Requests a simulated one-time-code identity challenge from the simulator
 */
export async function createIdentityChallenge(
  userId: string,
  simulatorUrl: string = process.env.SIMULATOR_URL || 'http://localhost:4000',
  controlToken: string = process.env.CONTROL_TOKEN || 'dev-control-token-456'
): Promise<IdentityChallengeResult> {
  const res = await fetch(`${simulatorUrl}/control/identity/challenge`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create identity challenge: status ${res.status}`);
  }

  return (await res.json()) as IdentityChallengeResult;
}

/**
 * Executes reset_user_session runbook with simulated identity proof,
 * execution guard, simulator reset call, verification, and automated ticket resolution.
 */
export async function executeSessionResetRunbook(params: {
  ticketId: string;
  challengeId: string;
  code: string;
  simulatorUrl?: string;
  controlToken?: string;
}): Promise<RunbookExecutionResult> {
  const {
    ticketId,
    challengeId,
    code,
    simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000',
    controlToken = process.env.CONTROL_TOKEN || 'dev-control-token-456',
  } = params;

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
  });

  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  const requesterId = ticket.requesterId || 'user-default';

  // 1. Verify identity proof with simulator
  const verifyRes = await fetch(`${simulatorUrl}/control/identity/verify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ challengeId, code }),
  });

  if (!verifyRes.ok) {
    const errData = await verifyRes.json().catch(() => ({}));
    throw new Error(`Identity proof verification failed: ${errData.error || 'Invalid code'}`);
  }

  const proof = await verifyRes.json();
  const identityProof = {
    challengeId,
    userId: proof.userId,
    verifiedAt: new Date(proof.verifiedAt),
    consumedAt: null,
  };

  // 2. Build execution context from stored rows
  const ctx = await buildExecutionContext({
    kind: 'L1',
    ticketId: ticket.id,
    action: 'reset_user_session',
    identityProof,
  });

  // 3. Evaluate shared execution guard
  const guardResult = assertExecutionAllowed(ctx);
  if (!guardResult.allowed) {
    await prisma.auditEvent.create({
      data: {
        actor: 'system',
        type: 'l1_execution_guard_refused',
        ticketId: ticket.id,
        payloadJson: {
          reason: guardResult.reason,
          disposition: guardResult.disposition,
        },
      },
    });

    throw new Error(`Execution disallowed by guard: ${guardResult.reason}`);
  }

  // 4. Call simulator reset-user-session (proof consumed atomically)
  const resetRes = await fetch(`${simulatorUrl}/control/reset-user-session`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId: requesterId,
      challengeId,
    }),
  });

  if (!resetRes.ok) {
    const err = await resetRes.json().catch(() => ({}));
    throw new Error(`Simulator session reset failed: ${err.error || 'Server error'}`);
  }

  const resetData = await resetRes.json();

  // 5. Verify old session is invalid and fresh login works
  if (!resetData.oldSessionInvalidated || !resetData.newSessionAvailable) {
    throw new Error('Verification failed: old session still active or fresh login unavailable');
  }

  // 6. Resolve ticket with no human
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status: 'resolved' },
  });

  // 7. Record audit event
  await prisma.auditEvent.create({
    data: {
      actor: 'system',
      type: 'runbook_executed',
      ticketId: ticket.id,
      evidenceLogIds: [],
      payloadJson: {
        runbookId: 'reset_user_session',
        action: 'reset_user_session',
        userId: requesterId,
        challengeId,
        autoResolved: true,
        verifiedOldSessionInvalidated: true,
        verifiedNewLoginAvailable: true,
      },
    },
  });

  return {
    success: true,
    ticketId: ticket.id,
    runbookId: 'reset_user_session',
    message: 'User session successfully reset and verified. Ticket auto-resolved with zero human intervention.',
    autoResolved: true,
    details: resetData,
  };
}
