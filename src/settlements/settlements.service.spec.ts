import { Test, TestingModule } from '@nestjs/testing';
import { SettlementsService } from './settlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { SettlementStatus } from '@prisma/client';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { withIdempotency } from '../helpers/idempotency.helper';

jest.mock('../helpers/idempotency.helper');
const mockWithIdempotency = withIdempotency as jest.MockedFunction<
  typeof withIdempotency
>;

describe('SettlementsService', () => {
  let service: SettlementsService;
  let prisma: PrismaService;

  const mockPrisma = {
    groupMember: {
      findUnique: jest.fn(),
    },
    memberBalance: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    settlement: {
      create: jest.fn(),
    },
    debt: {
      findUnique: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
  };

  const mockEventsGateway = {
    emitSettlementUpdated: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementsService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: EventsGateway,
          useValue: mockEventsGateway,
        },
      ],
    }).compile();

    service = module.get<SettlementsService>(SettlementsService);
    prisma = module.get<PrismaService>(PrismaService);

    // Default passthrough: real withIdempotency behavior for tests that
    // don't care about idempotency specifically, so the wrapped fn still runs.
    mockWithIdempotency.mockImplementation(
      (_prisma, _key, _userId, _endpoint, fn) =>
        mockPrisma.$transaction(fn as never),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createSettlement', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const dto = {
      fromId: 'member-1',
      toId: 'member-2',
      amount: 10,
      currency: 'USD',
    };

    it('should throw ForbiddenException if caller is not in group', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.createSettlement(groupId, userId, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create a settlement and update balances and debts', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
      });
      mockPrisma.groupMember.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'member-1')
          return Promise.resolve({ id: 'member-1', groupId });
        if (where.id === 'member-2')
          return Promise.resolve({ id: 'member-2', groupId });
        return Promise.resolve({ id: 'member-1', groupId }); // caller check
      });

      mockPrisma.settlement.create.mockResolvedValue({
        id: 'settlement-1',
        fromId: 'member-1',
        toId: 'member-2',
        amount: 10,
        currency: 'USD',
        status: SettlementStatus.COMPLETED,
        from: { name: 'Member 1', avatarUrl: null },
        to: { name: 'Member 2', avatarUrl: null },
      });

      const result = await service.createSettlement(groupId, userId, dto);

      expect(result.amount).toBe(10);
      expect(mockPrisma.settlement.create).toHaveBeenCalled();
      expect(mockPrisma.memberBalance.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.debt.findUnique).toHaveBeenCalled();
    });

    it('passes the idempotency key through to withIdempotency and returns its result', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
      });
      const sentinel = { id: 'settlement-1' };
      mockWithIdempotency.mockReset();
      mockWithIdempotency.mockResolvedValueOnce(sentinel as never);

      const result = await service.createSettlement(
        groupId,
        userId,
        dto,
        'key-abc',
      );

      expect(result).toBe(sentinel);
      expect(mockWithIdempotency).toHaveBeenCalledWith(
        mockPrisma,
        'key-abc',
        userId,
        'POST /groups/:id/settlements',
        expect.any(Function),
      );
    });
  });

  describe('settleUp', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    it('should compute minimal transfers and update them incrementally', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
      });

      const balances = [
        {
          memberId: 'member-1',
          balance: -10,
          currency: 'USD',
          member: { name: 'M1', avatarUrl: null },
        },
        {
          memberId: 'member-2',
          balance: 10,
          currency: 'USD',
          member: { name: 'M2', avatarUrl: null },
        },
      ];
      mockPrisma.memberBalance.findMany.mockResolvedValue(balances);

      mockPrisma.settlement.create.mockImplementation((args) => ({
        id: 's-' + Math.random(),
        ...args.data,
        from: { name: 'M1', avatarUrl: null },
        to: { name: 'M2', avatarUrl: null },
      }));

      const result = await service.settleUp(groupId, userId, {
        currency: 'USD',
      });

      expect(result.settlements).toHaveLength(1);
      expect(result.settlements[0].amount).toBe(10);

      // Verification that shared logic was used:
      // 1. Settlement record created
      expect(mockPrisma.settlement.create).toHaveBeenCalled();
      // 2. Member balances updated (2 calls per settlement)
      expect(mockPrisma.memberBalance.upsert).toHaveBeenCalled();
      // 3. Debt records updated
      expect(mockPrisma.debt.findUnique).toHaveBeenCalled();

      // CRITICAL: Ensure NO blind zeroing happened
      expect(mockPrisma.memberBalance.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.debt.deleteMany).not.toHaveBeenCalled();
    });

    it('should handle complex multi-member settlement', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
      });

      const balances = [
        {
          memberId: 'm1',
          balance: -10,
          currency: 'USD',
          member: { name: 'M1', avatarUrl: null },
        },
        {
          memberId: 'm2',
          balance: -5,
          currency: 'USD',
          member: { name: 'M2', avatarUrl: null },
        },
        {
          memberId: 'm3',
          balance: 15,
          currency: 'USD',
          member: { name: 'M3', avatarUrl: null },
        },
      ];
      mockPrisma.memberBalance.findMany.mockResolvedValue(balances);

      mockPrisma.settlement.create.mockImplementation((args) => ({
        id: 's-' + Math.random(),
        ...args.data,
        from: { name: 'From', avatarUrl: null },
        to: { name: 'To', avatarUrl: null },
      }));

      const result = await service.settleUp(groupId, userId, {});

      // m1 owes 10, m2 owes 5 -> m3 is owed 15.
      // Transfers: m1 -> m3 (10), m2 -> m3 (5)
      expect(result.settlements).toHaveLength(2);
      const totalSettled = result.settlements.reduce(
        (sum, s) => sum + s.amount,
        0,
      );
      expect(totalSettled).toBe(15);
    });

    it('passes the idempotency key through to withIdempotency and returns its result', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
      });
      const sentinel = { settlements: [] };
      mockWithIdempotency.mockReset();
      mockWithIdempotency.mockResolvedValueOnce(sentinel as never);

      const result = await service.settleUp(
        groupId,
        userId,
        { currency: 'USD' },
        'key-xyz',
      );

      expect(result).toBe(sentinel);
      expect(mockWithIdempotency).toHaveBeenCalledWith(
        mockPrisma,
        'key-xyz',
        userId,
        'POST /groups/:id/settle-up',
        expect.any(Function),
      );
    });
  });

  describe('settleAll', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const fromId = 'member-a';
    const toId = 'member-b';

    beforeEach(() => {
      mockPrisma.groupMember.findUnique.mockResolvedValue({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
    });

    it('throws BadRequestException if a currency amount no longer matches the current balance', async () => {
      // Current state: fromId owes toId exactly $20 in USD (not $30 as the client sent).
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([
        { memberId: fromId, balance: -20, currency: 'USD', member: { name: 'A', avatarUrl: null } },
        { memberId: toId, balance: 20, currency: 'USD', member: { name: 'B', avatarUrl: null } },
      ]);

      await expect(
        service.settleAll(
          groupId,
          userId,
          { fromId, toId, items: [{ currency: 'USD', amount: 30 }] },
          'key-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.settlement.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException if a claimed currency has no matching transfer for this pair', async () => {
      // fromId has no USD balance at all with toId.
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([]);

      await expect(
        service.settleAll(
          groupId,
          userId,
          { fromId, toId, items: [{ currency: 'USD', amount: 30 }] },
          'key-2',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.settlement.create).not.toHaveBeenCalled();
    });

    it('settles every validated currency in one batch when all items match', async () => {
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([
        { memberId: fromId, balance: -30, currency: 'USD', member: { name: 'A', avatarUrl: null } },
        { memberId: toId, balance: 30, currency: 'USD', member: { name: 'B', avatarUrl: null } },
        { memberId: fromId, balance: -61.5, currency: 'GBP', member: { name: 'A', avatarUrl: null } },
        { memberId: toId, balance: 61.5, currency: 'GBP', member: { name: 'B', avatarUrl: null } },
      ]);
      mockPrisma.settlement.create.mockImplementation((args) => ({
        id: 's-' + Math.random(),
        ...args.data,
        from: { name: 'A', avatarUrl: null },
        to: { name: 'B', avatarUrl: null },
      }));

      const result = await service.settleAll(
        groupId,
        userId,
        {
          fromId,
          toId,
          items: [
            { currency: 'USD', amount: 30 },
            { currency: 'GBP', amount: 61.5 },
          ],
        },
        'key-3',
      );

      expect(result.settlements).toHaveLength(2);
      expect(mockPrisma.settlement.create).toHaveBeenCalledTimes(2);
    });
  });
});
