import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Prisma, ExpenseCategory } from '@prisma/client';
import { GroupMembershipService } from './group-membership.service';
import {
  ExpenseResponse,
  PaginatedTransactionHistory,
  TransactionHistoryItem,
} from './types/expense-responses.type';
import { fromCents, toCents } from '../helpers/number.helper';
import {
  calculateDebtFlows,
  validatePayersTotal,
  calculateSplitData,
} from './lib/split-calculations';
import { updateDebtAtomic } from '../helpers/debt.helper';
import { withIdempotency } from '../helpers/idempotency.helper';
import { ExpenseWithRelations } from './types/expense-internal.types';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
    private groupMembership: GroupMembershipService,
  ) {}

  async create(
    groupId: string,
    userId: string,
    dto: CreateExpenseDto,
    idempotencyKey?: string,
  ): Promise<ExpenseResponse> {
    // 1. Verify group membership
    await this.groupMembership.assertActiveMember(groupId, userId);

    // 2. Validate payers total using integer cents
    const totalCents = toCents(dto.amount);
    validatePayersTotal(dto.payers, totalCents, dto.amount);

    // 3. Calculate splits in integer cents
    const splitData = calculateSplitData(
      dto.splitType,
      totalCents,
      dto.amount,
      dto.splits,
    );

    return withIdempotency(
      this.prisma,
      idempotencyKey,
      userId,
      'POST /groups/:id/expenses',
      async (tx) => {
        // 4. Create the expense
        const expense = await tx.expense.create({
          data: {
            groupId,
            description: dto.description,
            amount: dto.amount,
            splitType: dto.splitType,
            category: dto.category || ExpenseCategory.OTHER,
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
          category: createdExpense.category,
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
      },
    );
  }

  async getGroupTransactions(
    groupId: string,
    userId: string,
    limit = 20,
    cursor?: string,
  ): Promise<PaginatedTransactionHistory> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    const effectiveLimit = Math.min(limit, 50);

    // Decode cursor
    let cursorDate: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64').toString('utf-8'),
        ) as { date: string; id: string };
        cursorDate = new Date(decoded.date);
        cursorId = decoded.id;
      } catch {
        // malformed cursor — treat as first page
      }
    }

    const expenseDateFilter = cursorDate
      ? {
          OR: [
            { date: { lt: cursorDate } },
            { date: { equals: cursorDate }, id: { gt: cursorId! } },
          ],
        }
      : {};

    const settlementDateFilter = cursorDate
      ? {
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: { equals: cursorDate }, id: { gt: cursorId! } },
          ],
        }
      : {};

    const fetchCount = effectiveLimit + 1;

    const [expenses, settlements] = await Promise.all([
      this.prisma.expense.findMany({
        where: { groupId, deletedAt: null, ...expenseDateFilter },
        include: {
          payers: { include: { member: true } },
          splits: { include: { member: true } },
        },
        orderBy: [{ date: 'desc' }, { id: 'asc' }],
        take: fetchCount,
      }),
      this.prisma.settlement.findMany({
        where: { groupId, deletedAt: null, ...settlementDateFilter },
        include: { from: true, to: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: fetchCount,
      }),
    ]);

    const expenseItems: TransactionHistoryItem[] = expenses.map((e) => ({
      id: e.id,
      type: 'EXPENSE' as const,
      description: e.description,
      amount: Number(e.amount),
      currency: e.currency,
      category: e.category,
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
    }));

    const settlementItems: TransactionHistoryItem[] = settlements.map((s) => ({
      id: s.id,
      type: 'SETTLEMENT' as const,
      description: s.note || `${s.from.name} paid ${s.to.name}`,
      amount: Number(s.amount),
      currency: s.currency,
      date: s.createdAt,
      status: s.status,
      from: {
        memberId: s.fromId,
        name: s.from.name,
        avatarUrl: s.from.avatarUrl,
      },
      to: { memberId: s.toId, name: s.to.name, avatarUrl: s.to.avatarUrl },
    }));

    const merged = [...expenseItems, ...settlementItems]
      .sort((a, b) => {
        const diff = b.date.getTime() - a.date.getTime();
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      })
      .slice(0, fetchCount);

    const hasMore = merged.length > effectiveLimit;
    const items = hasMore ? merged.slice(0, effectiveLimit) : merged;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ date: last.date.toISOString(), id: last.id }),
      ).toString('base64');
    }

    return { items, nextCursor, hasMore };
  }

  async updateExpense(
    groupId: string,
    expenseId: string,
    userId: string,
    dto: UpdateExpenseDto,
  ): Promise<ExpenseResponse> {
    // 1. Verify membership and authorization
    await this.groupMembership.assertActiveMember(groupId, userId);

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
    // Only touch category when the caller actually sent one. Omitting it
    // (e.g. from clients like money-split-mobile that predate categories)
    // must leave the expense's existing category untouched instead of
    // silently resetting it to OTHER.
    const categoryUpdate =
      dto.category !== undefined ? { category: dto.category } : {};
    const currency = dto.currency || 'USD';
    const date = dto.date || new Date();
    const payers = dto.payers;
    const splits = dto.splits;

    // Re-validate payers and calculate new splits
    const totalCents = toCents(amount);
    validatePayersTotal(payers, totalCents, amount);
    const splitData = calculateSplitData(splitType, totalCents, amount, splits);

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
          ...categoryUpdate,
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
        category: finalExpense.category,
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
    await this.groupMembership.assertActiveMember(groupId, userId);

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

    const flows = calculateDebtFlows(payers, splits);
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
    const flows = calculateDebtFlows(payers, splitData);
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
