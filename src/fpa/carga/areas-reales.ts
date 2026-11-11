/**
 * FP&A (bloque C, C2) — las áreas reales con su gente (14 desde el 10-nov).
 *
 * Fuente: la relación de capturistas que Laura mandó el 27-oct
 * (`Relación capturistas y aprobadores por departamento.xlsx`, Hoja1!B2:D15;
 * FPA.md, "Reunión del 26-oct", punto 4.2), con lo que ella actualizó el
 * 10-nov (NAES la captura alfredo.moreno y Seguros, ella misma), y lo acordado
 * el 4-nov (FPA.md, "Reunión del 4-nov", "Cómo quedan las firmas"):
 *   - captura: el primero de la relación es el titular y los demás "también
 *     capturan" (filas de suplente);
 *   - aprueba: Laura titular y Liliana suplente en todas las áreas; en DG,
 *     Finanzas y Seguros, solo Liliana, porque Laura las captura (la base no
 *     deja que quien captura un área la apruebe).
 *
 * La columna "Aprobación" de la relación (Denisse, Gilberto, Guillermo…) no se
 * usa: desde el 4-nov esos líderes revisan con su equipo antes de enviar y no
 * firman en la plataforma. Uriel no se registra en Finanzas: si él envía,
 * nadie puede firmar el paso del CFO (FPA.md, 4-nov).
 */

export const DOMINIO = '@abent3t.com';

export interface AreaReal {
  area: string;
  /** Departamento propio, con el nombre del COA (TI es el IT del COA). */
  departamento: string;
  /** Correos sin dominio, en el orden de la relación. */
  captura: string[];
  /** Si no viene, Laura titular y Liliana suplente. */
  aprueba?: string[];
  /** Lo que no se pudo registrar y por qué. */
  pendiente?: string;
}

export const APRUEBAN_POR_OMISION = ['laura.montano', 'liliana.martinez'];

export const AREAS_REALES: AreaReal[] = [
  {
    area: 'Recursos Humanos',
    departamento: 'Recursos Humanos',
    captura: ['cristhian.guadarrama'],
  },
  {
    area: 'Servicios Generales',
    departamento: 'Servicios Generales',
    captura: ['ollin.herrera'],
  },
  {
    area: 'TI',
    departamento: 'IT',
    captura: ['cesar.callejas.ext', 'ollin.herrera'],
  },
  {
    area: 'Operación',
    departamento: 'Operación',
    captura: ['gilberto.maltos', 'noemi.velazquez'],
  },
  {
    area: 'Planta',
    departamento: 'Planta',
    captura: ['gilberto.maltos', 'noemi.velazquez'],
  },
  { area: 'GE', departamento: 'GE', captura: ['gilberto.maltos'] },
  { area: 'NAES', departamento: 'NAES', captura: ['alfredo.moreno'] },
  {
    area: 'Comercial',
    departamento: 'Comercial',
    captura: ['pedro.izoteco', 'omarfrancisco.cruz'],
  },
  {
    area: 'Medición',
    departamento: 'Medición',
    captura: ['victor.olarte', 'diego.torres'],
  },
  {
    area: 'Compras',
    departamento: 'Compras',
    captura: ['diana.mendez', 'ingrid.torres'],
  },
  {
    area: 'Dirección General',
    departamento: 'Dirección General',
    captura: ['laura.montano'],
    aprueba: ['liliana.martinez'],
  },
  {
    area: 'Finanzas',
    departamento: 'Finanzas',
    captura: ['laura.montano', 'henrry.garcia'],
    aprueba: ['liliana.martinez'],
    pendiente:
      'uriel.lases no se registra para capturar: si él envía, nadie puede firmar el paso del CFO',
  },
  {
    area: 'Seguros',
    departamento: 'Seguros',
    captura: ['laura.montano'],
    aprueba: ['liliana.martinez'],
  },
  {
    area: 'Legal',
    departamento: 'Legal',
    captura: ['graciela.herrera', 'erin.valverde', 'roberto.martinez'],
  },
];

/**
 * Áreas del control que no vienen en la relación (se listan, no se crean).
 * Vacía desde el 10-nov, cuando Laura agregó Seguros.
 */
export const AREAS_PENDIENTES: string[] = [];

export interface Responsable {
  email: string;
  duty: 'captura' | 'aprobacion';
  /** true = "también captura" o suplente de aprobación. */
  is_alternate: boolean;
}

/** Responsables que pide la relación para un área, en orden. */
export function responsablesDe(a: AreaReal): Responsable[] {
  const correo = (local: string) => `${local}${DOMINIO}`.toLowerCase();
  return [
    ...a.captura.map((c, i) => ({
      email: correo(c),
      duty: 'captura' as const,
      is_alternate: i > 0,
    })),
    ...(a.aprueba ?? APRUEBAN_POR_OMISION).map((c, i) => ({
      email: correo(c),
      duty: 'aprobacion' as const,
      is_alternate: i > 0,
    })),
  ];
}
