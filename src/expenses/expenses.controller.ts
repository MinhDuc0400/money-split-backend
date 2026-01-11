import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
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
  UserBalanceResponse,
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

  @Patch('expenses/:expenseId')
  @ApiOperation({ summary: 'Update an existing expense' })
  @ApiResponse({ status: 200, description: 'Expense updated successfully.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Expense not found.' })
  update(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
    @Req() req: Request,
    @Body() updateExpenseDto: UpdateExpenseDto,
  ): Promise<ExpenseResponse> {
    const userId = req.user!.id;
    return this.expensesService.updateExpense(
      groupId,
      expenseId,
      userId,
      updateExpenseDto,
    );
  }

  @Delete('expenses/:expenseId')
  @ApiOperation({ summary: 'Delete an expense' })
  @ApiResponse({ status: 204, description: 'Expense deleted successfully.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Expense not found.' })
  async remove(
    @Param('groupId') groupId: string,
    @Param('expenseId') expenseId: string,
    @Req() req: Request,
  ): Promise<void> {
    const userId = req.user!.id;
    await this.expensesService.deleteExpense(groupId, expenseId, userId);
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

  @Get('balances/me')
  @ApiOperation({ summary: 'Get specific balance of the calling user' })
  @ApiResponse({ status: 200, description: 'Return user balance.' })
  getMyBalance(
    @Param('groupId') groupId: string,
    @Req() req: Request,
  ): Promise<UserBalanceResponse> {
    const userId = req.user!.id;
    return this.expensesService.getUserBalance(groupId, userId);
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
