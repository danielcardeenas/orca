# ORCA — identidad de agentes y escuadrones en el campo

Diseño, 2026-09-05, a partir de dos capturas del campo real (una región de 33
tiles y un tile ampliado a tier 5) y de los frames del comp `offworld.mp4`
entre 7,5 s y 12 s (el árbol de tuberías NULL→ACTIVE y la rejilla de tiles).
Cada sección fija una decisión. El reparto de archivos al final es el contrato
entre agentes.

**La tesis.** Hoy un agente es un rectángulo con muesca y una franja de color;
un escuadrón es una palabra flotando sobre un bloque sin borde; una relación
es una tubería lima que cruza por encima de lo que sea. Las tres cosas usan la
misma lima, así que el ojo no distingue *estructura* (quién es de quién) de
*actividad* (quién está trabajando). El comp sí lo distingue: la estructura es
gris y lleva la lima *por dentro*; el tile encendido es el único bloque lima
sólido; y ningún cable cruza un tile. El diseño de abajo reparte esos tres
papeles y le da a cada agente y a cada escuadrón una marca que sobrevive al
zoom.

---

## 0. Lo que las capturas muestran roto (arreglar antes de diseñar encima)

| # | Síntoma en la captura | Causa | Arreglo |
|---|---|---|---|
| 0.1 | La tubería lima pasa **por encima** del texto del tile LL y de la fila B1…2T | `createSwarm` se llama antes que `createPipes` (`field.ts:186-187`); ambos materiales son `transparent` sin `depthWrite`, y Three ordena objetos transparentes en la misma posición por orden de inserción | `mesh.renderOrder = -1` para bus, núcleo y puertos en `pipes.ts`; pulsos a `+1`. El z ya es menor que el de los tiles; sólo falta que el orden lo respete |
| 0.2 | Las tuberías cruzan filas enteras de tiles (bus horizontal a media altura de B1…2T) | `routeLineage` dobla en `midY` entre padre e hijo; con dos filas de distancia el codo cae sobre la fila intermedia | Enrutado por **cunetas** (§4.1). Ninguna tubería toca un tile |
| 0.3 | `$0.00` y `LL` arrancan debajo de la franja de estado | La franja mide `max(4.5 %, 2.5 px)` del tile; `--pad-x` mide `4px·u` ≈ 1,6 % | Las tres bandas arrancan en `left: 7%` (§2.1) |
| 0.4 | `UPTIME  TURNS` queda bajo la banda azul que corre | La banda del shader ocupa el 7–10 % inferior; la banda DOM inferior llega a `bottom: 0` | `.lbl__bot { bottom: 11% }` (§2.1) |
| 0.5 | `Inventory OR…` y `I have a co…` cortados a once caracteres | Las dos líneas viven en la banda media, limitada al 66 % por la muesca | La línea NOW baja a la banda inferior, que es de ancho completo; misión a dos líneas (§2.2) |
| 0.6 | `axolots-25` como título | Es el título de sesión de Claude Code y repite el proyecto | Regla: si el título empieza por el nombre del proyecto, se descarta y la misión sube (§2.2) |
| 0.7 | Un `□` suelto bajo la línea NOW | Un emoji en `lastSay` que ni Geist Mono ni Tiny5 tienen | `lbl.ts` filtra `\p{Extended_Pictographic}` y variation selectors antes de pintar |

Estos siete son mecánicos y no admiten opinión; van primero porque cualquier
foto del diseño nuevo saldría mal con ellos dentro.

---

## 1. El agente: una marca que no es texto

### 1.1 El sigilo

**Decisión.** Cada tile lleva un **sigilo**: un glifo de píxeles 5×5,
simétrico en X, en la esquina superior derecha del tile (x 0,80–0,955 ·
y 0,775–0,93, libre de la muesca que va de y 0,30 a 0,70). Quince bits
deciden el dibujo. Es la marca que identifica a un agente cuando el tile mide
60 px y no cabe ni el callsign, y es la misma marca que verá en la cabecera de
su ventana.

**De dónde salen los bits.** Del hash FNV de una *semilla*:

- agente suelto → `agent.id`;
- miembro de un escuadrón → **el nombre del escuadrón**, no su id. Así cinco
  miembros llevan el mismo parche en el hombro y el bloque se lee como un
  cuerpo aun antes de ver el contorno;
- el líder lleva el **sigilo invertido**: un bloque de tinta con el glifo
  recortado en color de cuerpo. Sustituye al cuadrado relleno de hoy
  (`swarm.ts`, `mark`), que decía "líder" pero no de qué.

**Técnica.** Un atributo por instancia `iSigil` (float; quince bits caben
exactos en la mantisa). En el fragment, para la celda `(cx, cy)` del glifo
con `cx' = min(cx, 4 − cx)`, el bit es
`mod(floor(iSigil / exp2(cy·3 + cx')), 2)`. Coste: una multiplicación y dos
`floor` por píxel dentro de una región de 0,15×0,15 del tile. Cero CPU. El
mismo `sigilBits(seed)` vive en `gfx/sigil.ts` y también renderiza el glifo a
DOM (`<i class="sigil">` con 25 `box-shadow`) para la cabecera de ventana y el
rótulo de escuadrón.

**Color.** Tinta (`uInk`) sobre cuerpo oscuro; cuerpo (`uBody`) sobre tile
ámbar pleno. Nunca el color de estado: el sigilo dice *quién*, la franja dice
*cómo está*.

### 1.2 El runtime, en la franja

**Decisión.** La franja de estado del borde izquierdo lleva la **textura del
runtime**: continua para Claude, a trazos 2:1 para Codex, a puntos 1:1 para
Grok, continua fina para cualquier otro. Es la única señal de runtime que
sobrevive a todos los zooms; el chip `.lbl__rt` sigue diciéndolo en letras
cuando cabe. La forma del tile no cambia por runtime: las bandas del texto
están construidas alrededor de *esta* muesca y una muesca distinta por CLI las
rompería.

**Técnica.** `iAux` pasa de `vec3` a `vec4`; `.w` es el id de runtime
(0 claude, 1 codex, 2 grok, 3 otro). El patrón se calcula en `t.y` con
`fract(t.y · 10)`, en unidades del tile, para que un tile grande no muestre
cien trazos.

### 1.3 CAPCOM

Uno solo por flota y siempre importa: su tile lleva el contorno lima a 1 px
**permanente** (hoy sólo la selección lo tiene) y el sigilo es la `C` de
`gfx/logo.ts` en vez de un hash. No hay más excepciones por rol.

---

## 2. El texto dentro del tile

### 2.1 Las bandas

Las tres bandas se quedan; cambian sus bordes y su reparto.

```
 ┌─────────────────────────────────────┐
 │▌ top  0–30 %   x 7–94 %   LL  AX ·CX │▒▒▒│  ← sigilo en 80–95 %
 │▌ mid 31–68 %   x 7–66 %          ▐████│  ← muesca 70–100 %
 │▌                                  ▐████│
 │▌ bot 69–89 %   x 7–96 %  NOW ─────────│
 │▌               $  TOK/S  UP  TURNS  [PILL]│
 │▌ (banda del shader, 0–10 %)            │
 └─────────────────────────────────────┘
```

- `left: 7%` en las tres: la franja mide 4,5 % y necesita aire.
- `bot` termina en `bottom: 11%`: por debajo corre la banda de velocidad.
- La **píldora de estado** deja la esquina superior derecha (ahora es del
  sigilo) y se pone al final de la fila de métricas, alineada a la derecha.
  Es donde el comp pone `OFFLINE` en la tarjeta DEEP-SPACE RADAR ARRAY: bajo
  el título, no sobre él.

### 2.2 Qué va en cada banda, y la escalera

| Tier | ancho px | top | mid | bot |
|---|---|---|---|---|
| 1 | ≥ 44 | callsign · proyecto | — | — |
| 2 | ≥ 112 | + chip runtime | título **o** misión, 2 líneas | — |
| 3 | ≥ 190 | | | **NOW**, 1 línea, ancho completo |
| 4 | ≥ 320 | | título 1 línea + misión 2 líneas | NOW + métricas |
| 5 | ≥ 520 | + `RUNTIME · MODEL · MACHINE` | | + píldora |

Reglas nuevas:

- **NOW vive abajo.** Es la línea que más cambia y la que más se cortaba en el
  66 %. Abajo tiene el 89 % del tile y una sola línea.
- **La misión gana dos líneas** (`-webkit-line-clamp: 2`). Es la frase que
  explica por qué existe el agente; once caracteres no explican nada.
- **Título repetido, título fuera.** Si `title` empieza por el nombre o el
  código del proyecto (caso `axolots-25`), no se pinta y la misión ocupa su
  sitio. Si no hay misión, se pinta el título aunque repita: mejor un dato
  redundante que un hueco.
- **Métricas honestas, columnas fijas.** Las cuatro columnas no se mueven
  para que el ojo las encuentre; un valor sin sentido en el estado actual
  (TOK/S en idle) se pinta `—` en `--ink-faint`, no `0`.
- **Sin tofu.** Emojis y variation selectors se filtran del texto que llega
  del agente antes de pintarlo.

Nada de esto cambia el sistema de unidad `--u` ni la regla de que sólo el
cruce de un peldaño reescribe el interior.

---

## 3. El escuadrón: un tile de tiles

### 3.1 Contorno con muesca

**Decisión.** Un escuadrón tiene contorno: la línea de 1 px de `--line`
(un paso más clara que la de región, que es `--line-soft`) alrededor del
bloque de celdas de sus miembros, con la **misma muesca del tile** —
escalón fijo de 0,50 × 0,30 unidades en la esquina superior derecha, no
proporcional, porque un bloque ancho con una muesca proporcional parecería
otra cosa. El escuadrón es un tile hecho de tiles y se dibuja como tal.

El rótulo se apoya **sobre la línea superior**, a 0,3 unidades de la esquina
izquierda, con fondo `--bezel`, como la leyenda de un `fieldset`: la línea
pasa por debajo y el rótulo la interrumpe. Bajo foco, el contorno entero se
enciende cuando cualquier miembro está en la selección (`focusNear` incluye a
los compañeros de escuadrón).

**Técnica.** `pipes.add()` con la polilínea del contorno (nueve puntos, con
el escalón), `thick 0.4`, `kind 'lineage'`, z −0,38 (encima de la región, bajo
los tiles). Cuando el escuadrón aparece por primera vez, el contorno **se
traza** desde la esquina del líder en sentido horario en `T.move` usando el
mismo núcleo con relleno de §4.2 (`fill` 0→1). Sin fade.

### 3.2 El rótulo y su escalera

El rótulo deja de ser dos palabras y pasa a tener tres estados según
`pxPerUnit`:

| ppu | Qué muestra |
|---|---|
| < 40 (tiles ilegibles) | **sigilo** del escuadrón + **roster** |
| 40–120 | sigilo + nombre + `n` + roster |
| ≥ 120 | + `LEAD K9` + la misión del líder en una línea (máx. 48 car.) + `2 NEED YOU` en ámbar si aplica |

**El roster** es la pieza nueva: un cuadrado de 6×6 px por miembro, gap 2 px,
en el orden de `Squad.memberIds` (líder primero, con marco de 1 px de tinta),
cada uno del color de estado del miembro. Es el pulso del escuadrón a cualquier
zoom: cuando los tiles son motas, el roster sigue diciendo "cinco trabajando,
uno esperando por ti". Cambia por **corte**, con el mismo latido del tile: el
cuadrado que cambia salta a `--ink-bright` un frame y cae a su color en
`T.snap`. Tope 32 cuadrados (`MAX_SQUAD_NAME` ya limita el nombre; el roster
limita el ancho).

### 3.3 El puerto del escuadrón

Sobre la línea superior, a 0,15 unidades de la esquina izquierda y antes del
rótulo, un **puerto cuadrado** (`pipes.port`, escala 1,3, `--ink-dim`). Es el
punto donde aterriza un mensaje `toSquad` (hoy `squadAnchor` ya devuelve esa
esquina) y desde donde sale el **abanico** (§5.3). Se enciende a tinta
mientras haya un mensaje en vuelo hacia él y vuelve a `--ink-dim`.

### 3.4 Lo que no cambia

El empaquetado (`squadOrder`, `packCells`) ya hace bloques contiguos con el
líder en la primera celda; la etiqueta ya no se oculta nunca; el hub ya enruta
`scope:'squad'`. El diseño se apoya en eso y no lo toca.

---

## 4. Tuberías con sentido

### 4.1 Cunetas

**Decisión.** Toda tubería vive en las **cunetas** de la rejilla — los
`GAP_Y` entre filas y `GAP_X` entre columnas — y entra a un tile sólo por
un puerto en su borde. Ruta padre→hijo:

1. sale por el puerto inferior del padre (`x = P.x − 0,32`);
2. baja a la cuneta horizontal bajo el padre (`y = P.y − TILE_H/2 − GAP_Y/2`);
3. corre hasta la cuneta vertical **a la izquierda de la columna del hijo**
   (`x = C.x − TILE_W/2 − GAP_X/2`);
4. baja por ella hasta la cuneta sobre el hijo;
5. entra al hijo por su puerto superior (`x = C.x − 0,32`).

Seis puntos; dos si el hijo está justo debajo. Un hijo en la **misma fila**
entra por abajo (baja, corre por la cuneta inferior, sube). Mensajes entre
pares usan la misma rejilla: salen por un lado a la cuneta vertical, corren por
una horizontal, entran por un lado. Un tile **anclado por el operador** ha roto
la rejilla a propósito: para él se conserva `routeLineage`/`routeMessage`
actuales.

**Carriles.** Una cuneta de 0,26 admite tres tuberías de 0,055 a
`−0,075 · 0 · +0,075`. El carril se asigna por `hash(parentId) % 3`
(mensajes: `hash(fromId)`), así los hijos de un padre comparten bus y dos
familias en la misma cuneta no se pisan. Los cruces siguen existiendo; lo que
ya no existe es una tubería sobre un tile.

El enrutador toma `gapX/gapY` del `Layout` (campo o deck tienen gaps distintos)
en vez de constantes; `layout.ts` los expone.

### 4.2 Bus gris, núcleo lima

**Decisión.** El linaje se dibuja como en el comp: un **bus** gris
(`C_LINE`, `thick 1.0`) y, por dentro, un **núcleo** (`thick 0.42`) que lleva
la lima. El bus es estructura: existe desde que existe el hijo y no cambia. El
núcleo es vida: lima plena si el hijo está `working`, lima al 55 % en
`thinking/booting/idle`, **ausente** en `done/dead`. La lima deja de
significar "hay una tubería" y vuelve a significar "hay actividad", que es lo
que significa en el tile.

El lazo líder→miembro que hoy se pinta igual que el linaje se pinta igual
también aquí; es la misma clase de lazo.

**Técnica.** Nuevo `PipeKind 'core'` (id 5). Para él, `iMeta.y` deja de ser
edad y es la **longitud llena** en unidades de mundo; el fragment pinta
`vAlong < iMeta.y`. `add()` devuelve la longitud total de la ruta para que
quien llama pueda pasar `fill · len`. `fill` es un escalar animado (§5).

### 4.3 Puertos NULL / ACTV

Los puertos son las cajas `NULL`/`ACTIVE` del comp sin la palabra: **rellenos
de tinta** cuando el núcleo los alcanza, **huecos** (anillo) cuando no. Un hijo
recién creado tiene su puerto hueco en su celda antes de tener tile.

**Técnica.** Segunda malla instanciada `holes` de cuadrados en `uBody` a
escala 0,5 encima del puerto; `port(x, y, z, color, scale, sel, hollow)`.

### 4.4 Jerarquía de pesos y colores

| Relación | Color | Grosor | Movimiento |
|---|---|---|---|
| Región (contorno) | `--line-soft` | 0,4 | — |
| Escuadrón (contorno) | `--line` | 0,4 | se traza al nacer |
| Linaje, bus | `C_LINE` | 1,0 | — |
| Linaje, núcleo | lima / lima 55 % | 0,42 | crece al nacer, drena al morir |
| Lazo líder→miembro | igual que linaje | 0,8 / 0,35 | igual |
| `ask` abierto | ámbar | 1,0 | guión hacia quien debe |
| Espera entre pares | azul | 1,0 | guión hacia quien debe |
| `notice` | azul | 0,7 | se apaga en 60 s |
| Colisión | rojo | 1,0 | punteado, **quieto** |
| Hot (selección) | lima plena | 1,2 | — |

El ámbar sigue reservado a lo que sólo una persona puede resolver
(PLAN.md §5); nada aquí lo toca.

---

## 5. Movimiento: GSAP para lo discreto, shader para lo continuo

**Arquitectura.** Hoy el campo anima con un `anims` propio y `backOut` a mano.
Pasa a `field/anim.ts`: un registro de escalares `{ v }` tweenados por GSAP
con `T`/`EASE`/`dur()` de `motion.ts`, leídos por el RAF (`anim.get('core:'+id)`).
El shader conserva lo que no tiene fin (respiración, banda de velocidad,
guiones); GSAP toma lo que tiene principio y fin. Los tres motores siguen
leyendo un solo contrato.

### 5.1 Nacer (A8 del comp)

Hoy el tile aparece sobre el padre y se desliza a su celda con la tubería ya
puesta. Pasa a ser el gesto del comp:

1. la celda del hijo muestra su **puerto hueco** en el mismo frame del patch;
2. el **bus** aparece entero (gris, corte);
3. el **núcleo** crece del puerto del padre al del hijo en `T.move`,
   `EASE.inout`;
4. al llegar, el puerto se rellena y el **tile entra** con `back.out(2)` en
   `T.quick`, ya en su celda.

Un escuadrón nace así en cadena: el líder crece de su padre; cada miembro
crece del líder con los offsets de `beats(n)` que hoy ya calcula
`burstOffset`. Con cinco miembros son cuatro núcleos a 100 ms, medio segundo
de nada, y el quinto. Con `prefers-reduced-motion`, todo aterriza en el
estado final.

### 5.2 Morir y terminar

`dead`: el tile destella rojo una vez y se hunde (ya existe); el **núcleo
drena** hacia el padre en `T.move` y el puerto del hijo queda hueco. `done`:
igual sin el destello. El bus se queda: el hijo existió.

### 5.3 Hablar

- **Mensaje a un agente.** El pulso deja de ser un cuadrado a velocidad
  constante: es un **segmento** lima de 0,35 unidades que recorre la ruta con
  `EASE.inout` (duración `len / 9`, mín. `T.quick`) y deja una estela que se
  apaga en 0,6 s. Corte al llegar.
- **Mensaje a un escuadrón.** El pulso llega al **puerto del escuadrón**
  (§3.3), el puerto se enciende, y desde ahí salen `n` pulsos a los puertos
  superiores de los miembros con offsets `beats(n)`: el **abanico**. Es la
  imagen de "le hablé a la flotilla".
- **Respuesta a un `ask`.** Cuando `m.answer` aparece: la tubería ámbar
  **corta a lima plena un frame** y drena desde quien preguntó hacia quien
  respondió en `T.quick`; luego no existe. Nunca un fade.

### 5.4 El roster

Cada cuadrado que cambia de estado salta a `--ink-bright` y cae a su color en
`T.snap`, en el mismo frame que el tile hace su flash. Es el mismo latido a
otra escala.

---

## 6. Microanimaciones: cada interacción tiene un gesto

**Regla.** Toda interacción del operador produce un gesto, y todo gesto sale
del vocabulario del comp (IDEAS.md §A). Duraciones sólo de `T`; easings sólo
de `EASE`; las paletas cortan, las formas easean; el rojo no se anima; nada
llega a ritmo constante; con `prefers-reduced-motion` todo aterriza en el
estado final vía `dur()`. Un gesto que no cabe en una fila de esta tabla no se
implementa.

### 6.1 Ventanas

| Momento | Gesto | Tiempo |
|---|---|---|
| **Abrir** | El housing llega desde el punto que la abrió (tile, tray, comando) con `back.out(2)`, escala 0,86→1, **sin fade** (hoy hay `opacity 0→1`; fuera). En el mismo frame la tubería de anclaje al tile **se traza** del tile a la ventana (núcleo §4.2, `fill` 0→1). El callsign de la cabecera **se ensambla** de píxeles (A2): 3 frames de glifos revueltos y corta al real. Las secciones del cuerpo **caen en cascada** (A1): cada `.sec` aparece por corte, offsets `beats(n)` comprimidos a 40 ms por paso | housing `T.quick` · tubería `T.quick` · callsign 0,18 s · cascada ≤ 0,3 s |
| **Cerrar (normal)** | Colapso corto (A12): el cuerpo cae bajo el borde, el housing se aplana a una barra de 2 px y corta. La tubería de anclaje **drena** hacia el tile a la vez | `T.quick`, `EASE.inout` |
| **Cerrar (contestado / terminado / muerto)** | Ya existen: `wipe` lima, `check` píxel a píxel, y para `dead` corte a rojo y colapso sin destello | sin cambio |
| **Foco** | La línea bajo la cabecera (`.win__head::after`) **crece de izquierda a derecha**; al perder el foco, corte | `T.snap` |
| **Plegar al tray** | El housing vuela hacia su tile del tray (escala hasta 58×44, `EASE.inout`) y corta; el tile del tray **entra** con `back.out(2)` desde escala 0,6 | `T.quick` + `T.snap` |
| **Desplegar** | Inverso: el tile del tray se aplana a barra y la ventana llega desde él | `T.quick` |
| **PIN** | El botón corta a lima; la tubería de anclaje se traza (pin) o drena (unpin) | `T.quick` |
| **Arrastrar / redimensionar** | Directo, sin tween: un chrome que retrasa la mano se siente roto. La tubería de anclaje sigue en cada frame (ya) | — |
| **Telemetría hex** | Se revuelve a 70 ms **sólo mientras su agente está `working`** (A9); congelada en cualquier otro estado | 70 ms |
| **Estado del agente cambia** | La cabecera hace el mismo flash que el tile: salta a `--ink-bright` un frame y cae al color de estado | `T.snap` |

### 6.2 Controles

| Control | Gesto |
|---|---|
| `.btn` hover | Corte a lima (ya). Sin transición |
| `.btn` press | `translate(1px, 1px)` mientras está pulsado; corte |
| `.slab-btn` (lima) al confirmar | Invierte a tinta un frame y vuelve (`T.snap`): el destello local del comp. Si la acción tarda (spawn, launch), la banda de carga fina (A3) corre por el borde inferior del slab hasta el ack |
| `kbd` | **Eco de teclado**: cuando el atajo se pulsa, su `kbd` visible corta a lima y cae en `T.snap`. Aplica a mast, ventanas, tray, bookmarks |
| `pick` abrir | Llega con `back.out` (ya); las filas **caen en cascada** a 20 ms por corte |
| `pick` elegir | La fila elegida salta a tinta un frame y cae a lima; el menú corta |
| `toggle` | Corte (ya) + la banda fina corre una vez por el tile de 11 px en 120 ms |
| `fold` | `+`→`−` corte; cuerpo corta (ya). Sin cambio |
| Inputs | Nativos. Caret intacto |

### 6.3 HUD

| Pieza | Gesto |
|---|---|
| Línea de comandos: cambio de destino | El chip (`CAPCOM` → `@K9`) corta al nuevo color y hace un flash de tinta de un frame. `UNKNOWN` en rojo **no se anima** |
| Línea de comandos: enviar | El texto se **barre en lima** de izquierda a derecha (A5 a escala de línea, `T.quick`) y se vacía por corte. El pulso en el campo (§5.3) arranca en el mismo frame |
| Menú `/` | Filas en cascada a 30 ms; la selección se mueve por corte |
| Tray: tile nuevo | Llega con `back.out(2)` desde la ventana que lo originó, escala 0,6→1 |
| Tray: tile que se va | Se aplana a barra y corta (A12 corto) |
| Tray: modo `` ` `` | La fila **sube 4 px** en `T.snap` (la forma easea); el borde lima corta. Salir: inverso |
| Mast: contadores | Un número que cambia hace 3 frames de revuelto (A9) y aterriza. `NEED YOU` subiendo: corte a ámbar + el anillo de `alarm.ts` (ya) |
| Bookmarks: guardar | La casilla corta a lima con un frame de tinta antes |
| Minimapa | Construcción del eje (A13) al abrir y anillo por `patch` (A14); ya están en PLAN.md, sin cambio |
| Cursor | Clic: el cuadrado de 8 px baja a 4 px y vuelve en `T.snap`. Sobre un objetivo bloqueado (tile ámbar, ventana `is-blocked`) la retícula corta a ámbar |
| Región: hover | Borde corta a `--line` (ya). Clic: vuelo de cámara (ya) |

### 6.4 Campo

| Momento | Gesto |
|---|---|
| Selección de tile | La línea lima corta (ya) y aparecen **cuatro esquinas** de 6 px alrededor de la etiqueta DOM (`.lbl.is-sel::before/::after` + dos `<i>`), por corte. Deselección: corte |
| Subir de peldaño | Cuando el zoom cruza un `TIER_PX` hacia arriba, los elementos nuevos del interior caen en cascada a 30 ms. Bajar: corte |
| Lasso | Rectángulo de 1 px lima a trazos mientras se arrastra (ya); al soltar, los tiles capturados hacen el flash del latido en el mismo frame |
| Nacer / morir / hablar / responder | §5 |

---

## 7. Reparto de archivos

Seis columnas, disjuntas. Nadie edita fuera de la suya; lo que necesite de
otra columna lo consume por la firma escrita aquí.

| Col. | Archivos | Qué |
|---|---|---|
| **A** | `src/ui/gfx/sigil.ts` (nuevo) · `src/ui/field/swarm.ts` | `sigilBits(seed): number` (15 bits, FNV-1a), `sigilHTML(bits: number, inverted?: boolean): string` (un `<i class="sigil">` con 25 `box-shadow`, 1 unidad = `1em/5`), `CAPCOM_BITS`. En swarm: `iSigil`, `iAux` → vec4 (`.w` runtime id), decodificado del sigilo, líder invertido, textura de franja por runtime, contorno lima permanente cuando `iAux.w == 9` (CAPCOM); borrar `mark`. `write()` gana `sigil: number, runtime: number` al final |
| **B** | `src/ui/field/labels.ts` · `src/ui/styles/field.css` | §0.3–0.7, §2, §6.4 (esquinas de selección, cascada al subir de peldaño). CSS de `.sigil` y de `.squad`/`.roster` **no**: viven en `styles/squad.css` (D) y `styles/sigil.css` (A, importado desde `main.ts` por Fable) |
| **C** | `src/ui/field/pipes.ts` · `src/ui/field/layout.ts` · `test/motion.test.ts` | `renderOrder` (−1 bus/núcleo/puertos, +1 pulsos); `PipeKind 'core'` (id 5, `iMeta.y` = longitud llena); `add(...)` devuelve `number` (longitud total); `port(x, y, z, color, scale?, sel?, hollow?)`; `routeGutter(P, C, gaps: {x: number; y: number}, lane: -1|0|1): Pt[]` y `routeGutterMsg(A, B, gaps, lane)`; `pulse()` como segmento con estela (§5.3). `Layout.gapX/gapY`. Test de propiedad: en rejilla 6×4 sintética ninguna ruta interseca ningún rectángulo de tile |
| **D** | `src/ui/field/field.ts` · `src/ui/field/anim.ts` (nuevo) · `src/ui/styles/squad.css` (nuevo) · `test/visual.ts` | `anim.ts`: `grow(key, {to, dur, ease})`, `drain(key, ...)`, `get(key): number`, `has`, `kill(key)`, `sweep(liveKeys)`. En field: contorno + puerto + rótulo con roster (§3), `buildPipes` bus/núcleo/carriles (§4), nacer/morir/hablar/abanico/respuesta (§5), lasso-flash (§6.4); sustituir `anims`/`backOut`. Escenas visuales nuevas |
| **E** | `src/ui/windows/wm.ts` · `src/ui/windows/fx.ts` · `src/ui/windows/kinds/*.ts` · `src/ui/styles/window.css` | §6.1 completo y §6.2 para `.btn`/`.slab-btn`/`kbd` dentro de ventanas. Sigilo junto al callsign en `chrome()` consumiendo `sigilHTML` de `gfx/sigil.ts` (firma arriba; si A no ha aterrizado, un stub local con la misma firma que se borra al integrar) |
| **F** | `src/ui/controls.ts` · `src/ui/hud/*.ts` · `src/ui/styles/hud.css` | §6.2 (`pick`, `toggle`, eco de `kbd` en la mast) y §6.3 completo |
| **Fable** | `src/ui/main.ts` · `DESIGN.md` · integración | Imports de `sigil.css`/`squad.css`; reescribir **Tiles**, **Pipes**, añadir **Squads** y **Micro-interactions** en el contrato; `npm run typecheck`, `npm test`, `npm run visual` al final |

Firmas que cruzan columnas, fijadas aquí para que nadie espere a nadie:

```ts
// gfx/sigil.ts (A) — la consumen E y D
export function sigilBits(seed: string): number;          // 0 … 2^15−1
export function sigilHTML(bits: number, inverted?: boolean): string;
export const CAPCOM_BITS: number;

// field/pipes.ts (C) — la consume D
add(points, z, color, kind, age, thick?, sel?): number;   // longitud total
port(x, y, z, color, scale?, sel?, hollow?): void;
routeGutter(P: Pt, C: Pt, gaps: {x: number; y: number}, lane: -1 | 0 | 1): Pt[];
routeGutterMsg(A: Pt, B: Pt, gaps: {x: number; y: number}, lane: -1 | 0 | 1): Pt[];
type PipeKind = 'lineage' | 'notice' | 'ask' | 'collision' | 'hot' | 'core';

// field/layout.ts (C) — la consume D
interface Layout { …; gapX: number; gapY: number }

// field/swarm.ts (A) — la consume D
write(slot, x, y, z, scale, color, alert, speed, sel, alpha, seed,
      flash, focusAlpha, lead, sigil: number, runtime: number): void;
// runtime: 0 claude · 1 codex · 2 grok · 3 otro · 9 capcom
```

## 8. Verificación

- `npm run typecheck` y `npm test` en verde (incluye el test de cunetas).
- `npm run visual`: las escenas nuevas y las antiguas sin regresión.
- `npm run stress`: 1.000 agentes a 60 fps con bus+núcleo (dos `add` por
  linaje duplica segmentos; la capacidad ya crece por dos).
- A ojo, contra los frames del comp a 8,0 s y 10,5 s: el bus gris con la lima
  dentro, los puertos huecos y llenos, ningún cable sobre un tile.
- Las siete filas de §0, una a una, sobre la misma región de 33 tiles y el
  mismo tile LL de las capturas.
- Cada fila de §6, una a una, con `--headed`.
