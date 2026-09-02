import { BadRequestException } from '@nestjs/common';
import { SplitType } from '@prisma/client';
import {
  allocateByWeights,
  calculateDebtFlows,
  validatePayersTotal,
  calculateSplitData,
} from './split-calculations';

describe('allocateByWeights', () => {
  it('distributes by largest-remainder when the split does not divide evenly', () => {
    expect(allocateByWeights([1, 1, 1], 100)).toEqual([34, 33, 33]);
  });

  it('divides evenly with no remainder to distribute', () => {
    expect(allocateByWeights([1, 1], 10000)).toEqual([5000, 5000]);
  });

  it('throws BadRequestException when total weight is zero', () => {
    expect(() => allocateByWeights([0, 0], 100)).toThrow(BadRequestException);
    expect(() => allocateByWeights([0, 0], 100)).toThrow(
      'Total weight must be greater than 0',
    );
  });
});

describe('calculateDebtFlows', () => {
  it('maps a single payer to a single non-payer splitter for the full amount', () => {
    const flows = calculateDebtFlows(
      [{ memberId: 'A', amount: 30 }],
      [{ memberId: 'B', amountCents: 3000 }],
    );
    expect(flows).toEqual([
      { debtorId: 'B', creditorId: 'A', amountCents: 3000 },
    ]);
  });

  it('splits a single splitter debt proportionally across multiple payers', () => {
    const flows = calculateDebtFlows(
      [
        { memberId: 'A', amount: 60 },
        { memberId: 'B', amount: 40 },
      ],
      [{ memberId: 'C', amountCents: 10000 }],
    );
    expect(flows).toEqual([
      { debtorId: 'C', creditorId: 'A', amountCents: 6000 },
      { debtorId: 'C', creditorId: 'B', amountCents: 4000 },
    ]);
  });

  it('does not create a flow between a payer and themselves as a splitter', () => {
    const flows = calculateDebtFlows(
      [{ memberId: 'A', amount: 50 }],
      [{ memberId: 'A', amountCents: 5000 }],
    );
    expect(flows).toEqual([]);
  });
});

describe('validatePayersTotal', () => {
  it('does not throw when payer amounts sum to the total', () => {
    expect(() => validatePayersTotal([{ amount: 50 }], 5000, 50)).not.toThrow();
  });

  it('throws BadRequestException with both amounts when they mismatch', () => {
    expect(() => validatePayersTotal([{ amount: 40 }], 5000, 50)).toThrow(
      BadRequestException,
    );
    expect(() => validatePayersTotal([{ amount: 40 }], 5000, 50)).toThrow(
      'Total payers amount (40) must equal expense amount (50)',
    );
  });
});

describe('calculateSplitData', () => {
  it('computes an EVEN split across participants', () => {
    const result = calculateSplitData(SplitType.EVEN, 10000, 100, [
      { memberId: 'A' },
      { memberId: 'B' },
    ]);
    expect(result).toEqual([
      { memberId: 'A', amountCents: 5000 },
      { memberId: 'B', amountCents: 5000 },
    ]);
  });

  it('throws BadRequestException for EVEN with no participants', () => {
    expect(() => calculateSplitData(SplitType.EVEN, 10000, 100, [])).toThrow(
      'At least one participant is required',
    );
  });

  it('computes an EXACT split from given amounts', () => {
    const result = calculateSplitData(SplitType.EXACT, 10000, 100, [
      { memberId: 'A', amount: 30 },
      { memberId: 'B', amount: 70 },
    ]);
    expect(result).toEqual([
      { memberId: 'A', amountCents: 3000 },
      { memberId: 'B', amountCents: 7000 },
    ]);
  });

  it('throws BadRequestException when EXACT amounts do not sum to the total', () => {
    expect(() =>
      calculateSplitData(SplitType.EXACT, 10000, 100, [
        { memberId: 'A', amount: 30 },
        { memberId: 'B', amount: 60 },
      ]),
    ).toThrow(BadRequestException);
  });

  it('computes a PERCENTAGE split', () => {
    const result = calculateSplitData(SplitType.PERCENTAGE, 10000, 100, [
      { memberId: 'A', percentage: 50 },
      { memberId: 'B', percentage: 50 },
    ]);
    expect(result).toEqual([
      { memberId: 'A', amountCents: 5000, percentage: 50 },
      { memberId: 'B', amountCents: 5000, percentage: 50 },
    ]);
  });

  it('throws BadRequestException when percentages do not sum to 100', () => {
    expect(() =>
      calculateSplitData(SplitType.PERCENTAGE, 10000, 100, [
        { memberId: 'A', percentage: 40 },
        { memberId: 'B', percentage: 40 },
      ]),
    ).toThrow('Percentages must sum to 100%. Currently 80%');
  });

  it('computes a SHARES split', () => {
    const result = calculateSplitData(SplitType.SHARES, 10000, 100, [
      { memberId: 'A', share: 1 },
      { memberId: 'B', share: 3 },
    ]);
    expect(result).toEqual([
      { memberId: 'A', amountCents: 2500, share: 1 },
      { memberId: 'B', amountCents: 7500, share: 3 },
    ]);
  });

  it('throws BadRequestException when total shares is zero', () => {
    expect(() =>
      calculateSplitData(SplitType.SHARES, 10000, 100, [
        { memberId: 'A', share: 0 },
        { memberId: 'B', share: 0 },
      ]),
    ).toThrow('Total shares must be greater than 0');
  });
});
