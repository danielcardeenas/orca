# Gestos de la consola: qué toca el operador, no sólo qué pide el hub

Propuesta `imp_mtsckduj0xbfxnkh` · misión `mission_mtv3t4fi4vnpin1p` ·
rama `forge/gestos-consola-imp_mtsckduj0xbfxnkh`.

## Lo que había

La hipótesis de la propuesta se confirma en el código: los contadores `ui:`
los escribía `handleConsoleFrame` en `src/hub/server.ts` con el TIPO DE TRAMA
que llegaba al hub (`ui:hello`, `ui:improve:get`). Abrir la galería, desplegar
MISIONES, pulsar ⌥C o volar a un agente no le piden nada al hub, así que no
existían para AUTOMEJORA. De ahí «7 gestos» al lado de 500 lanzamientos, y
de ahí que la pregunta del brief del revisor —qué no toca nadie— no se pudiera
contestar sobre la interfaz.

## Lo que hay

Un vocabulario y un camino, sin contenido en ningún punto:

- **`src/shared/gestures.ts`** — las familias (`win`, `hud`, `key`, `fly`)
  como lista cerrada, la forma de un nombre (`gesture:<familia>:<detalle>`),
  `normalizeGestures` para validar un lote que escribe un navegador,
  `foldGesture` para el techo de 24 nombres por familia (lo que pasa se funde
  en `other`), `gesturesByFamily` y `windowKindsNeverOpened` para el informe.
  `WIN_KINDS` vive aquí y `wm.ts` deriva su tipo de esa lista: el hub, que no
  tiene ventanas, es quien escribe qué clases no se abrieron.
- **`src/ui/gestures.ts`** — el contador de la consola. `gesture('win',
  'agent')` suma a un mapa; cada 15 s, o con 50 acumulados, sale UN frame
  `gestures` sin ack. Si el enlace está caído el lote se queda y sale con el
  primer envío que funcione. Se conecta en `main.ts` justo tras `hub.connect()`.
- **Los ganchos**, cada uno donde ocurre el gesto y no en cada botón:
  `WindowManager.open` cuenta `win:<clase>` al crear una ventana (no al
  enfocar una ya abierta, ni al restaurar la sesión); `sections.open` cuenta
  `hud:sheet-<sección>`; los pliegues de MISIONES y AUTOMEJORA cuentan
  `hud:<sección>-fold|unfold`; `field.flyTo`/`flyToPoint` cuentan
  `fly:agent`/`fly:point` en el mismo punto en que el campo decide que fue el
  operador quien movió la cámara; y cada atajo ATENDIDO en `main.ts` cuenta
  `key:<tecla>` (`alt-c`, `mod-k`, `slash`, `f`, `window`…).
- **El hub** (`src/hub/server.ts`, `src/hub/improve.ts`): la trama
  `gestures` no cuenta como petición (`ui:`); su contenido pasa por
  `normalizeGestures` y entra por el mismo `ImproveStore.record` de siempre,
  que aplica el techo por familia. Los gestos suman a `signal`, así que una
  consola en la que se trabaja sin pedirle nada al hub también acerca la
  siguiente revisión.
- **El informe del revisor** gana tres líneas: los gestos más usados, el
  total por familia con los ceros, y **las clases de ventana que no se
  abrieron ni una vez** en 24 h. La antigua «console requests» pasa a
  llamarse «console requests to the hub» para que no se confunda con esto.

## Lo que no entra

Ni qué agente, ni qué archivo, ni qué se escribió. Sólo la clase de ventana,
la sección, la tecla y la clase de vuelo. Un detalle que no sea un nombre
limpio (`/Users/...`) se vuelve un nombre limpio o se tira; una familia que
no esté en la lista se tira; un lote que pase de 64 entradas se corta y una
cuenta que pase de 1 000 se recorta.

## Deuda que deja

- `src/ui/windows/wm.ts` en HEAD (`188e359`) no pasaba `tsc`: dos métodos
  `offView` con distinta firma. El privado se renombra a `tileOffView` aquí
  para que la rama compile. El árbol de trabajo de `main` tiene sin commitear
  otra solución que elimina ese método; al aterrizar, gana la de `main`.
- `main` tiene además cambios sin commitear en `server.ts`, `improve.ts`,
  `wm.ts` y `main.ts` de otras entregas. Esta rama sale de HEAD, no de ese
  árbol: aterrizarla pedirá una fusión con eso.
- Los atajos de `main.ts` y los pliegues de `hud/improve.ts` y
  `hud/missions.ts` no tienen prueba propia: van dentro de módulos que sólo
  se montan con la consola entera. El resto del camino sí la tiene.

## Verificación

```
npm run typecheck
npm test -- gestures improve      gestures.test.ts, gestures-dom.test.ts, improve*.test.ts
npm test -- --changed
```
