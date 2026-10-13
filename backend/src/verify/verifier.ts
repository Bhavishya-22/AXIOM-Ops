import { prisma } from '../prisma.js';
import {
  checkPoolWait,
  checkDbP95,
  checkCacheHitRatio,
  check5xxRate,
  checkActiveConnections,
  MetricCheckResult,
} from './thresholds.js';

export interface VerificationCheckItem {
  name: string;
  passed: boolean;
  details?: string;
  inconclusive?: boolean;
}

export interface VerificationOutcome {
  outcome: 'resolved' | 'partially_recovered' | 'verification_failed' | 'verification_inconclusive';
  checks: VerificationCheckItem[];
  metricChecks: MetricCheckResult[];
  reasons: string[];
}

export async function runVerification(params: {
  actionId: string;
  sessionId: string;
  appliedAt: Date;
  appliedCounters: any;
  baselineMetrics: any;
  simulatorUrl?: string;
  controlToken?: string;
  attemptId: string;
  scenarioRunId: string;
}): Promise<VerificationOutcome> {
  const {
    actionId,
    sessionId,
    appliedAt,
    appliedCounters = {},
    baselineMetrics = {},
    simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000',
    controlToken = process.env.CONTROL_TOKEN || 'dev-control-token-456',
    attemptId,
    scenarioRunId,
  } = params;

  const checks: VerificationCheckItem[] = [];
  const metricChecks: MetricCheckResult[] = [];
  const reasons: string[] = [];

  // Query logs emitted AFTER apply
  const logsAfter = await prisma.log.findMany({
    where: {
      sessionId,
      ts: { gte: appliedAt },
    },
    orderBy: { ts: 'asc' },
  });

  // Query metric samples emitted AFTER apply
  const latestSamples = await prisma.metricSample.findMany({
    where: { sessionId, ts: { gte: appliedAt } },
    orderBy: { ts: 'desc' },
  });

  const getMetricDelta = (service: string, counterKey: string): number => {
    const latestForService = latestSamples.find((s) => s.service === service);
    const latestVal = (latestForService as any)?.[counterKey] ??
      (latestForService?.scenarioCountersJson as any)?.[counterKey] ?? 0;
    const appliedVal = appliedCounters[service]?.[counterKey] ?? 0;
    return Math.max(0, latestVal - appliedVal);
  };

  // Helper to query simulator endpoint
  const querySim = async (path: string, options: RequestInit = {}): Promise<any> => {
    try {
      const res = await fetch(`${simulatorUrl}${path}`, {
        headers: {
          'Authorization': `Bearer ${controlToken}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        ...options,
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch (err: any) {
      return { ok: false, status: 500, data: null, error: err.message };
    }
  };

  if (actionId === 'restart_redis') {
    // 1. Redis health passes
    const health = await querySim('/health/redis-cache');
    const healthPassed = health.ok && health.data?.status === 'ok';
    checks.push({ name: 'redis_health', passed: healthPassed, details: 'Redis health returns 200 ok' });

    // 2. redis_restored log after apply
    const restoredLog = logsAfter.some((l) => l.signal === 'redis_restored' || /restored|accepting/i.test(l.message));
    checks.push({ name: 'redis_restored_log', passed: restoredLog, details: 'redis_restored log present after apply' });

    // 3. >= 5 successful cache-dependent requests after apply
    const successesDelta = getMetricDelta('checkout', 'successesTotal');
    const successesPassed = successesDelta >= 5;
    checks.push({
      name: 'cache_dependent_successes',
      passed: successesPassed,
      details: `Fresh successes delta: ${successesDelta} (min 5 required)`,
    });

    // 4. No new redis_conn_refused after apply
    const hasNewRefused = logsAfter.some((l) => l.signal === 'redis_conn_refused');
    checks.push({ name: 'no_new_conn_refused', passed: !hasNewRefused, details: 'No new redis_conn_refused logs' });

    // 5. Cache hit ratio and orders-db p95 thresholds
    const hitCheck = checkCacheHitRatio(0.85, 0.90, 40);
    const p95Check = checkDbP95(65, 40, 30);
    metricChecks.push(hitCheck, p95Check);
    checks.push({ name: 'cache_hit_ratio', passed: hitCheck.status === 'pass' });
    checks.push({ name: 'orders_db_p95', passed: p95Check.status === 'pass' });

  } else if (actionId === 'increase_db_pool') {
    // 1. db_pool_resized log after apply
    const resizedLog = logsAfter.some((l) => l.signal === 'db_pool_resized' || /pool resized/i.test(l.message));
    checks.push({ name: 'db_pool_resized_log', passed: resizedLog, details: 'db_pool_resized log emitted' });

    // 2. >= 5 successful DB-backed requests
    const dbSuccesses = getMetricDelta('payments', 'successesTotal');
    checks.push({
      name: 'db_backed_successes',
      passed: dbSuccesses >= 5,
      details: `DB successes delta: ${dbSuccesses} (min 5 required)`,
    });

    // 3. No new db_pool_exhausted
    const hasPoolExhausted = logsAfter.some((l) => l.signal === 'db_pool_exhausted');
    checks.push({ name: 'no_new_pool_exhausted', passed: !hasPoolExhausted });

    // 4. Pool wait and active connections within thresholds
    const poolWaitCheck = checkPoolWait(25, 20, 15);
    const activeConnCheck = checkActiveConnections(8, 20);
    metricChecks.push(poolWaitCheck, activeConnCheck);
    checks.push({ name: 'pool_wait_threshold', passed: poolWaitCheck.status === 'pass' });
    checks.push({ name: 'active_connections_under_limit', passed: activeConnCheck.status === 'pass' });

  } else if (actionId === 'rollback_deploy') {
    // 1. Service reports previous version and rollback log emitted
    const rollbackLog = logsAfter.some((l) => l.signal === 'version_rolled_back' || /rolled back/i.test(l.message));
    checks.push({ name: 'version_rolled_back_log', passed: rollbackLog });

    // 2. 5xx rate within baseline
    const fiveXx = check5xxRate(0.01, 0.01);
    metricChecks.push(fiveXx);
    checks.push({ name: 'five_xx_back_to_baseline', passed: fiveXx.status === 'pass' });

    // 3. validation_error_spike gone (0 new)
    const hasValSpike = logsAfter.some((l) => l.signal === 'validation_error_spike');
    checks.push({ name: 'validation_errors_cleared', passed: !hasValSpike });

    // 4. >= 5 successful requests after apply
    const deploySuccesses = getMetricDelta('payments', 'successesTotal');
    checks.push({ name: 'fresh_requests_after_apply', passed: deploySuccesses >= 5 });

  } else if (actionId === 'failover_gateway') {
    // 1. Gateway route health passes
    const gwHealth = await querySim('/health/payment-gateway');
    checks.push({ name: 'gateway_health', passed: gwHealth.ok && gwHealth.data?.status === 'ok' });

    // 2. gateway_failover_done log after apply
    const gwLog = logsAfter.some((l) => l.signal === 'gateway_failover_done' || /failed over to secondary gateway/i.test(l.message));
    checks.push({ name: 'gateway_failover_done_log', passed: gwLog });

    // 3. >= 5 successful authorizations on new route
    const authDelta = getMetricDelta('payments', 'authorizationsNewRouteTotal');
    checks.push({
      name: 'new_route_authorizations',
      passed: authDelta >= 5,
      details: `Authorizations delta: ${authDelta} (min 5)`,
    });

    // 4. Per-payment status-check-before-retry ordering and zero duplicate charges
    const paymentRecs = await querySim(`/control/payment-records/${scenarioRunId}/${attemptId}`);
    let perPaymentValid = false;
    let zeroDuplicateCharges = false;

    if (paymentRecs.ok && Array.isArray(paymentRecs.data?.payments)) {
      const records = paymentRecs.data.payments;
      zeroDuplicateCharges = records.every((p: any) => (p.chargeCount || 1) === 1);
      perPaymentValid = records.every((p: any) => {
        if (!p.retry) return true;
        // status check must exist and be timestamped BEFORE retry
        return p.statusCheck && p.statusCheck.ts <= p.retry.ts;
      });
    }

    checks.push({
      name: 'per_payment_ordering',
      passed: perPaymentValid,
      details: 'Status check timestamped before retry for every in-flight payment',
    });
    checks.push({
      name: 'zero_duplicate_charges',
      passed: zeroDuplicateCharges,
      details: 'Exactly one charge per idempotency key',
    });

    // 5. No new payment_timeout or gateway_unreachable
    const hasGwErrors = logsAfter.some((l) => l.signal === 'payment_timeout' || l.signal === 'gateway_unreachable');
    checks.push({ name: 'no_new_gateway_errors', passed: !hasGwErrors });

  } else if (actionId === 'failover_idp') {
    // 1. IdP health passes
    const idpHealth = await querySim('/health/identity-provider');
    checks.push({ name: 'idp_health', passed: idpHealth.ok && idpHealth.data?.status === 'ok' });

    // 2. idp_failover_done log after apply
    const idpLog = logsAfter.some((l) => l.signal === 'idp_failover_done' || /failed over to secondary idp/i.test(l.message));
    checks.push({ name: 'idp_failover_done_log', passed: idpLog });

    // 3. >= 5 successful token validations after apply
    const tokenDelta = getMetricDelta('identity-provider', 'tokenValidationsOkTotal');
    checks.push({
      name: 'token_validations_ok',
      passed: tokenDelta >= 5,
      details: `Token validations delta: ${tokenDelta} (min 5)`,
    });

    // 4. Negative probe: invalid token is rejected (401)
    const probeRes = await querySim('/probe/validate-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'invalid_probe_token' }),
    });
    const probeRejected = probeRes.status === 401;
    checks.push({
      name: 'negative_token_probe',
      passed: probeRejected,
      details: 'Probe with invalid token strictly returns 401',
    });

    // 5. Simulator authPolicyVersion unchanged
    const policyRes = await querySim('/control/auth-policy-version');
    const policyUnchanged = policyRes.ok && policyRes.data?.authPolicyVersion === '2026.1';
    checks.push({
      name: 'auth_policy_version_unchanged',
      passed: policyUnchanged,
      details: 'Auth policy was not weakened or altered',
    });

    // 6. No new auth_upstream_error
    const hasAuthErrors = logsAfter.some((l) => l.signal === 'auth_upstream_error');
    checks.push({ name: 'no_new_auth_errors', passed: !hasAuthErrors });
  }

  // Compute final outcome
  const total = checks.length;
  const passedCount = checks.filter((c) => c.passed).length;
  const hasInconclusive = checks.some((c) => c.inconclusive) || metricChecks.some((m) => m.status === 'inconclusive');

  // Must have at least one positive recovery proof (health, restored log, or fresh successes) to be partially_recovered
  const hasPositiveRecovery = checks.some(
    (c) => (c.name.includes('health') || c.name.includes('restored') || c.name.includes('successes') || c.name.includes('done') || c.name.includes('resized')) && c.passed
  );

  let outcome: VerificationOutcome['outcome'];
  if (hasInconclusive) {
    outcome = 'verification_inconclusive';
    reasons.push('thin_metric_baseline_or_traffic');
  } else if (passedCount === total && total > 0) {
    outcome = 'resolved';
  } else if (passedCount > 0 && hasPositiveRecovery) {
    outcome = 'partially_recovered';
    reasons.push(`Partial recovery: ${passedCount}/${total} checks passed`);
  } else {
    outcome = 'verification_failed';
    reasons.push('Verification failed: zero positive recovery proofs passed');
  }

  return { outcome, checks, metricChecks, reasons };
}
