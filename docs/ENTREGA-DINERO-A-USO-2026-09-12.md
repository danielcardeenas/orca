# El dinero sale de ORCA, el uso ocupa su lugar

**2026-09-12 · misión `mission_mty0dljurtf23kl5`.** Qué se cambió, qué se
decidió y qué se comprobó en la flota de verdad.

## La regla

Esta flota se paga con **plan plano**, Claude incluido, y no se usan llamadas a
la API. Ninguna cifra en dólares de ORCA correspondía a un cobro. El dinero
deja de ser medida de control y lo sustituye el **uso**: tokens con la regla de
`ceilingTokens` —entrada + salida + escritura de caché, la lectura de caché no
cuenta— y minutos vistos trabajando.

El mapa de dónde estaba el dinero, con fichero y línea, es
[`INVENTARIO-DINERO-2026-09-12.md`](INVENTARIO-DINERO-2026-09-12.md), entregado
antes de tocar nada.

---

## 1 · Los techos

`src/hub/budgets.ts`, `src/agents/tools.ts`, `src/collector/briefs.ts`,
`src/hub/server.ts` · commit `0915077`.

El eje en dólares **se fue del libro**, no se apagó: `BudgetLimit.usd`,
`BudgetConfig.money`, `spend()`, `ORCA_BUDGET_MONEY`,
`ORCA_DEFAULT_BUDGET_USD`, `ORCA_BUDGET_USD_PER_MTOK` y la ponderación de la
caché a 0,1 ya no existen. Con ellos se va el `≥` de las cifras estimadas: las
dos unidades que quedan son medidas y ninguna puede quedarse corta.

`set_budget`, `spawn_agent` y `launch_squad` ya no aceptan `budget_usd` ni
`squad_budget_usd`. Quitar la capacidad vale más que pedir que no se use: un
parámetro que se guarda y no se evalúa acaba puesto, y quien lo pone cree que
frena algo.

Un techo en dólares guardado de antes **se ignora al cargarlo**, y si era su
único eje, el techo entero desaparece.

### El destino de los 23 techos

Medido el 2026-09-12 contra la flota del hub: de los 23 techos del libro,
**ninguno alcanzaba a un agente vivo**. No había ni uno que convertir.

| Techos | Qué eran | Destino |
|---|---|---|
| 14 en dólares (+ minutos) | agentes archivados de `ideas-01` y `rubric-01` | el eje en dólares se cae al cargar; el techo entero lo borra `pruneOrphans` |
| 6 en dólares (+ minutos) | agentes terminados entre el 07 y el 11 de septiembre, ya fuera del archivo | igual |
| 3 en tokens (400k) | los revisores de AUTOMEJORA QW, EX y AJ, los tres terminados | unidad correcta, sujeto muerto: los borra `pruneOrphans` |

Uno a uno, con su callsign y lo que el journal registró de cada uno, en el
inventario.

**Ningún agente vivo se quedó sin freno por el camino**, porque ninguno tenía
techo. Eso es cierto y es también un aviso: los 22 agentes que había en el
mundo corren **sin techo propio y sin default de entorno**
(`ORCA_DEFAULT_BUDGET_TOKENS` y `ORCA_DEFAULT_BUDGET_MIN` están vacíos). El
libro hoy no frena a nadie. Encender un techo por defecto es decisión del
operador y no se ha tomado aquí; un punto de partida razonable para un worker
de Claude con contexto grande está entre 15 y 30 millones de tokens.

### La poda, para no repetir este inventario

`pruneOrphans` corre en cada barrido: un techo cuyo sujeto —agente, escuadrón o
misión— no está en la flota se marca, y se borra si **sigue** sin estar diez
minutos después.

Dos observaciones separadas en el tiempo, y ninguna cuenta con la flota vacía.
Es la asimetría de la vitalidad aplicada al revés: un techo de más no rompe
nada, y borrar el freno de alguien que sí está es el error caro. Un hub recién
relevado ve la flota vacía hasta que el collector habla; podar ahí desarmaría a
la flota entera de una pasada. Si el sujeto reaparece, la marca se borra y el
techo se queda.

Lo que se borra va al log del hub y no a CAPCOM: es un hecho, no un aviso.

---

## 2 · Lo que CAPCOM y el CLI leen

`src/hub/journal.ts`, `src/agents/tools.ts`, `src/agents/tools-journal.ts`,
`src/hub/improve.ts`, `bin/orca.mjs` · commit `620e779`.

| Superficie | Antes | Ahora |
|---|---|---|
| `journal_stats` | `cost: {totalUSD, avgUSD}` | `usage: {tokens, avgTokens, measured}` |
| `journal_stats` por proyecto | `totalCostUSD`, `avgCostUSD` | `totalTokens`, `avgTokens` |
| `endLine` (lo que ve CAPCOM) | `$0.50` | `15k tokens` |
| `list_fleet` por proyecto | `spend_usd` | `tokens` |
| `inspect_squad` | `spend_usd` por miembro y total | `tokens` |
| `inspect_agent` / vistas de techo | `spent_usd`, `usd_is_floor`, `limit_usd` | fuera |
| `purge_synthetic` | «$X of fictitious spend» | cuenta máquinas, agentes y proyectos |
| `orca fleet`, `orca squad`, `orca journal`, `--stats` | dólares | tokens |

`measured` no es decoración: un `0` con `measured: 0` es un journal que no
anotó tokens, y un `0` con `measured: 12` es una flota que no consumió. Sin él
las dos cosas se leen igual.

---

## 3 · La consola

Commit `e96ba8a`.

| Dónde | Antes | Ahora |
|---|---|---|
| Mástil | gauge `SPEND $12.40` | gauge `TOKENS 12.4M` |
| Cada baldosa del campo | celda `COST` | celda `TOKENS` |
| Ventana de agente | bloque `COST` | bloque `TOKENS` |
| Panel FLEET | `$` por fila y total | tokens por fila y total |
| Ventana de CAPCOM | stat en dólares | stat en tokens |
| Replay | `SPENT $12.40` | `USED 1.2M TOK` |
| Debrief de misión | coste por agente y total | uso por agente y total |
| Cubierta | orden `BY COST` | orden `BY USE` |

El orden por dinero merece una nota: con plan plano no ordenaba nada, y con
Codex —que escribe `$0.00` en todo— dejaba a media flota en orden de desempate.
Por uso ordena lo que se quería ver: quién ha gastado más cuota.

Debajo, `SessionRollup.costUSD` pasó a `tokens`, con `ceilingTokens`. El
argumento del arnés sintético no cambia, sólo la unidad: sus agentes se siguen
dibujando y su consumo se sigue restando del total de la flota, por la misma
razón por la que se restaba su gasto.

`money()` se fue de `src/ui/util.ts`: no quedaba quien lo llamara.

---

## 4 · El `costUSD` histórico: se ignora al leerlo, no se reescribe

**Decisión.** El journal guarda `costUSD` en miles de entradas `end` y la serie
histórica lo guarda por agente y por instantánea. **Nada de eso se toca.**

Reescribir el registro para borrar un número que ya nadie mira sería falsificar
lo que ORCA creyó en su momento, y el riesgo de estropear un fichero
append-only de 8 MiB es real a cambio de nada. Lo que cambia es el **lector**:

- ninguna agregación lo suma — `journal_stats` devuelve uso, el rollup del
  mundo cuenta tokens, el debrief mide tokens;
- ninguna superficie lo presenta — ni CAPCOM, ni la consola, ni el CLI;
- el campo sigue en la entrada cruda, donde siempre estuvo, y lleva escrito en
  el tipo (`JournalEntry.costUSD`) que es histórico y por qué.

Quien lo lea directamente sabe ahora qué significa: una estimación de un plan
plano, no un cobro.

Y una consecuencia que había que arreglar para poder medir uso del pasado: las
entradas `end` guardaban `tokens` **sin `cacheWrite`**, que en Claude es casi
toda la entrada. Ahora se guarda. Las entradas viejas se miden con el fallback
de `ceilingTokens` —entrada + salida + lectura de caché—, que mide de más y
nunca de menos, que es el lado correcto del error. La serie histórica hizo lo
mismo: un séptimo campo `tokens` por agente, y una instantánea de seis campos
sigue parseando y vale cero, que es la verdad de un tramo que no lo midió.

---

## 4b · ¿Y comparar modelos? Tampoco se queda

La misión dejaba una puerta abierta: si una estimación de coste seguía siendo
útil para **comparar modelos**, podía quedarse rotulada como estimación de un
plan plano. No se quedó ninguna, y conviene decir por qué en vez de dejarlo en
un silencio.

La única superficie que podía servir para eso era el coste medio por proyecto
de `journal_stats`. No compara modelos:

- **Mezcla adaptadores, no modelos.** Codex escribe `$0.00` en todo su
  transcript. Un proyecto llevado con Codex sale gratis y uno llevado con
  Claude sale caro, diga lo que diga el modelo que hubo detrás. Eso no es una
  comparación: es una lista de qué CLI reporta coste.
- **La tarifa no es la del plan.** El `costUSD` de Claude sale del `cost-state`,
  calculado con precios de API. Comparar dos modelos con una tarifa que no se
  paga es comparar dos ficciones.
- **Los tokens sí comparan, y de verdad.** `usage.tokens` con `measured` sale
  del transcript de los dos CLI, con la misma regla, y dice lo único que aquí
  se agota: cuánta cuota costó el trabajo. Si algún día hace falta ponerle
  precio a esa cifra para comparar proveedores, se hace sobre el uso medido y
  en el momento de la comparación, no guardando dólares en cada entrada.

---

## 5 · El relevo: no quedó pendiente, ocurrió solo

La misión pedía no reiniciar nada y avisar del relevo pendiente. **No se
reinició nada a mano, y aun así el relevo ocurrió**: el hub y el collector de
producción corren bajo `tsx`, que vigila `src/`, así que guardar en
`src/hub/budgets.ts`, `src/hub/server.ts`, `src/hub/world.ts`,
`src/hub/journal.ts` y `src/collector/index.ts` los relanzó por su cuenta. Es
un efecto conocido de cómo está levantada la flota, no una decisión de esta
entrega, y conviene que quede escrito porque cambia lo que hay que mirar.

Medido a las 15:22 del 2026-09-12:

| Qué | Evidencia |
|---|---|
| Hub relevado | pid 41058, arrancado 15:18:56 |
| Collector relevado | pid 40681, arrancado 15:18:55, bajo `tools/supervise.mjs` |
| Consola reconstruida | `dist/assets/index-jXkFfBEB.js`, 15:14 · 4 veces `TOKENS`, 0 veces `SPEND` |
| `/api/health` | publica `"tokens": 5397599` donde publicaba `costUSD` |
| `~/.orca/hub/budgets.json` | reescrito a las 15:02 con la forma nueva: `{tokens, min}`, **ni un `usd` en el fichero** |

### Los 23 techos: se fueron, y esto es lo que pasó

No hizo falta borrarlos a mano. Al relevarse el hub:

1. los que sólo tenían dólares se cayeron al cargar, porque `normalizeLimit` ya
   no lee ese eje y `hasLimit` dijo que no quedaba nada que evaluar;
2. los que además tenían minutos sobrevivieron a la carga como techos de
   tiempo, y `pruneOrphans` los marcó en la primera pasada y los borró en la
   siguiente, pasados los diez minutos, por no quedar sujeto;
3. los 3 en tokens de los revisores, igual.

Lo que hay ahora en el libro son **5 techos, todos en tokens**, puestos por
CAPCOM después del relevo: uno de 400k, uno de escuadrón de 1,8M y tres de
600k. Ni un eje en dólares, ni un techo huérfano.

El mecanismo se ensayó además en frío antes de esto, sobre una copia del
`budgets.json` de 23 techos y la flota real: 23 cargados → 0 en dólares → 5
marcados en la primera pasada → 5 borrados en la segunda, once minutos después,
y el disco reescrito sin un solo `usd`.

### Qué mirar si hace falta comprobarlo otra vez

1. `cat ~/.orca/hub/budgets.json` — ni un `usd`, ni un techo de alguien que no
   esté en la flota.
2. En el log del hub, cuando poda: `techos retirados por no quedar sujeto: …`.
   Si no sale nunca, comprobar que la flota no esté vacía: con cero agentes en
   el mundo la poda no corre, a propósito.
3. En la consola (`localhost:4478/?k=$(cat ~/.orca/token)`): el mástil dice
   `TOKENS` y no `SPEND`; una baldosa cualquiera dice `TOKENS` bajo su cifra;
   el menú de la cubierta ofrece `BY USE`.
4. `node bin/orca.mjs journal --stats` imprime `… tokens over N measured …` y
   ningún `$`.
5. `set_budget` con `budget_usd` debe ser rechazado por el esquema: el
   parámetro ya no existe.

---

## 6 · Lo que NO se tocó

Por instrucción de la misión: `src/collector/model-control.ts`,
`src/collector/capcom-reset.ts` y la regla de `ceilingTokens` en
`src/shared/tokens.ts` —que es la base de todo esto y se usa tal cual, sin
cambiarla.

`AgentMetrics.costUSD` se queda: lo escribe el CLI en su transcript y lo lee el
collector. Quitarlo del modelo rompería el collector, el formato de disco de la
historia y la lectura de lo ya escrito, a cambio de nada. Lo que se le quitó
fue el papel.

`ImproveArea` conserva la categoría `'cost'`: es una etiqueta de propuesta —«de
qué va esta idea»— y no una cifra de dinero.

### Una nota sobre el árbol compartido

Durante esta entrega otros agentes trabajaban en el mismo checkout. Dos cosas
que quedan dichas:

- `src/shared/types.ts`, con el cambio de `SessionRollup.costUSD` a `tokens`,
  se fue a `main` dentro de un commit ajeno (`f9a8133`, sobre artefactos). El
  código es correcto y está donde tiene que estar, pero no lo stageó quien lo
  escribió.
- El `npm run typecheck` de esta entrega da limpio salvo errores de otro
  trabajo en curso en el mismo árbol (`Artifact.source` sin declarar,
  `ImproveKind` sin `'measured'`), ajenos a estos ficheros.

---

## Filtros que cubren esto

```
npm test -- budgets            los techos: unidades, poda de huérfanos, el
                               techo en dólares que se cae al cargarlo, el hub
npm test -- journal            uso por proyecto, endLine, entryTokens, el CLI
npm test -- debrief            el parte de misión en tokens
npm test -- mission-crew       la nómina de la misión
npm test -- history            la serie, el séptimo campo y el uso del intervalo
npm test -- hub synthetic      el rollup de la flota y el arnés que no suma
npm test -- collector          el rollup por proyecto del collector
npm test -- briefing           el briefing sin cifras en dólares
npm test -- improve gestures   el digest de AUTOMEJORA
npm test -- worker-recovery    que un handoff no reinicia el consumo
npm test -- multi-machine      los esquemas de spawn sin budget_usd
```

La suite completa se corrió al cerrar la entrega: **1338/1338** antes de los
últimos commits y **1362/1362** después, sin un solo fallo.

Una nota sobre correr la suite en un árbol compartido: una pasada intermedia
dio 1354/1355, con `forge-field` cayendo en
`Cannot access 'TILE_W' before initialization`. No era de esta entrega —
`npm test -- forge-field` pasa aislado, antes y después—: otro agente commiteó
`src/ui/field/shelf.ts` mientras Vite servía ese módulo a la prueba. Si vuelve
a salir, mirar primero `git log` de lo que el error nombra antes de buscarlo en
el propio cambio.
