import { SettlementStatus } from '@prisma/client';

export interface BalanceMap {
  [memberId: string]: number;
}

export interface BalancesByCurrency {
  [currency: string]: BalanceMap;
}

export interface RecommendedSettlement {
  from: string;
  to: string;
  amount: number;
  currency: string;
}

export interface TransactionHistoryItem {
  id: string;
  type: 'EXPENSE' | 'SETTLEMENT';
  description: string;
  amount: number;
  currency: string;
  date: Date;
  // For EXPENSE
  payers?: {
    memberId: string;
    amount: number;
    name?: string;
  }[];
  // For SETTLEMENT
  fromId?: string;
  toId?: string;
  status?: SettlementStatus;
}

export interface ExpenseResponse {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  splitType: string;
  currency: string;
  date: Date;
  payers: {
    memberId: string;
    amount: number;
    name?: string;
  }[];
  splits: {
    memberId: string;
    amount: number;
    share?: number | null;
    percentage?: number | null;
  }[];
}

export interface GroupedTransactionHistory {
  [monthYear: string]: TransactionHistoryItem[];
}
