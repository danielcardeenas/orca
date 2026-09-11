# Presupuestos, descendencia y vitalidad

Qué mide ORCA cuando dice que un agente se está pasando, qué frena cuando un
agente se multiplica, y cómo decide el hub que un agente sigue existiendo.

Los tres van juntos porque los tres fallaron a la vez, en la misma operación de
tres horas con veinte agentes, y porque comparten mecanismo: contar consumo y
actuar sobre él.

---

## 1 · La unidad: tokens, no dólares

**Decisión: la unidad por defecto son TOKENS — entrada + salida + escritura de
caché; la lectura de caché no cuenta** (desde el 2026-09-11; antes contaba, ver
abajo). El dinero sigue en el modelo de datos, apagado. La regla vive en una
sola función, `ceilingTokens` (`src/shared/tokens.ts`), que usan todos los
techos.

### Por qué

Quien opera ORCA lo hace con suscripciones de Claude Code y de Codex. Los
dólares que un CLI escribe en su transcript no salen de su bolsillo: lo que se
agota es cuota. Un aviso en dinero le pedía reaccionar a un número que no paga,
y encima lo pedía mal — ver §2.

### Por qué esos tokens y no otros

- **No sólo los de salida.** Un agente que lanza veinte subagentes escribe poco
  y lee muchísimo. Un techo en tokens de salida habría hecho parecer barato al
  agente que consumió el equivalente a $74: es exactamente la forma del
  incidente que hay que frenar.
- **No los de lectura de caché** (revertido el 2026-09-11). La primera versión
  los contaba con este argumento: son la mayor parte del volumen de un agente
  con contexto grande, y reenviar un contexto enorme en cada turno es como una
  sesión larga quema cuota. En la práctica medían otra cosa: un CLI con un
  prompt de sistema grande relee todo su prefijo cacheado en cada llamada, y
  eso suma cientos de miles de tokens que cuestan la décima parte y no son
  trabajo nuevo. El revisor de AUTOMEJORA cruzaba su techo de 400k en el
  primer minuto sin haber archivado nada (AJ: 227.946 leídos de caché contra
  12 de entrada y 2.657 de salida). Un contexto que crece se sigue notando:
  lo que entra nuevo al contexto es escritura de caché, y ésa sí cuenta.
- **Sí los de escritura de caché.** En Claude son casi toda la entrada:
  `input_tokens` sale en unidades porque el resto entra por
  `cache_creation_input_tokens`. Sin ellos el techo de un agente de Claude no
  mediría casi nada. En Codex la escritura ya viene dentro de la entrada.
- **Entrada es lo que no salió de caché, en los dos CLI.** Claude ya lo reporta
  así; Codex incluye lo cacheado en `input_tokens` y su adaptador lo resta.
- **No los de razonamiento.** Vienen ya dentro de los de salida
  (`output_tokens_details.thinking_tokens`); sumarlos sería contarlos dos veces.

### Y son medidos, no estimados

Salen del transcript. No hay tarifa, no hay conjetura y por tanto no hay forma
de que la cifra se quede corta, que era el segundo defecto.

### Cómo se enciende y se apaga el dinero

| | |
|---|---|
| Apagado (por defecto) | `budget_usd` se guarda en el libro y **no se evalúa**. Ningún aviso menciona dólares. |
| Encendido | `ORCA_BUDGET_MONEY=1` en el entorno del hub. El eje en dólares vuelve a contar, junto al de tokens. |

No se borró nada: un techo en dólares puesto hoy sigue ahí y empieza a contar
el día que un proyecto consuma API de pago. `set_budget` lo dice al ponerlo:
`budget on K9: 2.5M tokens / $12 (stored, money mode off)`.

### El tiempo

`budget_min` mide **minutos trabajando**, no minutos desde el lanzamiento. El
libro acumula tiempo sólo mientras ve al agente en `booting`, `thinking` o
`working`, en su propia pasada; funciona igual con Claude, con Codex o con
cualquier otro CLI porque no depende de que el runtime escriba una duración.

Un agente en idle acumula cero. Ése era el aviso por reloj.

---

## 2 · El estimador que mentía

El hub reportaba ~$10 donde el journal registró $105,54, y $3,67 donde el real
fue ~$23: entre 6 y 20 veces por debajo. Tres causas, las tres arregladas:

1. **No incluía a la descendencia.** El consumo de los subagentes `Task` de un
   worker no se cargaba a nadie hasta el cierre. Ver §3.
2. **Ignoraba la lectura de caché.** La estimación sumaba entrada y salida y
   dejaba fuera el grueso del volumen. Ahora la pondera a 0,1, que es la
   proporción a la que la cobran los proveedores.
3. **Se presentaba como un total.** Un `~$10` invita a leerlo como la cifra.
   Ahora una cifra estimada lleva `≥` delante: `≥$10.00 of $12.00`. Es un
   **suelo**: la verdad es eso o más.

Y sobre todo: con tokens como unidad por defecto, la cifra que gobierna el
aviso ya no es una estimación de nada.

---

## 3 · La descendencia

### Se cobra al ancestro, en la misma pasada

Un subagente `Task` no tiene presupuesto propio: existe dentro del turno de su
padre y lo que gasta se carga a su ancestro **en cada barrido**, no al cerrar.
Ésa era la razón de que un lead llegara al 618 % de su techo antes del primer
aviso.

Un agente que ORCA lanzó como sesión completa **sí** es sujeto de presupuesto
propio y **no** se carga a quien lo lanzó: para eso está el techo de escuadrón.
La frontera es `Agent.subagent`, que ya distinguía las dos cosas.

Los avisos lo dicen: `… · includes 24 live Task subagents`.

### El freno

| Variable | Por defecto | Qué es |
|---|---|---|
| `ORCA_MAX_DESCENDANTS` | `8` | Subagentes `Task` vivos bajo un agente, subárbol entero. |
| `ORCA_MAX_AGENT_DEPTH` | `2` | Generaciones permitidas: hijos y nietos sí, bisnietos no. |
| `ORCA_SWARM_ACTION` | `warn` | `stop` para además la sesión del ancestro. |

En el incidente: 4 hijos + 24 nietos = 28 vivos sobre un tope de 8. El aviso
sale en el primer barrido en que se cruza.

**Por qué `warn` por defecto.** El hub no puede matar un subagente `Task`
nativo: no tiene sesión propia, no tiene pane, no hay nada que parar. Lo único
parable es el ancestro, y pararlo es una decisión con coste. Así que por
defecto se dice, con claridad y con las acciones que de verdad alcanzan a ese
agente; `ORCA_SWARM_ACTION=stop` para el ancestro para quien quiera la
guillotina.

> El arreglo de raíz —quitarle la herramienta `Task` a un worker en vez de
> pedirle que no la use— vive en el `spawn` del collector y queda fuera de esta
> entrega.

### CAPCOM ve el árbol

`inspect_agent` mostraba `children: []` mientras corrían 24 nietos, porque
`Agent.childIds` lo escribe el collector y llegaba vacío. Ahora el árbol se
deriva de `parentId` sobre la flota entera — la misma fuente que usa el libro
para cobrar, así que lo que se ve y lo que se cobra no pueden discrepar:

```json
"lineage": {
  "parent": null, "depth": 0,
  "children": [ … ],
  "descendants": [ { "callsign": "S1", "generation": 1, "subagent": true, "tokens": 412000 } ],
  "live_descendants": 24, "live_subagents": 24, "max_generation": 2, "truncated": 0
}
```

---

## 4 · Vitalidad: la muerte exige evidencia, la vida no

Éste es el arreglo más importante de la entrega y el que más caro costó
aprender.

### El problema

El collector sólo retira a un agente cuando su **transcript desaparece del
disco**, y un transcript no desaparece porque se cierre el pane: queda ahí con
el último estado derivado congelado. Un escuadrón parado con `stop_squad`
seguía figurando en `working`, con su cría intacta, y desde ahí:

- disparaba `[BUDGET 100%]` en ráfaga — trece de golpe, todos por reloj;
- disparaba `[SWARM CAP]` una y otra vez, con 25 subagentes que no existían;
- y **no lo alcanzaba ninguna herramienta**: `archive_agents` sólo toca a los
  terminados, `stop_agent` sólo a los background, `interrupt_agent` sólo a los
  que tienen pane. Un agente podía quedarse en ese limbo para siempre.

### El error caro, y por qué la regla es la que es

La primera corrección infirió la muerte del silencio: quien decía estar
`working` y llevaba veinte minutos sin escribir en su transcript se daba por
ido. **Marcó muertos a siete agentes vivos en mitad de su turno.** Estaban
razonando, o escribiendo un fichero de quinientas líneas — cosas que no dejan
rastro durante un buen rato. El operador estuvo a punto de relanzar a cinco
evaluadores y duplicar horas de trabajo y de consumo.

Los dos errores no valen lo mismo:

| Error | Coste |
|---|---|
| Dar por vivo a un muerto | Un aviso molesto. Se arregla retirándolo a mano. |
| Dar por muerto a un vivo | Trabajo en curso tirado y consumo duplicado. |

**La asimetría está en el código, no en el criterio de quien lo lee.** El hub
no concluye una muerte a partir de una ausencia de señal. Sólo tres cosas
terminan a un agente, y las tres son alguien **afirmando** algo:

1. el collector dice que terminó (`done` / `dead`);
2. alguien lo paró — `stop_agent`, `stop_squad`, `retire_agent`, o el propio
   libro de presupuestos al despachar una parada;
3. su máquina no está conectada, que es un hecho del hub y no una conjetura
   sobre el agente.

Y todas son **reversibles**: si el agente vuelve a hacer llamadas de
herramienta o a cambiar líneas, se le levanta la losa en la pasada siguiente
sin que nadie intervenga.

### Un solo guardián

`src/hub/liveness.ts` — `isLiveAgent()` — va delante de **toda** comprobación
periódica. El libro de presupuestos y el freno de enjambre preguntan lo mismo,
así que no pueden volver a discrepar. Un agente que no está vivo no cuenta como
miembro, no consume, no dispara avisos, y su cría `Task` se va con él.

### El consejo que dan los avisos es ejecutable

`reachability()` responde, con los mismos predicados que aplican las
herramientas de verdad, qué se puede hacer con un agente concreto. Los avisos
sólo recomiendan lo que funciona:

- con pane → `interrupt_agent` y `stop_agent`;
- background direccionable, sin pane → `stop_agent`;
- ni una cosa ni la otra → `retire_agent`, y se dice por qué es la única.

### Por qué archivar no bastaba: el fantasma resucitaba

B9 pasó por cuatro estados distintos en una tarde, siendo el mismo agente
inexistente: vivo e intocable → `done` por la reconciliación → archivado con su
escuadrón entero (nueve agentes) → **de vuelta en `idle`, con sus veinticinco
subagentes fantasma y un `[SWARM CAP]` nuevo**.

La causa: el collector redescubre las sesiones releyendo los transcripts de
`~/.claude/projects`, y un transcript terminado se vuelve a derivar como
`idle` — que es literalmente el estado «fin de turno» del CLI. El mundo tenía
esta regla:

> Si un archivado vuelve en un estado vivo, es que alguien reanudó la sesión:
> se levanta la lápida.

Que es falsa. Volver en `idle` no prueba nada; es lo que hace *cualquier*
transcript al releerse. Así, archivar limpiaba la foto y no el mundo, y el
guardián de vitalidad tampoco filtraba nada — el mundo decía `idle`, o sea
vivo.

**La regla nueva: una lápida sólo se levanta con actividad POSTERIOR al
archivado.** `updatedAt` del collector es la última actividad real del
transcript, no la hora de la pasada, así que la comparación es exacta. Cierra
las dos puertas: la de `agent:new` y la del patch que pedía un resync.

Es la misma asimetría de §4: equivocarse rechazando a alguien que sí volvió es
barato y reversible —el operador lo desarchiva desde la consola— y equivocarse
readmitiéndolo es un fantasma inmortal.

### La salida manual

**`retire_agent(agent_id, reason)`** — y **`orca retire <K9> --reason "<por qué>"`**
en el CLI, porque una sesión de CAPCOM negocia su lista de herramientas MCP al
arrancar y una herramienta nacida después no existe para el mando en funciones
hasta que reconecte. Un terminal siempre está.

Declara ido a un agente cuya sesión ya no existe, en un solo gesto y de forma
durable:

1. lo marca `dead` con el motivo, que queda en el feed;
2. **se lleva su cría `Task` con él** — un subagente no tiene sesión propia, y
   además un padre con hijos «vivos» no se puede archivar, porque
   `archiveCandidates` lo conserva para no romper el linaje;
3. **los archiva a todos**, que es lo que persiste en disco y lo que impide que
   el redescubrimiento los vuelva a dar de alta.

Marcarlo muerto y dejarlo en la flota no era una salida: la siguiente pasada
del descubridor lo pisaba. La lápida sí aguanta, y sobrevive a un reinicio del
hub.

No mata nada en la máquina (no queda nada que matar) y no borra el transcript.
Si la sesión resulta estar viva y vuelve a escribir, el hub levanta la lápida
por su cuenta.

### La regla general: un consejo tiene que ser invocable

> **Toda acción que el hub recomiende en un aviso tiene que poder ejecutarla
> quien recibe ese aviso.**

Un mensaje que dice «usa `retire_agent`» dirigido a alguien que no tiene
`retire_agent` no es un consejo: es una instrucción imposible de seguir, y
cuesta más tiempo que no decir nada. En un solo día ORCA dio tres:

| La instrucción | Por qué no se podía seguir |
|---|---|
| `interrupt_agent` / `stop_agent` sobre un fantasma | Ni pane ni sesión background: ninguna de las dos alcanzaba. |
| `tmux ls` | Sin `-L orca` mira otro servidor y no lista nada de la flota. |
| `orca-tell …` | No está en el PATH de quien recibía el mensaje. |
| `retire_agent` | Herramienta MCP nacida después de que la sesión de CAPCOM negociara su lista: no existe para él hasta reconectar. |

De ahí dos consecuencias en el código, y no sólo en el criterio de quien
escribe los mensajes:

1. **`reachability()`** decide qué se le puede hacer a un agente con los mismos
   predicados que aplican las herramientas de verdad, y los avisos sólo
   nombran lo que funciona para *ese* agente.
2. **Toda salida existe también en el CLI.** Una sesión MCP negocia sus
   herramientas al arrancar; un terminal siempre está. `retire_agent` tiene su
   `orca retire <K9> --reason "<por qué>"`, y un rechazo imprime el motivo —
   «ya está en done: archívalo con `archive_agents`» es la instrucción
   siguiente, y tragársela deja al operador con un código de salida y nada más.

---

## 5 · Los avisos en ráfaga son un suceso

Trece `[BUDGET 100%]` seguidos, por el mismo motivo y en el mismo instante,
taparon un informe que el operador estaba leyendo. El feed sigue llevando una
entrada por aviso —es historia, y cada una cuelga de su agente— pero **a CAPCOM
le llega un solo mensaje por pasada**:

```
[BUDGET] 13 budget notices in one sweep — 2 stopped, 8 at 100%, 3 at 80%. Worst: 1C at 988%.
· [BUDGET STOP] 1C · 24.1M of 2.5M tokens (988%) · no tool calls or edits in the last 3 min · stopped by the hub. …
· [BUDGET 100%] CG · 18.9M of 8.0M tokens (236%) · includes 4 live Task subagents · still making progress (CG 12s ago); not stopped. …
· …and 7 more, all of them in the console feed.
```

Se ordena por severidad —paradas, enjambre, 100 %, 80 %— y se muestran las seis
primeras completas.

---

## 6 · Qué verá CAPCOM exactamente

```
[BUDGET 80%]  K9 · 8.5M of 10.0M tokens (85%)
[BUDGET 80%]  K9 · squad audit-01 · 8.5M of 10.0M tokens (85%) · 24m of 30m active (80%) · 85% used
[BUDGET 100%] squad rubric-01 (CG, 1C, 3L) · 41.0M of 20.0M tokens (205%) · includes 24 live Task
              subagents · still making progress (CG 12s ago); not stopped. Use stop_agent, or raise
              it with set_budget.
[BUDGET STOP] 1C · mission mission_ab12 · 24.1M of 2.5M tokens (988%) · no tool calls or edits in
              the last 3 min · stopped by the hub. Raise it with set_budget and resume if the work
              must go on.
[SWARM CAP]   B9 · squad ideas-01 · 25 live Task subagents (cap 8) · nested 3 deep (cap 2) · their
              tokens already count against B9. The hub cannot stop a native Task subagent. Use
              stop_agent to end the session, or retire_agent if it turns out the session no longer
              exists. Raise the caps with ORCA_MAX_DESCENDANTS / ORCA_MAX_AGENT_DEPTH.
```

Con `ORCA_BUDGET_MONEY=1` se añade el eje en dólares, con `≥` cuando la cifra es
un suelo: `≥$74.21 of $12.00 (618%)`.

Y lo que **ya no** verá: ni una línea sobre un agente en idle, terminado,
parado o en una máquina no conectada.

---

## 7 · El entorno, completo

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ORCA_BUDGET_MONEY` | apagado | `1` evalúa el eje en dólares. |
| `ORCA_DEFAULT_BUDGET_TOKENS` | ninguno | Techo en tokens para todo worker sin techo propio. |
| `ORCA_DEFAULT_BUDGET_USD` | ninguno | Igual, en dólares. Sólo con el dinero encendido. |
| `ORCA_DEFAULT_BUDGET_MIN` | ninguno | Igual, en minutos **activos**. |
| `ORCA_BUDGET_ACTION` | `stop` | Qué hace el 100 % sin progreso. `warn` sólo reporta. |
| `ORCA_BUDGET_PROGRESS_MIN` | `3` | Minutos de silencio antes de contar como parado. |
| `ORCA_BUDGET_USD_PER_MTOK` | `6` | $/millón para el suelo estimado mientras el CLI no escribe coste. |
| `ORCA_MAX_DESCENDANTS` | `8` | Subagentes `Task` vivos bajo un agente. |
| `ORCA_MAX_AGENT_DEPTH` | `2` | Generaciones de subagentes `Task`. |
| `ORCA_SWARM_ACTION` | `warn` | `stop` para además la sesión del ancestro. |

Los techos por defecto siguen vacíos: cambiar la unidad no es lo mismo que
encender un límite en toda la flota, y encenderlo es decisión del operador. Un
punto de partida razonable para un worker de Claude con contexto grande está
entre 15 y 30 millones de tokens.

El freno de descendencia **sí** viene con valores puestos: ahí no había nada, y
la ausencia de freno fue lo más caro del incidente.

---

## Filtros que cubren esto

```
npm test -- budgets        21 pruebas: unidad, umbrales, tiempo activo, idle, retiro,
                           descendencia, freno, dinero, suelo estimado, agrupado, hub
npm test -- briefing       que el brief de CAPCOM nombre retire_agent y la unidad nueva
npm test -- worker-recovery que un handoff no reinicia el consumo del agente
npm test -- hub            el mundo, la reconciliación y el desalojo
npm test -- archive        que un fantasma releído no resucite y que retire_agent
                           se lleve a su cría y la archive con él
npm test -- --changed      lo que alcance a lo que hayas tocado
```

El CLI se comprueba a mano, que es como se usa:

```
node bin/orca.mjs --help | grep retire
node bin/orca.mjs retire <K9> --reason "<por qué>"
```
