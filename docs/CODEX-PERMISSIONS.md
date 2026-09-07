# Permisos de Codex, y el agente que nadie veía parado — 2026-09-07

Un worker de Codex con el MCP de Playwright pide permiso varias veces seguidas.
ORCA no lo marcaba, la consola lo pintaba `working`, y el operador lo descubría
él. Esta entrega ataca las dos mitades del problema: por qué no se veía, y por
qué preguntaba tanto.

## Por qué no se veía

La detección buena es de pantalla: `readScreens()` captura cada pane vivo en
cada poll de liveness y pasa lo capturado por `promptOn()`. Reconocía un diálogo
MCP de Codex **sólo si entre sus argumentos había una línea `action:`**.

Ese requisito salió de la única herramienta con la que se midió,
`browser_tabs`, que casualmente tiene un parámetro llamado `action`. Ninguna
otra lo tiene: `browser_navigate` nombra `url`, `browser_click` nombra `element`
y `ref`, `browser_snapshot` no lleva argumentos. Las tres se descartaban, y
descartar aquí no es fallar seguro: es quedarse ciego en silencio.

El respaldo tampoco cubría: `stuckTool` exige un tool abierto durante
`PERMISSION_SUSPECT_MS` (90 s) y `gatedPending` devuelve `null` en Codex
siempre. Noventa segundos de ceguera por permiso, cuando saltaba.

## Qué se hizo

**Detectar y contestar dejan de ser la misma cosa.** Eran lo mismo: si el parseo
fallaba, no había bloqueo. Ahora hay tres capas, y sólo la primera lee un
diálogo:

**1. `promptOn` — el diálogo, para poder contestarlo.** Saber qué tecla mandar
exige entender el menú; no hay forma de evitarlo, y sólo esta capa lo necesita.
Reconocido, la escalación trae `allow | deny`. Ya no exige ningún campo a un
diálogo MCP: lo identifican la cabecera, las etiquetas exactas de las opciones y
el pie, y los nombres de campo viajan en el resumen mientras los valores nunca.

**2. `titleSignal` — lo que el CLI declara de sí mismo.** Codex escribe el
título de su terminal con OSC, y uno de los elementos que pinta —`activity`, en
`[tui].terminal_title`— es literalmente «spinner mientras trabaja, mensaje de
acción requerida mientras está bloqueado». Medido el 2026-09-07 contra 0.153.4
en un tmux aislado, leyendo `#{pane_title}`:

```
Ready | proyecto                    fin de turno, nada pendiente
⠸ Working | proyecto                turno abierto
[ ! ] Action Required | proyecto    esperando una respuesta   (parpadea a `[ . ]`)
```

No es una deducción de ORCA sobre una pantalla: es el CLI declarando su estado,
y en `idle` no lo dice, así que no hay falso positivo por fin de turno. Los
spawns fuerzan el elemento en el argv (`CODEX_TITLE_CONFIG`) para no depender de
lo que tenga el `config.toml` del operador; un elemento que una versión futura
no reconozca lo ignora Codex con un aviso, sin fallar el arranque.

El título viaja con la identidad del pane en la misma llamada de
`permissionView`, tras un tabulador y **fuera** de `identity`: el marcador
parpadea, y una identidad que cambia no identifica nada.

**3. `stallSignal` — el parón, cuando no hay nada más.** `screenSignature()` da
una huella de la pantalla y el bloqueo salta cuando lleva 20 s sin cambiar con el
turno abierto (`ORCA_STALL_MS`). No lee texto en absoluto, así que sobrevive a
que cualquier CLI reescriba su TUI. Un `Bash` de diez minutos no cae aquí: las
dos CLIs animan spinner, segundos y tokens mientras un comando corre. Lo que no
cambia es una TUI esperando una tecla.

Las capas 2 y 3 no afirman qué se pregunta, así que su bloqueo no trae opciones:
trae dónde contestarlo. La 3 es `input` —ni siquiera se sabe que sea un permiso—
y la 2 es `permission`, porque el CLI lo dice.

## Por qué preguntaba tanto

`auto` traducía a `-a on-request -s workspace-write`, y ese sandbox **corta la
red**: medido el 2026-09-07 con codex-cli 0.153.4, `codex sandbox -- curl
https://example.com` devuelve `000`. Un worker con navegador dentro de ese
sandbox no navega, y `-a never` no lo salva — en vez de preguntar devuelve el
fallo al modelo, que reintenta.

Entre parar la flota ante diálogos que nadie contesta y lanzar sin sandbox, para
Codex se elige lo segundo y se dice: **`auto` es
`--dangerously-bypass-approvals-and-sandbox`**. `ORCA_CODEX_APPROVALS=1` devuelve
la postura anterior sin tocar código. Claude no cambia: su `auto` ya resolvía
solo.

De paso, `manual` mapeaba a `-a untrusted`, que **0.153.4 ya no acepta** (`-a`
admite `on-request` y `never`). Era un spawn que fallaba en el lanzamiento, no
en la política. Pasa a la postura de `acceptEdits`; la granularidad perdida vive
ahora en los permission profiles de Codex, que ORCA todavía no usa.

## Lo que esto no arregla

- **Claude Code está sin medir.** Escribe título, pero no se ha comprobado que
  marque nada al pedir permiso. Hasta comprobarlo, para Claude manda `promptOn` y
  detrás el parón, que es lo que ya había. Es una tarde de trabajo: el mismo
  tmux aislado, un permiso provocado y `#{pane_title}`.
- El bypass quita el sandbox de verdad. Contenerlo es trabajo de worktrees
  (`ORCA_WORKTREES=1`), que sigue apagado por defecto y es la siguiente decisión.
- Las capas 2 y 3 dicen que un agente espera, no ante qué. Sin `promptOn` no hay
  `allow | deny`: hay que abrir el terminal.
- La señal del título es buena y sigue siendo texto. La que no lo es existe y no
  se usa: `codex app-server` publica `item/commandExecution/requestApproval`,
  `item/tool/requestUserInput` y `mcpServer/elicitation/request` como JSON-RPC
  tipado, con esquema que el propio CLI genera (`codex app-server
  generate-json-schema`). Es la salida definitiva, y es un cambio de
  arquitectura: hoy ORCA hospeda la TUI en un pane, y ese protocolo pide
  hospedar una sesión de app-server.

## Verificación

```
npm run typecheck
npm test -- --changed          37 suites, 492/492
```

Cubren esta entrega:

```
npm test -- permissions        promptOn con MCP sin `action`, huella de pantalla
npm test -- collector          titleSignal y stallSignal: umbral, estados, `since`
npm test -- codex              codexArgv: auto, título forzado, sin untrusted
npm test -- screen commands tmux interrupt
```

Los títulos de las pruebas son capturas reales, no invenciones: salen de
`display-message -p '#{pane_title}'` sobre un codex 0.153.4 en un tmux aislado,
con una aprobación provocada y luego cancelada.

`--changed` avisó de cuatro archivos sin suite que los cubra —`test/visual.ts`,
`test/field-stress.ts`, `test/hud-tasks.shots.ts`, `vite.config.ts`—: son
cambios ajenos a esta entrega que ya estaban en el working tree.

No se lanzó un worker real de Codex contra Playwright: el argv, la traducción de
posturas y la detección están probados; que el navegador complete una sesión
entera bajo el nuevo default está sin comprobar en vivo.
