export interface TimelineEvent {
  at: number; // millisecond offset from fault onset
  service: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  variants: string[];
  counter?: {
    [key: string]: {
      perSecond?: number;
      minDelta?: number;
      from?: number;
      whileFaultActive?: boolean;
    };
  };
}

export interface ScenarioDefinition {
  name: string;
  trueCause: string | null;
  trueAction: string | null;
  isNegative?: boolean;
  expectedOutcome?: string;
  affectedServices: string[];
  failureRate: number; // e.g. 0.50 (50% requests fail while fault active)
  timeline: TimelineEvent[];
  fix?: {
    action: string;
    recoversAfterMs: number;
    emits: string[];
  };
}

export const SCENARIOS: Record<string, ScenarioDefinition> = {
  // 1. Cache Fault Family
  redis_down: {
    name: 'redis_down',
    trueCause: 'redis_unavailable',
    trueAction: 'restart_redis',
    affectedServices: ['checkout', 'payments', 'orders-db', 'redis-cache'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'redis-cache',
        level: 'ERROR',
        variants: [
          'connection refused to cache node:6379',
          'ECONNREFUSED cache:6379',
          'cannot connect to redis instance',
        ],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'WARN',
        variants: [
          'cache miss rate high during cart checkout',
          'cache miss spike on session lookup',
        ],
      },
      {
        at: 3000,
        service: 'orders-db',
        level: 'WARN',
        variants: [
          'cache fallback: serving reads from db',
          'serving reads from db directly due to cache unavailability',
        ],
        counter: {
          dbFallbackQueriesTotal: { perSecond: 10, from: 3000, whileFaultActive: true },
        },
      },
      {
        at: 4000,
        service: 'orders-db',
        level: 'WARN',
        variants: [
          'slow query on orders lookup',
          'slow query on table orders duration=4200ms',
        ],
      },
      {
        at: 6000,
        service: 'orders-db',
        level: 'ERROR',
        variants: [
          'pool exhausted, no free connections',
          'pool exhausted, cannot acquire lease',
        ],
      },
      {
        at: 7000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'upstream timeout calling orders-db',
          'upstream timeout on db pool wait',
        ],
      },
      {
        at: 9000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
          'status 503 backend error',
        ],
      },
    ],
    fix: {
      action: 'restart_redis',
      recoversAfterMs: 10000,
      emits: ['connection restored to primary node', 'accepting connections on port 6379'],
    },
  },

  // 2. Database Fault Family
  db_pool_exhausted: {
    name: 'db_pool_exhausted',
    trueCause: 'db_pool_exhausted',
    trueAction: 'increase_db_pool',
    affectedServices: ['orders-db', 'payments', 'checkout'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'orders-db',
        level: 'WARN',
        variants: [
          'slow query detected on table orders duration=4200ms',
          'slow query on orders lookup',
        ],
      },
      {
        at: 2000,
        service: 'orders-db',
        level: 'ERROR',
        variants: [
          'pool exhausted, no free connections',
          'pool exhausted, cannot acquire lease',
        ],
      },
      {
        at: 4000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'upstream timeout calling orders-db',
          'waiting on db connection timeout',
        ],
      },
      {
        at: 6000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
          'status 503 backend error',
        ],
      },
    ],
    fix: {
      action: 'increase_db_pool',
      recoversAfterMs: 8000,
      emits: ['pool resized to 40 connections', 'connection pool resized ok'],
    },
  },

  // 3. Deployment Fault Family
  bad_deploy: {
    name: 'bad_deploy',
    trueCause: 'bad_deploy',
    trueAction: 'rollback_deploy',
    affectedServices: ['payments', 'checkout'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'INFO',
        variants: [
          'deployed v2.4.1',
          'version changed to v2.4.1',
        ],
      },
      {
        at: 2000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'validation error on order payload',
          'validation error: schema mismatch on payload',
        ],
      },
      {
        at: 4000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'request failed with status 500',
          'status 502 bad gateway',
        ],
      },
      {
        at: 6000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
          'status 503 backend error',
        ],
      },
    ],
    fix: {
      action: 'rollback_deploy',
      recoversAfterMs: 8000,
      emits: ['rolled back to v2.4.0', 'version rolled back'],
    },
  },

  // 4. Payment Gateway Fault Family
  payment_gateway_down: {
    name: 'payment_gateway_down',
    trueCause: 'payment_gateway_down',
    trueAction: 'failover_gateway',
    affectedServices: ['payments', 'checkout'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'WARN',
        variants: [
          'gateway latency high: 4500ms',
          'gateway slow response detected',
        ],
      },
      {
        at: 2000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'gateway unreachable',
          'gateway 502 Bad Gateway',
          'gateway 503 Service Unavailable',
        ],
      },
      {
        at: 4000,
        service: 'payments',
        level: 'ERROR',
        variants: [
          'timeout contacting payment service',
          'payment timeout calling gateway',
        ],
      },
      {
        at: 6000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
          'status 503 backend error',
        ],
      },
    ],
    fix: {
      action: 'failover_gateway',
      recoversAfterMs: 10000,
      emits: ['failed over to secondary gateway', 'failed over to secondary gateway successfully'],
    },
  },

  // 5. Authentication Fault Family
  idp_down: {
    name: 'idp_down',
    trueCause: 'idp_down',
    trueAction: 'failover_idp',
    affectedServices: ['identity-provider', 'checkout'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'identity-provider',
        level: 'ERROR',
        variants: [
          'idp unreachable: connection timed out',
          'jwks fetch failed from auth server',
        ],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'auth upstream error validating token',
          'auth upstream error',
        ],
      },
      {
        at: 4000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
          'status 503 backend error',
        ],
      },
    ],
    fix: {
      action: 'failover_idp',
      recoversAfterMs: 10000,
      emits: ['failed over to secondary idp', 'failed over to secondary idp successfully'],
    },
  },

  // 6. Regulated Variant
  idp_down_regulated: {
    name: 'idp_down_regulated',
    trueCause: 'idp_down',
    trueAction: null, // Regulatory Hold!
    affectedServices: ['identity-provider', 'checkout', 'batch-record-service'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'identity-provider',
        level: 'ERROR',
        variants: [
          'idp unreachable: connection timed out',
          'jwks fetch failed from auth server',
        ],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'auth upstream error validating token',
          'auth upstream error',
        ],
      },
      {
        at: 3000,
        service: 'batch-record-service',
        level: 'ERROR',
        variants: [
          'e-sign failed: auth upstream error',
          'sign-in failed for operator 44',
        ],
      },
      {
        at: 5000,
        service: 'checkout',
        level: 'ERROR',
        variants: [
          'request failed with status 503',
        ],
      },
    ],
    fix: undefined,
  },

  // --- Negative Scenarios ---
  payment_decline_spike: {
    name: 'payment_decline_spike',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'not_an_incident',
    affectedServices: ['payments'],
    failureRate: 0.0,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'INFO',
        variants: ['card declined: customer insufficient funds on transaction', 'issuer declined authorization'],
      },
      {
        at: 2000,
        service: 'payments',
        level: 'INFO',
        variants: ['card declined: fraud rule check triggered', 'card declined: expired card'],
      },
    ],
  },

  token_expiry_spike: {
    name: 'token_expiry_spike',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'not_an_incident',
    affectedServices: ['checkout'],
    failureRate: 0.0,
    timeline: [
      {
        at: 0,
        service: 'checkout',
        level: 'INFO',
        variants: ['token expired at 12:00:00', 'token invalid: bad signature'],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'INFO',
        variants: ['invalid credentials entered by user', 'token expired for session'],
      },
    ],
  },

  normal_deploy: {
    name: 'normal_deploy',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'not_an_incident',
    affectedServices: ['payments'],
    failureRate: 0.0,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'INFO',
        variants: ['deployed v2.4.1', 'version changed to v2.4.1'],
      },
      {
        at: 400,
        service: 'payments',
        level: 'INFO',
        variants: ['post-deploy check ok'],
      },
      {
        at: 800,
        service: 'payments',
        level: 'INFO',
        variants: ['post-deploy check ok'],
      },
      {
        at: 1200,
        service: 'payments',
        level: 'INFO',
        variants: ['post-deploy check ok'],
      },
    ],
  },

  healthy: {
    name: 'healthy',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'insufficient_evidence',
    affectedServices: [],
    failureRate: 0.0,
    timeline: [
      {
        at: 0,
        service: 'checkout',
        level: 'WARN',
        variants: ['routine cache eviction on cold item', 'minor latency jitter observed'],
      },
    ],
  },

  unknown_errors: {
    name: 'unknown_errors',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'insufficient_evidence',
    affectedServices: ['payments'],
    failureRate: 0.40,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'ERROR',
        variants: ['unrecognized hardware glitch on cluster node #49', 'novel internal error code 99999'],
      },
    ],
  },

  supporting_only: {
    name: 'supporting_only',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'insufficient_evidence',
    affectedServices: ['checkout', 'payments'],
    failureRate: 0.40,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'ERROR',
        variants: ['timeout contacting payment service', 'upstream timeout'],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'ERROR',
        variants: ['request failed with status 503', 'status 500 internal error'],
      },
    ],
  },

  ambiguous: {
    name: 'ambiguous',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'ambiguous_multiple_causes',
    affectedServices: ['payments', 'identity-provider'],
    failureRate: 0.40,
    timeline: [
      {
        at: 0,
        service: 'payments',
        level: 'ERROR',
        variants: ['gateway unreachable', 'gateway 502 Bad Gateway'],
      },
      {
        at: 1000,
        service: 'identity-provider',
        level: 'ERROR',
        variants: ['idp unreachable: connection timed out', 'jwks fetch failed from auth server'],
      },
    ],
  },

  redis_plus_independent_db: {
    name: 'redis_plus_independent_db',
    trueCause: null,
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'ambiguous_multiple_causes',
    affectedServices: ['redis-cache', 'orders-db', 'checkout'],
    failureRate: 0.45,
    timeline: [
      {
        at: 0,
        service: 'redis-cache',
        level: 'ERROR',
        variants: ['connection refused to cache node:6379'],
      },
      {
        at: 1000,
        service: 'orders-db',
        level: 'ERROR',
        variants: ['pool exhausted, no free connections'],
      },
      {
        at: 3000,
        service: 'checkout',
        level: 'ERROR',
        variants: ['request failed with status 503'],
      },
    ],
  },

  redis_with_unexplained_cluster: {
    name: 'redis_with_unexplained_cluster',
    trueCause: 'redis_unavailable',
    trueAction: null, // manual recommended due to unexplained cluster
    isNegative: true,
    expectedOutcome: 'diagnosed_manual_only',
    affectedServices: ['redis-cache', 'checkout', 'payments'],
    failureRate: 0.45,
    timeline: [
      {
        at: 0,
        service: 'redis-cache',
        level: 'ERROR',
        variants: ['connection refused to cache node:6379'],
      },
      {
        at: 400,
        service: 'payments',
        level: 'ERROR',
        variants: ['unexplained memory corruption on payments processor'],
      },
      {
        at: 800,
        service: 'payments',
        level: 'ERROR',
        variants: ['unexplained memory corruption on payments processor'],
      },
      {
        at: 1200,
        service: 'payments',
        level: 'ERROR',
        variants: ['unexplained memory corruption on payments processor'],
      },
      {
        at: 2000,
        service: 'checkout',
        level: 'ERROR',
        variants: ['request failed with status 503'],
      },
    ],
  },

  compound: {
    name: 'compound',
    trueCause: 'compound',
    trueAction: null,
    isNegative: true,
    expectedOutcome: 'diagnosed_compound',
    affectedServices: ['redis-cache', 'identity-provider', 'checkout'],
    failureRate: 0.50,
    timeline: [
      {
        at: 0,
        service: 'redis-cache',
        level: 'ERROR',
        variants: ['connection refused to cache node:6379'],
      },
      {
        at: 1000,
        service: 'checkout',
        level: 'WARN',
        variants: ['cache miss rate high during cart checkout'],
      },
      {
        at: 2000,
        service: 'identity-provider',
        level: 'ERROR',
        variants: ['idp unreachable: connection timed out'],
      },
      {
        at: 3000,
        service: 'checkout',
        level: 'ERROR',
        variants: ['auth upstream error validating token'],
      },
    ],
  },
};
