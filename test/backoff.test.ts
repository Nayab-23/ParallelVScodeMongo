import { describe, expect, it } from 'vitest';

import { computeBackoff } from '../src/util/backoff';

describe('computeBackoff', () => {
  it('applies exponential growth with jitter', () => {
    const delay = computeBackoff(2, 1000, 30000, () => 0.5);
    expect(delay).toBe(3000);
  });

  it('caps at the maximum', () => {
    const delay = computeBackoff(10, 1000, 5000, () => 0);
    expect(delay).toBe(2500);
  });
});
