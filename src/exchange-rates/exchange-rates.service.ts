import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CachedRates {
  base: string;
  date: string | null;
  rates: Record<string, number>;
  stale: boolean;
}

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class ExchangeRatesService {
  private readonly logger = new Logger(ExchangeRatesService.name);

  constructor(private prisma: PrismaService) {}

  /** Fetches today's rates from the live API and upserts them into the cache. */
  async refreshRates(baseCurrency: string): Promise<void> {
    const response = await fetch(
      `https://open.er-api.com/v6/latest/${baseCurrency}`,
    );

    if (!response.ok) {
      throw new Error(
        `Exchange rate API request failed with status ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      result: string;
      rates?: Record<string, number>;
    };

    if (data.result !== 'success' || !data.rates) {
      throw new Error('Exchange rate API returned an error result');
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (const [targetCurrency, rate] of Object.entries(data.rates)) {
      await this.prisma.exchangeRate.upsert({
        where: {
          baseCurrency_targetCurrency_date: {
            baseCurrency,
            targetCurrency,
            date: today,
          },
        },
        create: {
          baseCurrency,
          targetCurrency,
          rate,
          date: today,
        },
        update: { rate },
      });
    }
  }

  /** Reads from the cache only. Never calls the live API. */
  async getCachedRates(baseCurrency: string): Promise<CachedRates> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: { baseCurrency },
      orderBy: { date: 'desc' },
    });

    if (rows.length === 0) {
      return { base: baseCurrency, date: null, rates: {}, stale: true };
    }

    const mostRecentDate = rows[0].date;
    const rates: Record<string, number> = {};
    for (const row of rows) {
      if (row.date.getTime() === mostRecentDate.getTime()) {
        rates[row.targetCurrency] = Number(row.rate);
      }
    }

    const stale = Date.now() - mostRecentDate.getTime() > STALE_AFTER_MS;

    return {
      base: baseCurrency,
      date: mostRecentDate.toISOString(),
      rates,
      stale,
    };
  }
}
