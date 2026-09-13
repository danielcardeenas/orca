# Tocar un fichero selecciona también a quien lo lee por ruta, y no ejecutar nada no es verde · 2026-09-13

**Squad forge-vivas-01, propuesta `cambios-de-css-no-despiertan-su-prueba`.**
Rama `forge-vivas-01` desde `main` @ `ad48def`. El diagnóstico está en
`docs/RECONOCIMIENTO-TABLERO-AUTOMEJORA-2026-09-13.md` (§3); el veredicto era
«reescribir», y al medirlo el agujero salió más ancho de lo escrito.

## Lo que pasaba, medido

`npm test -- --changed` elige suites recorriendo el grafo de imports relativos
(`test/affected.ts`). Sólo eso. Una prueba que llega a un fichero de otra manera
era invisible para el selector, y tocar ese fichero seleccionaba cero suites con
la corrida saliendo en verde. Medido con el `affected()` real sobre `main`:

| Fichero tocado | Suites que lo miran de verdad | Suites que seleccionaba |
|---|---|---|
| `src/ui/styles/hud.css` | 7 (`phone-media` la lee del disco; `agent-stop`, `file-browser`, `gestures-dom`, `minimap`, `voice-dom`, `window-canvas` la cargan por `<link>`) | **0** |
| `src/ui/styles/window.css` | 8 | **0** |
| `improve.css`, `boot.css`, `sigil.css`, `squad.css` | 1 a 2 | **0** |
| `public/sw.js` | `sw` | **0** |
| `tools/supervise.mjs` | `restart` | **0** |
| `tools/lease.mjs` | `strays` | **0** |
| `src/ui/hud/missions.ts` | `hud-disclose` | **0** |
| `package.json` | `shots-gate` | **0** |
| `bin/orca-read.mjs`, `bin/lib/wait-for.mjs` | `buzon`, `mail-wait`, `squads` | **0** |
| `bin/orca-improve.mjs`, `bin/orca-show.mjs` | `improve-cli`, `squads` | **0** |
| `test/push.fixture.ts` | `push` | **0** |
| `test/fixtures/**` | `model-control`, `permissions` | **0** |

En total: **7 de las 10 hojas** de `src/ui/styles` (las tres restantes llegan por
`test/page-zoom.fixture.ts`, que las importa a propósito) y **16 suites** que leen
algo por ruta, no las 14 del diagnóstico, que además contaba `restart` por
`restart.ts` (ése sí llega por import) y no contaba `permissions`, `push` ni
`phone-media`. Lo peor es `phone-media.test.ts`: es la prueba que se escribió para
exactamente esto, tiene 19 casos sobre `hud.css` y `window.css`, y tocar
cualquiera de las dos hojas no la ejecutaba.

Nadie consume el código de salida de `--changed` por máquina: sólo `AGENTS.md` y el
brief FORGE (`src/shared/improve.ts:1211`). Cambiarlo no rompe automatismos.

## Qué se ha hecho

### La prueba declara con la ruta con la que lee

El recorrido (`test/affected.ts`) lee tres señales más, además de los `import`:

- `new URL('../public/sw.js', import.meta.url)`, o cualquier literal relativo que
  resuelva a un fichero que existe.
- Un literal que resuelva a un **directorio** (`'../src/ui/styles/'`, `'../bin/'`,
  o el prefijo de una plantilla: `` `./fixtures/${name}.txt` `` → `test/fixtures/`):
  todo lo que hay debajo cuenta como alcanzado.
- `href="/src/ui/styles/hud.css"` o `src="/src/…"`: absolutos desde la raíz, que es
  como Vite sirve los fuentes a los fixtures HTML de Playwright.

Lo que no existe en disco no cuenta (las rutas de escape de las pruebas de saneado,
`'../../etc/passwd'`, no seleccionan nada), y un directorio que contenga a las
propias suites (`test/` por `'.'`, la raíz por `'..'`) tampoco: es desde donde se
resuelve, no una declaración.

Estas señales sólo se leen en ficheros **bajo `test/`** (suites y fixtures). El
primer intento las leía en todo el grafo y cualquier suite que alcanzara el
collector cubría `bin/` entero (`src/collector/shims.ts:46` resuelve `../../bin`), y
la que alcanzara `src/hub/files.ts` cubría `src/` (resuelve `../`): 45 suites por
hoja tocada. Una ruta al disco en `src/` es comportamiento del producto; la
declaración de qué vigila una prueba está en la prueba. Con ese recorte:

| Fichero tocado | Antes | Ahora |
|---|---|---|
| `src/ui/styles/hud.css` | 0 | 9 |
| `src/ui/styles/window.css` | 0 | 10 |
| `src/ui/styles/tokens.css` | 1 | 13 |
| `improve.css`, `boot.css` | 0 | 3 |
| `public/sw.js`, `tools/supervise.mjs`, `tools/lease.mjs`, `package.json` | 0 | 1 cada uno |
| `bin/orca-read.mjs` | 0 | 3 |
| `test/fixtures/permissions/*.txt` | 0 | 2 |
| `src/shared/restart.ts` (por import, sin cambio) | 30 | 32 |

Dos suites entran de más, a sabiendas: `source-rev` en cualquier cambio bajo `src/`
(escanea `../src` entero: es verdad que lo mira) y `update` en cualquier cambio
bajo `src/ui` (su fixture es el `index.html` de Vite con
`<script src="/src/ui/main.ts">`, que el selector sigue hasta las hojas). Son dos
suites rápidas; quitarlas sería una excepción escondida en el selector.

Una memo de lecturas por llamada (`Memo`) hace que sesenta suites no lean sesenta
veces los mismos cien ficheros de `src/`: 25 consultas pasan de 11,6 s a 1,3 s con
arranque incluido; el selector es más rápido que antes de este cambio, no más lento.

### No ejecutar nada no es verde

`test/run.ts` sale con **código 3** (`NOTHING_RAN`, distinto del 1 de los fallos)
cuando no ejecuta ninguna suite: un filtro que no coincide con nada, o cambios que
ninguna suite cubre. La única corrida vacía que sigue siendo verde es `--changed`
con el árbol limpio: no hay nada tocado, luego nada sin verificar.

Y bajo el amarillo de `sin suite que los cubra`, si lo que quedó fuera lo alcanza un
`*.shots.ts` o un `*.visual.ts`, lo dice con el comando: esta corrida no los
ejecuta, pero «nadie lo mira» sería mentira.

`AGENTS.md` (al que apunta `CLAUDE.md`) cuenta las tres cosas en el párrafo de
verificación.

## Lo que no se ha hecho

- No se ha tocado `npm run shots` ni `npm run visual`: siguen sin `--changed`, y
  `affected()` ya admite `.shots.ts` y `.visual.ts` como sufijo si alguien quiere
  dárselo.
- No se aplica el patrón de `page-zoom.fixture.ts` (importar la hoja) a las otras
  hojas: con el selector nuevo no hace falta, cada prueba ya declara con la ruta
  que usa.
- `src/ui/main.ts` sigue sin suite que lo alcance (es el arranque de la consola);
  ahora el amarillo lo dice y la corrida no sale en verde.
- El `?? node_modules` de un worktree con `node_modules` enlazado aparece en
  `git status` y por tanto en `sin suite que los cubra`: es ruido del symlink
  (`.gitignore` tiene `node_modules/` con barra), no del selector. `--since=HEAD`
  no lo ve.

## Verificación

Todo desde un worktree propio y quieto (`forge-vivas-01-selector`, rama desde
`forge-vivas-01` @ `0ca9ad7` más estos ficheros), porque el árbol compartido del
squad tenía cambios ajenos a medio hacer y su `--changed` daba 23 fallos en
`Fresh CAPCOM` / `Provider handoff` que no son de esta pieza.

- `npm run typecheck`: sin errores.
- `npm test -- affected`: 8/8. Las tres pruebas de antes más: una hoja selecciona a
  quien la lee del disco y a quien la carga por `<link>` (también con el directorio
  con barra final); un fichero leído por `import.meta.url` cuenta y una plantilla
  cubre su directorio; rutas inexistentes, `..` y `.` no declaran nada; una ruta al
  disco en `src/` no es una declaración; y `run.ts` ejecutado como proceso con un
  filtro sin coincidencia sale con código 3.
- `npm test` completa: **1518/1518, código 0**, ninguna suite rota.
- De extremo a extremo, con `--since=HEAD`:
  - tocar sólo `src/ui/styles/hud.css` → 9 suites, 60/60 (`agent-stop`, `file-browser`,
    `gestures-dom`, `minimap`, `phone-media`, `source-rev`, `update`, `voice-dom`,
    `window-canvas`). Antes: 0 suites y código 0.
  - tocar sólo `public/sw.js` → `sw`, 27/27. Antes: 0.
  - tocar sólo `README.md` → 0 suites, amarillo y **código 3**.
  - árbol limpio → «nada tocado, nada que verificar», código 0.
- Sin shots: no hay cambio de UI. Los shots que miran las hojas siguen sin
  correrse desde `npm test`; ahora el amarillo los nombra.

**Lo que cazó correrlo de verdad y no la unitaria.** El primer e2e dio 0 suites
para `hud.css` donde `affected()` en un script decía 9: `run.ts` pasa el
directorio de pruebas con barra final y `startsWith(dir + '/')` comparaba contra
`test//`, así que ninguna suite contaba como propia y las tres señales nuevas se
apagaban en silencio. Exactamente el verde que no prueba nada que esta pieza
viene a cerrar, y salió en rojo gracias al código 3. Arreglado (`e216c8a`), la
unitaria prueba con barra, y se comprobó que con el selector anterior esa prueba
falla.

Commits en `forge-vivas-01`: `9aac6fc` (selector, `run.ts`, `AGENTS.md`),
`e216c8a` (barra final), `dec9bb2` (rig sin rutas reales).

Filtros que cubren esta entrega: `affected` (el selector, sus tres señales, el
ruido que no declara, y el código 3 de una corrida vacía, ejecutando `run.ts` como
proceso).
