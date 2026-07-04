import { Prisma } from '@prisma/client';
import { toCents, fromCents } from './number.helper';

/**
 * Records that debtorId now owes creditorId an additional amountCents,
 * netting against any existing reverse debt (creditorId owes debtorId)
 * first. Shared by expenses.service.ts (applying/reversing expense
 * splits) and settlements.service.ts (a payment from fromId to toId is
 * equivalent to calling this with debtorId=toId, creditorId=fromId).
 */
export async function updateDebtAtomic(
  tx: Prisma.TransactionClient,
  groupId: string,
  debtorId: string,
  creditorId: string,
  currency: string,
  amountCents: number,
): Promise<void> {
  // 1. Check if reverse debt (creditorId owes debtorId) exists
  const reverseDebt = await tx.debt.findUnique({
    where: {
      groupId_debtorId_creditorId_currency: {
        groupId,
        debtorId: creditorId,
        creditorId: debtorId,
        currency,
      },
    },
  });

  let remainingNewDebtCents = amountCents;

  if (reverseDebt) {
    const reverseDebtCents = toCents(Number(reverseDebt.amount));
    if (reverseDebtCents >= remainingNewDebtCents) {
      const updatedReverseCents = reverseDebtCents - remainingNewDebtCents;
      if (updatedReverseCents === 0) {
        await tx.debt.delete({ where: { id: reverseDebt.id } });
      } else {
        await tx.debt.update({
          where: { id: reverseDebt.id },
          data: { amount: fromCents(updatedReverseCents) },
        });
      }
      remainingNewDebtCents = 0;
    } else {
      await tx.debt.delete({ where: { id: reverseDebt.id } });
      remainingNewDebtCents -= reverseDebtCents;
    }
  }

  if (remainingNewDebtCents > 0) {
    const amount = fromCents(remainingNewDebtCents);
    await tx.debt.upsert({
      where: {
        groupId_debtorId_creditorId_currency: {
          groupId,
          debtorId,
          creditorId,
          currency,
        },
      },
      create: {
        groupId,
        debtorId,
        creditorId,
        currency,
        amount,
      },
      update: {
        amount: { increment: amount },
      },
    });
  }
}
