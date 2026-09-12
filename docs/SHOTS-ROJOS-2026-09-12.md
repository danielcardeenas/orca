# Los cuatro shots rojos, cerrados uno a uno

Misión `forge-shots-rojos`. Cuatro shots en rojo y un veredicto por cada uno:
**el shot está desactualizado, o el código está roto**. Ninguno se silencia.

El punto de partida del brief era un censo de otro día y de otro sitio. Lo
primero fue correr la puerta entera en el checkout principal, que es donde
estas cosas se deciden:

```
npm run shots                                  13/16 · 5m
  file-browser   OK          ← el brief lo daba rojo
  shelf          OK          ← el brief lo daba rojo
  hud-missions   FALLA       ← rojo que el brief no traía
  hud-mobile     FALLA       ← «other is 44x44 (0x0)», como decía
  tether         FALLA       ← pero en otro sitio, y en otro distinto cada vez
```

Dos de los cuatro estaban verdes aquí, y había un quinto rojo que nadie había
visto. Eso ya dice algo del terreno, y es la mitad de esta entrega.

## 1 · `hud-mobile` — el shot, en cuatro sitios

**Veredicto: el shot estaba desactualizado. El código está bien, y en un caso
lo estaba desde antes de que el shot naciera.** Cuatro desfases, todos del
mismo commit gigante `188e359`, todos invisibles porque nadie corría la puerta.

| qué afirmaba | qué pasa de verdad |
|---|---|
| todo `.win__btn` mide 44×44 | FRONT y PIN sólo existen sobre el plano del canvas; en el teléfono (`spatial` es falso con `MOBILE()`, `wm.ts`) salen con `hidden` y miden 0×0. Exigirle tamaño de dedo a un control que el dedo no alcanza. Medido en dos sitios: el bloque 6d y `chromeFits`, que barre TODAS las ventanas en todos los tamaños |
| el verbo es `STOP` | es `STOP…`, con puntos, desde `b21db43`: parar un agente pide confirmación y motivo, la misma convención que `ANSWER…` y `SAY…`. En dos sitios: vertical y apaisado |
| AUTOMEJORA vuelve a la esquina superior derecha | vive en el carril izquierdo bajo MISIONES desde `188e359` — *«Estaba flotando en la esquina derecha, y allí ni se empujaba con nadie ni dejaba de disputarle el rincón al radar»* (`improve.css`). La prueba miraba a un rincón donde ya sólo están el reloj y el radar |

Lo que se filtra no se pierde: un control retirado tiene que seguir retirado, y
eso se afirma ahora aparte (`away` vale exactamente `['front', 'pin']`). Si un
día FRONT vuelve al teléfono, entra a medirse con los demás en vez de colarse.

## 2 · `hud-missions` — el arnés, no la consola

**Veredicto: fallo real, del arnés. Arreglado.** El shot imprimía que todo
había pasado y moría después:

```
HUD missions: phases, order, one-line rows, … passed.
[shots] failed: ENOTEMPTY: directory not empty, rmdir '…/orca-visual-vPXs7P/hub/improve'
```

`shutdown()` pide al grupo de procesos que se vaya y borra el `ORCA_HOME`
temporal a continuación, sin poder esperarlo: es también el manejador de
`exit`, y ahí sólo cabe trabajo síncrono. Un hub que escribe un fichero más
entre que rimraf vacía un directorio y lo borra convierte el desmontaje en
ENOTEMPTY — y el de este shot deja `hub/improve` latiendo. `force` no cubre eso
(perdona una ruta que falta, no una ocupada); `maxRetries` sí, y sigue siendo
síncrono. Si aun así sobrevive el directorio, se dice y la corrida se mantiene:
el veredicto de un shot es lo que vio en la pantalla, no lo que consiguió
borrar de `TMPDIR`.

## 3 · `file-browser` — ni el shot ni el código: la carpeta era imposible

**Veredicto: el código está bien y la regla que devuelve el 403 es correcta.
Lo que estaba mal era la carpeta que el shot elegía cuando corre desde un
worktree.** Aquí pasa; el censo lo vio rojo porque se corrió en un worktree
enlazado. Reproducido a propósito para nombrarlo:

```
git worktree add --detach .claude/worktrees/fb-403 HEAD
cd .claude/worktrees/fb-403 && npm run shots -- file-browser
  [browser] Failed to load resource: 403 (Forbidden)
  waiting for '.win.is-files .fb__row' … Timeout 15000ms
```

La causa está en `privatePath()`, `src/hub/files.ts:149`: el hub no sirve
**nada** que lleve un segmento `.claude` — ahí viven la configuración y las
credenciales de los agentes. Y los worktrees de FORGE viven exactamente en
`.claude/worktrees/<x>`. El shot navega «este mismo repo»
(`new URL('..', import.meta.url)`), así que desde un worktree pedía una carpeta
que el hub tiene prohibido servir, y esperaba quince segundos una fila que no
podía llegar.

No se toca la regla: está bien como está. El shot elige ahora una carpeta que
el hub pueda servir — `git rev-parse --git-common-dir` da el `.git` del
checkout principal, cuyo padre tiene los mismos `src/` y `package.json` que
esta prueba nombra. Verificado en los dos sitios: pasa en el principal y pasa
dentro de un worktree bajo `.claude`.

Esto no era sólo cosa de este shot: **cualquier agente de FORGE que corra la
puerta desde su worktree veía ese rojo**, y no tenía forma de saber que era
suyo y no del repo.

## 4 · `tether` — el shot, y no en un sitio: en cinco

**Veredicto: el shot estaba mal escrito. No encontré nada roto en el código
del tirante.** El brief apuntaba al arrastre; hoy el arrastre pasa. Cinco
corridas del mismo shot, sin tocar nada entre una y otra:

| corrida | dónde murió |
|---|---|
| censo del brief | `arrastrar una ficha coloca su superficie: había 1 y hay 1` |
| 1 | `TypeError: Cannot read properties of undefined (reading 'x')`, línea 202 |
| 2 | `el puerto de la escuadra cambia con el puntero…` |
| 3 | pasó |
| 4 y 5 | `el puerto de origen cambia con el puntero…` |

Un shot que falla cada vez en un sitio distinto no está detectando cinco
averías: está midiendo mal. Y medía mal siempre igual. El shot lee la caja de
una baldosa, calcula un parche de 16×16 en su borde, hace una foto, mueve el
puntero y hace otra. Entre la primera foto y la segunda el campo **no está
quieto**: la cámara llega con easing y la flota sintética relayoutea debajo.
Si la baldosa se desplaza entre foto y foto, las dos son del suelo, salen
iguales, y la prueba acusa al tirante de no encenderse cuando lo que pasó es
que miró a otro sitio.

Lo que se añadió, con el patrón que el propio fichero ya usaba para las fichas:

- **`still(read)`** — una caja leída dos veces seguidas igual, antes de calcular
  nada sobre ella.
- **`lightsUp(anchor, port, target)`** — hace las dos fotos, **comprueba que el
  ancla no se movió entre ellas**, y sólo da por muerto el tirante cuando
  cuatro intentos con el campo parado dan la misma foto. Si el puerto acaba
  fuera del lienzo, vuela al agente y repite: un encuadre que se fue no dice
  nada del tirante. Al agotarse deja la foto de lo que estaba mirando
  (`tether-XX-nolight.png`) y un mensaje que dice dónde estaban el puerto y el
  puntero.
- **`shelfOf` ya no devuelve una lista vacía en silencio** — devolverla era
  salir por la puerta de atrás: quien llama hace `.find(...)!` y revienta
  veinte líneas más abajo con un «undefined no tiene x» que no nombra a nadie.
  Y antes de rendirse **vuela al agente**: que no haya `.chip-art` no significa
  que se haya ido, significa que la cámara lo dejó en otro peldaño — entre 44 y
  190 px la franja es una tarjeta (`.chip-badge`) y no hay ficha que contar.

## 5 · `shelf` — el punto de fallo se movía porque el sujeto se iba

**Veredicto: el shot. El código de la estantería aguanta todo lo que el shot
le pide cuando el shot mira en el momento correcto.** El brief preguntaba si
eran dos roturas encadenadas o tiempos. Son tiempos, y de un tipo concreto:

El shot elegía un agente que tuviera las cinco fichas **un instante**, lo daba
por bueno y le medía la franja unas líneas más abajo, cuando ya se había
plegado en la bandeja de su padre: `cuatro fichas y un contador, no 0`,
acusando a la estantería de algo que hizo el mock. Ahora el candidato vale si
llega entero hasta la medida (`shelfOf`, con su estabilización, dentro del
bucle de candidatos), y si no, se prueba el siguiente.

Lo demás, igual de concreto:

- **Los clics sobre fichas se reintentan.** Las fichas son nodos de un pool que
  se recicla por fotograma: el mismo `<button>` puede estar sirviendo a otro
  agente un fotograma después. Playwright reintenta mientras el elemento se
  *mueve*; lo que no puede saber es que ha dejado de ser el mismo.
- **El peldaño de la tarjeta se busca, no se supone.** Es una franja estrecha
  (44–190 px de baldosa) y la rueda da pasos gordos: el primer fotograma sin
  fichas podía haberla cruzado entera.
- **Con la baldosa fuera del lienzo no se afirma nada** y se dice por qué, que
  es lo que ya hace `shelf-routes.shots.ts` cuando el fixture no acompaña.

## 6 · El árbol limpio después de `npm run shots`

`pwa.shots.ts` reescribía `public/screenshots/{wide,narrow}.png`, que están
versionados: son assets de producto —el manifest se los da al diálogo de
instalación y `pwa.production.ts` comprueba su tamaño declarado—, así que cada
corrida de la puerta dejaba `git status` sucio y alguien tenía que devolverlos
con un `git checkout`. Un runner que exige limpiar detrás es un runner que la
gente deja de correr, que es justo el agujero que `npm run shots` vino a tapar.

Ahora la corrida fotografía en `test/shots/` (ignorado, como todo lo que saca
el arnés) y refrescar lo que se publica es una decisión de alguien:

```
npx tsx test/pwa.shots.ts --assets    y sólo entonces se tocan los versionados
```

Comprobado sobre la corrida entera: `git status` antes y después de
`npm run shots`, idénticos.

## 7 · Lo que queda, dicho claro

**La puerta no es determinista, y no por estos cuatro.** Los once shots que no
tocan la flota sintética pasan siempre, en todas las corridas. Los cinco que sí
—`file-viewer`, `framing`, `hud-mobile`, `shelf`, `tether`— pasaron **6 de 15
ejecuciones** en tres rondas seguidas medidas a propósito (1/5, 3/5, 2/5), y el
rojo cambia de sitio cada vez. `file-viewer` y `framing` los daba verdes el
censo: no es que se hayan roto, es que la moneda cayó del otro lado.

La raíz es de diseño: estos shots eligen un sujeto de una **flota sintética
viva** —agentes que nacen, se pliegan en la bandeja de su padre, mueren y se
reencuadran— y luego le hacen treinta gestos durante dos minutos. Cada gesto
es una apuesta a que el sujeto siga donde estaba. Lo que se ha hecho aquí es
enseñar a esperar a los puntos que fallaban; lo que no se ha hecho, porque es
otra pieza y una decisión de diseño, es quitar la apuesta:

- **Un sujeto que no se mueva.** El arnés ya inyecta uno —`injectSquad()`, seis
  agentes bajo `ledger-close`, estables— y la parte de `tether` que lo usa no
  ha fallado ni una vez en once corridas. Pasar el sujeto principal de `shelf`
  y `tether` a la escuadra inyectada haría deterministas los dos.
- **O un modo quieto en el mock** (`test/fake-collector.ts`): sin nacimientos
  ni muertes mientras un shot corre. Hoy no existe ese flag.

Y tres hallazgos sueltos que no toqué, cada uno con su pista:

- **`hud-mobile` · `a pinch opens no menu (salió: T1)`** — una pinza abrió el
  menú contextual. `longpress.ts` lo cancela con el segundo dedo
  (`down.size > 1`), así que o el segundo `pointerdown` no llegó en esa
  corrida o hay una carrera real. Es el único de los restantes que **podría
  ser un fallo de la consola y no del shot**, y merece mirarse con calma.
- **`hud-mobile` · `there is a tile standing still in landscape too`** — a
  844×390 el mástil envuelve y devuelve el radar, la bandeja y las pistas, y la
  banda libre queda tan estrecha que a veces ninguna baldosa cae dentro y
  quieta. Se subió de cuatro reencuadres a seis; sigue apareciendo.
- **`file-viewer` · la escala de lectura** — el zoom parte de donde la dejó el
  reencuadre anterior y a veces no llega a 0.55 en los pasos que da.
- **`tether` · el puerto de la escuadra: el candidato más serio.** La foto que
  ahora deja el shot al agotarse (`test/shots/tether-XX-nolight.png`) descarta
  la explicación cómoda. Mapeando las coordenadas del mensaje sobre la foto,
  **el parche y el puntero caen exactamente donde el comentario dice**: el
  parche a la izquierda del rótulo de `ledger-close`, sobre la línea del
  contorno (`.squad` es el rótulo; el bloque lo dibuja `pipes.ts` en WebGL), y
  el puntero en el centro de la superficie del miembro descartado. Con todo en
  su sitio, y con el puntero encima, en la foto no se aprecia tirante
  encendido entre el rótulo y la superficie, mientras que el miembro `Z1` sí
  está en lima. Eso ya no es un parche que mira a otro lado: o el tirante a un
  puerto de escuadra no se enciende en alguna condición, o se enciende por un
  camino que ese parche no cruza. El shot pasa la mitad de las veces, así que
  no se dibuja nunca queda descartado. Requiere mirarlo con `--headed`, que es
  otra sesión.

## Filtros que cubren este documento

```
npm run typecheck                                   limpio
npm test -- --changed                               visual-ports 12/12; los .shots.ts no los cubre ninguna suite, a propósito (test/shots.ts lo explica)
npm run shots                                       la puerta entera, 16 en serie
npm run shots -- tether shelf.shots                 los dos del brief que medían mal
npm run shots -- hud-mobile hud-missions            el shot desactualizado y el arnés
npm run shots -- file-browser                       y desde un worktree bajo .claude, que es donde se rompía
npx tsx test/pwa.shots.ts --assets                  refrescar las capturas de instalación, cuando alguien lo decida
```
