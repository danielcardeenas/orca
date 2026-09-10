# FORGE — coordinación de automejoras

FORGE es un líder especializado por propuesta aprobada. Absorbe la gestión
operativa que antes recaía en el implementador genérico o en CAPCOM. CAPCOM
conserva revisión final, decisiones de seguridad, cierre de misión y publicación;
la aprobación del alcance sigue siendo un gesto humano en AUTOMEJORA.

## Arquitectura inspeccionada y decisión

- `shared/improve.ts`, `hub/improve.ts`: propuestas, revisiones, deduplicación,
  reloj, presupuesto del revisor y selección de proyecto/runtime/modelo.
- `hub/server.ts`: `improve:send` procede de la consola autenticada; el reloj
  y las herramientas de agentes no tienen una operación de aprobación.
- `shared/missions.ts`, `hub/missions.ts`, `hub/wake.ts`: asignación, linaje,
  recepción de informes, deuda de CAPCOM, detección de silencio y aviso al líder.
- `collector/briefs.ts`, `collector/spawns.ts`: miembros subordinados, buzón,
  límites de crecimiento y recuperación de incidentes.
- `ui/hud/improve.ts`, ventanas de misión, tripulación y `DESIGN.md`: aprobación,
  enlace a misión, conversación con el líder, estado y navegación al campo.
- `hub/publisher.ts`: publicación automática al terminar workers; FORGE y sus
  miembros quedan excluidos de ese disparador.

No se introduce un daemon permanente, otra cola, otro rol de agente ni una
máquina de estados. Cada propuesta tiene un `missionId`; cada misión conserva
`active | completed | failed`, `squads`, `agentIds`, mensajes y dispatches.
El prefijo reservado `forge-` identifica la política de un squad, incluidos
sus miembros, sin migrar sesiones o propuestas existentes. Los squads antiguos
`auto-…` conservan su comportamiento.

## Flujo y responsables

| Paso | Responsable | Registro o contrato existente |
| --- | --- | --- |
| Propuesta | Revisor sin herramientas de edición | Propuesta con evidencia o hipótesis |
| Aprobación | Operador, botón IMPLEMENT | `improve:send`, propuesta `sent`, `missionId`, evento en conversación |
| Asignación | Hub y líder FORGE | Misión y squad vinculados antes del spawn; líder sin padre CAPCOM |
| Seguimiento | FORGE | Buzón del squad, agentes, tripulación y dispatches |
| Bloqueos | FORGE; CAPCOM para autoridad insuficiente | Avisos de miembros, incidentes de recuperación, permisos y `missionStall` |
| Verificación | FORGE sobre el trabajo consolidado | Informe con comandos, resultados, archivos, cobertura y límites |
| Informe y cierre | FORGE informa; CAPCOM revisa y decide | Último mensaje del líder entra como `agent`; CAPCOM usa `report_mission` |
| Reflejo en el tablero | Hub, al cambiar la misión | `ImproveStore.syncMission`: la propuesta pasa a `completed` al cerrarse la misión y a `archived` al archivarla, y vuelve si la misión vuelve |

FORGE descompone por archivos y dependencias, delega sólo tareas acotadas, lee
los resultados antes de decidir e inspecciona el trabajo de miembros que
terminan sin escribir. El footer existente proporciona `orca-tell`, `orca-read`
y recuperación de cuotas. Los informes de miembros con líder vivo no se
publican individualmente en la misión. Si el líder muere, la infraestructura
existente devuelve visibilidad a CAPCOM; FORGE no añade reintentos autónomos.

La aprobación inicial se registra como evento de sistema: es una pulsación,
no una pregunta sin responder dirigida a CAPCOM. Esto evita los recordatorios
operativos de `missionDebt`. Un resultado del líder sí crea deuda de informe.
Los mensajes posteriores del humano siguen el enrutamiento existente al líder
vivo o, en su ausencia, a CAPCOM.

## Fronteras de seguridad

`dispatchForge` sólo integra la puerta existente de consola. Rechaza propuesta
ya enviada, estado no abierto, id inválido o misión ya existente antes de crear
trabajo. Reserva el vínculo y squad sin ceder ejecución antes de lanzar: dos
clics concurrentes no crean dos líderes. Una propuesta pospuesta vencida puede
aprobarse; una descartada requiere REOPEN.

Líder y descendientes creados por `orca-spawn` usan `permissionMode: auto`
para ejecución rutinaria dentro del alcance aprobado. El collector impone
la pertenencia del hijo al squad del padre. El publicador ignora la terminación
de cualquier agente `forge-…`; terminar no publica, no fusiona y no cambia el
estado final de la misión. CAPCOM decide la revisión y publicación por sus vías
habituales. La política general de publicación de otros squads permanece.

La política común de `shared/forge.ts` llega al brief inicial del líder y al
footer que el collector añade a líderes y miembros, aunque la tarea delegada
omita las restricciones. Autoriza lecturas, búsquedas locales, typecheck, tests
y cambios dentro del worktree/proyecto asignado sin preguntar de nuevo.

Antes de borrado, detención de procesos o recarga de servicios, deploy,
publicación/push/merge, acceso o exposición de secretos, red externa, salida
del worktree/proyecto (también mediante symlinks), cambios de permisos o una
acción ambigua, se pausa esa acción y se escala. Un script llamado test no es
rutinario si sus efectos cruzan estas fronteras. El miembro usa `orca-tell`
hacia su líder; el líder usa `orca-ask`, que llega al circuito existente de
CAPCOM (cola humana si CAPCOM no está disponible). El líder no se concede esa
autoridad: informa acción, destino, efectos y aprobación necesaria, y continúa
trabajo rutinario independiente mientras espera. No se auto-responden ni se
suprimen escalaciones nativas por pertenecer a FORGE.

La autorización de ejecución no autoriza publicación. La exclusión de
`publisher.finishedOwnWork` depende del squad, no de `permissionMode`; CAPCOM
conserva revisión, cierre y publicación. El brief prohíbe publicar, desplegar,
fusionar, recargar servicios, aprobar ampliaciones, saltar permisos y ejecutar
acciones destructivas por iniciativa propia. Exige aislamiento
antes de editar, datos sintéticos y stores temporales, y propagar estas
restricciones a miembros. Son instrucciones de operación, **no una sandbox
nueva que demuestre la inocuidad de cualquier comando**. No hay un clasificador de comandos ni una nueva barrera de ejecución.
En la implementación actual, Claude recibe `--permission-mode auto`; Codex
traduce `auto` a `--dangerously-bypass-approvals-and-sandbox`, salvo
`ORCA_CODEX_APPROVALS=1`, que conserva `on-request` y `workspace-write`.
Por ello las fronteras elevadas dependen de que el agente siga el brief;
no se garantiza que el runtime intercepte una infracción. Se conserva esa
traducción global y el tratamiento de prompts nativos pendientes. No se añaden credenciales
ni capacidades CAPCOM a FORGE.

## Fallos y límites

- Un lanzamiento rechazado o con recibo incierto deja misión activa, propuesta
  enlazada y causa legible. No se reenvía automáticamente: CAPCOM debe inspeccionar
  el squad y agentes tardíos antes de recuperar. Reiniciar el hub conserva el
  vínculo; no vuelve a lanzar FORGE.
- Los stores de propuestas y misiones guardan por separado. No hay transacción
  entre ficheros: un fallo de disco entre escrituras requiere reconciliación
  manual. No se promete atomicidad frente a un crash en ese intervalo.
- El worktree automático sigue dependiendo de `ORCA_WORKTREES`. Si está apagado,
  FORGE debe crear/verificar aislamiento antes de editar. La selección de proyecto,
  runtime y modelo sigue siendo la de automejora; no se añade un presupuesto
  global FORGE. Siguen vigentes los límites y controles de agentes/squads.
- Verificación es evidencia revisada por el líder y finalmente CAPCOM, no un
  booleano inferido de `done`. Los tests cubren los contratos, no la calidad de
  futuras decisiones de un modelo ni la ejecución real de todos los proveedores.
- No hay UI nueva: IMPLEMENT, OPEN MISSION, tripulación, conversación, feed y
  estados actuales muestran el recorrido. No se reetiquetan agentes reales.

## Archivos de implementación

- `src/hub/forge.ts`: aprobación recibida, validación, reserva, lanzamiento y
  constancia de fallos; `src/hub/server.ts` conecta la puerta de consola y feed.
- `src/shared/forge.ts`: identidad de squad; `src/shared/improve.ts`: nombre
  estable y brief especializado con el flujo y sus límites.
- `src/hub/improve.ts`: lanzamiento FORGE con permisos auto;
  `src/collector/spawns.ts`: misma postura para los hijos.
- `src/hub/publisher.ts`: exclusión de publicación automática por terminación.
- `test/forge.test.ts`, `test/improve-agent.test.ts`: fronteras e integración.
- `DESIGN.md`, `docs/AUTOMEJORA.md` y este documento: contrato y recorrido.

La verificación de la política auto está en
[ENTREGA-FORGE-PERMISOS-2026-09-10](ENTREGA-FORGE-PERMISOS-2026-09-10.md).

## Verificación de la entrega inicial (anterior a la política auto)

Las pruebas nuevas usan directorios temporales y una máquina sintética contra
un hub efímero. Cubren doble envío concurrente, reserva anterior al ack,
colisión de misión, rechazo de propuesta descartada, persistencia del fallo,
excepción del transporte, deuda de CAPCOM, permisos de miembros y exclusión de
publicación. La prueba de integración recorre consola → spawn → líder → informe
sin cierre automático. No se lanzaron ni modificaron sesiones reales para probar.

Resultados del 2026-09-10:

- `npm run typecheck`: correcto, sin diagnósticos.
- `npm test -- forge`: 8/8; la primera corrida descubrió una fixture sin
  hipótesis válida, corregida antes de la verificación final.
- `npm test -- --changed`: **846/846**, 66 suites. Incluye integración FORGE,
  automejora, misiones, wake, permisos, spawns y publisher, además de suites
  alcanzadas por modificaciones preexistentes del árbol compartido.
- `git diff --check`: correcto.
- No se ejecutó el arnés visual: esta entrega reutiliza la UI existente sin
  modificar su implementación. Las pruebas no evalúan visualmente los textos.

El selector avisó de falta de suites para `DESIGN.md`, `docs/AUTOMEJORA.md` y
los archivos preexistentes ajenos a FORGE: `README.md`, `bin/orca.mjs`,
`docs/ENTREGA-VENTANAS-CANVAS-2026-09-09.md`, `src/ui/styles/hud.css`,
`src/ui/windows/kinds/misc.ts`, `docs/ENTREGA-APARCAR-OCIOSOS-2026-09-10.md` y
`docs/ENTREGA-VENTANAS-CONTROL-2026-09-10.md`. Este documento tampoco tiene
una suite de contenido. Ningún archivo de código añadido o modificado por
FORGE quedó sin alcanzar por las suites seleccionadas. Se conservaron los
cambios ajenos; no se publicó, desplegó ni modificó una sesión real para probar.

Filtros de cobertura: `forge`, `improve`, `missions`, `mission-stall`, `wake`, `spawns`, `publisher`.
