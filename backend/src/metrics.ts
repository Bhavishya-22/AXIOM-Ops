export interface CounterDeltaResult {
  delta: number;
  isReset: boolean;
}

/**
 * Computes counter delta respecting monotonic semantics.
 * If current < previous, a reset occurred; delta restarts from current and isReset is true.
 */
export function computeCounterDelta(previous: number, current: number): CounterDeltaResult {
  if (current < previous) {
    return { delta: current, isReset: true };
  }
  return { delta: current - previous, isReset: false };
}

export type HistogramBuckets = Record<string, number>;

export interface LatencyBucketThreshold {
  upperMs: number;
  countKey: string;
}

// Standard latency bucket order: le_50, le_100, le_250, le_500, le_1000, le_2500, le_Inf
export const DEFAULT_LATENCY_THRESHOLDS: LatencyBucketThreshold[] = [
  { upperMs: 50, countKey: 'le_50' },
  { upperMs: 100, countKey: 'le_100' },
  { upperMs: 250, countKey: 'le_250' },
  { upperMs: 500, countKey: 'le_500' },
  { upperMs: 1000, countKey: 'le_1000' },
  { upperMs: 2500, countKey: 'le_2500' },
  { upperMs: Infinity, countKey: 'le_Inf' },
];

/**
 * Calculates p95 latency from histogram bucket deltas between baseline/before and after snapshots.
 * Returns estimated p95 in milliseconds, or null if insufficient observations.
 */
export function computeP95FromHistogramDeltas(
  beforeBuckets: HistogramBuckets = {},
  afterBuckets: HistogramBuckets = {},
  thresholds: LatencyBucketThreshold[] = DEFAULT_LATENCY_THRESHOLDS
): number | null {
  // Compute delta buckets
  const deltaBuckets: { upperMs: number; count: number }[] = [];

  for (const t of thresholds) {
    const beforeCount = beforeBuckets[t.countKey] ?? 0;
    const afterCount = afterBuckets[t.countKey] ?? 0;
    const deltaCount = Math.max(0, afterCount - beforeCount);
    deltaBuckets.push({ upperMs: t.upperMs, count: deltaCount });
  }

  // The last bucket (or maximum count) is total observations in the window
  const totalObservations = deltaBuckets[deltaBuckets.length - 1]?.count ?? 0;
  if (totalObservations <= 0) {
    return null;
  }

  const targetCount = 0.95 * totalObservations;

  // Find bucket where cumulative count >= targetCount
  let prevUpper = 0;
  let prevCount = 0;

  for (const b of deltaBuckets) {
    if (b.count >= targetCount) {
      if (b.upperMs === Infinity) {
        // Fallback for unbounded tail bucket
        return prevUpper > 0 ? prevUpper * 1.5 : 3000;
      }
      // Linear interpolation within bucket
      const bucketSpan = b.upperMs - prevUpper;
      const countInBucket = b.count - prevCount;
      if (countInBucket <= 0) return b.upperMs;

      const frac = (targetCount - prevCount) / countInBucket;
      return Math.round(prevUpper + frac * bucketSpan);
    }
    prevUpper = b.upperMs;
    prevCount = b.count;
  }

  return prevUpper;
}
