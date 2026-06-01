// scripts/migrate-storage.mjs
//
// Migra TODOS los archivos del Supabase Storage (buckets `evidences` y
// `proposal-attachments`) al MinIO local. Idempotente: si el objeto ya
// existe en MinIO con el mismo key, NO lo sobrescribe.
//
// Requisitos:
//   * MinIO corriendo (docker-compose up -d) en MINIO_ENDPOINT:MINIO_PORT.
//   * .env con MIGRATION_SUPABASE_URL y MIGRATION_SUPABASE_SERVICE_ROLE_KEY.
//   * MINIO_* configuradas.
//
// Uso:
//   node scripts/migrate-storage.mjs
//
// Cuando termine, comparar los conteos contra la BD:
//   - enrollment_evidences (1 esperado en dev)
//   - proposal_attachments (2 esperados en dev)
// Si todo cuadra, ELIMINAR las vars MIGRATION_SUPABASE_* del .env.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, '..');

// ---- Leer .env --------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(resolve(API_ROOT, '.env'), 'utf-8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const SUPABASE_URL = env.MIGRATION_SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_KEY =
  env.MIGRATION_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan MIGRATION_SUPABASE_URL / MIGRATION_SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const MINIO_ENDPOINT = env.MINIO_ENDPOINT || '127.0.0.1';
const MINIO_PORT = env.MINIO_PORT || '9000';
const MINIO_USE_SSL = (env.MINIO_USE_SSL || '').toLowerCase() === 'true';
const MINIO_ACCESS_KEY = env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = env.MINIO_SECRET_KEY || 'minioadmin';

const s3 = new S3Client({
  endpoint: `${MINIO_USE_SSL ? 'https' : 'http'}://${MINIO_ENDPOINT}:${MINIO_PORT}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

// Buckets a migrar: source Supabase → target MinIO (mismo nombre).
const BUCKETS = [
  { source: 'evidences', target: env.MINIO_BUCKET_EVIDENCES || 'evidences' },
  {
    source: 'proposal-attachments',
    target: env.MINIO_BUCKET_PROPOSALS || 'proposal-attachments',
  },
];

// ---- Supabase Storage REST helpers -----------------------------------------
async function listSupabaseObjects(bucket, prefix = '') {
  // POST /storage/v1/object/list/<bucket>
  const url = `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(bucket)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });
  if (!res.ok) {
    throw new Error(`Supabase list ${bucket}: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function downloadSupabaseObject(bucket, key) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${key}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(
      `Download ${bucket}/${key}: HTTP ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType };
}

async function objectExistsInMinio(bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToMinio(bucket, key, buffer, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

/**
 * Recorre recursivamente un bucket de Supabase Storage. Supabase NO devuelve
 * objetos dentro de "subfolders" en una sola llamada — hay que iterar por
 * cada prefix. Para el shape `<uuid_enrollment>/<timestamp>_filename`,
 * primero listamos prefixes raíz y luego descendemos.
 */
async function walkSupabaseBucket(bucket, prefix = '', out = []) {
  const items = await listSupabaseObjects(bucket, prefix);
  for (const item of items) {
    // Si tiene `id` y `metadata.size`, es un archivo. Si no, es un "folder".
    const fullKey = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id && item.metadata?.size !== undefined) {
      out.push({ key: fullKey, size: item.metadata.size });
    } else {
      // folder — recursive
      await walkSupabaseBucket(bucket, fullKey, out);
    }
  }
  return out;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  let totalCopied = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { source, target } of BUCKETS) {
    console.log(`\n=== Bucket: ${source} → ${target} ===`);
    let objects;
    try {
      objects = await walkSupabaseBucket(source);
    } catch (err) {
      console.error(`❌ No se pudo listar bucket ${source}:`, err.message);
      continue;
    }

    if (objects.length === 0) {
      console.log('  (vacío en Supabase)');
      continue;
    }

    console.log(`  ${objects.length} objetos encontrados.`);

    for (const obj of objects) {
      try {
        if (await objectExistsInMinio(target, obj.key)) {
          console.log(`  ⏭  ya existe en MinIO: ${obj.key}`);
          totalSkipped++;
          continue;
        }
        const { buffer, contentType } = await downloadSupabaseObject(
          source,
          obj.key,
        );
        await uploadToMinio(target, obj.key, buffer, contentType);
        console.log(
          `  ✓ ${obj.key} (${obj.size} bytes, ${contentType})`,
        );
        totalCopied++;
      } catch (err) {
        console.error(`  ❌ ${obj.key}: ${err.message}`);
        totalFailed++;
      }
    }
  }

  console.log(
    `\n📊 Resumen: ${totalCopied} copiados, ${totalSkipped} ya existían, ${totalFailed} fallidos.`,
  );
  if (totalFailed === 0) {
    console.log(
      '✅ Migración completa. Puedes eliminar MIGRATION_SUPABASE_* del .env.',
    );
  } else {
    console.log(
      '⚠️ Revisa los fallos arriba. NO elimines MIGRATION_SUPABASE_* hasta resolverlos.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
