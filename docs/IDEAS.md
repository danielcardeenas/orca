# ORCA — IDEAS

Dirección creativa a partir del comp `offworld.mp4` (28 s, 24 fps), del contrato
`DESIGN.md`, y del estado real de la consola hoy.

**El hallazgo que ordena todo lo demás.** El vocabulario de movimiento del video
ya está implementado, completo y con GSAP, en `src/ui/boot.ts` — y muere a los
11,9 segundos. Después de `finish()` la consola entra en un mundo donde existen
exactamente **dos** `@keyframes` en todo el CSS: `band-run`
(styles/window.css:190) y `blink` (styles/window.css:246). El campo cambia de
estado sin que nada lo anuncie. No hay que inventar un lenguaje: hay que
**sacar el que ya existe del boot y repartirlo por eventos**.

Dos hechos que lo confirman:

- **Los tokens de motion están declarados y no se usan.** `--t-snap`,
  `--t-quick` y `--t-move` (styles/tokens.css:82-84) tienen **cero** apariciones
  en todo el CSS; de los dos easings (`:85-86`) sólo `--ease-out` se usa una vez
  (styles/field.css:17). Todas las duraciones reales están a mano y dispersas:
  GSAP (`wm.ts:288` → 0.22, `alarm.ts:29` → 0.9, `misc.ts:22` → 6), literales en
  CSS (`window.css:187`, `:236`, `:242`), o números en el shader.
- **Hay tres motores de animación sin contrato entre ellos**: GSAP (boot y
  chrome), GLSL (el campo), y easing manual en el RAF (cámara y spots). El
  *breathing* del tile corre a `2.856 rad/s` (`field/swarm.ts:77`) — un número
  que no sale de ningún token.

Corolario de dirección: **antes de añadir movimiento hay que hacer que los cinco
tokens de motion signifiquen algo en los tres motores.** Es media tarde de
trabajo y es la condición para que todo lo demás se sienta de la misma máquina.

GSAP está instalado y lo usan cuatro archivos (`boot.ts`, `windows/wm.ts`,
`hud/alarm.ts`, `windows/kinds/misc.ts`). Three.js dibuja el campo. El coste de
todo lo que sigue es bajo porque las dos herramientas ya están en el bundle.

---

## A. Vocabulario de movimiento del video

Tiempos medidos sobre frames a 6 fps (`f_NNN`, t = (N−1)/6). Donde el boot ya
implementa el gesto, cito la línea: ésa es la implementación de referencia a
extraer.

| # | Gesto | Frames (t) | Qué se mueve | Duración | Easing | → Evento de la consola | Implementación |
|---|---|---|---|---|---|---|---|
| A1 | **Cascada POST** | f_001–f_008 (0,0–1,2 s) | Líneas de log mono aparecen una a una, arriba-izq, sin fade: corte por línea cada ~52 ms. En paralelo un segundo bloque de status a 38 ms | 1,2 s | ninguno (steps) | **Un collector se engancha**: sus líneas reales (`attach`, bytes, sesiones) se imprimen una a una en la ventana de máquina | ya en boot.ts:141-145; portar a `windows/kinds/fleet.ts` |
| A2 | **Ensamblaje del wordmark** | f_002–f_012 (0,2–1,8 s) | Píxeles sueltos convergen al glifo; f_009 aún está roto y desplazado, f_011 nítido. Termina con blur 8px→0 + scale 1,06→1 | 0,28 s (fase final) | `power2.out` | **Callsign resolviéndose**: al abrir una ventana de agente el callsign se ensambla de píxeles en 180 ms; y el logo de la mast al recuperar el link | boot.ts:149-151 → `windows/wm.ts` header |
| A3 | **Barra de carga** | f_009–f_018 (1,3–2,8 s) | Relleno blanco izq→der; un hairline ámbar corre **por delante** del relleno y desaparece al saturar | 1,15 s | `power1.inOut` | **Catch-up de un transcript** (leer 24 MB tiene final conocido). Nunca el progreso de un agente: el contrato lo prohíbe | boot.ts:152-153 |
| A4 | **Glifos X en ráfagas** | f_022–f_033 (3,5–5,3 s) | Glifos de pixel-art entran con scale 0,6→1. **Dos ráfagas**: 4 a 130 ms, pausa de 0,5 s, 4-6 más a 100 ms. Nunca ritmo constante | 0,12 s c/u | `back.out(2)` | **Cargando / esperando**: un agente `thinking` sin tool call. Sustituye cualquier spinner. También el CEO redactando | boot.ts:161-166 → `windows/kinds/agent.ts` |
| A5 | **Barrido lima** | f_033→f_035 (5,3–5,7 s) | Una barra lima sólida crece desde la izquierda **por encima** de los glifos y se los come; al llenar, los glifos se apagan en 180 ms y corta | 0,50 s | `power2.inOut` | **Confirmación al contestar una interrupción**: al enviar, la ventana se llena de lima izq→der, la tinta se invierte a `#1a0000`, y se cierra. Igual para `REMEMBER` guardado | boot.ts:167 → `windows/kinds/interrupt.ts` |
| A6 | **Cuadro de check** | f_037–f_041 (6,0–6,7 s) | Board lima entra a scale 0,82→1; los 8 píxeles negros del check se dibujan **uno a uno** de izq a der, ~40 ms cada uno, bajando y subiendo | 0,26 s + 0,32 s | `power2.out` + steps | **Un agente termina**: su ventana se va con el check trazado píxel a píxel. Y el check en miniatura en el feed cuando el CEO contesta solo y tú nunca lo ves | boot.ts:173-175 |
| A7 | **Tiles que se encienden** | f_043–f_060 (7,0–9,8 s) | Rejilla 4×4 de tiles con muesca. Se encienden **a golpes irregulares**: 4, 2, 3, 5, 2, 6 — cada beat a ~300 ms, apagando los anteriores. No es una ola | 0 s (flip) | ninguno | **Latido de la flota**: cuando llega un `patch` del hub con N agentes cambiados, esos N tiles hacen flash en el mismo frame, en golpe. Hoy el patch cambia el color y no pasa nada | boot.ts:184-187 → `field/swarm.ts` (uniform `uFlash` por instancia) |
| A8 | **Árbol de tuberías NULL→ACTV** | f_046–f_072 | Árbol ortogonal de cajas `NULL` que viran a `ACTIVE` de una en una cada ~200 ms, con el relleno lima corriendo **por dentro** de la tubería desde la raíz | 0,12 s por nodo | ninguno | **Linaje de spawn**: la tubería padre→hijo se dibuja creciendo desde el puerto del padre, y el puerto vira a lima al primer output del hijo | boot.ts:189 → `field/pipes.ts` |
| A9 | **Columna de glifos que se mezclan** | continua, f_046–f_090 | Bloque de 3×6 caracteres que se re-aleatoriza cada 70 ms; algunos en ámbar/azul (chroma) | ciclo 70 ms | ninguno | **Telemetría viva**: el hex de la esquina de cada ventana existe pero está congelado. Debe mezclarse **sólo mientras su agente está `working`** y congelarse en `idle`. Un dato falso que dice una verdad: si se mueve, hay tráfico | boot.ts `scrambleLoop` (70 ms) → `windows/wm.ts` |
| A10 | **Escalera ALGN** | f_072–f_082 (11,8–13,5 s) | 8 filas entran flush (y 14→0, escalonadas 44 ms) y luego **se meten hacia dentro** una cantidad creciente con la profundidad: `padding-left 10+i·14px`, `padding-right 10+i·10px`. Asimétrica: más inset a la izquierda | 0,46 s, stagger 32 ms | `power2.inOut` | **Una flota lanzándose en cascada**: `/launch` de 5 agentes. La fila *i* se abre cuando el agente *i* reporta `booting`. La escalera **es** el estado de lanzamiento, no un adorno | boot.ts:206-223 |
| A11 | **La cremallera** | f_078–f_086 (12,8–14,2 s) | Dentro de cada fila un relleno lima crece **desde el centro hacia los dos lados**. Como las filas están en escalera, los rellenos dibujan una V. Al llenar, las filas vuelven flush | 0,74 s, stagger 55 ms; retorno 0,40 s | `power2.inOut` | **Sincronización de un collector**: cada transcript en catch-up es una fila, su relleno crece del centro hacia fuera, y cuando todas llenan las filas se alinean y el modal se va. Duración real = la del catch-up | boot.ts:214-223 |
| A12 | **Colapso del modal** | f_090–f_093 (14,8–15,3 s) | El panel lima crece casi a pantalla completa mientras las filas caen por debajo del borde; colapsa a una barra horizontal y a nada | ~0,40 s | `power2.inOut` | Cierre de cualquier confirmación lima. Nunca un fade | boot.ts:225-228 |
| A13 | **Radar: construcción del eje** | f_095–f_101 (15,7–16,7 s) | Línea vertical fina desde el centro-abajo hacia arriba; círculo en el origen; luego la horizontal crece hacia los dos lados; 4 ticks lima gruesos; la retícula de puntos aparece **fila a fila de abajo arriba** | ~1,0 s | `1-(1-n)³` | **Arranque del minimapa** (`M`, hud/minimap.ts): se construye así en 400 ms, no aparece de golpe | **`gfx/radar.ts` ya lo dibuja entero**, parametrizado por un solo `t` 0→1 (`:32-41`), y hoy sólo lo usa el boot |
| A14 | **Radar: haces y anillos** | f_101–f_126 (16,7–20,8 s) | Dos haces rectos salen del origen abriéndose en ángulo; los círculos **se apoyan en el origen**, no son concéntricos (`radar.ts:68-75` lo llama `sit()`); arcos exteriores en oliva apagado. Capas escalonadas cada ~0,5 s | ~2,0 s por capa | `1-(1-n)³` | **Ping**: cada `patch` del hub dispara un anillo desde el centro del minimapa; un `flyTo` dispara uno desde el destino | `gfx/radar.ts` → `hud/minimap.ts` |
| A15 | **Cuadro rojo** | f_118–f_133 (19,5–22,0 s) | Un cuadrado rojo sólido pequeño aparece **de golpe**, sin fade, en el cuadrante superior izquierdo, y **no se mueve ni parpadea** durante ~4 s. Único rojo en un campo lima | 0 s | ninguno | **Bloqueado / muerto en el minimapa**: rojo estático para `dead`, ámbar estático para `needs you`. No parpadea — la quietud es lo que lo hace visible. Ojo: `gfx/radar.ts:130-139` pinta el blip **pulsante** (`0.65+0.35·sin(p·22)`); el video no pulsa, y tiene razón | `hud/minimap.ts:79-92` ya difiere los bloqueados a un segundo pase a 3px |
| A16 | **SIGNAL DETECTED** | f_126–f_140 (20,8–23,2 s) | Patrón ajedrezado de cuadros lima aparece de golpe y **crece en escala** mientras una marquesina corre de derecha a izquierda a velocidad constante | 1,3 s (xPercent 0→−50) | `none` | **Un agente nuevo entra**: banda de una línea en la mast (no pantalla completa), con el patrón del callsign nuevo y su brief real corriendo **una sola pasada** | boot.ts:237 |
| A17 | **SYS BREACH** | f_140→f_147 (23,2–24,3 s) | Mismo patrón y misma marquesina, pero **todo vira a rojo en un frame**; el fondo pasa a `--red-deep`. No hay transición: es un corte | 1 frame | ninguno | **Pérdida de link con el hub / breach**: `body.is-breach` vira los tokens de tinta y la marquesina. Corte, jamás un fade | `styles/tokens.css` (clase de body) |
| A18 | **Lluvia de píxeles** | f_151–f_167 (25,0–27,8 s) | Píxeles rojos aparecen al azar sobre el negro, cada vez más densos, hasta inundar la pantalla; luego se invierte (huecos negros sobre rojo). La densidad **crece de arriba abajo**: en f_157 la mitad superior ya está densa y la inferior sigue negra. Es una cortina que cae con dither aleatorio en el borde | ~1,2 s de ida | densidad lineal, borde con ruido | **Link caído**: la cortina cae sobre el campo en 900 ms con el error real escrito encima, y se retira igual cuando el WS reconecta | pasada full-screen en `field/field.ts`: `hash(uv) < umbral(t, uv.y)` |
| A19 | **Flash lima entre escenas** | f_043, f_055 | Un frame a lima 100 % que se va en 180–260 ms | 0,18–0,26 s | lineal | `/spawn` aceptado, `/launch` disparado. La única celebración permitida | boot.ts:196-197, 227-228 |

**Reglas que el video enseña y hoy no se cumplen.**

- **Nada llega a ritmo constante.** Los glifos van en dos ráfagas, los tiles en
  beats de 4-2-3-5-2-6. Un stagger uniforme se lee como una animación; uno
  irregular se lee como una máquina.
- **El rojo no se anima.** El cuadro rojo del radar está quieto cuatro segundos
  entre haces que se mueven. Es lo que lo hace visible.
- **Los cambios de paleta son cortes**, los cambios de forma son eases.
- **El relleno lima siempre crece desde un origen con significado**: la
  contraseña desde la izquierda (dirección de lectura), la cremallera desde el
  centro (sincronía simétrica), la barra de carga desde la izquierda (tiempo).

---

## B. Funcionalidades nuevas

### B1 · Marcadores de cámara (`Shift+1…9` graba, `1…9` vuela) — **S**
Guarda la vista actual; volar a ella es un `camera.flyTo` de 0,7 s
(`field/camera.ts:120`). Cada marcador es una muesca en el minimapa.
**Por qué:** una flota de 1.200 agentes (b2-artifact) no se recorre a mano dos
veces. **Depende de:** `field/camera.ts`; el minimapa ya sabe encuadrar y
arrastrar el viewport (`hud/minimap.ts:46-56`, `:99-118`).

### B2 · Volver (`Backspace`) — **S**
Pila de vistas: cada `flyTo` empuja la anterior, `Backspace` la desanda.
**Por qué:** hoy `/find K9` es un billete de ida y el operador se pierde.
**Se ve:** un anillo del radar (A14) desde el punto al que vuelves.

### B3 · Modo foco (`Espacio` mantenido) — **S**
Mientras mantienes espacio, todo lo no seleccionado baja a 12 % de opacidad
—como uniform en el shader, no en CSS—, las tuberías ajenas desaparecen y el
HUD baja a 30 %. Al soltar vuelve en 120 ms (`--t-snap`).
**Por qué:** es la respuesta más barata a "cómo se ven 1.000 agentes".
**Depende de:** `field/swarm.ts` (un uniform `uDim`, exactamente el patrón de
`uReduce`), `field/pipes.ts` (que ya tiene `uFar`).

### B4 · Presets de flotilla y la ventana ALGN (`/launch <preset>`) — **M**
Un preset es `.orca/fleets/*.json`: N briefs con nombre. `/launch auditoría`
abre exactamente la ventana del video: N filas que entran flush, se abren en
**escalera** (A10) conforme cada agente reporta `booting`, y cuya **cremallera**
(A11) se llena del centro hacia fuera con el primer output de cada uno. Cuando
todas llenan, las filas se alinean y la ventana colapsa (A12) — y el campo tiene
cinco agentes nuevos.
**Por qué:** es el momento "impresionante", y es literalmente el gesto del comp
puesto a trabajar. **Depende de:** `windows/kinds/spawn.ts`, boot.ts:206-223.

### B5 · Escuadrones con nombre — **M**
Un lasso + `/squad recolección` crea un escuadrón persistente: contorno común
en el campo, una fila en la mast con nombre y conteo bloqueado, y
`@recolección …` habla con todos.
**Por qué:** "flotillas absurdas" sólo son manejables si se pueden nombrar.
**Depende de:** el mismo almacén que el `placement` (sobrevive a recargas).

### B6 · Trazo de escalación hasta el nodo YOU — **M**
Al abrir una interrupción se dibuja en el campo la cadena real: agente →
agentes represados detrás → un nodo **YOU** que crece con el tamaño de tu cola.
`store.ts:267` ya calcula `dammedBehind`.
**Por qué:** es la justificación visual de `UNBLOCKS n`, el número que decide
cuál contestas primero. **Se ve:** tubería ámbar gruesa con guiones viajando
hacia ti; el linaje de fondo queda como un pelo gris.

### B7 · Vista conversación (`doble-clic sobre una tubería`) — **M**
Abre una ventana `wire`: dos columnas, mensajes intercalados en Geist Mono, la
tubería resaltada y la cámara encuadrando a los dos agentes.
**Por qué:** "verlos comunicarse" hoy es un cuadrado que corre por un cable y
nada más. **Depende de:** hacer las tuberías clicables (`field/pipes.ts` no
tiene picking hoy).

### B8 · Galería de artefactos (`/gallery`) — **M**
Rejilla de quads reales —imágenes, primer frame de los videos, thumbnail de los
HTML— de toda la flota, ordenada por recencia. Arrastra uno al campo y queda
colocado junto a su agente.
**Por qué:** hace real la promesa de "que me enseñen cosas". `field/media.ts` ya
proyecta media al campo; falta el índice. **Se ve:** al soltar, el quad cae con
`back.out(2)` y su tubería al agente se dibuja creciendo (A8).

### B9 · Comparación lado a lado (`/vs K9 T3`) — **S/M**
Dos ventanas de agente pegadas que comparten scroll temporal: las líneas del
mismo minuto se alinean.
**Por qué:** la pregunta real no es "qué hizo K9" sino "por qué K9 sí y T3 no".

### B10 · Sonido del comp (`hud/sound.ts`, `S` para mutear) — **S**
Cinco tonos cortos sintetizados en WebAudio, sin ficheros: *tick* al encenderse
un tile, *clack* al colocar una ventana, *swell* al llegar una escalación
(ámbar), *thud* al morir un agente, *hiss* de la cortina en breach. Gain maestro
y **muteado por defecto** hasta que el operador lo enciende.
**Por qué:** el único evento que debe poder sonar sin que mires es `alarm`
(store.ts:30). **Depende de:** nada; ~80 líneas.

### B11 · Teclado tipo juego (WASD + Q/E + `G`) — **S**
WASD panea, Q/E hace dolly, Shift acelera ×3; todo en el loop de cámara con
amortiguación crítica, sin lag (el contrato exige que el paneo sea directo).
`G` abre un palette de callsigns con filtrado difuso.
**Depende de:** `field/camera.ts`, `main.ts:307-340` (ya hay F/O/C/Q/L/N/M/Tab).

### B12 · Modo cine (`Shift+P`) — **M**
**No orbita.** El commit `800107f` ya midió la tercera dimensión y la descartó,
y el contrato dice que la cámara mira al plano. El modo cine es un **dolly lento
encadenado**: vuelos de 8 s a los agentes con más tráfico, el HUD desaparece
salvo la mast, y cada salto lo anuncia la marquesina SIGNAL DETECTED (A16).
**Por qué:** para dejarlo puesto en una pantalla grande sin que sea un
salvapantallas.

### B13 · Línea de tiempo y replay — **L**
Una regleta de 1 px a lo ancho del campo (no un panel, no una barra de
herramientas): cada evento del feed es una marca. Arrastrar el cursor rebobina
el campo entero —estados, tuberías y posiciones— sin tocar el servidor.
**Depende de:** un ring buffer de patches en `store.ts` (hoy sólo guarda 500
líneas de feed, store.ts:131). Es la única pieza cara de esta lista.

### B14 · "Qué pasó mientras no estabas" — **M**
Al volver a la pestaña tras más de 2 min, **una** tarjeta docked —ámbar si hay
cola—: N escalaciones nuevas, M agentes terminados, X gastado, y un botón que
**reproduce esos minutos en 6 segundos** sobre el campo real, usando B13.
**Por qué:** convierte el replay en algo que se usa a diario.

### B15 · Resumen del CEO en la mast — **S/M**
Una sola línea en Tiny5 que el CEO reescribe cada 30 s: *"3 flotas trabajando ·
GL atascada en credenciales · $214/h"*. Es la **única** frase en prosa de toda
la consola. Click → abre la ventana CEO.
**Por qué:** el operador quiere una respuesta, no siete contadores.

---

## C. Pulido

**Coherencia del sistema (lo primero)**

1. Los cinco tokens de motion (styles/tokens.css:82-86) no se usan en ningún
   sitio. Cablearlos: `--t-snap` a los flips de estado, `--t-quick` a la llegada
   de ventana (`wm.ts:288` usa 0.22, que ya es casi `--t-quick`), `--t-move` a
   los rellenos. Y registrar los dos `cubic-bezier` como eases con nombre en
   GSAP para que los tres motores hablen el mismo idioma.
2. El *breathing* del shader corre a `2.856 rad/s` (field/swarm.ts:77), la
   alarma a 0.9 s (hud/alarm.ts:29), la banda a 1.4 s (window.css:187). Tres
   ritmos que no riman. Derivarlos todos del mismo período base.
3. Los hexes de estado viven duplicados en tres sitios: `tokens.css:66-72`,
   `util.ts:22-30` y `hud/minimap.ts:23-26` — y el tercero **no coincide**:
   `minimap.ts:25` usa `idle #4a4e48` y `done #2f3238` contra `--st-idle
   #6e736c` y `--st-done #4a4e48`. Un agente `idle` en el minimapa es del color
   de un agente `done` en el campo. Bug de color, arreglo de una línea.
4. El canal de estado de 2 px es la rima formal más fuerte del sistema — está en
   el shader del tile (swarm.ts:87-88), en el borde de la ventana
   (window.css:34-38), en la fila de agente (:223) y en el tether (wm.ts:214).
   Extenderlo también a las filas del feed y de la cola: si algo tiene estado,
   lleva el canal.

**Mast y jerarquía**

5. La mast pone siete gauges con el mismo peso (a1-overview). `NEED YOU` ya gana
   borde y glow cuando hay cuenta (hud.css:50), pero **no gana tamaño**:
   debe ir al doble y los otros seis bajar a `--ink-dimmer`.
6. Ocultar los gauges en cero: `0 DEAD` en gris ocupa el mismo espacio que
   `473 NEED YOU`.
7. `SPEND` y `TOK/S` deben ir en Geist Mono, no en Tiny5: son cifras que se
   leen, no etiquetas que se reconocen (`DESIGN.md`, sección Type).
8. `.px--tiny` a 10 px con `0.16em` sobre `--ink-dim` (tokens.css:137) no se lee
   en la mast: 11 px y `--ink-mid` sólo ahí.

**El ámbar**

9. En a3-agent el ámbar cubre ~60 % de la pantalla. Si más del 30 % de la flota
   es ámbar, el ámbar deja de significar algo. Propuesta: glow ámbar sólo para
   las escalaciones en cola visible (las 6 abiertas + las N más antiguas); el
   resto en ámbar apagado, borde sin bloom.
10. Limitar el bloom del shader (field/swarm.ts:101-108) a los N tiles ámbar más
    recientes: 200 tiles ámbar con `exp(-dist·6.5)·0.55` hacen una mancha, no
    una alerta.
11. El predicado `blocked && kind !== 'peer'` está repetido literalmente en ocho
    archivos (field.ts:568, layout.ts:66, labels.ts:70, mast.ts:29,
    minimap.ts:85, util.ts:34, queue.ts:26…). Es el invariante mejor mantenido
    del código y merece ser **una función con nombre** (`needsHuman(a)`), para
    que nadie lo rompa por descuido en el noveno sitio.

**Zoom y densidad**

12. A zoom bajo (a1-overview) un proyecto son 60 tiles de 4 px que sólo hacen
    ruido de tres colores. Por debajo de cierto zoom, un proyecto debe colapsar
    a **un tile grande con el conteo dentro**, como el deck del video (f_046).
    Hoy sólo se desvanece la etiqueta (field.ts:240-241), no los tiles.
13. `pipes.ts:100` fija `uMinPx 1.2` para que un pipe nunca desaparezca al alejar
    la cámara. Es una buena regla que se rompe por volumen: con más de ~400
    agentes visibles hay que bajar `uMinPx` a 0 para las tuberías de linaje y
    dejar visibles sólo `ask`, `collision` y `hot` — las que el ojo sigue.
14. `field.ts:79` fija `LABEL_PX = 44` y `labels.ts:60` ya tiene tres tiers
    (190 / 112 / resto). El escalón que falta no es de contenido sino de
    **rango**: entre 44 y 112 px sólo se ve el callsign, y a 44 px Tiny5 con
    `0.14em` ya no se lee. Subir el umbral a ~60 px y ganar los frames.
15. El ground (field/ground.ts:17-20) casi no se ve en a1-overview. Subirlo a la
    densidad y opacidad de la retícula del radar del boot (f_101): es lo único
    que hace que el paneo se sienta como movimiento.

**Ventanas**

16. El header mete seis elementos en 30 px (`+M29 GL Fix flaky auth… PIN — ×`,
    window.css:49-78). `PIN` debe ser una chincheta de píxeles, no una palabra.
17. Las ventanas se apilan tapándose los botones: en b2-artifact `SÍ, BÓRRALA`
    queda cortado. La cascada de 24 px (wm.ts:258-260) no basta cuando hay seis
    interrupciones abiertas: hace falta `Cmd+~` para ciclar y un "ordenar" que
    las reparta.
18. `INTERRUPT` en el pie repite el kind que ya está en el header
    (a2-project-gl). Quitarlo y dejar sólo el stamp hex.
19. En la ventana de interrupción, `CEO TRIED` debe venir plegado por defecto:
    de los cinco bloques es el que menos decide.
20. La barra de scroll del FEED (a6-docked) es la nativa: 4 px, sin flechas,
    `--line`.
21. En el feed, `escaló:` va en rojo pero pesa lo mismo que `terminó`. Darle
    además el canal de estado del punto 4.

**Estados e interacción**

22. No hay estado hover en los tiles del campo. Un tile bajo el cursor debe
    subir un punto de brillo y sacar su etiqueta aunque esté por debajo del
    umbral de legibilidad. El cursor ya sabe que está sobre algo vivo
    (hud/cursor.ts:32, `setTarget` desde main.ts:103); el tile no.
23. No hay anillo de foco visible en los botones (`SEND` lima, a6-docked). Con
    teclado no se sabe dónde estás: `outline: 2px solid var(--lime);
    outline-offset: 2px` en todo lo interactivo.
24. Cada cambio de estado necesita un flash de `--t-snap`. `hud/alarm.ts:25-26`
    ya coalesce los bloqueos a 600 ms — la misma disciplina para los flips: diez
    tiles que cambian a la vez son **un** beat (A7), no diez animaciones.
25. El cursor de 8 px en `difference` (tokens.css:194-204) desaparece sobre los
    tiles ámbar: añadirle un contorno de 1 px del color inverso.

**Texto y accesibilidad**

26. El placeholder del command line dice cuatro cosas en una línea
    ("talk to the ceo · @K9 to an agent · @LZ to a project · / for commands").
    Una sola frase, o ninguna: `/` ya abre el menú con las once ayudas
    (command.ts:25-37).
27. `prefers-reduced-motion` sólo oculta las scanlines en tokens.css:353-355;
    window.css:294 mata los tres `@keyframes` y alarm.ts:21 la alarma. Falta
    cubrir explícitamente la cortina de breach (A18) y la marquesina infinita de
    `misc.ts:22` (`repeat: -1`), que son las dos únicas cosas que pueden marear.
28. `spawn.ts:16-20` muestra `codex` y `grok` apagados a propósito. Bien — pero
    un runtime apagado necesita decir *por qué* al pasar el ratón, o se lee como
    un bug.

---

## D. Top 10 para aprobar

1. **Cablear los tokens de motion** — los cinco están declarados y ninguno se
   usa; hasta que signifiquen algo en GSAP, CSS y shader, todo lo demás se
   sentirá de máquinas distintas. Media tarde. (S)
2. **Modo foco con espacio** — todo lo no seleccionado baja a 12 % en el shader;
   resuelve "cómo se ven 1.000 agentes" con un uniform. (S)
3. **Latido de la flota** — los tiles que cambian de estado dan un flash de
   120 ms **en golpe**, como los beats 4-2-3-5-2-6 del video; la consola deja de
   parecer una foto. (S)
4. **Barrido lima al contestar + check de píxeles al cerrar** — la
   microinteracción que verás cien veces al día, ya escrita en boot.ts:167-175. (S)
5. **Disciplina del ámbar** — glow sólo para las escalaciones en cola visible;
   recupera el significado del color que el contrato más protege. (S)
6. **Marcadores de cámara + volver con Backspace** — navegar deja de ser un
   billete de ida. (S)
7. **Sonido del comp** — cinco tonos WebAudio, muteados por defecto, uno por
   evento. No existe ni una línea de audio en el proyecto. (S)
8. **Presets de flotilla con la ventana ALGN** — escalera y cremallera reales,
   guiadas por los agentes que arrancan: el momento impresionante. (M)
9. **Trazo de escalación hasta el nodo YOU** — dibuja la cadena represada
   (`store.ts:267`) y justifica visualmente `UNBLOCKS n`. (M)
10. **Galería de artefactos arrastrable al campo** — hace real "que me enseñen
    cosas". (M)

*Fuera del top por coste, no por valor:* la línea de tiempo con replay y "qué
pasó mientras no estabas" (B13 + B14, **L**) — es la única pieza cara que vale
lo que cuesta, pero pide un ring buffer de patches que hoy no existe.
