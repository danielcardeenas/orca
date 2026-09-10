# AUTOMEJORA — informe de entrega

Misión `mission_mts6tjnbar7u0ngy`. Implementador único, sin subagentes.
Este archivo existe porque el canal de mensajes trunca: es el informe completo.
El documento de referencia de la sección es `docs/AUTOMEJORA.md`.

---

## 1. Qué hace

Una sección dedicada de la consola —forma, color y aviso propios— en la que
ORCA revisa **el instrumento** (la consola y CAPCOM) en vez de la flota, cada
cierto tiempo y sólo cuando tiene sentido. Produce **propuestas** y **preguntas
al operador**; el operador responde, pospone, descarta o **envía a CAPCOM**, y
enviar abre una misión real con la propuesta dentro. La revisión propone; el
trabajo lo dispara siempre una decisión humana.

**Dónde está en pantalla.** Arriba a la derecha, bajo el mástil, sobre el
canvas. El panel de misiones (trabajo de Q8, mission_mts6nu8pct7mqctr) está
arriba a la izquierda; el arnés visual comprueba contra los rectángulos reales
que las dos secciones no se solapan y que ninguna tapa el mástil, el reloj ni
el radar.

**Por qué se distingue a simple vista.**

- **Color propio** `--auto` `#b47cff`. En ORCA el color es significado y todos
  los que había hablan de agentes: lima vivo, ámbar *una persona hace falta
  ya*, rojo brecha, cian CAPCOM, azul esperando a otro. Ninguno podía prestarse
  sin mentir —menos que ninguno el ámbar, que significa un agente **parado**, y
  una propuesta no para a nadie. Queda documentado en `DESIGN.md` como
  «ORCA mirándose a sí misma. Sólo esta sección. Nunca un estado de agente».
- **Forma propia.** Ficha con el mordisco del tile en la esquina **contraria**
  (arriba a la izquierda) y una barra en el borde izquierdo. La barra es
  **continua** si la propuesta se apoya en mediciones y **discontinua** si es
  una hipótesis: la textura dice de qué está hecha la idea antes que la
  etiqueta, igual que la trama de un tile dice qué runtime corre dentro.
- **Aviso propio, una vez.** Cuenta en la cabecera (`2 NEW`), punto violeta en
  la esquina de la ficha, un paso lateral de la sección y un sonido. Nada de
  eso se repite por la misma propuesta: re-proponer la misma idea sube un
  contador y **no vuelve a avisar**. Se apaga al **abrir** la ficha, que es
  cuando de verdad se ha leído. Nada aquí se abre solo ni late.

**Qué enseña una ficha, en el orden en que se decide.** Plegada: área, si es
medición o hipótesis, hace cuánto, el título y dos líneas de resumen; impacto y
esfuerzo como dos medidores de tres celdas **sólo si la revisión tuvo con qué
estimarlos**. Abierta: evidencia (cifras citadas), hipótesis, detalle largo, la
pregunta al operador y la conversación entera.

**Acciones.** `REPLY` (guarda en el hilo *y* despierta a CAPCOM con la
respuesta) · `LATER · 3D` · `DISMISS` · `REOPEN` · `SEND TO CAPCOM` ·
`OPEN MISSION` cuando ya es una. Estados: `open` · `snoozed` (vuelve sola al
vencer) · `dismissed` (se **conserva**: es lo que impide que la siguiente
revisión la vuelva a proponer) · `sent`.

**Cómo se llega.** `⌥I` y `/improve` (o `/automejora`) la despliegan y la traen
a la vista. Se pliega a su cabecera y el pliegue se recuerda en prefs.

---

## 2. Programación real de las revisiones

Vive en `src/hub/improve.ts` como **pieza F de `hub/autonomy.ts`**, junto a
wake, verify y journal. No es un temporizador de la consola: corre en el hub y
sobrevive a que no haya ninguna consola abierta.

**El tic.** `deps.setInterval` cada `IMPROVE_TICK_MS` = 60 s. El tic sólo
**lee memoria** y sale por la primera condición que falla; lo caro —componer el
informe y pedir el turno— sólo ocurre si pasan todas. Nada de esto ocurre en un
render: la consola no dispara revisiones, sólo las mira.

**Las condiciones** (`dueForReview`, en `src/shared/improve.ts`, pura y por
tanto probada con reloj falso). El panel enseña literalmente la que falta:

| Condición | Lo que dice el panel |
|---|---|
| no pausada | `PAUSED BY THE OPERATOR` |
| ninguna revisión en vuelo | `A REVIEW IS IN FLIGHT · 12m AGO` |
| hay sesión CAPCOM viva | `NO CAPCOM SESSION TO ASK` |
| han pasado `everyMin` (6 h) | `NEXT IN 3h` |
| bajo el tope diario `perDay` (4) | `4 REVIEWS IN 24H · AT THE DAILY CEILING` |
| hay `minSignal` (40) gestos nuevos | `WAITING FOR SIGNAL · 12/40 SINCE THE LAST REVIEW` |
| CAPCOM no está en mitad de un turno | `CAPCOM IS MID-TURN · WAITING FOR IT TO SETTLE` |

«Cuando tenga sentido» es la condición de señal: una consola abierta y quieta
no acumula nada y no se le pregunta nunca; una sesión de trabajo real pasa de
40 gestos en minutos. La comprobación de CAPCOM ocupado va la **última** porque
es la única que cambia sola en un minuto.

**Controles visibles.** `REVIEW NOW` (ejecución manual: se salta reloj, señal y
tope diario —el operador ya decidió— pero **no** un CAPCOM vivo, que es una
imposibilidad, no una preferencia). `PAUSE`/`RESUME`. `SETUP` abre los tres
límites y cada uno cicla por pasos sensatos: cada 1 h/3 h/6 h/12 h/24 h, máximo
1/2/4/8/12 al día, señal mínima 0/10/40/100/250. Todo se guarda y sobrevive al
reinicio del hub. `ORCA_IMPROVE=0` es el interruptor duro (ni reloj ni
ejecución manual); `ORCA_IMPROVE_EVERY_MIN`, `ORCA_IMPROVE_PER_DAY`,
`ORCA_IMPROVE_MIN_SIGNAL` y `ORCA_IMPROVE_PAUSED` sólo fijan los valores
iniciales.

**Un turno, y ni uno más.** Pedida la revisión queda `pending` y no se pide
otra hasta que CAPCOM llama a la herramienta o hasta que **caduca a los 45
minutos** (`PENDING_TIMEOUT_MS`). Sin esa caducidad, la primera revisión que se
pierde —CAPCOM rota, muere o simplemente no llama— apagaría la sección para
siempre. La señal se pone a cero al **pedir** la revisión, no al recibirla.

**Por qué a CAPCOM y no a un worker.** CAPCOM ya tiene delante lo que hay que
revisar: la flota, el diario, las misiones y las herramientas. Un worker
costaría una sesión entera, un worktree y un arranque en frío para acabar
leyendo lo mismo.

---

## 3. Motor creativo, y por qué no es sólo métrica

El prompt (`reviewPrompt`) pide **dos trabajos**, y el segundo está escrito
para que no se pueda leer como opcional:

1. Leer la telemetría y decir qué enseña sobre cómo se usa ORCA de verdad:
   fricción, desperdicio, esperas, coste, lo que nadie toca, lo que se toca sin
   parar.
2. *«Think past it»*: proponer UI, usabilidad, rendimiento, comportamiento y
   **capacidades nuevas** que se crea que harían mejor la consola, **incluidas
   ideas que las cifras todavía no pueden sostener**. Textual: *«Those are
   wanted»*, con `kind="hypothesis"` y la suposición escrita.

**La marca que hace que eso sea honesto.** `normalizeDraft` rechaza —con el
motivo, en el mismo turno, para que se corrija sin perder la revisión— una
propuesta `observed` **sin evidencia** y una `hypothesis` **sin hipótesis**. Es
decir: una idea creativa es bienvenida pero **no puede disfrazarse de
medición**, y una afirmación medida no puede quedarse sin la cifra en la que se
apoya. El prompt lo repite: *«never invent a number: everything in `evidence`
must be from below or from the journal tools, quoted as it is»*.

**Impacto y esfuerzo son opcionales a propósito.** `impact`/`effort` sólo se
guardan si vienen y son válidos; sin ellos la ficha **no pinta medidor**. Una
estimación inventada es peor que ninguna porque el operador ordena por ella.
Las fichas se ordenan por estado primero, y dentro de eso por impacto menos
medio esfuerzo; las que no tienen estimación no se hunden ni flotan, van por
fecha: no saberlo no es lo mismo que ser poco importante.

**La creatividad se acumula, no se repite.** La deduplicación (§5) hace que
insistir en la misma idea suba `raised` y refresque la evidencia en vez de
producir otra fila y otro aviso, así que una revisión puede volver sobre una
buena idea sin castigar al operador por ello.

---

## 4. Cómo se envía a CAPCOM

Dos direcciones, las dos reales.

**Hub → CAPCOM (pedir la revisión).** `createImprove` compone
`reviewPrompt(...)` con el informe de telemetría, las propuestas abiertas (para
que reutilice claves) y lo que el operador contestó desde la última revisión, y
lo entrega por `deps.sayToCapcom`, que es el **router de CAPCOM ya existente**
(`capcomRouter.humanSays`): respeta rotaciones, así que si CAPCOM se está
reciclando la línea espera a la sesión nueva. La revisión se anota con
`delivery: 'delivered' | 'queued' | 'failed'`.

**CAPCOM → hub (contestar).** Tres herramientas MCP nuevas en
`src/agents/tools-improve.ts`, publicadas por el mismo servidor `/mcp` que el
resto y **nombradas en el brief de CAPCOM** (`src/collector/briefs.ts`, que es
lo que exige la prueba `capcom`):

- `report_improvements(review_id, proposals[])` — la **única** salida. La
  descripción insiste en que la prosa en el CLI no se archiva en ningún sitio y
  la revisión se da por perdida. Devuelve los rechazados **con el motivo**.
- `list_improvements(status, limit)` — el tablero: claves, estados, cuáles son
  ya misiones y qué contestó el operador. Se lee antes de archivar, para
  reutilizar claves y no re-proponer lo descartado.
- `note_improvement(proposal_id, text)` — contestar al operador en un hilo.

**Operador → CAPCOM (implementar).** `SEND TO CAPCOM` es lo único de la sección
que produce trabajo, y por eso lo dispara una pulsación y no un reloj. En el
hub (`improveSend` en `src/hub/server.ts`):

1. Lee la propuesta y **se niega si ya tiene misión** (la guarda está en el
   almacén *y* se comprueba aquí antes de crear nada, para no dejar misiones
   huérfanas). Valida el id contra `MISSION_ID`.
2. `missions.create(...)` con título `AUTOMEJORA · <título>`.
3. `missions.message(..., 'human', proposalHandoff(p))`: la propuesta **entera**
   —resumen, evidencia, hipótesis, detalle y la conversación con el operador—
   más la nota de que el operador la aprobó y que el trabajo es sobre ORCA.
4. Marca la propuesta `sent` y guarda `missionId`. La ficha cambia `SEND` por
   `OPEN MISSION`, que abre esa conversación en la ventana de CAPCOM.
5. Entrega el prompt de misión por el camino normal (`say` al CAPCOM vivo, o
   cola si está rotando). **Si no hay CAPCOM, la misión queda escrita igual** y
   la consola lo dice: el enlace es lo que permite retomarlo.

**Operador → CAPCOM (responder una pregunta).** `REPLY` guarda la respuesta en
el hilo de la propuesta **y** le pega a CAPCOM un turno
`[ORCA SELF-REVIEW REPLY <id>]` con la pregunta, la respuesta y la instrucción
de contestar con `note_improvement` bajo la misma clave. Si no hay nadie que lo
recoja, se guarda igual y se anota en el hilo que nadie lo tomó: perderla en
silencio sería lo único inaceptable.

---

## 5. Deduplicación y telemetría

**Deduplicación.** Cada propuesta tiene una **clave de idea**: la elige quien
reporta (se le pide reutilizar la de una abierta) y, si no, sale del título
normalizado. `findDuplicate` mira primero por clave y luego por título
normalizado —la red para cuando el modelo olvida la clave— y mira **todas** las
propuestas, **descartadas incluidas**: descartar algo y que vuelva a la mañana
siguiente es la forma más rápida de que nadie mire la sección. Una repetida
sube `raised`, refresca evidencia e impacto/esfuerzo, **no cambia el estado** y
**no vuelve a avisar**.

**Telemetría mínima, de datos existentes, sin contenido privado.** Dos fuentes,
ninguna nueva:

- El **diario** que ya existía (`hub/journal.ts`, `stats()` de 24 h):
  lanzamientos por origen, done/dead, coste total y medio, duración media,
  escalaciones —quién las contestó y cuánto esperaron—, rotaciones de CAPCOM,
  aterrizajes, y lo mismo por proyecto usando su **código** (`AX`), que es como
  lo nombra una persona y no dice dónde está.
- **Contadores de uso** (`UsageMeter`): `mcp:<tool>` cada vez que CAPCOM llama
  una herramienta (gancho `onTool` nuevo en `hub/mcp.ts`) y `ui:<frame>` cada
  vez que la consola pide algo al hub. **Un nombre y una cuenta**, nunca los
  argumentos. Es lo que enseña qué se usa de verdad y qué no se encuentra.

Lo que **no** entra en un informe: rutas, briefs, transcripciones, preguntas o
respuestas de nadie, y ningún secreto. Además todo lo que escribe CAPCOM pasa
por `redact()` antes de tocar el disco —cinturón sobre los tirantes: no debería
dispararse nunca, pero un token pegado en una propuesta se quedaría en disco y
saldría por el protocolo a cualquier consola conectada.

**Persistencia.** `~/.orca/hub/improve/improve.json`, escrito con
temporal-y-renombrado como `missions.json`. Si el directorio no se puede
escribir, la sección sigue en memoria y **lo dice** en su línea de estado, en
rojo: `NOT SAVING · DECISIONS WILL BE LOST ON RESTART`.

---

## 6. Archivos

**Sin commit.** Todo está en el árbol de trabajo sobre `507e30c`. No he
commiteado a propósito: el árbol está compartido con Q8
(`mission_mts6nu8pct7mqctr`), que tiene trabajo en vuelo en varios de los
mismos archivos, y un commit se llevaría por delante su estado a medias. Los
archivos están listados abajo para que se pueda commitear cuando el operador
quiera y con el alcance que quiera.

**Nuevos (9), todo el peso de la sección:**

| Archivo | Líneas | Qué es |
|---|---:|---|
| `src/shared/improve.ts` | 640 | tipos, validación, deduplicación, `dueForReview`, el prompt, el traspaso a misión, `redact` |
| `src/hub/improve.ts` | 567 | `UsageMeter`, `ImproveStore` (disco), `buildDigest`, el reloj |
| `src/agents/tools-improve.ts` | 185 | las tres herramientas MCP |
| `src/ui/hud/improve.ts` | 475 | la sección |
| `src/ui/styles/improve.css` | 279 | su color y su forma |
| `test/improve.test.ts` | 476 | 21 pruebas de las piezas, con reloj falso |
| `test/improve-hub.test.ts` | 241 | 7 pruebas de extremo a extremo contra un hub real |
| `test/hud-improve.shots.ts` | 283 | arnés visual de la sección |
| `docs/AUTOMEJORA.md` | 195 | documento de referencia |

**Ediciones quirúrgicas, todas aditivas y en puntos únicos:**

| Archivo | Qué añadí |
|---|---|
| `src/shared/protocol.ts` | `ServerFrame` `t:'improve'`; `ClientFrame` `improve:get/run/act/seen/send/config` |
| `src/hub/server.ts` | `improveWire()`, `improveAct()`, `improveSend()`; los seis `case`; `improveChanged` en las deps de autonomy; `onTool`; el contador `ui:<frame>` |
| `src/hub/autonomy.ts` | pieza F: crea `improve`, lo expone en `AutonomyApi`, lo para en `stop()`; `improveChanged?` en las deps |
| `src/hub/mcp.ts` | gancho `onTool?(name, ok)` |
| `src/agents/tools.ts` | `improve?` en `CeoContext`; `...IMPROVE_TOOLS`; el despacho en el `default` |
| `src/agents/context.ts` | `improve` en el contexto que construye el hub |
| `src/collector/briefs.ts` | las tres herramientas, nombradas en el brief de CAPCOM |
| `src/ui/main.ts` | import del CSS, `mountImprove`, `openImprove`, `⌥I`, dos ganchos `__orca` para el arnés |
| `src/ui/console.ts` | `openImprove()` |
| `src/ui/store.ts` | `improve`/`improveVerdict`, `putImprove()`, evento `{k:'improve'}` |
| `src/ui/net/client.ts` | `case 'improve'` y seis helpers |
| `src/ui/prefs.ts` | `improveFolded` |
| `src/ui/hud/command.ts` | `/improve` y `/automejora` |
| `src/ui/gfx/sigil.ts` | `sigilRows()` (export nuevo, nada modificado) |
| `DESIGN.md` | la fila `--auto` en la paleta y la sección «AUTOMEJORA» |
| `test/visual.ts` | `orcaToken()` exportada y los dos ganchos en `OrcaHook` |

**No toqué** `src/ui/hud/missions.ts`, `src/ui/hud/mission-status.ts`,
`src/hub/missions.ts` ni `src/ui/styles/hud.css` — los exclusivos de Q8.
Verifiqué antes y después de cada edición que su trabajo seguía en pie.

---

## 7. Pruebas y resultados

Todo lo de abajo se corrió y esto es lo que salió. No he vuelto a correr nada
para escribir este informe.

**`npm run typecheck`** — limpio.

**`npm test -- improve` → 28/28 pasan.** Dos suites:

`AUTOMEJORA` (21, piezas con reloj falso, sin hub):

1. a "measured" proposal without measurements is refused, and so is a hypothesis without one
2. an invented impact is not stored, and a graded one is
3. a credential inside a proposal never reaches disk
4. the same idea twice is one row, one notification, and it survives a dismissal
5. a title says which idea it is even when the words move around
6. the board survives a restart, and a snooze that ran out is open again
7. one notification per proposal: seen once, never new again
8. a proposal becomes a mission exactly once
9. the operator answer lands in the thread and travels with the handoff
10. the clock says which condition is missing, one at a time
11. the daily ceiling holds even when everything else says go
12. the reviewer spends one CAPCOM turn, and not a second until it is answered
13. a review nobody answers expires instead of switching the section off forever
14. a busy or absent CAPCOM is never interrupted by the clock
15. `ORCA_IMPROVE=0` is a real off switch, manual run included
16. a manual run skips the clock and the signal, but not a live CAPCOM
17. the telemetry is counts and codes: no paths, no transcripts, no secrets
18. `report_improvements` files, and says exactly why it refused a draft
19. without the section mounted the tools say so instead of throwing
20. the board is pruned from the closed end, never from what is still open
21. a duplicate is found by key first and by title second

`AUTOMEJORA · hub` (7, hub **real** levantado en proceso, hablado por el mismo
socket websocket que usa la consola):

1. the board travels the protocol with the reason the clock is waiting
2. SEND opens a real mission carrying the proposal, and never a second one
3. a refused SEND leaves no mission behind
4. answering keeps the exchange on the proposal, with or without CAPCOM
5. the limits the operator sets outlive the hub, and so does a dismissal
   *(apaga el hub, lee `improve.json` de disco, lo vuelve a levantar)*
6. the telemetry counts what the console asks for, and only the frame type
7. `report_improvements` reaches the board through the hub's own MCP endpoint
   *(POST real a `/mcp`, JSON-RPC `tools/call`)*

**`npm test -- --changed` → 826/826 pasan, sin suites rotas.** Es el conjunto
que el grafo de imports selecciona para todo lo tocado (mío y de Q8). Incluye
`capcom`, que exige que el brief nombre **todas** las herramientas de
`CEO_TOOLS`: falló al añadir las tres nuevas y pasa desde que las documenté.
También `autonomy`, que falló al montar la pieza F con un directorio no
escribible y pasa desde que el almacén degrada en vez de reventar.

**`npx tsx test/hud-improve.shots.ts` → pasa.** Arnés visual: hub real, flota
sintética, consola real en Chromium a 1440×900 @2x. No sólo fotografía,
**comprueba**: que `--auto` existe y no es la lima, que la cabecera lo lleva,
que el sigilo **tiene píxeles encendidos** (no que exista el `<canvas>`), que
la barra de una medida es continua y la de una hipótesis es
`repeating-linear-gradient`, que la ficha tiene `clip-path`, que las abiertas
van antes que las cerradas, que la novedad se marca y las leídas no, que los
medidores salen sólo con fundamento, que la cuenta dice `1 NEW`, que al abrir
una hipótesis sale `HYPOTHESIS · NOT MEASURED` y **no** `EVIDENCE · MEASURED`,
que al abrir una medida salen sus cifras citadas, que están las cuatro
acciones, que una enviada enseña `OPEN MISSION` y **no** `SEND TO CAPCOM`, que
la conversación se conserva, la geometría contra mástil/reloj/misiones/radar, y
el pliegue con su pref. `assert.deepEqual(errors, [])`: cero errores de página.

---

## 8. Evidencia visual

Escritas por la corrida del arnés, en `test/shots/`:

| Ruta | Qué se ve |
|---|---|
| `test/shots/hud-improve.png` | la consola entera: misiones a la izquierda, AUTOMEJORA a la derecha con cinco fichas, el radar libre |
| `test/shots/hud-improve-open.png` | una ficha abierta: evidencia citada, detalle, caja de respuesta, `SEND TO CAPCOM` / `LATER · 3D` / `DISMISS` |
| `test/shots/hud-improve-folded.png` | plegada: sigilo, `AUTOMEJORA`, `1 NEW`, `UNFOLD` |
| `test/shots/hud-improve-setup.png` | los límites: `EVERY 6H`, `MAX 4/DAY`, `MIN SIGNAL 40` |

Las miré una a una. Lo que enseñan y confirmé a ojo: el violeta se lee como
otra cosa junto al lima del panel de misiones sin competir con él; la barra
discontinua de la hipótesis se distingue de la continua a tamaño real; la
ficha enviada lleva el borde lima de «esto ya es trabajo»; el punto de novedad
está y no parpadea. Dos defectos salieron de mirarlas y de la corrida, y los
dos están arreglados: el cuerpo del panel no encogía (faltaba `min-height: 0`,
así que la lista imponía su altura, el panel se salía de la pantalla y las
fichas de abajo eran inalcanzables con la barra de scroll puesta), y el panel
pisaba el radar por seis píxeles.

---

## 9. Estado de integración y activación

- **Integrado y activo por defecto** en cuanto arranca el hub: la pieza F se
  monta en `createAutonomy`, el reloj empieza a mirar y los contadores empiezan
  a contar. No hace falta ningún paso de activación.
- **La primera revisión no ha ocurrido todavía**, y es correcto: con el hub
  recién arrancado no hay `40` señales acumuladas ni han pasado las 6 h. El
  panel lo dice (`WAITING FOR SIGNAL · n/40`). Se puede forzar con `REVIEW NOW`.
- **La consola pide el tablero al montar** (`improve:get`) y a partir de ahí el
  hub empuja `t:'improve'` cuando cambia. Sin propuestas la sección dice
  `NO REVIEW HAS RUN YET · … OR PRESS REVIEW NOW`, que es un estado distinto de
  «no hay nada que proponer».
- **CAPCOM ya sabe usarlo**: las tres herramientas salen en `tools/list` de
  `/mcp` (probado con un POST real) y están en el brief, así que una sesión
  nueva o recién rotada las conoce desde su primer turno.
- **Coordinación**: Q8 y yo repartimos archivos por mensaje antes de tocar
  nada; su panel quedó a la izquierda y el mío a la derecha, y el arnés lo
  comprueba. `--changed` en 826/826 con las dos partes en el árbol.

---

## 10. Limitaciones, dichas

1. **No he lanzado una revisión real contra el CAPCOM vivo.** Gastaría un turno
   del operador sobre la flota real. La entrega del prompt está cubierta por
   pruebas con `sayToCapcom` inyectado (una comprueba que se gasta exactamente
   un turno y ni uno más) y por la suite de hub. La primera de verdad la
   dispara el operador con `REVIEW NOW`. **La calidad de las propuestas no está
   medida**: depende de CAPCOM, y no la he visto.
2. **El aviso suena con el clip `artifact` existente.** No generé uno propio:
   eso pide `tools/sfx-gen.mjs` y la API de ElevenLabs, y gasta dinero. Un pack
   futuro puede darle voz propia sin tocar código.
3. **Hallazgo aparte, NO arreglado (fuera de encargo):** `sigilHTML()` no pinta
   nada, nunca. Dibuja las celdas como sombras **exteriores** de su propia
   caja, y una sombra exterior se recorta dentro de la caja del elemento; con
   las 25 celdas cayendo dentro de 1 em no queda nada visible. Lo comprobé en
   el navegador. Afecta al rótulo de squad (`src/ui/field/field.ts:916`).
   AUTOMEJORA pinta el suyo en lienzo con `sigilRows()`, que añadí a
   `gfx/sigil.ts`; el rótulo de squad lo dejé como estaba.
4. **Para Q8:** `test/hud-missions.shots.ts` no ve flota en este entorno por dos
   causas ajenas a los dos: el hub escucha en `0.0.0.0` y ahí exige token
   también a localhost (hace falta `?k=$(cat ~/.orca/token)`; exporté
   `orcaToken()` de `test/visual.ts` para eso), y los agentes de
   `test/fake-collector.ts` no traen `origin`, así que `agentOrigin()` da
   `'unknown'` y la pref por defecto `origin: 'orca'` los esconde todos
   (síntoma: `LINK UP`, `QUEUE 3`, `stats().agents === 0`). Mi arnés no depende
   de la flota y por eso pasa. Se lo dije por mensaje.
5. **Alcance:** la sección no implementa nada por su cuenta y no hay ningún
   camino por el que pueda hacerlo. Es deliberado y está escrito en el prompt,
   en la descripción de la herramienta y en el brief.

---

## 11. Cómo verificarlo

```
npm run typecheck
npm test -- improve                  las dos suites (28)
npx tsx test/hud-improve.shots.ts    la sección, fotografiada y comprobada
```

Filtros que cubren esta entrega: `improve`, `capcom`, `autonomy`.
