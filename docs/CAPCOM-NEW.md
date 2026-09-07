# New CAPCOM: contexto limpio o continuidad

Implementado para `task_mtpbw5elzf26ioz1` / squad `task-03`. Esta entrega no activa un reset real, no reinicia servicios y no incluye commit, push ni deploy.

## Botón y comandos reales

En la ventana de mando, junto a **CHANGE MODEL**, aparece **New CAPCOM**. Abre una elección con el alcance explícito y dos acciones:

| Acción | Contexto inicial | Actividad al arrancar |
| --- | --- | --- |
| **Clean context** | Instrucciones básicas de CAPCOM y verificación técnica de arranque. Sin resumen de pendientes, conversación, historial ni texto de reglas del hub. | Espera instrucciones o mensajes nuevos. No ejecuta `briefing`/`recall`, no reproduce backlog y no recibe el latido que ordena recuperar pendientes. |
| **With continuity** | Checkpoint breve del hub: tareas abiertas, preguntas pendientes, referencias de agentes y reglas persistentes. Historial completo archivado en disco, sin introducirlo en el contexto. | Recupera la situación con `briefing` y consulta detalles puntuales cuando son necesarios. |

Comandos de la barra ORCA:

```text
/capcom-new
/capcom-new clean
/capcom-new continuity
```

Sin argumento abre la elección; `clean` y `continuity` solicitan directamente el modo indicado. Un argumento desconocido se rechaza. `/clear` conserva su comportamiento de deseleccionar. No se envían comandos `/new` ni `/clear` al CLI. No había otra entrada `/capcom-new` en el registro de comandos.

El protocolo interno es `{ k: 'capcom:new', agentId, mode: 'clean' | 'continuity' }`. El hub genera el checkpoint de continuidad; no confía en un checkpoint proporcionado por la consola. El estado utiliza `handoff:status` y un `planId`, también tras recargar la ventana.

## Qué conserva y qué cambia

Se conserva el **runtime y modelo efectivo**, incluido Codex. No hay fallback a Claude ni a otro modelo. La acción requiere CAPCOM hospedado, vivo, con transcript y modelo conocidos, y sin turno ni cambio de modelo en curso. También admite un bloqueo de error/cuota; la preparación puede fallar por la cuota del mismo modelo y conserva el original.

Se cambia el UUID de sesión mediante un arranque nuevo preparado y un `resume` de **ese UUID nuevo** para abrir su terminal interactivo. No se reanuda la conversación antigua. El recibo de preparación forma parte del contexto técnico mínimo; «limpio» no significa una sesión sin instrucciones de rol o sin configuración MCP.

Archivos de proyectos, workers, tareas, reglas persistidas, transcripts originales y conversaciones del hub no se borran. Retirar tareas es una decisión aparte y se pide aparte, con ARCHIVE o `/tasks` ([TASK-RETENTION.md](TASK-RETENTION.md)): el registro del hub es lo que permite que la sesión sea desechable, y borrarlo como efecto colateral de un reset de contexto sería justo lo contrario. El modo limpio no carga esas reglas automáticamente: el operador puede pedir recuperar información histórica después. La política limpia continúa en una reanudación o compactación y hasta otro cambio de modo; una instrucción explícita puede pedir información histórica puntual.

Cada acción crea `<capcom-dir>/handoffs/<planId>/`:

- `source.jsonl`: el transcript anterior, enlazado en duro cuando el sistema de archivos lo permite y copiado cuando no. Los mismos bytes bajo otro nombre: sobrevive a que el CLI pode su directorio de sesiones, sin duplicar decenas de megabytes en cada intento.
- `conversation.md`: historial acumulado consultable desde TALK.
- `manifest.json`: hashes del transcript, historial y notas.
- `HANDOFF.md`: checkpoint de continuidad o acta del reset limpio, sin pendientes en el segundo caso.
- Copias de configuración/control previos, cuando existen.
- `runtime/`: directorio propio de la sesión preparada, con `CLAUDE.md` y `AGENTS.md` específicos del modo.
- `preparation.jsonl`, `preparation.stderr`, `destination-checkpoint.md` y `plan.json`: evidencia y resultado.

Al preparar un traspaso se podan los archivos anteriores: de cada uno que no sea
el activo — el que nombra `codex-recovery.json` — ni el que se está preparando,
se quitan `source.jsonl` y `conversation.md`, y queda un `PRUNED.md` que lo dice.
El plan, el checkpoint, los hashes del manifiesto, el recibo de preparación y la
pantalla del destino atascado se conservan: son lo que se abre para entender un
fallo. La conversación que contenían sigue en la sesión que la tiene y en el
transcript del propio CLI. La poda es de mejor esfuerzo y nunca hace fallar un
traspaso.

Las credenciales MCP se añaden al directorio de ejecución solo al abrir el terminal de destino, después de preparar y verificar el recibo. La preparación elimina variables `ORCA_*`; Claude no dispone de herramientas/MCP y Codex utiliza la ruta existente `exec --ignore-user-config ... -s read-only`. No se debe borrar un directorio `runtime/` que esté referenciado por la recuperación activa.

Ese directorio `runtime/` no existía un segundo antes, así que el CLI de destino
pediría confirmar su confianza y se quedaría esperando en un pane que nadie mira:
la verificación agota los dos minutos y el CAPCOM original se conserva. Antes de
abrir el terminal se registra la confianza de la carpeta donde cada CLI la guarda
— `~/.claude.json` para Claude, `[projects."<dir>"] trust_level = "trusted"` en
`~/.codex/config.toml` para Codex —, sin tocar una decisión ya tomada para esa
carpeta ni un archivo ilegible; si no se puede escribir, queda un aviso en el
feed. Cada traspaso añade así una entrada de proyecto al config de Codex. Cuando
la verificación falla de todos modos, la última pantalla del destino se guarda en
`resume-screen.txt` dentro del archivo.

El checkpoint de continuidad enumera hasta 16 elementos por sección, recorta líneas descriptivas a 240 caracteres y conserva identificadores y vías de consulta. El prompt preparado tiene un límite de 48 KiB. El historial archivado no comparte ese límite de contexto. Si el transcript cambia durante la preparación o queda incompleto durante una escritura, se rechaza el traspaso y se mantiene el original.

## Coordinación y mensajes

El corte de contexto se identifica con `cutoffAt` en el plan/evento. ORCA anuncia la retención antes de preparar el destino. Mientras dura:

1. El watchdog y la rotación automática no intervienen. Los comandos incompatibles y la entrada al terminal original quedan bloqueados; TALK sigue aceptando mensajes.
2. La preparación no recibe permiso para despachar trabajo. Debe devolver un UUID distinto y el recibo solicitado; limpio exige únicamente ese recibo.
3. El destino se abre sin un turno nuevo de activación. ORCA verifica que su terminal ha llegado a un prompt inactivo; tiene hasta dos minutos para ello.
4. Solo después de verificar el destino se detiene el pane anterior y se publica por rename la configuración de recuperación con el UUID nuevo. Se adopta ese UUID en el linaje y se publica el snapshot.
5. La cola se libera al destino confirmado. Si aún no se ve su transcript, continúa retenida. Una preparación lenta no descarta el correo por timeout.

Si falla preparación, autenticación/cuota, recibo, arranque, captura o readiness, el anterior no se detiene. Si falla detener el anterior, se cancela el destino y permanece la autoridad anterior. Las solicitudes duplicadas del mismo modo durante la preparación reutilizan el plan; otro modo o un segundo commit se rechazan.

Los mensajes nuevos de TALK, tareas y entregas directas al CAPCOM se retienen. En limpio, una instrucción nueva dentro de una tarea lleva su identificador y texto nuevo, sin adjuntar la conversación anterior. Lo mismo aplica a los resultados nuevos de workers. Las preguntas antiguas, los avisos de workers anteriores al corte y los incidentes de cuota históricos siguen guardados, pero no se vuelven a inyectar automáticamente; las preguntas/incidentes nuevos siguen llegando. El evento de handoff se muestra y persiste en la UI sin enviarlo como prompt al CAPCOM limpio.

La activación mantiene un único CAPCOM con autoridad. Durante la verificación puede haber dos procesos CLI vivos: el original y el destino preparado, sin turno activo ni rol de CAPCOM todavía. No se debe escribir directamente en el tmux de destino ni usar comandos del CLI para cambiar de sesión al margen de ORCA.

## Los avisos, plegados

Un traspaso deja su acta —«SESSION CHANGED», con enlaces a la conversación
anterior y a las notas— y el propio traspaso deja la suya, con el estado del
plan. Son útiles una vez y referencia después, pero desplegadas ocupaban entre
las dos dos tercios del alto de la ventana, y la conversación viva quedaba en
una franja de cuatro líneas; la del traspaso, además, no se podía cerrar de
ninguna manera, así que ese recorte era permanente.

Ahora el estado normal de un aviso es una línea: título, resumen y hora. Se abre
con un clic y se descarta con la ×, y ambas cosas se recuerdan en este navegador
por id del aviso —descartar el acta de un traspaso no esconde la del siguiente,
que es cuando hace falta leerla—. El aviso sigue en el hub: otra consola lo verá.

El acta del plan se abre sola mientras hay algo que decidir o algo en marcha
—una revisión pendiente de confirmar, una preparación, un fallo que explica qué
se conservó— y se pliega en cuanto es el recibo de algo que salió bien. La
acción que sigue a un traspaso completo, ir al agente que continúa, queda fuera
del plegado: se esconde el texto, no lo que hay que poder pulsar.

## Activación operativa pendiente

1. Integrar estos cambios y ponerlos en servicio mediante el procedimiento habitual, en una ventana autorizada. Esta tarea no ejecutó ese paso.
2. Abrir la ventana de mando, comprobar proveedor/modelo y esperar a que CAPCOM termine el turno. El botón explica cuándo no está disponible.
3. Elegir **New CAPCOM → Clean context / With continuity**, o utilizar el comando equivalente.
4. Esperar el resultado del plan. En caso de fallo, revisar el detalle y las evidencias del archivo antes de reintentar; no introducir `/new` en un terminal.
5. Verificar el nuevo UUID, proveedor/modelo y un solo rol CAPCOM. En limpio debe quedar esperando, salvo mensajes nuevos recibidos durante el cambio. En continuidad debe recuperar pendientes. Comprobar entrega de los mensajes retenidos.

Los cambios de autoridad locales son persistentes; no constituyen una transacción distribuida con garantía de exactamente una entrega frente a una caída simultánea del hub, collector y filesystem. La cola de callbacks del router sigue siendo memoria del hub, como antes: un reinicio del hub durante la transición requiere reconciliar los mensajes conservados en tareas/conversación y el estado del handoff; no hacer reenvíos ciegos. El estado interrumpido consulta la configuración de recuperación para reconocer una activación ya persistida, sin lanzar otro runtime. No se ha ensayado aquí una pérdida de alimentación ni se ha activado una sesión real del operador.

## Verificación

```sh
npm run typecheck
npm test
npm test -- capcom
npm test -- wake
npm test -- provider-handoff
npm test -- worker-recovery
node --import tsx test/capcom-new.visual.ts
node --import tsx test/capcom-handoff.visual.ts
```

La prueba visual crea su propio servidor Vite sin la configuración/proxy del proyecto ni conexión al hub real. Guarda capturas en `test/shots/capcom-new-{desktop,mobile}.png` y comprueba botón, ambos modos/comandos, alcance, modelo, borrador, fallo/reintento y overflow.

Las pruebas nuevas de runtime utilizan procesos CLI simulados con HOME/config/cwd temporales, y terminales inyectados para readiness/fallo/timeout. Las pruebas del hub usan WebSockets reales contra un hub temporal. Son comprobaciones de integración del controlador y los límites de proceso, no una certificación de cuota/autenticación ni una ejecución contra Claude/Codex de producción. La suite general también ejercita tmux en su entorno de prueba. No hubo rotación, reset ni envío de prompts al CAPCOM real.
