import { ConfigService } from '@nestjs/config';
import { loadSapSyncConfig, parseDailyTime } from './sap-sync.config';

/** L1 (2026-10-08): SAP_SYNC_FULL_DAILY_AT en la config del sync. */

const load = (env: Record<string, unknown>) =>
  loadSapSyncConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

describe('loadSapSyncConfig — full diario (L1)', () => {
  it('sin la variable: 03:00', () => {
    expect(load({}).fullDailyAt).toBe('03:00');
  });

  it('normaliza la hora a HH:MM', () => {
    expect(load({ SAP_SYNC_FULL_DAILY_AT: '3:05' }).fullDailyAt).toBe('03:05');
    expect(load({ SAP_SYNC_FULL_DAILY_AT: ' 02:30 ' }).fullDailyAt).toBe(
      '02:30',
    );
  });

  it('off (sin importar mayúsculas) lo apaga: null', () => {
    expect(load({ SAP_SYNC_FULL_DAILY_AT: 'off' }).fullDailyAt).toBeNull();
    expect(load({ SAP_SYNC_FULL_DAILY_AT: 'OFF' }).fullDailyAt).toBeNull();
  });

  it('un valor inválido (sin Joi de por medio) cae al default, nunca a otra hora', () => {
    expect(load({ SAP_SYNC_FULL_DAILY_AT: '25:00' }).fullDailyAt).toBe('03:00');
  });

  it('parseDailyTime: hora y minuto, o null', () => {
    expect(parseDailyTime('03:00')).toEqual({ hour: 3, minute: 0 });
    expect(parseDailyTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseDailyTime('24:00')).toBeNull();
    expect(parseDailyTime('off')).toBeNull();
  });
});
