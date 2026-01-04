import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { GroupRole } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class GroupsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, createGroupDto: CreateGroupDto) {
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

  async findAll(userId: string) {
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

  async findOne(id: string, userId: string) {
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

  async update(id: string, userId: string, updateGroupDto: UpdateGroupDto) {
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

    return this.prisma.group.update({
      where: { id },
      data: updateGroupDto,
    });
  }

  async remove(id: string, userId: string) {
    // Only creator or OWNER can delete the group
    const member = await this.prisma.groupMember.findUnique({
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

    // Soft delete
    return this.prisma.group.update({
      where: { id },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
