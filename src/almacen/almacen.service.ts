import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resumir, type FilaExistencia } from './almacen-resumen';

/** Fecha sin zona de Postgres (Prisma la lee como UTC) → 'AAAA-MM-DDTHH:MM:SS', hora de México. */
export const sinZona = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 19) : null;

const num = (d: Prisma.Decimal | null): number | null =>
  d === null ? null : Number(d);

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
} satisfies Prisma.almacen_cortesSelect;

type Corte = Prisma.almacen_cortesGetPayload<{ select: typeof CAMPOS_CORTE }>;

function corteDto(c: Corte) {
  return {
    id: c.id,
    almacen: c.almacen,
    fechaCorte: sinZona(c.fecha_corte),
    version: c.version,
    estado: c.estado,
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
    archivo: { nombre: c.archivo_nombre, sha256: c.archivo_sha256 },
    cargadoEn: c.cargado_en.toISOString(),
    reemplazadoEn: c.reemplazado_en ? c.reemplazado_en.toISOString() : null,
  };
}

/**
 * Almacén (0026): lectura de los cortes del reporte de inventario. Solo lee:
 * los cortes los carga `npm run almacen:cargar` (documentation/ALMACEN.md).
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

  /** El corte con sus notas y el resumen para las gráficas. */
  async detalle(id: string) {
    const c = await this.corte(id);
    const [notas, filas] = await Promise.all([
      this.prisma.almacen_cortes.findUnique({
        where: { id },
        select: { notas: true },
      }),
      this.prisma.almacen_existencias.findMany({
        where: { corte_id: id },
        select: {
          parte: true,
          descripcion: true,
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
      clasificacion: f.clasificacion,
      moneda: f.moneda,
      cantidad: Number(f.cantidad),
      unidad: f.unidad,
      fechaEntrada: sinZona(f.fecha_entrada),
      importePesos: num(f.importe_pesos),
      importePesosOc: num(f.importe_pesos_oc),
      origen: f.origen,
    }));
    return {
      ...corteDto(c),
      notas: (notas?.notas ?? []) as [string, string][],
      resumen: resumir(paraResumen, sinZona(c.fecha_corte)!),
    };
  }

  /** Lo que queda de cada entrada, en el orden del Excel (unas 1,250 filas: la página filtra). */
  async existencias(id: string) {
    await this.corte(id);
    const filas = await this.prisma.almacen_existencias.findMany({
      where: { corte_id: id },
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
    }));
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
