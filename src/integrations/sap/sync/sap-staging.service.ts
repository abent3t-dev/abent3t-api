import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SapBusinessPartnerDto,
  SapPurchaseOrderDto,
  SapPurchaseRequestDto,
} from '../dto/sap-document.dto';
import { SAP_MAPPER_VERSION, sapRawHash } from '../sap.mapper';
import { SapUpsertOutcome } from './sap-sync.types';

/**
 * Upsert idempotente a staging SAP (Fase INT-4). ÚNICO camino de escritura a
 * `sap_purchase_orders` / `sap_purchase_requests`.
 *
 * La clave natural es `doc_entry` (entero único por entidad — SAP no tiene
 * revisiones: el documento se actualiza in place), así que Prisma sí puede
 * hacer `upsert` nativo... pero se conserva el patrón findFirst +
 * create/update + P2002 del staging de Maximo para poder comparar el
 * `raw_hash` ANTES de escribir: sin cambio → solo `last_seen_at` (no se
 * reescribe el jsonb de ~32 KB en cada corrida).
 */
@Injectable()
export class SapStagingService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertPurchaseOrder(
    dto: SapPurchaseOrderDto,
    raw: unknown,
    runId: string,
  ): Promise<SapUpsertOutcome> {
    const rawHash = sapRawHash(raw);
    const mapped = {
      doc_num: dto.docNum,
      doc_date: toDate(dto.docDate),
      doc_due_date: toDate(dto.docDueDate),
      update_date_source: toDate(dto.updateDate),
      document_status: dto.documentStatus,
      comments: dto.comments,
      card_code: dto.cardCode,
      card_name: dto.cardName,
      doc_total: dto.docTotal,
      currency: dto.currency,
      lines_total: dto.linesTotal,
      lines_classified: dto.linesClassified,
      ahorro_total: dto.ahorroTotal,
    };

    const attempt = async (): Promise<SapUpsertOutcome> => {
      const existing = await this.prisma.sap_purchase_orders.findFirst({
        where: { doc_entry: dto.docEntry },
        select: { id: true, raw_hash: true },
      });
      if (!existing) {
        await this.prisma.sap_purchase_orders.create({
          data: {
            doc_entry: dto.docEntry,
            ...mapped,
            raw_hash: rawHash,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: SAP_MAPPER_VERSION,
            last_sync_run_id: runId,
          },
        });
        return 'inserted';
      }
      const unchanged = existing.raw_hash === rawHash;
      await this.prisma.sap_purchase_orders.update({
        where: { id: existing.id },
        data: unchanged
          ? { last_seen_at: new Date(), last_sync_run_id: runId }
          : {
              ...mapped,
              raw_hash: rawHash,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: SAP_MAPPER_VERSION,
              last_seen_at: new Date(),
              last_changed_at: new Date(),
              last_sync_run_id: runId,
            },
      });
      return unchanged ? 'unchanged' : 'updated';
    };

    return this.withUniqueRaceRetry(attempt);
  }

  async upsertPurchaseRequest(
    dto: SapPurchaseRequestDto,
    raw: unknown,
    runId: string,
  ): Promise<SapUpsertOutcome> {
    const rawHash = sapRawHash(raw);
    const mapped = {
      doc_num: dto.docNum,
      doc_date: toDate(dto.docDate),
      doc_due_date: toDate(dto.docDueDate),
      required_date: toDate(dto.requiredDate),
      update_date_source: toDate(dto.updateDate),
      document_status: dto.documentStatus,
      comments: dto.comments,
      requester: dto.requester,
      requester_name: dto.requesterName,
      doc_total: dto.docTotal,
      currency: dto.currency,
      lines_total: dto.linesTotal,
      lines_classified: dto.linesClassified,
      ahorro_total: dto.ahorroTotal,
    };

    const attempt = async (): Promise<SapUpsertOutcome> => {
      const existing = await this.prisma.sap_purchase_requests.findFirst({
        where: { doc_entry: dto.docEntry },
        select: { id: true, raw_hash: true },
      });
      if (!existing) {
        await this.prisma.sap_purchase_requests.create({
          data: {
            doc_entry: dto.docEntry,
            ...mapped,
            raw_hash: rawHash,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: SAP_MAPPER_VERSION,
            last_sync_run_id: runId,
          },
        });
        return 'inserted';
      }
      const unchanged = existing.raw_hash === rawHash;
      await this.prisma.sap_purchase_requests.update({
        where: { id: existing.id },
        data: unchanged
          ? { last_seen_at: new Date(), last_sync_run_id: runId }
          : {
              ...mapped,
              raw_hash: rawHash,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: SAP_MAPPER_VERSION,
              last_seen_at: new Date(),
              last_changed_at: new Date(),
              last_sync_run_id: runId,
            },
      });
      return unchanged ? 'unchanged' : 'updated';
    };

    return this.withUniqueRaceRetry(attempt);
  }

  async upsertBusinessPartner(
    dto: SapBusinessPartnerDto,
    raw: unknown,
    runId: string,
  ): Promise<SapUpsertOutcome> {
    const rawHash = sapRawHash(raw);
    const mapped = {
      card_name: dto.cardName,
      card_type: dto.cardType,
      federal_tax_id: dto.federalTaxId,
      email: dto.email,
      phone1: dto.phone1,
      phone2: dto.phone2,
      contact_person: dto.contactPerson,
      website: dto.website,
      currency: dto.currency,
      sap_valid: dto.sapValid,
      sap_frozen: dto.sapFrozen,
      update_date_source: toDate(dto.updateDate),
    };

    const attempt = async (): Promise<SapUpsertOutcome> => {
      const existing = await this.prisma.sap_business_partners.findFirst({
        where: { card_code: dto.cardCode },
        select: { id: true, raw_hash: true },
      });
      if (!existing) {
        await this.prisma.sap_business_partners.create({
          data: {
            card_code: dto.cardCode,
            ...mapped,
            raw_hash: rawHash,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: SAP_MAPPER_VERSION,
            last_sync_run_id: runId,
          },
        });
        return 'inserted';
      }
      const unchanged = existing.raw_hash === rawHash;
      await this.prisma.sap_business_partners.update({
        where: { id: existing.id },
        data: unchanged
          ? { last_seen_at: new Date(), last_sync_run_id: runId }
          : {
              ...mapped,
              raw_hash: rawHash,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: SAP_MAPPER_VERSION,
              last_seen_at: new Date(),
              last_changed_at: new Date(),
              last_sync_run_id: runId,
            },
      });
      return unchanged ? 'unchanged' : 'updated';
    };

    return this.withUniqueRaceRetry(attempt);
  }

  /** Carrera de doble insert (índice único) → P2002 → reintento como update. */
  private async withUniqueRaceRetry(
    attempt: () => Promise<SapUpsertOutcome>,
  ): Promise<SapUpsertOutcome> {
    try {
      return await attempt();
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'P2002') {
        return attempt();
      }
      throw err;
    }
  }
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
