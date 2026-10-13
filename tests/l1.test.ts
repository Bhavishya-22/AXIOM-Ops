import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../backend/src/prisma.js';
import { classifyTicket } from '../backend/src/l1/classifier.js';
import { evaluateDuplicateLinking } from '../backend/src/l1/duplicate-linker.js';
import { buildEscalationPacket } from '../backend/src/l1/escalation.js';

describe('L1 Ticket Handling, Runbooks & Triage (Section 20 & Section 15)', () => {
  const sessionId = 'test-l1-suite-session';
  let activeIncident: any;

  beforeEach(async () => {
    activeIncident = await prisma.incident.create({
      data: {
        sessionId,
        status: 'open',
        startedAt: new Date(Date.now() - 60000),
      },
    });

    // Create a linked ticket on the incident with diagnostic signals
    await prisma.ticket.create({
      data: {
        title: 'Redis Cluster Outage',
        description: 'Redis is returning redis_conn_refused errors',
        services: ['redis-cache', 'checkout'],
        incidentId: activeIncident.id,
        linkStatus: 'linked',
        status: 'open',
      },
    });
  });

  describe('Classifier and Triage', () => {
    it('classifies payment declines and token expiries as not_an_incident with runbook explanation', () => {
      // 1. Payment decline
      const declineRes = classifyTicket('Customer card declined', 'Bank returned do not honor');
      expect(declineRes.ticketType).toBe('not_an_incident');
      expect(declineRes.isNotAnIncident).toBe(true);
      expect(declineRes.runbook?.id).toBe('payment_decline_explanation');
      expect(declineRes.explanation).toMatch(/decline/i);

      // 2. Token expiry
      const tokenRes = classifyTicket('Session expired after 24 hours', 'Expired token received from client');
      expect(tokenRes.ticketType).toBe('not_an_incident');
      expect(tokenRes.isNotAnIncident).toBe(true);
      expect(tokenRes.runbook?.id).toBe('expired_token_explanation');
    });

    it('classifies how-tos, access requests, and known issues correctly', () => {
      // Browser cache how-to
      const cacheRes = classifyTicket('How do I clear browser cache?', 'Customer seeing stale CSS');
      expect(cacheRes.ticketType).toBe('how_to');
      expect(cacheRes.runbook?.id).toBe('how_to_clear_browser_cache');

      // MFA how-to
      const mfaRes = classifyTicket('Need to setup new Authenticator MFA device');
      expect(mfaRes.ticketType).toBe('how_to');
      expect(mfaRes.runbook?.id).toBe('how_to_verify_mfa_device');

      // Session reset access request
      const resetRes = classifyTicket('Please reset user session', 'User account locked in checkout');
      expect(resetRes.ticketType).toBe('access_request');
      expect(resetRes.runbook?.id).toBe('reset_user_session');

      // Known issue maintenance
      const maintRes = classifyTicket('Database maintenance window inquiry');
      expect(maintRes.ticketType).toBe('known_issue');
      expect(maintRes.runbook?.id).toBe('known_issue_scheduled_maintenance');
    });
  });

  describe('Conservative Duplicate Linking Invariants', () => {
    it('links to open incident only when service overlaps, time in window, and signature matches', async () => {
      // Ticket meeting all 3 criteria: services overlap (checkout), within window, text mentions Redis connection refused
      const linkEval = await evaluateDuplicateLinking({
        ticketServices: ['checkout'],
        ticketCreatedAt: new Date(),
        ticketText: 'Users cannot place orders: Redis connection refused in checkout',
        incidentId: activeIncident.id,
      });

      expect(linkEval.linkStatus).toBe('linked');
    });

    it('returns possible_duplicate when services or window overlap but signature does not match', async () => {
      // Services overlap (checkout) and within window, but unrelated signature
      const linkEval = await evaluateDuplicateLinking({
        ticketServices: ['checkout'],
        ticketCreatedAt: new Date(),
        ticketText: 'User would like an invoice copy for last month purchase',
        incidentId: activeIncident.id,
      });

      expect(linkEval.linkStatus).toBe('possible_duplicate');
      expect(linkEval.reason).toContain('signature does not decisively match');
    });

    it('returns possible_duplicate when services do not overlap', async () => {
      // Disjoint services (e.g. notifications only)
      const linkEval = await evaluateDuplicateLinking({
        ticketServices: ['notifications-service'],
        ticketCreatedAt: new Date(),
        ticketText: 'Email delivery delayed',
        incidentId: activeIncident.id,
      });

      expect(linkEval.linkStatus).toBe('possible_duplicate');
    });
  });

  describe('Escalation Packet Builder', () => {
    it('builds structured escalation packet when diagnosis is manual or engine abstains', () => {
      const packet = buildEscalationPacket({
        rootCauses: ['redis_unavailable'],
        candidateCauses: ['redis_unavailable', 'db_pool_exhausted'],
        evidenceSnapshotJson: {
          nodes: [{ logIds: ['log-1', 'log-2'] }],
        },
        dispositionReason: 'unexplained_error_cluster',
        actionDisposition: 'manual_recommended',
      });

      expect(packet.owningTeam).toBe('caching-and-data-storage');
      expect(packet.candidateCauses).toEqual(['redis_unavailable', 'db_pool_exhausted']);
      expect(packet.separatingEvidence).toContain('cache_fallback_to_db');
      expect(packet.citedEvidenceIds).toContain('log-1');
      expect(packet.actionRecommended).toBe('restart_redis');
    });
  });
});
