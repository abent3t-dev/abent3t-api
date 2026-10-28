import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { FPA_ADMIN, FPA_SEE_ALL } from './fpa-roles';
import {
  diffParams,
  paramsGaps,
  paramsHash,
  paramsSnapshot,
  type ParamsSnapshot,
} from './fpa-versions';
import type {
  FpaApproveParamsDto,
  FpaCreateVersionDto,
  FpaUpdateVersionDto,
  FpaVersionParamsDto,
} from './dto/fpa-version.dto';

/**
 * FP&A (B2) — versiones y sus parámetros, con el visto bueno de planeación.
 * Diseño: documentation/FPA.md, "Bloque B: avance" (B2) y "Diseño" §5.
 *
 * - Laura (planeación) carga los parámetros mientras la versión está en
 *   preparación: inflación, mes de corte (forecast), tipos de cambio, tarifas
 *   de viaje y la fuente. Cualquier cambio quita el visto bueno.
 * - El firmante de planeación (David; fpa_assignments duty 'planeacion') da el
 *   visto bueno con un clic sobre lo que revisó (hash). Sin firmantes
 *   registrados, lo da cualquiera de planeación. Nunca quien hizo el último
 *   cambio.
 * - Abrir a captura exige el visto bueno y los parámetros completos; crea el
 *   presupuesto en borrador de cada área activa que no lo tenga.
 * - Abierta, los parámetros no cambian. Regresar a preparación (para
 *   corregirlos) solo se puede mientras ningún presupuesto se haya enviado:
 *   es el candado.
 * - Cada paso: en una transacción, bloquea la fila de la versión (FOR UPDATE),
 *   revisa el estado con lo que hay en la base, la cambia y guarda el evento
 *   en fpa_version_events (solo inserción).
 */

type Tx = Prisma.TransactionClient;

const PARAMS_INCLUDE = {
  fpa_exchange_rates: {
    where: { is_active: true },
    orderBy: { currency: 'asc' },
  },
  fpa_travel_rates: { where: { is_active: true } },
} satisfies Prisma.fpa_versionsInclude;

type VersionWithParams = Prisma.fpa_versionsGetPayload<{
  include: typeof PARAMS_INCLUDE;
}>;

const PERSON_SELECT = { id: true, full_name: true, email: true } as const;

export interface Person {
  id: string;
  full_name: string;
}

const toPerson = (
  p: { id: string; full_name: string | null; email: string } | null,
): Person | null =>
  p ? { id: p.id, full_name: p.full_name ?? p.email } : null;

/** Presupuestos que están en algún paso de aprobación. */
const IN_FLOW = ['enviado', 'aprobado_area', 'aprobado_planeacion'];

const EVENT_SCHEMA = 1;

const STATUS_LABEL: Record<string, string> = {
  preparacion: 'en preparación',
  captura: 'abierta a captura',
  cerrada: 'cerrada',
};

export interface Check {
  ok: boolean;
  reason: string | null;
}
const yes: Check = { ok: true, reason: null };
const no = (reason: string): Check => ({ ok: false, reason });

export interface Usage {
  budgets: number;
  /** Presupuestos que alguna vez se enviaron (ronda > 0 o fuera de borrador). */
  budgets_sent: number;
  /** Presupuestos en un paso de aprobación (enviado o aprobado sin terminar). */
  budgets_in_flow: number;
  lines: number;
  /** Monedas distintas de MXN que usan las líneas vivas. */
  currencies: string[];
}

export interface Signers {
  titular: Person | null;
  suplentes: Person[];
  rows: Array<{ profile_id: string; is_alternate: boolean }>;
}

@Injectable()
export class FpaVersionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  private canAdmin(user: AuthUser): boolean {
    return hasAnyRole(user, ...FPA_ADMIN);
  }

  /** Rol con el que actúa en una versión (planeación o soporte). */
  private actorRole(user: AuthUser): string {
    return hasAnyRole(user, 'fpa_planeacion')
      ? 'fpa_planeacion'
      : 'super_admin';
  }

  private async load(
    id: string,
    db: Tx | PrismaService = this.prisma,
  ): Promise<VersionWithParams> {
    const v = await db.fpa_versions.findFirst({
      where: { id, is_active: true },
      include: PARAMS_INCLUDE,
    });
    if (!v) throw new NotFoundException('Versión no encontrada');
    return v;
  }

  /** Bloquea la fila de la versión hasta el fin de la transacción y la relee. */
  private async lock(tx: Tx, id: string): Promise<VersionWithParams> {
    await tx.$queryRaw`SELECT id FROM fpa_versions WHERE id = ${id}::uuid FOR UPDATE`;
    return this.load(id, tx);
  }

  private snapshot(v: VersionWithParams): ParamsSnapshot {
    return paramsSnapshot({
      inflation_pct: v.inflation_pct,
      cutoff_month: v.cutoff_month,
      params_source: v.params_source,
      exchange_rates: v.fpa_exchange_rates,
      travel_rates: v.fpa_travel_rates,
    });
  }

  private async usage(
    versionId: string,
    db: Tx | PrismaService = this.prisma,
  ): Promise<Usage> {
    const [budgets, lines] = await Promise.all([
      db.fpa_budgets.findMany({
        where: { version_id: versionId, is_active: true },
        select: { status: true, current_round: true },
      }),
      db.fpa_budget_lines.findMany({
        where: {
          version_id: versionId,
          is_active: true,
          fpa_budgets: { is_active: true },
        },
        select: { currency: true },
      }),
    ]);
    return {
      budgets: budgets.length,
      budgets_sent: budgets.filter(
        (b) => b.status !== 'borrador' || b.current_round > 0,
      ).length,
      budgets_in_flow: budgets.filter((b) => IN_FLOW.includes(b.status)).length,
      lines: lines.length,
      currencies: [
        ...new Set(lines.map((l) => l.currency).filter((c) => c !== 'MXN')),
      ].sort(),
    };
  }

  /** Firmantes de planeación registrados (titular y suplentes). */
  private async signers(
    db: Tx | PrismaService = this.prisma,
  ): Promise<Signers> {
    const rows = await db.fpa_assignments.findMany({
      where: { duty: 'planeacion', area_id: null, is_active: true },
      include: {
        profiles_fpa_assignments_profile_idToprofiles: {
          select: PERSON_SELECT,
        },
      },
      orderBy: { created_at: 'asc' },
    });
    const titular = rows.find((r) => !r.is_alternate);
    return {
      titular: titular
        ? toPerson(titular.profiles_fpa_assignments_profile_idToprofiles)
        : null,
      suplentes: rows
        .filter((r) => r.is_alternate)
        .map((r) => toPerson(r.profiles_fpa_assignments_profile_idToprofiles))
        .filter((p): p is Person => p !== null),
      rows: rows.map((r) => ({
        profile_id: r.profile_id,
        is_alternate: r.is_alternate,
      })),
    };
  }

  /**
   * ¿Puede esta persona dar el visto bueno ahora? Regresa con qué derecho
   * actúa (titular, suplente, rol o super_admin) o por qué no.
   */
  private approvalRight(
    user: AuthUser,
    v: VersionWithParams,
    gaps: string[],
    signers: Signers,
  ): { check: Check; acting_as: string | null } {
    const deny = (reason: string) => ({ check: no(reason), acting_as: null });
    if (!this.canAdmin(user)) return deny('Solo planeación da el visto bueno');
    if (v.status === 'cerrada') return deny('Una versión cerrada ya no cambia');
    if (v.kind === 'comparacion') {
      return deny('Una versión de comparación no lleva visto bueno');
    }
    if (v.params_approved_at)
      return deny('Los parámetros ya tienen visto bueno');
    if (gaps.length > 0) {
      return deny(`Antes hay que completar los parámetros: ${gaps.join('; ')}`);
    }
    if (v.params_updated_by && v.params_updated_by === user.id) {
      return deny(
        'Tú hiciste el último cambio a los parámetros: el visto bueno lo da otra persona',
      );
    }
    if (signers.rows.length > 0) {
      const mine = signers.rows.find((s) => s.profile_id === user.id);
      if (mine) {
        return {
          check: yes,
          acting_as: mine.is_alternate ? 'suplente' : 'titular',
        };
      }
      if (hasAnyRole(user, 'super_admin')) {
        return { check: yes, acting_as: 'super_admin' };
      }
      return deny(
        signers.titular
          ? `El visto bueno lo da el firmante de planeación: ${signers.titular.full_name}`
          : 'El visto bueno lo da un firmante de planeación',
      );
    }
    return {
      check: yes,
      acting_as: hasAnyRole(user, 'fpa_planeacion') ? 'rol' : 'super_admin',
    };
  }

  private actions(
    user: AuthUser,
    v: VersionWithParams,
    gaps: string[],
    usage: Usage,
    signers: Signers,
  ) {
    const admin = this.canAdmin(user);
    const onlyAdmin = no('Solo planeación cambia las versiones');
    const closed = no('Una versión cerrada ya no cambia');
    const editParams: Check = !admin
      ? onlyAdmin
      : v.status === 'preparacion'
        ? yes
        : v.status === 'captura'
          ? no(
              usage.budgets_sent > 0
                ? 'La versión está abierta y ya hay presupuestos enviados: sus parámetros ya no cambian'
                : 'La versión está abierta a captura: para cambiar los parámetros, regrésala a preparación',
            )
          : closed;
    const open: Check = !admin
      ? onlyAdmin
      : v.status !== 'preparacion'
        ? no(`La versión ya está ${STATUS_LABEL[v.status] ?? v.status}`)
        : v.kind === 'comparacion'
          ? no('Una versión de comparación no se abre a captura')
          : gaps.length > 0
            ? no(`Faltan parámetros: ${gaps.join('; ')}`)
            : !v.params_approved_at
              ? no('Falta el visto bueno de planeación a los parámetros')
              : yes;
    const giveBack: Check = !admin
      ? onlyAdmin
      : v.status !== 'captura'
        ? no('Solo una versión abierta a captura regresa a preparación')
        : usage.budgets_sent > 0
          ? no(
              'Ya hay presupuestos enviados: los parámetros ya no cambian y la versión no regresa a preparación',
            )
          : yes;
    const close: Check = !admin
      ? onlyAdmin
      : v.status !== 'captura'
        ? no('Solo se cierra una versión abierta a captura')
        : usage.budgets_in_flow > 0
          ? no(
              `Hay ${usage.budgets_in_flow} presupuesto(s) en aprobación: ciérrala cuando terminen`,
            )
          : yes;
    const reopen: Check = !admin
      ? onlyAdmin
      : v.status !== 'cerrada'
        ? no('Solo se reabre una versión cerrada')
        : yes;
    return {
      edit_params: editParams,
      edit_info: !admin ? onlyAdmin : v.status === 'cerrada' ? closed : yes,
      approve: this.approvalRight(user, v, gaps, signers).check,
      open,
      give_back: giveBack,
      close,
      reopen,
    };
  }

  private paramsDto(snap: ParamsSnapshot) {
    return {
      inflation_pct: snap.inflation_pct,
      cutoff_month: snap.cutoff_month,
      source: snap.source,
      exchange_rates: snap.exchange_rates,
      travel_rates: snap.travel_rates,
      hash: paramsHash(snap),
    };
  }

  /** GET /fpa/versiones/:id — detalle para la pantalla Versiones (planeación y CFO). */
  async detail(user: AuthUser, id: string) {
    if (!hasAnyRole(user, ...FPA_SEE_ALL)) {
      throw new ForbiddenException(
        'Solo planeación y el CFO ven las versiones',
      );
    }
    const v = await this.load(id);
    const [usage, signers, people, events, base] = await Promise.all([
      this.usage(id),
      this.signers(),
      this.prisma.profiles.findMany({
        where: {
          id: {
            in: [v.params_updated_by, v.params_approved_by].filter(
              (x): x is string => !!x,
            ),
          },
        },
        select: PERSON_SELECT,
      }),
      this.prisma.fpa_version_events.findMany({
        where: { version_id: id },
        include: { profiles: { select: PERSON_SELECT } },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
      v.base_version_id
        ? this.prisma.fpa_versions.findUnique({
            where: { id: v.base_version_id },
            select: { id: true, code: true },
          })
        : Promise.resolve(null),
    ]);
    const personOf = (pid: string | null) =>
      toPerson(people.find((p) => p.id === pid) ?? null);
    const snap = this.snapshot(v);
    const gaps = paramsGaps(snap, v.kind, { currencies: usage.currencies });
    return {
      version: {
        id: v.id,
        code: v.code,
        name: v.name,
        fiscal_year: v.fiscal_year,
        kind: v.kind,
        status: v.status,
        notes: v.notes,
        base_version: base,
        created_at: v.created_at.toISOString(),
      },
      params: this.paramsDto(snap),
      params_updated:
        v.params_updated_at !== null
          ? {
              by: personOf(v.params_updated_by),
              at: v.params_updated_at.toISOString(),
            }
          : null,
      params_approved:
        v.params_approved_at !== null && v.params_approved_by
          ? {
              by: personOf(v.params_approved_by),
              at: v.params_approved_at.toISOString(),
            }
          : null,
      gaps,
      usage,
      signers: {
        titular: signers.titular,
        suplentes: signers.suplentes,
        rule: signers.rows.length > 0 ? 'registrados' : 'rol',
      },
      actions: this.actions(user, v, gaps, usage, signers),
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        from_status: e.from_status,
        to_status: e.to_status,
        detail: e.detail,
        comment: e.comment,
        actor: toPerson(e.profiles),
        acting_as: e.acting_as,
        created_at: e.created_at.toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Cambios
  // ---------------------------------------------------------------------------

  private assertAdmin(user: AuthUser) {
    if (!this.canAdmin(user)) {
      throw new ForbiddenException('Solo planeación cambia las versiones');
    }
  }

  private async event(
    tx: Tx,
    user: AuthUser,
    data: {
      version_id: string;
      action: string;
      from_status?: string | null;
      to_status?: string | null;
      detail?: Prisma.InputJsonObject | null;
      comment?: string | null;
      acting_as?: string;
    },
  ) {
    const actingAs =
      data.acting_as ??
      (hasAnyRole(user, 'fpa_planeacion') ? 'rol' : 'super_admin');
    await tx.fpa_version_events.create({
      data: {
        version_id: data.version_id,
        action: data.action,
        from_status: data.from_status ?? null,
        to_status: data.to_status ?? null,
        detail: data.detail ?? Prisma.DbNull,
        comment: data.comment ?? null,
        actor_profile_id: user.id,
        // Como soporte el rol es super_admin, aunque también tenga planeación
        actor_role:
          actingAs === 'super_admin' ? 'super_admin' : this.actorRole(user),
        acting_as: actingAs,
      },
    });
  }

  /** POST /fpa/versiones — alta en preparación; opcional, con los parámetros de otra. */
  async create(user: AuthUser, dto: FpaCreateVersionDto) {
    this.assertAdmin(user);
    const isForecast = dto.kind === 'forecast';
    const cutoff = dto.cutoff_month ?? null;
    if (isForecast && cutoff === null) {
      throw new BadRequestException(
        'Un forecast lleva mes de corte: el último mes con real (1 a 11)',
      );
    }
    if (!isForecast && cutoff !== null) {
      throw new BadRequestException('Solo un forecast lleva mes de corte');
    }
    const exists = await this.prisma.fpa_versions.findFirst({
      where: { code: { equals: dto.code, mode: 'insensitive' } },
      select: { code: true },
    });
    if (exists) {
      throw new ConflictException(`Ya existe la versión ${exists.code}`);
    }
    const from = dto.copy_params_from
      ? await this.load(dto.copy_params_from)
      : null;
    const now = new Date();
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const v = await tx.fpa_versions.create({
          data: {
            fiscal_year: dto.fiscal_year,
            kind: dto.kind,
            code: dto.code,
            name: dto.name,
            cutoff_month: cutoff,
            status: 'preparacion',
            inflation_pct: from?.inflation_pct ?? null,
            params_source: from?.params_source ?? null,
            params_updated_by: from ? user.id : null,
            params_updated_at: from ? now : null,
            created_by: user.id,
          },
        });
        if (from) {
          if (from.fpa_exchange_rates.length > 0) {
            await tx.fpa_exchange_rates.createMany({
              data: from.fpa_exchange_rates.map((r) => ({
                version_id: v.id,
                currency: r.currency,
                rate_mxn: r.rate_mxn,
                created_by: user.id,
              })),
            });
          }
          if (from.fpa_travel_rates.length > 0) {
            await tx.fpa_travel_rates.createMany({
              data: from.fpa_travel_rates.map((t) => ({
                version_id: v.id,
                trip_type: t.trip_type,
                traveler_type: t.traveler_type,
                flight_per_person: t.flight_per_person,
                hotel_per_night: t.hotel_per_night,
                transport_per_day: t.transport_per_day,
                meals_per_day: t.meals_per_day,
                created_by: user.id,
              })),
            });
          }
        }
        await this.event(tx, user, {
          version_id: v.id,
          action: 'creada',
          to_status: 'preparacion',
          detail: from
            ? {
                schema: EVENT_SCHEMA,
                copia_de: { id: from.id, code: from.code },
              }
            : null,
        });
        return v.id;
      });
      return this.detail(user, id);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(`Ya existe la versión ${dto.code}`);
      }
      throw e;
    }
  }

  /** PUT /fpa/versiones/:id — nombre y notas (no son parámetros). */
  async update(user: AuthUser, id: string, dto: FpaUpdateVersionDto) {
    this.assertAdmin(user);
    const v = await this.load(id);
    if (v.status === 'cerrada') {
      throw new ConflictException('Una versión cerrada ya no cambia');
    }
    if (dto.name === null || (dto.name !== undefined && !dto.name)) {
      throw new BadRequestException('El nombre no puede quedar vacío');
    }
    await this.prisma.fpa_versions.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    return this.detail(user, id);
  }

  /** Valida el juego de parámetros y arma su foto. */
  private nextParams(
    v: VersionWithParams,
    dto: FpaVersionParamsDto,
  ): ParamsSnapshot {
    const errors: string[] = [];
    const isForecast = v.kind === 'forecast';
    const cutoff =
      dto.cutoff_month === undefined ? v.cutoff_month : dto.cutoff_month;
    if (isForecast && cutoff === null) {
      errors.push('Un forecast lleva mes de corte (1 a 11)');
    }
    if (!isForecast && cutoff !== null) {
      errors.push('Solo un forecast lleva mes de corte');
    }
    const currencies = new Set<string>();
    for (const r of dto.exchange_rates) {
      if (['MXN', 'MXP'].includes(r.currency)) {
        errors.push('El peso no lleva tipo de cambio (vale 1)');
      } else if (currencies.has(r.currency)) {
        errors.push(`La moneda ${r.currency} viene dos veces`);
      }
      currencies.add(r.currency);
      if (!new Prisma.Decimal(r.rate_mxn).greaterThan(0)) {
        errors.push(`El tipo de cambio de ${r.currency} debe ser mayor a 0`);
      }
    }
    const combos = new Set<string>();
    for (const t of dto.travel_rates) {
      const key = `${t.trip_type}|${t.traveler_type}`;
      if (combos.has(key)) {
        errors.push(
          `La tarifa de viaje ${t.trip_type} para ${t.traveler_type} viene dos veces`,
        );
      }
      combos.add(key);
    }
    if (errors.length > 0) throw new BadRequestException(errors.join('. '));
    return paramsSnapshot({
      inflation_pct:
        dto.inflation_pct === undefined ? v.inflation_pct : dto.inflation_pct,
      cutoff_month: cutoff,
      params_source:
        dto.params_source === undefined ? v.params_source : dto.params_source,
      exchange_rates: dto.exchange_rates,
      travel_rates: dto.travel_rates,
    });
  }

  /**
   * PUT /fpa/versiones/:id/parametros — el juego completo de parámetros, solo
   * en preparación. Si nada cambió, no hace nada (y el visto bueno se queda).
   * Si algo cambió, quita el visto bueno y lo deja en el historial.
   */
  async setParams(user: AuthUser, id: string, dto: FpaVersionParamsDto) {
    this.assertAdmin(user);
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        if (v.status !== 'preparacion') {
          throw new ConflictException(
            v.status === 'captura'
              ? 'La versión está abierta a captura: para cambiar los parámetros, regrésala a preparación'
              : 'Una versión cerrada ya no cambia',
          );
        }
        const current = this.snapshot(v);
        if (dto.expected_hash && dto.expected_hash !== paramsHash(current)) {
          throw new ConflictException(
            'Otra persona cambió los parámetros mientras los tenías en pantalla: vuelve a cargarlos',
          );
        }
        const next = this.nextParams(v, dto);
        const cambios = diffParams(current, next);
        if (cambios.length === 0) return; // nada cambió: el visto bueno se queda
        const now = new Date();
        await tx.fpa_versions.update({
          where: { id },
          data: {
            inflation_pct: next.inflation_pct,
            cutoff_month: next.cutoff_month,
            params_source: next.source,
            params_updated_by: user.id,
            params_updated_at: now,
            params_approved_by: null,
            params_approved_at: null,
          },
        });
        // Tipos de cambio: una fila por moneda (upsert; la que se quitó, de baja)
        const rates = await tx.fpa_exchange_rates.findMany({
          where: { version_id: id },
        });
        for (const r of next.exchange_rates) {
          const row = rates.find((x) => x.currency === r.currency);
          if (!row) {
            await tx.fpa_exchange_rates.create({
              data: {
                version_id: id,
                currency: r.currency,
                rate_mxn: r.rate_mxn,
                created_by: user.id,
              },
            });
          } else if (!row.is_active || row.rate_mxn.toFixed(6) !== r.rate_mxn) {
            await tx.fpa_exchange_rates.update({
              where: { id: row.id },
              data: { rate_mxn: r.rate_mxn, is_active: true },
            });
          }
        }
        for (const row of rates) {
          if (
            row.is_active &&
            !next.exchange_rates.some((r) => r.currency === row.currency)
          ) {
            await tx.fpa_exchange_rates.update({
              where: { id: row.id },
              data: { is_active: false },
            });
          }
        }
        // Tarifas de viaje: una fila por tipo de viaje y de viajero
        const travel = await tx.fpa_travel_rates.findMany({
          where: { version_id: id },
        });
        for (const t of next.travel_rates) {
          const row = travel.find(
            (x) =>
              x.trip_type === t.trip_type &&
              x.traveler_type === t.traveler_type,
          );
          const amounts = {
            flight_per_person: t.flight_per_person,
            hotel_per_night: t.hotel_per_night,
            transport_per_day: t.transport_per_day,
            meals_per_day: t.meals_per_day,
          };
          if (!row) {
            await tx.fpa_travel_rates.create({
              data: {
                version_id: id,
                trip_type: t.trip_type,
                traveler_type: t.traveler_type,
                ...amounts,
                created_by: user.id,
              },
            });
          } else {
            const same =
              row.is_active &&
              row.flight_per_person.toFixed(2) === t.flight_per_person &&
              row.hotel_per_night.toFixed(2) === t.hotel_per_night &&
              row.transport_per_day.toFixed(2) === t.transport_per_day &&
              row.meals_per_day.toFixed(2) === t.meals_per_day;
            if (!same) {
              await tx.fpa_travel_rates.update({
                where: { id: row.id },
                data: { ...amounts, is_active: true },
              });
            }
          }
        }
        for (const row of travel) {
          if (
            row.is_active &&
            !next.travel_rates.some(
              (t) =>
                t.trip_type === row.trip_type &&
                t.traveler_type === row.traveler_type,
            )
          ) {
            await tx.fpa_travel_rates.update({
              where: { id: row.id },
              data: { is_active: false },
            });
          }
        }
        await this.event(tx, user, {
          version_id: id,
          action: 'parametros',
          detail: {
            schema: EVENT_SCHEMA,
            antes: current as unknown as Prisma.InputJsonObject,
            despues: next as unknown as Prisma.InputJsonObject,
            cambios: cambios as unknown as Prisma.InputJsonArray,
            visto_bueno_retirado:
              v.params_approved_at && v.params_approved_by
                ? {
                    por: v.params_approved_by,
                    el: v.params_approved_at.toISOString(),
                  }
                : null,
          },
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }

  /**
   * POST /fpa/versiones/:id/visto-bueno — el firmante de planeación aprueba los
   * parámetros que revisó (params_hash). En preparación o, para la versión que
   * ya estaba abierta sin visto bueno (la B-26 de prod), en captura.
   */
  async approve(user: AuthUser, id: string, dto: FpaApproveParamsDto) {
    this.assertAdmin(user);
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        const snap = this.snapshot(v);
        const usage = await this.usage(id, tx);
        const gaps = paramsGaps(snap, v.kind, { currencies: usage.currencies });
        const signers = await this.signers(tx);
        const hash = paramsHash(snap);
        const right = this.approvalRight(user, v, gaps, signers);
        if (!right.check.ok || !right.acting_as) {
          const reason = right.check.reason ?? 'No puedes dar el visto bueno';
          // 409 si es por el estado de la versión; 403 si es por la persona
          throw v.params_approved_at ||
            v.status === 'cerrada' ||
            v.kind === 'comparacion' ||
            gaps.length > 0
            ? new ConflictException(reason)
            : new ForbiddenException(reason);
        }
        if (dto.params_hash !== hash) {
          throw new ConflictException(
            'Los parámetros cambiaron mientras los revisabas: vuelve a cargarlos antes de dar el visto bueno',
          );
        }
        const now = new Date();
        await tx.fpa_versions.update({
          where: { id },
          data: { params_approved_by: user.id, params_approved_at: now },
        });
        await this.event(tx, user, {
          version_id: id,
          action: 'visto_bueno',
          acting_as: right.acting_as,
          detail: {
            schema: EVENT_SCHEMA,
            parametros: snap as unknown as Prisma.InputJsonObject,
            hash,
          },
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }

  /**
   * Crea el presupuesto en borrador de cada área activa que no lo tenga en la
   * versión: al abrirla y al reabrirla (un área dada de alta mientras estaba
   * cerrada no lo recibió). Regresa cuántos creó.
   */
  private async createMissingBudgets(
    tx: Tx,
    user: AuthUser,
    id: string,
  ): Promise<number> {
    const areas = await tx.fpa_areas.findMany({
      where: { is_active: true },
      select: { id: true },
    });
    const existing = await tx.fpa_budgets.findMany({
      where: { version_id: id, is_active: true },
      select: { area_id: true },
    });
    const missing = areas.filter(
      (a) => !existing.some((b) => b.area_id === a.id),
    );
    if (missing.length > 0) {
      await tx.fpa_budgets.createMany({
        data: missing.map((a) => ({
          version_id: id,
          area_id: a.id,
          created_by: user.id,
        })),
      });
    }
    return missing.length;
  }

  /**
   * POST /fpa/versiones/:id/abrir — preparación › captura. Exige los
   * parámetros completos y su visto bueno; crea el presupuesto en borrador de
   * cada área activa que no lo tenga.
   */
  async open(user: AuthUser, id: string) {
    this.assertAdmin(user);
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        const usage = await this.usage(id, tx);
        const signers = await this.signers(tx);
        const gaps = paramsGaps(this.snapshot(v), v.kind, {
          currencies: usage.currencies,
        });
        const check = this.actions(user, v, gaps, usage, signers).open;
        if (!check.ok) throw new ConflictException(check.reason);
        await tx.fpa_versions.update({
          where: { id },
          data: { status: 'captura' },
        });
        const created = await this.createMissingBudgets(tx, user, id);
        await this.event(tx, user, {
          version_id: id,
          action: 'abierta',
          from_status: 'preparacion',
          to_status: 'captura',
          detail: {
            schema: EVENT_SCHEMA,
            presupuestos_creados: created,
          },
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }

  /**
   * POST /fpa/versiones/:id/regresar — captura › preparación, para corregir
   * los parámetros. Solo mientras ningún presupuesto se haya enviado (el
   * candado); las áreas dejan de ver la versión hasta que se vuelva a abrir.
   */
  async giveBack(user: AuthUser, id: string, comment: string | null) {
    this.assertAdmin(user);
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        const usage = await this.usage(id, tx);
        const check = this.actions(
          user,
          v,
          [],
          usage,
          await this.signers(tx),
        ).give_back;
        if (!check.ok) throw new ConflictException(check.reason);
        await tx.fpa_versions.update({
          where: { id },
          data: { status: 'preparacion' },
        });
        await this.event(tx, user, {
          version_id: id,
          action: 'regresada',
          from_status: 'captura',
          to_status: 'preparacion',
          comment,
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }

  /** POST /fpa/versiones/:id/cerrar — captura › cerrada (todo de solo lectura). */
  async close(user: AuthUser, id: string, comment: string | null) {
    this.assertAdmin(user);
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        const usage = await this.usage(id, tx);
        const check = this.actions(
          user,
          v,
          [],
          usage,
          await this.signers(tx),
        ).close;
        if (!check.ok) throw new ConflictException(check.reason);
        await tx.fpa_versions.update({
          where: { id },
          data: { status: 'cerrada' },
        });
        await this.event(tx, user, {
          version_id: id,
          action: 'cerrada',
          from_status: 'captura',
          to_status: 'cerrada',
          comment,
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }

  /**
   * POST /fpa/versiones/:id/reabrir — cerrada › captura, con comentario. Crea
   * el presupuesto de las áreas dadas de alta mientras estuvo cerrada.
   */
  async reopen(user: AuthUser, id: string, comment: string) {
    this.assertAdmin(user);
    if (!comment?.trim()) {
      throw new BadRequestException('Escribe por qué se reabre la versión');
    }
    await this.prisma.$transaction(
      async (tx) => {
        const v = await this.lock(tx, id);
        if (v.status !== 'cerrada') {
          throw new ConflictException('Solo se reabre una versión cerrada');
        }
        await tx.fpa_versions.update({
          where: { id },
          data: { status: 'captura' },
        });
        const created =
          v.kind === 'comparacion'
            ? 0
            : await this.createMissingBudgets(tx, user, id);
        await this.event(tx, user, {
          version_id: id,
          action: 'reabierta',
          from_status: 'cerrada',
          to_status: 'captura',
          comment: comment.trim(),
          detail:
            created > 0
              ? { schema: EVENT_SCHEMA, presupuestos_creados: created }
              : null,
        });
      },
      { timeout: 20_000 },
    );
    return this.detail(user, id);
  }
}
