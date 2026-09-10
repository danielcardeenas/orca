# Las ventanas se abren delante, y el cable sigue puesto

Pinchar un agente abría su ventana en el lienzo, a la escala de la cámara. Desde
cualquier zoom de trabajo eso era un sello: había que volar hasta la baldosa
para leer lo que se acababa de pedir. Ahora una ventana **se abre delante**,
fija a la pantalla y a tamaño de lectura, junto a la baldosa que la abrió.

El lienzo no desaparece: cada ventana aprende sus coordenadas del mundo en el
momento de abrirse, así que `CANVAS` la deja al lado de su baldosa a la escala
fija de las ventanas de agente (320 píxeles de maqueta por unidad de mundo), no
donde el cristal la tuviera. `FRONT` la trae de vuelta. La bandeja sigue
diciendo el modo de cada una: `canvas`, `front`, `fixed`, `folded`.

## El cable a la baldosa, en cualquier modo

La tubería de una ventana de agente hasta su baldosa se dibujaba sólo en el
lienzo. Se dibuja en todos los modos: la línea dice *de quién* es esta ventana,
y eso no deja de ser cierto porque la ventana esté sobre el cristal. Se traza
mientras la baldosa esté en pantalla; sin baldosa a la que apuntar, no hay
línea. Vive en la capa del lienzo, así que pasa por debajo del HUD.

## Dónde cae la ventana

Una ventana a tamaño de lectura es grande, y la baldosa es el interruptor que
vuelve a cerrarla: una carcasa encima de su propia baldosa tapa el interruptor.
La colocación prueba ahora cuatro lados —derecha, izquierda, abajo, arriba— y
se queda con el primero que quepa; si no cabe en ninguno, con el que más sitio
dé. Además, una carcasa **en pleno vuelo de llegada** no acepta clics: la
animación arranca a un tercio del camino hacia el punto que la abrió, y en un
doble clic el segundo clic tiene que llegar a la baldosa, no a la ventana que
va por el aire. El permiso vuelve por temporizador y no por el final de la
animación, porque plegar o cerrar en los primeros fotogramas mata el vuelo.

## El cierre ya no salta a otra parte

Abrir una ventana pinchando un agente y cerrarla ahí mismo mostraba el colapso
en otro punto del lienzo. Las dos variantes del colapso (`collapse` y
`collapseShort`) movían el `transform-origin` al centro para plegar la carcasa.
Una carcasa del lienzo ya lleva una `scale` fraccionaria —la de la cámara— y
CSS la aplica alrededor de ese mismo origen: cambiarlo teletransportaba la
ventana media carcasa antes del primer fotograma. Con `ppu = 10` el salto medido
era de 158 px a la derecha y 161 px hacia abajo.

Ahora el origen se queda en `0 0` y cada escala lleva su traslación
compensatoria, `h * (1 - s) / 2`, en los píxeles propios de la carcasa. El
resultado en pantalla es el mismo que se pedía —la barra en el centro— sin
salto. `foldTo` y `unfoldFrom` tenían el mismo defecto al plegar hacia la
bandeja y usan ahora un ayudante común, `corner`, que sitúa la esquina superior
izquierda sobre el destino leyendo la escala de la cámara del propio rectángulo.

## Verificación

- `npm run typecheck`: correcto.
- `npm test -- --changed`: 1.049/1.049 comprobaciones. La selección incluye los
  cambios que ya había en el árbol antes de esta tarea.
- `npm run visual -- console --isolated`: termina correctamente, 13 capturas.
  Omite `field-07-lasso` (el gesto no seleccionó varios agentes); esa escena
  queda sin verificación visual y no se cuenta como aprobada.
- Medición directa del salto al cerrar, con el lienzo a `ppu` 40 y 10: el centro
  de la carcasa se mueve 0,2 px durante el colapso. Con el `center center`
  anterior reintroducido a propósito, 158 × 161 px. La medición se hizo sobre
  `test/window-canvas.fixture.ts` en Chromium, fuera del repositorio.
- Revisadas `test/shots/field-03-agent.png` (ventana delante, a tamaño de
  lectura, con la tubería desde su baldosa) y `field-03-agent-located.png`.

Sin suite que los cubra: `DESIGN.md` y el propio contrato de colocación de
`wm.place`. La colocación se ejerce en el arnés visual, que es donde hay
baldosas reales con posiciones reales; `window-canvas` no ancla su ventana a
ninguna. Queda anotado como lo que es: probado a mano y en el arnés, no en una
suite.

El arnés visual `console` tuvo que adaptarse: comprobaba el vuelo de la cámara
hacia una ventana lejana del lienzo, que era el modo de apertura. Ahora manda la
ventana al lienzo con `CANVAS` antes de encuadrar la flota, y el vuelo se
comprueba igual. `window-canvas.fixture.ts` hace lo mismo, y la suite comprueba
además que una ventana recién abierta viene en `front`.

Filtros que cubren esta entrega: `window-canvas`.
Arnés visual: `console --isolated`.
