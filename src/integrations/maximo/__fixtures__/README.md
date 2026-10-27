# Fixtures de Maximo (sanitizados)

Respuestas REALES capturadas en producción/test de IBM Maximo (validaciones del
2026-05-29, 2026-06-05 y 2026-08-13; evidencia completa en `maximo-validation/`
en la raíz del repo), **sanitizadas** y, en algunos casos, recortadas. Los usan
los tests (`*.spec.ts`) y el seed de desarrollo de Int-3
(`npm run maximo:seed-fixtures`, T5 — guard `NODE_ENV!=production` y no se
copian a `dist`); en producción nunca se leen. El seed no pisa datos reales:
si la OC o la PR de un fixture ya tiene filas de una corrida real, la salta
completa (`skipped`).

## Sanitización aplicada

- Sin headers de autenticación ni tokens (las capturas solo guardan el cuerpo).
- Datos personales de `PERSON` y usuarios: `DISPLAYNAME`/`FIRSTNAME`/`LASTNAME`
  → `Persona Demo N` / `NombreN` / `ApellidoN`; `PERSONID`, `REQUESTEDBY`,
  `PURCHASEAGENT`, `CHANGEBY`, `SUPERVISOR`, `DELEGATE` → `USRnnn` (mapa
  determinista; la cuenta de sistema `MAXADMIN` se conserva). Dentro de
  `PERSON` también se reemplazan los cuasi-identificadores: `TITLE` →
  `Puesto demo`, `PERSONUID` → 90NN, `STATUSDATE` → fecha fija dummy.
- Los `href` OSLC `http://childkey#<base64>` codifican claves como
  `PO/PERSON/<id>` (el `-` final sustituye al `=` de padding): se decodifican y
  re-codifican con los ids dummy, de modo que ningún identificador real
  sobreviva ni siquiera en base64 (verificado por test en `maximo.mapper.spec.ts`).
- Proveedores (`COMPANIES`): se conserva `NAME`/`COMPANY` (dato de negocio);
  `PHONE`/`CELLPHONE` → `0000000000`, `CONTACT` → `Contacto Demo`, RFC
  (`REGISTRATION1`/`NIFCOM`) → `XAXX010101000`, direcciones → `Direccion demo`.
- `MEMO` → `Comentario de prueba`. Cualquier valor con `@` → `demo@example.invalid`.
- Hostnames reales en `href`/`localref`/`*_collectionref` → `maximo.example:9080`.
- Se mantienen intactos: números de PO/PR/contrato, importes, fechas, estatus,
  `rowstamp`, departamentos y la ESTRUCTURA completa (incluidos campos omitidos).

Los `*.SYNTHETIC.json` no salen de una captura: se construyeron a mano con la
forma real y los mismos valores dummy (usuarios `USRnnn`, `Persona Demo N`,
notas `Comentario de prueba…`). Los del bloque K (2026-10-05) usan además
proveedores, artículos y descripciones de demo.

## Inventario

| Archivo | Origen | Forma | Caso que cubre |
|---|---|---|---|
| `ab-compras.legacy-nested.page.json` | `evidencia_maximo_v2_20260813_120445/s_pagina_a.json` | legacy anidado | Página con `rsStart/rsCount/rsTotal`; 2 POs históricos SIN campos `AB_*` |
| `ab-compras.legacy-nested.ponum-filter.json` | `…/s_filtro.json` | legacy anidado | Filtro `PONUM=` (1 PO, sin `rsTotal`) |
| `ab-compras.legacy-compact.po102249.json` | `resultados_v2/A_ab_compras_po102249.json` | legacy compacto | PO completa CON `AB_AHORRO`/`AB_TIPOCOMP`/`AB_CLASFPO` |
| `ab-compras.oslc.po102249.json` | `resultados_v2/C2_oslc_compras_ponum.json` | OSLC | El MISMO PO102249 vía OSLC (prueba de equivalencia legacy ≡ OSLC) |
| `ab-compras.oslc.range.json` | `resultados_v2/C1_oslc_compras_rango.json` (3 de 8) | OSLC | Rango `orderdate>= and <=` |
| `ab-compras.legacy-compact.range.json` | `resultados_v2/D_ab_compras_orderdate_gt_2026.json` (3 de 25) | legacy compacto | Comparte PO102239 con el rango OSLC; uno con `AB_*` |
| `ab-compras.legacy.empty.json` | `resultados/block6_18a_ponum_inexistente.json` | legacy | Conjunto vacío (`AB_COMPRASSet: {}`) |
| `ab-contratos.legacy-compact.pr102828.json` | `resultados_v2/B_ab_contratos_1091.json` | legacy compacto | PR CON contrato: PURCHVIEW + COMPANIES + CONTRACTSTATUS (DRAFT, APPR) + CONTRACTLINE + PERSON |
| `ab-contratos.oslc.pr102828.json` | `resultados_v2/C5_oslc_contratos_prnum.json` | OSLC | El MISMO PR102828 vía OSLC (`oslc.where=prnum=…`) |
| `ab-contratos.legacy-nested.no-contract.json` | `…/c1_contratos_muestra.json` (2 de 25) | legacy anidado | PR SIN contrato (solo cabecera + PERSON con `STATUS=INACTIVE`, trampa conocida) |
| `ab-contratos.legacy-compact.purchview-root.v1.json` | `resultados/ab_contratos_1040.json` | legacy compacto | Estructura PREVIA (raíz PURCHVIEW, con `MAXVOL`) |
| `ab-contratos.legacy-compact.wappr.SYNTHETIC.json` | construido a mano sobre PR102828 | legacy compacto | **SINTÉTICO**: historial DRAFT → WAPPR → APPR en la estructura ACTUAL raíz PR (donde WAPPR no aparece en la evidencia, 0/25; en la estructura previa sí existe — ver `purchview-root.v1`, rev 1: PNDREV → WAPPR). PR104531 no existe en la evidencia |
| `ab-compras.oslc.page.SYNTHETIC.json` | construido sobre C1 (2 miembros) | OSLC | **SINTÉTICO**: `responseInfo.nextPage`/`totalCount` (paginación OSLC NO validada en prod) |
| `ab-compras.legacy-nested.po5-linecost.SYNTHETIC.json` | construido a mano (bloque K, 2026-10-05) | legacy anidado | **SINTÉTICO** (K2/K6): PO104896, la OC que se busca en dev (copia en SAP: 6337, EUR). INPRG, `PO5`=PROCESADO, `RECEIPTS`=COMPLETE, EUR, `TOTALCOST` 1755.00 = Σ `POLINE.LINECOST` (OC exenta). `POLINE` llega en orden 3, 1, 2, con `RECEIVEDQTY`, `RECEIPTSCOMPLETE` y `PRNUM`: la línea 3 es de PR990007 (USR022) y las 1 y 2 de PR990001 (USR021), así que `prnum`/`requestedBy` deben salir de la línea 1. `POSTATUS` desordenado |
| `ab-compras.legacy-nested.rq-tc-contrato.SYNTHETIC.json` | construido a mano (bloque O, 2026-10-26) | legacy anidado | **SINTÉTICO** (O1/O3): lo que CIISA agregó el 26-oct. PO990101 (MXN) con dos `RFQSTATUS` en la raíz, desordenados (gana el de `RFQSTATUSSEQ` más alto, USR041); PO990102 (USD) con `RFQSTATUS` debajo de la línea y una `PERSON` de otra persona (sin nombre); PO990103 de contrato por `CONTRACTREFNUM` en la cabecera; PO990104 (EUR, `EXCHANGERATE` 1.19) con `CONTRACTREFNUM` vacío y `"~null~"` (no es de contrato); PO990105 de contrato por la línea; PO990106 con `RFQSTATUS` debajo de `RFQLINE` (hija de la cabecera; dos líneas de la misma RQ, gana el `RFQSTATUSSEQ` más alto, USR045), **que es la forma de prod** (diagnóstico del 26-oct: las 3,843 OC con RQ lo traen ahí y en ningún otro nivel). `EXCHANGERATE` contra el dólar en todas |
| `ab-contratos.legacy-nested.prstatus.SYNTHETIC.json` | construido a mano (bloque K, 2026-10-05) | legacy anidado | **SINTÉTICO** (K3): 7 PR con `STATUS`, `STATUSDATE`, `ISSUEDATE` y `TOTALCOST` en la raíz y `PRSTATUS` desordenado. Ver la tabla de abajo |
| `ab-contratos.legacy-compact.prstatus.SYNTHETIC.json` | el mismo contenido que el anterior | legacy compacto | **SINTÉTICO** (K3): par compacto del anidado; las dos formas dan los mismos DTO y el mismo `raw_hash` |
| `oslc.error.bmxaa8781e.json` | `resultados_v2/C3_oslc_contratos_contractrefnum.json` | OSLC | Error `BMXAA8781E` (propiedad inválida en `oslc.where`) |

Generador: script de sesión (no versionado) que aplica las reglas anteriores sobre
la evidencia. Al regenerar, volver a verificar:
1. `grep -ril "MAXAUTH\|Authorization" __fixtures__ --include=*.json` = vacío.
2. Búsqueda de `@` (emails) y de nombres/hosts reales = vacío.
3. Decodificar TODOS los `childkey#<base64>` (reemplazando `-` final por `=`) y
   confirmar que ningún segmento `PERSON/<id>` trae un id fuera de
   `USRnnn`/`MAXADMIN` — el test "sanidad de los fixtures" de
   `maximo.mapper.spec.ts` lo automatiza.
4. Usuarios (`PERSONID`, `REQUESTEDBY`, `PURCHASEAGENT`, `CHANGEBY`,
   `SUPERVISOR`, `DELEGATE`) en `USRnnn`/`MAXADMIN`, `DISPLAYNAME` en
   `Persona Demo N` y `MEMO` en `Comentario de prueba…`, en las tres formas —
   también lo automatiza "sanidad de los fixtures".

### PR de los fixtures `prstatus` (K3)

Los PRNUM `PR9900nn` no existen en la evidencia ni en dev. Usuarios `USR021`–`USR031`
y notas `Comentario de prueba: …`, todos ficticios.

| PRNUM | STATUS | Historial (`PRSTATUS`, ordenado) | Caso |
|---|---|---|---|
| PR990001 | CLOSE | WAPPR → APPR → CLOSE | WAPPR y APPR en el mismo segundo (desempata `PRSTATUSID`; llegan al revés). La usan las líneas 1 y 2 de PO104896 |
| PR990002 | APPR | WAPPR → APPR → WAPPR → APPR | Regresa a aprobación y se re-aprueba: `pr_approved_at` = la PRIMERA APPR. Sin contrato y sin OC: la **única** pendiente de gestionar (smoke de K4) |
| PR990003 | CAN | WAPPR → APPR → CAN | `MEMO` en la CAN: `pr_cancelled_at` / `pr_cancelled_by` de esa fila |
| PR990004 | CAN | WAPPR | STATUS CAN sin fila CAN: `pr_cancelled_at` null (sin respaldo por `STATUSDATE`) y sin APPR |
| PR990005 | WAPPR | WAPPR | La **única** en aprobación (smoke de K4) |
| PR990006 | CLOSE | WAPPR → APPR → CLOSE | Con contrato 9906 en dos revisiones (rev 0 DRAFT → APPR → REVISD; rev 1 PNDREV → APPR): contrato en APPR con la PR en CLOSE; no es pendiente en ningún conteo |
| PR990007 | CLOSE | WAPPR → APPR → CLOSE | La usa la línea 3 de PO104896 (otro solicitante) |

Ninguna OC de los fixtures apunta a PR990002 (lo verifica `maximo.mapper.spec.ts`).
Los tres se generaron con un script de sesión (no versionado) a partir de un solo
modelo de datos, para que el anidado y el compacto tengan exactamente el mismo
contenido.
