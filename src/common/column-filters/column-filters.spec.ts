import { BadRequestException } from '@nestjs/common';
import {
  applyColumnQuery,
  columnFacet,
  ColumnDefs,
  dateKey,
  FACET_LIMIT,
  isColumnQueryActive,
  paginateRows,
  parseColumnQuery,
  requireFacetColumn,
  TextFacet,
  RangeFacet,
} from './column-filters';

/**
 * E1 (2026-09-25) — Motor del filtro "tipo Excel": parseo/validación,
 * filtros por valores y por rango, orden con vacías al final, facetas y
 * paginación en memoria.
 */

interface Row {
  po: string;
  supplier: string | null;
  days: number | null;
  date: Date | null;
  status: string;
}

const DEFS: ColumnDefs<Row> = {
  po: { type: 'text', value: (r) => r.po },
  supplier: { type: 'text', value: (r) => r.supplier },
  days: { type: 'number', value: (r) => r.days },
  date: { type: 'date', value: (r) => r.date },
  status: { type: 'text', value: (r) => r.status },
};

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const ROWS: Row[] = [
  {
    po: '1',
    supplier: 'Acme',
    days: -1473,
    date: d('2022-09-15'),
    status: 'retrasada',
  },
  {
    po: '2',
    supplier: 'Zeta',
    days: -10,
    date: d('2026-09-15'),
    status: 'retrasada',
  },
  {
    po: '3',
    supplier: 'Álvarez',
    days: 5,
    date: d('2026-09-30'),
    status: 'en_riesgo',
  },
  { po: '4', supplier: null, days: null, date: null, status: 'sin_fecha' },
  {
    po: '5',
    supplier: 'Acme',
    days: 0,
    date: d('2026-09-25'),
    status: 'en_riesgo',
  },
  {
    po: '6',
    supplier: '  ',
    days: 40,
    date: d('2026-11-04'),
    status: 'en_tiempo',
  },
];

const q = (filters: object, sort?: string, order?: 'asc' | 'desc') =>
  parseColumnQuery({ filters: JSON.stringify(filters), sort, order }, DEFS);

const pos = (rows: Row[]) => rows.map((r) => r.po);

describe('column-filters (E1)', () => {
  describe('parseColumnQuery', () => {
    it('sin filtros ni orden no está activo', () => {
      const query = parseColumnQuery({}, DEFS);
      expect(query.filters.size).toBe(0);
      expect(isColumnQueryActive(query)).toBe(false);
      expect(isColumnQueryActive(q({}))).toBe(false);
    });

    it.each([
      ['JSON roto', '{', /JSON/],
      ['arreglo', '[]', /objeto/],
      ['columna desconocida', '{"nope":{"in":["x"]}}', /nope/],
      ['in y nin a la vez', '{"supplier":{"in":[],"nin":[]}}', /in/],
      ['ni in ni nin', '{"supplier":{}}', /in/],
      ['in que no es lista', '{"supplier":{"in":"Acme"}}', /lista/],
      ['rango al revés', '{"days":{"min":5,"max":1}}', /desde/],
      ['número inválido', '{"days":{"min":"abc"}}', /Rango/],
      ['fecha sin formato', '{"date":{"min":"15/09/2026"}}', /AAAA-MM-DD/],
      [
        '__proto__ no es columna',
        '{"__proto__":{"in":["x"]}}',
        /objeto|columna/,
      ],
    ])('rechaza con 400: %s', (_label, filters, message) => {
      expect(() => parseColumnQuery({ filters }, DEFS)).toThrow(
        BadRequestException,
      );
      expect(() => parseColumnQuery({ filters }, DEFS)).toThrow(message);
    });

    it('rechaza ordenar por una columna que no existe', () => {
      expect(() => parseColumnQuery({ sort: 'nope' }, DEFS)).toThrow(/ordenar/);
    });

    it('un rango abierto (sin desde ni hasta) no filtra', () => {
      expect(q({ days: { min: null, max: '' } }).filters.size).toBe(0);
    });

    it('requireFacetColumn exige una columna filtrable', () => {
      expect(requireFacetColumn('supplier', DEFS)).toBe('supplier');
      expect(() => requireFacetColumn(undefined, DEFS)).toThrow(/column/);
      expect(() => requireFacetColumn('nope', DEFS)).toThrow(/nope/);
    });
  });

  describe('applyColumnQuery', () => {
    it('in con "(Vacías)": null también cubre los textos en blanco', () => {
      const out = applyColumnQuery(
        ROWS,
        DEFS,
        q({ supplier: { in: ['Acme', null] } }),
      );
      expect(pos(out)).toEqual(['1', '4', '5', '6']);
    });

    it('nin excluye los valores marcados', () => {
      const out = applyColumnQuery(
        ROWS,
        DEFS,
        q({ status: { nin: ['retrasada', 'sin_fecha'] } }),
      );
      expect(pos(out)).toEqual(['3', '5', '6']);
    });

    it('rango numérico inclusivo; las vacías no entran', () => {
      const out = applyColumnQuery(
        ROWS,
        DEFS,
        q({ days: { min: -400, max: 0 } }),
      );
      expect(pos(out)).toEqual(['2', '5']);
    });

    it('rango de fechas por día y "solo vacías"', () => {
      expect(
        pos(
          applyColumnQuery(
            ROWS,
            DEFS,
            q({ date: { min: '2026-09-15', max: '2026-09-30' } }),
          ),
        ),
      ).toEqual(['2', '3', '5']);
      expect(
        pos(applyColumnQuery(ROWS, DEFS, q({ date: { empty: true } }))),
      ).toEqual(['4']);
    });

    it('criterio de Ingrid: 2 proveedores Y días entre -400 y 0', () => {
      const out = applyColumnQuery(
        ROWS,
        DEFS,
        q({ supplier: { in: ['Acme', 'Zeta'] }, days: { min: -400, max: 0 } }),
      );
      expect(pos(out)).toEqual(['2', '5']);
    });

    it('exclude ignora el filtro de esa columna (base de su faceta)', () => {
      const query = q({ supplier: { in: ['Zeta'] }, days: { max: 0 } });
      expect(
        pos(applyColumnQuery(ROWS, DEFS, query, { exclude: 'supplier' })),
      ).toEqual(['1', '2', '5']);
    });

    it('ordena sin distinguir acentos y deja las vacías al final en ambos sentidos', () => {
      expect(
        pos(applyColumnQuery(ROWS, DEFS, q({}, 'supplier', 'asc'))),
      ).toEqual(['1', '5', '3', '2', '4', '6']);
      expect(
        pos(applyColumnQuery(ROWS, DEFS, q({}, 'supplier', 'desc'))),
      ).toEqual(['2', '3', '1', '5', '4', '6']);
      expect(pos(applyColumnQuery(ROWS, DEFS, q({}, 'days', 'desc')))).toEqual([
        '6',
        '3',
        '5',
        '2',
        '1',
        '4',
      ]);
    });

    it('no toca el arreglo original', () => {
      const copy = [...ROWS];
      applyColumnQuery(ROWS, DEFS, q({}, 'days', 'asc'));
      expect(ROWS).toEqual(copy);
    });
  });

  describe('columnFacet', () => {
    it('texto: conteo por valor (desc), vacías como null y búsqueda sin acentos', () => {
      const facet = columnFacet(ROWS, DEFS, 'supplier') as TextFacet;
      expect(facet.values).toEqual([
        { value: 'Acme', count: 2 },
        { value: null, count: 2 },
        { value: 'Álvarez', count: 1 },
        { value: 'Zeta', count: 1 },
      ]);
      expect(facet.total).toBe(6);
      const search = columnFacet(ROWS, DEFS, 'supplier', 'alva') as TextFacet;
      expect(search.values).toEqual([{ value: 'Álvarez', count: 1 }]);
    });

    it(`texto: tope de ${FACET_LIMIT} valores con aviso`, () => {
      const many = Array.from({ length: FACET_LIMIT + 5 }, (_, i) => ({
        ...ROWS[0],
        supplier: `P${i}`,
      }));
      const facet = columnFacet(many, DEFS, 'supplier') as TextFacet;
      expect(facet.values).toHaveLength(FACET_LIMIT);
      expect(facet.truncated).toBe(true);
    });

    it('número y fecha: mínimo, máximo y sin dato', () => {
      expect(columnFacet(ROWS, DEFS, 'days')).toEqual<RangeFacet>({
        column: 'days',
        type: 'number',
        min: -1473,
        max: 40,
        count: 5,
        empty: 1,
        total: 6,
      });
      const dates = columnFacet(ROWS, DEFS, 'date') as RangeFacet;
      expect([dates.min, dates.max, dates.empty]).toEqual([
        '2022-09-15',
        '2026-11-04',
        1,
      ]);
    });
  });

  it('dateKey: columnas date tal cual; timestamps al día de CDMX', () => {
    expect(dateKey(d('2026-09-15'))).toBe('2026-09-15');
    // 03:00 UTC del 25 = 21:00 del 24 en CDMX
    expect(dateKey(new Date('2026-09-25T03:00:00.000Z'))).toBe('2026-09-24');
    expect(dateKey('no es fecha')).toBeNull();
  });

  it('paginateRows arma el mismo meta que los listados en SQL', () => {
    const page = paginateRows(ROWS, 2, 4);
    expect(pos(page.data)).toEqual(['5', '6']);
    expect(page.meta).toEqual({
      total: 6,
      page: 2,
      limit: 4,
      totalPages: 2,
      hasNext: false,
      hasPrev: true,
    });
  });
});
