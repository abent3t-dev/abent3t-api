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
import { addDaysUtc, cdmxDateUtc } from './contracts.dates';
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
 */

const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB (§15)
const DOWNLOAD_TTL_SECONDS = 300; // 5 min (§15)

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
    ...rest
  } = row;
  return {
    ...rest,
    total_amount: total_amount === null ? null : Number(total_amount),
    supplier: suppliers,
    buyer,
  };
}

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findAll(query: ContractQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

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
    if (query.search) {
      where.OR = [
        { contract_number: { contains: query.search, mode: 'insensitive' } },
        {
          service_description: { contains: query.search, mode: 'insensitive' },
        },
        {
          suppliers: {
            legal_name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

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
    this.assertValidDates(dto.start_date, dto.end_date);

    const duplicate = await this.prisma.contracts.findFirst({
      where: { contract_number: dto.contract_number },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `Ya existe un contrato con el número ${dto.contract_number}`,
      );
    }

    try {
      const created = await this.prisma.contracts.create({
        data: {
          ...dto,
          start_date: new Date(dto.start_date),
          end_date: new Date(dto.end_date),
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
          `Ya existe un contrato con el número ${dto.contract_number}`,
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
    this.assertValidDates(
      dto.start_date ?? existing.start_date.toISOString(),
      dto.end_date ?? existing.end_date.toISOString(),
    );

    if (
      dto.contract_number &&
      dto.contract_number !== existing.contract_number
    ) {
      const duplicate = await this.prisma.contracts.findFirst({
        where: { contract_number: dto.contract_number, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException(
          `Ya existe un contrato con el número ${dto.contract_number}`,
        );
      }
    }

    const updated = await this.prisma.contracts.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.start_date ? { start_date: new Date(dto.start_date) } : {}),
        ...(dto.end_date ? { end_date: new Date(dto.end_date) } : {}),
      },
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

  private assertValidDates(start: string | Date, end: string | Date) {
    if (new Date(end).getTime() < new Date(start).getTime()) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la fecha de inicio',
      );
    }
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
