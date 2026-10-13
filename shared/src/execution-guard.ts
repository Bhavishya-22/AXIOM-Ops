import { z } from 'zod';

export const ALLOWLIST = [
  'restart_redis',
  'increase_db_pool',
  'rollback_deploy',
  'failover_gateway',
  'failover_idp',
] as const;

export const ActionIdEnum = z.enum([
  'restart_redis',
  'increase_db_pool',
  'rollback_deploy',
  'failover_gateway',
  'failover_idp',
]);
export type ActionId = z.infer<typeof ActionIdEnum>;

export const RoleEnum = z.enum(['operator', 'sme']);
export type Role = z.infer<typeof RoleEnum>;

export const EvidenceLevelEnum = z.enum(['Strong', 'Moderate', 'Weak']);
export type EvidenceLevel = z.infer<typeof EvidenceLevelEnum>;

export interface Cluster {
  service: string;
  messageHash: string;
  count: number;
  firstSeen: Date | string;
  lastSeen: Date | string;
  material: boolean;
  classification?: 'noise' | 'symptom' | 'material';
}

export interface TicketContext {
  id: string;
  title: string;
  description: string;
  services: string[];
  ticketType: string;
  status: string;
  incidentId: string | null;
  requesterId?: string | null;
}

export interface IncidentContext {
  id: string;
  scenarioRunId?: string | null;
  sessionId: string;
  openSlot?: number | null;
  status: string;
  detectedAt: Date | string;
  startedAt: Date | string;
  resolvedAt?: Date | string | null;
}

export interface InvestigationContext {
  id: string;
  ticketId: string;
  status: string;
  classification?: string | null;
  diagnosisStatus?: string | null;
  causeMode?: string | null;
  actionDisposition?: string | null;
  dispositionReason?: string | null;
  rootCauses: string[];
  regulatedHold?: boolean;
  evidenceComplete: boolean;
  evidenceLevel?: EvidenceLevel | null;
}

export interface ApprovalRecord {
  demoUserId: string;
  role: Role;
  at: Date | string;
}

export interface IdentityProofRecord {
  challengeId: string;
  userId: string;
  verifiedAt: Date | string;
  consumedAt: Date | string | null;
}

export type ExecutionContext =
  | {
      kind: 'L2';
      action: ActionId;
      ticket: TicketContext;
      incident: IncidentContext;
      investigation: InvestigationContext;
      latestEligibleInvestigationId: string;
      evidenceLevel: EvidenceLevel | null;
      evidenceComplete: boolean;
      unresolvedClusters: Cluster[];
      approval: ApprovalRecord | null;
    }
  | {
      kind: 'L1';
      action: 'reset_user_session';
      ticket: TicketContext;
      identityProof: IdentityProofRecord | null;
    };

export interface AllowedResult {
  allowed: true;
}

export interface ManualRecommendedResult {
  allowed: false;
  disposition: 'manual_recommended';
  reason: string;
  effectiveImpact: string[];
}

export interface RefusedResult {
  allowed: false;
  disposition: 'refused';
  reason: string;
}

export type GuardResult = AllowedResult | ManualRecommendedResult | RefusedResult;
