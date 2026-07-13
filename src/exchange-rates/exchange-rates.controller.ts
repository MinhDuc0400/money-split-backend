import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ExchangeRatesService, CachedRates } from './exchange-rates.service';

@ApiTags('exchange-rates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly exchangeRatesService: ExchangeRatesService) {}

  @Get()
  @ApiOperation({ summary: 'Get today\'s cached exchange rates for a base currency' })
  getRates(@Query('base') base = 'USD'): Promise<CachedRates> {
    return this.exchangeRatesService.getCachedRates(base.toUpperCase());
  }
}
