import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import { SettleUpDto } from './dto/settle-up.dto';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { SettleAllDto } from './dto/settle-all.dto';
import {
  SettleUpResponse,
  SettlementResponse,
} from './types/settle-up-responses.type';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request } from 'express';
import '../common/interfaces/request-user.interface';

@ApiTags('settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('groups/:groupId')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  @Post('settle-up')
  @ApiOperation({ summary: 'Settle up all debts in a group' })
  @ApiResponse({
    status: 201,
    description: 'Settlements created successfully, balances zeroed out.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  settleUp(
    @Param('groupId') groupId: string,
    @Req() req: Request,
    @Body() settleUpDto: SettleUpDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SettleUpResponse> {
    const userId = req.user!.id;
    return this.settlementsService.settleUp(
      groupId,
      userId,
      settleUpDto,
      idempotencyKey,
    );
  }

  @Post('settlements')
  @ApiOperation({
    summary: 'Create an individual settlement between two members',
  })
  @ApiResponse({
    status: 201,
    description: 'Settlement created successfully.',
  })
  @ApiResponse({ status: 400, description: 'Bad request.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  createSettlement(
    @Param('groupId') groupId: string,
    @Req() req: Request,
    @Body() dto: CreateSettlementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SettlementResponse> {
    const userId = req.user!.id;
    return this.settlementsService.createSettlement(
      groupId,
      userId,
      dto,
      idempotencyKey,
    );
  }

  @Post('settlements/settle-all')
  @ApiOperation({
    summary:
      'Settle every currency a specific pair of members owe each other in one batch',
  })
  @ApiResponse({
    status: 201,
    description: 'All matched currencies settled successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Missing Idempotency-Key header, or balances changed since the client last fetched them.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  settleAll(
    @Param('groupId') groupId: string,
    @Req() req: Request,
    @Body() dto: SettleAllDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SettleUpResponse> {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency-Key header is required for this endpoint',
      );
    }
    const userId = req.user!.id;
    return this.settlementsService.settleAll(
      groupId,
      userId,
      dto,
      idempotencyKey,
    );
  }
}
