import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { canonicalize } from '../../../common/maximo/maximo-canonical';
import { MaximoContractDto } from '../dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';
import { MAXIMO_MAPPER_VERSION } from '../maximo.mapper';
import {
  MaximoRemapReason,
  MaximoUpsertOutcome,
  MaximoUpsertResult,
} from './maximo-sync.types';
import { poMappedColumns, replacePoStatusHistory } from './maximo-po-history';
import {
  contractMappedColumns,
  replacePrStatusHistory,
} from './maximo-pr-history';

/**
 * Upsert idempotente a staging (Fase INT-3, T3/T4). ÚNICO camino de escritura
 * a `maximo_purchase_orders` / `maximo_contracts`: lo usan el sync engine y el
 * seed de fixtures (T5) por igual.
 *
 * La clave natural es un índice único sobre expresiones coalesce (Prisma no lo
 * modela), así que el upsert va por findFirst + create/update; la carrera de
 * doble insert se resuelve capturando P2002 y reintentando como update
 * (patrón ya usado en enrollments/platforms).
 *
 * G6 (2026-09-28): el alta o el cambio de una OC reescribe su historial
 * POSTATUS (`maximo_po_status_history`) en la MISMA transacción.
 *
 * I9 (2026-09-30): el rowstamp es por fila en Maximo y NO cambia cuando CIISA
 * agrega campos a la Object Structure. Por eso "sin cambio" exige además el
 * mismo `raw_hash` (hash del payload recibido) y la misma versión del mapper.
 * El hash va sobre la forma canónica: el mismo registro por legacy u OSLC no
 * cuenta como cambio.
 *
 * K8 (2026-10-05): tres desenlaces para una fila que ya existe:
 *   - rowstamp distinto → 'updated' (cambio real en Maximo): columnas, `raw`,
 *     historial y `last_changed_at`;
 *   - mismo rowstamp, mismo hash y mismo mapper → 'unchanged': solo
 *     `last_seen_at` / `last_sync_run_id`;
 *   - mismo rowstamp con otro mapper ('mapper') u otro hash ('hash': campo
 *     nuevo de CIISA o un cambio solo en hijos que no mueve el rowstamp de la
 *     raíz, como RECEIVEDQTY de una POLINE) → 'remapped': se reescribe todo
 *     igual que en 'updated', pero SIN tocar `last_changed_at`, que es lo que
 *     ven las revisiones del detalle ("Cambió en Maximo").
 * "Mismo rowstamp": en OC, `rowstamp` igual y no nulo; en contratos,
 * `pr_rowstamp` igual y no nulo Y `contract_rowstamp` igual (o los dos nulos).
 *
 * K3/K8 (2026-10-05): el alta, el cambio y el 'remapped' de un contrato
 * reescriben el historial PRSTATUS de su PR (`maximo_pr_status_history`) en
 * la misma transacción. Las cuatro ramas de contratos escriben
 * `superseded_at: null` (si la llave reaparece, se limpia) y
 * `supersedeMissingRevisions` marca las revisiones que ya no vienen.
 */
@Injectable()
export class MaximoStagingService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertPurchaseOrder(
    dto: MaximoPurchaseOrderDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertResult> {
    const rawHash = maximoRawHash(raw);
    // Normalización de la clave natural: el índice único usa coalesce(x, ''),
    // que colapsa NULL y '' en la misma tupla; aquí se normaliza '' → null
    // para que el espacio del findFirst coincida con el del índice y ninguna
    // representación alterna del mismo registro termine en P2002 permanente.
    const where = {
      ponum: dto.ponum,
      siteid: emptyToNull(dto.siteId),
      revisionnum: dto.revisionNum,
    };
    const key = naturalKey(where.ponum, where.siteid, where.revisionnum);
    const mapped = { ...poMappedColumns(dto), raw_hash: rawHash };

    const attempt = async (): Promise<MaximoUpsertResult> => {
      const existing = await this.prisma.maximo_purchase_orders.findFirst({
        where,
        select: {
          id: true,
          rowstamp: true,
          raw_hash: true,
          mapper_version: true,
        },
      });
      if (!existing) {
        // id generado aquí para escribir OC + historial en una transacción
        const id = randomUUID();
        await this.prisma.$transaction([
          this.prisma.maximo_purchase_orders.create({
            data: {
              id,
              ...where,
              ...mapped,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: MAXIMO_MAPPER_VERSION,
              last_sync_run_id: runId,
            },
          }),
          ...replacePoStatusHistory(this.prisma, id, dto),
        ]);
        return { outcome: 'inserted', key };
      }
      const sameRowstamp =
        existing.rowstamp !== null && existing.rowstamp === dto.rowstamp;
      const decision = existingOutcome(sameRowstamp, existing, rawHash);
      const now = new Date();
      if (decision.outcome === 'unchanged') {
        await this.prisma.maximo_purchase_orders.update({
          where: { id: existing.id },
          data: { last_seen_at: now, last_sync_run_id: runId },
        });
        return { ...decision, key };
      }
      await this.prisma.$transaction([
        this.prisma.maximo_purchase_orders.update({
          where: { id: existing.id },
          data: {
            ...mapped,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: MAXIMO_MAPPER_VERSION,
            last_seen_at: now,
            // K8: solo un rowstamp nuevo es cambio real
            ...(decision.outcome === 'updated' ? { last_changed_at: now } : {}),
            last_sync_run_id: runId,
          },
        }),
        ...replacePoStatusHistory(this.prisma, existing.id, dto),
      ]);
      return { ...decision, key };
    };

    return this.withUniqueRaceRetry(attempt);
  }

  async upsertContract(
    dto: MaximoContractDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertResult> {
    const rawHash = maximoRawHash(raw);
    // Ver nota de normalización en upsertPurchaseOrder ('' → null).
    const where = {
      prnum: emptyToNull(dto.prnum),
      contractnum: emptyToNull(dto.contractNum),
      revisionnum: dto.revisionNum,
    };
    const key = naturalKey(where.prnum, where.contractnum, where.revisionnum);
    const mapped = { ...contractMappedColumns(dto), raw_hash: rawHash };

    const attempt = async (): Promise<MaximoUpsertResult> => {
      const existing = await this.prisma.maximo_contracts.findFirst({
        where,
        select: {
          id: true,
          contract_rowstamp: true,
          pr_rowstamp: true,
          raw_hash: true,
          mapper_version: true,
        },
      });
      if (!existing) {
        await this.prisma.$transaction([
          this.prisma.maximo_contracts.create({
            data: {
              ...where,
              ...mapped,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: MAXIMO_MAPPER_VERSION,
              last_sync_run_id: runId,
              superseded_at: null,
            },
          }),
          ...replacePrStatusHistory(this.prisma, dto),
        ]);
        return { outcome: 'inserted', key };
      }
      // K8: la PR (STATUS, historial…) muta la raíz → pr_rowstamp; el
      // contrato (estatus, consumo, líneas) muta su PURCHVIEW →
      // contract_rowstamp. Mismo rowstamp = los dos iguales (en una PR sin
      // contrato, contract_rowstamp es null en ambos lados).
      const samePrRow =
        existing.pr_rowstamp !== null && existing.pr_rowstamp === dto.rowstamp;
      const sameContractRow =
        existing.contract_rowstamp === dto.contractRowstamp;
      const decision = existingOutcome(
        samePrRow && sameContractRow,
        existing,
        rawHash,
      );
      const now = new Date();
      if (decision.outcome === 'unchanged') {
        await this.prisma.maximo_contracts.update({
          where: { id: existing.id },
          data: {
            last_seen_at: now,
            last_sync_run_id: runId,
            superseded_at: null,
          },
        });
        return { ...decision, key };
      }
      await this.prisma.$transaction([
        this.prisma.maximo_contracts.update({
          where: { id: existing.id },
          data: {
            ...mapped,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: MAXIMO_MAPPER_VERSION,
            last_seen_at: now,
            // K8: solo un rowstamp nuevo es cambio real
            ...(decision.outcome === 'updated' ? { last_changed_at: now } : {}),
            last_sync_run_id: runId,
            superseded_at: null,
          },
        }),
        ...replacePrStatusHistory(this.prisma, dto),
      ]);
      return { ...decision, key };
    };

    return this.withUniqueRaceRetry(attempt);
  }

  /**
   * K8 (2026-10-05): marca `superseded_at` en las revisiones de la PR que ya
   * no vienen en su registro (p. ej. la fila sin contrato de una PR que
   * después tuvo contrato, o una revisión retirada). Las vistas las excluyen.
   *
   * - Con prnum null o '' no hace nada (raíz PURCHVIEW de la estructura
   *   previa): en Prisma `where: { prnum: null }` es IS NULL y marcaría los
   *   contratos sin PR de otros registros.
   * - La comparación va en JS con la llave de `uq_maximo_contract_natural_key`
   *   (`contractnum|revisionnum`, con coalesce): un `NOT {contractnum,
   *   revisionnum}` en SQL dejaría fuera la fila sin contrato (NULL = 'C1' da
   *   NULL).
   * - Solo marca las que faltan y aún no estaban marcadas, para no reescribir
   *   la fecha en cada corrida. Regresa cuántas marcó.
   *
   * El llamador la invoca SOLO si todos los upserts del registro salieron
   * bien: si falló el alta de la llave nueva, marcar la vieja dejaría la PR
   * fuera de todas las vistas.
   */
  async supersedeMissingRevisions(
    prnum: string | null,
    dtos: MaximoContractDto[],
  ): Promise<number> {
    if (prnum === null || prnum === '') return 0;
    const present = new Set(
      dtos.map((d) => revisionKey(emptyToNull(d.contractNum), d.revisionNum)),
    );
    const rows = await this.prisma.maximo_contracts.findMany({
      where: { prnum },
      select: {
        id: true,
        contractnum: true,
        revisionnum: true,
        superseded_at: true,
      },
    });
    const ids = rows
      .filter(
        (row) =>
          // `== null`: en el testkit una fila sin el campo trae undefined
          row.superseded_at == null &&
          !present.has(revisionKey(row.contractnum, row.revisionnum)),
      )
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.maximo_contracts.updateMany({
      where: { id: { in: ids } },
      data: { superseded_at: new Date() },
    });
    return count;
  }

  /** Carrera de doble insert (índice único de expresión) → P2002 → reintento. */
  private async withUniqueRaceRetry(
    attempt: () => Promise<MaximoUpsertResult>,
  ): Promise<MaximoUpsertResult> {
    try {
      return await attempt();
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'P2002') {
        // Otro proceso insertó la misma clave natural entre el findFirst y el
        // create: el reintento la encuentra y sigue por la rama de update.
        return attempt();
      }
      throw error;
    }
  }
}

/**
 * K8: rama de una fila que ya existe. Con el mismo rowstamp, un mapper
 * distinto manda sobre el hash (en el primer full tras un deploy cambian los
 * dos y la razón es el mapper).
 */
function existingOutcome(
  sameRowstamp: boolean,
  existing: { raw_hash: string | null; mapper_version: string },
  rawHash: string,
): {
  outcome: Exclude<MaximoUpsertOutcome, 'inserted'>;
  reason?: MaximoRemapReason;
} {
  if (!sameRowstamp) return { outcome: 'updated' };
  if (existing.mapper_version !== MAXIMO_MAPPER_VERSION) {
    return { outcome: 'remapped', reason: 'mapper' };
  }
  if (existing.raw_hash !== rawHash) {
    return { outcome: 'remapped', reason: 'hash' };
  }
  return { outcome: 'unchanged' };
}

/**
 * I9: hash del payload recibido sobre su forma canónica (claves en mayúsculas
 * y ordenadas, sin nulos): un campo o valor nuevo lo cambia; la forma de la
 * API (legacy anidado, legacy compacto u OSLC) no.
 *
 * K8 (2026-10-05), hash estable:
 *   - los arreglos se ordenan, de forma recursiva: primero se estabiliza cada
 *     elemento y después se ordena por su JSON (Maximo no garantiza el orden
 *     de los hijos);
 *   - sin la llave ROWSTAMP en ningún nivel: los rowstamp que importan se
 *     comparan aparte (raíz de la OC; raíz de la PR y PURCHVIEW del contrato);
 *   - PERSON y COMPANIES se proyectan a lo único que leen `mapPerson` y
 *     `mapVendor` (HASH_PROJECTIONS). Sin esto, editar el maestro de una
 *     persona o de un proveedor re-mapearía cientos de OC y PR.
 */
export function maximoRawHash(raw: unknown): string {
  const canonical = canonicalize(raw);
  const payload = canonical === null ? (raw ?? null) : stableForHash(canonical);
  return createHash('sha256')
    .update(JSON.stringify(payload) ?? 'null')
    .digest('hex');
}

/**
 * K8: campos de PERSON y COMPANIES que entran al hash, en cualquier nivel. Es
 * un contrato con el mapper: si algún día lee otro campo, se agrega aquí.
 */
const HASH_PROJECTIONS: Readonly<Record<string, readonly string[]>> = {
  PERSON: ['PERSONID', 'DISPLAYNAME', 'DEPARTMENT'],
  COMPANIES: ['COMPANY', 'NAME', 'ORGID'],
};

function stableForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const stable = stableForHash(item);
        return { stable, text: JSON.stringify(stable) ?? '' };
      })
      .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
      .map((entry) => entry.stable);
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'ROWSTAMP') continue;
    const item = (value as Record<string, unknown>)[key];
    if (item === null || item === undefined) continue;
    out[key] = stableForHash(projectForHash(key, item));
  }
  return out;
}

function projectForHash(key: string, value: unknown): unknown {
  const fields = HASH_PROJECTIONS[key];
  if (!fields || !Array.isArray(value)) return value;
  return value.map((child: unknown) => {
    if (child === null || typeof child !== 'object') return child;
    const source = child as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        projected[field] = source[field];
      }
    }
    return projected;
  });
}

/** Llave legible para el log (`a|b|rev`), con los nulos como en el índice. */
function naturalKey(
  first: string | null,
  second: string | null,
  revisionNum: number | null,
): string {
  return `${first ?? ''}|${second ?? ''}|${revisionNum ?? 0}`;
}

/** Llave de una revisión dentro de su PR (coalesce de la clave natural). */
function revisionKey(
  contractnum: string | null,
  revisionnum: number | null,
): string {
  return `${contractnum ?? ''}|${revisionnum ?? 0}`;
}

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}
