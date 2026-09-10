# El vuelo aterriza donde no hay ventana

Un `fly` —a un agente, a un squad, a un proyecto, a la flota entera— hacía una
sola cosa: poner el destino en el centro del cristal. Con una terminal o un
panel delante, el centro del cristal es a menudo justo lo que está tapado, y
el operador volaba a un tile para encontrarlo detrás de la ventana desde la
que había pulsado `F`.

## Qué cambia

El encuadre de un vuelo tiene ahora en cuenta las ventanas que están **en
primer plano** —`front` y `pinned`, las que viven en píxeles de pantalla y no
se mueven con la cámara— y elige un objetivo (centro + distancia) que deja el
destino a la vista. La regla, en orden:

1. Sin ventanas, o con el centrado ya despejado: **el centro, como siempre**.
   Ni una coordenada cambia respecto a antes.
2. Si algún rectángulo libre del cristal cabe el destino a este zoom: el
   destino se desliza al hueco más cercano al centro, moviendo la cámara lo
   mínimo (se recorta dentro del hueco, no se centra en él).
3. Si ningún hueco lo cabe pero uno lo cabría con la cámara más atrás: el
   menor paso atrás que lo despeja, hasta `ZOOM_OUT_MAX` (2×).
4. Si nada lo despeja (ventanas sobre casi todo el cristal): el destino se
   sienta sobre el rectángulo libre **más grande**, donde más porción suya
   se ve; empate, el que menos mueva la cámara.

Las ventanas en modo `canvas` no cuentan: están en coordenadas de mundo y se
mueven con el plano, así que ninguna cámara puede sacar un tile de debajo de
una. Un margen de 16 px separa el destino del borde de cualquier ventana.

## Dónde vive

- `src/ui/field/framing.ts`, nuevo y **puro** (sin three, sin DOM): `aim(box,
  z, view, obstacles)` devuelve `{x, y, z}`. Debajo, `freeRects` enumera los
  rectángulos vacíos máximos del viewport (rejilla de bordes + suma prefija;
  con la decena de ventanas de una consola es trivial) y `coveredArea` mide
  exactamente qué parte de un rectángulo queda bajo la unión de las ventanas.
  `projectBox` es la inversa, para las pruebas. `FOV` se mudó aquí y
  `camera.ts` lo reexporta (`bookmarks.ts` lo importa de la cámara y sigue
  igual).
- `src/ui/field/camera.ts`: `show(box, z)` es el vuelo consciente de ventanas
  y `frame(box, pad)` pasa por él, así que squads, proyectos, `frameAround` y
  la flota entera se benefician sin tocar a quien los llama. `flyTo(x, y, z)`
  sigue siendo el vuelo crudo. `setObstacles(fn)` recibe quién está delante,
  leído en el momento de cada vuelo.
- `src/ui/field/field.ts`: `flyTo(id)` y `frameAgents` con un solo tile
  vuelan con `show` y la caja del tile (`tileBox`, el mismo extent que
  `screenOf`). `FieldHandle.setObstacles` expone el gancho. `flyToPoint`
  (marcadores, minimapa, colocar un artefacto) y `frameWindow` (localizar una
  ventana del canvas) quedan crudos: significan un sitio, no una cosa que ver.
- `src/ui/main.ts`: cablea `field.setObstacles` con `wm.stack()` filtrado a
  `mode !== 'canvas'`, y añade el gancho de pruebas `__orca.fly(id)` (es
  `c.go`).

Con el tilt puesto la aritmética es la del plano llano: el desplazamiento es
aproximado, no exacto. No se ha visto un caso donde eso deje un tile detrás.

## Verificación

`npm run typecheck`: limpio.

`npm test -- framing` (`test/framing.test.ts`, nueva): 12/12. Cubre sin
ventanas (tile y flota: el centro, coordenada por coordenada), una ventana
que no tapa el centro (nada cambia), una ventana sobre el centro (el tile se
desliza justo a su derecha, misma altura, mismo zoom, margen respetado),
varias ventanas (encuentra el hueco entre ellas), hueco demasiado pequeño (la
cámara retrocede el mínimo paso, 1.5× y no 2×, y despeja), nada despeja (se
sienta sobre la banda libre mayor y enseña más que el centrado), una ventana
sobre todo el cristal (el centro, no hay otro sitio), la flota con una ventana
sobre media pantalla (retrocede y cabe en la otra media), y las dos primitivas
(`freeRects` con una ventana en medio da cuatro bandas; `coveredArea` cuenta
solapes una vez).

`npm test -- --changed` (80 suites, con las de otros cambios sin commitear del
árbol): 956/956, corrido dos veces, la segunda con el estado final de todos
los ficheros.

**A mano, contra la consola real** (`npx tsx test/framing.shots.ts
--isolated`, hub y flota sintética propios, Chromium 1440×900): vuelo a un
agente sin ventanas → centrado a menos de 2 px; se abre la ventana de otro
agente (sale en `front`, 632×688 sobre la izquierda, tapando el centro) y se
vuelve a volar → el tile aterriza en x=664, y=294, entero, a la derecha de la
ventana y a la altura del centro; con dos ventanas en la pila, lo mismo; y
`FRAME` con las dos ventanas abiertas deja la flota entera (21 tiles) en la
mitad derecha, ninguno bajo una ventana. Fotos en
`test/shots/framing-{0,1,2,3}-*.png`. El script comprueba las dos promesas
según lo que dejen las ventanas: si queda hueco para el tile, exige tile
limpio; si no, exige que se vea más que centrado.

Una trampa del arnés que costó dos corridas: los tiles se deslizan a su sitio
(`spot.x` hace easing hacia `spot.tx`) y la flota sintética los re-coloca sin
avisar, así que `flyAndLand` espera a que el tile esté quieto, vuela, y repite
si `tx/ty` cambió durante el vuelo.

Sin suite que los cubra: el cableado en `main.ts` y el gancho `__orca.fly`
sólo los ejercita el shot, que no forma parte de `npm test`.

Filtros que cubren esta entrega: `framing`.
Arnés visual: `npx tsx test/framing.shots.ts --isolated`.
