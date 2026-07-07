import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { withIdempotency } from './idempotency.helper';

function p2002(meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

describe('withIdempotency', () => {
  const mockTx = {
    idempotencyKey: {
      create: jest.fn(),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  };

  const mockPrisma = {
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(mockTx)),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('runs the operation directly when no idempotency key is provided', async () => {
    const fn = jest.fn().mockResolvedValue({ id: 'expense-1' });

    const result = await withIdempotency(
      mockPrisma as never,
      undefined,
      'user-1',
      'POST /groups/:id/expenses',
      fn,
    );

    expect(result).toEqual({ id: 'expense-1' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockTx.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('claims the key, runs the operation once, and stores the result', async () => {
    mockTx.idempotencyKey.create.mockResolvedValueOnce({});
    const fn = jest.fn().mockResolvedValue({ id: 'expense-1' });

    const result = await withIdempotency(
      mockPrisma as never,
      'key-abc',
      'user-1',
      'POST /groups/:id/expenses',
      fn,
    );

    expect(result).toEqual({ id: 'expense-1' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockTx.idempotencyKey.create).toHaveBeenCalledWith({
      data: {
        key: 'key-abc',
        userId: 'user-1',
        endpoint: 'POST /groups/:id/expenses',
        statusCode: 0,
        responseBody: Prisma.JsonNull,
      },
    });
    expect(mockTx.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'key-abc' },
      data: { statusCode: 201, responseBody: { id: 'expense-1' } },
    });
  });

  it('returns the cached response instead of re-running when the key was already completed', async () => {
    mockTx.idempotencyKey.create.mockRejectedValueOnce(p2002());
    mockTx.idempotencyKey.findUniqueOrThrow.mockResolvedValueOnce({
      key: 'key-abc',
      statusCode: 201,
      responseBody: { id: 'expense-1', cached: true },
    });
    const fn = jest.fn();

    const result = await withIdempotency(
      mockPrisma as never,
      'key-abc',
      'user-1',
      'POST /groups/:id/expenses',
      fn,
    );

    expect(result).toEqual({ id: 'expense-1', cached: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws ConflictException when the same key is still in flight', async () => {
    mockTx.idempotencyKey.create.mockRejectedValueOnce(p2002());
    mockTx.idempotencyKey.findUniqueOrThrow.mockResolvedValueOnce({
      key: 'key-abc',
      statusCode: 0,
      responseBody: null,
    });
    const fn = jest.fn();

    await expect(
      withIdempotency(
        mockPrisma as never,
        'key-abc',
        'user-1',
        'POST /groups/:id/expenses',
        fn,
      ),
    ).rejects.toThrow(ConflictException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rethrows unrelated database errors without swallowing them', async () => {
    const dbError = new Error('connection lost');
    mockTx.idempotencyKey.create.mockRejectedValueOnce(dbError);
    const fn = jest.fn();

    await expect(
      withIdempotency(
        mockPrisma as never,
        'key-abc',
        'user-1',
        'POST /groups/:id/expenses',
        fn,
      ),
    ).rejects.toThrow('connection lost');
    expect(fn).not.toHaveBeenCalled();
  });
});
