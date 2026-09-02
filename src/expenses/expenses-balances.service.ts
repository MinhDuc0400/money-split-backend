import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GroupMembershipService } from './group-membership.service';
import {
  BalancesByCurrency,
  RecommendedSettlement,
  UserBalanceResponse,
} from './types/expense-responses.type';
import { fromCents, toCents } from '../helpers/number.helper';

@Injectable()
export class ExpensesBalancesService {
  constructor(
    private prisma: PrismaService,
    private groupMembership: GroupMembershipService,
  ) {}

  async getBalances(
    groupId: string,
    userId: string,
  ): Promise<BalancesByCurrency> {
    // Verify membership
    await this.groupMembership.assertActiveMember(groupId, userId);

    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });

    const memberBalances = await this.prisma.memberBalance.findMany({
      where: { groupId },
    });

    const balancesByCurrency: BalancesByCurrency = {};
    const memberMap = new Map(members.map((m) => [m.id, m]));

    // Group balances by currency
    memberBalances.forEach((mb) => {
      const currency = mb.currency;
      if (!balancesByCurrency[currency]) {
        balancesByCurrency[currency] = [];
      }

      const m = memberMap.get(mb.memberId);
      if (m && !m.deletedAt) {
        balancesByCurrency[currency].push({
          memberId: mb.memberId,
          name: m.name,
          avatarUrl: m.avatarUrl,
          balance: Number(mb.balance),
        });
      }
    });

    // Ensure all members are included in each currency if they have no balance record yet
    const currencies = Object.keys(balancesByCurrency);
    currencies.forEach((currency) => {
      const presentMemberIds = new Set(
        balancesByCurrency[currency].map((b) => b.memberId),
      );
      members.forEach((m) => {
        if (!presentMemberIds.has(m.id)) {
          balancesByCurrency[currency].push({
            memberId: m.id,
            name: m.name,
            avatarUrl: m.avatarUrl,
            balance: 0,
          });
        }
      });
    });

    return balancesByCurrency;
  }

  async getUserBalance(
    groupId: string,
    userId: string,
  ): Promise<UserBalanceResponse> {
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, deletedAt: null },
    });
    const currentUserMember = members.find((m) => m.userId === userId);

    if (!currentUserMember) {
      throw new ForbiddenException('You are not a member of this group');
    }

    // Read from MemberBalance — the authoritative net balance per member,
    // updated atomically by both expense creation and settlements.
    // The Debt table tracks the payment graph but can drift from net balances
    // when minimal-transfer settlements don't perfectly map to raw debt rows.
    const memberBalances = await this.prisma.memberBalance.findMany({
      where: { groupId, memberId: currentUserMember.id },
    });

    const response: UserBalanceResponse = { balances: {} };

    for (const mb of memberBalances) {
      const net = Number(mb.balance);
      const totalOwed = net > 0 ? net : 0;
      const totalOwe = net < 0 ? Math.abs(net) : 0;

      // Report every currency the member has a balance row for, including
      // an exact 0/0 (fully settled). Omitting settled currencies makes
      // this response indistinguishable from "not fetched yet" to callers
      // that check for an empty object as a loading proxy.
      response.balances[mb.currency] = {
        totalOwed,
        totalOwe,
        details: [],
      };
    }

    return response;
  }

  async getSettlements(
    groupId: string,
    userId: string,
  ): Promise<RecommendedSettlement[]> {
    const balancesByCurrency = await this.getBalances(groupId, userId);
    const allSettlements: RecommendedSettlement[] = [];

    Object.entries(balancesByCurrency).forEach(([currency, balances]) => {
      const debtors: {
        id: string;
        name: string;
        avatarUrl: string | null;
        amountCents: number;
      }[] = [];
      const creditors: {
        id: string;
        name: string;
        avatarUrl: string | null;
        amountCents: number;
      }[] = [];

      balances.forEach((b) => {
        const cents = toCents(b.balance);
        if (cents < 0)
          debtors.push({
            id: b.memberId,
            name: b.name,
            avatarUrl: b.avatarUrl,
            amountCents: cents,
          });
        if (cents > 0)
          creditors.push({
            id: b.memberId,
            name: b.name,
            avatarUrl: b.avatarUrl,
            amountCents: cents,
          });
      });

      // debtors have negative balance, meaning they owe money.
      // creditors have positive balance, meaning they are owed money.
      // Math.abs(debtor.amountCents) is what they owe.

      debtors.sort((a, b) => a.amountCents - b.amountCents); // biggest debtors first (most negative)
      creditors.sort((a, b) => b.amountCents - a.amountCents); // biggest creditors first

      let i = 0;
      let j = 0;

      while (i < debtors.length && j < creditors.length) {
        const d = debtors[i];
        const c = creditors[j];
        const settleAmountCents = Math.min(
          Math.abs(d.amountCents),
          c.amountCents,
        );

        if (settleAmountCents > 0) {
          allSettlements.push({
            from: {
              memberId: d.id,
              name: d.name,
              avatarUrl: d.avatarUrl,
            },
            to: {
              memberId: c.id,
              name: c.name,
              avatarUrl: c.avatarUrl,
            },
            amount: fromCents(settleAmountCents),
            currency,
          });
        }

        d.amountCents += settleAmountCents;
        c.amountCents -= settleAmountCents;

        if (d.amountCents === 0) i++;
        if (c.amountCents === 0) j++;
      }
    });

    return allSettlements;
  }
}
