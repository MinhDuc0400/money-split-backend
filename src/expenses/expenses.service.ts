import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Prisma, ExpenseCategory } from '@prisma/client';
import { GroupMembershipService } from './group-membership.service';
import {
  BalancesByCurrency,
  CategorySpending,
  ExpenseResponse,
  PaginatedTransactionHistory,
  PersonCategorySpending,
  PersonSpending,
  RecommendedSettlement,
  TopExpenseItem,
  TransactionHistoryItem,
  UserBalanceResponse,
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
import ExcelJS from 'exceljs';
import { buildExportFilename } from '../helpers/filename.helper';

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

  async getSpendingByCategory(
    groupId: string,
    userId: string,
    currency?: string,
    from?: string,
    to?: string,
  ): Promise<CategorySpending[]> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    let effectiveCurrency = currency;
    if (!effectiveCurrency) {
      const group = await this.prisma.group.findUnique({
        where: { id: groupId },
      });
      effectiveCurrency = group?.currency || 'USD';
    }

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const grouped = await this.prisma.expense.groupBy({
      by: ['category'],
      where: {
        groupId,
        deletedAt: null,
        currency: effectiveCurrency,
        ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      },
      _sum: { amount: true },
    });

    return grouped.map((g) => ({
      category: g.category,
      totalCents: toCents(Number(g._sum.amount ?? 0)),
    }));
  }

  async getSpendingByPerson(
    groupId: string,
    userId: string,
    currency?: string,
    from?: string,
    to?: string,
    metric: 'paid' | 'share' = 'paid',
  ): Promise<PersonSpending[]> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    let effectiveCurrency = currency;
    if (!effectiveCurrency) {
      const group = await this.prisma.group.findUnique({
        where: { id: groupId },
      });
      effectiveCurrency = group?.currency || 'USD';
    }

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const expenseWhere = {
      groupId,
      deletedAt: null,
      currency: effectiveCurrency,
      ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
    };

    const grouped =
      metric === 'share'
        ? await this.prisma.expenseSplit.groupBy({
            by: ['memberId'],
            where: { expense: expenseWhere },
            _sum: { amount: true },
          })
        : await this.prisma.expensePayer.groupBy({
            by: ['memberId'],
            where: { expense: expenseWhere },
            _sum: { amount: true },
          });

    const activeMembers = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });
    const memberMap = new Map(activeMembers.map((m) => [m.id, m]));

    return grouped
      .filter((g) => memberMap.has(g.memberId))
      .map((g) => ({
        memberId: g.memberId,
        name: memberMap.get(g.memberId)!.name,
        totalCents: toCents(Number(g._sum.amount ?? 0)),
      }));
  }

  async getSpendingByPersonCategory(
    groupId: string,
    userId: string,
    currency?: string,
    from?: string,
    to?: string,
  ): Promise<PersonCategorySpending[]> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    let effectiveCurrency = currency;
    if (!effectiveCurrency) {
      const group = await this.prisma.group.findUnique({
        where: { id: groupId },
      });
      effectiveCurrency = group?.currency || 'USD';
    }

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const splits = await this.prisma.expenseSplit.findMany({
      where: {
        expense: {
          groupId,
          deletedAt: null,
          currency: effectiveCurrency,
          ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
        },
      },
      select: {
        memberId: true,
        amount: true,
        expense: { select: { category: true } },
      },
    });

    const activeMembers = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });
    const memberMap = new Map(activeMembers.map((m) => [m.id, m]));

    const totals = new Map<
      string,
      { memberId: string; category: string; totalCents: number }
    >();
    for (const split of splits) {
      if (!memberMap.has(split.memberId)) continue;
      const key = `${split.memberId}::${split.expense.category}`;
      const existing = totals.get(key);
      const cents = toCents(Number(split.amount));
      if (existing) {
        existing.totalCents += cents;
      } else {
        totals.set(key, {
          memberId: split.memberId,
          category: split.expense.category,
          totalCents: cents,
        });
      }
    }

    return Array.from(totals.values()).map((t) => ({
      memberId: t.memberId,
      name: memberMap.get(t.memberId)!.name,
      category: t.category,
      totalCents: t.totalCents,
    }));
  }

  async getTopExpenses(
    groupId: string,
    userId: string,
    currency?: string,
    from?: string,
    to?: string,
    limit = 5,
  ): Promise<TopExpenseItem[]> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    let effectiveCurrency = currency;
    if (!effectiveCurrency) {
      const group = await this.prisma.group.findUnique({
        where: { id: groupId },
      });
      effectiveCurrency = group?.currency || 'USD';
    }

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const expenses = await this.prisma.expense.findMany({
      where: {
        groupId,
        deletedAt: null,
        currency: effectiveCurrency,
        ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      },
      include: { payers: { include: { member: true } } },
      orderBy: { amount: 'desc' },
      take: limit,
    });

    return expenses.map((e) => ({
      id: e.id,
      description: e.description,
      amount: Number(e.amount),
      currency: e.currency,
      category: e.category,
      date: e.date,
      payerNames: e.payers.map((p) => p.member.name),
    }));
  }

  async exportExpenses(
    groupId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; filename: string; filenameUtf8: string }> {
    await this.groupMembership.assertActiveMember(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
    });
    const { filename, filenameUtf8 } = buildExportFilename(
      group?.name ?? 'Group',
    );

    const expenses = await this.prisma.expense.findMany({
      where: { groupId, deletedAt: null },
      include: {
        payers: { include: { member: true } },
        splits: { include: { member: true } },
      },
      orderBy: { date: 'asc' },
    });

    // Reuses the existing, already-tested getBalances/getSettlements methods
    // for all balance/settlement math — this method only formats their
    // output into rows. getSettlements calls getBalances again internally,
    // so this does re-run assertActiveMember and re-fetch the group's
    // members/balances a couple of extra times; accepted as a deliberate
    // simplicity-over-micro-optimization tradeoff (bounded by group size,
    // not expense count, and this endpoint isn't a hot path).
    const balancesByCurrency = await this.getBalances(groupId, userId);
    const settlements = await this.getSettlements(groupId, userId);

    // Distinct members who ever appeared as a payer or split participant across
    // this group's *entire* expense history — deliberately not filtered to
    // active members. Mirrors getTopExpenses' payerNames convention: each row
    // is a real historical record, so a member later removed from the group
    // should not have their historical amounts silently dropped or blanked.
    // Sorted by name for a stable, human-readable column order.
    const memberNameById = new Map<string, string>();
    for (const e of expenses) {
      for (const p of e.payers) memberNameById.set(p.memberId, p.member.name);
      for (const s of e.splits) memberNameById.set(s.memberId, s.member.name);
    }
    const memberColumns = Array.from(memberNameById.entries())
      .map(([memberId, name]) => ({ memberId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Expenses');

    // Column keys/widths only — no `header` property. Setting a column's
    // `header` makes exceljs write header text straight into row 1 the
    // moment `sheet.columns = [...]` runs (verified against
    // node_modules/exceljs/lib/doc/column.js's `set header`), which would
    // collide with the Balances/Settlement plan summary block written below.
    // The expense-list header is instead written explicitly, further down,
    // as its own addRow call once the summary block is done.
    sheet.columns = [
      { key: 'date', width: 14 },
      { key: 'description', width: 28 },
      { key: 'amount', width: 12 },
      { key: 'currency', width: 10 },
      { key: 'category', width: 14 },
      { key: 'payers', width: 24 },
      { key: 'splitType', width: 12 },
      ...memberColumns.map((m) => ({
        key: `member:${m.memberId}`,
        width: 14,
      })),
    ];

    // --- Balances section ---
    sheet.addRow(['Balances']).font = { bold: true };
    sheet.addRow(['Member', 'Currency', 'Net balance']).font = { bold: true };
    for (const [currency, balances] of Object.entries(balancesByCurrency)) {
      // Omit a currency entirely when every member's balance in it is
      // exactly zero (fully settled — nothing to report). toCents() avoids
      // float-precision false positives, the same reasoning getSettlements
      // already relies on for its own debtor/creditor split.
      const hasNonZeroBalance = balances.some((b) => toCents(b.balance) !== 0);
      if (!hasNonZeroBalance) continue;
      // Otherwise show every member for this currency, including anyone
      // sitting at exactly 0 — matches getBalances' own convention of
      // backfilling every active member per currency.
      for (const b of balances) {
        sheet.addRow([b.name, currency, b.balance]);
      }
    }
    sheet.addRow([]);

    // --- Settlement plan section ---
    sheet.addRow(['Settlement plan']).font = { bold: true };
    sheet.addRow(['From', 'To', 'Amount', 'Currency']).font = { bold: true };
    if (settlements.length === 0) {
      sheet.addRow(['Everyone is settled up']);
    } else {
      for (const s of settlements) {
        sheet.addRow([s.from.name, s.to.name, s.amount, s.currency]);
      }
    }
    sheet.addRow([]);

    // --- Expense list section (unchanged content, now below the summary block) ---
    const headerRow: Record<string, unknown> = {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
      currency: 'Currency',
      category: 'Category',
      payers: 'Payer(s)',
      splitType: 'Split type',
    };
    for (const m of memberColumns) headerRow[`member:${m.memberId}`] = m.name;
    sheet.addRow(headerRow).font = { bold: true };

    for (const e of expenses) {
      const row: Record<string, unknown> = {
        date: e.date.toISOString().slice(0, 10),
        description: e.description,
        amount: Number(e.amount),
        currency: e.currency,
        category: e.category,
        payers: e.payers.map((p) => p.member.name).join(', '),
        splitType: e.splitType,
      };
      // A member's column key is only set when they participated in this
      // expense, so exceljs leaves the cell blank/undefined for everyone
      // else — never 0. A blank cell is visually distinct from "participated
      // with a zero-amount share," which a 0 would misrepresent.
      for (const split of e.splits) {
        row[`member:${split.memberId}`] = Number(split.amount);
      }
      sheet.addRow(row);
    }

    // exceljs's bundled index.d.ts declares its own local `Buffer` interface
    // (`extends ArrayBuffer`) that shadows Node's real Buffer type within its
    // own type declarations, even though writeBuffer() genuinely returns a
    // real Node Buffer instance at runtime (verified directly against the
    // installed exceljs version). Bridge the type-only mismatch here.
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, filename, filenameUtf8 };
  }

  async getBalances(
    groupId: string,
    userId: string,
  ): Promise<BalancesByCurrency> {
    // Verify membership
    await this.groupMembership.assertActiveMember(groupId, userId);

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
      const totalOwed = net > 0 ? net : 0;
      const totalOwe = net < 0 ? Math.abs(net) : 0;

      // Report every currency the member has a balance row for, including
      // an exact 0/0 (fully settled). Omitting settled currencies makes
      // this response indistinguishable from "not fetched yet" to callers
      // that check for an empty object as a loading proxy.
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
