import { describe, it, expect } from 'vitest';
import { traverseServiceScope } from '../backend/src/evidence-builder.js';

describe('Service Dependency Traversal (Section 20 & Section 4)', () => {
  it('traverses bidirectionally to depth 3 from checkout and encompasses all expected services', () => {
    const scope = traverseServiceScope(['checkout'], 3);
    expect(scope).toContain('checkout');
    expect(scope).toContain('payments');
    expect(scope).toContain('redis-cache');
    expect(scope).toContain('identity-provider');
    expect(scope).toContain('orders-db');
    expect(scope).toContain('payment-gateway');
  });

  it('traverses bidirectionally from orders-db and includes payments, checkout, and batch-record-service', () => {
    const scope = traverseServiceScope(['orders-db'], 3);
    expect(scope).toContain('orders-db');
    expect(scope).toContain('payments');
    expect(scope).toContain('batch-record-service');
    expect(scope).toContain('checkout');
  });

  it('traverses bidirectionally from batch-record-service and includes upstream identity-provider and orders-db', () => {
    const scope = traverseServiceScope(['batch-record-service'], 3);
    expect(scope).toContain('batch-record-service');
    expect(scope).toContain('orders-db');
    expect(scope).toContain('identity-provider');
  });
});
