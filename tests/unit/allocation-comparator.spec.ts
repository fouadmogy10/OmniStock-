interface CandidateWarehouse {
  id: string;
  priority: number;
  created_at: Date;
}

function compareWarehousesForAllocation(a: CandidateWarehouse, b: CandidateWarehouse): number {
  // 1. priority ASC (lower number = higher priority)
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  // 2. created_at ASC (older warehouse preferred)
  const aTime = a.created_at.getTime();
  const bTime = b.created_at.getTime();
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  // 3. id ASC (deterministic tie-breaker)
  return a.id.localeCompare(b.id);
}

describe('Warehouse Allocation Comparator Unit Tests (T074, F5-2)', () => {
  it('orders warehouses primarily by priority ASC', () => {
    const wh1: CandidateWarehouse = {
      id: 'wh-1',
      priority: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
    };
    const wh2: CandidateWarehouse = {
      id: 'wh-2',
      priority: 2,
      created_at: new Date('2025-01-01T00:00:00Z'),
    };

    const sorted = [wh2, wh1].sort(compareWarehousesForAllocation);
    expect(sorted[0].id).toBe('wh-1');
    expect(sorted[1].id).toBe('wh-2');
  });

  it('orders warehouses with identical priority by created_at ASC', () => {
    const older: CandidateWarehouse = {
      id: 'wh-older',
      priority: 1,
      created_at: new Date('2025-06-01T00:00:00Z'),
    };
    const newer: CandidateWarehouse = {
      id: 'wh-newer',
      priority: 1,
      created_at: new Date('2026-06-01T00:00:00Z'),
    };

    const sorted = [newer, older].sort(compareWarehousesForAllocation);
    expect(sorted[0].id).toBe('wh-older');
    expect(sorted[1].id).toBe('wh-newer');
  });

  it('orders warehouses with identical priority and created_at by id ASC', () => {
    const sameDate = new Date('2026-01-01T00:00:00Z');
    const whA: CandidateWarehouse = {
      id: 'wh-a',
      priority: 1,
      created_at: sameDate,
    };
    const whB: CandidateWarehouse = {
      id: 'wh-b',
      priority: 1,
      created_at: sameDate,
    };

    const sorted = [whB, whA].sort(compareWarehousesForAllocation);
    expect(sorted[0].id).toBe('wh-a');
    expect(sorted[1].id).toBe('wh-b');
  });
});
