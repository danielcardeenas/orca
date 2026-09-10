# El handshake que no termina

Con un token que el hub no acepta, la consola celebraba.

El socket abría —abrir un socket no requiere permiso—, la consola daba el
enlace por bueno ahí mismo, mandaba el `hello`, y el hub cerraba. Reintento,
socket abierto, «LINK UP» otra vez: el destello lima de pantalla entera que la
consola reserva para una flota que sube, y su sonido, cada pocos segundos y
para siempre. El operador veía la consola alegrándose sin parar mientras
miraba un mundo congelado, y en ningún sitio decía «tu token no vale».

Dos arreglos, uno debajo del otro.

## El enlace se declara cuando el hub contesta

`store.setLink(true)` estaba en `ws.onopen`, que es antes de que nadie te haya
dicho quién eres. Ahora está en `handle()`: la primera trama que llega del hub
es la prueba de que hay enlace **y** de que el token valía, porque no hay
ninguna otra forma de recibir una. Un socket abierto que se cierra en seguida
ya no es un enlace, así que no hay destello, no hay sonido y no hay ciclo.

El mismo sitio pone `setAuth(true)`. El cierre con `CLOSE_UNAUTHORIZED` pone
`setAuth(false)`. Los códigos de cierre viven ahora en `shared/protocol.ts` —
los acuerdan hub y consola, y la consola no puede importar nada del hub;
`hub/auth.ts` los reexporta para quien ya se los pedía a él.

Un enlace caído y un token rechazado son dos condiciones distintas y se miran
distinto: la red vuelve sola y el mundo que ya estaba en pantalla sigue siendo
la última verdad conocida, mientras que un token no se arregla esperando.

## La pantalla

Con el token rechazado, la consola se retira detrás del beat de handshake del
arranque: el mismo rótulo, los mismos ocho bloques, las mismas clases
(`ui/handshake.ts`, escena `pass` de `boot.ts`). Con la diferencia que es el
mensaje entero: **no completa**. En el arranque los ocho bloques dan paso al
barrido lima que dice «aceptado»; aquí se apagan y vuelven a empezar. Un
handshake que no cierra es exactamente lo que está pasando.

- **Sin texto de error y sin campo.** No es una pantalla de login: nada de lo
  que se escriba ahí arregla esto —el token vive en el disco del hub y en el
  `localStorage` de la consola— y una casilla prometería una salida que no
  existe. Tampoco se dice qué falló: quien mira una consola ajena no tiene por
  qué enterarse de cómo se autentica ésta.
- **No se escribe detrás.** El panel cubre la pantalla y se come el ratón; el
  teclado lo para un listener en captura sobre `window`, que corre antes que
  los atajos de `main.ts`. Sin esto quedarían órdenes escribiéndose contra un
  enlace que no existe.
- **Se va sola.** El cliente reintenta con backoff; en cuanto el hub conteste
  una trama, la pantalla se retira sin ceremonia.

## Verificación

```sh
npm run typecheck
npm test -- --changed
```

Sin suite que lo cubra, y se dice: el comportamiento vive en el DOM, en gsap y
en un `WebSocket` real, y las pruebas de este repo son node puro. Se comprobó a
mano contra un hub estricto (`ORCA_STRICT_AUTH=1`) con Playwright, los cuatro
caminos:

- token inválido → la pantalla aparece y cicla (8 bloques encendidos, apagado,
  vuelta a empezar);
- doce segundos con ese token → **cero** destellos lima (`[data-alarm-flash]`
  se muestreó a 10 Hz y nunca subió de 0); antes había uno por reintento;
- una tecla con la pantalla puesta → no llega a `window` y no abre nada;
- el hub reiniciado aceptando ese token → la pantalla se retira sola y la
  consola vuelve.
