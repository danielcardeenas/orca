# Barrido del tablero de AUTOMEJORA · 2026-09-13

**Mission-29 · reconocimiento de sólo lectura.** Medido sobre `main` @ `7a61eed` (HEAD del
checkout del operador a las 12:00), sobre `~/.orca/hub/improve/improve.json`, sobre
`~/.orca/hub/events/*.jsonl` y sobre la rama sin fusionar `forge-tres-01` (11 commits,
leídos con `git show`). No se editó nada, no se corrió ningún test ni shot.

## Cómo se leyó el tablero

`orca-improve --list` no existe: el atajo del PATH sólo tiene `report` (`bin/orca-improve.mjs`).
Se leyó directamente `~/.orca/hub/improve/improve.json`. Contiene **30** propuestas, no 21:

| Estado real | Cuántas | Cuáles |
|---|---|---|
| Anotadas «IMPLEMENTADO Y FUSIONADO» por CAPCOM (status sigue `open`) | **8**, no 6 | journal-mezcla-arnes, buzon-de-agente-deja-de-recibir, puerta-forge-para-cambios-en-orca, files-gate-cierra-worktrees-forge, shots-apuestan-sobre-flota-sintetica, arnes-declara-maquina-que-parece-real, verde-que-no-afirma-nada, 403-mudo-y-boton-imposible |
| `completed` | 2 | reportes-de-agente-recortados-a-200, shot-de-automejora-en-rojo |
| `archived` | 2 | console-usage-instrumentation, active-mission-without-working-agent |
| **Abiertas sin anotar: el objetivo** | **18**, no 15 | las de abajo |

## El número que pediste: cuánto miente el tablero

De las 18 abiertas, **7 están arregladas en `main` y siguen abiertas** sin nota de cierre:
techo-revisor-cuenta-cache (11-09), ventana-de-uso-se-borra-al-leerla (11-09),
dinero-no-mide-nada (12-09), coste-codex-a-cero (12-09, por la anterior),
brief-duplicado-en-handoffs (12-09), journal-endings-missing y digest-launch-count-mismatch
(13-09, absorbidas por journal-mezcla-arnes según la propia nota de CAPCOM, pero sus claves
no se cerraron). Cinco sin residuo, dos con un fleco menor cada una.

Otras **2 están arregladas en `forge-tres-01`** sin fusionar (detener-no-libera-el-proceso,
miembro-sin-via-de-escape) y una tercera a medias (apaisado). Si esa rama entra, el tablero
tendrá 10 de 18 muertas sin cerrar.

Quedan **8 vivas de verdad**, y de ellas 3 se pueden decidir sin más datos.

## Las 18, en el orden en que conviene mirarlas

| # | Clave | Veredicto | Evidencia | Recomendación |
|---|---|---|---|---|
| 1 | collector-reemplazado-bucle | **Viva**, íntegra | se sostiene: 4.912 reconexiones, todas de la máquina real | **Implementar** |
| 2 | runtime-bajo-capcom-duplica-el-brief | **Viva**, confirmada en vivo por CAPCOM | se sostiene | **Implementar**, misión propia |
| 3 | cambios-de-css-no-despiertan-su-prueba | **Viva**, y peor de lo escrito | se sostiene; premisa parcialmente falsa | **Reescribir** |
| 4 | escalaciones-retiradas-cuentan-sin-respuesta | **Viva**, intacta | parcialmente contaminada; el fondo se sostiene | **Implementar** |
| 5 | permiso-reescalado-cada-4s | **Viva**; diagnóstico incompleto | se sostiene (máquina real) | **Reescribir** |
| 6 | reviewer-budget-heads-up | **Viva**, pero el terreno cambió | hipótesis sin cifras | **Medir primero** |
| 7 | apaisado-no-cuenta-como-telefono | **Viva** en `main`; arreglo en vuelo | se sostiene | **Implementar** (fusionar y contrastar) |
| 8 | detener-no-libera-el-proceso | **Viva** en `main`; arreglada en `forge-tres-01` | se sostiene | **Cerrar** al fusionar |
| 9 | miembro-sin-via-de-escape | **Viva** en `main`; arreglada en `forge-tres-01` | se sostiene | **Cerrar** al fusionar |
| 10 | capcom-not-in-the-loop | **Muerta** en su tesis; queda un residuo | contaminada (ventana + arnés) | **Reescribir** como propuesta pequeña |
| 11 | relevo-de-sesiones-largas | **Parcial**; aplazada por el operador el 12-09 | los $ ya no miden; los tokens sí | **Cerrar** (aplazada), reabrir con síntoma |
| 12 | brief-duplicado-en-handoffs | **Muerta** en código (`59456d2`); en disco actúa al próximo relevo | se sostiene | **Cerrar** |
| 13 | techo-revisor-cuenta-cache | **Muerta** (`0df43e1`); sin revisión posterior que lo pruebe | se sostiene | **Cerrar** |
| 14 | ventana-de-uso-se-borra-al-leerla | **Muerta** (`3c26898`), anillo vivo en el hub | se sostiene | **Cerrar** |
| 15 | dinero-no-mide-nada | **Muerta** (`0915077`, `620e779`, `e96ba8a`) | se sostiene | **Cerrar** |
| 16 | coste-codex-a-cero | **Muerta**, resuelta por la anterior | se sostiene | **Cerrar** |
| 17 | journal-endings-missing | **Muerta** (`b57d4a4`) | contaminada: era el recorte a 500 | **Cerrar** |
| 18 | digest-launch-count-mismatch | **Muerta** (`b57d4a4`); fleco de legibilidad | contaminada (arnés + recorte) | **Cerrar** |

## Detalle de las que no son obvias

### 1 · collector-reemplazado-bucle — Viva, implementar

Las tres piezas siguen exactamente como la propuesta las describe. El hub cierra la
conexión anterior con `4009` y no avisa ni cuenta (`src/hub/server.ts:1738-1741`; lo único
que sale es la línea normal de «collector conectado», `:1750`). El collector no lee el
código de cierre: el handler no declara `code` ni `reason` y reprograma sin más
(`src/collector/index.ts:1577-1585`). El backoff vuelve a 1 s en cada `open`
(`src/collector/index.ts:1561-1563`; `RECONNECT_MIN_MS` en `:134`). No hay ningún commit
posterior que toque `4009` ni `previous.ws.close`.

Evidencia: se sostiene y no está contaminada. Las 4.912 reconexiones del 10-09 son todas de
`a303610…` (la máquina real), entre 03:30 y 05:05 UTC, mediana de 1.152 ms entre una y la
siguiente. Los otros seis días del registro tienen 2, 0, 0, 0, 0 y 0. Los commits de hoy del
canal de mensajes (`69de31a`, `c40eff8`) son la raíz del proyecto en worktrees y no tocan el
websocket ni el `machineId`.

Pregunta abierta («¿qué corría esa mañana?»): el código no lo dice y los eventos tampoco
llevan pid ni versión. Lo que sí hay en esa franja y no está explicado: 15.509 `artifact:new`
y 448 `feed:alert` en hora y media. Para contestarla haría falta el log del collector de ese
día, si se conserva. Arreglo obvio (no hecho): que `close` mire `code === 4009`, no reconecte
y lo diga alto; que el hub cuente reemplazos por máquina y avise a partir del segundo en un
minuto.

### 2 · runtime-bajo-capcom-duplica-el-brief — Viva, implementar en misión propia

El cwd del relevo sigue en `~/.orca/capcom/handoffs/<id>/runtime`
(`src/collector/provider-handoff.ts:294-296`; `capcomDir()` en `src/collector/capcom.ts:189-191`),
y `~/.orca/capcom/CLAUDE.md` es ancestro suyo. El brief se escribe en el cwd por dos dueños
(`provider-handoff.ts:299-300` y `capcom.ts:441` → `:528-532`). Un reset `clean` escribe el
brief corto en `runtime/` y recibe igual el largo por el ancestro, escrito por
`capcom.ts:753` al arrancar el collector.

Confirmación en vivo, aportada por CAPCOM durante este barrido: su sesión actual, en modo
clean, arrancó con tres copias completas del brief (`~/.orca/capcom/CLAUDE.md`,
`handoffs/<id>/CLAUDE.md`, `handoffs/<id>/runtime/CLAUDE.md`). El disco lo cuadra: los 13
archivos de `~/.orca/capcom/handoffs/` tienen el `CLAUDE.md` en la raíz y ninguno en
`rules/`, porque `demoteArchivedRules` sólo corre al preparar un relevo nuevo
(`provider-handoff.ts:302`) y el último es del 10-09 17:37, anterior a `59456d2`. La copia
del medio la quita el próximo relevo; la del ancestro sólo la quita esta propuesta.

Cambia de categoría: no es eficiencia (6.017 tokens por petición, medidos en
`docs/BRIEF-DUPLICADO-EN-RELEVOS-2026-09-12.md`), es corrección: `clean` no cumple lo que
promete. La propia entrega del 12-09 lo dejó como «la propuesta siguiente» y descartó
recortar `:299` por tres razones verificadas (Codex no sube por ancestros; el activador lo
reescribe; los dos ficheros coinciden por casualidad). Forma: sacar `runtime/` de debajo de
`~/.orca/capcom`, con prueba de que un relevo arranca completo en `continuity` y en `clean`.
Sin pregunta abierta.

### 3 · cambios-de-css-no-despiertan-su-prueba — Viva y peor, reescribir

La premisa de la propuesta («existe una prueba que lee las hojas del disco y compara tablas
de verdad») **es falsa en `main`**: ningún fichero de `test/` lee un `.css` del disco. Esa
prueba la escribió `forge-tres-01` (`test/phone-media.test.ts`, 19 casos) y vive en la rama.

Lo que sí es cierto, y es más grave: la selección (`test/affected.ts:14`, `:43`) sigue sólo
`import` relativos desde `*.test.ts`, y de las 10 hojas de `src/ui/styles/` sólo 4 son
alcanzables (`tokens.css`, `field.css`, `strays.css` vía `test/page-zoom.fixture.ts:9-11`;
`agent-stop.css` vía `src/ui/hud/agent-stop.ts:6`). **`window.css`, `hud.css`, `improve.css`,
`boot.css`, `sigil.css` y `squad.css` no las alcanza ninguna suite.** Tocar sólo una de ellas
con `npm test -- --changed` selecciona cero suites, imprime el amarillo y sale por
`test/run.ts:142-145` con «no test files» y **código 0**. Es lo que pasó hoy con el mástil
(`952b59d`, sólo `hud.css`): la verificación fue verde sin ejecutar nada relevante. Las 25
pruebas que usan CSS lo hacen por `<link>` dentro de Playwright, invisible para el grafo.

Pregunta abierta («¿cuántas leen del disco?»): contestada. Además de las 6 hojas huérfanas,
**14 suites** dependen de ficheros del repo por ruta y quedan fuera del grafo, y no sólo CSS:
`test/sw.test.ts:25` (`public/sw.js`), `test/restart.test.ts:21` y `:62`
(`tools/supervise.mjs`, `src/shared/restart.ts`), `test/strays.test.ts:316`,
`test/hud-disclose.test.ts:34`, `test/improve-panel.test.ts:225`, `test/source-rev.test.ts:21`,
`test/shots-gate.test.ts:111`, `test/model-control.test.ts:47`, `test/buzon.test.ts:120`,
`test/mail-wait.test.ts:8`, `test/improve-cli.test.ts:25`, `test/squads.test.ts:46`. El único
mecanismo de declaración es una convención por comentario (`import type` del fixture +
`import` del `.css` dentro del fixture) usada una sola vez, `test/page-zoom.fixture.ts:3-11`.

Reescritura sugerida: (a) que `run.ts` salga en amarillo con código distinto de 0 cuando
**todo** lo cambiado queda sin cubrir, que es la falsa tranquilidad concreta; (b) aplicar el
patrón de `page-zoom.fixture.ts` a las 6 hojas huérfanas, o un campo declarativo en
`affected.ts` si se prefiere no depender de un comentario. Los 14 ficheros no-CSS son el
mismo agujero y conviene decidirlos a la vez.

### 4 · escalaciones-retiradas-cuentan-sin-respuesta — Viva, implementar

`createJournal` sólo engancha `escalation:new` y `escalation:answered`
(`src/hub/journal.ts:908-955`); `lifecycle` no tiene un tercer evento
(`src/hub/lifecycle.ts:38-40`, únicos `emit` en `:116` y `:131`). La retirada existe en el
protocolo (`src/shared/protocol.ts:61`), la emite el collector (`src/collector/index.ts:979`,
`:1016`) y el world la aplica (`src/hub/world.ts:2050-2057`) como evento de feed, nunca de
lifecycle. Consecuencia intacta: `journal.ts:673-677` mete toda retirada en `unanswered`, y
el digest lo reproduce sin clase de cierre (`src/hub/improve.ts:827`).

Evidencia: los «29 el arnés se apagó» eran del fake collector, como avisó E0. Pero la
máquina real sola tuvo el 10-09 68 retiradas y 0 respuestas (`events/2026-09-10.jsonl`: 56
«Permission dialog changed», 8 «answered manually», 4 «no longer observable»), así que el
fondo se sostiene sin el arnés. Volumen actual bajo: 11-09 y 12-09 sin escalaciones; 13-09,
5 nuevas y 4 contestadas. Sin pregunta abierta. Arreglo obvio: emitir `escalation:withdraw`
por lifecycle con motivo, anotarlo en el diario con clase, y repartirlo en el digest.

### 5 · permiso-reescalado-cada-4s — Viva, reescribir

El diagnóstico se queda corto en un punto que cambia la forma del arreglo: **ya existe una
deduplicación** en el collector por (identidad del pane, huella del diálogo)
(`src/collector/index.ts:744-745`), de `b904f4b` (07-09), anterior a las ráfagas medidas. Es
decir, las 76 escalaciones del 10-09 ocurrieron **con** esa deduplicación puesta: la huella
es un hash de toda la pantalla visible (`src/collector/screen.ts:71-75`), así que cualquier
cambio por encima del diálogo la invalida, retira la anterior y minta un id nuevo
(`index.ts:764`, `newId('esc')`), y el hub hace el retiro-y-alta literal
(`src/hub/world.ts:2031-2042`). No hay identidad por (agente, herramienta, objetivo) ni
fusión.

Evidencia: se sostiene y es de la máquina real (76 `escalation:new` de `a303610…` el 10-09,
retiradas a 4 s exactos entre sí). No ha vuelto: 0 el 11 y el 12. Pregunta abierta («¿se
notó en consola?»): el código no lo dice; cada `escalation:new` pasa por el router de CAPCOM
(`world.ts:2042`), así que es esperable que sí. Reescritura: la huella debe ser del texto del
diálogo, no de la pantalla; con eso la deduplicación existente basta y no hace falta
identidad nueva en el hub.

### 6 · reviewer-budget-heads-up — Viva, medir primero

Sigue vivo tal cual: un solo umbral (`WARN_AT = 0.8`, `src/hub/budgets.ts:152`, disparo en
`:795-802`), y el aviso va al feed y a CAPCOM, nunca al agente afectado
(`src/hub/server.ts:1045-1066`; `budgetNote` en `:1005-1010` sólo hace `pushFeed`). Lo único
que llega al revisor es el `stop` al 100 %. El brief del revisor no menciona techo ni
archivado temprano y dice lo contrario, «Take your time, then file»
(`src/shared/improve.ts:1090-1091`, cierre en `:1128-1130`). El revisor sí está en el libro
común (`src/hub/improve.ts:1318`, `server.ts:895-906`).

Pero el terreno cambió: con la regla nueva del techo, AJ habría llevado 114.008 de 400.000
(29 %) cuando lo pararon, y su sesión entera 224.040 (`docs/ENTREGA-AUTOMEJORA-TECHO-Y-VENTANA-2026-09-11.md`).
**Desde el 11-09 no ha corrido ninguna revisión**: las tres del tablero son anteriores
(`rev_mtw8cgp3dupemnnh` 11-09 00:40, `overbudget`) y `config.paused` sigue en `true`. El dato
que falta: si una revisión con la regla nueva termina sola dentro de 400k. Hasta tenerlo, el
aviso al revisor es una solución a un problema que quizá ya no existe. La parte barata (una
frase en el brief: archiva una primera tanda antes de seguir leyendo) no depende de la
medida. Pregunta abierta: brief primero; aviso sólo si la revisión de prueba vuelve a morir.

### 7 · apaisado-no-cuenta-como-telefono — Viva en `main`, arreglo en vuelo

En `main` el HUD está arreglado (`src/ui/styles/hud.css:374`, `:451`, por `952b59d`) y el
resto no: `src/ui/windows/wm.ts:258` (`MOBILE()` sólo por ancho, gobierna 20 decisiones del
gestor), `src/ui/styles/window.css:381`, `:402` (la condición que ningún teléfono de 844 o más
cumple: `max-width: 720px and max-height: 560px`), `:467`. Inventario de quién decide
«móvil» en TS, cinco sitios con cuatro criterios: `wm.ts:258`, `src/ui/controls.ts:118-120`,
`src/ui/hud/sections.ts:116`, `src/ui/windows/composer.ts:44`, `src/ui/hud/cursor.ts:36`.

`forge-tres-01` (`fa28d62`) crea `src/ui/phone.ts` con `PHONE_MQ`/`isPhone()`, lo importa
`wm.ts`, cambia las tres condiciones de `window.css` y añade `test/phone-media.test.ts`. Su
entrega (`docs/ENTREGA-MOVIL-APAISADO-2026-09-13.md`, en la rama) dice explícitamente que
`controls.ts` y `sections.ts` **no** se unifican porque preguntan otra cosa («¿cabe un
desplegable?», «¿cabe la sección flotando?»). Al fusionar, contrastar contra el inventario de
arriba: cubre `wm.ts` y `window.css`; deja fuera 3 de los 5 decisores a propósito, y anota
que la puerta de MISIONES no existe a 926×428. No verificado por mí el código de la rama,
sólo su diffstat y su entrega. Pregunta abierta: la rama eligió «un solo sitio», no sólo
ventanas.

### 8 y 9 · detener-no-libera-el-proceso y miembro-sin-via-de-escape — Vivas en `main`, arregladas en `forge-tres-01`

Sobre `main`: `stop` manda dos Ctrl-C y mata el pane en un temporizador cuyo resultado no
se reporta (`src/collector/commands.ts:1187-1199`); `stop_agent` devuelve `{ ok: true }` sin
mirar el ack (`src/agents/tools.ts:2307-2315`); nada verifica el pid; `retire_agent` sigue
diciendo que no mata nada (`tools.ts:669`). El perfil de miembro sigue sin `orca-ask`
(`src/collector/shims.ts:55`, `:132-138`) y `wake.ts` tiene cuatro despertadores, ninguno
`[SQUAD]`.

En la rama: `a4f28b9` (`src/shared/reap.ts`, `src/collector/reap.ts`, integrado en `stop`,
ack en dos partes, resto `session` en HYGIENE con `cc059d9`/`f7ae702`), y `536f290`
(quinto despertador `[SQUAD <name>]`: 15/45/120 min, al minuto si el líder murió, alerta al
operador a la hora) más `9bbc73f` (briefing marca `RECIPIENT IS GONE` para escuadrón vacío).
Las dos preguntas abiertas están contestadas por la decisión que la rama implementa: cierre
integrado en la detención; vigilancia desde el hub, sin tocar el perfil. Hueco declarado por
la propia entrega del cierre: **no se ha corrido `stop` contra un agente real de la flota**
(§7 de `docs/ENTREGA-CIERRE-PROCESOS-2026-09-13.md`, en la rama). Quien fusione debería
hacerlo con un agente desechable antes de cerrar la clave.

### 10 · capcom-not-in-the-loop — Muerta en su tesis, reescribir el residuo

Los tres ceros eran artefacto: la ventana de uso se vaciaba al leerla (arreglado, ver 14) y
la población era en parte del arnés. Hoy el anillo cuenta llamadas de CAPCOM a herramientas
por hora (`improve.json`, `usageHours`: p. ej. 87 `mcp:report_mission` en la ventana) y el
diario atribuye el spawn (`by: 'human' | 'capcom' | 'agent'`, `src/hub/journal.ts:93-94`,
`:854-855`; pista en `src/hub/server.ts:1374-1380`). Pregunta abierta: sí hubo CAPCOM vivo
(nota de CAPCOM del 11-09).

Lo que queda y vale una propuesta pequeña: el digest sigue sin estado explícito de CAPCOM.
`buildDigest` no recibe nada de él (`src/hub/improve.ts:812-819`; `fleet()` en
`src/hub/autonomy.ts:143-150` trae cuatro cifras) y escribe `none recorded` ambiguo
(`improve.ts:870`), aunque `capcomHealth()` ya sabe `capcomAlive`/`capcomBusy`
(`improve.ts:1141-1148`) y sólo se usa para decidir si lanzar. Fleco: `server.ts:1374`
atribuye a CAPCOM todo spawn sin consola, incluido el del propio revisor.

### 11 · relevo-de-sesiones-largas — Parcial, cerrar como aplazada

Hay traspaso con relevo para no-CAPCOM (`src/collector/worker-handoff.ts`, enrutado en
`src/collector/commands.ts:273`, alcanzable con `recover_agent` acción `handoff`), pero sin
umbral automático: `src/collector/rotation.ts` es sólo de CAPCOM (`:74-98`), único consumidor
`maybeRotateCapcom` (`src/collector/index.ts:1380-1412`). El diario no guarda coste por turno
ni `contextTokens` de vida (sólo en la entrada `rotation`, `journal.ts:145`). Evidencia: las
cifras en dólares ya no miden nada; la medida en tokens sobre 135 transcripts reales
(`docs/INFORME-CONTEXTO-REPETIDO-2026-09-12.md`) se sostiene. El operador la aplazó el 12-09
hasta ver síntoma (nota de CAPCOM en brief-duplicado-en-handoffs). El tablero debería
decirlo. Pregunta abierta («¿líderes vivos a propósito?»): no se contesta desde el código.

### 12 · brief-duplicado-en-handoffs — Muerta, cerrar (con aviso)

`59456d2`: `RULES_DIR = 'rules'` (`src/collector/provider-handoff.ts:92`), copia en
`:310-315`, `demoteArchivedRules` en `:105`, llamada en `:302`. El collector que corre arrancó
hoy a las 11:11 con ese código. Pero actúa sólo al preparar el próximo relevo, y en disco los
13 archivos siguen con la copia en la raíz (ver 2). La clave se puede cerrar; el residuo del
ancestro es la 2.

### 13 · techo-revisor-cuenta-cache — Muerta, cerrar

`0df43e1`: `ceilingTokens` en `src/shared/tokens.ts:45-50` (entrada + salida + escritura de
caché; la lectura sólo para collectors viejos), usado por `src/hub/improve.ts:1067-1069`,
`src/hub/budgets.ts:458-460`, `src/ui/hud/improve.ts:694`. `cacheWriteTokens` en
`src/shared/types.ts:293-299`, rellenado por `src/collector/derive.ts:373`/`:447` y
`src/collector/codex.ts:439-440`. Pregunta abierta: contestada, tokens sin lectura de caché.
Aviso: ninguna revisión ha corrido desde el arreglo (ver 6), así que «AUTOMEJORA cierra una
revisión sola» sigue sin demostrarse.

### 14 · ventana-de-uso-se-borra-al-leerla — Muerta, cerrar

`3c26898`: anillo de 24 cubos (`src/hub/improve.ts:216-217`, `USAGE_HOURS` en
`src/shared/improve.ts:352`), `usage()` sólo recorta (`improve.ts:376-388`), guardado por
temporizador (`:1447`, `USAGE_SAVE_MS` en `:86`) y al cerrar (`:1457`), línea «window
since» en el digest (`:865-866`). En el hub vivo: `improve.json` lleva `usageHours` con 17
cubos y `usageSince` 2026-09-11T00:40Z. Pregunta abierta: contestada (ver 10).

### 15 y 16 · dinero-no-mide-nada y coste-codex-a-cero — Muertas, cerrar

`BudgetLimit` sólo tiene `tokens` y `min`; el `usd` guardado se descarta al cargar
(`src/hub/budgets.ts:118-120`, `:214-221`). `list_fleet` y `journal_stats` no exponen dólares
(`src/agents/tools.ts:2362-2372`; `src/agents/tools-journal.ts:135-147`); el digest habla en
tokens (`src/hub/improve.ts:826`). Codex sigue en `costUSD: 0` (`src/collector/codex.ts:430-432`)
y es correcto por diseño; las 23 entradas del libro estaban huérfanas y las poda
`pruneOrphans`. Flecos de texto, no de dato: descripciones MCP que aún dicen «cost/spend»
(`src/agents/tools.ts:240`, `:547`, `:628`, `:657`; `src/agents/tools-journal.ts:7`, `:57`;
`src/collector/briefs.ts:327`) y un comentario obsoleto sobre `ORCA_BUDGET_MONEY`
(`src/shared/improve.ts:544`). Pregunta de Codex: contestada por el operador el 12-09, plan
plano.

### 17 y 18 · journal-endings-missing y digest-launch-count-mismatch — Muertas, cerrar

`b57d4a4`: `select()` sin tope y `MAX_LIMIT` sólo en `query()` (`src/hub/journal.ts:519-530`,
`:563-566`, `:571`); sintéticas excluidas y contadas (`:543`, `:571-573`, `excluded` en
`:665`, digest en `src/hub/improve.ts:856-858`); top 5 dice cuántos quedan fuera
(`improve.ts:839-846`). Releído sobre el hub real el 13-09: 55 de 55 entradas, 22 = 22, 24
done / 6 dead (`docs/ENTREGA-ARCHIVO-Y-PUERTA-2026-09-13.md`). Evidencia original
contaminada por las dos causas (recorte + arnés). Preguntas abiertas: contestadas (sí era el
arnés; sí compartían raíz).

Dos flecos que no justifican mantenerlas abiertas: los proyectos sin código salen con id
crudo (`improve.ts:840`, cae a `projectId`), y no existe la línea de autoauditoría
«N launches, 0 endings» (lanzamientos y finales van en líneas contiguas, `:824-825`, nadie
las compara). La asimetría de conteo (agentes distintos arriba, entradas abajo,
`journal.ts:666` vs `:600`) sigue, pero declarada en la propia línea (`improve.ts:824`).

## Lo que no pude comprobar

- **No ejecuté nada**: ni tests, ni shots, ni el hub. Todo es lectura de código, git, docs y
  ficheros de `~/.orca`.
- **El código de `forge-tres-01`** lo conozco por `git diff --stat`, `git log` y sus tres
  entregas; no leí sus fuentes ni verifiqué que sus pruebas pasen. El squad que lo escribe
  seguía activo durante este barrido, así que la rama puede haber cambiado.
- **Qué segundo collector corría el 10-09**: ni el código ni los eventos lo dicen.
- **Si las ráfagas de permisos sonaron en consola**: no se deduce del código.
- **Si CAPCOM recibe hoy tres copias del brief**: lo afirma CAPCOM; el disco lo hace
  consistente, no lo confirmo desde su sesión.
- **Si una revisión termina sola con la regla nueva del techo**: nadie la ha lanzado desde
  el 11-09.
- **Las cifras de dólares de las propuestas de coste** (por ejemplo «$302.64 de $387.64»)
  no las re-medí: con plan plano ya no miden nada, y la decisión del operador las vació de
  sentido antes de que nadie las comprobara.

## Avisos de forma

- `orca-improve --list` no existe en el atajo del PATH; se leyó el JSON del hub.
- El encargo hablaba de quince abiertas y seis fusionadas; el tablero tiene dieciocho y ocho.
- Recuento de las que el tablero da por abiertas y no lo están: **7 en `main`, 2 más en la
  rama**, 1 a medias en la rama.

Filtros que cubren este documento: ninguno. Es un informe de lectura; no cambia código ni
pruebas.
