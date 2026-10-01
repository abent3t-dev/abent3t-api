import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import {
  applyColumnQuery,
  facetOf,
  isColumnQueryActive,
  paginateRows,
  parseColumnQuery,
} from '../common/column-filters/column-filters';
import type { ColumnDefs } from '../common/column-filters/column-filters';
import { addDaysUtc, cdmxDateUtc } from './contracts.dates';
import {
  baseContractNumber,
  contractNumberFor,
  contractStatusFor,
  type ContractDocKind,
  type ContractStatus,
  docKindLabel,
  docKindName,
  docKindOf,
  docKindRank,
  docKindType,
  normalizeCarpeta,
  parseDocKind,
} from './contract-catalog';
import { ContractQueryDto } from './dto/contract-query.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';

/**
 * Fase §15 — Repositorio documental de contratos: metadata en `contracts`,
 * PDFs en el bucket privado `contracts` de MinIO (vía StorageService, patrón
 * de evidences), lectura abierta a cualquier autenticado y mutaciones solo
 * PURCHASE_TEAM (el gate vive en el controller).
 *
 * NO toca las tablas de staging de la integración (0005) ni conoce a la
 * fuente externa: son dos mundos separados (regla 1 de la fase).
 *
 * E1 (2026-09-25, pedido también por César): filtro "tipo Excel" por
 * columna sobre el listado, con el mismo motor que el resto de Compras.
 *
 * I6 (go-live 2026-09-30, base real de Diana): carpeta + tipo arman el
 * número (contract-catalog.ts), área usuaria, fechas opcionales ("Sin fecha
 * de fin", sin alertas), estatus por fecha de fin y el listado agrupado por
 * carpeta (`group=carpeta`): el contrato con su CI, enmiendas y convenios.
 *
 * J2 (2026-10-01): "vencido (histórico)" = sin avisos. Se marca solo al dar
 * de alta un contrato ya vencido; Compras lo desmarca si está en renovación.
 * Si el contrato deja de estar vencido (nueva fecha de fin), se apaga.
 */

const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB (§15)
const DOWNLOAD_TTL_SECONDS = 300; // 5 min (§15)

/** Tope del export (B1). */
const EXPORT_MAX_ROWS = 20_000;

const CONTRACT_INCLUDE = {
  suppliers: { select: { id: true, legal_name: true, tax_id: true } },
  profiles_contracts_buyer_profile_idToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
} as const;

/**
 * `storage_key` NUNCA sale al cliente (la descarga es por signed URL);
 * por eso los documentos siempre viajan con este select.
 */
const DOCUMENT_SELECT = {
  id: true,
  contract_id: true,
  file_name: true,
  mime_type: true,
  file_size_bytes: true,
  version: true,
  is_current: true,
  uploaded_by: true,
  uploaded_at: true,
} as const;

type ContractRow = Prisma.contractsGetPayload<{
  include: typeof CONTRACT_INCLUDE;
}>;

type DocumentRow = Prisma.contract_documentsGetPayload<{
  select: typeof DOCUMENT_SELECT;
}>;

/** BigInt no serializa a JSON; Decimal serializa como string. Se normalizan. */
function mapDocument(doc: DocumentRow) {
  return {
    ...doc,
    file_size_bytes:
      doc.file_size_bytes === null ? null : Number(doc.file_size_bytes),
  };
}

function aliasContract(row: ContractRow) {
  const {
    suppliers,
    profiles_contracts_buyer_profile_idToprofiles: buyer,
    total_amount,
    consumed_amount,
    ...rest
  } = row;
  const total = total_amount === null ? null : Number(total_amount);
  const consumed = consumed_amount === null ? null : Number(consumed_amount);
  return {
    ...rest,
    // I6: tipo del documento dentro de la carpeta (por su etiqueta)
    doc_kind: docKindOf(row),
    total_amount: total,
    consumed_amount: consumed,
    // Saldo = total - consumido, calculado (B4). null si falta cualquiera:
    // "No disponible" en la UI, nunca 0.
    balance_amount:
      total === null || consumed === null ? null : total - consumed,
    supplier: suppliers,
    buyer,
  };
}

type ContractListRow = ReturnType<typeof aliasContract>;

/** J2: estatus para tabla, filtro y export ("vencido_historico" aparte). */
export function contractStatusKey(row: {
  status: string;
  vencido_historico: boolean;
}): string {
  return row.status === 'vencido' && row.vencido_historico
    ? 'vencido_historico'
    : row.status;
}

/** "2026-10-01" → Date; null/"" → null (I6: fechas opcionales). */
function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Estatus al guardar: por fecha de fin; renovado/cancelado se respetan. */
function statusOnSave(
  end: Date | null,
  requested: ContractStatus | null,
): ContractStatus {
  if (requested === 'renovado' || requested === 'cancelado') return requested;
  return contractStatusFor(end, cdmxDateUtc(), requested);
}

/** E1: columnas filtrables = tabla de /compras/contratos. */
export const CONTRACT_FILTER_COLUMNS: ColumnDefs<ContractListRow> = {
  numero: { type: 'text', value: (r) => r.contract_number },
  // I6: carpeta, tipo del documento (Contrato, Enmienda…) y área usuaria
  carpeta: { type: 'text', value: (r) => r.carpeta },
  tipo: { type: 'text', value: (r) => docKindName(r.doc_kind) },
  area: { type: 'text', value: (r) => r.user_area },
  servicio: { type: 'text', value: (r) => r.service_description },
  proveedor: { type: 'text', value: (r) => r.supplier?.legal_name },
  inicio: { type: 'date', value: (r) => r.start_date },
  fin: { type: 'date', value: (r) => r.end_date },
  // J2: el vencido histórico (sin avisos) se filtra aparte
  estatus: { type: 'text', value: contractStatusKey },
  monto: { type: 'number', value: (r) => r.total_amount },
  consumido: { type: 'number', value: (r) => r.consumed_amount },
  saldo: { type: 'number', value: (r) => r.balance_amount },
  moneda: { type: 'text', value: (r) => r.currency },
  comprador: { type: 'text', value: (r) => r.buyer?.full_name },
  responsable: { type: 'text', value: (r) => r.responsible_user_name },
};

/** I6: una carpeta con sus documentos (el contrato primero). */
export interface ContractGroup {
  key: string;
  carpeta: string | null;
  /** El contrato de la carpeta (o su primer documento). */
  head: ContractListRow;
  documents: ContractListRow[];
}

const docOrder = (r: ContractListRow) =>
  docKindRank(r.doc_kind, parseDocKind(r.document_label)?.n ?? null);

/**
 * I6: agrupa los documentos (ya filtrados) por carpeta. Sin carpeta, cada
 * documento es su propio grupo. Orden: el de la columna pedida (sobre el
 * documento principal) o por carpeta.
 */
export function groupContractsByCarpeta(
  rows: ContractListRow[],
  sort: { column: string; order: 'asc' | 'desc' } | null = null,
): ContractGroup[] {
  const byKey = new Map<string, ContractListRow[]>();
  for (const row of rows) {
    const key = row.carpeta ?? `#${row.contract_number}`;
    const docs = byKey.get(key);
    if (docs) docs.push(row);
    else byKey.set(key, [row]);
  }
  const groups = [...byKey.entries()].map(([key, docs]) => {
    const documents = [...docs].sort(
      (a, b) =>
        docOrder(a) - docOrder(b) ||
        a.contract_number.localeCompare(b.contract_number),
    );
    return {
      key,
      carpeta: documents[0].carpeta,
      head: documents[0],
      documents,
    };
  });
  if (sort) {
    const heads = applyColumnQuery(
      groups.map((g) => g.head),
      CONTRACT_FILTER_COLUMNS,
      { filters: new Map(), sort },
    );
    const rank = new Map(heads.map((h, i) => [h.id, i]));
    return groups.sort(
      (a, b) => (rank.get(a.head.id) ?? 0) - (rank.get(b.head.id) ?? 0),
    );
  }
  return groups.sort((a, b) => {
    if (a.carpeta && b.carpeta) return a.carpeta.localeCompare(b.carpeta);
    if (a.carpeta || b.carpeta) return a.carpeta ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** WHERE del listado (compartido con el export). */
  private buildWhere(query: ContractQueryDto): Prisma.contractsWhereInput {
    const where: Prisma.contractsWhereInput = { is_active: true };
    if (query.status) where.status = query.status;
    if (query.supplier_id) where.supplier_id = query.supplier_id;
    if (query.vence_en_dias !== undefined) {
      const today = cdmxDateUtc();
      where.end_date = {
        gte: today,
        lte: addDaysUtc(today, query.vence_en_dias),
      };
    }
    // I6: permanentes, "por servicio"… (sin alertas de vencimiento)
    if (query.sin_fin === 'true') where.end_date = null;
    if (query.search) {
      where.OR = [
        { contract_number: { contains: query.search, mode: 'insensitive' } },
        {
          service_description: { contains: query.search, mode: 'insensitive' },
        },
        { user_area: { contains: query.search, mode: 'insensitive' } },
        {
          suppliers: {
            legal_name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }
    return where;
  }

  async findAll(query: ContractQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // E1: filtros por columna u orden → sobre el listado completo
    const columnQuery = parseColumnQuery(query, CONTRACT_FILTER_COLUMNS);
    if (isColumnQueryActive(columnQuery)) {
      const { rows } = await this.loadAll(query);
      return paginateRows(
        applyColumnQuery(rows, CONTRACT_FILTER_COLUMNS, columnQuery),
        page,
        limit,
      );
    }
    const where = this.buildWhere(query);

    const [total, rows] = await Promise.all([
      this.prisma.contracts.count({ where }),
      this.prisma.contracts.findMany({
        where,
        include: CONTRACT_INCLUDE,
        // Los próximos a vencer primero: es la vista operativa de procura.
        orderBy: [{ end_date: 'asc' }, { contract_number: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const meta = {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
    return {
      data: rows.map(aliasContract),
      meta,
    } satisfies PaginatedResponse<ReturnType<typeof aliasContract>>;
  }

  /**
   * I6: una fila por carpeta con sus documentos (el contrato principal y,
   * desplegables, su CI, enmiendas y convenios). Los filtros aplican a los
   * documentos; la página cuenta carpetas.
   */
  async findGroups(query: ContractQueryDto) {
    const columnQuery = parseColumnQuery(query, CONTRACT_FILTER_COLUMNS);
    const { rows } = await this.loadAll(query);
    const filtered = applyColumnQuery(
      rows,
      CONTRACT_FILTER_COLUMNS,
      columnQuery,
      { sort: false },
    );
    return paginateRows(
      groupContractsByCarpeta(filtered, columnQuery.sort),
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  /** Export (B1): mismos filtros que findAll, sin paginar, con tope. */
  async findAllForExport(query: ContractQueryDto) {
    const columnQuery = parseColumnQuery(query, CONTRACT_FILTER_COLUMNS);
    const { rows, truncated } = await this.loadAll(query);
    const filtered = applyColumnQuery(
      rows,
      CONTRACT_FILTER_COLUMNS,
      columnQuery,
      {
        sort: query.group !== 'carpeta',
      },
    );
    return {
      // I6: agrupado, el Excel va por carpeta (contrato, CI, enmiendas…)
      rows:
        query.group === 'carpeta'
          ? groupContractsByCarpeta(filtered, columnQuery.sort).flatMap(
              (g) => g.documents,
            )
          : filtered,
      truncated,
    };
  }

  /** E1: valores de una columna con los demás filtros aplicados. */
  async facets(query: ContractQueryDto) {
    const { rows } = await this.loadAll(query);
    return facetOf(rows, CONTRACT_FILTER_COLUMNS, query);
  }

  /** Listado completo con los filtros propios (tope del export). */
  private async loadAll(query: ContractQueryDto) {
    const where = this.buildWhere(query);
    const rows = await this.prisma.contracts.findMany({
      where,
      include: CONTRACT_INCLUDE,
      orderBy: [{ end_date: 'asc' }, { contract_number: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
    });
    return {
      rows: rows.slice(0, EXPORT_MAX_ROWS).map(aliasContract),
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  async findOne(id: string) {
    const contract = await this.prisma.contracts.findFirst({
      where: { id, is_active: true },
      include: CONTRACT_INCLUDE,
    });
    if (!contract) throw new NotFoundException('Contrato no encontrado');

    const documents = await this.prisma.contract_documents.findMany({
      where: { contract_id: id },
      select: DOCUMENT_SELECT,
      orderBy: { version: 'desc' },
    });

    return {
      ...aliasContract(contract),
      documents: documents.map(mapDocument),
    };
  }

  async create(dto: CreateContractDto, userId: string) {
    await this.assertValidReferences(dto);
    const startDate = toDate(dto.start_date);
    const endDate = toDate(dto.end_date);
    this.assertValidDates(startDate, endDate);

    // I6: número = carpeta + tipo (como la carga del control de contratos)
    const {
      carpeta: carpetaInput,
      doc_kind: kindInput,
      doc_number: nInput,
      contract_number: numberInput,
      ...rest
    } = dto;
    // J2: el histórico se decide abajo según el estatus
    delete rest.vencido_historico;
    const carpeta = this.carpetaOf(carpetaInput);
    const kind: ContractDocKind | null =
      kindInput ?? (carpeta ? 'contrato' : null);
    const n =
      kind === 'enmienda'
        ? (nInput ?? (carpeta ? await this.nextEnmienda(carpeta) : null))
        : null;
    let contractNumber = numberInput?.trim() ?? '';
    if (!contractNumber) {
      if (!carpeta || !kind) {
        throw new BadRequestException(
          'Indica la carpeta (A3T-0000) y el tipo de documento, o el número del contrato',
        );
      }
      contractNumber = await this.nextContractNumber(carpeta, kind, n);
    }

    const duplicate = await this.prisma.contracts.findFirst({
      where: { contract_number: contractNumber },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `Ya existe un contrato con el número ${contractNumber}`,
      );
    }
    const status = statusOnSave(endDate, dto.status ?? null);

    try {
      const created = await this.prisma.contracts.create({
        data: {
          ...rest,
          contract_number: contractNumber,
          document_type:
            dto.document_type ?? (kind ? docKindType(kind) : 'contrato'),
          ...(carpeta ? { carpeta } : {}),
          ...(kind && carpeta ? { document_label: docKindLabel(kind, n) } : {}),
          start_date: startDate,
          end_date: endDate,
          status,
          // J2: el que se da de alta ya vencido es histórico (sin avisos)
          vencido_historico:
            status === 'vencido' ? (dto.vencido_historico ?? true) : false,
          created_by: userId,
        },
        include: CONTRACT_INCLUDE,
      });
      this.logger.log(`Contrato ${created.contract_number} creado`);
      return aliasContract(created);
    } catch (err: unknown) {
      // Carrera sobre el UNIQUE de contract_number (duck-typing, patrón repo)
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          `Ya existe un contrato con el número ${contractNumber}`,
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateContractDto, userId: string) {
    const existing = await this.prisma.contracts.findFirst({
      where: { id, is_active: true },
    });
    if (!existing) throw new NotFoundException('Contrato no encontrado');

    await this.assertValidReferences(dto);
    const {
      carpeta: carpetaInput,
      doc_kind: kindInput,
      doc_number: nInput,
      contract_number: numberInput,
      start_date: startInput,
      end_date: endInput,
      status: statusInput,
      ...rest
    } = dto;
    // J2: el histórico se decide abajo según el estatus
    delete rest.vencido_historico;
    // undefined = no se toca; null/"" = se borra (I6: sin fecha)
    const startDate =
      startInput === undefined ? existing.start_date : toDate(startInput);
    const endDate =
      endInput === undefined ? existing.end_date : toDate(endInput);
    this.assertValidDates(startDate, endDate);

    // I6: cambio de carpeta o de tipo → etiqueta y número de nuevo
    const data: Prisma.contractsUncheckedUpdateInput = { ...rest };
    let contractNumber = numberInput?.trim() || existing.contract_number;
    if (
      carpetaInput !== undefined ||
      kindInput !== undefined ||
      nInput !== undefined
    ) {
      const carpeta =
        carpetaInput === undefined
          ? existing.carpeta
          : this.carpetaOf(carpetaInput);
      const kind = kindInput ?? docKindOf(existing);
      const n =
        kind === 'enmienda'
          ? (nInput ??
            parseDocKind(existing.document_label)?.n ??
            (carpeta ? await this.nextEnmienda(carpeta) : null))
          : null;
      data.carpeta = carpeta;
      data.document_label = carpeta ? docKindLabel(kind, n) : null;
      data.document_type = dto.document_type ?? docKindType(kind);
      if (!numberInput?.trim() && carpeta) {
        const base = baseContractNumber(carpeta, kind, n);
        const current = existing.contract_number;
        if (current !== base && !current.startsWith(`${base}-`)) {
          contractNumber = await this.nextContractNumber(carpeta, kind, n);
        }
      }
    }
    if (contractNumber !== existing.contract_number) {
      const duplicate = await this.prisma.contracts.findFirst({
        where: { contract_number: contractNumber, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException(
          `Ya existe un contrato con el número ${contractNumber}`,
        );
      }
      data.contract_number = contractNumber;
    }
    if (startInput !== undefined) data.start_date = startDate;
    if (endInput !== undefined) data.end_date = endDate;
    // Estatus por fecha de fin (renovado/cancelado se respetan)
    if (endInput !== undefined || statusInput !== undefined) {
      data.status = statusOnSave(endDate, statusInput ?? existing.status);
    }
    // J2: el histórico solo cuenta mientras esté vencido
    const statusAfter = (data.status as string | undefined) ?? existing.status;
    if (statusAfter !== 'vencido') {
      if (existing.vencido_historico) data.vencido_historico = false;
    } else if (dto.vencido_historico !== undefined) {
      data.vencido_historico = dto.vencido_historico;
    }

    const updated = await this.prisma.contracts.update({
      where: { id },
      data,
      include: CONTRACT_INCLUDE,
    });
    this.logger.log(
      `Contrato ${updated.contract_number} actualizado por ${userId}`,
    );
    return aliasContract(updated);
  }

  async remove(id: string, userId: string) {
    const existing = await this.prisma.contracts.findFirst({
      where: { id, is_active: true },
      select: { id: true, contract_number: true },
    });
    if (!existing) throw new NotFoundException('Contrato no encontrado');

    await this.prisma.contracts.update({
      where: { id },
      data: { is_active: false, deleted_at: new Date(), deleted_by: userId },
    });
    this.logger.log(
      `Contrato ${existing.contract_number} eliminado (soft) por ${userId}`,
    );
    return { message: 'Contrato eliminado' };
  }

  // ── Documentos (PDF en MinIO) ───────────────────────────────────────────

  async uploadDocument(
    contractId: string,
    file: Express.Multer.File,
    userId: string,
  ) {
    const contract = await this.prisma.contracts.findFirst({
      where: { id: contractId, is_active: true },
      select: { id: true, contract_number: true },
    });
    if (!contract) throw new NotFoundException('Contrato no encontrado');
    this.validatePdf(file);

    const last = await this.prisma.contract_documents.findFirst({
      where: { contract_id: contractId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    // Estructura de keys de §15: {contract_id}/v{version}_{timestamp}_{nombre}
    const storageKey = `${contractId}/v${version}_${Date.now()}_${sanitizedName}`;

    // Subir primero; el insert va después para que el rollback sea limpio
    // (mismo patrón que evidences).
    await this.storage.upload(
      this.storage.bucketContracts,
      storageKey,
      file.buffer,
      file.mimetype,
    );

    try {
      const [, created] = await this.prisma.$transaction([
        // Solo un documento vigente por contrato
        this.prisma.contract_documents.updateMany({
          where: { contract_id: contractId, is_current: true },
          data: { is_current: false },
        }),
        this.prisma.contract_documents.create({
          data: {
            contract_id: contractId,
            file_name: file.originalname,
            storage_key: storageKey,
            mime_type: file.mimetype,
            file_size_bytes: BigInt(file.size),
            version,
            is_current: true,
            uploaded_by: userId,
          },
          select: DOCUMENT_SELECT,
        }),
      ]);
      this.logger.log(
        `Documento v${version} subido al contrato ${contract.contract_number}`,
      );
      return mapDocument(created);
    } catch (err) {
      // Rollback: el insert falló pero el archivo ya está en MinIO.
      await this.storage.remove(this.storage.bucketContracts, storageKey);
      throw err;
    }
  }

  async getDocumentDownloadUrl(contractId: string, docId: string) {
    const doc = await this.prisma.contract_documents.findFirst({
      where: { id: docId, contract_id: contractId },
      select: { storage_key: true, file_name: true },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    const url = await this.storage.getSignedUrl(
      this.storage.bucketContracts,
      doc.storage_key,
      DOWNLOAD_TTL_SECONDS,
    );
    return { url, fileName: doc.file_name };
  }

  /** §15: se marca no-vigente; el objeto en MinIO se conserva (historial). */
  async removeDocument(contractId: string, docId: string, userId: string) {
    const doc = await this.prisma.contract_documents.findFirst({
      where: { id: docId, contract_id: contractId },
      select: { id: true, is_current: true },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    await this.prisma.contract_documents.update({
      where: { id: docId },
      data: { is_current: false },
    });
    this.logger.log(`Documento ${docId} marcado no-vigente por ${userId}`);
    return { message: 'Documento marcado como no vigente' };
  }

  // ── Alertas (consulta; el envío vive en ContractExpiryService) ──────────

  async findExpiring() {
    const today = cdmxDateUtc();
    const rows = await this.prisma.contracts.findMany({
      where: {
        is_active: true,
        status: 'vigente',
        end_date: { gte: today, lte: addDaysUtc(today, 30) },
      },
      include: CONTRACT_INCLUDE,
      orderBy: { end_date: 'asc' },
    });
    return rows.map(aliasContract);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private validatePdf(file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Archivo requerido');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Solo se aceptan PDF',
      );
    }
    if (file.size > MAX_PDF_SIZE) {
      throw new BadRequestException(
        'El archivo excede el tamaño máximo de 20MB',
      );
    }
  }

  private assertValidDates(start: Date | null, end: Date | null) {
    if (start && end && end.getTime() < start.getTime()) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la fecha de inicio',
      );
    }
  }

  /** I6: "a3t-3" → "A3T-0003"; vacía → null; otra forma → 400. */
  private carpetaOf(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value.trim() === '') {
      return null;
    }
    const carpeta = normalizeCarpeta(value);
    if (!carpeta) {
      throw new BadRequestException(
        `La carpeta "${value}" debe tener la forma A3T-0000`,
      );
    }
    return carpeta;
  }

  /** I6: número libre para la carpeta y el tipo (los dados de baja cuentan). */
  private async nextContractNumber(
    carpeta: string,
    kind: ContractDocKind,
    n: number | null,
  ): Promise<string> {
    const base = baseContractNumber(carpeta, kind, n);
    const taken = await this.prisma.contracts.findMany({
      where: { contract_number: { startsWith: base } },
      select: { contract_number: true },
    });
    const numbers = new Set(taken.map((t) => t.contract_number));
    return contractNumberFor(carpeta, kind, n, (num) => numbers.has(num));
  }

  /** I6: la enmienda sin número es la siguiente de la carpeta. */
  private async nextEnmienda(carpeta: string): Promise<number> {
    const docs = await this.prisma.contracts.findMany({
      where: { carpeta, document_type: 'addenda' },
      select: { document_label: true },
    });
    const max = Math.max(
      0,
      ...docs.map((d) => parseDocKind(d.document_label)?.n ?? 0),
    );
    return max + 1;
  }

  private async assertValidReferences(dto: {
    supplier_id?: string;
    buyer_profile_id?: string;
  }) {
    if (dto.supplier_id) {
      const supplier = await this.prisma.suppliers.findFirst({
        where: { id: dto.supplier_id, is_active: true },
        select: { id: true },
      });
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    }
    if (dto.buyer_profile_id) {
      const buyer = await this.prisma.profiles.findFirst({
        where: { id: dto.buyer_profile_id, is_active: true },
        select: { id: true },
      });
      if (!buyer)
        throw new NotFoundException('Comprador (perfil) no encontrado');
    }
  }
}
