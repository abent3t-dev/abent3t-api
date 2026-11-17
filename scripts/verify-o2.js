/**
 * O2 (2026-11-17) — Verificación en prod de las solicitudes de cotización
 * (RQ, AB_COTIZACIONES). SOLO LECTURA: únicamente SELECT; no toca Maximo.
 *
 * Se corre dentro del contenedor del api, después del pull y el rebuild (el
 * contenedor trae scripts/ y dist/):
 *   docker compose -f docker-compose.prod.yml exec -T api node scripts/verify-o2.js
 * Si el contenedor no trae scripts/, se pega como heredoc (igual que
 * verify-o.js). Usa los `dist` del api: las mismas consultas y el mismo motor
 * que la plataforma. Conviene correrlo después de la primera corrida de RQ
 * con MAXIMO_RFQS_ENABLED=true (sin ella, los apartados de RQ salen vacíos).
 *
 * Apartados: 0023 · flag y corridas · las RQ (conteos, historial, liga con
 * la OC y la forma real del registro) · la hora de Maximo · O3 ("Introducido
 * por" contra el comprador de AB_COMPRAS) · la página de Maximo con RQ y con
 * PR · la conciliación contra el informe de RQ de Jorge.
 */
try {
  require('dotenv').config();
} catch {
  /* en el contenedor las variables ya están */
}
const fs = require('fs');
const { PrismaClient, Prisma } = require('@prisma/client');

const DIST = [process.cwd(), '/app']
  .map((d) => d + '/dist')
  .find((d) => fs.existsSync(d + '/common/sql/erp-views.sql.js'));
if (!DIST) throw new Error('No encontré dist/common/sql/erp-views.sql.js');
const views = require(DIST + '/common/sql/erp-views.sql.js');
const { loadAvanceRows, buildAvanceData } = require(
  DIST + '/purchase-reports/avance-semanal/avance-semanal.data.js',
);
const { buildAvancePage, lastCompleteWeek, isoDay } = require(
  DIST + '/purchase-reports/avance-semanal/avance-semanal.engine.js',
);
const { conciliarAvance, opcionesConciliacion } = require(
  DIST + '/purchase-reports/avance-semanal/avance-semanal.conciliacion.js',
);
const { MAXIMO_MAPPER_VERSION, toRfq } = require(
  DIST + '/integrations/maximo/maximo.mapper.js',
);

const DESDE_2026 = new Date('2026-01-01T06:00:00Z'); // 1-ene 00:00 de México
const flag = (process.env.MAXIMO_RFQS_ENABLED || '').trim() === 'true';
const q = (prisma, sql) => prisma.$queryRaw(sql);

(async () => {
  if (typeof toRfq !== 'function') {
    console.log('<<< el dist no es el de O2 (no trae toRfq): falta el pull y el rebuild del api');
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    // 0) La migración 0023 (sin ella, el código de O2 falla: se para aquí)
    const [m] = await q(prisma, Prisma.sql`
      SELECT to_regclass('public.maximo_rfqs')::text AS rfqs,
             to_regclass('public.maximo_rfq_status_history')::text AS historial,
             (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e
                JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'maximo_sync_target') AS targets,
             (SELECT c.reloptions::text FROM pg_class c WHERE c.relname = 'idx_maximo_rfq_po_nums') AS gin,
             to_regclass('public.idx_maximo_rfq_last_seen') IS NULL AS sin_indice_last_seen,
             EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abent3t_app') AS rol_app`);
    if (!(m.rfqs && m.historial && /rfqs/.test(m.targets || ''))) {
      console.log('== 0023:', JSON.stringify(m), '<<< falta la 0023: aplicarla en el servidor B antes de seguir');
      process.exitCode = 1;
      return;
    }
    // los cuatro permisos en las dos tablas (has_table_privilege, para no
    // depender de con qué usuario entra el contenedor)
    const permisos = m.rol_app
      ? await q(prisma, Prisma.sql`
          SELECT t.tabla, bool_and(has_table_privilege('abent3t_app', t.tabla, p.priv)) AS completos
          FROM (VALUES ('maximo_rfqs'), ('maximo_rfq_status_history')) t(tabla)
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
          GROUP BY 1 ORDER BY 1`)
      : [];
    console.log('== 0023:', JSON.stringify({ ...m, permisos }),
      m.gin === '{fastupdate=off}' && m.sin_indice_last_seen && permisos.length === 2 && permisos.every((p) => p.completos)
        ? 'OK'
        : '<<< revisar (índices o permisos de abent3t_app)');

    // 1) Flag, mapper y corridas
    console.log(`\n== Flag MAXIMO_RFQS_ENABLED=${flag} · mapper esperado ${MAXIMO_MAPPER_VERSION}`);
    console.table(await q(prisma, Prisma.sql`
      SELECT target::text, mapper_version, count(*)::int AS filas
      FROM (SELECT 'purchase_orders' AS target, mapper_version FROM maximo_purchase_orders
            UNION ALL SELECT 'contracts', mapper_version FROM maximo_contracts
            UNION ALL SELECT 'rfqs', mapper_version FROM maximo_rfqs) t
      GROUP BY 1, 2 ORDER BY 1, 2`));
    console.table(await q(prisma, Prisma.sql`
      SELECT to_char(started_at AT TIME ZONE 'America/Mexico_City', 'DD-MM HH24:MI') AS inicio,
             target::text, triggered_by::text, status::text, records_fetched AS leidas,
             records_inserted AS nuevas, records_updated AS cambios, records_remapped AS remapped,
             records_unchanged AS sin_cambio, records_failed AS fallas, left(error_summary, 120) AS errores,
             left(filter_warnings::text, 120) AS avisos
      FROM maximo_sync_runs ORDER BY started_at DESC LIMIT 8`));

    // 2) Las RQ
    const [rq] = await q(prisma, Prisma.sql`
      SELECT count(*)::int AS vigentes,
             (SELECT count(*)::int FROM maximo_rfqs WHERE superseded_at IS NOT NULL) AS obsoletas,
             count(*) FILTER (WHERE enter_date >= ${DESDE_2026})::int AS de_2026,
             count(*) FILTER (WHERE enter_date IS NULL)::int AS sin_creacion,
             count(*) FILTER (WHERE cardinality(po_nums) > 0)::int AS con_oc
      FROM maximo_rfqs WHERE superseded_at IS NULL`);
    console.log('\n== RQ:', JSON.stringify(rq), '(17-nov, tabla de Maximo: 4,680 RQ y 634 de 2026)');
    console.log('2026 por estatus (17-nov: CLOSE 468, CANCEL 135, INPRG 31) y por "Introducido por" (ADCS1 400, JAGS1 120, DYMP1 114):');
    console.table(await q(prisma, Prisma.sql`
      SELECT 'estatus' AS dato, coalesce(status, '(sin)') AS valor, count(*)::int AS rq FROM maximo_rfqs
       WHERE superseded_at IS NULL AND enter_date >= ${DESDE_2026} GROUP BY 2
      UNION ALL
      SELECT 'introducido por', coalesce(enter_by, '(sin)'), count(*)::int FROM maximo_rfqs
       WHERE superseded_at IS NULL AND enter_date >= ${DESDE_2026} GROUP BY 2
      ORDER BY 1, 3 DESC`));
    const [h] = await q(prisma, Prisma.sql`
      WITH r AS (SELECT q.id, q.status, q.po_nums,
                   (SELECT count(*) FROM maximo_rfq_status_history h WHERE h.rfq_id = q.id) AS cambios,
                   (SELECT h.status FROM maximo_rfq_status_history h WHERE h.rfq_id = q.id
                     ORDER BY h.seq DESC LIMIT 1) AS ultimo
                 FROM maximo_rfqs q WHERE q.superseded_at IS NULL AND q.enter_date >= ${DESDE_2026})
      SELECT count(*) FILTER (WHERE cambios > 0)::int AS con_historial,
             count(*) FILTER (WHERE cambios = 0)::int AS sin_historial,
             count(*) FILTER (WHERE status IN ('CLOSE', 'CANCEL') AND ultimo IS DISTINCT FROM status)::int AS cierre_sin_su_fila,
             count(*) FILTER (WHERE status = 'CLOSE' AND cardinality(po_nums) = 0)::int AS cerradas_sin_ponum,
             count(*) FILTER (WHERE status = 'CLOSE' AND cardinality(po_nums) > 0 AND NOT EXISTS (
               SELECT 1 FROM maximo_purchase_orders o WHERE o.ponum = ANY (r.po_nums)))::int AS ponum_sin_oc_en_staging,
             round(avg(cambios), 1) AS cambios_promedio
      FROM r`);
    console.log('Historial y liga con la OC (RQ de 2026):', JSON.stringify(h),
      h.cierre_sin_su_fila > 0 ? '  ← esas usan STATUSDATE (o la fecha de su OC)' : '');
    // la forma real del registro: nombres de campos de la RQ cerrada más reciente
    const [ultima] = await q(prisma, Prisma.sql`
      SELECT rfqnum, raw FROM maximo_rfqs WHERE superseded_at IS NULL AND status = 'CLOSE'
      ORDER BY enter_date DESC NULLS LAST LIMIT 1`);
    if (ultima) {
      const nodo = (n) => ({
        atributos: Object.keys((n && (n.Attributes || n)) || {}).filter((k) => k !== 'RelatedMbos').sort().join(' '),
        hijos: Object.keys((n && n.RelatedMbos) || {}).sort().join(' '),
      });
      // un hijo único puede venir como objeto en lugar de arreglo
      const lista = (x) => (Array.isArray(x) ? x : x ? [x] : []);
      const raw = ultima.raw;
      const rel = (raw && raw.RelatedMbos) || {};
      const dto = toRfq(raw);
      console.log(`Forma de ${ultima.rfqnum}:`);
      console.log('  cabecera:', JSON.stringify(nodo(raw)));
      console.log('  RFQSTATUS[0]:', JSON.stringify(nodo(lista(rel.RFQSTATUS)[0])));
      console.log('  RFQLINE[0]:', JSON.stringify(nodo(lista(rel.RFQLINE)[0])));
      console.log(`  mapeada: introducido por ${dto.enterBy} · ${dto.statusHistory.length} cambios (${dto.statusHistory.map((c) => c.status).join(' › ')}) · cerrada ${dto.closedDate} por ${dto.closedBy} · OC ${dto.poNums.join(', ') || '(ninguna)'}`);
    }
    const [otroNivel] = await q(prisma, Prisma.sql`
      SELECT count(*)::int AS rfqstatus_en_rfqline
      FROM maximo_rfqs q
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE jsonb_typeof(q.raw #> '{RelatedMbos,RFQLINE}')
          WHEN 'array' THEN q.raw #> '{RelatedMbos,RFQLINE}'
          WHEN 'object' THEN jsonb_build_array(q.raw #> '{RelatedMbos,RFQLINE}')
          ELSE '[]'::jsonb END) l
      WHERE q.superseded_at IS NULL AND l #> '{RelatedMbos,RFQSTATUS}' IS NOT NULL`);
    console.log('RFQSTATUS debajo de RFQLINE (la plataforma lo lee en la cabecera):',
      otroNivel.rfqstatus_en_rfqline, otroNivel.rfqstatus_en_rfqline > 0 ? '  ← OJO: avisar al chat de compras' : '(bien)');

    // 3) La hora de Maximo: si el +00:00 fuera hora local, las RQ se crearían
    // entre 08 y 19 "UTC"; si es UTC de verdad, entre 14 y 01 (08 a 19 de
    // México). La prueba compara 6 h contra 6 h que solo son de noche en una
    // de las dos lecturas: 20-01 "UTC" (14-19 de México si es UTC; de noche
    // si fuera hora local) contra 08-13 "UTC" (02-07 de México si es UTC; de
    // mañana si fuera hora local).
    const horas = await q(prisma, Prisma.sql`
      SELECT 'creación' AS fecha, extract(hour FROM enter_date AT TIME ZONE 'UTC')::int AS hora, count(*)::int AS n
        FROM maximo_rfqs WHERE enter_date >= ${DESDE_2026} GROUP BY 2
      UNION ALL
      SELECT 'cambio de estatus', extract(hour FROM change_date AT TIME ZONE 'UTC')::int, count(*)::int
        FROM maximo_rfq_status_history WHERE change_date >= ${DESDE_2026} GROUP BY 2`);
    for (const fecha of ['creación', 'cambio de estatus']) {
      const filas = horas.filter((r) => r.fecha === fecha);
      const total = filas.reduce((s, r) => s + r.n, 0);
      const en = (desde, hasta) => filas.filter((r) => (desde <= hasta ? r.hora >= desde && r.hora <= hasta : r.hora >= desde || r.hora <= hasta)).reduce((s, r) => s + r.n, 0);
      if (total === 0) continue;
      const pct = (n) => Math.round((n * 100) / total);
      const tarde = en(20, 1);
      const manana = en(8, 13);
      console.log(`\n== Hora de ${fecha} (${total}): 14-01 "UTC" ${pct(en(14, 1))}% · 08-19 "UTC" ${pct(en(8, 19))}% · 20-01 "UTC" ${tarde} contra 08-13 "UTC" ${manana}`,
        tarde > manana ? '→ es UTC de verdad (el motor resta 6 h, bien)' : '→ OJO: parece hora local marcada como +00:00');
      console.log('  por hora:', filas.sort((a, b) => a.hora - b.hora).map((r) => `${String(r.hora).padStart(2, '0')}:${r.n}`).join(' '));
    }

    // 4) O3: "Introducido por" de la RQ contra el comprador de AB_COMPRAS
    console.log('\n== O3: OC de Maximo de 2026 (no canceladas): "Introducido por" de su RQ contra el comprador de RFQSTATUS de AB_COMPRAS');
    const o3 = await q(prisma, Prisma.sql`
      WITH c AS (${views.CURRENT_MAXIMO_POS})
      SELECT rq.rq_enter_by AS introducido_por, rq.rq_buyer AS comprador_ab_compras,
             count(*)::int AS oc,
             count(*) FILTER (WHERE ${views.maximoPoDeContrato('c')})::int AS de_contrato
      FROM c ${views.maximoRqBuyerJoin('c')}
      WHERE coalesce(c.status, '') NOT IN ('CAN', 'CANCEL') AND c.created_at_source >= ${DESDE_2026}
      GROUP BY 1, 2 ORDER BY 3 DESC`);
    const suma = (f) => o3.filter(f).reduce((s, r) => s + r.oc - r.de_contrato, 0);
    const iguales = suma((r) => r.introducido_por && r.comprador_ab_compras && r.introducido_por.toUpperCase() === r.comprador_ab_compras.toUpperCase());
    const distintas = suma((r) => r.introducido_por && r.comprador_ab_compras && r.introducido_por.toUpperCase() !== r.comprador_ab_compras.toUpperCase());
    const soloRq = suma((r) => r.introducido_por && !r.comprador_ab_compras);
    const soloCompras = suma((r) => !r.introducido_por && r.comprador_ab_compras);
    console.log(`Sin las de contrato: coinciden ${iguales} · DIFIEREN ${distintas} (gana "Introducido por") · solo con RQ en AB_COTIZACIONES ${soloRq} · solo con AB_COMPRAS ${soloCompras}`);
    console.table(o3.filter((r) => r.introducido_por !== r.comprador_ab_compras).slice(0, 12));

    // 5) La página de Maximo de la última semana completa, con RQ y con PR
    const lunes = lastCompleteWeek(new Date());
    const reglas = opcionesConciliacion({});
    // una sola carga, con las RQ (la de PR no las usa)
    const t0 = Date.now();
    const filas = await loadAvanceRows(prisma, { rq: true });
    const cargaMs = Date.now() - t0;
    const conRq = buildAvanceData(filas, reglas.reglas, 'rq');
    const conPr = buildAvanceData(filas, reglas.reglas, 'pr');
    const ahora = new Date();
    const fila = (d) => {
      const p = buildAvancePage(d, lunes, 'maximo', ahora, reglas);
      return {
        gestion: p.gestion_maximo || 'pr', recibidas: p.avance.recibidas_anio, nuevas: p.avance.nuevas_semana,
        cerradas: p.estado_anio.cerradas, cerradas_semana: p.avance.cerradas_semana,
        canceladas: p.estado_anio.canceladas, abiertas: p.estado_anio.abiertas,
        sin_oc: p.estado_anio.cerradas_sin_oc,
        dias_cierre: p.cierre.anio.promedio_dias, mediana: p.cierre.anio.mediana_dias,
        dias_cancelacion: p.cancelacion.anio ? p.cancelacion.anio.promedio_dias : null,
      };
    };
    console.log(`\n== Página de Maximo, semana del ${isoDay(lunes)} (la de Reportes con el flag ${flag ? 'prendido' : 'apagado'}; carga de datos ${cargaMs} ms):`);
    console.table([fila(conRq), fila(conPr)]);
    if (conRq.maximo_gestion !== 'rq') {
      console.log(filas.maximoRfqs.length === 0
        ? '  ← con RQ salió PR: no hay RQ en maximo_rfqs (¿flag apagado o aún sin sincronizar?)'
        : '  ← con RQ salió PR: ninguna corrida de RQ ha terminado en success (ver los errores de las corridas arriba; si una página falla siempre por tiempo, bajar MAXIMO_SYNC_PAGE_SIZE)');
    }

    // 6) La conciliación con RQ contra el informe de RQ de Jorge
    const conc = conciliarAvance(conRq, reglas, ahora);
    console.log(`\n== Conciliación con ${conc.gestion_maximo}: ${conc.rq_octubre.nota}`);
    console.table(conc.rq_octubre.puntos.flatMap((p) =>
      ['recibidas', 'nuevas', 'cerradas', 'cerradas_semana', 'canceladas', 'abiertas'].map((k) => ({
        dia: p.dia, dato: k, jorge: p.jorge[k], nuestro: p.nuestro[k], diferencia: p.diferencia[k],
      }))));
    const pr = conciliarAvance(conPr, reglas, ahora);
    console.log('Las 38 semanas (error ponderado %), RQ contra PR:');
    console.table(conc.resumen.map((r, i) => ({ kpi: r.kpi, semanas: r.semanas, error_rq: r.error_pct, error_pr: pr.resumen[i].error_pct, sesgo_rq: r.sesgo })));
    console.log(`Criterio con RQ (≤5% en recibidas, atendidas y abiertas): ${conc.criterio.cumple ? 'SÍ' : 'NO'} · ${conc.criterio.kpis.map((k) => `${k.kpi} ${k.error_pct}%`).join(' · ')}`);
    console.log('\nListo.');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
});
