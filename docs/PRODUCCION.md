# ORCA en producción

Correr siempre el build optimizado, y que publicar mejoras no toque lo que hay
en pie hasta que el operador lo decida.

## El día a día

```
npm run publish     comprueba tipos, construye la consola y barre lo que sobra
npm run prod        hub + collector, sin watch, sirviendo esa consola
```

`prod` levanta los dos bajo un supervisor, que es lo que permite reiniciarlos
después desde la propia consola (más abajo).

La consola sale por el puerto del hub —4479, o la url https que `tailscale
serve` publica en la tailnet— y no hay un segundo proceso que mantener: Vite
deja de estar en la ecuación. El hub sirve `dist/` con tres políticas de caché
(`serveStatic` en `src/hub/server.ts`): `index.html` en `no-store`, los
`/assets/*` con hash e `immutable` un año, y lo de nombre fijo —manifest,
iconos, fuentes, sfx— revalidado con `Last-Modified`, que es un 304 sin cuerpo.

Y con eso llega lo que en desarrollo no hay: bundle minificado, service worker,
arranque sin red y la consola instalable en el teléfono (`docs/PWA.md`).

## Publicar no recarga a nadie

`npm run publish` (`tools/publish.mjs`) hace tres cosas en este orden:

1. **`tsc --noEmit`.** Vite no comprueba tipos: sin esta puerta, publicar es
   publicar a ciegas. Si falla, no se toca nada y sigue en pie el build de
   antes.
2. **`vite build`, que NO vacía `dist/`.** Es lo que permite construir sobre una
   consola que alguien está mirando. Con el vaciado por defecto, durante los
   segundos del build la página viva pierde fuentes, sonidos, `/sw.js` y el
   index —y si el build falla, los pierde para siempre—. Sin vaciado el build
   es aditivo: los `/assets/*` nuevos llevan hash y conviven con los de la
   generación anterior, y el índice, que es lo único con nombre fijo que decide
   qué build es, se reescribe al final. Un build roto no llega a tocarlo.
3. **El barrido.** Se conservan dos generaciones: la que el índice servía antes
   y la nueva. La primera es la que tiene cargada la pestaña que aún no ha
   recargado; ya no va a pedir su bundle —lo tiene— pero sí su sourcemap si
   alguien abre las herramientas. Lo anterior a esas dos no lo puede pedir
   nadie, y se borra. Sin barrido, `dist/assets` crecería sin fin: por eso
   `npx vite build` a pelo funciona pero deja basura.

De ahí en adelante manda la doctrina de siempre: la consola no cambia bajo la
mano del operador. El conjunto de `/assets/*` del índice **es** el build id; la
página recuerda el suyo al cargar y lo compara cada minuto, al volver la
pestaña al frente y al recuperar el enlace con el hub. Cuando difiere se
enciende `UPDATE AVAILABLE · CLICK TO RELOAD`, y el clic es la recarga
(`src/ui/hud/update.ts`). El service worker sigue la misma regla: el worker
nuevo espera en `waiting` hasta ese clic, sin `skipWaiting` (`public/sw.js`).

## Publicar solo, cuando el trabajo termina

Un paso manual entre «el agente terminó» y «el operador puede verlo» es un paso
que no se da: el trabajo se queda en el disco, hecho y sin llegar. Por eso el
hub publica él mismo (`src/hub/publisher.ts`) en dos momentos:

- **Un agente que trabajaba sobre el repo de ORCA pasa a `done`.** Sólo `done`
  —un agente muerto no terminó nada—, sólo trabajadores —el fin de un CAPCOM es
  el fin de una sesión de mando, no de una tanda— y sólo el repo propio.
- **Una rama aterriza en el repo de ORCA** (`land_work`, en `src/agents/tools.ts`).

Nada de eso recarga nada. Publicar produce el build; la píldora lo ofrece; el
clic sigue siendo del operador. Automático hasta la oferta, nunca más allá.

Tres cosas hacen que no moleste:

**Sólo el repo propio.** ORCA gobierna muchos proyectos y publicar sólo tiene
sentido para el suyo. La comparación es de rutas resueltas contra el árbol desde
el que corre el proceso, no por el nombre del proyecto: uno puede llamarse
`orca` sin serlo, y el de verdad puede estar detrás de un enlace simbólico. Un
worker en un worktree cuenta, porque su proyecto sigue siendo éste.

**Se espera y se agrupa.** Un escuadrón termina en racimo. La primera petición
abre una ventana de 30 s y lo que llegue dentro viaja con ella. Y nunca hay dos
builds a la vez: lo que se pida mientras se construye se apunta y se hace una
sola vez al acabar, porque dos builds sobre el mismo `dist/` son justo la
carrera que `emptyOutDir: false` evita.

**Un fallo no se repite.** El árbol es compartido y está sucio a propósito: el
typecheck se pone rojo a menudo, y por trabajo de otro. Cuando eso pasa no se
toca nada —la consola en pie sigue con su build bueno— y se avisa a CAPCOM, que
es quien puede arreglarlo; al operador no se le interrumpe, sólo ve la píldora
cuando hay algo que de verdad se puede aplicar. Y el mismo error no se cuenta
dos veces: avisar en cada intento convierte el aviso en ruido y el ruido en
silencio.

`ORCA_AUTOPUBLISH=0` lo apaga y deja el publish manual de siempre. Un hub de
pruebas no construye nunca.

## La asimetría, dicha en voz alta

**Recargar actualiza la consola y nada más.** El hub y el collector cargan su
código al arrancar y no lo vuelven a mirar, así que después de publicar puede
quedar un bundle nuevo hablando con un proceso viejo — y el síntoma de eso (un
comando que no hace nada, un campo que llega vacío) no se parece a la causa.

Por eso el hub se vigila a sí mismo (`src/hub/source-rev.ts`): toma la revisión
de su código al arrancar, la vuelve a tomar cada 30 s y, si cambió, se lo dice a
las consolas con el frame `server` (`src/shared/protocol.ts`). Ahí se enciende
una segunda píldora, `SERVER CODE CHANGED · RESTART ORCA`, con un texto
distinto porque la acción es distinta: ésta no se arregla con un clic, se
arregla reiniciando ORCA.

### El clic que reinicia

Esa píldora es un botón cuando puede serlo. `npm run prod` pone
`tools/supervise.mjs` delante del hub y del collector, y un proceso supervisado
sabe pedirse el relevo: sale con el código 75 (`EX_TEMPFAIL`, «vuelve a
intentarlo») y el supervisor lo relanza en la misma terminal, con los mismos
logs y el mismo árbol de procesos. El contrato entero son dos piezas —una marca
en el entorno y un código de salida— y vive en `src/shared/restart.ts`.

Lo que pasa al pulsar: el hub avisa a los collectors, les da medio segundo para
que el frame salga por el cable, se apaga limpio y sale con 75. Cada collector
decide por su cuenta —sin supervisor detrás lo ignora, porque un collector que
se apaga y no vuelve deja su máquina fuera de la flota— y los agentes no se
tocan: viven en tmux, no dentro de estos procesos, y siguen trabajando mientras
los procesos vuelven.

No hay ack, porque quien tendría que mandarlo es justo lo que se está muriendo.
La confirmación es el enlace: cae, vuelve, y ahí la consola se recarga sola.
Recargar ahí no rompe la doctrina, la cumple — el clic ES la autorización, y
dejar la consola vieja hablando con el hub nuevo sería la única forma de que
ese clic acabara peor de lo que empezó. Si el enlace ni se inmuta en 15 s, no
pasó nada y el botón vuelve.

Sin supervisor —`npm start`, o el hub lanzado a mano— el frame `server` llega
con `restartable: false`, la píldora se queda en el cartel de siempre y dice
qué teclear. Ofrecer un botón que no puede funcionar es peor que no ofrecerlo:
el operador cree que ya está hecho.

Y un freno: un proceso que pide relevo tres veces sin llegar a vivir cinco
segundos para el ciclo. Eso es un árbol roto reiniciándose contra código que no
compila, y lo útil entonces es ver el error, no otro intento.

Qué cuenta como código del servidor: todo `src/**/*.ts` menos `src/ui/`, que ya
tiene su propia señal. `src/shared/` cuenta aunque lo comparta la consola —
puede mover el protocolo, y equivocarse hacia «avisa de más» cuesta un vistazo.
No se leen contenidos: ruta, tamaño y mtime bastan.

En desarrollo esto no se enciende nunca, y no por un `if`: bajo `tsx watch` el
proceso se reinicia al guardar, así que su revisión de arranque vuelve a ser la
del disco antes de que a nadie le dé tiempo a mirar.

El aviso llega por las dos puertas de entrada de una consola: la del token en
la query, que es la del navegador, y la del `hello`, que es la de todo lo demás.
Cablearlo en una sola es un fallo que las pruebas por WebSocket no ven — entran
por la del `hello` — mientras la consola de verdad no se entera de nada.

## Qué sigue en desarrollo

`npm run dev` no cambia: Vite en 4478, hub y collector bajo `tsx watch`, y el
aviso de actualización instantáneo por el WebSocket del dev server. Lo que
cambia es que ya no hace falta trabajar así para tener ORCA en pie.

## Pruebas

```
npm test -- source-rev publish publisher restart serve update
```
