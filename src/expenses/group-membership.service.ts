import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GroupMembershipService {
  constructor(private prisma: PrismaService) {}

  /** Throws ForbiddenException if userId isn't an active member of groupId. */
  async assertActiveMember(groupId: string, userId: string) {
    const member = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (!member || member.deletedAt) {
      throw new ForbiddenException('You are not a member of this group');
    }

    return member;
  }

  /**
   * Throws BadRequestException unless every memberId is an active member of
   * groupId. Guards expense payers/splits, which arrive as bare member ids:
   * without this, an id from another group (or a member who has left) would
   * be accepted and given a balance row in this group.
   *
   * alreadyOnExpense lists member ids the expense being edited already
   * references. Those may have left since (leaving requires a zero balance),
   * and must stay editable in place - but they still have to belong to this
   * group.
   */
  async assertActiveMembers(
    groupId: string,
    memberIds: string[],
    alreadyOnExpense: string[] = [],
  ): Promise<void> {
    const ids = [...new Set(memberIds)];
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, id: { in: ids } },
      select: { id: true, deletedAt: true },
    });

    const grandfathered = new Set(alreadyOnExpense);
    const allowed = new Set(
      members
        .filter((m) => !m.deletedAt || grandfathered.has(m.id))
        .map((m) => m.id),
    );

    if (ids.some((id) => !allowed.has(id))) {
      throw new BadRequestException(
        'Payers and split participants must be active members of this group',
      );
    }
  }
}
