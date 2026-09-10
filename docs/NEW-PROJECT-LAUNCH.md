# Lanzar sobre una carpeta nueva

Lo que pasó el 2026-09-08, con los datos exactos. El operador pidió trabajo
sobre `/Users/danielcardenas/projects/ventures`, recién creada. CAPCOM lanzó un
squad de cinco. Los cinco arrancaron, pintaron el diálogo nativo de Claude Code

```
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
```

y ahí se quedaron veinticinco minutos. ORCA los contaba como `blocked` con la
razón «waiting on its terminal: nothing has been painted for 20s with a turn
open», que es verdad y no sirve para nada. El operador fue a buscarlos con
`tmux ls` y obtuvo «no sessions», porque las sesiones de ORCA viven en su propio
socket. Y el proyecto ni siquiera existía para el hub: hubo que sembrarlo
lanzando `claude -p` dos veces a mano.

Cuatro fallos, todos de la misma familia: **ORCA sabía algo que el agente o el
operador necesitaban, y no se lo dijo — o se lo dijo mal.**

---

## 1 · La confianza, antes del spawn

`src/collector/trust.ts`, llamado desde `CommandRunner.spawn` /
`spawnPane` (`src/collector/commands.ts`).

Lo medido contra Claude Code 2.1.263:

- `--permission-mode bypassPermissions` **no** salta ese diálogo. La confianza
  de la carpeta es anterior a los permisos de herramienta.
- Mientras el diálogo está en pantalla el CLI **no crea** su directorio en
  `~/.claude/projects` — con `--session-id` tampoco. Sin transcript no hay
  deriver, y sin deriver ORCA no mira ese pane.
- El estado vive en `~/.claude.json`, en
  `projects["<ruta absoluta real>"].hasTrustDialogAccepted`. La clave es la
  ruta REAL: en este fichero todo lo que está bajo `/tmp` aparece como
  `/private/tmp/…`.

### Qué se decidió sobre `~/.claude.json`, y por qué

**ORCA escribe la entrada, justo antes de lanzar, sólo para la ruta exacta a la
que va a lanzar.** El razonamiento, y el porqué del alcance tan estrecho:

1. El diálogo pregunta «¿confías en esta carpeta?» a una pantalla que nadie
   mira. En una flota autónoma la pregunta no se contesta: se cuelga.
2. **La decisión ya está tomada, y antes.** Un operador —o CAPCOM en su
   nombre— nombró esa ruta y pidió un agente ahí con permiso para leer, editar
   y ejecutar. Conceder la confianza en ese mismo instante no añade ni un
   gramo de poder sobre lo que el lanzamiento ya concede; sólo lo escribe donde
   el CLI lo lee. La barrera que importa es quién eligió la ruta, y ésa está
   intacta.
3. El alcance es **exactamente** el del lanzamiento: la ruta a la que se lanza
   —ni el padre ni los hermanos— y sólo después de pasar las guardas que ya
   existían (`launchable`, `excludedWorkspace`, el rechazo del workspace de
   CAPCOM). Un worktree cuenta como carpeta propia, porque para el CLI lo es.

Y lo que **no** se hace:

- No se crea el fichero si no existe: que no exista significa que Claude Code
  nunca ha corrido en esta máquina, y su primer arranque escribe ahí su
  onboarding. Adelantarse con un fichero de una sola clave es inventarse su
  configuración, no contestar a su diálogo.
- No se reescribe un fichero que no parsea.
- No se degrada nada: si la entrada ya dice `true`, no hay escritura.
- La escritura es atómica y **optimista**: temporal en el mismo directorio,
  `fsync`, se relee el `mtime`+tamaño justo antes del `rename` y, si el fichero
  cambió debajo, se reintenta desde cero. El fichero está vivo — otras sesiones
  escriben su `lastCost` cada pocos segundos.
- Se conserva el modo del original. El `preTrust` anterior (el de CAPCOM)
  escribía `0644` fijo; sobre un `0600` eso era una apertura silenciosa de un
  fichero que en algunas instalaciones lleva credenciales de OAuth. Corregido
  al consolidar.

### Opt-in, opt-out, y carpetas propias

Se consideró hacerlo opt-in explícito y se descartó: el default «no conceder» es
exactamente el fallo que se está arreglando, y un opt-in que hay que recordar es
la misma clase de ritual que `orca-install`. Lo que sí hay es una salida
honesta:

- `ORCA_TRUST_SPAWNS=0` prohíbe la concesión. Con eso, un lanzamiento sobre una
  carpeta sin confianza **se rechaza con el porqué y con qué hacer**, en vez de
  congelarse esperando a nadie. Rechazar es seguro; colgarse no lo es.

Tampoco se distingue «carpeta que ORCA creó» de «carpeta ajena», y a propósito:
la única carpeta que ORCA crea sola es un worktree dentro de un proyecto que el
operador ya nombró, y la distinción que de verdad importa —quién eligió la
ruta— ya la hace el propio lanzamiento. Añadir una segunda categoría habría
sido una regla más que explicar sin una decisión más que proteger.

`preTrust` y `preTrustCodex` de `capcom.ts` siguen existiendo con la misma
firma; `preTrust` ahora delega en `trust.ts`, así que hay una sola
implementación y un solo sitio donde está escrito este razonamiento.

Las pruebas nunca tocan el `~/.claude.json` real: `CommandDeps.trustFile` acepta
una ruta o `false`, y bajo `ORCA_HARNESS` el default es no hacer nada.

---

## 2 · Cómo se ve el bloqueo cuando aun así ocurre

Antes, un worker parado en un diálogo nativo salía —cuando salía— como:

```
input · waiting on its terminal: nothing has been painted for 20s with a turn open
```

Ahora sale como:

```
input · native dialog waiting: "Quick safety check: Is this a project you created
or one you trust?" — nobody can answer it from ORCA; answer it in its terminal:
tmux -L orca attach -t =orca-<sessionId>
```

Tres cosas cambiaron:

- **`promptOn` ya reconocía el diálogo de confianza y ORCA no hacía nada con
  él** (`if (prompt.kind === 'trust') continue;`). Ahora produce un bloqueo con
  la pregunta leída de la pantalla. No hay escalación porque no hay tecla que
  ORCA pueda mandar en nombre de nadie: la confianza no tiene alcance «una vez».
- **El socket va en el comando.** `attachHint()` en `src/collector/tmux.ts` es
  ahora la única fuente de «cómo se llega a un pane», y siempre lleva `-L orca`.
  Un `tmux ls` a secas contesta «no server running». El brief de CAPCOM también
  se lo dice, para que lo repita verbatim al operador.
- **Panes sin sesión.** `readScreens` recorría derivers, y un pane atascado en
  el diálogo no tiene transcript, luego no tiene deriver, luego era invisible.
  `readOrphanScreens` barre los panes de ORCA que ningún agente reclama y
  publica una línea de alerta por diálogo, una sola vez. La primera vez que
  corrió en el sistema vivo encontró un superviviente del incidente: un pane
  llevaba ocho horas parado en el diálogo de `ventures` sin que nada lo dijera.

---

## 3 · El alta de proyectos

Los proyectos se descubrían sólo desde los slugs de `~/.claude/projects`
(`ProjectRegistry.ensureWork`), así que una carpeta sin sesión previa no existía
para el hub. Ahora:

- **`spawn_agent` y `launch_squad` aceptan una ruta absoluta** en `project_id`.
  Si ORCA no la conoce, la da de alta en la máquina que la tiene y lanza, en la
  misma llamada (`projectFor`, `src/agents/tools.ts`).
- **`register_project`** es la puerta explícita, para cuando el operador dice
  «añade este proyecto» y quiere su código antes de decidir nada.
- Por debajo, un comando nuevo `project:register` (hub → collector). El
  collector valida lo mismo que validaría un spawn —existe, es un directorio,
  no es ruta de sistema, no es el workspace de CAPCOM ni un scratchpad—,
  resuelve la ruta real y manda el snapshot **antes** de contestar, para que el
  hub tenga el proyecto cuando llegue el ack.
- El alta **se recuerda** en `~/.orca/projects.json` y se readopta al arrancar:
  un proyecto que aún no tiene transcripts no se redescubre solo, y perderlo en
  cada reinicio del collector sería devolver el ritual por la puerta de atrás.
- Con más de una máquina conectada, una ruta no dice de quién es: se contesta
  diciéndolo, en vez de adivinar.

`refuseWorkspace` cortaba por la primera barra («`<máquina>/<slug>`»), lo que
convertía `/Users/dan/x` en `Users/dan/x` y hacía que la guarda no reconociera
nada. Corregido: una ruta absoluta se pasa entera.

---

## 4 · Los comandos que el brief promete

El pie que el collector pega al brief de todo miembro de escuadrón nombra
`orca-tell`, `orca-read`, `orca-spawn` y `orca-recover`. **Ninguno estaba en el
PATH del worker.** Viven como ficheros en `bin/*.mjs`, y `orca-install` los
enlaza en `<proyecto>/.claude/bin/`, que no es un directorio que Claude Code
ponga en el PATH de nadie. Medido sobre catorce agentes en dos escuadrones: al
menos seis gastaron turnos enteros buscándolos (`which orca-tell`, `find
~/.orca`, `npm ls -g`, rebuscando en `~/.claude/plugins`); uno murió sin
escribir su entregable tras quince minutos investigando; varios cerraron su
trabajo pidiendo perdón por no haber podido avisar a su líder — con lo que el
líder tampoco se enteró de que habían terminado.

**Solución: el collector pone los comandos en el PATH de la sesión que lanza**
(`src/collector/shims.ts`). Cada shim es un `sh` de dos líneas con la ruta
absoluta del `.mjs` y el `node` de este collector, escritos bajo
`~/.orca/shims/`.

Con una trampa que costó un intento entero: **tmux no pasa `PATH` por `-e`.**
Medido contra tmux 3.7c, servidor recién arrancado:

```
tmux -L x new-session -d -e "PATH=/tmp/ZZZ:$PATH" -e ORCA_PROBE=yes \
  -- sh -c 'echo $PATH; echo $ORCA_PROBE'
  → ORCA_PROBE=yes    llega
  → PATH sin /tmp/ZZZ NO llega
```

El proceso inicial de una sesión hereda el `PATH` del **servidor** de tmux, no
el de la sesión; las demás variables sí viajan (`ORCA_PANE`, `ORCA_SPAWNED` y
las keys llevaban llegando desde siempre). Así que el `PATH` se pasa donde tmux
no lo puede reescribir: delante del argv, con `/usr/bin/env`, que exec-a en el
sitio — el pane sigue siendo el CLI, con su mismo pid, y sigue sin haber shell
por medio (`env` recibe un argv, no una línea). Sin `/usr/bin/env` no se toca
nada y el worker arranca como antes.

Se descartaron las otras dos salidas:

- *Quitar la promesa del brief* deja al miembro sin canal hacia su líder, que
  es renunciar a lo que un escuadrón es.
- *Escribir la ruta absoluta en el brief* funciona y se lee fatal, cambia en
  cada instalación, y no ayuda al agente que escribe un script ni al operador
  que copia una línea de la documentación.

Se hace en el lanzamiento y no con un instalador porque el instalador es un paso
manual, por proyecto, que ORCA nunca ejecuta.

Un detalle deliberado: **al miembro de un escuadrón no se le da `orca-ask`**.
El pie ya le decía que no lo usara; quitar la herramienta es más fiable que
pedir que no se use. El líder y el agente suelto sí lo llevan: son la puerta al
operador.

### La entrega es el archivo, no el mensaje

El pie del miembro ahora abre diciéndolo:

> Your deliverable is what you leave on disk in your working directory […] The
> messages below are how you keep your lead informed — they are courtesy, never
> the deliverable. If one fails, say so in one line in your final summary and
> finish anyway.

Y cierra diciendo que si un comando falta es un bug de ORCA, no algo que ir a
buscar por `npm`, `~/.orca` o los directorios de plugins — que es literalmente
lo que hicieron seis agentes.

### El líder se entera igual

`wake.tellLead` (`src/hub/wake.ts`): cuando un miembro de escuadrón llega a
`done` o `dead` **sin haber escrito a su líder**, el hub le manda al líder un
`notice` (o un `warning` si murió) diciendo que hay entregable en su directorio
de trabajo y que vaya a leerlo. No se manda si el miembro ya avisó — el aviso es
el respaldo, no una copia — ni si el líder ya no está vivo, en cuyo caso CAPCOM
se entera por su propio canal. El pie del líder lo anuncia, para que no lea el
silencio de un miembro como «no hizo nada».

---

## Demostración a mano

Sobre el sistema vivo (hub y collector corriendo desde este árbol), el
2026-09-08:

```
$ mkdir /Users/danielcardenas/projects/orca-trust-demo     # carpeta virgen
$ # sin entrada en ~/.claude.json, sin sesiones en ~/.claude/projects

register_project {"path":"/Users/danielcardenas/projects/orca-trust-demo"}
  → OC is on the map · /Users/danielcardenas/projects/orca-trust-demo

spawn_agent {"project_id":"/Users/danielcardenas/projects/orca-trust-demo", …}
  → spawned an agent on OC · pane orca-81b619ce-…

$ cat /Users/danielcardenas/projects/orca-trust-demo/TRUST-DEMO.md
/Users/danielcardenas/projects/orca-trust-demo
2026-09-08
launched by ORCA with no human at the keyboard
```

Ninguna tecla humana entre el spawn y el archivo. La entrada de confianza
apareció sola en `~/.claude.json` justo antes del lanzamiento.

Y el segundo camino, forzando el caso que el primero evita — un pane lanzado
**saltándose** el collector sobre una carpeta sin confianza. En el feed del hub,
segundos después:

```
alert | ORCA | orca-d234a791-… no ha llegado a existir como sesión: está parado
en un diálogo del CLI. native dialog waiting: "Quick safety check: Is this a
project you created or one you trust?" — nobody can answer it from ORCA; answer
it in its terminal: tmux -L orca attach -t =orca-d234a791-…
```

En la misma barrida apareció, sin buscarlo, `orca-22645b3e-…`: uno de los cinco
workers del incidente, ocho horas parado en el diálogo de `ventures`. Se dejó
donde estaba — no es de esta entrega apagar agentes ajenos — pero por primera
vez ORCA lo nombra.

Y el cuarto defecto, con un miembro de escuadrón de verdad sobre otra carpeta
nueva. Su misión era `which orca-tell orca-read orca-ask` y mandar un mensaje:

```
/Users/danielcardenas/.orca/shims/squad/orca-tell
/Users/danielcardenas/.orca/shims/squad/orca-read
orca-ask not found

sent: tell_mtrypun8tlnfor (notice → squad:shimdemo-01)
(exit: 0)
```

Los dos comandos que el brief le promete resuelven; `orca-ask`, que el brief le
prohíbe, no existe para él. El primer intento de esta misma prueba dio «not
found» en los tres y es lo que destapó lo del `PATH` en tmux.

Todo lo creado para las demostraciones se retiró: los panes, las carpetas, sus
entradas en `~/.claude.json` y el `~/.orca/projects.json` de la prueba.

---

## Cobertura

```
npm test -- trust        el caso entero: confianza, diálogo, shims, alta
npm test -- screen       el diálogo de confianza contra la pantalla real
npm test -- capcom       preTrust delegado, y el brief nombra register_project
npm test -- commands squads interrupt   los tres caminos de spawn
npm test -- codex        el argv y el descubrimiento de rollouts
npm test -- tmux         el spawn en un pane (PATH delante del argv)
```
