interface InventoryItemState {
  on_hand: number;
  reserved: number;
  low_stock_threshold: number | null;
}

function evaluateLowStockStatus(item: InventoryItemState): 'OPEN' | 'RESOLVED' | 'NO_ALERT' {
  if (item.low_stock_threshold === null || item.low_stock_threshold <= 0) {
    return 'NO_ALERT';
  }
  const available = item.on_hand - item.reserved;
  if (available <= item.low_stock_threshold) {
    return 'OPEN';
  }
  return 'RESOLVED';
}

describe('Low Stock Evaluator Unit Tests (T074, F4-3)', () => {
  it('returns NO_ALERT when threshold is null or zero', () => {
    expect(evaluateLowStockStatus({ on_hand: 5, reserved: 0, low_stock_threshold: null })).toBe(
      'NO_ALERT',
    );
    expect(evaluateLowStockStatus({ on_hand: 0, reserved: 0, low_stock_threshold: 0 })).toBe(
      'NO_ALERT',
    );
  });

  it('returns OPEN when available <= threshold', () => {
    // available = 10, threshold = 10 -> OPEN
    expect(evaluateLowStockStatus({ on_hand: 10, reserved: 0, low_stock_threshold: 10 })).toBe(
      'OPEN',
    );
    // available = 8, threshold = 10 -> OPEN
    expect(evaluateLowStockStatus({ on_hand: 10, reserved: 2, low_stock_threshold: 10 })).toBe(
      'OPEN',
    );
    // available = 0, threshold = 5 -> OPEN
    expect(evaluateLowStockStatus({ on_hand: 5, reserved: 5, low_stock_threshold: 5 })).toBe(
      'OPEN',
    );
  });

  it('returns RESOLVED when available > threshold', () => {
    // available = 11, threshold = 10 -> RESOLVED
    expect(evaluateLowStockStatus({ on_hand: 11, reserved: 0, low_stock_threshold: 10 })).toBe(
      'RESOLVED',
    );
    // available = 15, threshold = 10 -> RESOLVED
    expect(evaluateLowStockStatus({ on_hand: 20, reserved: 5, low_stock_threshold: 10 })).toBe(
      'RESOLVED',
    );
  });
});
