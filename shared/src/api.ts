import { z } from 'zod';
import { IngestBatchSchema } from './ingest.js';
import { OutcomeFieldsSchema } from './outcome.js';
import { ActionIdEnum, EvidenceLevelEnum } from './execution-guard.js';

// Common DTOs
export interface LogDto {
  id: string;
  ts: string;
  service: string;
  category: string;
  team: string;
  level: string;
  message: string;
  signal?: string | null;
  signalKind?: string | null;
  sessionId: string;
  serviceSeq: number;
  class: string;
  origin: string;
}

export interface IncidentDto {
  id: string;
  scenarioRunId?: string | null;
  sessionId: string;
  openSlot?: number | null;
  status: 'open' | 'resolved';
  detectedAt: string;
  startedAt: string;
  resolvedAt?: string | null;
  humanDetectedAt?: string | null;
  baselineMetricsJson?: unknown;
}

export interface TicketDto {
  id: string;
  title: string;
  description: string;
  services: string[];
  ticketType: 'incident_report' | 'service_request';
  status: string;
  incidentId?: string | null;
  linkStatus: 'linked' | 'possible_duplicate' | 'none';
  source: 'auto' | 'user';
  autoKey?: string | null;
  requesterId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationDto {
  id: string;
  ticketId: string;
  status: 'running' | 'done' | 'failed';
  classification?: string | null;
  diagnosisStatus?: string | null;
  causeMode?: string | null;
  actionDisposition?: string | null;
  dispositionReason?: string | null;
  rootCauses: string[];
  suppressedJson?: unknown;
  unresolvedClustersJson?: unknown;
  effectiveImpactJson?: unknown;
  regulatedHold: boolean;
  evidenceComplete: boolean;
  evidenceLevel?: string | null;
  levelReasonsJson?: unknown;
  evidenceSnapshotJson?: unknown;
  resultJson?: unknown;
  timingsJson?: unknown;
  investigationStartedAt: string;
  outcomeAt?: string | null;
  autoKey?: string | null;
}

export interface AuditEventDto {
  id: string;
  ts: string;
  incidentId?: string | null;
  ticketId?: string | null;
  investigationId?: string | null;
  remediationRunId?: string | null;
  actor: 'system' | 'user';
  actorRole?: string | null;
  type: string;
  evidenceLogIds: string[];
  payloadJson?: unknown;
}

export interface RemediationRunDto {
  id: string;
  incidentId: string;
  investigationId: string;
  attemptId: string;
  actionId: string;
  idempotencyKey: string;
  executionState: 'pending' | 'apply_sent' | 'apply_confirmed' | 'verifying' | 'finished';
  status: 'in_progress' | 'resolved' | 'failed';
  approvedBy: string;
  approverRole: string;
  approvedAt: string;
  appliedAt?: string | null;
  outcome?: 'resolved' | 'partially_recovered' | 'verification_failed' | 'verification_inconclusive' | null;
  verificationJson?: unknown;
  incidentMetricsJson?: unknown;
  afterMetricsJson?: unknown;
}

// 1. POST /ingest
export const IngestRequestSchema = IngestBatchSchema;
export const IngestResponseSchema = z.object({
  accepted: z.number(),
  duplicates: z.number(),
  gapsCreated: z.number().default(0),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

// 2. GET /logs
export const GetLogsQuerySchema = z.object({
  category: z.string().optional(),
  service: z.string().optional(),
  level: z.string().optional(),
  since: z.string().optional(),
  sessionId: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
});
export type GetLogsQuery = z.infer<typeof GetLogsQuerySchema>;
export interface GetLogsResponse {
  logs: LogDto[];
}

// 3. POST /scenarios/:name/trigger
export const TriggerScenarioParamsSchema = z.object({
  name: z.string(),
});
export const TriggerScenarioResponseSchema = z.object({
  runId: stringSchema(),
  sessionId: stringSchema(),
  scenario: stringSchema(),
  triggeredAt: stringSchema(),
});
function stringSchema() {
  return z.string();
}
export type TriggerScenarioResponse = z.infer<typeof TriggerScenarioResponseSchema>;

// 4. POST /incidents/report (Mode B)
export const ReportIncidentBodySchema = z.object({
  sessionId: z.string().optional(),
  services: z.array(z.string()).default(['checkout']),
  description: z.string().optional(),
});
export type ReportIncidentBody = z.infer<typeof ReportIncidentBodySchema>;
export interface ReportIncidentResponse {
  incident: IncidentDto;
}

// 5. GET /incidents/active and GET /incidents/:id/audit
export interface ActiveIncidentResponse {
  incident: IncidentDto | null;
}
export interface IncidentAuditResponse {
  auditEvents: AuditEventDto[];
}

// 6. POST /tickets, GET /tickets, GET /tickets/:id
export const CreateTicketBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  services: z.array(z.string()).min(1),
  incidentId: z.string().nullable().optional(),
  requesterId: z.string().optional(),
});
export type CreateTicketBody = z.infer<typeof CreateTicketBodySchema>;
export interface CreateTicketResponse {
  ticket: TicketDto;
}
export interface ListTicketsResponse {
  tickets: TicketDto[];
}
export interface TicketDetailResponse {
  ticket: TicketDto;
  incident?: IncidentDto | null;
  investigations: InvestigationDto[];
}

// 7. POST /tickets/:id/investigate
export const InvestigateResponseSchema = z.object({
  investigationId: z.string(),
  status: z.literal('running'),
});
export type InvestigateResponse = z.infer<typeof InvestigateResponseSchema>;

// 8. GET /investigations/:id
export interface InvestigationDetailResponse {
  investigation: InvestigationDto;
}

// 9. POST /investigations/:id/approve
export const ApproveInvestigationBodySchema = z.object({
  demoUserId: z.string().optional(),
});
export type ApproveInvestigationBody = z.infer<typeof ApproveInvestigationBodySchema>;
export interface ApproveResponse {
  remediationRunId: string;
  status: string;
}

// 10. GET /remediations/:id
export interface RemediationDetailResponse {
  remediation: RemediationRunDto;
}

// 11. POST /tickets/:id/identity-challenge and POST /tickets/:id/run-runbook
export const IdentityChallengeBodySchema = z.object({
  userId: z.string().min(1),
});
export type IdentityChallengeBody = z.infer<typeof IdentityChallengeBodySchema>;
export interface IdentityChallengeResponse {
  challengeId: string;
  message: string;
}

export const RunRunbookBodySchema = z.object({
  runbookId: z.string().min(1),
  identityProof: z
    .object({
      challengeId: z.string(),
      code: z.string(),
      userId: z.string(),
    })
    .optional(),
});
export type RunRunbookBody = z.infer<typeof RunRunbookBodySchema>;
export interface RunRunbookResponse {
  success: boolean;
  message: string;
  executedAction?: string;
}

// 12. GET /scorecard
export interface ScorecardMetricsDto {
  mttdSecondsMedian?: number;
  timeToDiagnosisSecondsMedian?: number;
  mttrSecondsMedian?: number;
  mttrWithoutApprovalSecondsMedian?: number;
  checkoutAvailabilityPct?: number;
  downtimeMinutesTotal?: number;
  verifiedResolutionRatePct?: number;
  incidentsDetectedTotal: number;
  ticketsAutoHandledTotal: number;
  smeTouchMinutesTotal?: number;
  sampleSize: number;
}
export interface ScorecardResponse {
  metrics: ScorecardMetricsDto;
  live?: Record<string, unknown>;
}
