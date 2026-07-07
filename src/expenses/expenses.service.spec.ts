import { Test, TestingModule } from '@nestjs/testing';
import { ExpensesService } from './expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';

describe('ExpensesService', () => {
  let service: ExpensesService;

  const mockPrisma = {
    groupMember: {
      findMany: jest.fn(),
    },
    memberBalance: {
      findMany: jest.fn(),
    },
  };

  const mockEventsGateway = {};

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
});
