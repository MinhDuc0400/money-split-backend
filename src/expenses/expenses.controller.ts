import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import {
  BalancesByCurrency,
  ExpenseResponse,
  GroupedTransactionHistory,
  RecommendedSettlement,
} from './types/expense-responses.type';
import type { Request } from 'express';
import '../common/interfaces/request-user.interface';

@ApiTags('expenses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('groups/:groupId')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post('expenses')
  @ApiOperation({ summary: 'Create a new expense in a group' })
  @ApiResponse({ status: 201, description: 'Expense created successfully.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  create(
    @Param('groupId') groupId: string,
    @Req() req: Request,
    @Body() createExpenseDto: CreateExpenseDto,
  ): Promise<ExpenseResponse> {
    const userId = req.user!.id;
    return this.expensesService.create(groupId, userId, createExpenseDto);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get transaction history of a group' })
  @ApiResponse({ status: 200, description: 'Return all transactions.' })
  getTransactions(
    @Param('groupId') groupId: string,
    @Req() req: Request,
  ): Promise<GroupedTransactionHistory> {
    const userId = req.user!.id;
    return this.expensesService.getGroupTransactions(groupId, userId);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Get balances of all members in a group' })
  @ApiResponse({ status: 200, description: 'Return balances by currency.' })
  getBalances(
    @Param('groupId') groupId: string,
    @Req() req: Request,
  ): Promise<BalancesByCurrency> {
    const userId = req.user!.id;
    return this.expensesService.getBalances(groupId, userId);
  }

  @Get('settlements')
  @ApiOperation({ summary: 'Get recommended settlements to balance the group' })
  @ApiResponse({ status: 200, description: 'Return recommended settlements.' })
  getSettlements(
    @Param('groupId') groupId: string,
    @Req() req: Request,
  ): Promise<RecommendedSettlement[]> {
    const userId = req.user!.id;
    return this.expensesService.getSettlements(groupId, userId);
  }
}
