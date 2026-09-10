# El visor de archivos: delante, activo y con scroll

Tres quejas del operador sobre la ventana de archivo, y qué pasa con cada una.

## «Se abre detrás de la ventana desde la que se abrió»

No se reproduce con el árbol de hoy. `test/file-viewer.shots.ts` abre una
ventana de agente, y desde dentro un archivo, en los dos estados que la
ventana de origen puede tener: en FRONT y en el canvas a tamaño de lectura.
En los dos, la de archivo queda delante y activa. Lo que lo cubre es el
cambio de hoy en `wm.ts` (`OPEN_MODE = 'front'`, entrega
`ENTREGA-VENTANAS-CANVAS-2026-09-09.md`): toda ventana nueva nace en FRONT,
en la capa de delante y con el `z` más alto. Una consola arrancada antes de
ese cambio sigue con el comportamiento viejo hasta que se recargue.

## «Pulsar el título debería traerla delante y activarla»

Faltaba, exactamente donde lo dice el operador: en el canvas, a tamaño de
lectura. Ahí pulsar la cabecera sólo enfocaba y subía la ventana entre las
del canvas, que viven en una capa por debajo de las de FRONT: nunca podía
pasar por delante de una ventana en FRONT. En la vista lejana (la ficha) sí
funcionaba, porque la ficha entera es el botón de FRONT.

Ahora un clic en la cabecera de una ventana del canvas —pulsar y soltar sin
mover más de 4 px— hace lo mismo que su botón FRONT: la trae delante de
todo, a tamaño 1, y la activa. Arrastrar la cabecera sigue moviéndola por el
canvas; sólo el clic sin desplazamiento cambia de capa. Está en `endDrag`
de `wire()` en `src/ui/windows/wm.ts`.

## «No hay scroll: hay que hacer zoom o redimensionar»

Era el modo FIT del visor de imágenes: la imagen entera encajada en la
ventana, de modo que una captura alta salía diminuta y sólo se leía haciendo
zoom, o estirando la ventana. El modo por defecto es ahora **WIDTH**: la
imagen toma el ancho de la ventana y lo que sobra se desplaza, como una
página. FIT sigue disponible, y 1:1, − y + desplazan como antes. Un clic en
la imagen alterna WIDTH y 1:1. En `showImage` de
`src/ui/windows/kinds/file.ts` y `.file__img.is-width` en `window.css`.

Texto, código, markdown, PDF y HTML ya se desplazaban dentro de la ventana;
no se tocan.

## Verificación

`npm run typecheck` limpio. `npm test -- window-canvas files attach
placed-files`: 44/44. `ORCA_VISUAL_ISOLATED=1 npx tsx
test/file-viewer.shots.ts` corre con hub, flota sintética y Chromium y
comprueba las tres cosas: la ventana de archivo delante de su origen en
FRONT y en canvas, el clic en el título de una ventana del canvas que la
trae delante y activa, y una imagen alta abierta a lo ancho con
`scrollHeight` mayor que la ventana. Deja `test/shots/file-viewer-01-stack.png`,
`file-viewer-02-raised.png` y `file-viewer-03-image-scrolled.png`; se revisó
la tercera: la imagen a todo el ancho, desplazada a media altura.

El gancho `__orca.openFile(path, at)` de `main.ts` existe para ese arnés:
abre el visor como si se pinchara una ruta.

Filtros que cubren esta entrega: `window-canvas`, `files`, `attach`,
`placed-files`. Arnés: `test/file-viewer.shots.ts`.
