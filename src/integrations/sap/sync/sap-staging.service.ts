import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SapApprovalRequestDto,
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
      cancelled: dto.cancelled,
      cancel_status: dto.cancelStatus,
      authorization_status: dto.authorizationStatus,
      confirmed: dto.confirmed,
      closing_date: toDate(dto.closingDate),
      comments: dto.comments,
      card_code: dto.cardCode,
      card_name: dto.cardName,
      doc_total: dto.docTotal,
      currency: dto.currency,
      lines_total: dto.linesTotal,
      lines_classified: dto.linesClassified,
      ahorro_total: dto.ahorroTotal,
      open_total: dto.openTotal,
      user_sign: dto.userSign,
      created_by_name: dto.createdByName,
      maximo_ponum: dto.maximoPonum,
      base_request_entries: dto.baseRequestEntries,
    };

    const attempt = async (): Promise<SapUpsertOutcome> => {
      const existing = await this.prisma.sap_purchase_orders.findFirst({
        where: { doc_entry: dto.docEntry },
        select: { id: true, raw_hash: true, mapper_version: true },
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
      const unchanged =
        existing.raw_hash === rawHash &&
        existing.mapper_version === SAP_MAPPER_VERSION;
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
      cancelled: dto.cancelled,
      cancel_status: dto.cancelStatus,
      authorization_status: dto.authorizationStatus,
      confirmed: dto.confirmed,
      closing_date: toDate(dto.closingDate),
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
        select: { id: true, raw_hash: true, mapper_version: true },
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
      const unchanged =
        existing.raw_hash === rawHash &&
        existing.mapper_version === SAP_MAPPER_VERSION;
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
        select: { id: true, raw_hash: true, mapper_version: true },
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
      const unchanged =
        existing.raw_hash === rawHash &&
        existing.mapper_version === SAP_MAPPER_VERSION;
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

  /** Cola de autorización (B5): una fila por Code; `raw` = { request, draft }. */
  async upsertApprovalRequest(
    dto: SapApprovalRequestDto,
    raw: unknown,
    runId: string,
  ): Promise<SapUpsertOutcome> {
    const rawHash = sapRawHash(raw);
    const mapped = {
      approval_template_id: dto.approvalTemplateId,
      template_name: dto.templateName,
      object_type: dto.objectType,
      is_draft: dto.isDraft,
      draft_entry: dto.draftEntry,
      draft_type: dto.draftType,
      object_entry: dto.objectEntry,
      status: dto.status,
      remarks: dto.remarks,
      current_stage: dto.currentStage,
      current_stage_name: dto.currentStageName,
      originator_id: dto.originatorId,
      originator_name: dto.originatorName,
      creation_date: toDate(dto.creationDate),
      doc_num: dto.docNum,
      doc_date: toDate(dto.docDate),
      doc_total: dto.docTotal,
      currency: dto.currency,
      card_name: dto.cardName,
      requester_name: dto.requesterName,
      // snake_case: es lo que leen la UI y el SQL de tiempos (jsonb_array_elements)
      approvers: dto.approvers.map((a) => ({
        stage_code: a.stageCode,
        stage_name: a.stageName,
        user_id: a.userId,
        user_name: a.userName,
        status: a.status,
        update_date: a.updateDate,
      })) as unknown as Prisma.InputJsonValue,
    };

    const attempt = async (): Promise<SapUpsertOutcome> => {
      const existing = await this.prisma.sap_approval_requests.findFirst({
        where: { code: dto.code },
        select: { id: true, raw_hash: true, mapper_version: true },
      });
      if (!existing) {
        await this.prisma.sap_approval_requests.create({
          data: {
            code: dto.code,
            ...mapped,
            raw_hash: rawHash,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: SAP_MAPPER_VERSION,
            last_sync_run_id: runId,
          },
        });
        return 'inserted';
      }
      const unchanged =
        existing.raw_hash === rawHash &&
        existing.mapper_version === SAP_MAPPER_VERSION;
      await this.prisma.sap_approval_requests.update({
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
