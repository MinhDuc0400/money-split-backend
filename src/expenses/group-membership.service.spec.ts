import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GroupMembershipService } from './group-membership.service';
import { PrismaService } from '../prisma/prisma.service';

describe('GroupMembershipService', () => {
  let service: GroupMembershipService;

  const mockPrisma = {
    groupMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupMembershipService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<GroupMembershipService>(GroupMembershipService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('assertActiveMember', () => {
    const groupId = 'group-1';
    const userId = 'user-1';

    it('returns the member when they are an active member', async () => {
      const member = {
        id: 'member-1',
        groupId,
        userId,
        deletedAt: null,
      };
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(member);

      await expect(
        service.assertActiveMember(groupId, userId),
      ).resolves.toEqual(member);
      expect(mockPrisma.groupMember.findUnique).toHaveBeenCalledWith({
        where: { groupId_userId: { groupId, userId } },
      });
    });

    it('throws ForbiddenException when no membership row exists', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce(null);

      await expect(service.assertActiveMember(groupId, userId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when the membership row is soft-deleted', async () => {
      mockPrisma.groupMember.findUnique.mockResolvedValueOnce({
        id: 'member-1',
        groupId,
        userId,
        deletedAt: new Date(),
      });

      await expect(service.assertActiveMember(groupId, userId)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('assertActiveMembers', () => {
    const groupId = 'group-1';

    it('accepts ids that are all active members of the group, looking them up within that group only', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: null },
      ]);

      await expect(
        service.assertActiveMembers(groupId, ['member-1', 'member-2']),
      ).resolves.toBeUndefined();
      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledWith({
        where: { groupId, id: { in: ['member-1', 'member-2'] } },
        select: { id: true, deletedAt: true },
      });
    });

    it('rejects an id that has no member row in this group (e.g. a member of another group)', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-1', deletedAt: null },
      ]);

      await expect(
        service.assertActiveMembers(groupId, ['member-1', 'outsider']),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a member who has left the group', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: new Date() },
      ]);

      await expect(
        service.assertActiveMembers(groupId, ['member-1', 'member-2']),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a member who has left when they are already on the expense being edited', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-1', deletedAt: null },
        { id: 'member-2', deletedAt: new Date() },
      ]);

      await expect(
        service.assertActiveMembers(
          groupId,
          ['member-1', 'member-2'],
          ['member-2'],
        ),
      ).resolves.toBeUndefined();
    });

    it('still rejects an outsider even when listed as already on the expense', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValueOnce([
        { id: 'member-1', deletedAt: null },
      ]);

      await expect(
        service.assertActiveMembers(
          groupId,
          ['member-1', 'outsider'],
          ['outsider'],
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
