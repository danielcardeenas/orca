# Un navegador de archivos con las teclas de vim, desde el menú de un proyecto

Lo que pidió el operador: «un navegador de archivos tipo vim que se abra como
ventana, visible haciendo click derecho en un proyecto». Esto es eso, y las
decisiones que hubo que tomar por el camino.

## Qué hay

Click derecho sobre un proyecto en el campo: el menú lleva una fila nueva,
**BROWSE FILES** (`b`), justo debajo de OPEN PROJECT. Abre una ventana de la
clase `files` (`src/ui/windows/kinds/files.ts`) sobre la carpeta del proyecto
en disco: una columna de nombres, carpetas primero, un cursor, y un pie con las
teclas. Una ventana por proyecto: volver a pedirla es volver a la misma.

Las teclas, con la ventana activa y sin nadie escribiendo:

| tecla | hace |
|---|---|
| `j` `k` ↓ ↑ | mover el cursor |
| `l` ↵ → | entrar en la carpeta, o abrir el archivo |
| `h` ← | subir una carpeta |
| `gg` `G` | principio, final |
| `^d` `^u` | media página |
| `/` | filtrar la carpeta por nombre; ↵ deja el filtro puesto, Esc lo quita |
| `q` | cerrar |

Abrir un archivo es el visor de siempre (`kinds/file.ts`), en su propia ventana
y delante del navegador, con el código del proyecto en su cabecera. El
navegador no edita nada: es un sitio para mirar un repo mientras los agentes
trabajan en él, y lo dice su propia cabecera.

## Decisiones

**Esc no cierra; `q` sí.** El brief proponía `q` o Esc. En ORCA Esc es del
gestor de ventanas —devuelve al canvas una ventana que está delante, cierra
una que está en el canvas— y quitárselo a una sola clase sería una excepción
que nadie recordaría. `q` cierra siempre; Esc hace lo que hace en todas.

**La raíz es una pared, dos veces.** `file-nav.ts` no construye jamás una ruta
por encima de `root`: `h` en la raíz devuelve `blocked` y la consola lo dice
(«AT THE PROJECT ROOT»). Y el hub vuelve a contenerlo todo por su cuenta:
`/api/dir` pasa por la misma `containPath` que `/api/file` (ruta léxica sin
`..` contra las raíces, luego `realpath` contra las raíces reales), así que
un `..`, una carpeta fuera o un symlink que apunta fuera son 403 aunque la
consola los pidiera. Lo que `privatePath` excluye —`.git`, `.env`, claves— no
aparece en el listado, porque un nombre que no se puede abrir es una fila que
miente. Un symlink dentro del proyecto que apunta fuera se lista como `other`
(«NOT SERVED», tachado): se ve que está, no se entra.

**Sólo el disco del hub.** Un proyecto de otra máquina (docs/FLEET-MULTI-MAC.md)
da 404/403 y la ventana lo dice con la misma frase que el visor; el hub sirve
lo que tiene debajo, no lo que ve por el socket.

**Las teclas con botón las despacha wm.ts.** UP, OPEN y FIND llevan `data-key`
(`h`, `l ↵`, `/`) como cualquier botón de ORCA, con su keycap pintado. Las
que no tienen botón (`j`, `k`, `gg`, `G`, `q`, `^d`, `^u`, flechas) las
escucha la ventana en fase de captura —antes de que main.ts diera `/` a la
línea de mando y `j` al campo— y sólo con el foco, fuera de la bandeja y sin
un campo de texto activo. UP y OPEN no se desactivan nunca: un botón
desactivado se tragaría `h` y `l` en silencio, y la nota es la respuesta.

## Qué se tocó

- `src/hub/files.ts` — `containPath` (la contención de siempre, ahora
  compartida), `resolveServedDir`, `DirEntry`, `MAX_DIR_ENTRIES` (2000, con
  `truncated`).
- `src/hub/server.ts` — `GET /api/dir?path=`, `servedRoots()` y `fileGate()`
  comunes con `/api/file`.
- `src/shared/gestures.ts` — `files` en `WIN_KINDS`.
- `src/ui/windows/file-nav.ts` — nuevo: el estado y las teclas, sin DOM.
- `src/ui/windows/kinds/files.ts` — nuevo: la ventana.
- `src/ui/windows/kinds/file.ts` — `refusal` exportada.
- `src/ui/windows/wm.ts` — `keyToken` exportada; tamaño por defecto de `files`.
- `src/ui/console.ts`, `src/ui/main.ts` — `openFiles(projectId)`, `openFile`
  acepta `project`, gancho `__orca.openFiles(root)` para el arnés.
- `src/ui/hud/context.ts` — BROWSE FILES en el menú del proyecto.
- `src/ui/styles/window.css` — bloque `fb__*`.
- `test/file-browser.test.ts`, `test/file-browser.fixture.ts`,
  `test/file-browser.shots.ts` — nuevos.

## Verificación

```
npm run typecheck                       limpio
npm test -- file-browser                7/7
npm test -- --changed                   979/979
npx tsx test/file-browser.shots.ts      ok · test/shots/file-browser-0{1,2,3}.png
```

`file-browser` cubre la navegación sin DOM, el listado y la contención del
hub (`..`, fuera, symlink fuera, archivo en vez de carpeta, sin token) y la
ventana en Chromium con las teclas contra el gestor de ventanas real y la
fila del menú. El arnés visual hace lo mismo con main.ts delante del teclado y
el hub sirviendo este repo por `ORCA_FILE_ROOTS`.

`--changed` marca `src/ui/main.ts` y `window.css` sin suite: el gancho y el
`openFiles` de main.ts los ejercita el arnés visual, y el CSS se carga en la
prueba de Chromium de `file-browser`.

Filtros que cubren esta entrega: `file-browser`, `files`.
Arnés visual: `npx tsx test/file-browser.shots.ts`.
