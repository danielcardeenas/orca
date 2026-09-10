# Archivos arrastrados a las conversaciones

Un archivo del escritorio se puede soltar en cualquiera de las tres cajas de
mensaje —la de un agente, la de CAPCOM y la de una misión— o pegarlo desde el
portapapeles (una captura, por ejemplo). También se puede soltar en el lienzo.

**Una imagen o un vídeo soltado en el lienzo se queda en el lienzo**, donde
se soltó, como una superficie igual que un artefacto colocado desde la
galería: se arrastra, se abre en el visor con un clic, y el menú contextual
lo quita del campo. Varios a la vez se abren en abanico. La colocación es
local a esta consola y sobrevive a un reload (`ui/placed-files.ts`, en
`localStorage` como las colocaciones de artefactos); otra consola no la ve.
Para mandarle esa imagen a un agente, se suelta en la caja de su ventana.

**Cualquier otro archivo** soltado en el lienzo va a una conversación: sobre
una baldosa, a ese agente; en el suelo, a CAPCOM. Se abre la ventana y el
archivo aparece en su caja. No se manda nada solo: el operador escribe qué
hacer con él y pulsa SEND.

## Cómo viaja

Un agente no ve el navegador; ve su disco. Así que el archivo no viaja «con el
mensaje»:

1. La consola lo sube por `POST /api/uploads` (misma puerta con token que
   `/api/recovery-images`; el nombre original va percent-encoded en la
   cabecera `x-orca-name`).
2. El hub lo deja en `~/.orca/uploads/<8 hex>-<nombre saneado>` y contesta con
   la ruta absoluta. El nombre se conserva porque `informe-q3.pdf` le dice al
   agente lo que `3f2a9c1e.bin` no; el prefijo evita que dos `captura.png` se
   pisen. Límite: 64 MB; el cuerpo se cuenta aunque `content-length` mienta;
   cross-site se rechaza; un archivo vacío se rechaza.
3. La consola escribe esa ruta en la caja donde estaba el cursor, con un
   espacio a cada lado si hace falta, igual que hace un terminal al soltarle
   un archivo encima. El operador ve exactamente lo que se va a mandar, puede
   escribir alrededor, y el borrador (`drafts.ts`) lo guarda sin saber que era
   un archivo.
4. Al mandar, Claude Code y Codex leen la ruta del prompt sin más ceremonia:
   una imagen con su herramienta de imágenes, un texto con `Read`.

`/api/file` sirve `~/.orca/uploads`, así que un adjunto citado en una
conversación se abre en el visor de archivos de la consola como cualquier
otra ruta. La carpeta es candidata de limpieza (`scratch` en la higiene): la
ruta ya vive en el transcript y el archivo es prescindible cuando la
conversación lo es.

## Dónde vive

- `src/hub/uploads.ts`: la política (nombre, tamaño, cuerpo acotado). La
  lectura acotada la comparte ahora `recovery-images.ts`.
- `src/ui/windows/attach.ts`: `insertPaths` (puro), `bindAttach` (arrastre y
  pegado en una caja), `stage`/`onStage` (el puente desde el lienzo: la
  ventana puede no estar montada aún cuando llega la ruta) y
  `guardStrayDrops` (un archivo soltado fuera de toda caja no se convierte
  en la página).
- `src/ui/field/field.ts`: `dragover`/`drop` con archivos, con la baldosa
  bajo el puntero como destino, el punto del plano donde se soltó y el
  cursor en modo target mientras dura el arrastre. `src/ui/main.ts` reparte:
  imagen o vídeo al campo, lo demás a una ventana.
- `src/ui/placed-files.ts`: la lista de archivos colocados y su forma de
  `Artifact` sin agente, que `field.setExtraMedia` suma a lo que dibuja
  `field/media.ts`. `hud/context.ts` le da su menú (OPEN, REMOVE FROM FIELD).
- CSS: `.ceo__in.is-drop` (borde lima a rayas) e `.is-uploading` (lima
  sólido) en `window.css`.

## Lo que no hace

- **Dos Macs.** El archivo cae en el disco del hub. Un worker en el otro Mac
  recibe una ruta que no existe en su disco (misma limitación que las
  imágenes de recovery, ver `docs/RECOVERY.md`). Lo honesto sería que el
  collector materializara la ruta desde `/api/file` antes de pegar; no está
  hecho y no se ha simulado.
- **Táctil.** En un teléfono no hay arrastre desde el escritorio; el pegado
  del portapapeles sí funciona donde el navegador lo permite. No hay botón
  «adjuntar» con selector de archivos.
- **Vista previa en la caja.** La caja enseña la ruta, no una miniatura.
- **Un archivo colocado que la higiene borre** (`~/.orca/uploads` es
  candidata de limpieza) deja una superficie en negro; se quita con su menú.

## Verificación

`npm run typecheck` limpio. `npm test -- --changed` (86 suites por el árbol
sin commitear de otros agentes): 1.040/1.040. Después, `npm test -- attach
uploads recovery-images files hub`: todo correcto. `attach-dom` corre en
Chromium el gesto entero: marca a rayas al entrar, rutas al soltar con el
caret detrás y un solo `input`, pegado de archivo sí y de texto no, caja
deshabilitada avisa, un fallo entre tres deja dos rutas, y la guarda del
documento reclama el drop suelto. `uploads` prueba bytes, nombre saneado y
con prefijo, `file` de reserva, vacío, tamaño, cross-site y método.

Sin cobertura automática: el paso lienzo → ventana en `main.ts` y el
`dragover` del campo (`field.ts`); se probaron a mano con el fixture, no con
una flota real.

`npm test -- placed-files` cubre colocar, mover, quitar, recolocar sin
duplicar, persistencia, storage roto, qué tipos van al campo y la forma de
`Artifact` que dibuja el campo. `ORCA_VISUAL_ISOLATED=1 npx tsx
test/placed-files.shots.ts` lo comprueba con hub, flota sintética y Chromium:
un `drop` con un PNG sobre el campo sube por `/api/uploads`, `/api/file` lo
sirve con 200, la colocación queda en `localStorage`, los píxeles del punto
cambian, y un reload la trae de vuelta; deja `test/shots/placed-file-01-dropped.png`
y `placed-file-02-reloaded.png`. Se revisó la primera foto: la imagen aparece
con marco en el punto donde se soltó. Sin cobertura automática: el reparto
en `main.ts` entre campo y ventana, y el menú contextual del archivo colocado.

Filtros que cubren esta entrega: `attach`, `uploads`, `recovery-images`,
`files`, `hub`, `placed-files`.
