import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Prisma, SplitType } from '@prisma/client';
import {
  BalancesByCurrency,
  ExpenseResponse,
  GroupedTransactionHistory,
  RecommendedSettlement,
  TransactionHistoryItem,
  UserBalanceResponse,
} from './types/expense-responses.type';
import { fromCents, toCents } from '../helpers/number.helper';
import { updateDebtAtomic } from '../helpers/debt.helper';
import { DebtFlow, ExpenseWithRelations } from './types/expense-internal.types';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
  ) {}

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

  private calculateDebtFlows(
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

  /** Throws ForbiddenException if userId isn't an active member of groupId. */
  private async assertActiveMember(groupId: string, userId: string) {
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

    return member;
  }

  async create(
    groupId: string,
    userId: string,
    dto: CreateExpenseDto,
  ): Promise<ExpenseResponse> {
    // 1. Verify group membership
    await this.assertActiveMember(groupId, userId);

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

      const currency = dto.currency || 'USD';

      // 7. Update MemberBalances & Debts
      await this.applyExpenseEffects(
        tx,
        groupId,
        currency,
        dto.payers,
        splitData,
      );

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

      const result = {
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
      this.eventsGateway.emitExpenseCreated(result.groupId, result);
      return result;
    });
  }

  async getGroupTransactions(
    groupId: string,
    userId: string,
  ): Promise<GroupedTransactionHistory> {
    // Verify membership
    await this.assertActiveMember(groupId, userId);

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
    await this.assertActiveMember(groupId, userId);

    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });

    const memberBalances = await this.prisma.memberBalance.findMany({
      where: { groupId },
    });

    const balancesByCurrency: BalancesByCurrency = {};
    const memberMap = new Map(members.map((m) => [m.id, m]));

    // Group balances by currency
    memberBalances.forEach((mb) => {
      const currency = mb.currency;
      if (!balancesByCurrency[currency]) {
        balancesByCurrency[currency] = [];
      }

      const m = memberMap.get(mb.memberId);
      if (m && !m.deletedAt) {
        balancesByCurrency[currency].push({
          memberId: mb.memberId,
          name: m.name,
          avatarUrl: m.avatarUrl,
          balance: Number(mb.balance),
        });
      }
    });

    // Ensure all members are included in each currency if they have no balance record yet
    const currencies = Object.keys(balancesByCurrency);
    currencies.forEach((currency) => {
      const presentMemberIds = new Set(
        balancesByCurrency[currency].map((b) => b.memberId),
      );
      members.forEach((m) => {
        if (!presentMemberIds.has(m.id)) {
          balancesByCurrency[currency].push({
            memberId: m.id,
            name: m.name,
            avatarUrl: m.avatarUrl,
            balance: 0,
          });
        }
      });
    });

    return balancesByCurrency;
  }

  async getUserBalance(
    groupId: string,
    userId: string,
  ): Promise<UserBalanceResponse> {
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });
    const currentUserMember = members.find((m) => m.userId === userId);

    if (!currentUserMember) {
      throw new ForbiddenException('You are not a member of this group');
    }

    // Read from MemberBalance — the authoritative net balance per member,
    // updated atomically by both expense creation and settlements.
    // The Debt table tracks the payment graph but can drift from net balances
    // when minimal-transfer settlements don't perfectly map to raw debt rows.
    const memberBalances = await this.prisma.memberBalance.findMany({
      where: { groupId, memberId: currentUserMember.id },
    });

    const response: UserBalanceResponse = { balances: {} };

    for (const mb of memberBalances) {
      const net = Number(mb.balance);
      if (Math.abs(net) < 0.001) continue;

      const totalOwed = net > 0 ? net : 0;
      const totalOwe = net < 0 ? Math.abs(net) : 0;

      response.balances[mb.currency] = {
        totalOwed,
        totalOwe,
        details: [],
      };
    }

    return response;
  }

  async getSettlements(
    groupId: string,
    userId: string,
  ): Promise<RecommendedSettlement[]> {
    const balancesByCurrency = await this.getBalances(groupId, userId);
    const allSettlements: RecommendedSettlement[] = [];

    Object.entries(balancesByCurrency).forEach(([currency, balances]) => {
      const debtors: {
        id: string;
        name: string;
        avatarUrl: string | null;
        amountCents: number;
      }[] = [];
      const creditors: {
        id: string;
        name: string;
        avatarUrl: string | null;
        amountCents: number;
      }[] = [];

      balances.forEach((b) => {
        const cents = toCents(b.balance);
        if (cents < 0)
          debtors.push({
            id: b.memberId,
            name: b.name,
            avatarUrl: b.avatarUrl,
            amountCents: cents,
          });
        if (cents > 0)
          creditors.push({
            id: b.memberId,
            name: b.name,
            avatarUrl: b.avatarUrl,
            amountCents: cents,
          });
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
            from: {
              memberId: d.id,
              name: d.name,
              avatarUrl: d.avatarUrl,
            },
            to: {
              memberId: c.id,
              name: c.name,
              avatarUrl: c.avatarUrl,
            },
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

  async updateExpense(
    groupId: string,
    expenseId: string,
    userId: string,
    dto: UpdateExpenseDto,
  ): Promise<ExpenseResponse> {
    // 1. Verify membership and authorization
    await this.assertActiveMember(groupId, userId);

    // 2. Fetch old expense
    const oldExpense = await this.prisma.expense.findUnique({
      where: { id: expenseId, groupId, deletedAt: null },
      include: {
        payers: { include: { member: true } },
        splits: { include: { member: true } },
      },
    });
    if (!oldExpense) {
      throw new NotFoundException('Expense not found');
    }

    // Prepare new data
    const description = dto.description;
    const amount = dto.amount;
    const splitType = dto.splitType;
    const currency = dto.currency || 'USD';
    const date = dto.date || new Date();
    const payers = dto.payers;
    const splits = dto.splits;

    // Re-validate payers and calculate new splits
    const totalCents = toCents(amount);
    const payersTotalCents = payers.reduce(
      (sum: number, p: { amount: number }) => sum + toCents(p.amount),
      0,
    );
    if (payersTotalCents !== totalCents) {
      throw new BadRequestException(
        `Total payers amount (${fromCents(payersTotalCents)}) must equal expense amount (${amount})`,
      );
    }

    const splitData: {
      memberId: string;
      amountCents: number;
      share?: number;
      percentage?: number;
    }[] = [];

    switch (splitType) {
      case SplitType.EVEN: {
        const participantIds = splits.map(
          (s: { memberId: string }) => s.memberId,
        );
        if (participantIds.length === 0) {
          throw new BadRequestException('At least one participant is required');
        }
        const cents = this.allocateByWeights(
          new Array(participantIds.length).fill(1),
          totalCents,
        );
        participantIds.forEach((memberId: string, i: number) => {
          splitData.push({ memberId, amountCents: cents[i] });
        });
        break;
      }
      case SplitType.EXACT: {
        const splitCentsSum = splits.reduce(
          (sum: number, s: { amount?: number }) => sum + toCents(s.amount || 0),
          0,
        );
        if (splitCentsSum !== totalCents) {
          throw new BadRequestException(
            `Exact split amounts must sum to ${amount}. Currently ${fromCents(splitCentsSum)}`,
          );
        }
        splits.forEach((s: { memberId: string; amount?: number }) => {
          splitData.push({
            memberId: s.memberId,
            amountCents: toCents(s.amount || 0),
          });
        });
        break;
      }
      case SplitType.PERCENTAGE: {
        const percentages = splits.map(
          (s: { percentage?: number }) => s.percentage || 0,
        );
        const percentSum = percentages.reduce(
          (a: number, b: number) => a + b,
          0,
        );
        if (Math.round(percentSum * 100) !== 10000) {
          throw new BadRequestException(
            `Percentages must sum to 100%. Currently ${percentSum}%`,
          );
        }
        const cents = this.allocateByWeights(percentages, totalCents);
        splits.forEach(
          (s: { memberId: string; percentage?: number }, i: number) => {
            splitData.push({
              memberId: s.memberId,
              amountCents: cents[i],
              percentage: s.percentage,
            });
          },
        );
        break;
      }
      case SplitType.SHARES: {
        const shares = splits.map((s: { share?: number }) => s.share || 0);
        const totalShares = shares.reduce((a: number, b: number) => a + b, 0);
        if (totalShares <= 0) {
          throw new BadRequestException('Total shares must be greater than 0');
        }
        const cents = this.allocateByWeights(shares, totalCents);
        splits.forEach((s: { memberId: string; share?: number }, i: number) => {
          splitData.push({
            memberId: s.memberId,
            amountCents: cents[i],
            share: s.share,
          });
        });
        break;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 3. REVERSE old effects
      await this.reverseExpenseEffects(tx, groupId, oldExpense);

      // 4. Update the expense (with optimistic locking)
      const updatedExpense = await tx.expense.update({
        where: {
          id: expenseId,
          updatedAt: oldExpense.updatedAt,
        },
        data: {
          description,
          amount,
          splitType,
          currency,
          date,
          // Clear old payers and splits to replace them
          payers: { deleteMany: {} },
          splits: { deleteMany: {} },
        },
      });

      // 5. Create new payers and splits
      await tx.expensePayer.createMany({
        data: payers.map((p: { memberId: string; amount: number }) => ({
          expenseId: updatedExpense.id,
          memberId: p.memberId,
          amount: p.amount,
        })),
      });

      await tx.expenseSplit.createMany({
        data: splitData.map((s) => ({
          expenseId: updatedExpense.id,
          memberId: s.memberId,
          amount: fromCents(s.amountCents),
          share: s.share,
          percentage: s.percentage,
        })),
      });

      // 6. Apply NEW effects
      await this.applyExpenseEffects(tx, groupId, currency, payers, splitData);

      const finalExpense = await tx.expense.findUnique({
        where: { id: updatedExpense.id },
        include: {
          payers: { include: { member: true } },
          splits: true,
        },
      });

      if (!finalExpense) throw new Error('Expense update failed');

      const result = {
        id: finalExpense.id,
        groupId: finalExpense.groupId,
        description: finalExpense.description,
        amount: Number(finalExpense.amount),
        splitType: finalExpense.splitType,
        currency: finalExpense.currency,
        date: finalExpense.date,
        payers: finalExpense.payers.map((p) => ({
          memberId: p.memberId,
          amount: Number(p.amount),
          name: p.member.name,
        })),
        splits: finalExpense.splits.map((s) => ({
          memberId: s.memberId,
          amount: Number(s.amount),
          share: s.share ? Number(s.share) : null,
          percentage: s.percentage ? Number(s.percentage) : null,
        })),
      };
      this.eventsGateway.emitExpenseUpdated(result.groupId, result);
      return result;
    });
  }

  async deleteExpense(
    groupId: string,
    expenseId: string,
    userId: string,
  ): Promise<void> {
    await this.assertActiveMember(groupId, userId);

    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId, groupId, deletedAt: null },
      include: {
        payers: { include: { member: true } },
        splits: { include: { member: true } },
      },
    });
    if (!expense) {
      throw new NotFoundException('Expense not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.reverseExpenseEffects(tx, groupId, expense);

      await tx.expense.update({
        where: {
          id: expenseId,
          updatedAt: expense.updatedAt,
        },
        data: { deletedAt: new Date() },
      });
    });
    this.eventsGateway.emitExpenseDeleted(groupId, expenseId);
  }

  private async reverseExpenseEffects(
    tx: Prisma.TransactionClient,
    groupId: string,
    expense: ExpenseWithRelations,
  ) {
    const currency = expense.currency;

    // 1. Reverse MemberBalances
    for (const p of expense.payers) {
      const amount = Number(p.amount);
      await tx.memberBalance.upsert({
        where: {
          groupId_memberId_currency: {
            groupId,
            memberId: p.memberId,
            currency,
          },
        },
        create: {
          groupId,
          memberId: p.memberId,
          currency,
          balance: -amount,
        },
        update: { balance: { decrement: amount } },
      });
    }

    for (const s of expense.splits) {
      const amount = Number(s.amount);
      await tx.memberBalance.upsert({
        where: {
          groupId_memberId_currency: {
            groupId,
            memberId: s.memberId,
            currency,
          },
        },
        create: {
          groupId,
          memberId: s.memberId,
          currency,
          balance: amount,
        },
        update: { balance: { increment: amount } },
      });
    }

    // 2. Reverse Debts
    const payers = expense.payers.map((p) => ({
      memberId: p.memberId,
      amount: Number(p.amount),
    }));
    const splits = expense.splits.map((s) => ({
      memberId: s.memberId,
      amountCents: toCents(Number(s.amount)),
    }));

    const flows = this.calculateDebtFlows(payers, splits);
    for (const flow of flows) {
      // To reverse, we act as if creditor owes debtor
      await updateDebtAtomic(
        tx,
        groupId,
        flow.creditorId,
        flow.debtorId,
        currency,
        flow.amountCents,
      );
    }
  }

  private async applyExpenseEffects(
    tx: Prisma.TransactionClient,
    groupId: string,
    currency: string,
    payers: { memberId: string; amount: number }[],
    splitData: { memberId: string; amountCents: number }[],
  ) {
    // 1. Update MemberBalances
    for (const p of payers) {
      await tx.memberBalance.upsert({
        where: {
          groupId_memberId_currency: {
            groupId,
            memberId: p.memberId,
            currency,
          },
        },
        create: {
          groupId,
          memberId: p.memberId,
          currency,
          balance: p.amount,
        },
        update: { balance: { increment: p.amount } },
      });
    }

    for (const s of splitData) {
      const amount = fromCents(s.amountCents);
      await tx.memberBalance.upsert({
        where: {
          groupId_memberId_currency: {
            groupId,
            memberId: s.memberId,
            currency,
          },
        },
        create: {
          groupId,
          memberId: s.memberId,
          currency,
          balance: -amount,
        },
        update: { balance: { decrement: amount } },
      });
    }

    // 2. Update Debts
    const flows = this.calculateDebtFlows(payers, splitData);
    for (const flow of flows) {
      await updateDebtAtomic(
        tx,
        groupId,
        flow.debtorId,
        flow.creditorId,
        currency,
        flow.amountCents,
      );
    }
  }
}
