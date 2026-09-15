# Acceso remoto

ORCA se alcanza desde otro dispositivo por **Tailscale**, no por un túnel
público. Este documento dice por qué esa elección, qué cambió en el hub para
soportarla y cómo se abre la consola desde un móvil.

## Por qué Tailscale y no un túnel

La arquitectura invita al túnel: los collectors marcan hacia fuera y sólo el hub
necesita un puerto, así que un `cloudflared` delante de `localhost:4479` bastaría
para tener dominio y TLS sin abrir el router. El problema es lo que le hace al
modelo de autenticación.

El hub tiene una puerta trasera deliberada: sin `ORCA_TOKEN` configurado, acepta
conexiones de loopback sin credencial, porque en una máquina de desarrollo
«viene de 127.0.0.1» significa «lo escribió el dueño». Un proxy en la misma
máquina rompe esa equivalencia: `cloudflared` conecta al hub desde 127.0.0.1, de
modo que **todo internet llega como local**. Sin más defensas, poner un túnel
delante publica `/mcp` —lanzar agentes, mandarles mensajes, matarlos— y
`/api/file` —los repos, el scratchpad, `~/.orca`— sin un solo error en el log.

Tailscale no tiene ese problema, y no por suerte: las conexiones llegan desde
`100.x.x.x`, `isLoopback()` devuelve false y el hub exige token él solo. La
diferencia que importa no es cuánto protege cada opción bien configurada, sino
qué pasa cuando algo se olvida. Con la tailnet, un despiste no abre nada; con el
túnel, un despiste lo abre todo.

## Lo que cambió en el hub

1. **La puerta local sólo existe si la puerta es local.** `createAuth()` recibe
   la interfaz de escucha y `allowLoopbackAnonymous` exige, además de no tener
   `ORCA_TOKEN` ni `ORCA_STRICT_AUTH`, que el hub escuche sólo en loopback.
   Escuchando en `0.0.0.0` se pide token a todo el mundo, también a localhost.
   Sin dato de host se asume expuesto: quien no dice dónde escucha no puede
   pedir que se le suponga a salvo.

2. **Una cabecera de proxy quita el pase de local.** `remoteOf()` mira
   `cf-connecting-ip`, `x-real-ip` y `x-forwarded-for`. Si viene alguna, el otro
   extremo del socket es un intermediario y no el cliente: con
   `ORCA_TRUST_PROXY=1` el hub cree la dirección que declara, y sin ella la
   petición deja de contar como local. Así, montar un túnel delante sin
   configurarlo falla cerrado en vez de abrirse en silencio.

3. **`/api/world`, `/api/traffic` y `/api/memory` piden token.** Eran públicos.
   `traffic` es el contenido literal de lo que se dicen los agentes y `memory`
   lo que el CEO ha ido guardando.

4. **`/api/health` sin token responde la postura y nada más**: `ok`, `protocol`,
   `harness`, `capcom` y el recuento de máquinas. Es lo que `hubPosture()` lee
   para negarse a tocar un hub real —la protección que impide que el arnés
   visual tumbe un CAPCOM de verdad—, así que tiene que salir sin credencial.
   Lo que ya no sale sin token son hostnames, ids de máquina, proyectos y costes.

5. **El collector encuentra el token solo.** Mandaba `ORCA_TOKEN ?? ''` y vivía
   de la puerta anónima; ahora usa `sharedToken()` (`src/shared/token.ts`), que
   cae a `~/.orca/token` igual que ya hacían `bin/orca.mjs` y `bin/orca-recover.mjs`.
   Sin esto, cerrar la puerta dejaba a la flota fuera de su propia máquina: viva
   en tmux, invisible en la consola.

## Abrir la consola desde otro dispositivo

El hub escucha en `0.0.0.0` y sirve `dist/`, así que la consola construida se
alcanza desde la tailnet sin configurar nada:

```
http://<mac>.<tailnet>.ts.net:4479/?k=$(cat ~/.orca/token)
```

El `?k=` sólo hace falta la primera vez: la consola lo guarda en `localStorage`.

Vite es otra cosa. Se queda en `127.0.0.1:4478` a propósito, y por eso desde el
móvil no hay nada en ese puerto. Para mirar la consola **en desarrollo** desde
otro dispositivo:

```
ORCA_UI_HOST=100.x.y.z npm run dev:ui     # sólo la tailnet
ORCA_UI_HOST=0.0.0.0       npm run dev:ui     # también el wifi del bar
```

Vite no se reinicia al cambiar `vite.config.ts`: hay que relanzar `dev:ui`.
`allowedHosts: ['.ts.net']` está puesto para que los nombres de MagicDNS no
choquen con la protección de DNS rebinding, que devuelve una página en blanco y
explica el motivo sólo en el terminal.

## Si algún día hace falta un túnel

Para abrir la consola en una máquina ajena —sin cliente de Tailscale— la opción
es Cloudflare Tunnel **con Access delante**, nunca a secas: Access autentica
antes de que la petición llegue al hub. Y con el túnel hay que decidir sobre
`ORCA_TRUST_PROXY=1`: sin ella toda petición proxiada exige token, que es lo
correcto; con ella el hub cree la IP declarada, y entonces la única defensa es
que nadie más pueda hablar con ese puerto.

## Pruebas

```
npm test -- remote-access hub files
```

`test/remote-access.test.ts` cubre la puerta según la interfaz de escucha, el
fallo cerrado cuando no se declara host, que una IP de tailnet no cuenta como
local y —levantando un hub con la puerta abierta— que una cabecera de proxy
convierte un 200 en un 401. `test/hub.test.ts` cubre que `/api/world`,
`/api/traffic` y `/api/memory` responden 401 sin token y que `/api/health` sin
token conserva `harness` y `capcom` sin publicar la flota.
