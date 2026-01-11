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
