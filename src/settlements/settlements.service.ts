import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettleUpDto } from './dto/settle-up.dto';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import {
  SettleUpResponse,
  SettlementResponse,
} from './types/settle-up-responses.type';
import { Prisma, SettlementStatus } from '@prisma/client';
import { toCents, fromCents } from '../helpers/number.helper';
import { calculateMinimalTransfers } from './settlement.algo';

@Injectable()
export class SettlementsService {
  constructor(private prisma: PrismaService) { }

  async createSettlement(
    groupId: string,
    userId: string,
    dto: CreateSettlementDto,
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

    return this.prisma.$transaction(async (tx) => {
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
        throw new BadRequestException('Payer is not a member of this group');
      }
      if (!toMember || toMember.groupId !== groupId || toMember.deletedAt) {
        throw new BadRequestException('Receiver is not a member of this group');
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

      return this.mapSettlementResponse(settlement);
    });
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
    // If fromId pays toId, we reduce the debt fromId owes to toId.
    await this.updateDebtAtomic(
      tx,
      groupId,
      fromId,
      toId,
      currency,
      toCents(amount),
    );

    return settlement;
  }

  private mapSettlementResponse(settlement: Prisma.SettlementGetPayload<{
    include: { from: true; to: true }
  }>): SettlementResponse {
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

  private async updateDebtAtomic(
    tx: Prisma.TransactionClient,
    groupId: string,
    debtorId: string,
    creditorId: string,
    currency: string,
    amountCents: number,
  ) {
    // Logic: debtorId pays creditorId 'amountCents'.
    // We should first reduce any existing debt where debtorId owes creditorId.
    // If there's surplus payment, it creates a "reverse" debt (creditorId owes debtorId).

    // 1. Check existing debt (debtorId owes creditorId)
    const existingDebt = await tx.debt.findUnique({
      where: {
        groupId_debtorId_creditorId_currency: {
          groupId,
          debtorId,
          creditorId,
          currency,
        },
      },
    });

    let remainingPaymentCents = amountCents;

    if (existingDebt) {
      const existingDebtCents = toCents(Number(existingDebt.amount));
      if (existingDebtCents >= remainingPaymentCents) {
        // Payment is less than or equal to existing debt
        const updatedDebtCents = existingDebtCents - remainingPaymentCents;
        if (updatedDebtCents === 0) {
          await tx.debt.delete({ where: { id: existingDebt.id } });
        } else {
          await tx.debt.update({
            where: { id: existingDebt.id },
            data: { amount: fromCents(updatedDebtCents) },
          });
        }
        remainingPaymentCents = 0;
      } else {
        // Payment exceeds existing debt
        await tx.debt.delete({ where: { id: existingDebt.id } });
        remainingPaymentCents -= existingDebtCents;
      }
    }

    if (remainingPaymentCents > 0) {
      // Create/Increase reverse debt (creditorId owes debtorId)
      const amount = fromCents(remainingPaymentCents);
      await tx.debt.upsert({
        where: {
          groupId_debtorId_creditorId_currency: {
            groupId,
            debtorId: creditorId,
            creditorId: debtorId,
            currency,
          },
        },
        create: {
          groupId,
          debtorId: creditorId,
          creditorId: debtorId,
          currency,
          amount,
        },
        update: {
          amount: { increment: amount },
        },
      });
    }
  }

  async settleUp(
    groupId: string,
    userId: string,
    dto: SettleUpDto,
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

    return this.prisma.$transaction(async (tx) => {
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

          createdSettlements.push(
            this.mapSettlementResponse(settlement),
          );
        }
      }

      return { settlements: createdSettlements };
    });
  }
}
