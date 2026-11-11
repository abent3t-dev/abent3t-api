import { AREAS_REALES, responsablesDe } from './areas-reales';
import { clave } from './normalizar';

describe('áreas reales (C2)', () => {
  it('son las 14 de la relación (Seguros desde el 10-nov), sin repetir', () => {
    expect(AREAS_REALES).toHaveLength(14);
    expect(new Set(AREAS_REALES.map((a) => clave(a.area))).size).toBe(14);
    expect(new Set(AREAS_REALES.map((a) => clave(a.departamento))).size).toBe(
      14,
    );
  });

  it('nadie captura y aprueba la misma área (uq_fpa_assignments_area_person)', () => {
    for (const a of AREAS_REALES) {
      const r = responsablesDe(a);
      expect(new Set(r.map((x) => x.email)).size).toBe(r.length);
    }
  });

  it('un titular por función; los demás capturan o suplen', () => {
    for (const a of AREAS_REALES) {
      const r = responsablesDe(a);
      for (const duty of ['captura', 'aprobacion'] as const) {
        const titulares = r.filter((x) => x.duty === duty && !x.is_alternate);
        expect(titulares.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('Laura y Liliana aprueban; en DG, Finanzas y Seguros, solo Liliana (4-nov)', () => {
    const aprueba = (area: string) =>
      responsablesDe(AREAS_REALES.find((a) => a.area === area)!)
        .filter((x) => x.duty === 'aprobacion')
        .map((x) => `${x.email}${x.is_alternate ? ' (suplente)' : ''}`);
    expect(aprueba('Compras')).toEqual([
      'laura.montano@abent3t.com',
      'liliana.martinez@abent3t.com (suplente)',
    ]);
    expect(aprueba('Dirección General')).toEqual([
      'liliana.martinez@abent3t.com',
    ]);
    expect(aprueba('Finanzas')).toEqual(['liliana.martinez@abent3t.com']);
    expect(aprueba('Seguros')).toEqual(['liliana.martinez@abent3t.com']);
  });

  it('Uriel no captura Finanzas; NAES la captura Alfredo y Seguros, Laura (10-nov)', () => {
    const correos = AREAS_REALES.flatMap((a) =>
      responsablesDe(a).map((r) => r.email),
    );
    expect(correos).not.toContain('uriel.lases@abent3t.com');
    expect(correos.every((c) => c.endsWith('@abent3t.com'))).toBe(true);
    const captura = (area: string) =>
      AREAS_REALES.find((a) => a.area === area)?.captura;
    expect(captura('NAES')).toEqual(['alfredo.moreno']);
    expect(captura('Seguros')).toEqual(['laura.montano']);
    expect(captura('TI')).toEqual(['cesar.callejas.ext', 'ollin.herrera']);
  });
});
