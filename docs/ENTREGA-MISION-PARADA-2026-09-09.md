# La misión que no avanza deja de parecer sana

El 2026-09-09 había dos misiones `active` en el hub. `list_missions` decía de
las dos `awaiting_reply: false`, `unreported_results: 0`; `inspect_mission`
decía `owed: nothing`; el panel decía IN PROGRESS. Ninguna de las dos avanzaba.

- `mission_mttsu2rn5ce3wtce` (iconos de CAPCOM): el envío al worker falló
  porque su máquina estaba desconectada. La misión se quedó activa y nadie
  volvió a mirarla. Al reenviar al día siguiente, el worker confirmó recepción
  y se puso a ello.
- `mission_mttkrjbsapplwtz8` (purge_harness): el `say` al agente 54 se acusó
  como enviado sin ninguna evidencia de que llegara a leerse; prompt antiguo,
  agente en idle. 54 es una sesión `claude` de fondo, sin pane, así que ni
  siquiera se le podía interrumpir. Se transfirió a E4, que sí confirmó.

Este trabajo no toca ninguna de las dos: son la prueba de que el hueco existe,
no el hueco.

## El diagnóstico, con el código delante

No hay una causa raíz. Son cinco huecos independientes que se suman, y por eso
tapar sólo el último —«añadir una alerta de idle»— habría dejado los otros
cuatro donde estaban.

**1. La deuda de una misión sólo mira mensajes.** `shared/missions.ts:missionDebt`
corta en el último mensaje de rol `capcom` y cuenta lo que venga después:
`humans` y `results`. `missionOwed` es exactamente eso. Y todo lo que dice
«pendiente» lee de ahí y de ningún otro sitio: `list_missions` (su
`only_pending`, su `awaiting_reply`, su `unreported_results`),
`inspect_mission` (su `owed`), la sección MISSIONS WAITING ON YOU del
`briefing`, y el recordatorio de `hub/wake.ts:missionReplies`. Un encargo que
nunca llegó no produce ni un `human` ni un `agent`: no hay deuda, luego no hay
nada. La misión estaba sana según la única definición de salud que existía.

**2. Un `send_to_agent` fallido no dejaba rastro fuera del turno de CAPCOM.**
`agents/tools.ts:sendToAgent` hacía `await ctx.dispatch(...)` y devolvía
`{ok:true}`. Con la máquina caída, `hub/server.ts` acusa
`máquina no conectada: <id>`, la promesa se rechaza, y el `catch` general de
`runTool` lo convierte en un error de herramienta. CAPCOM lo ve **una vez**, en
su ventana de contexto. No hay `JournalKind` para envíos (el diario tiene
launch, end, escalation, answer, rotation, landing) y `logEvent` es log, no
estado. En cuanto esa sesión rota o compacta, el fallo deja de existir para el
sistema. Eso es el caso 1, literal.

**3. El acuse de un `say` no es prueba de recepción, y el repo ya lo sabía en
otro sitio.** En `collector/commands.ts:say`, con pane el `ok` significa
«pegado en el pane»; sin pane significa «se lanzó `claude --bg --resume`».
Ninguno de los dos dice que el CLI lo haya leído. `interrupt`, justo debajo,
sí distingue `sent` de `confirmed` y explica en su comentario que ningún
transcript dice que el agente haya leído nada. `say` no distinguía nada. Eso es
el caso 2.

**4. El despertador por agente no vuelve a mirar a quien ya estaba idle.**
`hub/wake.ts:onState` sólo cuenta un fin si `from` es un estado de trabajo y si
el módulo vio a ese agente trabajar; y `idleReported` impide un segundo idle
hasta que vuelva a trabajar. Son dos reglas correctas —existen para que un hub
que reinicia no vomite treinta avisos de agentes que acabaron hace días— pero
juntas significan que **«idle de siempre» no genera ningún evento**. Un agente
que estaba parado cuando le llegó (o no le llegó) el encargo no produce
transición, y sin transición no hay despertador.

**5. Y la consola decía IN PROGRESS.** `ui/hud/mission-status.ts:missionPhase`
devolvía `progress` con cualquier tripulación `alive()`, e `idle` es `alive`.
Ése es el «silenciosamente saludable» que el operador tenía delante, y por eso
tuvo que preguntar si el progreso que veía era cierto.

### La telemetría honesta que sí existía

`collector/derive.ts` mueve `lastPromptAt` sólo cuando el CLI escribe un prompt
humano en su propio transcript, y `updatedAt` es `lastActivityAt`: conversación
real, no el mtime del archivo. `collector/index.ts:diffAgent` no emite patch si
no cambió nada de verdad, así que **un agente quieto no mueve su `updatedAt`**.
Comparar la actividad de un agente contra el momento del encargo dice «no
consta que empezara», que es verificable. «Recibido» no lo es, y no se afirma
en ninguna parte de esto.

## Qué hay ahora

**El encargo se anota.** `CapcomMission.dispatches` guarda, por agente, el
último envío que salió hacia él: cuándo y si llegó a su **máquina**.
`send_to_agent` lo escribe por los dos caminos, y cuando falla escribe además
una línea `system` en la conversación con el motivo que dio el hub — el mismo
gesto que el hub ya hacía en sentido contrario (`Delivery failed: …` cuando no
consigue entregarle a CAPCOM un mensaje del operador). Un envío que sale no
escribe línea: el registro basta, y una conversación con un renglón por cada
empujón deja de servir para leer de qué iba la misión. El resultado de la
herramienta ahora dice explícitamente que `sent` no es `received`.

**`missionStall()`**, en `shared/missions.ts`, junto a `missionDebt` y por la
misma razón: hay tres lectores —las herramientas, el despertador y el panel— y
tres versiones de «esto está parado» acabarían discrepando. Devuelve el motivo,
desde cuándo, y a quién apunta. Cuatro motivos, cada uno con una acción
distinta:

| motivo | qué se sabe |
|---|---|
| `send-failed` | el último envío no llegó a la máquina, y desde entonces no ha pasado nada. Es un hecho: el hub acusó el fallo con su texto. |
| `no-agent` | no queda nadie trabajando y CAPCOM no ha dado cuenta de ello. |
| `no-start` | hay agente vivo y no ha dado señal desde antes del encargo. |
| `no-progress` | trabajó después del encargo, se calló, y nada llegó a la misión. |

Y lo que **no** cuenta como parada, que es la mitad del diseño:

- Lo que ya se debe por otra vía (`missionOwed`): una pregunta del operador sin
  contestar o un resultado sin reportar ya salen en pendientes, con su propio
  reloj. Avisar dos veces del mismo hecho es ruido.
- Un agente `blocked` que no sea de tipo `input`: un permiso, una pregunta o
  una escalación son espera humana o bloqueo ya escalado, y tienen canal propio.
- Un resultado publicado que el operador todavía no ha leído, por los dos
  caminos por los que puede llegar. Si el agente ya no está, la condición de
  `no-agent` no es «no hay nadie», es «no hay nadie **y** CAPCOM no lo ha
  contado»: si publicó, lo que falta es que el operador lo lea, que es el estado
  que el panel ya llamaba WAITING ON YOU. Lo que no tenía nombre es la misión
  que se quedó sin nadie sin que CAPCOM dijera nada — un agente que muere
  callado no deja resultado que reportar, así que tampoco deja deuda.
  Y si el agente **sigue vivo y quieto**, que es lo normal —un CLI que termina
  su encargo se queda en `idle`, no en `done`, porque `done` es que el proceso
  cerró—, lo que le saca de la cuenta es su propia entrega posterior a su
  encargo, ya reportada por CAPCOM.

  Esa segunda mitad faltaba en la primera versión y CAPCOM la encontró
  revisando: con la conversación *human → capcom «assigned» → agent
  «delivered» → capcom «result for review»* y el worker en `idle`, media hora
  después salía `no-progress` diciendo «sin que nada llegara a la misión», con
  el resultado escrito tres líneas más arriba. Lo que resuelve la condición es
  **la entrega de ese agente**, nunca «CAPCOM habló»: si bastara lo segundo, un
  «mandado a WO» sobre un envío que jamás salió volvería a tapar el caso 1, que
  es el silencio original. Y como el encargo se cuenta por agente, un encargo
  nuevo deja atrás la entrega vieja y la misión vuelve a deber progreso.
- Una misión archivada. Archivar es el gesto que ya existía para retirar una
  misión sin perder nada, y hace de pausa explícita: no hizo falta inventar otra.

Los dos motivos que se infieren del silencio esperan un respiro de diez minutos
(`MISSION_STALL_GRACE_MS`, `ORCA_MISSION_STALL_MIN`): un CLI pasa por idle
entre dos llamadas a herramienta, y un worker que acaba necesita un momento
para que su resultado caiga en la conversación. Un envío fallido no pasa por
ahí: no hay nada que inferir.

**El cuarto despertador.** `[MISSION <id> stalled]` en `hub/wake.ts`, con el
motivo en una palabra y la acción literal debajo. Escalera en 1, 30 y 120
minutos desde que la condición empezó, y luego cada dos horas; deduplicado por
`motivo:desde-cuándo` en `wake.json`, así que un hub que reinicia con cada
edición no repite el primer aviso, y si la misión se para por otra razón la
escalera empieza de cero. Sin CAPCOM vivo el aviso espera y **no** se apunta
como dado. A los 45 minutos el operador se entera en su propio feed, lo haya
leído CAPCOM o no.

Se apaga solo, y eso importa tanto como que se encienda: la condición no se
guarda, se recalcula de la flota y de la conversación en cada tick. Actividad
del agente, un reenvío que sale, un resultado que cae, un `report_mission`,
archivar la misión — cualquiera de esas hace que `missionStall` devuelva null y
el aviso deja de existir sin que nadie lo cancele. Lo único que se persiste es
cuántas veces se avisó ya, para espaciarlos.

**Nada se reintenta solo.** El aviso dice qué pasó y qué se puede hacer;
reenviar, reasignar o cerrar lo decide CAPCOM. Repetir una acción externa
porque un reloj lo diga es cómo se manda dos veces el mismo encargo.

**Y se ve.** `list_missions` trae `stalled` en cada fila y `only_pending`
deja de perderlas; `inspect_mission` deja de decir `owed: nothing` y añade
`last_orders` con el último encargo a cada agente y cómo acabó; el `briefing`
tiene una sección MISSIONS ACTIVE WITH NO PROGRESS. El brief de CAPCOM enseña
el prefijo nuevo, los cuatro motivos, que `sent` no es `received` y que ORCA no
reenvía por él.

**En la consola**, una fase más: NOT MOVING. Reusa el ámbar de WAITING ON YOU
—es el mismo hecho, esto necesita a una persona— y se distingue por la palabra
y por la cremallera vacía; darle un color propio habría sido un sexto
significado en una paleta de tres. La fila sigue en el grupo de abiertas y no
cambia de sitio: sólo cambia lo que dice.

## Antes y después

| | antes | después |
|---|---|---|
| envío con la máquina caída | error en el turno de CAPCOM, y nada más | registro en la misión + línea `system` + `[MISSION … stalled] send-failed` al minuto |
| `sent` sin señal de arranque | invisible | `no-start` a los diez minutos, con el motivo y qué mirar |
| misión sin nadie y sin reportar | `owed: nothing` | `no-agent` en pendientes, briefing y panel |
| resultado publicado sin leer, agente ido | WAITING ON YOU | igual: no es un parón, y se dice por qué |
| resultado publicado sin leer, agente vivo en idle | (primera versión: `no-progress`, falso) | no es un parón: entregó y se reportó |
| encargo nuevo tras esa entrega | — | vuelve a deber progreso: `no-start` |
| `inspect_mission` de una parada | `owed: nothing` | `owed: unstick it (send-failed)` + `stalled` + `last_orders` |
| el panel | IN PROGRESS | NOT MOVING · 1H, en ámbar |

## Incertidumbre que queda

Esto **no cubre todo lo que puede dejar una misión parada**, y conviene que se
lea así y no como una red completa.

**Límite explícito.** Una misión a la que CAPCOM contestó y a la que nunca
asignó a nadie es **indistinguible** de una a la que contestó y en la que el
operador aún no ha vuelto a escribir: las dos son «último mensaje de CAPCOM,
sin tripulación», y en ninguna parte del sistema está el hecho «CAPCOM dijo que
iba a lanzar algo». Se tratan como espera humana, que es lo que el modelo de
estados ya dice de ellas, y por tanto **una misión que CAPCOM prometió y nunca
lanzó sigue sin avisar a nadie**. Afirmar lo contrario sería inventar una
intención que nadie midió. Cerrarlo pediría registrar esa intención —un
encargo declarado, no sólo un encargo enviado—, no más heurística sobre lo
mismo.

## Archivos

- `src/shared/missions.ts` — `MissionDispatch`, `CapcomMission.dispatches`,
  `missionStall()`, `MissionCrew`, `MISSION_STALL_GRACE_MS`.
- `src/hub/missions.ts` — `MissionStore.dispatched()`.
- `src/agents/tools.ts` — `sendToAgent` registra y ya no miente; `stallOf`,
  `stallJson`; `list_missions`, `inspect_mission` y `briefing`.
- `src/hub/wake.ts` — `missionStalls()`, sus constantes y su configuración,
  `wm.stalls` en la marca de agua, y el tick.
- `src/collector/briefs.ts` — el cuarto despertador en el brief de CAPCOM.
- `test/mission-stall.shots.ts` — el QA visual de la fase, con aserciones.
- `src/ui/hud/mission-status.ts`, `src/ui/hud/missions.ts`,
  `src/ui/windows/kinds/mission.ts`, `src/ui/styles/hud.css`,
  `src/ui/styles/window.css` — la fase NOT MOVING.

## Pruebas

`test/mission-stall.test.ts` (nuevo, 15 casos) cubre los cuatro motivos, el
respiro, la resolución sola, lo que no cuenta como parada, y el registro del
encargo sobreviviendo a un reinicio del almacén. Todo con `T0` y aritmética: ni
un sleep, ni un reloj real.

En `test/wake.test.ts`, cinco casos con el reloj falso del arnés: el envío
fallido avisa con motivo y acción, el `sent` sin arranque espera al respiro y
avisa una vez, la actividad del agente apaga el aviso y borra su cuenta, sin
CAPCOM no se marca como dado y el operador se entera igual, y la configuración
por entorno se lee y se puede apagar.

En `test/briefing.test.ts`, un caso de punta a punta sobre las tres
herramientas: una misión que no debe ningún mensaje sale en `only_pending`, con
el motivo del hub dentro, `owed` deja de ser `nothing`, `last_orders` trae el
envío fallido, y el briefing la nombra sin nombrar a la sana de al lado.

En `test/mission-status.test.ts`, la fase: el mismo agente vivo da `progress`
sin parón y `stalled` con él, y la fila sigue abierta.

Cuatro de los quince casos de `mission-stall` son del falso positivo que
encontró CAPCOM y de sus bordes: el idle que ya entregó y fue reportado no está
parado; un encargo nuevo posterior vuelve a abrir la deuda; un informe de
progreso de CAPCOM **sin** entrega del agente no silencia nada; y con dos
asignados, el que entregó no tapa al que no —el parón apunta al segundo y sólo
nombra a ése—.

Corrido: `npm run typecheck` limpio, `npm test -- --changed` en 97 suites y
1124/1124, y el QA visual de arriba.
Durante el trabajo el árbol estuvo roto dos veces por ediciones concurrentes
—un literal sin cerrar en `leadPrompt`, que se reparó, y un test de `wake`
contra un contrato nuevo, que su autor actualizó—; ninguna de las dos era de
esta entrega y las dos están verdes.

Sin cobertura automática, de lo que toca esta entrega: `src/ui/styles/hud.css`
y `src/ui/styles/window.css` —no hay suite de CSS, y es lo que el QA visual
mira— y la entrada `stalled` de `ZIP_AT` en `src/ui/hud/missions.ts`, que no
tiene suite propia; es una casilla obligatoria de un `Record<MissionPhase,
number>` y lo que decide es que la cremallera de una fila parada salga vacía,
que es justo lo que se fotografió.

QA visual: `test/mission-stall.shots.ts`, permanente y con aserciones —la
primera versión de esta entrega usó un shot de usar y tirar, que no se puede
revisar—.

    npx tsx test/mission-stall.shots.ts --isolated

`--isolated` no es comodidad: sin él `ensureServers()` comparte ORCA_HOME con
el operador y esto planta misiones. Pone tres delante del panel —parada por
envío fallido, viva con tripulación, y esperando al operador— y comprueba lo
que una foto prueba y un assert de string no: que la parada dice NOT MOVING en
el ámbar de `--amber` (el mismo que WAITING ON YOU, porque es el mismo hecho) y
no en el lima de vivo; que su cremallera se queda en `scaleX` 0, vacía, y la de
la viva en 1; que sigue en el grupo de abiertas y detrás de la que trabaja, sin
saltar al final por estar parada; que la ventana de la misión dice exactamente
lo mismo que el panel; y que no hay un solo error de consola. Deja
`test/shots/mission-stall-panel.png` y `mission-stall-console.png` (los frames
no se versionan, se regeneran con ese comando).

No toca `test/hud-missions.shots.ts`, que lleva otro agente: la fase nueva se
fotografía en su propio archivo para no pisarlo.

Filtros que cubren esta entrega: `mission-stall`, `wake`, `briefing`,
`mission-status`.
