import { Prisma } from '@prisma/client';

export type ExpenseWithRelations = Prisma.ExpenseGetPayload<{
  include: {
    payers: {
      include: {
        member: true;
      };
    };
    splits: {
      include: {
        member: true;
      };
    };
  };
}>;

export interface DebtFlow {
  debtorId: string;
  creditorId: string;
  amountCents: number;
}

export interface SplitInput {
  memberId: string;
  amount?: number;
  share?: number;
  percentage?: number;
}

export interface SplitData {
  memberId: string;
  amountCents: number;
  share?: number;
  percentage?: number;
}
