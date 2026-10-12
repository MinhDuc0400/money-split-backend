import { Test, TestingModule } from '@nestjs/testing';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { GroupMembershipService } from './group-membership.service';
import { withIdempotency } from '../helpers/idempotency.helper';
import { SplitType } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

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
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: null },
      ]);
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

    it('rejects a split participant who is not an active member of the group, without writing anything', async () => {
      mockPrisma.groupMember.findMany.mockReset();
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-1', deletedAt: null },
      ]);
      mockWithIdempotency.mockResolvedValue({ id: 'expense-3' } as never);

      await expect(service.create(groupId, userId, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockWithIdempotency).not.toHaveBeenCalled();
    });

    it('rejects a payer who is not an active member of the group', async () => {
      mockPrisma.groupMember.findMany.mockReset();
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: null },
      ]);
      mockWithIdempotency.mockResolvedValue({ id: 'expense-4' } as never);
      const outsiderPays = {
        ...dto,
        payers: [{ memberId: 'outsider', amount: 20 }],
      };

      await expect(
        service.create(groupId, userId, outsiderPays),
      ).rejects.toThrow(BadRequestException);
      expect(mockWithIdempotency).not.toHaveBeenCalled();
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
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: null },
      ]);
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

    it('rejects an edit that adds a participant who is not an active member of the group, leaving the expense untouched', async () => {
      mockPrisma.expense.findUnique.mockResolvedValueOnce(oldExpense);
      const dto = {
        ...baseDto,
        splits: [{ memberId: 'member-1' }, { memberId: 'outsider' }],
      };

      await expect(
        service.updateExpense(groupId, expenseId, userId, dto as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.expense.update).not.toHaveBeenCalled();
      expect(mockPrisma.memberBalance.upsert).not.toHaveBeenCalled();
    });

    it('allows an edit that keeps a participant who has since left the group', async () => {
      mockPrisma.groupMember.findMany.mockReset();
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: new Date('2026-02-01T00:00:00.000Z') },
      ]);
      mockPrisma.expense.findUnique
        .mockResolvedValueOnce(oldExpense)
        .mockResolvedValueOnce(buildFinalExpense('FOOD'));

      const result = await service.updateExpense(
        groupId,
        expenseId,
        userId,
        baseDto as never,
      );

      expect(result.id).toBe(expenseId);
      expect(mockPrisma.expense.update).toHaveBeenCalledTimes(1);
    });
  });
});
