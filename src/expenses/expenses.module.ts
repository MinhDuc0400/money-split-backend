import { Module } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { GroupMembershipService } from './group-membership.service';
import { ExpensesBalancesService } from './expenses-balances.service';
import { ExpensesAnalyticsService } from './expenses-analytics.service';

@Module({
  imports: [PrismaModule, EventsModule],
  controllers: [ExpensesController],
  providers: [
    ExpensesService,
    GroupMembershipService,
    ExpensesBalancesService,
    ExpensesAnalyticsService,
  ],
  exports: [ExpensesService],
})
export class ExpensesModule {}
