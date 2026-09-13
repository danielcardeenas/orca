# Los cinco shots que miran una flota viva — reconocimiento

*Sólo lectura: no se ha tocado un fichero del repo (`git status` sigue limpio).
Todo lo medido salió de `npm run shots`, que se aísla solo — `ORCA_VISUAL_ISOLATED=1`
en `test/shots.ts:72` — más una sonda propia en el scratchpad contra un hub
recién nacido con su `ORCA_HOME` de usar y tirar. El hub del operador no se tocó.*

---

## 1 · La recomendación

**B — un modo quieto en el mock — y antes que B una línea que no es ni A ni B:
pasar el contexto de Playwright a `reducedMotion: 'reduce'`** (hoy está clavado
en `'no-preference'` en `test/visual.ts:807` y otra vez en
`framing.shots.ts:109`).

El motivo en una frase: **lo que se mueve no es el sujeto, es la rejilla — toda
la flota sintética vive en UNA sola isla cuyo número de columnas es función de
la población, y la población no sólo rota sino que CRECE, de 26 agentes a más
de 100 en dos minutos y medio, a razón de un nacimiento cada 0,84 s (medido);
congelar un sujeto lo salva a él y deja a los otros cuatro shots midiendo el
mismo suelo movedizo.**

Y antes que las tres cosas, **un carácter**: el mock corre con `--speed=3`
(`test/visual.ts:1121`), que por un multiplicador aplicado dos veces (§5) da
**9×**. Medido, bajarlo a 1 pasa de 71 nacimientos por minuto a 3,6. No arregla
nada por sí solo, pero es veinte veces menos terremoto por cero riesgo.

Los tres matices que lo convierten en mezcla:

- **A sigue valiendo donde ya es gratis** — `tether` §escuadra, `shelf-routes`
  y `mission-crew` — y valdría para `framing`, que sólo necesita tres ids
  estables. Pero A **no** puede cubrir `shelf` entero ni arreglar `hud-mobile`,
  por razones concretas que están en §3, §4 y §7.
- **La premisa del brief a favor de A no se sostiene tal cual.** «La parte de
  `tether` que usa `injectSquad` no ha fallado ni una vez» es justo lo que el
  documento del repo contradice: `docs/SHOTS-ROJOS-2026-09-12.md:211-224` la
  nombra «el candidato más serio», dice que **pasa la mitad de las veces** y
  deja la sospecha de un fallo real del producto en el puerto de escuadra.
  Y el verde de los shots que se apoyan en `injectSquad` es, en parte, **verde
  de `skip`**: `shelf-routes.shots.ts` tiene seis salidas por `skip` (líneas
  97, 101, 120, 121, 129, 133) que devuelven éxito sin afirmar nada.
- **B tampoco es una sola guarda.** Hay tres manantiales de cambio en el mock
  —la retirada, la entrada en `done` y los hijos que engendra `Task`— y tapar
  uno solo deja la flota apagándose o creciendo igual. Está en §5.

---

## 2 · Lo que medí

Tres rondas de los cinco, en serie, cada shot con su hub, su Vite y su flota:

```
npm run shots -- file-viewer framing hud-mobile shelf.shots tether
```

|            | ronda 1 | ronda 2 | ronda 3 |
|---|---|---|---|
| file-viewer | OK 39s | OK 17s | OK 19s |
| framing     | OK 21s | **FALLA** 31s | OK 21s |
| hud-mobile  | OK 99s | OK 99s | **FALLA** 75s |
| shelf       | OK 28s | **FALLA** 32s | OK 33s |
| tether      | **FALLA** 14s | **FALLA** 26s | **FALLA** 56s |
| **total**   | **4/5** | **2/5** | **3/5** |

**9 de 15, no 6 de 15.** Mis números salen mejores que los del censo
(4/5, 2/5, 3/5 contra 1/5, 3/5, 2/5), pero dicen exactamente lo mismo: la tasa
no es estable y el rojo se muda. Por shot: `file-viewer` 3/3, `framing` 2/3,
`hud-mobile` 2/3, `shelf` 2/3, **`tether` 0/3**.

Seis rojos, seis sitios distintos, cinco mecanismos distintos:

| ronda | shot | dónde murió | mecanismo |
|---|---|---|---|
| 1 | tether | `arrastrar una ficha coloca su superficie: había 1 y hay 1` (`tether.shots.ts:288`) | el arrastre no colocó nada |
| 2 | framing | `the camera never settled` (`framing.shots.ts:78`, desde `:150`) | 60 lecturas y nunca dos iguales: el objetivo de la baldosa se movía |
| 2 | shelf | `sin fichas, la baldosa cuelga la tarjeta` (`shelf.shots.ts:477`) | la rueda cruzó entero el peldaño de la tarjeta |
| 2 | tether | `Clipped area is either empty or outside the resulting image`, en `patch` (`tether.shots.ts:173`, desde `:314`) | la ficha se salió del lienzo y el parche quedó fuera |
| 3 | hud-mobile | `landscape: holding opens the menu, once` (`hud-mobile.shots.ts:1060`) | el long-press cayó en el suelo |
| 3 | tether | `page.hover` agotado: *«element is not stable»* y `.srf … intercepts pointer events` (`tether.shots.ts:315`) | la ficha no se quedó quieta, y encima la superficie colocada la tapa |

Ese *«element is not stable»* lo dice Playwright con sus propias palabras, y es
el diagnóstico entero.

---

## 3 · El censo: los cinco, y qué aserción depende de que el sujeto siga vivo

### `file-viewer.shots.ts` — el que menos depende de la flota

Sujeto: `agentIds()[0]` (`:75`), y sólo para tener **una** ventana de agente.
Lo que se afirma sobre él —`:81`, `:82`, `:122`, `:149`— es apilado de
ventanas, no flota. El punto frágil real es `:116`
(`onCanvas.scale >= 0.55`): un bucle de sesenta ruedas (`:100-113`) que mueve
el puntero a `a.x + a.w - 60·a.scale` leído en cada vuelta; si el campo se
recoloca bajo la ventana del canvas, la rueda acaba cayendo fuera. Aquí A no
compra casi nada; `reducedMotion` y un campo quieto, sí. Pasó 3/3.

### `framing.shots.ts` — tres ids y una cámara

Sujetos: `ids = agentIds()`, `[a, b, c]` (`:123-124`). `b` es la baldosa a la
que se vuela; `a` y `c` abren ventana.

Aserciones que dependen de que `b` siga vivo **y quieto**: `:129` (centrada sin
ventanas), `:143` (libre de la ventana), `:144` (dentro del cristal), `:153`,
`:161`/`:162`. La dependencia es estructural, no incidental: `flyAndLand`
(`:88-102`) exige que `spotOf(b)` no haya cambiado durante el vuelo y vuelve a
volar si cambió (cinco intentos), y `landed` (`:59-79`) exige dos lecturas
consecutivas de `screenOf(b)` a menos de 0,5 px. Si `b` muere, `screenOf`
devuelve `null` para siempre y sale `no tile for <id>`.

**Se puede expresar sobre un sujeto inyectado sin perder nada**: lo que mide es
dónde aterriza una baldosa respecto a las ventanas, y le da igual de quién sea.

### `hud-mobile.shots.ts` — el que peor encaja en A

Sujeto: `settledTile()` (`:240-287`), que recorre `agentIds()` buscando una
baldosa (i) dentro del lienzo, (ii) que no caiga bajo ninguna pieza del HUD
—`.mast`, `.mmap`, `.tray`, `.secbar`, `.cmd`, `.hints`, `.bmarks`,
`.missions`, `.improve`, `.win` (`:253`)— y (iii) en el mismo sitio en dos
muestras separadas 500 ms, con hasta **seis reencuadres** (`:275`).

Aserciones colgadas del sujeto: `:851`, `:857` (el toque abre la ventana),
`:879` (el gesto largo abre el menú), `:934`, `:944`, `:951-953` (la pinza no
abre menú), `:959`, `:1056`, `:1060` (el gesto largo en apaisado).

Y aquí hay un agujero concreto del shot, no de la consola: `steadyAt`
(`:307-316`, dos lecturas iguales seguidas) **se usa en un único sitio**,
`:878`. Los gestos de `:854`, `:934`, `:944`, `:959` y `:1058` usan `tileAt`, de
una sola lectura, y caen en `?? p` cuando la baldosa se fue. El rojo que medí
—`:1060`— es exactamente eso: `tileAt` en `:1058`, sin reintento.

**Por qué A no ayuda aquí**: la restricción no es que el sujeto viva, es que
*alguna* baldosa caiga en la franja libre entre el HUD y los bordes de un
teléfono de 390 px de ancho. Hoy eso se consigue por número —hay veintitantas
baldosas y seis reencuadres para probar—. Con sólo la escuadra inyectada (siete
fichas) el shot tendría **menos** candidatos, no más.

### `shelf.shots.ts` — mitad A, mitad no

Sujeto: un candidato de `agentIds()` con `spotOf(id).trayOf === null &&
scale >= 1` (`:199-207`), probando hasta cuatro (`:223-237`), y el candidato
sólo vale si **conserva** las cinco fichas hasta la medida (`shelfOf`, `:96-128`).

Dependen del sujeto: `:240` (cinco fichas), `:242`, `:249` (el contador dice
`+N` contra los declarados del mundo), `:252`, `:259` (la franja empieza por
debajo de la baldosa), `:264` (una fila), `:307`/`:309` (de cerca la franja
sigue), `:441`/`:442` (de lejos se va y la flota sigue dibujada), `:477`
(la tarjeta), `:479`, `:480`, `:481`.

**Lo que NO se puede expresar sobre un sujeto inyectado**: `:374-378` espera a
que el mock publique un artefacto `image`, `declared`, **con URL**, y `:391`,
`:393-395` y `:415-416` comprueban que el `<img>` de la ficha **cargó de
verdad** (`naturalWidth > 0`). Eso es el único sitio de todo el repo que prueba
el camino entero hub → collector → bytes de un artefacto. `injectSquad` no
publica artefactos y no tiene al otro lado nada que sirva bytes, así que ese
tramo **exige una flota sintética viva, con o sin A**.

### `tether.shots.ts` — el peor, y ya tiene A dentro

Sujeto: el mismo bucle de candidatos (`:209-227`). Dependen de él: `:238` (el
pie dice de quién), `:270` (el asa ensancha), `:288` (arrastrar coloca), `:327`
y `:328` (el hilo de la ficha se enciende), `:335-340` (el hover en la baldosa
enciende la franja entera), `:374` (el puerto de origen), `:494`, `:516` (diez
fichas en un encuadre).

Y `:380-458` ya corre **sobre `injectSquad`**: `Z2` declara, coloca, se le
descarta, y el tirante tiene que ir al puerto del bloque. Ésa es la parte que
el brief da por incondicionalmente verde y que `docs/SHOTS-ROJOS-2026-09-12.md:211`
describe como el fallo más sospechoso que queda. En mis tres rondas el shot
murió antes de llegar ahí las tres veces, así que **no pude comprobarlo**.

---

## 4 · Qué hace hoy `injectSquad`, y qué no puede dar

`test/visual.ts:681-775`. Abre un socket de **collector** propio contra el hub
y suelta un `hello` + un `snapshot` + una `escalation`, y luego late cada cinco
segundos (`:770`).

Lo que pone, exactamente (`:728-763`):

| | callsign | estado | runtime | parentId | squad |
|---|---|---|---|---|---|
| líder | `Z1` | working | claude | — | `ledger-close`, lead |
| | `Z2` | working | codex | Z1 | `ledger-close` |
| | `Z3` | thinking | grok | Z1 | `ledger-close` |
| | `Z4` | **blocked** (pregunta, con escalación) | claude | Z1 | `ledger-close` |
| | `Z5` | idle | claude | Z1 | `ledger-close` |
| | `Z6` | **done** | codex | Z1 | `ledger-close` |
| aparte | `Z9` | working | codex | — | ninguna |

Ids fijos y derivados del callsign (`:712`), a propósito, para que una re-corrida
reemplace en vez de apilar. Máquina `orca-visual-squad`, proyecto `p_vsquad`.

**Lo que sí puede dar, y es más de lo que el brief supone:**

- **Sujetos con baldosa propia, garantizado por construcción.** Un hijo se
  pliega en la bandeja de su padre sólo si es `subagent` o `origin: 'orca'`, y
  **nunca** si lleva `squad` (`src/ui/field/blocks.ts:64,66,67`). Los seis de
  `ledger-close` llevan `squad`; `Z9` no tiene padre. Los siete caen en la rama
  `scale: 1, trayOf: null` de `src/ui/field/layout.ts:635`, que es literalmente
  el filtro que usan `shelf.shots.ts:205` y `tether.shots.ts:213`.
- **Las cinco fichas de `shelf` y el par que `tether` arrastra: sí.** Las fichas
  no vienen del hub, las inyecta la prueba con `__orca.artifact`
  (`src/ui/main.ts:1062`, `shelf.shots.ts:137-162`), que funciona sobre
  cualquier id. Y encima haría **determinista** el contador de `:249` y el
  `×N` de `:479`: hoy se cuentan contra el mundo porque el mock le publica
  cosas al sujeto por su cuenta.
- **Sobrevive al reciclado, sin discusión.** `retire()` es un método de
  `FakeMachine` (`test/fake-collector.ts:1231`) sobre su propio `this.agents`:
  no puede tocar una máquina que no es suya. Mientras el socket siga abierto y
  latiendo, la escuadra está.
- **Vive fuera de la rejilla que se mueve.** Las tres máquinas del mock se
  declaran `synthetic: true, harnessOf: HARNESS_HOME`
  (`test/fake-collector.ts:553-554`) y por eso caen todas en **un recinto
  único** (`islandIn`, `src/ui/field/layout.ts:76-82`). `injectSquad` no declara
  nada de eso, así que `p_vsquad` es una isla normal de la espiral — y «añadir
  un proyecto nunca mueve a los que ya están» (`src/ui/field/layout.ts:3-6`).

**Lo que no puede dar:**

- **Artefactos con bytes detrás.** Ni publica `artifact` por el cable ni hay un
  collector suyo al que el hub pueda ir a buscar los bytes. `shelf.shots.ts:374-416`
  se queda sin cubrir.
- **Vecinos.** Siete fichas no son veintitantas. `hud-mobile` necesita cantidad
  para encontrar hueco; `shelf.shots.ts:442` y `:505` quieren «la flota sigue
  dibujada»; `tether.shots.ts:516` quiere diez fichas en un encuadre (dos
  agentes de los siete bastan, eso sí).
- **Movimiento.** Sus agentes nunca transicionan, nunca producen, nunca hablan.
  Eso es la virtud y es el coste (§7).

Y un riesgo que hay que decir antes de apoyarse más en ella: **`injectSquad`
declara una máquina que el hub considera REAL.** No manda `synthetic` en su
`hello` (`test/visual.ts:693-696`), y `src/shared/synthetic.ts:30` es explícito
en que la marca la pone la máquina. Hoy entra una escalación `blocking` de
mentira en un hub de pruebas y no pasa nada; el día que alguien corra el arnés
contra un hub compartido, esa pregunta es indistinguible de una de verdad — que
es exactamente el incidente que `test/visual.ts:118-129` cuenta del 2026-09-07.
Arreglarlo es una línea (`synthetic: true` + un `harnessOf` propio), pero tiene
efecto secundario: la mandaría al recinto del arnés, y si el `harnessOf` es el
mismo del mock, **acabaría en la rejilla que se mueve** y perdería justo la
propiedad por la que sirve. Tendría que ser un `harnessOf` distinto.

---

## 5 · Cómo y cada cuánto recicla la flota

**Dónde.** `retire()` en `test/fake-collector.ts:1231-1240`: borra al agente,
manda `agent:gone` y **acto seguido nace otro** con `this.spawn(null, 0)`, en un
proyecto al azar. La única puerta que lleva ahí es `transition()`
(`:1087-1092`): al entrar en `done`/`dead` el agente se echa un `dwell` de
20–60 s y tira una moneda; cara, se retira.

**El reloj.** `start()` (`:733-747`) monta `every(250, () => this.tick(250))`,
y `every(ms, fn)` es `setInterval(fn, Math.max(30, ms / this.speed))` (`:736`).
Dentro, `tick(dtBase)` hace `const dt = dtBase * this.speed` (`:1011`).

**El multiplicador se aplica dos veces.** Con `--speed=3` el intervalo baja a
83 ms (doce ticks por segundo) y cada tick adelanta 750 ms: **nueve segundos
simulados por segundo real**, no tres. El arnés arranca el mock con
`--speed=3` clavado (`test/visual.ts:1121`), así que la máquina de estados de
los shots corre a 9×. Los demás temporizadores —latido, feed, tráfico,
colisiones— sólo llevan el divisor, así que van a 3×. Esto **no** es la causa
de la indeterminación, pero es el mando de volumen que la amplifica, y hoy está
puesto tres veces más alto de lo que su nombre dice.

**Qué hace una muerte en la pantalla.** Aquí está el nudo. Los tres hosts del
mock comparten un único `harnessOf` —`HARNESS_HOME`, una constante derivada del
`cwd` (`test/fake-collector.ts:66`)—, así que **todos sus agentes son una sola
isla y una sola rejilla** (`src/ui/field/layout.ts:356-362`). Dentro, se
ordenan por linaje y se empaquetan en
`cols = max(2, min(12, ceil(sqrt(n · 1.35))))` (`:373`). Dos consecuencias:

1. Una baja en medio del orden **desplaza una celda a todos los que vienen detrás**.
2. **El número de columnas es función de la población.** Con `n = 26` salen 6
   columnas; con 27, siete; con 71, diez. Cada vez que la población cruza uno
   de esos umbrales **se mueve la flota entera**.

Y el recinto del arnés no toma slot en la espiral: se planta junto a su
anfitrión y busca hueco (`:469-489`), así que al crecer puede además
**mudarse entero**.

**Es ambiente, no esencia — con una excepción.** Ninguno de los cinco shots
afirma nada sobre un nacimiento o una muerte. Lo que sí es esencial es que el
mock **siga transicionando**: los artefactos de verdad que `shelf` necesita los
produce `enter()` al entrar en `working` con la herramienta `Write`
(`:1113`). Por eso un «modo quieto» que congele la máquina de estados entera
rompería `shelf`, y el que hace falta es más estrecho: **sin nacimientos ni
muertes, con todo lo demás vivo.**

**Y ojo con la forma exacta de B, porque hay que tapar tres agujeros, no uno.**
El propio brief avisa de esto para el lado del navegador; vale igual para el
lado del mock. Una guarda sobre `retire()` y nada más no sirve:

1. **Sin `retire()` (`:1091`), la flota se desangra en silencio.** `done` es un
   estado absorbente: el `case 'done'/'dead'` de `transition()` (`:1087-1092`)
   no tiene más salida que retirarse. Sin reciclado los agentes se acumulan
   ahí hasta que la flota entera está apagada — deja de moverse, sí, pero
   también deja de producir, y la espera de noventa segundos de
   `shelf.shots.ts:374-378` se queda sin quien publique nada. Hay que impedir
   además **la ENTRADA** en `done`/`dead` (ramas `:1069` y `:1084`).
2. **Aun así la población seguiría creciendo**, porque el otro manantial de
   altas son los hijos que `enter()` engendra cuando la herramienta sale `Task`
   (`:1114-1118`), hasta tres por raíz (`:877`). Sin muertes, esos presupuestos
   se gastan igual durante el shot y la isla pasa de 26 a ~100 en los primeros
   minutos: el número de columnas vuelve a subir por escalones. Hay que poner
   `spawnBudget` a cero bajo la bandera.

Con los tres —ni retirada, ni entrada en `done`, ni `Task` que engendre— la
población queda **exactamente constante**, las columnas no se mueven nunca, y
todo lo demás sigue igual de vivo: estados, herramientas, artefactos,
escalaciones, colisiones, feed, latido.

**Medido.** Sonda propia: hub aislado (`ORCA_HARNESS=1`, `ORCA_HOME` temporal,
puerto libre) + el mock con `--speed=3 --anyway`, sondeando `/api/world` una vez
por segundo durante 151 s y diferenciando el conjunto de ids:

```
speed 3 · 151 s · población media 71 · altas 179 (71,3/min) · bajas 104 (41,4/min) · cambios de estado 3.309 (1.318/min)
speed 1 · 150 s · población media 30 · altas   9 ( 3,6/min) · bajas   3 ( 1,2/min) · cambios de estado   293 (  117/min)
```

A `--speed=3`, que es lo que corre en la puerta: **un nacimiento cada 0,84 s y
una muerte cada 1,45 s**, y son cotas **inferiores** —el muestreo es de 1 Hz y
un alta y una baja dentro del mismo segundo se cancelan—. Durante los dos
minutos que dura un shot, la rejilla se recompone del orden de doscientas veces.

A `--speed=1`, lo mismo pasa **veinte veces menos**: nueve altas y tres bajas en
dos minutos y medio. Normalizando por agente, la tasa de reproducción es
1,0/agente/min contra 0,12: **un factor 8,4**, que es la confirmación empírica
del multiplicador aplicado dos veces —predice 9— con la precisión que da un
muestreo de 1 Hz.

Y hay algo peor que el ritmo, que no esperaba y que sale de las mismas cifras:
**las altas superan a las bajas, y la flota crece sin límite.** Empieza en 26
agentes (20 del preset + 6 decorados) y en dos minutos y medio pasa de 100 —a
`speed 1` el mismo fenómeno, más lento: de 26 a ~33—. La
mecánica está en tres sitios: `spawn()` da a cada agente raíz un presupuesto de
0–3 hijos (`:877`), `enter()` los gasta cuando la herramienta sale `Task`
(`:1114-1118`), y `retire()` repone **siempre una raíz nueva** —con presupuesto
nuevo— por cada muerte, sea del que sea (`:1238`). Cada muerte devuelve, a la
larga, más de un agente. Nada lo frena.

Eso cierra el círculo con `cols = ceil(sqrt(n · 1,35))`: con la población
subiendo de 26 a 100, el número de columnas de la isla **sube por escalones
varias veces durante un mismo shot**, y en cada escalón se mueven todas las
baldosas a la vez. No es ruido de fondo: es un terremoto programado cada pocas
decenas de segundos, y los cinco shots están midiendo píxeles encima.

---

## 6 · ¿Es viable un modo quieto? Sí, y hay más de tres fuentes de movimiento

Hay **cuatro**, y —esto es lo que no esperaba encontrar— **tres de las cuatro
ya tienen interruptor, y es el mismo**: `prefers-reduced-motion`.

1. **La cámara.** `FieldCamera.step` (`src/ui/field/camera.ts:51-61`): con
   `reduce`, `c.x = t.x` y se acabó el easing exponencial. El pan y el zoom ya
   eran directos; lo que easea son los vuelos, que es justo lo que hacen los
   shots.
2. **Los tweens** (llegada de una baldosa, ventanas, nacimientos y muertes):
   todos pasan por `dur()`, que devuelve 0 bajo `reduce`
   (`src/ui/motion.ts:81-83`, `src/ui/field/anim.ts:25`).
3. **Los shaders.** `uReduce` apaga la respiración de las baldosas y detiene la
   traza que las cruza (`src/ui/field/swarm.ts:214-215,246`,
   `src/ui/field/command.ts:223-224`) y congela el discurrir de las tuberías
   (`src/ui/field/pipes.ts:175,185`), cuyos pulsos además duran `dur(...)` = 0
   (`:581`). Esto importa más de lo que parece para `tether`, que compara **dos
   fotos de un parche de 6×13 px**: con una baldosa respirando al lado, ese
   parche cambia solo, y la prueba puede pasar sin que se encienda nada.
4. **Los datos** — nacimientos, muertes, cambios de estado. **Ésta no tiene
   interruptor, y es la de B.**

De ahí la forma de la respuesta: **`reducedMotion` quita el *movimiento*; B
quita el *cambio*.** Ninguna de las dos sola deja el campo quieto —sin B, la
cámara ya no easea pero la baldosa teletransporta a su nueva celda; sin
`reducedMotion`, la baldosa ya no cambia de celda pero todo lo demás sigue
respirando—, y las dos juntas sí.

Coste de `reducedMotion`, dicho: las fotos que deja el arnés (`test/shots/`) se
quedan sin la respiración ni la traza. Son fotos de aserción, no las del comp
—ésas las saca `npm run visual`, que es otro programa—, pero conviene saberlo.
Comprobé que **ninguno de los cinco afirma nada sobre una animación**: el único
que menciona una es `framing.shots.ts:38`, y para esperarla, no para medirla.

Hay una tercera vía que ya existe y descarto: `__orca.replay(world)`
(`src/ui/main.ts:1028` → `src/ui/field/field.ts:2860-2875`) congela el mundo
entero, porque el campo pasa a leer `replay ?? store.world`. Pero enciende el
modo de repetición —banner, clase `is-replay`, sonido— y, peor, `__orca.artifact`
escribe en `store.world`, que en repetición ya no es el mundo que se dibuja. No
sirve sin reescribir las fichas.

---

## 7 · Qué se pierde con cada opción

**Con A, si los shots dejan de mirar una flota viva** (éste es el argumento
fuerte en contra, y es real):

- **Se pierde la única prueba del camino de bytes de un artefacto.**
  `shelf.shots.ts:374-416` es lo único que comprueba que un artefacto declarado
  por un collector llega con URL y que el `<img>` de su ficha **carga**. Nada
  más en el repo lo mira.
- **Se pierde que la consola aguante el relayout.** Hoy, sin quererlo, estos
  cinco shots son lo único que somete la rejilla a nacimientos y muertes
  continuos con la cámara encima. Una regresión del tipo «la estantería no
  sigue a su baldosa cuando la fila se recoloca» o «el tirante apunta a la
  celda vieja» se vería hoy —en rojo, mal explicada, pero se vería— y con A
  dejaría de verse.
- **Se pierde la escala.** Siete fichas no ejercitan el empaquetado por
  columnas, ni el recinto que se muda, ni un encuadre con la flota entera.
  `hud-mobile` en concreto **empeoraría**: su problema es encontrar hueco entre
  el HUD, y hoy lo resuelve por número de candidatos.
- Y se pierde algo menos medible: las fotos dejan de parecerse a una consola
  bajo carga, que es lo que el arnés existe para retratar.

**Con B** la pérdida es mucho más pequeña y se puede nombrar entera:

- Ningún shot volvería a ver un nacimiento ni una muerte. Es exactamente la
  misma pérdida del punto 2 de arriba — pero **sólo durante los shots**:
  `npm run visual`, `test/field-stress.ts` y el `npm run mock` de a diario
  siguen con la flota viva, así que el camino de relayout sigue teniendo quien
  lo mire, aunque sea sin aserción.
- Se pierde el «todo esto ocurre de verdad mientras la prueba mira», que es
  honesto reconocer como una pérdida de realismo: un shot que sólo pasa con la
  flota parada no demuestra que la consola aguante la flota andando.

---

## 8 · Coste comparado, aunque sea grueso

| | ficheros | líneas nuevas | aserciones a reescribir |
|---|---|---|---|
| **`reducedMotion`** | `test/visual.ts:807` y `framing.shots.ts:109` | 2 (cambiar un literal) | 0 (ninguno de los cinco afirma sobre una animación) |
| **B — modo quieto** | `test/fake-collector.ts` (opción en `FakeFleetOptions:1479-1495`, campo en `FakeMachine`, guardas en `:1069`, `:1084`, `:1091` y `:1114`, lectura del flag en `:1727-1736`) + `test/visual.ts:1121` + `test/shots.ts:72` | ~12 | **0** |
| **A — sujeto inyectado** | `test/visual.ts` (`injectSquad` parametrizable), `shelf.shots.ts:199-238`, `tether.shots.ts:209-227`, `framing.shots.ts:123-124`, `file-viewer.shots.ts:75`, `hud-mobile.shots.ts:240-287` | ~80-120 | ~6 directas (contadores fijos en `shelf:249`,`:479`; `tether:516`; las tres de `framing`), y **un bloque de selección por shot** reescrito entero |

Dos notas sobre B:

- `--quiet` ya está cogido y significa «no imprimas»
  (`test/fake-collector.ts:1735`), así que el flag necesita otro nombre
  (`--still` / `--no-churn`).
- **No debe encenderse para todo el arnés.** `ensureServers` es el mismo para
  los shots y para `npm run visual` (`test/visual.ts:1121`), y las escenas de
  `visual.ts` sí quieren una flota andando. El sitio natural es una env que
  lea `ensureServers` y que ponga el runner de los shots en la línea de al
  lado de la que ya pone: `test/shots.ts:72`. Una línea, y sólo afecta a la
  puerta.

Y un tercer ajuste, de **un carácter**, que no es ninguna de las dos y que yo
probaría el primero: **`--speed=3` en `test/visual.ts:1121` está dando 9×** por
el doble multiplicador de §5. Medido, bajarlo a 1 reduce los nacimientos de
71,3/min a 3,6/min y las muertes de 41,4/min a 1,2/min — **veinte veces menos
relayout**, sin tocar una aserción ni una línea de lógica. No es la solución
—a `speed 1` sigue habiendo un alta cada diecisiete segundos, y la puerta
seguiría sin ser determinista— pero es la medida más barata del tamaño real del
problema y hace que cualquier medida posterior se lea limpia.

---

## 9 · Defectos sueltos que vi y no toqué

Ninguno es A ni B; todos salieron de las tres rondas y sobreviven a cualquiera
de las dos decisiones.

1. **`tether.shots.ts:169-175`, `patch()` no protege un parche entero fuera del
   lienzo.** Recorta contra 0 por arriba y contra `VIEW` por abajo, pero si la
   ficha está por debajo de `y = 900` el recorte sale vacío y Playwright
   revienta con *«Clipped area is either empty»*. `lightsUp` sí tiene esa
   guarda (`:146`); el bucle de hover de `:307-324` la llama sin ella. Es el
   rojo de mi ronda 2.
2. **`hud-mobile.shots.ts:1058` usa `tileAt` donde debería usar `steadyAt`.**
   `steadyAt` existe (`:307`) y se usa en un solo sitio (`:878`). Es el rojo de
   mi ronda 3.
3. **`tether.shots.ts:284` y `:287` cuentan cosas distintas.** `antesN` cuenta
   **todos** los `.srf` del DOM; `arrastrada`, sólo los que no tienen
   `display:none`. Los `.srf` son nodos de un pool, así que la comparación
   `arrastrada > antesN` puede fallar con el arrastre funcionando. No es lo que
   pasó en mi ronda 1 (ahí salió 1 contra 1: el arrastre de verdad no colocó),
   pero es un rojo latente.
4. **`tether.shots.ts:315`: la superficie colocada tapa la franja de fichas.**
   El error dice `.srf … intercepts pointer events` sobre la ficha que se
   quiere `hover`. O el shot coloca la superficie donde estorba, o la consola
   deja que una superficie se pose encima de una estantería; no lo pude separar
   sin `--headed`.
5. **La flota sintética crece sin techo** (§5). `retire()` repone una raíz
   nueva con presupuesto nuevo por cada muerte (`test/fake-collector.ts:1238`,
   `:877`, `:1114-1118`), así que cada baja devuelve más de un agente: medido,
   de 26 a más de 100 en dos minutos y medio. `--agents=N` (`scaleFleet`,
   `:333`) dimensiona la flota **inicial**, no la de estado estacionario,
   porque no hay estado estacionario. Es a la vez la causa principal del
   relayout y la razón de que los shots largos —`hud-mobile`, 99 s;
   `tether`, dos minutos— fallen más que los cortos.
6. **El comentario de `shelf.shots.ts:91-94` y `shelf-routes.shots.ts:112-117`
   describe un peligro imposible.** Dicen que un miembro «se pliega en la
   bandeja de su padre … en el mock pasa cada pocos segundos». No puede pasar:
   el mock no pone `subagent` ni `origin: 'orca'` en los hijos que engendra
   (`test/fake-collector.ts:841-872`), y `absorbedChildren` sólo pliega con una
   de esas dos marcas (`src/ui/field/blocks.ts:66-67`). Ningún agente de la
   flota sintética se pliega jamás. La causa de que un sujeto «pierda la
   estantería» es otra: se murió, pasó a `done` —y `agentIds()` filtra
   `done`/`dead`, `src/ui/main.ts:1047`— o la cámara quedó en otro peldaño.
   Perseguir la explicación equivocada es parte de por qué estos shots llevan
   tanto sin cerrarse.

---

## 10 · Lo que no pude comprobar

- **El puerto de escuadra de `tether`** (`:454-458`), que es la evidencia
  central del brief a favor de A: el shot murió antes de llegar ahí en las tres
  rondas. No tengo un solo dato propio sobre él, ni a favor ni en contra. Lo
  único que hay es `docs/SHOTS-ROJOS-2026-09-12.md:211-224`, que dice que falla
  la mitad de las veces.
- **Si la mezcla que recomiendo deja la puerta verde.** Medí el mundo tal y
  como está; no pude correr un solo shot con `--speed=1`, con
  `reducedMotion: 'reduce'` ni con un modo quieto, porque los tres exigen
  editar. Mi confianza en el diagnóstico es alta y en el pronóstico, media.
- **Si `reducedMotion: 'reduce'` rompe algún shot de los once verdes.** No los
  corrí con el flag puesto: habría tenido que editar `test/visual.ts`, y esto
  era sólo lectura.
- **Tres rondas son tres rondas.** Mi 9/15 y el 6/15 del censo son compatibles
  con la misma moneda; ninguno de los dos tiene muestra para decir más.
- No me coordiné con el otro reconocimiento que corre en paralelo, como se pidió.

---

## Filtros que cubren este informe

```
npm run shots -- file-viewer framing hud-mobile shelf.shots tether   3 rondas · 9/15
npm run shots -- tether                                              0/3, tres puntos distintos
npm run shots -- --list                                              los dieciséis
```

Y la sonda del reciclado, que no vive en el repo (está en el scratchpad de la
sesión): hub aislado + `test/fake-collector.ts --speed=N --anyway`, sondeando
`/api/world?token=…` a 1 Hz y diferenciando el conjunto de ids. Si se quiere
conservar, su sitio sería `test/` al lado de `field-stress.ts`; no la dejé ahí
porque esto era sólo lectura.
