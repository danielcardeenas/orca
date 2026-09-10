# AUTOMEJORA — ORCA mirándose a sí misma

> Informes de entrega: la sección en
> [`AUTOMEJORA-ENTREGA.md`](AUTOMEJORA-ENTREGA.md), el agente revisor en
> [`AUTOMEJORA-REVISOR.md`](AUTOMEJORA-REVISOR.md).

Una sección aparte de la consola, con forma, color y aviso propios, en la que
ORCA revisa **el instrumento** en vez de la flota: cómo se está usando la
consola y CAPCOM, qué estorba, qué cuesta de más, y qué se podría hacer mejor.
La revisión **propone**; lo que convierte una propuesta en trabajo es una
decisión del operador.

## Por qué es una sección y no una ventana más

Todo lo demás que hay en el campo habla de agentes. Una propuesta sobre la
consola leída con el vestido del panel de misiones pasa por trabajo de un
agente, y es exactamente el malentendido que hace que nadie la lea. Por eso la
sección tiene:

- **Color propio.** `--auto` (`#b47cff`), un violeta que no existe en ninguna
  otra parte de ORCA. En este console el color es significado y todos los que
  hay hablan de agentes: lima vivo, ámbar *te necesita ahora*, rojo brecha,
  cian CAPCOM, azul esperando a otro. Ninguno podía prestarse sin mentir —
  menos que ninguno el ámbar, que significa un agente PARADO esperando a una
  persona, y una propuesta no para a nadie.
- **Forma propia.** Fichas con el mordisco del tile en la esquina contraria
  (arriba a la izquierda) y una barra en el borde izquierdo. La barra es
  **continua** si la propuesta se apoya en mediciones y **discontinua** si es
  una hipótesis: la textura dice de qué está hecha la idea antes que la
  etiqueta, igual que la trama de un tile dice qué runtime corre dentro.
- **Aviso propio, una sola vez.** Cuenta en la cabecera, punto en la esquina de
  la ficha, un paso lateral de la sección y un sonido. Nada de eso vuelve a
  ocurrir por la misma propuesta. Se apaga al ABRIR la ficha, que es cuando de
  verdad se ha visto. Nada se abre solo: en ORCA lo único que puede reclamar a
  un humano por su cuenta es un agente parado.

Vive arriba a la derecha bajo el mástil (`hud/improve.ts`), deja libre el
rincón del radar y el panel de misiones, se pliega a su cabecera y el pliegue
se recuerda. `⌥I` y `/improve` la despliegan y la traen a la vista.

## Qué es una propuesta

En el orden en que un operador decide:

| | |
|---|---|
| resumen | Una o dos frases. Lo único que se lee sin abrir nada. |
| motivación | `evidence`: cifras **medidas**, citadas como vinieron. Obligatorio en `kind: observed`. |
| hipótesis | Lo que se está suponiendo. Obligatorio en `kind: hypothesis`. |
| detalle | Lo largo, plegado. Accesible, no delante. |
| pregunta | Lo que sólo el operador puede decidir, cuando cambiaría la propuesta. |
| impacto / esfuerzo | Dos medidores de tres celdas, **sólo si hay fundamento**. |

**La creatividad no está limitada a lo medible.** Una consola que sólo mejora
lo que ya sabe contar no llega nunca a lo que todavía no hace, así que se piden
explícitamente ideas que los datos no sostienen — capacidades nuevas, otra
forma, una corazonada sobre qué confunde. Van marcadas `hypothesis` y con la
suposición escrita. Lo que no se admite nunca es una medición inventada:
`normalizeDraft` rechaza una propuesta `observed` sin cifras y una
`hypothesis` sin hipótesis, con el motivo, para que CAPCOM lo corrija en el
mismo turno. **`impact` y `effort` son opcionales a propósito**: el operador
ordena por ellos, y una estimación inventada le hace ordenar mal.

## Estados y acciones

`open` · `snoozed` (vuelve sola al vencer) · `dismissed` · `sent` · `completed` ·
`archived`. Los dos últimos no los pone el operador desde el tablero: los pone
la **misión** (ver [Lo que la misión le devuelve](#lo-que-la-misión-le-devuelve)).

- **REPLY** — contesta en el hilo de la propuesta *y* le pega el turno a CAPCOM
  con la respuesta, que contesta con `note_improvement`. La conversación entera
  se conserva y viaja con la propuesta si acaba en misión.
- **LATER · 3D** — pospone. Una semana entierra; un día no descansa.
- **DISMISS** — descarta. Se **conserva**: es lo que impide que la siguiente
  revisión la vuelva a proponer.
- **REOPEN** — la devuelve. No para una que ya es misión (enviada, terminada
  o archivada): una misión se reabre desde su ventana, no desde aquí.
- **IMPLEMENT** (hasta el 2026-09-09, `SEND TO CAPCOM`) — lo único de la
  sección que produce trabajo. Abre una misión normal titulada `AUTOMEJORA · …`
  con la propuesta entera dentro (resumen, evidencia, hipótesis, detalle y la
  conversación), deja la propuesta atada a ella (`missionId`, con `OPEN
  MISSION` en su sitio), y **lanza un agente propio de ORCA como líder de esa
  misión** sobre el repositorio de ORCA (`ImproveApi.implement`, con el brief
  de `implementerBrief`: qué implementar, cómo se verifica aquí —`npm run
  typecheck`, `npm test -- --changed`— y que su último mensaje es el informe).
  El líder es **FORGE**, coordinador especializado por propuesta aprobada:
  asigna, sigue, resuelve bloqueos operativos, verifica y consolida. **CAPCOM
  conserva control final, decisiones de seguridad, cierre y publicación**.
  FORGE usa los contratos existentes de misión y squad, sin estados propios.
  Su aprobación queda como evento de sistema, no como pregunta pendiente a
  CAPCOM. El squad se vincula antes del spawn. Se rechazan envíos repetidos,
  ids inválidos o ya ocupados y propuestas descartadas o aún pospuestas.
  Líder e hijos usan permisos `auto` para trabajo rutinario y escalan acciones
  elevadas o ambiguas a CAPCOM; terminar un squad `forge-…` no dispara
  el publicador automático. El detalle del flujo y sus límites está en
  [FORGE](FORGE.md).
  Si el agente no se puede lanzar —el repo de ORCA no es un proyecto de la
  flota, o no hay máquina— la misión queda escrita con una línea de ORCA que
  dice por qué, y la consola lo avisa; escribirle a esa misión va a CAPCOM,
  porque no tiene líder.

## Lo que la misión le devuelve

Hasta el 2026-09-10 el enlace `missionId` era de ida: IMPLEMENT lo escribía y
nadie volvía a mirarlo. Una misión que CAPCOM cerraba con `report_mission`
dejaba la propuesta en `sent` para siempre, y una que el operador archivaba
desde su ventana dejaba en el tablero una fila viva de un trabajo que el panel
de misiones ya no enseñaba: dos paneles diciendo cosas distintas del mismo
hecho, y trabajo terminado que parecía pendiente.

Ahora la propuesta copia lo que su misión dice, con una sola regla
(`linkedStatus` en `shared/improve.ts`):

| La misión está | La propuesta pasa a |
| --- | --- |
| `active` o `failed`, sin archivar | `sent` |
| `completed`, sin archivar | `completed` |
| archivada, acabara como acabara | `archived` |

Y en las dos direcciones: reabrir la misión (escribirle) la devuelve a `sent`,
desarchivarla la devuelve a lo que diga su estado. Cada cambio deja una línea
`system` en la conversación de la propuesta (`Mission completed.`, `Mission
archived: …`, `Mission restored from the archive.`, `Mission reopened.`), que
es donde el operador lee qué pasó.

Dónde ocurre: `ImproveStore.syncMission`, llamado desde el `changed` del
`MissionStore` en el hub —el mismo punto que publica la misión a las consolas—
y `syncMissions` una vez al arrancar, para lo que les pasó a las misiones
mientras el hub no estaba (o antes de que supiera contarlo: así se pusieron al
día las dos propuestas huérfanas que motivaron esto). Sólo toca propuestas
enlazadas a esa misión y ya en estado de misión: una descartada no resucita
porque alguien escriba en la misión, y una `failed` sigue en `sent`, porque
sigue siendo una misión abierta en el otro panel.

En el tablero, una `completed` sigue llevando la marca de misión (la barra lima
y OPEN MISSION) y dice `DONE` en la fila; una `archived` no se enseña, ni
desplegando las cerradas, que es lo que evita dos versiones del mismo trabajo.
`list_improvements` las devuelve si se le pide `status: completed | archived`.

## Deduplicación

Cada propuesta tiene una **clave** de idea. La elige quien reporta —se le pide
reutilizar la de una propuesta abierta— y si no, sale del título normalizado.
`findDuplicate` mira primero por clave y luego por título normalizado, y mira
**todas** las propuestas, descartadas incluidas: descartar algo y que vuelva a
la mañana siguiente es la forma más rápida de que nadie mire la sección. Una
repetida sube `raised`, refresca evidencia e impacto/esfuerzo, **no cambia el
estado** y **no vuelve a avisar**.

## El agente revisor

**Cada revisión es un agente temporal, no un turno de CAPCOM.** ORCA lo lanza
por el camino normal de spawn: aparece en el campo, tiene callsign, estado,
coste y ventana, hace su trabajo, archiva y termina.

La diferencia no es de implementación, es de lo que el operador puede ver y
hacer. Un turno de CAPCOM es invisible mientras dura —no se sabe si está
pensando, cuánto lleva, cuánto ha gastado ni cómo pararlo— y compite por el
contexto del mando con todo lo demás que la flota le está pidiendo. Un agente
se mira, se vuela hasta él, se abre su ventana, se le pone presupuesto y se le
para. Y cuando falla, falla como falla un agente: visiblemente.

**Cómo se lanza.** `spawn` con `parentId: null` (no es de nadie; colgarlo de
CAPCOM lo metería en el despertador y costaría un turno por revisión, que es lo
que esta arquitectura vino a quitar), `worktree: false` (no va a escribir), y
`review: true`, que es lo que le cambia dos cosas **en la máquina**:

- le pone `orca-improve` en el PATH, su único canal para archivar;
- le **quita** las herramientas de edición (`--disallowedTools Edit Write
  NotebookEdit MultiEdit`). Es una capacidad retirada, no una instrucción: un
  modelo atascado usa la salida que ve.

**Dónde corre.** En el repositorio de ORCA, que es lo que va a leer. Se
encuentra solo (`ORCA_ROOT`, la raíz del propio código) entre los proyectos de
la flota; `ORCA_IMPROVE_PROJECT` lo nombra por id, código, nombre o ruta. Sin
ninguno de los dos no se lanza nada y el panel dice por qué.

**Su identidad en el campo.** Runtime 8 en el shader: **línea violeta
permanente** y **sigilo violeta**, igual que CAPCOM lleva la suya cian. Es una
IDENTIDAD, no un estado: el color del cuerpo y la banda del borde izquierdo
siguen diciendo lo que le pasa de verdad, así que un revisor bloqueado se ve
ámbar dentro de un marco violeta y uno muerto se ve rojo. La consola sabe quién
es revisor leyendo el TABLERO (`reviewerIds`), que ya viaja entero y guarda las
últimas 40 revisiones: no hizo falta un `role` nuevo por el collector, el hub y
el protocolo para decir lo que esto ya dice.

**Estados de una revisión**, y ninguno es «desconocido»:

| | |
|---|---|
| `launching` | se pidió el spawn; todavía no hay agente que nombrar |
| `running` | el agente existe y está en ello |
| `reported` | archivó propuestas — **el único final que cuenta como revisión hecha** |
| `ended` | el agente terminó **sin** archivar nada |
| `failed` | el spawn falló, o el agente murió |
| `cancelled` | el operador la paró |
| `expired` | 45 minutos sin cerrarse de ninguna otra forma |
| `overbudget` | cruzó su techo de tokens y ORCA lo paró |

`ended` y `reported` son distintos a propósito: un agente que termina no
demuestra que haya propuesto nada, y decir «revisión completada» cuando no llegó
ni una línea sería la clase de resultado falso que hace inútil un panel que
corre solo. Lo que cierra una revisión es `endedAt`; archivar **no** la cierra,
porque el brief le dice al revisor que corrija lo rechazado y lo vuelva a
mandar, y mientras tanto sigue gastando.

**Una y sólo una.** El sitio se reserva ANTES de pedir el spawn
(`beginReview` deja la revisión en `launching`), así que dos ticks no pueden
lanzar dos revisores aunque el spawn tarde. Y **no hay bucle posible**: lo que
dispara una revisión son los contadores de la consola y de CAPCOM, que un
revisor no toca.

**Nada se queda colgado, y nada se queda vivo.** Un barrido cada 20 s y al
arrancar cierra lo que ya no puede terminar bien: pasó el reloj de pared (y
entonces también se PARA al agente), el hub se reinició y el agente ya no está
en el mundo, o terminó y el evento se perdió.

Y cierra también lo que **terminó sin decirlo**. Medido en la primera revisión
real: un agente de Claude Code **no termina solo** — acaba su turno, pasa a
`idle` y espera otro prompt que nadie le va a mandar. Un revisor `idle` durante
`REVIEWER_IDLE_MS` (un minuto, el mismo asentamiento que usa `wake.ts`, porque
un CLI pasa por `idle` entre dos herramientas) se da por terminado: se cierra la
revisión —`reported` si archivó, `ended` si no— **y se para al agente**. Sin
esto, un revisor que ya había entregado seguía siendo una sesión viva hasta el
reloj de pared: el «agente permanente» que esta sección promete no dejar.

**Decidir cómo acabó ≠ soltar el sitio.** `outcomeAt` es lo primero —se pasó
del techo, se le acabó el reloj, el operador la paró, archivó y se quedó
quieta—; `endedAt` es lo segundo, y **sólo lo pone la confirmación de que el
agente se fue**: terminal, o fuera del mundo. **No hay ningún plazo que suelte
el sitio.** Si el `stop` falla se reintenta acotado (`STOP_ATTEMPTS` = 5, con
espera 20 s · 40 s · 80 s · 160 s · 320 s) y agotarlos tampoco lo suelta: la
sección se queda bloqueada **y lo dice**, con los intentos y desde cuándo. Un
bloqueo visible es un problema que alguien puede mirar; dos revisores a la vez,
no. Reintentar un `stop` no le da turnos a nadie: no hay bucle de gasto.

**Presupuesto.** Ver §«Lo que cuesta».

**El tablero llega y se vuelve a pedir.** La sección lo pide al montar **y en
cada reconexión** —un hub reiniciado no empuja nada— con reintento acotado
(700 ms · 1,5 s · 3 s · 6 s · 12 s) y sólo mientras hay enlace. Sin enlace no
gasta intentos: espera al evento. Lo que no se pudo traer se DICE (`COULD NOT
READ THE BOARD`, con `TRY AGAIN`; `NO LINK · SHOWING THE LAST BOARD`), y lo que
ya se sabía no se borra. Leer el tablero es `improve:get` y nunca lanza una
revisión.

**En la consola.** Mientras hay revisión en vuelo, la sección enseña una fila
con el punto de su estado real, el callsign (pulsable: vuela la cámara y abre
su ventana), la palabra de su estado, cuánto lleva, cuánto ha gastado de cuánto,
y `STOP`. Una propuesta abierta dice `PROPOSED BY <callsign>` con el mismo
camino de vuelta. En un teléfono la fila entra en la hoja de la barra de
secciones y es **el único** camino hasta el revisor: no hay `⌥I` ni ventana que
abrir a mano.

## Lo que cuesta

Dos ejes, y **no se deducen el uno del otro**:

- `perDay` (4 de fábrica) limita cuántas revisiones **automáticas** ocurren en
  24 h. No ata a la ejecución manual, y no debe: el operador pulsa REVIEW NOW
  cuando quiere.
- `budgetTokens` (400.000 de fábrica) es el techo de **cada** revisión.

Un techo diario repartido entre revisiones sería un presupuesto que encoge
según la hora del día, y una revisión lanzada a última hora no puede valer menos
que la de por la mañana.

### El techo es un FRENO, no un muro

**Multiplicar los dos no da un techo de gasto diario, y decir que sí lo da sería
mentir.** Medido en la primera revisión real (`rev_mtschaq0u83g1or2`,
2026-09-08): el revisor cruzó los 400k en menos de un minuto y llegó a marcar
1,1M antes de que nadie lo parara. Tres razones, y ninguna se arregla subiendo
el número:

1. **La medida llega tarde y da saltos.** El consumo se deriva del transcript
   que el collector relee; en esa misma sesión la cifra pasó por 201k, 1.116.804
   y 622.319 antes de asentarse en el cierre. Nadie frena en un punto que
   todavía no ha visto.
2. **Frenar es mandar un comando.** El `stop` viaja al collector y puede tardar
   o fallar.
3. **Una llamada a un modelo no se parte por la mitad.** Un solo turno con
   mucho contexto ya gasta más que el resto de la pasada.

Lo que **sí** garantiza ORCA: mira el consumo del revisor en cada tic (20 s) **y
en cada cambio de estado suyo**, que es cuando su gasto acaba de moverse; en
cuanto lo ve por encima del techo, **lo para y cierra la revisión como
`overbudget`**, con las cifras en la nota. El panel enseña `STOPPED OVER BUDGET`.

El techo se aplica además con el **libro de presupuestos del hub**
(`budgets.set({kind:'agent', ref})`, o `setPendingByShortId` mientras la sesión
no ha aparecido), para que el revisor se vea y se frene como cualquier otro
agente. Ese libro es también un freno por muestreo, no un muro: por eso la
sección tiene el suyo encima y no delega la cuenta.

En **tokens** y no en dólares porque el eje del dinero está apagado salvo
`ORCA_BUDGET_MONEY=1`, y un presupuesto que casi nunca se evalúa no es un
presupuesto. `SETUP` lo cambia en cinco pasos (100k · 200k · 400k · 800k · 2M) y
`ORCA_IMPROVE_BUDGET_TOKENS` fija el inicial.

## Cuándo se revisa

Un tic cada minuto que sólo lee memoria y sale por la primera condición que
falla. Se pide un turno de CAPCOM únicamente cuando pasan las cinco, y el panel
enseña cuál falta (`dueForReview`):

| Condición | Lo que dice el panel |
|---|---|
| no pausada | `PAUSED BY THE OPERATOR` |
| ninguna revisión en vuelo | `A REVIEW IS IN FLIGHT · 12m AGO` |
| hay sesión CAPCOM | `NO CAPCOM SESSION TO ASK` |
| ha pasado `everyMin` (6h) | `NEXT IN 3h` |
| bajo el tope diario (4) | `4 REVIEWS IN 24H · AT THE DAILY CEILING` |
| hay `minSignal` (40) gestos nuevos | `WAITING FOR SIGNAL · 12/40` |
| CAPCOM no está en mitad de un turno | `CAPCOM IS MID-TURN` |

`REVIEW NOW` se salta el reloj, la señal y el tope —el operador ya decidió— pero
no un CAPCOM vivo, que no es una preferencia. `SETUP` cambia los tres límites y
`PAUSE` para la sección entera; todo se guarda. `ORCA_IMPROVE=0` es el
interruptor duro (ni reloj ni ejecución manual);
`ORCA_IMPROVE_EVERY_MIN`, `ORCA_IMPROVE_PER_DAY`, `ORCA_IMPROVE_MIN_SIGNAL` y
`ORCA_IMPROVE_PAUSED` son sólo los valores iniciales.

Una revisión pedida queda `pending` y **caduca a los 45 minutos**: sin eso, la
primera que se pierde —CAPCOM rota, muere, o no llama a la herramienta— apagaría
la sección para siempre.

**Por qué a CAPCOM y no a un worker.** CAPCOM ya tiene delante lo que hay que
revisar: la flota, el diario, las misiones y las herramientas. Un worker
costaría una sesión entera, un worktree y un arranque en frío para acabar
leyendo lo mismo.

## Telemetría

Mínima, existente y sin contenido. Dos fuentes, ninguna nueva:

- **El diario** (`hub/journal.ts`, `stats()` de 24h): lanzamientos por origen,
  done/dead, coste total y medio, duración media, escalaciones —quién las
  contestó y cuánto esperaron—, rotaciones de CAPCOM, aterrizajes, y lo mismo
  por proyecto usando su **código** (`AX`).
- **Contadores de uso** (`UsageMeter`): `mcp:<tool>` cada vez que CAPCOM llama
  una herramienta, `ui:<frame>` cada vez que la consola pide algo al hub, y
  `gesture:<familia>:<detalle>` cada vez que el operador **hace** algo en la
  interfaz que al hub no le pide nada: abre una ventana (`win:agent`,
  `win:terminal`, `win:gallery`…), despliega una sección (`hud:sheet-improve`,
  `hud:missions-unfold`), usa un atajo (`key:alt-c`, `key:f`) o vuela la
  cámara (`fly:agent`, `fly:point`). Un **nombre y una cuenta**, nunca los
  argumentos: ni qué agente, ni qué archivo. Es lo que enseña qué se usa de
  verdad y qué no se encuentra.

  Los gestos se acumulan en la consola y salen en lotes cada 15 s (o antes,
  con 50 acumulados) en una trama `gestures` sin ack (`src/ui/gestures.ts`).
  Las familias son una **lista cerrada** (`win`, `hud`, `key`, `fly`) y cada
  una tiene un techo de 24 nombres distintos; lo que pasa del techo se funde
  en `<familia>:other`, para que un cliente con un fallo no llene los 200
  contadores del tablero y deje fuera a las herramientas de CAPCOM
  (`src/shared/gestures.ts`). El informe del revisor los enseña en tres
  líneas: los más tocados, el total por familia (con los ceros) y **qué
  clases de ventana no se abrieron ni una vez** en la ventana de 24 h.

Lo que **no** entra en un informe: rutas, briefs, transcripciones, preguntas o
respuestas de nadie, y ningún secreto. Además todo lo que escribe CAPCOM pasa
por `redact` antes de tocar el disco, que es un cinturón sobre los tirantes: no
debería dispararse nunca, pero un token pegado en una propuesta se quedaría en
disco y saldría por el protocolo a cualquier consola conectada.

Dos acumuladores del mismo hecho, porque responden a preguntas distintas:
`usage` es la ventana que se le enseña a la revisión, `signal` es lo ocurrido
**desde** la última y es lo que decide si vale la pena pedir otra. `signal` se
pone a cero al PEDIR la revisión, no al recibirla.

## El canal del revisor

Un agente no tiene socket ni token del hub: tiene un sistema de ficheros. Así
que archivar es dejar un fichero, igual que `orca-tell` y que una escalación.

```
orca-improve report --review <review_id> --file proposals.json
```

1. `bin/orca-improve.mjs` escribe `<proyecto>/.orca/improve/<id>.json` con
   escribir-y-renombrar, y espera.
2. `ImproveDropWatcher` (`collector/improve-drop.ts`) lo recoge, valida forma y
   tamaño, **borra el fichero** y lo sube como `improve:report` con un
   `reportId`. La RUTA no viaja: se queda indexada en el collector, así que un
   hub comprometido no puede elegir dónde se escribe un fichero.
3. El hub comprueba **quién** reporta —sólo el agente de la revisión en vuelo, o
   uno cuyo short id coincida— archiva, y contesta `improve:ack` con el mismo
   `reportId`.
4. El collector escribe `<id>.ack.json` y `orca-improve` lo imprime: cuántas
   entraron, cuántas se fundieron, y **el motivo exacto de cada rechazo**. Un
   motivo es algo que el revisor puede corregir y volver a mandar en el mismo
   turno.

El recibo vuelve siempre, también cuando se rechaza entero: un informe que se
pierde en silencio se lleva por delante la revisión sin que nadie se entere.

## Herramientas de CAPCOM

Quien revisa es el agente, no CAPCOM. Lo que le queda a CAPCOM es el tablero:

- `list_improvements(status, limit)` — claves, estados, cuáles son ya misiones y
  qué contestó el operador.
- `note_improvement(proposal_id, text)` — contestar al operador en un hilo,
  cuando respondió a una pregunta de una propuesta.
- `report_improvements(review_id, proposals[])` — sigue publicada y hace lo
  mismo que `orca-improve`, con la misma validación. La usa un CAPCOM que quiera
  archivar algo por su cuenta; el camino normal es el revisor.

Las tres viven en `agents/tools-improve.ts`, salen por el mismo servidor MCP
que el resto (`/mcp`) y están nombradas en el brief de CAPCOM
(`collector/briefs.ts`), que es lo que la prueba `capcom` exige.

## Dónde vive

| | |
|---|---|
| `src/shared/improve.ts` | tipos, validación, deduplicación, `dueForReview`, el prompt y el traspaso a misión |
| `src/hub/improve.ts` | `UsageMeter`, `ImproveStore` (disco), `buildDigest`, el reloj y el ciclo de vida del revisor |
| `src/shared/gestures.ts` | el vocabulario de gestos: familias, techos, validación del lote, agregado por familia |
| `src/ui/gestures.ts` | el contador de la consola: acumula gestos y los manda en lotes |
| `bin/orca-improve.mjs` | el CLI con el que archiva el revisor |
| `src/collector/improve-drop.ts` | el buzón `<proyecto>/.orca/improve/` |
| `src/collector/shims.ts` | el tercer juego de comandos: el del revisor |
| `src/agents/tools-improve.ts` | las tres herramientas MCP |
| `src/hub/autonomy.ts` | pieza F, montada junto a wake/verify/journal |
| `src/hub/server.ts` | `improve:get/run/act/seen/send/config`, el push `t:'improve'`, los contadores |
| `src/ui/hud/improve.ts` | la sección |
| `src/ui/styles/improve.css` | su color y su forma |

Estado en `~/.orca/hub/improve/improve.json`, escrito con temporal-y-renombrado
como `missions.json`. Si el directorio no se puede escribir, la sección sigue en
memoria y **lo dice** en su línea de estado (`NOT SAVING · DECISIONS WILL BE
LOST ON RESTART`): una sección que acepta decisiones y las pierde en silencio es
peor que una que no existe.

## Verificación

```
npm test -- improve gestures        las suites de la sección y la de gestos
npx tsx test/hud-improve.shots.ts   la sección, fotografiada contra la consola
```

`improve` cubre cuatro suites: `AUTOMEJORA` (las piezas, con reloj falso),
`AUTOMEJORA · hub` (hub real por el socket de la consola), `AUTOMEJORA · agente
revisor` (el recorrido entero contra una máquina real al otro lado del cable:
lanzar, verse, reportar, terminar, fallar, cancelar) y `AUTOMEJORA ·
orca-improve` (el CLI de verdad como subproceso contra el vigilante de verdad).

`hud-improve.shots.ts` escribe `test/shots/hud-improve*.png` y comprueba en el
navegador el color propio, el sigilo pintado, la barra continua contra la
discontinua, el orden abiertas-antes-que-cerradas, los medidores sólo cuando hay
fundamento, la cuenta de novedades, evidencia contra hipótesis al abrir, las
acciones, que una enviada enseñe su misión y no un SEND, que una terminada
diga DONE y conserve la marca de misión mientras la archivada no está ni
detrás del pliegue, la geometría contra mástil, reloj, panel de misiones y
radar, y el pliegue. Se corre solo: `npx tsx test/hud-improve.shots.ts`.

Filtros de cobertura de FORGE: `forge`, `improve`, `missions`, `mission-stall`, `wake`, `spawns`, `publisher`.
