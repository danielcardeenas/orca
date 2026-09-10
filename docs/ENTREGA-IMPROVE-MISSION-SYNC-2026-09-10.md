# AUTOMEJORA · la misión le devuelve su estado a la propuesta

Misión: `mission-07`.

## El bug, con evidencia

Dos propuestas del tablero seguían en `sent` cuando su misión ya estaba
`completed` y archivada desde las 09:30Z del 2026-09-10:

| Propuesta | Misión | Misión decía | Propuesta decía |
| --- | --- | --- | --- |
| `imp_mtsckduj0xbfxnkh` (`console-usage-instrumentation`) | `mission_mtv3t4fi4vnpin1p` | `completed` + `archivedAt` | `sent`, sin notas |
| `imp_mttxv0wedohmhlen` (`active-mission-without-working-agent`) | `mission_mttxzjrueupaaqnu` | `completed` + `archivedAt` | `sent`, sin notas |

Causa: el enlace `missionId` era de ida. `dispatchForge` escribía `act: 'sent'`
y nadie escuchaba después el `changed` del `MissionStore`. Cerrar (CAPCOM,
`update_mission`/`report_mission`) y archivar (consola, `mission:archive`)
cambiaban la misión y nada más.

## Lo que cambia

- `src/shared/improve.ts`: `ImproveStatus` gana `completed` y `archived`;
  `MISSION_STATUSES`; `linkedStatus(mission)` es la única regla (archivada gana a
  terminada; `failed` sigue en `sent`); `sortProposals` hunde terminadas y deja
  las archivadas al final.
- `src/hub/improve.ts`: `ImproveStore.syncMission` (por misión, en las dos
  direcciones, con nota `system` en el hilo) y `syncMissions` (barrido de
  arranque, una sola escritura). `reopen` se niega para cualquier propuesta con
  misión, no sólo `sent`. La poda y `improveCounts` conocen los estados nuevos.
- `src/hub/server.ts`: el `changed` del `MissionStore` llama a `syncMission`
  (salvo purga); al arrancar, `syncMissions(missions.all())` con una línea de log
  si movió algo.
- `src/agents/tools-improve.ts`: `list_improvements` documenta los estados
  nuevos en `status`.
- `src/ui/hud/improve.ts` y `src/ui/styles/improve.css`: la fila de una
  terminada dice `DONE · <cuándo>` y se atenúa como las cerradas; la marca de
  misión (barra lima) pasa a la clase `is-mission`, que lleva toda propuesta con
  `missionId` —enviada o terminada— así que el destacado de «convertida en
  misión» no cambia. Las archivadas no se enseñan, ni detrás del pliegue.

No se toca `report_improvements`, ni `dispatchForge`, ni el criterio de qué
lleva la marca de misión.

## Verificación

- `npm run typecheck`: limpio.
- `npm test -- --changed`: 956/956. El aviso `sin suite que los cubra` lista
  archivos de otras misiones del árbol y, de esta, `src/ui/hud/improve.ts` e
  `improve.css`, que cubre el arnés visual de abajo.
- `npm test -- improve`: 96/96 (`AUTOMEJORA`) y 14/14 (`AUTOMEJORA · hub`), con
  las pruebas nuevas: sent → completed → archived → completed → sent con sus
  cuatro notas y persistidas; barrido de arranque que sólo mueve la enlazada y
  respeta una misión purgada; regla y orden; por el socket, cerrar y archivar
  la misión llegan a la propuesta y se empujan a la consola; y un hub que
  arranca con una misión cerrada y archivada en disco archiva su propuesta.
- `npx tsx test/hud-improve.shots.ts`: pasa, con fixtures nuevos (terminada y
  archivada) y aserciones de `DONE`, `is-mission`, OPEN MISSION sin IMPLEMENT ni
  REOPEN, y la archivada ausente al desplegar.
- Los dos casos reales: sobre una copia de `~/.orca/hub`, `syncMissions` los
  deja en `archived` con la nota `Mission archived: it leaves the board with
  it.` y un segundo barrido no mueve nada. El hub del operador se reinició a las
  17:52:33 (no desde esta misión) ya con este código, y su barrido de arranque
  dejó las dos propuestas reales en `archived` a las 17:52:34 con esa misma
  nota; coincide con el panel de misiones, donde ninguna de las dos es visible.

Queda fuera: una misión `failed` no cambia la propuesta (sigue `sent`), porque
el encargo era completar y archivar; es un cambio de una línea en
`linkedStatus` si se quiere.

Filtros de cobertura: `improve`, `forge`, `missions`.
