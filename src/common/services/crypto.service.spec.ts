import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { CryptoService } from './crypto.service';

/**
 * Fase 0 — T2. Las claves de este archivo son ficticias de test.
 */
describe('CryptoService', () => {
  const TEST_KEY = 'clave-de-prueba-unitaria-con-mas-de-32-caracteres';

  const makeService = (key: string | null = TEST_KEY) =>
    new CryptoService({
      get: () => key ?? undefined,
    } as unknown as ConfigService);

  /**
   * Reproduce el esquema LEGADO (aes-256-cbc, scrypt con salt estático) tal
   * como existía en platforms.service.ts antes de T2, para verificar que el
   * decrypt de compatibilidad lo lee. El salt es la palabra s-a-l-t en hex.
   */
  const encryptLegacy = (plaintext: string, masterKey: string): string => {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(masterKey, Buffer.from('73616c74', 'hex'), 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  };

  it('lanza si PLATFORM_ENCRYPTION_KEY no está configurada (sin fallback)', () => {
    expect(() => makeService(null)).toThrow('PLATFORM_ENCRYPTION_KEY');
  });

  it('roundtrip: encrypt → decrypt devuelve el texto original', () => {
    const service = makeService();
    const plaintext = 'secret-access-de-prueba-123';
    const ciphertext = service.encrypt(plaintext);
    expect(service.decrypt(ciphertext)).toBe(plaintext);
  });

  it('encrypt produce únicamente formato v2', () => {
    const service = makeService();
    const ciphertext = service.encrypt('cualquier-valor');
    expect(ciphertext.startsWith('v2:')).toBe(true);
    expect(service.isV2(ciphertext)).toBe(true);
    // v2:<salt>:<iv>:<authTag>:<datos>
    expect(ciphertext.split(':')).toHaveLength(5);
  });

  it('dos encrypt del mismo texto producen ciphertexts distintos (salt/IV aleatorios)', () => {
    const service = makeService();
    expect(service.encrypt('mismo-texto')).not.toBe(service.encrypt('mismo-texto'));
  });

  it('descifrar un ciphertext manipulado (tamper) lanza error', () => {
    const service = makeService();
    const ciphertext = service.encrypt('dato-integro');
    const parts = ciphertext.split(':');
    // Alterar un byte de los datos cifrados (última sección)
    const data = parts[4];
    const flipped = (data[0] === '0' ? '1' : '0') + data.slice(1);
    const tampered = [...parts.slice(0, 4), flipped].join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('descifrar con otra clave lanza error (auth tag no verifica)', () => {
    const serviceA = makeService();
    const serviceB = makeService('otra-clave-distinta-tambien-de-mas-de-32-chars');
    const ciphertext = serviceA.encrypt('dato');
    expect(() => serviceB.decrypt(ciphertext)).toThrow();
  });

  it('descifra el formato legado (CBC) con la clave actual', () => {
    const service = makeService();
    const legacy = encryptLegacy('credencial-legada', TEST_KEY);
    expect(service.isV2(legacy)).toBe(false);
    expect(service.decrypt(legacy)).toBe('credencial-legada');
  });

  it('descifra el formato legado con clave override (escenario de migración)', () => {
    const service = makeService();
    const legacyKey = 'clave-legada-anterior-de-mas-de-32-caracteres-x';
    const legacy = encryptLegacy('credencial-vieja', legacyKey);
    // Con la clave actual NO recupera el texto (CBC sin auth puede fallar con
    // error de padding o devolver basura; ambas cosas son "no recupera").
    let conClaveActual: string | null = null;
    try {
      conClaveActual = service.decrypt(legacy);
    } catch {
      // esperado en la mayoría de los casos
    }
    expect(conClaveActual).not.toBe('credencial-vieja');
    // Con el override (la clave con la que se cifró) sí recupera.
    expect(service.decrypt(legacy, legacyKey)).toBe('credencial-vieja');
  });

  it('formatos inválidos lanzan error claro', () => {
    const service = makeService();
    expect(() => service.decrypt('v2:solo:tres:partes')).toThrow('formato inválido');
    expect(() => service.decrypt('sin-separador')).toThrow('formato inválido');
  });
});
