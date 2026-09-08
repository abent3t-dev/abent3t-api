# Fixtures de Maximo (sanitizados)

Respuestas REALES capturadas en producción/test de IBM Maximo (validaciones del
2026-05-29, 2026-06-05 y 2026-08-13; evidencia completa en `maximo-validation/`
en la raíz del repo), **sanitizadas** y, en algunos casos, recortadas. Los usan
los tests (`*.spec.ts`) y el seed de desarrollo de Int-3
(`npm run maximo:seed-fixtures`, T5 — guard `NODE_ENV!=production` y no se
copian a `dist`); en producción nunca se leen.

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
| `oslc.error.bmxaa8781e.json` | `resultados_v2/C3_oslc_contratos_contractrefnum.json` | OSLC | Error `BMXAA8781E` (propiedad inválida en `oslc.where`) |

Generador: script de sesión (no versionado) que aplica las reglas anteriores sobre
la evidencia. Al regenerar, volver a verificar:
1. `grep -ril "MAXAUTH\|Authorization" __fixtures__ --include=*.json` = vacío.
2. Búsqueda de `@` (emails) y de nombres/hosts reales = vacío.
3. Decodificar TODOS los `childkey#<base64>` (reemplazando `-` final por `=`) y
   confirmar que ningún segmento `PERSON/<id>` trae un id fuera de
   `USRnnn`/`MAXADMIN` — el test "sanidad de los fixtures" de
   `maximo.mapper.spec.ts` lo automatiza.
