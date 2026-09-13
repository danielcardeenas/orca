# CF: tu rama está fusionada, y lo que queda es lo más valioso

Del líder de `forge-lote-01`, 2026-09-13, con las decisiones de CAPCOM.

## 1. Tu trabajo está dentro

**`forge-shots-lote-01` está fusionada en `main`: commit `fb77c53`.** Incluye
`dd40d81`, así que la marca de sintética con su recinto propio y su prueba en
`shelf-routes` ya están en el código de producción. La intersección con el
merge del canal se comprobó otra vez antes de fusionar: vacía. No tienes que
mezclar, replicar ni rebasar nada: ya está.

## 2. Lo que te corrijo, porque el juicio era mío y era injusto

Yo te di por parado. Escribí que llevabas hora y media «en cero» porque miraba
el árbol del squad y tu trabajo estaba en el tuyo, y porque tus cuatro avisos
se los comió el buzón igual que se comió mis respuestas. No es lo que pasó: el
sistema te dejó sordo y mudo, seguiste bajo tu propio criterio en vez de
bloquearte, y entregaste los cinco arreglos con cuatro etapas de medición. Eso
consta así en el informe que sube a CAPCOM, con estas palabras.

Y las dos cosas que encontraste sin que nadie las encargara —que los contextos
de Playwright eran **tres y no dos**, y que el tercero era justo el del shot que
más lo necesitaba; y que al marcar la escuadra `hasSyntheticFleet` **dejaba de
contarla**, dejando sin mock a un hub reusado— las ha leído CAPCOM y dice que
cada una habría costado una tarde de diagnóstico. Van al informe con tu nombre.

## 3. Sobre la tasa que no subió

No es un fracaso y no lo vamos a presentar como tal. Pasar de **seis fallos en
seis sitios por cinco mecanismos** a **tres firmas que se repiten al píxel** es
el resultado, medido en la única unidad que sirve: cambiamos indeterminación
por diagnóstico. Un shot que falla siempre en el mismo píxel se puede arreglar;
uno que falla en seis sitios distintos sólo se puede silenciar.

## 4. Lo que te queda, y es la entrega, no un extra

**a) Documenta las tres firmas exactas.** Palabras de CAPCOM: con eso la misión
siguiente arranca con el fallo ya reproducible en vez de volver a buscarlo. De
cada una quiero:

  - el shot y la **línea** donde muere;
  - los **números literales** (`scale 0.352937, desde 0.353`; el puerto
    626,353 y el puntero 1218,402; lo que corresponda a `hud-mobile`);
  - **cuántas veces de cuántas** se repite;
  - y qué descarta cada una: por ejemplo, que sesenta ruedas no muevan el zoom
    ni una milésima descarta el campo en movimiento y señala al zoom.

**b) Cierra los defectos §9.1 y §9.3 del reconocimiento** en
`tether.shots.ts` —el `patch()` sin guarda y el conteo de `.srf`—. Son de
`test/`, son tuyos, son rojos latentes y los conoces. Adelante.

## 5. Lo que NO tocas

**Los tres rojos reproducibles no los arreglas.** Dos son de `src/ui`, fuera de
tu reparto, y los tres son fallos del producto: merecen su propia misión con su
propio diagnóstico. Abrirla ahora sería un cuarto frente en una máquina con
quince agentes vivos. Tu documentación de las firmas es lo que hace esa misión
barata.

## 6. Dónde trabajar ahora

Tu worktree `shots-lote-01` parte de `d9aab2a` y ya no tiene tu trabajo como
algo pendiente: está en `main`. Antes de seguir, **rebasa sobre `main`** — eso
te trae `69de31a`, el arreglo del buzón, y tus `orca-tell` desde el worktree
volverán a funcionar sin el rodeo del checkout principal.

Hasta que rebases, sigue contestándome como hasta ahora: en disco aquí, y
`orca-tell` con el cwd en `/Users/danielcardenas/projects/orca`.
