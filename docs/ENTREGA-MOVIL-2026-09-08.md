# Entrega — Misiones y Automejora en un teléfono

**Misión:** `mission_mtsaa02eqa14rjii`
**Implementador:** Q8 · `87c2dede-8318-4240-a1ab-2c4806ce0a17` · squad `mission-03`
**Fecha:** 2026-09-08
**Estado:** implementado y verificado. **Sin commit** (§7).

El canal de mensajes trunca, así que el informe íntegro es éste. La descripción
para quien venga después está en [MISSIONS.md](MISSIONS.md) («En un teléfono»);
AUTOMEJORA se documenta en [AUTOMEJORA.md](AUTOMEJORA.md), que es de WO y no he
tocado.

---

## 1. El problema, dicho sin adornos

Las dos secciones del HUD flotan sobre el campo: MISIONES arriba a la izquierda
(360px) y AUTOMEJORA arriba a la derecha (400px). Eso cabe en 1400px y no cabe
en 390. La respuesta que había era apagarlas —`@media (max-width: 900px) {
.missions { display: none } }` y `@media (max-width: 1180px) { .improve {
display: none } }`— y **apagar una sección no es adaptarla**: en un teléfono
ORCA se quedaba sin las dos y sin ninguna manera de llegar a ellas que no fuera
un atajo de teclado (`⌥I`) o encontrar CAPCOM. Entre 900 y 1180 —un portátil
pequeño, una ventana a media pantalla— AUTOMEJORA sencillamente no existía.

## 2. Qué hay ahora

### La barra de secciones (`src/ui/hud/sections.ts`, nuevo)

Una barra en el dock, abajo, al alcance del pulgar y por encima de la línea de
comando. Un botón por sección, con su cuenta viva y su color: lima la flota,
violeta ORCA mirándose. Pulsar uno abre esa sección como **hoja** sobre el
campo.

- **Una a la vez.** El estado es `<body data-sheet="missions|improve|">`, un
  solo valor: dos hojas no pueden taparse porque no pueden estar abiertas a la
  vez. Verificado midiendo rectángulos, no leyendo CSS.
- **Nunca permanente.** El mismo botón la cierra, la `×` de la barra la cierra,
  `Escape` la cierra y tocar el campo la cierra. Y la hoja tiene **alto por
  contenido con tope**: una lista de tres filas deja ver el campo detrás en vez
  de estirarse hasta el dock.
- **Cada puerta donde hace falta.** MISIONES aparece bajo 900px y AUTOMEJORA
  bajo 1180px, que es exactamente donde cada una dejaba de caber. En una
  pantalla intermedia la barra enseña una sola puerta.
- **Nada se pierde.** No se mueve un solo nodo del DOM: la hoja es la misma
  sección con otra caja. Los borradores, las filas desplegadas, el scroll y los
  listeners siguen donde estaban, y volver a una ventana ancha lo devuelve todo
  intacto — se ve en `mobile-10-desktop.png`, donde la fila que se desplegó en
  el teléfono sigue desplegada en el escritorio.

### El mástil, compacto (`src/ui/styles/hud.css`)

Los quince abridores envolvían en **cinco filas** y se comían 480 de los 844px
de un iPhone, con una tecla dibujada en cada uno que en un teléfono no existe.
Ahora son **una fila que se desliza con el dedo**, sin las `<kbd>`, con el borde
derecho desvanecido para decir que hay más. El mástil pasa de ~200px a ~40 y ese
sitio se lo queda lo que se ha venido a leer. Las pistas de teclado
(`.hints`) desaparecen con un puntero grueso: no hay teclas que sugerir.

### La ventana de misión (`src/ui/styles/window.css`)

Ya ocupaba la pantalla bajo 720px; lo que faltaba es que dejara sitio y que se
pudiera escribir:

- alto `100dvh` menos la banda del dock (línea de comando, barra de secciones y
  bandeja), menos `env(safe-area-inset-bottom)`, menos `--kb`;
- `--kb` lo mide `sections.ts` con `visualViewport` y lo publica en el root, y
  `index.html` declara `interactive-widget=resizes-content`, que es lo que hace
  que el viewport se encoja con el teclado en vez de empujar la página;
- la caja de escribir se ancla al fondo de la ventana (`position: sticky`) y su
  fuente sube a 16px, que es lo que evita el zoom automático de iOS;
- pestañas que envuelven, cabecera de 40px, botones de 44.

### Táctil, no ratón (`@media (pointer: coarse)`)

Dentro de una hoja, todo lo que se pulsa crece a altura de dedo: el desplegable
de una fila (44×40), CONVERSATION / RESULTS, los callsigns, y en AUTOMEJORA
REVIEW NOW / PAUSE / SETUP, REPLY, SEND TO CAPCOM, LATER, DISMISS y OPEN
MISSION. La fila de estado y la de acciones envuelven en vez de salirse, y la
caja de respuesta pasa a ancho completo con su botón debajo. **Fuera de la hoja
no cambia nada**: el escritorio con ratón se queda como estaba.

### Apaisado y 360px

En apaisado (`max-height: 560px`) la hoja se lleva el sitio del mástil, que
estando abierta no se está usando, y lo devuelve al cerrarse. A 360px la barra
encoge sus etiquetas antes que perderlas —un botón sin palabra hay que
aprenderlo— y la hoja se pega a 4px de cada borde.

## 3. Archivos

### Nuevos

| Fichero | Qué es |
| --- | --- |
| `src/ui/hud/sections.ts` | La barra, el estado `data-sheet`, las cuentas vivas, el cierre por `Escape` y por toque en el campo, y la medida del teclado virtual |
| `test/hud-mobile.shots.ts` | El arnés táctil: 390×844, 360×640, apaisado y regresión de escritorio |
| `docs/ENTREGA-MOVIL-2026-09-08.md` | Este informe |

### Modificados

| Fichero | Cambio |
| --- | --- |
| `src/ui/styles/hud.css` | Bloque nuevo de barra + hojas + táctil + apaisado + 360px; mástil de una fila deslizante; banda inferior del dock (comando, barra, bandeja) con áreas seguras y `--kb`; pistas fuera del paso |
| `src/ui/styles/window.css` | La ventana en móvil: banda del dock, áreas seguras, teclado, pestañas, composer pegajoso y objetivos táctiles |
| `src/ui/main.ts` | Monta la barra, marca `body.has-tray`, y `⌥I` / `/improve` abren la hoja donde la sección es una hoja |
| `index.html` | `interactive-widget=resizes-content` en el viewport |
| `test/hud-missions.shots.ts` | El caso estrecho ya no afirma «el panel se aparta» a secas: comprueba que la barra es la puerta y que abre la hoja. Y las filas terminadas se comprueban por su regla, no por tres ids fijos (el hub del arnés comparte `ORCA_HOME` y tiene misiones propias) |
| `docs/MISSIONS.md` | Sección «En un teléfono» |

### Deliberadamente NO tocados

`src/ui/hud/improve.ts` y `src/ui/styles/improve.css`, que son de WO y están en
vuelo con el agente revisor (`mission_mtsaf4fnjtrh9j5j`). Todo el móvil de
AUTOMEJORA sale de `hud.css` con selectores de más especificidad
(`body[data-sheet="improve"] .improve …`), que ganan a la regla que la esconde
sin necesidad de `!important` y sin que su fichero cambie. Lo único que este
código hace sobre su elemento es ponerle `id="hud-improve"`, para que el
`aria-controls` del botón pueda nombrarlo. Reparto acordado con WO por mensaje
antes de escribir una línea.

## 4. Pruebas ejecutadas y resultados

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK**, sin salida |
| `npm test -- --changed` | **854/854** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** (arnés nuevo) |
| `npx tsx test/hud-missions.shots.ts` | **verde** (regresión del panel y de la ventana) |

Lo que afirma el arnés móvil, en orden:

1. **La puerta está a la vista** sin abrir nada, dentro del viewport, y los dos
   botones miden ≥44px. Ninguna sección ocupa el canvas hasta que se pide.
2. **Una hoja a la vez**: abrir MISIONES la enseña sin pisar la barra ni la
   línea de comando (rectángulos, no CSS); abrir AUTOMEJORA aparta MISIONES.
3. **AUTOMEJORA es usable**: el tablero se lee, una ficha se abre **al tocarla**,
   sale la pregunta al operador y su caja de respuesta, y REPLY, SEND TO CAPCOM,
   LATER · 3D y DISMISS están todos presentes y son objetivos de dedo; REVIEW
   NOW, PAUSE y SETUP también. Desde una propuesta ya enviada, **OPEN MISSION
   abre la ventana de su misión** en el teléfono.
4. **Cerrar**: el mismo botón, la `×` y `Escape`, y el canvas queda libre.
5. **La fila**: el desplegable se abre **tocándolo**, con el título entero y el
   encargo entero dentro; ninguna fila se pinta en blanco.
6. **La ventana de misión**: cabe en el ancho, deja libres la barra y la línea
   de comando, el composer está en pantalla, se escribe media línea, se cierra
   la ventana —sin archivar la misión— y al reabrirla **el borrador sigue ahí**.
   Una misión terminada abre por RESULTS también aquí.
7. **Apaisado**: lo que estaba abierto sigue abierto tras girar, y la hoja
   conserva alto para leer.
8. **360×640**: nada de la barra se sale del ancho y todo sigue midiendo ≥40px.
9. **Escritorio 1440×900**: no hay barra, el panel de misiones vuelve arriba a
   la izquierda, AUTOMEJORA arriba a la derecha, y **no se solapan**.

No se dispara nada que viaje al hub desde el arnés (SEND, LATER, DISMISS y
REPLY se comprueban como objetivos táctiles, no se pulsan): el hub del arnés no
tiene ese tablero y contestaría con el suyo, vacío, llevándose por delante lo
que se está midiendo.

## 5. Evidencia visual

En `test/shots/`, capturadas con contexto táctil real de Playwright
(`isMobile`, `hasTouch`, UA de iPhone 13, DPR 3) y con `tap()`, no con `click()`:

| Fichero | Qué enseña |
| --- | --- |
| `mobile-01-closed.png` | 390×844 sin nada abierto: el campo entero y las dos puertas |
| `mobile-02-missions.png` | La hoja de MISIONES |
| `mobile-03-improve.png` | La hoja de AUTOMEJORA |
| `mobile-04-improve-card.png` | Una ficha abierta: evidencia, detalle, pregunta, respuesta y acciones |
| `mobile-04b-from-improve.png` | La ventana de misión abierta desde una propuesta |
| `mobile-05-detail.png` | El detalle de una fila abierto con el dedo |
| `mobile-06-window.png` | La ventana de misión con el borrador escrito |
| `mobile-07-results.png` | Una misión terminada, por RESULTS |
| `mobile-08-landscape.png` | 844×390 |
| `mobile-09-narrow.png` | 360×640 |
| `mobile-10-desktop.png` | La regresión de escritorio |

## 6. Confirmaciones que pidió el operador

- **Acceso visible y táctil a las dos secciones**, sin atajos, sin hover y sin
  pasar por CAPCOM: la barra del dock, siempre a la vista, con etiqueta y
  cuenta. Comprobado que ambas puertas existen y miden ≥44px.
- **Navegación compacta, sin paneles tapándose ni ocupar todo el canvas
  permanentemente**: una hoja a la vez (imposible taparse por construcción),
  alto por contenido con tope, y cuatro maneras de cerrarla. El mástil pasa de
  cinco filas a una.
- **Ventanas de misión adaptadas al viewport**, con identidad por misión, el
  detalle completo, resultados / archivos / media y la conversación: la ventana
  ocupa el ancho y deja el dock; su clave sigue siendo `mission:<id>`; el
  borrador sobrevive a cerrar y reabrir; una terminada abre por RESULTS.
- **AUTOMEJORA usable**: leer, responder, enviar a CAPCOM, abrir la misión en
  ventana independiente, posponer, descartar, configurar y pausar — todo
  presente y con tamaño de dedo, comprobado uno por uno.
- **Superposición, scroll, áreas seguras y teclado virtual**: rectángulos que no
  se cruzan (medidos), la lista con su propio scroll dentro de la hoja,
  `env(safe-area-inset-*)` en la barra, la línea de comando, la bandeja y la
  ventana, y `--kb` + `interactive-widget` para el teclado.
- **Borradores y ventanas accesibles al resize**: nada se desmonta al cambiar de
  ancho porque no se mueve un solo nodo; la vuelta a escritorio está
  fotografiada con el estado intacto.
- **No es ocultar el panel con una media query**: la media query que lo ocultaba
  sigue ahí, pero ahora sólo describe «no flota aquí»; la sección se abre.

## 7. Limitaciones y avisos

1. **Sin commit.** `HEAD` en `507e30c`. El árbol está compartido con la misión
   del agente revisor de AUTOMEJORA (WO); un commit se llevaría trabajo ajeno en
   vuelo.
2. **No hay dispositivo físico.** Todo se ha verificado en Chromium con contexto
   táctil (`hasTouch`, `isMobile`, UA de iPhone, DPR 3) y gestos `tap()`. Eso
   cubre layout, objetivos táctiles, scroll y orientación. **No cubre**: Safari
   de iOS de verdad (su `visualViewport` y su barra de direcciones tienen
   comportamientos propios), el zoom por doble toque, ni el arrastre con inercia
   del sistema. `interactive-widget=resizes-content` lo honran Chrome y Android;
   en iOS el trabajo lo hace la medida de `visualViewport`, que sí se ejecuta,
   pero cuya cifra exacta no he podido observar sin el dispositivo.
3. **El teclado virtual no se puede levantar desde Playwright**, así que `--kb`
   se ejerce en el código y se ve valer 0 en las pruebas; la ruta con teclado
   abierto queda sin comprobar de forma automática.
4. **Entre 900 y 1180px** el panel de misiones sigue flotando (es donde cabe) y
   AUTOMEJORA pasa a hoja. Es deliberado: cada sección cambia de forma donde
   deja de caber, no antes.
5. **La bandeja de ventanas se reduce** en móvil (46×34, sin la línea inferior)
   y un rótulo largo se recorta dentro de la baldosa. Es lo que hace legible una
   fila de baldosas pequeñas, pero un `MISSION` se lee como `MISSI`.
6. **`src/ui/hud/improve.ts` y `improve.css` no están tocados** a propósito: si
   WO cambia los nombres de clase de la fila de estado o de las acciones, mis
   reglas táctiles dejarían de aplicarse en silencio. Queda dicho aquí y
   avisado a WO por mensaje.
7. **Sin suite unitaria**: `hud/sections.ts`, `hud.css`, `window.css`,
   `main.ts` e `index.html`. Los cubre el arnés visual, que es la única forma
   de comprobar un layout; el runner de unidades los lista como «sin suite que
   los cubra».

## Validación

```
npm run typecheck
npm test -- --changed                          854/854
npx tsx test/hud-mobile.shots.ts               móvil, apaisado, 360px y regresión
npx tsx test/hud-missions.shots.ts             el panel y la ventana en escritorio
```

---

# Segunda tanda — cinco arreglos de uso, misma misión

`mission_mtsaa02eqa14rjii` · 2026-09-08 · Q8. Cinco cosas que el operador pidió
sobre lo entregado arriba, hechas y verificadas en un solo lote.

## 1. El destinatario: no hay elección falsa

`NO LEAD` y `VIA CAPCOM` eran dos fichas una al lado de la otra, y la primera
salía **desactivada** cuando no había líder. Dos botones juntos son una
pregunta, y la respuesta era «no hay nada que elegir».

- **Sólo CAPCOM** (no hubo líder, o el líder terminó): una frase, no un botón —
  «Conversando con CAPCOM» con un punto de color, sin borde y sin hover— y
  debajo el porqué en una línea honesta: si el líder terminó, se dice con su
  hora.
- **Líder vivo**: dos opciones comprensibles, `HABLAR CON <CALLSIGN>` y
  `HABLAR CON CAPCOM`, en un `role="radiogroup"` con `aria-checked` y la
  seleccionada marcada en lima. **Elegir no manda nada**; manda SEND.
- **Líder terminado**: `LEER <CALLSIGN>` sigue ahí, pero como **acción** que
  abre su transcript, no como destinatario. Mandarle un mensaje a una sesión
  muerta no es una opción y no se ofrece.

Copy en castellano, como el diálogo de archivar que ya vivía en esta ventana:
son frases dirigidas al operador, no rótulos de instrumento.

## 2. Cerrar y minimizar, 44×44 de verdad

`—` y `×` medían 36×32 con un glifo de 10px. Ahora, bajo `@media (pointer:
coarse)` —por **puntero**, no por ancho, así que vale en teléfono y tableta y
no toca el escritorio con ratón— miden **44×44**, con 6px de separación, borde
propio (sin hover que los descubra), y el glifo a 18–20px. Va en el chrome
compartido de `window.css`, así que lo heredan **todas** las ventanas: misión,
CAPCOM, agente, artefacto, terminal. El arrastre no pierde nada: la cabecera ya
ignoraba un `pointerdown` que empieza en un botón, y en móvil no se arrastra.
Nada se ha escondido para hacer sitio; el título encoge con su elipsis.

## 3. Botones táctiles con el texto centrado

Subir `min-height` no mueve el texto: una caja con `padding` fijo,
`line-height: 1` o `align-items: baseline` —el caso de `.chip`— deja la
etiqueta arriba y crece por debajo. Todo lo que se agranda por táctil se centra
ahora en los dos ejes y se deja envolver; las filas de rejilla
(`.mission-win__reph`, `.mission-win__file`, `.missions__row`) se centran sin
dejar de ser rejilla. Medido en la prueba con un `Range` sobre el contenido de
cada botón: **desviación ≤2px** respecto al centro de su caja.

## 4. Enter salta línea; ⌘/⌃Enter manda

Regla nueva, la misma en escritorio y en móvil, en `src/ui/windows/composer.ts`:

| Tecla | Qué hace |
| --- | --- |
| `Enter` | salta de línea. Siempre. No manda nunca |
| `⌘Enter` / `⌃Enter` | manda, una sola vez (`repeat` fuera) |
| el botón SEND | manda |

`⌃Enter` vale igual que `⌘Enter` porque un teclado que no es de Mac no tiene ⌘.
**El IME no manda**: `isComposing` (y el `keyCode 229` de los navegadores que no
lo ponen) sale antes de tocar nada, porque ahí Enter confirma la palabra que se
está componiendo. Se aplica a las tres cajas de varias líneas —CAPCOM, misión y
agente— y a la respuesta de una ficha de AUTOMEJORA, ésta por delegación sobre
su lista porque las fichas se repintan enteras.

Lo que **no** se ha tocado, y es la regla: un `<input>` de una sola línea
—contestar una escalación, hablarle a una flota, el filtro de un selector, la
línea de comando, el terminal— manda con Enter y así se queda. En una caja sin
salto de línea, Enter no tiene otro trabajo.

Se retira el atajo `S` de envío y su tecla dibujada, en la ventana de misión y
en la de agente, y el `data-key="enter"` de CAPCOM. La pista se mueve al
placeholder —«… · ⌘↵ envía, enter salta línea»— y **desaparece en un aparato
sin teclado** (`any-pointer: coarse` y ningún `fine`), donde una pista de
teclado es una instrucción imposible de seguir. La tabla de teclas de `wm.ts`
queda actualizada, con el porqué.

## 5. Un selector es un diálogo centrado, no un desplegable

Hecho en el componente compartido (`src/ui/controls.ts`, `pick`), así que lo
heredan **todos** los sitios que ya lo usaban sin tocar una línea: MORE de
misiones terminadas en CAPCOM, los modelos de CAPCOM y del relevo,
proyecto/modelo/runtime/permiso de un spawn, el proyecto de un lanzamiento, las
fuentes de ajustes y los presets y packs de SFX.

Bajo 720px —el mismo ancho en el que una ventana pasa a ocupar la pantalla— el
mismo `pick` se abre **centrado en el viewport**: cabecera con lo que se está
eligiendo, `×` de 44px, lista scrollable dentro con `overscroll-behavior:
contain`, opciones de **48px** con la pista debajo del rótulo en vez de peleando
por el ancho, y lo elegido marcado en lima sin depender del hover. El alto se
mide contra `100dvh` menos las áreas seguras y menos `--kb`, así que el teclado
del filtro no esconde la mitad de las opciones.

- **El fondo no se arrastra**: un scrim con `touch-action: none` se come el
  gesto que si no paneaba el campo mientras se elegía. Tocarlo cierra.
- **Foco**: entra en el filtro si lo hay, y si no en la lista; al cerrar vuelve
  a donde estaba. `Escape` cierra sin elegir; elegir confirma y cierra, con la
  misma semántica de antes (`commit` → `change` → `onChange`).
- **Con el dedo se elige con `click`, con ratón con `mousedown`** —uno u otro,
  nunca los dos— porque el `mousedown` emulado del táctil llega tarde y elegiría
  dos veces.
- **El escritorio no cambia**: sigue siendo un desplegable colgado de su botón,
  sin scrim, y la prueba lo afirma midiendo que el menú arranca en la x del
  botón.

## Archivos

| Fichero | Cambio |
| --- | --- |
| `src/ui/windows/composer.ts` | **Nuevo.** La regla de Enter, el acorde por plataforma, el texto de ayuda y `isSendChord` |
| `src/ui/controls.ts` | `pick`: modo diálogo, scrim, cabecera con cierre, foco y elección por `click` en táctil |
| `src/ui/windows/kinds/mission.ts` | Destinatario honesto; composer nuevo; sin `data-key` en SEND |
| `src/ui/windows/kinds/ceo.ts` | Composer nuevo; placeholder con el acorde; sin `data-key="enter"` |
| `src/ui/windows/kinds/agent.ts` | Composer nuevo; placeholder; sin `data-key="s"` |
| `src/ui/hud/improve.ts` | Una línea: keydown delegado para que ⌘/⌃Enter mande la respuesta (acordado con WO) |
| `src/ui/windows/wm.ts` | La tabla de teclas, sin los envíos, y el porqué |
| `src/ui/styles/window.css` | 44×44 por puntero grueso, centrado, `.mission-win__to`, el diálogo del `pick` |
| `src/ui/styles/hud.css` | Centrado de lo que se agranda por táctil en las hojas |
| `test/hud-mobile.shots.ts` | Las comprobaciones de esta tanda |
| `test/hud-missions.shots.ts` | Una aserción que hablaba del selector viejo |

## Validación

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **867/867** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** (regresión de escritorio) |

Lo que afirma el arnés, además de lo de la primera tanda: sin líder no hay
`[data-route]` ni un solo `button:disabled`, y sí la frase «Conversando con
CAPCOM» · `Enter` deja `uno\ndos` en la caja y **nada** sale · un `keydown` con
`isComposing` y ⌘ no manda ni toca el texto · el acorde manda y deja **un**
eco · el botón manda y no anuncia ninguna tecla · cerrar y minimizar miden
44×44, con el glifo centrado (≤2px), a ≥16px, separados y **dentro** de su
cabecera · minimizar pliega a la bandeja y la bandeja lo devuelve · las
etiquetas de `.mission-win__act`, `.chip`, `.tab` y `.win__btn` están centradas
(≤2px) · el selector abre como diálogo centrado en el viewport con opciones de
≥44px, scrim, lista scrollable y cierre visible, y `Escape`, el fondo y elegir
lo cierran · en escritorio sigue siendo un desplegable anclado a su botón.

Capturas nuevas: `test/shots/mobile-06b-composer.png` (Enter, el acorde y el
destinatario) y `test/shots/mobile-06f-dialog.png` (el selector como diálogo).

## Limitaciones de esta tanda

1. `⌘Enter` se prueba con `ControlOrMeta+Enter` de Playwright, que es el acorde
   real; **el IME se prueba con un evento sintético** con `isComposing: true`,
   porque no hay manera de levantar un IME de verdad en el arnés.
2. El diálogo del `pick` se comprueba en el MORE de CAPCOM. Los demás usos
   —spawn, ajustes, SFX, modelos— lo heredan del componente y no se abren uno
   por uno en la prueba.
3. La línea añadida a `src/ui/hud/improve.ts` es de WO. Está avisada por
   mensaje, con lo que hace y por qué es por delegación.

---

# Nota de corrección — las dos brechas de alcance

`mission_mtsaa02eqa14rjii` · 2026-09-08 · Q8. El operador leyó la segunda tanda
y no la cerró por dos cosas. Las dos estaban bien vistas.

## 1. El diálogo se decidía sólo por ancho

`DIALOG()` era `matchMedia('(max-width: 720px)')`. Un teléfono **girado** mide
844×390: por ancho parecía un escritorio y se quedaba con el desplegable, que
es justo donde peor cae — un menú de 240px de alto en una pantalla de 390 no
tiene sitio ni arriba ni abajo, así que se voltea, se recorta, o las dos.

El criterio mira ahora el **dedo** y las **dos** medidas:

```ts
const DIALOG = () => matchMedia('(max-width: 720px)').matches
  || (matchMedia('(pointer: coarse)').matches
    && matchMedia('(max-width: 900px), (max-height: 560px)').matches);
```

Con puntero grueso basta que **una** de las dos medidas sea pequeña. Se conserva
el corte por ancho a secas para una ventana de escritorio encogida, donde el
menú tampoco cabe. El CSS del diálogo no lleva media query —lo gobierna la clase
que pone el JS—, así que sigue al criterio sin poder discrepar de él.

**Validado en apaisado**: `mobile-08b-dialog-landscape.png`, con la prueba
midiendo que el diálogo cabe entero en los 390px de alto y que sus opciones
siguen midiendo ≥44px.

## 2. Los mensajes de una línea seguían mandando con Enter

La primera regla que escribí —«textarea: Enter salta; `<input>`: Enter manda»—
usaba la etiqueta HTML como criterio, y la etiqueta no es el criterio. Lo que
decide es **qué se está escribiendo**: si es un mensaje, Enter tiene que poder
saltar de línea, y da igual que quien lo pidió lo pusiera en un `<input>`.

Cuatro campos componían mensajes desde un `<input>` y ahora son `textarea` con
la misma regla que el resto:

| Dónde | Qué se escribe |
| --- | --- |
| `kinds/interrupt.ts` | la respuesta a una escalación |
| `kinds/ceo.ts` | la misma respuesta, desde el bloque de CAPCOM |
| `kinds/agent.ts` | la misma respuesta, desde la ventana del agente |
| `kinds/fleet.ts` | hablarle a un squad, a un proyecto o a una selección |

Sus placeholders pasan por `composerHint`, así que dicen el acorde en un teclado
y **no dicen nada** en un aparato sin él. Al SEND de la ventana de interrupción
se le retira el `data-key="enter"`, que era la tercera manera de decir lo mismo.

**Lo que sigue con Enter, y por qué.** La línea de comando, el filtro de un
selector, el terminal, el nombre de un preset de SFX y la URL de un disco no
componen mensajes: son campos de una línea donde Enter es «acepta esto», y
cambiarlo sería romper lo que el operador ya sabe. `SAY ALL` de la ventana de
flota conserva su acorde `A` de ventana —como `FRAME` o `STOP ALL`— porque sólo
dispara con el foco **fuera** de la caja: lo que se retiró es el atajo que
competía con escribir, no la tecla de la ventana.

## Archivos de esta corrección

| Fichero | Cambio |
| --- | --- |
| `src/ui/controls.ts` | El criterio del diálogo: puntero + cualquiera de las dos medidas |
| `src/ui/windows/kinds/interrupt.ts` | Respuesta a `textarea` + acorde; fuera el `data-key="enter"` del SEND |
| `src/ui/windows/kinds/ceo.ts` | Respuesta a `textarea` + acorde |
| `src/ui/windows/kinds/agent.ts` | Respuesta a `textarea` + acorde |
| `src/ui/windows/kinds/fleet.ts` | Caja de flota a `textarea` + acorde; se suelta al cerrar |
| `test/hud-mobile.shots.ts` | El diálogo en apaisado y los campos convertidos |

## Validación

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **892/892** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** (regresión de escritorio) |

Lo que se afirma nuevo: en 844×390 el selector abre como diálogo, cabe en el
alto y mantiene opciones de ≥44px · la caja de la flota es un `textarea`, Enter
deja `uno\ndos` y nada sale hacia la flota, y `SAY ALL` conserva su acorde de
ventana · la respuesta a una escalación abierta desde la cola es un `textarea`,
Enter salta de línea, no contesta, y su SEND ya no anuncia ninguna tecla.

Capturas: `test/shots/mobile-08b-dialog-landscape.png` y
`test/shots/mobile-06g-answer.png`.

## Lo que sigue sin cubrir

1. El acorde en las cuatro cajas convertidas se apoya en el mismo
   `bindComposer` que ya se prueba de punta a punta en la de misión; en éstas la
   prueba comprueba la conversión y que **Enter no manda**, que era el fallo.
   Disparar un envío real desde ellas dejaría rastro en la flota sintética.
2. Los demás usos de `pick` —spawn, launch, ajustes, SFX, modelos— heredan el
   diálogo del componente; la prueba abre el de CAPCOM en vertical y en
   apaisado, no los seis.

---

# Corrección — los controles se salían de la cabecera

`mission_mtsaa02eqa14rjii` · 2026-09-08 · Q8. Bug real del operador: «en mobile
los botones cerrar/minimizar no quedan contenidos en el título de la ventana».

## La causa, medida en el DOM

La invariante «la cabecera contiene sus botones» vivía en **dos reglas con dos
condiciones distintas**:

```css
@media (max-width: 720px) { .win__head { min-height: 52px } }   /* por ANCHO   */
@media (pointer: coarse)  { .win__btn  { min-height: 44px } }   /* por PUNTERO */
```

Un teléfono **girado** cumple la segunda y no la primera. Medido con Playwright
sobre la consola real, tres tamaños, contexto táctil:

| Viewport | Alto de `.win__head` | Alto del botón | Se sale por abajo |
| --- | --- | --- | --- |
| 390×844 | 52px | 44px | −4px (dentro) |
| **844×390** | **30px** | **44px** | **+14px** |
| 360×640 | 52px | 44px | −4px (dentro) |

14px de botón cayendo sobre el cuerpo de la ventana. Y `overflow` es `visible`,
así que no se recorta: se ve, se pulsa fuera de su sitio y ninguna medida de
altura lo delata. Mi prueba anterior sí comparaba cajas, pero **sólo en
vertical**, que era el único tamaño donde la primera regla se cumplía.

## El arreglo

Las dos medidas pasan al **mismo bloque**, el de puntero, que es donde vive la
decisión: si el botón mide 44 porque hay un dedo, la cabecera mide 52 por lo
mismo. Una invariante no puede vivir en dos reglas que se pueden cumplir por
separado.

```css
@media (pointer: coarse) {
  .win__head { min-height: 52px; padding-top: 4px; padding-bottom: 4px; align-items: center; }
  .win__ctl  { gap: 6px; flex: none; }
  .win__btn  { flex: none; min-width: 44px; min-height: 44px; }
}
```

52 = 44 del botón + 4 arriba + 4 abajo; el padding vertical es lo que garantiza
que el objetivo entre entero **con su borde** y sin recorte. `flex: none` en el
grupo y en cada botón: antes que perder milímetros de dedo se acorta el título,
que para eso lleva su elipsis. Nada se ha achicado ni escondido, y el
escritorio con ratón sigue en 36×32 con su hover.

Como es el chrome compartido de `wm.ts`, vale para **todas** las ventanas:
misión, CAPCOM, agente, terminal, artefacto, cola, flota, ajustes.

## La prueba, que ahora no puede dar un falso positivo

`chromeFits()` en `test/hud-mobile.shots.ts` abre **varias clases de ventana a
la vez** (CAPCOM, flota, cola y un agente) y de cada botón mide, contra la caja
de su cabecera y la del título:

- 44×44 reales;
- no sobresale por arriba (`over <= 0`) ni por abajo (`under <= 0`);
- no se sale por el borde izquierdo de la cabecera;
- **no solapa el rectángulo del título**.

Se corre en **390×844, 844×390 y 360×640**, y a 1440 con el mismo contexto
táctil, donde lo correcto es que sigan midiendo 44 —el criterio es el puntero, no
el ancho— y sigan dentro. El caso de **ratón fino** —36×32, y también contenido—
se mide en `test/hud-missions.shots.ts`, que corre sin táctil.

No hay ninguna aserción de altura suelta: todas comparan cajas, porque con
`overflow: visible` la altura de la cabecera es exactamente el número que no se
entera del problema.

## Archivos

| Fichero | Cambio |
| --- | --- |
| `src/ui/styles/window.css` | Cabecera y controles dimensionados en el mismo bloque de puntero; `flex: none` en el grupo y en los botones |
| `test/hud-mobile.shots.ts` | `chromeFits()` sobre varias ventanas, en los tres tamaños y a 1440 táctil; capturas de cabecera |
| `test/hud-missions.shots.ts` | El caso de ratón fino: contenido y a tamaño de ratón |

## Validación

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **932/932** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** |

Capturas de cabecera, recortadas a la caja de la cabecera:
`test/shots/mobile-06h-chrome.png` (390×844) y
`test/shots/mobile-08c-chrome-landscape.png` (844×390, el tamaño que estaba
roto: `PIN — ×` dentro de la banda ámbar, sin recorte y sin tocar el título).

---

# Corrección 2 — el cuerpo se pintaba sobre la barra de título

`mission_mtsaa02eqa14rjii` · 2026-09-08 · Q8. El operador: «se sigue viendo el
contenido de CAPCOM encima de la barra de título». Tenía razón, y mi cierre
anterior fue prematuro por una razón concreta que conviene dejar escrita.

## La causa exacta

`.win` es una rejilla de tres filas y la primera estaba **fija**:

```css
.win { display: grid; grid-template-rows: 30px 1fr 18px; }
```

La corrección anterior subió el `min-height` de `.win__head` a 52px. Eso hace
que la **cabecera** mida 52 — pero su **pista** seguía midiendo 30. La cabecera
desbordaba su fila 22px y la fila 2, el cuerpo, empezaba en 30 con fondo opaco:
se pintaba encima de esos 22px. Medido en la consola real, contexto táctil:

| Viewport | `grid-template-rows` | Cabecera | Cuerpo empieza | Solape | `elementFromPoint` en la banda baja |
| --- | --- | --- | --- | --- | --- |
| 390×844 | `30px 600px 18px` | y=46, 52px | y=76 | **22px** | `button.rail__c` |
| 844×390 | `30px 198px 18px` | y=44, 52px | y=74 | **22px** | `div.capcom__status` |

El hit-testing lo dice sin ambigüedad: en la parte baja de la barra de título
lo que había era la cinta de misiones de CAPCOM y la línea de estado del
agente, no la cabecera.

**Por qué mi prueba no lo vio.** Comprobaba que los botones caben dentro de la
cabecera, y era cierto: lo que no cabía era la cabecera dentro de su fila. Una
comparación de cajas entre padre e hijo nunca puede ver eso; hace falta
preguntar quién se pinta encima. La captura anterior tampoco lo enseñó porque
estaba **recortada a la cabecera**, y el recorte incluía el bloque que la
tapaba sin que se pudiera distinguir de ella.

## El arreglo

La fila de la rejilla se dimensiona **en el mismo bloque** que la cabecera y
que los botones, que es donde vive la decisión:

```css
@media (pointer: coarse) {
  .win { grid-template-rows: 52px 1fr 18px; }
  .win__head { min-height: 52px; padding-top: 4px; padding-bottom: 4px; }
  .win__btn { min-width: 44px; min-height: 44px; flex: none; }
}
```

Tres medidas, un sitio. Poner la fila en `auto` también habría valido, pero
movería el escritorio, donde 30px es la medida que pide el comp; el número
explícito deja el ratón exactamente como estaba. Ningún `z-index`, ningún
`overflow: hidden` y ningún texto escondido: el problema era geométrico y la
corrección es geométrica.

Medido después, en los dos tamaños: `rows: 52px …`, solape **0**, y
`elementFromPoint` en la banda baja devuelve `header.win__head`.

## La prueba que sí lo ve

`headerClear()` en `test/hud-mobile.shots.ts` pregunta al navegador **quién se
pinta** en la cabecera, en vez de comparar cajas: una malla de puntos sobre la
banda —las cuatro esquinas, el centro, y el centro de cada botón— y por cada
punto `document.elementFromPoint`. Si lo que devuelve está dentro de
`.win__body`, falla y dice dónde y qué era.

Se corre **con la lista al principio y a media altura**, porque un panel
`sticky` o un `transform` dentro del cuerpo puede subirse a la cabecera sólo
después de desplazar; sobre **CAPCOM, agente, cola y flota**, cada una **a
solas** —en móvil las ventanas van a pantalla completa y una captura con cuatro
abiertas enseña cuál está delante, no si el cuerpo pisa su cabecera—; y en
**390×844, 844×390, 360×640** y a 1440 con puntero grueso.

Además, `shootEachWindow()` fotografía **la ventana entera** de cada clase, sin
recortes, en vertical y en apaisado. Y los controles se ejercitan de verdad
sobre CAPCOM: plegar → bandeja → volver → cerrar.

## Archivos

| Fichero | Cambio |
| --- | --- |
| `src/ui/styles/window.css` | La fila de la rejilla, la cabecera y los botones dimensionados juntos bajo `(pointer: coarse)` |
| `test/hud-mobile.shots.ts` | `headerClear()` (hit-testing, con scroll), `shootEachWindow()` (ventana entera, cada clase a solas) y el ciclo plegar/restaurar/cerrar sobre CAPCOM |

## Validación

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **OK** |
| `npm test -- --changed` | **947/947** |
| `npx tsx test/hud-mobile.shots.ts` | **verde** |
| `npx tsx test/hud-missions.shots.ts` | **verde** |

## Evidencia visual, revisada una por una

Ventanas enteras, cada una a solas, en `test/shots/`:

- `mobile-06h-win-390-ceo.png`, `-agent.png`, `-fleet.png`, `-queue.png` (390×844)
- `mobile-08c-win-844-ceo.png`, `-agent.png`, `-fleet.png`, `-queue.png` (844×390)

En la de CAPCOM en apaisado se ve la cabecera limpia con su regla cian y la
cinta de misiones empezando **debajo**; en la del agente en vertical, la línea
`WORKING · claude · …` empieza debajo de la cabecera y `PIN — ×` están enteros
dentro de ella.

## Lo que aprendí, por si vuelve

Una invariante repartida en dos reglas con dos condiciones se rompe en cuanto
un tamaño cumple una sola. Ya pasó con «cabecera por ancho, botones por
puntero», y ha vuelto a pasar con «fila fija, cabecera por puntero». Las tres
medidas viven ahora en el mismo bloque, y la prueba que las vigila no compara
cajas: pregunta quién se pinta encima.
