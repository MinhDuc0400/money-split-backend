import { SettlementStatus } from '@prisma/client';

/* =========================
   BALANCES
========================= */

export interface BalanceInfo {
  memberId: string;
  name: string;
  avatarUrl: string | null;
  balance: number;
}

export interface BalancesByCurrency {
  [currency: string]: BalanceInfo[];
}

export interface RecommendedSettlement {
  from: Participant;
  to: Participant;
  amount: number;
  currency: string;
}

/* =========================
   SHARED TYPES
========================= */

export interface Participant {
  memberId: string;
  amount?: number; // amount only exists for EXPENSE participants
  name?: string;
  avatarUrl: string | null;
}

/* =========================
   TRANSACTION HISTORY
========================= */

export interface ExpenseTransaction {
  id: string;
  type: 'EXPENSE';
  description: string;
  amount: number;
  currency: string;
  category: string;
  date: Date;

  payers: Participant[];
  receivers: Participant[];
}

export interface SettlementTransaction {
  id: string;
  type: 'SETTLEMENT';
  description?: string;
  amount: number;
  currency: string;
  date: Date;

  from: Participant;
  to: Participant;
  status: SettlementStatus;
}

export type TransactionHistoryItem = ExpenseTransaction | SettlementTransaction;

/* =========================
   RESPONSES
========================= */

export interface ExpenseResponse {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  splitType: string;
  category: string;
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

export interface PaginatedTransactionHistory {
  items: TransactionHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CategorySpending {
  category: string;
  totalCents: number;
}

export interface PersonSpending {
  memberId: string;
  name: string;
  totalCents: number;
}
