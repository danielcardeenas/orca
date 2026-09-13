# El lote de los cinco shots: lo que compró cada cambio

*Rama `forge-shots-lote-01`, worktree `.claude/worktrees/shots-lote-01`, desde
`d9aab2a`. Cinco commits. Todo lo medido salió de `npm run shots`, que se aísla
solo, en un árbol quieto —el checkout principal tiene ficheros de otros agentes
cambiando entre rondas, y ahí una medida de tasa no significa nada—. El hub del
operador no se tocó.*

Lo que pedía el brief está en
[`RECONOCIMIENTO-SHOTS-FLOTA-VIVA-2026-09-13.md`](RECONOCIMIENTO-SHOTS-FLOTA-VIVA-2026-09-13.md),
que trae el diagnóstico entero y los números de partida.

---

## 1 · El resultado en una frase

**La tasa de verde no subió —9/15 antes, 7/15 después— pero los rojos dejaron
de mudarse: donde había seis fallos en seis sitios por cinco mecanismos
distintos, ahora hay TRES firmas que se repiten al píxel.** Eso no es lo mismo
que arreglarlo, y no se va a decir que lo es; es la diferencia entre una puerta
que da tirones y una puerta que señala tres cosas concretas, dos de las cuales
huelen a fallo del producto y no del arnés.

El caso limpio es `framing`: pasó de 2/3 a **12/12** en las cuatro etapas.
Medía si una baldosa aterriza donde debe, y lo que le fallaba era que la cámara
easeaba el vuelo y las dos lecturas consecutivas nunca coincidían.

---

## 2 · Las cinco cosas que se hicieron

| | qué | dónde |
|---|---|---|
| 1 | El mock corre a **1×** y no a 9× | `test/visual.ts` (`--speed=1`) |
| 2 | **Movimiento reducido** en los contextos de Playwright de la puerta | `test/visual.ts` (`newPage`), `framing.shots.ts`, `hud-mobile.shots.ts` |
| 3 | **Modo quieto** del mock, tres guardas | `test/fake-collector.ts` (`--still`), encendido por `test/shots.ts` (`ORCA_FLEET_STILL`) |
| 4 | La escuadra inyectada se declara **sintética**, en recinto propio | `test/visual.ts` (`injectSquad`), afirmado en `shelf-routes.shots.ts` |
| 5 | Un shot omitido deja de contar como **verde** | `test/shot-skip.ts` (nuevo), `test/shots.ts`, `shelf-routes.shots.ts` |

Dos detalles que no estaban en el brief y que salieron al hacerlo:

- **Son tres contextos de Playwright, no dos.** `hud-mobile` no pasa por
  `newPage`: se construye su propio contexto de teléfono, y era el que más
  falta le hacía —casi todo lo que afirma cuelga de `settledTile`, que busca
  una baldosa quieta en dos muestras y se rinde tras seis reencuadres—.
- **`hasSyntheticFleet` contaba la escuadra inyectada.** Al marcarla
  sintética pasaba a contar como flota, y un hub reusado se habría quedado sin
  mock: sintética sí, pero no es una flota —no transiciona ni publica nada—.

El modo quieto son **tres** guardas porque a medias es peor que nada: no
retirar, no ENTRAR en `done` —es absorbente, y sin eso la flota se apaga sola y
deja de producir los artefactos que `shelf` espera noventa segundos— y el
presupuesto de hijos a cero, que es el otro manantial de altas. Con las tres, la
población queda exactamente constante y todo lo demás sigue vivo. Lo mide
`test/fleet-still.test.ts`: 26 agentes, 0 altas, 0 bajas, 15 cambios de estado.

---

## 3 · Lo que compró cada etapa

Tres rondas de los cinco por etapa, en serie, cada shot con su hub, su Vite y su
flota. El baseline es el del reconocimiento, sobre el mismo `d9aab2a`.

| | baseline | E1 `speed=1` | E2 `+reduce` | E3 `+still` | E4 `+sintética` |
|---|---|---|---|---|---|
| file-viewer | 3/3 | 2/3 | 2/3 | 1/3 | 0/3 |
| framing     | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hud-mobile  | 2/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| shelf       | 2/3 | 3/3 | 2/3 | 3/3 | 2/3 |
| tether      | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 |
| **total**   | **9/15** | **9/15** | **7/15** | **8/15** | **7/15** |

Y los dos que se apoyan en la escuadra inyectada, medidos en E4:
`shelf-routes` **3/3**, `mission-crew` **3/3**.

Leído con honestidad: **las diferencias entre etapas caben dentro del ruido de
tres rondas.** Lo que no cabe dentro del ruido es el reparto por shot —`framing`
12/12 en las cuatro etapas, `tether` recuperándose de 0/3 a 2/3, `hud-mobile`
cayendo a 0/12— y, sobre todo, el TEXTO de los rojos.

### Lo que sí cambió: los rojos se volvieron reproducibles

Antes (reconocimiento): seis rojos, seis sitios distintos, cinco mecanismos.
Después: los mismos tres mensajes, con los mismos números hasta el píxel.

```
file-viewer  the agent window reads on the canvas (scale 0.352937, desde 0.353)
hud-mobile   there is a tile standing still in landscape too
tether       el puerto de la escuadra cambia con el puntero sobre la superficie
             de su miembro (cuatro veces con el campo quieto y el parche no
             cambió · puerto 626,353 · puntero 1218,402)
```

`desde 0.353` y `scale 0.352937` en la misma línea significa que **sesenta
ruedas no movieron la escala ni una milésima**: el bucle de zoom de
`file-viewer` no está haciendo zoom, y con el campo quieto ya no hay a quién
echarle la culpa. El de `tether` es el hallazgo del lote: con el movimiento
reducido, ese shot dejó de comparar dos fotos de un parche de 6×13 px que
cambiaba solo porque una baldosa respiraba al lado, y ahora dice —cuatro veces
seguidas, con el campo quieto— que **el puerto no se enciende**. Es el candidato
a fallo real del producto que `SHOTS-ROJOS-2026-09-12.md:211` sospechaba y que
el reconocimiento no pudo alcanzar.

---

## 4 · Lo que queda sin cubrir, dicho

- **Los tres rojos de arriba no se tocaron.** No estaban en el lote: el lote era
  quitarle el ruido a la puerta para que se pudiera ver qué falla, y eso es lo
  que hay ahora. Dos de los tres apuntan al producto (`src/ui`), que no es este
  dominio.
- **Los defectos §9.1 y §9.3 del reconocimiento siguen en pie**:
  `tether.shots.ts:169-175` (`patch()` no protege un parche entero fuera del
  lienzo) y `:284/:287` (`antesN` cuenta todos los `.srf` del DOM y
  `arrastrada` sólo los visibles). Son rojos latentes del arnés, en este
  dominio, y no se arreglaron por no ampliar el lote sin pedirlo.
- **`shelf.shots.ts:313` tiene una omisión parcial** —se salta un bloque de
  aserciones y sigue— que el tercer estado no cubre: el shot acaba verde
  habiendo dejado de mirar una parte. Un cuarto estado «pasó con reservas»
  sería otra conversación.
- **`npm test -- --since=d9aab2a` avisa de tres ficheros sin suite que los
  cubra**: `framing.shots.ts`, `hud-mobile.shots.ts` y `shelf-routes.shots.ts`.
  Son shots; los cubre `npm run shots`, no la suite.
- **`injectSquad` no tiene prueba unitaria de su marca.** Que se declare
  sintética y caiga en recinto propio lo afirma `shelf-routes.shots.ts`, que es
  un shot: si nadie corre la puerta, nadie lo ve.
- Los `--speed` de las otras entradas del mock (`npm run mock`, `field-stress`)
  no se tocaron: el cambio es del arnés visual.

---

## 5 · Lo que se corrió y lo que salió

```
npm run typecheck                                        verde
npm test -- --since=d9aab2a                              172/172 · 10 suites
npm test -- fleet-still                                  2/2 · población constante y viva
npm run shots -- shelf-routes                            1/1 · recinto propio afirmado
npm run shots -- file-viewer framing hud-mobile shelf.shots tether
                                                         4 etapas × 3 rondas (tabla §3)
npm run shots                                            14/16 · sin regresiones
```

**La puerta entera, una corrida (5 m): 14/16.** Los once shots que no son de
este lote —`file-browser`, `hud-improve`, `hud-missions`, `hyg-memory`,
`hyg-strays`, `mission-crew`, `mission-stall`, `placed-files`,
`provider-marks`, `pwa`, `shelf-routes`— pasan todos: ni el movimiento
reducido ni la población congelada les rompieron nada, que era el riesgo de
tocar el arnés para todos. En esa corrida `shelf` y `tether` también pasaron;
los dos rojos fueron `file-viewer` (la misma firma de siempre) y `hud-mobile`
(`a pinch opens no menu`, otro de sus gestos).

## 6 · Filtros que cubren este documento

```
npm test -- shots-gate fleet-still         el tercer estado y el modo quieto
npm run shots -- shelf-routes              la escuadra sintética en su recinto
npm run shots -- file-viewer framing hud-mobile shelf.shots tether
npm run shots                              los dieciséis
```
