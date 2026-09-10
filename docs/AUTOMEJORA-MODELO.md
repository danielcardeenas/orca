# AUTOMEJORA — elegir modelo y presupuesto para el revisor

**Misión:** `mission_mttiklauzji25qa6`
**Sobre:** `mission_mts6tjnbar7u0ngy` (la sección) y `mission_mtsaf4fnjtrh9j5j`
(el agente revisor)
**Estado:** implementado y verificado; **corregido tras la revisión de entrega**
—dos fallos reales, §2 y §3, con las pruebas que los cazan en §6—. **Sin
commit** (§8).

Documentos previos: [AUTOMEJORA.md](AUTOMEJORA.md) (referencia de la sección),
[AUTOMEJORA-ENTREGA.md](AUTOMEJORA-ENTREGA.md) y
[AUTOMEJORA-REVISOR.md](AUTOMEJORA-REVISOR.md) (el agente revisor).

**§1–§6** son lo que se ha construido y cómo está probado. **§7** es la
segunda pregunta —qué modelos usar—: la recomendación la da CAPCOM, y aquí sólo
queda lo que ORCA puede comprobar por sí misma y cómo medirlo.

---

## 1. Qué se puede elegir ahora

En `SETUP` de la sección AUTOMEJORA hay dos filas nuevas y una casilla:

```
EVERY 6H [CHANGE] · MAX PER DAY 4 [CHANGE] · MIN SIGNAL 40 [CHANGE]
REVIEWER BUDGET 400K [CHANGE] · [OR TYPE ONE][SET]
RUNTIME [CLAUDE ▾]   MODEL [OPUS ▾]
NEXT REVIEWER · claude/opus · 400K TOKENS = INPUT + OUTPUT + CACHE READ
· A BRAKE, NOT A HARD CEILING: IT CAN OVERSHOOT BEFORE ORCA SEES IT
```

- **RUNTIME** — `claude` o `codex`. La primera opción es `INHERIT · <lo que
  resuelva el entorno>`: quien no elige, sigue al entorno, como antes.
- **MODEL** — el catálogo del runtime elegido. La primera opción es
  `INHERIT · <modelo>` o `INHERIT · THE CLI DECIDES` cuando el entorno no fija
  ninguno.
- **REVIEWER BUDGET** — `CHANGE` recorre los presets
  (100K · 200K · 400K · 800K · 2M) y la casilla admite cualquier valor.

La línea de abajo no es decoración: dice **qué revisor va a nacer el próximo**,
de dónde sale cada mitad (`runtime from the operator, model from the
environment`), y qué significa el número. Sin ella la elección sería una
pregunta abierta cada vez que alguien mira el panel.

El catálogo no es una lista escrita a mano. Es `providerModels()` —el mismo que
usa el traspaso de proveedor (`src/collector/provider-handoff.ts:14`)—: alias
de Claude Code y el caché local de Codex, con su marca de `installed`. Si Codex
no está instalado, sus modelos siguen listándose pero marcados, y si su caché
no existe no se inventa ninguno. El selector es `pick()` de
`src/ui/controls.ts`, el de Q8, sin tocarlo: mismo teclado, mismo diálogo en
móvil, mismos estilos.

## 2. Qué se guarda y a qué se aplica

`ImproveState` gana dos campos, `runtime` y `model`, ambos `string | null`.
`null` significa **heredar**, que no es lo mismo que «claude»: si mañana el
entorno cambia, quien no eligió se mueve con él y quien eligió no.

Se aplica a **las revisiones futuras**, manuales y periódicas por igual: el
lanzador pregunta `choiceNow()` justo antes de construir el `spawn`, y el
`Command` lleva siempre `runtime` y, si hay modelo aplicable, `model`.

«Aplicable» es la palabra corregida. `ORCA_IMPROVE_MODEL` es el modelo de
`ORCA_IMPROVE_RUNTIME`, no un modelo universal: `effectiveChoice` sólo lo
hereda cuando el runtime efectivo es el del entorno. Con entorno `claude/opus`
y el operador eligiendo `codex`, el próximo revisor es `codex` **sin modelo**
—decide el CLI—, no `codex/opus`. En la otra dirección igual, y al volver a
heredar el modelo del entorno vuelve.

> **Esto también estuvo mal.** La primera versión heredaba `env.model` bajo
> cualquier runtime, así que la limpieza del panel no servía de nada: el modelo
> del entorno se colaba igual en el payload del spawn. Corregido en
> `effectiveChoice` (`src/shared/improve.ts`), con pruebas que miran **el
> `Command` del spawn**, manual y automático, no sólo los campos del store.

Se aplica **a la siguiente**, no a la de ahora. `beginReview()`
(`src/hub/improve.ts:264`) **sella** en el registro de la revisión el runtime,
el modelo y el presupuesto con los que nació. Cambiar el SETUP mientras un
revisor está vivo no reescribe su historia ni le mueve el techo: el consumo se
compara contra `r.budgetTokens`, el de la revisión, y sólo cae al estado global
cuando la revisión es anterior a que existiera el campo
(`src/hub/improve.ts:807`). Por eso la tabla de revisiones puede decir, un mes
después, con qué corrió cada una.

**Migrar no pierde nada.** Al cargar el archivo, un `budgetTokens` ausente toma
el valor por defecto y un `runtime`/`model` ausente queda en `null` —heredar—,
que es exactamente el comportamiento anterior a esta entrega
(`src/hub/improve.ts:171-176`). No hay reescritura del fichero al arrancar.

## 3. El presupuesto: qué cuenta y qué no promete

`400K TOKENS = INPUT + OUTPUT + CACHE READ`. Es la suma que ORCA lee del
contador del agente, la misma que ve `BudgetBook`; no es «tokens de respuesta»
ni «contexto».

Y es **un freno, no un techo**. El texto de la UI lo dice con esas palabras
porque la corrida real de `rev_mtschaq0u83g1or2` lo demostró: 570.858 tokens
sobre un presupuesto de 400K (143%), y lecturas no monótonas por el camino.
ORCA muestrea, y entre dos muestras un turno de modelo entero puede
completarse; `stop` es una orden, no un interruptor. §7 de
[AUTOMEJORA-REVISOR.md](AUTOMEJORA-REVISOR.md) tiene el detalle. Elegir 2M no
es «gastar como mucho 2M»: es «avisar y frenar alrededor de 2M».

Rango aceptado: **20.000 – 20.000.000**. Lo valida el servidor, no el
navegador: `setConfig()` recorta el número al rango
(`src/hub/improve.ts:211`) y devuelve el valor efectivo, que el panel compara
con lo pedido y avisa si no coincide. Un `curl` al hub con `budgetTokens:
1e12` obtiene 20M, no un revisor sin freno.

La elección de runtime/modelo **no se recorta, se rechaza**: un número fuera de
rango se parece a un cero de más, pero un runtime que ORCA no sabe lanzar no se
parece a nada válido, y aceptarlo a medias dejaría un SETUP que promete algo
que no ocurrirá. `validateChoice()` (`src/shared/improve.ts:534`) devuelve el
error y el hub lo manda tal cual en el `ack`.

Cambiar de runtime **limpia el modelo**, y lo hace el servidor. Un alias de
Claude Code no existe en el catálogo de Codex, y quedarse con él dejaría un
`spawn` con una pareja imposible que sólo se descubriría al fallar el
lanzamiento.

La regla exacta, porque el matiz importa: `setConfig` compara el runtime
**efectivo** antes y después del parche —`data.runtime ?? entorno`, no
`data.runtime` a secas— y si se movió, y el mismo parche no trae modelo, lo
pone a `null`. Un modelo explícito en el mismo parche gana: elegir CLI y
modelo a la vez es una decisión, no dos. Y volver a *heredar* sólo borra el
modelo si el entorno corre otro CLI; si corre el mismo, no ha cambiado nada y
no se tira nada.

> **Esto estuvo mal hasta la revisión de la entrega.** La primera versión sólo
> limpiaba el modelo desde el panel: un `improve:config` con `{runtime:
> 'codex'}` y nada más dejaba guardado `codex/opus`, y este documento afirmaba
> que el servidor lo garantizaba cuando no era cierto. Corregido en
> `src/hub/improve.ts:setConfig`, con prueba unitaria y por wire (§6), y el
> panel ya no manda la limpieza: manda sólo el runtime, y la regla vive en un
> solo sitio.

## 4. Lo que sigue siendo igual

- El revisor **sigue sin implementar**. La restricción vive en su brief y en el
  hueco único de revisión, no en el modelo elegido; cambiar de modelo no le da
  permisos nuevos. (Con un matiz honesto sobre Codex en §8.)
- Las **propuestas siguen aprobándose aparte**, una a una, con su misión
  enlazada. Elegir modelo no aprueba nada.
- El hueco sigue siendo **uno**, con la semántica de exclusión corregida en la
  entrega anterior: `outcomeAt` es el resultado, `endedAt` es el hueco, y el
  hueco sólo se libera con muerte confirmada.

## 5. Archivos

Nuevos (míos, íntegros):

| Archivo | Qué aporta a esta entrega |
|---|---|
| `src/shared/improve.ts` | `REVIEW_RUNTIMES`, `MODEL_ID`, `BUDGET_MIN/MAX`, `validateChoice()`, `effectiveChoice()`; `runtime`/`model` en `ImproveState` y en `ImproveReview` |
| `src/hub/improve.ts` | `choiceNow()`, sellado en `beginReview()`, `setConfig()` con recorte y rechazo, `ImproveApi.choice()`/`project()`, carga tolerante |
| `src/ui/hud/improve.ts` | fila `RUNTIME`/`MODEL` con `pick()`, presets + casilla de presupuesto, línea de efectivo |
| `src/ui/styles/improve.css` | `.improve__field`, `.improve__pick`, `.improve__custom`, `.improve__num`, `.improve__note` |
| `test/improve.test.ts`, `test/improve-hub.test.ts`, `test/improve-panel.test.ts`, `test/hud-improve.shots.ts` | validación, limpieza al cambiar de runtime, herencia por runtime, payload del spawn, sellado, migración, y la sección fotografiada |

Compartidos, sólo añadiendo (sin tocar lo ajeno):

- `src/shared/protocol.ts` — `runtime`/`model` en el parche de `improve:config`
  y en el estado que viaja; `models:list` ya existía.
- `src/hub/server.ts` — el `case 'improve:config'` (mío, de la primera entrega)
  delega en `setConfig` y devuelve su error en el `ack` en vez de tragárselo,
  que es lo que hace visible un runtime inválido en el panel.
- `test/fake-collector.ts` — `models:list` responde catálogo sintético.

## 6. Pruebas, con su código de salida

Cada comando por separado, sin tubería que esconda un fallo, y con el log
guardado. Los logs están en el scratchpad de la sesión,
`/private/tmp/claude-501/-Users-danielcardenas-projects-orca/23b3c87c-63d2-4310-bc27-ac8b93e7083a/scratchpad/`:

```
$ npx tsc --noEmit -p tsconfig.json; echo "TSC_EXIT=$?"      → tsc.log
TSC_EXIT=0

$ npx tsx test/run.ts improve; echo "IMPROVE_EXIT=$?"        → improve.log
90/90 passed
IMPROVE_EXIT=0

$ npx tsx test/run.ts --changed; echo "CHANGED_EXIT=$?"      → changed.log
956/960 passed, 4 failed
broken suites: collector.test.ts, squads.test.ts, trust.test.ts, workspaces.test.ts
CHANGED_EXIT=1

$ npx tsx test/run.ts --changed; echo "CHANGED_EXIT=$?"      → changed2.log
1011/1011 passed
CHANGED_EXIT=0

$ npx tsx test/hud-improve.shots.ts; echo "SHOTS_EXIT=$?"    → shots.log
AUTOMEJORA: colour, silhouette, evidence vs hypothesis, actions, geometry,
fold, reviewer row and phone passed.
SHOTS_EXIT=0
```

**Los dos `--changed` son deliberados y los dos van aquí.** El primero falló:
cuatro suites no cargaron con
`The requested module '../shared/restart.ts' does not provide an export named
'exitForRestart'`. `src/shared/restart.ts` **no es mío** —ninguno de mis
ficheros lo importa— y **sí exporta** `exitForRestart` (línea 51); su marca de
tiempo es de la misma hora de la corrida. Fue una carrera con otro agente
escribiendo ese fichero mientras el arnés lo leía, no un fallo de esta entrega:
la corrida siguiente, sobre el mismo árbol, da 1011/1011 y `CHANGED_EXIT=0`.
Lo dejo escrito con su código de salida en vez de enseñar sólo el verde.

### Que las pruebas nuevas cazan los fallos que arreglan

Una prueba que pasa con el código roto no prueba nada. Revertí las dos
correcciones sobre el árbol corregido y volví a correr:

```
$ npx tsx test/run.ts improve; echo "REGRESS_EXIT=$?"        (fixes revertidos)
FAIL no codex/opus: an alias of one CLI is not a model of the other
FAIL inheriting the same CLI is not a change; inheriting another one is
FAIL ORCA_IMPROVE_MODEL belongs to ORCA_IMPROVE_RUNTIME, not to every CLI
FAIL the environment is not lost, it is just not applicable meanwhile
FAIL the clock and the button build the same payload
84/89 passed, 5 failed
REGRESS_EXIT=1

$ npx tsx test/run.ts improve-hub; echo "WIRE_REGRESS_EXIT=$?"  (fix 1 revertido)
FAIL the ack says what stuck, and what stuck is launchable
11/12 passed, 1 failed
WIRE_REGRESS_EXIT=1
```

Luego restauré los ficheros corregidos desde su copia y volví a correr en verde
(los números de arriba). Las dos pruebas que **no** fallan al revertir son
guardas de regresión sobre comportamiento que ya era correcto —parche conjunto
y re-elegir el mismo runtime—, y están a propósito.

### Qué cubre cada prueba nueva

En `test/improve.test.ts` (7 nuevas):

| Prueba | Qué fija |
|---|---|
| `changing runtime alone clears the model, and the spawn proves it` | fallo 1: `{runtime:'codex'}` a secas sobre `claude/opus` deja `codex` sin modelo, **y el `Command` del spawn no lleva `model`** |
| `a runtime and a model chosen in the same breath both survive` | el modelo explícito del mismo parche gana |
| `re-choosing the runtime already in force keeps the model` | no se tira nada cuando nada cambia |
| `going back to inherited clears the model only if the effective runtime moves` | volver a heredar: se conserva si el entorno corre el mismo CLI, se limpia si corre otro |
| `the environment model is not inherited under another CLI, in either direction` | fallo 2, **las dos direcciones**, comprobado sobre el payload del spawn manual |
| `letting the runtime go back to inherited brings the environment model back` | fallo 2, vuelta a heredar |
| `the automatic clock inherits no foreign model either` | el mismo caso por el **reloj**, no sólo por el botón |

En `test/improve-hub.test.ts` (1 nueva, por wire con hub real y socket real):
`over the wire, changing runtime alone leaves no model from the other CLI` —
manda `improve:config` con sólo `{runtime}`, exactamente lo que manda el panel,
y comprueba el `ack` y el estado del hub; después un parche conjunto y comprueba
que el modelo explícito sobrevive.

**No se lanzó ninguna revisión real**, como pedía la misión.

## 7. Qué modelos elegir

**La recomendación de modelos la da CAPCOM.** Este documento no la sustituye ni
la duplica: aquí sólo está lo que la propia ORCA puede comprobar, que es qué se
puede elegir en esta máquina y cómo medir el resultado.

**He retirado la comparación de modelos que traía la primera versión de este
informe.** Contenía precios y equivalencias de versión que no puedo citar desde
el repositorio, y argumentos del tipo «más ventana de contexto luego mejores
propuestas» que no son una implicación: la ventana dice qué cabe, no qué se
acierta. Presentar eso junto a una entrega verificada le daba el mismo peso que
al resto, y no lo tiene.

### 7.1 Qué ofrece esta máquina

El catálogo no es una lista escrita a mano: es `providerModels()`
(`src/collector/provider-handoff.ts:14`), leído de la máquina donde correrá el
revisor y con la marca `installed` de cada CLI.

- **`claude`** — los alias de Claude Code: `opus`, `fable`, `sonnet`, `haiku`.
  Son alias: ORCA escribe el alias y el CLI resuelve la versión.
- **`codex`** — lo que haya en `~/.codex/models_cache.json` con visibilidad de
  lista. Si el caché falta, la lista sale corta y no se inventa nada.

### 7.2 Cómo decidirlo con datos y no con opinión

Esto es lo que la entrega aporta a la pregunta, y es lo único que aporta: la
elección ahora queda **sellada por revisión**, así que se puede comparar en
lugar de argumentar.

1. Fijar un runtime/modelo y dejar correr dos o tres revisiones periódicas.
2. Cambiar al candidato y dejar correr las mismas.
3. Comparar en la tabla de revisiones, que guarda por revisión el runtime, el
   modelo, el presupuesto sellado, los tokens leídos y los contadores
   `filed` / `merged` / `rejected`.

La cifra que decide **no es tokens por revisión**: es **propuestas aceptadas por
revisión** —y, siendo duros, propuestas que acabaron en una misión que se
cerró—. Un modelo barato que hay que releer dos veces no sale barato.

### 7.3 Lo único que he medido

Una revisión real, `rev_mtschaq0u83g1or2`, con el modelo por defecto: cinco
propuestas genuinas y 570.858 tokens sobre un presupuesto de 400K (143%). Es
una muestra de una: sirve para afirmar que el freno se sobrepasa —eso está en
§3 y en el texto de la UI— y no sirve para comparar modelos. **No he lanzado
ninguna revisión para esta entrega**, como pedía la misión.

## 8. Límites, dicho claro

1. **El presupuesto es un freno muestreado.** Sigue pudiendo sobrepasarse, con
   cualquier modelo, y con los de turno largo más. No es un techo duro y la UI
   no lo llama así.
2. **ORCA cuenta tokens, no dinero.** No hay conversión a dólares en ninguna
   parte, ni una tabla de precios en el producto: comparar coste entre modelos
   es algo que hoy hay que hacer fuera de ORCA.
3. **El alias no fija la versión.** `opus` es lo que Claude Code resuelva ese
   día. Lo que la revisión sella es el alias elegido, no un identificador de
   versión; si hace falta trazabilidad exacta de versión, hoy no la hay —y es
   otra razón para no escribir equivalencias de versión en un informe.
4. **El modelo guardado no recuerda para qué runtime se eligió.** La limpieza
   se decide **al guardar** (§3). Si después cambia `ORCA_IMPROVE_RUNTIME` en
   el entorno mientras el operador tiene el runtime heredado y un modelo
   fijado, ese modelo viaja al CLI nuevo. Es raro —requiere reiniciar el hub
   con otro entorno— y degrada a lo documentado: el spawn falla con el mensaje
   del CLI, que es quien sabe qué modelos tiene. Cerrarlo del todo pide guardar
   la pareja modelo↔runtime, que no está en esta entrega.
5. **`effort` y `thinking` no se eligen desde ORCA.** El revisor nace por el
   CLI, y ORCA le pasa runtime y modelo, no la profundidad de razonamiento.
   Esa palanca —que en modelos actuales pesa tanto como el modelo— queda fuera
   de esta entrega.
6. **En `codex`, el «no implementes» es una instrucción, no una jaula.** Desde
   la decisión de permisos de 2026-09-07, ORCA lanza Codex con
   `--dangerously-bypass-approvals-and-sandbox` salvo que `ORCA_CODEX_APPROVALS=1`
   (`src/collector/commands.ts:1490`). Un revisor Codex **podría** escribir en
   el repositorio si decidiera desobedecer su brief; uno de Claude Code, en la
   configuración de esta máquina, también depende de su brief. Es un hecho a
   tener delante al elegir runtime, no una recomendación.
7. **El catálogo de Codex sale de un caché local.** Si el caché falta o está
   viejo, la lista sale corta o desfasada; ORCA no inventa modelos para
   rellenar.
8. **Sin commit.** El repositorio está compartido y sucio con trabajo de otros
   agentes; no he commiteado, revertido ni tocado nada ajeno. El `typecheck` de
   §6 recorre el árbol entero, incluidos ficheros ajenos, y pasa: el fallo que
   avisé en `src/hub/push.ts` lo ha arreglado su dueño.
9. **Un solo implementador, sin subagentes**, como pedía la misión.

## 9. El diff de esta corrección

La auditoría vio «0 archivos atribuidos» porque los ficheros de esta sección son
**nuevos y sin trackear**: `git diff` no enseña nada de ellos, y lo último que
el verificador vio ejecutarse fue un `cat` de este informe. Así que aquí está el
cambio, entero, en vez de una marca de «tests passed» que no prueba nada.

Ficheros nuevos de la sección, todos míos (líneas): `src/shared/improve.ts`
1085 · `src/hub/improve.ts` 1151 · `src/ui/hud/improve.ts` 907 ·
`src/ui/styles/improve.css` 429 · `src/agents/tools-improve.ts` 185 ·
`src/collector/improve-drop.ts` 203 · `bin/orca-improve.mjs` 166 · pruebas
`test/improve*.ts` y `test/hud-improve.shots.ts`.

El diff de **esta ronda de corrección**, que es lo que hay que revisar:

```diff
### src/shared/improve.ts
@@ -552,17 +552,25 @@
  * La elección del operador gana; sin ella, el entorno; sin él, `claude`. Se
  * calcula en un sitio para que el panel pueda enseñar exactamente lo que va a
  * pasar en vez de una casilla vacía que el operador tiene que interpretar.
+ *
+ * El modelo del entorno SÓLO se hereda cuando el runtime efectivo es el suyo.
+ * `ORCA_IMPROVE_MODEL` es el modelo de `ORCA_IMPROVE_RUNTIME`, no un modelo
+ * universal: heredarlo bajo otro CLI produce parejas que no existen —`codex`
+ * con el alias `opus`— y el lanzamiento falla por un motivo que el operador no
+ * eligió. Sin modelo aplicable, decide el CLI, que es la herencia honesta.
  */
 export function effectiveChoice(
   state: Pick<ImproveState, 'runtime' | 'model'>,
   env: { runtime: string; model: string },
 ): { runtime: string; model: string | null; from: { runtime: 'operator' | 'environment'; model: 'operator' | 'environment' | 'cli' } } {
+  const runtime = state.runtime ?? env.runtime;
+  const inherited = runtime === env.runtime ? (env.model || null) : null;
   return {
-    runtime: state.runtime ?? env.runtime,
-    model: state.model ?? (env.model || null),
+    runtime,
+    model: state.model ?? inherited,
     from: {
       runtime: state.runtime ? 'operator' : 'environment',
-      model: state.model ? 'operator' : env.model ? 'environment' : 'cli',
+      model: state.model ? 'operator' : inherited ? 'environment' : 'cli',
     },
   };
 }

### src/hub/improve.ts
@@ -147,7 +147,20 @@
   /** Por qué no se puede guardar, cuando no se puede. Viaja hasta el panel. */
   private degraded: string | null = null;
 
-  constructor(dir: string, private now: () => number = Date.now, private changed: () => void = () => {}, defaults?: ImproveConfig & { budgetTokens?: number }) {
+  constructor(
+    dir: string,
+    private now: () => number = Date.now,
+    private changed: () => void = () => {},
+    defaults?: ImproveConfig & { budgetTokens?: number },
+    /**
+     * El runtime del entorno, para saber cuál es el EFECTIVO.
+     *
+     * `setConfig` necesita distinguir «heredar» de «claude»: sin esto, volver
+     * a heredar parecería un cambio cuando no lo es, o parecería no serlo
+     * cuando el entorno corre otro CLI.
+     */
+    private envRuntime: () => string = () => 'claude',
+  ) {
     const home = path.join(dir, IMPROVE_DIR);
     // Un directorio que no se puede crear no tumba el hub: la sección sigue
     // en memoria y lo DICE (`degraded`), que es lo único que hace honesta la
@@ -199,6 +212,12 @@
    *
    * Nada de esto toca una revisión en curso: los valores se leen al LANZAR y
    * se sellan en la revisión (ver `beginReview`).
+   *
+   * Cambiar de runtime efectivo BORRA el modelo, salvo que el mismo parche
+   * traiga uno. Un alias de Claude Code no existe en el catálogo de Codex, así
+   * que la pareja que quedaría no es «rara»: es imposible, y sólo se
+   * descubriría al fallar el lanzamiento. La regla vive aquí y no en el panel
+   * porque la consola no es la única puerta.
    */
   setConfig(patch: Partial<ImproveConfig & { budgetTokens: number; runtime: string | null; model: string | null }>): ImproveSettings {
     const choice = validateChoice(patch);
@@ -209,8 +228,15 @@
     if (Number.isFinite(patch.perDay)) next.perDay = Math.min(48, Math.max(1, Math.round(patch.perDay!)));
     if (Number.isFinite(patch.minSignal)) next.minSignal = Math.min(100_000, Math.max(0, Math.round(patch.minSignal!)));
     if (Number.isFinite(patch.budgetTokens)) this.data.budgetTokens = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(patch.budgetTokens!)));
+    const wasRuntime = this.data.runtime ?? this.envRuntime();
     if (choice.value.runtime !== undefined) this.data.runtime = choice.value.runtime;
+    const nowRuntime = this.data.runtime ?? this.envRuntime();
+    // El modelo explícito del mismo parche gana: elegir CLI y modelo a la vez
+    // es una sola decisión, y borrarla sería contradecir lo que se acaba de
+    // pedir. Sin él, un cambio de runtime efectivo lo deja en «lo que diga el
+    // CLI», que es lo único que se sabe válido.
     if (choice.value.model !== undefined) this.data.model = choice.value.model;
+    else if (nowRuntime !== wasRuntime) this.data.model = null;
     this.data.config = next;
     this.save();
     return {
@@ -684,7 +710,7 @@
 
 export function createImprove(deps: AutonomyDeps, hooks: ImproveHooks): ImproveApi {
   const env = improveEnv(deps.env);
-  const store = new ImproveStore(deps.dir, deps.now, () => hooks.changed?.(), env.defaults);
+  const store = new ImproveStore(deps.dir, deps.now, () => hooks.changed?.(), env.defaults, () => env.runtime);
 
   /** El agente de la revisión en vuelo, si el mundo todavía lo tiene. */
   function reviewerOf(r: ImproveReview | null): Agent | null {

### src/ui/hud/improve.ts
@@ -593,12 +593,12 @@
             // del CLI si de verdad no está.
           })),
         ],
-        onChange: (v) => {
-          // Cambiar de CLI invalida el modelo: un alias de Claude no existe en
-          // Codex, y dejarlo puesto haría fallar el próximo lanzamiento por un
-          // motivo que el operador no eligió.
-          act(() => hub.improveConfig({ runtime: v || null, ...(v && v !== state.runtime ? { model: null } : {}) }));
-        },
+        // Sólo el runtime. Cambiar de CLI invalida el modelo —un alias de
+        // Claude no existe en Codex— pero de eso se encarga `setConfig` en el
+        // hub, que es quien sabe cuál es el runtime EFECTIVO cuando se hereda.
+        // Mandarlo también desde aquí duplicaría la regla en dos sitios y sólo
+        // uno de los dos manda.
+        onChange: (v) => act(() => hub.improveConfig({ runtime: v || null })),
       });
       runtimeHost.appendChild(runtimePick.el);
 
@@ -629,9 +629,8 @@
      *
      * `improveChoice` viene de un empujón y puede tener un instante de retraso
      * respecto a lo que el operador acaba de guardar; el estado ya lo tiene. Y
-     * si eligió un runtime y no modelo, el modelo es el que decida el CLI —
-     * `setConfig` limpia el modelo al cambiar de runtime, así que no puede
-     * quedar uno del proveedor anterior.
+     * mientras el runtime elegido no coincida con el que el hub resolvió, no se
+     * hereda modelo: el del entorno es el de SU CLI, no uno universal.
      */
     const effRuntime = state.runtime ?? choice?.runtime ?? '—';
     const effModel = state.model ?? (state.runtime && state.runtime !== choice?.runtime ? null : choice?.model ?? null);
```

Más, en las pruebas: 7 casos nuevos en `test/improve.test.ts` y 1 por wire en
`test/improve-hub.test.ts`, descritos uno a uno en §6.

## 10. Cómo verificarlo

```
npm run typecheck
npm test -- improve                 las cinco suites (90)
npm test -- --changed               1011
npx tsx test/hud-improve.shots.ts   la sección, con la fila de modelo
```

Filtros que cubren esta entrega: `improve`, `commands`, `autonomy`.
