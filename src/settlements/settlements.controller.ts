import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import { SettleUpDto } from './dto/settle-up.dto';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { SettleUpResponse, SettlementResponse } from './types/settle-up-responses.type';
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
  ): Promise<SettleUpResponse> {
    const userId = req.user!.id;
    return this.settlementsService.settleUp(groupId, userId, settleUpDto);
  }

  @Post('settlements')
  @ApiOperation({ summary: 'Create an individual settlement between two members' })
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
  ): Promise<SettlementResponse> {
    const userId = req.user!.id;
    return this.settlementsService.createSettlement(groupId, userId, dto);
  }
}
