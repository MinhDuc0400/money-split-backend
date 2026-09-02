import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { GroupMembershipService } from './group-membership.service';
import { PrismaService } from '../prisma/prisma.service';

describe('GroupMembershipService', () => {
  let service: GroupMembershipService;

  const mockPrisma = {
    groupMember: {
      findUnique: jest.fn(),
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
});
