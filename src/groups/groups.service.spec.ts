import { Test, TestingModule } from '@nestjs/testing';
import { GroupsService } from './groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('GroupsService', () => {
  let service: GroupsService;

  const mockPrisma = {
    group: {
      findUnique: jest.fn(),
    },
    groupMember: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    memberBalance: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
  };

  const mockEventsGateway = {
    emitMemberJoined: jest.fn(),
    emitMemberLeft: jest.fn(),
    emitGroupUpdated: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<GroupsService>(GroupsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addGuest', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const dto = { name: 'Sam' };

    it('should throw ForbiddenException if caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(service.addGuest(groupId, userId, dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.groupMember.create).not.toHaveBeenCalled();
    });

    it('should create a guest member with no userId and isGuest true', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.create.mockResolvedValueOnce({
        id: 'guest-1',
        groupId,
        userId: null,
        name: 'Sam',
        isGuest: true,
      });

      const result = await service.addGuest(groupId, userId, dto);

      expect(mockPrisma.groupMember.create).toHaveBeenCalledWith({
        data: {
          groupId,
          userId: null,
          name: 'Sam',
          role: 'MEMBER',
          isGuest: true,
        },
      });
      expect(result.isGuest).toBe(true);
      expect(mockEventsGateway.emitMemberJoined).toHaveBeenCalledWith(
        groupId,
        expect.objectContaining({ id: 'guest-1' }),
      );
    });
  });

  describe('renameGuest', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const guestId = 'guest-1';
    const dto = { name: 'Samantha' };

    it('should throw ForbiddenException if caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.renameGuest(groupId, userId, guestId, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if the guest does not exist in this group', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.renameGuest(groupId, userId, guestId, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should rename the guest', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.findFirst.mockResolvedValueOnce({
        id: guestId,
        groupId,
        isGuest: true,
        deletedAt: null,
      });
      mockPrisma.groupMember.update.mockResolvedValueOnce({
        id: guestId,
        groupId,
        name: 'Samantha',
        isGuest: true,
      });

      const result = await service.renameGuest(groupId, userId, guestId, dto);

      expect(mockPrisma.groupMember.update).toHaveBeenCalledWith({
        where: { id: guestId },
        data: { name: 'Samantha' },
      });
      expect(result.name).toBe('Samantha');
    });
  });

  describe('removeGuest', () => {
    const groupId = 'group-1';
    const userId = 'user-1';
    const guestId = 'guest-1';

    it('should throw ForbiddenException if caller is not an active member', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.removeGuest(groupId, userId, guestId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if the guest does not exist in this group', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.removeGuest(groupId, userId, guestId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if the guest has an unsettled balance', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.findFirst.mockResolvedValueOnce({
        id: guestId,
        groupId,
        isGuest: true,
        deletedAt: null,
      });
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([
        { memberId: guestId, groupId, balance: 12.5, currency: 'USD' },
      ]);

      await expect(
        service.removeGuest(groupId, userId, guestId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.groupMember.update).not.toHaveBeenCalled();
    });

    it('should soft-delete the guest when settled', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      });
      mockPrisma.groupMember.findFirst.mockResolvedValueOnce({
        id: guestId,
        groupId,
        isGuest: true,
        deletedAt: null,
      });
      mockPrisma.memberBalance.findMany.mockResolvedValueOnce([]);
      mockPrisma.groupMember.update.mockResolvedValueOnce({
        id: guestId,
        deletedAt: new Date(),
      });

      await service.removeGuest(groupId, userId, guestId);

      expect(mockPrisma.groupMember.update).toHaveBeenCalledWith({
        where: { id: guestId },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockEventsGateway.emitMemberLeft).toHaveBeenCalledWith(
        groupId,
        guestId,
      );
    });
  });

  describe('previewByInviteCode', () => {
    const inviteCode = 'AB123456';

    it('returns name, currency, and memberCount for a matching non-deleted group', async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce({
        id: 'group-1',
        name: 'Trip to Japan',
        currency: 'USD',
        _count: { members: 4 },
      });

      const result = await service.previewByInviteCode(inviteCode);

      expect(result).toEqual({
        name: 'Trip to Japan',
        currency: 'USD',
        memberCount: 4,
      });
    });

    it('uppercases the invite code before looking it up, regardless of input case', async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce({
        id: 'group-1',
        name: 'Trip to Japan',
        currency: 'USD',
        _count: { members: 1 },
      });

      await service.previewByInviteCode('ab123456');

      expect(mockPrisma.group.findUnique).toHaveBeenCalledWith({
        where: { inviteCode: 'AB123456', deletedAt: null },
        include: {
          _count: { select: { members: { where: { deletedAt: null } } } },
        },
      });
    });

    it('throws NotFoundException when no matching non-deleted group exists', async () => {
      mockPrisma.group.findUnique.mockResolvedValueOnce(null);

      await expect(service.previewByInviteCode(inviteCode)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
