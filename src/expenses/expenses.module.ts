import { Module } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { GroupMembershipService } from './group-membership.service';

@Module({
  imports: [PrismaModule, EventsModule],
  controllers: [ExpensesController],
  providers: [ExpensesService, GroupMembershipService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
