# CF → CAPCOM: la marca de sintética, las tasas, y un choque en la fusión

*2026-09-13. Respuesta a las tres preguntas, en disco. Sigue a
`RESPUESTA-CF-arnes.md`, que cuenta la hora entera.*

---

## 1 · La marca de sintética SÍ está: commit `dd40d81`

No aparece en el diff que miraste porque es **doce minutos posterior** al
último de los cuatro (`b5b3719`, 09:16 → `dd40d81`, 09:28). Rama
`forge-shots-lote-01`, fichero `test/visual.ts`, tres piezas:

**a) El identificador de arnés, propio y distinto del mock.**

```ts
const SQUAD_HARNESS = 'visual-squad';
```

El del mock es `HARNESS_HOME = pathToSlug(process.cwd())`
(`test/fake-collector.ts:66`), que es el slug del directorio desde el que se
lanzó. Al no coincidir, `harnessIsland()` le da a la escuadra **su propio
recinto**: `~harness/visual-squad` frente a `~harness/<slug del cwd>`. Que sea
distinto es justo el punto — compartirlo la habría metido dentro de la rejilla
que se recompone en cada nacimiento, perdiendo la única propiedad por la que
esa escuadra sirve.

**b) La declaración, en el `hello` de la máquina inyectada.**

```ts
synthetic: true, harnessOf: SQUAD_HARNESS,
```

La marca la pone quien se presenta y nunca la deduce el hub
(`src/shared/synthetic.ts`), así que tenía que decirse aquí. Con ella, la
escalación `blocking` inventada de Z4 queda en cuarentena y deja de ser
indistinguible de una real.

**c) Comprobado, no supuesto.** `shelf-routes.shots.ts` lo afirma ahora, porque
es una propiedad que se pierde en silencio —el par seguiría apareciendo, sólo
que otra vez sobre arenas movedizas—:

```ts
const recintos = [...document.querySelectorAll('.rgn--harness')].map((el) => el.dataset.project);
assert.ok(recintos.includes('~harness/visual-squad'), …);
assert.ok(recintos.length > 1, 'y el del mock sigue siendo otro: si sólo hay uno,
  la escuadra cayó dentro de la rejilla que se mueve');
```

Corrido: `npm run shots -- shelf-routes` → **1/1**, y 3/3 en las tres rondas de
la etapa D.

**d) Un extra que salió al hacerlo, y que hay que conocer**: `hasSyntheticFleet`
(`test/visual.ts`) contaba cualquier máquina sintética online. Con la escuadra
ya marcada, pasaba a valer como flota y **un hub reusado se habría quedado sin
mock**, con cada foto esperando a un agente que no llega. Ahora la excluye por
id: es sintética, pero no es una flota — no transiciona y no publica nada.

---

## 2 · Las tasas, que es lo que no se puede rehacer hacia atrás

Tres rondas de los cinco frágiles por etapa, en serie, contra un árbol quieto
(worktree propio desde `d9aab2a`, sin los ficheros de otros agentes cambiando
entre rondas). Baseline = el del reconocimiento, mismo commit.

| | baseline | **A** `speed=1` | **B** `+reduce` | **C** `+still` | **D** `+sintética` |
|---|---|---|---|---|---|
| file-viewer | 3/3 | 2/3 | 2/3 | 1/3 | 0/3 |
| framing     | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hud-mobile  | 2/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| shelf       | 2/3 | 3/3 | 2/3 | 3/3 | 2/3 |
| tether      | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 |
| **total**   | **9/15** | **9/15** | **7/15** | **8/15** | **7/15** |

En la etapa D añadí los dos que se apoyan en la escuadra inyectada:
`shelf-routes` **3/3**, `mission-crew` **3/3**.

**Lo que estos números dicen, y lo que no.**

- **La tasa no sube.** 9/15 antes, 7/15 después, y las diferencias entre etapas
  caben enteras dentro del ruido de tres rondas. Ninguna de las cuatro etapas
  compró verde, y no lo voy a presentar de otra manera.
- **Lo que sí compraron fue determinismo.** Antes: seis rojos, seis sitios,
  cinco mecanismos —el reconocimiento los tabuló—. Después: **tres firmas que
  se repiten al píxel**, corrida tras corrida.

```
file-viewer  the agent window reads on the canvas (scale 0.352937, desde 0.353)
hud-mobile   there is a tile standing still in landscape too
tether       el puerto de la escuadra cambia con el puntero sobre la superficie
             de su miembro (cuatro veces con el campo quieto y el parche no
             cambió · puerto 626,353 · puntero 1218,402)
```

- **`framing` es el caso limpio**: 2/3 antes, **12/12** en las cuatro etapas.
  Lo suyo era el easing de la cámara, y `reducedMotion` se lo quitó.
- **El hallazgo del lote está en `tether`.** Con el movimiento reducido dejó de
  comparar dos fotos de un parche de 6×13 px que cambiaba solo porque una
  baldosa respiraba al lado. Ahora dice, cuatro veces seguidas y con el campo
  quieto, que **el puerto no se enciende**. Es el candidato a fallo del
  producto que `SHOTS-ROJOS-2026-09-12.md:211` sospechaba y que el
  reconocimiento no pudo alcanzar por morir antes.
- **`file-viewer`**: `desde 0.353` y `scale 0.352937` en la misma línea
  significa que sesenta ruedas no movieron el zoom ni una milésima. Con el
  campo quieto ya no hay a quién echarle la culpa.

**Aviso sobre la etapa A que se está midiendo ahora**: la mía dio 9/15, idéntico
al baseline. Y si esa medición y las mías corrieron a la vez en esta máquina,
los dos juegos de números están tocados: dos Chromium compitiendo es justo lo
que hace mentir a estos shots. Los míos fueron todos en serie y aislados, pero
no puedo garantizar que nadie más estuviera midiendo en la misma ventana.

**Verificación completa**: `npm run typecheck` verde · `npm test --
--since=d9aab2a` **172/172** en 10 suites · `npm test -- fleet-still` 2/2 (26
agentes, 0 altas, 0 bajas, 15 cambios de estado en 6 s a `speed 20`) ·
`npm run shots` entera **14/16**, con los once shots ajenos al lote pasando
todos: ni el movimiento reducido ni la población congelada rompieron nada.

---

## 3 · El choque en la fusión, con la línea exacta

Confirmado, y es el que anticipabas:

- **Mío** (`babb475`, `test/visual.ts:1130`): `--speed=1` más diez líneas de
  comentario sobre el doble multiplicador.
- **Del squad** (`forge-lote-01`, `test/visual.ts:1131`): `--speed=1` con su
  propio comentario.

Misma línea, mismo valor, distinto texto: conflicto textual seguro, resultado
idéntico se resuelva como se resuelva. **No lo toco yo.** Y hay un segundo roce
en el mismo `spawnProc`: mi `b5b3719` le añade ahí el `--still` condicionado a
`ORCA_FLEET_STILL`, así que quien resuelva el conflicto tiene que quedarse con
la forma que trae el array `still`, no sólo con el `--speed=1`.

**No toco nada más en `test/`** hasta que lo digas.

---

## 4 · Lo que espera decisión tuya

1. **La rama.** `forge-shots-lote-01`, seis commits, listos. No hago push, merge
   ni rebase. Sobre rebasar contra `main`: lo haría encantado por recuperar el
   canal, pero cambia la base sobre la que medí —`69de31a` toca `src/`— y
   prefiero que la fusión la ordenes tú antes que mover el suelo de los números.
2. **Los tres rojos reproducibles.** Dos apuntan a `src/ui`, fuera de mi
   reparto; el de `tether` merece que alguien lo mire con `--headed`.
3. **Los defectos §9.1 y §9.3 del reconocimiento**, que sí son de `test/` y son
   rojos latentes del arnés: `tether.shots.ts:169-175` (`patch()` no protege un
   parche entero fuera del lienzo, y revienta con «Clipped area is either
   empty») y `:284/:287` (`antesN` cuenta todos los `.srf` del DOM y
   `arrastrada` sólo los visibles, así que la comparación puede fallar con el
   arrastre funcionando).

— CF
