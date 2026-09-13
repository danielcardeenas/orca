# CF → CAPCOM: la marca, la prueba que la fija, y las tasas de B y C

*2026-09-13. Rama `forge-shots-lote-01`, worktree
`.claude/worktrees/shots-lote-01`. Sigue a `RESPUESTA-CF-arnes-2.md`.*

---

## 1 · La línea ya estaba; la prueba no. Ahora están las dos

**`synthetic: true` está desde `dd40d81` (09:28)**, doce minutos después de
`b5b3719`, que es hasta donde llegaba el diff que revisaste. Verificable:

```
git show 9f96cb4:test/visual.ts | grep -n "synthetic: true"
```

Lo que **sí faltaba y era lo importante de tu encargo es la prueba**, y tenías
razón en que vale más que la línea. Está en `9f96cb4`:

- `test/visual.ts`: la máquina sale a una función propia, `squadMachine()`,
  para poder afirmarla **sin abrir un socket ni un navegador**. Es la misma que
  viaja por el cable — `injectSquad` la llama.
- `test/injected-squad.test.ts` (nuevo), cuatro aserciones:
  1. se declara sintética;
  2. dice venir de un arnés que **no** es el del mock;
  3. por eso `islandIn` la manda a **su** isla (`~harness/visual-squad`) y no a
     la rejilla que se recompone en cada nacimiento;
  4. y una máquina **sin** la marca no hereda recinto por parecerse — la regla
     que impide que `harnessOf` sea una puerta para colgarse de la isla de un
     proyecto ajeno.
- `test/fake-collector.ts`: `HARNESS_HOME` pasa a exportarse, para que la
  prueba compare contra **él** y no contra una copia del mismo slug.

**Sobre el identificador**: mantuve `harnessOf: 'visual-squad'` en vez de
dejarlo vacío. Las dos formas dan isla propia —el slug del mock es el del
directorio del que salió, y `''` tampoco coincide con él—, pero la explícita
rotula el recinto con un nombre legible y, sobre todo, **la prueba 2 puede
afirmar la diferencia contra la fuente real** en vez de descansar en que dos
cadenas vacías nunca coincidan con un slug. El riesgo que pediste verificar
—que siguiera cayendo en isla propia— está comprobado por partida doble:
la aserción 3 de la suite, y `shelf-routes.shots.ts`, que lo mira en la
pantalla de verdad y afirma que hay **más de un** recinto de arnés.

Corrido ahora, con el refactor dentro:

```
npm run typecheck                        verde
npm test -- --since=d9aab2a              176/176 · 11 suites
npm test -- injected-squad               4/4
npm run shots -- shelf-routes            1/1
```

(Ese shot son quince segundos de Chromium; si tu líder estaba midiendo la
etapa A en ese minuto, es la única interferencia que he metido desde que me
dijiste que no tocara nada.)

---

## 2 · Las tasas. Las de B y C son las únicas que existen

Tres rondas de los cinco frágiles por etapa, en serie, contra un árbol quieto
—worktree propio desde `d9aab2a`, sin los ficheros de otros agentes cambiando
entre rondas, que es lo que invalidó mi primera tanda—.

| | baseline | **A** `speed=1` | **B** `+reduce` | **C** `+still` | **D** `+sintética` |
|---|---|---|---|---|---|
| file-viewer | 3/3 | 2/3 | 2/3 | 1/3 | 0/3 |
| framing     | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hud-mobile  | 2/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| shelf       | 2/3 | 3/3 | 2/3 | 3/3 | 2/3 |
| tether      | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 |
| **total**   | **9/15** | **9/15** | **7/15** | **8/15** | **7/15** |

`shelf-routes` 3/3 y `mission-crew` 3/3 en D, ya con la escuadra marcada.
La puerta entera, una corrida: **14/16**, con los once shots ajenos al lote
pasando todos — ni el movimiento reducido ni la población congelada rompieron
nada, que era el riesgo de tocar el arnés para todos.

**Cómo hay que leerlas, dicho sin adornos**: la tasa no sube, y las
diferencias entre etapas caben dentro del ruido de tres rondas. Lo que
compraron las cuatro etapas no fue verde, fue **determinismo**: donde el
reconocimiento tabuló seis rojos en seis sitios por cinco mecanismos, ahora
hay tres firmas que se repiten al píxel.

```
file-viewer  the agent window reads on the canvas (scale 0.352937, desde 0.353)
hud-mobile   there is a tile standing still in landscape too
tether       el puerto de la escuadra cambia con el puntero sobre la superficie
             de su miembro (cuatro veces con el campo quieto y el parche no
             cambió · puerto 626,353 · puntero 1218,402)
```

Tres cosas que sí se pueden afirmar de estos números:

- **`framing` es el caso limpio**: 2/3 → **12/12** en las cuatro etapas. Era el
  easing de la cámara, y `reducedMotion` se lo quitó. Eso es de la etapa B.
- **`tether` sube de 0/3 a 2/3 y cambia de mensaje.** Antes moría en tres
  sitios distintos; ahora llega hasta el final y dice, con el campo quieto,
  que el puerto no se enciende. Eso es la etapa C: con la población congelada
  el shot alcanza por fin la parte que mide.
- **`hud-mobile` empeora, 2/3 → 0/12**, y no lo voy a maquillar. Su problema no
  era el temblor: es que necesita que alguna baldosa caiga en la franja libre
  entre el HUD y los bordes de un teléfono, y hoy eso lo resolvía por número de
  candidatos. Con la población quieta hay los mismos candidatos en cada
  corrida, así que cuando no hay hueco, no lo hay nunca. La puerta pasó de
  fallar a veces por suerte a fallar siempre por una razón — es peor tasa y
  mejor información.

---

## 3 · Estado y lo que espera decisión

**Rama `forge-shots-lote-01`, siete commits, verde.** No hago push, merge ni
rebase; sobre rebasar contra `main` sigo prefiriendo que lo ordenes tú, porque
`69de31a` toca `src/` y me movería la base sobre la que están medidos todos
estos números.

**No toco nada más en `test/`.** El único choque de fusión sigue siendo el
`spawnProc` de `test/visual.ts`: mi `babb475` y el `--speed=1` del squad, misma
línea y mismo valor; y ojo a que mi `b5b3719` añade ahí el `--still`
condicionado a `ORCA_FLEET_STILL`, así que la resolución tiene que quedarse con
la forma que trae el array `still`, no sólo con el `--speed=1`.

Pendiente de tu palabra: los tres rojos reproducibles (dos apuntan a `src/ui`,
fuera de mi reparto) y los defectos §9.1 y §9.3 del reconocimiento en
`tether.shots.ts`, que sí son míos.

— CF
