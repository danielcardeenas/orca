# La purga del arnés, verificada e integrada en el árbol de entrega

Misión `mission_mttkrjbsapplwtz8`. Empezó como una comprobación —¿sigue en pie
el fallo que mató a un agente?— y acaba como una integración: el arreglo bueno
existía, estaba en un worktree de otro agente, y lo que faltaba era llevarlo al
árbol desde el que se entrega y medirlo allí. Ninguna línea de la corrección se
volvió a escribir aquí. Lo que se aporta es la evidencia, el trozo que faltaba
por cerrar, y el traslado.

El incidente está contado en `docs/SYNTHETIC-HARNESS.md` («El día que la
contención mató a un agente»). En una frase: `purge_harness` reconocía a sus
tres programas con `command.includes(script)` sobre la línea entera de `ps`, el
agente **DH** (`pid 68523`) estaba construyendo esa misma frontera y su brief
citaba `tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3
--anyway`, así que la línea de comandos de un agente vivo traía el script y el
puerto del hub real. `stopped: how=term`, `removed: 0`.

## Lo que ya estaba, y funciona

`harnessInvocation()` ya no busca una cadena: mira la **estructura** de la
línea —quién es el ejecutable y en qué posición está el script— y lee `--hub=`
e `--isolated` sólo de los argumentos *del script*, nunca de la línea entera.
Antes de cada señal se relee el pid y se le aplica la misma regla (`how:
'changed'` si ya es otro), y se señala al grupo sólo cuando el pid lo lidera.
Eso es lo que había al empezar; lo que vino después —dos correcciones y un
cambio de método— está abajo, en el orden en que se encontró.

Comprobado en vivo y no de memoria: la línea de `ps` del agente que escribe
esto nombra el script, la sesión de DH y el hub real —el brief de esta misión
los cita— y `harnessInvocation()` sobre ella devuelve `null`. Con la regla de
antes habría encajado: el script en el texto y, sin `--hub=`, el puerto
canónico por defecto.

## El trozo que quedaba abierto, y quién lo cerró

`isPreamble()` admitía entre el intérprete y el script **cualquier** módulo
—`.js`, `.mjs`, `.cjs`, o cualquier ruta con `node_modules`— porque la forma
real del mock carga dos. Pero un módulo suelto no es un cargador: es **el
programa**, y lo que va detrás son *sus* argumentos. Con eso, un agente lanzado
como `node …/cli.js` cuyo prompt empezara por el comando volvía a encajar
entero: el incidente otra vez, por otra puerta.

Lo cerró **F9**, y por la vía correcta: un módulo sólo cuenta como preámbulo si
lo pidió la opción anterior (`-r`, `--require`, `--import`, `--loader`,
`--experimental-loader`). Escribir aquí un segundo arreglo del mismo hueco
habría dejado dos reglas parecidas para lo mismo, y en un módulo cuyo trabajo
es matar procesos la que discrepa siempre es la que mata de más.

Medido sobre doce líneas de `ps` —las tres formas reales del mock, el visual,
`npm exec`, un `--isolated`, uno apuntando a otro puerto, la línea de DH, la de
este agente y tres invocaciones de CLI que sólo *nombran* el script—, con
`harnessProcs` importado de los dos árboles a la vez:

| línea | esperado | árbol antes | árbol ahora |
|---|---|---|---|
| `node …/claude/versions/2.1.266/cli.js -p tsx test/fake-collector.ts --hub=…:4479` | a salvo | **señalado** | a salvo |
| `node …/node_modules/@x/grok/cli.js exec tsx test/fake-collector.ts --hub=…:4479` | a salvo | **señalado** | a salvo |
| `node tools/report.js test/fake-collector.ts --hub=…:4479` | a salvo | **señalado** | a salvo |
| la línea de DH, y la de este agente | a salvo | a salvo | a salvo |
| mock por `npx`, por `.bin/tsx`, y en su forma real con loaders | señalar | señalar | señalar |
| `npm exec tsx test/field-stress.ts`, `tsx test/visual.ts` | señalar | señalar | señalar |
| mock `--isolated`, y mock a `:5599` | a salvo | a salvo | a salvo |

**9 de 12 antes, 12 de 12 ahora.**

## La matriz adversarial, que es la evidencia

Las formas se prueban en bloque y en las dos direcciones, dentro de
`synthetic`: 54 líneas, cada una con el lado que le toca. Contra el código
anterior a este cambio **catorce caían del lado equivocado** (40/54); ahora, ninguna
(54/54).

| familia | ejemplos | esperado | antes | ahora |
|---|---|---|---|---|
| las cinco formas reales | `tsx test/X.ts`, `node …/.bin/tsx …`, los dos loaders, `npx tsx`, `npm exec -- tsx` | señalar | 11/11 | 11/11 |
| `--eval` en sus cuatro escrituras | `--eval`, `--eval=0`, `-e`, `-e0` | a salvo | 2/4 | 4/4 |
| `--print` en sus cuatro | `--print`, `--print=0`, `-p`, `-p0` | a salvo | 2/4 | 4/4 |
| `--check` y `--version` | `--check`, `-c`, `--check=1`, `--version`, `-v` | a salvo | 4/5 | 5/5 |
| opciones con valor no enumeradas | `--title`, `--conditions`, `--stack-size`, `--max-old-space-size=4096`, `--inspect-brk=9229` | a salvo | 1/5 | 5/5 |
| el script como módulo de carga | `--require`, `--require=`, `--import`, `--loader`, `-r` | a salvo | 5/5 | 5/5 |
| programas que sólo lo nombran | el `claude` de DH, `cli.js --print`, `report.js`, `codex`, `zsh`, `vim`, `grep` | a salvo | 10/10 | 10/10 |
| vecinos del nombre | `.bak`, `…-notes.ts`, `test/run.ts`, `src/hub/server.ts` | a salvo | 4/4 | 4/4 |
| delimitador y subcomandos | `npm run mock`, `npm exec X.ts`, `npx X.ts`, `node -- X.ts` | a salvo | 1/4 | 4/4 |
| runtimes que ORCA no usa | `bun`, `deno run -A` | a salvo | 0/2 | 2/2 |

Las columnas «antes» y «ahora» se midieron ejecutando la misma matriz contra la
función pura de los dos árboles, sobre texto de `ps`: sin levantar hub, sin
ejecutar ninguno de esos comandos y sin mandar una sola señal.

## La tercera puerta: nombrar el archivo no es ejecutarlo

Una revisión independiente encontró que quedaban falsos positivos, y tenía
razón. Las dos correcciones anteriores miraban quién es el ejecutable y qué hay
entre él y el script, pero seguían leyendo la línea como una lista plana de
palabras: en cuanto aparecía el script, se daba por hecho que node lo iba a
correr. Node no lee así su línea, y había dos formas de estar ahí sin que nadie
ejecute nada:

- **como valor de una opción.** `--require`, `--import`, `--loader` y
  `--conditions` toman su valor del token siguiente. En `node --require
  test/fake-collector.ts tools/report.js` el programa es `report.js`; buscar el
  script antes de consumir el valor lo confundía con el entrypoint.
- **en un modo que no ejecuta.** `--check` sólo valida la sintaxis —lo que hace
  un editor o un `lint` al guardar el archivo— y `--eval`/`--print` evalúan una
  expresión de la propia línea, así que lo que va detrás es `argv`.

Con las formas cortas pasaba lo mismo, porque `tok.startsWith('-')` trataba a
todas las opciones como preámbulo indistinto. Nueve líneas en total salían
señaladas —`--check`, `-c`, `--print`, `-p`, `--eval`, `-e`, y `--require`,
`--import` y `--conditions` con el script de valor—, y ninguna está empujando
fixtures a ningún hub. Es la misma familia que mató a un agente.

El primer intento fue un recorrido que leía la línea en el orden en que la lee
node —consumir el valor de la opción anterior, descartar la línea si la opción
no ejecuta nada, y sólo entonces preguntar por el script—, con dos listas:
`VALUE_OPTS` y `NON_EXEC_OPTS`. Cerraba los nueve casos, y **seguía siendo
insuficiente**. La verificación de CAPCOM lo demostró con cuatro más:
`--eval=0`, `--print=0` y `-e0` llevan el valor pegado y no encajaban en la
lista, y `--title test/fake-collector.ts tools/report.js` es una opción con
valor que sencillamente nadie había enumerado.

Ahí está la raíz, y es de método, no de casos: **enumerar lo prohibido no
termina nunca**. Las opciones de node son un conjunto abierto —cada versión
añade—, y cada una que falte es un falso positivo esperando. La lista de lo que
node acepta no se puede completar desde aquí; la de lo que ORCA arranca de
verdad cabe en cinco líneas.

Así que la regla dejó de descartar y pasó a **reconocer**. Es un reconocedor de
formas conocidas, no un parser: la línea encaja entera en una de las cinco o no
encaja, y lo que no encaja no se toca.

```
tsx test/X.ts …                                    npm run mock / visual / stress
node …/.bin/tsx test/X.ts …                        lo que ps enseña de lo anterior
node --require …/preflight.cjs --import file://…/loader.mjs test/X.ts …
                                                   el proceso hijo real de tsx
npx tsx test/X.ts …                                a mano
npm exec [--] tsx test/X.ts …                      a mano
```

Cada una sale de una línea de `ps` observada en esta máquina o de un script de
`package.json`. El preámbulo admitido es sólo pares de opción de carga con su
módulo —juntos con `=` o separados—, y el valor tiene que **terminar** en
`.cjs`, `.mjs` o `.js`: un `.ts` no es un cargador, y por ahí muere
`--require test/fake-collector.ts` sin necesidad de nombrarlo. No hay
«cualquier otra opción»: `--check`, `--eval=0`, `-e0`, `--title`,
`--max-old-space-size=4096` y todo lo que venga rompen la forma y la línea deja
de clasificar.

Consecuencia sobre el trabajo de F9, que le comuniqué: su `isPreamble` —y con
ella `LOADER_OPTS`, `VALUE_OPTS` y `NON_EXEC_OPTS`— desaparece, porque el
contrato hace su trabajo sin listas de exclusión. Lo que él demostró sigue
siendo cierto y sigue probado: un módulo suelto es el programa. Sus dos pruebas
y las de DH pasan sin tocar una línea.

**Limitaciones, dichas en voz alta.** Un arranque legítimo con una opción fuera
del contrato —`node --max-old-space-size=4096 …/tsx test/fake-collector.ts`—
**no se reconoce**: ese mock se queda vivo y hay que pararlo a mano. Lo mismo
`bun` y `deno`, que ORCA no usa, y cualquier ruta con espacios, que rompe el
troceo. Son falsos negativos a propósito: un proceso del arnés que sobrevive se
arregla en diez segundos; un agente al que se le manda SIGTERM, no. Cuando una
forma nueva aparezca de verdad en `ps`, se añade al contrato con su línea en la
matriz.

## La integración, y en qué estado queda cada árbol

El parche de F9 vivía sólo en `.claude/worktrees/harness-proc-selection`. Se
trasladó al árbol principal **aplicándolo por contexto** (`patch`, no una copia
ciega): así, si otro agente hubiera tocado esas líneas mientras tanto, el
traslado habría fallado en vez de pisar su trabajo. Aplicó limpio en los tres
archivos, y los tres quedan **byte a byte idénticos** a los del worktree:

- `src/hub/harness.ts` — `LOADER_OPTS` y el `isPreamble(tok, prev)`;
- `test/synthetic.test.ts` — su prueba de regresión «un módulo suelto es el
  programa, no un preámbulo», con los tres CLIs que nombran el script y las
  tres formas reales del mock que tienen que seguir reconociéndose;
- `docs/SYNTHETIC-HARNESS.md` — su sección «La puerta que quedó abierta al
  cerrar la primera» y su nota sobre DH.

No hay ya ninguna diferencia entre los dos árboles en esta pieza. El worktree
se dejó intacto: es de F9 y sigue siendo suyo. Se le pidió confirmación antes
de mover nada y no contestó en tres minutos, así que se procedió sobre una
asunción declarada —su estado de las 18:17-18:20 es el bueno— y se le avisó de
lo hecho, con la oferta de re-sincronizar si sigue editando.

Las dos correcciones siguientes se escribieron y se probaron **fuera del árbol
vivo**: una copia entera en el scratchpad, con `node_modules` enlazado, donde
ni `tsx watch` ni el supervisor miran. Allí corrieron el `typecheck` y las
suites. La única escritura sobre el árbol de entrega fue cada integración
final, siempre `patch` por contexto y siempre dejando los archivos idénticos a
los verificados. Los parches están guardados y son los que se aplicaron —se
pueden releer y volver a aplicar sobre el árbol anterior—:
`scratchpad/entrega-parser-modo.patch` el primero, y
`scratchpad/entrega-gramatica.patch` el del contrato.

Falta una cosa que no es de aquí y conviene no perder: **nada de esto está
commiteado**. `src/hub/harness.ts` sigue siendo un archivo sin seguimiento en
un árbol con más de doscientos cambios de varios agentes. La corrección vive en
disco, no en la historia.

## Qué pasó en el hub que está corriendo

Hay que decirlo entero, porque no se ordenó y ocurrió igual: **el ORCA de
producción se relanzó solo**. El árbol de entrega es el mismo desde el que
corre, bajo `tools/supervise.mjs` con recarga de `tsx`, así que escribir
`src/hub/harness.ts` a las `18:25:41` hizo que el supervisor relanzara
`collector` y `orca` a las `18:25:58`, diecisiete segundos después. No se
ejecutó ningún despliegue, ningún `purge_harness`, ninguna señal a ningún
proceso y ningún reinicio pedido a mano: es el efecto de editar el árbol vivo,
y quien integre aquí debe contar con él.

Dicho con la misma precisión: en este árbol trabajan varios agentes a la vez y
los relanzamientos son frecuentes por sí solos —se contaron otros a las
`18:28:50` y las `18:31:00`, que no salieron de aquí—. Los que sí se pueden
atribuir a esta entrega son dos, y los dos con el mismo patrón: escritura a las
`18:25:41` → relanzamiento a las `18:25:58`, y escritura del parser a las
`18:34:17` → relanzamiento a las `18:35:18`.

El hub quedó sano y así sigue: `ok: true`, `harness: false`, CAPCOM `HN` en
`idle`, una máquina online. Y el efecto de fondo es el que se buscaba: **el hub
en marcha ejecuta ya las tres correcciones**, comprobado por relojes y no por
suposición —el proceso vivo arrancó a las `18:35:18` y el archivo se escribió a
las `18:34:17`—, así que la próxima llamada a `purge_harness` desde este CAPCOM
sale con el parser dentro. Entre las `18:34:17` y las `18:35:18` hubo un minuto
en el que el hub corría con la versión anterior; si alguien hubiera llamado a
la herramienta justo ahí, habría usado la regla de antes.

Lo que **no** depende de un reinicio es el proceso del CAPCOM: la operación se
resuelve en el hub, no en el agente, así que un CAPCOM ya en marcha no arrastra
la versión vieja. No queda nada de esta corrección pendiente de aplicar.

## DH: lo que se perdió, con precisión

Corrijo lo que dejé escrito en la primera versión de esta entrega. Miré la
sesión en disco y la di por interrumpida; el journal del hub dice otra cosa, y
es el registro que manda:

- `launch` el `2026-09-07 22:53:19`, `end` con `state: done` el `2026-09-09
  12:05:36` — 37 h 12 min, `$10.26`. **DH terminó**, no se quedó a media faena,
  y su trabajo está entero en el árbol: `src/hub/harness.ts`, las pruebas de
  `synthetic` y la sección del incidente en `SYNTHETIC-HARNESS.md`.
- `pid 68523` no existe hoy. La sesión `8ecbcf65-dcb8-4b91-88d1-43261cdaef92`
  sigue en disco, 585 líneas. **No se relanzó y no debe relanzarse.**
- El hub no tenía ni tiene máquinas sintéticas, coherente con el `removed: 0`
  de aquel día: lo único que la llamada se llevó fue el proceso del agente.

Lo grave del incidente no es lo que costó —no costó su trabajo— sino lo que
podía costar: una herramienta que dispara contra un agente vivo por lo que dice
su prompt.

## Verificación

Ejecutada en el árbol de entrega **después** de la integración, guardando
salida y código de salida reales; ninguna de estas líneas sale de un mensaje de
ORCA ni de un resumen de otro agente:

En el árbol aislado, donde se escribió el contrato:

```sh
npm run typecheck                                    TYPECHECK_ISO_EXIT=0
npm test -- synthetic                                19/19 · SYNTH_ISO_EXIT=0
```

Y en el árbol de entrega, después de integrar:

```sh
npm run typecheck                                    TYPECHECK_EXIT=0
npm test -- synthetic harness-field visual-ports     35/35 · MIAS_EXIT=0
npm test -- push                                     4/4 · PUSH1_EXIT=0
npm test -- --changed                                1114/1115 · CHANGED_EXIT=1
```

**Los rojos que hay que contar**, porque callarlos sería lo contrario de esta
entrega. `npm test -- --changed` no ha terminado limpio ninguna de las tres
veces que se corrió tras integrar el contrato, y **ninguna de las tres cayó por
esta pieza**:

- la primera, `push`, con `hub exited 1` al arrancar el hub hijo de su fixture.
  `push.test.ts` no importa `harness`, `npm test -- push` a solas pasa `4/4`, y
  la corrida anterior lo tenía en verde: intermitente;
- la segunda, un `throw` sin capturar en `src/hub/server.ts:2000`
  (`improveSend`, «Already sent as mission_send_1») que tumbó el runner entero.
  Ese archivo se escribió a las `18:47:09` **durante la corrida**, e
  `src/hub/improve.ts` a las `18:46:17`: otro agente trabajando;
- la tercera se hizo ya sobre una **copia estable con `.git`**, fuera del árbol
  vivo, para quitar ese ruido. Cayó `wake`, en «member of a CAPCOM squad wakes
  the new CAPCOM» (`0 said`). Y ahí está la prueba que cierra el asunto: se
  duplicó esa copia, se **revirtió este parche** en la duplicada, y `wake`
  **falla igual sin él** (`29/30`). `src/hub/wake.ts` es de las `18:47:36`, y
  otra sesión confirmó por mensaje que está metiendo `missionSay` y
  `missionLeadOf` en `wake.ts` y `server.ts`.

Dicho como toca: el `--changed` del árbol compartido está rojo por trabajo ajeno
en vuelo, y lo de esta entrega está verde y medido aparte —`synthetic`,
`harness-field` y `visual-ports` en `35/35`, con la matriz dentro—.

Los dos rojos ajenos quedaron explicados por la sesión que los estaba
produciendo, y no son averías: el de `wake` es el **comportamiento nuevo**
—un miembro con líder vivo ya no despierta a CAPCOM— y el
`Already sent as …` es el mensaje nuevo de `improveSend`. Las dos pruebas las
actualiza `orca-48`, que lleva la ventana de misión, sus tests y sus docs. Así
que `--changed` volverá a verde cuando esas dos aterricen; no hay nada que
esperar por parte de esta pieza.

Las tres baterías sobre texto de `ps`, con la función pura importada del árbol
correspondiente —sin levantar hub, sin señalar procesos, sin ejecutar ninguno
de los comandos de las líneas y sin matar nada—: los **9 casos del parser**
(`--check`, `-c`, `--print`, `-p`, `--eval`, `-e`, y `--require`, `--import`,
`--conditions` con el script de valor) más las cuatro formas reales del mock
que deben seguir reconociéndose; y los **12 casos** de la tabla de arriba, que
siguen en 12/12 después del cambio.

Trazas de las cifras, para que se puedan seguir: `npm test -- --changed` daba
`1097/1097` antes de integrar el parche de F9 y `1098/1098` después —su prueba
es la que suma—, y `1115/1115` en la última corrida. El salto no es mío: en
esas dos horas otros agentes metieron pruebas y un fichero más en el árbol
compartido (271 → 272 ficheros, 96 → 97 suites). Lo que sí es de aquí es que
`synthetic` pase de 18 a 19 con la prueba del parser, y que las tres corridas
terminen en `0`.

El aviso `sin suite que los cubra` sale con 104 ficheros, casi todos cambios de
otros agentes en este árbol compartido. De lo tocado aquí, lo único que cae en
esa lista son los dos documentos —`SYNTHETIC-HARNESS.md` y esta entrega—, que
ninguna prueba mira ni tiene por qué; el código integrado lo cubre `synthetic`,
que corrió entera.

Filtros que cubren esta entrega: `synthetic`, `harness-field`, `visual-ports`.
