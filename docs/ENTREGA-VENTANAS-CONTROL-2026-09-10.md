# El control de ventanas: cuatro huecos del par canvas/front

Continúa la entrega de ayer (docs/ENTREGA-VENTANAS-CANVAS-2026-09-09.md), que
puso el vuelo de `CANVAS`. Un vuelo dice hacia dónde cayó una ventana durante
`T.quick` y después calla; estos cuatro cambios son lo que hacía falta
alrededor para que el par canvas/front se sostenga solo.

## 1 · Una ventana fuera de vista lo dice, y se ve en el radar

La ficha de la bandeja siempre ha llevado la colocación debajo del rótulo:
`canvas`, `front`, `fixed`, `folded`. Faltaba el único caso en el que esa
línea es la única prueba de que la ventana existe: la ventana está en el
mundo y no hay ni un píxel suyo en el cristal. Ahora ahí pone `off view`, con
la clase `is-away` en la baldosa —el `<small>` a opacidad completa, sin acento
nuevo—, y la ficha lo dice **sola**: quien saca una ventana de la pantalla es
la cámara, no un clic, así que `reproject` mira el cruce del borde cada
fotograma y avisa a la bandeja sólo cuando cambia el lado.

Tres cosas se confundían bajo el mismo nombre y ahora tienen tres: `far` es
«se ve, demasiado pequeña para trabajar»; `needsLocate` es «se ve mal
colocada», y es lo que decide si recuperarla mueve la cámara; `offView` es el
caso duro, «no toca la pantalla». El `offView` que ya existía —el del tile de
un agente— pasó a llamarse `tileOffView`, que es lo que era.

Y el minimapa, que dibujaba regiones, agentes y viewport, dibuja también las
ventanas del canvas: son sitios del mundo como una región, y son los únicos
que el campo no pinta por su cuenta. Punteadas mientras están en pantalla
—eso es un recordatorio—, sólidas cuando no —eso es la respuesta—, y la que
tiene el teclado en tinta, porque el lima es del viewport y dos rectángulos
lima discutirían. El mapa **crece** para incluir un asiento lejano en vez de
recortarlo: una ventana fuera de la flota es justo la que hay que encontrar.
El radar se redibujaba sólo cuando se movían la cámara o el mundo, así que
ahora su clave lleva `wm.stamp()`, un número que sube cuando una ventana puede
haberse movido.

## 2 · Un asiento que se quedó fuera de vista se rinde

`CANVAS` devolvía la ventana a las coordenadas del mundo que tenía guardadas,
siempre. Eso es la doctrina del canvas —las cosas se quedan donde se las
puso— pero se rompe cuando el operador viaja con la ventana delante: el
asiento de hace tres regiones ya no es un sitio, y mandar la ventana allí es
mandarla a ninguna parte y dejar la bandeja como único camino de vuelta.
Ahora, si el asiento ha quedado fuera de la vista actual (`seatOffView`, la
misma lectura que `offView` pero sobre las coordenadas del mundo), se
abandona y la ventana aterriza en la vista que el operador eligió. Un asiento
que sigue a la vista no se toca.

## 3 · `+` es el par de `-`

Con una ventana activa, `-` la pliega y `Esc` la devuelve al canvas; para el
camino contrario sólo había ratón (el botón `FRONT`, el menú contextual, o la
pulsación quieta sobre la cabecera a tamaño de lectura). Ahora `+` —y `=`, que
es la misma tecla sin estirar el meñique— trae al frente la ventana activa del
canvas. En la fila de la bandeja hace lo mismo sobre la del cursor y **sale**
del modo, al revés que `-`, que se queda: traer una al frente es pedir
trabajar en ella, y la fila ya no tiene nada que decir.

## 4 · Dos ventanas no aterrizan una encima de otra

En el frente, una ventana que se abre busca el hueco al lado de su tile
(`beside`). En el canvas no había nada equivalente, y con el cambio 2 el
problema deja de ser teórico: dos ventanas traídas al frente están las dos
centradas en el cristal, así que las dos se soltarían exactamente en el mismo
punto del mundo. Ahora un asiento **que elige el gestor** —al abrir, o al
soltar aquí— se aparta de los que ya están ocupados, empujándose a la derecha
del que estorba, hasta ocho veces (el mundo no tiene bordes donde quedarse sin
sitio; el tope es para que un corro de asientos empujándose no se coma un
fotograma).

Un asiento **que elige la mano** no se mueve nunca. Soltar una ventana justo
encima de otra es algo que se hace a propósito, y un canvas que se recoloca
solo bajo el arrastre es un canvas peleándose con la mano.

## Verificación

`npm run typecheck` limpio. `npm test -- --changed` → 5 suites
(`capcom-window`, `debrief`, `minimap`, `talk`, `window-canvas`), 65/65. Y la
suite entera, `npm test`, por ser `wm.ts` el centro de la consola: 1180/1180.

`window-canvas` cubre los cuatro: que la ficha pasa a `off view` bajo un
paneo y vuelve, sin que nadie toque nada; que un asiento caducado se rinde y
la ventana aterriza en la vista, con un asiento nuevo; que `+` trae al frente
y `Esc` devuelve, en la ventana activa y en la fila de la bandeja; y que dos
ventanas soltadas en el mismo sitio no se solapan mientras que una arrastrada
encima de otra se queda donde la mano la dejó. Las cuatro aserciones se
comprobaron mutando el código: cada una falla cuando se quita lo que mira.

`minimap` es nueva. Monta el radar contra un campo mínimo y lee píxeles: sin
ventanas no dibuja ninguna; con una, la dibuja; la misma ventana en el mismo
asiento pasa de punteada a sólida cuando la cámara se va de ella (más píxeles
del mismo gris, mismo encuadre); la enfocada se dibuja en tinta y deja de ser
gris; y un asiento a sesenta unidades del campo sigue dentro del mapa. Deja
`test/shots/minimap-windows.png`.

El CSS de `is-away` se verifica en Chromium aunque el grafo de suites marque
`hud.css` sin cobertura; medido además a mano: `off view` ocupa 38 px de los
58 de la baldosa. La ayuda (`kinds/misc.ts`, ⌥H) también queda sin suite: es
la lista de teclas, y ahora nombra `+`, lo que hace `+` en la fila de la
bandeja y qué significa `off view` en una ficha.

Filtros que cubren esta entrega: `window-canvas`, `minimap`.
Arnés visual: `console --isolated`.
