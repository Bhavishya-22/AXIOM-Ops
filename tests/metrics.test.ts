import { describe, it, expect } from 'vitest';
import {
  computeCounterDelta,
  computeP95FromHistogramDeltas,
  DEFAULT_LATENCY_THRESHOLDS,
} from '../backend/src/metrics.js';

describe('Metrics Utilities (Item 4)', () => {
  describe('Counter Reset Handling', () => {
    it('computes positive delta when counter increases monotonically', () => {
      const res = computeCounterDelta(100, 150);
      expect(res).toEqual({ delta: 50, isReset: false });
    });

    it('detects counter reset when current counter is less than previous', () => {
      // Counter was 150, but server restarted and reset to 25
      const res = computeCounterDelta(150, 25);
      expect(res).toEqual({ delta: 25, isReset: true });
    });

    it('handles zero delta when counter is unchanged', () => {
      const res = computeCounterDelta(200, 200);
      expect(res).toEqual({ delta: 0, isReset: false });
    });
  });

  describe('p95 Latency from Histogram Bucket Deltas', () => {
    it('returns null when there are zero delta observations', () => {
      const buckets = { le_50: 10, le_100: 20, le_Inf: 20 };
      const res = computeP95FromHistogramDeltas(buckets, buckets);
      expect(res).toBeNull();
    });

    it('interpolates p95 latency accurately from bucket deltas', () => {
      // 100 requests: 50 <= 50ms, 40 between 50-100ms (90 <= 100ms), 10 between 100-250ms (100 <= 250ms)
      // 95th percentile falls in 100-250ms bucket
      const before = {
        le_50: 0,
        le_100: 0,
        le_250: 0,
        le_500: 0,
        le_1000: 0,
        le_2500: 0,
        le_Inf: 0,
      };
      const after = {
        le_50: 50,
        le_100: 90,
        le_250: 100,
        le_500: 100,
        le_1000: 100,
        le_2500: 100,
        le_Inf: 100,
      };

      const p95 = computeP95FromHistogramDeltas(before, after);
      expect(p95).not.toBeNull();
      // Target is 95. From 90 to 100 in span [100, 250]: 100 + (5/10) * 150 = 175ms
      expect(p95).toBe(175);
    });

    it('calculates p95 when all observations are in lowest bucket', () => {
      const before = { le_50: 10, le_Inf: 10 };
      const after = { le_50: 110, le_Inf: 110 };
      const p95 = computeP95FromHistogramDeltas(before, after);
      expect(p95).not.toBeNull();
      expect(p95).toBeLessThanOrEqual(50);
    });
  });
});
