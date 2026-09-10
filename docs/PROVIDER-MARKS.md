# Marcas de proveedor en los selectores de modelo

**Misión:** `mission_mttsu2rn5ce3wtce`
**Estado:** implementado y verificado. **Sin publicar** y **sin commit**, como
pedía la instrucción: esto va a revisión de CAPCOM.

---

## 1. El problema, en una línea

`CHANGE MODEL` y `New CAPCOM` mezclan dos proveedores en la misma lista, y los
nombres no siempre lo dicen: `opus` y `gpt-5.6-luna` se distinguen porque el
operador ya lo sabe, no porque la lista lo enseñe. Ahora lo enseña.

## 2. Qué se ve

En la cabecera de cada bloque del menú, a la izquierda del nombre que ya
estaba:

```
❋ CLAUDE CODE          la ráfaga de ocho rayos
⬡ CODEX                el nudo hexagonal
```

Y en la línea de estado, con el menú **cerrado**, la marca del proveedor que
está corriendo ahora mismo: `⬡ CODEX · gpt-6-astra`.

**Son el logotipo oficial de cada proveedor, no una interpretación.** Bajados
en SVG, rasterizados y reducidos a la rejilla: se dibujan a 18×12 píxeles por
celda, se mide la cobertura media de cada celda y se enciende la que pasa del
40%. La forma la pone el proveedor; ORCA sólo elige la resolución.

Rejilla de **18×18 a 18px** — una celda por píxel, exacto y sin suavizado.

### Los dos intentos que fallaron, para que nadie los repita

1. **Deducir la geometría.** Derivé el nudo de OpenAI de su estructura (tres
   lazos cruzándose a 60°) y la ráfaga de Claude de sus rayos. Salía una figura
   plausible que **no era el logotipo**: a 11px el nudo parecía una tuerca. El
   operador lo dijo mejor que yo — «parece que sólo pusimos cosas aleatorias».
   Un icono que hay que explicar no es un icono.
2. **Reducir el logotipo a 11 celdas o menos.** Ruido. El trazo del nudo y los
   rayos de la ráfaga son **más finos que una celda** a ese tamaño: la mitad se
   perdía y la otra mitad se convertía en manchas. Engordar el trazo antes de
   reducir tampoco sirve: rellena los huecos del nudo y sale un borrón.

Lo comprobé en las dos direcciones antes de decidir, no de oído: reducción
directa, reducción con dilatación morfológica, y rejillas de 9, 11, 13, 16, 18,
20 y 22 celdas. La comparación está fotografiada en
`test/shots/marks-compare2.png`, con el pixelado a cada tamaño, el vector real
sin pixelar y lo que había antes, los tres en su sitio real —al lado del nombre
del grupo— para poder compararlos como se ven y no como se describen.

**Dieciocho celdas es donde empieza a reconocerse**, y por eso son 18. Sigue
siendo pequeño —cinco píxeles más alto que el texto que acompaña— y sigue
siendo un dibujo de píxeles, que era la condición de partida.

## 3. Dónde va la marca, y por qué ahí

**En la cabecera del grupo, no en cada fila.** La lista ya está agrupada por
proveedor: repetir la marca en las diez filas de un bloque no añade
información, y convierte una lista en un tapiz. La cabecera dice de quién es el
bloque, una vez.

**Y en la línea de estado**, porque con el menú cerrado la cabecera no se ve, y
«de quién es el modelo que está corriendo» es justo lo que se mira antes de
abrir nada. Ahí el nombre del runtime sigue escrito al lado: la marca acompaña
al texto, no lo sustituye — un dibujo de 18px no es un nombre.

## 4. Qué NO cambia

Nada de lo que ya funcionaba, y está probado uno a uno (§6):

- los **nombres** de los grupos (`CODEX`, `CLAUDE CODE`) siguen siendo texto,
  no imagen: el filtrado, el salto por letra y un lector de pantalla los leen
  igual que antes;
- las **etiquetas y pistas** de las opciones, intactas, incluidas las de lo que
  no se puede elegir (`CLI not installed`), que se sigue listando y leyendo;
- el **filtrado**, el **teclado** y la **selección**;
- y los ocho llamadores de `pick` que no pasan `mark` quedan **byte a byte**
  como estaban: sin `mark` no se dibuja nada y no se añade ninguna clase.

## 5. Archivos

| Archivo | Qué |
|---|---|
| `src/ui/gfx/marks.ts` | **nuevo.** Los dos retículos reducidos del SVG oficial, `MARKS`, `markForRuntime()` y `markSVG()` |
| `src/ui/controls.ts` | `PickOption.mark?: string`, dibujado en la cabecera de grupo |
| `src/ui/windows/capcom-model.ts` | pasa `mark` en los dos selectores y en la línea de estado |
| `src/ui/styles/window.css` | `.pick__group.has-mark`, `.pmark`, y lo mismo para la línea de estado |
| `test/provider-marks.shots.ts` | **nuevo.** QA visual aislado, escritorio y teléfono |

**SVG y no lienzo**, que es la única decisión que se sale del idioma de la
casa. `paintBits` pinta en `<canvas>` porque el wordmark y el sigilo viven donde
ya hay un elemento al que agarrarse y un repintado propio. Una marca vive dentro
de `pick`, que reconstruye su lista entera en cada filtrado: un lienzo obligaría
a repintar a mano después de cada reconstrucción y a llevar el DPR a cuestas. Un
`<svg>` con `shape-rendering="crispEdges"` es una cadena, entra en el HTML que
`pick` ya escribe, hereda el color con `currentColor` —así la marca se apaga con
su fila sin que `pick` sepa que existe— y sale exacto a cualquier zoom.

## 6. Pruebas, con su código de salida

```
$ npx tsc --noEmit -p tsconfig.json;        TSC_EXIT=0
$ npx tsx test/run.ts --changed;            1114/1115, 1 failed  CHANGED_EXIT=1   (§7: es de E4)
$ npx tsx test/provider-marks.shots.ts;     MARKS_EXIT=0
$ npx tsx test/capcom-model.visual.ts;      EXIT=0
$ npx tsx test/capcom-new.visual.ts;        EXIT=0
$ npx tsx test/model-catalog.visual.ts;     EXIT=0
$ npx tsx test/provider-handoff.visual.ts;  EXIT=0
```

Las cuatro visuales existentes son las que tocan estos dos componentes, y son
la prueba de que no he roto nada de lo suyo. `capcom-model`, `model-catalog` y
`provider-handoff` piden un vite en 4478; no había ninguno, así que levanté uno
efímero para correrlas y **lo cerré al terminar** (comprobado: 0 procesos en
4478 después). No reinicié hub ni collector.

Lo que comprueba `provider-marks.shots.ts`, en entorno aislado —vite propio y
efímero, sin la configuración del proyecto, sin proxy de websocket y sin hub—:

1. `CHANGE MODEL` agrupa por proveedor y cada cabecera lleva **una** marca;
2. las dos marcas son **distintas** (se comparan los SVG): una marca igual para
   los dos sería un adorno, no una señal;
3. son píxeles y no tipografía: `crispEdges` y las celdas contadas;
4. las etiquetas, las pistas, el filtro, el teclado y la selección, intactos;
5. la marca va en la cabecera y **no** repetida por fila (se cuenta: 2 marcas
   en un menú de cuatro opciones);
6. la línea de estado lleva su marca con el menú cerrado, y el nombre al lado;
7. lo mismo en `New CAPCOM`;
8. y en el teléfono, con el selector abierto como **diálogo**: marcas presentes,
   sin desbordamiento a lo ancho, y el diálogo entero dentro de la pantalla —la
   marca ensancha la cabecera, que es lo que decide el ancho del menú, así que
   eso se **mide** y no se supone.

Capturas: `test/shots/provider-marks-change-model.png`,
`provider-marks-new-capcom.png`, `provider-marks-mobile.png`.

## 7. Qué está verde y qué no

Aquí hay dos cosas distintas y la primera versión de este informe las juntó en
un «árbol verde» que no era cierto. Se separan:

**Mi validación: verde.** `TSC_EXIT=0`, las cinco pruebas visuales en 0, y
`--changed` con **todas las suites que alcanzan lo que he tocado** en verde.

**El árbol compartido: no.** `--changed` acabó en `1114/1115`, `CHANGED_EXIT=1`.
El fallo es `synthetic`, en `ejecutar, no nombrar ni precargar`, esperando
`920,921,922` y recibiendo `911..922`. Es de **E4**: su prueba
(`test/synthetic.test.ts`) y su implementación (`src/hub/harness.ts`) las está
escribiendo ahora mismo —las dos con marca de tiempo de hace minutos— y durante
esta sesión esa suite y `wake` fallaron y se recuperaron solas dos veces, más un
`TS2741` en `src/hub/wake.ts` que también se resolvió solo.

Que no es mío se comprueba, no se afirma: ninguno de mis ficheros
(`gfx/marks.ts`, `controls.ts`, `windows/capcom-model.ts`, `styles/window.css`)
aparece en el grafo de imports de `test/synthetic.test.ts`, que llega a
`hub/harness.ts` y `hub/server.ts` y no toca la capa de `ui/`.

**Ninguna suite queda sin cubrir por mi parte.** Lo que toqué de lógica es
`pick` y `capcom-model`, y las cinco pruebas visuales de arriba los miran.

## 8. Límites

1. **Dos proveedores y no más.** `markForRuntime` conoce `claude` y `codex`; un
   runtime nuevo no pinta nada, que es exactamente como está la lista hoy. No
   hay marca genérica de relleno: un dibujo que no dice quién es, no dice nada.
2. **La marca es del proveedor, no del CLI.** Si mañana Codex sirviera un modelo
   de otra casa, su marca sería otra y el runtime seguiría siendo `codex`. Hoy
   esa distinción no se puede hacer porque el catálogo no la trae.
3. **Observado de camino, no arreglado** (es de `controls.ts` y no de esta
   misión): un `pick` que ya se abrió como desplegable y se reabre después de
   encoger la ventana a medidas de teléfono conserva la posición anclada
   anterior y el diálogo queda fuera de pantalla (medido: `left:195`,
   `right:553`, `vw:390`). En un teléfono de verdad no ocurre —nunca fue un
   escritorio— y por eso la prueba del teléfono usa una pestaña nueva. Queda
   dicho para quien lleve `controls.ts`.
4. **Sin publicar, sin desplegar y sin commit**, como pedía la instrucción. Aviso
   honesto: el publicador automático del hub (`src/hub/publisher.ts`) construye
   al terminar un worker del repo propio, así que **terminar esta misión puede
   disparar un build por sí solo**. No es una acción mía y no la puedo evitar
   desde aquí. Lo que sí puedo decir con precisión: `tsc --noEmit` pasa sobre el
   árbol entero, así que si ese build salta hoy, no saltará por esto —pero el
   árbol es compartido y lo que valga dentro de un minuto lo decide quien esté
   escribiendo entonces, no yo (§7).

## 9. Cómo verificarlo

```
npm run typecheck
npm test -- --changed
npx tsx test/provider-marks.shots.ts    las marcas, escritorio y teléfono
npx tsx test/capcom-new.visual.ts       New CAPCOM, sin tocar
```

Filtros que cubren esta entrega: `capcom`, `synthetic`, `commands`.
