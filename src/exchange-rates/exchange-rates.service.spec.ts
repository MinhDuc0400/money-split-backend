import { Test, TestingModule } from '@nestjs/testing';
import { ExchangeRatesService } from './exchange-rates.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ExchangeRatesService', () => {
  let service: ExchangeRatesService;

  const mockPrisma = {
    exchangeRate: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const originalFetch = global.fetch;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ExchangeRatesService>(ExchangeRatesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
  });

  describe('refreshRates', () => {
    it('fetches the live API and upserts one row per currency for today', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: 'success',
          base_code: 'USD',
          rates: { EUR: 0.92, VND: 25400, GBP: 0.79 },
        }),
      }) as unknown as typeof fetch;

      await service.refreshRates('USD');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://open.er-api.com/v6/latest/USD',
      );
      expect(mockPrisma.exchangeRate.upsert).toHaveBeenCalledTimes(3);
      expect(mockPrisma.exchangeRate.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            baseCurrency_targetCurrency_date: expect.objectContaining({
              baseCurrency: 'USD',
              targetCurrency: 'EUR',
            }),
          }),
          create: expect.objectContaining({
            baseCurrency: 'USD',
            targetCurrency: 'EUR',
            rate: 0.92,
          }),
        }),
      );
    });

    it('throws if the live API responds with a non-success result', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'error' }),
      }) as unknown as typeof fetch;

      await expect(service.refreshRates('USD')).rejects.toThrow(
        'Exchange rate API returned an error result',
      );
      expect(mockPrisma.exchangeRate.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getCachedRates', () => {
    it('returns cached rates as a flat map, not stale when dated today', async () => {
      const today = new Date();
      mockPrisma.exchangeRate.findMany.mockResolvedValueOnce([
        { targetCurrency: 'EUR', rate: 0.92, date: today },
        { targetCurrency: 'VND', rate: 25400, date: today },
      ]);

      const result = await service.getCachedRates('USD');

      expect(result.base).toBe('USD');
      expect(result.rates).toEqual({ EUR: 0.92, VND: 25400 });
      expect(result.stale).toBe(false);
    });

    it('flags the result as stale when the cached date is more than 48 hours old', async () => {
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
      mockPrisma.exchangeRate.findMany.mockResolvedValueOnce([
        { targetCurrency: 'EUR', rate: 0.92, date: threeDaysAgo },
      ]);

      const result = await service.getCachedRates('USD');

      expect(result.stale).toBe(true);
    });

    it('returns an empty rates map with stale=true when nothing is cached yet', async () => {
      mockPrisma.exchangeRate.findMany.mockResolvedValueOnce([]);

      const result = await service.getCachedRates('USD');

      expect(result.rates).toEqual({});
      expect(result.stale).toBe(true);
    });
  });
});
