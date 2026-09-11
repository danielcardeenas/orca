# El arnés en cuarentena

`npm run mock` se conecta al hub real del 4479 si nadie lo impide. Alguien lo
arrancó para fotografiar la isla de workspaces y lo dejó quince minutos puesto.
Sus agentes de fixture escalan preguntas —"Should I upgrade three.js to
0.185?", "Which database should the migration target?"—, el hub no tenía forma
de distinguir una escalación inventada de una real, y se las enrutó todas al
CAPCOM de verdad: nueve minutos seguidos contestándolas, el contexto del 100%
al 10%, una compactación por el camino.

Y el bucle que lo hace peor: fotografiar esa isla **exige** arrancar el mock,
así que trabajar en el arnés era lo que quemaba al mando que trabajaba en el
arnés.

## La marca, que es la que protege siempre

Una máquina se declara `synthetic: true` en su `hello`. La marca la pone quien
la merece —`test/fake-collector.ts`— y el hub la cree, porque es una
declaración que **sólo quita permisos**: nadie gana nada declarándose falso.
Eso es lo que la hace segura de aceptar del cable, y lo que la mantiene en pie
aunque alguien arranque el mock a mano contra el puerto que sea, que es
exactamente como ocurrió.

La regla no es un filtro sobre CAPCOM sino una **cuarentena simétrica**: lo
sintético y lo real no se hablan en ninguna dirección.

- **Escalaciones.** `CapcomRouter.offer` no se la ofrece al mando si viene del
  otro mundo. Vale también para `sweep`, que es el que reofrece cada barrido lo
  que quedó pendiente: sin eso, ciento treinta preguntas muertas volvían a
  llamar a la puerta cada minuto. Se anota una línea en el feed por máquina, no
  una por pregunta.
- **Mensajes entre agentes.** Un `squad` se resuelve por la etiqueta y por nada
  más, así que un escuadrón sintético llamado como uno de verdad le pegaba el
  mensaje en el pane a agentes reales. Ahora no cruza. La excepción es el
  operador (`fromAgentId: 'ceo'`, sin máquina detrás): la voz del humano manda
  también sobre el arnés.

Lo que el arnés necesita no se pierde: la pregunta sintética **sigue en el
mundo, `pending`**, que es justo lo que hay que poder mirar y fotografiar. Y si
algún día el mock levanta su propio CAPCOM, dentro de su mundo todo funciona.

La marca es pegajosa: una máquina que ya se declaró fixture no sale de la
cuarentena porque una reconexión llegue sin marca.

## La puerta, que ahora la guarda el hub

La primera versión de esta puerta estaba en el cliente: el mock preguntaba por
`/api/health` si había mando vivo y se negaba a arrancar. Duró un día. El
2026-09-07 alguien la contestó con `--anyway` —el flag existe para el caso
legítimo— y metió **~1.330 agentes sintéticos y siete proyectos falsos** en la
consola del operador, con más de mil dólares de gasto ficticio en los
contadores; `list_fleet` pasó de 2 KB a 121 KB y dejó de servirle a CAPCOM.

La lección no es que faltara una comprobación: es que la comprobación la hacía
**quien quería entrar**. Un guardarraíl que se responde con un flag es una
pregunta, no un guardarraíl.

Así que la decisión se mudó al hub y se invirtió. **El arnés ya no pide
permiso: es el hub el que tiene que declararse de pruebas.**

- Un hub de pruebas nace con `ORCA_HARNESS` en su entorno. Lo ponen `test/run.ts`
  (la corrida de `npm test` entera), `test/visual.ts` cuando levanta el suyo, y
  el `--isolated` del propio mock. `npm start`, `npm run dev` y el servicio del
  operador **no lo tienen y no hay flag que se lo dé**: es lo único que el arnés
  no puede falsificar desde el otro lado del cable.
- Un `hello` con `synthetic: true` contra un hub que no se declara de pruebas se
  cierra con **4004** (`CLOSE_NOT_HARNESS`) y una línea en el log, *antes* de
  tocar el mundo. Ni un agente, ni un proyecto, ni un dólar llegan a existir.
- `/api/health` publica `harness: true|false`, para que quien vaya a conectarse
  pueda negarse solo con un mensaje útil en vez de estrellarse contra un cierre.

### Qué hace ahora `--anyway`

Sigue existiendo **para lo que se inventó**: un hub *de pruebas* que ya tiene un
CAPCOM vivo dentro. Dejó de ser una llave maestra.

```
$ npx tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway
[fake] ws://127.0.0.1:4479: ese hub NO se declara de pruebas, así que no admite máquinas sintéticas.
[fake] --anyway no sirve para esto y el hub cerraría la conexión de todas formas.
[fake] usa --isolated: levanta un hub propio, con su ORCA_HOME y su puerto.
```

La regla vive entera en `doorVerdict()`, una función pura que la prueba
interroga sin levantar nada. Un hub que **no contesta** tampoco abre: no saber
qué hay al otro lado es exactamente el caso en el que no se arranca.

`--isolated` da un mundo entero propio —su `ORCA_HOME` temporal, su puerto, su
hub, ya marcado— y dice cómo apuntarle una consola. Es el mismo aislamiento y
las mismas palabras que `test/visual.ts --isolated`, a propósito.

Las dos puertas dicen lo mismo y ninguna sobra: la del cliente explica la
salida, la del hub es la que no se puede saltar.

### El arnés visual dejó de compartir el hub del operador

`test/visual.ts` reutilizaba el 4479 de `npm run dev` y le arrancaba encima una
flota sintética con `--anyway`. Ésa era la vía. Ahora `sharing()` sólo lo
reutiliza si va a plantar fixtures **y** ese hub se declara de pruebas; si no,
levanta el suyo y deja el del operador como estaba. Un run que no necesita
flota (`--fleet=false`) sigue pudiendo compartir: no le inyecta nada.
`test/field-stress.ts` declina la flota estándar porque arranca las suyas,
dimensionadas, así que lo dice aparte: `{ fleet: false, fixtures: true }`.

`test/visual.ts` reconoce la flota sintética por la marca y no por el nombre de
las máquinas: el hub tiene que saber cuáles son fixtures de todos modos, y
comparar hostnames se rompería en silencio el día que el mock se renombre.

### Y un hub de pruebas no escribe en el directorio del real

La puerta decide qué máquinas entran; no decía nada de dónde escribe el hub. Un
hub de pruebas arrancado sin `ORCA_HOME` propio —el de `test/visual.ts` sin
`--isolated`, y el de cada suite de `npm test` que levantaba un hub sin darle
almacén— escribía su diario, sus eventos, sus misiones y su tablero de
automejora en `~/.orca/hub`, el del hub real. El 2026-09-11, 290 de 329
lanzamientos del diario de 24 h eran de las máquinas del fixture, y el informe
de AUTOMEJORA estaba midiendo pruebas.

- **El hub se niega.** `startHub` con `ORCA_HARNESS` sobre el `ORCA_HOME` del
  operador —por omisión, nombrado, o por un enlace que acaba ahí— no arranca, y
  lo dice con la salida (`harnessHomeRefusal`, `src/hub/harness.ts`). Antes de
  abrir un solo fichero. No hay flag que lo salte.
- **Los arneses se aíslan solos**, que es lo que mantiene el uso de siempre:
  `test/run.ts` le da a la corrida entera un `ORCA_HOME` temporal, y
  `test/visual.ts` le da uno a todo hub que levanta, con `--isolated` o sin él.
  Quien reutiliza un hub que ya sirve no cambia nada.
- **El diario no anota al arnés**, ni en un hub de pruebas: `createJournal`
  descarta toda entrada cuya máquina se declara `synthetic`. Por la marca, no
  por nombres.

Se eligió negarse **y** aislar, en vez de una de las dos. Sólo negarse habría
roto el camino por defecto de `npm run visual` y las suites que levantan un hub
sin almacén; sólo aislar habría dejado la regla en el cliente, que es
exactamente lo que falló el 2026-09-07. Así el uso actual sigue igual y
olvidarse del aislamiento es un fallo al arrancar, no una semana de datos
mezclados. Lo único que deja de funcionar es un `ORCA_HARNESS=1` a mano sobre
`~/.orca`, y el mensaje dice qué hacer. Detalle y conteos del saneado del
diario existente: `docs/ENTREGA-JOURNAL-ARNES-2026-09-11.md`.

## La contención, por si algo se cuela igual

La puerta impide que entre. Esto es lo que se hace cuando **ya entró** — un hub
que estuvo sin ella, un mundo persistido de antes. Hasta ahora la única salida
era matar el proceso a mano y archivar agente por agente: 1.330 fixtures, uno a
uno.

`purge_harness`, una herramienta MCP de CAPCOM, hace las dos cosas en una
llamada y en el único orden que funciona:

1. **Para los procesos** del arnés que apuntan a *este* hub —`fake-collector.ts`,
   `visual.ts`, `field-stress.ts`—, SIGTERM primero para que el mock haga su
   retirada ordenada, SIGKILL sólo al que la ignore.
2. **Purga el mundo** (`World.purgeSynthetic`): máquinas marcadas, sus agentes,
   sus proyectos, sus preguntas, sus artefactos, sus colisiones y sus lápidas.

El orden no es un detalle: un mock vivo replanta sus tres máquinas en cuanto se
le purga por debajo. Por eso es **una** herramienta y no dos — entre dos
llamadas cabía justo la carrera que hace inútil a la primera.

El alcance es la marca y sólo la marca. Un agente real en una máquina real no
se toca ni aunque su proyecto se llame igual que uno de fixture: **la máquina es
el ancla, el nombre no**. Y del lado de los procesos, sólo reconoce tres
programas y sólo mata los que apuntan a este puerto; `test/run.ts` está fuera de
la lista a propósito —`npm test` no le mete nada al hub y matarlo sería tirar la
verificación de otro agente—, y un `--isolated` tampoco se toca, porque tiene su
propio mundo.

Esto es también la respuesta a *"necesito que CAPCOM pueda hacer ese kill"*: no
se le dio un `Bash(kill:*)` en su `settings.json`. `--allowedTools mcp__orca` ya
cubre esta herramienta, así que un CAPCOM recién nacido la tiene sin **ningún**
permiso nuevo — y lo que tiene es una operación que no sabe matar otra cosa. Un
`kill` de shell habría podido con cualquier pid de la máquina.

Lo que **no** borra: el feed. Sus líneas no llevan máquina, así que no hay forma
de distinguirlas; la tira es acotada y se vacía sola.

### El día que la contención mató a un agente

El 2026-09-09, en un latido, CAPCOM llamó a `purge_harness` y la herramienta
paró al agente **DH** (`pid 68523`) — el que había construido esta misma
frontera. Reportó `stopped: test/fake-collector.ts how=term` y `removed: 0`:
ni una máquina sintética, porque no había ninguna. Sólo el agente.

La regla de entonces era una cadena dentro de una línea:

```ts
const script = HARNESS_SCRIPTS.find((s) => command.includes(s));
```

`command` es la línea entera de `ps`, y el brief de DH citaba literalmente
`tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway`. Un
prompt viaja en la línea de comandos, así que ahí estaban las dos condiciones:
el script y el puerto del hub real. Los dos leídos de una frase. Y el disparo
fue al **grupo** (`kill(-pid)`) sin comprobar si ese pid lo lideraba, de modo
que el alcance no era ni siquiera el proceso que se creía estar matando.

Un `includes` sobre una línea de `ps` no distingue **ejecutar** de **nombrar**,
y en una flota de agentes que hablan del repo, nombrar es constante: un editor
abierto en el archivo, un `grep`, un brief, este mismo documento en la pantalla
de alguien. La corrección es mirar la estructura, no el texto:

- **quién es el ejecutable**: una lista blanca corta de intérpretes (`node`,
  `tsx`, `npm`, `npx`, `bun`, `deno`). `claude`, `codex`, `zsh`, `vim` y
  cualquier otro quedan fuera por no estar, aunque lleven el nombre del script
  en los argumentos;
- **en qué posición está el script**: tiene que aparecer como el archivo que se
  ejecuta, comparando por segmentos de ruta —`test/fake-collector-notes.ts` y
  un `.bak` ya no cuelan— y con sólo preámbulo por delante (opciones, loaders,
  `npm exec`). La primera palabra suelta de un prompt rompe la forma;
- **de dónde se leen `--hub=` y `--isolated`**: de los argumentos *del script*,
  nunca de la línea entera. Eso es lo que impedía que un texto declarase el
  puerto del hub real.

Y antes de cada señal, dos comprobaciones que no existían: se **relee el pid**
y se le aplica la misma regla sobre su comando actual —entre la foto y el
disparo el número puede haber cambiado de dueño; si ya no clasifica, se informa
como `changed` y no se le manda nada— y se señala **al grupo sólo si el pid es
el líder del grupo**. Señalar `-pid` de quien no lo lidera alcanza a sus
hermanos, a su shell y a su pane: aquí se viene a parar un proceso, no una
sesión.

#### La puerta que quedó abierta al cerrar la primera

La regla estructural admitía, entre el intérprete y el script, cualquier módulo
suelto: un token acabado en `.js`, `.mjs` o `.cjs`, o cualquier ruta con
`node_modules`. Estaba puesto por una razón buena —la forma real del mock carga
dos, `--require .../preflight.cjs` y `--import file://.../loader.mjs`— pero
metía en el preámbulo algo que no es un cargador. **Un módulo suelto es el
programa**, y lo que viene detrás son sus argumentos.

Con eso, el incidente entero volvía a encajar por otra puerta:

```
node .../claude/versions/2.1.266/cli.js --print «arregla test/fake-collector.ts --hub=…»
node tools/report.js test/fake-collector.ts
```

El primero es otra vez un agente al que le hablan del arnés —ejecutable de la
lista blanca, `cli.js` colado como preámbulo, `--print` como opción, y el prompt
aportando script y puerto—; el segundo, cualquier herramienta que reciba la ruta
como argumento. Medidos contra el código de esa primera corrección: los dos
salían señalados.

Ahora un módulo sólo cuenta como preámbulo si lo pidió una opción de carga
(`-r`, `--require`, `--import`, `--loader`, `--experimental-loader`). Las cuatro
formas reales del mock —`tsx` como ejecutable, el par de loaders de node,
`.bin/tsx` y `npm exec tsx`— siguen reconociéndose, que es la mitad que no se
puede perder al arreglar la otra.

#### Y la tercera: dejar de enumerar lo prohibido

Quedaba una lista plana donde node lee una gramática. La regla recorría los
tokens y, en cuanto veía el script, daba por hecho que iba a correr; pero un
`tok.startsWith('-')` no distingue una opción de su valor, ni un modo que
ejecuta de uno que no. `node --check test/fake-collector.ts` —lo que corre un
editor al guardar—, `node --print …` y `node --require test/fake-collector.ts
tools/report.js`, donde el programa es `report.js`, salían señalados.

El primer arreglo fue enumerar: una lista de opciones que toman valor y otra de
opciones que no ejecutan. Cerró nueve casos y se quedó corto a la primera
revisión, porque `--eval=0` y `-e0` llevan el valor pegado y `--title` es una
opción con valor que nadie había puesto en la lista. **Las opciones de node son
un conjunto abierto**: enumerar lo prohibido no termina nunca, y cada hueco es
un falso positivo esperando.

Así que la regla dejó de descartar y pasó a **reconocer**. El contrato entero
son cinco formas, todas sacadas de `ps` o de `package.json`:

```
tsx test/X.ts …                                    npm run mock / visual / stress
node …/.bin/tsx test/X.ts …                        lo que ps enseña de lo anterior
node --require …/preflight.cjs --import file://…/loader.mjs test/X.ts …
npx tsx test/X.ts …
npm exec [--] tsx test/X.ts …
```

Entre el ejecutable y el script sólo cabe un par de opción de carga con su
módulo —con `=` o separados—, y el valor tiene que terminar en `.cjs`, `.mjs` o
`.js`: un `.ts` no es un cargador, y por ahí muere `--require
test/fake-collector.ts` sin necesidad de nombrarlo. Lo que no encaja entero en
una de las cinco no se toca, sea `--check`, `--eval=0`, `--title`,
`--max-old-space-size=4096` o lo que traiga la próxima versión de node.

El precio, dicho a propósito: un arranque legítimo con una opción fuera del
contrato no se reconoce, y ese mock se queda vivo hasta que alguien lo pare a
mano. `bun` y `deno` tampoco están, porque ORCA no los usa. Un proceso del
arnés que sobrevive se arregla en diez segundos; un agente al que se le manda
SIGTERM, no. Cuando una forma nueva aparezca de verdad en `ps`, se añade al
contrato con su línea en la matriz.

#### Qué le pasó a DH, y qué se perdió

Nada de su trabajo. DH **terminó bien**: el journal lo cierra en `done` a las
`09-09 04:05`, tras 37h12m y $10.26, con su entrega redactada —«el hub real
sigue en pie, limpio, con su CAPCOM vivo»—. Lo que construyó está entero en el
árbol: `src/hub/harness.ts`, las pruebas de esta suite y esta misma sección.

Lo que se perdió fue el proceso, no el resultado, y conviene decirlo con la
misma precisión con la que se cuenta el fallo: la herramienta disparó contra un
agente al que no tenía por qué alcanzar, y eso es grave por lo que pudo pasar
—un agente a media faena pierde el contexto de su sesión— más que por lo que
pasó. La purga del mundo que acompañaba al disparo se llevó `0` máquinas: no
había ninguna que llevarse.

## Irse sin dejar restos

Un collector de verdad que se apaga deja sesiones que **siguen existiendo en
disco**, y el hub hace bien en conservarlas. Las del mock no existen en ninguna
parte: cuando el proceso muere no queda nada a lo que correspondan. Así que
ahora se retira al recibir SIGTERM o SIGINT — `agent:gone` por cada agente,
`escalation:withdraw` por cada pregunta abierta, y espera al cierre del socket,
porque `process.exit` no espera a nadie.

Y del lado del hub: **la pregunta se va con el agente**. Un agente desalojado,
archivado o cuya sesión ya no existe no puede recibir la respuesta, así que
dejarla `pending` era dejar en la cola del humano una pregunta que ya no le
sirve a nadie. Así es como el hub llegó a tener ciento treinta.

Los agentes decorativos del mock —los que producen la isla de fuera de la
flota— van `pinned`: el reciclador de terminados no los toca. Antes
desaparecían a los veinte segundos, de modo que la isla que se iba a
fotografiar se vaciaba sola.

## El recinto, que es lo que se ve

La cuarentena impedía que el arnés le costara el mando a nadie. Seguía
costando la pantalla: `npm run visual` levanta tres máquinas de fixture con sus
proyectos, y esos proyectos entraban en la espiral como islas de verdad —cada
una en su slot, empujando el espaciado de las reales— mientras sus preguntas
inventadas abrían ventanas encima de lo que el operador estuviera mirando, tres
por tanda. Al acabar las pruebas todo desaparecía y la flota volvía a colocarse.
Trabajar con la consola delante mientras corren las pruebas era eso.

Ahora lo del arnés se dibuja **junto**, no **entre**:

- **Un recinto, no seis islas.** Todos los agentes de fixture que salieron del
  mismo directorio caen en una sola isla, `~harness/<slug>`, sean tres máquinas
  o una. No toma slot en la espiral y no cuenta para su espaciado, así que la
  flota de verdad no se mueve ni medio milímetro porque alguien corra las
  pruebas — es la primera prueba de `harness-field`, y es la que importa.
- **Pegado a su anfitrión.** El arnés declara en su `hello` de qué directorio
  salió (`harnessOf`, el slug de su `cwd`), y la consola planta el recinto a la
  derecha de la isla de ese proyecto, a ras de su borde de arriba; si ahí no
  cabe, prueba el otro lado, arriba, abajo, y en último caso baja hasta
  despejar. Sin anfitrión declarado se va al margen. El campo lo rotula
  `~~ harness · orca`: de quién son estas pruebas, en una línea.
- **Encerrado, y que se vea.** El recinto lleva el marco de una región dibujado
  dos veces, una pared dentro de otra. Es lo único del campo con doble línea, así
  que se lee como valla y no como parcela desde el zoom en el que una isla es un
  bloque, antes de que ningún rótulo tenga letras. El chip del rótulo repite ese
  doble borde, y la tarjeta de una pregunta suya también.
- **Nada suyo se abre solo.** Una escalación o un artefacto de una máquina de
  fixture no abre ventana: nadie espera esa respuesta —el hub ya la tiene en
  cuarentena— y la ventana la paga el operador con su pantalla. Sigue en la cola,
  apagada y rotulada `HARNESS`, y se abre si la abre él. La tarjeta pierde el
  ámbar: el ámbar es «hace falta una persona aquí», y aquí no hace falta nadie.

El origen sólo se cree sobre una máquina que ya se declaró fixture. `synthetic`
es una declaración que quita permisos y por eso se acepta del cable; `harnessOf`
sólo dice dónde dibujar, y aceptarlo de una máquina real sería dejar que
cualquiera se cuelgue de la isla de un proyecto ajeno. Se conserva igual que la
marca: una reconexión sin él no vacía el recinto ya plantado.

- **Nada suyo suena.** Sus máquinas nacen, se mueren y preguntan a un ritmo que
  no es el de nadie: veinte teselas a la vez y una pregunta cada pocos segundos,
  durante todo lo que dure la prueba. El oído no distingue un mundo del otro, así
  que un arnés en marcha convertía la banda sonora de la consola en un timbre
  continuo — es decir, en nada, que es lo contrario de para qué está. Ahora el
  nacimiento, la muerte, el artefacto y la respuesta del arnés son mudos, y la
  alarma sólo suena si hay alguna pregunta de verdad esperando (`ui/hud/sound.ts`).
  Tampoco timbra: el anillo ámbar de pantalla entera —el gesto más caro que hace
  la consola— no lo dispara un bloqueo de fixture (`ui/hud/alarm.ts`). El
  destello lima de pantalla es otra cosa y nunca fue suyo: sale de la ventana
  LAUNCH cuando el operador levanta una flota, y del enlace del hub al volver.

Lo que **no** cambia: el arnés sigue contando en el mástil, en la alarma y en
el número de agentes de la flota — se ve, no se oye. Sus preguntas siguen en la
cola. Ver algo raro ahí es el motivo por el que se fotografía la isla.

Lo que **sí** cambió es el dinero. El total de gasto de la flota
—`state.fleet.costUSD`, el que enseña el HUD y publica `/api/health`— deja fuera
lo que gastaron agentes de máquinas marcadas: ahí es donde entraron los mil
dólares del incidente. El rollup de cada proyecto conserva su cifra, porque el
recinto del arnés tiene que poder dibujar la suya, y `list_fleet` sigue
listando esos proyectos —en un hub de pruebas son justo lo que hay que mirar—
pero con `synthetic: true` y una nota pegada a la línea: *test fixture: not a
repository and not real spend*. Rotulado, no escondido.

## Restos: los servidores que sobrevivían a su corrida

Los servidores que levanta `test/visual.ts` van `detached`, en su propio grupo,
y eso es deliberado: `npx` bifurca al proceso de verdad, y señalar sólo al
envoltorio dejaba una flota sintética hablándole al hub para siempre. Pero lo
que los salva de una muerte a medias del padre también los salva de una limpia:
si el arnés se va sin poder ejecutar su `shutdown` —un SIGKILL, un agente al
que le cortan la tarea, un `--keep` interrumpido a lo bruto— sus hijos siguen
sirviendo. Y no se nota: se acumulan en silencio. Medido en la máquina del
operador: siete Vite de quince horas, cada uno con su esbuild, más un hub
aislado con su mock.

No hay señal que arregle eso, porque el proceso que tendría que mandarla ya no
existe. Así que cada corrida **deja escrito lo que levantó**
(`$TMPDIR/orca-visual-runs/<pid>.json`: el pid de cada servidor y con qué se
lanzó) y la siguiente barre lo de las corridas cuyo dueño ya no vive. El
barrido va en `ensureServers`, antes de levantar nada, que es cuando importa.

Dos cosas lo hacen seguro, y son las que prueba `visual-ports`:

- **Una corrida viva es dueña de lo suyo**, incluido un `--keep` a propósito:
  se comprueba el pid del dueño antes de tocar nada suyo.
- **El pid solo no prueba nada.** Los números se reciclan, y matar a un tercero
  por un número repetido sería mucho peor que dejar un Vite colgado; por eso el
  registro guarda también con qué se lanzó el proceso, y se compara con lo que
  `ps` dice hoy de ese pid antes de mandarle nada.

Las salidas ordenadas se cubren donde faltaban: `SIGHUP` (cerrar la terminal) y
`exit` (un throw sin capturar) ahora también apagan, además de `SIGINT` y
`SIGTERM`, que ya lo hacían.

## Verificación

```sh
npm run typecheck
npm run build
npm test -- --changed                     1098/1098 el 2026-09-09
npm test -- synthetic                     19/19, con las cuatro del incidente
npm test -- synthetic harness-field visual-ports
npm test -- capcom hub messages traffic squads
npm test -- cli workspaces
npm test -- --changed
```

La frontera y la contención viven en `synthetic`, con su contraparte real en
cada prueba para que un hub que rechazara todo no las pasara:

- un hub sin la marca cierra con 4004 y no deja entrar la máquina; uno con ella
  la acepta — mismo `hello`, dos posturas;
- un collector **real** sigue entrando en el hub sin marca;
- el `startFakeFleet` entero contra un hub sin marca no coloca ni una máquina;
- `doorVerdict` en sus cinco casos, incluido el hub que no contesta;
- `purgeSynthetic` se lleva lo del arnés y deja intacto lo real;
- el total de la flota son $12 con mil dólares de fixture dentro;
- `harnessProcs` sobre una foto de `ps` de diez procesos elige cuatro, incluida
  la forma real del mock (`node --require …/preflight.cjs --import …/loader.mjs
  test/fake-collector.ts`), que sin reconocerla dejaría vivo al que sí molesta;
- **el incidente, como fixture**: la línea exacta del agente DH, más un `codex`,
  un `zsh -lc`, un `vim`, un `grep`, un `.bak` y un `…-notes.ts` — todos
  nombrando el script y el hub real — no se señalan, y el único que sí lo
  ejecuta, sí. Con la regla anterior se señalaban siete de ocho;
- **el contrato, en una matriz de 54 líneas**: las cinco formas reales se
  reconocen —`tsx`, `.bin/tsx`, el par de loaders con `=` y sin él, `npx tsx`,
  `npm exec -- tsx`— y no se toca nada más: `--eval`, `--print` y `--check` en
  sus cuatro escrituras cada una (separada, con `=`, corta, corta y pegada), las
  opciones con valor que nadie enumeró (`--title`, `--stack-size`,
  `--max-old-space-size=4096`), el script puesto como módulo de carga, los
  programas que sólo lo nombran, los vecinos del nombre, `npm run mock` y los
  runtimes que ORCA no usa. Contra la versión anterior, catorce de esas líneas
  caían del lado equivocado (40/54);
- la señal se vuelve a mirar antes de mandarse: al que lidera su grupo le llega
  a `-pid`, al que cuelga del grupo de otro sólo a su `pid`, y al pid que entre
  medias pasó a ser un agente no le llega **nada** (`how: 'changed'`).

Las dos pruebas que importan —la escalación sintética que no llega al mando y
el mensaje de escuadrón que no cruza— se ponen rojas si se quita la guarda; se
comprobó desactivándola. Cada una lleva su contraparte real en el mismo test,
para que un hub que no enrutase nada en absoluto no las pasara.

Sin cubrir por pruebas: `--isolated` y el envío real de la señal por
`stopHarnessProcs` —a quién se señala y con qué alcance sí está probado, con
`identify`/`send` inyectados; que el sistema operativo la entregue, no— se
ejercitaron a mano, porque eso levanta procesos de verdad. La comprobación contra el hub del operador,
con el comando exacto del incidente:

```
$ npx tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway
[fake] ese hub NO se declara de pruebas...                       exit 1

# y saltándose el cliente, hablando el protocolo a mano contra 4479:
CERRADO code=4004 motivo=hub real: no admite máquinas sintéticas

# el hub real, antes y después:  1 máquina, 8 agentes, 2 proyectos, $0.11
# el mismo mock con --isolated:  3 máquinas, 50 agentes, 6 proyectos, $0.00
#   (harness: true, y $0.00 porque todo su gasto queda fuera del total)
```

Del recinto, `harness-field` cubre las tres reglas —la flota real quieta, un
solo recinto, plantado junto a su anfitrión— sobre el layout, que es donde
viven. Lo que ninguna prueba mira es lo que sólo se puede ver: la doble pared,
el rótulo y la marca de la cola. Se miró a mano, contra un mundo aislado con la
flota de fixtures del mock y una máquina de verdad inyectada por el protocolo
publicado —un proyecto cuyo slug es el del repo, como el que el arnés declara—
para tener las dos cosas en el mismo campo: la isla `OR ORCA · 6` y, pegado a
su derecha y a ras de su borde de arriba, `~~ HARNESS · ORCA · 22`. La
separación de las dos paredes salió de ahí: con media unidad de gutter se leían
como una línea gruesa al zoom en el que la isla entra en pantalla.

Lo que ese ejercicio destapó, y **no** es de esta entrega: con la preferencia de
fábrica (`origin: 'orca'`) el campo esconde la flota del arnés entera, porque
sus agentes llegan sin origen verificado (`unknown`). En un navegador con
perfil nuevo —el que abre `test/visual.ts`— eso deja el campo vacío:
`waitForFleet` avisa («the fleet never populated the field») y se pierden cinco
frames. Con `origin: 'all'` en `localStorage` aparecen los 26 agentes y todo lo
demás encaja. El arreglo natural es una línea en el arnés visual; no se tocó
aquí para no meter mano en un archivo que estaban usando otros tres agentes.
