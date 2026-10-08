import {
  isMaximoInApproval,
  MAXIMO_APPROVAL_LEVELS,
  MAXIMO_LAST_APPROVAL_LEVEL,
  MAXIMO_STATUS_LABELS,
  maximoApprovedLevel,
  maximoLevelHolder,
  maximoStatusLabel,
  maximoStatusWithCode,
} from './maximo-status.util';

/**
 * L3 (2026-10-07): estatus de OC de Maximo con las palabras del cliente y
 * titular por nivel de autorización. Misma tabla en el front.
 */

describe('Etiquetas de estatus de OC de Maximo (L3, tabla del cliente)', () => {
  it('las palabras del cliente; en la OC, en femenino', () => {
    expect(maximoStatusLabel('INPRG')).toBe('En progreso');
    expect(maximoStatusLabel('PNDREV')).toBe('Revisión pendiente');
    expect(maximoStatusLabel('REVISD')).toBe('Revisada');
    expect(maximoStatusLabel('HOLD')).toBe('En suspenso');
    expect(maximoStatusLabel('APPR')).toBe('Aprobada');
    expect(maximoStatusLabel('WAPPR')).toBe('En espera de aprobación');
    expect(maximoStatusLabel('CAN')).toBe('Cancelada');
    expect(maximoStatusLabel('CLOSE')).toBe('Cerrada');
  });

  it('APPRn y APPRnREV = "Autorización n", nivel 5 incluido', () => {
    expect(maximoStatusLabel('APPR1')).toBe('Autorización 1');
    expect(maximoStatusLabel('APPR2REV')).toBe('Autorización 2');
    expect(maximoStatusLabel('APPR5')).toBe('Autorización 5');
    expect(maximoStatusLabel('APPR5REV')).toBe('Autorización 5');
  });

  it('desconocido o vacío: tal cual, sin inventar', () => {
    expect(maximoStatusLabel('WSTART')).toBe('WSTART');
    expect(maximoStatusLabel(null)).toBe('');
    // APPRn es dinámico, no vive en el mapa fijo
    expect(Object.keys(MAXIMO_STATUS_LABELS).some((s) => /\d/.test(s))).toBe(
      false,
    );
  });

  it('exports: la etiqueta con el código entre paréntesis', () => {
    expect(maximoStatusWithCode('HOLD')).toBe('En suspenso (HOLD)');
    expect(maximoStatusWithCode('INPRG')).toBe('En progreso (INPRG)');
    expect(maximoStatusWithCode('PNDREV')).toBe('Revisión pendiente (PNDREV)');
    expect(maximoStatusWithCode('REVISD')).toBe('Revisada (REVISD)');
    expect(maximoStatusWithCode('APPR5REV')).toBe('Autorización 5 (APPR5REV)');
    expect(maximoStatusWithCode('WSTART')).toBe('WSTART');
    expect(maximoStatusWithCode(null)).toBe('');
  });
});

describe('En aprobación (G7) con el nivel 5 (L3)', () => {
  it('WAPPR, APPRn y APPRnREV siguen en aprobación; APPR5 y APPR5REV también', () => {
    for (const status of ['WAPPR', 'APPR1', 'APPR4REV', 'APPR5', 'APPR5REV']) {
      expect(isMaximoInApproval(status)).toBe(true);
    }
    for (const status of ['APPR', 'INPRG', 'HOLD', 'PNDREV', 'REVISD', null]) {
      expect(isMaximoInApproval(status)).toBe(false);
    }
  });

  it('nivel ya autorizado de APPRn / APPRnREV', () => {
    expect(maximoApprovedLevel('APPR5')).toBe(5);
    expect(maximoApprovedLevel('APPR5REV')).toBe(5);
    expect(maximoApprovedLevel('WAPPR')).toBeNull();
    expect(maximoApprovedLevel('APPR')).toBeNull();
  });
});

describe('Titular por nivel (MAXIMO_APPROVAL_LEVELS)', () => {
  it('los cinco niveles de la tabla del cliente', () => {
    expect(MAXIMO_APPROVAL_LEVELS).toEqual({
      1: 'David Alejandro Rodríguez Ojeda',
      2: 'Miguel Ángel Ortiz García',
      3: 'Gilberto Maltos Vázquez',
      4: 'Uriel Lases García',
      5: 'Alejandro Escandón',
    });
    expect(MAXIMO_LAST_APPROVAL_LEVEL).toBe(5);
  });

  it('el titular de un nivel; fuera de la tabla, null', () => {
    expect(maximoLevelHolder(2)).toBe('Miguel Ángel Ortiz García');
    expect(maximoLevelHolder(5)).toBe('Alejandro Escandón');
    expect(maximoLevelHolder(6)).toBeNull();
    expect(maximoLevelHolder(null)).toBeNull();
  });
});
