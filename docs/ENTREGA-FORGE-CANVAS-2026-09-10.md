# FORGE · Visualización en el canvas

FORGE se identifica en el tile del lead real del squad `forge-*`, a la escala
de CAPCOM y fuera del marco del proyecto ORCA (o del proyecto donde trabaje).
Se coloca junto al borde derecho de ORCA, separado de CAPCOM; varias
instancias se distribuyen con espacio vertical para sus tiles y rótulos.
Un pipe violeta de afiliación une el perímetro del proyecto al lead real,
además de los pipes existentes hacia sus agentes. ORCA se identifica por el
slug del proyecto; si falta su región se usa la del lead y, sin ninguna región
disponible, no se inventa una.
El rótulo permanente `FORGE · LEAD <callsign> · <actividad>` hace explícita
su identidad y abre al lead con ratón o teclado. No se crea
un agente ficticio, otro rol, una misión adicional ni estado persistente.
El tile conserva callsign, selección, arrastre, apertura y zoom. Sus pipes de
parentesco y de squad conectan al lead con los subordinados, incluidos miembros
sin `parentId` al lead. El roster y el sigilo siguen siendo los del squad.

## Datos y decisiones

`src/ui/field/forge.ts` deriva una presentación por lead a partir de agentes,
`missionLeadOf`, `missionDebt` y `squadsOf`. Una misión activa y no archivada
identifica al FORGE activo. Si varias misiones comparten lead, se presenta la
actualizada más recientemente. No se adivina una misión a partir de su título.

El rótulo del lead muestra FORGE incluso antes de que los tiles sean legibles;
se mantiene dentro del ancho de pantalla en móvil. El rótulo del squad muestra FORGE y su actividad incluso antes de que los tiles
sean legibles. El tile muestra FORGE, el callsign real y la actividad desde el
segundo nivel de texto. Precedencia de la actividad:

1. `BLOCKED`: algún miembro está bloqueado. El color real del agente conserva
   la distinción existente entre espera de un par y atención humana.
2. `VERIFYING`: algún miembro está trabajando en una herramienta de ejecución
   cuyo detalle contiene un comando reconocido de test, typecheck, visual o
   build. Significa ejecución observada; no certifica que haya pasado.
3. `WORKING`: algún miembro está trabajando.
4. `WAITING CAPCOM`: hay resultados de agentes posteriores al último reporte
   de CAPCOM, calculados por `missionDebt`, y nadie trabaja ni está bloqueado.
5. `WAITING`: misión activa sin las señales anteriores.
6. `INACTIVE`: no hay misión activa vinculada, se cerró, falló, archivó o purgó.

La identidad activa reutiliza el contorno y sigilo violetas de AUTOMEJORA. La
textura de runtime (Claude/Codex/Grok/otro) y el color real del agente se
conservan. Al cerrar se retira la marca violeta; el tile histórico queda
identificado como FORGE inactivo hasta que el agente desaparezca de la flota.

## Implementación

- `src/ui/field/forge.ts`: derivación pura, sin mutación de datos ni temporizadores.
- `src/ui/field/layout.ts`: lead externo, misma escala y separación que CAPCOM;
  respeta posiciones manuales y conserva `leadId` y conteo completo del squad.
- `src/ui/field/field.ts`: cálculo por feed, rótulo y datos para labels.
- `src/ui/field/labels.ts`: identidad y actividad en las bandas existentes,
  incluidas en la firma que evita reconstruir DOM innecesariamente.
- `src/ui/field/swarm.ts`: reutilización de la marca violeta en el shader
  instanciado, conservando la textura de runtime.
- `src/ui/main.ts`: eventos de misión también invalidan el campo.

El botón del rótulo evita que el canvas capture su pulsación; la rueda conserva
el zoom habitual. No hay nuevas capas WebGL, draw calls o bucles de animación
para FORGE. La derivación se calcula por actualización del mundo,
no por fotograma. El replay utiliza las misiones de su propio snapshot.

## Límites

Sin lead observado no se fabrica un nodo provisional: se conserva la
representación habitual del squad si hay miembros. Una asociación todavía no
recibida se presenta inactiva hasta el siguiente feed. Verificaciones con
comandos desconocidos o detalle ausente se muestran como trabajo normal.
Esperar a CAPCOM no implica aprobación ni cierre. Si el squad está trabajando
y a la vez debe un resultado a CAPCOM, prima el trabajo; el detalle de misión
conserva la deuda completa. No se han cambiado aprobación, publicación ni
permisos de FORGE, ni desplegado el resultado.

Los leads históricos conservan su tile especial mientras existan. Varios
squads FORGE producen un tile por lead real, nunca un singleton ficticio.
Los fixtures marcados como arnés permanecen dentro de su recinto. En deck,
FORGE usa la misma cuadrícula que los demás y vuelve a su posición al salir;
una posición fijada por el operador prevalece sobre la separación automática.
Arrastrar el proyecto no arrastra al lead externo. Los enlaces siguen usando
parentesco y líder canónico de `squadsOf`, sin duplicar el pipe lead→hijo.
Los pipes del lead externo entran al proyecto por sus márgenes y gutters,
para no atravesar los tiles de otros subordinados.

## Verificación

La selección `--changed` del árbol compartido incluye suites ajenas que crean
sesiones tmux, barren procesos de otros arneses o usan persistencia global.
Se restringe a filtros seguros para cumplir la prohibición de sesiones reales.
Las pruebas de navegador usan Vite local y datos sintéticos, sin hub.

El aviso `sin suite que los cubra` incluye documentación, CSS y cambios previos
ajenos a esta entrega. `field.css` sí se carga mediante URL en el fixture
`forge-field` (el grafo estático no detecta ese enlace). No se certifican aquí
los cambios previos de main, HUD, ventanas o backend fuera de los filtros.

`npm run typecheck`: correcto. Integración con
`npm test -- --changed forge-field.test forge-layout.test forge-view.test layout.test minimap.test window-canvas.test commands.test`:
29/29 comprobaciones correctas. Incluye actividad, derivación sin mutaciones,
lead único, proximidad a ORCA, instancias múltiples, aislamiento del arnés,
pins, deck, selección, zoom y activación del rótulo por ratón y teclado.
Capturas de escritorio y móvil inspeccionadas en `test/shots/forge-*.png`.
El ajuste final de prioridad ORCA frente al proyecto del lead y tolerancia de
coordenadas incorpora una prueba adicional: typecheck correcto y
`npm test -- --changed forge-field.test forge-layout.test layout.test`,
15/15 correctas. `git diff --check` también correcto.
Tras ajustar el recorrido de pipes por los gutters: typecheck correcto y
`npm test -- --changed forge-field.test`, 1/1 correcto.

Filtros de cobertura: `forge-field.test`, `forge-layout.test`, `forge-view.test`,
`layout.test`, `commands.test`, `minimap.test`, `window-canvas.test`.
