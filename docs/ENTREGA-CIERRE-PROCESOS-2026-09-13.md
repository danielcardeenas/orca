# Detener una sesión cierra también su proceso

**Escuadra:** forge-tres-01 · **Pieza:** el cierre del proceso de un agente
cuando su sesión termina · **Fecha:** 2026-09-13

**Estado:** implementado y verificado contra procesos reales desechables y un
tmux en socket privado. **Sin corrida contra la flota real** (§7): hay agentes
vivos y sesiones del operador en esta máquina, y el brief lo prohibía sin aviso.

---

## 1. El hecho, y lo que había

Tres agentes que habían entregado seguían con su proceso vivo: 612M, 464M y
490M, 1,5G retenidos, con el swap del operador en 3,6G de 5,0G. Dos se habían
detenido expresamente desde el hub, que los daba por detenidos. La máquina no.

Lo que ORCA hacía al detener, antes de esta entrega:

| Camino | Qué terminaba | Qué miraba después |
|---|---|---|
| `stop` sobre un pane | Dos Ctrl-C; a los 6s, `kill-session` desde un temporizador | Nada. El ack decía «interrumpido; si no sale solo, se cierra en 6s», que es lo que se PROGRAMÓ, no lo que pasó |
| `stop` sobre un `--bg` | `claude stop <id>` | Nada |
| `remove` | `kill-session` y el worktree | Nada |
| El agente termina solo | — | Nada: la liveness deja de listarlo, el pane desaparece, y el pid se OLVIDA justo cuando hacía falta |
| Restos de higiene (`strays`) | Vite, entrypoints de ORCA, panes muertos, agentes fantasma | Explícitamente, «retirar no mata nada». No había un tipo de resto para «sesión terminada con proceso vivo» |

El mecanismo del fallo, reproducido en `test/reap-live.test.ts` con un pane de
verdad: un programa que ignora Ctrl-C y SIGHUP —lo que hace un CLI con la
terminal en modo crudo— sobrevive al `kill-session`, queda reparentado a init,
y nadie lo vuelve a mirar. Y el pid no se puede recuperar después: `claude
agents --json` ya no lista la sesión y el pane ya no existe.

## 2. La decisión del operador, tal cual se implementa

El cierre va **dentro de la detención**. Detener tiene dos efectos: la sesión
termina y su proceso se cierra. Si un agente termina solo y deja proceso, se
cierra igual. Con cinco condiciones que son puertas en orden, no matices:

| # | Salvaguarda | Dónde | Cómo |
|---|---|---|---|
| 1 | Sólo procesos que ORCA lanzó | `decideReap` | `origin === 'orca'`, que el linaje verifica por el registro de spawns. `'external'` **y ausente** se rechazan igual: no saber cuenta como externo |
| 2 | Sólo con la sesión terminada | `SessionReaper.ended` | Pane `orca-<id>` fuera del servidor de tmux **y** CLI sin listarla. `stop` espera hasta 8s a que eso ocurra; si no ocurre, el proceso no se toca |
| 3 | Nunca el collector, el hub, CAPCOM | `decideReap` | `role === 'capcom'` rechaza; subagente rechaza; la línea de comandos de un entrypoint de ORCA o un Vite rechaza (`orca-self`); y **todo pid que la liveness liste vivo**, de cualquier sesión y origen, más `process.pid` y `process.ppid`, es intocable |
| 4 | Identidad verificada justo antes | `decideReap` + `readRow` | Lectura NUEVA de `ps`: mismo pid, misma hora de arranque (±4s, por la resolución de `etime`) y **misma línea de comandos**. Sin hora de arranque no se actúa |
| 5 | Decir qué se liberó, con registro | `describeStop`, feed, log | RSS medido antes de la señal. Va en el ack, en una línea del feed (`K9: proceso 36572 liberado · 612M`) y en el log del collector |

Y una sexta que no estaba en el brief pero sale de la misma regla de «lista
permitida, no exclusiones»: la línea de comandos tiene que ser **una de las
formas de runtime observadas en la flota** —`claude` con sus argumentos, o el
Codex de npm por su envoltorio `node …/bin/codex` o su binario nativo—. Lo que
no encaja no se cierra aunque todo lo demás cuadre.

## 3. Qué se ha añadido

| Fichero | Qué |
|---|---|
| `src/shared/reap.ts` | Puro. `runtimeShape` (la lista permitida), `sessionIdInCommand` (`--session-id` / `--resume`), `decideReap` (las puertas, en orden, con evidencia), `describeStop`/`describeProcess` (el ack en dos partes), `sessionStray` (el resto para el panel) y `retainedBySessions` (la suma) |
| `src/collector/reap.ts` | `SessionReaper`. Recuerda la identidad de cada sesión mientras vive (`note` en cada latido de liveness, `remember` con un `ps -p` agrupado); `afterStop` para `stop`/`remove`; `sweep` para el agente que termina solo; `discover` para lo que quedó de antes de un reinicio del collector; `scan`/`clean` para HYGIENE |
| `src/collector/commands.ts` | `stop` y `remove` → `endSession` (lo de antes) y después `reaper.afterStop`. `stopPane` **espera** a que el pane se vaya en vez de programar un temporizador y contestar. `strays:clean` enruta los ids `stray_session_*` al reaper. `AgentHandle.role` |
| `src/collector/index.ts` | Monta el reaper con la liveness; `note`/`remember`/`sweep` en `pollLiveness`; `scan` en la muestra de higiene; `reapAgent` da procedencia, rol y estado |
| `src/shared/strays.ts` | `StrayKind` gana `'session'`; `Stray.rssBytes` |
| `src/hub/hygiene.ts` | Acepta `'session'` y deja pasar `rssBytes` (commit aparte, additivo) |

### El ack, en dos partes

```
sesión detenida (orca-208f… salió con Ctrl-C) · proceso 36570 liberado · 612M
sesión detenida (orca-208f… no salió con Ctrl-C; cerrado a los 6s) · proceso 36570 liberado · 612M
sesión detenida (…) · proceso 36570 NO liberado · 464M: pid 36570 now runs a different command (claude): it was reused
sesión NO detenida: orca-208f… sigue en el servidor de tmux · proceso: not attempted
```

`ok` es **true** en las tres primeras: la sesión terminó. Que el proceso no se
haya liberado va dicho aparte y con su motivo, y `data` lleva `{ session,
process }` tipados (`StopOutcome`) para quien prefiera leerlo a parsearlo.
Colapsar las dos cosas en un veredicto era volver a confundir la creencia del
hub con el estado de la máquina.

Si esta máquina no tiene el reaper montado (un arnés, un `CommandDeps` sin
`reaper`), `stop` hace lo de siempre y **no afirma nada** del proceso.

### La pieza que vale sola

`scan()` produce un resto de higiene por cada sesión que ORCA recuerda y no
está corriendo con normalidad, decidido con **la misma función** que cierra:

```
!  K9 · done · 612M retained        pid 36570                      [STOP IT]
·  orca-f0 · idle · 500M retained   pid 1490     ← externa: protegida, con el motivo
?  T4 · done · 37M retained          pid 41000    ← pid reciclado: ambiguo, no se toca
```

Lo que se ofrece es exactamente lo que `clean` haría. `retainedBySessions`
suma los huérfanos para la cabecera de LEFT BEHIND: «1 STOPPED SESSION RETAIN
612M». En el mismo `span` que el recuento, para no tocar `strays.css`.

## 4. Lo que NO se cierra, dicho en voz alta

- **Una sesión `--bg` sin pane que termina sola.** Para ella «el CLI no la
  lista» es la única señal, y ese silencio no es prueba: es el error que marcó
  27 agentes vivos como fantasmas en su día (`hub/liveness.ts`). Se **enseña**
  en HYGIENE como protegida con el motivo, y se cierra sólo tras un `stop`
  explícito de ORCA, que sí autoriza a esperar a que el CLI la suelte.
- **Codex tras un reinicio del collector.** Su argv no lleva el id de sesión,
  así que sólo se conoce por memoria del collector. Un `claude` sí (`--session-id`
  / `--resume`) y `discover` lo recupera de `ps`.
- **Los hijos del proceso** (servidores MCP, shells). SIGTERM le da al CLI la
  ocasión de recogerlos; tras un SIGKILL pueden quedar reparentados. No se
  buscan ni se cierran: no hay forma segura de atarlos a la sesión.
- **Una sesión cuyo pid nunca se vio** (un `--bg` que el CLI no listó con pid):
  `unknown`, con esas palabras.
- **Nada que la liveness liste vivo**, aunque su propia sesión haya terminado y
  todo lo demás cuadre.

## 5. Costes

`note` es una inserción en un mapa por latido. `remember` hace un `ps -p` sólo
cuando aparece un pid nuevo. `sweep` corre con la liveness (4s) y no lee la
máquina salvo que haya un candidato asentado; `discover` (un `ps -eo`) cada
60s. `stop` sobre un pane tarda ahora lo que tarde el pane en irse: ~1s si el
CLI sale con Ctrl-C, ~7s si hay que cerrarlo, más 4s de gracia si el proceso
ignora SIGTERM; todo dentro de los 30s del ack. Antes contestaba en 300ms y
mentía.

## 6. Verificación

```
npm run typecheck                    limpio
npm test -- reap                     reap.test.ts       17/17  (las reglas, con formas reales de la flota)
npm test -- reap-live                reap-live.test.ts  17/17  (procesos reales; un pane real en socket privado)
npm test -- --changed                ver §6.1
```

Las tres pruebas que el brief exigía para poder fusionar:

| Exigida | Dónde | Qué afirma |
|---|---|---|
| Una sesión externa no se toca nunca | `reap-live` «an external session with exactly the same process shape is never touched» y «no verified provenance» | Mismo script, mismo pid conocido, `origin:'external'` o ausente → `kept/external`, proceso vivo, feed vacío |
| Un pid reciclado no se cierra | `reap-live` «a recycled pid is not closed» | El pid recordado pasa a ser otro proceso: rechazado por orden distinta y por hora distinta; los dos siguen vivos |
| La detención informa por separado | `reap-live` «stop through the command runner, against a real pane…» y `reap` «a stop outcome always says the session and the process separately» | Pane real que ignora Ctrl-C y SIGHUP: `ok`, `data.session.stopped`, `data.process.result === 'freed'`, y el detalle con las dos partes |

Además: CAPCOM rechazado; un pid listado vivo intocable; sesión viva (pane o
CLI) intocable; `gone` sin señal; `unknown` honesto; un `claude --session-id`
de antes de un reinicio descubierto por argv y cerrado; el barrido respeta el
asentamiento y no pisa un `stop` en curso; un `--bg` que termina solo se
enseña y no se barre; el escaneo lista la detenida con su coste, protege la
externa y omite la que corre; `clean` por id libera; sin reaper montado, `stop`
se comporta como antes.

### 6.1 `npm test -- --changed`

Con los ficheros del núcleo y el del hub tocados: **80 suites, 1042/1042**.
El único «sin suite que los cubra» fue `node_modules` (el enlace simbólico del
worktree, sin importancia). Corrida sobre el worktree con el árbol en
movimiento (otros dos miembros commiteaban): indicio, no tasa.

Tras el toque de UI (§3): typecheck limpio; `npm run shots -- hyg-strays` y
`--changed` de nuevo, resultados en §6.2.

### 6.2 Tras el toque de UI

```
npm run typecheck                    limpio
npm test -- --changed                sin suite que cubra src/ui/windows/kinds/hygiene.ts (esperado: lo cubre el shot)
npm run shots -- hyg-strays          2 corridas: OK 10s, OK 10s
npm test -- hygiene                  31/31 (1 nuevo: el resto `session` cruza el hub con sus bytes; un tipo desconocido se tira)
```

El shot se extendió con un séptimo resto, `session` (`K9 · done · 612M
retained`), y afirma que se ofrece como huérfano con STOP IT, que el coste va
en la etiqueta y que la cabecera dice «1 STOPPED SESSION RETAIN 612M». La
primera corrida (antes de extenderlo) comprobó que el panel no se rompía con la
línea nueva; la segunda, que la línea dice lo que debe. Captura en
`test/shots/hyg-strays.png` (ignorada por git; publicada con orca-show).

## 7. Lo que no se ha hecho

- **No se ha cerrado ningún proceso real de la flota.** Los tres de 1,5G del
  brief ya no estaban cuando se miró la máquina. Lo cerrado en las pruebas son
  `node` desechables lanzados por la propia prueba.
- **Una corrida real de `stop` contra la flota** para ver el ack nuevo con un
  agente de verdad. Se puede hacer con un agente desechable lanzado a propósito
  por CAPCOM; queda para quien fusione.

## 8. Decisiones del brief que resultaron distintas al implementar

- **«Lo mismo para el agente que termina solo»** se cumple para sesiones
  hospedadas (pane). Para `--bg` sin pane no se puede sin adivinar (§4), y
  adivinar es lo que el brief prohibía. Queda enseñado, no automatizado.
- **El ack de `stop` deja de ser inmediato.** Contestar «interrumpido» a los
  300ms sin mirar era exactamente la afirmación sin contenido que el brief
  describe; ahora tarda lo que tarda el hecho.

Filtros que cubren esta entrega: `reap`, `reap-live`, `strays`, `hygiene`,
`interrupt`, `collector`.
