# CAPCOM · Feedback visual de carga y relanzamiento

La consola separa tres hechos: el enlace con el hub, la actividad observada de
CAPCOM y el recibo de un mensaje. Enviar no enciende «procesando»; recibir un
acuse no confirma una respuesta. Una espera entre agentes es azul y el ámbar
queda para una petición a la persona.

## Contratos inspeccionados

- `shared/capcom.ts`: `capcomOf` selecciona la misma sesión que el routing;
  `capcomTurn` deriva la actividad. No se duplicó la selección de CAPCOM.
- `ui/net/client.ts` y `ui/store.ts`: `link` confirma una trama del hub,
  `auth` distingue credenciales rechazadas; el cliente ya reconecta con espera
  creciente. `world`, `agents`, `talk`, `ceo` y `delivery` repintan la consola.
- `OutgoingMessage`: sending, accepted, delivered y failed son estados de
  entrega. `pendingEchoes` y `echoLanded` retiran el eco cuando el transcript
  lo confirma. Un timeout sigue siendo entrega sin confirmar, incluso si el
  agente trabaja por otra causa.
- `ModelControl`: queued/applying/ready/failed describe el cambio de modelo.
  `ProviderHandoffPlan`: review/preparing/complete/failed describe el relevo.
  El recibo de `capcom:new` en el mismo proveedor no es un plan de handoff.
- `CapcomHandoff` es el acta de un cambio ya ocurrido; `metrics.compactions`
  es un contador histórico, sin fase de compactación en curso. Los textos
  de espera y eventos del transcript conservan su contenido; no se analizan
  como si fueran un protocolo de progreso.

## Comportamiento

`ui/windows/capcom-feedback.ts` deriva estados de presentación sin mutar el
mundo: CONNECTING, RECONNECTING, STARTING, THINKING/PROCESSING, CHANGING SESSION,
CHECKING SESSION, CHANGING MODEL/MODEL CHANGE QUEUED, READY, WAITING ON AGENT,
WAITING ON YOU y errores de acceso, sesión o cambio. Sin sesión activa se dice
NO ACTIVE SESSION; una ausencia no prueba un fallo ni un relanzamiento.

La ventana conserva el transcript y el borrador durante la desconexión,
deshabilita SEND y oculta el caudal y las filas de actividad en vivo antiguas.
Al volver el enlace se recalcula el estado sin recargar ni reenviar mensajes.
La banda de velocidad exige trabajo observado: un relevo no tiene porcentaje
ni caudal inventado. Un bloque cambia de contenido incluso cuando conserva
el estado genérico `blocked`.

La barra de comandos usa la misma derivación de actividad/conexión. Los
planes locales del selector de modelo se muestran en la ventana CAPCOM;
no se inventó un contrato global para propagarlos a la barra.

El seguimiento de handoff reintenta únicamente consultas de lectura. Conserva
la referencia guardada si falla una consulta, funciona durante el hueco sin
sesión activa y elimina el error transitorio cuando vuelve una respuesta.
Las restauraciones fallidas se espacian al menos dos segundos. Si la referencia
ya no se puede recuperar, DISMISS SAVED STATUS permite dejar de seguir ese
recibo local; no cancela ni reenvía el cambio de sesión. El panel sigue visible
durante el hueco y no inventa el proveedor de una sesión ausente.

## Accesibilidad y límites

Estado y entrega tienen regiones `role=status`, `aria-live=polite` y
`aria-atomic=true`. El campo describe su disponibilidad mediante
`aria-describedby`. El estado no se vuelve a anunciar por cada segundo o
actualización de métricas. Los controles conservan semántica nativa y el
borrador permanece editable. Los mensajes usan texto y color; las nuevas
franjas no animan y el arnés verifica movimiento reducido.

No se cambiaron compactación, relanzamiento, routing ni el protocolo de red.
No se puede afirmar «compactando» ni estimar el progreso con estos contratos.
READY significa sesión observada ociosa, no salud del proveedor ni recepción
de una instrucción concreta. La reconexión representa el enlace del hub, no
un diagnóstico de la conectividad individual de cada collector. No se envían
automáticamente otra vez mensajes cuya entrega quedó incierta.

No se probaron sesiones reales, cuotas, proveedores ni lectores de pantalla
reales. Las pruebas de navegador montan Vite sin configuración/proxy del
proyecto y sustituyen los comandos con respuestas sintéticas. Las capturas
son inspección visual, no comparación automática contra goldens.

## Verificación

La fixture usa `pane: true`, conforme al contrato booleano de `Agent.pane`.
La primera comprobación detectó el valor string incorrecto y se corrigió.
Resultado final: `npm run typecheck` correcto; `npm test -- --changed`
seleccionó 69 suites y pasó 878/878 comprobaciones. Tras los últimos ajustes,
los filtros `capcom-feedback capcom-window model-control capcom-new` pasaron
74/74, incluidas las 23 pruebas nuevas de derivación. Ambos recorridos
visuales indicados abajo pasaron; se inspeccionaron las capturas de escritorio
y móvil y se corrigió el bloque de espera obsoleto detectado en la primera
inspección. `git diff --check` también terminó sin errores.

`--changed` incluye el trabajo concurrente que ya estaba en este árbol. Su
aviso «sin suite que los cubra» incluye CSS, la barra de comandos, documentos
y fixtures visuales: el selector de suites unitarias no ejecuta los recorridos
visuales. Los cambios de esta entrega en esas superficies se revisan mediante
los dos recorridos indicados abajo; el HUD se monta y comprueba con los comandos
del recorrido existente, pero no tiene una prueba DOM específica de desconexión.
Los documentos no tienen prueba automática.
El detector de diseño solo señaló dos bordes preexistentes de 3px en
`window.css`, fuera de este cambio; las nuevas franjas usan los tokens existentes.

Filtros que cubren esta entrega:

- `npm run typecheck`
- `npm test -- --changed`
- `npm test -- capcom-feedback capcom-window model-control capcom-new`
- `npx tsx test/capcom-feedback.visual.ts` — conexión, entrega, errores,
  recuperación, handoff, borrador, regiones accesibles, escritorio y móvil.
- `npx tsx test/capcom-new.visual.ts` — recibo en el sitio, planes entre
  proveedores, fallo/reintento, controles, comandos y borrador.
