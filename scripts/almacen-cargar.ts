/**
 * Almacén (0026 y 0027) — carga un corte del reporte de inventario
 * (documentation/ALMACEN.md).
 *
 * Lee el paquete que arma documentation/inventario_henry/exportar.js con el
 * Excel del reporte (por omisión, scripts/data/almacen-corte.json.gz, que git
 * ignora: lleva costos del cliente y el Excel). Lo valida
 * (src/almacen/almacen-carga.ts: Excel, filas, saldos, totales y, en el
 * formato 2, ubicaciones, motivos y devoluciones) y, por la huella del paquete
 * completo:
 *   1. si ese paquete ya está publicado, no hace nada (o, con --aceptar, lo marca aceptado);
 *   2. si es el de una versión reemplazada, la vuelve a publicar;
 *   3. si es nuevo, deja 'reemplazado' el publicado de la misma fecha de corte y
 *      crea el corte en la versión siguiente, con su Excel, sus existencias y sus
 *      devoluciones.
 * Todo corte entra "en revisión" con Contabilidad. Cuando lo aceptan, se corre la
 * carga otra vez con el mismo paquete y --aceptar: solo marca aceptado el que ya
 * está publicado (con otro paquete, no hace nada).
 * Al final vuelve a leer lo escrito y comprueba filas y totales.
 *
 * USO (por omisión, modo de prueba: corre todo en una transacción y la deshace):
 *   npm run almacen:cargar
 *   npm run almacen:cargar -- --por "Alex" --excel-sha256 <sha256 del Excel> --commit
 *   npm run almacen:cargar -- --por "Alex" --excel-sha256 <sha256 del Excel> --aceptar --commit
 *   opciones: --archivo <ruta.json.gz>  --por <quién carga>  --excel-sha256 <64 hex>  --aceptar
 * Con --commit pide --excel-sha256: así se carga el Excel que se revisó y no
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
  FORMATO_V2,
  huellaPaquete,
  validarPaquete,
  type PaqueteCorte,
} from '../src/almacen/almacen-carga';

const COMMIT = process.argv.includes('--commit');
const ACEPTAR = process.argv.includes('--aceptar');
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
const json = (x: unknown) => x as Prisma.InputJsonValue;

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
  const v2 = p.formato === FORMATO_V2;
  const por =
    opcion('--por') ??
    process.env.USER ??
    process.env.USERNAME ??
    'almacen:cargar';
  const excelEsperado = opcion('--excel-sha256')?.trim().toLowerCase() ?? null;

  log(`Paquete: ${ruta}`);
  log(
    `  ${p.titulo} · ${p.almacen === 'TODOS' ? 'todos los almacenes' : `almacén ${p.almacen}`} · corte ${p.fechaCorte}${v2 ? ` · versión ${p.versionReporte} del reporte` : ''}`,
  );
  log(`  Excel: ${p.archivo?.nombre}`);
  log(`  sha256 del Excel: ${p.archivo?.sha256}`);
  log(
    `  ${p.existencias?.length} filas · ${p.totales?.articulos} artículos · ${p.totales?.unidades} unidades · ${pesos(p.totales?.pesos ?? 0)} (con el tipo de cambio de la OC, ${pesos(p.totales?.pesosOc ?? 0)})${v2 ? ` · ${p.ubicaciones?.length} ubicaciones · ${p.devoluciones?.length} devoluciones` : ''}`,
  );

  const problemas = validarPaquete(p);
  if (excelEsperado !== null && excelEsperado !== p.archivo?.sha256)
    problemas.push(
      `el Excel del paquete no es el que se revisó: su sha256 empieza con ${p.archivo?.sha256?.slice(0, 12)}… y --excel-sha256 con ${excelEsperado.slice(0, 12)}…`,
    );
  if (COMMIT && excelEsperado === null)
    problemas.push(
      'con --commit hace falta --excel-sha256 <sha256 del Excel> (la prueba en seco lo imprime)',
    );
  if (problemas.length) {
    log(`\nEl paquete no se carga (${problemas.length} problemas):`);
    for (const x of problemas.slice(0, 30)) log(`  - ${x}`);
    process.exitCode = 1;
    return;
  }
  const huella = huellaPaquete(p);
  log(
    `  Validación: bien (Excel, filas, saldos y totales${v2 ? ', ubicaciones y devoluciones' : ''}${excelEsperado ? '; es el Excel que se revisó' : ''}).`,
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
        // Las versiones se cuentan por fecha de corte (0027): la versión 2, de todos los almacenes, reemplaza a la de CENTRAL.
        const previos = await tx.almacen_cortes.findMany({
          where: { fecha_corte: fecha },
          select: { id: true, version: true, estado: true },
        });
        const publicado = previos.find((c) => c.estado === 'publicado');
        const mismo = await tx.almacen_cortes.findUnique({
          where: { paquete_sha256: huella },
          select: { id: true, version: true, estado: true, revision: true },
        });
        const aceptar = async (id: string) => {
          await tx.almacen_cortes.update({
            where: { id },
            data: { revision: 'aceptado', aceptado_en: new Date() },
            select: { id: true },
          });
        };
        if (mismo?.estado === 'publicado') {
          if (ACEPTAR && mismo.revision !== 'aceptado') {
            await aceptar(mismo.id);
            resumen = `La versión ${mismo.version} de ${p.almacen} al ${p.fechaCorte} queda aceptada por Contabilidad.`;
            if (!COMMIT) throw new Deshacer();
            return;
          }
          resumen = `Ese paquete ya está cargado y publicado (versión ${mismo.version}, ${mismo.revision === 'aceptado' ? 'aceptado' : 'en revisión'}). No se hace nada.`;
          nadaQueHacer = true;
          throw new Deshacer();
        }
        // --aceptar solo marca aceptado lo que ya está publicado: se carga primero, se revisa en la página y después se acepta.
        if (ACEPTAR) {
          resumen =
            'Con --aceptar, el paquete debe ser el que ya está publicado. Cárgalo primero sin --aceptar; cuando Contabilidad lo acepte, corre la carga otra vez con --aceptar.';
          nadaQueHacer = true;
          process.exitCode = 1;
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
              version_reporte: p.versionReporte ?? 1,
              ubicaciones: json(p.ubicaciones ?? []),
              devoluciones_por_mes: json(p.devolucionesPorMes ?? []),
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
              motivo: f.motivo ?? null,
              como_llego: f.comoLlego ?? null,
            })),
          });
          if (p.devoluciones?.length)
            await tx.almacen_devoluciones.createMany({
              data: p.devoluciones.map((d) => ({
                corte_id: corte.id,
                orden: d.orden,
                fecha: sinZona(d.fecha)!,
                fecha_captura: sinZona(d.fechaCaptura),
                documento: d.documento,
                documento_descripcion: d.documentoDescripcion,
                almacen: d.almacen,
                anaquel: d.anaquel,
                parte: d.parte,
                descripcion: d.descripcion,
                cantidad: dec(d.cantidad)!,
                unidad: d.unidad,
                costo_maximo_usd: dec(d.costoMaximoUsd)!,
                costo: dec(d.costo),
                moneda: d.moneda,
                tipo_cambio: dec(d.tipoCambio),
                importe_pesos: dec(d.importePesos),
                tipo_cambio_oc: dec(d.tipoCambioOc),
                importe_pesos_oc: dec(d.importePesosOc),
                valuacion: d.valuacion,
                oc: d.oc,
                observacion: d.observacion,
                marcas: d.marcas,
                salio_antes: dec(d.salioAntes),
                salio_12m: dec(d.salio12m),
                ultima_salida: sinZona(d.ultimaSalida),
                ot_ultima_salida: d.otUltimaSalida,
                saldo_almacen: dec(d.saldoAlmacen),
                saldo_otras: dec(d.saldoOtras),
              })),
            });
        }

        // Lo publicado: mismas filas, mismos totales, las devoluciones y un solo corte publicado de esa fecha.
        const suma = await tx.almacen_existencias.aggregate({
          where: { corte_id: corteId },
          _count: true,
          _sum: { importe_pesos: true, importe_pesos_oc: true, cantidad: true },
        });
        const dev = await tx.almacen_devoluciones.aggregate({
          where: { corte_id: corteId },
          _count: true,
          _sum: { cantidad: true },
        });
        const publicados = await tx.almacen_cortes.findMany({
          where: { fecha_corte: fecha, estado: 'publicado' },
          select: { id: true, revision: true },
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
        const devEsperadas = p.devoluciones ?? [];
        if (
          dev._count !== devEsperadas.length ||
          Math.abs(
            Number(dev._sum.cantidad ?? 0) -
              devEsperadas.reduce((s, d) => s + d.cantidad, 0),
          ) > 1e-4
        )
          fallas.push(`devoluciones: ${dev._count} de ${devEsperadas.length}`);
        if (publicados.length !== 1 || publicados[0].id !== corteId)
          fallas.push(
            `cortes publicados de esa fecha: ${publicados.length}, y debe ser solo este`,
          );
        if (fallas.length)
          throw new Error(`Lo escrito no cuadra: ${fallas.join('; ')}`);

        const reemplaza =
          publicado && publicado.id !== corteId
            ? `, reemplaza a la versión ${publicado.version}`
            : '';
        const estado =
          publicados[0].revision === 'aceptado'
            ? 'aceptado por Contabilidad'
            : 'en revisión con Contabilidad';
        const devTxt = dev._count ? ` y ${dev._count} devoluciones` : '';
        resumen = mismo
          ? `La versión ${version} de ${p.almacen} al ${p.fechaCorte} vuelve a quedar publicada${reemplaza}, ${estado}: ${suma._count} filas${devTxt}, ${pesos(Number(suma._sum.importe_pesos))}. Cuadra con el paquete.`
          : `Versión ${version} de ${p.almacen} al ${p.fechaCorte}${reemplaza}, ${estado}: ${suma._count} filas${devTxt}, ${pesos(Number(suma._sum.importe_pesos))}. Cuadra con el paquete.`;
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
        'Modo de prueba: no se escribió nada. Para escribir, agrega --excel-sha256 <sha256 del Excel> --commit.',
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
