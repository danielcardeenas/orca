# Escala de ventanas de agente y recuperación desde la bandeja

Las ventanas que se abren desde agentes usan una escala fija de 320 píxeles
de contenido por unidad del campo. Una ventana de 640 píxeles ocupa dos
unidades, tanto si se abre cerca como si se abre lejos. Su posición inicial
se calcula junto al agente en coordenadas del mundo, sin capturar el zoom
que había al pulsar. CAPCOM abierto desde su agente usa esa misma referencia.
El redimensionado manual sigue siendo la decisión del operador.

La bandeja abre o minimiza. Recuperar una ventana conserva su modo canvas,
front o fixed; una ventana lejana del canvas se encuadra con un vuelo de
cámara hacia sus propios límites, reservando espacio para la barra superior
y la inferior. Una ventana ya visible no provoca otro vuelo al restaurarse.
FRONT/CANVAS sigue siendo una acción explícita de la cabecera.

Pulsar un agente abre su ventana; volver a pulsarlo la cierra. Si estaba
minimizada, la recupera. El evento nativo `dblclick` no añade una tercera
apertura después de los dos clics. El selector de teclado usa la misma
recuperación en el modo existente que la bandeja.

## Verificación

- `npm run typecheck`: correcto en la comprobación final. Una corrida anterior
  detectó errores transitorios en `src/ui/hud/improve.ts`, fuera de esta
  entrega; desaparecieron sin editar ese archivo.
- `npm test -- --changed`: 1.041/1.041 comprobaciones correctas. Incluye los
  cambios previos que ya existen en el árbol compartido.
- `npm test -- window-canvas visual-ports`: 13/13 correctas. La prueba de
  navegador cubre la escala y posición al abrir lejos/cerca, abrir/cerrar
  desde el origen, recuperación con vuelo, minimizar/restaurar sin cambiar
  de modo y conservación del contenido.
- `npm run visual -- console --isolated`: verifica los clics abrir/cerrar,
  el doble clic sin tercera apertura, el vuelo real al recuperar desde la
  bandeja y la minimización posterior conservando canvas. Capturas:
  `test/shots/field-03-agent.png` y `field-03-agent-located.png`.
  La escena de lasso queda omitida: el gesto no seleccionó varios agentes.
  Las corridas anteriores encontraron agentes que cambiaban o salían del
  campo durante la prueba; la comprobación sigue ahora la identidad del
  agente abierto y consulta su posición antes de cada clic.
- El detector de Impeccable no encontró incidencias en los archivos de UI
  modificados en esta entrega.

El aviso de suites sin cobertura incluye `main.ts`, la ayuda y la documentación;
la prueba del gestor usa callbacks de cámara simulados. La interacción del
campo real se revisa adicionalmente en el arnés visual. El arnés usa la
proyección real del agente para pulsarlo, en lugar de estimar su posición
a partir de la tipografía de su etiqueta.

Filtros que cubren esta entrega: `window-canvas`, `visual-ports`.
Arnés visual: `console --isolated`.
