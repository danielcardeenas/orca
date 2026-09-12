# Artefactos en el canvas: reconocimiento y propuesta

Misión `mission_mty0u9wtmoc471tc`, squad `canvas-artefactos-01`, miembro 2 (la
presentación). El compañero 1 lleva la captura y el camino de datos; este
documento sólo responde a la pregunta 2 del operador: **cómo mostrarlo en el
canvas para que tenga sentido**.

Todo lo que sigue con fichero y línea contra el árbol de `main` del
2026-09-12 (HEAD `7886ccd`).

## 1. Cómo está hecho el canvas hoy

### La flota es un solo dibujo

Las baldosas no son objetos: son ranuras de una malla instanciada. El bucle
recorta primero por un rectángulo alrededor de la cámara
(`src/ui/field/field.ts:2295`), escribe cada agente visible en una ranura
(`field.ts:2338`) y cierra con un único `swarm.commit(slot, clock, ppu)`
(`field.ts:2368`). **Veintidós agentes cuestan una llamada de dibujo.** El
contador `drawn` que sale en `stats()` es ese `slot` (`field.ts:2576`).

La geometría es fija y conocida: `TILE_W = 1.0`, `TILE_H = 0.78`, y el paso de
la rejilla es `1.24 × 1.04` con `GAP_X`/`GAP_Y` (`src/ui/field/layout.ts:85-88`).
Esa medida es la que hace legible la forma de la flota.

### El zoom ya tiene un contrato

Los rótulos son DOM y suben por peldaños medidos en píxeles de baldosa:
`TIER_PX = [44, 112, 190, 320, 520]` (`src/ui/field/labels.ts:103`), y el campo
sólo emite rótulo si `wpx >= LABEL_PX` (`field.ts:2359-2366`). La cámara va de
`Z_MIN = 1.4` a `Z_Max = 420` (`src/ui/field/camera.ts:16-17`) y el único
escalar sobre el que todo el mundo decide es `pxPerUnit(z)`
(`camera.ts:79`). O sea: **de lejos el canvas ya renuncia a las palabras y se
queda con la silueta y el color.** Cualquier cosa nueva tiene que entrar en esa
escalera, no inventarse otra.

### Reservar sitio junto a una baldosa ya existe, dos veces

`layout.ts` tiene dos precedentes de «esto vive al lado de aquello y el layout
le hace hueco»:

- **la bandeja** (`trayGrid`, `CELL_SCALE = 0.3`, `layout.ts:125-140` y
  `layout.ts:520-540`): los hijos plegados de un padre ocupan **una celda de la
  rejilla** al lado del padre;
- **el recinto del arnés** (`HARNESS_CLEAR = 0.7`, `layout.ts:118`): un vecino
  con aire propio.

En los dos casos el hueco lo reserva el layout, así que nada se solapa nunca.

### Y ya existe media en el campo

`src/ui/field/media.ts` proyecta un `Artifact` con `placement` en el campo: un
cuadro con textura para `image`/`video` (`media.ts:65-97`), una superficie DOM
para `html`/`text` (`media.ts:99-126`). `MEDIA_W = 2.4` (`media.ts:16`),
`MAX_MEDIA = 40` (`media.ts:17`). Clic en un cuadro abre la ventana del
artefacto (`field.ts:2119`); arrastrarlo lo mueve y escribe el `placement`
(`field.ts:1961-1971`); `pickAt` prueba agentes **antes** que media
(`field.ts:1783-1790`), así que una baldosa debajo de un cuadro sigue ganando
el clic.

### Pero nada lo ancla solo

`placement` es `null` hasta que el operador hace un gesto:

- `PLACE IN FIELD` en la ventana del artefacto
  (`src/ui/windows/kinds/artifact.ts:50,61`),
- `PLACE` en una miniatura de la galería
  (`src/ui/windows/kinds/gallery.ts:130,166`),
- o arrastrar la miniatura al campo (`gallery.ts:23-35` → `dropArtifactAt`).

El sitio lo calcula `Console.placeArtifact` (`src/ui/main.ts:428-441`) con
`field.placeNear(agentId, n)` (`field.ts:2571`). Y el `placement` **sólo vive en
`localStorage`**: `orca.artifacts.placed.v1` (`main.ts:595-611`), porque el hub
no tiene canal (`main.ts:184`). Los artefactos del canvas son, hoy, de este
navegador.

La respuesta a «¿dónde se ancla algo visual a un agente?» es por tanto:
`layout.spots.get(agentId)` (`layout.ts:147-159`), a través de `field.spotOf` o
`placeNear`. Lo que falta no es el ancla: es que alguien la use sin que el
operador lo pida, y que lo que cuelgue de ella quepa.

## 2. Qué se rompe si se echan imágenes al campo

Nueve cosas, medidas y no supuestas:

**a) Se tapa la flota.** `MEDIA_W = 2.4` son 2,4 baldosas de ancho y unas 2 de
alto. `placeNear` pone la primera en `s.x + 2.0`, con columnas cada 2.7 y filas
cada 2.0 (`field.ts:2574`), sobre un paso de rejilla de 1.24 × 1.04. **Un solo
cuadro automático entierra de cuatro a seis baldosas vecinas.** Con colocación
manual eso es problema del operador; anclando solo, es problema de ORCA. Es
exactamente «tapar la información que el canvas ya da».

**b) Se invierte el coste de dibujo.** Cada media son dos mallas con su propia
geometría y su propio material (`media.ts:88-96`). Cuarenta artefactos son
ochenta llamadas de dibujo contra **una** de toda la flota.

**c) La memoria de textura.** `loader.load(url)` sube el archivo a resolución
completa y con mipmaps (`media.ts:75`). Un PNG 4K son ~44 MB de VRAM; cuarenta,
~1,7 GB, y el contexto de GL se cae. **No hay miniatura en ningún punto de la
cadena**: la galería y la ventana de misión también ponen el original en un
`<img>` (`gallery.ts:122`, `src/ui/windows/kinds/mission.ts:557`).

**d) Los vídeos no paran nunca.** `autoplay + loop + muted` (`media.ts:69`),
reproduciéndose estén en pantalla o no, con una subida de fotograma a la GPU por
frame y por vídeo (`VideoTexture`, `media.ts:72`). Nada los pausa fuera de
cuadro ni en el zoom lejano.

**e) Un vídeo pesado no enseña nada, y no lo dice.** `MAX_ARTIFACT_BYTES` son
16 MB (`src/shared/protocol.ts:648`) y por encima el collector se niega a mandar
los bytes (`src/collector/artifacts.ts:331-337`). El artefacto sigue existiendo
con su `url`, así que el campo monta una `VideoTexture` sobre una URL que falla:
**un rectángulo negro para siempre, sin explicación.**

**f) El techo de 40 es silencioso y arbitrario.** `if (n >= MAX_MEDIA) break`
(`media.ts:165`) sobre `want.values()`, que es el orden de inserción del registro
del mundo, o sea lo que el hub mandó primero. Un agente con cuarenta imágenes se
come el presupuesto global entero y el 41 simplemente no aparece.

**g) Media no tiene LOD.** Ignora `pxPerUnit` por completo: los cuadros se
dibujan a cualquier zoom. Sólo las superficies DOM se esconden, por debajo de
`scale < 0.18` (`media.ts:177`). En `Z_MAX`, donde una baldosa son 3 px y los
rótulos ya no están, un cuadro de 2,4 unidades sigue siendo 7 px de ruido
fotográfico encima de la silueta.

**h) El artefacto de un agente muerto se va a la cámara.** Cuando no hay
`spot`, `placeNear` devuelve `{ camera.cam.x, camera.cam.y, 0.1 }`
(`field.ts:2573`): suelta el cuadro donde estés mirando, sin ancla, y el
`placement` de `localStorage` lo deja ahí para siempre. Y los artefactos
sobreviven a su agente por diseño — el hub desaloja por edad y por techo, no por
la vida del agente (`src/hub/world.ts:1352-1362`) —, así que **este es el caso
normal, no el raro.**

**i) Un `.zip` no llega a ser artefacto.** `kindOf` es una lista blanca de
extensiones (`src/collector/artifacts.ts:70-72`); un binario devuelve `null` y no
se registra. Hoy, «artefacto sin miniatura posible» sólo son `.md`/`.txt`/`.html`
y `.svg`. Si la captura se ensancha —la pregunta 1, del compañero— empezará a
llegar `kind: 'file'`, y `media.ts` lo mete en la rama `else`: una superficie DOM
que **descarga el binario y lo pinta como texto** (`media.ts:111-118`). Eso son
caracteres de reemplazo sobre el canvas.

## 3. Propuesta: la estantería

Los artefactos **no** entran en el campo como superficies grandes flotando. Cada
agente que ha producido algo gana una **estantería**: una franja estrecha bajo su
baldosa, con fichas pequeñas de tamaño fijo, una por artefacto, colocada por
`layout.ts` para que no pise a nadie. La superficie grande sigue siendo un gesto
explícito del operador: el `PLACE` de hoy, intacto.

El porqué, en una frase: **la información del canvas es la forma de la flota, y
esa forma está hecha de baldosas de un tamaño conocido a un paso conocido;
cualquier cosa que no mida eso destruye la forma.** Así que lo automático tiene
que ser a escala de baldosa y *dentro* del layout, no encima.

### 3.1 La estantería es layout, no una capa encima

La altura de la estantería se suma a la celda que ocupa el agente, igual que ya
hacen la bandeja y `HARNESS_CLEAR`. Consecuencia: la celda de un agente que
produce es un poco más alta, sus vecinos bajan, y **nada queda nunca enterrado**.
Coste: la flota se recoloca cuando llega el primer artefacto de un agente. Se
paga cuantizando la altura a un solo escalón (0 o `SHELF_H`): se recoloca una vez
por agente, no una vez por artefacto.

### 3.2 Cuarenta imágenes: cuatro fichas y un contador

Cuatro fichas visibles por agente como máximo —así la estantería mide lo mismo
que la baldosa de encima—, las más nuevas primero, y una quinta ficha que es un
contador: `+36`. Cuarenta imágenes son cuatro fichas y `+36`.

El contador abre **la galería filtrada por ese agente**; el filtro por agente ya
existe (`gallery.ts:96-101,138-140`). Para cuarenta cosas el sitio correcto es el
índice, no el lienzo. Eso resuelve el caso sin una tira con scroll sobre el campo
y sin cuarenta texturas.

### 3.3 Las fichas son miniaturas, con techo en píxeles

La textura de una ficha es el artefacto reducido a un lado corto fijo —128 px— una
sola vez. Cuatro fichas por veintidós agentes son 88 fichas: `88 × 128 × 128 × 4 B
≈ 5,8 MB`, contra los ~1,7 GB de (c). Sin mipmaps y con el tamaño de dibujo
acotado.

Lo mejor sería dibujarlas como **una sola malla instanciada sobre un atlas**, y
entonces toda la estantería de la flota cuesta una llamada de dibujo, como el
`swarm`. Es más trabajo; lo honesto para la primera pieza son cuadros por ficha
con textura de 128 px y un techo global de ~96 fichas, y el atlas después, con
números de una flota real en la mano.

**De dónde sale la miniatura es la costura con el compañero 1.** La respuesta
más barata y correcta es que **la haga el hub** (`/api/artifact/<id>?thumb=128`):
así el navegador no se descarga un PNG de 12 MB para pintar 128 px, la galería y
la ventana de misión la heredan gratis, y el límite de 16 MB del cable deja de
importar *para la vista previa*. Si el hub no puede, el cliente sabe hacerlo con
`createImageBitmap(blob, { resizeWidth: 128 })` — correcto, pero se sigue bajando
el archivo entero. Recomiendo el hub.

### 3.4 Un vídeo nunca es un vídeo en la estantería

La ficha de un vídeo es **su primer fotograma** —capturado una vez con
`currentTime = 0`, un `drawImage` a un canvas, y el elemento se destruye— más una
marca `▶`. Nunca una `VideoTexture` automática en el campo. El vídeo se ve en la
ventana del artefacto, que ya tiene `<video controls>` (`artifact.ts:36`).

Eso mata (d) y (e) de golpe: nada decodifica de fondo, y un vídeo de 200 MB
muestra un póster y un peso en vez de un rectángulo negro. Si el póster no se
puede hacer —el archivo no viaja—, la ficha es la ficha de glifo con su tamaño,
que es lo honesto.

### 3.5 Sin miniatura posible: una ficha de glifo, y ya está

Misma geometría, sin textura: la extensión en Tiny5 y el peso (`ZIP · 4,2MB`),
en la paleta de la baldosa. Ya hay precedente: `thumb__k` imprime el `kind`
cuando no hay imagen (`gallery.ts:124`). La estantería es esa misma idea a escala
de baldosa.

Lo importante: la ficha **no intenta pintar el contenido**. Y de paso hay que
cerrar (i): `kind: 'file'` no debe llegar a la rama de texto de `media.ts`
(`media.ts:110-118`); sólo `kind === 'text'` se baja como texto.

### 3.6 Zoom lejano: la estantería se va antes que los rótulos

Un solo umbral, sobre el mismo escalar que usa todo lo demás: la estantería se
dibuja mientras la baldosa esté en el peldaño 2 de los rótulos o por encima
(112 px, `labels.ts:103`), es decir mientras la baldosa ya esté mostrando
palabras. Por debajo, la estantería no se encoge: **desaparece**. De lejos el
trabajo del canvas es la forma de la flota y el color de los estados, y una
mancha de 7 px de fotografía es justo lo que rompe esa lectura.

Y como la estantería **está reservada en el layout**, el hueco sigue reservado a
cualquier zoom: la flota no se recoloca al alejarse, que sería mucho peor que una
franja vacía. Ése es el argumento de reservar en vez de superponer, otra vez.

Entre el peldaño 1 y el 2 merece la pena un intermedio: **una marca de cuenta** —
una barra pequeña o un `4` en la esquina de la baldosa, sin imagen. «Este agente
ha hecho cosas» sobrevive un escalón de zoom más que «esto es lo que ha hecho».
Eso va donde va el sigilo del shader (`sigilOf`, `field.ts:2341`) y no cuesta
nada.

### 3.7 El agente muerto: nunca inventar un ancla

Tres casos, y la regla es la que el layout ya usa para todo:

- **Muerto o terminado pero aún en el campo.** Su baldosa sigue ahí, atenuada
  (`alpha` 0.55 / 0.35, `field.ts:2319`), así que la estantería se queda y se
  atenúa con ella. Éste es el caso bueno y es la mayoría.
- **Fuera de `w.agents`** (archivado) con el artefacto todavía en el mundo:
  **no hay estantería.** El artefacto no recibe un sitio inventado en el canvas.
  Sigue en la galería —que es exactamente el lugar que sobrevive a su autor— y en
  la ventana de misión, que está anclada a la misión y no a un agente vivo
  (`mission.ts:546-565` ya resuelve el indicativo por `store.knownAgent`, así que
  lee bien con un agente muerto). Lo que **no** haría: que los artefactos
  huérfanos deriven a una esquina. Un montón de imágenes sin dueño sobre suelo
  abierto es el canvas mintiendo sobre la forma de la flota.
- **Uno que el operador colocó a mano y cuyo agente murió después:** conserva su
  sitio. *Una colocación del operador siempre gana*, que es la regla escrita tres
  veces en `layout.ts` (`layout.ts:10`, `310`, `621`), y esto no va a ser la
  excepción. Pero la salida por la cámara de `placeNear` (`field.ts:2573`) debe
  irse: colocar un artefacto cuyo agente no tiene sitio tiene que negarse y
  decirlo en el feed, no soltarlo debajo de tus narices.

### 3.8 El clic

Una ficha, un clic, una cosa: se abre la ventana del artefacto al lado de la
ficha, que es exactamente lo que ya hace un cuadro de media
(`field.ts:2119` → `onOpenArtifact`). **Sin previsualización al pasar por
encima**: una imagen que se infla bajo el puntero mientras intentas leer una
baldosa es la peor interacción posible en este canvas.

- La ficha contador abre la galería filtrada por el agente.
- Clic derecho es el menú de artefacto que ya existe
  (`c.menu({ kind: 'artifact', id })`, `gallery.ts:151`), donde vive
  `PLACE IN FIELD`: la superficie grande sigue a un gesto de distancia y la
  estantería es el índice, no su sustituto.
- Arrastrar una ficha a suelo abierto reutiliza el camino de drop que ya existe
  (`gallery.ts:23-35`) y coloca allí la superficie completa. Así la estantería y
  la colocación manual son un solo gesto continuo en vez de dos funciones.

### 3.9 Movimiento

La ficha aparece dibujada, no deslizada ni desvanecida, y pasa por `dur()`
(`src/ui/motion.ts:19`), que con `prefers-reduced-motion` la colapsa al estado
final: la ficha simplemente está en el siguiente fotograma, y la recolocación del
layout por la estantería nueva es instantánea — igual que ya hace la cámara
(`camera.ts:53`). Sin brillo de «artefacto nuevo»: un artefacto nuevo ya se
anuncia en el feed, y el destello de la baldosa está reservado a los cambios de
estado.

## 4. Lo que aplazo, con su motivo

- **El atlas instanciado.** La primera pieza va con cuadros por ficha a 128 px y
  un techo global de ~96 fichas. El atlas es una optimización medible y prefiero
  medirla sobre una flota real.
- **Persistir la estantería entre navegadores.** No hace falta: la estantería se
  deriva del mundo, que es mejor que el `placement` de `localStorage` de hoy. Las
  colocaciones manuales siguen siendo locales hasta que el hub tenga canal
  (`main.ts:184`), y no ensancharía eso en esta misión.
- **Artefactos `html` en la estantería.** La ficha de una página web no puede ser
  su render sin una captura de iframe fuera de pantalla, y eso es un agujero.
  Ficha de glifo `HTML` con el nombre del archivo; la superficie DOM para leerla
  de verdad sigue siendo el `PLACE` explícito, que ya funciona
  (`media.ts:104-109`).

## Filtros que cubren este documento

Reconocimiento y propuesta: sin código todavía, así que sin suite propia. Las
suites que tocarán las piezas cuando se implementen:

```
npm test -- layout blocks forge-layout    la reserva de hueco en el layout
npm test -- placed-files harness-field    el camino de media en el campo
npm run visual                            el arnés visual
npx tsx test/placed-files.shots.ts        media dibujada de verdad, en Chromium
```
