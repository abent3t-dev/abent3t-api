# `src/integrations/` — Infraestructura de integraciones (Fase INT-1)

Capa transversal que reutilizarán los clientes específicos de **Maximo** (Int-2) y
**SAP Business One** (Int-4). Contiene el esqueleto del módulo y un cliente HTTP
resiliente y testeable. No contiene lógica de negocio, mappers ni sincronización.

## Reglas inviolables

1. **SOLO LECTURA.** Las integraciones con Maximo y SAP son GET-only por compromiso
   contractual. `IntegrationHttpClient` expone únicamente `get()`; no existe ningún
   método de escritura, ni público ni privado (los helpers son funciones de módulo).
   Un test verifica que el prototipo público es exactamente `['constructor', 'get']`.
2. **Secretos solo por env vars.** Nunca tokens ni credenciales en código, fixtures,
   logs ni tests. El logger redacta headers de autenticación (`MAXAUTH`, `Cookie`,
   `Set-Cookie`, `Authorization`, `apikey`, y cualquier nombre que contenga `auth`,
   `token`, `secret`, `session`, …) y query params con credenciales (`_lid`, `_lpwd`,
   `token`, `password`, …). En `debug` solo se emiten NOMBRES de headers. Nunca se
   loguean cuerpos. Los errores exponen la URL saneada y un `cause` depurado (nunca
   el objeto original de `fetch`, que puede contener la URL cruda o el valor de un
   header). El estado del cliente vive en campos `#privados`: `JSON.stringify` /
   `util.inspect` del cliente no revelan los headers.
3. **El dominio de Compras no conoce Maximo/SAP.** Nada en `requisitions/`,
   `approvals/`, `purchase-orders/` ni `suppliers/` importa desde `integrations/`.
   La dirección futura es: `integrations → staging en BD ← dominio`.
4. **Cero llamadas de red en tests.** Se inyecta `fetchImpl` (y `sleep`/`random`/
   `logger`) por configuración; ningún test usa el `fetch` global.

## Cómo instanciar el cliente

Ejemplo para un submódulo ubicado en `src/integrations/maximo/` (Int-2):

```ts
// src/integrations/maximo/maximo.module.ts
import { IntegrationsModule } from '../integrations.module';

@Module({ imports: [IntegrationsModule], providers: [MaximoClient] })
export class MaximoModule {}

// src/integrations/maximo/maximo.client.ts
import {
  IntegrationHttpClientFactory,
  IntegrationHttpClient,
} from '../common';

@Injectable()
export class MaximoClient {
  private readonly http: IntegrationHttpClient;

  constructor(factory: IntegrationHttpClientFactory, config: ConfigService) {
    this.http = factory.create({
      system: 'maximo',
      baseUrl: config.getOrThrow('MAXIMO_BASE_URL'), // absoluta, http(s)
      timeoutMs: 60_000,
      maxRetries: 3,
      retryBaseDelayMs: 500,
      retryMaxDelayMs: 10_000,
      defaultHeaders: { MAXAUTH: config.getOrThrow('MAXIMO_AUTH_TOKEN') },
    });
  }

  async listPurchaseOrders() {
    const res = await this.http.get<MaximoEnvelope>('AB_COMPRAS', {
      query: { _format: 'json', _maxItems: 100, _rsStart: 0 },
    });
    // res.data, res.status, res.headers, res.setCookie, res.url (saneada),
    // res.durationMs, res.attempts
    return res.data;
  }
}
```

Defaults: `timeoutMs` 30 000, `maxRetries` 3 (= 4 intentos), `retryBaseDelayMs` 500,
`retryMaxDelayMs` 10 000. El constructor valida que `baseUrl` sea absoluta http(s),
que los números sean finitos y que ningún header contenga CR/LF/NUL (el mensaje de
error solo nombra el header, nunca su valor).

`get<T>(path, options?)`:

| Opción      | Descripción                                                                 |
|-------------|-----------------------------------------------------------------------------|
| `query`     | Query params; `null`/`undefined` se omiten.                                 |
| `headers`   | Headers adicionales para esta llamada (se mezclan sobre `defaultHeaders`).  |
| `timeoutMs` | Sobreescribe el timeout por intento de esta llamada.                        |
| `parseAs`   | `'json'` (default) o `'text'` (p. ej. XML crudo).                           |

- `path` debe ser **relativo** a `baseUrl`; las URLs absolutas se rechazan.
- Las redirecciones no se siguen (`redirect: 'manual'`): un 3xx llega como
  `IntegrationRequestError` con su `status`, para que ningún header de autenticación
  viaje a un host distinto sin que nadie lo decida.
- Con `parseAs: 'json'`, un cuerpo vacío (204, 200 sin contenido) devuelve
  `data: undefined`; un cuerpo no vacío que no sea JSON lanza
  `IntegrationRequestError` (status 2xx, cuerpo truncado).
- El timeout cubre cabeceras **y** lectura completa del cuerpo.

## Comportamiento ante fallos

| Situación                                              | Reintenta | Error final                 |
|--------------------------------------------------------|-----------|-----------------------------|
| Error de red (ECONNRESET, ENOTFOUND, corte leyendo el cuerpo, …) | Sí | `IntegrationNetworkError`   |
| Timeout por intento (cabeceras o cuerpo)               | Sí        | `IntegrationTimeoutError`   |
| 5xx                                                    | Sí        | `IntegrationServerError`    |
| 429 (respeta `Retry-After`, acotado por `retryMaxDelayMs`) | Sí    | `IntegrationRequestError`   |
| 401 / 403                                              | **No**    | `IntegrationAuthError`      |
| 4xx restantes, 3xx (`redirect: 'manual'`)              | **No**    | `IntegrationRequestError`   |
| 2xx con cuerpo no vacío que no es JSON (`parseAs: 'json'`) | **No** | `IntegrationRequestError`   |
| URL o header inválidos detectados por `fetch`          | **No**    | `IntegrationNetworkError`   |

Reintentos: backoff exponencial con jitter — se acota `retryBaseDelayMs · 2^(intento-1)`
a `retryMaxDelayMs` y luego se aplica mitad fija + mitad aleatoria, así el jitter
sobrevive al tope. `maxRetries` son reintentos *adicionales* al primer intento.

Todos los errores extienden `IntegrationError` y exponen `system`, `url` (saneada),
`attempt` y `cause` (copia depurada: nombre, `code` y mensaje sin URL cruda ni
secretos). Los de HTTP añaden `status`; `IntegrationAuthError`,
`IntegrationRequestError` e `IntegrationServerError` añaden `body` truncado a 500
caracteres; `IntegrationTimeoutError` añade `timeoutMs`; `IntegrationNetworkError`
añade `code`.

## Logging

Una línea por intento vía `Logger` de Nest con contexto `Integration:<system>`:
`GET <url saneada> status=<n> <ms>ms attempt=<i>/<n> [detail=…] [retry_in=…ms]`.
La duración incluye la lectura del cuerpo. Éxito → `log`, reintento → `warn`,
fallo definitivo → `error`. En `debug` se emite `headers=[NOMBRE, …]` (solo nombres).

## Staging y sync de Maximo (Fase INT-3)

Lo que `MaximoClient` lee se persiste en PostgreSQL (`prisma/sql/0005_maximo_staging.sql`):

| Tabla | Qué guarda |
|---|---|
| `maximo_purchase_orders` | Staging AB_COMPRAS, una fila por revisión. Clave natural `(ponum, siteid, revisionnum)` |
| `maximo_contracts` | Staging AB_CONTRATOS, una fila por revisión de PURCHVIEW (T3). Clave `(prnum, contractnum, revisionnum)` |
| `maximo_sync_runs` | Bitácora de corridas (`cron` \| `manual` \| `seed`) con contadores y `filter_warnings` |

Cada fila conserva el registro **crudo original** en `raw` JSONB + `mapper_version`:
`npm run maximo:remap` re-deriva las columnas mapeadas sin re-descargar (así se
aplicarán las confirmaciones de Isaac §20.A.2/7). Detección de cambios por
`rowstamp` (PO) / `contract_rowstamp` (contrato); sin cambio solo se toca
`last_seen_at`.

**Ciclo de vida de una corrida** (`MaximoSyncService`): fila `running` →
full scan paginado legacy (`_maxItems`/`_rsStart`, `MAXIMO_SYNC_PAGE_SIZE`) →
upsert idempotente por página (fallo de página se registra y la corrida sigue)
→ `success` | `partial` | `failed` + contadores. Mutex in-memory por target;
`MAXIMO_SYNC_ENABLED=false` apaga cron (no se registra) y disparo manual (503)
sin tocar la red.

**Endpoints** (`/api/integrations/maximo`, roles PURCHASE_ADMINS; `status`
también `executive`):

```
POST /integrations/maximo/sync    body { target?: purchase_orders|contracts|all }
                                  → 202 {runs:[{target,run_id}],skipped} · 409 corrida en curso · 503 flag apagado
GET  /integrations/maximo/status  → { enabled, contractsEnabled, intervalMinutes, pageSize,
                                      running[], lastRuns{...}, counts{...} }
GET  /integrations/maximo/runs    ?target=&page=&limit= → historial paginado
```

**Seed de desarrollo (T5):** `npm run maximo:seed-fixtures` llena staging desde
los fixtures sanitizados por el MISMO camino de upsert (corridas
`triggered_by='seed'`; idempotente; aborta con `NODE_ENV=production`).
`npm run maximo:seed-clear` lo retira.

**Plan de activación en producción** (actualizado 2026-09-21; prerequisitos
YA CUMPLIDOS: credenciales prod del correo de Isaac 3-ago probadas el
2026-09-21 — HTTP 200, AB_COMPRAS con 5,001 POs —; egress `maxapp:9080` desde
el Servidor A confirmado el 2026-09-17; §20.2 resuelta:
CONTRACTVALUE=TOTALCOST y CONTRACTREFNUM=CONTRACTNUM ya en el mapper
`2026.09.21-1`):

1. En `.env.prod` del Servidor A (los valores viven en el correo de Isaac del
   3-ago / gestor de secretos — NUNCA aquí):
   - `MAXIMO_BASE_URL` → REST legacy, termina en `/maxrest/rest/os`.
   - `MAXIMO_OSLC_URL` → mismo host, termina en `/maximo/oslc/os`. El full
     scan NO la usa (es legacy), pero Joi la exige con el sync prendido; se
     usa solo en consultas puntuales por rango/prnum.
   - `MAXIMO_AUTH_TOKEN` → el token del header `MAXAUTH` (Base64), tal cual.
   - `MAXIMO_CONTRACTS_ENABLED=true` (default false: sin esto la corrida de
     contratos falla con `MaximoContractsDisabledError`).
   - `MAXIMO_SYNC_ENABLED=true` (con true, Joi exige las 3 primeras — el boot
     falla temprano si falta alguna, a propósito).
   - Opcionales: `MAXIMO_SYNC_INTERVAL_MINUTES` (default 60),
     `MAXIMO_SYNC_PAGE_SIZE` (default 100).
2. `git pull` + rebuild + recreate del contenedor de la API (patrón SAP del
   18-sep; NO hay migraciones nuevas — el staging `0005` ya está en prod).
3. Disparo manual: `POST /integrations/maximo/sync {"target":"all"}` (202).
   Con 5,001 POs a 100 por página son ~51 páginas; esperar unos minutos.
4. Verificar `GET /integrations/maximo/status` → corridas `success` y counts
   poblados; `GET /maximo/summary` → totales por estatus; pestañas "Ordenes
   Maximo" (en /compras/ordenes) y "Contratos Maximo" (en /compras/contratos)
   con datos paginados.
5. Dejar correr el cron (cada `MAXIMO_SYNC_INTERVAL_MINUTES`).
6. **Esperado, no error:** Ahorro / Clasificación / Tipo compra (AB_AHORRO /
   AB_CLASFPO / AB_TIPOCOMP) y MAXVOL salen como **"No disponible"** — la
   Object Structure aún no expone esos campos (ajuste de definición pendiente
   con CIISA, validado 13-ago). Cuando CIISA los exponga: el siguiente sync
   los trae y la UI los pinta sin cambios de código (las filas ya
   sincronizadas se refrescan por `rowstamp`, o en bloque con
   `npm run maximo:remap`).
7. Si el staging de prod ya tuviera filas de una corrida previa al mapper
   `2026.09.21-1`, correr `npm run maximo:remap` una vez para re-derivar
   `contract_value`/`contract_ref_num` sin re-descargar.

## Consumo desde dominio (Fase INT-5)

La lectura de staging para la intranet vive en `src/maximo-records/`
(módulo de dominio, `GET /maximo/*`): listados con "vista actual" (mayor
`revisionnum` por clave natural vía `DISTINCT ON`), detalle con líneas e
historial derivados del `raw`, y `GET /maximo/summary` para el dashboard.
Ese módulo NO importa nada de esta carpeta y NUNCA escribe staging — el
único escritor sigue siendo `MaximoStagingService`. El frontend consume
además los endpoints de esta capa (`/integrations/maximo/*`) tal cual desde
`/compras/integraciones` (estado, corridas y disparo manual).

## Cliente, staging y sync de SAP (Fase INT-4)

`src/integrations/sap/` espeja el stack de Maximo contra el **Service Layer de
SAP B1** (OData, `SL_BASE_URL`). Piezas:

- **`sap-transport.ts`** — transporte sobre `node:https` (permite
  `SL_REJECT_UNAUTHORIZED=false` POR CONEXIÓN, solo fuera de producción;
  jamás se toca `NODE_TLS_REJECT_UNAUTHORIZED` global). Expone el `FetchLike`
  GET-only para Int-1 y **`postSapLogin` — el ÚNICO POST de toda la capa
  (decisión T2)**: el path `/Login` es una constante interna, no existe
  parámetro de path, así que es estructuralmente imposible escribir a SAP.
- **`SapSessionManager`** — cachea las cookies `B1SESSION`/`ROUTEID` (30 min),
  renueva con margen de 5 min, colapsa logins concurrentes; `invalidate()` +
  reintento único ante 401 en un GET.
- **`SapClient`** — GETs vía `IntegrationHttpClient`: `PurchaseOrders` y
  `PurchaseRequests` con `$select` (validado en vivo 2026-09-17: `$expand`
  da 400; las líneas llegan completas ~32 KB/doc), paginación
  `$orderby=DocEntry` + `$top/$skip`, `/$count`, incremental
  `$filter=UpdateDate ge YYYY-MM-DD`. `PurchaseRequests` no permite proyectar
  CardCode/CardName/DocTotal → usa `Requester*` y suma de `LineTotal`.
- **Mapper** — normaliza los 3 UDF de línea (`U_Clas_gts`, `U_Imp_ahorro`,
  `U_Proc_Comp`): el placeholder `"SELECCIONAR"`/vacío/null = SIN DATO →
  `null` (T10: el ahorro jamás se inventa como 0). `sapRawHash` (sha256) para
  detección de cambios — `UpdateDate` tiene granularidad de día.

Staging (`prisma/sql/0009_sap_staging.sql`): `sap_purchase_orders` y
`sap_purchase_requests` (una fila por `DocEntry`; SAP no tiene revisiones,
el cambio se detecta por `raw_hash`) + `sap_sync_runs` (con `mode`
full/incremental y `since_filter`). Sin seed: no hay fixtures de SAP.

**Endpoints** (`/integrations/sap`, roles PURCHASE_ADMINS; `status` también
`executive`):

```
POST /integrations/sap/sync    body { target?: purchase_orders|purchase_requests|all,
                                      mode?: full|incremental }   (default: incremental si hay datos)
                               → 202 {runs:[{target,run_id}]} · 409 corrida en curso · 503 flag apagado
GET  /integrations/sap/status  → { enabled, intervalMinutes, pageSize, running[], lastRuns{}, counts{} }
GET  /integrations/sap/runs    ?target=&page=&limit= → historial paginado
```

**Proveedores (BusinessPartners)** — tercer target del mismo sync
(`business_partners`, migración `0010`): staging `sap_business_partners`
(una fila por `CardCode`, filtro `CardType eq 'cSupplier'`; en PRD son 873).
El **espejo al catálogo del dominio** (`suppliers`) NO lo hace esta capa:
vive en `src/suppliers/supplier-sap-mirror.service.ts` (cron horario min 45 +
`POST /suppliers/sap-mirror`), escribe SOLO los básicos (nombre, RFC, email,
teléfono, contacto, moneda, flags informativos sap_valid/sap_frozen) con
`source='sap'` + `external_id=CardCode`, y JAMÁS toca puntuación/bloqueo/
is_active de ABENT. `tax_id` es UNIQUE y en SAP hay RFC repetidos (43 con el
genérico XEXX010101000): cascada RFC → "RFC-CardCode" → CardCode.

El dominio lee staging desde `src/sap-records/` (`GET /sap/purchase-orders`,
`/sap/purchase-requests`, detalle por `:docEntry` con líneas derivadas del
`raw`, y `/sap/summary` para el dashboard). Ese módulo no importa nada de
esta carpeta.

**Plan de activación en producción (Servidor A)** — validado E2E contra
`PRD_ABENT` el 2026-09-17 (3,359 OC + 309 PR, full en 83 s, 0 fallos):

1. Aplicar la migración `prisma/sql/0009_sap_staging.sql` en la BD de prod (Servidor B).
2. Env del servidor: `SL_BASE_URL`, `SL_COMPANY_DB=PRD_ABENT`, `SL_USER`, `SL_PASSWORD`.
3. **`SL_REJECT_UNAUTHORIZED=true` (obligatorio: Joi no arranca con false en prod).**
   Si el cert del Service Layer no valida contra CAs públicas: exportar la cadena y
   arrancar la API con `NODE_EXTRA_CA_CERTS=/ruta/sap-ca.pem` (no relajar TLS).
4. `SAP_SYNC_ENABLED=true` (+ opcionales `SAP_SYNC_INTERVAL_MINUTES=60`,
   `SAP_SYNC_PAGE_SIZE=20`). Rebuild/redeploy de la imagen API.
5. Primera corrida manual: `POST /integrations/sap/sync {"mode":"full"}` (~2 min).
6. Verificar `GET /integrations/sap/status` (corridas `success`, counts ≈ 3.4k/0.3k)
   y el dashboard de Compras (tarjeta SAP y pestañas Ordenes/Solicitudes SAP).
7. Dejar el cron (incremental cada hora). Nada de esto escribe hacia SAP.

**Cola de autorización (ApprovalRequests)** — cuarto target del sync
(`approval_requests`, migración `0011`, sprint 2026-09-22 B5): staging
`sap_approval_requests`, una fila por `Code`. `ApprovalRequests` NO expone
`UpdateDate`, así que la corrida es SIEMPRE full (548 filas: barato) y
`raw` = `{ request, draft }` para que el hash detecte cambios en cualquiera
de los dos. Al inicio de cada corrida se cargan 4 catálogos completos
(`Drafts` con `$select` sin líneas, `Users`, `ApprovalStages`,
`ApprovalTemplates`, todos tolerantes al server-cap de `$top`) para
enriquecer nombres de solicitante/aprobador/etapa/plantilla y los datos del
borrador. Los aprobadores se persisten en `approvers` (jsonb, snake_case).
Se lee en `GET /sap/approval-requests` (pestaña "Pendientes de autorización
(SAP)" en /compras/aprobaciones) y alimenta los tiempos de aprobación SAP de
`GET /compras/reportes/tiempos-aprobacion`. `target: all` NO lo incluye
(el cron sí, en cada tick); disparo manual: `{"target":"approval_requests"}`.

**Campos de cancelación (A6, migración `0011`):** `Cancelled`,
`CancelStatus`, `AuthorizationStatus`, `Confirmed` y `ClosingDate` entran al
`$select` de OC y solicitudes (mapper `1.1.0`). SAP reporta una cancelada
como `bost_Close` + `Cancelled=tYES`, por eso el dominio deriva el estatus
(`status_key`: open | close | cancelled). Tras desplegar `0011` hay que
correr un **re-sync `mode:'full'`** de `purchase_orders` y
`purchase_requests` para poblar las columnas en lo ya sincronizado (el raw
cambia → todas las filas se actualizan; ~2.5 min las OC en dev).

**Bloque 2026-09-23 (check-in Ingrid, migración `0013`):** una sola
migración `prisma/sql/0013_bloque_2026-09-23.sql` (tabla `erp_user_aliases`
para las equivalencias usuario SAP/Maximo → nombre; `maximo_contracts.pr_total`
y `.consumed_value`; índice parcial sobre `sap_purchase_orders.maximo_ponum`).
Mapper de Maximo `2026.09.23-1`: en filas SIN contrato el estatus se toma de
la raíz PR si la OS lo expone (`PR.STATUS`/`PRSTATUS`), `pr_total` de
`PR.TOTALCOST`/`PRCOST`/suma de `PRLINE.LINECOST`, y `consumed_value` de la
primera llave presente entre `RELEASEDTOTAL`, `RELEASEDCOST`, `TOTALRELEASED`,
`COMMITTED`, `COMMITTEDTOTAL`, `INVOICEDTOTAL`, `TOTALINVOICED`. **Hoy
AB_CONTRATOS no expone ninguna** (la PR llega solo con PRNUM/SITEID/REQUESTEDBY,
fixture `ab-contratos.legacy-nested.no-contract.json`): esos campos salen
"No disponible" y van a la lista de CIISA junto con `AB_*`/`MAXVOL`/`WAPPR`;
cuando CIISA los exponga, `maximo:remap` (o el siguiente sync, por rowstamp)
los pinta sin tocar código. Para desplegar: migración `0013` en B → pull +
rebuild api/next → `npm run maximo:remap` dentro del contenedor del api
(target `contracts`; el de OC no cambia) → sin re-sync de SAP (D1 usa
`maximo_ponum`, ya poblado por el mapper 1.2.0). Regla D1 en
`src/common/sql/erp-views.sql.ts`: una OC de SAP con `maximo_ponum` que
existe en `maximo_purchase_orders` se cuenta una sola vez (se descuenta del
lado SAP) en dashboard, reportes y expeditación; `/sap/summary` sigue con el
total propio y expone `migradas`.

## Qué NO hacer

- Agregar cualquier operación de escritura al cliente genérico ("ni solo para
  login" — el login de SAP vive aislado en `sap-transport.ts` con path
  constante, T2; no replicar ese patrón para nada más).
- Importar `integrations/` desde el dominio de Compras.
- Leer `MAXIMO_*` / `SL_*` desde este módulo (corresponde a los submódulos).
- Loguear `res.headers` / `res.setCookie` (pueden traer cookies) ni cuerpos de respuesta.
- Hacer llamadas de red reales en tests.
