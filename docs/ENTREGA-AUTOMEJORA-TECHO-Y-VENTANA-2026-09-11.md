# AUTOMEJORA · que una revisión pueda terminar

Misión: `mission_mtw986y6u2i55irl` (`mission-20`). Dos propuestas del mismo
subsistema, archivadas por la revisión `rev_mtw8cgp3dupemnnh` (AJ):
`techo-revisor-cuenta-cache` (`imp_mtw91vbt8bzlw32w`) y
`ventana-de-uso-se-borra-al-leerla` (`imp_mtw91vbt6znuk320`). Un commit cada una.

## 1 · El techo no cuenta la lectura de caché

### La regla

Entrada + salida + escritura de caché. La lectura de caché no cuenta. El
razonamiento no se suma porque los dos CLI ya lo meten dentro de la salida. No
se usa dinero: Codex escribe $0.

Vive en una sola función, `ceilingTokens` (`src/shared/tokens.ts`).

### `tokensOf` no era una función compartida: era la misma suma copiada cinco veces

Todas contaban `input + output + cacheRead`, así que el criterio se aplica a
todas. Consumidores que cambian:

| Dónde | Qué es | Qué cambia |
| --- | --- | --- |
| `src/hub/budgets.ts` · `BudgetBook.tokensOf` | Los presupuestos de **todos** los agentes: `set_budget`, techo de escuadrón y de misión, `ORCA_DEFAULT_BUDGET_TOKENS`, los avisos `[BUDGET 80%]`/`[BUDGET 100%]`/`[BUDGET STOP]` y la parada | Pasa a `ceilingTokens`. El texto de los avisos (`N of M tokens (P%)`) no cambia: «tokens» significa ahora lo mismo en todas partes |
| `src/hub/improve.ts` · `tokensOf` local + `closeFor` | El techo del revisor, la nota `stopped at Nk of a Mk ceiling` y el `tokens` que se guarda en la revisión | Pasa a `ceilingTokens`; la copia suelta de `closeFor` también |
| `src/ui/hud/improve.ts` | La fila del revisor en vuelo (`Nk/400K`) y la línea `NEXT REVIEWER · … TOKENS = …` | Misma cifra que el hub; la línea dice `INPUT + OUTPUT + CACHE WRITES · CACHE READS NOT COUNTED` |
| `src/agents/tools.ts` · `lineageOf` | Los tokens por nodo del árbol de linaje que ve CAPCOM | Pasa a `ceilingTokens` |
| `src/agents/tools.ts` · descripciones de `set_budget`, `spawn_agent` y `spawn_squad` | Lo que CAPCOM lee sobre qué cuenta un techo | Dicen `input + output + cache writes (cache reads do not count)` |

Aparte, la estimación en dólares de `BudgetBook.spend` (sólo cuando el CLI no
escribe coste) suma también la escritura de caché, a peso 1.

**Aviso para el operador:** esto invierte una decisión escrita en
`docs/BUDGETS.md` §1, que argumentaba a favor de contar la lectura de caché. El
cambio de escala es grande. En las 58 sesiones recientes de este repo que
pasan de 50k, la lectura de caché es entre el 96,9 % y el 99,8 % de la suma
vieja (mediana 99,4 %). En conjunto sumaban 1.657.732.316 con la regla vieja
y 31.746.996 con la nueva: 52 veces menos. Un techo en tokens puesto con la
regla vieja salta ahora mucho más tarde. Hoy eso sólo afecta a los techos de
revisor: en `~/.orca/hub/budgets.json` los únicos techos en tokens son los
tres de 400k de los revisores (los otros 20 son en dólares o minutos), y el
hub corre sin `ORCA_DEFAULT_BUDGET_TOKENS`. `docs/BUDGETS.md` ya explica el
cambio y su motivo.

### Hacía falta el collector

Tres cosas que el hub no podía arreglar solo:

1. **La escritura de caché no llegaba.** `AgentMetrics` no la tenía. Ahora
   existe `cacheWriteTokens`: Claude la toma de `cache_creation_input_tokens`
   y del `cacheCreationInputTokens` del cost-state; Codex manda 0, porque su
   escritura ya va dentro de la entrada. Sin ella el techo de un agente de
   Claude mediría casi nada: AJ tenía 12 de entrada.
2. **Codex metía lo cacheado dentro de `input_tokens`.** Su adaptador lo resta.
   `inputTokens` significa ya lo mismo en los dos CLI: entrada que no salió de
   caché. En la ventana de un agente de Codex, `TOK IN` baja por eso.
3. **Cada mensaje de Claude se sumaba dos, tres o cuatro veces.** Claude Code
   escribe una línea por bloque (thinking, texto, cada tool_use) y todas
   repiten el `usage` del mensaje. Lo comprobé en 40 transcripts de este repo:
   4.064 líneas repetidas y ninguna con un `usage` distinto del de su mensaje.
   `derive.ts` suma ahora una vez por `message.id`. Ésos eran los «saltos» de
   la cifra viva, y el «451k» de AJ salió de ahí.

**Nada de esto toma efecto hasta que se reinicie el collector**, y yo no lo
reinicié. Mientras tanto el hub reconoce a un collector viejo porque no manda
`cacheWriteTokens`, y para él mantiene la suma vieja, con la lectura dentro.
Contar sólo entrada + salida dejaría el techo de Claude en un par de miles,
que sería un freno que nunca frena.

### AJ con la regla vieja y con la nueva

Recalculado desde su transcript
(`fed2ad80-d609-4b4d-9320-5a0c34b836ad.jsonl`), cortado en el instante del
freno (`outcomeAt`, 00:41:19Z, 46 s después del lanzamiento):

| | entrada | salida | lectura caché | escritura caché | **regla vieja** | **regla nueva** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sumado por línea (lo que el hub vio en vivo) | 26 | 5.817 | 445.426 | 270.100 | **451.269** | 275.943 |
| Por mensaje (lo que dice el cost-state) | 12 | 2.657 | 227.946 | 111.339 | **230.615** | **114.008** |

- El freno se disparó con 451k de 400k. Por mensaje eran 230.615, que es el
  `tokens` que quedó guardado en la revisión.
- Con la regla nueva y el collector nuevo, AJ llevaba **114.008** (el 29 % del
  techo) cuando lo pararon.
- La sesión entera de AJ, hasta archivar sus ocho propuestas a las 01:00Z:
  4.409.188 con la regla vieja y **224.040** con la nueva.
- EX (`rev_mtspcjx49qappeai`, 30 s): 647.245 por línea, 266.661 por mensaje
  con la regla vieja y **30.416** con la nueva.

### El techo por defecto no se toca

400k. Con la regla nueva, la única revisión que llegó a archivar consumió
224.040, así que 400k le deja terminar con margen y sigue parando a uno que se
desboque. Hay un matiz: con la regla nueva pero el collector viejo, que suma
por línea, la sesión entera de AJ habría marcado 513.248 en vivo y la habrían
parado igual. Por eso el arreglo de `derive.ts` es parte de esta entrega, y por
eso importa el reinicio.

### Pruebas

- `test/budgets.test.ts`: la unidad es entrada + salida + escritura de caché;
  para un collector viejo se mantiene la suma vieja; y un agente con 900k
  leídos de caché no avisa, mientras que 343k nuevos sí avisan, con esa cifra
  en el texto.
- `test/improve.test.ts`: la forma de AJ (445k leídos de caché) ya no para al
  revisor; 420k nuevos sí lo paran, con `stopped at 420k of a 400k ceiling`.
- `test/collector.test.ts`: tres líneas de un mismo mensaje cuentan una vez; la
  escritura de caché llega a las métricas, del mensaje y del cost-state; una
  línea de un mensaje que ya está sumado no vuelve a entrar después del
  cost-state.
- `test/codex.test.ts`: la entrada de Codex sale sin lo cacheado (19172 −
  11904), con escritura 0.
- `test/hud-improve.shots.ts`: la línea `NEXT REVIEWER` dice qué cuenta.
