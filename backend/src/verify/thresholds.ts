/**
 * Threshold configuration and rule helpers per Section 12.
 */
export const THRESHOLDS = {
  poolWait:    { mult: 1.5, floorMs: 50,  minSamples: 10 },
  dbP95:       { mult: 2.0, floorMs: 100, minObservations: 20 },
  cacheHit:    { mult: 0.8, floorRatio: 0.5, minLookups: 30, minBaselineRatio: 0.3 },
  fiveXx:      { maxDeltaPct: 1 },
  activeConns: { maxShareOfLimit: 0.8 },
};

export type CheckStatus = 'pass' | 'fail' | 'inconclusive';

export interface MetricCheckResult {
  checkName: string;
  status: CheckStatus;
  observed: number;
  baseline: number;
  threshold: number;
  reason?: string;
}

export function checkPoolWait(
  afterWaitMs: number,
  baselineWaitMs: number,
  sampleCount: number
): MetricCheckResult {
  const { mult, floorMs, minSamples } = THRESHOLDS.poolWait;
  if (sampleCount < minSamples) {
    return {
      checkName: 'poolWait',
      status: 'inconclusive',
      observed: afterWaitMs,
      baseline: baselineWaitMs,
      threshold: floorMs,
      reason: 'thin_data_insufficient_samples',
    };
  }

  const threshold = Math.max(mult * baselineWaitMs, floorMs);
  const status = afterWaitMs <= threshold ? 'pass' : 'fail';
  return { checkName: 'poolWait', status, observed: afterWaitMs, baseline: baselineWaitMs, threshold };
}

export function checkDbP95(
  afterP95Ms: number,
  baselineP95Ms: number,
  observationCount: number
): MetricCheckResult {
  const { mult, floorMs, minObservations } = THRESHOLDS.dbP95;
  if (observationCount < minObservations) {
    return {
      checkName: 'dbP95',
      status: 'inconclusive',
      observed: afterP95Ms,
      baseline: baselineP95Ms,
      threshold: floorMs,
      reason: 'thin_data_insufficient_observations',
    };
  }

  const threshold = Math.max(mult * baselineP95Ms, floorMs);
  const status = afterP95Ms <= threshold ? 'pass' : 'fail';
  return { checkName: 'dbP95', status, observed: afterP95Ms, baseline: baselineP95Ms, threshold };
}

export function checkCacheHitRatio(
  afterRatio: number,
  baselineRatio: number,
  totalLookups: number
): MetricCheckResult {
  const { mult, floorRatio, minLookups, minBaselineRatio } = THRESHOLDS.cacheHit;
  if (totalLookups < minLookups || baselineRatio < minBaselineRatio) {
    return {
      checkName: 'cacheHit',
      status: 'inconclusive',
      observed: afterRatio,
      baseline: baselineRatio,
      threshold: floorRatio,
      reason: 'thin_data_insufficient_lookups_or_baseline',
    };
  }

  const threshold = Math.max(mult * baselineRatio, floorRatio);
  const status = afterRatio >= threshold ? 'pass' : 'fail';
  return { checkName: 'cacheHit', status, observed: afterRatio, baseline: baselineRatio, threshold };
}

export function check5xxRate(afterPct: number, baselinePct: number): MetricCheckResult {
  const { maxDeltaPct } = THRESHOLDS.fiveXx;
  const threshold = baselinePct + maxDeltaPct;
  const status = afterPct <= threshold ? 'pass' : 'fail';
  return { checkName: 'fiveXxRate', status, observed: afterPct, baseline: baselinePct, threshold };
}

export function checkActiveConnections(active: number, limit: number = 20): MetricCheckResult {
  const { maxShareOfLimit } = THRESHOLDS.activeConns;
  const threshold = limit * maxShareOfLimit;
  const status = active < threshold ? 'pass' : 'fail';
  return { checkName: 'activeConnections', status, observed: active, baseline: 0, threshold };
}
