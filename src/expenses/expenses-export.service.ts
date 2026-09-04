import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GroupMembershipService } from './group-membership.service';
import { ExpensesBalancesService } from './expenses-balances.service';
import ExcelJS from 'exceljs';
import { buildExportFilename } from '../helpers/filename.helper';
import { toCents } from '../helpers/number.helper';

@Injectable()
export class ExpensesExportService {
  constructor(
    private prisma: PrismaService,
    private groupMembership: GroupMembershipService,
    private balancesService: ExpensesBalancesService,
  ) {}

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
    const balancesByCurrency = await this.balancesService.getBalances(
      groupId,
      userId,
    );
    const settlements = await this.balancesService.getSettlements(
      groupId,
      userId,
    );

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
}
