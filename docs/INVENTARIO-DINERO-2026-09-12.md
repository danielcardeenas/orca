# Inventario: dónde aparece el dinero en ORCA

**2026-09-12 · misión `mission_mty0dljurtf23kl5`.** Primer entregable: el mapa
de todo lo que hoy presenta o usa dólares, antes de cambiar nada.

## La regla del operador

Todo se paga con **plan plano**, Claude incluido. No se usan llamadas a la API.
Ninguna cifra en dólares de ORCA corresponde a un cobro: son estimaciones o
totales que un CLI escribió en su transcript, y el operador los describe como
«no significa nada». El dinero deja de ser medida de control; ocupan su lugar
el **uso** (tokens, con la regla de `ceilingTokens`: entrada + salida +
escritura de caché, la lectura de caché no cuenta) y el **tiempo** (minutos
activos).

## Lo que está medido hoy

`~/.orca/hub/budgets.json`, leído el 2026-09-12:

| | |
|---|---|
| Techos configurados | 23 |
| En dólares (con o sin minutos) | 20 |
| En tokens | 3, de 400k, los revisores de AUTOMEJORA |
| **De agentes que siguen en la flota** | **0** |

Los 23 apuntan a agentes que ya no existen: 14 están en `archived.jsonl`
(`done`), y los 9 restantes ni siquiera eso — el journal los da terminados
entre el 2026-09-07 y el 2026-09-11. Ningún agente vivo de los 22 que hay
ahora mismo en el mundo tiene techo propio, y los defaults de entorno
(`ORCA_DEFAULT_BUDGET_*`) están vacíos. El libro de presupuestos hoy **no frena
a nadie**, ni en dólares ni en tokens.

`ORCA_BUDGET_MONEY` está apagado (es el defecto desde el 2026-09-11), así que
el eje en dólares de esos 20 techos ya está inerte: sólo se evalúa su `min`.

Los 20 en dólares, con lo que el journal registró de cada uno:

| Techo | Agente | Fin | Destino |
|---|---|---|---|
| $12 / 60m | `4ee5ac1c` 79 [OR] | done, $6.90 | huérfano |
| $6 / 90m | `79269d77` KP [OR] | done, $3.59 | huérfano |
| $30 / 150m | `56e48c71` 6J [OR] | done, $20.71 | huérfano |
| $30 | `8ecbcf65` DH [OR] | done, $10.26 | huérfano |
| $12 / 60m | `34e45cbe` B9, squad ideas-01 | archivado | huérfano |
| $12 / 60m | `277ca5d0` | sin rastro en journal ni archivo | huérfano |
| $12 / 60m | `d6725230` CG, ideas-01 | archivado | huérfano |
| $12 / 60m | `6680b082` D6, ideas-01 | archivado | huérfano |
| $12 / 60m | `d81fe429` KC, ideas-01 | archivado | huérfano |
| $1 / 5m | `22645b3e` | sin rastro | huérfano |
| $12 / 60m | `a470e6fd` CC, ideas-01 | archivado | huérfano |
| $12 / 60m | `0fb5ba34` EY, ideas-01 | archivado | huérfano |
| $12 / 60m | `efb0c3a6` XQ, ideas-01 | archivado | huérfano |
| $12 / 60m | `fe13a0f3` G0, ideas-01 | archivado | huérfano |
| $12 / 45m | `06fbaf4f` 1C, ideas-01 | archivado | huérfano |
| $18 / 75m | `5105675a` TA, rubric-01 | archivado | huérfano |
| $18 / 75m | `cb83f890` 3L, rubric-01 | archivado | huérfano |
| $18 / 75m | `777b1182` 7P, rubric-01 | archivado | huérfano |
| $18 / 75m | `42d5bdc3` AW, rubric-01 | archivado | huérfano |
| $18 / 75m | `a49447bf` RT, rubric-01 | archivado | huérfano |

Y los 3 en tokens, `30df816e` QW, `1570e332` EX y `fed2ad80` AJ: los tres
terminados también. Son residuo igual, aunque su unidad ya sea la correcta.

**Consecuencia para la entrega:** no hay ni un techo que *convertir*. Los 20 en
dólares se retiran, y con ellos los 3 en tokens que apuntan a muertos. Lo que
sí hace falta es que retirarlos no sea un gesto manual que haya que repetir
cada semana: el libro tiene que podar solo lo que apunta a un agente que ya no
existe.

---

## 1 · Los techos

| Dónde | Qué hace con el dinero |
|---|---|
| `src/hub/budgets.ts` | `BudgetLimit.usd`; `BudgetConfig.money / defaultUsd / usdPerMTok`; `spend()`, que estima dólares desde tokens con `CACHE_USD_WEIGHT`; `Consumption.spent_usd` y `estimated`; el eje usd de `pct()`; `figures()`, que imprime `≥$3.88 of $12.00 (32%)` |
| Entorno | `ORCA_BUDGET_MONEY`, `ORCA_DEFAULT_BUDGET_USD`, `ORCA_BUDGET_USD_PER_MTOK` |
| `src/agents/tools.ts` | `set_budget` con `budget_usd`; `spawn_agent` con `budget_usd`; `spawn_squad` con `budget_usd` y `squad_budget_usd`; el resumen `$12 (stored, money mode off)`; `policy.unit: 'tokens + usd'` |
| `src/collector/briefs.ts:269` | El brief de CAPCOM explica `budget_usd` y `squad_budget_usd` |
| `docs/BUDGETS.md` | §1 «la unidad», §2 «el estimador que mentía», §6 y §7 |

Las alertas `[BUDGET 80%/100%/STOP]` salen de `figures()`: con el dinero
apagado ya no nombran dólares. Ésa es la única superficie del dinero que ya
está limpia hoy.

## 2 · Lo que devuelven las herramientas de CAPCOM

| Dónde | Qué presenta |
|---|---|
| `src/agents/tools.ts:1094` | `list_fleet` → `spend_usd` por proyecto (17,44 en OR; 10,38 en SI) |
| `src/agents/tools.ts:3272` | La línea corta de `list_fleet`: `· $17.44` |
| `src/agents/tools.ts:2006, 2036` | `inspect_squad` → `spend_usd` por miembro y en totales |
| `src/agents/tools.ts:2348, 2357, 2366, 2398` | `budgetView` / `scopeView` / `projectBudget` → `spent_usd`, `usd_is_floor`, `limit_usd`; los lee `inspect_agent`, `inspect_squad` y `list_fleet` |
| `src/agents/tools-journal.ts:140` | `journal_stats` → `$X total`; y la descripción de la herramienta promete «coste medio por proyecto» |
| `src/agents/tools.ts:1042, 1053` | `purge_synthetic` → «$X of fictitious spend» |

## 3 · El journal

| Dónde | Qué |
|---|---|
| `src/hub/journal.ts:105` | `JournalEntry.costUSD`, escrito en cada `end` |
| `src/hub/journal.ts:772` | `recordEnd` lo redondea a 4 decimales y lo guarda; junto a `tokens: {input, output, cacheRead, thinking}` — **sin `cacheWrite`**, así que la entrada histórica no basta para aplicar `ceilingTokens` con exactitud |
| `src/hub/journal.ts:236, 263, 520, 545, 581` | `JournalStats.cost{totalUSD, avgUSD}` y `ProjectStats.totalCostUSD / avgCostUSD` |
| `src/hub/journal.ts:681` | `endLine()` → `$1.29` en la línea que ve CAPCOM |

Miles de entradas ya escritas. **No se reescriben.**

## 4 · AUTOMEJORA

| Dónde | Qué |
|---|---|
| `src/hub/improve.ts:800, 828, 833` | `money()` y el digest de telemetría: `cost: $12.40 total, $1.03 per agent` y `by project: OR 40L 3✝ $12.40` |
| `src/shared/improve.ts:266` | `ImproveReview.costUSD`, lo que costó una revisión |
| `src/hub/improve.ts:470, 502, 1013, 1032, 1088` | `settleOutcome` / `closeReview` guardan `{costUSD, tokens}` al cerrar |
| `src/shared/improve.ts:71` | `ImproveArea` incluye `'cost'` — es una **categoría de propuesta**, no una cifra: se queda |

## 5 · El mundo, la historia y el collector

| Dónde | Qué |
|---|---|
| `src/shared/types.ts:264, 314` | `AgentMetrics.costUSD` y `SessionRollup.costUSD` |
| `src/collector/derive.ts:375` | De dónde sale: el `cost-state` del transcript de Claude (`totalCostUSD`) |
| `src/collector/codex.ts:429` | Codex escribe `costUSD: 0` — correcto con plan plano, no un agujero |
| `src/collector/index.ts:1935, 2086, 2102` | Traza de depuración `$0.00`, detección de cambio y rollup por proyecto |
| `src/hub/world.ts:318, 924-955, 2409` | Rollup de proyecto y de flota; `fleet.costUSD` es lo que alimenta el gauge SPEND |
| `src/hub/world.ts:789-798, 930-934, 1519-1596` | `synthCostUSD` y `purgeSynthetic`: descontar el gasto del arnés sintético |
| `src/hub/history.ts:15, 82, 91, 117, 165-178, 451-479` | La serie temporal guarda `costUSD` por agente y por instantánea, **en el formato de disco** |
| `src/shared/debrief.ts:47-246` | `costUSD` por agente y sumado, lo que lee la ventana de misión |

## 6 · La consola

| Dónde | Qué se ve |
|---|---|
| `src/ui/hud/mast.ts:44` | El gauge **SPEND** del mástil, junto a WORKING / IDLE / TOK\_S |
| `src/ui/field/labels.ts:259` | La celda **COST** en la fila de métricas de **cada tile** del campo |
| `src/ui/windows/kinds/agent.ts:251` | El bloque **COST** de la ventana de agente |
| `src/ui/windows/kinds/fleet.ts:175, 222` | `$X` por fila y el total del panel FLEET |
| `src/ui/windows/kinds/ceo.ts:688` | El stat de dinero junto a cada agente en la ventana de CAPCOM |
| `src/ui/windows/kinds/mission.ts:377, 514, 521` | Coste por agente y total de la misión en el debrief |
| `src/ui/windows/kinds/timeline.ts:335` | `SPENT $X` en el replay |
| `src/ui/windows/mission-crew.ts:55, 124` | `costUSD` de la tripulación |
| `src/ui/field/layout.ts:223, 715` | `DeckSort` incluye `'cost'`: se puede **ordenar la cubierta por dinero** |
| `src/ui/util.ts:121` | `money()`, el formateador que usan todas las de arriba |
| `src/ui/store.ts:679`, `src/ui/history.ts:90-160` | Recomponen el rollup y el replay sumando `costUSD` |

## 7 · El CLI

`bin/orca.mjs`: `money()` (291) y sus cuatro usos — `orca fleet` (302),
`orca squad` (319), `orca journal` (400) y `orca journal --stats` (428, 434).

## 8 · Documentación

`docs/BUDGETS.md` (el capítulo entero de la unidad), y de pasada
`docs/AUTOMEJORA-REVISOR.md`, `docs/IDEAS.md`, `docs/CONTRACT-REQUESTS.md`,
`docs/IDENTITY.md`, `docs/SYNTHETIC-HARNESS.md`. Las entregas fechadas
(`docs/ENTREGA-*`) son historia y no se tocan.

---

## Qué se hace con cada cosa

Tres destinos, y ninguna pieza cae en dos:

**Se va de la vista.** Toda superficie donde el dinero es la cifra que se lee:
el gauge SPEND, la celda COST de cada tile, el bloque COST de la ventana de
agente, la columna y el total de FLEET, el stat de CAPCOM, el `SPENT` del
replay, el coste de la ventana de misión, el orden `cost` de la cubierta,
`spend_usd` en `list_fleet` / `inspect_squad` / `inspect_agent`, el `$X` de
`journal_stats`, de `endLine` y del CLI, y la línea `cost:` del digest de
AUTOMEJORA. En su lugar va **uso**: tokens con `ceilingTokens`, y minutos donde
el tiempo diga algo.

**Se queda medido, pero no se presenta ni se suma.** `AgentMetrics.costUSD`
sigue llegando del transcript y sigue viajando en el mundo, en la historia y en
el journal: es un dato que el CLI escribe y quitarlo del modelo rompería el
collector, el formato de disco de `history.ts` y la lectura de miles de
entradas ya escritas, a cambio de nada. Lo que se quita es su papel: ninguna
agregación lo suma para presentarlo, ningún techo lo evalúa.

**El `costUSD` histórico del journal: se ignora al leerlo, no se reescribe.**
Reescribir miles de entradas para borrar un número que ya nadie mira sería
falsificar el registro de lo que ORCA creyó en su momento, y el riesgo de
estropear el fichero es real. Así que las entradas se quedan como están, y es
el **lector** el que cambia: `journal_stats` deja de devolver `cost` y devuelve
uso, y `endLine` deja de imprimir `$`. Quien quiera el número viejo lo tiene
donde siempre estuvo, en la entrada cruda, y sabe por este documento qué
significa: una estimación de un plan plano, no un cobro.

Una consecuencia que hay que arreglar en la entrega: las entradas `end` del
journal guardan `tokens` **sin `cacheWrite`**, así que el uso de una entrada
vieja sólo se puede medir con el fallback de `ceilingTokens` (entrada + salida
+ lectura de caché). Las entradas nuevas guardarán `cacheWrite` y se medirán
con la regla exacta.

**Los techos.** Ninguno de los 23 alcanza a un agente vivo; los 20 en dólares
se retiran y los 3 en tokens también, por apuntar a muertos. `set_budget` deja
de aceptar `budget_usd` como eje de control, y el libro poda solo lo que apunta
a un agente que ya no existe, para que este inventario no haya que repetirlo.

---

## Filtros que cubren esto

Este documento es un inventario: no cambia código y no tiene pruebas propias.
Los filtros de la entrega que viene van en su documento.
