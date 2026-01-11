import { Participant } from '../../expenses/types/expense-responses.type';
import { SettlementStatus } from '@prisma/client';

export interface SettlementResponse {
  id: string;
  from: Participant;
  to: Participant;
  amount: number;
  currency: string;
  status: SettlementStatus;
  note?: string | null;
  createdAt: Date;
}

export interface SettleUpResponse {
  settlements: SettlementResponse[];
}
