# El arnés deja de escribir en el diario del hub real

Misión `mission_mtw98n0rpkpi5fo1`, propuesta de AUTOMEJORA `journal-mezcla-arnes`
(`imp_mtw91vbtzdge5edl`, revisión `rev_mtw8cgp3dupemnnh`).

La propuesta juntaba dos agujeros. Uno: un hub de pruebas (`ORCA_HARNESS=1`)
arrancado sin su propio `ORCA_HOME` escribía el diario, los eventos, las
misiones y el tablero de automejora en `~/.orca/hub`, el mismo directorio que
el hub real. Dos: el diario no miraba en ningún punto la marca `synthetic` de
la máquina, aunque el mundo sí la resta del coste. Lo que se construye sobre
el diario —el informe de AUTOMEJORA, los briefings de CAPCOM— estaba midiendo
pruebas.

## 1. La guarda: el hub se niega y los arneses se aíslan

La misión pedía una de dos: que un hub con `ORCA_HARNESS` se niegue a
arrancar sobre el `ORCA_HOME` por defecto, o que el arnés se aísle siempre.
Se hicieron las dos, y es la combinación que menos rompe:

- **Solo negarse** habría roto justo lo que más se usa: `npm run visual` sin
  `--isolated` (el camino por defecto) levantaba su hub sobre `~/.orca`, y
  varias suites de `npm test` —`serve`, `term`, `files`, `file-browser`—
  levantan un hub en proceso sin darle almacén. Todo eso habría fallado al
  arrancar.
- **Solo aislar** habría dejado la regla en el cliente, que es exactamente lo
  que falló el 2026-09-07 con `--anyway` (`docs/SYNTHETIC-HARNESS.md`): el
  próximo arnés que se olvide vuelve a mezclar, y nadie se entera en una
  semana.

Con las dos, el uso de hoy sigue igual y olvidar el aislamiento pasa a ser un
fallo al arrancar con el remedio escrito, en vez de datos mezclados. Lo único
que deja de funcionar es un `ORCA_HARNESS=1` a mano sobre `~/.orca`.

| Pieza | Dónde | Qué hace |
|---|---|---|
| Negarse | `harnessHomeRefusal`, `src/hub/harness.ts`; llamada al principio de `startHub` | Un hub de pruebas sobre el `ORCA_HOME` del operador (por omisión, nombrado, con barra final o por un enlace que acaba ahí, porque compara con `realpath`) lanza un error antes de crear el auth, el store o cualquier fichero. Un hub real no pasa por aquí. No hay flag que lo salte. |
| Aislar `npm test` | `test/run.ts` | La corrida entera usa un `ORCA_HOME` temporal que se borra al salir, salvo que alguien haya fijado otro directorio a propósito. Efecto de rebote: `npm test` deja de reescribir `~/.orca/shims` para que apunten al checkout que corre las pruebas. |
| Aislar `npm run visual` | `ensureServers`, `test/visual.ts` | Todo hub que el arnés levanta tiene su `ORCA_HOME`, con `--isolated` o sin él (antes solo con él). Cuando reutiliza un hub que ya está sirviendo, no cambia nada. `test/field-stress.ts` usa lo mismo. |

`test/fake-collector.ts --isolated` ya tenía su propio home, y sin
`--isolated` apunta al hub que se le diga: allí decide el hub.

## 2. El diario descarta lo que viene de una máquina sintética

En `createJournal` (`src/hub/journal.ts`), todas las escrituras pasan por un
único `write()`, que descarta la entrada si su `machineId` es una máquina con
la marca `synthetic`. Además cortan antes el `agent:new` (antes de la rama de
CAPCOM, para que un CAPCOM del arnés no cuente como rotación del de verdad),
el `agent:state` y el barrido. La máquina se consulta con una dependencia
nueva y opcional, `AutonomyDeps.machine`, conectada en `server.ts` a
`world.state.machines`. Si la máquina no se conoce, cuenta como real, que es
el valor por defecto en toda la frontera. `landed` y `record` pasan a
devolver `JournalEntry | null`; ningún llamante usaba lo que devolvían.

El filtro se aplica también en un hub de pruebas: sus fixtures están para
verlos en la consola, no para auditarlos.

La definición del fixture queda exportada en `test/fake-collector.ts` como
`isFixtureMachineId`: las tres máquinas de `FLEET` y sus réplicas de
`scaleFleet`, sacadas de la misma regla (`replicaId`) y no de una lista. En
un hub vivo decide la marca. `isFixtureMachineId` solo hace falta donde la
marca ya no existe, que es el saneado.

## 3. Saneado único del diario existente

Herramienta: `tools/journal-sanitize.ts`. Sin argumentos cuenta y no toca
nada; con `--apply` hace primero el respaldo y después aparta. Aparta por
`isFixtureMachineId`, porque una entrada vieja solo guarda el id de la máquina
y esa máquina ya no está en ningún mundo que se pueda consultar. El diario
vivo lo estaba escribiendo el hub real mientras tanto; la herramienta lo
cubre (detalle en su cabecera).

Aplicado el 2026-09-11 a las 01:24Z. Respaldo, apartadas e informe están en
`~/.orca/hub/journal-aparte/20260911T012453Z/` (`respaldo/`,
`apartadas.jsonl`, `informe.json`). No se borró nada.

| Fichero | Antes | Quedan | Apartadas |
|---|---:|---:|---:|
| `journal.20260908-052540.000011.jsonl` | 19.735 | 187 | 19.548 |
| `journal.20260908-053542.000011.jsonl` | 19.210 | 0 | 19.210 |
| `journal.20260908-053818.000012.jsonl` | 18.778 | 0 | 18.778 |
| `journal.20260908-053937.000013.jsonl` | 18.686 | 0 | 18.686 |
| `journal.20260908-054301.000014.jsonl` | 18.125 | 0 | 18.125 |
| `journal.20260908-112034.000015.jsonl` | 18.511 | 7 | 18.504 |
| `journal.jsonl` (vivo) | 12.942 | 295 | 12.647 |
| **Total** | **125.987** | **489** | **125.498** |

Apartadas por máquina: `vps-nue2` 48.725, `mac-cascabel` 44.188, `vps-fra1`
32.585. Las que quedan: la máquina real `a303610cd6985e46f05a53366923d07a`
tiene 475. Hay 14 más que no son flota real pero tampoco son del fixture:
`orca-visual-squad` (12), la máquina que `test/visual.ts` inyecta sin marca
`synthetic`, y `m-term` (2), el hub en proceso de `term.test.ts`, que escribía
en `~/.orca` porque no le daban almacén. Siguen en su sitio porque la regla
del saneado es la definición del fixture. Las dos vías ya no llegan al
directorio real: la segunda la cierra `test/run.ts` y la primera, la guarda.
Todas son anteriores a la ventana de 24 h.

Comprobación hecha sobre el disco: la unión de las líneas del respaldo y la
unión de «quedan + apartadas» son el mismo multiconjunto (125.987 contra
125.987, 0 diferencias en cualquiera de los dos sentidos). `state.json` se
copió idéntico.

## 4. Rastros de un hub de pruebas en misiones, tablero y demás

Solo lectura; no se borró nada.

- **Misiones** (`missions.json`, 44): ninguna tiene agentes del fixture. Se
  cruzaron los 88.707 `agentId` de las entradas apartadas contra los
  `agentIds` de todas las misiones y la intersección es vacía. El único texto
  con nombres del fixture es la propia misión `mission_mtw98n0rpkpi5fo1`, que
  los cita como evidencia. No hay misiones `mission_shot_*` de los shots.
- **Tablero de AUTOMEJORA** (`improve/improve.json`: 14 propuestas, 3
  revisiones): las tres revisiones corrieron en la máquina real, y ninguna
  propuesta la abrió un agente del fixture. Pero hay **cuatro propuestas cuya
  evidencia se midió sobre datos contaminados**: `journal-endings-missing`,
  `digest-launch-count-mismatch` (sus proyectos AM/TL/LZ son del fixture),
  `journal-mezcla-arnes` (esta), y `escalaciones-retiradas-cuentan-sin-respuesta`,
  cuya cifra de «29 retiradas por "el arnés se apagó"» sale del fake collector.
- **Fuera del alcance del saneado, también contaminado**:
  - `events/`: entradas de máquinas del fixture por día: 07-09 36.827 de
    39.370, 08-09 38.407 de 38.653, 09-09 17.435 de 20.782, 10-09 4.094 de
    28.664, 11-09 0 de 354. La retención de 14 días los irá borrando.
  - `archived.jsonl`: 299 de 538 lápidas son de agentes del fixture. El hub
    real las carga al arrancar. Conviene decidir aparte si se apartan.
  - `overflow/`: 375 y 120 líneas los días 08 y 09.
- **Ningún arnés corriendo ahora contra el hub real.** Mirado con `ps` al
  empezar: no había `fake-collector`, `visual` ni `field-stress` vivos.

## 5. Nueva medición de las otras dos propuestas (sin arreglarlas)

Hecha con `Journal.stats()` —la misma que usa el informe— sobre copias del
respaldo y del diario saneado, con la ventana de 24 h que termina el
2026-09-11 a las 01:26Z, y otra vez con la ventana del informe original del
2026-09-08 a las 07:27Z.

### `journal-endings-missing`: no persiste

| | Informe 08-09, antes | Mismo día, saneado | 24 h al 11-09, saneado |
|---|---|---|---|
| Entradas que lee `stats()` | 500 de 112.216 | 188 | 161 |
| Lanzamientos (cabecera) | 500 | 83 | 42 |
| Finales | 0 | 82 done / 19 dead | 36 done / 5 dead |

El «500 lanzamientos, 0 finales» se explica entero por dos cosas. La primera
es el arnés. La segunda es un límite: **`stats()` pasa por `query()`, y
`query()` recorta a `MAX_LIMIT` = 500 entradas, las más viejas de la
ventana.** Aquel día la ventana tenía 112.216 entradas y el informe leyó
solo las 500 primeras, que eran lanzamientos del fixture. Con el arnés
separado, la máquina real cierra a sus agentes: en la ventana actual hay 42
lanzamientos de 42 agentes y 41 finales de 38 agentes. 15 lanzados no tienen
final dentro de la ventana y 11 finales son de agentes lanzados antes.

Queda una propuesta nueva, y no se arregló aquí: ese límite de 500 en
`stats()` sigue ahí. Hoy no muerde (161 entradas en 24 h), pero en cuanto un
día pase de 500 el informe volverá a medir solo la parte más vieja de la
ventana, y no lo dirá.

### `digest-launch-count-mismatch`: persiste en parte

- **Las dos reglas de conteo** (agentes distintos en la cabecera, entradas en
  el desglose por proyecto) **no se separaron** en ninguna de las dos
  ventanas: no hubo ningún relanzamiento del mismo agente, y la cabecera es
  igual a la suma de todos los proyectos (42 = 42). El «500» de cabecera de
  aquel informe era el límite del apartado anterior.
- **El recorte a cinco proyectos sin avisar sigue.** Ahora: la cabecera dice
  42 y la línea `by project` suma 39 (33 + 2 + 2 + 1 + 1), con 4 de 9
  proyectos fuera y sin decirlo.
- **Algo que la propuesta no vio**: los proyectos sin código aparecen con su
  id crudo, tipo `a303610…/-Users-danielcardenas--orca-capcom-handoffs-<uuid>-runtime`
  o un scratchpad. Ocupan puestos del top 5 con directorios de CAPCOM y de
  pruebas, y hacen ilegible la línea.

La respuesta a la pregunta de la propuesta: no conviene fusionarlas. Solo
compartían raíz en los síntomas que venían del arnés, que ya están
separados. Lo que queda de cada una es distinto: el límite de 500 en
`stats()` en la primera, y el recorte a cinco y las etiquetas crudas en la
segunda.

## Qué no se tocó

`src/collector/model-control.ts`, `src/collector/capcom-reset.ts`, ni nada de
`src/hub/improve.ts`, tampoco el armado del informe: el filtro no lo
necesitó. Los eventos, las lápidas y el tablero se midieron pero no se
tocaron.

## Verificación

Mientras trabajaba, `main` tenía cambios sin commitear de otro worker (el techo
y la ventana de AUTOMEJORA). Durante un rato su `improve.ts` rompió el arranque
de todos los hubs (`ReferenceError: hourOf`), y eso tumbaba pruebas que no
tenían que ver con esto. Para tener una señal limpia, lo que cuenta se corrió
en un worktree creado desde `HEAD` con solo los archivos de esta entrega. Antes
del commit comprobé con `cmp` que esos archivos son byte a byte los mismos que
hay en `main`.

- `npm run typecheck` en el worktree y en `main`: limpio.
- **`npm test` completo en el worktree: 1309/1309, exit 0.**
- `npm test -- synthetic journal visual-ports` en `main`, con el trabajo del
  otro worker ya arreglado: 54/54.
- **Prueba de mutación**, en el worktree: con el filtro del diario apagado y
  la guarda apagada, fallan exactamente las cuatro pruebas previstas: el
  filtro unitario, el diario con la flota del fixture en un hub de verdad, el
  CLI del diario, y el hub hijo que tiene que negarse. Con el código
  restaurado, pasan.
- **Arnés visual por el camino por defecto**, desde el checkout principal, sin
  `--isolated` y con el hub real arriba en 4479: `ensureServers()` levantó su
  hub en un puerto libre con un `ORCA_HOME` temporal (`harness: true`). Las
  tres máquinas del fixture entraron con el token de ese home, y el
  `journal.jsonl` real no creció ni un byte en esos segundos. Al hub real solo
  se le hizo un `GET /api/health`. Al terminar no quedó ningún proceso vivo.
  Hay un ruido que ya existía y que ahora sale también sin `--isolated`:
  `shutdown()` borra el home temporal mientras el hub todavía está cerrando, y
  el hub escribe un `ENOENT` de `persist` en su salida. No se perdió nada que
  importe.

Pruebas nuevas:

- `synthetic`: «el diario no anota al arnés, y al collector real de al lado
  sí» (en un hub de verdad, con `startFakeFleet` y dos collectors a mano);
  «un hub de pruebas se niega a arrancar sobre el ORCA_HOME del operador»
  (por omisión, por enlace, con barra final, uno propio, hub real); y
  «arrancado de verdad»: `src/hub/server.ts` como proceso hijo con un `HOME`
  falso. Sin `ORCA_HOME` propio sale con error y no crea `hub/`; con él,
  escucha.
- `journal`: el filtro unitario (incluido un CAPCOM del arnés que no puede
  pasar por rotación), `isFixtureMachineId` contra la flota escalada y contra
  ids parecidos que no lo son, y el saneado. El saneado se prueba así: el
  modo en seco no toca nada, el respaldo sale igual al original, lo apartado
  sale byte a byte, lo que el hub escribe mientras se cambia el vivo se
  reparte bien, y una segunda pasada no hace nada. La prueba del CLI ya no
  depende de que el mock llene el diario: comprueba que no lo llena y siembra
  entradas reales.

Qué queda sin prueba automática: el efecto de `test/visual.ts`. `visual-ports`
importa el archivo, pero no ejercita `ensureServers`, porque haría falta
levantar hub y Vite. Lo cubre la comprobación a mano de arriba y, de rebote,
la guarda: si el arnés dejara de aislarse, su hub no arrancaría.

Filtros que cubren esta entrega: `synthetic`, `journal`, `visual-ports`.
