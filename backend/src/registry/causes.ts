// effects = causal-effect registry. A downstream signal is explained by a cause only when its
// mechanism signals are present AND correctly ordered AND the cause came first.
// The dependency graph is never used for this.
// privateSupport = signals that corroborate THIS cause and that no other cause's effects explain.
// symptomSignatures = explicit (service, message pattern, maxLagMs) entries for UNMATCHED errors that are known
// symptoms of this cause. A service name plus a time window never explains an error.

export interface SymptomSignature {
  service: string;
  pattern: RegExp;
  maxLagMs: number;
}

export interface CausalEffect {
  signal: string;
  mechanism: string[];
  mechanismCounter?: { name: string; minDelta: number };
  maxLagMs: number;
}

export interface ExclusionRule {
  signal: string;
  probes: number;
  minSpanMs: number;
}

export interface CauseDefinition {
  diagnosticSignals: string[];
  supportingSignals: string[];
  privateSupport: string[];
  symptomSignatures: SymptomSignature[];
  effects: CausalEffect[];
  excludedBy: ExclusionRule | null;
  compatibleAction: string;
  targetService: string;
  risk: 'low' | 'medium' | 'high';
  executable: boolean;
  requiresSupport?: boolean;
  supportOnChangedService?: string[];
  observationMs?: number;
}

export const CAUSES: Record<string, CauseDefinition> = {
  redis_unavailable: {
    diagnosticSignals: ['redis_conn_refused'],
    supportingSignals: ['cache_miss_spike', 'cache_fallback_to_db', 'db_slow_query', 'payment_timeout', 'checkout_5xx'],
    privateSupport: ['cache_miss_spike'],
    symptomSignatures: [
      { service: 'payments',  pattern: /upstream timeout calling orders-db/i, maxLagMs: 60000 },
      { service: 'checkout',  pattern: /request failed with status 5\d\d/i,   maxLagMs: 90000 },
      { service: 'orders-db', pattern: /connection (wait|queue) (high|growing)/i, maxLagMs: 60000 },
    ],
    effects: [
      { signal: 'db_pool_exhausted', mechanism: ['cache_fallback_to_db'],
        mechanismCounter: { name: 'dbFallbackQueriesTotal', minDelta: 20 }, maxLagMs: 60000 },
      { signal: 'payment_timeout', mechanism: ['cache_miss_spike'], maxLagMs: 60000 },
      { signal: 'checkout_5xx',    mechanism: [], maxLagMs: 90000 },
    ],
    excludedBy: { signal: 'redis_health_ok', probes: 3, minSpanMs: 30000 }, // must overlap this cause's own signal range
    compatibleAction: 'restart_redis', targetService: 'redis-cache', risk: 'low', executable: true,
  },
  db_pool_exhausted: {
    diagnosticSignals: ['db_pool_exhausted'],
    supportingSignals: ['db_slow_query', 'payment_timeout', 'checkout_5xx'],
    privateSupport: ['db_slow_query'],
    symptomSignatures: [
      { service: 'payments', pattern: /waiting on db connection/i, maxLagMs: 60000 },
      { service: 'checkout', pattern: /request failed with status 5\d\d/i, maxLagMs: 90000 },
    ],
    effects: [
      { signal: 'payment_timeout', mechanism: [], maxLagMs: 60000 },
      { signal: 'checkout_5xx',    mechanism: [], maxLagMs: 90000 },
    ],
    excludedBy: null,
    compatibleAction: 'increase_db_pool', targetService: 'orders-db', risk: 'medium', executable: true,
  },
  payment_gateway_down: {
    diagnosticSignals: ['gateway_unreachable'],
    supportingSignals: ['gateway_latency_high', 'payment_timeout', 'checkout_5xx'],
    privateSupport: ['gateway_latency_high'],
    symptomSignatures: [
      { service: 'payments', pattern: /gateway retry (queued|exhausted)/i, maxLagMs: 60000 },
      { service: 'checkout', pattern: /request failed with status 5\d\d/i, maxLagMs: 90000 },
    ],
    effects: [
      { signal: 'payment_timeout', mechanism: [], maxLagMs: 60000 },
      { signal: 'checkout_5xx',    mechanism: [], maxLagMs: 90000 },
    ],
    excludedBy: null,
    compatibleAction: 'failover_gateway', targetService: 'payment-gateway', risk: 'medium', executable: true,
  },
  idp_down: {
    diagnosticSignals: ['idp_unreachable'],
    supportingSignals: ['auth_upstream_error', 'batch_signin_failed', 'checkout_5xx'],
    privateSupport: ['auth_upstream_error'],
    symptomSignatures: [
      { service: 'checkout',             pattern: /session lookup failed/i,            maxLagMs: 60000 },
      { service: 'batch-record-service', pattern: /signature service unavailable/i,    maxLagMs: 60000 },
    ],
    effects: [
      { signal: 'auth_upstream_error', mechanism: [], maxLagMs: 60000 },
      { signal: 'batch_signin_failed', mechanism: [], maxLagMs: 60000 },
      { signal: 'checkout_5xx',        mechanism: [], maxLagMs: 90000 },
    ],
    excludedBy: null,
    compatibleAction: 'failover_idp', targetService: 'identity-provider', risk: 'medium', executable: true,
  },
  bad_deploy: {
    diagnosticSignals: ['version_changed'],
    requiresSupport: true,
    supportOnChangedService: ['validation_error_spike', 'payments_5xx'], // must come from the changed service
    observationMs: 120000,                                               // healthy this long = not an incident
    supportingSignals: ['validation_error_spike', 'payments_5xx', 'checkout_5xx'],
    privateSupport: ['validation_error_spike'],
    symptomSignatures: [
      { service: 'payments', pattern: /schema mismatch on payload/i, maxLagMs: 60000 },
      { service: 'checkout', pattern: /request failed with status 5\d\d/i, maxLagMs: 90000 },
    ],
    effects: [
      { signal: 'validation_error_spike', mechanism: [], maxLagMs: 60000 },
      { signal: 'payments_5xx',           mechanism: [], maxLagMs: 90000 },
      { signal: 'checkout_5xx',           mechanism: [], maxLagMs: 90000 },
    ],
    excludedBy: null,
    compatibleAction: 'rollback_deploy', targetService: 'payments', risk: 'medium', executable: true,
  },
};
// executable flips to true per cause only after that scenario is remediation-supported.

export const ALLOWLIST = [
  'restart_redis',
  'increase_db_pool',
  'rollback_deploy',
  'failover_gateway',
  'failover_idp',
] as const;

export type ActionId = (typeof ALLOWLIST)[number];
export type CauseId = keyof typeof CAUSES;
