# Entrega — el clic derecho con el dedo

**Misión:** `mission_mtspovc6vm6xxa4b`
**Implementador:** Q8 · `87c2dede-8318-4240-a1ab-2c4806ce0a17` · squad `mission-03`
**Fecha:** 2026-09-08
**Estado:** implementado y verificado. **Sin commit** (§6).

---

## 1. Qué hay

Mantener pulsado medio segundo sobre cualquier superficie que ya tuviera menú
contextual lo abre. Nada más: ni una acción nueva, ni una tabla de opciones
paralela.

`src/ui/hud/longpress.ts` escucha un `pointerdown` de dedo o lápiz, espera
`HOLD_MS` (500) sin que se mueva más de `SLOP` (10px) y entonces **despacha un
`contextmenu` de verdad sobre el nodo que hay bajo el dedo**
(`document.elementFromPoint`). Ese evento sube por la misma cadena y lo recoge
el mismo manejador que atendía al botón derecho, así que **el objetivo es
siempre el correcto** —la baldosa, el squad, la región, la media, la fila, la
baldosa de la bandeja— y no hay dos vocabularios que mantener.

Se cablea **por superficie**, una llamada por sitio que ya ofrecía menú, no un
oyente global que fabrique `contextmenu` en cualquier parte:

| Superficie | Qué abre | Filtro |
| --- | --- | --- |
| `field/field.ts` (raíz del campo) | agente · squad · región · media · campo | salta `iframe`, `pre` y la × de una superficie |
| `windows/wm.ts` (`.win__head`) | el menú de la ventana | sólo la barra de título |
| `hud/tray.ts` | el de la ventana de esa baldosa | `[data-w]` |
| `kinds/gallery.ts` | el del artefacto | `.thumb` |
| `kinds/queue.ts` | el de la escalación | `.qrow` |
| `kinds/fleet.ts` | agente · proyecto · máquina · squad | las filas |
| `kinds/agent.ts` | agente · artefacto | los chips `[data-go]`, `[data-art]` |

**Sólo la barra de título de una ventana, no su cuerpo**: dentro hay
transcripts, y ahí el gesto largo es del sistema para seleccionar y copiar.

## 2. La presentación, coherente con lo que ya había

Con el dedo, el menú se viste como el selector (`pick`): **centrado**, la lista
scrollable dentro, filas de **48px**, fondo que oscurece y se come el gesto, y
sin las teclas dibujadas —no hay teclado que las cumpla—. Anclarlo al punto no
vale en un teléfono: el punto está debajo de la mano que acaba de mantener
pulsado.

El criterio de «esto es táctil» es **uno solo** para el menú y para el selector:
`touchDialog()` en `controls.ts`, exportado justamente para que no haya dos.

## 3. Lo que no hace, y cómo se cancela

- **No bloquea el desplazamiento ni el zoom.** No llama a `preventDefault` en
  `pointerdown` ni en `pointermove`: el navegador sigue mandando en el scroll.
  Si el dedo se mueve, el gesto no se cumple y ya está.
- **No toca el ratón.** Sólo `touch` y `pen`; el clic derecho de escritorio es
  exactamente el de antes, con su menú anclado al puntero.
- **No secuestra texto ni controles.** Quedan fuera `input`, `textarea`,
  editables, enlaces, `iframe`, `pre`, `code` y el terminal, que es donde el
  gesto largo del sistema ya sirve para algo.
- **No abre dos menús.** Si el navegador saca su `contextmenu` nativo primero
  (Android lo hace), el temporizador se cancela y manda el nativo; si el nuestro
  sale primero, se traga el nativo que llegue detrás.
- **No deja un clic suelto.** Al levantar el dedo habría un `click` sobre lo que
  hay debajo —que ahora es el menú— y elegiría una fila sin querer: un guardián
  en captura se traga exactamente uno. Y el campo marca además su propio
  `swallowClick`, que es el mecanismo que ya tenía para lo mismo.
- **Se cancela** con movimiento, un segundo dedo, `pointercancel`, `pointerup`,
  un scroll o una rueda, y al perder el foco la ventana. Esos tres últimos son
  **un solo oyente** para toda la consola, no uno por superficie: si no, cada
  ventana abierta dejaría el suyo colgado.

## 4. La causa de que no funcionara a la primera

El gesto disparaba el `contextmenu` correctamente y el menú no salía. El campo
lo descartaba en su propia guarda:

```js
if (mode !== 'none') return;   // «no abras un menú a mitad de un arrastre»
```

`mode` se fija en el `pointerdown` —`agent` sobre una baldosa, `pan` sobre el
vacío— **antes de que nada se haya movido**. Con un ratón daba igual: el botón
derecho llega con el izquierdo levantado. Con una pulsación larga el dedo sigue
abajo justo cuando el menú tiene que salir, así que la guarda se lo comía
siempre.

La guarda ahora es el **movimiento**, que es lo que de verdad se quería evitar:

```js
if (mode !== 'none' && dragMoved) return;
```

Ésa es la integración en la interacción compartida del campo que pedía el
encargo: una condición corregida donde vive, no un evento sintético colado por
encima.

## 5. Pruebas

Con **eventos de toque reales**, no sintéticos: `Input.dispatchTouchEvent` por
CDP produce eventos confiables, y es lo único que permite medir cuánto se
aguanta y cuánto se mueve. En `test/hud-mobile.shots.ts`, a 390×844:

| Caso | Qué se afirma |
| --- | --- |
| toque corto (90ms) | no abre menú, y **sigue haciendo lo que hacía** (abre el agente) |
| mantener 620ms | abre el menú **una vez**, vestido de diálogo |
| … | la cabecera nombra el sujeto correcto, cabe en pantalla, filas ≥44px |
| … | al levantar el dedo **no se elige nada**: el menú sigue abierto |
| `Escape` | lo cierra |
| arrastrar 60px durante la pulsación | no abre menú |
| segundo dedo (pinza) | no abre menú |
| mantener sobre un `textarea` | no abre menú: ese gesto es del sistema |

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **956/956** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** (escritorio intacto) |

Evidencia visual: ver la corrección de más abajo. La captura que acompañaba a
esta sección estaba **mal**: enseñaba el menú del campo, no el de un agente.

## 6. Limitaciones

1. **Sin commit**: `HEAD` en `507e30c`, árbol compartido con WO.
2. **Sin dispositivo físico.** Los toques son de Chromium por CDP: confiables y
   con tiempos reales, pero no son un dedo. Lo que no cubren es el gesto largo
   **nativo** de iOS Safari y de Android Chrome sobre elementos donde sí lo
   sacan (imágenes, enlaces): el código los deja pasar y traga el suyo si llega
   tarde, pero esa carrera concreta no se puede reproducir aquí.
3. **La vibración** (`navigator.vibrate`) se llama si existe; en iOS no existe y
   no hay acuse háptico. No hay alternativa desde una página web.
4. **El menú del campo puede ser largo** (diez filas para un agente): cabe con
   scroll dentro del diálogo, pero en apaisado ocupa casi todo el alto. Se ha
   dejado así antes que esconder filas.
5. Las superficies cubiertas son las siete de la tabla. Si mañana aparece otra
   con `contextmenu` propio, hay que añadirle su línea: es una llamada, y es
   deliberado que sea explícita.

## Validación

```
npm run typecheck
npm test -- --changed                          956/956
npx tsx test/hud-mobile.shots.ts               el gesto, con toques reales
npx tsx test/hud-missions.shots.ts             el escritorio, intacto
```

---

# Corrección — la captura no era la que decía, y detrás había dos fallos

El operador abrió `mobile-06i-longpress.png` y vio el menú **FIELD**, no el del
agente que el informe afirmaba. Tenía razón: la captura del informe venía de una
prueba manual contra la consola viva —donde sí salía `Q8 · OR · WORKING`— y la
del arnés cayó sobre canvas vacío. Al ir a arreglar la prueba aparecieron dos
fallos de verdad.

## Fallo 1 · el sujeto se decidía medio segundo tarde

`elementFromPoint` al vencer el temporizador no es el objetivo de la pulsación:
es lo que hay ahí **después**. En el campo, con la flota entrando y saliendo,
la baldosa se ha recolocado y el punto ya es canvas vacío — menú del campo,
sobre un dedo que no se ha movido.

Dos capas de corrección, cada una en su sitio:

- **`hud/longpress.ts`** guarda el elemento pulsado y despacha sobre él cuando
  sigue en el árbol; sólo vuelve a preguntar por coordenadas si ya no está.
- **`field/field.ts`** no vuelve a picar por coordenadas cuando el dedo no se
  ha movido: usa `clickId` / `dragId`, que es lo que el propio campo ya guarda
  al bajar el dedo para saber sobre qué se hizo clic. El menú es del sujeto que
  se pulsó, se haya movido el mundo o no.

## Fallo 2 · el menú nativo abría lo que nosotros cancelábamos

Chromium saca su propio `contextmenu` a los ~500 ms de una pulsación larga, y lo
saca **también** cuando nosotros cancelamos a propósito: con dos dedos, con un
`touchCancel`, con un arrastre. Como la guarda del campo pasó a mirar el
movimiento, ese nativo encontraba la puerta abierta y el menú salía justo en los
casos en los que se había decidido que no. Lo vio la prueba de la pinza.

Dentro de una secuencia táctil el gesto es ahora la **única** puerta: el nativo
se traga (`NATIVE_MS`, 1,5 s desde el último dedo). El ratón no entra en esa
regla —la marca sólo la mueve un dedo—, así que el clic derecho de escritorio
sigue intacto.

## Las pruebas, ahora de identidad y no de existencia

Sobre una baldosa, tres comprobaciones encadenadas:

1. la cabecera lleva un **callsign**, no un título genérico (`FIELD` habría
   fallado aquí, que es exactamente lo que pasaba);
2. las filas son las de un agente —`OPEN`, `FLY TO`, `SPAWN CHILD`, `STOP`— y
   **no** `FRAME ALL`;
3. `OPEN` abre la ventana de **ese mismo callsign**, comparando `.win__cs` con
   la cabecera del menú.

Y sobre canvas vacío, la contraria: título `FIELD`, `FRAME ALL` presente y
`SPAWN CHILD` ausente. El punto vacío no se busca por geometría —hay baldosas,
bloques de squad y rótulos, y todo se mueve—: se prueban ocho puntos y se exige
que **alguno** dé el menú del campo.

Añadido además:

- **`pointercancel`**: un toque que el sistema cancela no abre menú.
- La baldosa de la prueba se elige **quieta**: se muestrea dos veces con medio
  segundo de por medio y se acepta la que no se movió, con cuatro reintentos.
  Sin eso, apuntar a donde estaba hace un segundo es apuntar al vacío, y la
  prueba fallaba por el motivo equivocado.

## Archivos

| Fichero | Cambio |
| --- | --- |
| `src/ui/hud/longpress.ts` | El objetivo es el pulsado; el `contextmenu` nativo se traga dentro de una secuencia táctil |
| `src/ui/field/field.ts` | Con el dedo quieto el sujeto es el picado al bajar (`clickId`/`dragId`), no el de las coordenadas al vencer |
| `test/hud-mobile.shots.ts` | Identidad en tres pasos, menú del campo por búsqueda, `pointercancel`, baldosa quieta |

## Validación

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **956/956** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** |

## Evidencia, esta vez la que dice

- `test/shots/mobile-06i-longpress-agent.png` — cabecera `N1 · LZ · NEEDS YOU`,
  con `OPEN`, `TERMINAL` (apagado, «NO PANE»), `FLY TO`, `SAY…`, `SPAWN CHILD`,
  `SELECT CHILDREN`, `PROJECT LZ`, `DISMISS` y `STOP`. Es el menú de un agente,
  y del agente que se pulsó.
- `test/shots/mobile-06i-longpress-field.png` — el otro: `FIELD`, con `FRAME
  ALL`, el bloque `DECK`, `SPAWN…`, `LAUNCH…`, `FLEET`, `CAPCOM`.

La captura vieja (`mobile-06i-longpress.png`) se ha borrado para que no vuelva a
citarse.

## El apaisado, ya cubierto

Añadido el paso **8d** a `test/hud-mobile.shots.ts`, en 844×390:

- mantener sobre una baldosa abre el menú **una vez**;
- la cabecera lleva el **callsign de ese agente** y las filas son las suyas
  (`OPEN`, `FLY TO`, `STOP`), no las del campo;
- **cabe** en los 390px de alto y lo que no cabe **se desplaza dentro**: se
  comprueba que el menú tiene su propio scroll y que se llega a las filas de
  abajo;
- al levantar el dedo **no se elige nada**;
- y elegir funciona: `FLY TO` mueve la cámara y cierra el menú, sin clic
  accidental.

Captura: `test/shots/mobile-08d-longpress-landscape.png` — `M1 · AX · WORKING`,
con el chip `@M1` en la línea de comando confirmando el sujeto.

### Dos arreglos que salieron al cubrirlo

1. **Los dedos se contaban con un número.** Un `touchEnd` que suelta dos a la
   vez no entrega dos `pointerup`, así que la cuenta se quedaba en 1 para
   siempre y después de una pinza **no volvía a abrirse ningún menú**. Ahora
   son ids en un `Set`, y un `pointerdown` primario empieza secuencia y limpia:
   el estado no puede quedarse colgado.
2. **La marca de «esto viene de un dedo» se refresca al mover.** El menú nativo
   de Chromium puede llegar tarde en una secuencia larga, y fuera de la ventana
   de 1,5 s se colaba justo cuando ya habíamos cancelado. Se vio como un fallo
   intermitente en la prueba de la pinza.

La prueba, además, vuelve a leer el centro de la baldosa **justo antes de cada
gesto** y descarta las que caen bajo el mástil, el radar, la bandeja o la barra:
el campo se mueve entre medir y pulsar, y apuntar a la medida vieja es apuntar
al vacío — que daba el menú del campo y parecía un fallo del gesto sin serlo.

`npx tsx test/hud-mobile.shots.ts` en verde **dos veces seguidas** (la
intermitencia era eso), y `npm test -- --changed` **956/956** por el cambio en
`longpress.ts`.
