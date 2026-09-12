# Archivar desde el panel, leer el título entero, y que abrir sea un gesto

**2026-09-12 · misión `mission_mty0il7zhqeqiuht`.** Tres arreglos pedidos por el
operador en los paneles MISSIONS y SELF-IMPROVEMENT de la consola: qué se
cambió, qué había que mirar antes, y qué mirar en la consola para confirmarlo.

---

## 1 · Archivar una misión desde su fila

`src/ui/hud/mission-status.ts`, `src/ui/hud/missions.ts`,
`src/ui/styles/hud.css`, `src/ui/windows/kinds/mission.ts` · commit `7886ccd`.

ARCHIVE sólo existía dentro de la ventana de la misión, así que retirar una
conversación de la consola costaba abrirla primero. La fila abierta ya tenía su
barra de acciones —MISSION, CONVERSATION, CREW—; ahora lleva ARCHIVE al lado,
sobre el mismo `archiveMission` del cliente (`mission:archive`). No hizo falta
nada nuevo en el hub.

**ARCHIVE no crece con las tres y va apagado hasta que se le apunta.** Las tres
son puertas y ésta es lo contrario: retirar la misión. Darle el mismo ancho y el
mismo verde la habría leído como una cuarta manera de entrar. En una fila ámbar
—WAITING ON YOU, NOT MOVING— tampoco se tiñe: el ámbar es de las puertas.

**La pregunta pasa a `missionArchiveAsk` y la leen los dos sitios.** Una misión
viva pregunta antes de archivarse, con su nombre; una terminada no pregunta
nada. Dos redacciones de la misma pregunta son dos promesas distintas sobre lo
que pasa al aceptar, y el operador sólo lee una de las dos.

La fila desaparece sola: el hub devuelve la misión archivada, el store la
guarda y `visibleMissions` deja de darla. No hay que recargar la consola.

---

## 2 · El título completo, donde no se leía

`src/ui/util.ts`, `src/ui/hud/improve.ts`, `src/ui/hud/missions.ts`,
`src/ui/styles/improve.css`, `src/ui/styles/window.css`,
`src/ui/windows/kinds/mission.ts` · commit `5e0c3d6`.

**El reconocimiento venía con un anclaje invertido y conviene dejarlo escrito.**
En `MissionRow`, `headline` es el título ENTERO (`missionHeadline`) y `title` es
el recortado a cuarenta (`missionTitle`). O sea que `.missions__full` ya
imprimía el título completo al expandir: el panel de misiones no tenía ese
problema. Lo tenían los otros dos sitios.

**SELF-IMPROVEMENT.** El título entero sólo vivía en el `title=` de la fila, o
sea en un tooltip: no se puede tabular, no se puede tocar en un teléfono y se va
mientras lo lees. Ahora abre el detalle, entero y envuelto en las líneas que
haga falta, con el vestido del titular para que se reconozca como la misma frase
que la fila enseñaba a medias.

**La ventana de la misión: dentro del cuerpo, no en la barra.** `.win__title`
corta con puntos suspensivos y no puede dejar de hacerlo — esa barra es la de
TODAS las ventanas, con un alto fijo, el distintivo, la clase y los tres
botones. Dejarla envolver cambiaría el cromado de cada ventana de la consola y
movería el borde superior del cuerpo mientras se arrastra o se redimensiona. La
cabecera `mission-win__head` ya envuelve (`flex-wrap: wrap`), así que la frase
entera va ahí y no toca el marco. No hay ventana propia de propuesta: una
propuesta se lee en el panel o, una vez implementada, en la ventana de su
misión, que es la que acaba de arreglarse.

**El criterio de no repetirse pasa a `besidesTitle` y lo comparten los dos
paneles.** Un detalle que se abre para leer el título entero y debajo repite la
misma frase no ha dicho nada dos veces: ha dicho una vez y ha gastado el sitio
de la otra. Pasa de verdad — una misión toma su nombre de la primera línea del
operador, y una propuesta cuyo resumen cabía en el titular lo repite. La
comparación ignora lo que no distingue dos frases: espacios de más, mayúsculas
y el punto final.

---

## 3 · Abrir y cerrar es un gesto

`src/ui/gfx/algn.ts`, `src/ui/hud/improve.ts`, `src/ui/hud/missions.ts`,
`src/ui/styles/hud.css`, `src/ui/styles/improve.css` · commit `ea9430a`;
la espera de la foto, `08d27ba`.

En misiones el detalle era `[hidden]` con `display: none`, que no se anima. En
AUTOMEJORA era peor: no existía en el DOM hasta abrirlo, y **lo que no está no
se puede descubrir con un gesto ni recoger con otro**.

`algnDisclose` es la persiana de `algnFold` a escala de una fila: lo que se
mueve es el ALTO de la caja, que es lo que empuja a lo que hay debajo en vez de
aparecer encima. Nada se desliza dentro; el contenido está donde va a estar
desde el primer fotograma y lo único que cambia es cuánto se ve de él. Cerrar va
más rápido que abrir: al abrir se pide leer, al cerrar se pide que desaparezca.

**Dos cajas por detalle y no una.** Con el margen, el relleno y la línea en la
caja que anima, a alto cero seguían midiendo doce píxeles y el cierre no
terminaba nunca. Y el `overflow: hidden` es fijo y no del gesto: puesto y
quitado en cada extremo, el margen de la caja de dentro se colapsa fuera de la
de fuera y la fila da un salto justo al acabar de abrirse.

**Sólo el clic anima.** Las dos listas se repintan con cada empujón del hub y
cada pocos segundos por los «2M». Una fila abierta que se abriera otra vez en
cada pasada sería el panel latiendo delante de quien lo está leyendo, y una que
ya estaba abierta al montar entraría dando un respingo. Manda además la
intención y no el DOM: durante el cierre el detalle todavía se ve, y un segundo
clic ahí es «vuelve a abrirlo».

**AUTOMEJORA deja de rehacer la lista entera en cada pintado.** Reconcilia por
id, como el panel de misiones. Una ficha ya no es algo que se pueda tirar y
volver a construir: tiene un gesto a medias, el foco dentro y el borrador de una
respuesta sin enviar. Lo que sólo cambia con el reloj se escribe aparte
(`tagsText`) y queda fuera de la firma (`cardSig`), o el tic de los treinta
segundos rehría la ficha igual y se llevaría por delante lo mismo. De regalo, un
borrador de respuesta a medias ya sobrevive al repintado.

Con `prefers-reduced-motion` no hay gesto: el detalle aparece o desaparece. Se
quita el movimiento, nunca lo que dice.

### Medido en el navegador

Con una misión y una propuesta de título largo, sonda propia contra la consola
de verdad:

```
normal      misiones   123px → 0 → 123   17 alturas intermedias cerrando, 24 abriendo
            automejora 227px → 0 → 227   18 cerrando, 25 abriendo
reducido    las mismas alturas finales, 0 intermedias en los dos
repintado   0 de 10 repintados seguidos movieron un detalle abierto
```

Al acabar no queda `style` en la caja: el alto vuelve a ser el del CSS, así que
un detalle que crezca mañana —una tripulación más, una respuesta más— no se
recorta contra la medida de hoy.

---

## Qué mirar en la consola para confirmarlo

1. **MISSIONS**, abrir una fila con `▸`. Se despliega creciendo, no de golpe.
   Dentro: el título entero envuelto, el encargo debajo sólo si dice otra cosa,
   la tripulación, y MISSION · CONVERSATION · CREW · ARCHIVE.
2. **ARCHIVE en una misión activa** pregunta con su nombre; al aceptar la fila
   se va sin recargar. En una terminada no pregunta. Es el mismo texto que el
   ARCHIVE de la ventana.
3. **Cerrar la fila con `▸`** se recoge; el detalle no desaparece de golpe.
4. **Dejar una fila abierta un minuto.** Los «2M» avanzan y la fila no se mueve
   ni parpadea: el repintado no anima.
5. **SELF-IMPROVEMENT**, abrir una propuesta de título largo. El titular entero
   arriba del detalle, envuelto, y el resumen debajo sólo si dice otra cosa.
   Abre y cierra con el mismo gesto.
6. **Escribir media respuesta en una propuesta y esperar treinta segundos.**
   Sigue escrita.
7. **Abrir una misión de título largo.** La frase entera se lee en la cabecera
   del cuerpo; la barra de la ventana sigue cortando, a propósito.
8. **Con «reducir movimiento» del sistema activado**, todo lo anterior sigue
   diciendo lo mismo y nada se mueve.

**Hace falta un relevo de la consola para que entre.** Nada de esto es estado
del hub: es la consola, y la consola que el operador tiene delante corre el
paquete de antes.

---

## Lo que no se tocó

`src/collector/model-control.ts`, `src/collector/capcom-reset.ts`, la regla de
`ceilingTokens` en `src/shared/tokens.ts`, y nada de lo que ST cambió sobre
dinero. Se commiteó pieza por pieza con `git commit --only -- <rutas>`, sin
`-A`: ST trabajaba en `main` al mismo tiempo y sus ficheros nunca entraron en
estos commits.

Un aviso: `test/hud-improve.shots.ts` falla en `y las filas entran en el compás
(0 filas)`. Se comprobó con `git stash`: **falla igual en `HEAD` sin estos
cambios**. Es previo y no se abordó aquí.

## Filtros que cubren esto

```
npm test -- hud-disclose       el detalle en los dos paneles: que exista
                               siempre, que sólo el clic lo anime y que el
                               gesto devuelva la caja como la dejó el CSS
npm test -- mission-status     missionArchiveAsk: una viva pregunta con su
                               nombre, una terminada no pregunta
npm test -- tiles              besidesTitle: la segunda línea sólo cuando de
                               verdad dice otra cosa
npm test -- improve-panel      cardSig y tagsText: el tic de los «2M» no
                               rehace una ficha
npm test -- missions           el archivo sobre el cable y la reversibilidad
npx tsx test/hud-missions.shots.ts    el panel contra la consola de verdad
```

La suite completa se corrió al cerrar la entrega: **1338/1338**, con
`npm run typecheck` limpio sobre el `HEAD` combinado con ST.
