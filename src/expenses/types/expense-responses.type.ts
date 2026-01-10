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
  description?: string;
  amount: number;
  currency: string;
  date: Date;
  // For EXPENSE
  payers?: {
    memberId: string;
    amount: number;
    name?: string;
    avatarUrl: string | null;
  }[];

  receivers?: {
    memberId: string;
    amount: number;
    name?: string;
    avatarUrl: string | null;
  }[];

  // For SETTLEMENT
  from?: {
    memberId: string;
    name?: string;
    avatarUrl: string | null;
  };
  to?: {
    memberId: string;
    name?: string;
    avatarUrl: string | null;
  };
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

export interface UserBalanceResponse {
  balances: {
    [currency: string]: {
      totalOwed: number; // how much he is owed
      totalOwe: number; // how much he owes
      details: {
        memberId: string;
        name: string;
        avatarUrl: string | null;
        amount: number; // positive: they owe user, negative: user owes them
      }[];
    };
  };
}

export interface GroupedTransactionHistory {
  [monthYear: string]: TransactionHistoryItem[];
}
