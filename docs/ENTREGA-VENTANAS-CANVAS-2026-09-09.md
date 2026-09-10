# Ventanas dentro del canvas

Las ventanas de escritorio se abren en el campo y conservan coordenadas del
canvas. Al navegar se desplazan y escalan; ya no quedan pegadas a los bordes.
Las ventanas de agente mantienen la conexión visual con su origen, pero su
posición la decide el operador. Por debajo de la escala de lectura aparece
una ficha con el título y el color de estado; el contenido permanece montado.

La sección inferior sigue siendo el control de todas las ventanas:

- `canvas`: está colocada en el campo.
- `front`: está temporalmente delante, a tamaño de lectura.
- `fixed`: permanece fija en pantalla.
- `folded`: está guardada en la bandeja.

Pulsar una ficha recupera su ventana desde cualquier lugar. Pulsar otra vez
la ventana activa y visible la minimiza. Si está lejos, la cámara vuela a ella.
La bandeja conserva el modo canvas/front/fixed. `FRONT` y
`CANVAS` cambian explícitamente entre el campo y el frente desde la cabecera. `PIN` fija una ventana
que está delante; `×` cierra y `—` pliega. El menú contextual y el selector
con teclado usan las mismas acciones. `Esc` devuelve una ventana `front` al
canvas; en las otras ventanas conserva el cierre anterior.

El regreso conserva la posición original, el borrador, el scroll y los
contenidos embebidos. Los movimientos entre capas usan la operación atómica
`moveBefore`; en navegadores sin ella se conserva la capa original para no
recargar un iframe. Las sesiones persistentes guardan coordenadas y modo.
Las ventanas efímeras de agente/interrupción mantienen la política anterior:
no se reabren automáticamente al recargar.

En móvil se mantienen las hojas a tamaño de pantalla. Las ventanas abiertas
en móvil adoptan coordenadas del canvas cuando se pasa a escritorio. El HUD
y el indicador de pendientes quedan por encima de las ventanas del campo.

## Verificación

- `npm run typecheck`: correcto.
- `npm test -- --changed`: 1.032/1.032 comprobaciones, 83 suites. La selección
  incluye los numerosos cambios que ya había en el árbol antes de esta tarea.
- `npm test -- window-canvas visual-ports`: comprobación final de los cambios
  del gestor y de la adaptación del arnés visual: 13/13 correctas.
  Tras ocultar el fijado en móvil se volvió a ejecutar `window-canvas`: 1/1.
- `window-canvas` ejecuta Chromium con Vite aislado, sin conectar a agentes:
  movimiento, zoom, ficha alejada, recuperación desde bandeja, fijado,
  conservación de borrador/iframe/scroll, plegado, arrastre, redimensionado
  con zoom, persistencia tras recarga y transición móvil/escritorio.
- `npm run visual -- console --isolated`: termina correctamente, 11 capturas.
  Omite `field-03-agent` (el doble clic no abrió la ventana) y `field-07-lasso`
  (el gesto no seleccionó varios agentes). Estas dos escenas quedan sin
  verificación visual general; no se cuentan como aprobadas.
- `npm run visual -- mobile --isolated`: termina correctamente, 2 capturas.
- La adaptación del arnés recupera cada ventana por su identificador estable
  desde la bandeja antes de plegarla; ya no presupone que sigue en pantalla.
- Capturas específicas: `test/shots/window-canvas-{overview,front,workspace,mobile}.png`.

El aviso `sin suite que los cubra` incluye, dentro de esta entrega, el contrato
`DESIGN.md`, la conexión de eventos en `main.ts`, la ayuda y CSS.
El CSS se carga y comprueba en la prueba de navegador; el grafo de imports no
sigue enlaces de hojas de estilo. La conexión con el campo real se revisa con
el arnés visual general. El detector de Impeccable señaló dos bordes laterales
preexistentes en `window.css`; esta entrega conserva esos estilos de ORCA.

## De lejos, la ventana y nada más

La ficha compacta que sustituía al cuerpo por debajo de escala 0,55 se quitó,
y con ella el corte: era una segunda representación de la misma ventana y
hacía que al acercarse la ventana apareciera de golpe ya grande. Ahora una
ventana en canvas no tiene versión lejana de ningún tipo: ni ficha, ni
desvanecido, ni umbral. De lejos es la carcasa pequeña, a la escala de la
cámara, y acercarse solo la hace más grande. Escala con el canvas, sin
compensar el zoom ni mantener un tamaño mínimo. La bandeja sigue siendo la
forma de encontrar una ventana, y recuperarla desde ahí sigue volando a
tamaño de lectura cuando está por debajo de 0,55.

Se probó primero una rampa de opacidad ligada al tamaño aparente, con suelo
al 7 % y bloom al pasar el puntero; el operador la descartó: seguía leyéndose
como una versión mínima que de repente se convertía en la ventana. Fuera.

`npm run typecheck` y `npm test -- window-canvas` terminaron correctamente.
La prueba comprueba que a un cuarto y a un octavo de escala no hay ficha, que
la carcasa está a opacidad 1, captura clics con normalidad, no lleva ninguna
clase de lejanía y su cuerpo sigue maquetado y visible: alejarse solo la hace
más pequeña. `test/shots/window-canvas-overview.png` muestra la ventana a un
octavo de escala.
`npm run visual -- console --isolated` se detiene en `field-03-agent` con
«Agent source is obscured by agent-thread scroll»: la ventana abierta en
frente cae sobre su propio tile. Es el modo frente, ajeno a este cambio, y la
escena ya quedaba sin aprobar en la corrida anterior.

## La línea al tile sobrevive a perder el tile de vista

La tubería entre la ventana y su tile solo se dibujaba con el tile en
pantalla o cerca de ella. Al hacer zoom o desplazarse hasta perderlo, la
ventana en canvas se quedaba suelta y ya no decía de dónde salía. Ahora la
cámara distingue dos cosas: `visible`, en pantalla o cerca, y `ahead`, delante
de la cámara. La línea se dibuja siempre que el tile está delante, esté donde
esté sobre el cristal: sale por el borde y esa es la señal. Solo un tile
detrás de la cámara se queda sin línea, porque su proyección es un espejo y
no un sitio. El SVG de la tubería ya tenía `overflow: visible` y ocupa toda
la pantalla, así que no hace falta recortar nada.

`npm run typecheck` y `npm test -- window-canvas` terminaron correctamente.
La prueba mueve el tile del arnés a 900 px fuera del borde izquierdo y
comprueba que la polilínea sigue y arranca en su borde derecho; con `ahead`
en falso, comprueba que no hay línea.

## De lejos, pulsar y arrastrar mueve la ventana desde cualquier punto

Por debajo de la escala de lectura, 0,55 y ahora una sola constante
`READING_SCALE` en `wm.ts`, la ventana es un sello: no se puede trabajar en
ella, solo moverla. Hasta ahora había que acertar en la barra de título
diminuta. Ahora la carcasa lleva `is-far`, el cuerpo deja de recibir el
puntero y el arrastre que antes vivía en la cabecera vive en la carcasa
entera: cabecera a cualquier escala, cualquier punto cuando está lejos. Los
botones, la esquina de redimensionar y el indicador de borde siguen siendo
suyos. Una pulsación quieta sobre un sello no hace nada, como antes; a tamaño
de lectura la pulsación quieta en el título sigue trayendo la ventana al
frente, y el cuerpo sigue siendo del contenido.

`npm run typecheck` y `npm test -- window-canvas` terminaron correctamente.
La prueba, a un octavo de escala, comprueba que el cuerpo no recibe el
puntero y que pulsar y arrastrar sobre él desplaza la ventana 50×30 px sin
traerla al frente; a escala 1, que el mismo gesto sobre el cuerpo no la mueve.
El CSS se verifica en Chromium aunque el grafo de suites lo marque sin cobertura.

## Del frente al canvas se ve adónde cae

`CANVAS` devolvía la ventana al mundo de un corte: desaparecía del cristal y
reaparecía en su sitio, que puede estar en cualquier coordenada del campo y
muy a menudo fuera de la pantalla. El operador se quedaba sin saber hacia
dónde se había ido. Ahora la carcasa vuela: sale de donde estaba en el
frente, encoge hasta la escala de la cámara y aterriza en su asiento; si el
asiento está fuera, se va por el borde y se corta allí, que es exactamente la
respuesta dibujada. El gesto vive en `fx.ts` (`sendToCanvas`, sobre un
`glideFrom` que `unfoldFrom` también usa) y dura `T.quick`, como cualquier
otro vuelo de una carcasa: el trayecto puede ser larguísimo, pero es un gesto
que el operador repite todo el día y una ventana que se toma su tiempo en
irse es una ventana estorbando; una salida rápida en la dirección correcta
dice lo mismo. Solo el delta se anima —`left` y `top` los sigue escribiendo el gestor cada fotograma—, así que
una cámara que se mueve durante el vuelo no deja la ventana atrás. Con
`prefers-reduced-motion` sigue siendo un corte.

`npm run typecheck` y `npm test -- window-canvas` terminaron correctamente.
La prueba abre una segunda página con movimiento permitido —la del arnés lo
tiene desactivado—, manda al mundo una ventana con el asiento en la esquina
inferior izquierda y a media escala de cámara —un viaje largo y diagonal,
entero en pantalla— y comprueba que a mitad de vuelo la carcasa está entre el
cristal y el asiento y aún es más grande de lo que la dejará la cámara, que
aterriza justo en el asiento y devuelve `transform`; con movimiento reducido,
que ya está en el asiento sin volar. La muestra de mitad de vuelo la toma la
propia página con su `setTimeout`: el tween dura `T.quick` y una ida y vuelta
por el driver puede llegar después del aterrizaje, que se leería como que no
hubo vuelo.

Filtros que cubren esta entrega: `window-canvas`, `visual-ports`.
Arnés visual: `console --isolated`, `mobile --isolated`.
