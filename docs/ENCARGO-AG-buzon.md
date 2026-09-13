# Encargo para AG — lo que queda del buzón

**Esto está en disco porque el buzón se lo come.** Te mandé tres mensajes
(09:35, 09:36, 09:40) y mi propio `orca-read` los ha consumido a los tres: el
`.orca/in/` no está segmentado y el primero que lee se lleva el correo de
todos. Es tu §2 bis, y me ha mordido a mí dirigiendo el squad. Así que el
encargo vive aquí, donde nadie lo puede consumir.

Tu diagnóstico está aceptado entero y es la pieza que faltaba: **no era una
raíz, eran dos.** El worktree explica los caminos A y B; el buzón sin segmentar
es un segundo fallo independiente que sólo afecta al B y que no se arregla con
lo primero.

## Ya está hecho, no lo toques

- `bin/lib/project-root.mjs` — pliega el worktree a su repo padre, la misma
  regla que `foldWorktreeSlug`. Los seis CLI lo usan.
- `bin/lib/receipt.mjs` (+ `.d.mts`) — el recibo, lado emisor.
- `src/agents/tools.ts` — sección `PEER QUESTIONS UNANSWERED` en el briefing.
- `test/buzon.test.ts` — 10/10.
- Todo commiteado en `c40eff8`.

## Tuyo, en zona exclusiva: `src/collector/messages.ts` y `bin/orca-read.mjs`

### (A) Segmentar el buzón — el fallo 2

- `inboxPayload` tiene que serializar el destino: `toAgentId`, `toSquad`, scope.
  Hoy no lo lleva y por eso `orca-read` no **puede** filtrar.
- `readItems` filtra por la identidad de quien lee (`lib/whoami.mjs`) y su
  escuadrón. Un `scope: project` sigue siendo de todos.
- La marca de leído deja de ser global: `<id>.read` pasa a ser por agente.
- **Compatibilidad:** hay ~200 ficheros ya depositados sin campo de destino. Un
  mensaje sin destino no puede desaparecer para todo el mundo — eso cambia un
  fallo por otro peor. Sugerencia: sin campo = visible para todos, como hoy.
  Déjalo escrito en el comentario.

### (B) `writeAtomic` — el fallo 3

Temporal de nombre fijo, carrera `ENOENT`, 288 avisos en siete días que han
desviado dos investigaciones. Dale un temporal único. Que el comentario diga
por qué era fijo y por qué ya no.

### (C) El recibo, lado collector

**Ruta corregida** — te la di mal la primera vez:

```
<project>/.orca/receipts/<stem>.json      ← es aquí
<project>/.orca/out/<stem>.receipt.json   ← NO: tu scan de messages.ts:211 se
                                            lleva del buzón de salida todo
                                            `.json` que no acabe en
                                            `.answer.json`, y take() lo borraba
                                            en el mismo tick. Medido: duraba
                                            menos de un segundo.
```

Campos y estados exactos en `bin/lib/receipt.mjs`; el emisor ya los lee.

**El emisor ya cierra el primer salto solo**: si un recibo está en `filed` y su
fichero ya no está en `.orca/out`, `sweepReceipts` lo promueve a `picked` sin
ayuda de nadie. Así que **no necesitas escribir `picked`**. Lo que sólo sabes
tú, y es lo que hace falta: `delivered` (con `recipients`), `undeliverable`
(con el motivo en `detail`) y `read`.

Si no puedes saberlo con certeza —entrega en otra máquina—, **deja `picked` y
no inventes `delivered`**. Un recibo que miente es peor que uno incompleto.

## Reglas que no se negocian

1. **Nunca edites en `/Users/danielcardenas/projects/orca`.** Es producción: el
   hub y el collector vivos corren sobre él bajo `tsx watch` y se relevan al
   guardar. Hoy eso dejó una puerta de denegación sin revisar activa una hora.
2. **Ejecutar** los `orca-*` desde ahí sí es seguro. Editar no. No confundas
   las dos cosas: así se produjo el incidente del otro squad.
3. Trabaja sólo en `/Users/danielcardenas/projects/orca/.claude/worktrees/forge-buzon-01`.
4. El shim del PATH apunta al checkout principal. Para probar el código nuevo,
   `node bin/orca-<lo-que-sea>.mjs`, no el nombre pelado.

## Cómo entregas

Deja el resumen en `docs/` de este worktree — **no confíes en el buzón hasta
que (A) esté puesto**, que es precisamente lo que estás arreglando. Verifica
con `npm run typecheck` y `npm test -- --changed` desde el worktree; no corras
la suite entera (diez minutos, y la máquina está con 3,6 G de swap).
