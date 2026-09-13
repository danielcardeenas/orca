# CAPCOM: relevo de runtime y bloqueo por cuota

## Incidente observado el 6 de septiembre de 2026

Claude Code 2.1.263 dejó a CAPCOM vivo después de un error a las 05:59:55 UTC.
El JSONL contiene `isApiErrorMessage: true`, `error: "rate_limit"` y
`apiErrorStatus: 429`. El pedido de higiene (disco, CPU, RAM y acceso MCP)
no fue atendido. Vigilar exclusivamente muerte del proceso no detecta este caso.
Otros workers compartían el límite; algunos habían terminado. No corresponde
relanzarlos todos ni inferir que el trabajo parcial se perdió.

Antes de modificar código se copiaron todos los transcripts disponibles del
proyecto Claude de CAPCOM, incluidos subagentes, y el estado de ~/.orca. El
manifiesto registra 118 archivos, 42.591.925 bytes y sus SHA-256, verificados.
La copia privada está en `.orca/backups/capcom-20260906T061705Z`; queda ignorada
por git y contiene estado sensible. `.orca/recovery/conversation.md` reúne
336 mensajes de texto. Es una vista auxiliar: las llamadas y resultados completos
siguen en los JSONL originales. No se promete recuperar contenido que el CLI
nunca escribió ni transferir literalmente el contexto interno de Claude a Codex.

## Recuperación implementada

La sesión Codex se prepara primero con el modelo solicitado (`gpt-6-astra`), el
historial íntegro disponible, el handoff de obligaciones y consultas MCP de
lectura. Sólo después de comprobar modelo y MCP se retira el coordinador anterior.
Los workers conservan sus procesos y cambios.

`~/.orca/capcom/codex-recovery.json` selecciona explícitamente una sesión Codex
YA preparada, mediante `sessionId` (UUID) y `model`. CAPCOM la adopta si está viva
o ejecuta `codex resume <sessionId>` dentro de tmux. Conserva la misma identidad,
MCP autenticado, instrucciones actuales en AGENTS.md, sandbox workspace-write,
revisión automática de aprobaciones de shell y herramientas del MCP orca
preaprobadas, igual que la autoridad del coordinador anterior.

La configuración inválida falla cerrada: nunca se interpreta un id de Claude
como Codex ni se vuelve silenciosamente a Claude. Se mantiene el límite de cinco
reinicios por hora. Esta ruta es una recuperación de sesión preparada, no un
selector general ni una implementación de rotación entre proveedores. La
rotación automática a una sesión vacía queda desactivada para este modo; requiere
preparar otro relevo. No hay fallback automático ni migración de workers.

El parser de Claude ahora clasifica los mensajes sintéticos de error API como
`blocked` / `block.kind: error`. Conserva modelo y métricas reales, muestra la
causa y sólo limpia el fallo al recibir una respuesta válida del modelo.
No infiere una hora de recuperación de un 429: puede significar cuota, una
ventana temporal u otro límite. La prevención de envíos a un proveedor agotado
y una cola durable de reintentos quedan pendientes.

## Diseño recomendado para el producto

Un CAPCOM lógico por flota con runtime/modelo seleccionables y una sola sesión
con autoridad de escritura. Los proveedores son ejecutores intercambiables;
las conversaciones, instrucciones del operador, obligaciones y resultados
pertenecen a Orca. Un CAPCOM por modelo fragmentaría esa autoridad y podría
repetir despachos o dar instrucciones contradictorias.

El dropdown debería elegir runtime + modelo y mostrar su disponibilidad, el
motivo del bloqueo y el reset cuando sea conocido. Un cambio dentro del mismo
runtime puede ser un cambio de modelo; cambiar de CLI exige un relevo explícito.
Para ese relevo: guardar snapshot y posiciones del registro, preparar candidato,
validar MCP y reconstrucción de pendientes, transferir una concesión exclusiva
con número de generación, y por último liberar los mensajes retenidos. Rechazar
escrituras de generaciones antiguas. Si falla la preparación, conservar la sesión
y el respaldo anteriores; no activar un coordinador que no pasó el chequeo.

El registro canónico debe ser append-only y durable, incluyendo GENERAL, no
sólo tareas creadas con NEW TASK. Los límites actuales (100 mensajes por tarea,
300 bloques de talk en memoria) son límites de presentación, no deben definir
retención del archivo. Mantener por separado el resumen operativo y las
referencias a evidencia íntegra. Registrar ids de entregas y resultados, estados
`queued/delivered/acknowledged/completed`, y reconciliar antes de reintentar para
no repetir efectos cuando el CLI se bloquea después de ejecutar una herramienta.

La salud necesita dos dimensiones: proceso vivo y capacidad para avanzar.
Normalizar señales por proveedor/cuenta/modelo: límite temporal, cuota agotada,
autenticación, red, permisos y caída. Una pausa sin progreso por sí sola no prueba
falta de créditos. Circuit breaker por cuenta/cuota, reintentos acotados con
backoff para fallos temporales, reset cuando exista y una alerta agrupada con
los workers afectados. No consumir créditos extra ni cambiar automáticamente
a un proveedor con cobro distinto sin política previa del operador.

Señales oficiales disponibles:

- Claude Code: hook `StopFailure`, con `error` como `rate_limit`, `billing_error`,
  `authentication_failed`, etc. Además, el incidente ya entrega error estructurado
  en el transcript de la versión instalada. [Hooks](https://code.claude.com/docs/en/hooks).
- Codex App Server: `account/rateLimits/read`, `account/rateLimits/updated`,
  `usedPercent`, `resetsAt` y detalles de créditos cuando están disponibles;
  errores de turno con `UsageLimitExceeded`. La integración TUI/JSONL actual no
  recibe por sí sola todas las notificaciones de App Server.
  [App Server](https://developers.openai.com/codex/app-server).

Validación: `test/capcom-recovery.test.ts` cubre adopción, reanudación en tmux,
configuración inválida, retención de identidad, límite de reinicios, guardia de
rotación y el error de cuota observado. La preparación real verificó acceso a
`gpt-6-astra`, lectura de los 336 mensajes, manifiesto y consultas al MCP.

Resultado de activación: sesión `01a07569-fdc3-75a1-88ed-8180be4b44b5`, Codex
CLI 0.153.4, `gpt-6-astra`. Primera respuesta interactiva y consulta `briefing`
comprobadas a las 06:45 UTC. El diálogo inicial de confianza del directorio fue
aceptado durante la activación. `--approve-for-me` implica workspace-write y
no acepta un `--sandbox` adicional; la prueba de argv conserva esta restricción.

Resultados de pruebas: cuatro pruebas nuevas de recuperación pasan; las suites
CAPCOM previas también pasan y TypeScript no reporta errores. Suite general:
577/580, con fallos en `orca archive --dry-run` y dos pruebas del watermark en
`wake.test.ts`. El log completo permanece en `.orca/recovery/tests.log`. Esos
frentes siguen pendientes de revisión dentro de las entregas previas; no se
presenta la suite general como verde ni el relevo como migración de los workers.

## Indicador y conocimiento del relevo

GENERAL · TALK muestra ahora un aviso persistente `SESSION CHANGED` sobre el
transcript activo: modelos anterior y nuevo, hora, causa y botones para abrir
la conversación anterior y el checkpoint de pendientes. Explica que el archivo
anterior se conserva separado y no se ha incorporado al transcript visible.
EVENTS conserva los relevos cronológicamente, incluso sin coordinador vivo.
Los mensajes informativos del relevo se etiquetan ORCA, no YOU.

El collector publica el relevo en `capcom:handoff` durante la resincronización,
leyendo la configuración de recuperación. La metadata adicional es `reason`
(`usage_limit`, `manual`, `context_rotation` o `unknown`), `previousRuntime`,
`previousModel`, `historyPath` y `checkpointPath`. Las configuraciones antiguas
sin `reason` deben anotarse explícitamente; no se adivina la causa.

El hub valida la máquina propietaria y la sesión CAPCOM destino. Guarda el evento
antes de publicarlo en `~/.orca/hub/capcom-handoffs.jsonl`, con identidad estable
por par de sesiones. Los reenvíos y reconexiones no crean eventos ni notificaciones
duplicados. Este registro es independiente de los límites de los transcripts
en memoria y de ceo.jsonl; el estado inicial de la consola lo recupera al arrancar.

Al registrar un relevo nuevo se intenta entregar a CAPCOM una explicación
informativa con las rutas de recuperación. `briefing` incluye siempre los
últimos tres relevos, aunque ya hayan sido consultados, así que compactar o
reiniciar no borra ese conocimiento accesible. La entrega inmediata es best-effort;
el registro y la consulta MCP son persistentes. El aviso no marca tareas
completadas ni inicia reintentos de workers.

Comprobado con pruebas de persistencia, replay, validación de metadata, rutas de
chat/feed/MCP y con navegador en escritorio y móvil: botones, teclado, borrador,
EVENTS y recarga. El evento real de Fable → gpt-6-astra quedó publicado y CAPCOM
confirmó haber recibido las referencias.

## Cambiar de modelo conservando la sesión

El control `CHANGE MODEL`, encima del mensaje de CAPCOM, consulta el menú nativo
del CLI y ofrece sus modelos con búsqueda. El modelo activo se muestra separado
del solicitado. La primera consulta necesita que el CLI esté esperando entrada;
una vez cargado el catálogo se puede elegir mientras trabaja. El cambio queda
pendiente en el collector hasta que termine el turno y puede cancelarse.

Se conserva el identificador de sesión: no hay resume, fork ni prompt de relevo.
Codex 0.153.4 requiere abrir `/model`, seleccionar la fila y confirmar el nivel de
razonamiento que presenta su menú. `/model nombre` en esta versión se interpreta
como un mensaje normal: el controlador nunca lo usa. Claude Code 2.1.263 utiliza
`s` para aplicar únicamente a esta sesión, sin cambiar el predeterminado global.
Codex sigue la semántica de persistencia de preferencias de su selector nativo.

Desde Claude Code 2.1.268, si el modelo actual ya respondió en la conversación
(su caché está caliente), `s` abre además `Switch model?` con `❯ 1. Yes, switch
to <modelo>` / `2. No, go back`. Pasa con cualquier destino, no sólo con 1M; no
pasa si el modelo actual aún no ha respondido. El controlador pulsa Enter una
sola vez, y sólo si la opción marcada nombra el modelo pedido; después espera la
confirmación de siempre. Las capturas reales están en
`test/fixtures/model-control/`.

El controlador valida el menú y su fila seleccionada, y espera una nueva
confirmación del CLI. Rechaza escribir sobre un borrador de terminal o un diálogo
desconocido. No interrumpe permisos pendientes. Si no reconoce la confirmación,
muestra `Change unconfirmed` y ofrece abrir la terminal; si hay un diálogo
abierto, el detalle cita su primera línea. No anuncia éxito ni reintenta el
cambio automáticamente. La disponibilidad del menú no garantiza que
el modelo tenga cuota. Cambiar de proveedor sigue requiriendo el relevo explícito.

`model-control-<sessionId>.json`, dentro del directorio CAPCOM, guarda el catálogo,
el cambio pendiente y los últimos 50 eventos mediante reemplazo atómico.
`model-changes.jsonl` conserva el registro completo. Un reinicio conserva la cola;
un cambio interrumpido en fase de aplicación queda sin confirmar. La configuración
de recuperación Codex recibe el modelo confirmado para futuros resumes del mismo
thread; `handoffModel` conserva el modelo original del relevo histórico.

El estado viaja por el sanitizador de agentes del hub. GENERAL · TALK intercala
los eventos como ORCA, EVENTS los muestra cronológicamente y `briefing` incluye los
tres cambios recientes de CAPCOM en cada consulta. No se requiere una respuesta
del LLM para cambiar de modelo, de modo que el control funciona ante un error de cuota.

Verificación: pruebas del controlador (cola, cancelación, reinicio, confirmación
ausente, permisos, cambio Claude solo por sesión y el diálogo `Switch model?` de
2.1.268 sobre capturas reales: `npm test -- model-control`); pruebas visuales de escritorio
y móvil (selector, errores, borrador, TALK/EVENTS); cambios reales en dos sesiones
CLI aisladas; consulta del catálogo mediante el hub del CAPCOM activo. El CAPCOM
real permanece en `01a07569-fdc3-75a1-88ed-8180be4b44b5`, `gpt-6-astra`.

## Selector por proveedor y handoff revisable

`CHANGE MODEL` agrupa modelos por runtime. El grupo actual conserva el cambio
nativo de sesión; el otro ofrece `handoff · review first`. Claude muestra los
aliases Opus, Fable, Sonnet y Haiku; Codex usa su catálogo local. Tener el CLI
instalado no garantiza acceso al modelo ni cuota: la preparación comprueba la
respuesta real antes del relevo.

Elegir otro proveedor crea un respaldo, todavía sin invocar el modelo destino:
`~/.orca/capcom-handoffs/<uuid>/source.jsonl`, `conversation.md`, `HANDOFF.md`,
configuración de recuperación anterior y `manifest.json` con SHA-256. La
conversación incluye el historial archivado previo y el transcript actual;
el checkpoint incluye tareas, escalaciones, mensajes y estado de los workers.
Las rutas a archivos originales de relevos anteriores siguen en la configuración
respaldada. REVIEW CONTEXT y REVIEW HISTORY permiten revisar los archivos antes
de CONFIRM HANDOFF. Cancelar conserva el respaldo y no cambia CAPCOM.

La confirmación rechaza un transcript cambiado o un respaldo alterado. Envía la
conversación y el checkpoint completos por stdin a una sesión nueva: Claude
en modo print sin herramientas ni MCP; Codex exec con configuración de usuario
ignorada y sandbox read-only. No se pasan variables ORCA_* al proceso de
preparación. Se exige salida exitosa, id de sesión y una confirmación de contexto
con nonce. Una cuota agotada, autenticación fallida, contexto excesivo o falta de
confirmación conserva el coordinador anterior. El límite del paquete es 4 MiB;
no se trunca para forzar el relevo. Los límites del modelo pueden ser menores.

El destino confirmado se reanuda con las herramientas CAPCOM y se comprueba su
terminal antes de detener el pane anterior. La configuración persistente incluye
el runtime y el id de destino; el nombre `codex-recovery.json` se conserva por
compatibilidad, también para destinos Claude. Durante la preparación se suspende
el watchdog y el hub retiene los mensajes dirigidos al coordinador; al terminar,
los libera al CAPCOM activo. Un proceso interrumpido no reintenta la preparación
automáticamente; la revisión se recupera desde `plan.json`. El selector conserva
el id del plan en el navegador para consultar el resultado tras recargar.

TALK ofrece LOAD PREVIOUS CONVERSATION y LOAD EARLIER MESSAGES. Lee páginas del
archivo mediante el collector, incluso cuando el hub está en otra máquina, y
las presenta antes del tramo activo. Los originales siguen disponibles en sus
archivos. Los sobres de transporte de handoffs anteriores se representan una
sola vez para evitar duplicar recursivamente el historial; permanecen completos
en el JSONL original. Los archivos de revisión del directorio CAPCOM estándar
también pueden abrirse con el visor del hub local.

Verificado con preparación real mínima en Claude Haiku y Codex GPT-6 Astra,
pruebas de integridad/fallos/cutover/paginación y navegador de escritorio/móvil.
El hub real devuelve ambos catálogos y páginas del historial. Esta implementación
no efectúa un relevo del CAPCOM real: el operador elige y confirma el destino.
