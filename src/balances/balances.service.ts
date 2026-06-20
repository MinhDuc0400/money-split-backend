import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
export interface CurrencyBalance {
  totalBalance: number;
  totalOwed: number;
  totalOwing: number;
}

export interface BalanceSummary {
  byCurrency: Record<string, CurrencyBalance>;
}

@Injectable()
export class BalancesService {
  constructor(private prisma: PrismaService) {}

  async getSummary(userId: string): Promise<BalanceSummary> {
    const memberBalances = await this.prisma.memberBalance.findMany({
      where: {
        member: {
          userId,
          deletedAt: null,
        },
        group: {
          deletedAt: null,
        },
      },
      select: {
        balance: true,
        currency: true,
      },
    });

    const byCurrency: Record<string, CurrencyBalance> = {};

    for (const { balance, currency } of memberBalances) {
      if (!byCurrency[currency]) {
        byCurrency[currency] = { totalBalance: 0, totalOwed: 0, totalOwing: 0 };
      }

      const amount = Number(balance);
      byCurrency[currency].totalBalance += amount;

      if (amount > 0) {
        byCurrency[currency].totalOwed += amount;
      } else if (amount < 0) {
        byCurrency[currency].totalOwing += Math.abs(amount);
      }
    }

    // Round to 2 decimal places
    for (const currency of Object.keys(byCurrency)) {
      const entry = byCurrency[currency];
      entry.totalBalance = Math.round(entry.totalBalance * 100) / 100;
      entry.totalOwed = Math.round(entry.totalOwed * 100) / 100;
      entry.totalOwing = Math.round(entry.totalOwing * 100) / 100;
    }

    return { byCurrency };
  }
}
