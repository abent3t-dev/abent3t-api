import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * StorageService — Fase 3.
 *
 * Reemplaza `supabase.db.storage` por MinIO (S3-compatible) corriendo en
 * el Servidor App. Mantiene la misma API funcional:
 *   - `upload(bucket, key, body, contentType)` → sube un objeto.
 *   - `getSignedUrl(bucket, key, ttl)` → URL temporal para descarga directa.
 *   - `remove(bucket, key)` → borra un objeto.
 *
 * Los 2 buckets que usa el sistema (`evidences`, `proposal-attachments`)
 * quedan en propiedades de conveniencia para no hardcodear strings.
 *
 * Configuración vía env vars (ver `.env.example`):
 *   MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL,
 *   MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
 *   MINIO_BUCKET_EVIDENCES, MINIO_BUCKET_PROPOSALS
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;

  /** Bucket de evidencias de inscripción (10 MB, PDF/JPG/PNG/XLSX/DOCX). */
  readonly bucketEvidences: string;
  /** Bucket de adjuntos de propuestas (mismas reglas). */
  readonly bucketProposals: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT || '127.0.0.1';
    const port = process.env.MINIO_PORT || '9000';
    const useSSL =
      (process.env.MINIO_USE_SSL || '').toLowerCase() === 'true';
    const protocol = useSSL ? 'https' : 'http';

    const accessKeyId = process.env.MINIO_ACCESS_KEY;
    const secretAccessKey = process.env.MINIO_SECRET_KEY;
    if (!accessKeyId || !secretAccessKey) {
      this.logger.error(
        'MINIO_ACCESS_KEY y MINIO_SECRET_KEY son requeridas. Storage no funcionará.',
      );
    }

    this.s3 = new S3Client({
      endpoint: `${protocol}://${endpoint}:${port}`,
      // `region` es obligatorio por el SDK pero MinIO lo ignora.
      region: process.env.MINIO_REGION || 'us-east-1',
      credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || '',
      },
      // CRÍTICO para MinIO (path-style en lugar de virtual-host-style).
      forcePathStyle: true,
    });

    this.bucketEvidences =
      process.env.MINIO_BUCKET_EVIDENCES || 'evidences';
    this.bucketProposals =
      process.env.MINIO_BUCKET_PROPOSALS || 'proposal-attachments';
  }

  /**
   * Al arrancar verifica que ambos buckets existan. NO los crea aquí (el
   * `docker-compose.yml` se encarga con `createbuckets`). Si faltan, loguea
   * un warning pero NO rompe el arranque del server — los uploads fallarán
   * con error claro cuando se intenten.
   */
  async onModuleInit() {
    for (const bucket of [this.bucketEvidences, this.bucketProposals]) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
        this.logger.log(`✓ Bucket "${bucket}" accesible`);
      } catch (err: unknown) {
        const msg = (err as { name?: string })?.name ?? 'unknown error';
        this.logger.warn(
          `⚠️ Bucket "${bucket}" no accesible (${msg}). ` +
            'Verifica que MinIO esté corriendo y que los buckets existan.',
        );
      }
    }
  }

  /**
   * Sube un objeto al bucket. NO sobrescribe (lanza error si la key existe).
   * Devuelve la `key` (path lógico) que se debe persistir en BD para luego
   * generar URLs firmadas o borrar.
   */
  async upload(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ path: string }> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { path: key };
    } catch (err: unknown) {
      this.logger.error(`Error uploading to ${bucket}/${key}`, err);
      throw new BadRequestException('Error al subir el archivo');
    }
  }

  /**
   * Genera una URL firmada GET para descargar el objeto, válida por
   * `expiresIn` segundos (default 1h). El bucket es privado, así que esta
   * URL es la ÚNICA forma de acceder al archivo externamente.
   */
  async getSignedUrl(
    bucket: string,
    key: string,
    expiresIn = 3600,
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn },
      );
    } catch (err) {
      this.logger.error(`Error signing URL for ${bucket}/${key}`, err);
      throw new BadRequestException('Error al generar URL de descarga');
    }
  }

  /**
   * Borra el objeto. Idempotente: si la key no existe, no falla.
   * Recordatorio: el proyecto usa soft-delete en BD (`is_active = false`).
   * Esta función está disponible para rollbacks de subidas fallidas y para
   * limpiezas administrativas, pero NO se llama desde el flujo normal de
   * "eliminar evidencia" (eso solo soft-deletea la fila).
   */
  async remove(bucket: string, key: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (err: unknown) {
      // No relanzar: si era rollback de upload fallido, no queremos enmascarar
      // el error original.
      this.logger.warn(
        `Failed to remove ${bucket}/${key}: ${(err as Error).message}`,
      );
    }
  }
}
