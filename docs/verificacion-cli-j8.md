# J8 — verificación en vivo del cableado de los CLI, tras el arreglo

2026-09-13, ~09:50. Agente J8, squad `forge-buzon-01`, worktree
`.claude/worktrees/forge-buzon-01`. Para CAPCOM.

## VEREDICTO

**Tres verificados en vivo, los tres verdes. Dos sin verificar, y no por
descuido.**

- ✅ `orca-tell`, `orca-read`, `orca-show` — probados en vivo desde el worktree
  tras el arreglo (`69de31a`). Los tres pliegan al repo padre y el ciclo
  completo tell → collector → hub → deliver → read funciona.
- ⚠️ `orca-spawn` — **NO probado a propósito**: verificarlo lanza un agente real
  con la máquina a 3,6 G de 5,0 G de swap y cuatro agentes vivos. Escalado en
  vez de ejecutado. Cableado correcto por lectura (`bin/orca-spawn.mjs:113`, el
  mismo `projectRoot`). Pendiente de una orden de CAPCOM.
- ⚠️ `orca-improve` — no probado: mueve la cola de automejora, y no es algo que
  deba disparar para una prueba de cableado. Cableado correcto por lectura
  (`bin/orca-improve.mjs:113`).

**Nada falló de lo que probé.** Lo que sigue roto es otra cosa, que el arreglo
del canal no toca: el buzón de entrada sigue siendo del primero que lee. Lo
reproduzco abajo, en «Lo que sigue roto».

Nota sobre el alcance: no fueron cinco en vivo. Fueron **tres de los seis**.
Si alguien va a cerrar la misión contando cinco cableados probados, faltan dos.

## Aclaración de encargo, primero

**A mí nunca se me encargó verificar cinco CLI.** El brief que recibí de mi
líder BW era, literalmente, «DIAGNÓSTICO (no escribas código de producción
todavía)» del camino B: el recorrido de un `orca-tell --kind ask`, el punto de
pérdida con fichero:línea, y si había huella. Eso lo entregué en
`docs/diagnostico-camino-b.md` (427 líneas) y avisé a las 09:28.

Lo digo porque si CAPCOM creía que ese hueco estaba asignado a alguien, no lo
estaba: durante esos catorce minutos yo estaba terminando el diagnóstico, no
esperando correo. La verificación de abajo la he hecho ahora, al recibir el
encargo, en unos ocho minutos.

## Lo que ha cambiado bajo nuestros pies

Mientras yo diagnosticaba, **el arreglo se commiteó y está desplegado**:

- worktree: `c40eff8` «ORCA: un worktree dejaba de existir para la flota…»
- checkout principal: `69de31a` «ORCA: un worktree ya no desconecta a quien entra en él»
- nuevo: `bin/lib/project-root.mjs` con `foldWorktree()`, que pliega por
  `--git-common-dir` además de por la marca `--claude-worktrees-`, y descarta
  submódulos comparando `--git-dir` con `--git-common-dir`.

Dato de despliegue que confirmo en vivo: el shim es
`/Users/danielcardenas/.orca/shims/squad/orca-tell` y su contenido es
`exec node /Users/danielcardenas/projects/orca/bin/orca-tell.mjs "$@"`. **Los
agentes ejecutan el `bin/` del checkout principal, no el de su worktree.** Por
eso el arreglo ya está activo para toda la flota sin reinstalar shims (el shim
es un wrapper de una línea, no una copia). Corrijo con esto la nota de mi
diagnóstico, que decía que haría falta reinstalarlos.

## Resultado CLI por CLI

Los seis comparten ahora el mismo `projectRoot` de `bin/lib/project-root.mjs`
(verificado: los seis lo importan).

| CLI | buzón | verificado en vivo | resultado |
|---|---|---|---|
| `orca-tell` | `.orca/out` | **Sí** | ✅ arreglado |
| `orca-read` | `.orca/in` | **Sí** | ✅ arreglado |
| `orca-show` | `.orca/artifacts` | **Sí** | ✅ arreglado |
| `orca-ask` | `.orca/ask` | **Sí** (esta entrega) | ver abajo |
| `orca-spawn` | `.orca/spawn` | **No — por decisión** | cableado correcto por lectura |
| `orca-improve` | `.orca/improve` | No | cableado correcto por lectura |

### 1. `orca-tell` — ✅ verificado

```
$ cd .claude/worktrees/forge-buzon-01
$ orca-tell "Verificacion de cableado post-arreglo, ignorar" --to BW --kind notice
sent: tell_mtz5mgyvrwaptb (notice → BW)
$ sleep 3; ls .orca/out/              # worktree
tell_mtz4uygix9x6ps.json              # ← de las 09:26, ANTES del arreglo
tell_mtz4yepc6f9ltv.json              # ← de las 09:28, ANTES del arreglo
$ ls /Users/danielcardenas/projects/orca/.orca/out/
(vacío)
```

El mensaje nuevo no está en ninguno de los dos: plegó al principal y **el
collector lo consumió en menos de 3 segundos**. Los dos que siguen en el
worktree son los que perdí antes del arreglo, y son la referencia A/B.

### 2. `orca-read` — ✅ verificado

```
$ orca-read --peek -n 3
NOTICE  from J8  2026-09-13 01:47
  Verificacion de cableado post-arreglo, ignorar
```

Desde el worktree lee el buzón del proyecto principal. Antes del arreglo leía
`<worktree>/.orca/in`, que está vacío. Confirmado el ciclo completo
tell → collector → hub → deliver → read.

### 3. `orca-show` — ✅ verificado

```
$ orca-show docs/diagnostico-camino-b.md "Diagnostico camino B"
showing: Diagnostico camino B  (.claude/worktrees/forge-buzon-01/docs/diagnostico-camino-b.md)
```

La ruta que imprime es **relativa al checkout principal**, prueba de que plegó
bien. No creó `.orca/artifacts` en el worktree; el `show_mtz5kjfl7xmvyx.json`
apareció en el `.orca/artifacts` del principal y el collector ya lo consumió.

### 4. `orca-spawn` — NO verificado en vivo, deliberadamente

Verificarlo **lanza un agente real**. Con la máquina a 3,6 G de 5,0 G de swap y
cuatro agentes vivos, no lo he hecho por mi cuenta: es exactamente el tipo de
acción que mi brief manda escalar en vez de ejecutar. Si CAPCOM quiere el
cableado probado de verdad, dímelo y lo lanzo con un brief trivial y
`--no-wait`.

Lo que sí consta: `bin/orca-spawn.mjs:113` usa el mismo `projectRoot`, y en **mi
propio worktree** hay un `.orca/spawn/spawn_mtz4gb46joidp5.json.rescued` de las
09:14 — prueba de que `orca-spawn` estaba roto igual que los demás antes del
arreglo, y de que alguien tuvo que rescatarlo a mano.

### 5. `orca-improve` — no verificado

Mismo import, `bin/orca-improve.mjs:113`. No lo he disparado: mueve la cola de
automejora y no es algo que deba tocar para una prueba de cableado.

## Lo que sigue roto y el arreglo NO toca

`foldWorktree` cierra el punto de pérdida de la *ruta*. **El segundo punto de
pérdida sigue vivo, y lo acabo de reproducir sin querer en la prueba 2:**

El buzón `.orca/in` es **del proyecto, no del agente**, y el payload depositado
no lleva destinatario — `inboxPayload` (`src/collector/messages.ts:606-622`)
emite `id, kind, scope, from, fromAgentId, fromProjectId, subject, body, files,
at, expiresAt, replyTo` y **ningún `toAgentId`**. Por eso `orca-read` no filtra
por destinatario: no puede.

Reproducción exacta:

```
# desde CUALQUIER worktree o desde el checkout principal, como cualquier agente
$ cd /Users/danielcardenas/projects/orca/.claude/worktrees/forge-buzon-01
$ orca-read --peek -n 3

Esperado:  sólo mensajes dirigidos a mí (J8), o a mi proyecto/squad/flota.
Ocurrido:  NOTICE from J8 … "Verificacion de cableado post-arreglo, ignorar"
           — un mensaje de scope `agent` dirigido a BW, visible entero.
```

Sin `--peek`, `orca-read` habría escrito la marca `.read` (`bin/orca-read.mjs:183-193`)
y BW no lo habría visto nunca. Con cinco agentes en el mismo proyecto, el
primero que teclea `orca-read` vacía el buzón de los otros cuatro.

En la prueba 2, **el mensaje que leí iba dirigido a BW, no a mí**. Lo vi entero.
Usé `--peek` a propósito, así que no lo he marcado leído y BW todavía lo tiene;
sin `--peek` se lo habría robado en silencio. Es exactamente el mecanismo que
describe CAPCOM en su mensaje —«el que lee primero se lo lleva todo»— y confirmo
que **sigue activo después del arreglo**. Es el mismo fallo que hizo que BW
consumiera mi correo y el del otro miembro.

Mi diagnóstico lo detalla como «punto 3» con el código. El arreglo natural es
que `inboxPayload` incluya `toAgentId` y que `orca-read` filtre por el suyo,
mostrando lo de scope `project`/`squad`/`fleet` a todos y lo de scope `agent`
sólo a su destinatario.

## Escrituras mías en `/Users/danielcardenas/projects/orca` — declaradas

CAPCOM pregunta expresamente. **Sí escribí en ese árbol, tres veces, todas
ficheros de buzón `.orca/`, y las tres ya han sido consumidas y borradas por el
collector.** Ninguna toca `src/`, `bin/`, `docs/` ni nada bajo vigilancia de
`tsx watch`:

1. `.orca/out/tell_mtz4z7h2n69rcs.json` — 09:28, `orca-tell --project <principal>`,
   para hacer llegar el aviso a BW cuando la vía normal estaba rota. Consumido.
2. `.orca/artifacts/show_mtz5kjfl7xmvyx.json` — 09:46, la prueba de `orca-show`.
   Consumido.
3. `.orca/out/tell_mtz5mgyvrwaptb.json` — 09:49, la prueba de `orca-tell`.
   Consumido.

Estado actual comprobado: `.orca/out/` vacío, y en `.orca/artifacts/` sólo
quedan ficheros de días anteriores. `git status` del principal muestra un único
untracked, `docs/DIAGNOSTICO-BUZON-2026-09-13.md`, que **no es mío** — yo no he
creado ni modificado ningún fichero versionado allí. Mi diagnóstico vive en el
worktree.

Escribir en `.orca/` de ese árbol es el funcionamiento normal de los CLI —es
donde el collector espera los buzones— pero lo declaro porque la pregunta era
sobre escrituras en esa ruta, y tres son tres.

## Estoy parado por

Nada. Ni esperaba correo ni lo espero. Si quieres que verifique `orca-spawn`
y `orca-improve` en vivo, es una orden de una línea y son dos minutos; sólo
necesito el visto bueno para lanzar un agente con la máquina como está.

## Verificación

Pruebas en vivo con los CLI, listadas arriba con su salida literal. No he
corrido `npm run typecheck` ni suites: no he cambiado código, ni en el worktree
ni en ningún sitio. El arreglo que verifico lo escribió y commiteó otro miembro
(`c40eff8` / `69de31a`); quien lo firme debe decir qué suites corrió sobre él.

Filtros que cubren esta zona cuando se toque:

```
npm run typecheck
npm test -- messages
npm test -- --changed
```
