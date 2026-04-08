import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

export interface NotificationPayload {
  type:
    | 'enrollment'
    | 'evidence'
    | 'request'
    | 'proposal'
    | 'budget'
    | 'course'
    | 'user'
    // Tipos de Compras
    | 'requisition'
    | 'purchase_order'
    | 'approval'
    | 'supplier';
  action: 'create' | 'update' | 'delete' | 'approve' | 'reject' | 'upload' | 'verify' | 'pending_approval';
  entityId: string;
  entityName?: string;
  message: string;
  data?: Record<string, unknown>;
  userId?: string; // User who performed the action
  targetUserId?: string; // User who should receive the notification
  departmentId?: string; // Department related to the event
}

@Injectable()
export class SocketService {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  getServer(): Server | null {
    return this.server;
  }

  /**
   * Emit to all connected clients
   */
  broadcast(event: string, payload: NotificationPayload) {
    if (!this.server) return;
    this.server.emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit to a specific user by their ID
   */
  emitToUser(userId: string, event: string, payload: NotificationPayload) {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit to all users in a department
   */
  emitToDepartment(departmentId: string, event: string, payload: NotificationPayload) {
    if (!this.server) return;
    this.server.to(`department:${departmentId}`).emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit to users with specific roles
   */
  emitToRole(role: string, event: string, payload: NotificationPayload) {
    if (!this.server) return;
    this.server.to(`role:${role}`).emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit to admin_rh users (most common case)
   */
  emitToAdminRH(event: string, payload: NotificationPayload) {
    this.emitToRole('admin_rh', event, payload);
    this.emitToRole('super_admin', event, payload);
  }

  /**
   * Emit enrollment events
   */
  emitEnrollment(
    action: 'create' | 'update' | 'delete',
    enrollment: {
      id: string;
      profileId: string;
      profileName: string;
      courseName: string;
      status?: string;
      departmentId?: string;
    },
    performedBy: { id: string; name: string },
  ) {
    const messages: Record<string, string> = {
      create: `${enrollment.profileName} fue inscrito en ${enrollment.courseName}`,
      update: `Inscripción de ${enrollment.profileName} actualizada a "${enrollment.status}"`,
      delete: `Inscripción de ${enrollment.profileName} fue cancelada`,
    };

    const payload: NotificationPayload = {
      type: 'enrollment',
      action,
      entityId: enrollment.id,
      entityName: `${enrollment.profileName} - ${enrollment.courseName}`,
      message: messages[action],
      data: enrollment,
      userId: performedBy.id,
      targetUserId: enrollment.profileId,
      departmentId: enrollment.departmentId,
    };

    // Notify the enrolled user
    this.emitToUser(enrollment.profileId, 'notification', payload);

    // Notify admin_rh
    this.emitToAdminRH('enrollment:update', payload);

    // Broadcast to department
    if (enrollment.departmentId) {
      this.emitToDepartment(enrollment.departmentId, 'enrollment:update', payload);
    }
  }

  /**
   * Emit evidence events
   */
  emitEvidence(
    action: 'upload' | 'verify' | 'reject',
    evidence: {
      id: string;
      enrollmentId: string;
      profileId: string;
      profileName: string;
      courseName: string;
      status?: string;
    },
    performedBy: { id: string; name: string },
  ) {
    const messages: Record<string, string> = {
      upload: `${evidence.profileName} subió evidencia para ${evidence.courseName}`,
      verify: `Evidencia de ${evidence.profileName} fue aprobada`,
      reject: `Evidencia de ${evidence.profileName} fue rechazada`,
    };

    const payload: NotificationPayload = {
      type: 'evidence',
      action,
      entityId: evidence.id,
      entityName: `${evidence.profileName} - ${evidence.courseName}`,
      message: messages[action],
      data: evidence,
      userId: performedBy.id,
      targetUserId: evidence.profileId,
    };

    // Notify the user who uploaded
    this.emitToUser(evidence.profileId, 'notification', payload);

    // Notify admin_rh when evidence is uploaded
    if (action === 'upload') {
      this.emitToAdminRH('evidence:pending', payload);
    }

    // Broadcast update
    this.emitToAdminRH('evidence:update', payload);
  }

  /**
   * Emit request events (training requests)
   */
  emitRequest(
    action: 'create' | 'approve' | 'reject',
    request: {
      id: string;
      requesterId: string;
      requesterName: string;
      profileId: string;
      profileName: string;
      courseName: string;
      departmentId?: string;
    },
    performedBy: { id: string; name: string },
  ) {
    const messages: Record<string, string> = {
      create: `${request.requesterName} solicitó capacitación para ${request.profileName}`,
      approve: `Solicitud de ${request.profileName} para ${request.courseName} fue aprobada`,
      reject: `Solicitud de ${request.profileName} para ${request.courseName} fue rechazada`,
    };

    const payload: NotificationPayload = {
      type: 'request',
      action,
      entityId: request.id,
      entityName: `${request.profileName} - ${request.courseName}`,
      message: messages[action],
      data: request,
      userId: performedBy.id,
      targetUserId: request.requesterId,
      departmentId: request.departmentId,
    };

    // Notify the requester
    this.emitToUser(request.requesterId, 'notification', payload);

    // Notify the beneficiary if different
    if (request.profileId !== request.requesterId) {
      this.emitToUser(request.profileId, 'notification', payload);
    }

    // Notify admin_rh when request is created
    if (action === 'create') {
      this.emitToAdminRH('request:pending', payload);
    }

    // Broadcast update
    this.emitToAdminRH('request:update', payload);
  }

  /**
   * Emit proposal events (external course proposals)
   */
  emitProposal(
    action: 'create' | 'update' | 'approve' | 'reject',
    proposal: {
      id: string;
      proposerId: string;
      proposerName: string;
      profileId: string;
      profileName: string;
      courseName: string;
      status?: string;
    },
    performedBy: { id: string; name: string },
  ) {
    const messages: Record<string, string> = {
      create: `${proposal.proposerName} propuso el curso "${proposal.courseName}"`,
      update: `Propuesta "${proposal.courseName}" cambió a "${proposal.status}"`,
      approve: `Propuesta "${proposal.courseName}" fue aprobada`,
      reject: `Propuesta "${proposal.courseName}" fue rechazada`,
    };

    const payload: NotificationPayload = {
      type: 'proposal',
      action,
      entityId: proposal.id,
      entityName: proposal.courseName,
      message: messages[action],
      data: proposal,
      userId: performedBy.id,
      targetUserId: proposal.proposerId,
    };

    // Notify the proposer
    this.emitToUser(proposal.proposerId, 'notification', payload);

    // Notify the beneficiary if different
    if (proposal.profileId !== proposal.proposerId) {
      this.emitToUser(proposal.profileId, 'notification', payload);
    }

    // Notify admin_rh when proposal is created
    if (action === 'create') {
      this.emitToAdminRH('proposal:pending', payload);
    }

    // Broadcast update
    this.emitToAdminRH('proposal:update', payload);
  }

  /**
   * Emit budget events
   */
  emitBudget(
    action: 'update',
    budget: {
      id: string;
      departmentId: string;
      departmentName: string;
      assignedAmount: number;
      consumedAmount: number;
      remainingPercent: number;
    },
    performedBy: { id: string; name: string },
  ) {
    const payload: NotificationPayload = {
      type: 'budget',
      action,
      entityId: budget.id,
      entityName: budget.departmentName,
      message: `Presupuesto de ${budget.departmentName} actualizado (${budget.remainingPercent.toFixed(0)}% disponible)`,
      data: budget,
      userId: performedBy.id,
      departmentId: budget.departmentId,
    };

    // Broadcast to department managers
    this.emitToDepartment(budget.departmentId, 'budget:update', payload);

    // Notify admin_rh
    this.emitToAdminRH('budget:update', payload);

    // Alert if budget is running low (< 20%)
    if (budget.remainingPercent < 20) {
      const alertPayload: NotificationPayload = {
        ...payload,
        message: `Alerta: Presupuesto de ${budget.departmentName} por debajo del 20%`,
      };
      this.emitToAdminRH('budget:alert', alertPayload);
    }
  }

  /**
   * Emit dashboard refresh event
   */
  emitDashboardRefresh() {
    if (!this.server) return;
    this.server.emit('dashboard:refresh', {
      timestamp: new Date().toISOString(),
    });
  }
}
