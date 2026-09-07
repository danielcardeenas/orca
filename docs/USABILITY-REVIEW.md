# Revisión de comunicación y usabilidad — 2026-09-06

## Decisión

Mantener hub + collectors + WebSocket y el buzón como transporte compatible.
Evolucionar el control de sesiones hacia eventos y respuestas estructuradas.
Cambiar el buzón por otro canal, por sí solo, no resuelve el arranque del CLI,
los turnos de CAPCOM ni los formularios que esperan una interacción nativa.

Esta revisión inspecciona el código y prueba procesos simulados y el navegador.
No mide el tiempo de inferencia ni valida un flujo completo con modelos reales.
El checkout ya contenía cambios de runtimes y terminales; se han conservado.

## Cuellos de botella encontrados

| Tramo | Evidencia en el código | Consecuencia |
|---|---|---|
| Mensaje al collector | `MessageWatcher` usa `fs.watch` y reconciliación cada 1 s | No es un bucle de inferencia; normalmente la entrega responde a eventos |
| Mensaje al destinatario | `CommandRunner.deliver` solo escribe el buzón | Guardado no equivale a visto; un agente que terminó su turno no se despierta |
| Espera de respuesta | `orca-ask` y `orca-tell` consultaban cada 1500 ms | Añadía hasta otro intervalo después de escribir la respuesta |
| Arranque de Claude hospedado | Esperaba el transcript hasta 8 s, aunque ya eligió el ID | `launch_squad` acumulaba esa espera al lanzar miembros secuencialmente |
| Arranque sin ID conocido | Codex descubre el rollout por runtime, proyecto y fecha | No paralelizar indiscriminadamente: se puede atribuir el mismo rollout a dos lanzamientos |
| Telemetría | Watch de transcripts con reconciliación de 1500 ms y tick del collector de 500 ms | Confirmar un proceso y observar su primera actividad son momentos diferentes |
| Preguntas nativas | `AskUserQuestion` se detecta; `answer` resuelve archivos de `orca-ask` o permisos de pantalla | No hay un contrato general para responder una o varias selecciones del CLI |
| Navegación | CAPCOM mostraba su conversación, sin listado de trabajo integrado | El usuario debía descubrir por separado dónde estaba el agente |

Estos intervalos son límites/configuración del código, no percentiles medidos de
latencia real. No se puede afirmar qué porcentaje del tiempo consume el modelo
sin instrumentar un flujo real.

## Cambios aplicados

- `orca-read --wait --timeout 60` espera hasta 60 **segundos** por correo con
  eventos del filesystem; timeout explícito con exit 3. La llamada normal sigue
  siendo inmediata. `--peek`, `--json` y filtros conservan su comportamiento.
- `orca-ask --wait` y `orca-tell --wait` usan el mismo mecanismo. Sus flags de
  timeout siguen expresándose en **minutos**, como antes.
- Suscripción antes de leer para no perder una entrega durante el montaje;
  reconciliación cada 5 s cuando el filesystem omite eventos; cierre de watcher
  y timers al resolver. Las respuestas siguen siendo archivos persistidos.
- Claude hospedado confirma el ID después de que tmux acepta el lanzamiento,
  sin esperar su transcript. La confirmación no afirma que el modelo esté listo.
  Codex y Claude sin tmux conservan la espera por identidad.
- CAPCOM muestra FLEET WORK: estado, misión, proyecto y escuadrón de agentes de
  trabajo visibles, con Open, Locate y Terminal. Muestra hasta 30 filas y ofrece
  acceso a la flota completa; no atribuye todos esos agentes a una orden concreta.
- Enviar desde CAPCOM muestra feedback local inmediato. Un enlace caído conserva
  el borrador. El texto «Sent to hub» indica envío local, no recepción por el CLI.
- Los briefs favorecen reutilizar un agente, usar un trabajador por tarea concreta
  y reservar escuadrones para trabajo independiente. Explican espera por eventos
  y decisiones entre pares mediante preguntas/respuestas textuales.

## Herramientas de trabajo

CAPCOM tiene Bash/Edit/Write denegados expresamente en su configuración: es una
restricción del coordinador. Los trabajadores se lanzan con el CLI de su runtime;
ORCA no les aplica esas denegaciones de CAPCOM. Su acceso efectivo depende de las
herramientas, sandbox y permisos del runtime/proyecto. Detectar `Read`, `Write` o
`Bash` en un transcript no equivale a inventariar todas sus capacidades actuales.

## Siguiente cambio estructural

1. **Contrato de ejecución observable.** Persistir una operación antes de lanzar:
   `requested → launching → running → waiting_input → completed/failed`, con ID,
   proyecto, misión, agente y resultado. La UI debe mostrarla antes del transcript.
   Esto también permite agrupar los agentes por la orden que los originó.
2. **Entrega dirigida con acuse.** Separar `persisted`, `notified`, `read` y
   `answered`. Identidad de destinatario y marcas de lectura por agente: hoy el
   buzón y la marca `.read` se comparten por proyecto, por lo que una lectura
   puede ocultar correo a otro trabajador del mismo checkout.
3. **Activación de sesiones.** Un adaptador de runtime debe notificar o encolar el
   mensaje al terminar un turno y reactivar sesiones inactivas. El buzón durable
   queda como respaldo. No pegar mensajes automáticamente en una pantalla que
   puede estar mostrando un permiso o una pregunta.
4. **Preguntas estructuradas.** Un contrato con `questionId`, tipo (`text`,
   `single`, `multi`, `permission`), opciones estables, destinatario y respuesta
   correlacionada. Un agente puede responder elecciones delegadas; las decisiones
   reservadas al usuario siguen su ruta explícita. Cada runtime debe declarar si
   puede responder ese tipo; si no, ofrecer Terminal y explicar la limitación.
5. **Medir antes de cambiar proveedor/transporte.** Registrar timestamps de envío
   UI, recepción hub, aceptación collector, creación de proceso, primer evento,
   primera respuesta y resultado. Medir p50/p95 por runtime, con arranques fríos y
   calientes, una tarea simple y un escuadrón. Separar latencia del modelo de la
   de infraestructura y de la espera de decisiones.

La espera por eventos implementada aquí evita consultas repetidas; no reactiva
una sesión que dejó de ejecutar el comando. Tampoco resuelve todavía el buzón
compartido ni convierte los checkboxes nativos en preguntas contestables por un
par. Esas son limitaciones abiertas, no garantías de esta entrega.

## Validación de esta entrega

- Suite completa: 302/302 pruebas, incluida entrega por rename, timeout, lectura
  sin duplicación y confirmación de arranque antes del transcript.
- `npm run build` y `npm run typecheck`: correctos.
- Chromium con flota simulada, escritorio y móvil: dos trabajadores visibles,
  apertura del agente desde CAPCOM, borrador preservado sin conexión y ningún
  error JavaScript. Capturas en `test/shots/capcom-review-{desktop,mobile}.png`.
- No se lanzaron agentes de trabajo reales ni se reinició CAPCOM. Los cambios
  de brief se aplican a nuevos trabajadores y al próximo arranque de CAPCOM.

## Segunda entrega: respuesta al hablar con agentes

El camino humano → agente hospedado ya era directo (WebSocket → collector →
CLI en tmux); no pasa por el buzón. Se conserva ese camino y se elimina la
falta de visibilidad de su entrega:

- `ceo:say` acepta un ID de solicitud opcional. El collector confirma el envío
  a CAPCOM y el hub devuelve ese mismo acuse a la consola solicitante. Los
  clientes antiguos sin ID siguen funcionando. Sin comando disponible llega
  un fallo explícito; el API command confirma aceptación, no entrega a un CLI.
- Eco local inmediato y estados de envío para CAPCOM y trabajadores, también
  cuando se escribe desde la línea de comandos. La ventana muestra los tres
  envíos recientes; el store limita el historial local a 100. Se pierde al
  recargar la página, mientras el historial del hub conserva su ruta habitual.
- El tiempo mostrado corresponde al acuse del collector. No afirma que el
  modelo haya leído el mensaje ni que haya respondido. Timeout/desconexión se
  muestran como entrega sin confirmar; no hay reintento automático que pudiera
  duplicar una orden.
- Los mensajes pegados en el mismo pane se serializan hasta completar paste y
  Enter, con buffers únicos. Panes diferentes siguen siendo independientes.
- Hablar con Codex hospedado ya no requiere encontrar también el binario Claude.
- La llegada de un transcript programa publicación entre 25 y 250 ms, agrupando
  ráfagas y conservando el tick de 500 ms como reconciliación. Estos tiempos
  empiezan después de que el watcher haya leído el transcript; no son una
  garantía de latencia extremo a extremo.
- Las ventanas de agentes terminados o fallidos permanecen abiertas para leer
  el resultado y continuar la conversación.

Validación: 304/304 pruebas; build correcto; tmux real en socket aislado para
verificar envíos simultáneos separados y ordenados; hub con collector simulado
para verificar que no confirma antes del acuse. Chromium en escritorio y móvil
comprueba eco, entrega confirmada, fallo visible, borrador offline y permanencia
al finalizar, sin errores JavaScript. Las capturas usan acuses simulados: sus
cifras no representan rendimiento medido de un modelo real.

Esto sustituye el feedback local provisional «Sent to hub» de la primera
entrega por el estado real del acuse. No cambia todavía la activación de un
agente que solo recibe correo por filesystem, ni las preguntas nativas.

## Selección de Codex + Astra

Verificada el 2026-09-06 con Codex CLI 0.153.4. Corregidos el selector de modelos
(antes seguía mostrando Claude al elegir Codex), el campo `model` de
`spawn_agent` y su paso desde `orca spawn --model`. Los escuadrones inline
aceptan `runtime`, aplicado al líder y miembros; los presets conservan sus
runtimes guardados. Codex hospedado puede lanzarse sin instalar también Claude.

En SPAWN, seleccionar CODEX elige `gpt-6-astra`; también se puede elegir RUNTIME
DEFAULT. Al volver a Claude, el modelo cambia a uno de Claude. Verificado en
Chromium que el formulario envía `runtime: codex`, `model: gpt-6-astra`, hosted.
Las pruebas de CAPCOM verifican esos valores hasta el collector y las del
adaptador verifican `-m gpt-6-astra`.

Se hizo además una llamada real, efímera, con Codex, modelo `gpt-6-astra`,
sandbox read-only y un directorio temporal vacío: respondió `ORCA_ASTRA_OK`,
exit 0. No fue un lanzamiento completo a través del hub/tmux de ORCA; ese
recorrido se verifica por componentes y con la UI conectada a un transporte
simulado. Modelo oficial: https://developers.openai.com/api/docs/models/gpt-6-astra

## Origen y limpieza visual (2026-09-06)

El hub local reportó 82 sesiones durante la revisión: 55 idle (47 sin actividad
por más de una hora), 9 done y 1 dead. Son observaciones del collector, no 82
agentes lanzados por el usuario desde ORCA.

La procedencia ahora se deriva de los registros de lanzamiento de LineageIndex;
los subagentes nativos heredan el origen de sus ancestros. Tener una misión no
prueba que ORCA haya lanzado la sesión. Los collectors antiguos sin este dato
muestran UNVERIFIED, salvo CAPCOM y panes confirmados de ORCA. La actualización
viaja tanto en snapshots como en patches, para Claude y Codex.

La vista inicia en ORCA; FLEET ofrece ORCA / EXTERNAL / ALL y sus conteos. Agentes
y flotillas muestran su origen; una flotilla heterogénea dice MIXED. SHOW HISTORY
ignora temporalmente los filtros y descartes locales. La limpieza es visual:
CLEAN UP INACTIVE oculta terminados; las sesiones idle de más de una hora se
ocultan automáticamente y reaparecen al retomar actividad. CAPCOM vivo permanece
visible. Un agente bloqueado no se considera terminado por su antigüedad.
Los terminados de ORCA permanecen diez minutos antes de ocultarse automáticamente.
Las ventanas abiertas y los agentes de una tarea consultan también los registros
ocultos, conservando acceso a sus resultados.

No se borran transcripts ni se detienen procesos. Los filtros y descartes se
conservan en el navegador; el historial disponible depende de la retención del
hub/collector. Un navegador que ya tenía SHOW ALL activado conserva esa preferencia:
pulsar ORCA vuelve a la vista filtrada. Recargar la UI y actualizar el collector/hub
permite ver la procedencia confirmada de sesiones anteriores.
