import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ExpensesAnalyticsService } from './expenses-analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupMembershipService } from './group-membership.service';

describe('ExpensesAnalyticsService', () => {
  let service: ExpensesAnalyticsService;

  const mockPrisma = {
    groupMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    group: {
      findUnique: jest.fn(),
    },
    expense: {
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    expensePayer: {
      groupBy: jest.fn(),
    },
    expenseSplit: {
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesAnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
        GroupMembershipService,
      ],
    }).compile();

    service = module.get<ExpensesAnalyticsService>(ExpensesAnalyticsService);

    // Default so tests that don't care about active-member lookups don't
    // crash on `.map()` over `undefined`; individual tests still override
    // via mockResolvedValueOnce where the members list actually matters.
    // Carried over from expenses.service.spec.ts's outer beforeEach, which
    // several of the relocated tests below depend on implicitly.
    mockPrisma.groupMember.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
