# SELF-IMPROVEMENT — choosing model and budget for the reviewer

**Mission:** `mission_mttiklauzji25qa6`
**On:** `mission_mts6tjnbar7u0ngy` (the section) and `mission_mtsaf4fnjtrh9j5j`
(the reviewer agent)
**Status:** implemented and verified; **corrected after the delivery review**
—two real bugs, §2 and §3, with the tests that catch them in §6—. **Not
committed** (§8).

Reference for the section: [AUTOMEJORA.md](AUTOMEJORA.md).

**§1–§6** are what has been built and how it is tested. **§7** is the second
question —which models to use—: the recommendation comes from CAPCOM, and what
is left here is only what ORCA can check for itself and how to measure it.

---

## 1. What can be chosen now

In the SELF-IMPROVEMENT section's `SETUP` there are two new rows and a box:

```
EVERY 6H [CHANGE] · MAX PER DAY 4 [CHANGE] · MIN SIGNAL 40 [CHANGE]
REVIEWER BUDGET 400K [CHANGE] · [OR TYPE ONE][SET]
RUNTIME [CLAUDE ▾]   MODEL [OPUS ▾]
NEXT REVIEWER · claude/opus · 400K TOKENS = INPUT + OUTPUT + CACHE WRITES
· CACHE READS NOT COUNTED · A BRAKE, NOT A HARD CEILING: IT CAN OVERSHOOT BEFORE ORCA SEES IT
```

- **RUNTIME** — `claude` or `codex`. The first option is `INHERIT · <whatever
  the environment resolves>`: whoever does not choose follows the environment,
  as before.
- **MODEL** — the catalogue of the chosen runtime. The first option is
  `INHERIT · <model>` or `INHERIT · THE CLI DECIDES` when the environment pins
  none.
- **REVIEWER BUDGET** — `CHANGE` cycles through the presets
  (100K · 200K · 400K · 800K · 2M) and the box accepts any value.

The line below is not decoration: it says **which reviewer will be born next**,
where each half comes from (`runtime from the operator, model from the
environment`), and what the number means. Without it the choice would be an open
question every time someone looks at the panel.

The catalogue is not a hand-written list. It is `providerModels()` —the same one
the provider handoff uses (`src/collector/provider-handoff.ts:14`)—: Claude Code
aliases and Codex's local cache, with their `installed` mark. If Codex is not
installed, its models are still listed but marked, and if its cache does not
exist none are invented. The selector is `pick()` from `src/ui/controls.ts`, Q8's
one, untouched: same keyboard, same dialog on mobile, same styles.

## 2. What is saved and what it applies to

`ImproveState` gains two fields, `runtime` and `model`, both `string | null`.
`null` means **inherit**, which is not the same as "claude": if the environment
changes tomorrow, whoever did not choose moves with it and whoever chose does
not.

It applies to **future reviews**, manual and periodic alike: the launcher asks
`choiceNow()` right before building the `spawn`, and the `Command` always carries
`runtime` and, if there is an applicable model, `model`.

"Applicable" is the corrected word. `ORCA_IMPROVE_MODEL` is the model of
`ORCA_IMPROVE_RUNTIME`, not a universal model: `effectiveChoice` only inherits it
when the effective runtime is the environment's. With a `claude/opus`
environment and the operator choosing `codex`, the next reviewer is `codex`
**with no model** —the CLI decides—, not `codex/opus`. The same in the other
direction, and going back to inherit brings the environment's model back.

> **This was wrong too.** The first version inherited `env.model` under any
> runtime, so clearing it from the panel did nothing: the environment's model
> slipped into the spawn payload anyway. Fixed in `effectiveChoice`
> (`src/shared/improve.ts`), with tests that look at **the spawn's `Command`**,
> manual and automatic, not just at the store's fields.

It applies **to the next one**, not to the current one. `beginReview()`
(`src/hub/improve.ts:264`) **seals** into the review's record the runtime, the
model and the budget it was born with. Changing SETUP while a reviewer is alive
does not rewrite its history or move its ceiling: consumption is compared against
`r.budgetTokens`, the review's own, and only falls back to the global state when
the review predates the field's existence (`src/hub/improve.ts:807`). That is why
the review table can say, a month later, what each one ran with.

**Migrating loses nothing.** When loading the file, a missing `budgetTokens`
takes the default value and a missing `runtime`/`model` stays `null` —inherit—,
which is exactly the behaviour before this delivery
(`src/hub/improve.ts:171-176`). The file is not rewritten at startup.

## 3. The budget: what it counts and what it does not promise

`400K TOKENS = INPUT + OUTPUT + CACHE WRITES · CACHE READS NOT COUNTED`. It is
the sum ORCA reads from the agent's counter, the same one `BudgetBook` sees
(`ceilingTokens`, `src/shared/tokens.ts`); it is not "response tokens" or
"context". Until 2026-09-11 cache reads counted, and a reviewer crossed 400K in
its first minute.

And it is **a brake, not a ceiling**. The UI text says so in those words because
the real run of `rev_mtschaq0u83g1or2` proved it: 570,858 tokens against a budget
of 400K (143%), and non-monotonic readings along the way. ORCA samples, and
between two samples a whole model turn can complete; `stop` is an order, not a
switch.
Choosing 2M is not "spend at most 2M": it is "warn and brake somewhere around
2M".

Accepted range: **20,000 – 20,000,000**. The server validates it, not the
browser: `setConfig()` clamps the number to the range
(`src/hub/improve.ts:211`) and returns the effective value, which the panel
compares with what was asked and flags if they do not match. A `curl` to the hub
with `budgetTokens: 1e12` gets 20M, not a reviewer with no brake.

The runtime/model choice **is not clamped, it is rejected**: a number out of
range looks like one zero too many, but a runtime ORCA does not know how to
launch does not look like anything valid, and half-accepting it would leave a
SETUP promising something that will not happen. `validateChoice()`
(`src/shared/improve.ts:534`) returns the error and the hub sends it through in
the `ack` as it is.

Changing runtime **clears the model**, and the server does it. A Claude Code
alias does not exist in Codex's catalogue, and keeping it would leave a `spawn`
with an impossible pairing that would only be discovered when the launch failed.

The exact rule, because the nuance matters: `setConfig` compares the
**effective** runtime before and after the patch —`data.runtime ?? environment`,
not plain `data.runtime`— and if it moved, and the same patch brings no model, it
sets it to `null`. An explicit model in the same patch wins: choosing CLI and
model at once is one decision, not two. And going back to *inherit* only clears
the model if the environment runs a different CLI; if it runs the same one,
nothing has changed and nothing is thrown away.

> **This was wrong until the delivery review.** The first version only cleared
> the model from the panel: an `improve:config` with `{runtime: 'codex'}` and
> nothing else left `codex/opus` saved, and this document claimed the server
> guaranteed it when that was not true. Fixed in
> `src/hub/improve.ts:setConfig`, with a unit test and a wire test (§6), and the
> panel no longer sends the clear: it sends only the runtime, and the rule lives
> in one place.

## 4. What stays the same

- The reviewer **still does not implement**. The restriction lives in its brief
  and in the single review slot, not in the chosen model; changing model gives it
  no new permissions. (With an honest caveat about Codex in §8.)
- **Proposals are still approved separately**, one by one, with their linked
  mission. Choosing a model approves nothing.
- The slot is still **one**, with the exclusion semantics corrected in the
  previous delivery: `outcomeAt` is the result, `endedAt` is the slot, and the
  slot is only released on confirmed death.

## 5. Files

New (mine, in full):

| File | What it contributes to this delivery |
|---|---|
| `src/shared/improve.ts` | `REVIEW_RUNTIMES`, `MODEL_ID`, `BUDGET_MIN/MAX`, `validateChoice()`, `effectiveChoice()`; `runtime`/`model` in `ImproveState` and in `ImproveReview` |
| `src/hub/improve.ts` | `choiceNow()`, sealing in `beginReview()`, `setConfig()` with clamping and rejection, `ImproveApi.choice()`/`project()`, tolerant loading |
| `src/ui/hud/improve.ts` | `RUNTIME`/`MODEL` row with `pick()`, presets + budget box, effective line |
| `src/ui/styles/improve.css` | `.improve__field`, `.improve__pick`, `.improve__custom`, `.improve__num`, `.improve__note` |
| `test/improve.test.ts`, `test/improve-hub.test.ts`, `test/improve-panel.test.ts`, `test/hud-improve.shots.ts` | validation, clearing on runtime change, inheritance per runtime, spawn payload, sealing, migration, and the section photographed |

Shared, additions only (nothing of anyone else's touched):

- `src/shared/protocol.ts` — `runtime`/`model` in the `improve:config` patch and
  in the state that travels; `models:list` already existed.
- `src/hub/server.ts` — the `case 'improve:config'` (mine, from the first
  delivery) delegates to `setConfig` and returns its error in the `ack` instead of
  swallowing it, which is what makes an invalid runtime visible in the panel.
- `test/fake-collector.ts` — `models:list` answers with a synthetic catalogue.

## 6. Tests, with their exit codes

Each command separately, with no pipe to hide a failure, and with the log saved.
The logs are in the session's scratchpad,
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

**Both `--changed` runs are deliberate and both go here.** The first one failed:
four suites did not load, with
`The requested module '../shared/restart.ts' does not provide an export named
'exitForRestart'`. `src/shared/restart.ts` **is not mine** —none of my files
import it— and it **does export** `exitForRestart` (line 51); its timestamp is
from the same hour as the run. It was a race with another agent writing that file
while the harness was reading it, not a failure of this delivery: the next run,
over the same tree, gives 1011/1011 and `CHANGED_EXIT=0`. I am writing it down
with its exit code instead of showing only the green.

### That the new tests catch the bugs they fix

A test that passes with the code broken proves nothing. I reverted both fixes on
top of the corrected tree and ran again:

```
$ npx tsx test/run.ts improve; echo "REGRESS_EXIT=$?"        (fixes reverted)
FAIL no codex/opus: an alias of one CLI is not a model of the other
FAIL inheriting the same CLI is not a change; inheriting another one is
FAIL ORCA_IMPROVE_MODEL belongs to ORCA_IMPROVE_RUNTIME, not to every CLI
FAIL the environment is not lost, it is just not applicable meanwhile
FAIL the clock and the button build the same payload
84/89 passed, 5 failed
REGRESS_EXIT=1

$ npx tsx test/run.ts improve-hub; echo "WIRE_REGRESS_EXIT=$?"  (fix 1 reverted)
FAIL the ack says what stuck, and what stuck is launchable
11/12 passed, 1 failed
WIRE_REGRESS_EXIT=1
```

Then I restored the corrected files from their copy and ran green again (the
numbers above). The two tests that do **not** fail on revert are regression
guards over behaviour that was already correct —a joint patch and re-choosing the
same runtime— and they are there on purpose.

### What each new test covers

In `test/improve.test.ts` (7 new):

| Test | What it pins down |
|---|---|
| `changing runtime alone clears the model, and the spawn proves it` | bug 1: a bare `{runtime:'codex'}` over `claude/opus` leaves `codex` with no model, **and the spawn's `Command` carries no `model`** |
| `a runtime and a model chosen in the same breath both survive` | the explicit model in the same patch wins |
| `re-choosing the runtime already in force keeps the model` | nothing is thrown away when nothing changes |
| `going back to inherited clears the model only if the effective runtime moves` | going back to inherit: kept if the environment runs the same CLI, cleared if it runs another |
| `the environment model is not inherited under another CLI, in either direction` | bug 2, **both directions**, checked against the manual spawn's payload |
| `letting the runtime go back to inherited brings the environment model back` | bug 2, back to inherit |
| `the automatic clock inherits no foreign model either` | the same case via the **clock**, not just via the button |

In `test/improve-hub.test.ts` (1 new, over the wire with a real hub and a real
socket): `over the wire, changing runtime alone leaves no model from the other
CLI` — it sends `improve:config` with only `{runtime}`, exactly what the panel
sends, and checks the `ack` and the hub's state; then a joint patch, and it checks
that the explicit model survives.

**No real review was launched**, as the mission asked.

## 7. Which models to choose

**The model recommendation comes from CAPCOM.** This document neither replaces
nor duplicates it: here there is only what ORCA itself can check, which is what
can be chosen on this machine and how to measure the result.

**I have removed the model comparison the first version of this report
carried.** It contained prices and version equivalences I cannot cite from the
repository, and arguments of the form "more context window therefore better
proposals" that are not an implication: the window says what fits, not what gets
it right. Presenting that alongside a verified delivery gave it the same weight
as the rest, and it does not have it.

### 7.1 What this machine offers

The catalogue is not a hand-written list: it is `providerModels()`
(`src/collector/provider-handoff.ts:14`), read from the machine where the
reviewer will run and with each CLI's `installed` mark.

- **`claude`** — Claude Code's aliases: `opus`, `fable`, `sonnet`, `haiku`. They
  are aliases: ORCA writes the alias and the CLI resolves the version.
- **`codex`** — whatever is in `~/.codex/models_cache.json` with list
  visibility. If the cache is missing, the list comes out short and nothing is
  invented.

### 7.2 How to decide it with data and not with opinion

This is what the delivery contributes to the question, and it is all it
contributes: the choice is now **sealed per review**, so it can be compared
instead of argued about.

1. Pin a runtime/model and let two or three periodic reviews run.
2. Switch to the candidate and let the same number run.
3. Compare in the review table, which keeps per review the runtime, the model,
   the sealed budget, the tokens read and the `filed` / `merged` / `rejected`
   counters.

The figure that decides is **not tokens per review**: it is **accepted proposals
per review** —and, to be strict about it, proposals that ended in a mission that
was closed—. A cheap model you have to re-read twice does not come out cheap.

### 7.3 The only thing I have measured

One real review, `rev_mtschaq0u83g1or2`, with the default model: five genuine
proposals and 570,858 tokens against a budget of 400K (143%). It is a sample of
one: it is enough to state that the brake gets overshot —that is in §3 and in the
UI text— and it is not enough to compare models. **I have not launched any review
for this delivery**, as the mission asked.

## 8. Limits, stated plainly

1. **The budget is a sampled brake.** It can still be overshot, with any model,
   and more so with the long-turn ones. It is not a hard ceiling and the UI does
   not call it one.
2. **ORCA counts tokens, not money.** There is no conversion to dollars anywhere,
   nor a price table in the product: comparing cost between models is something
   that today has to be done outside ORCA.
3. **The alias does not pin the version.** `opus` is whatever Claude Code
   resolves that day. What the review seals is the chosen alias, not a version
   identifier; if exact version traceability is needed, today there is none —and
   that is another reason not to write version equivalences into a report.
4. **The saved model does not remember which runtime it was chosen for.** The
   clearing is decided **on save** (§3). If `ORCA_IMPROVE_RUNTIME` later changes
   in the environment while the operator has the runtime inherited and a model
   pinned, that model travels to the new CLI. It is rare —it requires restarting
   the hub with a different environment— and it degrades to what is documented:
   the spawn fails with the CLI's message, and the CLI is the one that knows
   which models it has. Closing it completely calls for storing the
   model↔runtime pairing, which is not in this delivery.
5. **`effort` and `thinking` are not chosen from ORCA.** The reviewer is born by
   the CLI, and ORCA passes it runtime and model, not reasoning depth. That lever
   —which on current models weighs as much as the model— is outside this
   delivery.
6. **On `codex`, "do not implement" is an instruction, not a cage.** Since the
   permissions decision of 2026-09-07, ORCA launches Codex with
   `--dangerously-bypass-approvals-and-sandbox` unless `ORCA_CODEX_APPROVALS=1`
   (`src/collector/commands.ts:1490`). A Codex reviewer **could** write to the
   repository if it decided to disobey its brief; a Claude Code one, in this
   machine's configuration, also depends on its brief. It is a fact to keep in
   front of you when choosing a runtime, not a recommendation.
7. **Codex's catalogue comes from a local cache.** If the cache is missing or
   stale, the list comes out short or out of date; ORCA does not invent models to
   fill it in.
8. **No commit.** The repository is shared and dirty with other agents' work; I
   have not committed, reverted or touched anything of anyone else's. The
   `typecheck` in §6 walks the whole tree, other people's files included, and it
   passes: the failure I flagged in `src/hub/push.ts` has been fixed by its
   owner.
9. **A single implementer, no subagents**, as the mission asked.

## 9. The diff of this correction

The audit saw "0 files attributed" because this section's files are **new and
untracked**: `git diff` shows nothing of them, and the last thing the verifier
saw run was a `cat` of this report. So here is the change, whole, instead of a
"tests passed" badge that proves nothing.

New files in the section, all mine (lines): `src/shared/improve.ts`
1085 · `src/hub/improve.ts` 1151 · `src/ui/hud/improve.ts` 907 ·
`src/ui/styles/improve.css` 429 · `src/agents/tools-improve.ts` 185 ·
`src/collector/improve-drop.ts` 203 · `bin/orca-improve.mjs` 166 · tests
`test/improve*.ts` and `test/hud-improve.shots.ts`.

The diff of **this round of corrections**, which is what needs reviewing:

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

More, in the tests: 7 new cases in `test/improve.test.ts` and 1 over the wire in
`test/improve-hub.test.ts`, described one by one in §6.

## 10. How to verify it

```
npm run typecheck
npm test -- improve                 the five suites (90)
npm test -- --changed               1011
npx tsx test/hud-improve.shots.ts   the section, with the model row
```

Filters that cover this delivery: `improve`, `commands`, `autonomy`.
