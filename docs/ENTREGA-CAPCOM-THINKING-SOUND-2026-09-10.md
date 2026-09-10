# CAPCOM: microsonido opcional de actividad

La ventana SFX permite ajustar por separado el sonido de actividad de CAPCOM.
Parte en silencio (0); el nivel se conserva en `orca.sfx.capcom-thinking.vol.v1`.
El silencio general y el volumen maestro también lo gobiernan. Cambiar un pack
o preset no activa esta preferencia ni borra el silencio elegido.

Reutiliza `capcom.thinking`, el clip `tick`, `capcomOf` y `capcomFeedback`.
Su significado es «se observó actividad de CAPCOM cerca de un mensaje enviado».
No acredita recepción, entrega, aceptación, respuesta terminada ni éxito. Los
estados visuales siguen disponibles con audio desactivado; no se añade un anuncio
ARIA repetitivo. La preferencia de movimiento reducido conserva su significado
visual y no sustituye el control explícito de audio.

## Cuándo se oye

- Una transición observada a pensamiento, herramienta o espera de un agente par,
  con CAPCOM identificado, conexión autenticada y mensaje local de menos de 30 s.
- Una sola vez por identificador de mensaje, con separación mínima de 10 s.
  Las actualizaciones de herramientas, métricas o recibos no repiten el toque.
- Ganancia máxima relativa del 25 % multiplicada por el nivel elegido y el maestro;
  ataque de 12 ms, salida a cero en 160 ms y duración máxima de 180 ms incluso
  si se asigna un clip más largo. No tiene bucle ni cola de repeticiones.

Inicio, snapshots, reconexión y cambios de autenticación establecen una base
silenciosa y consumen el mensaje anterior. Desconexión, error, espera humana,
listo, desaparición de la sesión, silencio, nivel cero, pestaña oculta y desmontaje
cancelan el toque activo o pendiente. Una carga/decodificación de más de un segundo
se descarta. No hay recuperación sonora tardía al desbloquear audio, volver a la
pestaña o quitar silencio. Sin Web Audio, gesto inicial o archivo disponible,
la consola sigue funcionando en silencio. El arnés sintético permanece silencioso.

La audición explícita de clips de SFX conserva su contrato existente: permite
escuchar la muestra elegida y no representa actividad automática de CAPCOM.

## Verificación

Pruebas de política con reloj determinista y prueba de navegador con Store y
Web Audio falsos; sin hub, collector, websockets ni sesiones reales. Cubren
silencio inicial, persistencia, límite de duración, deduplicación, recibos,
reconexión y cancelación de decodificación pendiente. Se ejecutan typecheck y
las suites afectadas sobre el árbol compartido.

- `npm run typecheck`: correcto.
- `npm test -- --changed`: 78 suites, 938/938 comprobaciones correctas sobre
  el árbol compartido al iniciar la corrida. La segunda corrida del miembro
  responsable de SFX incluyó su nueva suite: 79 suites, 939/939 correctas.
- `npm test -- capcom-thinking`: 6/6, incluida la caducidad de carga y las bases
  silenciosas de arranque/snapshot añadidas durante la revisión.
- `npm test -- --changed capcom-thinking sfx-thinking`: verificación final,
  tres suites y 7/7 correctas, con capturas de escritorio y móvil y manejo por
  teclado, puntero, persistencia y sincronización del control.
- Detector Impeccable sobre los tres módulos de UI: sin hallazgos (`[]`).

La corrida afectada avisó de 23 rutas sin suite: documentación, estilos y
entradas de UI/fixtures ya modificadas por otras tareas (entre ellas DESIGN.md,
README.md, command.ts y main.ts). No se atribuye cobertura a esas rutas. Este
microsonido tiene suites propias enlazadas por imports; el documento de entrega
se revisa como texto y eleva a 24 los avisos de la corrida final filtrada.

Filtros: `capcom-thinking` (política y ciclo de audio); `sfx-thinking` (control
accesible y capturas desktop/mobile); `capcom-feedback` (estados
visuales reutilizados); `turn` (contrato compartido de actividad).
