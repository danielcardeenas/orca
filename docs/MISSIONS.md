# Misiones

Lo que hasta hoy se llamó *task* se llama MISSION, arriba y abajo: en la
consola, en el protocolo, en las herramientas de CAPCOM y en el disco. El
vocabulario a medias era el problema — el operador leía «TASK» en el panel,
«mission» en el brief de un worker y `task_id` en una herramienta, para tres
cosas que no eran la misma. Y con el nombre, CAPCOM gana lo que le faltaba:
puede abrir una misión él, en vez de depender del botón de la ventana CEO.

## Qué es una misión

Un hilo en el hub: su conversación, sus agentes, su estado, su fila en el panel.
Sobrevive a que la sesión de CAPCOM se recicle, se archiva y se recupera, y es lo
que el operador abre días después para saber cómo acabó algo. Vive en
`src/shared/missions.ts` (la forma) y `src/hub/missions.ts` (el store en disco).

No confundir con el campo `mission` de un spawn, que ya existía y no ha cambiado:
ése es el brief con el que un worker despierta. Una misión puede tener varios
workers, cada uno con su propio `mission` de spawn.

## El renombrado

| Antes | Ahora |
| --- | --- |
| `src/shared/tasks.ts` | `src/shared/missions.ts` |
| `src/hub/tasks.ts` · `TaskStore` | `src/hub/missions.ts` · `MissionStore` |
| `src/ui/hud/tasks.ts` · `hud/task-status.ts` | `hud/missions.ts` · `hud/mission-status.ts` |
| `CapcomTask` `TaskMessage` `TaskStatus` | `CapcomMission` `MissionMessage` `MissionStatus` |
| `visibleTasks` `archivableTasks` `taskPrompt` | `visibleMissions` `archivableMissions` `missionPrompt` |
| `task:create` `task:archive` `task:purge` | `mission:create` `mission:archive` `mission:purge` |
| frame `{t:'task', task}` | `{t:'mission', mission}` |
| `ceo:say` con `taskId` | con `missionId` |
| `WorldState.tasks` | `WorldState.missions` |
| `store.upsertTask` `selectTask` `activeTaskId` | `upsertMission` `selectMission` `activeMissionId` |
| `prefs.tasksFolded` `capcomTasks` | `missionsFolded` `capcomMissions` |
| CSS `.tasks__*` · `.talk__g.is-task` | `.missions__*` · `.is-mission` |
| `/tasks archive\|restore\|purge` | `/missions …` |
| `NO TASKS` `NEW TASK` `TASK IN CAPCOM` | `NO MISSIONS` `NEW MISSION` `MISSION IN CAPCOM` |
| `journal` campo `taskId` | `missionId` |
| budget scope `'task'` | `'mission'` |

Lo que NO se ha tocado, porque no es el concepto: la tool `Task` de Claude Code
(subagentes, `derive.ts`, `lineage.ts`), los eventos `task_started` /
`task_complete` de Codex, y «task» en su sentido inglés corriente («task
difficulty» en las decisiones de recovery, «the task» en el brief de un squad).
Un `sed` sobre la palabra habría roto las tres cosas.

## Lo que no se puede invalidar

Hay estado en disco de antes del renombrado, y negarle la entrada no lo
renombraría: lo borraría de la vista. Tres compatibilidades, todas de la misma
forma — se lee lo viejo, se escribe siempre lo nuevo:

- **Ids.** `MISSION_ID = /^(?:mission|task)_[A-Za-z0-9_-]{1,100}$/`. Un id
  `task_` guardado sigue siendo válido para siempre; lo que nace hoy nace
  `mission_` (`MISSION_ID_PREFIX`), así que el prefijo viejo sólo puede llegar de
  algo que ya existía.
- **El fichero.** `MissionStore` lee `missions.json`, y `tasks.json` cuando el
  primero no existe todavía. Escribe siempre `missions.json`: la primera
  escritura migra sola y `tasks.json` se queda en disco intacto, como respaldo.
- **La clave del navegador.** `orca.capcom.mission`, con `orca.capcom.task` como
  respaldo de lectura. La primera carga copia la vieja a la nueva y retira la
  vieja, para que la consola no arrastre el vocabulario anterior en cada recarga.

Dos más, del mismo tipo: `[ORCA TASK <id>]` se sigue reconociendo al clasificar
los transcripts de CAPCOM (`ui/windows/talk.ts`), porque los transcripts ya
escritos lo llevan; y el título marcador `New task` cuenta como marcador junto a
`New mission`, o una misión vieja sin título propio se quedaría llamándose «New
task» justo cuando el operador le escribe y debería tomar su nombre.

El journal traduce `taskId` → `missionId` al leer cada entrada (`migrate` en
`hub/journal.ts`): son meses de jsonl acumulado, y sin eso un filtro por misión
no encontraría nada anterior a hoy.

## Los alias de las herramientas MCP

`report_task`, `list_tasks` e `inspect_task` siguen despachando al mismo handler
que sus nombres nuevos, y `task_id` se sigue aceptando donde ahora se llama
`mission_id` (también en `spawn_agent`, `launch_squad`, `set_budget` y
`journal`). No se anuncian por MCP: quien conecta nuevo sólo ve el vocabulario de
hoy.

Existen por una razón concreta y con fecha: hay una sesión de CAPCOM en vuelo con
el esquema viejo en su contexto, y quitárselo de golpe la rompe a mitad de vuelo.
Su brief se reescribe desde `collector/briefs.ts` cuando CAPCOM arranca o rota
(`~/.orca/capcom/CLAUDE.md`), así que **caducan en la primera rotación de CAPCOM
posterior a este cambio**: a partir de ahí ninguna sesión conoce los nombres
viejos y las cuatro líneas del `switch` se pueden borrar.

## `open_mission`

```
open_mission(title, first_message?, project_id?, agent_ids?) → { mission_id, title, status, project, agents }
```

Abre una misión por el mismo camino que el botón NEW MISSION: mismo store, mismo
id, mismo broadcast. El panel la ve aparecer en vivo, se abre igual en la ventana
CEO, cuenta igual contra el tope de cien y se archiva igual. Devuelve el
`mission_id` para pasarlo acto seguido a `spawn_agent` / `launch_squad` y
publicar con `report_mission`.

- `first_message` entra como el mensaje `capcom` que origina el hilo — CAPCOM es
  quien escribe, y un hilo que dijera `human` le devolvería al operador sus
  propias palabras como si las hubiera tecleado ahí. Lleva el código del proyecto
  delante cuando hay uno, para que la misión se lea entera desde su primera línea.
- `agent_ids` adopta agentes YA vivos, que es el caso «esto que ya lancé, ponlo
  en un hilo».
- Se niega sin título, con un proyecto que no existe o con un agente desconocido.

El criterio de cuándo usarla vive en el brief (`collector/briefs.ts`, sección
«When to open a mission»), que es donde CAPCOM lo lee:

- **Abre una misión** para trabajo real en un repo, cualquier cosa de más de un
  paso o más de un agente, y cualquier cosa cuyo resultado el operador vaya a
  querer consultar más tarde.
- **Deja el spawn suelto** para lo trivial y desechable: un smoke test, una
  comprobación de dos minutos, algo que cabe en una línea y nadie vuelve a mirar.
- Si el operador dice «esto como misión» o «sin misión», manda él.

## La pregunta del operador no se queda esperando

Había una asimetría que no se sostenía.

Cuando un **agente** pregunta, el hub despierta a CAPCOM y, si no contesta en 90
segundos, le pasa la pregunta al operador diciendo que CAPCOM no respondió. Hay
reloj, hay escalada y hay constancia.

Cuando el **operador** preguntaba en una misión, su mensaje se entregaba una vez
y se acababa ahí. Si CAPCOM contestaba en la consola y se olvidaba de
`report_mission`, la misión se quedaba en `pending_human` para siempre: visible
en `briefing` y en `list_missions`, y sin nadie mirándola. El 2026-09-08 pasó
tres veces en la misma tarde — una espera de 30 minutos, otra de 23 — y el
operador tuvo que preguntar si el «en progreso» que veía en la consola era
cierto. Lo era.

El tiempo de un agente estaba mejor protegido que el del operador.

### El tercer despertador

`hub/wake.ts` tenía dos prefijos, `[AGENT …]` y `[HEARTBEAT]`. Ahora tiene tres.
Es la misma maquinaria — el mismo tick de 30 s, el mismo router de CAPCOM, la
misma marca de agua en `wake.json` — y no una paralela:

```
[MISSION mission_ab12] "Rediseñar el selector" · the operator has been waiting 23m for a reply
  asked: ¿Puedes empezar por el filtro de estado antes que por el orden?
  reply with: report_mission(mission_id="mission_ab12", text="<your reply>", status="active")
Answering in the console does not close a mission: only report_mission does.
```

Las tres cosas que hacen falta para actuar sin investigar: **qué misión, cuánto
lleva esperando y qué preguntó** — con la llamada exacta debajo, para que
contestar sea copiar una línea.

### Los tiempos, y por qué

| Espera | Qué pasa |
|---|---|
| 4 min | primer recordatorio a CAPCOM |
| 15 min | segundo |
| 45 min | tercero |
| cada 2 h | a partir de ahí |
| 30 min | **el operador** ve en su feed que su pregunta sigue sin respuesta |

**Cuatro minutos el primero.** Una escalación de agente urge a los 90 segundos
porque el agente está *detenido*; aquí no hay nadie parado, así que el reloj
puede ser más largo. Pero no mucho más: un turno de CAPCOM dura minutos, y
avisar por debajo de tres llegaría mientras está escribiendo esa misma
respuesta — la versión ansiosa del problema. Cuatro cae justo detrás de un turno
normal y muy por delante de los 23 y los 30 que el operador esperó de verdad.

**Y luego espaciado.** El primer recordatorio lleva casi toda la información; el
quinto idéntico no lleva ninguna y tapa la pantalla. Es la misma lección que los
trece `[BUDGET 100%]` de la misma tarde, y por eso **varias misiones esperando
son un mensaje, nunca varios**:

```
[MISSION] 3 operator questions are waiting on you, the oldest 30m.
[MISSION mission_c] …
[MISSION mission_a] …
Answer each with report_mission. Answering in the console does not close a mission.
```

**Media hora para el operador.** Es exactamente lo que esperó sin saberlo. Le
llega a su feed con nivel de aviso, no para regañar a nadie: una pregunta suya
perdida en un hilo es peor que un agente parado, y él es el único que puede
decidir insistir o dejarlo. Sale aunque no haya CAPCOM vivo — sobre todo
entonces.

### Se apaga solo

No hay que acordarse de nada. El recordatorio sale de `missionDebt`: todo lo
posterior al último mensaje `capcom` de la misión está sin contestar. En cuanto
CAPCOM llama a `report_mission`, la deuda desaparece y el recordatorio con ella.
Si el operador vuelve a preguntar, la escalera se reinicia y el aviso sale
enseguida — insistir es señal de que corre más prisa, no menos.

El cálculo vive en `shared/missions.ts` y no en las herramientas, porque hay dos
lectores: `list_missions` / `inspect_mission`, que lo enseñan, y el despertador,
que avisa por ello. Dos implementaciones de «qué está esperando el operador»
acabarían discrepando, y la que discrepa siempre es la que calla.

La cuenta de recordatorios se persiste en `wake.json`. El hub reinicia con cada
edición bajo `tsx watch`; sin persistirla, cada reinicio volvería a mandar el
primer recordatorio de todas las misiones abiertas, que es la ráfaga que este
módulo existe para no producir.

### Entorno

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ORCA_MISSION_REPLY_STEPS` | `4,15,45,120` | Minutos de espera a los que se recuerda. El último se repite. Vacía conserva el default; `0` apaga. |
| `ORCA_MISSION_REPLY_ALERT_MIN` | `30` | Minutos tras los que el operador se entera. `0` apaga. |

## Cómo se navega

Una misión es una **ventana**, no una pestaña. Antes vivía dentro de CAPCOM:
pulsar una en la cinta cambiaba esa ventana por su conversación, así que tener
dos delante era imposible y leer un resultado mientras se le escribía al mando
obligaba a elegir. Desde 2026-09-08 cada misión abre en `kinds/mission.ts`, una
ventana del canvas como las demás —se arrastra, se apila, se pliega en la
bandeja— con identidad estable por `mission_id`:

- **Dos puertas, una llamada.** La fila del panel del HUD y la cinta de CAPCOM
  llaman las dos a `c.openMission(id, { tab })`. No hay dos maneras de estar
  dentro de una misión, que es lo que garantiza que las dos digan lo mismo.
- **Abrir la que ya está abierta la enfoca.** La clave de ventana es
  `mission:<id>`, y el gestor levanta la que hay en vez de apilar una copia
  (`wm.open`). Si se pide por la otra mitad, cambia de pestaña.
- **Cerrarla no archiva ni termina nada.** Archivar es un botón aparte, con su
  confirmación cuando la misión sigue viva; cerrar sólo quita la ventana, como
  en la de un agente.
- **La que está delante es «la misión abierta».** El foco de ventana escribe
  `store.activeMissionId`, que es lo que marca la fila del panel y lo que sigue
  el arco del campo.
- **Vuelve con la sesión.** El gestor persiste las ventanas ancladas a nada, con
  sus `params`, así que una misión abierta sigue abierta tras recargar.

La ventana tiene dos pestañas, que son las dos preguntas que se hacen de verdad:
CONVERSATION (qué se dijo, con lo que aún no ha confirmado el hub marcado como
tal) y RESULTS (cómo acabó). Una misión terminada abre por RESULTS, que es a lo
que se viene; una viva, por su conversación.

CAPCOM se queda con lo que siempre fue suyo —su sesión— y su cinta pasa a ser el
índice que abre misiones. El orden del hilo y la cinta están en
[CAPCOM-CONVERSATION.md](CAPCOM-CONVERSATION.md).

## El panel del HUD: arriba a la izquierda, y una fila es una línea

El panel se movió de la esquina derecha a la **izquierda**, bajo el mástil: es lo
primero que se lee y el ojo empieza ahí; la derecha se queda con el reloj y el
minimapa, que se consultan, no se leen.

Una fila plegada es **una línea**: título, cremallera, fase · hace cuánto, y
cuántos agentes hay dentro. La tripulación iba antes en una segunda línea que se
partía —un squad de seis convertía el panel en párrafos y descuadraba la columna
de la fase—, así que ahora vive en el detalle.

El **detalle** es la parte que faltaba. El título completo y el encargo entero
sólo se alcanzaban pasando el ratón por encima, y un `title=` no se puede tabular,
no se puede tocar con el dedo y desaparece mientras lo lees. Cada fila lleva un
desplegable (`▸`) que es un `<button>` de verdad con `aria-expanded`: Tab llega,
Enter y Espacio lo abren, y dentro están el título entero, el encargo entero, la
tripulación con su callsign y las dos entradas a la misión. El clic en la fila
abre la mitad que corresponde: conversación mientras corre, resultados cuando
terminó.

Un detalle de implementación que es una regla de uso: el panel **mueve sólo lo
que está fuera de sitio** al repintar. Reinsertar cada fila en cada render le
quita el foco a lo que haya dentro, y el reloj de diez segundos bastaba para que
la siguiente tecla se fuera al campo.

## En un teléfono

El panel no flota bajo 900px: allí las dos secciones del HUD —ésta y
AUTOMEJORA— se abren como **hoja** desde una barra en el dock, una a la vez, y
se cierran con el mismo botón, con la ×, con `Escape` o tocando el campo. La
hoja es el mismo panel con otra caja —no se mueve un nodo—, así que un borrador
a medias y una fila desplegada sobreviven al giro del teléfono y a la vuelta al
escritorio. La ventana de una misión ocupa el ancho y deja libre la banda del
dock, con el composer anclado al fondo y el teclado virtual medido. Está en
[ENTREGA-MOVIL-2026-09-08.md](ENTREGA-MOVIL-2026-09-08.md) y vive en
`src/ui/hud/sections.ts`.

## CREW: quién la está haciendo, y bajo quién

La ventana tenía dos pestañas y contestaba dos preguntas —qué se dijo, cómo
acabó—. La tercera es la que se hace mirando el campo: **quién está en esta
misión y bajo quién**. Lo único que había de eso era la lista plana de WHAT
CHANGED, una fila por agente, sin proyecto, sin squad y sin decir quién manda, y
además detrás de la pestaña con la que se mira una misión terminada.

CREW es la nómina, en tres niveles:

```
LEDGER                                   ← la isla del campo, abre el proyecto
  LEDGER-CLOSE · 6 · LED BY Z1           ← el squad, abre el squad
    Z1  WORKING   CLAUDE  —  —  Own the March close…      ← el líder, arriba
    Z2  WORKING   CODEX   —  —  Reconcile the March…
    …
    Z6  DONE      CODEX   —  —  Reconcile the March…      ← terminado, y sigue ahí
AXOLOTS
  K1  BLOCKED  CLAUDE  —  —  Draft the incident postmortem…
```

**El eje es proyecto → squad → miembros, y no el linaje.** Los dos son ciertos,
pero sólo uno sobrevive: el parte del hub guarda `projectId`, `squad` y `lead` de
cada agente que voló, mientras que `parentId` sólo existe mientras el agente está
en el mundo. Con linaje, una misión cerrada —que es cuando esta ventana se abre—
se vería plana.

**Dos fuentes, una regla** (`ui/windows/mission-crew.ts`, puro y probado): el
mundo vivo manda en lo que cambia —estado, si se le puede hablar, en qué squad
está ahora— y el diario manda en lo que ya no está. Un agente que voló y ya no
aparece en la flota **no desaparece de la nómina**: sale con lo que el diario
sabe, con su callsign en gris y sin poder volar a él, porque «quién trabajó en
esto» también es la respuesta. Las medidas salen sólo del diario, con la regla de
siempre: lo que nadie midió es `—`, nunca `0`.

**El glifo de cada fila es el de su baldosa.** Misma semilla que el campo (el
squad si lo hay, si no el id) y el líder lo lleva invertido, igual que su tile:
la nómina y el campo se leen como la misma flota. Ese glifo en DOM
(`gfx/sigilHTML`) llevaba meses sin dibujar un solo píxel —las celdas iban como
sombras exteriores, y una sombra exterior se recorta contra la caja del propio
elemento— y afectaba también al rótulo de los squads en el campo; ahora se pintan
como capas de fondo. `test/sigil.test.ts` lo fija.

### MUSTER: llevar la misión al campo, no dibujar el campo dentro

La nómina no lleva mapa, y es deliberado: el campo ya es el mapa, y una miniatura
suya dentro de una ventana serían dos verdades sobre dónde está cada agente, con
la pequeña siempre peor. Lo que hay es un puente, en la cabecera de la ventana:

- **MUSTER** selecciona a la tripulación, encuadra sus baldosas y enciende el
  foco, con lo que todo lo que la misión no toca cae al 12 % y las relaciones se
  quedan. Apila la vista antes de mover la cámara: `Backspace` vuelve a donde
  estabas. Sin nadie de la misión en el campo, el botón está desactivado.
- **Un callsign** vuela a su baldosa; **su brief** abre la ventana del agente;
  **un squad** abre el suyo; **una isla** abre su proyecto.
- La cabecera cuenta `6 LIVE · 7 FLEW` y ese contador entra en la pestaña.

La tercera puerta está también en el panel del HUD: cada fila desplegada ofrece
CONVERSATION · CREW · RESULTS.

## Los resultados: lo que la flota hizo, no lo que se dijo

La conversación de una misión es la palabra. RESULTS es el otro lado, y cada
sección dice de dónde sale:

| Sección | De dónde |
| --- | --- |
| RESULT | el último `report_mission` de CAPCOM. Publicar el texto y marcar la misión completada son la misma llamada, así que ese mensaje ES el resultado |
| WHAT CHANGED | el diario del hub, por `missionId`: líneas tocadas, coste, duración, estado final y aterrizajes de rama, por agente |
| FILES REPORTED | las rutas escritas en la conversación, resueltas contra el proyecto de quien las escribió, abiertas en el visor de ORCA |
| MEDIA | los artefactos que publicaron sus agentes (`orca-show`) |
| REPORTS ALONG THE WAY | los informes anteriores de CAPCOM y lo que reportaron los workers |

**Del diario y no del mundo en memoria**, porque un agente terminado se archiva y
con él se van sus métricas — y una misión se abre días después, que es
literalmente para lo que existe. El hub contesta la trama `mission:debrief`
(`shared/protocol.ts`) con un `MissionDebrief` que arma `shared/debrief.ts` a
partir de las entradas `launch` / `end` / `landing` de esa misión. Se pide, no se
emite: barrer el diario en cada cambio del mundo, por cada consola conectada,
para un panel que casi nunca se mira, sería pagar siempre por servir casi nunca.

**Nada se inventa.** Un número que nadie midió sale `null` y se pinta `—`, nunca
`0`, y `measured` dice de cuántos agentes hay registro: la consola tiene que
poder distinguir «no cambió nada» de «nadie lo apuntó», porque la segunda hay que
decirla en voz alta. Mientras quede alguien corriendo, el total lleva «SO FAR».
Cada sección vacía dice qué falta y quién tendría que haberlo puesto — una misión
cerrada sin `report_mission` lo dice con esas palabras.

## Hablar con quien la llevó

> **2026-09-09.** Ya no hay selector. La ventana tiene UNA línea de salida, se
> escribe sólo desde CONVERSATION, y el destinatario lo decide el hub con la
> regla que la ventana enseña encima de la caja. Lo que sigue describe lo que
> hay; el porqué y las medidas están en
> [ENTREGA-LEADS-2026-09-09.md](ENTREGA-LEADS-2026-09-09.md).

La pestaña con la que abre toda misión, viva o terminada, es **MISSION**: el
encargo entero (BRIEF), el resultado (RESULT) y lo que la flota cambió. La
conversación es la segunda pestaña, y es la única con caja de texto; desde las
otras dos el pie dice a quién iría la línea y ofrece `WRITE`, que lleva a la
conversación. Así no se escribe donde no se lee lo que se contesta.

La línea va a **uno de dos sitios, y se dice cuál** antes de mandar:

- **`TO K1 · LEAD OF THIS MISSION`.** La misión tiene líder en pie: un agente
  asignado que lidera su squad, o —si no hay ninguno asignado que lidere— el
  líder del squad que la misión declara en `mission.squads`. Entre dos, gana el
  vivo, y entre terminados el que se movió el último. CAPCOM nunca es líder de
  una misión. El mensaje va a su sesión con la cabecera `[ORCA MISSION <id>]
  <título>` y una línea que le dice cómo contestar: su último mensaje es lo que
  ORCA vuelca en la misión. En la conversación la línea queda como `YOU → K1`,
  marcada con `to` (`MissionMessage.to`), y **no es deuda de CAPCOM**: el
  despertador no se la recuerda, y `list_missions` no la cuenta como
  `pending_human`.
- **`TO CAPCOM · NO LEAD ON THIS MISSION`** (o `· THE LEAD IS GONE`, con `READ
  K1` al lado para leer su transcript). La línea entra en la conversación de la
  misión y CAPCOM la recibe con el hilo detrás, como siempre.

La regla es `missionLeadOf` en `shared/missions.ts`, y es UNA porque tiene dos
lectores: la ventana, que promete, y el hub (`mission:say`), que manda. Si el
líder murió entre la pintada y el clic, el hub elige CAPCOM y la consola lo dice.

**Escribir en una misión terminada la reabre.** Hasta el 2026-09-09 hablarle al
líder de una misión COMPLETED iba por `say` directo al agente: la misión no se
enteraba, seguía COMPLETED mientras el líder hacía lo nuevo, y su respuesta no
llegaba al hilo. Ahora las dos rutas pasan por el hub, y las dos ponen la
misión en `active`.

### Los miembros hablan con el líder, no con CAPCOM

Un squad con líder en pie es un embudo, y hasta hoy tenía agujeros: cada
miembro que terminaba o paraba a respirar despertaba a CAPCOM con un `[AGENT …]`
(`hub/wake.ts`) y además metía su `lastSay` en la conversación de la misión
(`MissionStore.observe`), lo que disparaba OTRO turno de CAPCOM para
«publicarlo». Seis miembros, doce turnos del mando para leer lo que el líder ya
estaba consolidando.

Desde 2026-09-09:

- Un miembro con líder vivo **no despierta a CAPCOM** ni escribe en la misión.
  Su fin —`done`, `dead`, o un `idle` asentado— va al líder como aviso
  (`tellLead`), y sólo si el miembro no se lo dijo él por `orca-tell`.
- **El líder** es quien despierta a CAPCOM al terminar, y su palabra es la que
  entra en la misión. El prompt que recibe CAPCOM dice que el líder ya
  consolidó y verificó: `report_mission` y nada más, sin rehacer ni relanzar.
- Muerto el líder, el miembro vuelve a hablarle a la misión y a CAPCOM: es lo
  único que queda.

El pie del líder (`collector/briefs.ts`) le dice que es también la puerta de
entrada —el operador puede escribirle con `[ORCA MISSION <id>]`— y que su
último mensaje es el informe: no tiene que mandarle nada a CAPCOM.

## Validación

```
npm test -- missions mission-status mission-crew sigil debrief briefing command wake journal budgets talk drafts capcom-new-hub worker-recovery improve
npx tsx test/hud-missions.shots.ts     el panel y la ventana contra la consola viva
npx tsx test/mission-crew.shots.ts     la nómina, sus glifos y MUSTER
npx tsx test/hud-mobile.shots.ts       las dos secciones y la ventana con el dedo
```

`test/mission-crew.test.ts` cubre la nómina: la jerarquía con el líder arriba y
los sueltos detrás de los squads, que el mundo mande en el estado y el diario en
las medidas, que un agente que ya no está en la flota siga en la lista sin
baldosa, que CAPCOM no sea tripulación, la semilla del sigilo, y que lo no medido
sea `null`. `test/sigil.test.ts` fija que el glifo en DOM pinte dentro de su caja
—la regresión de las sombras exteriores— y que el del líder sea el complemento.
`test/mission-crew.shots.ts` lo fotografía contra la consola viva: las dos islas,
la cabecera del squad con quién manda, el terminado que sigue en la nómina, que
cada glifo pinte de verdad y que MUSTER mueva la cámara.

`test/missions.test.ts` cubre el store, el ciclo de archivo y purga, el cableado
por WebSocket con los verbos `mission:*`, y que una misión guardada antes del
renombrado conserve id, conversación, título y sitio.
`test/briefing.test.ts` cubre `open_mission` —que lo que crea es indistinguible
de lo del operador, que adopta agentes vivos y que rechaza entrada mala—, el
anuncio por MCP de las herramientas nuevas y la ausencia de las viejas en ese
anuncio. `test/mission-status.test.ts` y `test/hud-missions.shots.ts`, el panel.
`test/debrief.test.ts` cubre el parte: que un agente archivado sigue en él con
lo que el diario guardó, que lo no medido es `null` y no `0`, que el `end` del
diario gana a la flota viva cuando existe y la flota viva rellena mientras corre,
que los totales cuentan cuántos agentes hay medidos de verdad, los aterrizajes,
que una entrada de otra misión no se cuela, quién es el líder (asignado antes que
por squad, vivo antes que terminado, CAPCOM nunca) y qué rutas se pueden abrir de
lo reportado. `test/hud-missions.shots.ts` fotografía el panel a la izquierda y
comprueba que una fila plegada ocupa una línea, que el desplegable se abre y se
cierra con el teclado y enseña el título y el encargo enteros, que la fila abre la
ventana de la misión sin duplicarla, que una terminada abre por RESULTS con sus
estados vacíos dichos y no inventados, que la cinta de CAPCOM abre la misma
ventana, que cerrarla no archiva y que bajo 900px el panel se aparta.
`test/wake.test.ts` cubre el tercer despertador: que una misión con
`pending_human` avisa a los 4 minutos y no antes, que responderla lo apaga, que
la escalera se espacia sin repetirse cada tick, que varias misiones salen en un
mensaje, que el operador se entera a la media hora una sola vez y aunque no haya
CAPCOM, que un reinicio del hub no repite el recordatorio, y que una misión
archivada o terminada no avisa de nada.
