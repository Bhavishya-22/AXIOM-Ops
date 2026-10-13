export const RULE_VERSION = '2026-10-r3';

export interface ServiceDefinition {
  category: string;
  team: string;
  dependsOn: string[];
  regulated?: boolean;
}

export const SERVICES: Record<string, ServiceDefinition> = {
  'orders-db':           { category: 'database', team: 'Data Platform',  dependsOn: [] },
  'redis-cache':         { category: 'cache',    team: 'Infrastructure', dependsOn: [] },
  'payment-gateway':     { category: 'external', team: 'Payments',       dependsOn: [] },
  'identity-provider':   { category: 'auth',     team: 'Identity',       dependsOn: [] },
  'payments':            { category: 'payment',  team: 'Payments',
                           dependsOn: ['orders-db', 'redis-cache', 'payment-gateway'] },
  'checkout':            { category: 'api',      team: 'Commerce',
                           dependsOn: ['payments', 'redis-cache', 'identity-provider'] },
  'batch-record-service':{ category: 'pharma',   team: 'Quality Systems', regulated: true,
                           dependsOn: ['orders-db', 'identity-provider'] },
};

export type ServiceName = keyof typeof SERVICES;
export type SignalKind = 'diagnostic' | 'supporting' | 'recovery' | 'benign' | 'health';

export interface SignalRule {
  service: string;
  patterns: RegExp[];
  signal: string;
  kind: SignalKind;
}

// kind: diagnostic | supporting | recovery | benign | health
export const SIGNAL_RULES: SignalRule[] = [
  // cache
  { service: 'redis-cache', patterns: [/connection refused/i, /econnrefused/i, /cannot connect/i], signal: 'redis_conn_refused', kind: 'diagnostic' },
  { service: 'redis-cache', patterns: [/connection restored/i, /accepting connections/i], signal: 'redis_restored', kind: 'recovery' },
  { service: 'redis-cache', patterns: [/ping ok/i], signal: 'redis_health_ok', kind: 'health' },
  { service: 'checkout',    patterns: [/cache miss/i], signal: 'cache_miss_spike', kind: 'supporting' },
  { service: 'payments',    patterns: [/cache miss/i], signal: 'cache_miss_spike', kind: 'supporting' },
  // database
  { service: 'orders-db', patterns: [/pool exhausted/i, /no free connections/i], signal: 'db_pool_exhausted', kind: 'diagnostic' },
  { service: 'orders-db', patterns: [/pool resized/i], signal: 'db_pool_resized', kind: 'recovery' },
  { service: 'orders-db', patterns: [/slow query/i], signal: 'db_slow_query', kind: 'supporting' },
  { service: 'orders-db', patterns: [/cache fallback/i, /serving reads from db/i], signal: 'cache_fallback_to_db', kind: 'supporting' }, // B4 mechanism event
  // payment
  { service: 'payments', patterns: [/gateway unreachable/i, /gateway (502|503)/i], signal: 'gateway_unreachable', kind: 'diagnostic' },
  { service: 'payments', patterns: [/gateway latency high/i, /gateway slow response/i], signal: 'gateway_latency_high', kind: 'supporting' },
  { service: 'payments', patterns: [/failed over to secondary gateway/i], signal: 'gateway_failover_done', kind: 'recovery' },
  { service: 'payments', patterns: [/timeout/i], signal: 'payment_timeout', kind: 'supporting' },
  { service: 'payments', patterns: [/card declined/i, /issuer declined/i], signal: 'payment_declined', kind: 'benign' },
  // authentication
  { service: 'identity-provider', patterns: [/idp unreachable/i, /jwks fetch failed/i], signal: 'idp_unreachable', kind: 'diagnostic' },
  { service: 'identity-provider', patterns: [/failed over to secondary idp/i], signal: 'idp_failover_done', kind: 'recovery' },
  { service: 'checkout', patterns: [/auth upstream error/i], signal: 'auth_upstream_error', kind: 'supporting' },
  { service: 'batch-record-service', patterns: [/e-sign failed/i, /sign-in failed/i], signal: 'batch_signin_failed', kind: 'supporting' },
  { service: 'checkout', patterns: [/token (expired|invalid)/i, /invalid credentials/i], signal: 'token_invalid', kind: 'benign' },
  // deployment
  { service: 'payments', patterns: [/version changed/i, /deployed v/i], signal: 'version_changed', kind: 'diagnostic' },
  { service: 'payments', patterns: [/post-deploy check ok/i], signal: 'deploy_health_ok', kind: 'health' },
  { service: 'payments', patterns: [/validation error/i], signal: 'validation_error_spike', kind: 'supporting' },
  { service: 'payments', patterns: [/rolled back/i], signal: 'version_rolled_back', kind: 'recovery' },
  // generic symptoms
  { service: 'checkout', patterns: [/status 5[0-9][0-9]/i], signal: 'checkout_5xx', kind: 'supporting' },
  { service: 'payments', patterns: [/status 5[0-9][0-9]/i], signal: 'payments_5xx', kind: 'supporting' },
];

/**
 * Match a log line against the registered signal rules for the specified service.
 * Returns { signal, kind } on first match, or null if unmatched.
 */
export function matchSignal(service: string, message: string): { signal: string; kind: SignalKind } | null {
  for (const rule of SIGNAL_RULES) {
    if (rule.service === service && rule.patterns.some((p) => p.test(message))) {
      return { signal: rule.signal, kind: rule.kind };
    }
  }
  return null;
}
