import { z } from 'zod';

export const CandidateHypothesisSchema = z.object({
  category: z.string(),
  reasoning: z.string(),
  evidenceLogIds: z.array(z.string()),
});
export type CandidateHypothesis = z.infer<typeof CandidateHypothesisSchema>;

export const LlmDiagnosedOutputSchema = z.object({
  status: z.literal('diagnosed'),
  candidates: z.array(CandidateHypothesisSchema),
  rootCauseCategory: z.string(),
  explanation: z.string(),
  evidenceLogIds: z.array(z.string()).min(1),
  historicalCaseId: z.string().nullable(),
  actionId: z.string(),
  prevention: z.array(z.string()),
  missingEvidence: z.array(z.string()).default([]),
});
export type LlmDiagnosedOutput = z.infer<typeof LlmDiagnosedOutputSchema>;

export const LlmInsufficientEvidenceOutputSchema = z.object({
  status: z.literal('insufficient_evidence'),
  candidates: z.array(CandidateHypothesisSchema).default([]),
  rootCauseCategory: z.literal('unknown'),
  explanation: z.string(),
  evidenceLogIds: z.array(z.string()).default([]),
  historicalCaseId: z.null().optional().default(null),
  actionId: z.null().optional().default(null),
  prevention: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).min(1),
});
export type LlmInsufficientEvidenceOutput = z.infer<typeof LlmInsufficientEvidenceOutputSchema>;

export const LlmOutputSchema = z.discriminatedUnion('status', [
  LlmDiagnosedOutputSchema,
  LlmInsufficientEvidenceOutputSchema,
]);
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

export function validateLlmOutput(input: unknown) {
  return LlmOutputSchema.safeParse(input);
}
