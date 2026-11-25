import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  resumir,
  resumirDevoluciones,
  SIN_COSTO,
  type FilaExistencia,
} from './almacen-resumen';

/** Fecha sin zona de Postgres (Prisma la lee como UTC) → 'AAAA-MM-DDTHH:MM:SS', hora de México. */
export const sinZona = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 19) : null;

const num = (d: Prisma.Decimal | null): number | null =>
  d === null ? null : Number(d);
const redondea = (x: number) => Math.round(x * 1e6) / 1e6;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export interface Ubicacion {
  clave: string;
  descripcion: string;
  tipo: string;
  grupo: string;
}

/** Lo del corte, sin el Excel (que pesa unos 2 MB y solo se lee al descargarlo). */
const CAMPOS_CORTE = {
  id: true,
  almacen: true,
  fecha_corte: true,
  version: true,
  estado: true,
  titulo: true,
  fuente: true,
  articulos: true,
  unidades: true,
  total_pesos: true,
  total_pesos_oc: true,
  sin_valuar_articulos: true,
  sin_valuar_unidades: true,
  archivo_nombre: true,
  archivo_sha256: true,
  cargado_en: true,
  reemplazado_en: true,
  version_reporte: true,
  revision: true,
  aceptado_en: true,
  ubicaciones: true,
} satisfies Prisma.almacen_cortesSelect;

type Corte = Prisma.almacen_cortesGetPayload<{ select: typeof CAMPOS_CORTE }>;

const ubicacionesDe = (c: Corte): Ubicacion[] =>
  Array.isArray(c.ubicaciones) ? (c.ubicaciones as unknown as Ubicacion[]) : [];

function corteDto(c: Corte) {
  return {
    id: c.id,
    almacen: c.almacen,
    fechaCorte: sinZona(c.fecha_corte),
    version: c.version,
    versionReporte: c.version_reporte,
    estado: c.estado,
    revision: c.revision,
    aceptadoEn: c.aceptado_en ? c.aceptado_en.toISOString() : null,
    titulo: c.titulo,
    fuente: c.fuente,
    totales: {
      pesos: Number(c.total_pesos),
      pesosOc: Number(c.total_pesos_oc),
      articulos: c.articulos,
      unidades: Number(c.unidades),
      sinValuarArticulos: c.sin_valuar_articulos,
      sinValuarUnidades: Number(c.sin_valuar_unidades),
    },
    ubicaciones: ubicacionesDe(c),
    archivo: { nombre: c.archivo_nombre, sha256: c.archivo_sha256 },
    cargadoEn: c.cargado_en.toISOString(),
    reemplazadoEn: c.reemplazado_en ? c.reemplazado_en.toISOString() : null,
  };
}

/**
 * Almacén (0026 y 0027): lectura de los cortes del reporte de inventario. Solo
 * lee: los cortes los carga `npm run almacen:cargar` (documentation/ALMACEN.md).
 */
@Injectable()
export class AlmacenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Los cortes publicados, del más reciente al más antiguo. */
  async cortes() {
    const lista = await this.prisma.almacen_cortes.findMany({
      where: { estado: 'publicado' },
      select: CAMPOS_CORTE,
      orderBy: [{ fecha_corte: 'desc' }, { almacen: 'asc' }],
    });
    return lista.map(corteDto);
  }

  private async corte(id: string): Promise<Corte> {
    const c = await this.prisma.almacen_cortes.findUnique({
      where: { id },
      select: CAMPOS_CORTE,
    });
    if (!c) throw new NotFoundException('No existe ese corte');
    return c;
  }

  /**
   * Los almacenes de un filtro: la clave de una ubicación del corte o el nombre
   * de un grupo (todas las suyas). Sin filtro, null (todos).
   */
  private almacenesDe(c: Corte, ubicacion?: string): string[] | null {
    const u = ubicacion?.trim();
    if (!u) return null;
    const lista = ubicacionesDe(c);
    if (!lista.length && u === c.almacen) return null;
    if (lista.some((x) => x.clave === u)) return [u];
    const delGrupo = lista.filter((x) => x.grupo === u).map((x) => x.clave);
    if (delGrupo.length) return delGrupo;
    throw new BadRequestException('No existe esa ubicación en el corte');
  }

  /**
   * El corte con sus notas, los totales y el resumen de las gráficas de lo que
   * deja el filtro (sin filtro, son los del corte completo).
   */
  async detalle(id: string, ubicacion?: string) {
    const c = await this.corte(id);
    const almacenes = this.almacenesDe(c, ubicacion);
    const [notas, filas] = await Promise.all([
      this.prisma.almacen_cortes.findUnique({
        where: { id },
        select: { notas: true },
      }),
      this.prisma.almacen_existencias.findMany({
        where: {
          corte_id: id,
          ...(almacenes ? { almacen: { in: almacenes } } : {}),
        },
        select: {
          parte: true,
          descripcion: true,
          almacen: true,
          clasificacion: true,
          moneda: true,
          cantidad: true,
          unidad: true,
          fecha_entrada: true,
          importe_pesos: true,
          importe_pesos_oc: true,
          origen: true,
        },
        orderBy: { orden: 'asc' },
      }),
    ]);
    const paraResumen: FilaExistencia[] = filas.map((f) => ({
      parte: f.parte,
      descripcion: f.descripcion,
      almacen: f.almacen,
      clasificacion: f.clasificacion,
      moneda: f.moneda,
      cantidad: Number(f.cantidad),
      unidad: f.unidad,
      fechaEntrada: sinZona(f.fecha_entrada),
      importePesos: num(f.importe_pesos),
      importePesosOc: num(f.importe_pesos_oc),
      origen: f.origen,
    }));
    const sin = paraResumen.filter((f) => f.origen === SIN_COSTO);
    return {
      ...corteDto(c),
      filtro: ubicacion?.trim() || null,
      almacenes: almacenes ?? [...new Set(paraResumen.map((f) => f.almacen))],
      totales: {
        pesos: redondea(
          paraResumen.reduce((s, f) => s + (f.importePesos ?? 0), 0),
        ),
        pesosOc: redondea(
          paraResumen.reduce((s, f) => s + (f.importePesosOc ?? 0), 0),
        ),
        articulos: new Set(paraResumen.map((f) => f.parte)).size,
        unidades: r4(paraResumen.reduce((s, f) => s + f.cantidad, 0)),
        sinValuarArticulos: new Set(sin.map((f) => f.parte)).size,
        sinValuarUnidades: r4(sin.reduce((s, f) => s + f.cantidad, 0)),
      },
      notas: (notas?.notas ?? []) as [string, string][],
      resumen: resumir(paraResumen, sinZona(c.fecha_corte)!),
    };
  }

  /** Lo que queda de cada entrada, en el orden del Excel (unas 4,800 filas en la versión 2: la página filtra). */
  async existencias(id: string, ubicacion?: string) {
    const c = await this.corte(id);
    const almacenes = this.almacenesDe(c, ubicacion);
    const filas = await this.prisma.almacen_existencias.findMany({
      where: {
        corte_id: id,
        ...(almacenes ? { almacen: { in: almacenes } } : {}),
      },
      orderBy: { orden: 'asc' },
    });
    return filas.map((f) => ({
      orden: f.orden,
      parte: f.parte,
      descripcion: f.descripcion,
      almacen: f.almacen,
      almacenFisico: f.almacen_fisico,
      clasificacion: f.clasificacion,
      costo: num(f.costo),
      moneda: f.moneda,
      cantidad: Number(f.cantidad),
      unidad: f.unidad,
      fechaEntrada: sinZona(f.fecha_entrada),
      fechaCaptura: sinZona(f.fecha_captura),
      tipoCambio: num(f.tipo_cambio),
      importePesos: num(f.importe_pesos),
      tipoCambioOc: num(f.tipo_cambio_oc),
      importePesosOc: num(f.importe_pesos_oc),
      origen: f.origen,
      oc: f.oc,
      fuenteTc: f.fuente_tc,
      fuenteTcOc: f.fuente_tc_oc,
      saldoArticulo: Number(f.saldo_articulo),
      regresaronRecientes: num(f.regresaron_recientes),
      herramienta: f.herramienta,
      enSuInventario: f.en_su_inventario,
      unidadEntrada: f.unidad_entrada,
      nota: f.nota,
      motivo: f.motivo,
      comoLlego: f.como_llego,
    }));
  }

  /** Las devoluciones sin OT del corte, con su resumen (por día, documento, mes y marca). */
  async devoluciones(id: string) {
    await this.corte(id);
    const [c, filas] = await Promise.all([
      this.prisma.almacen_cortes.findUnique({
        where: { id },
        select: { devoluciones_por_mes: true },
      }),
      this.prisma.almacen_devoluciones.findMany({
        where: { corte_id: id },
        orderBy: { orden: 'asc' },
      }),
    ]);
    const lineas = filas.map((d) => ({
      orden: d.orden,
      fecha: sinZona(d.fecha)!,
      fechaCaptura: sinZona(d.fecha_captura),
      documento: d.documento,
      documentoDescripcion: d.documento_descripcion,
      almacen: d.almacen,
      anaquel: d.anaquel,
      parte: d.parte,
      descripcion: d.descripcion,
      cantidad: Number(d.cantidad),
      unidad: d.unidad,
      costoMaximoUsd: Number(d.costo_maximo_usd),
      costo: num(d.costo),
      moneda: d.moneda,
      tipoCambio: num(d.tipo_cambio),
      importePesos: num(d.importe_pesos),
      tipoCambioOc: num(d.tipo_cambio_oc),
      importePesosOc: num(d.importe_pesos_oc),
      valuacion: d.valuacion,
      oc: d.oc,
      observacion: d.observacion,
      marcas: d.marcas,
      salioAntes: num(d.salio_antes),
      salio12m: num(d.salio_12m),
      ultimaSalida: sinZona(d.ultima_salida),
      otUltimaSalida: d.ot_ultima_salida,
      saldoAlmacen: num(d.saldo_almacen),
      saldoOtras: num(d.saldo_otras),
    }));
    const porMes = Array.isArray(c?.devoluciones_por_mes)
      ? (c.devoluciones_por_mes as unknown as {
          mes: string;
          lineas: number;
          unidades: number;
        }[])
      : [];
    return { lineas, resumen: resumirDevoluciones(lineas, porMes) };
  }

  /** El Excel aceptado, tal cual se cargó. */
  async excel(id: string) {
    const c = await this.prisma.almacen_cortes.findUnique({
      where: { id },
      select: { archivo: true, archivo_nombre: true },
    });
    if (!c) throw new NotFoundException('No existe ese corte');
    return { nombre: c.archivo_nombre, archivo: Buffer.from(c.archivo) };
  }
}
