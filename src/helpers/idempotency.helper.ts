import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wraps a mutation in an idempotency-key claim so a retried or
 * double-submitted request (network timeout, double-click) replays the
 * original response instead of re-executing the mutation. Pass the
 * client-supplied `Idempotency-Key` header value; if undefined, the
 * operation just runs directly with no protection (callers that don't
 * send the header get today's behavior, not an error).
 */
export async function withIdempotency<T>(
  prisma: PrismaService,
  idempotencyKey: string | undefined,
  userId: string,
  endpoint: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!idempotencyKey) {
    return prisma.$transaction(fn);
  }

  return prisma.$transaction(async (tx) => {
    try {
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          userId,
          endpoint,
          statusCode: 0,
          responseBody: Prisma.JsonNull,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await tx.idempotencyKey.findUniqueOrThrow({
          where: { key: idempotencyKey },
        });
        if (existing.statusCode !== 0) {
          return existing.responseBody as T;
        }
        throw new ConflictException('This request is already being processed');
      }
      throw err;
    }

    const result = await fn(tx);

    await tx.idempotencyKey.update({
      where: { key: idempotencyKey },
      data: {
        statusCode: 201,
        responseBody: result as Prisma.InputJsonValue,
      },
    });

    return result;
  });
}
