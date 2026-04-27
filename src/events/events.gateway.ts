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
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*' }, // tighten in production
  namespace: '/events',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      this.logger.warn(`Client ${client.id} disconnected — no token`);
      void client.disconnect();
    } else {
      this.logger.log(`Client connected: ${client.id}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Client joins a group room to receive group-scoped events */
  @SubscribeMessage('join_group')
  handleJoinGroup(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { groupId: string },
  ) {
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
