import { z } from 'zod';

export const ClassificationEnum = z.enum(['incident', 'not_an_incident', 'service_request']);
export type Classification = z.infer<typeof ClassificationEnum>;

export const DiagnosisStatusEnum = z.enum([
  'diagnosed',
  'insufficient_evidence',
  'ambiguous_multiple_causes',
  'invalid_model_output',
  'failed',
]);
export type DiagnosisStatus = z.infer<typeof DiagnosisStatusEnum>;

export const CauseModeEnum = z.enum(['single', 'compound']);
export type CauseMode = z.infer<typeof CauseModeEnum>;

export const ActionDispositionEnum = z.enum([
  'executable',
  'manual_recommended',
  'no_action',
  'executed',
]);
export type ActionDisposition = z.infer<typeof ActionDispositionEnum>;

export const DispositionReasonEnum = z.enum([
  'regulated_service_requires_change_control',
  'unexplained_error_cluster',
  'evidence_gap',
  'action_not_supported',
  'compound',
]);
export type DispositionReason = z.infer<typeof DispositionReasonEnum>;

// Discriminated / exact validity matrix shapes per Section 6
const IncidentDiagnosedSingleSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('diagnosed'),
  causeMode: z.literal('single'),
  actionDisposition: z.enum(['executable', 'manual_recommended']),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).min(1).default([]),
});

const IncidentDiagnosedCompoundSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('diagnosed'),
  causeMode: z.literal('compound'),
  actionDisposition: z.literal('manual_recommended'), // never executable
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).min(2).default([]),
});

const IncidentInsufficientEvidenceSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('insufficient_evidence'),
  causeMode: z.null().optional(),
  actionDisposition: z.literal('no_action'),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

const IncidentAmbiguousSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('ambiguous_multiple_causes'),
  causeMode: z.null().optional(),
  actionDisposition: z.literal('no_action'),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

const IncidentInvalidModelOutputSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('invalid_model_output'),
  causeMode: z.null().optional(),
  actionDisposition: z.literal('no_action'),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

const IncidentFailedSchema = z.object({
  classification: z.literal('incident'),
  diagnosisStatus: z.literal('failed'),
  causeMode: z.null().optional(),
  actionDisposition: z.literal('no_action'),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

const NotAnIncidentSchema = z.object({
  classification: z.literal('not_an_incident'),
  diagnosisStatus: z.null().optional(),
  causeMode: z.null().optional(),
  actionDisposition: z.literal('no_action'),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

const ServiceRequestSchema = z.object({
  classification: z.literal('service_request'),
  diagnosisStatus: z.null().optional(),
  causeMode: z.null().optional(),
  actionDisposition: z.enum(['manual_recommended', 'executed']),
  dispositionReason: z.string().nullable().optional(),
  rootCauses: z.array(z.string()).default([]),
});

/**
 * Zod union representing the strict validity matrix from Section 6.
 * Rejects any illegal combination of classification, diagnosisStatus, causeMode, actionDisposition.
 */
export const OutcomeFieldsSchema = z.union([
  IncidentDiagnosedSingleSchema,
  IncidentDiagnosedCompoundSchema,
  IncidentInsufficientEvidenceSchema,
  IncidentAmbiguousSchema,
  IncidentInvalidModelOutputSchema,
  IncidentFailedSchema,
  NotAnIncidentSchema,
  ServiceRequestSchema,
]);

export type OutcomeFields = z.infer<typeof OutcomeFieldsSchema>;

export function validateOutcomeFields(input: unknown) {
  return OutcomeFieldsSchema.safeParse(input);
}
