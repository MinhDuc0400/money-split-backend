import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettleUpDto } from './dto/settle-up.dto';
import { SettleAllDto } from './dto/settle-all.dto';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import {
  SettleUpResponse,
  SettlementResponse,
} from './types/settle-up-responses.type';
import { Prisma, SettlementStatus } from '@prisma/client';
import { toCents, fromCents } from '../helpers/number.helper';
import { updateDebtAtomic } from '../helpers/debt.helper';
import { withIdempotency } from '../helpers/idempotency.helper';
import { calculateMinimalTransfers } from './settlement.algo';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class SettlementsService {
  constructor(
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
  ) {}

  async createSettlement(
    groupId: string,
    userId: string,
    dto: CreateSettlementDto,
    idempotencyKey?: string,
  ): Promise<SettlementResponse> {
    // 1. Verify group membership of the calling user
    const caller = await this.prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId,
        },
      },
    });

    if (!caller || caller.deletedAt) {
      throw new ForbiddenException('You are not a member of this group');
    }

    const { fromId, toId, amount, currency = 'USD', note } = dto;

    if (fromId === toId) {
      throw new BadRequestException('Cannot settle with yourself');
    }

    return withIdempotency(
      this.prisma,
      idempotencyKey,
      userId,
      'POST /groups/:id/settlements',
      async (tx) => {
        // 2. Verify both members exist in the group
        const [fromMember, toMember] = await Promise.all([
          tx.groupMember.findUnique({ where: { id: fromId } }),
          tx.groupMember.findUnique({ where: { id: toId } }),
        ]);

        if (
          !fromMember ||
          fromMember.groupId !== groupId ||
          fromMember.deletedAt
        ) {
          throw new ForbiddenException('Payer is not a member of this group');
        }
        if (!toMember || toMember.groupId !== groupId || toMember.deletedAt) {
          throw new ForbiddenException(
            'Receiver is not a member of this group',
          );
        }

        // 3. Apply the settlement using internal logic
        const settlement = await this.applySettlementInternal(
          tx,
          groupId,
          fromId,
          toId,
          amount,
          currency,
          note,
        );

        const result = this.mapSettlementResponse(settlement);
        this.eventsGateway.emitSettlementUpdated(groupId, result);
        return result;
      },
    );
  }

  private async applySettlementInternal(
    tx: Prisma.TransactionClient,
    groupId: string,
    fromId: string,
    toId: string,
    amount: number,
    currency: string,
    note?: string,
  ) {
    // 1. Create the Settlement record
    const settlement = await tx.settlement.create({
      data: {
        groupId,
        fromId,
        toId,
        amount,
        currency,
        status: SettlementStatus.COMPLETED,
        note: note || 'Settlement',
      },
      include: {
        from: true,
        to: true,
      },
    });

    // 2. Update MemberBalances
    // Payer (fromId): balance increases (less negative or more positive)
    await tx.memberBalance.upsert({
      where: {
        groupId_memberId_currency: {
          groupId,
          memberId: fromId,
          currency,
        },
      },
      create: {
        groupId,
        memberId: fromId,
        currency,
        balance: amount,
      },
      update: { balance: { increment: amount } },
    });

    // Receiver (toId): balance decreases (less positive or more negative)
    await tx.memberBalance.upsert({
      where: {
        groupId_memberId_currency: {
          groupId,
          memberId: toId,
          currency,
        },
      },
      create: {
        groupId,
        memberId: toId,
        currency,
        balance: -amount,
      },
      update: { balance: { decrement: amount } },
    });

    // 3. Update Debt records (Reverse/Reduce debt)
    // If fromId pays toId, that's equivalent to toId now owing fromId
    // the paid amount (netted against any existing fromId->toId debt).
    await updateDebtAtomic(
      tx,
      groupId,
      toId,
      fromId,
      currency,
      toCents(amount),
    );

    return settlement;
  }

  private mapSettlementResponse(
    settlement: Prisma.SettlementGetPayload<{
      include: { from: true; to: true };
    }>,
  ): SettlementResponse {
    return {
      id: settlement.id,
      from: {
        memberId: settlement.fromId,
        name: settlement.from.name,
        avatarUrl: settlement.from.avatarUrl,
      },
      to: {
        memberId: settlement.toId,
        name: settlement.to.name,
        avatarUrl: settlement.to.avatarUrl,
      },
      amount: Number(settlement.amount),
      currency: settlement.currency,
      status: settlement.status,
      note: settlement.note,
      createdAt: settlement.createdAt,
    };
  }

  async settleUp(
    groupId: string,
    userId: string,
    dto: SettleUpDto,
    idempotencyKey?: string,
  ): Promise<SettleUpResponse> {
    // 1. Verify group membership
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

    const { currency } = dto;

    return withIdempotency(
      this.prisma,
      idempotencyKey,
      userId,
      'POST /groups/:id/settle-up',
      async (tx) => {
        // 2. Fetch all non-zero balances
        const balances = await tx.memberBalance.findMany({
          where: {
            groupId,
            currency: currency || undefined,
            balance: { not: 0 },
          },
          include: {
            member: true,
          },
        });

        if (balances.length === 0) {
          return { settlements: [] };
        }

        const createdSettlements: SettlementResponse[] = [];
        const currencies = [...new Set(balances.map((b) => b.currency))];

        for (const curr of currencies) {
          const currBalances = balances.filter((b) => b.currency === curr);

          // 3. Build BalanceInput (CENTS, immutable)
          const balanceInputs = currBalances.map((b) => ({
            memberId: b.memberId,
            amountCents: toCents(Number(b.balance)),
          }));

          // 4. Calculate minimal transfers (PURE function)
          const transfers = calculateMinimalTransfers(balanceInputs);

          // 5. Apply each transfer via internal settlement logic
          for (const t of transfers) {
            const settlement = await this.applySettlementInternal(
              tx,
              groupId,
              t.fromId,
              t.toId,
              fromCents(t.amountCents),
              curr,
              'Automatic Settle Up',
            );

            createdSettlements.push(this.mapSettlementResponse(settlement));
          }
        }

        for (const s of createdSettlements) {
          this.eventsGateway.emitSettlementUpdated(groupId, s);
        }
        return { settlements: createdSettlements };
      },
    );
  }

  async settleAll(
    groupId: string,
    userId: string,
    dto: SettleAllDto,
    idempotencyKey?: string,
  ): Promise<SettleUpResponse> {
    // 1. Verify group membership
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

    const { fromId, toId, items } = dto;

    return withIdempotency(
      this.prisma,
      idempotencyKey,
      userId,
      'POST /groups/:id/settlements/settle-all',
      async (tx) => {
        // 2. Verify both members exist in the group (abort the whole batch
        // up-front, consistent with createSettlement's validation).
        const [fromMember, toMember] = await Promise.all([
          tx.groupMember.findUnique({ where: { id: fromId } }),
          tx.groupMember.findUnique({ where: { id: toId } }),
        ]);

        if (
          !fromMember ||
          fromMember.groupId !== groupId ||
          fromMember.deletedAt
        ) {
          throw new ForbiddenException('Payer is not a member of this group');
        }
        if (!toMember || toMember.groupId !== groupId || toMember.deletedAt) {
          throw new ForbiddenException(
            'Receiver is not a member of this group',
          );
        }

        // 3. Reject the whole batch up-front if the client sent the same
        // currency more than once - applying it twice would double-settle
        // the same debt in a single request.
        const currencies = [...new Set(items.map((i) => i.currency))];
        if (currencies.length !== items.length) {
          throw new BadRequestException(
            'Duplicate currency in settle-all request',
          );
        }

        // 4. Fetch current balances for exactly the claimed currencies
        const balances = await tx.memberBalance.findMany({
          where: {
            groupId,
            currency: { in: currencies },
            balance: { not: 0 },
          },
          include: {
            member: true,
          },
        });

        // 5. Validate every (currency, amount) pair against the current
        // computed balance BEFORE applying any of them. If any single
        // currency no longer matches, abort the whole batch.
        const validated: Array<{ currency: string; amountCents: number }> =
          [];

        for (const item of items) {
          const currBalances = balances.filter(
            (b) => b.currency === item.currency,
          );

          const balanceInputs = currBalances.map((b) => ({
            memberId: b.memberId,
            amountCents: toCents(Number(b.balance)),
          }));

          const transfers = calculateMinimalTransfers(balanceInputs);
          const matchingTransfer = transfers.find(
            (t) => t.fromId === fromId && t.toId === toId,
          );

          if (!matchingTransfer) {
            throw new BadRequestException(
              `No current ${item.currency} balance to settle between these members. Your balances changed - refresh and try again.`,
            );
          }

          const currentAmount = fromCents(matchingTransfer.amountCents);
          if (Math.abs(currentAmount - item.amount) > 0.005) {
            throw new BadRequestException(
              `The ${item.currency} amount changed. Your balances changed - refresh and try again.`,
            );
          }

          validated.push({
            currency: item.currency,
            amountCents: matchingTransfer.amountCents,
          });
        }

        // 6. Only now, after every currency has been validated, apply each
        // settlement using the EXACT existing amount (never rounded or
        // converted).
        const createdSettlements: SettlementResponse[] = [];

        for (const { currency, amountCents } of validated) {
          const settlement = await this.applySettlementInternal(
            tx,
            groupId,
            fromId,
            toId,
            fromCents(amountCents),
            currency,
            'Settle All',
          );

          createdSettlements.push(this.mapSettlementResponse(settlement));
        }

        for (const s of createdSettlements) {
          this.eventsGateway.emitSettlementUpdated(groupId, s);
        }

        return { settlements: createdSettlements };
      },
    );
  }
}
