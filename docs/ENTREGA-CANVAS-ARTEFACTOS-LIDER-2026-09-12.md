# Los resultados se ven en el canvas: entrega consolidada del líder

Misión `mission_mty0u9wtmoc471tc`, squad `canvas-artefactos-01`. Líder LU;
miembro de captura 2S; miembro de canvas BO. Los dos miembros dejaron su
entrega propia: [ENTREGA-CAPTURA-ARTEFACTOS-2026-09-12.md](ENTREGA-CAPTURA-ARTEFACTOS-2026-09-12.md)
y [ENTREGA-CANVAS-ARTEFACTOS-2026-09-12.md](ENTREGA-CANVAS-ARTEFACTOS-2026-09-12.md).
Este documento es el conjunto: qué se decidió, qué entró, qué se vio en la
consola viva y qué queda.

## 1. Qué se decidió y por qué

**Captura: declarar es la vía canónica, detectar es la red, nunca se parsea
texto.** El brief de todo agente lanzado nombra `orca-show <ruta> "título"`
para lo que un humano deba mirar, con `--open` sólo para lo único que hay que
ver. La detección por `Write`/`Edit` sigue como red, y se le sumó la captura
por efecto (`fs.watch` del árbol del proyecto) porque un pipeline escribe con
ffmpeg o con un build y no con `Write`. Nunca se buscan rutas ni URLs en lo
que el agente escribe: nombra archivos que no creó, crea archivos que no
nombra, y una URL no es un archivo. Cada artefacto lleva `source`:
`declared` u `observed`. Sólo lo declarado se cuelga solo en el canvas; lo
observado vive en la galería y en las ventanas. Lo que git ignora no entra
solo, porque las capturas del arnés visual se estaban colando en la flota
real atribuidas a agentes que no las hicieron.

**Canvas: la estantería.** Cada agente que declaró algo cuelga una franja de
fichas cuadradas bajo su baldosa. La franja mide exactamente lo que mide la
baldosa, y el hueco lo reserva la rejilla (`layout.ts`), como ya hace con la
bandeja de hijos y con el recinto del arnés: nada queda nunca debajo. Cuatro
fichas y un contador; la ficha abre el artefacto, el contador abre la galería
filtrada por ese agente. El `PLACE IN FIELD` de siempre (la superficie grande)
sigue intacto y es el gesto para verlo grande.

**Cambio respecto a la decisión inicial.** El `.zip` no se acepta como
`kind: 'file'`. La lista blanca de extensiones es la barrera que impide que
un `kind` declarado reetiquete un `.env` y lo saque por el hub; ampliarla
para colgar un icono no compensa ese agujero. «Sin miniatura posible» queda
en md, html y svg, que van como ficha de glifo.

## 2. Qué entró, pieza por pieza

Captura (2S):

- `e657fc2` `Artifact.source`: `declared` no se pierde al reescribir el archivo.
- `99e0bac` los dos pies de squad nombran `orca-show`, con una prueba que exige que todo `orca-*` prometido esté en `WORKER_COMMANDS`.
- `4405844` el svg del camino de datos, publicado por ese mismo camino.
- `9b9f602` captura por efecto: se observa el archivo, nunca el comando; 24 por tick; sin agente no hay registro.
- `104bbf1` el techo tira primero lo observado; una declaración sólo cae cuando no queda nada observado.
- `1823a90` lo que git ignora no entra solo (una consulta a `git check-ignore` por tick), y la prueba de que un `.zip` no entra por ninguna puerta.
- `6d5d7da` `bin/lib/whoami.mjs`: los seis comandos `orca-*` saben de qué agente son (`--agent`, `CLAUDE_SESSION_ID`, `ORCA_PANE`, árbol de procesos). Hasta aquí, un artefacto declarado podía colgar del agente equivocado, y los mensajes de la squad llegaban con el indicativo cruzado.
- `22c7c60` (líder) `CLAUDE_SESSION_ID` se acepta tal cual; el uuid sólo se exige al pane. Regresión de `6d5d7da` que cazó la suite completa.

Canvas (BO):

- `f9a8133` `shelf.ts`: geometría y cuenta puras, con pruebas de medida.
- `b3c02b2` sólo lo declarado cuelga.
- `85d9a24` la rejilla reserva el hueco; las medidas de la rejilla salen a `grid.ts` (`layout.ts` las reexporta).
- `a33ffaa` `media.ts`: `kind: 'file'` fuera de la rama de texto, vídeo pausado fuera de cuadro, LOD por `pxPerUnit`, `placeNear` se niega sin baldosa.
- `1f2fb2e` `shelves.ts`: fichas como DOM proyectado, clic, contador, galería filtrada en ventana propia.
- `e22a10c`, `dfb3cf1` el arnés visual de la estantería en Chromium.

Documentos: `8217a5f` reconocimiento y propuesta; `58e688d` decisión;
`428dea5`, `31e1aff`, `8bf1595` entrega de captura; `1a487a9` entrega del canvas.

## 3. El caso real

Dos artefactos producidos por el miembro 2S, un agente de verdad de esta
flota: `docs/artefacto-camino-de-datos.svg` (declarado con `orca-show`,
`art_c14af5960557f28f`) y `docs/artefacto-camino-de-datos.png` (generado por
ImageMagick desde Bash y declarado, `art_856a6e0833b50de0`). Con la consola
publicada desde `main` y abierta en Chromium contra el hub real:

- de lejos, la flota entera se ve como antes y las tres fichas del mundo están `hidden`;
- al volar a la baldosa de 2S, dos fichas con imagen cargada (`naturalWidth` 1060) cuelgan bajo ella, y la ficha de glifo del informe declarado por 6F bajo la suya;
- el clic en la ficha del png abre la ventana del artefacto junto a la ficha, con su título y `PLACE IN FIELD`.

## 4. Los casos difíciles

- **Cuarenta imágenes.** Lo observado no cuelga; si alguien declara cuarenta, cuatro fichas y `+36` a la galería filtrada. Techo global de 96 fichas.
- **Vídeo pesado.** Primer fotograma y una marca, nunca reproducción automática; por encima de los 16 MB del cable, glifo con peso en vez del rectángulo negro.
- **Sin miniatura posible.** Ficha de glifo con extensión y peso. El `.zip` no llega a artefacto, por seguridad (arriba).
- **Zoom lejano.** La franja desaparece por debajo del peldaño 3 de los rótulos (190 px por baldosa); el hueco sigue reservado y alejarse no recoloca la flota.
- **Agente muerto.** Con baldosa en el campo, la franja se atenúa con ella. Archivado, sin estantería ni ancla inventada: galería y ventana de misión. Colocar a mano un artefacto de un agente sin baldosa se niega y lo dice en el feed.

Aplazado con motivo:

- **Miniatura de verdad.** La ficha baja el archivo original y lo escala por CSS: es ancho de banda, no memoria de vídeo. El único punto de cambio es `chipSrc()` en `shelves.ts`; la generación debería hacerla el collector, que es quien tiene el archivo, y el hub no tiene dependencia de imagen.
- **Atlas instanciado** para las fichas: optimización a medir con una flota real.
- **Ficha con render para `.html`**: requiere captura de iframe fuera de pantalla.
- **Agente plegado en la bandeja de su padre**: sin estantería, por la misma regla que los rótulos; sigue en la galería.
- **URLs** como resultado (una página servida en localhost): sin bytes que cachear, fuera de esta misión.
- **Atribución de lo observado** con varios agentes en un checkout: sigue siendo el agente más activo del proyecto; el daño es una línea en la galería, nunca una ficha bajo la baldosa equivocada.

## 5. Convivencia y roturas

El árbol quedó dos veces sin compilar por trabajo en vuelo del canvas
(`main.ts` con `placement` nulo; `shelf-layout.test.ts` sumando un booleano).
Las dos se corrigieron de verdad y sin silenciar el compilador, y desde
entonces la regla en la squad es typecheck en verde antes de dar una pieza
por hecha y antes de empezar la siguiente. Los reinicios del hub y del
collector de las 15:01 y las 15:07 no los pidió nadie: en producción
también corren bajo `tsx watch`, y guardar en `src/hub` o `src/collector`
los releva solos. El buzón de 2S dejó de recibir entregas del hub
(«no pude escribir el buzón de entrada» en los eventos), y por eso la última
regresión la corrigió el líder.

## 6. Verificación y relevo

- `npm run typecheck`: limpio sobre `22c7c60`.
- `npm test` completa sobre `22c7c60`: 1364/1364, exit 0 (la corrida anterior, sobre 1a487a9, dio 1363/1364 por el resolver, corregido en 22c7c60).
- Consola publicada con `npm run publish` sobre `22c7c60` (build `index-BpMMOm8J.js`).

Relevo: ninguno pendiente. Hub y collector ya corren el código de captura
(se relevaron solos al guardar). La consola tiene el build nuevo: pulsar
`UPDATE AVAILABLE`. Para confirmar que entró: acercarse a la baldosa de 2S y
mirar la franja de dos fichas bajo ella; pulsar una y ver abrirse el
artefacto; o pedirle a cualquier agente `orca-show <ruta> "título"` y ver
aparecer la ficha bajo su baldosa.

## Filtros que cubren este documento

```
npm test -- artifacts squads spawns          la captura, el brief y el resolver de sesión
npm test -- shelf shelf-layout layout        la estantería y la reserva en la rejilla
npm test -- surface placed-files harness-field   el campo y media
ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts   la estantería dibujada en Chromium
```
