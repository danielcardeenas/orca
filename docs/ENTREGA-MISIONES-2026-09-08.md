# Entrega — Misiones: lectura, resultados, ventana propia y conversación con el líder

**Misión:** `mission_mts6nu8pct7mqctr`
**Implementador:** Q8 · `87c2dede-8318-4240-a1ab-2c4806ce0a17` · squad `mission-03`
**Fecha:** 2026-09-08
**Estado:** implementado y verificado. **Sin commit** (ver §7).

Este fichero existe porque el informe no cabe en un `orca-tell`: el canal lo
truncó dos veces. La versión íntegra es ésta; la descripción del comportamiento,
para quien venga después, está en [MISSIONS.md](MISSIONS.md) («Cómo se navega»,
«El panel del HUD», «Los resultados», «Hablar con quien la llevó»).

---

## 1. Qué pidió el operador y qué hay

| Petición | Dónde está | Confirmado por |
| --- | --- | --- |
| Panel de misiones arriba a la **izquierda** | `src/ui/styles/hud.css` (`.missions`) | geometría real medida: `left 62`, `top 150` ≥ `mast.bottom 137.7` |
| Filas **compactas**, sin párrafos ni multilínea | `src/ui/hud/missions.ts` | altura de fila 42px → **22px** en la consola viva |
| Título y misión **completos por clic Y teclado** | detalle de fila, `<button aria-expanded>` | arnés: `Enter` abre y `Enter` cierra; el texto completo se lee |
| Clic en misión terminada → **resultados** | pestaña RESULTS de `kinds/mission.ts` | arnés: una terminada abre por RESULTS |
| Resumen, cambios, **archivos y media** | secciones RESULT / WHAT CHANGED / FILES / MEDIA | probado contra el hub real (§4) |
| **Datos reales, nunca inventados** | `shared/debrief.ts`, estados vacíos explícitos | `test/debrief.test.ts` 22/22 |
| **Conversar con el líder** real o vía CAPCOM | `missionLead` + rutas LEAD / VIA CAPCOM | arnés + consola viva |
| **Ventana propia por misión** (ampliación) | `kinds/mission.ts`, kind `mission`, key `mission:<id>` | arnés: dos puertas, foco sin duplicar, cerrar no archiva |

## 2. Archivos

### Nuevos

| Fichero | Qué es |
| --- | --- |
| `src/shared/debrief.ts` | El parte de una misión: tipos del cable y `buildDebrief`, puro. Mezcla las entradas del diario (`launch`/`end`/`landing`) con la flota viva. Lo no medido es `null`, nunca `0`; `measured` dice de cuántos agentes hay registro |
| `src/ui/windows/kinds/mission.ts` | La ventana de una misión: cabecera con fase y squads, pestañas CONVERSATION / RESULTS, composer con las dos rutas. Exporta `reportedFiles` y `openingTab` |
| `test/debrief.test.ts` | Suite nueva (22 pruebas) |
| `docs/ENTREGA-MISIONES-2026-09-08.md` | Este informe |

### Modificados

| Fichero | Cambio |
| --- | --- |
| `src/shared/missions.ts` | `+missionBrief` (el encargo entero) y `+missionResult` (`final` / `progress` / `fromFleet`) |
| `src/shared/protocol.ts` | `+{ t: 'mission:debrief'; id; missionId }` en `ClientFrame`, con el porqué de que se pida y no se emita |
| `src/hub/server.ts` | `+case 'mission:debrief'`: consulta el diario por `missionId` (`kind: launch/end/landing`, límite 500) y contesta con `buildDebrief` |
| `src/ui/net/client.ts` | `+missionDebrief(missionId)` |
| `src/ui/hud/mission-status.ts` | `+missionHeadline` (el título entero, del que `missionTitle` es el recorte), `+missionLead`, y `headline` / `brief` en `MissionRow` |
| `src/ui/hud/missions.ts` | Panel reescrito: fila de una línea, detalle como disclosure, reconciliación que no roba el foco |
| `src/ui/windows/kinds/ceo.ts` | La cinta pasa de selector de vista a puerta; sale de aquí la vista de misión (`renderTalkMission`, `selected`, el scroll por conversación, el botón ARCHIVE) |
| `src/ui/windows/wm.ts` | `+'mission'` en `WinKind` y su tamaño por defecto (560×640) |
| `src/ui/console.ts` | `openMission(missionId, opts?: { tab; at })` sustituye al `openMission` de una línea |
| `src/ui/main.ts` | Registro del kind, apertura por clave estable, y el foco de ventana marca `store.activeMissionId` |
| `src/ui/styles/hud.css` | Bloque `.missions` reescrito y movido a la izquierda |
| `src/ui/styles/window.css` | Bloque `.mission-win` nuevo, `+.rail__none` |
| `test/hud-missions.shots.ts` | Arnés ampliado (§5); además, dos arreglos que lo tenían roto de antes |
| `docs/MISSIONS.md` | Secciones nuevas y filtros de validación actualizados |
| `docs/CAPCOM-CONVERSATION.md` | Nota fechada: la cinta ya no cambia de vista |

## 3. Integración y activación

No hay que activar nada: es el camino por defecto desde el primer render.

- **Puerta A — panel del HUD.** Clic en la fila (o `Enter` sobre el título con el
  teclado) → `c.openMission(id, { tab })`. El detalle ofrece las dos mitades con
  botones `CONVERSATION` y `RESULTS`.
- **Puerta B — cinta de CAPCOM.** Cada pestaña de la cinta y el `pick` de `MORE`
  llaman a `c.openMission(id)`. `+ NEW` crea la misión y abre su ventana.
- **Puerta C — el chip de misión** dentro del hilo general de CAPCOM
  (`data-mission-go`) llama a lo mismo.
- **Identidad y foco.** `wm.open({ key: 'mission:<id>' })`: si ya existe, el
  gestor la restaura y la enfoca y devuelve la misma ventana; si además se pide
  otra pestaña, `setTab` la cambia. **Nunca hay dos ventanas de la misma misión.**
- **Cerrar ≠ archivar.** `×` sólo quita la ventana y libera `activeMissionId`.
  Archivar es el botón `ARCHIVE` de la cabecera, con confirmación si la misión
  sigue viva.
- **Estado conservado.** El gestor persiste las ventanas docked con sus `params`,
  así que una misión abierta sigue abierta tras recargar; el borrador del
  composer vive en `draftKey('mission', id)`, uno por misión.
- **Backend.** El `case` nuevo del hub no necesita configuración: el diario ya
  existía y ya anotaba `missionId`. Un hub sin diario devolvería `journal:false`
  y la consola lo diría con esas palabras.

## 4. Pruebas ejecutadas y resultados

Ninguna repetida al escribir este informe; son las corridas reales.

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK**, sin salida |
| `npm test -- --changed` | **826/826** |
| `npm test -- debrief` | **22/22** (suite nueva) |
| `npm test -- debrief mission-status capcom talk drafts briefing command` | 215/216 — el único fallo era `briefing`, de la misión de Automejora (`report_improvements` sin declarar en el brief), ajeno a esto y ya verde en la corrida de 826 |
| `npx tsx test/hud-missions.shots.ts` | **verde**, 8 capturas |

### Qué cubre `test/debrief.test.ts` (22)

Un agente archivado sigue en el parte con lo que el diario guardó · sin `end`
anotado los números son `null` y no `0` · mientras corre mide la flota viva y
cuando acaba gana el `end` · un agente que sólo conoce el diario entra igual ·
los asignados van primero · dos `launch` no duplican · los totales suman lo
medido y cuentan `done`/`dead`/`measured` · los aterrizajes, el más nuevo primero,
con su rama y su fallo · una entrada de otra misión no se cuela · `missionBrief`
y `missionResult` (incluido el caso «cerrada sin reportar», que no inventa
resultado) · `missionHeadline` con el marcador viejo · `missionLead` en sus cuatro
formas (asignado, vivo antes que terminado, por squad, y CAPCOM nunca) ·
`reportedFiles` (absoluta y relativa con proyecto, sin adivinar la que no se
puede resolver, sin repetir, y lista vacía cuando no hay).

### Qué comprueba el arnés visual

Fases y orden · la cabecera cuenta las abiertas · **una fila plegada ocupa una
línea** (tope 30px) · nada desplegado hasta que se pide · **el panel está a la
izquierda** y por debajo del mástil, del reloj y de los bookmarks · el
desplegable **se abre y se cierra con `Enter`** y enseña el título y el encargo
enteros · el pliegue de la cabecera se recuerda en prefs · **la fila abre la
ventana de la misión**, con su título y su conversación · **abrirla otra vez no
duplica** · **una terminada abre por RESULTS** con sus cinco secciones y sus
estados vacíos dichos, no inventados · **cerrar la ventana no archiva la misión**
· **la cinta de CAPCOM abre la misma ventana** · un callsign del detalle sigue
volando la cámara · bajo 900px el panel se aparta.

### Evidencia contra el hub real (no sintético)

Sonda de la trama `mission:debrief` contra el hub de producción, misión
`mission_mtryllky54ox7buo` (terminada y archivada, sus agentes ya fuera del
mundo en memoria):

```
journal: true · totals: {"agents":4,"done":4,"dead":0,
  "linesAdded":712,"linesRemoved":0,"costUSD":5.5276,
  "durationMs":12374762,"measured":4}
  KV done +144 -0 $1.2963 3764442 · Evalúas UN frente. Trabajas en …
  CU done +208 -0 $1.2909 3745700 · Evalúas UN frente. Trabajas en …
  91 done +181 -0 $1.6561 3725651 · Evalúas UN frente. Trabajas en …
  ZF done +179 -0 $1.2843 1138969 · REEVALUACIÓN con información nueva…
landings: 0
```

Y la misma misión abierta en la consola viva, con la sección leída del DOM:

```
WHAT CHANGED  +712 −0 LINES · $5.53 · 3H 26M · 4 OF 4 AGENTS MEASURED
FILES REPORTED  veredicto.html → /Users/…/ventures/jk-detailing/veredicto.html
errores de página: []
```

Esto es lo que separa la entrega de una maqueta: cuatro agentes archivados hace
horas siguen teniendo parte, con líneas, coste y duración reales.

## 5. Evidencia visual

En `test/shots/` (dentro del repo):

| Fichero | Qué enseña |
| --- | --- |
| `hud-missions.png` | El panel a la izquierda con las cinco fases |
| `hud-missions-panel.png` | El panel recortado, filas de una línea |
| `hud-missions-detail.png` | El detalle abierto con el teclado |
| `hud-missions-folded.png` | La cabecera plegada |
| `hud-missions-open.png` | La ventana de una misión viva, en CONVERSATION |
| `hud-missions-results.png` | Dos ventanas de misión a la vez, una en RESULTS |
| `hud-missions-from-capcom.png` | La misma ventana abierta desde la cinta de CAPCOM |
| `hud-missions-narrow.png` | 390×844 |
| `hud-missions-detail-live.png` | Consola viva: detalle con el encargo real de esta misión |
| `mission-window-talk-live.png` | Consola viva: CONVERSATION con los mensajes reales |
| `mission-window-results-live.png` | Consola viva: RESULTS de una misión real con datos del diario |

Revisión acotada: **escritorio 1440×900** (todas las anteriores) y **móvil
390×844** (`hud-missions-narrow.png`). En móvil el panel del HUD sigue oculto
bajo 900px, que es la decisión de diseño previa y no la he cambiado; la puerta
en esa anchura es la cinta de CAPCOM.

## 6. Confirmaciones que pidió el operador

- **Ventana independiente por misión, desde CAPCOM y desde la barra.** Sí. Kind
  `mission`, una ventana por `mission_id`, abierta por las tres puertas de §3,
  todas por la misma llamada. Comprobado en el arnés (`hud-missions-open.png`,
  `hud-missions-from-capcom.png`) y en la consola viva.
- **Foco sin duplicados.** Sí. Segundo clic sobre la misma fila: el arnés afirma
  `count === 1`. Pedir la otra pestaña de una ya abierta cambia de pestaña, no
  abre otra ventana. Con dos misiones distintas hay dos ventanas, como debe ser.
- **Cerrar no archiva ni termina.** Sí, afirmado en el arnés: tras cerrar, la
  fila sigue en el panel. Archivar es otro botón, con confirmación.
- **Resultados, media y archivos.** Sí, con datos reales y estados vacíos
  explícitos. Los ficheros se abren en el visor de ORCA; los artefactos, en la
  ventana de artefacto.
- **Conversación con el líder.** Sí: LEAD (asignado que lidera su squad, o líder
  del squad de la misión; vivo antes que terminado; CAPCOM nunca) y VIA CAPCOM,
  que conserva el contexto porque entra en la conversación de la misión. Sesión
  terminada → botón desactivado, la hora en que acabó y un botón para leer su
  transcript. Sin líder → se dice, y sólo queda CAPCOM. Sin CAPCOM vivo → la
  línea se archiva en la misión y se contesta cuando haya sesión.

## 7. Limitaciones y avisos

1. **Sin commit.** `HEAD` sigue en `507e30c`. El árbol está compartido con la
   misión de Automejora (`mission_mts6tjnbar7u0ngy`, agente WO): un commit se
   llevaría por delante trabajo ajeno en vuelo. Los ficheros de §2 están en el
   árbol; el reparto se acordó con WO por adelantado.
2. **El hub real se reinició una vez.** Editar `src/hub/server.ts` lo reinicia
   bajo `tsx watch`. Volvió solo y CAPCOM siguió con el mismo id
   (`01a07ef6-…`). No reinicié ningún otro servicio.
3. **Bajo 900px el panel del HUD sigue oculto.** Decisión de diseño anterior, no
   la he tocado.
4. **MEDIA depende de la retención de artefactos del hub** (`ARTIFACT_RETENTION_MS`,
   ~24h y un tope): lo más viejo ya no está en el mundo, y el estado vacío lo
   dice en vez de fingir que no hubo nada.
5. **FILES es «lo que se reportó», no un diff.** Son las rutas escritas en la
   conversación, y así está rotulada la sección. Una ruta relativa sin proyecto
   conocido no se adivina: se descarta.
6. **`durationMs` de un agente vivo sale `—`**: el diario sólo lo anota al
   terminar. El total lleva «SO FAR, SOME ARE STILL RUNNING» mientras quede
   alguien corriendo.
7. **Sin suite unitaria:** `src/ui/hud/missions.ts`, `src/ui/styles/hud.css`,
   `src/ui/styles/window.css` y `src/ui/main.ts`. Los cubre el arnés visual, que
   corrí en verde; el runner de unidades los lista como «sin suite que los
   cubra» y hay que saberlo.
8. **Dos arreglos al arnés que venían de antes**, no de este trabajo:
   `test/hud-missions.shots.ts` abría la consola sin `?k=<token>` (se quedaba en
   HANDSHAKE) y no ajustaba la pref `origin`, que por defecto es `'orca'` y
   escondía entera la flota sintética. Sin ellos el arnés no podía pasar.
9. **`report_mission` lo tiene que llamar CAPCOM.** Un worker no dispone de esa
   herramienta; avisé por `orca-tell` a H6 y a `squad:mission-03` con el
   `mission_id` exacto y la ruta de este fichero.

## Validación

```
npm run typecheck
npm test -- --changed                          826/826
npm test -- debrief                            22/22
npx tsx test/hud-missions.shots.ts             el panel y la ventana, en verde
```
