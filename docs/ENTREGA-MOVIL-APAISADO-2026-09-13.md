# Entrega — Un teléfono girado es un teléfono, también para las ventanas

**Squad:** forge-tres-01 · dominio «móvil apaisado»
**Fecha:** 2026-09-13
**Rama:** `forge-tres-01` desde `7a61eed`, en su worktree. Sin push, sin merge.

Hoy por la mañana se arregló el mástil (`hud.css`, en `7a61eed`): en 844×390
envolvía hasta 239px y no dejaba baldosa que tocar. Esta entrega es lo que
quedó: las ventanas, la condición que nadie cumplía, y la pregunta de fondo.

---

## 1. Cuántos sitios preguntaban «¿estoy en un móvil?»

Se buscó toda `@media` y todo `matchMedia` de `src/ui`. Hay muchas
condiciones por tamaño, pero casi todas preguntan **otra cosa** —¿cabe la
sección flotando? (900/1180, `sections.ts` y `hud.css`), ¿cabe un desplegable?
(`controls.ts`), ¿hay sólo dedo? (`composer.ts`)— y no se tocan.

La pregunta «¿es un teléfono?» —la que decide que una ventana sea la pantalla,
que no se arrastre ni se capture al canvas, que el mástil sea una fila— se
contestaba en **tres sitios con tres cadenas distintas**:

| Sitio | Condición que tenía | Qué decidía |
| --- | --- | --- |
| `src/ui/windows/wm.ts` `MOBILE()` | `(max-width: 720px)` | arrastre, canvas, clamp, tether, minimizar |
| `src/ui/styles/window.css` (3 bloques) | `(max-width: 720px)`; `(max-width: 720px) and (max-height: 560px)`; `(pointer: coarse) and (max-width: 720px)` | ventana = pantalla; apaisado; misión con dedo |
| `src/ui/styles/hud.css` (2 bloques) | `(max-width: 720px), ((max-width: 1180px) and (max-height: 560px))` | mástil y marcadores, desde hoy |

Es decir: el CSS vestía la ventana de una manera y el `wm` la trataba de
otra en cuanto un tamaño cumplía una cadena y no otra. Exactamente la forma
del fallo que hoy se ha visto dos veces.

**La respuesta: son tres, y ahora la decisión vive en uno.** `src/ui/phone.ts`
tiene `PHONE_MQ` e `isPhone()`; el `wm` lo importa. Las hojas no pueden
importar una cadena en `@media`, así que la repiten literal y una prueba
afirma que siguen diciendo lo mismo (§4). No es un refactor: son tres líneas
en `wm.ts`, tres condiciones en `window.css`, un módulo de 40 líneas y una
suite.

Se descartó la otra forma de «un solo sitio» —que el TS ponga una clase en
`<body>` y las hojas usen `body.is-phone` en vez de `@media`—: reescribe los
cinco bloques, incluido el del mástil que se arregló esta mañana, sube la
especificidad de cada regla de teléfono y deja un frame sin vestir antes de
que arranque el módulo. Si se quiere, el sitio único ya existe y ese cambio
sería mecánico.

## 2. La condición que ningún teléfono de hoy cumplía

`window.css` tenía, para el apaisado:

```css
@media (max-width: 720px) and (max-height: 560px) { .win { top: 8px; … } }
```

Pretendía cubrir el teléfono girado: subir la ventana al sitio del mástil y
darle el alto que en 390px falta. Pero pide **el ancho de un teléfono de pie y
el alto de uno de lado a la vez**: 844×390 falla el ancho, 390×844 falla el
alto. Comprobado con `matchMedia` en la consola de verdad, en contexto de
iPhone:

| Viewport | `(max-width: 720px)` | `(max-width: 720px) and (max-height: 560px)` | `PHONE_MQ` |
| --- | --- | --- | --- |
| 844×390 | false | **false** | true |
| 926×428 | false | **false** | true |
| 390×844 | true | **false** | true |

La prueba de §4 me corrigió el titular: «ningún teléfono» era falso. Un
Android de 360 girado (640×360) o un 4,7" (667×375) sí entraban. Ninguno de
844 o más —todo iPhone desde el X, los Android grandes— entraba. La prueba
afirma exactamente eso y lo deja escrito.

Ahora ese bloque usa `(max-width: 1180px) and (max-height: 560px)`: la mitad
corta de `PHONE_MQ`, la misma que `hud.css` ya usaba para la hoja en apaisado.

## 3. Medido, antes y después

Mismo método que el mástil: la consola de verdad en Chromium, contexto de
iPhone, `elementFromPoint` sobre una malla de 40×20 y sobre el centro de cada
baldosa; y para la ventana, su caja, su cuerpo, su asa, y un arrastre de
puntero sobre la cabecera para ver si se mueve. Sin ventana abierta nada
cambia —el mástil era de hoy—: 844×390, 67% libre, mástil de 69px.

**844×390, CAPCOM abierta:**

| | Antes | Después |
| --- | --- | --- |
| Caja de la ventana | 500×178 en (282,112) | 844×264 en (0,8) |
| Pantalla que ocupa | 27% | 68% |
| Alto del cuerpo (lo que se lee) | 108px | 194px |
| Asa de redimensionar | visible | ninguna |
| Arrastre de 60px sobre la cabecera | se mueve 54px | 0px |
| Línea de comando, puerta de MISIONES, bandeja | tocables | tocables |
| Mástil | tocable | bajo la ventana (a propósito, §2) |

La ventana de agente y la de flota dan las mismas cifras: 640×178 y 380×178
antes, 844×264 las dos después. En 926×428 el cuerpo pasa de 146 a 232px. En
390×844 nada cambia: 390×648, cuerpo 578px, igual antes y después.

Las capturas están en `test/shots/mobile-08c-win-844-*.png` (después) y las
del script de medida en el informe al líder.

## 4. La prueba que vigila que sigan diciendo lo mismo

`test/phone-media.test.ts` (19 casos):

- `PHONE_MQ` es verdad en ocho teléfonos de referencia, de pie y de lado, y
  falso en siete tamaños que no lo son, incluidos los bordes (1181×560,
  721×561).
- La condición de lado es un subconjunto de la entera.
- La condición vieja no describe ningún teléfono de 844 o más girado.
- **Cada `@media` de `hud.css` y `window.css` que hable de teléfono tiene la
  misma tabla de verdad que `phone.ts`** —o su forma con `(pointer: coarse)`
  delante—, evaluada sobre una malla de 61×41 tamaños. No compara cadenas: dos
  condiciones pueden decir lo mismo en otro orden.

Comprobado por mutación: con `window.css` devuelto a `(max-width: 720px) and
(max-height: 560px)` la suite marca ese bloque y falla; restaurada, 19/19.

Limitación, dicha: `npm test -- --changed` sigue imports de `.ts`, así que
tocar sólo una hoja CSS no selecciona esta suite (aparece como «sin suite que
los cubra»). Tocar `phone.ts` sí. `npm test -- phone` la corre por nombre.

## 5. Lo que queda fuera, dicho

- **`secbar__b--missions` no existe en 926×428.** La puerta de MISIONES sale
  sólo bajo 900px de ancho, y un iPhone Pro Max girado mide 926. Es la
  pregunta «¿cabe la sección flotando?», no «¿es un teléfono?», y a 926 el
  panel flota y cabe; no es de este brief, pero se vio al medir.
- **`touchDialog` en `controls.ts`** tiene su propio criterio (dedo y
  cualquiera de las dos medidas pequeña, o ancho ≤720 a secas). Contesta
  «¿cabe un desplegable?», no «¿es un teléfono?»; no se ha unificado.
- **El ANTES visual con ventana** lo produjo el script de medida, no un shot.

## 6. Ficheros

- `src/ui/phone.ts` — nuevo: el sitio único.
- `src/ui/windows/wm.ts` — `MOBILE()` → `isPhone()` de `phone.ts`.
- `src/ui/styles/window.css` — tres condiciones, con el porqué de cada una.
- `src/ui/styles/hud.css` — el comentario del mástil apunta a `phone.ts`.
- `test/phone-media.test.ts` — nuevo: el guardián.
- `test/hud-mobile.shots.ts` — en 844×390 afirma que la ventana es la pantalla,
  sin asa, y que la cabecera no arrastra.
- `docs/MISSIONS.md` — «En un teléfono» enlaza aquí.

## 7. Filtros que cubren este documento

```
npm run typecheck                                 OK
npm test -- --changed                             1020/1020 (79 suites; hud.css, window.css y el shot sin suite unitaria que los cubra)
npm test -- phone                                 19/19, y rojo por mutación
npm run shots -- hud-mobile file-viewer tether    tres rondas: ver §8
```

## 8. Shots, tres rondas

(pendiente de completar al terminar la corrida)
