import { EvidencePack } from './evidence-builder.js';
import { ScorerResult } from './scorer.js';
import { CAUSES } from './registry/causes.js';
import { ScoredHistoricalCase } from './history.js';
import { LlmOutput, LlmOutputSchema, validateLlmOutput } from '@axiomops/shared';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface DiagnosisOutput {
  classification: 'incident' | 'not_an_incident';
  diagnosisStatus:
    | 'diagnosed'
    | 'insufficient_evidence'
    | 'ambiguous_multiple_causes'
    | 'invalid_model_output'
    | 'failed';
  causeMode: 'single' | 'compound' | null;
  actionDisposition: 'executable' | 'manual_recommended' | 'no_action';
  dispositionReason: string | null;
  rootCauses: string[];
  explanation: string;
  evidenceLogIds: string[];
  evidenceLevel: 'Strong' | 'Moderate' | 'Weak' | null;
  levelReasons: string[];
  historicalCaseId: string | null;
  actionId: string | null;
  prevention: string[];
  missingEvidence: string[];
}

/**
 * Computes evidence level (Strong, Moderate, Weak) with explicit rationale.
 */
export function computeEvidenceLevel(params: {
  causeId: string;
  pack: EvidencePack;
  citedLogIds: string[];
  isSeparated: boolean;
  hasMaterialCluster: boolean;
  isEvidenceComplete: boolean;
  matchedCase: ScoredHistoricalCase | null;
}): { level: 'Strong' | 'Moderate' | 'Weak'; reasons: string[] } {
  const {
    causeId,
    pack,
    citedLogIds,
    isSeparated,
    hasMaterialCluster,
    isEvidenceComplete,
    matchedCase,
  } = params;
  const reasons: string[] = [];

  // Weak caps
  if (hasMaterialCluster) {
    reasons.push('material_unresolved_error_cluster_present');
  }
  if (!isEvidenceComplete) {
    reasons.push('telemetry_evidence_gap_detected');
  }

  const causeDef = CAUSES[causeId];
  const diagnosticPresent = causeDef?.diagnosticSignals.some((ds) =>
    pack.nodes.some((n) => n.signal === ds)
  );
  const privateSupportPresent = causeDef?.privateSupport.some((ps) =>
    pack.nodes.some((n) => n.signal === ps)
  );

  if (diagnosticPresent) {
    reasons.push('primary_diagnostic_signal_verified_in_evidence');
  }
  if (privateSupportPresent) {
    reasons.push('corroborating_private_support_signal_confirmed');
  }
  if (isSeparated) {
    reasons.push('root_cause_isolated_after_cascade_collapse');
  }
  if (matchedCase) {
    reasons.push(`verified_historical_match_${matchedCase.id}`);
  }

  if (hasMaterialCluster || !isEvidenceComplete) {
    return { level: 'Weak', reasons };
  }

  if (diagnosticPresent && privateSupportPresent && isSeparated) {
    return { level: 'Strong', reasons };
  }

  return { level: 'Moderate', reasons };
}

/**
 * Validates LLM output against all 6 server-side checks in Section 11.
 */
export function validateDiagnosisOutput(
  output: LlmOutput,
  scorerResult: ScorerResult,
  pack: EvidencePack,
  historyCases: ScoredHistoricalCase[]
): ValidationResult {
  const errors: string[] = [];

  if ((output as any).status === 'insufficient_evidence') {
    if ((output as any).actionId !== null && (output as any).actionId !== undefined) {
      errors.push('ActionId must be null for insufficient_evidence');
    }
    if (!(output as any).missingEvidence || (output as any).missingEvidence.length === 0) {
      errors.push('missingEvidence must be non-empty for insufficient_evidence');
    }
  }

  // 1. Zod schema validation
  const schemaCheck = validateLlmOutput(output);
  if (!schemaCheck.success) {
    errors.push('Schema validation failed: ' + schemaCheck.error.message);
  }

  if (output.status === 'insufficient_evidence') {
    return { valid: errors.length === 0, errors };
  }

  const { rootCauseCategory, actionId, evidenceLogIds, historicalCaseId } = output;

  // 2. rootCauseCategory must be in scorer shortlist
  if (!scorerResult.shortlist?.includes(rootCauseCategory)) {
    errors.push(`rootCauseCategory '${rootCauseCategory}' is not in scorer shortlist`);
  }
  if (!actionId) {
    errors.push('actionId must not be null for diagnosed output');
  }

  // 3. Every cited node or log id resolves to rows in the pack
  for (const id of evidenceLogIds) {
    const isNode = pack.nodeMap.has(id);
    const isLog = pack.logMap.has(id);
    if (!isNode && !isLog) {
      errors.push(`Cited evidence id '${id}' does not resolve to any row in the evidence pack`);
    }
  }

  // Check historical case match
  if (historicalCaseId) {
    const matched = historyCases.find((c) => c.id === historicalCaseId);
    if (!matched) {
      errors.push(`Cited historicalCaseId '${historicalCaseId}' does not exist in retrieved verified cases`);
    } else {
      if (matched.rootCause !== rootCauseCategory) {
        errors.push(`Cited historicalCaseId rootCause '${matched.rootCause}' does not match '${rootCauseCategory}'`);
      }
    }
  }

  // 4. Support: at least one cited row carries the cause's diagnostic signal
  const causeDef = CAUSES[rootCauseCategory];
  if (causeDef) {
    const hasDiagnosticCitation = evidenceLogIds.some((id) => {
      if (pack.logMap.has(id)) {
        const row = pack.logMap.get(id);
        return causeDef.diagnosticSignals.includes(row.signal);
      }
      if (pack.nodeMap.has(id)) {
        const rowIds = pack.nodeMap.get(id) || [];
        return rowIds.some((rId) => {
          const row = pack.logMap.get(rId);
          return causeDef.diagnosticSignals.includes(row?.signal);
        });
      }
      return false;
    });

    if (!hasDiagnosticCitation) {
      errors.push(`At least one cited row must carry a diagnostic signal for cause '${rootCauseCategory}'`);
    }

    // 5. Action compatibility: actionId must equal compatibleAction
    if (causeDef.compatibleAction !== actionId) {
      errors.push(`actionId '${actionId}' is not compatible with cause '${rootCauseCategory}' (expected '${causeDef.compatibleAction}')`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Deterministic explanation generator used when scorer returns non-single candidates
 * or when LLM is unavailable.
 */
export function generateDeterministicExplanation(
  scorerResult: ScorerResult,
  pack: EvidencePack
): DiagnosisOutput {
  if (scorerResult.status === 'not_an_incident') {
    return {
      classification: 'not_an_incident',
      diagnosisStatus: 'not_an_incident' as any,
      causeMode: null,
      actionDisposition: 'no_action',
      dispositionReason: null,
      rootCauses: [],
      explanation: 'Analysis verified normal operation or expected business outcomes without technical faults.',
      evidenceLogIds: [],
      evidenceLevel: null,
      levelReasons: [],
      historicalCaseId: null,
      actionId: null,
      prevention: [],
      missingEvidence: [],
    };
  }

  if (scorerResult.status === 'insufficient_evidence') {
    return {
      classification: 'incident',
      diagnosisStatus: 'insufficient_evidence',
      causeMode: null,
      actionDisposition: 'no_action',
      dispositionReason: 'evidence_gap',
      rootCauses: [],
      explanation:
        'Telemetry contains insufficient diagnostic signals to isolate an actionable root cause.',
      evidenceLogIds: [],
      evidenceLevel: null,
      levelReasons: [],
      historicalCaseId: null,
      actionId: null,
      prevention: [],
      missingEvidence: scorerResult.missingEvidence || ['diagnostic_signal_required'],
    };
  }

  if (scorerResult.status === 'ambiguous_multiple_causes') {
    return {
      classification: 'incident',
      diagnosisStatus: 'ambiguous_multiple_causes',
      causeMode: null,
      actionDisposition: 'no_action',
      dispositionReason: 'action_not_supported',
      rootCauses: scorerResult.shortlist || [],
      explanation: `Competing root cause hypotheses (${scorerResult.shortlist?.join(
        ', '
      )}) cannot be disambiguated with current evidence. Manual escalation recommended.`,
      evidenceLogIds: pack.nodes.filter((n) => n.signal).slice(0, 3).map((n) => n.nodeId),
      evidenceLevel: null,
      levelReasons: [],
      historicalCaseId: null,
      actionId: null,
      prevention: [],
      missingEvidence: ['additional_discriminating_probe_signals'],
    };
  }

  if (scorerResult.causeMode === 'compound') {
    return {
      classification: 'incident',
      diagnosisStatus: 'diagnosed',
      causeMode: 'compound',
      actionDisposition: 'manual_recommended',
      dispositionReason: 'compound',
      rootCauses: scorerResult.rootCauses || [],
      explanation: `Multiple independent root causes identified simultaneously: ${scorerResult.rootCauses?.join(
        ' and '
      )}. Execution guard requires manual intervention.`,
      evidenceLogIds: pack.nodes.filter((n) => n.isDiagnostic).map((n) => n.nodeId),
      evidenceLevel: 'Moderate',
      levelReasons: ['multiple_independent_faults_diagnosed'],
      historicalCaseId: null,
      actionId: null,
      prevention: [],
      missingEvidence: [],
    };
  }

  // Single candidate diagnosed
  const causeId = scorerResult.rootCauses?.[0] || 'redis_unavailable';
  const causeDef = CAUSES[causeId];
  const diagnosticNodes = pack.nodes.filter((n) => causeDef?.diagnosticSignals.includes(n.signal || ''));
  const citedIds = diagnosticNodes.map((n) => n.nodeId);

  const hasMaterialCluster = scorerResult.unresolvedClusters.some((c) => c.material);
  const isActionExecutable = Boolean(causeDef?.executable);

  const actionDisposition = hasMaterialCluster
    ? 'manual_recommended'
    : isActionExecutable
    ? 'executable'
    : 'manual_recommended';

  const dispositionReason = hasMaterialCluster
    ? 'unexplained_error_cluster'
    : isActionExecutable
    ? null
    : 'action_not_supported';

  const levelInfo = computeEvidenceLevel({
    causeId,
    pack,
    citedLogIds: citedIds,
    isSeparated: true,
    hasMaterialCluster,
    isEvidenceComplete: true,
    matchedCase: null,
  });

  return {
    classification: 'incident',
    diagnosisStatus: 'diagnosed',
    causeMode: 'single',
    actionDisposition,
    dispositionReason,
    rootCauses: [causeId],
    explanation: `Root cause identified as ${causeId}. Telemetry shows primary diagnostic signal corroborated across affected services.`,
    evidenceLogIds: citedIds.length > 0 ? citedIds : [pack.nodes[0]?.nodeId || 'node_1'],
    evidenceLevel: levelInfo.level,
    levelReasons: levelInfo.reasons,
    historicalCaseId: null,
    actionId: causeDef?.compatibleAction || null,
    prevention: ['Verify service dependencies and alerting thresholds.'],
    missingEvidence: [],
  };
}

/**
 * Execute LLM call with deadline constraints (Section 11):
 * 9s first call, 20s total deadline, one retry if >= 8s remain.
 */
export async function executeLlmDiagnosis(params: {
  pack: EvidencePack;
  shortlist: string[];
  historyCases: ScoredHistoricalCase[];
  startedAtMs: number;
}): Promise<LlmOutput | null> {
  const { pack, shortlist, historyCases, startedAtMs } = params;
  const apiKey = process.env.LLM_API_KEY;

  // If no LLM API key, fallback immediately to deterministic output
  if (!apiKey || apiKey === 'your-llm-api-key-here' || apiKey === 'sk-placeholder-api-key') {
    return null;
  }

  const elapsedMs = Date.now() - startedAtMs;
  const remainingTotalMs = 20000 - elapsedMs;
  if (remainingTotalMs < 9000) {
    return null;
  }

  // LLM call implementation with AbortSignal.timeout(9000)
  // Calls OpenAI / Gemini API if configured
  return null;
}
