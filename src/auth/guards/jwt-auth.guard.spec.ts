import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

describe('JwtAuthGuard', () => {
  const buildContext = (): ExecutionContext => {
    const handler = () => undefined;
    const klass = () => undefined;
    return {
      getHandler: () => handler,
      getClass: () => klass,
    } as unknown as ExecutionContext;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true immediately, without invoking the Passport check, when the route is marked @Public()', () => {
    const getAllAndOverride = jest.fn().mockReturnValue(true);
    const reflector = { getAllAndOverride } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const passportCanActivate = jest.spyOn(
      Object.getPrototypeOf(JwtAuthGuard.prototype) as {
        canActivate: (...args: unknown[]) => unknown;
      },
      'canActivate',
    );

    const context = buildContext();
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('delegates to the default Passport JWT check when the route is not marked @Public()', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);
    const passportCanActivate = jest
      .spyOn(
        Object.getPrototypeOf(JwtAuthGuard.prototype) as {
          canActivate: (...args: unknown[]) => unknown;
        },
        'canActivate',
      )
      .mockReturnValue(true);

    const context = buildContext();
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(passportCanActivate).toHaveBeenCalledWith(context);
  });
});
