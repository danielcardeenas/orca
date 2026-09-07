# Retención en disco

ORCA separa la telemetría desechable de los datos de trabajo. La limpieza visual
de FLEET no elimina archivos. No se borran los transcripts de Claude/Codex.

| Archivo | Política automática |
| --- | --- |
| `~/.orca/history.jsonl` | Hasta 24 horas, 6.000 snapshots y 250.000 entradas agente×snapshot en memoria. Archivo limitado a 32 MiB después de cada flush; compactación cada hora y al arrancar cuando hace falta. |
| `~/.orca/hub/events/YYYY-MM-DD.jsonl` | 14 fechas UTC, incluida la actual. Máximo 8 MiB por archivo diario después de cada flush. |
| `~/.orca/hub/overflow/YYYY-MM-DD.jsonl` | Misma política que eventos. |
| `~/.orca/hub/tasks.json` | Estado durable de conversaciones por tarea; conserva los límites propios del TaskStore. No se borra por antigüedad. |
| `~/.orca/hub/archived.jsonl` | Lápidas de agentes archivados a mano (`archive_agents`, ARCHIVE FINISHED, `orca archive`). Append-only; un `undo` posterior levanta la lápida. Al arrancar se lee la cola (2 MiB, hasta 5.000 lápidas vigentes). No se borra por antigüedad: vale mientras exista el transcript que el collector seguiría reenviando. |
| `ceo.jsonl`, `escalations.jsonl`, memorias, configuración y resultados | Fuera de la eliminación de telemetría. No tienen un nuevo límite global impuesto por esta política. |

Los logs diarios se revisan al arrancar, al escribir y cada seis horas. Los
archivos vencidos se eliminan; los archivos demasiado grandes conservan su cola
reciente de registros completos, dejando espacio para nuevas entradas. El
timeline se reemplaza atómicamente desde su anillo. Por el límite de tamaño puede
haber menos de 24 horas disponibles tras reiniciar en una flota grande. Estos son
techos de los archivos de telemetría tras el mantenimiento, no un límite global
para todo `~/.orca`; durante el reemplazo existe además un archivo temporal.

Appends y compactaciones comparten una cola para evitar que un reemplazo borre
escrituras recientes. Las lecturas de arranque leen una cola acotada directamente
del archivo, sin cargar un JSONL entero antes de recortarlo. Las escrituras siguen
agrupadas cada 500 ms; el timeline captura normalmente cada 20 segundos y agrupa
marcas rápidas a intervalos mínimos de cinco segundos.

## Archivar agentes terminados

Decisión (2026-09-06): **archivar con lápida, no borrar.** El hub no persiste
agentes —los reconstruye del snapshot de cada collector, que reenvía también
los `done`/`dead` mientras su transcript siga en disco—, así que "marcar como
archivado y ocultar" no tenía dónde vivir: el registro se desaloja del mundo
como en la retención de una hora y lo que se persiste es la lápida (`id`,
callsign, proyecto, squad, estado, cuándo terminó, quién lo archivó). Con ella
el mundo rechaza al agente cuando el collector lo vuelve a mandar terminado, y
lo readmite —levantando la lápida— si vuelve vivo, porque una sesión reanudada
es un agente. Nada se borra en disco: ni el transcript, ni el log de eventos,
ni el timeline. Un padre terminado con hijos vivos no se archiva (se conserva
el linaje, la misma regla que la retención). Los squads no tienen registro:
uno cuyo último miembro se archiva desaparece solo, y la operación lo reporta
como `squads_retired`.

Los parámetros están en `StoreOptions` (`retentionDays`, `maxDailyBytes`) y
`HistoryOptions` (`retentionMs`, `maxFileBytes`, `maxSnapshots`, `maxEntries`).
Los valores anteriores son los predeterminados. No hay que ejecutar un comando
manual para activar la limpieza con el hub actualizado.

Medición del 2026-09-06: aproximadamente 13 MiB en `~/.orca`, unos 10 MiB del
timeline, 1,6 MiB de eventos y 0,65 MiB de overflow. El volumen observado no era
urgente; los límites previenen el crecimiento posterior. Las pruebas de
`test/retention.test.ts` cubren eliminación por edad, límite de tamaño, conservación
de conversaciones, lecturas parciales y appends simultáneos con compactación.
