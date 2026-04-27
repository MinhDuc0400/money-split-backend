export interface BalanceInput {
  memberId: string;
  amountCents: number;
}

export interface TransferOutput {
  fromId: string;
  toId: string;
  amountCents: number;
}

/**
 * Calculates the minimal set of transfers to settle debts.
 * @param balances List of member balances (positive means they are owed money, negative means they owe money)
 * @returns List of transfers to settle everyone up
 * @throws Error if balances do not sum to zero
 */
export function calculateMinimalTransfers(
  balances: BalanceInput[],
): TransferOutput[] {
  const sum = balances.reduce((acc, b) => acc + b.amountCents, 0);
  if (sum !== 0) {
    throw new Error(`Balances do not sum to zero (diff: ${sum})`);
  }

  const debtors = balances
    .filter((b) => b.amountCents < 0)
    .sort((a, b) => a.amountCents - b.amountCents); // Most negative first

  const creditors = balances
    .filter((b) => b.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents); // Most positive first

  const transfers: TransferOutput[] = [];
  let i = 0; // debtor index
  let j = 0; // creditor index

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];

    // Amount to transfer is the minimum of what debtor owes and what creditor is owed
    const amount = Math.min(Math.abs(debtor.amountCents), creditor.amountCents);

    if (amount > 0) {
      transfers.push({
        fromId: debtor.memberId,
        toId: creditor.memberId,
        amountCents: amount,
      });
    }

    // Update remaining amounts
    debtor.amountCents += amount;
    creditor.amountCents -= amount;

    // Move indices if settled
    if (debtor.amountCents === 0) i++;
    if (creditor.amountCents === 0) j++;
  }

  return transfers;
}
