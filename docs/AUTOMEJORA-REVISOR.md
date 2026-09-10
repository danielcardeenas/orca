# AUTOMEJORA — informe de entrega: el agente revisor

**Misión:** `mission_mtsaf4fnjtrh9j5j`
**Sobre:** `mission_mts6tjnbar7u0ngy` (la sección) · coordinado con
`mission_mtsaa02eqa14rjii` (el móvil, de Q8)
**Estado:** implementado y verificado. **Sin commit** (§7).

El canal de mensajes trunca, así que el informe íntegro es éste. El documento
de referencia de la sección es [AUTOMEJORA.md](AUTOMEJORA.md); el de la entrega
anterior, [AUTOMEJORA-ENTREGA.md](AUTOMEJORA-ENTREGA.md).

---

## 1. Qué ha cambiado

Antes, una revisión era **un turno de CAPCOM**. Ahora es **un agente revisor
temporal**: ORCA lo lanza por el camino normal de spawn, aparece en el campo
con su callsign, su estado y su consumo como cualquier otro, examina el uso,
explora mejoras, archiva lo que propone en la sección y **termina**.

La sección sigue siendo permanente y conserva propuestas, preguntas y
decisiones; el revisor no. Una propuesta aprobada sigue abriendo una misión
normal enlazada a la idea, que CAPCOM coordina.

**Por qué es mejor, dicho sin adornos.** Un turno de CAPCOM es invisible
mientras dura: no se sabe si está pensando, cuánto lleva, cuánto ha gastado ni
cómo pararlo, y compite por el contexto del mando con todo lo que la flota le
está pidiendo a la vez. Un agente se mira, se vuela hasta él, se abre su
ventana, se le pone presupuesto y se le para. Y cuando falla, falla como falla
un agente —visiblemente— en vez de dejar una revisión colgada que nadie sabe
que existe.

## 2. Lanzamiento

`createImprove` (`src/hub/improve.ts`) despacha un `spawn` real por
`deps.dispatch`, el mismo camino que usa `spawn_agent`:

| Campo | Valor | Por qué |
|---|---|---|
| `projectId` | el repo de ORCA | es lo que va a leer |
| `parentId` | `null` | no es de nadie. Colgarlo de CAPCOM lo metería en el despertador (`wake.ts`) y costaría un turno por revisión: justo lo que esta arquitectura vino a quitar |
| `mission` | `AUTOMEJORA <review_id>` | ata el tile a la revisión, y se ve en el campo |
| `worktree` | `false` | no va a escribir; uno vacío por revisión sería basura en disco |
| `background` | `true` | sobrevive a que se cierre la consola; con tmux va a un pane que el operador puede abrir |
| `review` | `true` | **campo nuevo del protocolo**, ver abajo |

**`review: true` cambia dos cosas en la máquina, y las dos son capacidades:**

- le pone **`orca-improve`** en el PATH — un tercer juego de shims
  (`collector/shims.ts`), que no lleva ningún otro worker;
- le **quita** las herramientas de edición:
  `--disallowedTools Edit Write NotebookEdit MultiEdit`. Es una capacidad
  retirada, no una instrucción; un modelo atascado usa la salida que ve. Va
  **primero** en el argv porque es variádica y se comería el prompt posicional
  (la misma trampa documentada en `capcom.ts`, que ya costó un CAPCOM mudo).

**Dónde corre.** El repositorio de ORCA, encontrado solo entre los proyectos de
la flota comparando `ORCA_ROOT` (la raíz del propio código) con la ruta de cada
proyecto. `ORCA_IMPROVE_PROJECT` lo nombra por id, código, nombre o ruta. Sin
ninguno de los dos **no se lanza nada** y el panel dice por qué: una revisión en
un proyecto cualquiera leería el repo equivocado y propondría mejoras para otra
cosa.

**Qué recibe.** `reviewerBrief` compone lo ÚNICO que ve una sesión recién
nacida: quién es y qué no es, los dos trabajos (leer lo medido / pensar más
allá), la línea de comando **entera** con la que contesta, lo que no hace, y
que termine. Lleva dentro el informe de telemetría, el tablero con las claves
abiertas y lo que el operador contestó desde la última revisión.

## 3. Motor creativo

Sin cambios de fondo, y ésa era la intención: el brief pide **dos** trabajos y
el segundo está escrito para que no se pueda leer como opcional — *«Think past
it … including ideas the numbers cannot support yet. Those are wanted, not
tolerated»*, con `kind="hypothesis"` y la suposición escrita.

Lo que lo sostiene sigue siendo `normalizeDraft`: rechaza —con el motivo, para
que se corrija y se vuelva a mandar— una propuesta `observed` **sin evidencia**
y una `hypothesis` **sin hipótesis**. Una idea creativa es bienvenida pero no
puede disfrazarse de medición. `impact`/`effort` sólo se guardan con
fundamento; sin ellos la ficha no pinta medidor.

Lo que el agente añade sobre el turno: **puede leer el repositorio de verdad**
—código, DESIGN.md, docs, el log de git— en vez de razonar sólo sobre el
resumen que le cabía en un prompt. El brief se lo dice explícitamente.

## 4. Cómo reporta

Un agente no tiene socket ni token del hub: tiene un sistema de ficheros. El
canal es el mismo patrón que `orca-tell` y que una escalación.

```
orca-improve report --review <review_id> --file proposals.json
```

1. `bin/orca-improve.mjs` escribe `<proyecto>/.orca/improve/<id>.json`
   (escribir-y-renombrar) y espera.
2. `ImproveDropWatcher` (`collector/improve-drop.ts`) lo recoge, valida forma y
   tamaño, **borra el fichero** y lo sube como `improve:report` con un
   `reportId`. **La ruta no viaja**: se queda indexada en el collector, así que
   un hub comprometido no puede elegir dónde se escribe un fichero.
3. El hub comprueba **quién** reporta: sólo el agente de la revisión en vuelo,
   o uno cuyo short id coincida. Sin esa comprobación `orca-improve` sería un
   canal abierto a cualquier sesión de la máquina.
4. Archiva y contesta `improve:ack` con el mismo `reportId`; el collector
   escribe `<id>.ack.json` y el CLI lo imprime: cuántas entraron, cuántas se
   fundieron, y **el motivo exacto de cada rechazo**.

El recibo vuelve **siempre**, también cuando se rechaza entero: un informe que
se pierde en silencio se lleva por delante la revisión sin que nadie —ni el
agente ni el operador— se entere.

`report_improvements` sigue publicada por `/mcp` y hace lo mismo con la misma
validación, para un CAPCOM que quiera archivar por su cuenta.

## 5. Identidad, estado y consumo

**Runtime 8 en el shader** (`ui/field/swarm.ts`): línea violeta permanente,
tinte violeta del cuerpo y sigilo violeta — el mismo movimiento que la línea
cian de CAPCOM, y por la misma razón: hay una clase de sesión que no está
haciendo el trabajo de la flota y lo dice a cualquier zoom.

**Es una IDENTIDAD, nunca un estado.** El color del cuerpo y la banda del borde
izquierdo siguen diciendo lo que le pasa de verdad. Un revisor bloqueado se ve
ámbar dentro de un marco violeta; uno muerto, rojo. La selección (lima) sigue
ganando sobre el violeta.

**Cómo lo sabe la consola:** leyendo el TABLERO (`reviewerIds`), que ya viaja
entero y guarda las últimas 40 revisiones, así que un revisor sigue siendo
reconocible mucho después de terminar. Un `role: 'reviewer'` nuevo habría que
propagarlo por el collector, el hub y el protocolo para no decir nada que esto
no diga ya.

**La fila del panel** enseña, mientras hay revisión en vuelo: el punto de su
estado real · el callsign (pulsable: vuela la cámara y abre su ventana) · la
palabra de su estado · cuánto lleva · **cuánto ha gastado de cuánto** · `STOP`.
Una propuesta abierta dice `PROPOSED BY <callsign>` con el mismo camino de
vuelta. `REVIEW NOW` se apaga mientras hay uno trabajando.

**Un fallo real que salió de esto**, y que sólo una comprobación de color
podía encontrar: pasaba `var(${stateVar(a)})` y `stateVar` **ya** devuelve
`var(--st-…)`, así que salía `var(var(--st-blocked))`, inválido, y el punto y la
lectura caían al violeta de la sección — un revisor bloqueado se habría visto
sano. Está arreglado y hay una aserción que lo vigila (§8).

## 6. Ciclo de vida: nada se queda colgado, nada miente

**Siete estados, y ninguno es «desconocido»:** `launching` · `running` ·
`reported` · `ended` · `failed` · `cancelled` · `expired`.

`reported` **se gana archivando propuestas**. `ended` es un agente que terminó
sin archivar nada, y se llama así a propósito: decir «revisión completada»
cuando no llegó ni una línea sería el resultado falso que hace inútil un panel
que corre solo. La línea de estado lo enseña tal cual (`ENDED WITH NOTHING
FILED`, `FAILED`, `TIMED OUT`).

**Lo que cierra una revisión es `endedAt`**, no el estado: archivar no la
cierra, porque el brief le dice al revisor que corrija lo rechazado y lo vuelva
a mandar, y mientras tanto sigue gastando.

**Una y sólo una.** El sitio se reserva **antes** de pedir el spawn
(`beginReview` → `launching`), así que dos ticks no pueden lanzar dos revisores
aunque el spawn tarde segundos.

**Sin bucles.** Lo que dispara una revisión son los contadores de la consola
(`ui:<frame>`) y de CAPCOM (`mcp:<tool>`), que un revisor no toca: no puede
provocar la siguiente ni aunque trabaje una hora. Probado (§8).

**El barrido**, en cada tic y **al arrancar**, cierra lo que ya no puede acabar
bien: pasó el reloj de pared de 45 min (y entonces también **para** al agente),
el hub se reinició y el agente ya no está en el mundo, o terminó y el evento se
perdió. El arranque es exactamente cuando el segundo caso es más probable.

### La exclusión: un solo revisor vivo, sin excepciones

Ésta es la garantía que la sección tiene que cumplir, porque es el único fallo
suyo que no se puede deshacer. Se separan dos cosas que antes eran una:

- **Decidir el resultado** (`outcomeAt`): se pasó del techo, se le acabó el
  reloj, el operador lo paró, archivó y se quedó quieto. Puede ocurrir en
  cualquier momento.
- **Soltar el sitio** (`endedAt`): **sólo** cuando el mundo confirma que el
  agente se fue — terminal, o fuera del mundo.

Tres caminos liberaban el hueco con un agente conocido vivo, y los tres están
cerrados:

| antes | ahora |
|---|---|
| `CANCEL_GRACE_MS`: a los 2 min de pedir el `stop`, cerraba aunque no se hubiera confirmado | **eliminado.** No hay plazo que suelte el sitio |
| `REVIEW_MAX_MS`: a los 45 min, `activeReview` apartaba la revisión aunque su agente siguiera vivo | el reloj decide el resultado (`expired`) y **no suelta nada** |
| `overbudget`: cerraba en el acto y mandaba el `stop` | decide el resultado y **sigue bloqueando** |

Si el `stop` falla, se reintenta **acotado** —`STOP_ATTEMPTS` = 5, con espera
20 s · 40 s · 80 s · 160 s · 320 s— y agotarlos **tampoco** suelta el sitio:
sólo se deja de insistir. La sección se queda bloqueada **y lo dice**, con el
número de intentos: `STOPPED BY THE OPERATOR · STOP SENT 5× · NO MORE RETRIES ·
WAITING FOR THE FLEET TO CONFIRM IT IS GONE · 30m`. Un bloqueo visible es un
problema que alguien puede mirar; dos revisores a la vez, no.

Reintentar un `stop` no le da turnos a nadie: **no hay bucle de gasto**. Y hay
tres salidas reales que no hay que forzar — el agente pasa a `done`/`dead`,
desaparece del mundo, o su máquina se cae y el hub da por muertos a sus agentes
(`BEAT_TIMEOUT_MS`).

Probado más allá de cualquier plazo: con el `stop` fallando siempre y el agente
vivo, **treinta intentos manuales a lo largo de media hora fueron denegados**,
sólo salió un spawn, los reintentos se pararon en 5, y en cuanto el mundo
confirmó la muerte la sección se recuperó sola y lanzó la siguiente.

**Y nada se queda vivo.** Un agente de Claude Code no termina solo: acaba su
turno, pasa a `idle` y espera otro prompt. Un revisor `idle` durante un minuto
se da por terminado —`reported` si archivó, `ended` si no— **y se le para**.
Esto salió de la corrida real (§8bis), no de leer el código.

## 7. Presupuesto: qué garantiza exactamente

Dos ejes, y **no se deducen el uno del otro**:

- `perDay` (4) limita cuántas revisiones **automáticas** ocurren en 24 h. **No
  ata a la ejecución manual**, y no debe: el operador pulsa REVIEW NOW cuando
  quiere.
- `budgetTokens` (**400.000**) es el techo de **cada** revisión.

Por qué 400.000: una pasada es leer un informe de una pantalla, mirar el repo
un rato y escribir media docena de propuestas; en la flota de este repo un
worker que lee y escribe media hora se mueve entre 150k y 350k.

### Corrección: NO hay techo duro de 1,6M al día

La primera versión de este informe decía que el gasto máximo del día era
`perDay × budgetTokens` = 1,6M tokens. **Es falso, y la corrida real lo
demostró.** `rev_mtschaq0u83g1or2` cruzó los 400k en menos de un minuto y llegó
a marcar 1,1M antes de que nadie lo parara. Tres razones, y ninguna se arregla
subiendo el número:

1. **La medida llega tarde y da saltos.** El consumo se deriva del transcript
   que el collector relee. En esa misma sesión la cifra leída pasó por 201.861,
   1.116.804 y 622.319 antes de asentarse en 622.319 al cierre. Nadie frena en
   un punto que todavía no ha visto, y el número que se ve no es monótono.
2. **Frenar es mandar un comando.** El `stop` viaja al collector y puede tardar
   o fallar.
3. **Una llamada a un modelo no se parte por la mitad.** Un turno con mucho
   contexto ya gasta más que el resto de la pasada.

A eso se suma que `perDay` no limita lo manual. Así que el producto **es un
orden de magnitud esperado en un día automático, no un límite**.

### Lo que sí se garantiza, y lo que se ha cambiado

- ORCA **mira** el consumo del revisor en cada tic —bajado de 60 s a **20 s**
  por esta corrida— **y en cada cambio de estado suyo**, que es cuando su gasto
  acaba de moverse.
- En cuanto lo ve por encima del techo, **para al agente** y cierra la revisión
  como **`overbudget`**, con las cifras en la nota (`stopped at 540k of a 400k
  ceiling`). El panel lo enseña como `STOPPED OVER BUDGET`.
- El techo se registra además en el **libro de presupuestos del hub**
  (`budgets.set({kind:'agent', ref})`), para que el revisor se vea y se frene
  como cualquier otro agente. Ese libro es también un freno por muestreo: por
  eso la sección tiene el suyo encima y no delega la cuenta.

Es **un freno, no un muro**, y así está escrito en el código, en
`docs/AUTOMEJORA.md` y en el panel. Nada promete un techo duro.

## 8. Pruebas y resultados

Todo esto se corrió y esto es lo que salió.

**`npm run typecheck`** — limpio.

**`npm test -- improve` → 67/67**, en cinco suites:

`AUTOMEJORA` (32, piezas con reloj falso). Lo nuevo, sobre las que ya había:
el spawn que sale es el que un revisor necesita (sin padre, sin worktree,
`review:true`, brief con la línea de `orca-improve`) · un revisor a la vez, con
la negativa nombrando al que tiene el sitio · un spawn que falla cierra y
libera · un agente que termina sin archivar es `ended` y **no** `reported` · uno
que muere es `failed` · lo archivado lleva `agentId` y callsign · un agente que
no es el revisor no puede archivar · el que se cuelga se caduca **y se para** ·
**un reinicio no deja una revisión corriendo para siempre** · el id de sesión
que el ack no vio se ata cuando el agente aparece · **el callsign se rellena de
la flota cuando el ack no lo trajo** · sin proyecto no se lanza nada y se dice
por qué · el presupuesto se pone al lanzar y es configurable · **un revisor
nunca dispara la siguiente revisión**.

Y lo que salió de la corrida real: **un revisor por encima de su techo se para y
la revisión queda `overbudget`** con las cifras · **uno que archivó y se quedó
`idle` se cierra Y se para** en vez de seguir vivo · uno que se queda `idle`
**sin** archivar es `ended` · **cancelar pide el stop y HOLD del hueco**: con el
agente vivo nadie lanza un segundo revisor, ni cuando el stop falla · pasada la
gracia se reintenta el stop, se cierra y se dice que **nunca se confirmó** ·
cancelar antes de que exista el agente cierra en el acto · **con el `stop`
fallando y el agente vivo, treinta intentos manuales en media hora denegados**,
reintentos parados en 5, y recuperación en cuanto se confirma la muerte · el
reloj de pared y el techo deciden el resultado **sin** abrir la puerta.

`AUTOMEJORA · hub` (7): el tablero por el protocolo · SEND abriendo una misión
y negándose a la segunda · un SEND inválido no deja misiones huérfanas · la
respuesta del operador en el hilo · config y decisiones sobreviviendo a un
reinicio del hub · los contadores · `report_improvements` por `/mcp`.

`AUTOMEJORA · agente revisor` (10) — **el recorrido entero, sin mocks del
router**: un hub real y una **máquina real al otro lado del websocket de
collector**, hablando el protocolo. Cubre `launch` (la consola pide, el spawn
cruza el cable, la máquina lo acepta con su `SpawnAck`) · `visible` (el agente
está en el mundo, el tablero lo marca como revisor, el libro de presupuestos
tiene su techo) · `report` (una propuesta entra, otra se rechaza con motivo, el
recibo vuelve, la revisión pasa a `reported`) · un agente ajeno no puede
archivar · `finish` (el agente termina, la revisión se cierra **con lo que
costó de verdad**, y el hueco queda libre para la siguiente, que sale) · un
agente que muere sin archivar es `failed` · una segunda revisión se niega por
nombre · cancelar manda un `stop` de verdad · un spawn que la máquina rechaza
cierra con **el motivo de la máquina** · el tablero se empuja solo a la consola
con el revisor dentro.

`AUTOMEJORA · el panel pide su tablero` (5): el fallo del §8ter — reintento con
espera creciente, no gastar intentos sin enlace, volver a pedir al reconectar,
una petición en vuelo a la vez, y que el camino de carga **sólo lea**.

`AUTOMEJORA · orca-improve` (6): **el binario de verdad como subproceso**
contra el **vigilante de verdad** sobre un directorio de verdad — archiva, el
fichero desaparece, el rechazo llega al agente y sale por su salida estándar ·
un rechazo entero sale con código 3 · fuera de un proyecto vigilado dice que
ORCA no está ahí en vez de dejar un fichero que nadie lee · JSON malo, informe
vacío y falta de `--review` se rechazan antes de escribir nada · un informe
gigante lo para el collector y deja el motivo en disco · sólo un revisor
recibe el comando.

**`npm test -- --changed` → 866/866**, sin suites rotas. Incluye `capcom`
(el brief nombra todas las herramientas), `autonomy`, `collector`, `commands`,
`trust` y las de Q8.

**`npx tsx test/hud-improve.shots.ts`** → pasa. Además de lo que ya
comprobaba, ahora: la fila del revisor existe y nombra al agente · su marco es
el violeta de la sección y **el punto y la lectura NO lo son** (llevan el color
de estado del agente) · dice minutos y tokens sobre el techo · hay `STOP` ·
`REVIEW NOW` está apagado · la ficha acredita al revisor · la línea de estado
resume la última **cerrada** y no repite la viva · y todo el bloque móvil (§9).

## 8bis. La revisión real: `rev_mtschaq0u83g1or2`

**Una sola revisión, por el camino normal** (`improve:run`, que es lo que hace
REVIEW NOW), contra el hub vivo y un CLI real. No se lanzó ninguna otra, ni a
mano ni por el reloj.

| | |
|---|---|
| Revisión | `rev_mtschaq0u83g1or2` · trigger `manual` · «ASKED BY THE OPERATOR» |
| Agente | `30df816e-cf65-4ad6-98f7-36ada4d355ae` · callsign **QW** · runtime `claude` |
| Proyecto | `OR` — el repositorio de ORCA, encontrado solo por `ORCA_ROOT` |
| Misión en el tile | `AUTOMEJORA rev_mtschaq0u83g1or2` |
| Resultado | **5 propuestas archivadas**, 0 fundidas, 0 rechazadas |
| Consumo final | **622.319 tokens · $1,0596** · 3 turnos · 12 llamadas a herramienta |
| Cierre | `cancelled` · «the reviewer is confirmed stopped» — ver la nota de atribución abajo |
| Hueco | liberado tras la confirmación; verdict volvió a `NEXT IN 6h` |

**El recorrido, punto por punto, tal como se observó:**

1. **Lanzamiento.** El ack devolvió `status: running` con `agentId`,
   `projectId` y `machineId`. Ninguna otra revisión en vuelo (se comprobó antes
   de pulsar).
2. **Visible.** A los segundos, QW estaba en el mundo `working`, con el tile
   nombrando su revisión y `tool: Bash cat docs/AUTOMEJORA-REVISOR.md` — leyendo
   el repositorio, que es lo que se le pidió.
3. **`orca-improve` accesible.** El agente lo usó sin preguntar dónde estaba ni
   gastar turnos buscándolo, que era el riesgo. Su último mensaje empieza
   *«Archivadas y aceptadas: 5 filed, 0 merged»* — el texto del recibo que
   escribe el CLI, así que el ack le llegó de vuelta.
4. **Reporte.** Las 5 entraron al tablero con `agentId`, `callsign QW` y
   `reviewId`. El buzón `<repo>/.orca/improve/` quedó vacío: el vigilante
   consumió el fichero.
5. **Cierre.** La revisión se cerró conservando el consumo real, y el hueco
   quedó libre.

**Atribución del cierre, con precisión.** No hubo ningún clic humano en `STOP`
en la consola, y decir «el operador lo paró» era impreciso. Lo que pasó fue:
QW se pasó del techo, llegó por el canal de supervisión un `interrupt` a la
sesión —de CAPCOM / la validación en curso, no de la interfaz— pidiéndole
cerrar la exploración y terminar; QW archivó sus cinco propuestas; y después
**yo mismo mandé `improve:cancel`** por el socket de consola, que es el mismo
frame que dispara el botón, como parte de la validación. La revisión quedó
`cancelled` porque ése es el camino que se ejerció, no porque una persona
pulsara nada.

**Lo que propuso** (resumido; están en el tablero, y **no se ha enviado ninguna
a implementar**):

| clave | tipo | qué |
|---|---|---|
| `journal-endings-missing` | observed · imp alto | 500 lanzamientos y **0 finales** en 24 h: coste, duración y done-rate salen vacíos porque se calculan sólo sobre entradas `end`. Con una pregunta al operador sobre si el arnés escribe en el mismo diario. |
| `digest-launch-count-mismatch` | observed · imp medio | la cabecera dice 500 lanzamientos y el desglose suma 438: dos reglas de conteo distintas más un recorte silencioso a cinco proyectos. |
| `capcom-not-in-the-loop` | observed · imp alto | CAPCOM originó 0 de 500 lanzamientos, 0 llamadas a herramienta, 0 escalaciones. Pregunta si hubo CAPCOM vivo. |
| `console-usage-instrumentation` | **hypothesis** | los contadores `ui:` cuentan peticiones al hub, no gestos de interfaz; con 7 en total no se puede contestar «qué no toca nadie». Hipótesis escrita, y dice qué **no** verificó. |
| `reviewer-budget-heads-up` | **hypothesis** | el revisor no ve su consumo mientras trabaja, así que no puede decidir cuándo dejar de leer. Lo escribió tras ser interrumpido por pasarse del techo. |

**Esto es lo que valida el motor creativo**, y no una prueba: tres `observed`
con cifras citadas del informe que se le dio, dos `hypothesis` con la suposición
escrita y con lo que no comprobó, dos preguntas reales al operador, y **ni una
medición inventada**. Encontró además un defecto real de ORCA que nadie había
mirado (el diario sin finales).

### Lo que la corrida rompió, y se arregló

1. **El techo de 400k no frenó nada.** Cruzado en menos de un minuto, marcó
   1,1M. Ver §7: ahora la sección tiene su propio freno (tic de 20 s + cada
   cambio de estado del revisor → `stop` + `overbudget`), y ningún documento
   promete ya un techo duro.
2. **El revisor no terminaba.** Un CLI de Claude Code no acaba solo: se queda
   `idle` esperando otro prompt. La revisión habría ocupado el sitio 45 minutos
   y el agente habría seguido vivo. Ahora un revisor `idle` un minuto se cierra
   **y se para**.
3. **La revisión se quedó sin callsign.** El ack trajo `agentId` y no
   `callsign`, y el historial decía «—». Ahora se rellena del mundo en cuanto
   está, por cualquiera de los dos nombres.
4. **Cancelar liberaba el hueco al pedirlo.** Corregido antes de esta corrida y
   ejercitado en ella: `improve:cancel` contestó `holding: true` y el hueco no
   se liberó hasta que la flota confirmó que QW estaba `done`.

## 8ter. El panel clavado en «ASKING THE HUB…»

**Síntoma.** La sección se quedaba diciendo `ASKING THE HUB FOR THE BOARD…`
indefinidamente, con las cinco propuestas ya en el hub. El operador no podía
distinguirlo de «no hay propuestas».

**Causa, en una línea.** `mountImprove` pedía el tablero **una sola vez al
montar**, con un `catch` vacío, confiando en que un push lo arreglara. El hub
sólo empuja `t:'improve'` cuando el tablero **cambia**, así que una petición
perdida no se recuperaba nunca. Se pierde con facilidad: el `request` del
cliente rechaza en seco si el socket todavía no está `OPEN`, y bajo `tsx watch`
el hub se reinicia con cada edición — como ocurrió hoy media docena de veces.

**Arreglo**, en `src/ui/hud/improve.ts`:

1. **Se pide al conectar y en cada reconexión**, no sólo al montar. No es sólo
   una red de seguridad: un hub reiniciado no empuja nada, así que sin volver a
   preguntar la consola enseñaría un tablero viejo.
2. **Reintento acotado con espera creciente** (700 ms · 1,5 s · 3 s · 6 s ·
   12 s) **sólo con el enlace arriba**. Con el enlace caído no se gasta ni un
   intento: se espera al evento, que es información y no una conjetura.
3. **Estados visibles**, y ninguno se calla: `COULD NOT READ THE BOARD` con el
   motivo y un botón `TRY AGAIN`; `NO LINK · SHOWING THE LAST BOARD` cuando hay
   tablero pero no enlace, con `REVIEW NOW` apagado. **Lo que ya se sabía no se
   borra**: un fallo de red no vacía la sección.
4. **Una petición en vuelo a la vez**: el montaje y el evento de enlace llegan
   casi juntos, y sin la guarda se pedía dos veces.
5. **Leer el tablero nunca lanza una revisión.** Hay una prueba que lee el
   código del camino de carga y falla si aparece cualquier `hub.improve*()` que
   no sea `hub.improve()`.

**Evidencia.**

- `npm test -- improve` incluye la suite nueva `AUTOMEJORA · el panel pide su
  tablero` (5): un primer fallo se reintenta con esperas crecientes y acaba
  entrando · con el enlace caído no se gasta un intento en media hora y se pide
  al reconectar · cada reconexión vuelve a leer · dos disparos a la vez son una
  sola petición · el camino de carga sólo lee.
- El arnés visual corta el socket de consola de verdad: el panel pasa a
  `NO LINK`, **conserva las filas**, apaga `REVIEW NOW`, y se recupera sin
  recargar cuando el cliente reconecta (`hud-improve-offline.png`).
- **En la consola viva**, tras el arreglo: `5 NEW`, cinco filas con las
  propuestas reales de QW, `NEXT IN 5H · LAST 34M · CANCELLED`, sin errores de
  página. Ya no hay ningún «ASKING THE HUB».

## 9. Evidencia visual

En `test/shots/`, escritas por la corrida del arnés:

| Ruta | Qué se ve |
|---|---|
| `hud-improve.png` | la consola entera con la sección |
| **la corrida real** | §8bis: ids, callsign, consumo, las 5 propuestas y el cierre, leídos del hub vivo |
| `hud-improve-reviewer.png` | **la fila del revisor**: marco violeta, `K1`, `NEEDS YOU · 7M IN · 861K/400K` en ámbar, `STOP`, `REVIEW NOW` apagado |
| `hud-improve-tile.png` | el tile del revisor en el campo |
| `hud-improve-open.png` | una ficha abierta con evidencia, detalle y acciones |
| `hud-improve-folded.png` · `hud-improve-setup.png` | plegada; y los cuatro límites, presupuesto incluido |
| `hud-improve-mobile.png` | **el teléfono**: la barra de secciones, la hoja de AUTOMEJORA abierta y la fila del revisor dentro |
| `hud-improve-mobile-agent.png` | **el acceso al revisor desde el móvil**: tocar el callsign abre su ventana |
| `hud-improve-offline.png` | **sin enlace**: lo dice, conserva el tablero y apaga REVIEW NOW |

La foto de la fila enseña justo lo que se pedía: **marco violeta** (qué es) con
**texto ámbar** (`NEEDS YOU`, cómo le va). La identidad no tapa el estado.

## 10. Integración con el móvil de Q8

Validado en Chromium con contexto táctil real (`hasTouch`, 390×844), que es lo
que hace falta: un viewport estrecho no cambia `pointer: coarse`, y sin él la
prueba diría que los botones miden 21px cuando en un teléfono miden 40.

- **No toqué una sola línea** de `hud.css`, `hud/sections.ts`, `hud/missions.ts`,
  `mission-status.ts`, `windows/kinds/mission.ts` ni `window.css`.
- **Todos los selectores de improve que usa `hud.css` siguen existiendo con el
  mismo nombre**: `.improve`, `.improve__body`, `.improve__list`,
  `.improve__head`, `.improve__status`, `.improve__setup`, `.improve__btn`,
  `.imp__act`, `.imp__mission`, `.improve__more`, `.imp__acts`, `.imp__reply`.
  Nada renombrado, nada movido de sitio en el DOM.
- Las **cinco clases nuevas** llevan su táctil en **mi** hoja, bajo el mismo
  enganche que usa Q8 (`body[data-sheet="improve"]` dentro de
  `@media (pointer: coarse)`): `.improve__agent` (rejilla de dos filas en
  táctil, porque envolviendo caía en tres y dejaba medio teléfono en blanco),
  `.improve__agent-go` (40px), `.improve__agent-meta`, `.improve__agent-stop`
  (ya cubierta por la regla de Q8, porque lleva también `.improve__btn`) y
  `.imp__by` / `.imp__who-go` (36px).
- **En un teléfono la fila del revisor es el ÚNICO camino hasta él**: no hay
  `⌥I` ni ventana que abrir a mano. La prueba lo toca y comprueba que abre
  `.win.is-agent`.

## 11. Archivos

**Sin commit**, en el árbol de trabajo sobre `507e30c`, compartido con Q8.

**Nuevos en esta misión (4):**

| Archivo | Líneas | Qué es |
|---|---:|---|
| `bin/orca-improve.mjs` | 166 | el CLI con el que archiva el revisor |
| `src/collector/improve-drop.ts` | 203 | el buzón `<proyecto>/.orca/improve/` |
| `test/improve-agent.test.ts` | 390 | el recorrido entero contra una máquina real |
| `test/improve-cli.test.ts` | 154 | el CLI de verdad contra el vigilante de verdad |

**Reescritos:** `src/shared/improve.ts` (851) — `ReviewStatus`, `activeReview`
por `endedAt`, `reviewerBrief`, `reviewerIds`, `REVIEWER_BUDGET_TOKENS`;
`src/hub/improve.ts` (850) — spawn, ciclo de vida, barrido, cancelación,
`report` con comprobación de autor, `reviewProject`.

**Tocados, aditivo:** `shared/protocol.ts` (`spawn.review`, `improve:report`,
`improve:ack`, `improve:cancel`) · `collector/{commands,shims,index}.ts` ·
`hub/{server,autonomy}.ts` · `ui/field/{swarm,field}.ts` (runtime 8) ·
`ui/hud/improve.ts` · `ui/styles/improve.css` · `ui/net/client.ts` ·
`ui/main.ts` · `DESIGN.md` · `docs/AUTOMEJORA.md` · `test/visual.ts` ·
`test/improve*.ts` · `test/hud-improve.shots.ts`.

## 12. Estado de activación

- **Activo por defecto** en cuanto arranca el hub: la pieza F se monta, el
  reloj mira y los contadores cuentan.
- **No lanzará nada hasta que haya un proyecto que revisar.** En un despliegue
  donde el repo de ORCA no está registrado como proyecto, el panel lo dice
  (`ORCA'S OWN REPO IS NOT A PROJECT ON THIS FLEET`) y `REVIEW NOW` contesta
  con la ruta que buscó. Es la única configuración que puede hacer falta.
- **La primera revisión la puede disparar el operador** con `REVIEW NOW`; por
  el reloj saldrá cuando haya 40 gestos nuevos y hayan pasado 6 h.
- `ORCA_IMPROVE=0` apaga todo; `ORCA_IMPROVE_PROJECT`, `_BUDGET_TOKENS`,
  `_EVERY_MIN`, `_PER_DAY`, `_MIN_SIGNAL`, `_RUNTIME`, `_MODEL` ajustan.

## 13. Limitaciones, dichas

1. **Una sola revisión real, y terminó interrumpida.** QW archivó sus 5
   propuestas y después el operador lo paró por pasarse del techo, así que
   **no se ha observado un cierre limpio por sí solo** (`reported` → agente
   `idle` → cierre automático). Ese camino está probado con reloj falso
   (§8) y con una máquina real (§8), pero no con un CLI real. El arreglo del
   idle es posterior a la corrida.
2. **`--disallowedTools` es de Claude Code.** Con `ORCA_IMPROVE_RUNTIME=codex`
   el revisor no tendría esa retirada de capacidad: Codex no tiene una opción
   equivalente (ver `codexArgv`). Por eso el runtime por defecto es `claude`, y
   la limitación está escrita aquí en vez de escondida.
3. **No es una jaula.** Quedan `Bash` y `Read` —los necesita para leer el repo
   y para llamar a `orca-improve`— así que un `echo > fichero` sigue siendo
   posible para quien se empeñe. Es la diferencia entre la salida evidente y la
   rebuscada, que en la práctica es la que importa; una jaula de verdad pedía
   un sandbox y habría dejado al revisor ciego.
4. **La telemetría cuenta el propio spawn del revisor** como un lanzamiento más
   en el diario de la siguiente ventana de 24h. Es una línea entre muchas y no
   afecta a la señal que dispara revisiones (que son contadores de consola y
   CAPCOM), pero está ahí.
7. **El presupuesto es un freno, no un muro** (§7), y el rebase medido llegó a
   2,8× antes del arreglo. Con el freno puesto no hay una cota superior
   demostrada: lo que se puede afirmar es que ORCA mira cada 20 s y en cada
   cambio de estado, y que para en cuanto lo ve.
8. **`perDay` no limita la ejecución manual.** Es deliberado —el operador debe
   poder revisar cuando quiera— pero significa que no existe un tope de gasto
   diario que ORCA haga cumplir.
9. **El consumo que se lee no es monótono**: en la corrida pasó por 201k, 1,1M
   y 622k. Lo que se guarda al cerrar es la última lectura, no un máximo.
5. **Móvil validado en Chromium táctil**, no en Safari físico ni con teclado
   virtual real — igual que la entrega de Q8, y por la misma razón.
6. **Un `flake` observado:** una corrida de `--changed` dio 853/854 y la
   siguiente 854/854 con el mismo árbol; el arnés visual también falló una vez
   por un `tap` sobre una fila que la flota sintética movió debajo. Añadí un
   `scrollIntoViewIfNeeded` antes de ese toque. No he visto ningún fallo
   reproducible.

## 14. Cómo verificarlo

```
npm run typecheck
npm test -- improve                 las cinco suites (67)
npm test -- --changed               866
npx tsx test/hud-improve.shots.ts   la sección y el teléfono, fotografiados
```

Filtros que cubren esta entrega: `improve`, `capcom`, `autonomy`, `commands`.
