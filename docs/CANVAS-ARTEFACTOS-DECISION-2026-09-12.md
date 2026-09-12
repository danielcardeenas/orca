# Artefactos en el canvas: decisión del líder

Misión `mission_mty0u9wtmoc471tc`, squad `canvas-artefactos-01`. Complementa el reconocimiento del canvas en [CANVAS-ARTEFACTOS-2026-09-12.md](CANVAS-ARTEFACTOS-2026-09-12.md).


QUÉ EXISTE HOY (confirmado con archivo y línea):
- Registro: src/collector/artifacts.ts (ArtifactIndex). Dos entradas: automática (derive.ts noteProduced: tool_use Write/Edit/MultiEdit/NotebookEdit sobre .png .jpg .gif .webp .svg .mp4 .webm .mov .html .md .txt) y explícita (shim orca-show → <proyecto>/.orca/artifacts/<id>.json con {path,title,kind,open}). Lista blanca de extensiones: un .zip hoy NO llega a ser artefacto. Techo 200 por máquina; bytes hasta MAX_ARTIFACT_BYTES=16 MB (protocol.ts:648), por encima el registro viaja pero los bytes no (rectángulo negro en el campo). width/height sólo para imágenes (imageSize). Id = sha1(máquina+ruta): reescribir actualiza, no duplica.
- Camino: collector → hub (world.ts guarda en ~/.orca/artifacts, sirve /api/artifact/<id>) → consola (store.world.artifacts, evento 'artifacts').
- Muestra: ventana de artefacto (windows/kinds/artifact.ts), galería con filtro por agente (gallery.ts), sección ARTIFACTS en la ventana de agente (agent.ts:277) y miniaturas en la de misión (mission.ts:553). En el CAMPO existe field/media.ts (quad texturizado o superficie DOM, MEDIA_W=2.4, MAX_MEDIA=40) pero SÓLO para artefactos con placement, y placement sólo lo pone un gesto del operador (PLACE / arrastrar desde la galería), guardado en localStorage. El ancla junto al agente ya existe: field.placeNear (field.ts:2571). Lo que falta no es el ancla: es que nadie la use sola y que lo que cuelgue de ella quepa.
- El artefacto sobrevive al agente por diseño (hub desaloja por edad/techo, no por vida del agente). Con el agente fuera de w.agents, placeNear cae a la posición de la cámara.
- Detalle completo del canvas: docs/CANVAS-ARTEFACTOS-2026-09-12.md (8217a5f).

DECISIÓN 1 — CAPTURA: mezcla, con reparto de responsabilidad. DECLARAR es la vía canónica; DETECTAR es la red de seguridad; NUNCA se parsea texto libre.
- El brief de cada agente lanzado dice de forma determinista: «cuando produzcas algo que un humano deba mirar, orca-show <ruta> "título"; --open sólo para la única cosa que hay que ver». Un pipeline (ffmpeg, python) escribe por Bash, no por Write, y la detección no lo ve: por eso la declaración es la vía principal, no un adorno.
- La detección automática por Write/Edit se queda tal cual como red (funciona sin que el agente sepa que ORCA existe).
- Nada de extraer rutas/URLs del texto del agente: falla en las tres formas (nombra archivos que no creó, crea archivos que no nombra, y una URL no es un archivo) y contradice «detectar por señal, no por string».
- Se ensancha SÓLO la vía declarada: orca-show acepta cualquier archivo → kind 'file' (zip, binarios) con nombre y peso; los bytes de un 'file' no viajan. La vía automática no se ensancha.

DECISIÓN 2 — CANVAS: la estantería (docs/CANVAS-ARTEFACTOS-2026-09-12.md §3). Nada entra solo como superficie grande. Cada agente que produjo algo gana una franja estrecha bajo su baldosa, reservada por layout.ts (como la bandeja y HARNESS_CLEAR), así nada queda enterrado. Fichas de tamaño fijo, miniaturas a 128 px (nunca el original), máx. 4 + contador «+N» que abre la galería filtrada por el agente. El PLACE explícito de hoy (superficie grande) sigue intacto y es el gesto para «verlo en grande».
Casos difíciles:
- 40 imágenes: 4 fichas + «+36»; techo global de fichas ~96; la galería es el índice.
- Vídeo pesado: nunca VideoTexture automática; ficha = primer fotograma + ▶ si los bytes llegaron; si pesa > 16 MB, ficha de glifo con «MP4 · 200 MB». Se ve en la ventana del artefacto.
- Sin miniatura (.zip, binario, .md, .html): ficha de glifo con extensión y peso; kind 'file' nunca entra en la rama de texto de media.ts.
- Zoom lejano: la estantería desaparece por debajo del peldaño 2 de labels (112 px por baldosa); el hueco reservado no se recoloca al alejarse. Marca de cuenta entre peldaño 1 y 2: aplazada a después de la primera pieza.
- Agente muerto: baldosa aún en el campo → la estantería se atenúa con ella. Archivado → sin estantería, sin ancla inventada; sigue en galería y ventana de misión. Colocación manual del operador siempre gana. placeNear sin spot deja de caer a la cámara: se niega y lo dice en el feed.

PLAN POR PIEZAS (cada una con pruebas y commit propio, git add sólo sus rutas):
P1 (captura, 2S): brief determinista de orca-show en briefs.ts (ST ya commiteó allí; si aparecen cambios ajenos, no se incluyen); orca-show/collector aceptan kind 'file' declarado; miniatura de imagen servida por el hub (/api/artifact/<id>?thumb=128) si hay forma sin dependencia nueva, si no la hace el cliente. Tests: artifacts, shims, hub.
P2 (canvas, autor del doc): estantería en layout.ts + field.ts + fichas (media.ts o módulo nuevo shelf.ts), LOD, clic → ventana, contador → galería filtrada, guardas de 'file' y de placeNear. Tests: layout, placed-files, harness-field, shots.
P3 (líder): caso real de punta a punta con un agente de verdad (un miembro genera una imagen por Bash y la declara con orca-show; se confirma en la consola viva), typecheck + suite completa, relevo.
APLAZADO con motivo: atlas instanciado (optimización a medir con flota real); persistir estantería/colocaciones en el hub (la estantería se deriva del mundo, no hace falta); render de miniatura para .html (requiere captura de iframe).

## Filtros que cubren este documento

Decisión sin código: sin suite propia. Las piezas que nombra llevan las suyas: `artifacts shims hub` (P1), `layout placed-files harness-field` (P2).
