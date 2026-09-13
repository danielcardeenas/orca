# Camino B: por qué un `orca-tell --kind ask` no llega al buzón del líder

Diagnóstico, 2026-09-13. Sólo lectura: no se ha tocado producción.
Worktree `.claude/worktrees/forge-buzon-01`, código leído en `d9aab2a`.

## Resumen en tres líneas

El mensaje no se pierde en el enrutado, ni en el hub, ni en `orca-read`. **Se
pierde antes de entrar al sistema**: `orca-tell` escribe el fichero en
`<git root>/.orca/out/`, y cuando el emisor corre dentro de un git worktree ese
git root es el worktree, un directorio que el collector no vigila nunca. El
fichero se queda ahí para siempre. No hay error, no hay reintento, no hay
entrada en el hub y no hay aviso: `orca-tell` imprime `sent:` y sale 0.

Hay **prueba forense en disco ahora mismo**: 15 mensajes atascados en
`.claude/worktrees/forge-lote-01/.orca/out/`, escritos entre las 08:41 y las
09:24 de hoy, incluido uno del líder que dice literalmente «tu ask con --wait
lleva colgado desde las 09:10 y NO me llegó».

Hay además otros dos puntos de pérdida reales, independientes de éste, que
detallo abajo y que conviene arreglar en la misma pasada.

---

## 1. El recorrido completo y real de un `orca-tell --kind ask --to <callsign>`

Salto a salto, con el código que lo hace:

### Salto 1 — el emisor escribe un fichero

`bin/orca-tell.mjs` (líneas de `HEAD`, antes de la edición en curso de otro
miembro del squad):

```js
// orca-tell.mjs:112-123
function projectRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    // The message lands in the repo the agent is actually working in, which is
    // what the collector maps to a project.
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

// orca-tell.mjs:138-139
const root = projectRoot(opts.project);
const outDir = join(root, '.orca', 'out');
```

Payload (`orca-tell.mjs:172-182`): `{kind, to, subject, body, files, agentId,
ttlMinutes, at, cwd}`. Se escribe a `.<id>.tmp` y se renombra a `<id>.json`
(`orca-tell.mjs:186-195`), para que el collector no lea un JSON a medias.

La única comprobación previa es que exista `~/.orca` (`orcaPresent()`,
`orca-tell.mjs:130-133`). **No se comprueba en ningún momento que el directorio
donde se escribe sea uno que el collector mire.** Con `--wait`, el proceso pasa
a esperar `<mismo root>/.orca/in/<id>.answer.json` (`orca-tell.mjs:210`).

### Salto 2 — el collector recoge el fichero

`src/collector/messages.ts`, `MessageWatcher`:

- `track(projectId, projectPath)` (`messages.ts:150-160`) fija
  `outDir = <projectPath>/.orca/out` e `inDir = <projectPath>/.orca/in`.
- `scan()` (`messages.ts:201-222`) recorre a 1 Hz **sólo los `outDir` de los
  proyectos trackeados**, más un `fs.watch` sobre cada uno (`attachWatch`,
  `messages.ts:224-238`).
- `take()` (`messages.ts:247-299`) valida tamaño, parsea, construye el mensaje,
  lo emite y **borra el fichero**.

Quién llama a `track`: `src/collector/index.ts:500`, `:542`, `:619` y `:1325`,
siempre con `p.path` — la ruta que el `ProjectRegistry` tiene para el proyecto.

### Salto 3 — se resuelve el destinatario (en el collector del emisor)

`MessageWatcher.route()` (`messages.ts:381-425`). Cuatro formas:
`fleet`/`null` → fleet; `project:<x>` → project; `squad:<x>` → squad (no se
valida aquí a propósito: sólo el hub ve la flota entera); cualquier otra cosa se
trata como callsign, vía `deps.agentByCallsign` → `index.ts:1095-1106`, que
busca entre los `derivers` **de esta máquina**, prefiriendo uno no terminal.

Si el callsign no resuelve, `messages.ts:421-424` degrada a `scope: 'project'`
del emisor y antepone al subject `[no encontré a <X>]` (`messages.ts:322-328`).
Es decir: **el degradado del help existe de verdad y funciona** — pero sólo si
el fichero llegó a leerse.

### Salto 4 — el mensaje sale al hub

`index.ts:1021-1031` (`onMessage`): `send({t:'message', ...})` al hub y una
línea en el feed con `from → to (kind): subject`.

### Salto 5 — el hub enruta

`src/hub/server.ts:1482-1599` (`routeMessage`):

- `scope 'agent'`: sigue la cadena de relevos de CAPCOM (`:1492-1497`), falla si
  el destinatario no existe (`:1498`) o ya terminó (`:1499-1501`).
- `scope 'squad'`: filtra por etiqueta; si no hay nadie, **no difunde**
  (`:1523-1525`).
- Se excluye siempre al emisor (`:1536`), se aplica la cuarentena del arnés
  (`:1549-1558`) y un techo de difusión de broadcast (`:1560-1576`).
- Para cada destinatario alcanzable: `dispatchCommand(..., {k:'deliver', ...})`
  (`:1591`).
- Si no se entregó a nadie, `routeNewMessage` (`:1606-1623`) escribe un aviso en
  el feed, `alert` si era un `ask`.

### Salto 6 — el collector deposita en el buzón del destinatario

`src/collector/commands.ts:1275-1285` (`deliver`) → `cwdOf(a)` →
`messages.deliverTo(cwd.path, msg, a.id)` (`messages.ts:437-458`), que escribe
`<projectPath>/.orca/in/<msg.id>.json` de forma atómica.

### Salto 7 — `orca-read`

`bin/orca-read.mjs:93` resuelve su raíz con el mismo `git rev-parse
--show-toplevel`, lee `<root>/.orca/in`, se salta `.answer.json` y ocultos,
barre los caducados (`:137-141`), oculta los que ya tienen `<id>.read`
(`:144`) y al final escribe la marca `.read` (`:183-193`).

---

## 2. El salto exacto donde se pierde, con fichero:línea

### EL punto de pérdida del caso de hoy: salto 1 ↔ salto 2

**`bin/orca-tell.mjs:117` (el `git rev-parse --show-toplevel`) contra
`src/collector/projects.ts:48-51` (`foldWorktreeSlug`).**

El collector **dobla deliberadamente** el slug de un worktree sobre el de su
proyecto padre:

```js
// src/collector/projects.ts:33-51
/**
 * Dobla el slug de un worktree sobre el de su proyecto.
 * `claude --bg` corre la sesión dentro de un git worktree bajo
 * `<proyecto>/.claude/worktrees/<nombre>/`, y ese directorio produce su propio
 * slug. Sin esto, cada agente en background aparecía como un proyecto nuevo […]
 */
const WORKTREE_MARK = '--claude-worktrees-';

export function foldWorktreeSlug(slug) {
  const at = slug.indexOf(WORKTREE_MARK);
  return at > 0 ? slug.slice(0, at) : slug;
}
```

Y al construir el proyecto, la pista del `cwd` real se descarta porque ya no
coincide con el slug doblado:

```js
// src/collector/projects.ts:179-182
const slug = foldWorktreeSlug(rawSlug);
const id = this.idForSlug(slug);
const hint = matchesSlug(cwdHint, slug) ? cwdHint : null;   // ← siempre null en un worktree

// src/collector/projects.ts:297-300
export function matchesSlug(cwd, slug) {
  if (!cwd) return null;
  return pathToSlug(cwd) === slug ? cwd : null;
}
```

Hecha la cuenta con el caso real:

| | valor |
|---|---|
| `cwd` del agente | `/Users/danielcardenas/projects/orca/.claude/worktrees/forge-lote-01` |
| `pathToSlug(cwd)` | `-Users-danielcardenas-projects-orca--claude-worktrees-forge-lote-01` |
| `foldWorktreeSlug(...)` | `-Users-danielcardenas-projects-orca` |
| `matchesSlug(cwd, slug)` | `null` (no coinciden) |
| `project.path` resultante | `/Users/danielcardenas/projects/orca` |

Por tanto `index.ts:500` ejecuta
`messages.track(p.id, '/Users/danielcardenas/projects/orca')` y el `outDir`
vigilado es `/Users/danielcardenas/projects/orca/.orca/out`.

Mientras tanto `orca-tell`, corriendo dentro del worktree, escribe en
`/Users/danielcardenas/projects/orca/.claude/worktrees/forge-lote-01/.orca/out/`.

**Dos directorios distintos. El del worktree no lo lee nadie, nunca.** No es que
falle una entrega: es que el mensaje jamás entra en ORCA. Por eso no hay error
(el `writeFileSync`+`rename` funcionó), no hay reintento (nadie sabe que hay
algo que reintentar), no hay huella en el hub (el frame `{t:'message'}` nunca se
envió) y no hay aviso a ninguna de las dos partes (`routeNewMessage`, el
mecanismo que existe precisamente para gritar cuando un mensaje no llega a
nadie, vive en el hub — un salto más allá de donde murió).

Las dos invariantes que la cabecera de `messages.ts:13-22` declara —«un mensaje
jamás se pierde en silencio», «sólo un ask bloquea»— son ciertas *dentro* del
módulo. El fallo está justo aguas arriba de ellas.

Con `--kind ask --wait` el emisor además se queda esperando
`<worktree>/.orca/in/<id>.answer.json` (`orca-tell.mjs:210`) hasta el timeout,
60 minutos por defecto, y sale 3. Es exactamente lo que le pasó a DA hoy.

### Prueba forense: los mensajes están en disco

```
.claude/worktrees/forge-lote-01/.orca/out/
  tell_mtz3a09rcjewo8.json.rescued   08:41  handoff → squad:forge-lote-01
  tell_mtz3a5jh647nr2.json.rescued   08:42  (reply)
  tell_mtz3a9oxgds3rk.json.rescued   08:42  (reply)
  tell_mtz3ac4vsex3qi.json.rescued   08:42  (reply)
  tell_mtz3fz0jclng50.json.rescued   08:46  notice  → squad:forge-lote-01
  tell_mtz3igym8tmbpq.json.rescued   08:48  handoff → Z0
  tell_mtz3jyhcyiavbe.json.rescued   08:49  handoff → squad:forge-lote-01
  tell_mtz3l5anow9boa.json.rescued   08:50  handoff → CF
  tell_mtz3l5bvwkf95v.json.rescued   08:50  handoff → DA
  tell_mtz3m4rciom7i4.json.rescued   08:51  handoff → CF
  tell_mtz3x6o2dbqlih.json.rescued   09:00  handoff → squad:forge-lote-01
  tell_mtz45eep7ofz1f.json.rescued   09:06  handoff → squad:forge-lote-01
  tell_mtz4piypghimrw.json.rescued   09:22  handoff → CF
  tell_mtz4qwqtkpdqbh.json.rescued   09:22  handoff → DA
  tell_mtz4ta1t387m0r.json           09:24  handoff → squad:forge-lote-01

.claude/worktrees/shots-lote-01/.orca/out/
  tell_mtz44asrtizjvi.json.rescued   09:05
```

Todos llevan `"cwd": "/Users/danielcardenas/projects/orca/.claude/worktrees/forge-lote-01"`.
La extensión `.rescued` la puso a mano alguien que ya se encontró con esto hoy;
los ficheros siguen ahí porque **el collector nunca los tocó**. Dos de sus
subjects lo dicen solos:

> `tell_mtz4qwqtkpdqbh`: «DA: tu ask con --wait lleva colgado desde las 09:10 y
> NO me llegó — lo mandaste a squad:forge-lote-0…»

> `tell_mtz4ta1t387m0r`: «CORREGIDO EL ÁRBOL. Tu orden del árbol (worktree
> compartido .claude/worktrees/forge-lote-01) nunca m…»

Y en `/Users/danielcardenas/projects/orca/.orca/in/` están los reenvíos que el
líder acabó mandando **desde el checkout principal** cuando se dio cuenta:
`msg_5fa775f0bc0f1c52` — «CANAL ROTO, y por eso lleváis 40 minutos sin oírme:
los CLI orca-\* res…».

El mismo fallo, además, alcanza a `orca-ask`: hay un
`.claude/worktrees/forge-lote-01/.orca/ask/ask_mtz4rizl09sye4.json` sin recoger,
y a los artefactos: `…/forge-lote-01/.orca/artifacts/show_*.json`. Es el patrón
completo de buzones del agente, no sólo el de mensajes — `escalate.ts`,
`artifacts.ts`, `spawns.ts` e `improve-drop.ts` se trackean en las mismas cuatro
líneas de `index.ts` que `messages.ts`.

---

## 3. Los otros puntos de pérdida

### Punto 2 — la entrega tampoco sabe de worktrees (simétrico del anterior)

`src/collector/commands.ts:1397-1417` (`cwdOf`):

```js
const project = this.deps.projects.get(a.projectId);
if (!project) return { ok: false, res: { ok: false, detail: 'proyecto desconocido' } };
const cwd = path.resolve(project.path);     // ← commands.ts:1410
```

`deliver` (`commands.ts:1275-1285`) llama a `deliverTo(cwd.path, …)`, que escribe
en `<proyecto>/.orca/in`. Un destinatario que corre en un worktree lee
`<worktree>/.orca/in` (`orca-read.mjs:93,110`) y **no ve nada**.

Diferencia importante con el punto 1: **aquí sí hay huella**. El fichero existe
en `<proyecto>/.orca/in/`, el hub hizo `world.markDelivered` (`server.ts:1594`) y
el feed dice «entregado». O sea: la consola afirma que el mensaje se entregó y
el destinatario no lo tiene. Es el peor de los dos para depurar, aunque hoy no
sea el que rompió el caso.

### Punto 3 — el buzón de entrada es del proyecto, no del agente

`deliverTo` escribe en `<projectPath>/.orca/in/<msg.id>.json`
(`messages.ts:445-447`): **un único directorio por proyecto, compartido por todos
los agentes de ese proyecto**. Y el payload que ve el agente no lleva
destinatario — `inboxPayload` (`messages.ts:606-622`) emite `id, kind, scope,
from, fromAgentId, fromProjectId, subject, body, files, at, expiresAt, replyTo`
y **ningún `toAgentId`**.

Consecuencia, en `orca-read.mjs:117-151`: no filtra por destinatario porque no
*puede*. Lee todo el directorio, imprime y **marca `.read` todo lo que imprimió**
(`orca-read.mjs:183-193`). Con cinco agentes en el mismo checkout, el primero que
teclea `orca-read` se lleva el correo de los otros cuatro y lo deja marcado como
leído; los destinatarios reales no lo verán jamás sin `--all`.

Esto explica pérdidas de mensajes **incluso sin worktrees**, y encaja con la
memoria de «los directos no llegan a idle»: no es que idle no reciba, es que
otro se lo leyó primero. En el checkout principal hay ahora mismo 109 mensajes
y 106 marcas `.read` acumulados en `.orca/in`, sin vaciar.

### Punto 4 — un callsign de otra Mac no resuelve (hoy no aplica)

`agentByCallsign` (`index.ts:1095-1106`) recorre `this.derivers`, que son los de
**esta** máquina. Un líder en la segunda Mac no resuelve y el mensaje se degrada
a `project:` del emisor con `[no encontré a X]`. No es una pérdida silenciosa
(sale con nota), pero es un desvío. Con una sola Mac hoy, no interviene.

### Cuál explica el caso de hoy

**El punto 1.** El emisor corría en `.claude/worktrees/forge-lote-01`, su
`orca-tell` escribió en el `.orca/out` del worktree, y esos ficheros siguen ahí
sin recoger. El punto 2 habría mordido después, si el 1 no hubiera matado el
mensaje antes. El punto 3 es un problema distinto y vivo, pero no es el de hoy.

---

## 4. Hipótesis comprobadas y descartadas

| Hipótesis | Veredicto | Por qué |
|---|---|---|
| El callsign de un líder no se resuelve | **Descartada** | `messages.ts:414-420` resuelve cualquier callsign vía `index.ts:1095`, prefiriendo agentes no terminales. Un líder es un agente como otro. |
| Un destinatario no enrutable se pierde | **Descartada, el degradado existe** | `messages.ts:421-424` degrada a `project` y antepone `[no encontré a X]` al subject (`messages.ts:322-328`). Está implementado tal y como promete el `--help`. |
| Un `squad:` vacío se difunde a la flota | **Descartada, y es deliberado** | `server.ts:1523-1525` NO difunde y devuelve el motivo, que `routeNewMessage` publica en el feed. |
| Un agente `idle`/dormido no recibe | **Descartada** | `canReceive` (`server.ts:1471-1473`) es `!TERMINAL_STATES.has(state)`, y `TERMINAL_STATES` es `{'done','dead'}` (`src/shared/types.ts:755`). `idle` recibe. La entrega es un fichero en disco, no un pegado en el pane. |
| Identidad del emisor / `--agent` / whoami | **Descartada como causa** | `whoami.mjs:43-53` puede devolver `null`, y entonces `resolveAgent` (`index.ts:1153-1170`) cae en «el agente no terminal más activo del proyecto». Eso estropea la *atribución* (`fromCallsign`), no la entrega. Se arregló el 2026-09-12 y no interviene aquí. |
| `orca-read` lee el buzón equivocado | **Confirmada, pero es el punto 2/3, no el de hoy** | Lee `<git root>/.orca/in`, que en un worktree no es donde se entrega. |
| `orca-read` filtra y excluye el mensaje | **Descartada como filtro** | Los únicos filtros son `--kind`, la marca `.read` y `expiresAt` (`orca-read.mjs:137-145`). El problema es el contrario: no filtra por destinatario (punto 3). |
| Expiración / TTL se come el `ask` | **Descartada** | `expiryOf` (`messages.ts:599-603`): un `ask` sin `--ttl` explícito tiene `expiresAt = null` y no caduca nunca. Sólo los `notice` caducan, a las 6 h. |
| El hub tira el mensaje en silencio | **Descartada** | `routeNewMessage` (`server.ts:1606-1623`) publica un feed `alert` para un `ask` no entregado. El mecanismo existe; simplemente nunca se llegó a él. |

---

## 5. ¿Hay huella del envío? — Sí, una, y es pasiva

**Lo que SÍ queda:**

- El propio fichero `<worktree>/.orca/out/tell_<id>.json`, íntegro y para
  siempre, porque `take()` (`messages.ts:298`) es quien lo borra y `take()` no
  corre. Es la única huella, y nadie la mira: ningún proceso lista ese
  directorio, ninguna alerta lo cuenta, no aparece en la consola.
- En el stdout del emisor, `sent: tell_<id> (ask → BW)` (`orca-tell.mjs:201`) —
  que es exactamente la mentira que hay que quitar.

**Lo que NO queda, y hay que saberlo para el arreglo:**

- **Nada en el hub.** El mensaje no existe en `world.state.messages`: sólo se
  escribe desde el frame `{t:'message'}` (`world.ts:2172-2204`), que nunca se
  envió.
- **Nada en el feed.** Ni la línea de `index.ts:1026-1030`, ni el aviso de no
  entregado de `server.ts:1616-1622`.
- **Nada en el journal.** `JournalKind` es `'launch' | 'end' | 'escalation' |
  'answer' | 'rotation' | 'landing'` (`src/hub/journal.ts:68`): los mensajes
  entre agentes **no se journalizan en absoluto**, ni siquiera los que sí llegan.
- Ningún bloqueo `peer` en la consola: `open` sólo se puebla en
  `messages.ts:292-294`, dentro de `take()`.

Es decir: para todo ORCA, ese `ask` **no ocurrió**. El único testigo es un JSON
huérfano en un directorio que nadie abre.

---

## Nota sobre el estado del árbol

Mientras escribía esto, otro miembro del squad ha empezado a editar
`bin/orca-tell.mjs` y `bin/orca-read.mjs` **en este mismo worktree**: ambos
importan ya `./lib/project-root.mjs`, que todavía no existe en disco. En este
instante `orca-tell.mjs` llama a `projectRoot` sin tenerlo definido ni
importado — el comando está roto en este árbol. Lo señalo porque afecta a
cualquier verificación que se haga aquí; no lo he tocado, es trabajo de otro y
va en la dirección correcta.

Las citas de `bin/orca-tell.mjs` y `bin/orca-read.mjs` de este documento son de
`git show HEAD:`, que es el código que estaba corriendo cuando ocurrió el fallo.

---

## Verificación

Ninguna: esta fase es sólo lectura y no cambia código. No se ha corrido
`typecheck` ni suite alguna, y no procede — no hay nada nuevo que cubrir.

Cuando se implemente el arreglo, los filtros que lo cubren son:

```
npm run typecheck
npm test -- messages          # test/messages.test.ts, la única suite que hoy mira este canal
npm test -- --changed         # projects.ts y los bin/ no tienen suite propia: que lo elija el grafo
```

---

## Apéndice: reproducido en vivo al entregar este diagnóstico

A las 09:28, desde este mismo worktree, avisé al líder de que el documento
estaba escrito:

```
$ orca-tell "Camino B diagnosticado: …" --to BW --kind notice
sent: tell_mtz4yepc6f9ltv (notice → BW)
$ echo $?
0
```

Salida `sent:`, código 0. Y el fichero, treinta segundos después:

```
.claude/worktrees/forge-buzon-01/.orca/out/tell_mtz4yepc6f9ltv.json   ← sigue ahí
/Users/danielcardenas/projects/orca/.orca/out/                        ← vacío
```

El mensaje no se ha movido y nunca se moverá. Es el fallo entero en cuatro
líneas: el emisor tiene una confirmación de envío en la mano y el destinatario
no tiene nada.

Dos apuntes que salieron de esta prueba:

- `which orca-tell` → `/Users/danielcardenas/.orca/shims/squad/orca-tell`. Los
  agentes NO corren el `bin/orca-tell.mjs` de su árbol, sino el shim instalado
  en `~/.orca/shims/`. Un arreglo en `bin/` no llega a la flota viva hasta que
  los shims se reinstalan (`src/collector/shims.ts`); hay que contarlo en el
  plan de despliegue, o el arreglo parecerá no funcionar.
- En este worktree hay además un `tell_mtz4uygix9x6ps.json` de las 09:26 que no
  es mío: otro miembro acaba de perder otro mensaje por lo mismo, mientras
  escribíamos el diagnóstico del asunto.

El aviso al líder acabó saliendo con `orca-tell --project
/Users/danielcardenas/projects/orca`, que fuerza el buzón del checkout
principal. Es la misma salida manual que el líder de forge-lote-01 usó a las
09:23, y sirve como confirmación independiente de la causa: cambiando sólo el
directorio de escritura, el canal funciona.

Verificado: ese segundo mensaje desapareció de `/Users/danielcardenas/projects/orca/.orca/out/`
en menos de cuatro segundos —recogido por `take()`— mientras
`tell_mtz4yepc6f9ltv.json` sigue intacto en el `.orca/out` del worktree. Mismo
comando, mismo destinatario, misma máquina, mismo minuto: la única variable es
el directorio de escritura. Eso es la causa, aislada.
