# El archivo histórico sabe qué era de mentira, y el repo tiene puerta

Squad `forge-lote-01`, miembro del hub. Dos piezas que no se tocan entre sí y
comparten una idea: **la marca la declara quien sabe, y quien lee la usa.**

---

## 1. El archivo histórico y el diario dejan de contar la flota de pruebas

### Lo medido, antes de tocar nada

`~/.orca/hub/archived.jsonl`, el 2026-09-13:

| | líneas | lápidas vigentes | del arnés | reales |
|---|---:|---:|---:|---:|
| archivo del hub real | 595 | 423 (86 son `undo`) | **299** | 124 |

299 de 423 es el **71%** de lo vigente, no la mitad: la cifra de 538 del
reconocimiento del 11-09 contaba las lápidas escritas, no las que siguen en
pie. Todas de `mac-cascabel`, una máquina de `test/fake-collector.ts`. Cualquier
cifra agregada sobre el pasado —coste por proyecto, terminados contra muertos,
duración media— se calculaba sobre esa población.

El diario (`~/.orca/hub/journal`) ya estaba limpio: lo apartó
`tools/journal-sanitize.ts` el 11-09 (ver `docs/ENTREGA-JOURNAL-ARNES-2026-09-11.md`),
y desde entonces `createJournal` **descartaba** al escribir lo que viniera de
una máquina sintética.

### La decisión: marcar, no borrar — y también en el diario

Descartar es borrar. Dejaba las cifras limpias, pero el diario no podía
enseñar la serie completa a quien la pidiera ni decir cuánto había dejado
fuera, y un total que cambia sin explicación al lado es peor que uno
equivocado. Así que la regla sigue donde estaba —en el único sitio por el que
se escribe— y ahora es una marca.

| Pieza | Dónde | Qué hace |
|---|---|---|
| La lápida conserva la marca | `ArchivedAgent.synthetic`, `tombstone()` (`src/shared/archive.ts`); `World.archiveAgents` la copia de `state.machines` | Una lápida nueva nace sabiendo si su máquina era del arnés. Es el único sitio donde ese dato sobrevive: la marca la declara la máquina en su `hello` y desaparece con ella. |
| Corregir lo ya escrito, añadiendo | `SyntheticMark` (`shared/archive.ts`), `HubStore.appendSyntheticMark` y `loadArchived` (`hub/persist.ts`) | Una línea `{id, at, synthetic, mark}` por lápida vieja. El archivo es append-only y sus líneas no se reescriben nunca — `Unarchived` ya era una corrección hecha así. `loadArchived` las devuelve marcadas, y aplica la marca llegue antes o después de la lápida que corrige. |
| La herramienta | `tools/archive-mark.ts` | Sin argumentos cuenta; con `--apply` añade las marcas que falten. Por `isFixtureMachineId`, como el saneado del diario, porque en una lápida vieja sólo queda el id de la máquina. Una segunda pasada no hace nada. Nada se borra. |
| El diario marca en vez de descartar | `write()` en `createJournal` (`hub/journal.ts`); `JournalEntry.synthetic` | Las entradas del arnés se escriben con la marca. El único corte que queda es el CAPCOM del arnés, que no puede pasar por rotación del de verdad: eso es estado del hub, no un renglón que se pueda filtrar luego. |
| Las lecturas excluyen por defecto | `Journal.select/query/stats`, `JournalQuery.includeSynthetic` | `query()` y `stats()` —y con ellas `byProject`, `briefingLines`, el informe y el CLI— no cuentan lo sintético. La serie completa se pide por su nombre. |
| Y dicen cuánto excluyeron | `JournalStats.excluded`; `buildDigest` (`hub/improve.ts`); `orca journal --stats`; `journal_stats` (MCP) | En la misma estructura y en la misma línea que los totales, no en un log. El informe lo dice incluso cuando es cero: «no harness entry falls in this window». |
| Pedir la serie completa | `orca journal --synthetic`, `include_synthetic` en la herramienta MCP | Explícito, y sólo explícito. |

### El segundo fallo, que sí existía: el agregado se recortaba a 500

`stats()` pedía `MAX_LIMIT * 1000` entradas y `query()` se las recortaba a
`MAX_LIMIT` con un `Math.min` silencioso, quedándose además con las **más
viejas** de la ventana (`order: 'asc'`). Eso es literalmente el «500
lanzamientos, 0 finales» del informe del 08-09: la ventana tenía 112.216
entradas y el informe leyó las 500 primeras, todas lanzamientos.

Arreglado separando las dos cosas: `select()` devuelve todo lo que casa, sin
recortar, y el tope de 500 vive en `query()`, que es la API que pagina.
`stats()` usa `select()`. Un agregado no puede recortar la población que
agrega, y menos sin decirlo.

### Las dos métricas, releídas sobre el hub real

Ventana de 24 h que termina el 2026-09-13 a las 01:07Z, con `Journal.stats()`,
la misma que usa el informe:

| | ayer (08-09) | hoy |
|---|---|---|
| entradas leídas | 500 de 112.216 | 55 de 55, `excluded: 0` |
| lanzamientos (cabecera, agentes distintos) | 500 | 22 |
| entradas `launch` | — | 22 |
| suma de `by project` | 39 con 4 proyectos fuera | 22, los 4 proyectos |
| finales | 0 | 24 done / 6 dead |

- **`journal-endings-missing` no persiste.** Hay finales, y son más que los
  lanzamientos de la ventana porque varios agentes se lanzaron antes de ella.
- **`digest-launch-count-mismatch` no persiste como descuadre.** Cabecera 22 =
  suma por proyecto 22. Las dos reglas de conteo siguen siendo distintas
  —agentes distintos arriba, entradas de lanzamiento abajo— y ahora lo dice
  cada línea, en vez de dejar que quien lee lo descubra restando. El recorte
  a cinco proyectos también se dice (`top 5 of N · +N more with NL not shown`).

**Lo que queda abierto y no he arreglado**: los proyectos sin código salen en
el informe con su id crudo (`a303610…/-Users-…-capcom-handoffs-<uuid>-runtime`)
y ocupan puestos del top 5 con directorios de CAPCOM. Se ve en la medición de
arriba. Es legibilidad del informe, no una cifra equivocada.

### Lo que cambia para un hub de pruebas

Su diario vuelve a llenarse con el fixture, marcado. No afecta al hub real —la
guarda de `harnessHomeRefusal` impide que un arnés escriba en `~/.orca` desde
el 11-09— y en un home temporal son decenas de entradas por corrida, no los
18.686 de un rotado de entonces. A cambio, sus cifras se leen con la misma
regla que las de producción.

---

## 2. La puerta de lanzamiento por proyecto

Que todo cambio en el repositorio de ORCA pase por un squad FORGE dependía de
la disciplina de quien lanza. Una política que sólo vive ahí es una costumbre,
y se rompe el día que hay prisa: un lanzamiento suelto se saltaba el brief de
fronteras, la exclusión de la publicación automática (`hub/publisher.ts`) y el
modo de permisos, las tres cosas que ya cuelgan del prefijo del squad.

### Marca por proyecto

`~/.orca/hub/project-policy.json`:

```json
{ "projects": { "/Users/danielcardenas/projects/orca": { "forgeOnly": true } } }
```

La clave es el `projectId` o la **ruta** del proyecto; se admiten las dos
porque las dos aparecen: el id es lo que viaja en los comandos, y la ruta es lo
único que una persona reconoce y lo único que sigue valiendo con el mismo
repositorio clonado en dos Macs.

**El fichero no se crea solo.** Si no existe, no hay marcas y todos los
proyectos pasan; el hub no escribe nada por arrancar. Marcar un proyecto —el
primero o el quinto— es escribir una línea de JSON, nunca tocar un fichero
`.ts`: eso es lo que quería decir «por proyecto y no el repositorio en duro».

La marca sólo AÑADE restricción. Por eso es segura donde está: nadie gana nada
marcando un proyecto, igual que nadie gana nada declarándose sintético.

### La puerta mira la ESCRITURA, no los ficheros

`spawnWrites` (`src/shared/forge.ts`): un spawn `review` —al que el collector
le quita las herramientas de edición— y uno en `permissionMode: 'plan'` son de
sólo lectura y **pasan siempre**. Todo lo demás escribe, incluido un
`permissionMode` ausente, porque el defecto del collector edita.

Esto no es un detalle. El 12-09 hubo que lanzar dos reconocimientos de sólo
lectura sobre este mismo repositorio; una puerta que rechazara todo lanzamiento
sin prefijo habría obligado a inventar un squad FORGE para algo que no escribe
una línea, y una puerta que estorba se aprende a rodear. Y con esta forma, la
pregunta de «¿un cambio que sólo toca documentación pasa por la puerta?» se
disuelve: la puerta no puede saber qué ficheros se tocarán antes de que se
toquen, así que no mira eso.

### Dónde está y a quién alcanza

`forgeGate` (`src/hub/project-policy.ts`), llamada en `dispatchCommand`
(`src/hub/server.ts`) justo después del enrutado: el único punto por el que
pasan la consola, CAPCOM por MCP y los callers en proceso. El rechazo va en el
ack y queda en el log de eventos del hub.

**Los hijos ya estaban cubiertos, y lo comprobé en vez de fiarme.** Un miembro
no lo lanza el hub: lo pide su líder con `orca-spawn` y lo arma el collector,
y ahí `planChild` le pone al hijo el squad del padre (`who.squad ?? req.squad`,
`src/collector/spawns.ts`). Un hijo de un líder `forge-…` nace en `forge-…` y
`isForgeSquad` lo deja pasar. Hay prueba que lo ejercita con el `planChild` de
verdad, no con un squad escrito a mano: sin ella, la puerta podría estar
atrapando a los propios miembros de FORGE y el único síntoma sería un squad
que no puede crecer.

**El rechazo nombra la alternativa exacta**, con el squad que traía y el
fichero donde vive la marca:

> `OR only accepts WRITING launches from a FORGE squad (this one is "audit-01"):
> relaunch with squad "forge-<name>", or as read-only (permission_mode "plan",
> or a review spawn), which always passes. The mark is per project, in
> ~/.orca/hub/project-policy.json.`

### Alcance temporal, dicho a propósito

Se aplica **desde el lanzamiento, no desde el squad**. Un squad antiguo sin el
prefijo que siga vivo sobre un proyecto marcado verá rechazados sus
lanzamientos hijos con escritura, y el rechazo le dice cómo seguir: relanzar
bajo un squad `forge-`, o en modo lectura. Es lo correcto — eximir a los vivos
sería una puerta que se abre por antigüedad, y el lanzamiento suelto es
exactamente lo que se quería cerrar. Hoy no hay ningún squad así vivo sobre
ORCA.

### Aterriza APAGADA, y el incidente que lo decidió

**Estado, a día de hoy: la puerta no está operativa en ningún sitio.** El
código no está en `main`, el hub vivo no lo lleva, y cuando esta rama se
integre seguirá sin encenderse hasta que alguien escriba el fichero de política
a mano. Ninguna versión anterior de este documento que diga otra cosa vale.

Qué pasó. La primera versión sembraba `~/.orca/hub/project-policy.json` al
arrancar, con el repo de ORCA marcado. Parte de este trabajo se escribió por
error en el checkout principal —la orden del líder de trabajar en el worktree
del squad se quedó atrapada en `.orca/out/`, que es el fallo que otro miembro
estaba diagnosticando— y **el hub del operador se relevó a las 08:58 y se
encontró la puerta armada sobre su propio repositorio sin que nadie lo hubiera
decidido.**

Lo que hizo mientras estuvo armada, medido y no supuesto:

- **Ventana:** 08:58 → 09:23:42, cuando el proceso `orca` de producción volvió
  a arrancar tras revertir el principal (PID 47244 bajo el supervisor 15100).
  Veinticinco minutos.
- **Cero rechazos:** ni un `spawn rechazado` en
  `~/.orca/hub/events/2026-09-13.jsonl`.
- Los dos únicos lanzamientos de la ventana sobre el repo son los de las
  09:13:53, squad `forge-buzon-01` (líder y miembro). Pasaron por llevar el
  prefijo: el squad que estaba arreglando el buzón nació a través de esta
  puerta. Si el predicado no hubiera cubierto a los hijos, habrían sido
  rechazados y ese squad no existiría — el fallo silencioso exacto contra el
  que se escribió la prueba del `planChild`.

El principal se revirtió a `d9aab2a` y el fichero sembrado se conserva
renombrado como evidencia
(`project-policy.json.incidente-2026-09-13.evidencia`). **El renombrado protegía
el registro, no desactivaba la siembra:** con el código tal como estaba, el día
que la rama aterrizara en `main` la puerta se habría encendido sola otra vez.

Por eso CAPCOM decidió, y está implementado aquí, que **arrancar no escribe
nada y no enciende nada**. Sin fichero de política no hay marcas y todos los
proyectos pasan. Encender es un gesto explícito y posterior: una persona
escribe el fichero, a sabiendas, y el hub lo lee al arrancar.

```sh
cat > ~/.orca/hub/project-policy.json <<'JSON'
{ "projects": { "/Users/danielcardenas/projects/orca": { "forgeOnly": true } } }
JSON
```

Apagar es lo simétrico: quitar la entrada, o el fichero. Nada aquí lee el
fichero de la evidencia, y no se ha añadido ninguna compatibilidad que lo
vuelva a leer: se lee `project-policy.json`, ese nombre exacto y ninguna
variante.

La regla operativa que sale del incidente, y la asumo: **editar en el checkout
principal es desplegar**, porque el hub y el collector vivos corren sobre él.
Ejecutar los CLI `orca-*` desde ahí sí es seguro; escribir código, no.

Cuando se encienda, los dos lanzamientos automáticos que caen sobre el repo
seguirán pasando —el revisor de AUTOMEJORA por ser de sólo lectura
(`review: true`), el implementador por su squad `forge-…`— y hay una prueba en
la suite `improve` que lo ata a los comandos de verdad, no a un squad escrito a
mano: si la puerta les cerrara, la revisión dejaría de correr y el síntoma
sería un informe que no llega.

### El hueco conocido

Un agente que ya está dentro de un proyecto marcado puede pedirle un hijo a su
collector con `orca-spawn` sin pasar por el hub. Ese hijo hereda su squad, así
que la disciplina se propaga desde quien sí pasó por la puerta; lo que no cubre
es un agente que haya entrado al proyecto por otra vía (arrancado a mano en el
directorio, sin ORCA). El collector no conoce la política del hub, y llevársela
sería una pieza aparte.

---

## Verificación

Corrido en el worktree del squad
(`.claude/worktrees/forge-lote-01`, rama `forge-lote-01` desde `d9aab2a`), con
el trabajo de Z0 sobre la puerta de archivos ya dentro: los dos repartos son
disjuntos y las suites pasan con los dos aplicados. El checkout principal quedó
otra vez en `d9aab2a`, limpio.

Antes de mudarme había corrido todo en el principal, con los mismos números;
hubo un rato con `test/shots.ts` a medias de otro miembro (avisado por su
autor), y las corridas que cuentan son posteriores a eso.

- `npm run typecheck`: **limpio**, exit 0.
- `npm test -- --changed` (lo que alcanzan los cambios del worktree, los míos
  y los de Z0): **1040/1040**, exit 0.
- `npm test -- journal improve hub tools` (los filtros del encargo):
  **159/159**, exit 0.
- `npm test -- synthetic archive gestures`: **54/54** — la frontera entera,
  incluida la prueba de arnés contra hub real.
- `npm test -- hub-forge-gate`: **8/8**; `npm test -- hub-archive-mark`: **6/6**.
- `tools/archive-mark.ts` en seco contra el archivo real: 595 líneas, 423
  lápidas vigentes, 299 del arnés, 0 ya marcadas. **No aplicado**: escribe
  fuera del proyecto y está esperando el visto bueno del líder.

Pruebas nuevas:

- `hub-archive-mark` (suite nueva): la lápida nace con la marca de su máquina;
  el mundo la copia de `state.machines`; una marca tardía corrige una lápida
  vieja **sin tocar un byte** de las líneas anteriores; una marca que llega
  antes de la lápida que corrige también aterriza (archivar → `undo` →
  marcar → rearchivar); la herramienta cuenta en seco sin tocar nada, marca con
  `--apply`, deja intacta la línea ilegible y la lápida desarchivada, y una
  segunda pasada no hace nada; `plan()` sobre un fichero a medias de escribir
  no inventa lápidas.
- `hub-forge-gate` (suite nueva): **sin fichero de política, una escritura sin
  prefijo PASA y no se escribe nada en el directorio** —el defecto nuevo, y lo
  único que nadie volvería a comprobar a mano: si un refactor cerrara por
  omisión, el síntoma sería que nadie puede lanzar y nadie sabría por qué—;
  encender es escribir el fichero y apagar es quitarlo, con el fichero del
  incidente al lado sin que se lea; la escritura sin prefijo se rechaza y el
  rechazo nombra la alternativa; `plan` y `review` pasan; el líder FORGE pasa y
  **el hijo que `planChild` le arma también**; un proyecto sin marca no pide
  nada; la marca funciona por id y por ruta; un fichero ilegible deja la puerta
  abierta en vez de tumbar el hub; y la puerta **está cableada** — un hub de
  verdad rechaza la escritura y deja pasar la lectura por `dispatchCommand`.
- `journal`: el arnés se escribe marcado y ninguna lectura lo cuenta
  (`excluded` cuadra con lo marcado en disco), la serie completa se puede
  pedir, y `stats()` lee la ventana entera con 1.200 entradas mientras una
  página sigue topando en 500.
- `synthetic`: la prueba del hub real pasa de «el diario no anota al arnés» a
  «lo marca, no lo cuenta y dice cuánto apartó», con el fixture de verdad y
  dos collectors a mano.
- `improve`: los dos spawns que AUTOMEJORA emite pasan la puerta con ORCA
  marcado, y por las razones que se creen —`review` uno, prefijo `forge-` el
  otro—, no por casualidad.

Qué queda sin prueba automática:

- **La pasada real sobre `~/.orca/hub/archived.jsonl`.** La herramienta está
  probada sobre ficheros temporales; la aplicó el líder con permiso de CAPCOM
  el 13-09 (respaldo `archived.jsonl.bak-2026-09-13-forge-lote-01`, 299
  marcadas, las 595 líneas originales idénticas byte a byte, segunda pasada sin
  nada que hacer).
- `bin/orca.mjs` sale como «sin suite que los cubra» (lo único, junto a este
  documento): ninguna suite lo importa,
  pero la prueba `orca journal` lo **ejecuta** como proceso, y ahora comprueba
  también la línea de excluidos y `--synthetic`.
- El efecto de la puerta sobre un lanzamiento que llega hasta un collector de
  verdad: la prueba de integración llega al enrutado y ahí se queda, porque no
  hay collector conectado. Lo que sí queda probado es que el rechazo y el paso
  ocurren dentro del hub.

Filtros que cubren esta entrega: `journal`, `synthetic`, `hub-archive-mark`,
`hub-forge-gate`, `improve`, `archive`, `gestures`.
