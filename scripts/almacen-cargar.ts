/**
 * Almacén (0026) — carga un corte del reporte de inventario
 * (documentation/ALMACEN.md).
 *
 * Lee el paquete que arma documentation/inventario_henry/exportar.js con el
 * Excel que aceptó Contabilidad (por omisión, scripts/data/almacen-corte.json.gz,
 * que git ignora: lleva costos del cliente y el Excel). Lo valida
 * (src/almacen/almacen-carga.ts: Excel, filas, saldos y totales) y, por la
 * huella del paquete completo:
 *   1. si ese paquete ya está publicado, no hace nada;
 *   2. si es el de una versión reemplazada, la vuelve a publicar;
 *   3. si es nuevo, deja 'reemplazado' el publicado del mismo almacén y fecha
 *      y crea el corte en la versión siguiente, con su Excel y sus existencias.
 * Al final vuelve a leer lo escrito y comprueba filas y totales.
 *
 * USO (por omisión, modo de prueba: corre todo en una transacción y la deshace):
 *   npm run almacen:cargar
 *   npm run almacen:cargar -- --por "Alex" --excel-sha256 <sha256 del Excel aceptado> --commit
 *   opciones: --archivo <ruta.json.gz>  --por <quién carga>  --excel-sha256 <64 hex>
 * Con --commit pide --excel-sha256: así se carga el Excel que se aceptó y no
 * otro (la prueba en seco lo imprime completo).
 *
 * Se niega a correr con NODE_ENV=production: en prod se corre desde un
 * contenedor efímero con DATABASE_URL de prod, como las cargas de FP&A.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  archivoDe,
  huellaPaquete,
  validarPaquete,
  type PaqueteCorte,
} from '../src/almacen/almacen-carga';

const COMMIT = process.argv.includes('--commit');
const opcion = (nombre: string): string | null => {
  const i = process.argv.indexOf(nombre);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
const log = (msg: string) => console.log(msg);
const pesos = (x: number) =>
  `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 'AAAA-MM-DDTHH:MM:SS' (hora de México) → Date que Prisma escribe tal cual en un timestamp sin zona. */
const sinZona = (f: string | null) => (f ? new Date(`${f}Z`) : null);
const dec = (x: number | null) => (x === null ? null : new Prisma.Decimal(x));

class Deshacer extends Error {}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guardia: almacen:cargar no corre con NODE_ENV=production. Córrelo desde un contenedor efímero con DATABASE_URL de prod.',
    );
  }
  const ruta =
    opcion('--archivo') ?? join(__dirname, 'data', 'almacen-corte.json.gz');
  if (!existsSync(ruta)) throw new Error(`No está el paquete: ${ruta}`);
  const crudo = readFileSync(ruta);
  const p = JSON.parse(
    (ruta.endsWith('.gz') ? gunzipSync(crudo) : crudo).toString('utf8'),
  ) as PaqueteCorte;
  const por =
    opcion('--por') ??
    process.env.USER ??
    process.env.USERNAME ??
    'almacen:cargar';
  const excelEsperado = opcion('--excel-sha256')?.trim().toLowerCase() ?? null;

  log(`Paquete: ${ruta}`);
  log(`  ${p.titulo} · almacén ${p.almacen} · corte ${p.fechaCorte}`);
  log(`  Excel: ${p.archivo?.nombre}`);
  log(`  sha256 del Excel: ${p.archivo?.sha256}`);
  log(
    `  ${p.existencias?.length} filas · ${p.totales?.articulos} artículos · ${p.totales?.unidades} unidades · ${pesos(p.totales?.pesos ?? 0)} (con el tipo de cambio de la OC, ${pesos(p.totales?.pesosOc ?? 0)})`,
  );

  const problemas = validarPaquete(p);
  if (excelEsperado !== null && excelEsperado !== p.archivo?.sha256)
    problemas.push(
      `el Excel del paquete no es el aceptado: su sha256 empieza con ${p.archivo?.sha256?.slice(0, 12)}… y --excel-sha256 con ${excelEsperado.slice(0, 12)}…`,
    );
  if (COMMIT && excelEsperado === null)
    problemas.push(
      'con --commit hace falta --excel-sha256 <sha256 del Excel aceptado> (la prueba en seco lo imprime)',
    );
  if (problemas.length) {
    log(`\nEl paquete no se carga (${problemas.length} problemas):`);
    for (const x of problemas.slice(0, 30)) log(`  - ${x}`);
    process.exitCode = 1;
    return;
  }
  const huella = huellaPaquete(p);
  log(
    `  Validación: bien (Excel, filas, saldos y totales${excelEsperado ? '; es el Excel aceptado' : ''}).`,
  );
  log(`  Huella del paquete: ${huella.slice(0, 12)}…`);

  const prisma = new PrismaService();
  await prisma.$connect();
  let resumen = '';
  let nadaQueHacer = false;
  try {
    await prisma.$transaction(
      async (tx) => {
        const fecha = sinZona(p.fechaCorte)!;
        const previos = await tx.almacen_cortes.findMany({
          where: { almacen: p.almacen, fecha_corte: fecha },
          select: {
            id: true,
            version: true,
            estado: true,
            paquete_sha256: true,
          },
        });
        const publicado = previos.find((c) => c.estado === 'publicado');
        const mismo = await tx.almacen_cortes.findUnique({
          where: { paquete_sha256: huella },
          select: {
            id: true,
            version: true,
            estado: true,
            almacen: true,
            fecha_corte: true,
          },
        });
        if (mismo?.estado === 'publicado') {
          resumen = `Ese paquete ya está cargado y publicado (versión ${mismo.version}). No se hace nada.`;
          nadaQueHacer = true;
          throw new Deshacer();
        }

        let corteId: string;
        let version: number;
        if (mismo) {
          // El paquete de una versión reemplazada: se vuelve a publicar
          if (publicado)
            await tx.almacen_cortes.update({
              where: { id: publicado.id },
              data: { estado: 'reemplazado', reemplazado_en: new Date() },
              select: { id: true },
            });
          await tx.almacen_cortes.update({
            where: { id: mismo.id },
            data: { estado: 'publicado', reemplazado_en: null },
            select: { id: true },
          });
          corteId = mismo.id;
          version = mismo.version;
        } else {
          version = previos.reduce((m, c) => Math.max(m, c.version), 0) + 1;
          if (publicado)
            await tx.almacen_cortes.update({
              where: { id: publicado.id },
              data: { estado: 'reemplazado', reemplazado_en: new Date() },
              select: { id: true },
            });
          const corte = await tx.almacen_cortes.create({
            data: {
              almacen: p.almacen,
              fecha_corte: fecha,
              version,
              titulo: p.titulo,
              fuente: p.fuente,
              articulos: p.totales.articulos,
              unidades: dec(p.totales.unidades)!,
              total_pesos: dec(p.totales.pesos)!,
              total_pesos_oc: dec(p.totales.pesosOc)!,
              sin_valuar_articulos: p.totales.sinValuarArticulos,
              sin_valuar_unidades: dec(p.totales.sinValuarUnidades)!,
              notas: p.notas,
              archivo_nombre: p.archivo.nombre,
              // Prisma pide un Uint8Array con su propio ArrayBuffer (un Buffer puede compartirlo)
              archivo: new Uint8Array(archivoDe(p)),
              archivo_sha256: p.archivo.sha256,
              paquete_sha256: huella,
              cargado_por: por.slice(0, 120),
            },
            select: { id: true },
          });
          corteId = corte.id;
          await tx.almacen_existencias.createMany({
            data: p.existencias.map((f) => ({
              corte_id: corte.id,
              orden: f.orden,
              parte: f.parte,
              descripcion: f.descripcion,
              almacen: f.almacen,
              almacen_fisico: f.almacenFisico,
              clasificacion: f.clasificacion,
              costo: dec(f.costo),
              moneda: f.moneda,
              cantidad: dec(f.cantidad)!,
              unidad: f.unidad,
              fecha_entrada: sinZona(f.fechaEntrada),
              fecha_captura: sinZona(f.fechaCaptura),
              tipo_cambio: dec(f.tipoCambio),
              importe_pesos: dec(f.importePesos),
              tipo_cambio_oc: dec(f.tipoCambioOc),
              importe_pesos_oc: dec(f.importePesosOc),
              origen: f.origen,
              oc: f.oc,
              fuente_tc: f.fuenteTc,
              fuente_tc_oc: f.fuenteTcOc,
              saldo_articulo: dec(f.saldoArticulo)!,
              regresaron_recientes: dec(f.regresaronRecientes),
              herramienta: f.herramienta,
              en_su_inventario: f.enSuInventario,
              unidad_entrada: f.unidadEntrada,
              nota: f.nota,
            })),
          });
        }

        // Lo publicado: mismas filas, mismos totales y un solo corte publicado de esa fecha.
        const suma = await tx.almacen_existencias.aggregate({
          where: { corte_id: corteId },
          _count: true,
          _sum: { importe_pesos: true, importe_pesos_oc: true, cantidad: true },
        });
        const publicados = await tx.almacen_cortes.findMany({
          where: {
            almacen: p.almacen,
            fecha_corte: fecha,
            estado: 'publicado',
          },
          select: { id: true },
        });
        const fallas: string[] = [];
        if (suma._count !== p.existencias.length)
          fallas.push(`filas: ${suma._count} de ${p.existencias.length}`);
        if (
          Math.abs(Number(suma._sum.importe_pesos ?? 0) - p.totales.pesos) >
          0.01
        )
          fallas.push(`total en pesos: ${Number(suma._sum.importe_pesos)}`);
        if (
          Math.abs(
            Number(suma._sum.importe_pesos_oc ?? 0) - p.totales.pesosOc,
          ) > 0.01
        )
          fallas.push(
            `total con el de la OC: ${Number(suma._sum.importe_pesos_oc)}`,
          );
        if (
          Math.abs(Number(suma._sum.cantidad ?? 0) - p.totales.unidades) > 1e-4
        )
          fallas.push(`unidades: ${Number(suma._sum.cantidad)}`);
        if (publicados.length !== 1 || publicados[0].id !== corteId)
          fallas.push(
            `cortes publicados de esa fecha: ${publicados.length}, y debe ser solo este`,
          );
        if (fallas.length)
          throw new Error(`Lo escrito no cuadra: ${fallas.join('; ')}`);

        const reemplaza = publicado
          ? `, reemplaza a la versión ${publicado.version}`
          : '';
        resumen = mismo
          ? `La versión ${version} de ${p.almacen} al ${p.fechaCorte} vuelve a quedar publicada${reemplaza}: ${suma._count} filas, ${pesos(Number(suma._sum.importe_pesos))}. Cuadra con el paquete.`
          : `Versión ${version} de ${p.almacen} al ${p.fechaCorte}${reemplaza}: ${suma._count} filas, ${pesos(Number(suma._sum.importe_pesos))}. Cuadra con el paquete.`;
        if (!COMMIT) throw new Deshacer();
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
    log(`\n${resumen}`);
    log(COMMIT ? 'Escrito (--commit).' : '');
  } catch (e) {
    if (!(e instanceof Deshacer)) throw e;
    log(`\n${resumen}`);
    if (!COMMIT && !nadaQueHacer)
      log(
        'Modo de prueba: no se escribió nada. Para escribir, agrega --excel-sha256 <sha256 del Excel aceptado> --commit.',
      );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
