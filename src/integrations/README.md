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

**Checklist de activación en producción** (en orden; hoy TODO apagado):

1. OS cerradas con Isaac/CIISA (§20.A.2/7/9: CONTRACTREFNUM/CONTRACTVALUE, APPR1..4, smoke OSLC en prod).
2. Salida NSG a `maxapp:9080` autorizada con César.
3. `MAXIMO_BASE_URL`, `MAXIMO_OSLC_URL`, `MAXIMO_AUTH_TOKEN` en env del servidor.
4. `MAXIMO_SYNC_ENABLED=true` (reinicio).
5. Disparo manual `POST /integrations/maximo/sync {"target":"purchase_orders"}`.
6. Verificar `GET /integrations/maximo/status` (corrida `success`, counts creciendo).
7. Dejar correr el cron (`MAXIMO_SYNC_INTERVAL_MINUTES`, default 60).
8. Contratos después, con `MAXIMO_CONTRACTS_ENABLED=true` (tras cerrar §20.A.2).

## Consumo desde dominio (Fase INT-5)

La lectura de staging para la intranet vive en `src/maximo-records/`
(módulo de dominio, `GET /maximo/*`): listados con "vista actual" (mayor
`revisionnum` por clave natural vía `DISTINCT ON`), detalle con líneas e
historial derivados del `raw`, y `GET /maximo/summary` para el dashboard.
Ese módulo NO importa nada de esta carpeta y NUNCA escribe staging — el
único escritor sigue siendo `MaximoStagingService`. El frontend consume
además los endpoints de esta capa (`/integrations/maximo/*`) tal cual desde
`/compras/integraciones` (estado, corridas y disparo manual).

## Qué NO hacer

- Agregar cualquier operación de escritura al cliente (ni "solo para login").
- Importar `integrations/` desde el dominio de Compras.
- Leer `MAXIMO_*` / `SL_*` desde este módulo (corresponde a los submódulos).
- Loguear `res.headers` / `res.setCookie` (pueden traer cookies) ni cuerpos de respuesta.
- Hacer llamadas de red reales en tests.
