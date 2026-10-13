import { describe, it, expect } from 'vitest';
import { matchSignal, SIGNAL_RULES, RULE_VERSION, SERVICES } from '@axiomops/shared';

describe('Signal Rules Contract Tests (Section 4 & Section 20)', () => {
  it('has rule version 2026-10-r3', () => {
    expect(RULE_VERSION).toBe('2026-10-r3');
  });

  describe('Cache Fault Family (redis-cache, checkout, payments)', () => {
    it('maps connection refused patterns to redis_conn_refused (diagnostic)', () => {
      const m1 = matchSignal('redis-cache', 'connection refused to cache node:6379');
      expect(m1).toEqual({ signal: 'redis_conn_refused', kind: 'diagnostic' });

      const m2 = matchSignal('redis-cache', 'ECONNREFUSED 127.0.0.1:6379');
      expect(m2).toEqual({ signal: 'redis_conn_refused', kind: 'diagnostic' });

      const m3 = matchSignal('redis-cache', 'cannot connect to cache cluster');
      expect(m3).toEqual({ signal: 'redis_conn_refused', kind: 'diagnostic' });
    });

    it('maps recovery messages to redis_restored (recovery)', () => {
      const m1 = matchSignal('redis-cache', 'connection restored to primary node');
      expect(m1).toEqual({ signal: 'redis_restored', kind: 'recovery' });

      const m2 = matchSignal('redis-cache', 'accepting connections on port 6379');
      expect(m2).toEqual({ signal: 'redis_restored', kind: 'recovery' });
    });

    it('maps health pings to redis_health_ok (health)', () => {
      const m = matchSignal('redis-cache', 'ping ok');
      expect(m).toEqual({ signal: 'redis_health_ok', kind: 'health' });
    });

    it('maps cache miss messages to cache_miss_spike (supporting)', () => {
      const m1 = matchSignal('checkout', 'cache miss rate high during cart checkout');
      expect(m1).toEqual({ signal: 'cache_miss_spike', kind: 'supporting' });

      const m2 = matchSignal('payments', 'cache miss on payment token');
      expect(m2).toEqual({ signal: 'cache_miss_spike', kind: 'supporting' });
    });
  });

  describe('Database Fault Family (orders-db)', () => {
    it('maps pool exhausted to db_pool_exhausted (diagnostic)', () => {
      const m1 = matchSignal('orders-db', 'pool exhausted, cannot acquire lease');
      expect(m1).toEqual({ signal: 'db_pool_exhausted', kind: 'diagnostic' });

      const m2 = matchSignal('orders-db', 'no free connections in pool');
      expect(m2).toEqual({ signal: 'db_pool_exhausted', kind: 'diagnostic' });
    });

    it('maps pool resized to db_pool_resized (recovery)', () => {
      const m = matchSignal('orders-db', 'pool resized to 40 connections');
      expect(m).toEqual({ signal: 'db_pool_resized', kind: 'recovery' });
    });

    it('maps slow query to db_slow_query (supporting)', () => {
      const m = matchSignal('orders-db', 'slow query detected on table orders duration=4200ms');
      expect(m).toEqual({ signal: 'db_slow_query', kind: 'supporting' });
    });

    it('maps cache fallback mechanism to cache_fallback_to_db (supporting)', () => {
      const m1 = matchSignal('orders-db', 'cache fallback: serving reads from db');
      expect(m1).toEqual({ signal: 'cache_fallback_to_db', kind: 'supporting' });

      const m2 = matchSignal('orders-db', 'serving reads from db directly');
      expect(m2).toEqual({ signal: 'cache_fallback_to_db', kind: 'supporting' });
    });
  });

  describe('Payment Gateway Fault Family (payments)', () => {
    it('maps gateway unreachable and 502/503 to gateway_unreachable (diagnostic)', () => {
      const m1 = matchSignal('payments', 'gateway unreachable for intent pi_123');
      expect(m1).toEqual({ signal: 'gateway_unreachable', kind: 'diagnostic' });

      const m2 = matchSignal('payments', 'gateway 502 Bad Gateway');
      expect(m2).toEqual({ signal: 'gateway_unreachable', kind: 'diagnostic' });

      const m3 = matchSignal('payments', 'gateway 503 Service Unavailable');
      expect(m3).toEqual({ signal: 'gateway_unreachable', kind: 'diagnostic' });
    });

    it('maps high latency to gateway_latency_high (supporting)', () => {
      const m1 = matchSignal('payments', 'gateway latency high: 4500ms');
      expect(m1).toEqual({ signal: 'gateway_latency_high', kind: 'supporting' });

      const m2 = matchSignal('payments', 'gateway slow response on charge request');
      expect(m2).toEqual({ signal: 'gateway_latency_high', kind: 'supporting' });
    });

    it('maps failover completion to gateway_failover_done (recovery)', () => {
      const m = matchSignal('payments', 'failed over to secondary gateway successfully');
      expect(m).toEqual({ signal: 'gateway_failover_done', kind: 'recovery' });
    });

    it('maps timeout to payment_timeout (supporting)', () => {
      const m = matchSignal('payments', 'timeout contacting payment service');
      expect(m).toEqual({ signal: 'payment_timeout', kind: 'supporting' });
    });

    it('maps card declines to payment_declined (benign)', () => {
      const m1 = matchSignal('payments', 'card declined: insufficient funds');
      expect(m1).toEqual({ signal: 'payment_declined', kind: 'benign' });

      const m2 = matchSignal('payments', 'issuer declined authorization');
      expect(m2).toEqual({ signal: 'payment_declined', kind: 'benign' });
    });
  });

  describe('Authentication Fault Family (identity-provider, checkout, batch-record-service)', () => {
    it('maps IdP unreachable and JWKS failures to idp_unreachable (diagnostic)', () => {
      const m1 = matchSignal('identity-provider', 'idp unreachable: connection timed out');
      expect(m1).toEqual({ signal: 'idp_unreachable', kind: 'diagnostic' });

      const m2 = matchSignal('identity-provider', 'jwks fetch failed from auth server');
      expect(m2).toEqual({ signal: 'idp_unreachable', kind: 'diagnostic' });
    });

    it('maps IdP failover to idp_failover_done (recovery)', () => {
      const m = matchSignal('identity-provider', 'failed over to secondary idp');
      expect(m).toEqual({ signal: 'idp_failover_done', kind: 'recovery' });
    });

    it('maps auth upstream error to auth_upstream_error (supporting)', () => {
      const m = matchSignal('checkout', 'auth upstream error validating token');
      expect(m).toEqual({ signal: 'auth_upstream_error', kind: 'supporting' });
    });

    it('maps batch record sign-in failure to batch_signin_failed (supporting)', () => {
      const m1 = matchSignal('batch-record-service', 'e-sign failed during batch release');
      expect(m1).toEqual({ signal: 'batch_signin_failed', kind: 'supporting' });

      const m2 = matchSignal('batch-record-service', 'sign-in failed for operator 44');
      expect(m2).toEqual({ signal: 'batch_signin_failed', kind: 'supporting' });
    });

    it('maps invalid/expired tokens to token_invalid (benign)', () => {
      const m1 = matchSignal('checkout', 'token expired at 11:30:00');
      expect(m1).toEqual({ signal: 'token_invalid', kind: 'benign' });

      const m2 = matchSignal('checkout', 'token invalid: signature mismatch');
      expect(m2).toEqual({ signal: 'token_invalid', kind: 'benign' });

      const m3 = matchSignal('checkout', 'invalid credentials entered by user');
      expect(m3).toEqual({ signal: 'token_invalid', kind: 'benign' });
    });
  });

  describe('Deployment Fault Family (payments)', () => {
    it('maps version changes to version_changed (diagnostic)', () => {
      const m1 = matchSignal('payments', 'version changed to v2.4.1');
      expect(m1).toEqual({ signal: 'version_changed', kind: 'diagnostic' });

      const m2 = matchSignal('payments', 'deployed v2.4.1');
      expect(m2).toEqual({ signal: 'version_changed', kind: 'diagnostic' });
    });

    it('maps post-deploy check to deploy_health_ok (health)', () => {
      const m = matchSignal('payments', 'post-deploy check ok');
      expect(m).toEqual({ signal: 'deploy_health_ok', kind: 'health' });
    });

    it('maps validation errors to validation_error_spike (supporting)', () => {
      const m = matchSignal('payments', 'validation error on order schema');
      expect(m).toEqual({ signal: 'validation_error_spike', kind: 'supporting' });
    });

    it('maps rollback to version_rolled_back (recovery)', () => {
      const m = matchSignal('payments', 'rolled back to previous release');
      expect(m).toEqual({ signal: 'version_rolled_back', kind: 'recovery' });
    });
  });

  describe('Generic 5xx Symptoms (checkout, payments)', () => {
    it('maps 5xx status codes to checkout_5xx and payments_5xx', () => {
      const m1 = matchSignal('checkout', 'request failed with status 500');
      expect(m1).toEqual({ signal: 'checkout_5xx', kind: 'supporting' });

      const m2 = matchSignal('checkout', 'status 503 backend error');
      expect(m2).toEqual({ signal: 'checkout_5xx', kind: 'supporting' });

      const m3 = matchSignal('payments', 'status 502 bad gateway');
      expect(m3).toEqual({ signal: 'payments_5xx', kind: 'supporting' });
    });
  });

  describe('Service Boundary & Unmatched Message Handling', () => {
    it('returns null when service does not match rule service', () => {
      // "connection refused" belongs to redis-cache, not checkout
      const m = matchSignal('checkout', 'connection refused');
      expect(m).toBeNull();
    });

    it('returns null for unrecognised logs', () => {
      const m = matchSignal('payments', 'customer updated shipping address');
      expect(m).toBeNull();
    });
  });
});
