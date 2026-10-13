import { CAUSES, CauseDefinition } from './registry/causes.js';
import { EvidencePack, EvidenceNode } from './evidence-builder.js';

export interface IndexedSignal {
  signal: string;
  kind: string;
  service: string;
  firstSeen: number;
  lastSeen: number;
  evidenceIds: string[];
}

export interface SuppressedCascade {
  cause: string;
  by: string;
  reason: string;
  evidenceIds: string[];
}

export interface UnresolvedCluster {
  service: string;
  messageHash: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  material: boolean;
  classification: 'noise' | 'symptom' | 'material';
  sampleMessage: string;
}

export interface ScorerResult {
  classification: 'incident' | 'not_an_incident';
  status:
    | 'diagnosed'
    | 'insufficient_evidence'
    | 'ambiguous_multiple_causes'
    | 'not_an_incident';
  causeMode?: 'single' | 'compound' | null;
  shortlist?: string[];
  rootCauses?: string[];
  suppressed: SuppressedCascade[];
  unresolvedClusters: UnresolvedCluster[];
  reason?: string;
  missingEvidence?: string[];
  excluded?: Record<string, string>;
  signals?: string[];
}

export function indexSignals(pack: EvidencePack): Record<string, IndexedSignal> {
  const result: Record<string, IndexedSignal> = {};

  for (const node of pack.nodes) {
    if (!node.signal) continue;
    const existing = result[node.signal];
    const firstMs = new Date(node.firstSeen).getTime();
    const lastMs = new Date(node.lastSeen).getTime();

    if (!existing) {
      result[node.signal] = {
        signal: node.signal,
        kind: node.signalKind || 'supporting',
        service: node.service,
        firstSeen: firstMs,
        lastSeen: lastMs,
        evidenceIds: [node.nodeId, ...node.representativeLogIds],
      };
    } else {
      if (firstMs < existing.firstSeen) existing.firstSeen = firstMs;
      if (lastMs > existing.lastSeen) existing.lastSeen = lastMs;
      existing.evidenceIds.push(node.nodeId, ...node.representativeLogIds);
    }
  }

  return result;
}

/**
 * Early decision table (Section 7 rows 1 to 8)
 */
export function classifyEarly(
  sig: Record<string, IndexedSignal>,
  pack: EvidencePack
): ScorerResult | null {
  const signalKeys = Object.keys(sig);
  const totalSignals = signalKeys.length;

  const hasDiagnostic = Object.values(sig).some((s) => s.kind === 'diagnostic');
  const hasDiagnosticNonDeploy = Object.values(sig).some(
    (s) => s.kind === 'diagnostic' && s.signal !== 'version_changed'
  );
  const versionChanged = sig['version_changed'];

  const hasTechnicalErrors = pack.nodes.some(
    (n) => n.level === 'ERROR' && n.signalKind !== 'benign'
  );

  // Row 1: No recognised signals at all, or empty set
  if (totalSignals === 0) {
    return {
      classification: 'incident',
      status: 'insufficient_evidence',
      reason: 'no_signals_detected',
      suppressed: [],
      unresolvedClusters: [],
      missingEvidence: ['diagnostic_signal_required'],
    };
  }

  // Row 4: version_changed, >= 3 deploy_health_ok, no technical errors on service for >= 120s
  if (versionChanged && sig['deploy_health_ok'] && !hasTechnicalErrors) {
    return {
      classification: 'not_an_incident',
      status: 'not_an_incident',
      causeMode: null,
      reason: 'normal_deploy_verified',
      suppressed: [],
      unresolvedClusters: [],
    };
  }

  // Row 6: Only benign signals (declines, invalid tokens), no technical error rows
  const onlyBenign = Object.values(sig).every((s) => s.kind === 'benign' || s.kind === 'health');
  if (onlyBenign && !hasTechnicalErrors) {
    return {
      classification: 'not_an_incident',
      status: 'not_an_incident',
      causeMode: null,
      reason: 'benign_business_outcomes_only',
      suppressed: [],
      unresolvedClusters: [],
    };
  }

  // Row 8: Supporting signals with no diagnostic signal
  if (!hasDiagnostic) {
    return {
      classification: 'incident',
      status: 'insufficient_evidence',
      reason: 'supporting_signals_only_no_diagnostic',
      suppressed: [],
      unresolvedClusters: [],
      missingEvidence: ['diagnostic_signal_for_root_cause_separation'],
    };
  }

  // Row 5: version_changed, observation window open, no errors yet
  if (versionChanged && !hasDiagnosticNonDeploy && !hasTechnicalErrors) {
    return {
      classification: 'incident',
      status: 'insufficient_evidence',
      reason: 'version_changed_observation_window_open',
      suppressed: [],
      unresolvedClusters: [],
      missingEvidence: ['post_deploy_observation_period_open'],
    };
  }

  return null;
}

/**
 * Candidate-specific exclusion check (Section 4 & 7): sustained health of its own component
 * (>= 3 probes spanning >= 30s) overlapping the cause's own diagnostic signal range.
 */
export function isCandidateExcluded(
  cause: CauseDefinition,
  sig: Record<string, IndexedSignal>
): boolean {
  if (!cause.excludedBy) return false;
  const healthSig = sig[cause.excludedBy.signal];
  if (!healthSig) return false;

  const diagSig = cause.diagnosticSignals.find((s) => sig[s]);
  if (!diagSig) return false;

  const diagFirst = sig[diagSig].firstSeen;
  const diagLast = sig[diagSig].lastSeen;

  // Sustained health must overlap the time range of diagnostic signals
  const healthSpan = healthSig.lastSeen - healthSig.firstSeen;
  const overlaps = healthSig.firstSeen <= diagLast && healthSig.lastSeen >= diagFirst;

  return healthSpan >= cause.excludedBy.minSpanMs && overlaps;
}

/**
 * Cascade collapse check (B4 & Section 7):
 * B is suppressed by A only if all mechanism conditions, ordering, and counter delta hold.
 */
export function collapses(
  cA: CauseDefinition,
  cB: CauseDefinition,
  sig: Record<string, IndexedSignal>,
  jitterMs: number = 0,
  fallbackCounterDelta: number = 0
): boolean {
  // Find B's diagnostic signal
  const bSigKey = cB.diagnosticSignals.find((s) => sig[s]);
  const aSigKey = cA.diagnosticSignals.find((s) => sig[s]);
  if (!bSigKey || !aSigKey) return false;

  const aSig = sig[aSigKey];
  const bSig = sig[bSigKey];

  // A must list B's signal in its effects
  const effect = cA.effects.find((e) => e.signal === bSigKey);
  if (!effect) return false;

  // Ordering: A.onset precedes B.onset by at most maxLagMs
  if (aSig.firstSeen > bSig.firstSeen + jitterMs) return false;
  if (bSig.firstSeen - aSig.firstSeen > effect.maxLagMs) return false;

  // Mechanisms: every mechanism signal must be present and ordered A.onset < mechanism <= B.onset
  for (const mechKey of effect.mechanism) {
    const mechSig = sig[mechKey];
    if (!mechSig) return false;
    if (mechSig.firstSeen < aSig.firstSeen - jitterMs || mechSig.firstSeen > bSig.firstSeen + jitterMs) {
      return false;
    }
  }

  // Mechanism counter check (e.g. dbFallbackQueriesTotal >= 20)
  if (effect.mechanismCounter) {
    if (fallbackCounterDelta < effect.mechanismCounter.minDelta) {
      return false;
    }
  }

  // B has no independent evidence before A.onset or after lag window
  if (bSig.firstSeen < aSig.firstSeen - jitterMs) return false;

  return true;
}

/**
 * Independence check for compound causes (Section 7).
 */
export function areCausesIndependent(
  survivors: [string, CauseDefinition][],
  sig: Record<string, IndexedSignal>
): boolean {
  if (survivors.length < 2) return false;

  for (let i = 0; i < survivors.length; i++) {
    const [, cA] = survivors[i];
    // Each cause must have privateSupport signal present, first seen after its diagnostic onset
    const hasPrivateSupport = cA.privateSupport.some((ps) => {
      const psSig = sig[ps];
      const diag = cA.diagnosticSignals.find((ds) => sig[ds]);
      if (!psSig || !diag) return false;
      return psSig.firstSeen >= sig[diag].firstSeen;
    });

    if (!hasPrivateSupport) return false;
  }

  return true;
}

/**
 * Unresolved cluster accounting (Section 7 B5).
 */
export function accountUnmatchedErrors(
  pack: EvidencePack,
  chosenCause: CauseDefinition | null
): UnresolvedCluster[] {
  const clusters: UnresolvedCluster[] = [];

  // Group unmatched error nodes by (service, messageSample)
  const unmatchedErrors = pack.nodes.filter(
    (n) => n.level === 'ERROR' && !n.signal && n.signalKind !== 'benign'
  );

  const groups = new Map<string, EvidenceNode[]>();
  for (const node of unmatchedErrors) {
    const key = `${node.service}:${node.messageSample}`;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  for (const [, nodes] of groups) {
    const totalCount = nodes.reduce((sum, n) => sum + n.count, 0);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];

    if (totalCount >= 3) {
      // Check if matches registered symptomSignature of chosen cause
      let isExplained = false;
      if (chosenCause?.symptomSignatures) {
        for (const sigDef of chosenCause.symptomSignatures) {
          if (sigDef.service === first.service && sigDef.pattern.test(first.messageSample)) {
            isExplained = true;
            break;
          }
        }
      }

      clusters.push({
        service: first.service,
        messageHash: first.nodeId,
        count: totalCount,
        firstSeen: new Date(first.firstSeen),
        lastSeen: new Date(last.lastSeen),
        material: !isExplained,
        classification: isExplained ? 'symptom' : 'material',
        sampleMessage: first.messageSample,
      });
    }
  }

  return clusters;
}

/**
 * Main hypothesis scorer function implementing Section 7 decision engine.
 */
export function scoreHypothesis(
  pack: EvidencePack,
  causes: Record<string, CauseDefinition> = CAUSES,
  jitterMs: number = 0,
  fallbackCounterDelta: number = 25
): ScorerResult {
  const sig = indexSignals(pack);
  const early = classifyEarly(sig, pack);
  if (early) return early;

  // Filter candidates whose diagnostic signal is present, not excluded, and requiresSupport met
  const eligibleCandidates = Object.entries(causes).filter(([id, c]) => {
    const hasDiag = c.diagnosticSignals.some((ds) => sig[ds]);
    if (!hasDiag) return false;

    if (isCandidateExcluded(c, sig)) return false;

    if (c.requiresSupport && c.supportOnChangedService) {
      const hasSupport = c.supportOnChangedService.some((ss) => sig[ss]);
      if (!hasSupport) return false;
    }

    return true;
  });

  // Zero-candidate handling first
  if (eligibleCandidates.length === 0) {
    return {
      classification: 'incident',
      status: 'insufficient_evidence',
      reason: 'no_eligible_cause_after_exclusions',
      suppressed: [],
      unresolvedClusters: [],
      signals: Object.keys(sig),
    };
  }

  // Check cascade collapse edges
  const edges: [string, string, string][] = []; // [suppressorId, suppressedId, reason]
  for (const [idB, cB] of eligibleCandidates) {
    for (const [idA, cA] of eligibleCandidates) {
      if (idA !== idB && collapses(cA, cB, sig, jitterMs, fallbackCounterDelta)) {
        edges.push([idA, idB, `collapsed_by_${idA}_mechanism_proven`]);
      }
    }
  }

  // Safety checks: mutual suppression or cycles
  const hasCycleOrMutual = edges.some(([a, b]) => edges.some(([x, y]) => x === b && y === a));
  const allSuppressed = eligibleCandidates.every(([id]) => edges.some(([, b]) => b === id));

  if (hasCycleOrMutual || allSuppressed) {
    return {
      classification: 'incident',
      status: 'ambiguous_multiple_causes',
      shortlist: eligibleCandidates.map(([id]) => id),
      suppressed: [],
      unresolvedClusters: [],
      reason: 'unresolved_causal_relationship_cycle',
    };
  }

  const suppressed: SuppressedCascade[] = edges.map(([by, cause, reason]) => ({
    cause,
    by,
    reason,
    evidenceIds: sig[CAUSES[cause]?.diagnosticSignals[0]]?.evidenceIds || [],
  }));

  const survivors = eligibleCandidates.filter(([id]) => !edges.some(([, b]) => b === id));

  if (survivors.length === 0) {
    return {
      classification: 'incident',
      status: 'insufficient_evidence',
      reason: 'invariant_violation_empty_survivors',
      suppressed,
      unresolvedClusters: [],
    };
  }

  const chosenCauseDef = survivors.length === 1 ? survivors[0][1] : null;
  const clusters = accountUnmatchedErrors(pack, chosenCauseDef);

  if (survivors.length === 1) {
    const singleCauseId = survivors[0][0];
    return {
      classification: 'incident',
      status: 'diagnosed',
      causeMode: 'single',
      shortlist: [singleCauseId],
      rootCauses: [singleCauseId],
      suppressed,
      unresolvedClusters: clusters,
    };
  }

  // 2 or more survivors: Check independence
  const isIndependent = areCausesIndependent(survivors, sig);
  if (isIndependent) {
    return {
      classification: 'incident',
      status: 'diagnosed',
      causeMode: 'compound',
      shortlist: survivors.map(([id]) => id),
      rootCauses: survivors.map(([id]) => id),
      suppressed,
      unresolvedClusters: clusters,
    };
  }

  // Ambiguous multiple causes
  return {
    classification: 'incident',
    status: 'ambiguous_multiple_causes',
    shortlist: survivors.map(([id]) => id),
    suppressed,
    unresolvedClusters: clusters,
    reason: 'competing_causes_cannot_be_separated',
  };
}
