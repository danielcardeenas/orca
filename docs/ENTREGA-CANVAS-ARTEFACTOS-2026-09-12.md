# La estantería: entrega

Misión `mission_mty0u9wtmoc471tc`, squad `canvas-artefactos-01`, miembro 2 (la
presentación en el canvas), pieza P2 del plan del líder
([CANVAS-ARTEFACTOS-DECISION-2026-09-12.md](CANVAS-ARTEFACTOS-DECISION-2026-09-12.md)).
El reconocimiento y el porqué están en
[CANVAS-ARTEFACTOS-2026-09-12.md](CANVAS-ARTEFACTOS-2026-09-12.md); la mitad de
la captura, en
[ENTREGA-CAPTURA-ARTEFACTOS-2026-09-12.md](ENTREGA-CAPTURA-ARTEFACTOS-2026-09-12.md).

El pedido del operador: *«quiero verlos en el canvas cerca de los agentes que lo
hicieron»*. Y la advertencia que venía con él: *«que no tape la información que
el canvas ya da»*.

## 1. Lo que hay ahora

Cada agente que ha **declarado** algo cuelga una franja de fichas bajo su
baldosa: cuatro fichas y un contador. La franja mide exactamente lo que mide la
baldosa, y el hueco donde cae lo reserva la rejilla.

| | |
|---|---|
| La geometría y la cuenta, puras | `src/ui/field/shelf.ts` |
| Las medidas de la rejilla | `src/ui/field/grid.ts` (nuevo; `layout.ts` las reexporta) |
| La reserva del hueco | `src/ui/field/layout.ts`, parámetro `shelved` |
| El dibujo | `src/ui/field/shelves.ts`, capa `[data-shelves]` |
| Las reglas de una superficie | `src/ui/field/surface.ts` |
| Quién tiene estantería | `shelvedAgents`, `src/ui/field/field.ts` |
| El estilo | `.chip-art` en `src/ui/styles/field.css` |

Cinco commits, cada uno con sus pruebas: `f9a8133` (geometría), `b3c02b2` (la
regla de lo declarado), `85d9a24` (la reserva), `1f2fb2e` (el dibujo, el clic y
el contador), `a33ffaa` (las cuatro roturas de `media.ts`), más `e22a10c` y
`dfb3cf1` (el arnés visual).

## 2. Por qué una franja y no la imagen

Porque **una superficie de media mide 2,4 baldosas de ancho sobre un paso de
rejilla de 1,24**. Anclar eso a un agente por su cuenta entierra de cuatro a
seis baldosas vecinas, y la información del canvas es la forma de la flota: quién
está con quién, quién trabaja, de qué color. Tapar media flota para enseñar una
imagen es cambiar lo que el canvas dice por lo que muestra.

Así que lo que aparece solo mide lo que mide una baldosa, y el `PLACE` de hoy —la
superficie grande, con el operador decidiendo tapar lo que hay debajo— sigue
intacto y es el gesto para verlo en grande.

Y el hueco **se reserva**, no se superpone: la fila que lleva estantería mide
más y las de abajo bajan, igual que la rejilla ya le hace hueco a una bandeja o
al recinto del arnés. Entonces no hay nada que pueda quedar debajo.

## 3. Los casos difíciles

**Cuarenta imágenes.** Dos respuestas, y la primera es la de la mitad de la
captura: se cuelga sólo lo **declarado**. Un agente que genera cuarenta png no
tiene cuarenta resultados, tiene uno, y sólo él sabe cuál; lo observado apareció
sin que nadie lo eligiera y su título es un nombre de archivo. Cuarenta archivos
observados no ponen nada bajo ninguna baldosa. Y si alguien declara cuarenta de
verdad: cuatro fichas y un `+36` que abre la galería filtrada por ese agente.
Para cuarenta cosas el sitio es un índice, no un mapa.

**Un vídeo pesado.** La ficha es su primer fotograma y una marca `▶`, nunca una
`VideoTexture`. Antes un vídeo colocado se reproducía en bucle estuviera en
pantalla o no, subiendo un fotograma a la GPU por frame: los decodificadores de
hardware se cuentan con los dedos de una mano, así que el cuarto vídeo colocado
degradaba a los tres primeros. Y si pesa más de los 16 MB del cable, el artefacto
llegaba con `url` pero sin bytes y el campo montaba una textura sobre una URL que
falla — un rectángulo negro para siempre, sin explicación. Ahora dice qué es y
cuánto pesa.

**Un artefacto sin miniatura posible.** Ficha de glifo: la extensión y el peso,
`ZIP · 4.2 MB`, que es todo lo que se puede decir con verdad de un binario.
Precedente: `thumb__k` en la galería. Y de paso se cierra el agujero que la mitad
de la captura dejó anotado: `kind: 'file'` ya no entra en la rama de texto de
`media.ts`, que descargaba el binario y lo pintaba como texto.

**El zoom lejano.** La franja se dibuja mientras la baldosa esté en el peldaño 3
de los rótulos (190 px), donde una ficha son 33 px y es una imagen; en el peldaño
de abajo serían 19, y un color no es una miniatura. Por debajo no se encoge:
desaparece. Y como el hueco está reservado, **alejarse no recoloca la flota**:
sólo deja la franja vacía. Medido en el arnés: la franja se va con 25 a 33
baldosas todavía en pantalla. La silueta se queda; la fotografía se va.

**Un agente que ya murió.** Si su baldosa sigue en el campo (`dead`/`done`), la
franja se queda y se atenúa con ella: es la mayoría de los casos. Si está
archivado y fuera de `w.agents`, **no hay estantería**, y no se le inventa un
sitio: vive en la galería, que es el lugar que sobrevive a su autor, y en la
ventana de misión. Un montón de imágenes sin dueño sobre suelo abierto es el
canvas mintiendo sobre la forma de la flota. Y colocar a mano un artefacto cuyo
agente ya no tiene baldosa ya no cae en la posición de la cámara —soltaba la
superficie donde el operador estuviera mirando y la colocación la dejaba ahí para
siempre—: se niega y lo dice en el feed.

**El clic.** Una ficha abre su artefacto donde está la ficha, por el camino que
ya abría un cuadro colocado. El contador abre la galería filtrada por el agente,
y es otra ventana y no la misma con otro filtro: si compartieran clave, abrir el
contador de una baldosa recolocaría la galería que el operador tenía abierta
mirando otra cosa. Clic derecho sigue siendo el menú del artefacto, donde vive
`PLACE IN FIELD`, así que la superficie grande está a un gesto y la estantería es
el índice y no su sustituto. **Sin previsualización al pasar por encima**: una
imagen que se infla bajo el puntero mientras intentas leer una baldosa es la peor
interacción posible en este canvas.

**`prefers-reduced-motion`.** La ficha aparece dibujada, nunca deslizada ni
desvanecida, así que no hay transición que quitar. Sólo queda el color del hover,
que es información —cuál de las cinco se va a abrir— y por eso se queda.

## 4. Lo que se rompía en silencio y ya no

Cuatro cosas de `media.ts` y `field.ts` que ninguna lanzaba un error. Las reglas
que las deciden salieron a `surface.ts`, puras y con pruebas:

- un cuadro que ya no es una imagen se retira por debajo de 40 px de ancho
  dibujado — como un favicon, lo más pequeño en que una imagen sigue siendo una
  imagen. En el tope del zoom eran diez píxeles de mancha sobre la silueta; en el
  zoom de trabajo son 168 y no se le toca;
- un vídeo que nadie mira deja de decodificar;
- un binario dice lo que es en vez de pintarse como texto;
- `placeNear` deja de inventar un ancla.

## 5. Lo que falla o queda, dicho claro

**Un agente plegado en la bandeja de su padre pierde su estantería.** Un hijo que
sólo habla con su padre se pliega, y una celda de bandeja no tiene estantería a
propósito: es demasiado pequeña para nada y dice sólo su estado, la misma regla
que ya siguen los rótulos. Mientras esté plegado, lo que declaró no se ve en el
campo. Sigue en la galería. Es el precio de la regla y no un descuido, pero
conviene saberlo: en el mock pasa cada pocos segundos.

**La miniatura sigue siendo el original.** `chipSrc` en `shelves.ts` es el único
sitio donde entra `/api/artifact/<id>?thumb=128` cuando exista — la costura que
la mitad de la captura dejó aplazada porque hoy el hub no tiene ninguna
dependencia de imagen. Mientras no exista, una ficha de 33 px se baja el png
entero. No es memoria de vídeo, que era el desastre; es ancho de banda, y las
fichas se cuentan con los dedos. Con la miniatura, el canvas cuesta bastante
menos.

**El atlas instanciado, aplazado.** Cada ficha es un nodo DOM. Con el techo de 96
eso es aceptable y medible; un atlas instanciado dejaría la estantería de toda la
flota en una llamada de dibujo. Es una optimización y quiero medirla sobre una
flota real antes de escribirla.

**La ficha de un `.html` no es su render.** Requiere una captura de iframe fuera
de pantalla. Ficha de glifo con el nombre; la superficie DOM para leerla de verdad
sigue siendo el `PLACE` explícito, que ya funciona.

**El techo de 96 fichas parte por orden de recorte de la cámara**, que es el
orden en que el bucle de dibujo recorre a los agentes visibles. Es determinista
pero no es «las más cercanas al centro»; con una flota que declare mucho habría
que ordenarlo.

**Ruido del arnés, no mío:** al cerrar, el hub aislado se queja con un `ENOENT`
sobre `hub/events/<fecha>.jsonl` porque su `ORCA_HOME` temporal se borra antes de
que termine de cerrar. Pasa después de que la prueba pase, y está en
`test/visual.ts` / `src/hub/persist.ts`.

## 6. Verificación

```
npm run typecheck                       limpio
npm test -- --changed                   149/149
npm test -- shelf shelf-layout          24 + 7
ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts    4 corridas seguidas en verde
```

Lo que el arnés visual comprueba en Chromium, con el hub aislado y sin tocar el
índice del operador: cuatro fichas y un contador bajo la baldosa y **por debajo
de su borde inferior**; en una fila; lo observado sin colgar de nadie aunque sea
lo más nuevo; el contador contado contra el mundo; un clic en una ficha abriendo
su artefacto; el contador abriendo la galería filtrada; **una ficha con una
imagen que el hub sirvió de verdad, comprobando que cargó y no que exista la
etiqueta**; y la franja desapareciendo con la flota todavía dibujada. Fotos en
`test/shots/shelf-0{1..5}.png`.

Lo que **no** tiene suite: `src/ui/main.ts` (la rama de `placeArtifact` que se
niega cuando el agente no tiene baldosa — se prueba a mano, no hay prueba) y
`src/ui/styles/field.css`. Lo dice `npm test -- --changed` y lo digo aquí para que
«los tests pasan» siga queriendo decir algo.

**Relevo:** ninguno. Es todo consola, que Vite recarga. Para confirmarlo en la
consola viva: acercarse a un agente que haya declarado algo con `orca-show` y
mirar bajo su baldosa; o pulsar el contador y ver la galería llegar filtrada por
él.

## Filtros que cubren este documento

```
npm test -- shelf                 la geometría, la cuenta y la regla de lo declarado
npm test -- shelf-layout          la reserva del hueco, caja contra caja
npm test -- surface               cuándo se mira, cuándo se reproduce, qué pone
npm test -- layout blocks forge-layout harness-field placed-files   que nada se movió
ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts   que se dibuja, en Chromium
```
