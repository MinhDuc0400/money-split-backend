import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BalancesService, BalanceSummary } from './balances.service';
import '../common/interfaces/request-user.interface';

@ApiTags('balances')
@ApiBearerAuth()
@Controller('balances')
@UseGuards(JwtAuthGuard)
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get total balance summary across all groups for the authenticated user',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns totalBalance, totalOwed, and totalOwing grouped by currency.',
    schema: {
      example: {
        byCurrency: {
          USD: {
            totalBalance: 50.0,
            totalOwed: 100.0,
            totalOwing: 50.0,
          },
        },
      },
    },
  })
  getSummary(@Req() req: Request): Promise<BalanceSummary> {
    return this.balancesService.getSummary(req.user!.id);
  }
}
