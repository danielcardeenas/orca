# Conversaciones de CAPCOM

CAPCOM mantiene un coordinador y ofrece conversaciones por tarea. En su ventana,
**NEW TASK** crea una conversación; el selector permite volver a las anteriores.
El primer mensaje pone el título. **GENERAL · FLEET** conserva la vista global.
Cada tarea muestra sus mensajes, estado y agentes, con accesos al agente, su
ubicación y su terminal. Las preguntas pendientes de esos agentes enlazan al
panel de respuesta existente.

El hub persiste las tareas en `tasks.json` dentro de su directorio de datos,
mediante reemplazo atómico. Al conectar entrega el historial con el mundo y
publica cambios por WebSocket. La selección se conserva en el navegador. Se
retienen hasta 100 tareas, 100 mensajes por tarea y 8.000 caracteres por mensaje;
no es un archivo ilimitado de transcripciones.

Cada envío incluye un `taskId` explícito. CAPCOM recibe el ID y contexto reciente,
y responde mediante `report_task`, indicando `active`, `completed` o `failed`.
`spawn_agent` y `launch_squad` aceptan `task_id` para asociar los trabajadores.
Una etiqueta de squad permite asociar también sesiones Codex cuyo ID llega después
del acuse de lanzamiento. Los descendientes se incorporan por parentesco.
Los resultados observados de agentes asignados se guardan una vez por texto y se
notifican a CAPCOM agrupando actualizaciones próximas. Un resultado observado no
marca automáticamente la tarea como terminada: CAPCOM debe confirmar el cierre.

CAPCOM no necesita recordar las tareas: las lee del hub. `list_tasks` (filtros
`status` y `only_pending`) devuelve cada conversación con su estado, sus agentes
con indicativo y estado, la fecha del último mensaje y si hay un mensaje humano
sin respuesta o resultados de trabajadores sin reportar; `inspect_task` devuelve
una tarea completa con lo que falta por responder. La regla es posicional: todo
lo que hay después del último mensaje de CAPCOM en la tarea está pendiente.
`briefing` resume la flota entera en una llamada —bloqueados, tareas en deuda,
trabajadores terminados sin reportar, squads sin miembros vivos, proyectos con
actividad, últimas reglas— y es lo primero que llama una sesión nueva o recién
compactada. Cuando la sesión CAPCOM se recicla (ver README, "It is recycled
before it forgets"), el hub retiene los mensajes de tarea hasta que aparece la
sesión nueva y se los entrega entonces; si no vuelve en tres minutos, la tarea
recibe un mensaje de sistema `Delivery failed`.

Las conversaciones comparten el proceso y contexto interno de CAPCOM. Hay
separación explícita del historial y enrutamiento, pero no aislamiento de sesiones
ni ejecución simultánea independiente del coordinador. El prompt proporciona las
últimas ocho intervenciones (hasta 2.000 caracteres cada una). Las respuestas de
texto libre del terminal siguen en GENERAL; para aparecer en una tarea se debe
usar `report_task`. Las preguntas directas de CAPCOM mediante `ask_human` siguen
usando el panel global de interrupciones.

El acuse del collector confirma la entrega al mecanismo de entrada, no que el
modelo haya consumido el mensaje. Un fallo aparece en el recibo; el mensaje queda
guardado. Los avisos de resultados no tienen reintentos persistentes tras reinicio;
el resultado sí permanece en la conversación.

Para usar los cambios se necesita el hub actualizado y una sesión CAPCOM que
haya cargado el catálogo MCP nuevo (`report_task`). Una sesión previa puede
necesitar reconectar su MCP o reiniciarse. No se reinician sesiones de trabajo
activas como parte de la instalación del cambio.

Validación: `test/tasks.test.ts` comprueba persistencia, atribución de respuestas
tardías, descendientes, squads diferidos, reconexión y aviso de resultados.
La comprobación con Playwright usa una conexión simulada en escritorio y móvil:
crea dos conversaciones, verifica separación de respuestas y restaura la selección.

## La ventana: TALK, WORK y EVENTS

La ventana de CAPCOM tiene tres pestañas. **TALK** es la conversación; **WORK**
lista los agentes que CAPCOM tiene en marcha (o los asignados a la tarea) con
acceso al agente, a su posición en el campo y a su terminal; **EVENTS** reúne el
tráfico que CAPCOM envía a la flota y la telemetría sobre él, que antes se
intercalaban con la conversación. Debajo de la conversación hay una línea de
estado con lo que CAPCOM hace ahora mismo: estado, herramienta en uso, velocidad
y coste, más TERM y FLY. Los pedidos rápidos ocupan una sola fila desplazable.

En GENERAL, TALK muestra el transcript real de la sesión CAPCOM. El collector
emite tramas `talk` con cada bloque que el CLI escribe en su JSONL: el prompt
completo, los bloques de pensamiento, cada llamada a herramienta con su detalle,
el resultado recortado a 600 caracteres y la respuesta íntegra. El hub las
apila por agente (`world.talk[agentId]`), deduplica por id, conserva 300 bloques
y no las persiste: el transcript en disco ya es la copia de verdad y el collector
relee su cola al arrancar. Sólo se emiten para la sesión con `role: 'capcom'`.

La consola agrupa los bloques en intercambios: tu línea y, debajo, todo lo que
CAPCOM hizo hasta parar. Los pasos (pensamiento, herramientas) son filas plegadas
que se abren para ver lo que devolvieron. Un prompt `[ORCA TASK …]` aparece como
enlace a esa tarea, y un `[ESCALATION …]` como pregunta de la flota con acceso a
la interrupción si sigue abierta. Mientras CAPCOM trabaja se añade una fila viva
con los glifos (pensando) o la herramienta en curso. El eco local de un envío se
muestra como tu mensaje con su recibo hasta que el prompt aparece en el transcript.

Granularidad: el CLI escribe cada bloque en su JSONL al completarse, así que
por esa vía la respuesta llega párrafo a párrafo y el pensamiento al cerrarse. Un
pensamiento redactado por el CLI aparece como paso vacío.

Texto en vivo: cuando CAPCOM vive en un pane de tmux, el collector mantiene un
cliente de control de tmux (`tmux -C attach`) sobre ese pane. Cada vez que el pane
pinta, tmux emite `%output` y el collector lee la pantalla con un debounce de
100 ms (nunca más seguido que cada 80 ms), sólo mientras el estado es `thinking`
o `working`. De la pantalla extrae el bloque `⏺` que el CLI está pintando, sólo si
hay un spinner de turno abierto y el bloque es texto (no una tool). El cliente de
control no afecta al tamaño del pane; si cae o no está disponible, el collector
sondea cada 400 ms hasta relanzarlo. En reposo no se lee nada.

La TUI de Claude Code usa la pantalla alterna: `capture-pane` sólo devuelve la
ventana visible. Si el bloque en curso es más alto que el pane, su `⏺` queda
fuera por arriba y el spinner por abajo; el collector devuelve entonces la cola
visible con `…` delante, y detecta que el turno sigue abierto por el `esc to
interrupt` de la barra de estado. La caja de entrada pinta `❯` con espacio duro
(U+00A0) y puede contener un borrador del operador; ambos se toleran. Medido en
94 frames de una respuesta larga (2.1.263, 104x27): texto en 75, y los 22 nulos
corresponden al arranque del turno, antes del primer bloque, y al cierre. Lo manda como `talk:live` (`world.talkLive`), la
ventana lo muestra como fila «typing» con cursor, y en cuanto el bloque completo
llega por el transcript la fila desaparece y el párrafo definitivo la sustituye.
Es lo que la TUI pintó (sin asteriscos de markdown, con su propio ajuste de
línea), no lo que dijo la API; no se persiste. Sin pane no hay texto en vivo.

Orden: el hub y la consola funden los bloques con la misma regla
(`src/shared/talk.ts`): deduplicar por id y ordenar por tiempo de forma estable.
Hace falta porque una reposición tras reiniciar el hub entrega bloques antiguos
después de los nuevos. El estado pasa a `thinking` en cuanto el prompt aparece en
el transcript, antes del primer bloque de respuesta, con un tope de diez minutos
sin respuesta tras el cual vuelve a `idle`. Un collector anterior
a este cambio no envía `talk`; la ventana lo indica en el estado vacío y hay que
reiniciarlo. Las conversaciones de tarea siguen mostrando los mensajes publicados
con `report_task`, con la misma fila viva y línea de estado.

Validación: `test/talk.test.ts` cubre la derivación desde líneas del transcript,
la sanitización, deduplicación, orden y límite en el hub, el plegado en
intercambios, la clasificación de prompts envueltos, el eco local, el estado
`thinking` tras un prompt, la lectura del bloque en curso desde la pantalla y el
texto en vivo en el hub.
