import { PrismaService } from '../prisma/prisma.service';
import { loadPendingRequests } from './pending-requests';

/**
 * K4 (2026-10-05) — pendientes de gestionar de Maximo = PR aprobadas (APPR)
 * sin OC ni contrato, por PR y por fecha de aprobación; las WAPPR aparte.
 * Prisma mockeado: se pinza el SQL y el mapeo (los conteos con los fixtures
 * sembrados de K3.8 se revisan en dev).
 */

type SqlArg = { sql: string; values: unknown[] };

function makePrisma(maximoRow: Record<string, number> | null) {
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce([{ pendientes: 5, sin_limite: 9 }])
    .mockResolvedValueOnce(maximoRow ? [maximoRow] : []);
  return {
    prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
    queryRaw,
  };
}

const maximoSql = (queryRaw: jest.Mock) => {
  const [arg] = queryRaw.mock.calls[1] as [SqlArg];
  return { text: arg.sql.replace(/\s+/g, ' '), values: arg.values };
};

/** Expresión de un FILTER por su alias de columna. */
const filterOf = (text: string, column: string) => {
  const end = text.indexOf(` AS ${column},`);
  const start = text.lastIndexOf('count(', end);
  return text.slice(start, end);
};

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2027-01-01T00:00:00Z');

describe('loadPendingRequests (K4)', () => {
  it('Maximo por PR sobre la vista por PR (sin obsoletas): la fila vieja no duplica la PR', async () => {
    const { prisma, queryRaw } = makePrisma(null);
    await loadPendingRequests(prisma, FROM, TO);
    const { text } = maximoSql(queryRaw);
    expect(text).toContain('DISTINCT ON (prnum)');
    expect(text).toContain('superseded_at IS NULL');
    expect(text).toContain('FROM prs p');
    expect(text).toContain('count(DISTINCT p.prnum) FILTER');
    // ya no hay ventana de folios ni la vista por contrato
    expect(text).not.toContain('regexp_replace');
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('el periodo de las APPR va por la llegada a Compras (primer APPR); las WAPPR, por su emisión', async () => {
    const { prisma, queryRaw } = makePrisma(null);
    await loadPendingRequests(prisma, FROM, TO);
    const { text, values } = maximoSql(queryRaw);
    const llegada = 'coalesce(p.pr_approved_at, p.pr_issue_date)';
    for (const column of ['pendientes', 'de_contrato', 'aprobadas_con_oc']) {
      const filter = filterOf(text, column);
      expect(filter).toContain("p.pr_status = 'APPR'");
      expect(filter).toContain(`AND ${llegada} >= ? AND ${llegada} < ?`);
    }
    const enAprobacion = filterOf(text, 'en_aprobacion');
    expect(enAprobacion).toContain("p.pr_status = 'WAPPR'");
    expect(enAprobacion).toContain(
      'AND p.pr_issue_date >= ? AND p.pr_issue_date < ?',
    );
    expect(enAprobacion).not.toContain('pr_approved_at');
    // sin límite: la misma condición sin periodo
    for (const column of [
      'sin_limite',
      'de_contrato_sin_limite',
      'aprobadas_con_oc_sin_limite',
      'en_aprobacion_sin_limite',
    ]) {
      expect(filterOf(text, column)).not.toContain('>= ?');
    }
    expect(values.filter((v) => v === FROM)).toHaveLength(4);
    expect(values.filter((v) => v === TO)).toHaveLength(4);
  });

  it('pendientes, de contrato y con OC parten las APPR (las WAPPR no se suman)', async () => {
    const { prisma, queryRaw } = makePrisma(null);
    await loadPendingRequests(prisma, FROM, null);
    const { text } = maximoSql(queryRaw);
    const pendientes = filterOf(text, 'pendientes');
    const deContrato = filterOf(text, 'de_contrato');
    const conOc = filterOf(text, 'aprobadas_con_oc');
    expect(pendientes).toContain('NOT p.de_contrato');
    expect(pendientes).toContain('p.prnum NOT IN (');
    expect(deContrato).toContain('AND p.de_contrato');
    expect(deContrato).toContain('p.prnum NOT IN (');
    expect(conOc).toContain('p.prnum IN (');
    expect(conOc).not.toContain('de_contrato');
    // sin año: últimos 12 meses abiertos (sin límite superior)
    expect(pendientes).not.toContain('< ?');
  });

  it('mapea los conteos tal cual: las APPR en sus tres partes y las WAPPR aparte', async () => {
    const { prisma } = makePrisma({
      pendientes: 1,
      sin_limite: 3,
      de_contrato: 2,
      de_contrato_sin_limite: 4,
      aprobadas_con_oc: 6,
      aprobadas_con_oc_sin_limite: 38,
      en_aprobacion: 13,
      en_aprobacion_sin_limite: 26,
      con_estatus: 5197,
    });
    const result = await loadPendingRequests(prisma, FROM, TO);
    expect(result.maximo).toEqual({
      pendientes: 1,
      sin_limite: 3,
      de_contrato: 2,
      de_contrato_sin_limite: 4,
      aprobadas_con_oc: 6,
      aprobadas_con_oc_sin_limite: 38,
      en_aprobacion: 13,
      en_aprobacion_sin_limite: 26,
    });
    expect(result.sap).toEqual({ pendientes: 5, sin_limite: 9 });
    expect(result).toMatchObject({ desde: '2026-01-01', hasta: '2026-12-31' });
  });

  it('sin pr_status en ninguna PR (antes del primer full) → null, nunca 0', async () => {
    const { prisma } = makePrisma({
      pendientes: 0,
      sin_limite: 0,
      de_contrato: 0,
      de_contrato_sin_limite: 0,
      aprobadas_con_oc: 0,
      aprobadas_con_oc_sin_limite: 0,
      en_aprobacion: 0,
      en_aprobacion_sin_limite: 0,
      con_estatus: 0,
    });
    const result = await loadPendingRequests(prisma, FROM, null);
    expect(result.maximo).toMatchObject({
      pendientes: null,
      de_contrato: null,
      aprobadas_con_oc: null,
      en_aprobacion: null,
      sin_limite: 0,
    });
    expect(result.hasta).toBeNull();
  });
});
