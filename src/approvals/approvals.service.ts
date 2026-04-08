import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SocketService } from '../socket/socket.service';

// Niveles de aprobacion y roles correspondientes
const APPROVAL_LEVELS: Record<number, string> = {
  1: 'aprobador_nivel_1',
  2: 'aprobador_nivel_2',
  3: 'aprobador_nivel_3',
  4: 'director_general',
};

const LEVEL_NAMES: Record<number, string> = {
  1: 'Nivel 1 (David)',
  2: 'Nivel 2 (Gilberto)',
  3: 'Nivel 3 (Uriel)',
  4: 'Director General',
};

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly socketService: SocketService,
  ) {}

  /**
   * Obtiene las aprobaciones pendientes del usuario actual
   */
  async getPending(userId: string, userRole: string) {
    // Determinar el nivel del usuario
    const userLevel = Object.entries(APPROVAL_LEVELS).find(([_, role]) => role === userRole)?.[0];

    if (!userLevel) {
      return []; // Usuario no es aprobador
    }

    const { data, error } = await this.supabase.db
      .from('approvals')
      .select(`
        *,
        workflow:approval_workflows(
          *,
          requisition:requisitions(
            *,
            requester:profiles!requester_id(id, full_name, email),
            department:departments(id, name)
          )
        )
      `)
      .eq('approver_id', userId)
      .eq('status', 'pendiente')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return data || [];
  }

  /**
   * Obtiene el historial de aprobaciones del usuario
   */
  async getMyApprovals(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase.db
      .from('approvals')
      .select(`
        *,
        workflow:approval_workflows(
          *,
          requisition:requisitions(
            id, rq_number, description, estimated_amount
          )
        )
      `, { count: 'exact' })
      .eq('approver_id', userId)
      .neq('status', 'pendiente')
      .eq('is_active', true)
      .order('approved_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const total = count ?? 0;
    return {
      data: data ?? [],
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Obtiene el workflow de aprobacion de una requisicion
   */
  async getWorkflowByRequisition(requisitionId: string) {
    // Obtener el workflow
    const { data: workflow, error: workflowError } = await this.supabase.db
      .from('approval_workflows')
      .select('*')
      .eq('requisition_id', requisitionId)
      .eq('is_active', true)
      .single();

    if (workflowError || !workflow) {
      return null; // No hay workflow para esta requisicion
    }

    // Obtener las aprobaciones del workflow
    const { data: approvals, error: approvalsError } = await this.supabase.db
      .from('approvals')
      .select(`
        *,
        approver:profiles!approver_id(id, full_name, email, role)
      `)
      .eq('workflow_id', workflow.id)
      .eq('is_active', true)
      .order('level', { ascending: true });

    if (approvalsError) throw approvalsError;

    return {
      ...workflow,
      approvals: approvals || [],
      level_names: LEVEL_NAMES,
    };
  }

  /**
   * Inicia el workflow de aprobacion para una requisicion
   */
  async startWorkflow(requisitionId: string, userId: string) {
    // Verificar que la requisicion existe y esta en revision
    const { data: requisition, error: rqError } = await this.supabase.db
      .from('requisitions')
      .select('*')
      .eq('id', requisitionId)
      .eq('is_active', true)
      .single();

    if (rqError || !requisition) {
      throw new NotFoundException('Requisicion no encontrada');
    }

    if (requisition.status !== 'en_revision') {
      throw new BadRequestException('Solo se puede iniciar workflow para requisiciones en revision');
    }

    // Verificar que no exista ya un workflow
    const { data: existingWorkflow } = await this.supabase.db
      .from('approval_workflows')
      .select('id')
      .eq('requisition_id', requisitionId)
      .eq('is_active', true)
      .single();

    if (existingWorkflow) {
      throw new BadRequestException('Ya existe un workflow de aprobacion para esta requisicion');
    }

    // Crear el workflow
    const { data: workflow, error: workflowError } = await this.supabase.db
      .from('approval_workflows')
      .insert({
        requisition_id: requisitionId,
        current_level: 1,
        status: 'pendiente',
      })
      .select()
      .single();

    if (workflowError) throw workflowError;

    // Buscar aprobadores para cada nivel
    for (let level = 1; level <= 4; level++) {
      const role = APPROVAL_LEVELS[level];

      // Buscar usuario con ese rol
      const { data: approver } = await this.supabase.db
        .from('profiles')
        .select('id')
        .eq('role', role)
        .eq('is_active', true)
        .limit(1)
        .single();

      if (approver) {
        await this.supabase.db.from('approvals').insert({
          workflow_id: workflow.id,
          level: level,
          approver_id: approver.id,
          status: level === 1 ? 'pendiente' : 'esperando', // Solo nivel 1 inicia pendiente
        });
      }
    }

    // Actualizar estado de la requisicion
    await this.supabase.db
      .from('requisitions')
      .update({ status: 'en_progreso', updated_at: new Date().toISOString() })
      .eq('id', requisitionId);

    // Notificar al primer aprobador
    this.notifyApprover(workflow.id, 1, requisition);

    this.logger.log(`Workflow iniciado para requisicion ${requisition.rq_number}`);

    return workflow;
  }

  /**
   * Aprueba una requisicion en el nivel actual
   */
  async approve(requisitionId: string, userId: string, userRole: string, comments?: string) {
    // Verificar que el usuario es aprobador del nivel correcto
    const userLevel = Object.entries(APPROVAL_LEVELS).find(([_, role]) => role === userRole)?.[0];

    if (!userLevel) {
      throw new ForbiddenException('No tienes permisos para aprobar requisiciones');
    }

    // Obtener el workflow
    const { data: workflow, error: workflowError } = await this.supabase.db
      .from('approval_workflows')
      .select('*, requisition:requisitions(*)')
      .eq('requisition_id', requisitionId)
      .eq('is_active', true)
      .single();

    if (workflowError || !workflow) {
      throw new NotFoundException('No existe workflow de aprobacion para esta requisicion');
    }

    if (workflow.status !== 'pendiente') {
      throw new BadRequestException(`El workflow ya esta ${workflow.status}`);
    }

    if (workflow.current_level !== parseInt(userLevel)) {
      throw new BadRequestException(
        `Esta requisicion esta pendiente de aprobacion en nivel ${workflow.current_level}`,
      );
    }

    // Obtener la aprobacion del nivel actual
    const { data: approval, error: approvalError } = await this.supabase.db
      .from('approvals')
      .select('*')
      .eq('workflow_id', workflow.id)
      .eq('level', workflow.current_level)
      .eq('approver_id', userId)
      .eq('is_active', true)
      .single();

    if (approvalError || !approval) {
      throw new ForbiddenException('No tienes asignada esta aprobacion');
    }

    // Calcular tiempo de aprobacion en dias habiles
    const { data: businessDays } = await this.supabase.db.rpc('calculate_business_days', {
      start_date: approval.created_at.split('T')[0],
      end_date: new Date().toISOString().split('T')[0],
    });

    // Actualizar la aprobacion
    await this.supabase.db
      .from('approvals')
      .update({
        status: 'aprobada',
        approved_at: new Date().toISOString(),
        time_to_approve: businessDays || 0,
      })
      .eq('id', approval.id);

    // Determinar siguiente paso
    const nextLevel = workflow.current_level + 1;

    if (nextLevel > 4) {
      // Workflow completado - aprobar requisicion
      await this.supabase.db
        .from('approval_workflows')
        .update({
          status: 'aprobado',
          completed_at: new Date().toISOString(),
        })
        .eq('id', workflow.id);

      await this.supabase.db
        .from('requisitions')
        .update({ status: 'aprobada', updated_at: new Date().toISOString() })
        .eq('id', requisitionId);

      // Notificar al comprador asignado
      if (workflow.requisition.buyer_id) {
        this.socketService.emitToUser(workflow.requisition.buyer_id, 'notification', {
          type: 'requisition',
          action: 'approve',
          message: `La requisicion ${workflow.requisition.rq_number} ha sido aprobada y esta lista para generar PO`,
          entityId: requisitionId,
        });
      }

      this.logger.log(`Requisicion ${workflow.requisition.rq_number} aprobada completamente`);
    } else {
      // Avanzar al siguiente nivel
      await this.supabase.db
        .from('approval_workflows')
        .update({ current_level: nextLevel })
        .eq('id', workflow.id);

      // Activar la siguiente aprobacion
      await this.supabase.db
        .from('approvals')
        .update({ status: 'pendiente' })
        .eq('workflow_id', workflow.id)
        .eq('level', nextLevel);

      // Notificar al siguiente aprobador
      this.notifyApprover(workflow.id, nextLevel, workflow.requisition);

      this.logger.log(
        `Requisicion ${workflow.requisition.rq_number} aprobada en nivel ${workflow.current_level}, avanzando a nivel ${nextLevel}`,
      );
    }

    return { success: true, message: 'Requisicion aprobada' };
  }

  /**
   * Rechaza una requisicion
   */
  async reject(requisitionId: string, userId: string, userRole: string, rejectionReason: string) {
    // Verificar que el usuario es aprobador
    const userLevel = Object.entries(APPROVAL_LEVELS).find(([_, role]) => role === userRole)?.[0];

    if (!userLevel) {
      throw new ForbiddenException('No tienes permisos para rechazar requisiciones');
    }

    // Obtener el workflow
    const { data: workflow, error: workflowError } = await this.supabase.db
      .from('approval_workflows')
      .select('*, requisition:requisitions(*)')
      .eq('requisition_id', requisitionId)
      .eq('is_active', true)
      .single();

    if (workflowError || !workflow) {
      throw new NotFoundException('No existe workflow de aprobacion para esta requisicion');
    }

    if (workflow.status !== 'pendiente') {
      throw new BadRequestException(`El workflow ya esta ${workflow.status}`);
    }

    // Obtener la aprobacion del nivel actual
    const { data: approval } = await this.supabase.db
      .from('approvals')
      .select('*')
      .eq('workflow_id', workflow.id)
      .eq('level', workflow.current_level)
      .eq('approver_id', userId)
      .eq('is_active', true)
      .single();

    if (!approval) {
      throw new ForbiddenException('No tienes asignada esta aprobacion');
    }

    // Actualizar la aprobacion
    await this.supabase.db
      .from('approvals')
      .update({
        status: 'rechazada',
        rejected_at: new Date().toISOString(),
        rejection_reason: rejectionReason,
      })
      .eq('id', approval.id);

    // Terminar el workflow
    await this.supabase.db
      .from('approval_workflows')
      .update({
        status: 'rechazado',
        completed_at: new Date().toISOString(),
      })
      .eq('id', workflow.id);

    // Actualizar requisicion
    await this.supabase.db
      .from('requisitions')
      .update({ status: 'rechazada', updated_at: new Date().toISOString() })
      .eq('id', requisitionId);

    // Notificar al solicitante
    this.socketService.emitToUser(workflow.requisition.requester_id, 'notification', {
      type: 'requisition',
      action: 'reject',
      message: `Tu requisicion ${workflow.requisition.rq_number} ha sido rechazada. Motivo: ${rejectionReason}`,
      entityId: requisitionId,
    });

    this.logger.log(`Requisicion ${workflow.requisition.rq_number} rechazada en nivel ${workflow.current_level}`);

    return { success: true, message: 'Requisicion rechazada' };
  }

  /**
   * Obtiene estadisticas de aprobaciones por aprobador
   */
  async getStats() {
    const { data: approvals, error } = await this.supabase.db
      .from('approvals')
      .select(`
        level,
        status,
        time_to_approve,
        approver:profiles!approver_id(id, full_name, role)
      `)
      .eq('is_active', true);

    if (error) throw error;

    // Agrupar por nivel
    const statsByLevel: Record<number, any> = {};

    for (let level = 1; level <= 4; level++) {
      const levelApprovals = approvals?.filter((a) => a.level === level) || [];
      const approved = levelApprovals.filter((a) => a.status === 'aprobada');
      const rejected = levelApprovals.filter((a) => a.status === 'rechazada');
      const pending = levelApprovals.filter((a) => a.status === 'pendiente');

      const totalTime = approved.reduce((sum, a) => sum + (a.time_to_approve || 0), 0);
      const avgTime = approved.length > 0 ? Math.round(totalTime / approved.length) : 0;

      statsByLevel[level] = {
        level,
        level_name: LEVEL_NAMES[level],
        total: levelApprovals.length,
        approved: approved.length,
        rejected: rejected.length,
        pending: pending.length,
        approval_rate: levelApprovals.length > 0
          ? Math.round((approved.length / (approved.length + rejected.length || 1)) * 100)
          : 0,
        average_time_days: avgTime,
        approver: levelApprovals[0]?.approver || null,
      };
    }

    return statsByLevel;
  }

  /**
   * Notifica al aprobador del nivel correspondiente
   */
  private async notifyApprover(workflowId: string, level: number, requisition: any) {
    const { data: approval } = await this.supabase.db
      .from('approvals')
      .select('approver_id')
      .eq('workflow_id', workflowId)
      .eq('level', level)
      .single();

    if (approval?.approver_id) {
      this.socketService.emitToUser(approval.approver_id, 'notification', {
        type: 'requisition',
        action: 'pending_approval',
        message: `Tienes una requisicion pendiente de aprobacion: ${requisition.rq_number}`,
        entityId: requisition.id,
      });
    }
  }
}
