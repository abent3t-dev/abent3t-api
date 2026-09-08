import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Servicio ÚNICO de cifrado de credenciales de integraciones (Fase 0 — T2,
 * cierra H3). Ninguna otra pieza del código debe cifrar/descifrar por su
 * cuenta.
 *
 * Esquema v2 (el único que produce `encrypt`):
 *   aes-256-gcm con IV aleatorio de 12 bytes por operación y auth tag de 16
 *   bytes verificado al descifrar (un ciphertext manipulado lanza error).
 *
 * Derivación de clave (decisión documentada): scrypt(masterKey, salt, 32) con
 * SALT ALEATORIO de 16 bytes POR OPERACIÓN, almacenado junto al ciphertext.
 * Se eligió derivar (y no usar la clave directa) porque
 * PLATFORM_ENCRYPTION_KEY es una passphrase de longitud mínima 32 caracteres,
 * no 32 bytes exactos de material aleatorio.
 *
 * Formato del ciphertext v2 (hex):  v2:<salt>:<iv>:<authTag>:<datos>
 *
 * Formato legado (solo LECTURA, para migrar datos existentes):
 *   <iv>:<datos>  — aes-256-cbc, clave scrypt(masterKey, salt estático, 32).
 *   `encrypt` NUNCA produce este formato. El soporte de lectura se retirará
 *   cuando `npm run crypto:migrate` haya corrido en todos los ambientes.
 *
 * La clave viene de ConfigService (garantizada por el schema de T1). No hay
 * ningún fallback: sin clave, el constructor lanza y la app no arranca.
 */

const V2_PREFIX = 'v2:';
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // recomendado para GCM
const KEY_LENGTH = 32;

// Salt estático del esquema legado (la palabra s-a-l-t en hex). Existe SOLO
// para poder descifrar datos viejos durante la migración; el esquema v2 usa
// salt aleatorio por operación.
const LEGACY_SCRYPT_SALT = Buffer.from('73616c74', 'hex');

@Injectable()
export class CryptoService {
  private readonly masterKey: string;

  constructor(configService: ConfigService) {
    const key = configService.get<string>('PLATFORM_ENCRYPTION_KEY');
    if (!key) {
      // El schema de env (T1) ya impide llegar aquí; defensa en profundidad
      // sin fallback posible.
      throw new Error(
        'PLATFORM_ENCRYPTION_KEY no está configurada; CryptoService no puede operar',
      );
    }
    this.masterKey = key;
  }

  /** Cifra un texto plano. Produce ÚNICAMENTE el formato v2 (GCM). */
  encrypt(plaintext: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = crypto.scryptSync(this.masterKey, salt, KEY_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return (
      V2_PREFIX +
      [salt, iv, authTag, encrypted].map((b) => b.toString('hex')).join(':')
    );
  }

  /**
   * Descifra un ciphertext v2 o legado (CBC). Lanza error si el formato es
   * inválido o si el auth tag no verifica (v2 manipulado).
   *
   * `masterKeyOverride` existe SOLO para la migración (datos legados cifrados
   * con una clave anterior distinta a la actual). El código de la app llama
   * siempre sin override.
   */
  decrypt(ciphertext: string, masterKeyOverride?: string): string {
    const masterKey = masterKeyOverride ?? this.masterKey;
    return ciphertext.startsWith(V2_PREFIX)
      ? this.decryptV2(ciphertext, masterKey)
      : this.decryptLegacy(ciphertext, masterKey);
  }

  /** true si el ciphertext ya está en el formato v2 (usado por la migración). */
  isV2(ciphertext: string): boolean {
    return ciphertext.startsWith(V2_PREFIX);
  }

  private decryptV2(ciphertext: string, masterKey: string): string {
    const parts = ciphertext.slice(V2_PREFIX.length).split(':');
    if (parts.length !== 4) {
      throw new Error('Ciphertext v2 con formato inválido');
    }
    const [salt, iv, authTag, data] = parts.map((p) => Buffer.from(p, 'hex'));
    const key = crypto.scryptSync(masterKey, salt, KEY_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }

  private decryptLegacy(ciphertext: string, masterKey: string): string {
    const [ivHex, encryptedText] = ciphertext.split(':');
    if (!ivHex || !encryptedText) {
      throw new Error('Ciphertext legado con formato inválido');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(masterKey, LEGACY_SCRYPT_SALT, KEY_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
