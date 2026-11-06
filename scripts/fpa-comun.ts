/**
 * FP&A (bloque C) — lo que comparten los scripts de carga del bloque C
 * (fpa:catalogo, fpa:areas y fpa:b27):
 *   - la guardia de NODE_ENV=production (regla 7: en prod se corren desde un
 *     contenedor efímero con DATABASE_URL de prod, como fpa:arranque);
 *   - la transacción: en modo de prueba (por omisión) se corre todo y se
 *     deshace; con --commit se escribe, salvo que la verificación falle;
 *   - los totales por versión con fpa-calc, para comprobar que una carga no
 *     mueva lo que ya existe (la B-26 de prod da $6,426,591.28).
 */
import { Prisma } from '@prisma/client';
import { calcLine } from '../src/fpa/fpa-calc';
import { PrismaService } from '../src/prisma/prisma.service';

export type Tx = Prisma.TransactionClient;

export const COMMIT = process.argv.includes('--commit');

/** Valor de una opción `--nombre valor` (o null si no viene). */
export function opcion(nombre: string): string | null {
  const i = process.argv.indexOf(nombre);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

export const log = (msg: string) => console.log(msg);

export function guardiaProduccion(script: string) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Guardia: ${script} no corre con NODE_ENV=production (regla 7). Córrelo desde un contenedor efímero con DATABASE_URL de prod.`,
    );
  }
}

class Deshacer extends Error {}

/**
 * Corre `trabajo` en una transacción. Sin --commit, o si `trabajo` regresa
 * problemas, se deshace todo. Regresa lo que regresó `trabajo` y si se
 * escribió.
 */
export async function enTransaccion<T extends { problemas: string[] }>(
  prisma: PrismaService,
  trabajo: (tx: Tx) => Promise<T>,
): Promise<{ resultado: T; escrito: boolean }> {
  let resultado: T | null = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        resultado = await trabajo(tx);
        if (!COMMIT || resultado.problemas.length > 0) throw new Deshacer();
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
  } catch (e) {
    if (!(e instanceof Deshacer)) throw e;
  }
  const r = resultado as T | null;
  if (!r) throw new Error('La carga no regresó resultado');
  return { resultado: r, escrito: COMMIT && r.problemas.length === 0 };
}

export interface TotalVersion {
  total: Prisma.Decimal;
  lineas: number;
  noDisponibles: number;
}

/** Total en pesos de las líneas vivas de cada versión (fpa-calc), por clave. */
export async function totalesPorVersion(
  tx: Tx,
): Promise<Map<string, TotalVersion>> {
  const versiones = await tx.fpa_versions.findMany({
    include: {
      fpa_exchange_rates: { where: { is_active: true } },
      fpa_travel_rates: { where: { is_active: true } },
    },
  });
  const salida = new Map<string, TotalVersion>();
  for (const v of versiones) {
    const params = {
      inflation_pct: v.inflation_pct,
      cutoff_month: v.cutoff_month,
      rates: Object.fromEntries(
        v.fpa_exchange_rates.map((r) => [r.currency, r.rate_mxn]),
      ),
      travel_rates: v.fpa_travel_rates,
    };
    const lineas = await tx.fpa_budget_lines.findMany({
      where: {
        version_id: v.id,
        is_active: true,
        fpa_budgets: { is_active: true },
      },
      include: { fpa_budget_line_months: true },
    });
    let total = new Prisma.Decimal(0);
    let noDisponibles = 0;
    for (const l of lineas) {
      const r = calcLine({ ...l, months: l.fpa_budget_line_months }, params);
      if (r.total_mxn) total = total.plus(r.total_mxn);
      else noDisponibles += 1;
    }
    salida.set(v.code, { total, lineas: lineas.length, noDisponibles });
  }
  return salida;
}

/** Diferencias entre dos fotos de totales (versiones que cambiaron). */
export function compararTotales(
  antes: Map<string, TotalVersion>,
  despues: Map<string, TotalVersion>,
  ignorar: string[] = [],
): string[] {
  const problemas: string[] = [];
  for (const [codigo, a] of antes) {
    if (ignorar.includes(codigo)) continue;
    const d = despues.get(codigo);
    if (!d) {
      problemas.push(`la versión ${codigo} ya no está`);
      continue;
    }
    if (
      !a.total.equals(d.total) ||
      a.lineas !== d.lineas ||
      a.noDisponibles !== d.noDisponibles
    ) {
      problemas.push(
        `${codigo} cambió: ${a.total.toFixed(2)} (${a.lineas} líneas) › ${d.total.toFixed(2)} (${d.lineas} líneas)`,
      );
    }
  }
  return problemas;
}

/** Busca por nombre sin distinguir mayúsculas (como la pantalla de Áreas). */
export const nombrado = (name: string) => ({
  equals: name,
  mode: 'insensitive' as const,
});
