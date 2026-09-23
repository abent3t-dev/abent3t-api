import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateErpAliasDto,
  ERP_ALIAS_SYSTEMS,
  ErpAliasQueryDto,
  ErpAliasSystem,
  UpdateErpAliasDto,
} from './dto/erp-alias.dto';

/**
 * Bloque 2026-09-23 (D6) — Equivalencias de usuarios de SAP y Maximo.
 *
 * Los ERPs entregan códigos (CGAZB, AMMD1, jgonzalez.a3t…); Ingrid/Alfredo
 * cargan aquí "código → nombre" (y, si aplica, el perfil de la plataforma
 * para ligar al aprobador con su rol). SOLO presentación: el staging
 * conserva los códigos; `resolve` los traduce al mostrar. Sin alias, todo se
 * ve como hoy (el código).
 *
 * Los alias son pocos (decenas): se cachean en memoria por sistema durante
 * CACHE_MS y se invalidan en cada escritura.
 */

export interface ErpAliasEntry {
  code: string;
  display_name: string;
  profile_id: string | null;
}

const CACHE_MS = 30_000;

const ALIAS_SELECT = {
  id: true,
  system: true,
  code: true,
  display_name: true,
  profile_id: true,
  is_active: true,
  created_at: true,
  updated_at: true,
  profiles_erp_user_aliases_profile_idToprofiles: {
    select: { full_name: true, email: true },
  },
} as const;

type AliasRow = {
  id: string;
  system: string;
  code: string;
  display_name: string;
  profile_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  profiles_erp_user_aliases_profile_idToprofiles: {
    full_name: string | null;
    email: string;
  } | null;
};

export interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

type ImportRecord = {
  system?: string;
  code?: string;
  name?: string;
  email?: string;
};

/** Encabezados aceptados en CSV/Excel (sin acentos, minúsculas). */
const HEADER_ALIASES: Record<string, keyof ImportRecord> = {
  system: 'system',
  sistema: 'system',
  erp: 'system',
  code: 'code',
  codigo: 'code',
  usuario: 'code',
  user: 'code',
  userid: 'code',
  clave: 'code',
  name: 'name',
  nombre: 'name',
  display_name: 'name',
  displayname: 'name',
  email: 'email',
  correo: 'email',
};

const normalizeHeader = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z_]/g, '');

@Injectable()
export class ErpAliasesService {
  private readonly logger = new Logger(ErpAliasesService.name);
  private cache = new Map<
    ErpAliasSystem,
    { at: number; byCode: Map<string, ErpAliasEntry> }
  >();

  constructor(private readonly prisma: PrismaService) {}

  // ── Consulta / CRUD (gestión) ───────────────────────────────────────────

  async list(query: ErpAliasQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const term = query.search?.trim();
    const where = {
      ...(query.system ? { system: query.system } : {}),
      ...(term
        ? {
            OR: [
              { code: { contains: term, mode: 'insensitive' as const } },
              {
                display_name: { contains: term, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.erp_user_aliases.count({ where }),
      this.prisma.erp_user_aliases.findMany({
        where,
        select: ALIAS_SELECT,
        orderBy: [{ system: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: rows.map((r) => this.toView(r)),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async create(dto: CreateErpAliasDto, userId: string) {
    const existing = await this.findByCode(dto.system, dto.code);
    if (existing) {
      throw new ConflictException(
        `Ya existe un alias para ${dto.system.toUpperCase()} / ${existing.code}`,
      );
    }
    if (dto.profile_id) await this.assertProfile(dto.profile_id);
    const row = await this.prisma.erp_user_aliases.create({
      data: {
        system: dto.system,
        code: dto.code,
        display_name: dto.display_name,
        profile_id: dto.profile_id ?? null,
        created_by: userId,
      },
      select: ALIAS_SELECT,
    });
    this.invalidate(dto.system);
    return this.toView(row);
  }

  async update(id: string, dto: UpdateErpAliasDto) {
    const current = await this.prisma.erp_user_aliases.findUnique({
      where: { id },
      select: { id: true, system: true },
    });
    if (!current) throw new NotFoundException('Alias no encontrado');
    if (dto.profile_id) await this.assertProfile(dto.profile_id);
    const row = await this.prisma.erp_user_aliases.update({
      where: { id },
      data: {
        ...(dto.display_name !== undefined
          ? { display_name: dto.display_name }
          : {}),
        ...(dto.profile_id !== undefined ? { profile_id: dto.profile_id } : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
      },
      select: ALIAS_SELECT,
    });
    this.invalidate(current.system as ErpAliasSystem);
    return this.toView(row);
  }

  /** Baja física: es configuración de presentación, no un registro de negocio. */
  async remove(id: string) {
    const current = await this.prisma.erp_user_aliases.findUnique({
      where: { id },
      select: { id: true, system: true },
    });
    if (!current) throw new NotFoundException('Alias no encontrado');
    await this.prisma.erp_user_aliases.delete({ where: { id } });
    this.invalidate(current.system as ErpAliasSystem);
    return { message: 'Alias eliminado' };
  }

  /**
   * Importación desde CSV (`,` o `;`) o Excel (primera hoja). Columnas:
   * `sistema` (opcional si viene `system` en el form), `usuario`/`codigo`,
   * `nombre` y opcionalmente `email` (liga el perfil de la plataforma).
   * Upsert por (sistema, código); nunca borra.
   */
  async importFile(
    file: { buffer: Buffer; originalname: string; mimetype: string },
    defaultSystem: ErpAliasSystem | undefined,
    userId: string,
  ): Promise<ImportResult> {
    const records = await this.parseFile(file);
    const result: ImportResult = {
      rows: records.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };
    const touched = new Set<ErpAliasSystem>();
    for (const [index, record] of records.entries()) {
      const line = index + 2;
      // Columna "sistema" vacía en la fila → el sistema elegido en el form.
      const system = (record.system?.trim() || defaultSystem || '')
        .toLowerCase()
        .trim() as ErpAliasSystem;
      if (!ERP_ALIAS_SYSTEMS.includes(system)) {
        result.errors.push(`Fila ${line}: sistema inválido "${system}"`);
        result.skipped += 1;
        continue;
      }
      const code = (record.code ?? '').trim();
      const name = (record.name ?? '').trim();
      if (!code || !name) {
        result.errors.push(`Fila ${line}: falta usuario o nombre`);
        result.skipped += 1;
        continue;
      }
      let profileId: string | undefined;
      const email = (record.email ?? '').trim().toLowerCase();
      if (email) {
        const profile = await this.prisma.profiles.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (!profile) {
          result.errors.push(
            `Fila ${line}: no hay perfil con el correo ${email} (se carga sin ligar)`,
          );
        } else {
          profileId = profile.id;
        }
      }
      try {
        const existing = await this.findByCode(system, code);
        if (existing) {
          await this.prisma.erp_user_aliases.update({
            where: { id: existing.id },
            data: {
              display_name: name,
              is_active: true,
              ...(profileId ? { profile_id: profileId } : {}),
            },
          });
          result.updated += 1;
        } else {
          await this.prisma.erp_user_aliases.create({
            data: {
              system,
              code,
              display_name: name,
              profile_id: profileId ?? null,
              created_by: userId,
            },
          });
          result.created += 1;
        }
        touched.add(system);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Fila ${line}: ${msg.slice(0, 120)}`);
        result.skipped += 1;
      }
    }
    for (const system of touched) this.invalidate(system);
    this.logger.log(
      `Importación de alias: filas=${result.rows} creados=${result.created} actualizados=${result.updated} omitidos=${result.skipped}`,
    );
    return result;
  }

  // ── Resolución (lectura, usada por los módulos de dominio) ───────────────

  /** Alias activos del sistema, indexados por código en minúsculas. */
  async byCode(system: ErpAliasSystem): Promise<Map<string, ErpAliasEntry>> {
    const cached = this.cache.get(system);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.byCode;
    const rows = await this.prisma.erp_user_aliases.findMany({
      where: { system, is_active: true },
      select: { code: true, display_name: true, profile_id: true },
    });
    const byCode = new Map<string, ErpAliasEntry>();
    for (const row of rows) byCode.set(row.code.trim().toLowerCase(), row);
    this.cache.set(system, { at: Date.now(), byCode });
    return byCode;
  }

  /** Nombre a mostrar de un código; el propio código si no hay alias. */
  async displayName(
    system: ErpAliasSystem,
    code: string | null,
  ): Promise<string | null> {
    if (code === null) return null;
    const map = await this.byCode(system);
    return map.get(code.trim().toLowerCase())?.display_name ?? code;
  }

  /**
   * Traduce varios códigos de una vez: `{ código → nombre }` solo para los
   * que tienen alias (los demás no aparecen; el caller conserva el código).
   */
  async resolveMany(
    system: ErpAliasSystem,
    codes: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const map = await this.byCode(system);
    const out = new Map<string, string>();
    for (const code of codes) {
      if (!code) continue;
      const hit = map.get(code.trim().toLowerCase());
      if (hit) out.set(code, hit.display_name);
    }
    return out;
  }

  /** Alias (ambos sistemas) ligados a los perfiles indicados. */
  async forProfiles(profileIds: string[]) {
    if (profileIds.length === 0) return [];
    return this.prisma.erp_user_aliases.findMany({
      where: { is_active: true, profile_id: { in: profileIds } },
      select: {
        system: true,
        code: true,
        display_name: true,
        profile_id: true,
      },
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async findByCode(system: ErpAliasSystem, code: string) {
    return this.prisma.erp_user_aliases.findFirst({
      where: { system, code: { equals: code.trim(), mode: 'insensitive' } },
      select: { id: true, code: true },
    });
  }

  private async assertProfile(profileId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: { id: true },
    });
    if (!profile) throw new BadRequestException('El perfil no existe');
  }

  private invalidate(system: ErpAliasSystem) {
    this.cache.delete(system);
  }

  private toView(row: AliasRow) {
    const profile = row.profiles_erp_user_aliases_profile_idToprofiles;
    return {
      id: row.id,
      system: row.system,
      code: row.code,
      display_name: row.display_name,
      profile_id: row.profile_id,
      profile: profile
        ? { full_name: profile.full_name, email: profile.email }
        : null,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async parseFile(file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  }): Promise<ImportRecord[]> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Archivo vacío');
    }
    const name = file.originalname.toLowerCase();
    const isExcel =
      name.endsWith('.xlsx') ||
      file.mimetype.includes('spreadsheetml') ||
      file.mimetype.includes('ms-excel');
    const table: string[][] = [];
    if (isExcel) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new BadRequestException('El Excel no tiene hojas');
      sheet.eachRow((row) => {
        const values = (row.values as unknown[]).slice(1);
        table.push(values.map((v) => cellText(v)));
      });
    } else {
      // BOM de Excel/Windows al inicio del CSV (U+FEFF)
      const raw = file.buffer.toString('utf8');
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const firstLine = text.split('\n')[0] ?? '';
      const separator = firstLine.includes(';') ? ';' : ',';
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        table.push(splitCsvLine(line, separator));
      }
    }
    if (table.length === 0) throw new BadRequestException('Archivo sin filas');
    const header = table[0].map((h) => HEADER_ALIASES[normalizeHeader(h)]);
    if (!header.includes('code') || !header.includes('name')) {
      throw new BadRequestException(
        'El archivo debe traer las columnas "usuario" (código del ERP) y "nombre"; opcionales "sistema" y "email"',
      );
    }
    return table.slice(1).map((cells) => {
      const record: ImportRecord = {};
      header.forEach((key, i) => {
        if (key) record[key] = cells[i] ?? '';
      });
      return record;
    });
  }
}

/** Solo escalares se convierten a texto (un objeto desconocido → ''). */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** Texto de una celda de ExcelJS (valor plano, fórmula, rich text o fecha). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || value instanceof Date) {
    return scalarText(value);
  }
  const v = value as { text?: unknown; result?: unknown; richText?: unknown };
  if (Array.isArray(v.richText)) {
    return v.richText
      .map((r) => scalarText((r as { text?: unknown }).text))
      .join('');
  }
  if (v.text !== undefined) return scalarText(v.text);
  if (v.result !== undefined) return scalarText(v.result);
  return '';
}

/** CSV mínimo: comillas dobles opcionales, sin saltos de línea embebidos. */
function splitCsvLine(line: string, separator: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === separator && !quoted) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}
