/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { db } from '../db/drizzle';
import { goalMembers } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface GoalUpdatedPayload {
  goalId: string;
  currentValue: string;
  userName: string;
  amount: number;
  action: 'created' | 'updated' | 'deleted';
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/goals',
})
export class GoalsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization?.split(' ')[1] as string);

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });

      const userId: string = payload.sub;
      client.data.userId = userId;

      // Entra nas salas de todas as metas que o usuário participa
      const memberships = await db
        .select({ goalId: goalMembers.goalId })
        .from(goalMembers)
        .where(eq(goalMembers.userId, userId));

      for (const m of memberships) {
        await client.join(`goal:${m.goalId}`);
      }

      console.log(
        `[WS] Usuário ${userId} conectado — ${memberships.length} sala(s)`,
      );
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    console.log(`[WS] Usuário ${client.data?.userId || '?'} desconectou`);
  }

  /**
   * Notifica todos os membros de uma meta que houve uma atualização.
   * Chamado pelo TransactionsService após create/update/delete de investimento.
   */
  notifyGoalUpdated(payload: GoalUpdatedPayload) {
    this.server.to(`goal:${payload.goalId}`).emit('goal:updated', payload);
  }

  /**
   * Adiciona um usuário conectado a uma nova sala de meta
   * (quando um membro é adicionado a uma meta em runtime).
   */
  async joinGoalRoom(userId: string, goalId: string) {
    const sockets = await this.server.fetchSockets();
    for (const socket of sockets) {
      if (socket.data.userId === userId) {
        await socket.join(`goal:${goalId}`);
      }
    }
  }
}
