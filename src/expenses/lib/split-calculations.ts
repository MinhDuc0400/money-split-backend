import { BadRequestException } from '@nestjs/common';
import { SplitType } from '@prisma/client';
import { fromCents, toCents } from '../../helpers/number.helper';
import {
  DebtFlow,
  SplitData,
  SplitInput,
} from '../types/expense-internal.types';

export function allocateByWeights(
  weights: number[],
  totalCents: number,
): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    throw new BadRequestException('Total weight must be greater than 0');
  }

  const raw = weights.map((w) => {
    const exact = (totalCents * w) / totalWeight;
    return { base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });

  const assigned = raw.reduce((a, b) => a + b.base, 0);
  let rem = totalCents - assigned;

  const order = raw
    .map((r, idx) => ({ idx, frac: r.frac }))
    .sort((a, b) => b.frac - a.frac);

  const cents = raw.map((r) => r.base);
  for (let i = 0; i < order.length && rem > 0; i++, rem--) {
    cents[order[i].idx] += 1;
  }

  return cents;
}

export function calculateDebtFlows(
  payers: { memberId: string; amount: number }[],
  splits: { memberId: string; amountCents: number }[],
): DebtFlow[] {
  const flows: DebtFlow[] = [];
  const payerCents = payers.map((p) => ({
    memberId: p.memberId,
    amountCents: toCents(p.amount),
  }));

  let payerIndex = 0;
  let currentPayerOffset = 0;
  let splitterOffset = 0;

  for (const s of splits) {
    const splitterNextOffset = splitterOffset + s.amountCents;
    while (
      payerIndex < payerCents.length &&
      currentPayerOffset < splitterNextOffset
    ) {
      const p = payerCents[payerIndex];
      const payerNextOffset = currentPayerOffset + p.amountCents;

      // Intersection of [splitterOffset, splitterNextOffset] and [currentPayerOffset, payerNextOffset]
      const overlapStart = Math.max(splitterOffset, currentPayerOffset);
      const overlapEnd = Math.min(splitterNextOffset, payerNextOffset);
      const overlap = overlapEnd - overlapStart;

      if (overlap > 0 && s.memberId !== p.memberId) {
        // Debt invariant: For each splitter S and each payer P:
        // S owes P = splitAmount(S) * (payerPaid / totalPaid).
        // We use an intersection of ranges to implement this proportionally in integer cents without drift.
        flows.push({
          debtorId: s.memberId,
          creditorId: p.memberId,
          amountCents: overlap,
        });
      }

      if (payerNextOffset <= splitterNextOffset) {
        payerIndex++;
        currentPayerOffset = payerNextOffset;
      } else {
        currentPayerOffset = overlapEnd; // Move pointer to end of splitter range
        break;
      }
    }
    splitterOffset = splitterNextOffset;
  }

  return flows;
}

/** Throws BadRequestException if payer amounts don't sum to the expense total. */
export function validatePayersTotal(
  payers: { amount: number }[],
  totalCents: number,
  amount: number,
) {
  const payersTotalCents = payers.reduce(
    (sum, p) => sum + toCents(p.amount),
    0,
  );
  if (payersTotalCents !== totalCents) {
    throw new BadRequestException(
      `Total payers amount (${fromCents(payersTotalCents)}) must equal expense amount (${amount})`,
    );
  }
}

/**
 * Computes per-member split amounts (in cents) for the given split type,
 * validating the split-specific invariant (participants present, exact
 * amounts sum to total, percentages sum to 100%, shares > 0). Shared by
 * create() and updateExpense() since both accept the same split shape.
 */
export function calculateSplitData(
  splitType: SplitType,
  totalCents: number,
  amount: number,
  splits: SplitInput[],
): SplitData[] {
  const splitData: SplitData[] = [];

  switch (splitType) {
    case SplitType.EVEN: {
      const participantIds = splits.map((s) => s.memberId);
      if (participantIds.length === 0) {
        throw new BadRequestException('At least one participant is required');
      }

      const cents = allocateByWeights(
        new Array(participantIds.length).fill(1),
        totalCents,
      );
      participantIds.forEach((memberId, i) => {
        splitData.push({
          memberId,
          amountCents: cents[i],
        });
      });
      break;
    }

    case SplitType.EXACT: {
      const splitCentsSum = splits.reduce(
        (sum, s) => sum + toCents(s.amount || 0),
        0,
      );
      if (splitCentsSum !== totalCents) {
        throw new BadRequestException(
          `Exact split amounts must sum to ${amount}. Currently ${fromCents(splitCentsSum)}`,
        );
      }
      splits.forEach((s) => {
        splitData.push({
          memberId: s.memberId,
          amountCents: toCents(s.amount || 0),
        });
      });
      break;
    }

    case SplitType.PERCENTAGE: {
      const percentages = splits.map((s) => s.percentage || 0);
      const percentSum = percentages.reduce((a, b) => a + b, 0);

      // We use Math.round(percentSum * 100) to check if it's 100% (with 2 decimal precision for percentages)
      if (Math.round(percentSum * 100) !== 10000) {
        throw new BadRequestException(
          `Percentages must sum to 100%. Currently ${percentSum}%`,
        );
      }

      const cents = allocateByWeights(percentages, totalCents);
      splits.forEach((s, i) => {
        splitData.push({
          memberId: s.memberId,
          amountCents: cents[i],
          percentage: s.percentage,
        });
      });
      break;
    }

    case SplitType.SHARES: {
      const shares = splits.map((s) => s.share || 0);
      const totalShares = shares.reduce((a, b) => a + b, 0);

      if (totalShares <= 0) {
        throw new BadRequestException('Total shares must be greater than 0');
      }

      const cents = allocateByWeights(shares, totalCents);
      splits.forEach((s, i) => {
        splitData.push({
          memberId: s.memberId,
          amountCents: cents[i],
          share: s.share,
        });
      });
      break;
    }
  }

  // Invariant check
  const totalSplitCents = splitData.reduce((sum, s) => sum + s.amountCents, 0);
  if (totalSplitCents !== totalCents) {
    throw new Error('Internal Invariant Violation: Split sum mismatch');
  }

  return splitData;
}
