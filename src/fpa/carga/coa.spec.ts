import { construirCatalogo, quitarBeneficiario, type FilaCoa } from './coa';
import { clave, nombreCanonico } from './normalizar';

const fila = (
  cuenta: string,
  centro: string | null,
  departamento: string,
  desc2: string,
  desc3: string,
  ceco: string | null = null,
): FilaCoa => ({ cuenta, lfc: centro, ceco, departamento, desc2, desc3 });

describe('normalizar', () => {
  it('compara sin acentos, mayúsculas, signos ni palabras vacías', () => {
    expect(clave('Vales Restaurante')).toBe(clave('Vales de Restaurante'));
    expect(clave('Comunicaciónes')).toBe(clave('Comunicaciones'));
    expect(clave('Renta de autos ')).toBe(clave('renta  de AUTOS'));
    expect(clave('Fee O&M')).toBe('fee o&m');
    expect(clave('Fee O&M (Naes)')).not.toBe(clave('Fee O&M'));
  });

  it('corrige la ortografía sin cambiar la clave', () => {
    expect(nombreCanonico('Renta de Vehiculos')).toBe('Renta de Vehículos');
    expect(nombreCanonico('  O&M  Vehículos de planta ')).toBe(
      'O&M Vehículos de planta',
    );
    expect(nombreCanonico('Psícologa')).toBe('Psicóloga');
    expect(nombreCanonico('O&M Dep de Mantenimeinto')).toBe(
      'O&M Departamento de Mantenimiento',
    );
    expect(nombreCanonico('Asesoría Legal')).toBe('Asesoría Legal');
  });
});

describe('quitarBeneficiario', () => {
  it('quita el departamento al final en Beneficios', () => {
    expect(
      quitarBeneficiario(
        'Beneficios',
        'Vales de Restaurante Dirección General',
      ),
    ).toEqual({
      clasificacion: 'Vales de Restaurante',
      beneficiario: 'Dirección General',
    });
    expect(
      quitarBeneficiario('Beneficios', 'Fondo de Ahorro Operación Tabasco'),
    ).toEqual({
      clasificacion: 'Fondo de Ahorro',
      beneficiario: 'Operación Tabasco',
    });
    expect(quitarBeneficiario('Beneficios', 'Gasolina IT')).toEqual({
      clasificacion: 'Gasolina',
      beneficiario: 'IT',
    });
  });

  it('en Capacitación, el departamento solo es la categoría', () => {
    expect(quitarBeneficiario('Capacitación', 'Legal')).toEqual({
      clasificacion: 'Capacitación',
      beneficiario: 'Legal',
    });
    expect(quitarBeneficiario('Capacitación', 'Capacitación')).toEqual({
      clasificacion: 'Capacitación',
      beneficiario: null,
    });
  });

  it('las claves de Servicios Generales son la categoría', () => {
    expect(quitarBeneficiario('Papeleria', 'RHG')).toEqual({
      clasificacion: 'Papeleria',
      beneficiario: 'RHG',
    });
  });

  it('no toca otras categorías', () => {
    expect(
      quitarBeneficiario('Servicios Profesionales', 'Asesoría Legal'),
    ).toEqual({ clasificacion: 'Asesoría Legal', beneficiario: null });
    expect(quitarBeneficiario('Comunicaciones', 'Internet Tabasco')).toEqual({
      clasificacion: 'Internet Tabasco',
      beneficiario: null,
    });
  });
});

describe('construirCatalogo', () => {
  const filas: FilaCoa[] = [
    fila(
      '600000000000001',
      'GSGAD012',
      'Compras',
      'Servicios Profesionales',
      'Servicios Profesionales',
    ),
    fila('600000000000002', 'GSGAD012', 'Compras', 'Otros', 'Otros'),
    fila(
      '600000000000003',
      'GSGAD012',
      'Compras',
      'Arrendamientos',
      'Renta de Vehiculos',
    ),
    fila(
      '600000000000004',
      'GSGAD014',
      'Cuarto Tren',
      'otros',
      'No deducibles',
    ),
    fila('600000000000005', 'GSGAD014', 'Cuarto Tren', 'Comunicaciones', ''),
    fila(
      '600000000000006',
      'GSGAD001',
      'Recursos Humanos',
      'Beneficios',
      'Autos Comercial',
    ),
    fila(
      '600000000000007',
      'GSGAD001',
      'Recursos Humanos',
      'Beneficios',
      'Autos Legal',
    ),
    fila(
      '600000000000008',
      'GSGAD001',
      'Recursos Humanos',
      'Beneficios',
      'Descuento Vales de Restaurante Compras',
    ),
    fila(
      '600000000000009',
      'GSGAD009',
      'Servicios Generales',
      'Papeleria',
      'RHG',
    ),
    fila(
      '601001001150000',
      'GMTOM005',
      'NAES',
      'O&M Consumibles',
      'O&M Consumibles',
    ),
    fila(
      '601001001280000',
      null,
      'NAES',
      'O&M Departamento de Administración',
      'O&M Departamento de Administración',
      'GMTOM018',
    ),
    fila(
      '601001002280000',
      null,
      'NAES',
      'O&M Dep Administración',
      'O&M Dep Administración',
      'GMTOM018',
    ),
    fila(
      '602001000110000',
      'GGEEM600',
      'GE',
      'GE Fixed Fee + Variable Fee',
      'GE Fixed Fee + Variable Fee',
    ),
    // Fuera: ingreso, depreciación y cuentas sin centro de FP&A
    fila(
      '410001000100000',
      'IR010000',
      'Socio de Negocio',
      'Cargo Fijo',
      'Cargo Fijo',
    ),
    fila(
      '600000000000010',
      'DOFID100',
      'Amortizaciones',
      'Depreciación',
      'Depreciación',
    ),
  ];
  const cat = construirCatalogo(filas);

  it('departamentos con su centro de costos; NAES y GE por prefijo', () => {
    expect(cat.departamentos).toEqual([
      { nombre: 'Recursos Humanos', centro_costos: 'GSGAD001', cuentas: 3 },
      { nombre: 'Servicios Generales', centro_costos: 'GSGAD009', cuentas: 1 },
      { nombre: 'Compras', centro_costos: 'GSGAD012', cuentas: 3 },
      { nombre: 'Cuarto Tren', centro_costos: 'GSGAD014', cuentas: 2 },
      { nombre: 'NAES', centro_costos: 'GMTOM', cuentas: 3 },
      { nombre: 'GE', centro_costos: 'GGEEM', cuentas: 1 },
    ]);
  });

  it('sin duplicados por mayúsculas ni por los "Dep" de NAES', () => {
    const nombres = cat.categorias.map((c) => c.nombre);
    expect(nombres.filter((n) => clave(n) === 'otros')).toEqual(['Otros']);
    expect(nombres.filter((n) => n.includes('Administración'))).toEqual([
      'O&M Departamento de Administración',
    ]);
  });

  it('sin beneficiario, con ortografía y negativos en los descuentos', () => {
    const beneficios = cat.categorias.find((c) => c.nombre === 'Beneficios');
    // Autos acepta negativos por el ajuste D-5 (NEGATIVOS_D5)
    expect(beneficios?.clasificaciones).toEqual([
      { nombre: 'Autos', acepta_negativos: true },
      { nombre: 'Descuento Vales de Restaurante', acepta_negativos: true },
    ]);
    expect(
      cat.categorias.find((c) => c.nombre === 'Papelería')?.clasificaciones,
    ).toEqual([{ nombre: 'Papelería', acepta_negativos: false }]);
    expect(
      cat.categorias.find((c) => c.nombre === 'Arrendamientos')
        ?.clasificaciones,
    ).toEqual([{ nombre: 'Renta de Vehículos', acepta_negativos: false }]);
  });

  it('las de siempre van primero en el orden', () => {
    const orden = cat.categorias.map((c) => c.nombre);
    expect(orden.slice(0, 3)).toEqual([
      'Servicios Profesionales',
      'Arrendamientos',
      'Otros',
    ]);
    expect(cat.categorias.map((c) => c.orden)).toEqual(
      orden.map((_, i) => i + 1),
    );
  });

  it('parejas por departamento y aviso de las cuentas sin descripción', () => {
    expect(cat.pares['Cuarto Tren']).toEqual([['Otros', 'No deducibles']]);
    expect(cat.pares['Recursos Humanos']).toEqual([
      ['Beneficios', 'Autos'],
      ['Beneficios', 'Descuento Vales de Restaurante'],
    ]);
    expect(cat.pares.NAES).toEqual([
      ['O&M Consumibles', 'O&M Consumibles'],
      [
        'O&M Departamento de Administración',
        'O&M Departamento de Administración',
      ],
    ]);
    expect(cat.avisos).toEqual([
      'Cuarto Tren: 1 cuenta(s) sin Descripción 2 o 3; no entran al catálogo',
    ]);
  });
});
