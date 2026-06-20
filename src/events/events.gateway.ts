import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173' },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token ?? '');
      client.data.userId = payload.sub;
      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
    } catch {
      this.logger.warn(`Client ${client.id} rejected — invalid token`);
      void client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Client joins a group room to receive group-scoped events */
  @SubscribeMessage('join_group')
  async handleJoinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { groupId: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { error: 'unauthorized' };

    const member = await this.prisma.groupMember.findFirst({
      where: { groupId: payload.groupId, userId, deletedAt: null },
    });

    if (!member) {
      this.logger.warn(
        `Client ${client.id} denied join to group:${payload.groupId} — not a member`,
      );
      return { error: 'forbidden' };
    }

    void client.join(`group:${payload.groupId}`);
    this.logger.log(`Client ${client.id} joined group:${payload.groupId}`);
    return { event: 'joined', data: payload.groupId };
  }

  @SubscribeMessage('leave_group')
  handleLeaveGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { groupId: string },
  ) {
    void client.leave(`group:${payload.groupId}`);
    this.logger.log(`Client ${client.id} left group:${payload.groupId}`);
  }

  // ── Emit helpers called by services ──────────────────────────────

  emitExpenseCreated(groupId: string, expense: unknown) {
    this.server.to(`group:${groupId}`).emit('expense_created', expense);
  }

  emitExpenseUpdated(groupId: string, expense: unknown) {
    this.server.to(`group:${groupId}`).emit('expense_updated', expense);
  }

  emitExpenseDeleted(groupId: string, expenseId: string) {
    this.server.to(`group:${groupId}`).emit('expense_deleted', { expenseId });
  }

  emitSettlementUpdated(groupId: string, settlement: unknown) {
    this.server.to(`group:${groupId}`).emit('settlement_updated', settlement);
  }

  emitMemberJoined(groupId: string, member: unknown) {
    this.server.to(`group:${groupId}`).emit('member_joined', member);
  }

  emitGroupUpdated(groupId: string, group: unknown) {
    this.server.to(`group:${groupId}`).emit('group_updated', group);
  }
}
