import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { withIdempotency } from '../helpers/idempotency.helper';
import { SplitType } from '@prisma/client';

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
      ],
    }).compile();

    service = module.get<ExpensesService>(ExpensesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserBalance', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const memberId = 'member-1';

    beforeEach(() => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: memberId, groupId, userId, deletedAt: null },
      ]);
    });

    it('should report a non-zero balance as owed or owing', async () => {
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([
        { memberId, currency: 'USD', balance: -100 },
      ]);

      const result = await service.getUserBalance(groupId, userId);

      expect(result.balances.USD).toEqual({
        totalOwed: 0,
        totalOwe: 100,
        details: [],
      });
    });

    it('should still report a currency explicitly as settled (0/0), not omit it, when the member is fully settled', async () => {
      // This is the bug: a member who has fully paid off their debt via
      // settlements has a MemberBalance row of exactly 0 for that currency.
      // Omitting it from the response makes the frontend's "has the server
      // responded yet" check (Object.keys(balances).length > 0) indistinguishable
      // from "never fetched" - causing it to fall back to a stale,
      // settlement-unaware local calculation that still shows the old debt.
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([
        { memberId, currency: 'USD', balance: 0 },
      ]);

      const result = await service.getUserBalance(groupId, userId);

      expect(result.balances.USD).toEqual({
        totalOwed: 0,
        totalOwe: 0,
        details: [],
      });
    });
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
              date: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
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
      payers: [
        { memberId: 'member-1', amount: 20, member: { name: 'Alice' } },
      ],
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
      payers: [
        { memberId: 'member-1', amount: 20, member: { name: 'Alice' } },
      ],
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
