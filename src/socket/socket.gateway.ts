import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SocketService } from './socket.service';

interface AuthenticatedSocket extends Socket {
  data: {
    user?: {
      id: string;
      email: string;
      role: string;
      department_id?: string;
      full_name?: string;
    };
  };
}

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/',
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SocketGateway.name);
  private connectedClients = new Map<string, AuthenticatedSocket>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly socketService: SocketService,
  ) {}

  afterInit(server: Server) {
    this.socketService.setServer(server);
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      // Validate token using Supabase
      const {
        data: { user },
        error,
      } = await this.supabaseService.db.auth.getUser(token);

      if (error || !user) {
        this.logger.warn(`Client ${client.id} has invalid token`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }

      // Get user profile with role
      const { data: profile } = await this.supabaseService.db
        .from('profiles')
        .select('id, email, full_name, role, department_id')
        .eq('id', user.id)
        .single();

      if (!profile) {
        this.logger.warn(`No profile found for user ${user.id}`);
        client.emit('error', { message: 'User profile not found' });
        client.disconnect();
        return;
      }

      // Store user data in socket
      client.data.user = {
        id: profile.id,
        email: profile.email,
        role: profile.role,
        department_id: profile.department_id,
        full_name: profile.full_name,
      };

      // Join user-specific room
      client.join(`user:${profile.id}`);

      // Join role-specific room
      client.join(`role:${profile.role}`);

      // Join department room if applicable
      if (profile.department_id) {
        client.join(`department:${profile.department_id}`);
      }

      // Store client reference
      this.connectedClients.set(client.id, client);

      this.logger.log(
        `Client ${client.id} connected: ${profile.email} (${profile.role})`,
      );

      // Send welcome message
      client.emit('connected', {
        message: 'Connected to ABENT 3T notifications',
        userId: profile.id,
        role: profile.role,
      });
    } catch (err) {
      this.logger.error(`Error handling connection: ${err.message}`);
      client.emit('error', { message: 'Connection error' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const user = client.data.user;
    this.connectedClients.delete(client.id);

    if (user) {
      this.logger.log(`Client ${client.id} disconnected: ${user.email}`);
    } else {
      this.logger.log(`Client ${client.id} disconnected`);
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: AuthenticatedSocket) {
    return { event: 'pong', data: { timestamp: new Date().toISOString() } };
  }

  @SubscribeMessage('subscribe:dashboard')
  handleSubscribeDashboard(@ConnectedSocket() client: AuthenticatedSocket) {
    client.join('dashboard');
    this.logger.log(`Client ${client.id} subscribed to dashboard`);
    return { success: true };
  }

  @SubscribeMessage('unsubscribe:dashboard')
  handleUnsubscribeDashboard(@ConnectedSocket() client: AuthenticatedSocket) {
    client.leave('dashboard');
    return { success: true };
  }

  @SubscribeMessage('subscribe:edition')
  handleSubscribeEdition(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { editionId: string },
  ) {
    if (data.editionId) {
      client.join(`edition:${data.editionId}`);
      this.logger.log(
        `Client ${client.id} subscribed to edition ${data.editionId}`,
      );
      return { success: true };
    }
    return { success: false, error: 'Edition ID required' };
  }

  @SubscribeMessage('unsubscribe:edition')
  handleUnsubscribeEdition(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { editionId: string },
  ) {
    if (data.editionId) {
      client.leave(`edition:${data.editionId}`);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Get count of connected clients
   */
  getConnectedCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Get connected users info (for debugging)
   */
  getConnectedUsers(): Array<{ id: string; email: string; role: string }> {
    return Array.from(this.connectedClients.values())
      .map((client) => client.data.user)
      .filter((user): user is NonNullable<typeof user> => !!user)
      .map(({ id, email, role }) => ({ id, email, role }));
  }
}
