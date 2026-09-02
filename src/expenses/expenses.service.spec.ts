import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { GroupMembershipService } from './group-membership.service';
import { ExpensesBalancesService } from './expenses-balances.service';
import { withIdempotency } from '../helpers/idempotency.helper';
import { SplitType } from '@prisma/client';
import ExcelJS from 'exceljs';

jest.mock('../helpers/idempotency.helper');
const mockWithIdempotency = withIdempotency as jest.MockedFunction<
  typeof withIdempotency
>;

describe('ExpensesService', () => {
  let service: ExpensesService;

  const mockPrisma = {
    groupMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    memberBalance: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    group: {
      findUnique: jest.fn(),
    },
    expense: {
      groupBy: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    expensePayer: {
      createMany: jest.fn(),
      groupBy: jest.fn(),
    },
    expenseSplit: {
      createMany: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    debt: {
      findUnique: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(mockPrisma)),
  };

  const mockEventsGateway = {
    emitExpenseUpdated: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
        GroupMembershipService,
        ExpensesBalancesService,
      ],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);

    // Default so tests that don't care about active-member lookups don't
    // crash on `.map()` over `undefined`; individual tests still override
    // via mockResolvedValueOnce where the members list actually matters.
    mockPrisma.groupMember.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create (idempotency wiring)', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const dto = {
      description: 'Lunch',
      amount: 20,
      splitType: SplitType.EVEN,
      payers: [{ memberId: 'member-1', amount: 20 }],
      splits: [
        { memberId: 'member-1', amount: 10 },
        { memberId: 'member-2', amount: 10 },
      ],
    };

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('passes the idempotency key through to withIdempotency and returns its result', async () => {
      const sentinel = { id: 'expense-1' };
      mockWithIdempotency.mockResolvedValueOnce(sentinel as never);

      const result = await service.create(groupId, userId, dto, 'key-abc');

      expect(result).toBe(sentinel);
      expect(mockWithIdempotency).toHaveBeenCalledWith(
        mockPrisma,
        'key-abc',
        userId,
        'POST /groups/:id/expenses',
        expect.any(Function),
      );
    });

    it('still works when no idempotency key is provided', async () => {
      const sentinel = { id: 'expense-2' };
      mockWithIdempotency.mockResolvedValueOnce(sentinel as never);

      const result = await service.create(groupId, userId, dto);

      expect(result).toBe(sentinel);
      expect(mockWithIdempotency).toHaveBeenCalledWith(
        mockPrisma,
        undefined,
        userId,
        'POST /groups/:id/expenses',
        expect.any(Function),
      );
    });
  });

  describe('getSpendingByCategory', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('throws ForbiddenException when the caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getSpendingByCategory(groupId, userId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.expense.groupBy).not.toHaveBeenCalled();
    });

    it('excludes soft-deleted expenses via deletedAt: null', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByCategory(groupId, userId, 'USD');

      expect(mockPrisma.expense.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });

    it('filters by the provided currency without querying the group', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByCategory(groupId, userId, 'EUR');

      expect(mockPrisma.group.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.expense.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: 'EUR' }),
        }),
      );
    });

    it("falls back to the group's own currency when none is provided", async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce({
        id: groupId,
        currency: 'VND',
      });
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByCategory(groupId, userId);

      expect(mockPrisma.group.findUnique).toHaveBeenCalledWith({
        where: { id: groupId },
      });
      expect(mockPrisma.expense.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: 'VND' }),
        }),
      );
    });

    it('converts summed decimal totals to integer cents per category, including legacy OTHER-defaulted rows', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([
        { category: 'FOOD', _sum: { amount: 12.5 } },
        { category: 'OTHER', _sum: { amount: 3.333333 } },
      ]);

      const result = await service.getSpendingByCategory(
        groupId,
        userId,
        'USD',
      );

      expect(result).toEqual([
        { category: 'FOOD', totalCents: 1250 },
        { category: 'OTHER', totalCents: 333 },
      ]);
    });

    it('returns an empty array when the group has no spending in that currency', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      const result = await service.getSpendingByCategory(
        groupId,
        userId,
        'USD',
      );

      expect(result).toEqual([]);
    });

    it('builds a date range filter when from/to are provided', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByCategory(
        groupId,
        userId,
        'USD',
        '2026-01-01',
        '2026-01-31',
      );

      expect(mockPrisma.expense.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            date: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
          }),
        }),
      );
    });

    it('omits the date filter entirely when from/to are not provided', async () => {
      mockPrisma.expense.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByCategory(groupId, userId, 'USD');

      const call = mockPrisma.expense.groupBy.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('date');
    });
  });

  describe('getSpendingByPerson', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('throws ForbiddenException when the caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getSpendingByPerson(groupId, userId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.expensePayer.groupBy).not.toHaveBeenCalled();
      expect(mockPrisma.expenseSplit.groupBy).not.toHaveBeenCalled();
    });

    it("defaults to the 'paid' metric and queries expensePayer", async () => {
      mockPrisma.expensePayer.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByPerson(groupId, userId, 'USD');

      expect(mockPrisma.expensePayer.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['memberId'],
          where: expect.objectContaining({
            expense: expect.objectContaining({
              groupId,
              deletedAt: null,
              currency: 'USD',
            }),
          }),
          _sum: { amount: true },
        }),
      );
      expect(mockPrisma.expenseSplit.groupBy).not.toHaveBeenCalled();
    });

    it("queries expenseSplit when metric is 'share'", async () => {
      mockPrisma.expenseSplit.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByPerson(
        groupId,
        userId,
        'USD',
        undefined,
        undefined,
        'share',
      );

      expect(mockPrisma.expenseSplit.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['memberId'],
          where: expect.objectContaining({
            expense: expect.objectContaining({
              groupId,
              deletedAt: null,
              currency: 'USD',
            }),
          }),
          _sum: { amount: true },
        }),
      );
      expect(mockPrisma.expensePayer.groupBy).not.toHaveBeenCalled();
    });

    it("falls back to the group's own currency when none is provided", async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce({
        id: groupId,
        currency: 'VND',
      });
      mockPrisma.expensePayer.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByPerson(groupId, userId);

      expect(mockPrisma.group.findUnique).toHaveBeenCalledWith({
        where: { id: groupId },
      });
      expect(mockPrisma.expensePayer.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expense: expect.objectContaining({ currency: 'VND' }),
          }),
        }),
      );
    });

    it('builds a date range filter on the joined expense when from/to are provided', async () => {
      mockPrisma.expensePayer.groupBy.mockResolvedValueOnce([]);

      await service.getSpendingByPerson(
        groupId,
        userId,
        'USD',
        '2026-01-01',
        '2026-01-31',
      );

      expect(mockPrisma.expensePayer.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expense: expect.objectContaining({
              date: {
                gte: new Date('2026-01-01'),
                lte: new Date('2026-01-31'),
              },
            }),
          }),
        }),
      );
    });

    it('joins member names, converts to cents, and drops removed members', async () => {
      mockPrisma.expensePayer.groupBy.mockResolvedValueOnce([
        { memberId: 'member-a', _sum: { amount: 12.5 } },
        { memberId: 'member-removed', _sum: { amount: 7 } },
      ]);
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-a', name: 'Alice', deletedAt: null },
      ]);

      const result = await service.getSpendingByPerson(groupId, userId, 'USD');

      expect(result).toEqual([
        { memberId: 'member-a', name: 'Alice', totalCents: 1250 },
      ]);
    });

    it('returns an empty array when there is no spending in that currency', async () => {
      mockPrisma.expensePayer.groupBy.mockResolvedValueOnce([]);
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([]);

      const result = await service.getSpendingByPerson(groupId, userId, 'USD');

      expect(result).toEqual([]);
    });
  });

  describe('getSpendingByPersonCategory', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('throws ForbiddenException when the caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getSpendingByPersonCategory(groupId, userId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.expenseSplit.findMany).not.toHaveBeenCalled();
    });

    it('filters the joined expense by currency without querying the group', async () => {
      mockPrisma.expenseSplit.findMany.mockResolvedValueOnce([]);

      await service.getSpendingByPersonCategory(groupId, userId, 'EUR');

      expect(mockPrisma.group.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.expenseSplit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expense: expect.objectContaining({
              groupId,
              deletedAt: null,
              currency: 'EUR',
            }),
          }),
          select: expect.objectContaining({
            memberId: true,
            amount: true,
            expense: { select: { category: true } },
          }),
        }),
      );
    });

    it('builds a date range filter on the joined expense when from/to are provided', async () => {
      mockPrisma.expenseSplit.findMany.mockResolvedValueOnce([]);

      await service.getSpendingByPersonCategory(
        groupId,
        userId,
        'USD',
        '2026-01-01',
        '2026-01-31',
      );

      expect(mockPrisma.expenseSplit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expense: expect.objectContaining({
              date: {
                gte: new Date('2026-01-01'),
                lte: new Date('2026-01-31'),
              },
            }),
          }),
        }),
      );
    });

    it('aggregates multiple splits for the same member and category into one row', async () => {
      mockPrisma.expenseSplit.findMany.mockResolvedValueOnce([
        { memberId: 'member-a', amount: 10, expense: { category: 'FOOD' } },
        { memberId: 'member-a', amount: 2.5, expense: { category: 'FOOD' } },
        { memberId: 'member-a', amount: 5, expense: { category: 'TRANSPORT' } },
      ]);
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-a', name: 'Alice', deletedAt: null },
      ]);

      const result = await service.getSpendingByPersonCategory(
        groupId,
        userId,
        'USD',
      );

      expect(result).toEqual([
        {
          memberId: 'member-a',
          name: 'Alice',
          category: 'FOOD',
          totalCents: 1250,
        },
        {
          memberId: 'member-a',
          name: 'Alice',
          category: 'TRANSPORT',
          totalCents: 500,
        },
      ]);
    });

    it('drops rows for members who are no longer active', async () => {
      mockPrisma.expenseSplit.findMany.mockResolvedValueOnce([
        {
          memberId: 'member-removed',
          amount: 10,
          expense: { category: 'FOOD' },
        },
      ]);
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([]);

      const result = await service.getSpendingByPersonCategory(
        groupId,
        userId,
        'USD',
      );

      expect(result).toEqual([]);
    });

    it('returns an empty array when there are no splits in that currency', async () => {
      mockPrisma.expenseSplit.findMany.mockResolvedValueOnce([]);
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([]);

      const result = await service.getSpendingByPersonCategory(
        groupId,
        userId,
        'USD',
      );

      expect(result).toEqual([]);
    });
  });

  describe('getTopExpenses', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('throws ForbiddenException when the caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(service.getTopExpenses(groupId, userId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.expense.findMany).not.toHaveBeenCalled();
    });

    it('queries sorted descending by amount, defaulting limit to 5', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      await service.getTopExpenses(groupId, userId, 'USD');

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            groupId,
            deletedAt: null,
            currency: 'USD',
          }),
          orderBy: { amount: 'desc' },
          take: 5,
        }),
      );
    });

    it('respects an explicit limit', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      await service.getTopExpenses(
        groupId,
        userId,
        'USD',
        undefined,
        undefined,
        2,
      );

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 }),
      );
    });

    it("falls back to the group's own currency when none is provided", async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce({
        id: groupId,
        currency: 'VND',
      });
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      await service.getTopExpenses(groupId, userId);

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: 'VND' }),
        }),
      );
    });

    it('builds a date range filter when from/to are provided', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      await service.getTopExpenses(
        groupId,
        userId,
        'USD',
        '2026-01-01',
        '2026-01-31',
      );

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            date: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
          }),
        }),
      );
    });

    it('maps expense rows to TopExpenseItem including all payer names', async () => {
      const date = new Date('2026-02-01T00:00:00.000Z');
      mockPrisma.expense.findMany.mockResolvedValueOnce([
        {
          id: 'expense-1',
          description: 'Hotel',
          amount: 300,
          currency: 'USD',
          category: 'TRAVEL',
          date,
          payers: [{ member: { name: 'Alice' } }, { member: { name: 'Bob' } }],
        },
      ]);

      const result = await service.getTopExpenses(groupId, userId, 'USD');

      expect(result).toEqual([
        {
          id: 'expense-1',
          description: 'Hotel',
          amount: 300,
          currency: 'USD',
          category: 'TRAVEL',
          date,
          payerNames: ['Alice', 'Bob'],
        },
      ]);
    });

    it('returns an empty array when there are no expenses in that currency', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      const result = await service.getTopExpenses(groupId, userId, 'USD');

      expect(result).toEqual([]);
    });
  });

  describe('exportExpenses', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.group.findUnique.mockResolvedValue({
        id: groupId,
        name: 'Trip to Japan',
        currency: 'USD',
      });
      // Default: no balance activity at all, so getBalances/getSettlements
      // (both called internally by exportExpenses) resolve to an empty
      // BalancesByCurrency ({}) and an empty settlements list ([]). This
      // fixes the Balances/Settlement summary block at exactly 7 rows
      // (title, header, blank, title, header, "Everyone is settled up",
      // blank) for every test below that doesn't override these mocks, so
      // the expense-list header always lands on row 8 in those tests.
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      mockPrisma.memberBalance.findMany.mockResolvedValue([]);
    });

    it('throws ForbiddenException when the caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(service.exportExpenses(groupId, userId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.expense.findMany).not.toHaveBeenCalled();
    });

    it('queries all non-deleted expenses for the group ordered by date ascending, with payers and splits included', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      await service.exportExpenses(groupId, userId);

      expect(mockPrisma.expense.findMany).toHaveBeenCalledWith({
        where: { groupId, deletedAt: null },
        include: {
          payers: { include: { member: true } },
          splits: { include: { member: true } },
        },
        orderBy: { date: 'asc' },
      });
    });

    it('produces a workbook with only the 7 fixed columns and a header row at row 8 for a zero-expense, zero-balance-activity group', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);

      const { buffer, filename, filenameUtf8 } = await service.exportExpenses(
        groupId,
        userId,
      );

      expect(filename).toBe('Trip to Japan-expenses.xlsx');
      expect(filenameUtf8).toBe('Trip to Japan-expenses.xlsx');

      const workbook = new ExcelJS.Workbook();
      // See the matching comment in expenses.service.ts: exceljs's bundled
      // types declare their own local Buffer interface that doesn't
      // structurally match Node's real Buffer, even though the runtime value
      // is a genuine Node Buffer.
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      expect(sheet.rowCount).toBe(8);
      expect(sheet.columnCount).toBe(7);
      expect(sheet.getRow(1).getCell(1).value).toBe('Balances');
      expect(sheet.getRow(4).getCell(1).value).toBe('Settlement plan');
      expect(sheet.getRow(6).getCell(1).value).toBe('Everyone is settled up');
      expect(sheet.getRow(8).getCell(1).value).toBe('Date');
      expect(sheet.getRow(8).getCell(7).value).toBe('Split type');
    });

    it('produces one data row per expense at row 9+ with comma-joined payer names and the raw category/splitType enum values', async () => {
      const date = new Date('2026-01-15T00:00:00.000Z');
      mockPrisma.expense.findMany.mockResolvedValueOnce([
        {
          id: 'expense-1',
          description: 'Hotel',
          amount: 300,
          currency: 'USD',
          category: 'TRAVEL',
          splitType: 'EVEN',
          date,
          payers: [
            { memberId: 'member-a', member: { id: 'member-a', name: 'Alice' } },
            { memberId: 'member-b', member: { id: 'member-b', name: 'Bob' } },
          ],
          splits: [
            {
              memberId: 'member-a',
              amount: 150,
              member: { id: 'member-a', name: 'Alice' },
            },
            {
              memberId: 'member-b',
              amount: 150,
              member: { id: 'member-b', name: 'Bob' },
            },
          ],
        },
      ]);

      const { buffer } = await service.exportExpenses(groupId, userId);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      expect(sheet.rowCount).toBe(9);
      expect(sheet.columnCount).toBe(9); // 7 fixed + Alice + Bob
      expect(sheet.getRow(8).getCell(1).value).toBe('Date');
      const row = sheet.getRow(9);
      expect(row.getCell(1).value).toBe('2026-01-15');
      expect(row.getCell(2).value).toBe('Hotel');
      expect(row.getCell(3).value).toBe(300);
      expect(row.getCell(4).value).toBe('USD');
      expect(row.getCell(5).value).toBe('TRAVEL');
      expect(row.getCell(6).value).toBe('Alice, Bob');
      expect(row.getCell(7).value).toBe('EVEN');
    });

    it('includes a column for a member removed from the group, and leaves a blank (not 0) cell for a member who did not participate in a given expense', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([
        {
          id: 'expense-1',
          description: 'Groceries',
          amount: 40,
          currency: 'USD',
          category: 'FOOD',
          splitType: 'EVEN',
          date: new Date('2026-01-10'),
          payers: [
            {
              memberId: 'member-removed',
              member: { id: 'member-removed', name: 'Zack' },
            },
          ],
          splits: [
            {
              memberId: 'member-removed',
              amount: 40,
              member: { id: 'member-removed', name: 'Zack' },
            },
          ],
        },
        {
          id: 'expense-2',
          description: 'Taxi',
          amount: 20,
          currency: 'USD',
          category: 'TRANSPORT',
          splitType: 'EVEN',
          date: new Date('2026-01-11'),
          payers: [
            {
              memberId: 'member-active',
              member: { id: 'member-active', name: 'Amy' },
            },
          ],
          splits: [
            {
              memberId: 'member-active',
              amount: 20,
              member: { id: 'member-active', name: 'Amy' },
            },
          ],
        },
      ]);

      const { buffer } = await service.exportExpenses(groupId, userId);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      expect(sheet.rowCount).toBe(10);
      // Member columns sorted alphabetically: Amy (col 8), Zack (col 9)
      expect(sheet.getRow(8).getCell(8).value).toBe('Amy');
      expect(sheet.getRow(8).getCell(9).value).toBe('Zack');
      // Row for expense-1 (Zack's groceries): Amy's cell is blank, Zack's cell is 40
      const row1 = sheet.getRow(9);
      expect(row1.getCell(8).value).toBeNull();
      expect(row1.getCell(9).value).toBe(40);
      // Row for expense-2 (Amy's taxi): Amy's cell is 20, Zack's cell is blank
      const row2 = sheet.getRow(10);
      expect(row2.getCell(8).value).toBe(20);
      expect(row2.getCell(9).value).toBeNull();
    });

    it('shows one Balances row per member for a currency with a non-zero balance (including a member at exactly 0), and omits a currency where every member is exactly 0', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-a', name: 'Alice', avatarUrl: null, deletedAt: null },
        { id: 'member-b', name: 'Bob', avatarUrl: null, deletedAt: null },
        { id: 'member-c', name: 'Carol', avatarUrl: null, deletedAt: null },
      ]);
      mockPrisma.memberBalance.findMany.mockResolvedValue([
        { memberId: 'member-a', currency: 'USD', balance: 30 },
        { memberId: 'member-b', currency: 'USD', balance: -30 },
        { memberId: 'member-c', currency: 'USD', balance: 0 },
        { memberId: 'member-a', currency: 'EUR', balance: 0 },
        { memberId: 'member-b', currency: 'EUR', balance: 0 },
        { memberId: 'member-c', currency: 'EUR', balance: 0 },
      ]);

      const { buffer } = await service.exportExpenses(groupId, userId);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      expect(sheet.getRow(1).getCell(1).value).toBe('Balances');
      expect(sheet.getRow(2).getCell(1).value).toBe('Member');
      expect(sheet.getRow(2).getCell(2).value).toBe('Currency');
      expect(sheet.getRow(2).getCell(3).value).toBe('Net balance');
      // USD has a non-zero balance, so all 3 members show, Carol included at 0.
      expect(sheet.getRow(3).getCell(1).value).toBe('Alice');
      expect(sheet.getRow(3).getCell(2).value).toBe('USD');
      expect(sheet.getRow(3).getCell(3).value).toBe(30);
      expect(sheet.getRow(4).getCell(1).value).toBe('Bob');
      expect(sheet.getRow(4).getCell(3).value).toBe(-30);
      expect(sheet.getRow(5).getCell(1).value).toBe('Carol');
      expect(sheet.getRow(5).getCell(3).value).toBe(0);
      // EUR is entirely zero, so it's omitted — row 6 is the blank separator,
      // row 7 is "Settlement plan", not another currency's data.
      expect(sheet.getRow(6).getCell(1).value).toBeNull();
      expect(sheet.getRow(7).getCell(1).value).toBe('Settlement plan');
      // The expense-list header (row 11) still lands correctly after the
      // longer, real-data summary block.
      expect(sheet.getRow(11).getCell(1).value).toBe('Date');
      expect(sheet.rowCount).toBe(11);
    });

    it('shows one Settlement plan row per recommended payment, in major units', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-a', name: 'Alice', avatarUrl: null, deletedAt: null },
        { id: 'member-b', name: 'Bob', avatarUrl: null, deletedAt: null },
      ]);
      mockPrisma.memberBalance.findMany.mockResolvedValue([
        { memberId: 'member-a', currency: 'USD', balance: 50 },
        { memberId: 'member-b', currency: 'USD', balance: -50 },
      ]);

      const { buffer } = await service.exportExpenses(groupId, userId);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      expect(sheet.getRow(6).getCell(1).value).toBe('Settlement plan');
      expect(sheet.getRow(7).getCell(1).value).toBe('From');
      expect(sheet.getRow(7).getCell(2).value).toBe('To');
      expect(sheet.getRow(7).getCell(3).value).toBe('Amount');
      expect(sheet.getRow(7).getCell(4).value).toBe('Currency');
      const row = sheet.getRow(8);
      expect(row.getCell(1).value).toBe('Bob'); // debtor pays...
      expect(row.getCell(2).value).toBe('Alice'); // ...the creditor
      expect(row.getCell(3).value).toBe(50); // major units, not 5000 cents
      expect(row.getCell(4).value).toBe('USD');
      expect(sheet.getRow(10).getCell(1).value).toBe('Date');
      expect(sheet.rowCount).toBe(10);
    });

    it('shows "Everyone is settled up" when getSettlements returns no recommended payments, even with non-empty but fully-zero balance data', async () => {
      mockPrisma.expense.findMany.mockResolvedValueOnce([]);
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-a', name: 'Alice', avatarUrl: null, deletedAt: null },
        { id: 'member-b', name: 'Bob', avatarUrl: null, deletedAt: null },
      ]);
      mockPrisma.memberBalance.findMany.mockResolvedValue([
        { memberId: 'member-a', currency: 'USD', balance: 0 },
        { memberId: 'member-b', currency: 'USD', balance: 0 },
      ]);

      const { buffer } = await service.exportExpenses(groupId, userId);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Expenses')!;
      // The USD currency is present but fully zero, so it's omitted from
      // Balances (row 3 is the blank separator, not a data row).
      expect(sheet.getRow(3).getCell(1).value).toBeNull();
      expect(sheet.getRow(4).getCell(1).value).toBe('Settlement plan');
      const row = sheet.getRow(6);
      expect(row.getCell(1).value).toBe('Everyone is settled up');
      expect(row.getCell(2).value).toBeNull();
      expect(sheet.getRow(8).getCell(1).value).toBe('Date');
      expect(sheet.rowCount).toBe(8);
    });
  });

  describe('updateExpense (category preserve-on-omit)', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const expenseId = 'expense-1';
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');

    // No `category` field — mirrors clients like money-split-mobile that
    // predate categories and re-send edits without one.
    const baseDto = {
      description: 'Lunch',
      amount: 20,
      splitType: SplitType.EVEN,
      payers: [{ memberId: 'member-1', amount: 20 }],
      splits: [{ memberId: 'member-1' }, { memberId: 'member-2' }],
    };

    const oldExpense = {
      id: expenseId,
      groupId,
      currency: 'USD',
      category: 'FOOD',
      updatedAt,
      payers: [{ memberId: 'member-1', amount: 20, member: { name: 'Alice' } }],
      splits: [
        { memberId: 'member-1', amount: 10, member: { name: 'Alice' } },
        { memberId: 'member-2', amount: 10, member: { name: 'Bob' } },
      ],
    };

    const buildFinalExpense = (category: string) => ({
      id: expenseId,
      groupId,
      description: 'Lunch',
      amount: 20,
      splitType: SplitType.EVEN,
      category,
      currency: 'USD',
      date: new Date(),
      payers: [{ memberId: 'member-1', amount: 20, member: { name: 'Alice' } }],
      splits: [
        { memberId: 'member-1', amount: 10, share: null, percentage: null },
        { memberId: 'member-2', amount: 10, share: null, percentage: null },
      ],
    });

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.expense.update.mockResolvedValue({ id: expenseId });
      mockPrisma.expensePayer.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.expenseSplit.createMany.mockResolvedValue({ count: 2 });
      mockPrisma.memberBalance.upsert.mockResolvedValue({});
      mockPrisma.debt.findUnique.mockResolvedValue(null);
      mockPrisma.debt.upsert.mockResolvedValue({});
    });

    it('leaves the existing category untouched when the update DTO omits it', async () => {
      mockPrisma.expense.findUnique
        .mockResolvedValueOnce(oldExpense)
        .mockResolvedValueOnce(buildFinalExpense('FOOD'));

      const result = await service.updateExpense(
        groupId,
        expenseId,
        userId,
        baseDto as never,
      );

      expect(result.category).toBe('FOOD');
      const updateCall = mockPrisma.expense.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('category');
    });

    it('overwrites the category when the update DTO explicitly provides one', async () => {
      mockPrisma.expense.findUnique
        .mockResolvedValueOnce(oldExpense)
        .mockResolvedValueOnce(buildFinalExpense('TRANSPORT'));

      const dto = { ...baseDto, category: 'TRANSPORT' };
      const result = await service.updateExpense(
        groupId,
        expenseId,
        userId,
        dto as never,
      );

      expect(result.category).toBe('TRANSPORT');
      const updateCall = mockPrisma.expense.update.mock.calls[0][0];
      expect(updateCall.data.category).toBe('TRANSPORT');
    });
  });
});
