# ¿ORCA llena las conversaciones de contexto repetido?

Informe de la misión `mission_mty0musvu9eijhez` — investigación; no se modificó código.
Medido el 2026-09-12 sobre 135 transcripts reales de `~/.claude/projects/` y el código que
arma los prompts. Tokenizador: `tiktoken/cl100k_base` para el texto; los totales de coste
salen del `usage` real que el CLI graba en cada petición, no de una estimación.

## Contexto

El operador pregunta si estamos llenando las conversaciones de contexto repetido, y si eso
es esperado o desperdicio. CAPCOM aportó cinco pistas. Las cinco están medidas abajo: dos se
confirman, una se desmiente, una se matiza y la quinta identifica la propuesta correcta del
tablero.

## Respuesta corta

**Sí hay repetición, pero casi toda es inevitable y casi nada la mete ORCA.**

- El prefijo fijo de un worker son ~41.000 tokens, y **~39.000 son de Claude Code**, no de
  ORCA. Lo prueba el contraste: sesiones en proyectos que no tienen nada que ver con ORCA
  gastan **más** prefijo (dijosi 50.457, site 50.794) que las de `orca` (41.856 de mediana).
  ORCA aporta ~2.000 tokens: `CLAUDE.md` del proyecto (416), `MEMORY.md` (981) y el brief del
  squad (~600). **El 4,9% del prefijo.**
- Lo que de verdad llena las conversaciones es **el contexto acumulado de la propia sesión**:
  entre el 55% y el 96% de todo el prompt enviado. Eso no es contexto "repetido" por error, es
  la conversación creciendo, y se re-envía entera en cada petición porque así funciona la caché.
- **El único desperdicio puro atribuible a ORCA** es la copia byte a byte del brief de CAPCOM
  en las sesiones de relevo: 4.479 tokens en cada petición, 1.155.582 tokens medidos.

## Las tres formas de sesión

| | prompt turno 1 | turno 20 | último turno | peticiones | prompt total | prefijo × peticiones |
|---|---|---|---|---|---|---|
| CAPCOM directo `4591c244` | 44.037 | 76.245 | 533.329 | 285 | 81.455.648 | 15,4% |
| CAPCOM relevado `1d2c27ff` | 9.419 → 18.749¹ | 101.227 | 425.454 | 157 | 41.068.592 | 3,6% |
| Worker de misión `06e04e5f` (PZ) | 41.111 | 88.178 | 310.246 | 150 | 28.775.884 | 21,4% |
| Revisor AUTOMEJORA `fed2ad80` (AJ) | 41.336 | 86.374 | 141.217 | 49 | 4.550.342 | 44,5% |

¹ arranca en 9.419 y el bloque de instrucciones (9.330 tokens) entra en el turno 29.

En el turno 20 el prefijo ya es minoría en todas: 19–58%. El resto es transcripción.
Ratio prompt/output: **110× a 303×**. Por cada token de trabajo nuevo se re-envían ~250 de
contexto. Eso es lo esperado con caché de prompt, no una anomalía.

Escala de la flota: **3.128 millones** de tokens de prompt en 135 sesiones.

## Las cinco pistas, medidas

### 1. El brief de CAPCOM tres veces — CONFIRMADA. 4.479 tokens por petición.

El bloque `instructions` de la sesión relevada mide 9.330 tokens y contiene tres ficheros:

```
4.479 tok  sha=62dfc94add  ~/.orca/capcom/CLAUDE.md
4.479 tok  sha=62dfc94add  ~/.orca/capcom/handoffs/<id>/CLAUDE.md      ← idéntico
  195 tok  sha=bf3bf9bbce  ~/.orca/capcom/handoffs/<id>/runtime/CLAUDE.md
```

Mismo sha1 y mismo md5 (`8c335acf…`) en disco, en los 13 handoffs archivados. **Por qué pasa:**

- `src/collector/provider-handoff.ts:246` pone el cwd del proceso nuevo en `handoffs/<id>/runtime/`.
- `src/collector/provider-handoff.ts:250` escribe ahí el `CLAUDE.md` que sí toca (el brief bueno).
- `src/collector/provider-handoff.ts:256-258` copia `CLAUDE.md` y `AGENTS.md` del directorio vivo
  a `handoffs/<id>/` **como archivo de respaldo** — el comentario de `:255` lo dice: *"Keep control
  state and earlier archive references before any target process runs"*.

El fallo es que Claude Code carga el `CLAUDE.md` de **todos los directorios ancestros del cwd**.
Como el cwd cuelga de `handoffs/<id>/`, esa copia de archivo se convierte en instrucciones, y el
`~/.orca/capcom/CLAUDE.md` original entra por el mismo camino. Un fichero pensado para que el
operador lo revise acaba pagándose en cada petición.

Sólo ocurre en sesiones de relevo: **2 de 6** sesiones de CAPCOM. Las que corren directamente en
`~/.orca/capcom` no lo tienen (0 tokens duplicados).

| sesión | peticiones | duplicado | coste |
|---|---|---|---|
| `1d2c27ff` | 157 | 4.479 | **698.724** |
| `4b002951` | 102 | 4.479 | **456.858** |

**Caso peor, no medido en transcript pero presente en disco:** en los handoffs de *continuidad*
(`4fd9dfe4`, `ea00dcd0`, `53291e39`, `817e3ad8`, `8b750a80`) el `runtime/CLAUDE.md` no es la
variante corta sino `capcomBrief()` entero, 6.196 tokens, de los que 17 de sus 23 párrafos están
literalmente en el otro fichero. Ahí el brief va **tres veces**: 4.478 + 4.478 + 6.196 = 15.152
tokens de prefijo, de los que ~8.957 son redundancia pura, en cada petición.

Añadido menor: `src/collector/capcom.ts:441` vuelve a llamar `writeConfig(cwd, …)` sobre el mismo
`runtime/`, reescribiendo el fichero que `provider-handoff.ts:250` acaba de escribir. No cuesta
tokens, pero son dos dueños del mismo fichero.

### 2. La etiqueta `[OR]` duplicada — CONFIRMADA, y cuesta 24 tokens en total.

6 de 494 mensajes de misión empiezan por `[OR] [OR]`. `"[OR] "` son 4 tokens: **24 tokens en toda
la historia del hub.** Es un síntoma, no un coste.

Origen exacto, y es el único sitio del repo que antepone el código de proyecto a un texto que
acaba en un prompt:

```ts
// src/agents/tools.ts:2957
mission = ctx.missions.message(mission.id, 'capcom', project ? `[${project.code}] ${first}` : first, 'active');
```

No hay guardia contra un prefijo ya presente. El ciclo se cierra porque `missionPrompt`
(`src/shared/missions.ts:448-451`) devuelve la conversación entera a CAPCOM **con la línea ya
prefijada**; CAPCOM la lee como convención y la reescribe en el siguiente `open_mission`.

**Buscado explícitamente si el patrón "envolver lo ya envuelto" reaparece en sitios más caros: no.**
Los demás `[…]` del repo son etiquetas de squad, escalación o wake, y se generan una sola vez.

### 3. El brief del spawn duplica el mensaje de la misión — DESMENTIDA.

Medido sobre **73 pares** (agente ↔ misión) con solape por n-gramas de 8 y de 5 palabras:

- **Solape mediano: 0%.** Con ambos tamaños de n-grama.
- Máximo observado: 26% (401 tokens) en una sola misión.
- Suma de toda la duplicación en toda la historia: **783 tokens** (k=8) / 1.297 (k=5).

CAPCOM no copia el mensaje de la misión en el brief del spawn: lo reescribe con otras palabras. El
solape es deliberado y mínimo. Esta pista no es un problema.

### 4. Los volúmenes de caché — REALES, pero la cifra citada se quedó corta, y son inevitables.

La pista decía PZ 12,2M leídos contra 86 de entrada. Medido ahora sobre el transcript completo:

| | input fresco | cache_creation | cache_read | output |
|---|---|---|---|---|
| PZ `06e04e5f` | 300 | 279.801 | **28.495.783** | 112.257 |
| AJ `fed2ad80` | 96 | 182.549 | **4.367.697** | 41.395 |

No es que la pista fuera falsa: la sesión siguió creciendo después de que CAPCOM la mirase. La
proporción que señalaba es correcta y aún más extrema.

**Esto es inevitable y no debe contarse como desperdicio.** `cache_read` no es contexto repetido
por error: es el prefijo re-enviado en cada llamada, que es exactamente cómo funciona la caché, y
se factura a 0,1×. Un `cache_read` alto con `input` casi nulo es la señal de que la caché **está
funcionando**. Si bajara el `cache_read` subiría el `cache_creation`, que cuesta 1,25×.

Lo que sí se lee de estos números es **cuánto pesa el prefijo**, y ahí la conclusión es la de
arriba: el prefijo no es el problema; el crecimiento del transcript sí.

### 5. La propuesta que recuerda el operador — es `relevo-de-sesiones-largas`.

`imp_mtw91vbtanjf36w4`, "Relevar a los agentes de larga vida como se releva a CAPCOM". Su
hipótesis dice literalmente que esas sesiones *"gastan sobre todo en releer su propio contexto
acumulado, no en trabajo nuevo"*, y que **"no está medido: el diario guarda el total por sesión,
no el coste por turno ni el tamaño del contexto a lo largo de la vida"**.

Eso es justo lo que pedía esta misión, y queda medido aquí por primera vez. **La hipótesis se
confirma.** La otra candidata, `techo-revisor-cuenta-cache` (`imp_mtw91vbt8bzlw32w`), trata de
cómo se contabiliza el techo del revisor, no de contexto repetido: no es ésta.

Ninguna propuesta del tablero cubre la duplicación del brief de CAPCOM en los handoffs. **Para eso
hace falta una nueva.**

## Qué ahorraría, por orden de lo que ahorra

Simulación sobre los prompts reales turno a turno: relevar cuando el contexto pasa de un umbral,
arrancando la sesión nueva con prefijo + 20.000 tokens de traspaso (generoso: `HANDOFF.md` entero).

### 1. Relevar las sesiones largas — 47% a 65% del gasto. De lejos, lo mayor.

| sesión | coste real | con relevo @150k | ahorro |
|---|---|---|---|
| CAPCOM directo `4591c244` | 81.455.648 | 29.273.725 | **64%** |
| CAPCOM relevado `1d2c27ff` | 41.068.592 | 14.296.457 | **65%** |
| Worker PZ `06e04e5f` | 28.775.884 | 15.168.138 | **47%** |
| Revisor AJ `fed2ad80` | 4.550.342 | 4.438.398 | 2% |

Sensibilidad del umbral (CAPCOM `4591c244`): 100k → 72%, 150k → 64%, 200k → 57%, 250k → 49%,
300k → 39%.

El revisor no gana nada porque muere antes de crecer: **el relevo sólo paga en sesiones largas**, y
eso mismo dice dónde aplicarlo. Donde vive el mecanismo que ya existe para CAPCOM:
`src/collector/provider-handoff.ts:244-269` (prepara el traspaso) y
`src/collector/capcom.ts:441` (lo activa). Extenderlo a workers es la propuesta
`relevo-de-sesiones-largas`.

### 2. No cargar el brief de CAPCOM dos veces en los relevos — 4.479 tokens por petición.

1.155.582 tokens medidos en 2 sesiones; 15.152 de prefijo en el caso peor de continuidad.
Arreglo de una línea: que la copia de archivo de `src/collector/provider-handoff.ts:256-258` no
caiga en un ancestro del cwd — por ejemplo bajo `handoffs/<id>/archive/` en vez de
`handoffs/<id>/`. El cwd (`:246`) y el brief bueno (`:250`) no se tocan.

### 3. El `runtime/CLAUDE.md` de continuidad no debería repetir el brief entero.

`src/collector/provider-handoff.ts:249` escribe `capcomBrief()` completo (6.196 tokens) cuando 17
de sus 23 párrafos ya están en el `CLAUDE.md` que el proceso carga igualmente. Con el arreglo 2 el
problema se reduce; sin él, se suman.

### 4. `[OR] [OR]` — 24 tokens. Cosmético, pero es una línea.

`src/agents/tools.ts:2957`: no anteponer el código si el texto ya empieza por `[<code>] `.

*(Menor, y no es de ORCA: la re-inyección del bloque de instrucciones tras compactar aparece en 4
de 54 sesiones de worker y cuesta 854–1.216 tokens. Lo hace el CLI, no ORCA.)*

## Lo que esto significa en dinero

Nada, directamente. La regla del operador confirmada hoy (`mission_mty0dljurtf23kl5`) es que todo
se paga con **plan plano**. Lo que ahorran estas cuatro cosas no son dólares: es **cuota, ventana
de contexto y latencia** — y, en el caso del relevo, la diferencia entre una sesión que sigue
trabajando y una que se ahoga en su propio historial.

## Verificación

No se corrió `npm run typecheck` ni la suite: la misión prohíbe expresamente tocar código y correr
las suites, y no se modificó ningún fichero del repo. Todo lo afirmado sale de:

- `usage` real de 135 transcripts en `~/.claude/projects/` (no estimaciones).
- `md5`/`sha1` de los `CLAUDE.md` en `~/.orca/capcom/` y sus 13 handoffs.
- `~/.orca/hub/missions.json` (494 mensajes) y `~/.orca/hub/improve/improve.json` (15 propuestas).
- Lectura directa de `src/collector/provider-handoff.ts`, `src/collector/capcom.ts` y
  `src/agents/tools.ts` en las líneas citadas.

Scripts de medición reproducibles en el scratchpad de la sesión: `an.py` (coste y bloques
repetidos), `curva.py` (prefijo vs acumulado), `spawn_vs_mission.py` (pista 3), `relevo.py`
(simulación del relevo).


## Filtros que lo cubren

Este informe no cambia código, así que **no hay suite que lo cubra**: no se corrió ninguna, y
la misión lo prohibía expresamente. Se dice aquí en vez de callarlo.

Los filtros que cubren las zonas donde nacen los cuatro arreglos propuestos, para quien los
implemente:

```
npm test -- provider-handoff capcom          arreglos 2 y 3 (copia del brief, runtime/CLAUDE.md)
npm test -- missions debrief                 arreglo 4 ([OR] duplicado; debrief fija el formato)
npm test -- capcom-handoff capcom-recovery   arreglo 1 (extender el relevo a workers)
```

`test/debrief.test.ts:159-161` fija hoy el formato con el prefijo, así que el arreglo 4 pasa
por ahí.
