import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import { CommitteeQueryDto } from './dto/committee-query.dto';
import { CreateCommitteeDto } from './dto/create-committee.dto';
import { RejectCommitteeDto } from './dto/reject-committee.dto';
import { UpdateApprovalLevelDto } from './dto/update-approval-level.dto';
import { UpdateCommitteeDto } from './dto/update-committee.dto';

/**
 * Fase §16 — Comité de Compras: workflow de aprobación SECUENCIAL leído de
 * `committee_approval_levels` (data-driven, §20.A.5 abierta): un nivel lo
 * aprueba el usuario específico (`profile_id`) o, si es null, cualquier
 * usuario activo con el `role` del nivel. Cambiar el mapeo (Gilberto→David,
 * Félix por usuario) es un UPDATE a esa tabla, sin deploy.
 *
 * Primera entidad de Compras AUDITADA (decisión de negocio, §16: el comité es
 * el punto de mayor exposición — cada acción es firma electrónica). Acciones
 * mapeadas al enum audit_action existente: submit→update, versión→upload.
 *
 * Correos best-effort DESPUÉS del commit (§16); sin sockets (pendiente global
 * de compras, regla 6 de la fase). Sin FKs hacia el staging de integraciones
 * ni hacia contracts (regla 2).
 */

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB (§16)
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
];
const DOWNLOAD_TTL_SECONDS = 3600; // 1 h (§16: los aprobadores tardan más)
const MS_PER_HOUR = 3_600_000;

const COMMITTEE_INCLUDE = {
  profiles: { select: { id: true, full_name: true, email: true } },
} as const;

/** `storage_key` nunca viaja al cliente (regla 4 de la fase). */
const VERSION_SELECT = {
  id: true,
  committee_id: true,
  version: true,
  file_name: true,
  external_link: true,
  mime_type: true,
  file_size_bytes: true,
  uploaded_by: true,
  uploaded_at: true,
} as const;

const APPROVAL_INCLUDE = {
  profiles: { select: { id: true, full_name: true } },
} as const;

type CommitteeRow = Prisma.purchase_committeesGetPayload<{
  include: typeof COMMITTEE_INCLUDE;
}>;

type LevelRow = Prisma.committee_approval_levelsGetPayload<object>;

type VersionRow = Prisma.committee_versionsGetPayload<{
  select: typeof VERSION_SELECT;
}>;

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function roundHours(ms: number): number {
  return Math.round((ms / MS_PER_HOUR) * 100) / 100;
}

function mapVersion(row: VersionRow) {
  return {
    ...row,
    file_size_bytes:
      row.file_size_bytes === null ? null : Number(row.file_size_bytes),
  };
}

/** Semana ISO-8601 para el consecutivo COM-YYYY-WNN. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNumber = (d.getUTCDay() + 6) % 7; // lunes=0
  d.setUTCDate(d.getUTCDate() - dayNumber + 3); // jueves de la semana
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / 604_800_000);
  return { year: isoYear, week };
}

@Injectable()
export class PurchaseCommitteesService {
  private readonly logger = new Logger(PurchaseCommitteesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService,
  ) {}

  // ── Cadena de aprobación (data-driven) ──────────────────────────────────

  private async getActiveLevels(): Promise<LevelRow[]> {
    return this.prisma.committee_approval_levels.findMany({
      where: { is_active: true },
      orderBy: { orden: 'asc' },
    });
  }

  /** ¿El usuario puede actuar en este nivel? usuario específico > rol. */
  private levelMatchesUser(level: LevelRow, user: AuthUser): boolean {
    if (level.profile_id) return level.profile_id === user.id;
    return hasAnyRole(user, level.role);
  }

  getLevels() {
    return this.prisma.committee_approval_levels.findMany({
      orderBy: { orden: 'asc' },
    });
  }

  async updateLevel(id: string, dto: UpdateApprovalLevelDto, user: AuthUser) {
    const existing = await this.prisma.committee_approval_levels.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Nivel no encontrado');
    if (dto.profile_id) {
      const profile = await this.prisma.profiles.findFirst({
        where: { id: dto.profile_id, is_active: true },
        select: { id: true },
      });
      if (!profile) throw new NotFoundException('Perfil no encontrado');
    }
    try {
      const updated = await this.prisma.committee_approval_levels.update({
        where: { id },
        data: dto,
      });
      this.logger.log(
        `Nivel ${existing.orden} del comité actualizado por ${user.id} (confirmed=${String(updated.confirmed)})`,
      );
      return updated;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestException('Ya existe un nivel con ese orden');
      }
      throw err;
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async findAll(query: CommitteeQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.purchase_committeesWhereInput = { is_active: true };
    if (query.status) where.status = query.status;
    if (query.created_by) where.created_by = query.created_by;
    if (query.date_from || query.date_to) {
      where.committee_date = {
        ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
        ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { committee_number: { contains: query.search, mode: 'insensitive' } },
        { title: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [total, rows, levels] = await Promise.all([
      this.prisma.purchase_committees.count({ where }),
      this.prisma.purchase_committees.findMany({
        where,
        include: COMMITTEE_INCLUDE,
        orderBy: [{ committee_date: 'desc' }, { committee_number: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.getActiveLevels(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: rows.map((row) => this.aliasCommittee(row, levels, user)),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    } satisfies PaginatedResponse<unknown>;
  }

  async findOne(id: string, user: AuthUser) {
    const committee = await this.prisma.purchase_committees.findFirst({
      where: { id, is_active: true },
      include: COMMITTEE_INCLUDE,
    });
    if (!committee) throw new NotFoundException('Comité no encontrado');

    const [versions, approvals, levels] = await Promise.all([
      this.prisma.committee_versions.findMany({
        where: { committee_id: id },
        select: VERSION_SELECT,
        orderBy: { version: 'desc' },
      }),
      this.prisma.committee_approvals.findMany({
        where: { committee_id: id },
        include: APPROVAL_INCLUDE,
        orderBy: [{ version: 'asc' }, { approver_level: 'asc' }],
      }),
      this.getActiveLevels(),
    ]);

    return {
      ...this.aliasCommittee(committee, levels, user),
      versions: versions.map(mapVersion),
      approvals: approvals.map((a) => ({
        id: a.id,
        version: a.version,
        approver_level: a.approver_level,
        approver: a.profiles,
        approver_role: a.approver_role,
        action: a.action,
        justification: a.justification,
        action_at: a.action_at,
        elapsed_hours_since_assigned: toNumber(a.elapsed_hours_since_assigned),
      })),
      levels: levels.map((l) => ({
        orden: l.orden,
        role: l.role,
        has_specific_user: l.profile_id !== null,
        confirmed: l.confirmed,
      })),
    };
  }

  async create(dto: CreateCommitteeDto, user: AuthUser) {
    const committeeDate = new Date(dto.committee_date);
    const number = await this.generateCommitteeNumber(committeeDate);
    const created = await this.prisma.purchase_committees.create({
      data: {
        committee_number: number,
        committee_date: committeeDate,
        title: dto.title,
        description: dto.description,
        created_by: user.id,
      },
      include: COMMITTEE_INCLUDE,
    });
    await this.auditLog('create', created.id, created.committee_number, user, {
      new_values: { title: dto.title, committee_date: dto.committee_date },
    });
    this.logger.log(`Comité ${created.committee_number} creado por ${user.id}`);
    const levels = await this.getActiveLevels();
    return this.aliasCommittee(created, levels, user);
  }

  async update(id: string, dto: UpdateCommitteeDto, user: AuthUser) {
    const existing = await this.assertEditable(id, user);
    const updated = await this.prisma.purchase_committees.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.committee_date
          ? { committee_date: new Date(dto.committee_date) }
          : {}),
      },
      include: COMMITTEE_INCLUDE,
    });
    await this.auditLog('update', id, existing.committee_number, user, {
      old_values: { title: existing.title },
      new_values: dto as Record<string, unknown>,
    });
    const levels = await this.getActiveLevels();
    return this.aliasCommittee(updated, levels, user);
  }

  // ── Versiones (PPT/PDF o link externo) ──────────────────────────────────

  async uploadVersion(
    id: string,
    user: AuthUser,
    file?: Express.Multer.File,
    externalLink?: string,
  ) {
    const committee = await this.assertEditable(id, user);
    if (!file && !externalLink) {
      throw new BadRequestException(
        'Adjunta un archivo (.pdf/.pptx) o un external_link HTTPS',
      );
    }
    if (file && externalLink) {
      throw new BadRequestException('Envía archivo O link externo, no ambos');
    }
    if (file) this.validateFile(file);

    // Tras un rechazo, el documento corresponde a la SIGUIENTE versión (el
    // submit hará el bump de current_version; regla 5 de §16).
    const targetVersion =
      committee.status === 'rechazado'
        ? committee.current_version + 1
        : committee.current_version;

    let storageKey: string | null = null;
    if (file) {
      const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      storageKey = `${id}/v${targetVersion}_${Date.now()}_${sanitized}`;
      await this.storage.upload(
        this.storage.bucketCommittees,
        storageKey,
        file.buffer,
        file.mimetype,
      );
    }

    const data = {
      file_name: file?.originalname ?? null,
      storage_key: storageKey,
      external_link: externalLink ?? null,
      mime_type: file?.mimetype ?? null,
      file_size_bytes: file ? BigInt(file.size) : null,
      uploaded_by: user.id,
      uploaded_at: new Date(),
    };

    try {
      const existing = await this.prisma.committee_versions.findFirst({
        where: { committee_id: id, version: targetVersion },
        select: { id: true, storage_key: true },
      });
      let saved: VersionRow;
      if (existing) {
        // Reemplazo del documento de una versión aún no enviada
        saved = await this.prisma.committee_versions.update({
          where: { id: existing.id },
          data,
          select: VERSION_SELECT,
        });
        if (existing.storage_key && existing.storage_key !== storageKey) {
          await this.storage.remove(
            this.storage.bucketCommittees,
            existing.storage_key,
          );
        }
      } else {
        saved = await this.prisma.committee_versions.create({
          data: { committee_id: id, version: targetVersion, ...data },
          select: VERSION_SELECT,
        });
      }
      await this.auditLog('upload', id, committee.committee_number, user, {
        new_values: {
          version: targetVersion,
          file_name: data.file_name,
          external_link: data.external_link,
        },
      });
      return mapVersion(saved);
    } catch (err) {
      if (storageKey) {
        await this.storage.remove(this.storage.bucketCommittees, storageKey);
      }
      throw err;
    }
  }

  async getVersionDownload(committeeId: string, versionId: string) {
    const version = await this.prisma.committee_versions.findFirst({
      where: { id: versionId, committee_id: committeeId },
      select: { storage_key: true, file_name: true, external_link: true },
    });
    if (!version) throw new NotFoundException('Versión no encontrada');
    // Link externo: se regresa directo (no hay objeto en MinIO)
    if (version.external_link) {
      return { url: version.external_link, fileName: version.file_name };
    }
    if (!version.storage_key) {
      throw new NotFoundException('La versión no tiene documento adjunto');
    }
    const url = await this.storage.getSignedUrl(
      this.storage.bucketCommittees,
      version.storage_key,
      DOWNLOAD_TTL_SECONDS,
    );
    return { url, fileName: version.file_name };
  }

  // ── Workflow ────────────────────────────────────────────────────────────

  async submit(id: string, user: AuthUser) {
    const levels = await this.getActiveLevels();
    if (levels.length === 0) {
      throw new BadRequestException(
        'La cadena de aprobación está vacía: configura committee_approval_levels',
      );
    }
    const firstLevel = levels[0].orden;

    const updated = await this.prisma.$transaction(async (tx) => {
      const committee = await tx.purchase_committees.findFirst({
        where: { id, is_active: true },
      });
      if (!committee) throw new NotFoundException('Comité no encontrado');
      this.assertAuthor(committee.created_by, user);
      if (!['borrador', 'rechazado'].includes(committee.status)) {
        throw new BadRequestException(
          'Solo se puede enviar desde borrador o rechazado',
        );
      }
      const newVersion =
        committee.status === 'rechazado'
          ? committee.current_version + 1
          : committee.current_version;

      // Regla 5: el reenvío requiere el documento de la nueva versión
      const versionDoc = await tx.committee_versions.findFirst({
        where: { committee_id: id, version: newVersion },
        select: { id: true },
      });
      if (!versionDoc) {
        throw new BadRequestException(
          `Sube el documento de la versión ${newVersion} antes de enviar a aprobación`,
        );
      }

      return tx.purchase_committees.update({
        where: { id },
        data: {
          status: 'en_aprobacion',
          current_version: newVersion,
          current_approver_level: firstLevel,
          submitted_at: new Date(),
        },
        include: COMMITTEE_INCLUDE,
      });
    });

    // Post-commit: auditoría + correo al primer nivel (best-effort)
    await this.auditLog('update', id, updated.committee_number, user, {
      description: `Comité ${updated.committee_number} enviado a aprobación (v${updated.current_version})`,
      new_values: { status: 'en_aprobacion', version: updated.current_version },
    });
    await this.notifyLevel(
      levels[0],
      `[ABENT 3T] Comité ${updated.committee_number} espera tu aprobación`,
      [
        `El comité "${updated.title}" (versión ${updated.current_version}) fue enviado a aprobación.`,
        'Eres el primer nivel de la cadena.',
      ],
    );
    return this.aliasCommittee(updated, levels, user);
  }

  async approve(
    id: string,
    user: AuthUser,
    meta: { ip?: string; userAgent?: string },
  ) {
    const levels = await this.getActiveLevels();
    let result: {
      committee: CommitteeRow;
      isFinal: boolean;
      nextLevel: LevelRow | null;
    };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const committee = await this.loadForAction(tx, id);
        const currentLevel = this.resolveCurrentLevel(committee, levels);
        this.assertTurn(currentLevel, user);

        await tx.committee_approvals.create({
          data: {
            committee_id: id,
            version: committee.current_version,
            approver_level: currentLevel.orden,
            approver_profile_id: user.id,
            approver_role: currentLevel.role,
            action: 'aprobado',
            elapsed_hours_since_assigned: await this.elapsedForLevel(
              tx,
              committee,
            ),
            ip_address: meta.ip ?? null,
            user_agent: meta.userAgent ?? null,
          },
        });

        const next = levels.find((l) => l.orden > currentLevel.orden) ?? null;
        const isFinal = next === null;
        const updated = await tx.purchase_committees.update({
          where: { id },
          data: isFinal
            ? {
                status: 'aprobado',
                approved_at: new Date(),
                current_approver_level: null,
                total_elapsed_hours: committee.submitted_at
                  ? roundHours(Date.now() - committee.submitted_at.getTime())
                  : null,
              }
            : { current_approver_level: next.orden },
          include: COMMITTEE_INCLUDE,
        });
        return { committee: updated, isFinal, nextLevel: next };
      });
    } catch (err: unknown) {
      // Doble aprobación del mismo (versión, nivel) → idempotente: el estado
      // ya avanzó en la primera; se devuelve el comité tal cual está.
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.warn(`Aprobación duplicada ignorada en comité ${id}`);
        return this.findOne(id, user);
      }
      throw err;
    }

    const { committee, isFinal, nextLevel } = result;
    await this.auditLog('approve', id, committee.committee_number, user, {
      new_values: {
        version: committee.current_version,
        final: isFinal,
        next_level: nextLevel?.orden ?? null,
      },
      ip_address: meta.ip,
      user_agent: meta.userAgent,
    });
    if (isFinal) {
      await this.notifyResolution(committee, 'aprobado', null);
    } else if (nextLevel) {
      await this.notifyLevel(
        nextLevel,
        `[ABENT 3T] Comité ${committee.committee_number} espera tu aprobación`,
        [
          `El nivel anterior aprobó el comité "${committee.title}" (versión ${committee.current_version}).`,
          'Es tu turno en la cadena de aprobación.',
        ],
      );
    }
    return this.aliasCommittee(committee, levels, user);
  }

  async reject(
    id: string,
    dto: RejectCommitteeDto,
    user: AuthUser,
    meta: { ip?: string; userAgent?: string },
  ) {
    const levels = await this.getActiveLevels();
    let committee: CommitteeRow;
    try {
      committee = await this.prisma.$transaction(async (tx) => {
        const current = await this.loadForAction(tx, id);
        const currentLevel = this.resolveCurrentLevel(current, levels);
        this.assertTurn(currentLevel, user);

        await tx.committee_approvals.create({
          data: {
            committee_id: id,
            version: current.current_version,
            approver_level: currentLevel.orden,
            approver_profile_id: user.id,
            approver_role: currentLevel.role,
            action: 'rechazado',
            justification: dto.justification,
            elapsed_hours_since_assigned: await this.elapsedForLevel(
              tx,
              current,
            ),
            ip_address: meta.ip ?? null,
            user_agent: meta.userAgent ?? null,
          },
        });

        // Regla 5: regresa al autor; el reenvío subirá la versión
        return tx.purchase_committees.update({
          where: { id },
          data: { status: 'rechazado', current_approver_level: null },
          include: COMMITTEE_INCLUDE,
        });
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.warn(`Acción duplicada ignorada en comité ${id}`);
        return this.findOne(id, user);
      }
      throw err;
    }

    await this.auditLog('reject', id, committee.committee_number, user, {
      new_values: {
        version: committee.current_version,
        justification: dto.justification,
      },
      ip_address: meta.ip,
      user_agent: meta.userAgent,
    });
    await this.notifyResolution(committee, 'rechazado', dto.justification);
    return this.aliasCommittee(committee, levels, user);
  }

  /** Comités en aprobación donde el turno es del usuario. */
  async pendingForMe(user: AuthUser) {
    const levels = await this.getActiveLevels();
    const myLevels = levels
      .filter((l) => this.levelMatchesUser(l, user))
      .map((l) => l.orden);
    if (myLevels.length === 0) return [];
    const rows = await this.prisma.purchase_committees.findMany({
      where: {
        is_active: true,
        status: 'en_aprobacion',
        current_approver_level: { in: myLevels },
      },
      include: COMMITTEE_INCLUDE,
      orderBy: { submitted_at: 'asc' },
    });
    return rows.map((row) => this.aliasCommittee(row, levels, user));
  }

  // ── Dashboard de tiempos (§16) ──────────────────────────────────────────

  async dashboardTiempos() {
    const [approvals, committees] = await Promise.all([
      this.prisma.committee_approvals.findMany({
        include: APPROVAL_INCLUDE,
      }),
      this.prisma.purchase_committees.findMany({
        where: { is_active: true },
        select: { status: true, total_elapsed_hours: true },
      }),
    ]);

    const byApprover = new Map<
      string,
      { name: string | null; totalHours: number; count: number }
    >();
    const byLevel = new Map<number, { total: number; rejected: number }>();
    for (const approval of approvals) {
      const hours = toNumber(approval.elapsed_hours_since_assigned) ?? 0;
      const approver = byApprover.get(approval.approver_profile_id) ?? {
        name: approval.profiles.full_name,
        totalHours: 0,
        count: 0,
      };
      approver.totalHours += hours;
      approver.count += 1;
      byApprover.set(approval.approver_profile_id, approver);

      const level = byLevel.get(approval.approver_level) ?? {
        total: 0,
        rejected: 0,
      };
      level.total += 1;
      if (approval.action === 'rechazado') level.rejected += 1;
      byLevel.set(approval.approver_level, level);
    }

    const approvedHours = committees
      .filter((c) => c.status === 'aprobado')
      .map((c) => toNumber(c.total_elapsed_hours))
      .filter((h): h is number => h !== null);

    const byStatus = new Map<string, number>();
    for (const c of committees) {
      byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
    }

    return {
      byApprover: [...byApprover.entries()].map(([id, a]) => ({
        approver_profile_id: id,
        full_name: a.name,
        avg_hours: a.count
          ? Math.round((a.totalHours / a.count) * 100) / 100
          : 0,
        actions: a.count,
        // Cuello de botella según §16: promedio > 72h
        bottleneck: a.count > 0 && a.totalHours / a.count > 72,
      })),
      avgTotalHours: approvedHours.length
        ? Math.round(
            (approvedHours.reduce((s, h) => s + h, 0) / approvedHours.length) *
              100,
          ) / 100
        : null,
      byStatus: [...byStatus.entries()].map(([status, count]) => ({
        status,
        count,
      })),
      rejectionRateByLevel: [...byLevel.entries()]
        .sort(([a], [b]) => a - b)
        .map(([level, l]) => ({
          level,
          total: l.total,
          rejected: l.rejected,
          rate: l.total ? Math.round((l.rejected / l.total) * 100) : 0,
        })),
    };
  }

  // ── Recordatorio diario (§16: turno con >48h sin actuar) ────────────────

  async runReminderCheck(now: Date = new Date()) {
    const result = { checked: 0, reminded: 0, errors: [] as string[] };
    const levels = await this.getActiveLevels();
    const pending = await this.prisma.purchase_committees.findMany({
      where: { is_active: true, status: 'en_aprobacion' },
    });
    result.checked = pending.length;
    for (const committee of pending) {
      try {
        const level = levels.find(
          (l) => l.orden === committee.current_approver_level,
        );
        if (!level) continue;
        const lastAction = await this.prisma.committee_approvals.findFirst({
          where: {
            committee_id: committee.id,
            version: committee.current_version,
          },
          orderBy: { action_at: 'desc' },
          select: { action_at: true },
        });
        const assignedAt =
          lastAction?.action_at ?? committee.submitted_at ?? null;
        if (!assignedAt) continue;
        const hours = (now.getTime() - assignedAt.getTime()) / MS_PER_HOUR;
        if (hours < 48) continue;
        await this.notifyLevel(
          level,
          `[ABENT 3T] Recordatorio: comité ${committee.committee_number} lleva ${Math.floor(hours)}h esperando tu aprobación`,
          [
            `El comité "${committee.title}" (versión ${committee.current_version}) está detenido en tu nivel desde hace ${Math.floor(hours)} horas.`,
          ],
        );
        result.reminded += 1;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${committee.committee_number}: ${msg}`);
      }
    }
    if (result.reminded > 0 || result.errors.length > 0) {
      this.logger.log(
        `Recordatorios de comité: revisados=${result.checked} enviados=${result.reminded} errores=${result.errors.length}`,
      );
    }
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private aliasCommittee(
    row: CommitteeRow,
    levels: LevelRow[],
    user: AuthUser,
  ) {
    const { profiles, total_elapsed_hours, ...rest } = row;
    const currentLevel =
      row.current_approver_level === null
        ? null
        : (levels.find((l) => l.orden === row.current_approver_level) ?? null);
    return {
      ...rest,
      total_elapsed_hours: toNumber(total_elapsed_hours),
      author: profiles,
      current_level: currentLevel
        ? { orden: currentLevel.orden, role: currentLevel.role }
        : null,
      is_my_turn:
        row.status === 'en_aprobacion' &&
        currentLevel !== null &&
        this.levelMatchesUser(currentLevel, user),
    };
  }

  private assertAuthor(createdBy: string, user: AuthUser) {
    // El autor (o un admin de compras) opera su comité
    if (createdBy !== user.id && !hasAnyRole(user, 'lider_procura')) {
      throw new ForbiddenException('Solo el autor puede operar este comité');
    }
  }

  private async assertEditable(id: string, user: AuthUser) {
    const committee = await this.prisma.purchase_committees.findFirst({
      where: { id, is_active: true },
    });
    if (!committee) throw new NotFoundException('Comité no encontrado');
    this.assertAuthor(committee.created_by, user);
    if (!['borrador', 'rechazado'].includes(committee.status)) {
      throw new BadRequestException(
        'Solo se puede editar en borrador o rechazado',
      );
    }
    return committee;
  }

  private loadForAction(tx: Prisma.TransactionClient, id: string) {
    return tx.purchase_committees
      .findFirst({ where: { id, is_active: true } })
      .then((committee) => {
        if (!committee) throw new NotFoundException('Comité no encontrado');
        if (committee.status !== 'en_aprobacion') {
          throw new BadRequestException('El comité no está en aprobación');
        }
        return committee;
      });
  }

  private resolveCurrentLevel(
    committee: { current_approver_level: number | null },
    levels: LevelRow[],
  ): LevelRow {
    const level = levels.find(
      (l) => l.orden === committee.current_approver_level,
    );
    if (!level) {
      throw new BadRequestException(
        'El nivel vigente no existe en committee_approval_levels: revisa la configuración',
      );
    }
    return level;
  }

  private assertTurn(level: LevelRow, user: AuthUser) {
    // Verificación en service (no solo guard): §16 regla 3
    if (!this.levelMatchesUser(level, user)) {
      throw new ForbiddenException('No es tu turno de aprobar');
    }
  }

  /** Horas desde que el nivel vigente recibió el comité. */
  private async elapsedForLevel(
    tx: Prisma.TransactionClient,
    committee: {
      id: string;
      current_version: number;
      submitted_at: Date | null;
    },
  ): Promise<number | null> {
    const last = await tx.committee_approvals.findFirst({
      where: {
        committee_id: committee.id,
        version: committee.current_version,
      },
      orderBy: { action_at: 'desc' },
      select: { action_at: true },
    });
    const assignedAt = last?.action_at ?? committee.submitted_at;
    return assignedAt ? roundHours(Date.now() - assignedAt.getTime()) : null;
  }

  private async generateCommitteeNumber(date: Date): Promise<string> {
    const { year, week } = isoWeek(date);
    const base = `COM-${year}-W${String(week).padStart(2, '0')}`;
    for (let suffix = 0; suffix < 20; suffix++) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      const exists = await this.prisma.purchase_committees.findFirst({
        where: { committee_number: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new BadRequestException(`Demasiados comités para la semana ${base}`);
  }

  private validateFile(file: Express.Multer.File) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Solo .pdf o .pptx (§16)',
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        'El archivo excede el tamaño máximo de 30MB',
      );
    }
  }

  /** Correo a quien(es) cubren un nivel: usuario específico o todos con el rol. */
  private async notifyLevel(
    level: LevelRow,
    subject: string,
    lines: string[],
  ): Promise<void> {
    try {
      const recipients = level.profile_id
        ? await this.prisma.profiles.findMany({
            where: { id: level.profile_id, is_active: true },
            select: { email: true, full_name: true },
          })
        : await this.prisma.profiles.findMany({
            where: {
              is_active: true,
              OR: [
                {
                  user_roles_user_roles_profile_idToprofiles: {
                    some: { is_active: true, role: level.role },
                  },
                },
                { role: level.role },
              ],
            },
            select: { email: true, full_name: true },
          });
      for (const recipient of recipients) {
        await this.sendPlainEmail(recipient, subject, lines);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Notificación de nivel falló (best-effort): ${msg}`);
    }
  }

  /** Resolución: aprobado → autor + todos los que actuaron; rechazo → autor. */
  private async notifyResolution(
    committee: CommitteeRow,
    outcome: 'aprobado' | 'rechazado',
    justification: string | null,
  ): Promise<void> {
    try {
      const recipients = new Map<
        string,
        { email: string; full_name: string | null }
      >();
      recipients.set(committee.profiles.email, committee.profiles);
      if (outcome === 'aprobado') {
        const actors = await this.prisma.committee_approvals.findMany({
          where: { committee_id: committee.id },
          select: { profiles: { select: { email: true, full_name: true } } },
        });
        for (const actor of actors) {
          recipients.set(actor.profiles.email, actor.profiles);
        }
      }
      const subject =
        outcome === 'aprobado'
          ? `[ABENT 3T] Comité ${committee.committee_number} APROBADO`
          : `[ABENT 3T] Comité ${committee.committee_number} rechazado`;
      const lines =
        outcome === 'aprobado'
          ? [
              `El comité "${committee.title}" fue aprobado por todos los niveles.`,
              `Horas totales del flujo: ${toNumber(committee.total_elapsed_hours) ?? '—'}.`,
            ]
          : [
              `El comité "${committee.title}" fue rechazado y regresó al autor.`,
              `Justificación: ${justification ?? '—'}`,
              'Sube una nueva versión y reenvíalo para reiniciar la cadena.',
            ];
      for (const recipient of recipients.values()) {
        await this.sendPlainEmail(recipient, subject, lines);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Notificación de resolución falló (best-effort): ${msg}`,
      );
    }
  }

  private async sendPlainEmail(
    recipient: { email: string; full_name: string | null },
    subject: string,
    lines: string[],
  ): Promise<void> {
    // Asuntos/cuerpos sobrios (§16 no define plantillas; consistente con §15)
    const body = [
      `<p>Estimado/a <strong>${recipient.full_name ?? recipient.email}</strong>,</p>`,
      ...lines.map((line) => `<p>${line}</p>`),
      `<p><a href="${process.env.FRONTEND_URL?.split(',')[0] ?? 'http://localhost:3000'}/compras/comite">Abrir el Comité de Compras</a></p>`,
      '<p style="color:#666;font-size:12px">Mensaje automático del sistema de compras ABENT 3T.</p>',
    ].join('\n');
    await this.emailService.sendEmail({
      to: { email: recipient.email, name: recipient.full_name ?? undefined },
      subject,
      body,
      isHtml: true,
    });
  }

  private async auditLog(
    action: 'create' | 'update' | 'approve' | 'reject' | 'upload',
    entityId: string,
    entityName: string,
    user: AuthUser,
    extra: {
      description?: string;
      old_values?: Record<string, unknown>;
      new_values?: Record<string, unknown>;
      ip_address?: string;
      user_agent?: string;
    } = {},
  ): Promise<void> {
    // Primera entidad de compras auditada (§16). AuditService ya es
    // try/catch por dentro: nunca rompe el flujo.
    await this.audit.log({
      action,
      entity_type: 'committee',
      entity_id: entityId,
      entity_name: entityName,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      ...extra,
    });
  }
}
