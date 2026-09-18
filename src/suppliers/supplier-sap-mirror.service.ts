import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espejo del staging de proveedores de SAP hacia el catálogo `suppliers`
 * (petición de Ingrid 2026-09-18; decisión del principal: llenar el apartado
 * EXISTENTE, no pantallas nuevas).
 *
 * Reglas:
 * - Lee `sap_business_partners` (staging) vía Prisma — el dominio NO importa
 *   la capa externa, mismo criterio que el módulo de lectura de Int-4/5.
 * - Escribe SOLO los datos básicos: nombre, RFC, email, teléfono, contacto,
 *   moneda y los flags informativos sap_valid/sap_frozen.
 * - JAMÁS toca lo que es de ABENT: performance_score, is_blocked/blocked_*,
 *   is_active, commercial_name, address, contact_email, contact_phone.
 *   Un proveedor desactivado a mano en ABENT NO se revive.
 * - Clave del espejo: (source='sap', external_id=CardCode) — índice único
 *   parcial de la migración 0010 (Prisma no modela índices parciales: el
 *   upsert va por findFirst + create con manejo de P2002).
 * - `tax_id` es UNIQUE y en SAP hay RFC repetidos (43 comparten el genérico
 *   de extranjeros XEXX010101000): cascada RFC → "RFC-CardCode" → CardCode.
 *
 * Idempotente y barato (~900 filas): corre cada hora al minuto 45 (después
 * del tick horario del sync, que arranca con jitter) y bajo demanda vía
 * POST /suppliers/sap-mirror. Con el staging vacío es un no-op.
 */

export interface SapMirrorSummary {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Filas que no pudieron escribirse ni con los fallbacks de tax_id. */
  conflicts: number;
  errors: number;
}

const BATCH_SIZE = 200;
const TAX_ID_MAX = 40;

interface StagedBp {
  card_code: string;
  card_name: string | null;
  federal_tax_id: string | null;
  email: string | null;
  phone1: string | null;
  contact_person: string | null;
  currency: string | null;
  sap_valid: boolean | null;
  sap_frozen: boolean | null;
}

@Injectable()
export class SupplierSapMirrorService {
  private readonly logger = new Logger(SupplierSapMirrorService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Corre cada hora (min 45); nunca lanza. */
  @Cron('45 * * * *')
  async cronMirror(): Promise<void> {
    try {
      const summary = await this.runMirror();
      if (summary.scanned > 0 && (summary.created || summary.updated)) {
        this.logger.log(
          `espejo de proveedores: +${summary.created} nuevos, ~${summary.updated} actualizados de ${summary.scanned}`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `espejo de proveedores falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Una pasada completa staging → catálogo. Mutex simple (idempotente). */
  async runMirror(): Promise<SapMirrorSummary> {
    if (this.running) {
      return {
        scanned: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        conflicts: 0,
        errors: 0,
      };
    }
    this.running = true;
    const summary: SapMirrorSummary = {
      scanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      conflicts: 0,
      errors: 0,
    };
    try {
      let cursor: string | null = null;
      for (;;) {
        const batch: StagedBp[] =
          await this.prisma.sap_business_partners.findMany({
            where: cursor ? { card_code: { gt: cursor } } : {},
            orderBy: { card_code: 'asc' },
            take: BATCH_SIZE,
            select: {
              card_code: true,
              card_name: true,
              federal_tax_id: true,
              email: true,
              phone1: true,
              contact_person: true,
              currency: true,
              sap_valid: true,
              sap_frozen: true,
            },
          });
        if (batch.length === 0) break;
        for (const bp of batch) {
          summary.scanned += 1;
          try {
            await this.mirrorOne(bp, summary);
          } catch (err: unknown) {
            summary.errors += 1;
            this.logger.warn(
              `espejo ${bp.card_code} falló: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        cursor = batch[batch.length - 1].card_code;
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async mirrorOne(
    bp: StagedBp,
    summary: SapMirrorSummary,
  ): Promise<void> {
    const basics = {
      legal_name: bp.card_name ?? bp.card_code,
      email: bp.email,
      phone: bp.phone1,
      contact_name: bp.contact_person,
      currency: bp.currency,
      sap_valid: bp.sap_valid,
      sap_frozen: bp.sap_frozen,
    };

    const existing = await this.prisma.suppliers.findFirst({
      where: { source: 'sap', external_id: bp.card_code },
      select: {
        id: true,
        legal_name: true,
        tax_id: true,
        email: true,
        phone: true,
        contact_name: true,
        currency: true,
        sap_valid: true,
        sap_frozen: true,
      },
    });

    if (!existing) {
      const created = await this.createWithTaxIdFallback(bp, basics);
      if (created === 'created') summary.created += 1;
      else if (created === 'race') summary.unchanged += 1;
      else summary.conflicts += 1;
      return;
    }

    // Formas aceptables del tax_id para ESTE proveedor: no se reescribe si
    // ya está en cualquiera de ellas (evita churn con los fallbacks).
    const acceptableTaxIds = this.taxIdCandidates(bp);
    const taxIdOk = acceptableTaxIds.includes(existing.tax_id);
    const sameBasics =
      existing.legal_name === basics.legal_name &&
      existing.email === basics.email &&
      existing.phone === basics.phone &&
      existing.contact_name === basics.contact_name &&
      existing.currency === basics.currency &&
      existing.sap_valid === basics.sap_valid &&
      existing.sap_frozen === basics.sap_frozen;
    if (sameBasics && taxIdOk) {
      summary.unchanged += 1;
      return;
    }

    if (taxIdOk) {
      await this.prisma.suppliers.update({
        where: { id: existing.id },
        data: basics,
      });
      summary.updated += 1;
      return;
    }
    // El RFC cambió en SAP: misma cascada de unicidad que en el alta.
    for (const candidate of acceptableTaxIds) {
      try {
        await this.prisma.suppliers.update({
          where: { id: existing.id },
          data: { ...basics, tax_id: candidate },
        });
        summary.updated += 1;
        return;
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
      }
    }
    // Ningún candidato libre: se actualizan los básicos y el tax_id se queda.
    await this.prisma.suppliers.update({
      where: { id: existing.id },
      data: basics,
    });
    summary.updated += 1;
    summary.conflicts += 1;
  }

  /** RFC → "RFC-CardCode" → CardCode (todas ≤ 40 y la última siempre única). */
  private taxIdCandidates(bp: StagedBp): string[] {
    const candidates: string[] = [];
    const rfc = bp.federal_tax_id?.trim();
    if (rfc) {
      candidates.push(rfc.slice(0, TAX_ID_MAX));
      const combined = `${rfc}-${bp.card_code}`;
      if (combined.length <= TAX_ID_MAX) candidates.push(combined);
    }
    candidates.push(bp.card_code.slice(0, TAX_ID_MAX));
    return [...new Set(candidates)];
  }

  private async createWithTaxIdFallback(
    bp: StagedBp,
    basics: Record<string, unknown>,
  ): Promise<'created' | 'race' | 'conflict'> {
    for (const taxId of this.taxIdCandidates(bp)) {
      try {
        await this.prisma.suppliers.create({
          data: {
            ...basics,
            legal_name: basics.legal_name as string,
            tax_id: taxId,
            source: 'sap',
            external_id: bp.card_code,
            is_active: true,
          },
        });
        return 'created';
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
        // P2002 puede ser por tax_id (probar siguiente candidato) o por la
        // carrera del índice (source, external_id): si la fila ya existe,
        // otra pasada la creó — se deja para la siguiente vuelta.
        const raced = await this.prisma.suppliers.findFirst({
          where: { source: 'sap', external_id: bp.card_code },
          select: { id: true },
        });
        if (raced) return 'race';
      }
    }
    this.logger.warn(
      `espejo ${bp.card_code}: sin tax_id libre (RFC ${bp.federal_tax_id ?? '—'}) — fila omitida`,
    );
    return 'conflict';
  }
}
