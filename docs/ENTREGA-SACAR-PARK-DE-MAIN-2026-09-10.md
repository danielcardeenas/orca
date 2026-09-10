# Entrega — «Aparcar ociosos» sale de `main`, a una rama borrador

**Fecha:** 2026-09-10
**Estado:** hecho en el árbol de trabajo de `main`, sin commit ahí. La
consolidación de `main` la hace otro agente.

## Por qué

`ParkClock` (`src/hub/park.ts`) paraba por defecto a cualquier agente ocioso
más de dos horas, y sus órdenes `stop` —como las de `park_idle_agents`—
salían sin consola y sin `reason`, así que se saltaban la guarda de Agent stop
(`agentStopReason`, `src/shared/agent-stop.ts`) que el hub solo aplica cuando
`consoleId !== null || cmd.reason !== undefined`. En el hub real paró a
miembros y al lead de una misión activa. El operador decidió sacarlo de `main`
sin descartarlo, y no tocar Agent stop, que comparte archivos con park.

## Qué se sacó de `main` (solo park)

| Archivo | Hunks retirados |
|---|---|
| `src/agents/tools.ts` | import `parkCandidates`; specs `resume_agent` y `park_idle_agents`; sus dos `case` en `runTool`; funciones `resumeAgent` y `parkIdleAgents` |
| `src/collector/briefs.ts` | las dos líneas del briefing de CAPCOM sobre `park_idle_agents` y `resume_agent` |
| `src/hub/server.ts` | import `ParkClock`/`parkConfig`; `HubOptions.park`; `Hub.park`; bloque `parkClock`/`parkNote`/`parkSweep`; `parkSweep()` en el sweep; `park:` en el hub devuelto |
| `src/ui/console.ts` | métodos `resume` y `archive` de la interfaz `Console` |
| `src/ui/main.ts` | implementaciones de `c.resume` y `c.archive` |
| `src/ui/hud/context.ts` | import `parkCandidates`; `parkRow`; fila PARK IDLE en campo, proyecto, squad y selección; ARCHIVE FINISHED de la selección; RESUME y ARCHIVE de un agente terminado |
| `src/ui/windows/kinds/agent.ts` | botones RESUME y ARCHIVE, su habilitado en `render` y sus listeners |
| `bin/orca.mjs`, `README.md`, `src/collector/tmux.ts`, `test/tmux.test.ts` | restaurados a HEAD: su diff era íntegramente park (`orca park`, `orca resume`, `printPark`, sección «Parking idle agents», `killServer` borrando el socket y su test) |
| `src/shared/park.ts`, `src/hub/park.ts`, `test/park.test.ts`, `docs/ENTREGA-APARCAR-OCIOSOS-2026-09-10.md` | archivos sueltos, movidos a la rama |

Se dejó en `main` todo lo de Agent stop en esos mismos archivos: `reason` en
`stop_agent` y en el protocolo, la guarda con `agentStopReason` y
`describeCommand` en el hub, `STOP…` con `stopUnavailable`/`requestAgentStop`
en los dos menús y en la ventana del agente, la retirada del STOP armado de dos
clics y el repintado con `missions`. También `BROWSE FILES`, `openFiles`,
`/api/dir`, FORGE, el carril del HUD y el resto de features del árbol.

Quedan dos menciones al nombre del documento de park en listados de
verificación de `docs/FORGE.md` y `docs/ENTREGA-FORGE-PERMISOS-2026-09-10.md`;
son historia de esas entregas y no se tocaron.

## Dónde está park ahora

Rama `park/aparcar-ociosos-borrador`, desde `40dfcfc` (HEAD de `main` en el
momento), en un worktree temporal del scratchpad de la sesión. Dos commits:

- `e2fba80` — `TmuxHost.killServer` borra el fichero del socket, con su test.
  Arreglo independiente, aparte para poder rescatarlo solo.
- `f09bf6c` — el borrador de park entero: los mismos hunks de la tabla, más
  los cuatro archivos sueltos. El mensaje del commit documenta el bug de la
  guarda (`agentStopReason`), lo que pasó en el hub real y las tres condiciones
  para reintegrarlo: `parkable` delega en `agentStopReason`, el reloj arranca
  en `off` o `warn`, y los `stop` del reloj y de la tool pasan por la misma
  guarda que los de consola.

La rama no incluye Agent stop ni el resto del árbol sin commitear: al
reintegrar habrá que reconciliar `context.ts`, `kinds/agent.ts`, `tools.ts` y
`server.ts` con lo que `main` tenga entonces.

## Verificación

- `main`: `npm run typecheck` limpio tras sacar los hunks. Antes de retirar
  `test/park.test.ts` fallaba solo por él (`hub.park` ya no existe), lo que
  confirma que ninguna otra pieza del árbol referenciaba park.
- `main`: `git diff` sin `ParkClock`, `parkable`, `parkCandidates`,
  `park_idle`, `resume_agent`, `PARK IDLE`, `data-resume`, `c.resume`,
  `c.archive` ni `killServer`.
- `main`: `npm test -- --changed`: 952/952 en verde sobre el árbol compartido
  (incluye los cambios sin commitear de las demás misiones). «Sin suite que
  los cubra» lista `src/ui/main.ts` y `src/ui/windows/kinds/agent.ts`, que
  aquí solo pierden código; es el mismo aviso que ya daba Agent stop.
- Rama borrador: `tsc --noEmit` limpio. Sus suites (`park`, `tmux`, `cli`) no
  se corrieron desde el worktree: `npm test` desde otro checkout reescribe
  `~/.orca/shims` hacia ese checkout.

Filtros que cubren esta entrega: `agent-stop`, `hub`, `tmux`, `cli`.
