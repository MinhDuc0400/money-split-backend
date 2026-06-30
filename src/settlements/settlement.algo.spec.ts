import { calculateMinimalTransfers } from './settlement.algo';

describe('calculateMinimalTransfers', () => {
  it('should return empty list for no balances', () => {
    expect(calculateMinimalTransfers([])).toEqual([]);
  });

  it('should throw error if balances do not sum to zero', () => {
    expect(() =>
      calculateMinimalTransfers([{ memberId: '1', amountCents: 10 }]),
    ).toThrow(/Balances do not sum to zero/);
  });

  it('should solve simple 1-to-1 debt', () => {
    // A owes 10, B is owed 10
    const balances = [
      { memberId: 'A', amountCents: -10 },
      { memberId: 'B', amountCents: 10 },
    ];
    const transfers = calculateMinimalTransfers(balances);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toEqual({ fromId: 'A', toId: 'B', amountCents: 10 });
  });

  it('should solve 3-person circular debt', () => {
    // A owes B 10, B owes C 10, C owes A 10.
    // Net: A: 0, B: 0, C: 0.
    // If net is 0, no transfers needed.
    const balances = [
      { memberId: 'A', amountCents: 0 },
      { memberId: 'B', amountCents: 0 },
      { memberId: 'C', amountCents: 0 },
    ];
    expect(calculateMinimalTransfers(balances)).toEqual([]);
  });

  it('should solve 3-person chain debt', () => {
    // A owes 10 (net -10)
    // B owes 0 (net 0) but maybe involved? If net 0 they are ignored.
    // C is owed 10 (net 10)
    // A -> C 10
    const balances = [
      { memberId: 'A', amountCents: -10 },
      { memberId: 'B', amountCents: 0 },
      { memberId: 'C', amountCents: 10 },
    ];
    const transfers = calculateMinimalTransfers(balances);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toEqual({ fromId: 'A', toId: 'C', amountCents: 10 });
  });

  it('should solve multi-debtor multi-creditor scenario', () => {
    // A: -10
    // B: -20
    // C: +15
    // D: +15
    const balances = [
      { memberId: 'A', amountCents: -10 },
      { memberId: 'B', amountCents: -20 },
      { memberId: 'C', amountCents: 15 },
      { memberId: 'D', amountCents: 15 },
    ];
    // Greedy algo:
    // Debtors: B(-20), A(-10)
    // Creditors: C(15), D(15) -- order depends on sort stability for equal values, let's assume one first

    // 1. B(-20) pays C(15) -> 15. B remains -5. C done.
    // 2. B(-5) pays D(15) -> 5. B done. D remains 10.
    // 3. A(-10) pays D(10) -> 10. A done. D done.

    const transfers = calculateMinimalTransfers(balances);

    const totalTransferred = transfers.reduce(
      (acc, t) => acc + t.amountCents,
      0,
    );
    expect(totalTransferred).toBe(30); // Total positive sum

    // Check individual flow validity
    const netChange: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const t of transfers) {
      netChange[t.fromId] -= t.amountCents;
      netChange[t.toId] += t.amountCents;
    }
    expect(netChange['A']).toBe(10); // Was -10, paid 10, net 0
    expect(netChange['B']).toBe(20); // Was -20, paid 20, net 0
    expect(netChange['C']).toBe(-15); // Was +15, received 15, net 0
    expect(netChange['D']).toBe(-15); // Was +15, received 15, net 0
  });
});
