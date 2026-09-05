# ORCA — plan de los diez aprobados

Análisis propio, técnico y de UI, de cada pieza aprobada el 2026-09-05 a partir
de `docs/IDEAS.md`. Cada sección fija la decisión, no las opciones. El reparto
de archivos al final es el contrato entre agentes: nadie edita fuera de su
columna.

## 0. Motion tokens (arquitectura, previo a todo)

**Diagnóstico.** `tokens.css` declara `--t-snap/--t-quick/--t-move` y dos
easings y nada los usa. GSAP, CSS, el shader y el bucle RAF tienen cada uno sus
propios números. Con diez animaciones nuevas entrando, eso se convierte en
cuatro consolas distintas.

**Decisión.** Un solo módulo `src/ui/motion.ts` es la fuente de verdad:
exporta `T = { snap: 0.12, quick: 0.28, move: 0.55, wipe: 0.5, check: 0.32 }`,
`EASE = { out: 'power2.out', inout: 'power2.inOut', arrive: 'back.out(2)' }`,
`REDUCE` (prefers-reduced-motion) y un `stagger(n, beats)` que produce los
ritmos irregulares del video (4-2-3-5-2-6) en vez de un stagger uniforme. El
CSS lee los mismos valores porque `motion.ts` escribe los custom properties en
`:root` al arrancar; el shader recibe `uReduce` y las duraciones como uniforms
desde el mismo objeto. Cambiar un número cambia los tres motores.

**UI.** Regla del video: las formas se easean, las paletas se cortan. Ninguna
transición de color pasa por un fade.

## 1. Modo foco (Espacio)

**Técnica.** Un uniform `uFocus` (0→1, eased en 120 ms) en `swarm.ts` y
`pipes.ts`; por instancia, el flag `sel` ya existe. En foco, alpha = `sel>0 ?
1 : 0.12`, y el glow de los no seleccionados a cero. Las etiquetas DOM se
atenúan con una clase en el layer (`opacity .12`), no una por una. La tecla se
mantiene pulsada; al soltar, vuelve. Sin selección, Espacio no hace nada (no
hay nada que enfocar) salvo mostrar una pista en el hint.

**UI.** Foco enfoca *relaciones*: los seleccionados, sus tuberías, y los
agentes al otro extremo de esas tuberías a 0.45. Así el foco responde a "¿con
quién habla esto?" y no sólo "¿dónde está?".

**Riesgo.** Un `keydown` repetido de Espacio no debe re-disparar el ease; se
ignora `e.repeat`.

## 2. Latido de la flota

**Técnica.** Atributo por instancia `iFlash` (tiempo del último cambio de
estado, en el reloj del shader). En el fragment, `flash = exp(-(uTime -
iFlash) * 12)` mezcla el cuerpo hacia el color de estado durante ~120 ms. El
campo escribe `iFlash = clock` en `feedNow()` para cada agente cuyo estado
difiere de `lastState`. Coste: un float por instancia, cero CPU extra.

**UI.** El golpe es simultáneo para todos los que cambian en el mismo `patch`;
ése es el beat del video. No hay stagger. A 1.000 agentes un patch grande hace
un destello de campo entero: correcto, es lo que pasó.

## 3. Marcadores de cámara + volver

**Técnica.** Módulo `hud/bookmarks.ts` con historial (pila de 30 vistas) y 9
slots persistidos. Todo vuelo programado (`flyTo`, `frameProject`, minimapa,
`/find`) pasa por `push()` antes; el pan/zoom manual no apila (sería ruido).
`Backspace` vuelve. Instrumento de 9 casillas bajo la mast.

**UI.** Slot ocupado = lima; vacío = línea. Shift+clic guarda. Nada se anima
salvo el vuelo, que ya existe.

## 4. Barrido lima al contestar + check al cerrar

**Técnica.** `windows/fx.ts` con `wipe`, `check`, `collapse` como Promises
sobre el elemento `.win`; `wm.closeWith(win, fx)`. Referencia exacta en
`boot.ts:161-170, 225`. Con reduced-motion resuelven al instante.

**UI.** El barrido va de izquierda a derecha (dirección de lectura), invierte
la tinta a `#1a0000` al pasar, y corta. El check se traza píxel a píxel al
terminar un agente. Nunca un fade.

## 5. Disciplina del ámbar

**Técnica.** Hoy `alert=1` para todo `blocked` no-peer. Pasa a: ámbar pleno
con glow sólo si el agente tiene una escalación `pending`/`with_ceo` (la que
puedes contestar desde aquí); `permission`/`input` sin escalación → ámbar en
el borde y cuerpo oscuro, sin glow ni respiración. El campo ya conoce las
escalaciones por `store.world.escalations`.

**UI.** El glow vuelve a significar "puedes resolverlo con un clic". Lo que
hay que contestar en una terminal ajena no grita.

## 6. Sonido del comp

**Técnica.** `hud/sound.ts`, WebAudio sin archivos, osciladores de pulso,
tonos ≤180 ms, muteado por defecto, desbloqueo en el primer gesto, coalescencia
(1 por tipo cada 400 ms, 3 por segundo). Se suscribe al store.

**UI.** Seis eventos, seis tonos; el silencio es el estado por defecto y la
tecla `S` conmuta. Un tono nunca se repite en bucle.

## 7. Presets de flotilla + ventana ALGN

**Técnica.** `windows/kinds/launch.ts`. Presets en localStorage (JSON
validado), lanzamiento secuencial con 150 ms entre spawns. La ventana se
convierte en el modal ALGN: filas flush → escalera (A10) → cremallera por fila
al llegar el ack (A11) → flush → `collapse`. Un fallo pinta su fila en rojo y
la ventana se queda. Flash lima (A19) al disparar.

**UI.** La escalera *es* el estado del lanzamiento: la fila i se abre cuando el
agente i reporta `booting`. Es el momento más caro del video y el que más se
verá; tiene que ser exacto.

## 8. Trazo de escalación hasta YOU

**Técnica.** Un nodo YOU por región (esquina superior derecha del contorno, un
puerto cuadrado ámbar con etiqueta DOM "YOU · n"). Para cada agente
`blocked` no-peer con escalación: tubería `ask` ámbar desde el agente al YOU
de su región. Para cada `peer`: tubería `ask` hacia el agente al que espera
(ya existe si hay mensaje; si no, se crea desde `block.waitingOn`). La cadena
represada (`store.dammedBehind`) se pinta en `hot` cuando su terminus está
seleccionado. Contar `n` = escalaciones pendientes en la región.

**UI.** La V invertida de tuberías que convergen en YOU es la imagen de
"UNBLOCKS n": se ve cuántos cuelgan de la misma respuesta.

## 9. Galería de artefactos

**Técnica.** `windows/kinds/gallery.ts`, cuadrícula con filtros por proyecto y
agente, miniaturas autenticadas, drag HTML5 con `text/orca-artifact`; el drop
lo recibe el campo (`dropArtifactAt(id, sx, sy)`), que crea la colocación en
la coordenada del mundo bajo el cursor.

**UI.** Soltar sobre el campo es la forma más directa de "enséñame esto aquí".

## 10. Línea de tiempo + "mientras no estabas"

**Técnica.** Hub: anillo de instantáneas compactas cada 20 s (24 h / 6.000),
persistido en `~/.orca/history.jsonl`; `/api/history` y
`/api/history/summary`. UI: ventana con scrubber e histograma; el campo entra
en modo replay con `setReplay(world)`: dibuja un `WorldState` sintético y la
mast muestra `REPLAY · hh:mm`; `LIVE` vuelve. El resumen usa `orca.lastSeen`.

**UI.** El replay no es un video: es el mismo campo con otro estado. Todo lo
demás sigue funcionando (abrir un agente muestra su estado de entonces).

## Reparto de archivos

| Dueño | Archivos |
|---|---|
| Fable (arquitectura) | `docs/PLAN.md`, `src/ui/motion.ts`, cableado final en `main.ts`, `command.ts`, `console.ts` |
| Opus · campo | `field/swarm.ts`, `field/pipes.ts`, `field/field.ts`, `field/labels.ts`, `styles/field.css` |
| Opus · HUD | `hud/bookmarks.ts`, `hud/sound.ts`, cola de `styles/hud.css` |
| Opus · ventanas | `windows/fx.ts`, `windows/kinds/{interrupt,agent,artifact,gallery,launch}.ts`, cola de `styles/window.css`, `wm.ts` (sólo kinds, tamaños, `closeWith`) |
| Opus · historia | `hub/history.ts`, enganches mínimos en `hub/server.ts` y `hub/world.ts`, `ui/history.ts`, `windows/kinds/timeline.ts`, `test/history.test.ts` |

Verificación: cada agente deja `npx tsc --noEmit` en verde; el cableado final
corre `npm test`, `npm run visual` y `npm run stress`, y se miran los frames.

## 11. CAPCOM: el comando central es un agente de la flota

**Diagnóstico.** El CEO vive en el hub como bucle del SDK de Anthropic: paga
API por vuelta, es el único punto del proyecto atado a un proveedor, e ignora
la suscripción de Claude Code que ya mueve al resto de la flota.

**Decisión.** CAPCOM (NASA: la única voz que habla con la tripulación en
nombre de control) es una sesión de CLI más — Claude Code hoy, Codex cuando
tenga adaptador — que el collector lanza en `~/.orca/capcom/` con un `CLAUDE.md`
que es su brief y un `.mcp.json` que apunta al hub. El hub expone sus
herramientas de flota como **servidor MCP** (`/mcp`, autenticado por token):
`list_fleet`, `inspect_agent`, `spawn_agent`, `send_to_agent`, `stop_agent`,
`answer_agent`, `ask_human`, `recall`, `remember`, `read_traffic`, `relay`,
`answer_peer`, `resolve_collision` — las mismas que hoy tiene `src/agents/tools.ts`,
reutilizando `runTool` y `CeoContext`. Cualquier CLI que hable MCP puede ser
CAPCOM; el comando es agnóstico de runtime por construcción.

**Flujo.** Lo que escribes en la línea de comandos va al hub como hasta ahora
y el hub lo entrega a CAPCOM con `say`. Una escalación de un agente se
entrega a CAPCOM como mensaje; CAPCOM contesta con `answer_agent` o la sube
con `ask_human`, que es lo que hoy hace `considerEscalation`. La memoria
sigue en `hub/memory.ts` detrás de `recall`/`remember`. La ventana CAPCOM es
la vista del transcript de esa sesión, como la de cualquier agente.

**Fallbacks.** `--api-command` conserva el CEO de API para quien no tenga
CLI; el guionizado sigue siendo el fallback sin coste. Ningún camino queda
sin comando.

**UI.** `CEO` → `CAPCOM` en mast, línea de comandos, ventana, ayuda y
documentos. La ventana muestra el transcript de CAPCOM cuando existe un
agente con `role: 'capcom'` y la conversación del CEO de API en su defecto.

| Dueño | Archivos |
|---|---|
| Opus · CAPCOM backend | `hub/mcp.ts` (nuevo), `hub/server.ts`, `hub/world.ts`, `collector/capcom.ts` (nuevo), `collector/index.ts`, `collector/commands.ts`, `shared/types.ts` (`Agent.role`), `shared/protocol.ts`, `agents/*`, `README.md`, tests |
| Opus · CAPCOM UI | `windows/kinds/ceo.ts`, `windows/kinds/misc.ts`, `DESIGN.md` wording |
| Fable | `main.ts`, `hud/mast.ts`, `hud/command.ts` (etiquetas y enrutado) |

## 12. Teclado en todos los botones, y la pila de ventanas

**Teclado.** Cada botón de acción lleva un `<kbd>` con su tecla, como los
instrumentos de la mast. La tecla actúa sobre la **ventana activa**: `data-key`
en el botón, un `<kbd>` inyectado automáticamente por el gestor de ventanas
(no se escribe a mano en cada kind), y un despachador único en `wm.ts` que,
con el foco fuera de un input, busca `[data-key="…"]` en la ventana activa y
hace clic. Asignación por ventana: agente `S` say, `F` fly, `L` logs, `C`
spawn child, `X` stop (armado, dos veces); interrupción `1…9` opciones,
`Enter` enviar, `O` abrir agente, `D` descartar; flota `A` say all, `L` say
lead, `F` frame, `N` spawn here, `X` stop all; CAPCOM `Enter` enviar, `1…5`
órdenes; spawn `Enter` spawn; launch `Enter` launch, `E` editar presets;
artefacto `P` place/remove, `R` raw; galería `P` sobre la miniatura enfocada;
timeline `L` live, `←/→` paso; música `A` add. Universales con ventana activa:
`Esc` cerrar, `-` plegar, `Shift+Tab`/`` ` `` ciclar la pila. Las teclas del
campo (`F O D G T C Q L N M S 1…9 Backspace /`) solo actúan cuando **no** hay
ventana activa; cuando la hay, la ventana manda. La mast lo muestra: al
enfocar una ventana sus `kbd` se encienden y los de la mast se apagan.

**Pila.** Las ventanas abiertas son una pila por z-order, visible en la
bandeja como una fila de fichas con mordida (las plegadas ya están ahí; las
abiertas se añaden a la izquierda, la activa en lima con su callsign). `` ` ``
cicla, clic activa. La activa lleva la cabecera con una línea lima de 2 px
bajo el título además de la sombra de foco actual.

**Fuera de vista.** Una ventana anclada cuya ficha está fuera de pantalla hoy
se atenúa al 15 %. Pasa a: la ventana se queda legible en el borde de la
pantalla más cercano a su ficha (clamp), con un indicador de borde: un puerto
cuadrado + flecha pixel + callsign en el color de estado, pegado al borde por
donde queda la ficha. Clic en el indicador o `V` con esa ventana activa hace
un **zoom out temporal**: `pushView()`, la cámara encuadra el rectángulo que
contiene la vista actual y la ficha (`camera.frame` con ambos), y `Backspace`
devuelve. Al ciclar la pila hacia una ventana con ficha fuera de vista, el
zoom out temporal ocurre solo.

| Dueño | Archivos |
|---|---|
| Opus · teclado y pila | `windows/wm.ts` (despachador, kbd, pila, indicador de borde), `windows/kinds/*.ts` (solo añadir `data-key` a los botones), `hud/tray.ts` (pila), `styles/window.css`, `styles/hud.css` (final) |
| Fable | `main.ts` (ceder teclas a la ventana activa, `V`, `` ` ``), `field/field.ts` (`frameWith(rect)`) |
