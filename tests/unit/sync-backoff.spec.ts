function computeExponentialBackoffSeconds(k: number): number {
  if (k <= 0) return 30;
  return Math.min(30 * Math.pow(2, k - 1), 3600);
}

describe('Sync Exponential Backoff Unit Tests (T074, F7-2)', () => {
  it('computes expected exponential delays for k = 1..5', () => {
    expect(computeExponentialBackoffSeconds(1)).toBe(30);
    expect(computeExponentialBackoffSeconds(2)).toBe(60);
    expect(computeExponentialBackoffSeconds(3)).toBe(120);
    expect(computeExponentialBackoffSeconds(4)).toBe(240);
    expect(computeExponentialBackoffSeconds(5)).toBe(480);
  });

  it('caps backoff delay at 3600 seconds (1 hour)', () => {
    expect(computeExponentialBackoffSeconds(8)).toBe(3600);
    expect(computeExponentialBackoffSeconds(10)).toBe(3600);
    expect(computeExponentialBackoffSeconds(20)).toBe(3600);
  });
});
