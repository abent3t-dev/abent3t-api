// scripts/smoke-sap-b1.mjs
//
// Smoke test READ-ONLY del SAP Business One Service Layer (ABENT 3T).
// Hace Login → GET PurchaseOrders → GET PurchaseRequests → Logout, validando
// que los 3 UDF de línea (U_Clas_gts, U_Imp_ahorro, U_Proc_Comp) sean
// legibles. No escribe NADA en SAP.
//
// Requisitos:
//   * Node 20+ (usa fetch global + headers.getSetCookie + undici).
//   * .env con SL_BASE_URL, SL_COMPANY_DB, SL_USER, SL_PASSWORD.
//   * Para TEST con cert TLS propio: SL_REJECT_UNAUTHORIZED=false
//     (queda documentado como riesgo; en PROD debe ser true).
//
// Uso:
//   node scripts/smoke-sap-b1.mjs
//
// Salida: reporta status, sesión, tabla de líneas con UDF, y un checklist
// final con los pasos validados.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SL_BASE_URL = env.SL_BASE_URL;
const SL_COMPANY_DB = env.SL_COMPANY_DB;
const SL_USER = env.SL_USER;
const SL_PASSWORD = env.SL_PASSWORD;
const SL_REJECT_UNAUTHORIZED =
  (env.SL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';

if (!SL_BASE_URL || !SL_COMPANY_DB || !SL_USER || !SL_PASSWORD) {
  console.error(
    '❌ Faltan variables. Requeridas en .env: SL_BASE_URL, SL_COMPANY_DB, SL_USER, SL_PASSWORD.',
  );
  process.exit(1);
}

// ---- TLS: aviso explícito si saltamos verificación --------------------------
// Nota: usamos NODE_TLS_REJECT_UNAUTHORIZED para no añadir `undici` como dep
// solo para este smoke test. Afecta a TODO el proceso pero el script es
// efímero (corre y termina). En PROD: SL_REJECT_UNAUTHORIZED=true (o instalar
// el CA del Service Layer en el trust store del servidor App).
if (!SL_REJECT_UNAUTHORIZED) {
  console.warn(
    '⚠️  SL_REJECT_UNAUTHORIZED=false → se ignora la validación del certificado del Service Layer.\n' +
      '    Esto es aceptable SOLO en TEST con cert propio. En PROD debe ser true.',
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ---- UDF a validar (nivel línea: POR1 / PRQ1) ------------------------------
const UDF_FIELDS = ['U_Clas_gts', 'U_Imp_ahorro', 'U_Proc_Comp'];

// Campos de línea que pedimos en el $expand. Incluimos los UDF + algunos
// "anchors" para que la respuesta tenga sentido al imprimir.
const LINE_SELECT = ['LineNum', 'ItemCode', 'ItemDescription', ...UDF_FIELDS].join(',');
const HEADER_SELECT = 'DocEntry,DocNum,CardName,DocTotal,DocDate';

// ---- Estado del checklist ---------------------------------------------------
const checks = {
  loginOk: false,
  sessionReused: false,
  poResponds: false,
  prResponds: false,
  udfClasCompReadable: false,
  udfImptAhorroReadable: false,
  udfProcCompReadable: false,
  logoutOk: false,
};
const notes = [];

// ---- Cookie jar simple (B1SESSION + ROUTEID) -------------------------------
let cookieJar = '';

function rememberCookies(res) {
  // Node 20+: getSetCookie() devuelve string[] con todos los Set-Cookie.
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
  const pairs = setCookies
    .map((c) => c.split(';')[0].trim()) // descarta Path=, HttpOnly, etc.
    .filter(Boolean);
  if (pairs.length) {
    cookieJar = pairs.join('; ');
  }
  return pairs;
}

function authHeaders() {
  return cookieJar ? { Cookie: cookieJar } : {};
}

// ---- HTTP helpers -----------------------------------------------------------
async function postLogin() {
  const url = `${SL_BASE_URL}/Login`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CompanyDB: SL_COMPANY_DB,
        UserName: SL_USER,
        Password: SL_PASSWORD,
      }),
    });
  } catch (err) {
    diagnoseNetworkError(err, url);
    throw err;
  }
  const ms = Date.now() - t0;

  if (res.status !== 200) {
    const body = await safeText(res);
    if (res.status === 401) {
      throw new Error(
        `Login 401 (credenciales inválidas para ${SL_USER}@${SL_COMPANY_DB}). Body: ${body}`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Login 404 — revisa SL_BASE_URL (${SL_BASE_URL}). Body: ${body}`,
      );
    }
    throw new Error(`Login HTTP ${res.status}. Body: ${body}`);
  }

  const cookies = rememberCookies(res);
  const json = await res.json();

  const hasB1Session = cookies.some((c) => c.startsWith('B1SESSION='));
  const hasRouteId = cookies.some((c) => c.startsWith('ROUTEID='));

  console.log(`\n[1] Login → HTTP ${res.status} (${ms} ms)`);
  console.log(`    SessionId:        ${json.SessionId ?? '(no en body)'}`);
  console.log(`    SessionTimeout:   ${json.SessionTimeout ?? '?'} min`);
  console.log(`    Version:          ${json.Version ?? '?'}`);
  console.log(`    Cookies recibidas: B1SESSION=${hasB1Session} ROUTEID=${hasRouteId}`);

  if (!hasB1Session) {
    throw new Error(
      'Login OK pero NO llegó cookie B1SESSION; no se puede mantener sesión.',
    );
  }
  checks.loginOk = true;
}

async function getEntity(path, label) {
  const url = `${SL_BASE_URL}${path}`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Prefer: 'odata.maxpagesize=5',
        ...authHeaders(),
      },
    });
  } catch (err) {
    diagnoseNetworkError(err, url);
    throw err;
  }
  const ms = Date.now() - t0;

  if (res.status === 401) {
    throw new Error(
      `${label} HTTP 401 — la sesión no se reutilizó (cookie ausente o expirada).`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `${label} HTTP 404 — entidad inexistente o ruta mal escrita: ${path}`,
    );
  }
  if (res.status >= 400) {
    const body = await safeText(res);
    throw new Error(`${label} HTTP ${res.status}. Body: ${body}`);
  }

  // Si llegamos aquí con 2xx, la sesión SÍ se reutilizó.
  checks.sessionReused = true;

  const json = await res.json();
  console.log(`\n[${label}] GET ${path}`);
  console.log(`    HTTP ${res.status} (${ms} ms) — ${json.value?.length ?? 0} documentos`);
  return json.value ?? [];
}

async function postLogout() {
  const url = `${SL_BASE_URL}/Logout`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: authHeaders() });
  } catch (err) {
    diagnoseNetworkError(err, url);
    throw err;
  }
  // El Service Layer responde 204 No Content cuando logout exitoso.
  if (res.status === 204 || res.status === 200) {
    console.log(`\n[4] Logout → HTTP ${res.status} ✓`);
    checks.logoutOk = true;
    return;
  }
  console.warn(
    `\n[4] Logout devolvió HTTP ${res.status} (no crítico, sesión expira sola).`,
  );
}

// ---- Validación de UDF en líneas -------------------------------------------
function inspectDocuments(docs, entityLabel) {
  if (docs.length === 0) {
    notes.push(
      `${entityLabel}: sin documentos en TEST — no se pudo validar UDF con datos reales.`,
    );
    return;
  }

  // Estado por UDF: "presente con valor", "presente sin datos", "ausente".
  const udfState = Object.fromEntries(
    UDF_FIELDS.map((f) => [f, { present: false, withData: false }]),
  );

  const rows = [];
  for (const doc of docs) {
    const lines = doc.DocumentLines ?? [];
    for (const line of lines) {
      for (const f of UDF_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(line, f)) {
          udfState[f].present = true;
          if (line[f] !== null && line[f] !== '' && line[f] !== undefined) {
            udfState[f].withData = true;
          }
        }
      }
      rows.push({
        DocNum: doc.DocNum,
        CardName: truncate(doc.CardName ?? '', 28),
        Line: line.LineNum ?? '?',
        Item: truncate(line.ItemCode ?? '', 14),
        U_Clas_gts: fmt(line.U_Clas_gts),
        U_Imp_ahorro: fmt(line.U_Imp_ahorro),
        U_Proc_Comp: truncate(fmt(line.U_Proc_Comp), 28),
      });
    }
  }

  if (rows.length === 0) {
    notes.push(`${entityLabel}: los documentos no traen DocumentLines.`);
    return;
  }

  console.log(`    ${entityLabel} — líneas (primeras 10):`);
  console.table(rows.slice(0, 10));

  // Marcar el checklist con la regla del enunciado:
  // "campo presente pero sin datos" = legible (no error de conexión).
  for (const f of UDF_FIELDS) {
    const st = udfState[f];
    if (!st.present) {
      notes.push(
        `${entityLabel}.${f}: AUSENTE en DocumentLines (UDF no expuesto por el Service Layer o mal escrito).`,
      );
      continue;
    }
    if (!st.withData) {
      notes.push(
        `${entityLabel}.${f}: presente pero sin datos en TEST (no es error de conexión).`,
      );
    }
    if (f === 'U_Clas_gts') checks.udfClasCompReadable = true;
    if (f === 'U_Imp_ahorro') checks.udfImptAhorroReadable = true;
    if (f === 'U_Proc_Comp') checks.udfProcCompReadable = true;
  }
}

// ---- Utilidades -------------------------------------------------------------
function fmt(v) {
  if (v === null || v === undefined) return '(null)';
  if (v === '') return '(vacío)';
  return String(v);
}

function truncate(s, n) {
  if (s == null) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<sin body>';
  }
}

function diagnoseNetworkError(err, url) {
  const code = err?.cause?.code || err?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    console.error(
      `❌ DNS no resuelve el host de ${url}. ¿VPN abajo o SL_BASE_URL mal escrita?`,
    );
  } else if (code === 'ECONNREFUSED') {
    console.error(`❌ Conexión rechazada en ${url}. ¿Service Layer caído o puerto bloqueado?`);
  } else if (code === 'ETIMEDOUT') {
    console.error(`❌ Timeout conectando a ${url}. Posible firewall o VPN intermitente.`);
  } else if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    console.error(
      `❌ Cert TLS rechazado (${code}). En TEST poner SL_REJECT_UNAUTHORIZED=false; en PROD agregar el CA al trust store.`,
    );
  } else {
    console.error(`❌ Error de red contra ${url}: ${err?.message ?? err}`);
  }
}

// ---- Main -------------------------------------------------------------------
async function main() {
  console.log(`SAP B1 Service Layer smoke test`);
  console.log(`  Base URL : ${SL_BASE_URL}`);
  console.log(`  CompanyDB: ${SL_COMPANY_DB}`);
  console.log(`  Usuario  : ${SL_USER}`);

  await postLogin();

  // --- PurchaseOrders ---
  try {
    const poPath =
      `/PurchaseOrders` +
      `?$top=5&$orderby=DocEntry desc` +
      `&$select=${HEADER_SELECT}` +
      `&$expand=DocumentLines($select=${LINE_SELECT})`;
    const poDocs = await getEntity(poPath, 'PurchaseOrders');
    checks.poResponds = true;
    inspectDocuments(poDocs, 'PurchaseOrders');
  } catch (err) {
    console.error(err.message);
  }

  // --- PurchaseRequests (opcional) ---
  try {
    const prPath =
      `/PurchaseRequests` +
      `?$top=5&$orderby=DocEntry desc` +
      `&$select=${HEADER_SELECT}` +
      `&$expand=DocumentLines($select=${LINE_SELECT})`;
    const prDocs = await getEntity(prPath, 'PurchaseRequests');
    checks.prResponds = true;
    inspectDocuments(prDocs, 'PurchaseRequests');
  } catch (err) {
    // No bloqueante: PR es opcional según el enunciado.
    console.warn(`(PR) ${err.message}`);
  }

  await postLogout();

  // --- Checklist final ---
  console.log(`\n========== Checklist ==========`);
  const line = (ok, label) => `  [${ok ? 'x' : ' '}] ${label}`;
  console.log(line(checks.loginOk, 'Login OK'));
  console.log(line(checks.sessionReused, 'Sesión reutilizada en GET'));
  console.log(line(checks.poResponds, 'PurchaseOrders responde'));
  console.log(line(checks.udfClasCompReadable, 'U_Clas_gts legible'));
  console.log(line(checks.udfImptAhorroReadable, 'U_Imp_ahorro legible'));
  console.log(line(checks.udfProcCompReadable, 'U_Proc_Comp legible'));
  console.log(line(checks.prResponds, 'PurchaseRequests responde (opcional)'));
  console.log(line(checks.logoutOk, 'Logout OK'));

  if (notes.length) {
    console.log(`\nNotas:`);
    for (const n of notes) console.log(`  • ${n}`);
  }

  const mandatory = [
    checks.loginOk,
    checks.sessionReused,
    checks.poResponds,
    checks.udfClasCompReadable,
    checks.udfImptAhorroReadable,
    checks.udfProcCompReadable,
    checks.logoutOk,
  ];
  const allOk = mandatory.every(Boolean);
  console.log(
    `\n${allOk ? '✅ Integración SAP B1 read-only verificada.' : '⚠️  Hay pasos sin marcar; revisar arriba.'}`,
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ Error fatal:', err?.message ?? err);
  process.exit(1);
});
