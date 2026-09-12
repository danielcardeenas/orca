# Los outputs en el canvas: el tirante hasta su origen

Misión `mission-26`, automejora del canvas: cómo se muestran los outputs y de
dónde vienen. Sigue a la estantería
([CANVAS-ARTEFACTOS-2026-09-12.md](CANVAS-ARTEFACTOS-2026-09-12.md),
[ENTREGA-CANVAS-ARTEFACTOS-2026-09-12.md](ENTREGA-CANVAS-ARTEFACTOS-2026-09-12.md))
y no la cambia: las fichas siguen colgando de su baldosa y la superficie
grande sigue siendo un gesto del operador. Lo que añade es la respuesta a
**quién** y **cuándo** sin abrir nada.

El pedido del operador, no negociable: *cada output mostrado en el canvas
lleva una línea visible hasta su origen —la baldosa de su agente, o la de su
escuadra—, tenue en reposo y claramente más notable con el puntero encima.*

## 1. Lo que hay ahora

| | |
|---|---|
| La geometría del tirante y la regla del hover, puras | `src/ui/field/tether.ts` |
| El dibujo: `PipeKind` `tether`, alfa en reposo y caliente | `src/ui/field/pipes.ts` |
| Quién lo dibuja, de dónde sale, qué está caliente | `drawTethers`, `tetherOrigin` y `mediaAt`, `src/ui/field/field.ts` |
| El hover de las fichas y su pie | `src/ui/field/shelves.ts` |
| El pie de las superficies y si se dibujan | `src/ui/field/media.ts` |
| El estilo | `.chip-art.is-hot`, `.chip-cap`, `.srf-cap`, `.srf__who` en `src/ui/styles/field.css` |

Dos formas del mismo tirante:

- **La ficha de la estantería** cuelga de la baldosa por un **hilo** vertical:
  del centro de su borde superior al borde inferior de la baldosa. Uno por
  ficha, contador incluido. Mide exactamente `SHELF_PAD` a la escala de la
  baldosa — el aire que la estantería ya reservaba — así que no cruza nada.
  Cinco fichas son cinco hilos cortos: cada una dice de quién es sin que haya
  que deducirlo de la vecindad, y cuál de las cinco está bajo el puntero se
  ve en el hilo antes que en el borde de la ficha.
- **La superficie colocada** puede estar en cualquier sitio, porque la puso
  el operador. Su tirante es un **camino ortogonal**, como todo lo que une
  cosas en el campo: sale por el lado de la superficie que mira al origen,
  cruza a media distancia y entra por el lado del origen que mira a la
  superficie, con un **puerto** en el origen. Varias superficies de un mismo
  agente convergen en el mismo punto de su baldosa: N outputs son un haz, no
  N líneas.

Y un **pie** bajo cada superficie con textura —`título · INDICATIVO · 3M`—, a
letra fija como los rótulos, y `INDICATIVO · 3M` en la barra de una superficie
DOM. Una imagen flotando sobre el campo sin las tres cosas es una foto en el
suelo. La ficha, que a 33 px no puede decir nada, lo dice al pasar el puntero:
una línea de texto debajo con el título y hace cuánto. No es una
previsualización: la imagen no se infla.

## 2. Reposo y hover: la decisión

**En reposo el tirante es una hairline sólida en `--ink-dim` (`C_INK_DIM`),
a 0.5 de alfa y la mitad del grosor del bus de linaje.** Sólida a
propósito, aunque en este campo «nada estructural es una línea sólida»: un
tirante no es estructura ni tráfico, es una etiqueta. Las rachas del bus
dicen «hay algo vivo aquí» y una racha sobre un tirante diría que el
artefacto hace algo, que es mentira. En `--ink-dim` y no en el gris del bus
porque lo probé primero con el gris (`--line`, a 0.32) y en la foto no
estaba: el gris de línea por debajo de 0.5 se funde con el suelo, y una
línea que no se ve no es tenue, es que no está. A 0.5 queda por debajo de
todo lo que ya hay (bus 0.8, marco 0.9, mando 0.30–0.65): con veinte outputs
en pantalla, veinte tirantes son textura de fondo y no la imagen.

**Caliente —el puntero sobre el output, o sobre su origen— se vuelve lima
(`C_LIME`), a 0.95 de alfa y el doble de grosor, el puerto de origen crece
de 0.6 a 1, y la baldosa de origen se enciende como si el puntero estuviera
sobre ella** (`sel = 1` en el shader del enjambre, que ya existía para el
hover). Lima porque es lo que ya significa «lo que el operador está mirando»
en este campo: el core de un tie bajo el puntero, la selección. Un color
nuevo sería un significado nuevo.

El hover funciona en los dos sentidos, y con reglas distintas a propósito:

- **Sobre una ficha**: se enciende SU hilo y la baldosa. Los otros cuatro
  hilos siguen en reposo, así que se ve cuál es.
- **Sobre una superficie**: se enciende su tirante, su puerto y la baldosa.
  Aunque la superficie tape a un vecino: `pickAt` sigue dando la baldosa
  enterrada —el clic y el arrastre son suyos, como decidió la estantería—,
  pero el tirante mira lo que se ve (`mediaAt`, `field.ts`), y lo que se ve
  es el cuadro.
- **Sobre la baldosa** (o el contador de la estantería): se encienden TODOS
  sus hilos y tirantes, y la franja entera de fichas se enmarca en lima
  (`.is-hot`). Es la forma barata de responder «¿qué ha hecho éste?».
- **Sobre el bloque de una escuadra**: los tirantes cuyo origen es su puerto.

Nada se desvanece: el tirante cambia de estado en el fotograma siguiente,
como el resto de los pipes, y por eso `prefers-reduced-motion` no tiene nada
que quitar. Con el modo foco (Espacio) el tirante es un pipe más: sólo los
del seleccionado guardan su peso (`iSel`), los demás bajan a 0.12.

**Con muchos outputs a la vez.** Tres cosas evitan el ruido sin quitar la
línea: la estantería ya limita a cinco hilos por agente, todos dentro de la
columna de su baldosa y en un hueco reservado, así que no cruzan nada; las
superficies de un agente convergen en un punto, así que se leen como un haz
y no como N líneas; y en reposo todo está a 0.5, de modo que la única línea
entera es la que el puntero pide. Cuando la cámara se aleja, `uFar` los
apaga con los demás pipes, y el hilo se va con la estantería (peldaño 3,
190 px) y el tirante con su superficie (40 px), porque `MediaRect.shown`
lo dice y el tirante lo sigue.

## 3. De dónde sale

`tetherOrigin` en `field.ts`, en este orden y sin inventar nada:

1. **La baldosa de su agente**, si `layout.spots` la tiene — viva, muerta o
   terminada, y también una celda de bandeja, a su escala.
2. **El puerto de su escuadra**, si el agente ya no está en `w.agents` pero
   `store.knownAgent` lo recuerda con escuadra y el bloque sigue en el campo
   (`blockFor`). Es «el origen es la escuadra entera»: el agente se fue, la
   escuadra sigue.
3. **Nada.** Un archivo del operador (`placed-files`, sin agente) no es el
   output de nadie. Y un artefacto de un agente archivado sin escuadra en el
   campo no recibe un origen inventado, que es la regla que la estantería ya
   sigue: sigue en la galería y en la ventana de misión.

El tirante entra por el lado de la baldosa a `−0.12·TILE_H` de su centro: la
mordida está en el borde derecho y el puerto de mensajes (`routeMessage`)
entra a `+0.12`, así que dos líneas que llegan a una baldosa por lados
distintos siguen siendo dos cosas.

## 4. Lo que queda, dicho claro

- **Los pipes no saben que la estantería existe.** ~~Visto en las fotos, y no
  es de esta pieza~~ — **resuelto el mismo día, §6.** La rejilla reservaba el
  alto de la franja, pero `routeGutter` y `routeGutterMsg` calculaban «el
  canalón bajo la fila» desde `TILE_H`, así que el bus de linaje que sale del
  puerto inferior de un padre con estantería corría por en medio de sus
  fichas, y un ask que cruza por debajo de la fila pasaba entre la baldosa y
  las fichas.
- **Un tirante pasa por debajo de un vecino enterrado.** `placeNear` deja la
  primera superficie a dos unidades de su baldosa, encima del vecino de la
  derecha, y el tirante —un pipe, dibujado bajo las baldosas como todos—
  cruza por debajo de ese vecino y asoma junto al cuadro. Es lo que el
  operador decidió al colocar ahí; el puerto de origen y el tramo que entra
  en la baldosa siguen viéndose y se encienden con el hover.

- **El hilo del contador** cuelga como los demás pero el contador no es un
  output: es la puerta a todos. Pasar el puntero por él enciende la franja
  entera, no un hilo. Es coherente, pero conviene saberlo.
- **Un artefacto huérfano colocado a mano no lleva tirante** (caso 3). La
  alternativa era una línea al contorno de su proyecto, y descarté inventar
  un origen a grano de región: decía «de este proyecto» con la misma raya que
  dice «de esta baldosa».
- **El pie de las superficies envejece cada quince segundos**, no cada
  fotograma: `ago` cambia de palabra a esa resolución y reescribir DOM por
  frame es lo que los rótulos evitan.
- **`test/forge-field` falló una vez** en la corrida de `--changed` (la
  aserción «Overview label stays inside mobile viewport», con doce suites en
  paralelo) y pasó dos veces sola. No toca nada de lo que cambié; lo anoto
  por si vuelve.

## 5. Verificación

```
npm run typecheck                                    limpio
npm test -- tether                                   11/11
npm test -- --changed                                ver la entrega
ORCA_VISUAL_ISOLATED=1 npx tsx test/tether.shots.ts  ver la entrega
ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts   ver la entrega
```

Lo que el arnés visual comprueba en Chromium, con hub aislado y por firma de
píxeles donde la línea es WebGL: una superficie colocada cuyo pie lleva el
indicativo del agente; el hover sobre una ficha saca su pie con «qué ·
cuándo» y cambia los píxeles de su hilo; el hover sobre la baldosa enmarca
las cinco fichas; el hover sobre la superficie enciende el puerto de origen
en la baldosa; un miembro de escuadra descartado del campo (`__orca.dismiss`,
lo que hace DISMISS) cuya superficie sigue, y el puerto de la escuadra que
se enciende al pasar por ella; y muchos outputs en un encuadre. Las fotos:

```
test/shots/tether-01-rest.png            reposo: hilos y tirante en --ink-dim, a 0.5
test/shots/tether-02-hover-chip.png      una ficha: su hilo, su pie, su baldosa
test/shots/tether-03-hover-tile.png      la baldosa: los cinco hilos y el tirante, en lima
test/shots/tether-04-hover-surface.png   la superficie: su tirante y el puerto en la baldosa
test/shots/tether-05-squad-rest.png      origen en escuadra, en reposo
test/shots/tether-06-squad-hover.png     origen en escuadra, el puerto del bloque en lima
test/shots/tether-07-many.png            seis estanterías y tres superficies en un encuadre
```

Dos cosas que las fotos enseñan y que no maquillo: **en reposo el hilo de
una ficha se pierde cuando un ask cruza la franja** — la flota sintética
tiene una docena de asks en vuelo y sus pipes ámbar atraviesan el hueco
entre la baldosa y las fichas (§4, los pipes no saben que la estantería
existe); el hilo está, a 0.5, pero un pipe ámbar a 1.0 por encima gana. Con
el puntero encima el hilo es lima y se lee igual. Y **el tirante a una
escuadra pasa por debajo de sus baldosas** cuando `placeNear` deja la
superficie sobre el propio bloque: se ven los tramos que van por los
canalones y el puerto, no la línea entera.

Para verlo en la consola viva: acercarse a un agente que haya declarado algo
con `orca-show`, y mirar los cinco hilos entre la baldosa y su franja; pasar
el puntero por una ficha y por la baldosa. `PLACE IN FIELD` desde la ventana
del artefacto o desde la galería, arrastrar la superficie a cualquier sitio
del campo, y el tirante la sigue.

## 6. Las rutas saben que la estantería existe (misión `mission_mty82s5wo0q8ko6w`, mismo día)

El primer punto de §4, hecho. Es un cambio de rutas, no de diseño: el
tirante de arriba no se toca.

**Qué cambia.** `Spot` lleva `shelf`: lo que su FILA reserva debajo
(`SHELF_H` si alguien de la fila declaró algo, 0 si no). Lo pone
`layout.ts` a partir del mismo `shelfRow` que ya bajaba las filas de
debajo, así que no hay una segunda fuente de verdad. `routeGutter` y
`routeGutterMsg` aceptan `RoutePt` (`Pt` con `shelf` opcional) y restan esa
franja **sólo al canalón que está bajo un borde inferior**: el del padre
cuando el hijo está abajo, el del hijo cuando está arriba, el de la fila
cuando los dos comparten fila. El canalón sobre un borde superior no se
mueve, porque la franja cuelga de las baldosas de la fila de arriba y el
hueco queda debajo de ella. Una fila sin estantería enruta exactamente como
antes, número a número; una con estantería baja su canalón `SHELF_H`, ni
más ni menos, y la bajada recta a un hijo justo debajo sigue siendo recta,
franja incluida.

**Lo que no cambia y por qué.** El pipe sigue saliendo por el puerto
inferior de la baldosa (`x − 0.32·TILE_W`): el puerto es la forma de la
baldosa —la pestaña que el shader dibuja bajo el borde— y no se mueve por
las fichas. Ese tramo vertical cruza la franja a la fuerza, y cae en el
hueco entre la primera y la segunda ficha (probado contra `shelfChips`),
por debajo del DOM de las fichas. Lo que ya no pasa es que un tramo
horizontal corra por dentro de la franja.

**Lo que queda.** Una baldosa que el operador fijó fuera de su celda lleva
`shelf: 0`: sus pipes van directos (`offGrid`) y cruzan lo que haya, como
siempre. CAPCOM y la cubierta, igual. Las rutas entre regiones salen por
las puertas de la región, cuyo pad ya contaba `shelfTotal`.

**Verificación.**

```
npm test -- shelf-routes                        12/12: fila con/sin estantería, subida, bajada, misma fila, ask, 2280 rutas sin pisar baldosa ni franja, y la rejilla de verdad
ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf-routes.shots.ts   test/shots/shelf-routes-0{1,2}.png: el líder de la escuadra del arnés con estantería y el bus a un miembro de la fila de abajo, por debajo de las fichas
```

El arnés visual afirma lo que no depende de la suerte —que la rejilla dio
`shelf` a la fila y que la de abajo bajó eso— y **hace skip, no fallo**, si
la escuadra no ofrece un miembro con baldosa propia en la fila de abajo en
esa corrida. La flota sintética no vale para este par: padre e hijo van
contiguos en la rejilla y sólo caen en filas distintas en un salto de fila
que el siguiente nacimiento deshace. Un rojo que depende del fixture
envenena la suite. La foto que hay al escribir esto salió con la escuadra:
`Z1` con cinco fichas y el bus a `Z4`, una fila más abajo, bajando por el
hueco entre la primera y la segunda ficha y corriendo por debajo de la fila
(`shelf-routes-02-close.png`); antes de dar con la escuadra, la flota
sintética sólo dejó un primer plano de diagnóstico con una baldosa en
tránsito por delante.

## Filtros que cubren este documento

```
npm test -- tether                       la geometría del hilo y del camino, y la regla del hover
npm test -- pipes shelf surface          que nada de lo de al lado se movió
npm test -- placed-files harness-field   el camino de media en el campo
ORCA_VISUAL_ISOLATED=1 npx tsx test/tether.shots.ts   que se dibuja y se enciende, en Chromium
```
