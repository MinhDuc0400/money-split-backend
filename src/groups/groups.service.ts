import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { Group, GroupMember, GroupRole } from '@prisma/client';
import * as crypto from 'crypto';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
  ) {}

  async create(userId: string, createGroupDto: CreateGroupDto): Promise<Group> {
    return this.prisma.$transaction(async (tx) => {
      const id = crypto.randomUUID();
      const inviteCode = crypto
        .createHash('sha256')
        .update(id)
        .digest('hex')
        .substring(0, 8)
        .toUpperCase();

      const group = await tx.group.create({
        data: {
          ...createGroupDto,
          id,
          inviteCode,
          createdBy: userId,
        },
      });

      // Automatically add the creator as an OWNER member
      const user = await tx.user.findUnique({
        where: { id: userId },
      });

      await tx.groupMember.create({
        data: {
          groupId: group.id,
          userId: userId,
          name: user?.name || 'Unknown',
          avatarUrl: user?.avatarUrl,
          role: GroupRole.OWNER,
        },
      });

      return group;
    });
  }

  async findAll(userId: string): Promise<Group[]> {
    return this.prisma.group.findMany({
      where: {
        members: {
          some: {
            userId: userId,
            deletedAt: null,
          },
        },
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            members: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string, userId: string): Promise<Group> {
    const group = await this.prisma.group.findFirst({
      where: {
        id,
        members: {
          some: {
            userId: userId,
            deletedAt: null,
          },
        },
        deletedAt: null,
      },
      include: {
        members: {
          where: {
            deletedAt: null,
          },
        },
        expenses: {
          where: {
            deletedAt: null,
          },
          include: {
            payers: true,
            splits: true,
          },
          orderBy: {
            date: 'desc',
          },
        },
        settlements: {
          where: {
            deletedAt: null,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        _count: {
          select: {
            expenses: true,
          },
        },
      },
    });

    if (!group) {
      throw new NotFoundException(`Group with ID "${id}" not found`);
    }

    return group;
  }

  async update(
    id: string,
    userId: string,
    updateGroupDto: UpdateGroupDto,
  ): Promise<Group> {
    // Check if user is a member (or maybe only OWNER can update?)
    // For now, let's allow any member to update group info,
    // or restrict to OWNER if preferred.
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId: userId,
        },
      },
    });

    if (!member || member.deletedAt) {
      throw new ForbiddenException('You do not have access to this group');
    }

    const updated = await this.prisma.group.update({
      where: { id },
      data: updateGroupDto,
    });
    this.eventsGateway.emitGroupUpdated(id, updated);
    return updated;
  }

  async remove(id: string, userId: string): Promise<Group> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      // Only creator or OWNER can delete the group
      const member = await tx.groupMember.findUnique({
        where: {
          groupId_userId: {
            groupId: id,
            userId: userId,
          },
        },
      });

      if (!member || member.role !== GroupRole.OWNER || member.deletedAt) {
        throw new ForbiddenException('Only the group owner can delete the group');
      }

      // All members must be settled before the group can be deleted.
      // Checked and applied in the same transaction so a concurrent
      // expense/settlement can't slip in between the check and the write.
      const unsettledBalances = await tx.memberBalance.findMany({
        where: {
          groupId: id,
          balance: { not: 0 },
          member: { deletedAt: null },
        },
      });

      if (unsettledBalances.length > 0) {
        throw new ForbiddenException(
          'All members must settle their balances before the group can be deleted',
        );
      }

      return tx.group.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
    this.eventsGateway.emitGroupUpdated(id, { ...deleted, deleted: true });
    return deleted;
  }

  async leave(groupId: string, userId: string): Promise<void> {
    const member = await this.prisma.$transaction(async (tx) => {
      const member = await tx.groupMember.findFirst({
        where: { groupId, userId, deletedAt: null },
      });

      if (!member) {
        throw new NotFoundException('You are not a member of this group');
      }

      if (member.role === GroupRole.OWNER) {
        throw new ForbiddenException('Group owner cannot leave. Transfer ownership or delete the group.');
      }

      // Check if user has any unsettled balances in this group.
      // Checked and applied in the same transaction so a concurrent
      // expense/settlement can't slip in between the check and the write.
      const unsettledBalances = await tx.memberBalance.findMany({
        where: {
          memberId: member.id,
          groupId,
          balance: { not: 0 },
        },
      });

      if (unsettledBalances.length > 0) {
        throw new ForbiddenException('You must settle all balances before leaving the group');
      }

      await tx.groupMember.update({
        where: { id: member.id },
        data: { deletedAt: new Date() },
      });

      return member;
    });

    this.eventsGateway.emitMemberLeft(groupId, member.id);
  }

  async join(userId: string, joinGroupDto: JoinGroupDto): Promise<GroupMember> {
    const { inviteCode } = joinGroupDto;

    const group = await this.prisma.group.findUnique({
      where: {
        inviteCode: inviteCode.toUpperCase(),
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException(
        `Group with invite code "${inviteCode}" not found`,
      );
    }

    // Check if user is already a member
    const existingMember = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: group.id,
          userId,
        },
      },
    });

    if (existingMember) {
      if (existingMember.deletedAt) {
        // Re-activate member if they were soft-deleted
        return this.prisma.groupMember.update({
          where: { id: existingMember.id },
          data: { deletedAt: null },
        });
      }
      throw new ConflictException('You are already a member of this group');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    const member = await this.prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId: userId,
        name: user?.name || 'Unknown',
        avatarUrl: user?.avatarUrl,
        role: GroupRole.MEMBER,
      },
    });
    this.eventsGateway.emitMemberJoined(group.id, member);
    return member;
  }
}
