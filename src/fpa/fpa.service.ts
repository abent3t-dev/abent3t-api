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
import {
  NO_DISPONIBLE,
  buildExcel,
  excelFilename,
  type ExcelColumn,
} from '../common/utils/excel-export.util';
import {
  calcLine,
  lineDataErrors,
  money,
  sumMonths,
  MONTHS,
  type CalcLineInput,
  type CalcLineResult,
  type CalcVersion,
} from './fpa-calc';
import { FPA_ADMIN, FPA_MODULE_ROLES, FPA_SEE_ALL } from './fpa-roles';
import type { FpaCalcInputDto, FpaLineInputDto } from './dto/fpa-line.dto';

/** Lo que usa el cálculo de una línea (alta, cambio o POST /fpa/calcular). */
type CalcFields = Pick<
  FpaLineInputDto,
  'calc_method' | 'currency' | 'price_index' | 'unit_price' | 'trip' | 'months'
>;

/**
 * FP&A (A3, lunes 26-oct) — presupuesto por área. Diseño:
 * documentation/FPA.md, "Diseño" (§3 quién ve y edita, §6 cálculos, §8
 * endpoints del lunes). Contrato con el front: abent3t-next/src/types/fpa.ts.
 *
 * - Se guarda solo lo capturado; los montos los calcula fpa-calc al leer.
 * - El rol da la entrada; el alcance por área sale de fpa_assignments:
 *   fpa_area ve las áreas donde tiene una responsabilidad y edita donde tiene
 *   la captura (titular o suplente); planeación edita en cualquier área pero
 *   no envía; el CFO solo lee.
 * - Solo se edita un presupuesto en borrador o devuelto, con la versión en
 *   captura. El flujo de aprobación (enviar, aprobar, rechazar) es del bloque B.
 */

type Decimal = Prisma.Decimal;
type Money = string | null;

const EDITABLE_BUDGET = ['borrador', 'devuelto'];

const BUDGET_STATUS_LABEL: Record<string, string> = {
  borrador: 'en borrador',
  enviado: 'enviado',
  aprobado_area: 'aprobado por el área',
  aprobado_planeacion: 'aprobado por planeación',
  aprobado_cfo: 'aprobado',
  devuelto: 'devuelto',
};

const MONTH_HEADERS = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

const VERSION_INCLUDE = {
  fpa_exchange_rates: {
    where: { is_active: true },
    orderBy: { currency: 'asc' },
  },
  fpa_travel_rates: { where: { is_active: true } },
} satisfies Prisma.fpa_versionsInclude;

type VersionWithParams = Prisma.fpa_versionsGetPayload<{
  include: typeof VERSION_INCLUDE;
}>;

const LINE_INCLUDE = {
  fpa_line_keys: { select: { number: true } },
  fpa_departments: { select: { id: true, name: true } },
  fpa_classifications: {
    select: {
      id: true,
      name: true,
      fpa_categories: { select: { id: true, name: true, sort_order: true } },
    },
  },
  fpa_budget_line_months: { orderBy: { month: 'asc' } },
} satisfies Prisma.fpa_budget_linesInclude;

type LineWithRefs = Prisma.fpa_budget_linesGetPayload<{
  include: typeof LINE_INCLUDE;
}>;

interface Scope {
  /** Ve todas las áreas (planeación, CFO, super_admin o consulta general). */
  all: boolean;
  /** Áreas donde tiene alguna responsabilidad vigente. */
  areaIds: Set<string>;
  /** Áreas donde tiene la captura (titular o suplente). */
  captureAreaIds: Set<string>;
}

const decText = (v: Decimal | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();

const isNegative = (v: string | null | undefined) =>
  v !== null && v !== undefined && new Prisma.Decimal(v).isNegative();

@Injectable()
export class FpaService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Alcance
  // ---------------------------------------------------------------------------

  private seesAll(user: AuthUser): boolean {
    return hasAnyRole(user, ...FPA_SEE_ALL);
  }

  private canAdmin(user: AuthUser): boolean {
    return hasAnyRole(user, ...FPA_ADMIN);
  }

  private async myAssignments(userId: string) {
    return this.prisma.fpa_assignments.findMany({
      where: { profile_id: userId, is_active: true },
      include: {
        fpa_areas: {
          select: { id: true, name: true, is_active: true, sort_order: true },
        },
      },
    });
  }

  private async scope(user: AuthUser): Promise<Scope> {
    const assignments = await this.myAssignments(user.id);
    const areaIds = new Set<string>();
    const captureAreaIds = new Set<string>();
    let generalConsulta = false;
    for (const a of assignments) {
      if (a.area_id) areaIds.add(a.area_id);
      else if (a.duty === 'consulta') generalConsulta = true;
      if (a.duty === 'captura' && a.area_id) captureAreaIds.add(a.area_id);
    }
    return {
      all: this.seesAll(user) || generalConsulta,
      areaIds,
      captureAreaIds,
    };
  }

  /** ¿Puede editar las líneas de este presupuesto ahora? (rol, área, estado y versión) */
  private canEdit(
    user: AuthUser,
    scope: Scope,
    budget: { area_id: string; status: string; is_active: boolean },
    version: { status: string },
  ): boolean {
    if (!budget.is_active) return false;
    if (!EDITABLE_BUDGET.includes(budget.status)) return false;
    if (version.status !== 'captura') return false;
    if (this.canAdmin(user)) return true;
    return (
      hasAnyRole(user, 'fpa_area') && scope.captureAreaIds.has(budget.area_id)
    );
  }

  // ---------------------------------------------------------------------------
  // Versiones, catálogo y contexto
  // ---------------------------------------------------------------------------

  private async loadVersion(
    user: AuthUser,
    versionId: string,
  ): Promise<VersionWithParams> {
    const version = await this.prisma.fpa_versions.findFirst({
      where: { id: versionId, is_active: true },
      include: VERSION_INCLUDE,
    });
    // Una versión en preparación solo la ve quien ve todo (las áreas aún no)
    if (!version || (version.status === 'preparacion' && !this.seesAll(user))) {
      throw new NotFoundException('Versión no encontrada');
    }
    return version;
  }

  private calcVersion(version: VersionWithParams): CalcVersion {
    return {
      inflation_pct: version.inflation_pct,
      cutoff_month: version.cutoff_month,
      rates: Object.fromEntries(
        version.fpa_exchange_rates.map((r) => [r.currency, r.rate_mxn]),
      ),
      travel_rates: version.fpa_travel_rates,
    };
  }

  private versionDto(version: VersionWithParams) {
    return {
      id: version.id,
      code: version.code,
      name: version.name,
      fiscal_year: version.fiscal_year,
      kind: version.kind,
      status: version.status,
      inflation_pct: version.inflation_pct
        ? version.inflation_pct.toFixed(3)
        : null,
      cutoff_month: version.cutoff_month,
      exchange_rates: version.fpa_exchange_rates.map((r) => ({
        currency: r.currency,
        rate_mxn: r.rate_mxn.toFixed(6),
      })),
    };
  }

  async context(user: AuthUser) {
    const assignments = await this.myAssignments(user.id);
    const byArea = new Map<
      string,
      { area_id: string; area_name: string; sort: number; duties: string[] }
    >();
    let generalConsulta = false;
    for (const a of assignments) {
      if (!a.area_id || !a.fpa_areas) {
        if (a.duty === 'consulta') generalConsulta = true;
        continue;
      }
      if (!a.fpa_areas.is_active) continue;
      const entry = byArea.get(a.area_id) ?? {
        area_id: a.area_id,
        area_name: a.fpa_areas.name,
        sort: a.fpa_areas.sort_order,
        duties: [],
      };
      if (!entry.duties.includes(a.duty)) entry.duties.push(a.duty);
      byArea.set(a.area_id, entry);
    }
    return {
      can_admin: this.canAdmin(user),
      sees_all: this.seesAll(user) || generalConsulta,
      areas: [...byArea.values()]
        .sort(
          (x, y) =>
            x.sort - y.sort || x.area_name.localeCompare(y.area_name, 'es'),
        )
        .map(({ area_id, area_name, duties }) => ({
          area_id,
          area_name,
          duties,
        })),
    };
  }

  async listVersions(user: AuthUser) {
    const versions = await this.prisma.fpa_versions.findMany({
      where: {
        is_active: true,
        ...(this.seesAll(user)
          ? {}
          : { status: { in: ['captura', 'cerrada'] } }),
      },
      include: VERSION_INCLUDE,
      orderBy: [{ fiscal_year: 'desc' }, { code: 'asc' }],
    });
    return versions.map((v) => this.versionDto(v));
  }

  async catalog() {
    const [categories, departments] = await Promise.all([
      this.prisma.fpa_categories.findMany({
        where: { is_active: true },
        include: {
          fpa_classifications: {
            where: { is_active: true },
            orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
          },
        },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.fpa_departments.findMany({
        where: { is_active: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.sort_order,
        classifications: c.fpa_classifications.map((k) => ({
          id: k.id,
          name: k.name,
          allows_negative: k.allows_negative,
        })),
      })),
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        area_id: d.area_id,
        cost_center: d.cost_center,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Presupuestos
  // ---------------------------------------------------------------------------

  /** Titular de captura y de aprobación de cada área (sin suplentes). */
  private async titulars(areaIds: string[]) {
    const rows = await this.prisma.fpa_assignments.findMany({
      where: {
        area_id: { in: areaIds },
        duty: { in: ['captura', 'aprobacion'] },
        is_active: true,
        is_alternate: false,
      },
      include: {
        profiles_fpa_assignments_profile_idToprofiles: {
          select: { id: true, full_name: true, email: true },
        },
      },
    });
    const map = new Map<
      string,
      {
        capturer: { id: string; full_name: string } | null;
        approver: { id: string; full_name: string } | null;
      }
    >();
    for (const r of rows) {
      if (!r.area_id) continue;
      const p = r.profiles_fpa_assignments_profile_idToprofiles;
      const person = { id: p.id, full_name: p.full_name ?? p.email };
      const entry = map.get(r.area_id) ?? { capturer: null, approver: null };
      if (r.duty === 'captura') entry.capturer = person;
      else entry.approver = person;
      map.set(r.area_id, entry);
    }
    return map;
  }

  private toCalcLine(line: {
    calc_method: string;
    currency: string;
    price_index: string;
    unit_price: Decimal | null;
    trip_type: string | null;
    travelers_colaborador: number | null;
    travelers_director: number | null;
    nights: number | null;
    fpa_budget_line_months: Array<{
      month: number;
      quantity: Decimal | null;
      unit_price: Decimal | null;
      amount: Decimal | null;
      trips: number | null;
    }>;
  }): CalcLineInput {
    return {
      calc_method: line.calc_method,
      currency: line.currency,
      price_index: line.price_index,
      unit_price: line.unit_price,
      trip_type: line.trip_type,
      travelers_colaborador: line.travelers_colaborador,
      travelers_director: line.travelers_director,
      nights: line.nights,
      months: line.fpa_budget_line_months.map((m) => ({
        month: m.month,
        quantity: m.quantity,
        unit_price: m.unit_price,
        amount: m.amount,
        trips: m.trips,
      })),
    };
  }

  /** Lo calculado de una línea, con montos en texto (2 decimales; null = "No disponible"). */
  private calcDto(calc: CalcLineResult) {
    const trip = calc.trip_breakdown;
    return {
      months: calc.months.map((m) => ({
        month: m.month,
        amount_currency: money(m.amount_currency),
        amount_mxn: money(m.amount_mxn),
      })),
      total_currency: money(calc.total_currency),
      total_mxn: money(calc.total_mxn),
      unavailable_reason: calc.unavailable_reason,
      trip_breakdown: trip
        ? {
            trip_type: trip.trip_type,
            nights: trip.nights,
            days: trip.days,
            travelers: trip.travelers.map((t) => ({
              traveler_type: t.traveler_type,
              count: t.count,
              flight_per_person: money(t.flight_per_person),
              hotel_per_night: money(t.hotel_per_night),
              meals_per_day: money(t.meals_per_day),
              flight: money(t.flight),
              hotel: money(t.hotel),
              meals: money(t.meals),
            })),
            transport: {
              traveler_type: trip.transport.traveler_type,
              per_day: money(trip.transport.per_day),
              amount: money(trip.transport.amount),
            },
            per_trip: money(trip.per_trip),
            trips: trip.trips,
          }
        : null,
    };
  }

  private lineDto(line: LineWithRefs, calc: CalcLineResult) {
    const category = line.fpa_classifications.fpa_categories;
    return {
      id: line.id,
      folio: `L-${String(line.fpa_line_keys.number).padStart(6, '0')}`,
      line_key_id: line.line_key_id,
      sort_order: line.sort_order,
      department: line.fpa_departments,
      category: { id: category.id, name: category.name },
      classification: {
        id: line.fpa_classifications.id,
        name: line.fpa_classifications.name,
      },
      concept: line.concept,
      justification: line.justification,
      supplier_id: line.supplier_id,
      supplier_name: line.supplier_name,
      priority: line.priority,
      calc_method: line.calc_method,
      currency: line.currency,
      price_index: line.price_index,
      unit_price: decText(line.unit_price),
      trip:
        line.calc_method === 'viaje'
          ? {
              trip_type: line.trip_type,
              travelers_colaborador: line.travelers_colaborador ?? 0,
              travelers_director: line.travelers_director ?? 0,
              nights: line.nights ?? 0,
              car_rental: line.car_rental ?? false,
            }
          : null,
      months_input: line.fpa_budget_line_months.map((m) => ({
        month: m.month,
        quantity: decText(m.quantity),
        unit_price: decText(m.unit_price),
        amount: decText(m.amount),
        trips: m.trips,
      })),
      ...this.calcDto(calc),
      contract_label: line.contract_label,
      project_tag: line.project_tag,
      outside_ebitda: line.outside_ebitda,
      spend_type: line.spend_type,
      source_ref: line.source_ref,
    };
  }

  async listBudgets(user: AuthUser, versionId: string) {
    const version = await this.loadVersion(user, versionId);
    const scope = await this.scope(user);
    const params = this.calcVersion(version);
    const budgets = await this.prisma.fpa_budgets.findMany({
      where: {
        version_id: versionId,
        is_active: true,
        ...(scope.all ? {} : { area_id: { in: [...scope.areaIds] } }),
      },
      include: {
        fpa_areas: {
          select: {
            id: true,
            name: true,
            department_id: true,
            sort_order: true,
          },
        },
        fpa_budget_lines: {
          where: { is_active: true },
          include: { fpa_budget_line_months: true },
        },
      },
    });
    const people = await this.titulars(budgets.map((b) => b.area_id));
    return budgets
      .sort(
        (a, b) =>
          a.fpa_areas.sort_order - b.fpa_areas.sort_order ||
          a.fpa_areas.name.localeCompare(b.fpa_areas.name, 'es'),
      )
      .map((b) => {
        const sums = sumMonths(
          b.fpa_budget_lines.map((l) =>
            calcLine(this.toCalcLine(l), params).months.map(
              (m) => m.amount_mxn,
            ),
          ),
        );
        const who = people.get(b.area_id);
        return {
          id: b.id,
          version_id: b.version_id,
          area: {
            id: b.fpa_areas.id,
            name: b.fpa_areas.name,
            department_id: b.fpa_areas.department_id,
          },
          status: b.status,
          current_round: b.current_round,
          capturer: who?.capturer ?? null,
          approver: who?.approver ?? null,
          line_count: b.fpa_budget_lines.length,
          total_mxn: money(sums.total),
          can_edit: this.canEdit(user, scope, b, version),
        };
      });
  }

  async getBudget(user: AuthUser, budgetId: string) {
    const budget = await this.prisma.fpa_budgets.findFirst({
      where: { id: budgetId, is_active: true },
      include: {
        fpa_areas: { select: { id: true, name: true, department_id: true } },
        fpa_budget_lines: {
          where: { is_active: true },
          include: LINE_INCLUDE,
          orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        },
      },
    });
    if (!budget) throw new NotFoundException('Presupuesto no encontrado');
    const version = await this.loadVersion(user, budget.version_id);
    const scope = await this.scope(user);
    if (!scope.all && !scope.areaIds.has(budget.area_id)) {
      throw new ForbiddenException(
        'No tienes acceso al presupuesto de esta área',
      );
    }
    const params = this.calcVersion(version);
    const lines = budget.fpa_budget_lines.map((l) => ({
      line: l,
      calc: calcLine(this.toCalcLine(l), params),
    }));

    // Totales por categoría, en el orden del catálogo
    const byCategory = new Map<
      string,
      { name: string; sort: number; months: Array<Array<Decimal | null>> }
    >();
    for (const { line, calc } of lines) {
      const cat = line.fpa_classifications.fpa_categories;
      const entry = byCategory.get(cat.id) ?? {
        name: cat.name,
        sort: cat.sort_order,
        months: [],
      };
      entry.months.push(calc.months.map((m) => m.amount_mxn));
      byCategory.set(cat.id, entry);
    }
    const total = sumMonths(
      lines.map(({ calc }) => calc.months.map((m) => m.amount_mxn)),
    );
    const people = await this.titulars([budget.area_id]);
    const who = people.get(budget.area_id);

    return {
      id: budget.id,
      version_id: budget.version_id,
      area: budget.fpa_areas,
      status: budget.status,
      current_round: budget.current_round,
      capturer: who?.capturer ?? null,
      approver: who?.approver ?? null,
      line_count: lines.length,
      total_mxn: money(total.total),
      can_edit: this.canEdit(user, scope, budget, version),
      version: this.versionDto(version),
      lines: lines.map(({ line, calc }) => this.lineDto(line, calc)),
      totals: {
        months_mxn: total.months.map(money),
        total_mxn: money(total.total),
        by_category: [...byCategory.entries()]
          .sort(
            ([, a], [, b]) =>
              a.sort - b.sort || a.name.localeCompare(b.name, 'es'),
          )
          .map(([id, c]) => {
            const s = sumMonths(c.months);
            return {
              category_id: id,
              category_name: c.name,
              months_mxn: s.months.map(money),
              total_mxn: money(s.total),
            };
          }),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Líneas: alta, cambio y baja
  // ---------------------------------------------------------------------------

  /** Carga el presupuesto y valida que la persona pueda editarlo ahora. */
  private async loadForEdit(user: AuthUser, budgetId: string) {
    const budget = await this.prisma.fpa_budgets.findFirst({
      where: { id: budgetId, is_active: true },
      include: { fpa_versions: { include: VERSION_INCLUDE } },
    });
    if (!budget) throw new NotFoundException('Presupuesto no encontrado');
    const version = budget.fpa_versions;
    const scope = await this.scope(user);
    const isEditor =
      this.canAdmin(user) ||
      (hasAnyRole(user, 'fpa_area') &&
        scope.captureAreaIds.has(budget.area_id));
    if (!isEditor) {
      throw new ForbiddenException(
        'Solo quien captura el área, o planeación, puede editar este presupuesto',
      );
    }
    if (!EDITABLE_BUDGET.includes(budget.status)) {
      throw new ConflictException(
        `El presupuesto está ${BUDGET_STATUS_LABEL[budget.status] ?? budget.status}: no se puede editar`,
      );
    }
    if (version.status !== 'captura') {
      throw new ConflictException(
        `La versión ${version.code} no está abierta a captura`,
      );
    }
    return { budget, version };
  }

  /**
   * Lo que se valida del cálculo (forma, moneda, índice, precio, viaje y
   * meses) contra los parámetros de la versión. Lo usan el alta y el cambio
   * de una línea (prepareLine) y la vista previa (calculate): los dos dicen lo
   * mismo.
   */
  private calcInputErrors(
    dto: CalcFields,
    version: VersionWithParams,
  ): string[] {
    const errors: string[] = [];
    const isTrip = dto.calc_method === 'viaje';
    const months = dto.months ?? [];

    if (dto.calc_method === 'precio_veces' && dto.unit_price == null) {
      errors.push('En precio × veces falta el precio sin IVA');
    }
    if (dto.calc_method !== 'precio_veces' && dto.unit_price) {
      errors.push('El precio de la línea solo va en precio × veces');
    }
    if (isTrip) {
      if (!dto.trip) errors.push('Faltan los datos del viaje');
      else if (
        dto.trip.travelers_colaborador + dto.trip.travelers_director <
        1
      ) {
        errors.push('El viaje debe llevar al menos una persona');
      }
      if (dto.currency !== 'MXN') errors.push('Un viaje va en pesos (MXN)');
      if (dto.price_index !== 'precio_acordado') {
        errors.push(
          'Un viaje va con precio acordado: las tarifas ya son de la versión',
        );
      }
    } else if (dto.trip) {
      errors.push('Los datos de viaje solo van en la forma Viaje');
    }
    if (
      dto.currency !== 'MXN' &&
      !version.fpa_exchange_rates.some((r) => r.currency === dto.currency)
    ) {
      errors.push(
        `La versión ${version.code} no tiene tipo de cambio de ${dto.currency}`,
      );
    }
    if (dto.price_index === 'inflacion' && version.inflation_pct === null) {
      errors.push(`La versión ${version.code} no tiene inflación todavía`);
    }

    errors.push(
      ...lineDataErrors(
        {
          calc_method: dto.calc_method,
          currency: dto.currency,
          price_index: dto.price_index,
          unit_price: dto.unit_price ?? null,
          months: months.map((m) => ({
            month: m.month,
            quantity: m.quantity ?? null,
            unit_price: m.unit_price ?? null,
            amount: m.amount ?? null,
            trips: m.trips ?? null,
          })),
        },
        version.cutoff_month,
      ),
    );
    if (months.some((m) => isNegative(m.quantity))) {
      errors.push('Las veces no pueden ser negativas');
    }
    return errors;
  }

  /**
   * Valida la línea contra la versión y el catálogo y regresa los datos a
   * guardar. Lo que la base ya cuida con CHECK se valida aquí también, para
   * responder con un mensaje claro.
   */
  private async prepareLine(dto: FpaLineInputDto, version: VersionWithParams) {
    const errors: string[] = [];
    const [department, classification] = await Promise.all([
      this.prisma.fpa_departments.findFirst({
        where: { id: dto.department_id, is_active: true },
        select: { id: true },
      }),
      this.prisma.fpa_classifications.findFirst({
        where: { id: dto.classification_id, is_active: true },
        select: { id: true, name: true, allows_negative: true },
      }),
    ]);
    if (!department)
      errors.push('El departamento no existe o está dado de baja');
    if (!classification)
      errors.push('La clasificación no existe o está dada de baja');

    const isTrip = dto.calc_method === 'viaje';
    const months = dto.months ?? [];

    errors.push(...this.calcInputErrors(dto, version));
    if (!isTrip && !dto.supplier_id && !dto.supplier_name) {
      errors.push('Falta el proveedor (del catálogo u OTROS)');
    }
    if (
      classification &&
      !classification.allows_negative &&
      (isNegative(dto.unit_price) ||
        months.some((m) => isNegative(m.amount) || isNegative(m.unit_price)))
    ) {
      errors.push(
        `La clasificación ${classification.name} no acepta montos negativos`,
      );
    }

    // Proveedor: copia del nombre del catálogo de SAP (el espejo cambia
    // legal_name); OTROS u otro texto van sin supplier_id
    let supplierName: string | null = isTrip
      ? null
      : (dto.supplier_name ?? null);
    if (!isTrip && dto.supplier_id) {
      const supplier = await this.prisma.suppliers.findUnique({
        where: { id: dto.supplier_id },
        select: { legal_name: true },
      });
      if (!supplier) errors.push('El proveedor no existe en el catálogo');
      else supplierName = supplier.legal_name;
    }

    if (errors.length > 0) throw new BadRequestException(errors.join('. '));

    const data = {
      department_id: dto.department_id,
      classification_id: dto.classification_id,
      concept: dto.concept,
      justification: dto.justification ?? null,
      supplier_id: isTrip ? null : (dto.supplier_id ?? null),
      supplier_name: supplierName,
      priority: dto.priority ?? null,
      calc_method: dto.calc_method,
      currency: dto.currency,
      price_index: dto.price_index,
      unit_price: dto.calc_method === 'precio_veces' ? dto.unit_price : null,
      trip_type: isTrip ? dto.trip!.trip_type : null,
      travelers_colaborador: isTrip ? dto.trip!.travelers_colaborador : null,
      travelers_director: isTrip ? dto.trip!.travelers_director : null,
      nights: isTrip ? dto.trip!.nights : null,
      car_rental: isTrip ? dto.trip!.car_rental : null,
      contract_label: dto.contract_label ?? null,
      project_tag: dto.project_tag ?? null,
      outside_ebitda: dto.outside_ebitda ?? null,
      spend_type: dto.spend_type ?? null,
    };
    const monthRows = months.map((m) => ({
      month: m.month,
      quantity: m.quantity ?? null,
      unit_price: m.unit_price ?? null,
      amount: m.amount ?? null,
      trips: m.trips ?? null,
    }));
    return { data, monthRows };
  }

  private async lineResponse(lineId: string, version: VersionWithParams) {
    const line = await this.prisma.fpa_budget_lines.findUniqueOrThrow({
      where: { id: lineId },
      include: LINE_INCLUDE,
    });
    return this.lineDto(
      line,
      calcLine(this.toCalcLine(line), this.calcVersion(version)),
    );
  }

  async createLine(user: AuthUser, budgetId: string, dto: FpaLineInputDto) {
    const { budget, version } = await this.loadForEdit(user, budgetId);
    const { data, monthRows } = await this.prepareLine(dto, version);
    const lineId = await this.prisma.$transaction(async (tx) => {
      const key = await tx.fpa_line_keys.create({
        data: { origin: 'captura', created_by: user.id },
      });
      const last = await tx.fpa_budget_lines.aggregate({
        where: { budget_id: budget.id },
        _max: { sort_order: true },
      });
      const line = await tx.fpa_budget_lines.create({
        data: {
          ...data,
          budget_id: budget.id,
          version_id: budget.version_id,
          line_key_id: key.id,
          sort_order: (last._max.sort_order ?? 0) + 1,
          created_by: user.id,
        },
      });
      if (monthRows.length > 0) {
        await tx.fpa_budget_line_months.createMany({
          data: monthRows.map((m) => ({ ...m, line_id: line.id })),
        });
      }
      return line.id;
    });
    return this.lineResponse(lineId, version);
  }

  async updateLine(user: AuthUser, lineId: string, dto: FpaLineInputDto) {
    const current = await this.prisma.fpa_budget_lines.findFirst({
      where: { id: lineId, is_active: true },
      select: { id: true, budget_id: true },
    });
    if (!current) throw new NotFoundException('Línea no encontrada');
    const { version } = await this.loadForEdit(user, current.budget_id);
    const { data, monthRows } = await this.prepareLine(dto, version);
    await this.prisma.$transaction(async (tx) => {
      await tx.fpa_budget_lines.update({ where: { id: lineId }, data });
      // Los meses se reescriben con su línea (por eso es la única tabla con DELETE)
      await tx.fpa_budget_line_months.deleteMany({
        where: { line_id: lineId },
      });
      if (monthRows.length > 0) {
        await tx.fpa_budget_line_months.createMany({
          data: monthRows.map((m) => ({ ...m, line_id: lineId })),
        });
      }
    });
    return this.lineResponse(lineId, version);
  }

  /**
   * POST /fpa/calcular (B1): calcula una línea sin guardarla, con los
   * parámetros de la versión del presupuesto, para que el modal enseñe los
   * meses, el total y el desglose del viaje mientras se captura. Basta poder
   * ver el presupuesto. `errors` trae lo mismo que diría el alta sobre el
   * cálculo; si hay, la pantalla no enseña los montos.
   */
  async calculate(user: AuthUser, dto: FpaCalcInputDto) {
    const budget = await this.prisma.fpa_budgets.findFirst({
      where: { id: dto.budget_id, is_active: true },
      select: { id: true, area_id: true, version_id: true },
    });
    if (!budget) throw new NotFoundException('Presupuesto no encontrado');
    const version = await this.loadVersion(user, budget.version_id);
    const scope = await this.scope(user);
    if (!scope.all && !scope.areaIds.has(budget.area_id)) {
      throw new ForbiddenException(
        'No tienes acceso al presupuesto de esta área',
      );
    }
    const errors = this.calcInputErrors(dto, version);
    const trip = dto.calc_method === 'viaje' ? dto.trip : null;
    const calc = calcLine(
      {
        calc_method: dto.calc_method,
        currency: dto.currency,
        price_index: dto.price_index,
        unit_price: dto.unit_price ?? null,
        trip_type: trip?.trip_type ?? null,
        travelers_colaborador: trip?.travelers_colaborador ?? null,
        travelers_director: trip?.travelers_director ?? null,
        nights: trip?.nights ?? null,
        months: (dto.months ?? []).map((m) => ({
          month: m.month,
          quantity: m.quantity ?? null,
          unit_price: m.unit_price ?? null,
          amount: m.amount ?? null,
          trips: m.trips ?? null,
        })),
      },
      this.calcVersion(version),
    );
    return { ...this.calcDto(calc), errors };
  }

  async deactivateLine(user: AuthUser, lineId: string) {
    const current = await this.prisma.fpa_budget_lines.findFirst({
      where: { id: lineId, is_active: true },
      select: { id: true, budget_id: true },
    });
    if (!current) throw new NotFoundException('Línea no encontrada');
    await this.loadForEdit(user, current.budget_id);
    await this.prisma.fpa_budget_lines.update({
      where: { id: lineId },
      data: { is_active: false },
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Consolidado
  // ---------------------------------------------------------------------------

  async consolidated(
    user: AuthUser,
    versionId: string,
    groupBy: 'area' | 'categoria' | 'area_categoria' = 'area',
  ) {
    const version = await this.loadVersion(user, versionId);
    const scope = await this.scope(user);
    const params = this.calcVersion(version);
    const budgets = await this.prisma.fpa_budgets.findMany({
      where: {
        version_id: versionId,
        is_active: true,
        ...(scope.all ? {} : { area_id: { in: [...scope.areaIds] } }),
      },
      include: {
        fpa_areas: { select: { id: true, name: true, sort_order: true } },
        fpa_budget_lines: {
          where: { is_active: true },
          include: {
            fpa_budget_line_months: true,
            fpa_classifications: {
              select: {
                fpa_categories: {
                  select: { id: true, name: true, sort_order: true },
                },
              },
            },
          },
        },
      },
    });

    interface Group {
      key: string;
      label: string;
      sublabel: string | null;
      sort: [number, string, number, string];
      months: Array<Array<Decimal | null>>;
    }
    const groups = new Map<string, Group>();
    const all: Array<Array<Decimal | null>> = [];
    const touch = (g: Omit<Group, 'months'>) => {
      const found = groups.get(g.key);
      if (found) return found;
      const created = { ...g, months: [] };
      groups.set(g.key, created);
      return created;
    };

    for (const b of budgets) {
      const area = b.fpa_areas;
      // Por área, cada presupuesto vivo tiene su renglón aunque no tenga líneas
      if (groupBy === 'area') {
        touch({
          key: area.id,
          label: area.name,
          sublabel: null,
          sort: [area.sort_order, area.name, 0, ''],
        });
      }
      for (const l of b.fpa_budget_lines) {
        const months = calcLine(this.toCalcLine(l), params).months.map(
          (m) => m.amount_mxn,
        );
        all.push(months);
        const cat = l.fpa_classifications.fpa_categories;
        const g =
          groupBy === 'area'
            ? touch({
                key: area.id,
                label: area.name,
                sublabel: null,
                sort: [area.sort_order, area.name, 0, ''],
              })
            : groupBy === 'categoria'
              ? touch({
                  key: cat.id,
                  label: cat.name,
                  sublabel: null,
                  sort: [cat.sort_order, cat.name, 0, ''],
                })
              : touch({
                  key: `${area.id}:${cat.id}`,
                  label: area.name,
                  sublabel: cat.name,
                  sort: [area.sort_order, area.name, cat.sort_order, cat.name],
                });
        g.months.push(months);
      }
    }

    const rows = [...groups.values()]
      .sort(
        (a, b) =>
          a.sort[0] - b.sort[0] ||
          a.sort[1].localeCompare(b.sort[1], 'es') ||
          a.sort[2] - b.sort[2] ||
          a.sort[3].localeCompare(b.sort[3], 'es'),
      )
      .map((g) => {
        const s = sumMonths(g.months);
        return {
          key: g.key,
          label: g.label,
          sublabel: g.sublabel,
          months_mxn: s.months.map(money),
          total_mxn: money(s.total),
        };
      });
    const totals = sumMonths(all);
    return {
      version: this.versionDto(version),
      group_by: groupBy,
      rows,
      totals: {
        months_mxn: totals.months.map(money),
        total_mxn: money(totals.total),
      },
    };
  }

  async consolidatedExcel(
    user: AuthUser,
    versionId: string,
    groupBy: 'area' | 'categoria' | 'area_categoria' = 'area',
  ): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.consolidated(user, versionId, groupBy);
    type Row = {
      label: string;
      sublabel: string | null;
      months: Money[];
      total: Money;
    };
    const value = (v: Money) => (v === null ? NO_DISPONIBLE : Number(v));
    const firstHeader = groupBy === 'categoria' ? 'Categoría' : 'Área';
    const columns: ExcelColumn<Row>[] = [
      { header: firstHeader, value: (r) => r.label, width: 32 },
      ...(groupBy === 'area_categoria'
        ? [{ header: 'Categoría', value: (r: Row) => r.sublabel, width: 30 }]
        : []),
      ...MONTHS.map(
        (m): ExcelColumn<Row> => ({
          header: MONTH_HEADERS[m - 1],
          value: (r) => value(r.months[m - 1]),
          kind: 'money',
          width: 15,
        }),
      ),
      {
        header: 'Total',
        value: (r) => value(r.total),
        kind: 'money',
        width: 17,
      },
    ];
    const rows: Row[] = [
      ...data.rows.map((r) => ({
        label: r.label,
        sublabel: r.sublabel,
        months: r.months_mxn,
        total: r.total_mxn,
      })),
      {
        label: 'Total',
        sublabel: null,
        months: data.totals.months_mxn,
        total: data.totals.total_mxn,
      },
    ];
    const v = data.version;
    const rates = v.exchange_rates
      .map((r) => `${r.currency} ${Number(r.rate_mxn)}`)
      .join(', ');
    const note = [
      `Versión ${v.code} (${v.name}), ejercicio ${v.fiscal_year}.`,
      'Montos en pesos, sin IVA, calculados con los parámetros de la versión:',
      `tipos de cambio ${rates || 'solo MXN'}; inflación ${v.inflation_pct === null ? 'no disponible' : `${Number(v.inflation_pct)}%`}.`,
      '"No disponible" = a la línea le falta un parámetro de la versión (no es cero).',
    ].join(' ');
    const buffer = await buildExcel('Consolidado', columns, rows, { note });
    return { buffer, filename: excelFilename(`FPA_consolidado_${v.code}`) };
  }

  // ---------------------------------------------------------------------------
  // Áreas y responsables (planeación)
  // ---------------------------------------------------------------------------

  async listAreas() {
    const areas = await this.prisma.fpa_areas.findMany({
      include: {
        fpa_departments_fpa_areas_department_idTofpa_departments: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ is_active: 'desc' }, { sort_order: 'asc' }, { name: 'asc' }],
    });
    const people = await this.titulars(areas.map((a) => a.id));
    return areas.map((a) => ({
      id: a.id,
      name: a.name,
      sort_order: a.sort_order,
      is_active: a.is_active,
      department:
        a.fpa_departments_fpa_areas_department_idTofpa_departments ?? null,
      capturer: people.get(a.id)?.capturer ?? null,
      approver: people.get(a.id)?.approver ?? null,
    }));
  }

  private async areaRow(areaId: string) {
    const rows = await this.listAreas();
    const row = rows.find((r) => r.id === areaId);
    if (!row) throw new NotFoundException('Área no encontrada');
    return row;
  }

  async createArea(user: AuthUser, name: string) {
    if (!name)
      throw new BadRequestException('El nombre del área es obligatorio');
    const exists = await this.prisma.fpa_areas.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (exists) throw new ConflictException('Ya existe un área con ese nombre');
    // Su departamento propio lleva el mismo nombre (único en el catálogo): si
    // ya existe uno libre se reutiliza; si lo captura otra área, no se toca
    const dept = await this.prisma.fpa_departments.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      include: {
        fpa_areas_fpa_departments_area_idTofpa_areas: {
          select: { name: true },
        },
      },
    });
    const owner = dept?.fpa_areas_fpa_departments_area_idTofpa_areas;
    if (dept && owner) {
      throw new ConflictException(
        `Ya existe el departamento ${dept.name} y lo captura ${owner.name}: usa otro nombre para el área`,
      );
    }
    const last = await this.prisma.fpa_areas.aggregate({
      _max: { sort_order: true },
    });
    const openVersions = await this.prisma.fpa_versions.findMany({
      where: {
        is_active: true,
        status: 'captura',
        kind: { in: ['presupuesto', 'forecast'] },
      },
      select: { id: true },
    });
    try {
      const areaId = await this.prisma.$transaction(async (tx) => {
        const area = await tx.fpa_areas.create({
          data: {
            name,
            sort_order: (last._max.sort_order ?? 0) + 1,
            created_by: user.id,
          },
        });
        const own = dept
          ? await tx.fpa_departments.update({
              where: { id: dept.id },
              data: { area_id: area.id },
            })
          : await tx.fpa_departments.create({
              data: { name, area_id: area.id, created_by: user.id },
            });
        await tx.fpa_areas.update({
          where: { id: area.id },
          data: { department_id: own.id },
        });
        // Un área que se agrega con versiones ya abiertas recibe su
        // presupuesto en borrador en cada una, para que pueda capturar
        for (const v of openVersions) {
          await tx.fpa_budgets.create({
            data: { version_id: v.id, area_id: area.id, created_by: user.id },
          });
        }
        return area.id;
      });
      return this.areaRow(areaId);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe un área o un departamento con ese nombre',
        );
      }
      throw e;
    }
  }

  /** Nombra al titular de captura o de aprobación de un área (revoca al anterior). */
  async assign(
    user: AuthUser,
    dto: {
      area_id: string;
      duty: 'captura' | 'aprobacion';
      profile_id: string;
    },
  ) {
    const area = await this.prisma.fpa_areas.findFirst({
      where: { id: dto.area_id, is_active: true },
      select: { id: true },
    });
    if (!area) throw new NotFoundException('Área no encontrada');
    const person = await this.prisma.profiles.findFirst({
      where: {
        id: dto.profile_id,
        is_active: true,
        user_roles_user_roles_profile_idToprofiles: {
          some: { module: 'fpa', is_active: true },
        },
      },
      select: { id: true },
    });
    if (!person) {
      throw new BadRequestException(
        'La persona debe tener un rol de FP&A activo (asígnalo en Administración › Usuarios)',
      );
    }
    const current = await this.prisma.fpa_assignments.findMany({
      where: { area_id: dto.area_id, is_active: true },
      select: { id: true, duty: true, profile_id: true, is_alternate: true },
    });
    if (
      current.some(
        (a) =>
          a.profile_id === dto.profile_id &&
          a.duty === dto.duty &&
          !a.is_alternate,
      )
    ) {
      return this.areaRow(dto.area_id); // ya es titular: nada que hacer
    }
    if (current.some((a) => a.profile_id === dto.profile_id)) {
      throw new ConflictException(
        'Esa persona ya tiene otra función en el área: quien captura no aprueba la misma área',
      );
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const previous = current.filter(
        (a) => a.duty === dto.duty && !a.is_alternate,
      );
      for (const p of previous) {
        await tx.fpa_assignments.update({
          where: { id: p.id },
          data: { is_active: false, revoked_at: now, revoked_by: user.id },
        });
      }
      await tx.fpa_assignments.create({
        data: {
          area_id: dto.area_id,
          duty: dto.duty,
          profile_id: dto.profile_id,
          created_by: user.id,
        },
      });
    });
    return this.areaRow(dto.area_id);
  }

  /** Personas con un rol de FP&A activo, para los selectores de responsables. */
  async directory(search?: string) {
    const rows = await this.prisma.profiles.findMany({
      where: {
        is_active: true,
        user_roles_user_roles_profile_idToprofiles: {
          some: {
            module: 'fpa',
            is_active: true,
            role: { in: FPA_MODULE_ROLES as never[] },
          },
        },
        ...(search
          ? {
              OR: [
                { full_name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, full_name: true, email: true },
      orderBy: { full_name: 'asc' },
      take: 50,
    });
    return rows.map((r) => ({ id: r.id, full_name: r.full_name ?? r.email }));
  }
}
