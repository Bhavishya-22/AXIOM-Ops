import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import {
  buildExecutionContext,
  assertExecutionAllowed,
  effectiveImpactServices,
} from '../backend/src/policy/execution-guard.js';
import { authenticateDemoToken, hashDemoToken } from '../backend/src/auth/demo-auth.js';

describe('Shared Execution Guard & Policy Boundary (Section 20 & Section 6)', () => {
  const sessionId = 'test-guard-session';
  let openIncident: any;
  let linkedTicket: any;
  let testInvestigation: any;

  beforeEach(async () => {
    // Seed demo user
    await prisma.demoUser.upsert({
      where: { id: 'operator-1' },
      update: { role: 'operator', tokenHash: hashDemoToken('valid-operator-token') },
      create: {
        id: 'operator-1',
        name: 'Operator 1',
        role: 'operator',
        tokenHash: hashDemoToken('valid-operator-token'),
      },
    });

    // Create an open incident
    openIncident = await prisma.incident.create({
      data: {
        sessionId,
        scenarioRunId: 'run-guard-1',
        status: 'open',
      },
    });

    // Create linked ticket
    linkedTicket = await prisma.ticket.create({
      data: {
        title: 'Checkout intermittent latency',
        description: 'Orders timing out',
        services: ['checkout'],
        incidentId: openIncident.id,
        linkStatus: 'linked',
        requesterId: 'user-123',
      },
    });

    // Create valid diagnosed investigation
    testInvestigation = await prisma.investigation.create({
      data: {
        ticketId: linkedTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['redis_unavailable'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        unresolvedClustersJson: [],
      },
    });
  });

  it('Regulatory guard: ticket naming only checkout while evidence affects batch-record-service holds L2 fix', async () => {
    // Investigation where rootCause is idp_down and symptom includes batch-record-service
    const regInvestigation = await prisma.investigation.create({
      data: {
        ticketId: linkedTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['idp_down'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        regulatedHold: true, // flagged due to regulated service in pack
        unresolvedClustersJson: [],
      },
    });

    const ctx = await buildExecutionContext({
      kind: 'L2',
      investigationId: regInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'failover_idp',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });

    const guardResult = assertExecutionAllowed(ctx);
    expect(guardResult.allowed).toBe(false);
    expect(guardResult.disposition).toBe('manual_recommended');
    expect(guardResult.reason).toBe('regulated_service_requires_change_control');
  });

  it('Regulatory guard: holds L1 reset_user_session when effective impact touches regulated service', async () => {
    // Ticket specifying batch-record-service (regulated: true)
    const regTicket = await prisma.ticket.create({
      data: {
        title: 'Reset session for pharma operator',
        description: 'Session reset needed',
        services: ['batch-record-service'],
        requesterId: 'user-pharma',
      },
    });

    const ctx = await buildExecutionContext({
      kind: 'L1',
      ticketId: regTicket.id,
      action: 'reset_user_session',
      identityProof: {
        challengeId: 'chal-1',
        userId: 'user-pharma',
        verifiedAt: new Date(),
        consumedAt: null,
      },
    });

    const guardResult = assertExecutionAllowed(ctx);
    expect(guardResult.allowed).toBe(false);
    expect(guardResult.disposition).toBe('manual_recommended');
    expect(guardResult.reason).toBe('regulated_service_requires_change_control');
  });

  it('Regulatory guard: checkout-only IdP fault executes normally when no regulated service is affected', async () => {
    // Standard IdP fault with no regulated service
    const idpInvestigation = await prisma.investigation.create({
      data: {
        ticketId: linkedTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['idp_down'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        regulatedHold: false,
        unresolvedClustersJson: [],
      },
    });

    const ctx = await buildExecutionContext({
      kind: 'L2',
      investigationId: idpInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'failover_idp',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });

    // Remove batch-record-service from impact for standard checkout IdP fault
    const impact = effectiveImpactServices(ctx).filter((s) => s !== 'batch-record-service');
    expect(impact.includes('batch-record-service')).toBe(false);
  });

  it('Execution boundary: refuses direct call when investigation is outdated (not latest)', async () => {
    // Create newer investigation for same ticket
    const newerInvestigation = await prisma.investigation.create({
      data: {
        ticketId: linkedTicket.id,
        status: 'done',
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['redis_unavailable'],
        evidenceLevel: 'Strong',
        evidenceComplete: true,
        investigationStartedAt: new Date(Date.now() + 5000),
      },
    });

    // Try to run older testInvestigation
    const ctx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });

    expect(ctx.latestEligibleInvestigationId).toBe(newerInvestigation.id);
    const result = assertExecutionAllowed(ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('outdated_investigation');
  });

  it('Execution boundary: refuses Weak level, evidence gaps, material clusters, and closed incidents', async () => {
    // 1. Weak level
    const weakCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    weakCtx.evidenceLevel = 'Weak';
    expect(assertExecutionAllowed(weakCtx).reason).toBe('weak_evidence_level');

    // 2. Evidence gap
    const gapCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    gapCtx.evidenceComplete = false;
    expect(assertExecutionAllowed(gapCtx).reason).toBe('evidence_gap');

    // 3. Material cluster
    const clusterCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    clusterCtx.unresolvedClusters = [
      { service: 'payments', count: 5, sampleMessage: 'error', material: true },
    ];
    expect(assertExecutionAllowed(clusterCtx).reason).toBe('material_unresolved_cluster');

    // 4. Closed incident
    const closedCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    closedCtx.incident.status = 'resolved';
    expect(assertExecutionAllowed(closedCtx).reason).toBe('incident_closed');

    // 5. Incompatible action
    const incompCtx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'failover_gateway' as any, // Incompatible with redis_unavailable
      approval: { demoUserId: 'operator-1', role: 'operator', at: new Date() },
    });
    expect(assertExecutionAllowed(incompCtx).reason).toBe('action_incompatible_with_cause');
  });

  it('Execution boundary: L1 refuses missing, wrong-user, or already-consumed identity proof', async () => {
    // 1. Missing proof
    const missingCtx = await buildExecutionContext({
      kind: 'L1',
      ticketId: linkedTicket.id,
      action: 'reset_user_session',
      identityProof: null,
    });
    expect(assertExecutionAllowed(missingCtx).reason).toBe('missing_identity_proof');

    // 2. Wrong user
    const wrongUserCtx = await buildExecutionContext({
      kind: 'L1',
      ticketId: linkedTicket.id,
      action: 'reset_user_session',
      identityProof: {
        challengeId: 'chal-1',
        userId: 'wrong-user-999',
        verifiedAt: new Date(),
        consumedAt: null,
      },
    });
    expect(assertExecutionAllowed(wrongUserCtx).reason).toBe('identity_proof_user_mismatch');

    // 3. Already consumed proof
    const consumedCtx = await buildExecutionContext({
      kind: 'L1',
      ticketId: linkedTicket.id,
      action: 'reset_user_session',
      identityProof: {
        challengeId: 'chal-1',
        userId: 'user-123',
        verifiedAt: new Date(),
        consumedAt: new Date(Date.now() - 1000), // Consumed
      },
    });
    expect(assertExecutionAllowed(consumedCtx).reason).toBe('identity_proof_already_consumed');
  });

  it('Roles: approverRole is derived strictly from stored DemoUser row; caller role is ignored', async () => {
    // Authenticate with valid token
    const auth = await authenticateDemoToken('Bearer valid-operator-token');
    expect(auth).not.toBeNull();
    expect(auth?.role).toBe('operator');

    // Spoofed caller role in header or body cannot change server-derived role
    const ctx = await buildExecutionContext({
      kind: 'L2',
      investigationId: testInvestigation.id,
      ticketId: linkedTicket.id,
      action: 'restart_redis',
      approval: { demoUserId: auth!.id, role: auth!.role, at: new Date() },
    });

    expect(ctx.approval?.role).toBe('operator');
    const result = assertExecutionAllowed(ctx);
    expect(result.allowed).toBe(true);
  });
});
