import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';
import * as jwt from 'jsonwebtoken';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const client: Socket = context.switchToWs().getClient<Socket>();
    const token = client.handshake?.auth?.token as string | undefined;
    if (!token) throw new WsException('Unauthorized');

    try {
      const secret = this.configService.get<string>('JWT_SECRET')!;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      client.data.user = jwt.verify(token, secret);
      return true;
    } catch {
      throw new WsException('Unauthorized');
    }
  }
}
