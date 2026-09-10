# ORCA · Detener agentes desde menú contextual

`STOP…` en el menú del agente (canvas, selección y menú de ventana) abre una
confirmación con callsign, estado, motivo editable y explicación de conservación
de conversación. El botón STOP de la ventana usa la misma confirmación.
CANCEL y Escape no envían nada. Durante el envío se bloquea una segunda orden;
el resultado distingue acuse del collector y error/timeout. Un acuse no afirma
que el proceso ya terminó: el collector puede tardar seis segundos en cerrar
el pane. La sesión terminada se continúa mediante RESUME.

La regla compartida muestra por qué no se puede parar: CAPCOM, sesión terminada,
subagente, lead asignado a una misión activa, incluso archivada (directamente o por squad),
y sesión sin pane hospedado ni background de Claude direccionable. Un pane
hospedado sí admite stop aunque `background` sea false, igual que el collector;
un `shortId` de Claude también es direccionable. Sin enlace tampoco se confirma.
Se revalida al cambiar el mundo y al confirmar, y el hub comprueba de nuevo la
regla antes de retirar al agente del libro de presupuesto.

La orden sigue siendo `{ k: 'stop', agentId, reason }`, la vía de `stop_agent`.
El motivo ahora viaja desde esa tool y queda en el registro de comandos del hub;
la consola muestra el resultado con motivo en su telemetría. Todas las órdenes
stop procedentes de una consola respetan la regla, incluso las antiguas sin
motivo. Los stops internos sin motivo (presupuestos, aparcado y parada de squad)
conservan su política existente. No se han rediseñado las confirmaciones masivas.
No se envía remove ni archive y no se borra ninguna transcripción. FORGE no se
ha modificado en esta misión.

## Verificación

- `npm run typecheck`: correcto.
- `npm test -- agent-stop`: 3/3 checks correctos en la revisión final; regla de elegibilidad, frontera del hub y tool,
  cancelación, ambos menús, motivo vacío, desconexión, único envío, acuse y
  timeout. Hub temporal sin collector real y transporte de navegador simulado.
- Capturas inspeccionadas: `test/shots/agent-stop-desktop.png` y
  `test/shots/agent-stop-mobile.png`; sin desbordamiento horizontal.
- Detector Impeccable de los cuatro archivos UI afectados: sin hallazgos.
- `npm test -- --changed`: 68 suites, 853/853 checks correctos sobre el árbol
  compartido. Incluye cambios previos de otras misiones.
- `npm test -- agent-stop hub`: 4 suites, 35/35 checks correctos tras reforzar
  la guarda para consolas que omiten el motivo.

La nueva prueba ejercita los menús de canvas y ventana y el diálogo compartido;
no monta la ventana completa de conversación (`windows/kinds/agent.ts`). Ese
archivo sigue figurando como «sin suite que los cubra» en el selector. Su conexión
del botón y su actualización de estado se revisaron en código. No se ha probado
una parada o reanudación sobre agentes reales.

Filtros: `agent-stop hub commands interrupt park budgets`.
