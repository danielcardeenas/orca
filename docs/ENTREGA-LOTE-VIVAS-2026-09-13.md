# Lote «vivas»: cuatro arreglos del tablero de AUTOMEJORA · 2026-09-13

**Squad forge-vivas-01 (líder + 6F, 7F, 87, AI).** Rama `forge-vivas-01` desde `main` @
`ad48def`, worktree `/Users/danielcardenas/projects/orca/.claude/worktrees/forge-vivas-01`.
Diagnóstico de partida: `docs/RECONOCIMIENTO-TABLERO-AUTOMEJORA-2026-09-13.md` (§1, §2,
§3 y §4). Nadie editó en el checkout del operador. Sin push, sin merge a `main`, sin
publicación: la fusión es de CAPCOM.

## Los cuatro, en una tabla

| # | Clave del tablero | Miembro | Commits | Entrega |
|---|---|---|---|---|
| 1 | collector-reemplazado-bucle | 6F | `99ef8ed`, `8279f5f` (rama `forge-vivas-01-bucle`, fusionada en `1d1a5e9`) | `docs/ENTREGA-BUCLE-COLLECTOR-REEMPLAZADO-2026-09-13.md` |
| 2 | runtime-bajo-capcom-duplica-el-brief | AI | `c63d075` | `docs/RELEVO-FUERA-DE-CAPCOM-2026-09-13.md` |
| 3 | cambios-de-css-no-despiertan-su-prueba | 87 (+ líder) | `9aac6fc`, `e216c8a`, `dec9bb2`, `62f60e3`, `8fdef7f` | `docs/ENTREGA-SELECTOR-LEE-RUTAS-2026-09-13.md` |
| 4 | escalaciones-retiradas-cuentan-sin-respuesta | 7F | `0ca9ad7` | `docs/ENTREGA-ESCALACIONES-RETIRADAS-2026-09-13.md` |

Los cuatro entran verificados. Ninguno se queda a medias en la rama.

## Aislamiento y reparto

- **Worktree compartido** `forge-vivas-01`, creado por el líder desde `main` @ `ad48def`
  antes del primer mensaje, con `node_modules` enlazado al checkout principal. Los cuatro
  recibieron la ruta absoluta en el primer handoff. Regla: cada uno toca sólo sus ficheros,
  commitea por piezas con `git commit --only -- <rutas>`, y avisa antes de tocar un fichero
  ajeno. Dos cruces declarados y autorizados: AI en `src/hub/server.ts:2598` (una línea en
  `servedRoots`) mientras 6F estaba en `server.ts` ~1743; 6F y 7F en `src/hub/world.ts`
  (sección máquinas y sección escalaciones). La fusión salió limpia.
- **6F trabajó en un worktree propio** (`.claude/worktrees/forge-vivas-01-bucle`, rama
  `forge-vivas-01-bucle`) porque empezó antes de leer el reparto; se aceptó tal cual y el
  líder fusionó con `--no-ff` (`1d1a5e9`) en cuanto 7F y AI commitearon `world.ts` y
  `server.ts`.
- **87 midió en un worktree propio** (`.claude/worktrees/forge-vivas-01-selector`, rama
  `forge-vivas-01-selector`, dos commits WIP que son copias de lo que ya está en
  `forge-vivas-01`) porque el árbol compartido tenía ediciones ajenas a medias durante su
  suite completa. Se queda hasta que CAPCOM decida; no contiene nada que no esté ya fusionado.
- **Nada en el working tree**: `forge-vivas-01` @ `8fdef7f` está limpio (`git status` sólo
  enseña el symlink `node_modules`, que `.gitignore` no cubre por llevar barra).

## Arreglo por arreglo

### 1 · collector-reemplazado-bucle (6F)

**Ficheros**: `src/shared/protocol.ts` (`CLOSE_REPLACED = 4009`, `CollectorInstance`
opcional en el `hello`; `PROTOCOL_VERSION` sin subir), `src/collector/reconnect.ts` (nuevo:
`ReconnectPolicy`, pura), `src/collector/index.ts` (cableado en `connect`/`close`/`sendHello`),
`src/hub/replacements.ts` (nuevo: `ReplacementWatch` por máquina, ventana de 10 min),
`src/hub/server.ts` (cuenta y dice quién echó a quién; cierra con `CLOSE_REPLACED` y motivo
con pid y cwd), `src/hub/world.ts` (`noteMachineReplaced`: evento `machine:replaced` siempre,
alerta en feed desde el segundo en la ventana), `test/reconnect.test.ts` (nuevo, 7 casos),
`test/hub.test.ts` (+1 integración: dos sockets con el mismo id contra un hub aislado).

**Decisión que cambia el diagnóstico, y por qué es mejor.** El barrido decía «con 4009, no
reconectar y decirlo alto». El collector desplazado **sí reconecta**, con escalera propia:
30 s la primera vez, ×2 hasta 5 min, y sólo baja tras quedarse 5 min conectado. Motivo: si
el otro proceso muere (un zombi, una demo), el echado tiene que volver solo; «nunca» deja la
máquina fuera con un collector vivo dentro hasta que alguien reinicie a mano. Peor caso con
dos collectors vivos: un reemplazo cada 5 min, y el hub avisa desde el segundo en 10 min con
los dos pids y cwd. Antes: uno por segundo, indistinguible de una reconexión.

Segunda corrección de un supuesto: la escalera de red se resetea **por durar** (≥ 60 s), no
por abrir; en el bucle el socket abría siempre y moría al segundo, así que volvía al primer
peldaño cada vez.

**Pregunta abierta del barrido** («¿qué corría esa mañana?»): a partir de ahora el `hello`
lleva pid, cwd y arranque, y el motivo de cierre se lo dice al echado. Para el 10-09 sigue sin
respuesta: no hay dato.

### 2 · runtime-bajo-capcom-duplica-el-brief (AI)

**Ficheros**: `src/collector/provider-handoff.ts`, `src/collector/capcom.ts`,
`src/collector/commands.ts`, `src/collector/index.ts` (canal `handoffsDir`/`configure`),
`src/collector/hygiene.ts`, `src/hub/server.ts` (una línea en `servedRoots`),
`src/shared/hygiene.ts`, `src/shared/workspaces.ts`, `test/provider-handoff.test.ts`,
`test/capcom-new.test.ts`, `test/hygiene.test.ts`, `test/workspaces.test.ts`,
`docs/CAPCOM-RUNTIME-RECOVERY.md` (una ruta).

**Qué**: los relevos viven en `~/.orca/capcom-handoffs/<id>/` (hermano de `capcom`, no
hijo), con `runtime/` y `rules/` dentro como hasta ahora. Ningún ancestro del cwd lleva
fichero de reglas. `CapcomSession.writeConfig` es el único dueño del brief; sin dueño, el
relevo con contexto nuevo se rechaza antes de escribir nada. `ORCA_CAPCOM_DIR` mueve los dos.

**Medido** sobre réplica del `~/.orca/capcom` real: reset `clean` 9.145 → 189 tokens de
reglas por petición (tres copias → una, la corta); `continuity` 10.696 → 6.218 (una copia).
Prueba nueva que recorre la cadena de ancestros hasta el padre común y exige un único fichero.

**Lo que no cura solo**: la sesión CAPCOM viva (`162ee578`, clean) sigue con cwd bajo
`~/.orca/capcom` y paga el ancestro hasta relevarse; tras el próximo relevo 9.145 → 4.667,
y el CAPCOM que la releve, ya en el hermano, 189. Los 13 archivos viejos **no se tocan**
(`planFile` busca en las dos raíces; el próximo relevo les baja el brief a `rules/`).

### 3 · cambios-de-css-no-despiertan-su-prueba (87, con un commit del líder)

**Ficheros**: `test/affected.ts`, `test/run.ts`, `test/affected.test.ts`, `AGENTS.md`
(párrafo de verificación; `CLAUDE.md` sigue siendo el symlink).

**Medida, que cambia el diagnóstico**: no 14 sino **16 suites y unos 20 ficheros** fuera del
grafo; 7 de 10 hojas (no 6: `agent-stop.css` vive en `src/ui/hud` y sí llegaba); `restart`
sí se seleccionaba por `restart.ts` pero no por `supervise.mjs`; `permissions`, `push` y
`phone-media` no estaban contadas. Lo peor: `test/phone-media.test.ts` (19 casos sobre
`hud.css`/`window.css`, fusionada de forge-tres-01) no corría al tocar esas hojas.

**Forma**: la ruta con la que la prueba lee el fichero **es** su declaración. El recorrido
lee, sólo en ficheros bajo `test/`, los literales relativos que existen en disco (fichero o
directorio, incluido el prefijo de una plantilla) y los `href`/`src` absolutos de los fixtures
Playwright. En `src/` no se leen: el primer intento seguía `'../../bin'` de `shims.ts` y 45
suites cubrían cualquier hoja. Dos suites de más a sabiendas: `source-rev` en cualquier
cambio de `src` y `update` en `src/ui`. Resultado: `hud.css` 0 → 9 suites, `window.css`
0 → 10, `public/sw.js` 0 → 1.

`run.ts` sale con código 3 (`NOTHING_RAN`) cuando no ejecuta ninguna suite; bajo el amarillo
dice qué shots o escenas visuales miran lo que quedó fuera. Excepciones, las dos verdes de
verdad: `--changed` con el árbol limpio, y **sólo documentación tocada** (`8fdef7f`, del
líder: Markdown en `docs/` o en la raíz, reconocido por forma y no por lista de excepciones;
se dice aparte y no cuenta en el amarillo). Sin esa segunda excepción cada entrega de este
repo, que commitea su doc, habría salido en rojo.

**Hallazgo cazado por correrlo de verdad**: la unitaria decía 9 suites para `hud.css` y el
primer e2e dio 0 con código 3. `run.ts` pasa el directorio con barra final y el selector
comparaba contra `test//`. Arreglado en `e216c8a` con una prueba que falla contra el selector
anterior. Salió en rojo y no en verde, que es exactamente para lo que existe el código 3.

### 4 · escalaciones-retiradas-cuentan-sin-respuesta (7F)

**Ficheros**: `src/shared/types.ts` (`WithdrawCause`), `src/hub/world.ts` (un único
`closeEscalation` por el que pasan los seis cierres; idempotente), `src/hub/lifecycle.ts`
(`escalation:withdrawn`), `src/hub/journal.ts` (entrada `withdraw` con causa, motivo y
`waitedMs`; `stats().escalations` con `withdrawn`, `withdrawnBy`, `unanswered`),
`src/hub/improve.ts` (digest), `src/agents/tools-journal.ts` (`journal_stats`), `bin/orca.mjs`
(`orca journal --stats`), `test/journal.test.ts` (+2), fixtures de `test/improve.test.ts` y
`test/gestures.test.ts`.

**Medido** sobre el diario real: 85 preguntas, 4 respuestas, 81 contadas como sin respuesta,
76 del 10-09. Diagnóstico confirmado, y dos cosas que no veía: el evento `escalation:withdraw`
no llevaba id ni agente (el diario no podía casarlo aunque lo escuchara), y de los seis
cierres sin respuesta **cuatro no emitían nada** (sustituida por otro diálogo, caducada por
`expiresAt`, caducada por desborde, descartada desde consola). Causas: `agent | permission |
gone | superseded | expired | dismissed`, deducidas de lo que el hub sabe, nunca del texto.

**Segundo hallazgo**: los cuatro consumidores leían la misma `stats()` y no se contradecían
en cifra, pero no enseñaban lo mismo (el digest decía `unanswered`, el CLI `open`, el resumen
de `journal_stats` sólo `asked`). Ahora los tres enseñan asked / answered / withdrawn /
unanswered con las mismas palabras.

**Lo que no cambia**: el histórico no se reescribe (las 76 del 10-09 no tienen id con qué
casarse; la ventana del digest es de 24 h y ya no las ve). Collector y UI sin tocar.
`dismissEscalation` ya no vuelve `withdrawn` una escalación `answered`/`expired`.

## Verificación del conjunto, con el lote quieto

Todo sobre `forge-vivas-01` @ `8fdef7f`, working tree limpio, nadie editando (aviso al
squad antes de empezar). Ningún miembro corrió nada durante estas corridas.

| Qué | Resultado |
|---|---|
| `npm run typecheck` | limpio, código 0 |
| `npm test -- --since=main` | 36 ficheros tocados → 111 suites, **1343/1343**, código 0. «Sólo documentación, nada que probar»: los 5 docs y `AGENTS.md`. **Ningún fichero de código sin suite.** |
| `npm test` completa | **135 suites, 1530/1530**, código 0. Pedida por CAPCOM porque el lote toca el selector: es la única corrida que no depende de él. |
| `npm run shots`, ronda 1 | **16/16**, 7 min |
| `npm run shots`, ronda 2 | **parada por el líder en 7/16**, todas OK hasta ahí, para dejar la máquina a la suite completa cuando CAPCOM pidió cerrar ya |
| `npm run shots`, ronda 3 | no corrida |

El encargo pedía tres rondas; CAPCOM cambió el plan a media verificación («lo que esté
verificado, ahora»; los shots sólo si algo toca la interfaz, y nada de este lote la toca).
Así que la puerta visual tiene **una ronda entera** sobre `8fdef7f` y media más, no tres:
es un dato para «no se ha roto», no para «no es intermitente». Las corridas de arriba son
del mismo árbol y el mismo commit; no se suman con las de otros árboles (las de 87 en
`forge-vivas-01-selector` y las de 6F en `forge-vivas-01-bucle` están en sus entregas).

Verificaciones por pieza, en sus entregas: 6F `--changed` 77 suites 971/971; 7F `journal`
23/23, `improve gestures` 120/120; 87 suite completa 1518/1518 en su worktree limpio; AI
`--changed` 108 suites 1322/1322.

## Lo que queda sin cubrir por ninguna prueba

- **Arreglo 1**: el cableado de `ReconnectPolicy` dentro de `Collector`
  (`src/collector/index.ts`, `connect`/`scheduleReconnect`/`sendHello`): la clase no se
  exporta y su constructor levanta tmux, watchers y ptys. La política entera está probada sin
  socket. **No se ha reproducido el bucle con dos collectors reales** contra un hub; la
  integración lo hace con dos sockets crudos contra un hub aislado.
- **Arreglo 2**: la línea de `servedRoots` en `src/hub/server.ts` y las dos del canal en
  `src/collector/index.ts` (cableado; las pruebas cablean lo mismo a mano con un
  `CapcomSession` real). **No se ha hecho un relevo real de CAPCOM** con este código: la
  sesión viva seguirá pagando el ancestro hasta que ocurra.
- **Arreglo 3**: el aviso «lo miran fuera de esta corrida» (shots/visual) no tiene prueba
  propia. La excepción de sólo-documentación está probada como unidad (`isProse` y mezcla
  doc + hoja en `affected.test.ts`) y de extremo a extremo por la propia corrida
  `--since=main` de arriba (6 docs apartados, código 0) y por `npm test -- --since=HEAD~1`
  sobre el commit de este mismo documento («sólo documentación tocada, nada que verificar»,
  código 0); no por un test que ejecute `run.ts` con un doc solo. `src/ui/main.ts` sigue sin suite que lo alcance (ahora lo dice y no sale
  verde).
- **Arreglo 4**: `bin/orca.mjs` (`orca journal --stats`): la prueba lo ejecuta como proceso
  y salió `withdrawn 0, open 0`, pero no afirma sobre la palabra nueva.
- **Ningún shot mira ninguno de los cuatro**: no hay UI tocada. Los 16 se corrieron como
  puerta, no como cobertura.

## Lo que queda sin medir

- Si el bucle 4009 vuelve a ocurrir en la máquina real, cuánto tarda en aparecer la alerta y
  qué dice el log del collector desplazado. Sólo se ha visto en la integración.
- El coste real de un relevo `clean` de CAPCOM en producción tras este cambio (los 189
  tokens son sobre réplica del directorio, no sobre una sesión relevada de verdad).
- Cuántas suites de más selecciona el selector nuevo en un día normal (`source-rev` y
  `update` entran en casi cualquier cambio de `src`; es una decisión, no un error, pero no
  se ha medido su coste en minutos).

## Propuestas nuevas, para el tablero y no para esta rama

Encontradas al implementar; no se arreglan aquí por decisión de CAPCOM.

1. **`.gitignore` no cubre un `node_modules` enlazado**: la entrada lleva barra
   (`node_modules/`) y un symlink no es un directorio, así que en cualquier worktree con
   `node_modules` por enlace `git status` lo enseña como `??` y `npm test -- --changed` lo
   lista como «sin suite que lo cubra». Ruido, no fallo; con `--since` no aparece. Una línea.
2. **Las 76 retiradas del 10-09 seguirán contando como sin respuesta** en cualquier ventana
   que las incluya: el evento de entonces no llevaba id. Si alguna vez hace falta leer esa
   semana, hay que decidir si se reclasifican con una causa `unknown` explícita, nunca
   inventada.
3. **Trasladar los 13 archivos viejos de relevo** a `~/.orca/capcom-handoffs/`: nada de este
   cambio lo hace y sería una operación aparte y pedida. Hoy se leen desde las dos raíces.
4. **`src/ui/main.ts` sin suite**: el selector ahora lo dice en amarillo cada vez que se
   toca. Es el punto de entrada de la UI y sólo lo miran los shots.

## A quién se puede parar, y cuándo

- **6F, 7F, AI**: se pueden parar **ahora**. Sus piezas están commiteadas y fusionadas en
  `forge-vivas-01` @ `8fdef7f`; no tienen encargo abierto y no tocan ningún worktree.
- **87**: se puede parar **ahora**. Su handoff pendiente (sólo-documentación) lo cerró el
  líder en `8fdef7f`; 87 no lo llegó a leer.
- **Worktrees**: `forge-vivas-01-bucle` (6F) y `forge-vivas-01-selector` (87) no contienen
  nada que no esté ya en `forge-vivas-01`; se pueden retirar cuando CAPCOM quiera, después de
  parar a sus dueños. `forge-vivas-01` es el que hay que fusionar.
- **El líder** termina con este documento; no queda nada en vuelo.

Filtros que cubren esta entrega: `reconnect`, `hub` (arreglo 1); `provider-handoff`,
`capcom-new`, `workspaces`, `hygiene` (arreglo 2); `affected` (arreglo 3); `journal`,
`improve`, `gestures` (arreglo 4). El conjunto: `npm test -- --since=main` desde la rama.
