# Los tres rojos reproducibles, cerrados uno a uno

*Misión `forge-rojos`, rama `forge-rojos-01`, worktree
`.claude/worktrees/forge-rojos-01` desde `main` (`425158a`). Todo lo medido
salió de `npm run shots` en ese árbol, aislado, con la flota quieta y el
movimiento reducido que dejó el lote de ayer
([`LOTE-SHOTS-FLOTA-QUIETA-2026-09-13.md`](LOTE-SHOTS-FLOTA-QUIETA-2026-09-13.md)).
El arnés no se tocó. El hub del operador tampoco.*

El brief traía tres shots rojos «de forma reproducible» y pedía, para cada
uno, un arreglo o un veredicto argumentado. Lo primero que hubo que medir fue
la premisa, porque decide el método: **de los tres, sólo `hud-mobile` era un
rojo fijo.** Tres rondas base de los tres en el árbol limpio:

| | ronda 1 | ronda 2 | ronda 3 | firma del rojo |
|---|---|---|---|---|
| file-viewer | verde | verde | **rojo** | `scale 0.328992, desde 0.329` — la de siempre |
| hud-mobile  | **rojo** | **rojo** | **rojo** | `there is a tile standing still in landscape too` — la de siempre |
| tether      | verde | verde | verde | — |

Un rojo que cambia de sitio o de tasa entre árboles no se cierra con más
rondas sino con una explicación de por qué se mueve. Eso es lo que hay debajo.

Dos cosas que la entrega tiene que decir con estas palabras, porque son lo que
se aprendió y no lo que se arregló:

- **El modo quieto no arregló ningún shot: hizo visible qué los rompía.** Dos
  de los tres rojos eran las pruebas estorbándose a sí mismas —una ventana del
  paso 1 sobre la cabecera del paso 2, una superficie del paso del asa sobre el
  puerto del paso de la escuadra—, y eso era invisible mientras el suelo se
  movía: con el campo temblando el estorbo cambiaba de sitio en cada corrida y
  el rojo parecía cinco averías distintas.
- **La priorización del brief estaba invertida, y lo que la corrigió fue medir
  la premisa en vez de aceptarla.** `tether` venía como «el candidato más serio
  a fallo real» y era el shot; `hud-mobile` venía como «cerrado, sólo el
  veredicto» y era el único fallo real de la consola de los tres. No es un
  reproche: es información sobre cómo se reparte el trabajo, y CAPCOM pidió que
  constara tal cual.

---

## 1 · `file-viewer` — el shot se tapaba a sí mismo

**Veredicto: el shot. No es una regresión de los commits del zoom de ayer, y la
consola hace lo que debe. Arreglado en el shot.**

La pregunta del brief era si `zoom-lock.ts` y `chain.ts` (`a2ca350`, día 12 a
las 21:21) habían introducido el fallo. No: el baseline del lote (`d9aab2a`,
día 13 a las 08:19) ya llevaba ese commit y daba `file-viewer` 3/3, y la rama
del manejador de rueda que este fallo recorre —una ventana que no está en el
canvas— era idéntica antes y después (`git show a2ca350^:src/ui/windows/wm.ts`,
línea 1361: `if (win.mode === 'canvas' && …)`; hoy: `if (win.mode !== 'canvas')
return;`). El zoom sobre una ventana del canvas sigue llegando al campo por
`onZoom`, y `zoom-lock` sólo hace `preventDefault`, que el campo no mira.

Lo que pasa se midió, no se dedujo: un guion que repite los pasos 1 y 2 del shot
y, antes de la rueda, pregunta al DOM qué hay bajo el puntero. **Ocho de ocho
con la misma flota:**

```
pt 641,498 · under: div.file__view · win=file/is-file,is-focus
agent(canvas) 443,494 218×234 scale 0.341 · file(front) 549,212 680×540
scales tras 5 ruedas: 0.341 0.341 0.341 0.341 0.341
```

El paso 1 abre una ventana de archivo **en front** a `(agente.x+80,
agente.y+120)` y la deja abierta. El paso 2 devuelve la ventana del agente al
canvas, y una ventana vuelve al canvas **junto a la baldosa de su agente**
(`captureCanvas`, `wm.ts:546`), no donde estaba en el cristal. La capa del
canvas va por debajo de las ventanas en front y del HUD (`window.css`,
`.wm--canvas { z-index: hud − 1 }`). Según dónde haya puesto la flota a ese
agente, la cabecera a la que el paso 2 apunta —`x + w − 60·escala, y +
12·escala`, calculado desde la caja y sin mirar qué hay encima— cae debajo de la
ventana de archivo del paso 1. Sesenta ruedas con ⌘ sobre una ventana en front,
que por diseño no hace zoom del campo, y la escala no se mueve ni una milésima.
Por eso el rojo es «reproducible» dentro de una flota y una moneda entre
flotas: la posición de la baldosa del primer agente la decide el mock.

Dos cambios en `test/file-viewer.shots.ts`:

- **La ventana de archivo del paso 1 se cierra una vez medida.** Lo que el paso
  2 prueba —que un archivo abierto desde el canvas aterriza delante— no la
  necesita.
- **La rueda va donde la ventana la recibe de verdad**: `bareHeaderPoint()`
  barre la cabecera y devuelve un punto que `elementFromPoint` atribuya a esa
  ventana, o **qué la tapa** si no hay ninguno. Es la comprobación que el paso
  3 ya hacía para el clic, extraída y usada también en el zoom. Si un día el
  HUD tapa la cabecera, el rojo lo dirá por su nombre en vez de decir que el
  zoom no anda.

## 2 · `hud-mobile` — la consola no dejaba hueco en un teléfono de lado

**Veredicto: la consola. En un teléfono apaisado (844×390) no había sitio para
tocar una baldosa, y eso lo sufre una persona. Arreglado en la interfaz.**

El brief lo daba por diagnosticado como cuestión de candidatos: con la
población quieta, ninguna baldosa cae en la franja libre. Es verdad, pero la
franja es la parte que importa, así que se midió con la consola de verdad en un
contexto de iPhone 13 apaisado:

```
844×390 · antes
  .mast    [62,14 → 782,239]     el mástil de escritorio, envuelto en cuatro filas
  .mmap    [540,159 → 782,330]   el radar, de vuelta
  .secbar  [14,288 → 830,332]    las puertas
  .cmd     [62,328 → 782,368]    la línea de comando
  libre: 15% de la pantalla · baldosas tocables tras frame(): 0/20
```

El tratamiento de teléfono vive en `@media (max-width: 720px)` (`hud.css:362`):
mástil de una fila deslizable, sin contadores, sin radar, sin pistas, sin
marcadores. Un teléfono girado mide 844 de ancho, así que **por ancho pasaba
por escritorio** y recibía el mástil entero con sus quince abridores, que
envuelve hasta los 239 px de un alto de 390. Y el mástil recibe el dedo en toda
su caja (`.hud > * { pointer-events: auto }`), también en los huecos entre
botones: una baldosa que asome entre FLEET y CAPCOM tampoco se toca. La consola
ya sabía que un teléfono de lado es un teléfono —`(max-width: 1180px) and
(max-height: 560px)` hace que la hoja se coma el sitio del mástil
(`hud.css:956`) y que el selector sea un diálogo—, pero al mástil, al radar, a
las pistas y a los marcadores nadie les había dicho.

El cambio, en `src/ui/styles/hud.css`: los dos bloques «teléfono» cubren
también el viewport corto, con la misma condición que la hoja ya usa.

```
844×390 · después
  .mast    [14,14 → 830,83]      una fila de herramientas que se desliza
  .secbar  [14,288 → 830,332]
  .cmd     [14,338 → 830,378]
  libre: 54% de la pantalla · baldosas tocables tras frame(): 18/20
```

`hud-mobile.shots.ts` no se tocó: su `settledTile` encuentra la baldosa por sí
solo en cuanto hay hueco, que es lo que siempre había medido. Lo que queda
fuera, dicho: `window.css:402` tiene una regla «en apaisado el alto es lo
escaso» bajo `(max-width: 720px) and (max-height: 560px)`, que ningún teléfono
real cumple girado; y `MOBILE()` en `wm.ts` sigue siendo por ancho, así que las
ventanas en apaisado siguen siendo las de escritorio. El shot afirma sobre esas
ventanas y pasa; cambiarlas es otra decisión, no un arreglo de éste.

## 3 · `tether` — el shot se tapaba a sí mismo, igual que `file-viewer`

**Veredicto: el shot. El puerto de la escuadra se enciende; lo que no se veía
era el puerto, debajo de una superficie que el propio shot había colocado y
ensanchado veinte líneas antes. Arreglado en el shot. La consola no tiene
nada que arreglar aquí.**

Primero, la premisa. «Cuatro veces con el campo quieto y el parche no cambió»
es el **mensaje de aserción de `lightsUp`**, que cuenta sus cuatro intentos
internos en una sola corrida; la tabla del lote da `tether` 1/3 y 2/3 en sus
dos últimas etapas y la corrida entera de la puerta lo dio verde. Es una tasa,
no un rojo fijo: aquí salió **1 de 18 corridas**, y hubo que esperar a la
decimosexta para tenerlo con foto.

Lo que descartó cada medida, en orden:

- **La geometría del bloque y del puntero**: la firma dice `puerto 626,353 ·
  puntero 1218,402`, y una corrida **verde** tiene el rótulo de `ledger-close`
  en (666,367) y el centro de la superficie en (1217,401): lo mismo al píxel,
  con el puerto encendido en lima a la izquierda del rótulo.
- **El estado que decide el tirante**: una sonda temporal (`__orca.tetherProbe`,
  no commiteada) leyó en el instante de la segunda foto `hovArt` igual al
  artefacto, `store.knownAgent` recordando al miembro descartado, `squadOf` →
  bloque → `squadPortAt` proyectando el puerto dentro del parche. Ocho
  corridas con sonda, 6 verdes y 2 rojos en otros sitios (una ficha tapada por
  una superficie, §9.4; el asa que no ensancha).
- **El campo**: `git diff 9f96cb4..main -- src/ui/field src/ui/styles` está
  vacío. Nada del lote pudo arreglarlo de paso.
- **La velocidad de la pestaña**: cuatro corridas con `Emulation.setCPUThrottlingRate`
  ×4 por CDP —sólo ese Chromium, la máquina intacta, swap 3632 M antes y
  después—: 3 verdes con el puerto encendido y 1 rojo en el asa.

Y la foto, en la corrida 16 (`tether-XX-nolight.png`, con el puntero todavía
sobre la superficie): **`FOTOGRAMA 0 · K1`, la superficie del agente principal
del shot, ensanchada 120 px en el paso del asa, ocupa la esquina superior
izquierda del bloque `ledger-close`, con el puerto debajo.** Una superficie
colocada es DOM sobre el lienzo (`media.ts`, `.srf`); el puerto es WebGL. El
parche de 40×28 a la izquierda del rótulo fotografiaba la superficie, que no
cambia con el hover, y la prueba acusaba al tirante. Pasa cuando la flota pone
a `who` —siempre el primer candidato, K1— lejos del recinto del arnés, y falla
cuando lo pone al lado: por eso era moneda, por eso la geometría del bloque era
la misma en verde y en rojo, y por eso el día 12, con el suelo temblando, el
estorbo cambiaba de sitio en cada corrida.

Dos cambios en `test/tether.shots.ts`:

- **Las superficies de `who` se retiran antes del paso de la escuadra.** Ya
  están medidas —el asa, el arrastre, el tirante a la baldosa— y el paso de la
  escuadra no las necesita; el de «muchos outputs» vuelve a colocar las suyas.
- **Antes de fotografiar el parche se pregunta al DOM qué hay encima**, y si
  no es el lienzo el rojo lo nombra. Y lo mismo con el asa: «tirar del asa
  ensancha la superficie: 541 → 541 px» salió tres veces en doce corridas y no
  distinguía un asa que no responde de un `pointerdown` que no le llegó.

Lo que queda sin cerrar de `tether`, dicho: el asa que no ensancha (3/12) y la
ficha bajo una superficie (1/12, §9.4) siguen siendo rojos móviles del shot,
ahora con nombre pero sin causa medida. Con el campo quieto ya no se mudan de
sitio: la próxima vez que salgan, el mensaje dirá qué había bajo el puntero.

## 4 · Lo que se corrió y lo que salió

Todo en el worktree, aislado, en serie, con la flota quieta y el movimiento
reducido. Las tasas llevan su número de rondas; una corrida suelta no es una
tasa.

```
npm run typecheck                                   limpio (tras retirar la sonda)
npm test -- --since=main                            19 suites · 324/324
                                                    sin suite que cubra hud.css ni los .shots.ts: los cubre la puerta
npm run shots -- file-viewer hud-mobile tether      3 rondas base, sin tocar nada:
                                                      file-viewer 2/3 · hud-mobile 0/3 · tether 3/3
                                                    3 rondas con los arreglos:
                                                      file-viewer 3/3 · hud-mobile 3/3 · tether 2/3 (el rojo del puerto, con foto)
npm run shots -- tether                             3/3 tras retirar las superficies de `who`
                                                    (y antes: 8 con sonda 6/8 · 4 frenadas ×4 3/4 · ninguno en el puerto)
npm run shots                                       15/16 · 7m
npm run shots -- shelf.shots                        3/3 después
```

**La puerta entera: 15/16, desde 14/16.** Los dos rojos de la mañana están en
verde; el que cae es `shelf` —«un clic en una ficha no abrió la ventana de su
artefacto», `shelf.shots.ts:71`—, que es el rojo de fichas recicladas que el
día 12 ya describió (§5 de `SHOTS-ROJOS-2026-09-12.md`) y que el lote medía
2/3. No lo toca nada de esta entrega: corre a 1440×900, donde el CSS nuevo no
aplica, y tres rondas seguidas después lo dan 3/3. Se dice porque hay que
decirlo, no porque sea nuevo.

Lo que queda sin cubrir, dicho:

- **`shelf` sigue siendo una moneda** (3/4 hoy) por su cuenta, y no era de este
  brief.
- **Los otros dos rojos móviles de `tether`** —el asa que no ensancha, 3/12; la
  ficha bajo una superficie, 1/12— tienen ahora un mensaje que nombra lo que
  hay bajo el puntero, pero no una causa medida.
- **Las ventanas en un teléfono apaisado** siguen siendo las de escritorio
  (`MOBILE()` por ancho; `window.css:402` con una condición que ningún teléfono
  cumple). `hud-mobile` lo afirma y pasa; cambiarlo es una decisión de diseño.
- **`main` avanzó dos commits durante la misión** (`dbb1420`, el buzón); la
  rama sale de `425158a` y la fusión es de CAPCOM.

## 5 · Filtros que cubren este documento

```
npm run typecheck
npm test -- --changed                        page-zoom y lo que alcance hud.css
npm run shots -- file-viewer hud-mobile tether   tres rondas de los tres
npm run shots                                 los dieciséis, tras tocar hud.css
```
