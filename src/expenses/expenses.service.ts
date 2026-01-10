import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { SplitType } from '@prisma/client';
import {
  BalancesByCurrency,
  ExpenseResponse,
  GroupedTransactionHistory,
  RecommendedSettlement,
  TransactionHistoryItem,
  UserBalanceResponse,
} from './types/expense-responses.type';
import { fromCents, toCents } from '../helpers/number.helper';

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  private allocateByWeights(weights: number[], totalCents: number): number[] {
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

  async create(
    groupId: string,
    userId: string,
    dto: CreateExpenseDto,
  ): Promise<ExpenseResponse> {
    // 1. Verify group membership
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (!member || member.deletedAt) {
      throw new ForbiddenException('You are not a member of this group');
    }

    // 2. Validate payers total using integer cents
    const totalCents = toCents(dto.amount);
    const payersTotalCents = dto.payers.reduce(
      (sum, p) => sum + toCents(p.amount),
      0,
    );

    if (payersTotalCents !== totalCents) {
      throw new BadRequestException(
        `Total payers amount (${fromCents(payersTotalCents)}) must equal expense amount (${dto.amount})`,
      );
    }

    // 3. Calculate splits in integer cents
    const splitData: {
      memberId: string;
      amountCents: number;
      share?: number;
      percentage?: number;
    }[] = [];

    switch (dto.splitType) {
      case SplitType.EVEN: {
        const participantIds = dto.splits.map((s) => s.memberId);
        if (participantIds.length === 0) {
          throw new BadRequestException('At least one participant is required');
        }

        const cents = this.allocateByWeights(
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
        const splitCentsSum = dto.splits.reduce(
          (sum, s) => sum + toCents(s.amount || 0),
          0,
        );
        if (splitCentsSum !== totalCents) {
          throw new BadRequestException(
            `Exact split amounts must sum to ${dto.amount}. Currently ${fromCents(splitCentsSum)}`,
          );
        }
        dto.splits.forEach((s) => {
          splitData.push({
            memberId: s.memberId,
            amountCents: toCents(s.amount || 0),
          });
        });
        break;
      }

      case SplitType.PERCENTAGE: {
        const percentages = dto.splits.map((s) => s.percentage || 0);
        const percentSum = percentages.reduce((a, b) => a + b, 0);

        // We use Math.round(percentSum * 100) to check if it's 100% (with 2 decimal precision for percentages)
        if (Math.round(percentSum * 100) !== 10000) {
          throw new BadRequestException(
            `Percentages must sum to 100%. Currently ${percentSum}%`,
          );
        }

        const cents = this.allocateByWeights(percentages, totalCents);
        dto.splits.forEach((s, i) => {
          splitData.push({
            memberId: s.memberId,
            amountCents: cents[i],
            percentage: s.percentage,
          });
        });
        break;
      }

      case SplitType.SHARES: {
        const shares = dto.splits.map((s) => s.share || 0);
        const totalShares = shares.reduce((a, b) => a + b, 0);

        if (totalShares <= 0) {
          throw new BadRequestException('Total shares must be greater than 0');
        }

        const cents = this.allocateByWeights(shares, totalCents);
        dto.splits.forEach((s, i) => {
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
    const totalSplitCents = splitData.reduce(
      (sum, s) => sum + s.amountCents,
      0,
    );
    if (totalSplitCents !== totalCents) {
      throw new Error('Internal Invariant Violation: Split sum mismatch');
    }

    return this.prisma.$transaction(async (tx) => {
      // 4. Create the expense
      const expense = await tx.expense.create({
        data: {
          groupId,
          description: dto.description,
          amount: dto.amount,
          splitType: dto.splitType,
          currency: dto.currency || 'USD',
          date: dto.date || new Date(),
        },
      });

      // 5. Create payers
      await tx.expensePayer.createMany({
        data: dto.payers.map((p) => ({
          expenseId: expense.id,
          memberId: p.memberId,
          amount: p.amount,
        })),
      });

      // 6. Create splits
      await tx.expenseSplit.createMany({
        data: splitData.map((s) => ({
          expenseId: expense.id,
          memberId: s.memberId,
          amount: fromCents(s.amountCents),
          share: s.share,
          percentage: s.percentage,
        })),
      });

      const createdExpense = await tx.expense.findUnique({
        where: { id: expense.id },
        include: {
          payers: {
            include: {
              member: true,
            },
          },
          splits: true,
        },
      });

      if (!createdExpense) {
        throw new Error('Expense creation failed');
      }

      return {
        id: createdExpense.id,
        groupId: createdExpense.groupId,
        description: createdExpense.description,
        amount: Number(createdExpense.amount),
        splitType: createdExpense.splitType,
        currency: createdExpense.currency,
        date: createdExpense.date,
        payers: createdExpense.payers.map((p) => ({
          memberId: p.memberId,
          amount: Number(p.amount),
          name: p.member.name,
        })),
        splits: createdExpense.splits.map((s) => ({
          memberId: s.memberId,
          amount: Number(s.amount),
          share: s.share ? Number(s.share) : null,
          percentage: s.percentage ? Number(s.percentage) : null,
        })),
      };
    });
  }

  async getGroupTransactions(
    groupId: string,
    userId: string,
  ): Promise<GroupedTransactionHistory> {
    // Verify membership
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (!member || member.deletedAt) {
      throw new ForbiddenException('You do not have access to this group');
    }

    const [expenses, settlements] = await Promise.all([
      this.prisma.expense.findMany({
        where: { groupId, deletedAt: null },
        include: {
          payers: {
            include: {
              member: true,
            },
          },
          splits: {
            include: {
              member: true,
            },
          },
        },
        orderBy: { date: 'desc' },
      }),
      this.prisma.settlement.findMany({
        where: { groupId, deletedAt: null },
        include: {
          from: true,
          to: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Combine and sort
    const transactions: TransactionHistoryItem[] = [
      ...expenses.map((e) => ({
        id: e.id,
        type: 'EXPENSE' as const,
        description: e.description,
        amount: Number(e.amount),
        currency: e.currency,
        date: e.date,
        payers: e.payers.map((p) => ({
          memberId: p.memberId,
          amount: Number(p.amount),
          name: p.member.name,
          avatarUrl: p.member.avatarUrl,
        })),
        receivers: e.splits.map((s) => ({
          memberId: s.memberId,
          amount: Number(s.amount),
          name: s.member.name,
          avatarUrl: s.member.avatarUrl,
        })),
      })),
      ...settlements.map((s) => ({
        id: s.id,
        type: 'SETTLEMENT' as const,
        amount: Number(s.amount),
        currency: s.currency,
        date: s.createdAt,
        status: s.status,

        from: {
          memberId: s.fromId,
          name: s.from.name,
          avatarUrl: s.from.avatarUrl,
        },
        to: {
          memberId: s.toId,
          name: s.to.name,
          avatarUrl: s.to.avatarUrl,
        },
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    // Group by month
    const grouped: GroupedTransactionHistory = {};
    transactions.forEach((tx) => {
      const date = new Date(tx.date);
      const monthYear = date.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      });
      if (!grouped[monthYear]) {
        grouped[monthYear] = [];
      }
      grouped[monthYear].push(tx);
    });

    return grouped;
  }

  async getBalances(
    groupId: string,
    userId: string,
  ): Promise<BalancesByCurrency> {
    // Verify membership
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (!member || member.deletedAt) {
      throw new ForbiddenException('You do not have access to this group');
    }

    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });

    const expenses = await this.prisma.expense.findMany({
      where: { groupId, deletedAt: null },
      include: {
        payers: true,
        splits: true,
      },
    });

    const settlements = await this.prisma.settlement.findMany({
      where: {
        groupId,
        deletedAt: null,
        status: 'COMPLETED',
      },
    });

    // Use a temporary structure to hold integer cents
    const balancesByCurrencyCents: {
      [currency: string]: { [memberId: string]: number };
    } = {};

    // Process expenses
    expenses.forEach((expense) => {
      const currency = expense.currency;
      if (!balancesByCurrencyCents[currency]) {
        balancesByCurrencyCents[currency] = {};
        members.forEach((m) => (balancesByCurrencyCents[currency][m.id] = 0));
      }

      const balances = balancesByCurrencyCents[currency];

      expense.payers.forEach((payer) => {
        balances[payer.memberId] += toCents(Number(payer.amount));
      });

      expense.splits.forEach((split) => {
        balances[split.memberId] -= toCents(Number(split.amount));
      });
    });

    // Process settlements (completed ones)
    settlements.forEach((s) => {
      const currency = s.currency;
      if (!balancesByCurrencyCents[currency]) {
        balancesByCurrencyCents[currency] = {};
        members.forEach((m) => (balancesByCurrencyCents[currency][m.id] = 0));
      }
      const balances = balancesByCurrencyCents[currency];
      balances[s.fromId] += toCents(Number(s.amount));
      balances[s.toId] -= toCents(Number(s.amount));
    });

    // Convert back to decimal for output
    const balancesByCurrency: BalancesByCurrency = {};
    Object.keys(balancesByCurrencyCents).forEach((currency) => {
      balancesByCurrency[currency] = {};
      Object.keys(balancesByCurrencyCents[currency]).forEach((memberId) => {
        balancesByCurrency[currency][memberId] = fromCents(
          balancesByCurrencyCents[currency][memberId],
        );
      });
    });

    return balancesByCurrency;
  }

  async getUserBalance(
    groupId: string,
    userId: string,
  ): Promise<UserBalanceResponse> {
    const balancesByCurrency = await this.getBalances(groupId, userId);
    const settlementsByCurrency = await this.getSettlements(groupId, userId);

    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });
    const memberMap = new Map(members.map((m) => [m.id, m]));
    const currentUserMember = members.find((m) => m.userId === userId);

    if (!currentUserMember) {
      throw new ForbiddenException('You are not a member of this group');
    }

    const response: UserBalanceResponse = { balances: {} };

    Object.keys(balancesByCurrency).forEach((currency) => {
      const details: UserBalanceResponse['balances'][string]['details'] = [];
      let totalOwedCents = 0;
      let totalOweCents = 0;

      // Use the calculated settlements to figure out who owes who
      const currencySettlements = settlementsByCurrency.filter(
        (s) => s.currency === currency,
      );

      currencySettlements.forEach((s) => {
        const amountCents = toCents(s.amount);
        if (s.from === currentUserMember.id) {
          // User owes s.to
          const targetMember = memberMap.get(s.to);
          totalOweCents += amountCents;
          details.push({
            memberId: s.to,
            name: targetMember?.name || 'Unknown',
            avatarUrl: targetMember?.avatarUrl || null,
            amount: -s.amount,
          });
        } else if (s.to === currentUserMember.id) {
          // s.from owes user
          const targetMember = memberMap.get(s.from);
          totalOwedCents += amountCents;
          details.push({
            memberId: s.from,
            name: targetMember?.name || 'Unknown',
            avatarUrl: targetMember?.avatarUrl || null,
            amount: s.amount,
          });
        }
      });

      response.balances[currency] = {
        totalOwed: fromCents(totalOwedCents),
        totalOwe: fromCents(totalOweCents),
        details,
      };
    });

    return response;
  }

  async getSettlements(
    groupId: string,
    userId: string,
  ): Promise<RecommendedSettlement[]> {
    const balancesByCurrency = await this.getBalances(groupId, userId);
    const allSettlements: RecommendedSettlement[] = [];

    Object.entries(balancesByCurrency).forEach(([currency, balances]) => {
      const debtors: { id: string; amountCents: number }[] = [];
      const creditors: { id: string; amountCents: number }[] = [];

      Object.entries(balances).forEach(([id, amount]) => {
        const cents = toCents(amount);
        if (cents < 0) debtors.push({ id, amountCents: cents });
        if (cents > 0) creditors.push({ id, amountCents: cents });
      });

      // debtors have negative balance, meaning they owe money.
      // creditors have positive balance, meaning they are owed money.
      // Math.abs(debtor.amountCents) is what they owe.

      debtors.sort((a, b) => a.amountCents - b.amountCents); // biggest debtors first (most negative)
      creditors.sort((a, b) => b.amountCents - a.amountCents); // biggest creditors first

      let i = 0;
      let j = 0;

      while (i < debtors.length && j < creditors.length) {
        const d = debtors[i];
        const c = creditors[j];
        const settleAmountCents = Math.min(
          Math.abs(d.amountCents),
          c.amountCents,
        );

        if (settleAmountCents > 0) {
          allSettlements.push({
            from: d.id,
            to: c.id,
            amount: fromCents(settleAmountCents),
            currency,
          });
        }

        d.amountCents += settleAmountCents;
        c.amountCents -= settleAmountCents;

        if (d.amountCents === 0) i++;
        if (c.amountCents === 0) j++;
      }
    });

    return allSettlements;
  }
}
