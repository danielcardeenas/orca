/**
 * ¿Esto es un teléfono? Un solo sitio para decirlo.
 *
 * La consola lo decidía por ancho, y en tres sitios distintos con tres
 * umbrales distintos: el gestor de ventanas preguntaba `max-width: 720px`,
 * `window.css` lo mismo, y el mástil de `hud.css` había añadido ya el alto.
 * Un teléfono girado mide 844×390 —o 926×428— y por ancho pasaba por
 * escritorio: el mástil envolvía en cuatro filas y no dejaba baldosa que
 * tocar, y la ventana de CAPCOM salía como una caja de 500×178 con asa y
 * arrastre, con 108px de cuerpo para leer una conversación. Dos lados
 * resolviendo la misma pregunta por separado es la forma de un fallo, no un
 * detalle: en cuanto un tamaño cumple una condición y no la otra, el CSS
 * viste la ventana de una manera y el `wm` la trata de otra.
 *
 * La condición mira las DOS medidas. De pie basta el ancho; de lado el ancho
 * es de escritorio y lo que delata al teléfono es el alto. El corte de alto va
 * unido a un techo de ancho (1180) para que una ventana de escritorio
 * encogida a lo bajo no se convierta en teléfono; 1180 es el mismo ancho por
 * debajo del cual AUTOMEJORA ya se abre como hoja.
 *
 * `@media` no puede importar de aquí, así que las hojas repiten la cadena
 * literal: los bloques de teléfono de `hud.css` y `window.css` llevan esta
 * misma condición y `test/phone-media.test.ts` afirma que sigue siendo la
 * misma, rama a rama. Cambiarla es cambiarla aquí y allí en la misma edición;
 * la prueba grita si se olvida una.
 */

/** Un teléfono, de pie o de lado. */
export const PHONE_MQ = '(max-width: 720px), ((max-width: 1180px) and (max-height: 560px))';

/**
 * Sólo de lado: la mitad corta de `PHONE_MQ`. Es la que usan las hojas donde
 * lo escaso es el alto —la ventana y la hoja se comen el sitio del mástil— y
 * no tiene sentido de pie.
 */
export const PHONE_LANDSCAPE_MQ = '(max-width: 1180px) and (max-height: 560px)';

/**
 * Se pregunta cada vez y no se cachea: girar el teléfono cambia la respuesta,
 * y lo que la consulta —el `wm`— decide en el gesto, no al arrancar.
 */
export const isPhone = (): boolean => matchMedia(PHONE_MQ).matches;
