import { SplitType } from '@prisma/client';

export interface SplitResult {
  memberId: string;
  amount: number;
  share?: number;
  percentage?: number;
}

export interface PayerData {
  memberId: string;
  amount: number;
}

export interface ExpenseCalculationInput {
  totalAmount: number;
  splitType: SplitType;
  splits: {
    memberId: string;
    amount?: number;
    share?: number;
    percentage?: number;
  }[];
}
