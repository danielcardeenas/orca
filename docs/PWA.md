# ORCA instalable — la consola como app en el teléfono

**Fecha:** 2026-09-08
**Estado:** implementado y verificado (§6). Falta un paso de despliegue que es
del operador, no del código: servir el hub por https (§3).

---

## 1. Por qué no se podía instalar

El manifest, los iconos y los metas de standalone llevaban puestos desde el
principio, y el hub ya servía `manifest.webmanifest` con su tipo correcto y una
política de caché pensada para instalaciones (`src/hub/server.ts`). Faltaban
dos cosas, y ninguna era el manifest:

**No había service worker.** Faltaba el arranque sin red y el receptor de
notificaciones. Corrección al diagnóstico original: Chrome permite instalar
desde el menú sin un worker con `fetch` desde Chrome 108 móvil y 112 escritorio;
no es correcto atribuir sólo a esa ausencia que aparezca un acceso directo.
[Fuente: Chrome](https://developer.chrome.com/blog/update-install-criteria).

**No había contexto seguro.** El hub escucha en `http://0.0.0.0:4479`
(`src/hub/server.ts`), así que desde el móvil se entra por la IP de la tailnet
o de la LAN. Eso no es `https` ni `localhost`, y fuera de contexto seguro
`navigator.serviceWorker` **no existe**: no es que el worker falle, es que la
API no está. De las dos, ésta es la que manda — sin ella lo primero da igual.

## 2. Qué hay ahora

### `public/sw.js` — el worker

JavaScript plano en `public/`, sin paso de build. Cuatro estrategias y la
decisión de cuál toca vive en una función pura, `policy(pathname)`:

| Ruta | Estrategia | Por qué |
|---|---|---|
| `/api`, `/ws`, `/mcp` | **nunca se toca** | Una consola de tiempo real que sirve un mundo de hace cinco minutos desde una caché es peor que una consola caída: parece que funciona. |
| `/assets/*` | caché primero, para siempre | Llevan hash en el nombre. Son inmutables por construcción. |
| `/`, `/index.html`, toda navegación | **red primero**, caché si no hay red | El index es lo que apunta a los assets con hash: *es* el build. Servirlo de caché dejaría la consola pegada a una versión vieja, y le mentiría al centinela de `hud/update.ts`, que lo lee para saber si hay build nuevo. |
| fuentes, iconos, manifest, sfx, recovery | caché y revalidar por detrás | Nombre fijo, cambian poco, y el arranque no debe esperarlos. |
| cualquier otra cosa | a la red, sin guardar | El hub contesta el index a toda ruta desconocida (SPA); cachear por su url guardaría el mismo html bajo veinte claves. |

Tres detalles que no son obvios y por eso están probados:

- **El index vive bajo una sola clave, `/`.** El centinela lo pide como
  `/?update=…` cada minuto y una navegación puede llegar por cualquier ruta;
  son el mismo documento y comparten entrada.
- **El precache lee el index.** En `install` se guarda el casco (html, fuentes,
  iconos, recovery) y además los `/assets/*` **que el index servido nombra**, en
  vez de una lista de hashes que habría que regenerar en cada build — una lista
  así se desactualiza el día que alguien construye sin acordarse. Sin ese paso,
  el primer arranque sin red tendría el html en caché y su javascript no.
- **Un 502 no gana al casco guardado.** Es el caso más frecuente, no un borde:
  `tailscale serve` sobrevive a ORCA porque vive en tailscaled, así que con el
  portátil dormido o el hub parado, abrir la app instalada no da un error de
  red — da un 502 del proxy, con la página de Tailscale. El index va a red
  primero, pero si lo que vuelve no sirve, gana la copia guardada. Sin copia,
  el error se ve tal cual: mejor un error de verdad que una pantalla en blanco.
- **La caché de assets se poda.** Cada build deja los suyos con un hash nuevo;
  al activar, lo que el index vivo ya no nombra se borra. Sin eso la caché crece
  un build tras otro en un teléfono que nunca la vacía.

### `src/ui/pwa.ts` — el registro

Sólo en producción (en desarrollo una caché por delante convierte «edito y
recargo» en «edito y veo lo de antes»; además el dev server es otro puerto,
4478, y por tanto otro origen) y sólo donde la API existe. En desarrollo, de
paso, desregistra cualquier worker que hubiera quedado.

### El relevo: la consola sigue sin recargarse sola

Es la doctrina de `hud/update.ts` y el worker no la rompe. **No hay
`skipWaiting()` en `install`**: el worker nuevo se queda esperando, la píldora
UPDATE AVAILABLE se enciende, y el clic —que ya volcaba los borradores— manda
`orca:activate`, espera al relevo (con tope de 1,5 s) y entonces recarga. Sin
esa espera la recarga la serviría el worker viejo con la caché vieja, y el
botón necesitaría un segundo clic para hacer algo.

### El manifest

Añadido `launch_handler: { client_mode: "focus-existing" }`: tocar el icono con
la app ya abierta vuelve a ella en vez de abrir una segunda instancia con su
segundo websocket contra el hub.

## 3. Cómo se sirve: lo hace el arranque

El hub está en `0.0.0.0:4479` por http. `tailscale serve --bg 4479` publica ese
mismo puerto por https con certificado real dentro de la tailnet, y con eso hay
contexto seguro: el worker se registra, Chrome ofrece instalar y el websocket
sube a `wss://` solo (`net/client.ts` elige el esquema por `location.protocol`).

Un comando que hay que acordarse de teclear después de cada reinicio es un
comando que un día no se teclea, así que **lo ejecuta el arranque**
(`src/hub/tailscale.ts`, llamado desde `src/orca.ts`). Tres cosas que no es:

- **No abre nada nuevo.** `serve` no es `funnel`: no sale a internet. Y la
  tailnet ya alcanzaba el 4479 por http, porque el hub escucha en `0.0.0.0`.
  Lo único que cambia es que además hay TLS y un nombre. Por eso puede ir
  encendido por defecto sin ser una decisión del operador: no amplía la
  superficie, la cifra. Se apaga con `ORCA_TAILSCALE=0`.
- **No pisa nada.** Si el 443 del nodo ya sirve otra cosa, se deja como está y
  se dice en una línea. Y si ya apunta al puerto del hub no se vuelve a
  ejecutar — bajo `tsx watch` el hub se reinicia cada vez que alguien toca
  `src/hub/*`.
- **No tumba el arranque.** Sin tailscale, con el backend parado, sin Serve
  habilitado en la tailnet o con un comando que falle, el hub sigue y la
  consola sigue alcanzable por http como siempre. El motivo se imprime tal cual
  lo da tailscale.

Va en `src/orca.ts` y **no** en `startHub()`: startHub lo levantan decenas de
suites y el arnés visual, y ninguna tiene por qué tocar la tailnet de nadie.

### De quién es cada cosa

Lo que deja puesto **sobrevive a ORCA**: `--bg` vive en el estado de tailscaled,
no en este proceso. La documentación de Tailscale lo dice: al reiniciar el
equipo, o tras `tailscale down` / `up`, «Serve automatically resumes sharing»
([KB 1242](https://tailscale.com/kb/1242/tailscale-serve)). O sea que abrir
Tailscale en la Mac ya deja la url en pie, con ORCA levantado o sin él.

Lo que hace el arranque de ORCA no es crearlo cada vez: es **asegurarlo**. Si
ya está, no toca nada; si alguien lo quitó, lo repone. Y con la url en pie pero
ORCA parado, lo que contesta es un 502 del proxy — de ahí el punto del §2, que
es lo que hace que la app instalada arranque igual.

Se quita con `tailscale serve --https=443 off`. Retirarlo al salir sería peor:
serían decenas de reconfiguraciones al día bajo `tsx watch`.

### Verificado en la tailnet real (2026-09-08)

El primer intento por este camino falló con `Serve is not enabled on your
tailnet.` —de ahí que el código imprima el motivo tal cual y añada dónde se
activa—, y el segundo, sin tocar el código, funcionó. Quedó servido:

```
https://<mac>.<tailnet>.ts.net/  →  proxy http://127.0.0.1:4479
```

Comprobado de punta a punta contra esa url con el build que sirve el hub:
contexto seguro (`isSecureContext`), `navigator.serviceWorker` existe, el
worker **controla la página**, las cachés quedan pobladas (9 entradas de casco,
2 de assets), `pushManager` disponible —que es lo que necesita el push del §5—
y la consola **enlaza con el hub**, sin handshake. Es decir: instalable de
verdad, no en teoría.

El timeout del `serve` es de 30 s por esto mismo: la primera vez que se publica
un nombre, tailscaled emite el certificado TLS. Los dos `status` son lecturas
locales y siguen con 5 s.

## 4. Cómo se instala, y el token

El token no viaja en el manifest a propósito: `start_url` es `/`, y el token
vive en el `localStorage` del origen desde la primera visita con `?k=`
(`net/client.ts`). La consecuencia práctica es el orden de los pasos:

1. En el teléfono, abrir **una vez**
   `https://<mac>.<tailnet>.ts.net/?k=<token>` — el de `~/.orca/token`.
2. Cuando la consola arranque (o sea: cuando el handshake cierre), instalar:
   Chrome → menú → **Instalar app**. iOS Safari → compartir → **Añadir a inicio**.

Instalada, la app hereda ese `localStorage` y arranca con enlace. Instalar
**antes** de meter el token deja la app en el handshake que no termina, sin
manera de escribirlo: `ui/handshake.ts` no tiene casilla, y eso es deliberado
—el token no es una contraseña que el operador sepa de memoria—, así que la
salida es volver a abrir la url con `?k=` en el navegador.

Cambiar de origen (de la IP al nombre de la tailnet, o al revés) es cambiar de
`localStorage`: hay que repetir el `?k=` una vez por origen.

## 5. Push, pantalla y dispositivos — ampliación 2026-09-08

**Notificaciones implementadas.** SETTINGS → THIS DEVICE → ENABLE PUSH pide
permiso desde el clic y suscribe este dispositivo. DISABLE PUSH elimina el
registro del hub y cancela la suscripción del navegador. En iPhone/iPad hay que
abrir la app desde la pantalla de inicio; el permiso requiere una interacción
directa. [Fuente: WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

El hub genera claves VAPID al primer acceso autenticado a `/api/push` y guarda
claves, suscripciones y esperas notificadas en `~/.orca/push.json` (`ORCA_HOME`
si está definido), modo 0600, con reemplazo atómico. Conservar este archivo al
migrar el hub: las suscripciones pertenecen a esas claves. Opcionalmente,
`ORCA_VAPID_SUBJECT=mailto:operador@tu-dominio` fija el contacto VAPID; el valor
local por defecto es `https://orca.local`. No hace falta una cuenta Firebase ni
exponer el hub a Internet: sí necesita salida HTTPS hacia los servicios push.

La API usa la autenticación existente en GET/POST/DELETE, exige JSON para
mutaciones, limita a 32 dispositivos y valida los endpoints de Chrome/Firefox/
Safari/Windows para impedir que se convierta en un proxy hacia URLs arbitrarias.
404/410 eliminan suscripciones caducadas. Una suscripción existente se reconcilia
al recuperar el enlace o abrir ajustes, sin volver a pedir permiso.

Una espera nueva de tipo permiso/pregunta/error produce push; las esperas entre
agentes, los agentes idle y las máquinas sintéticas no. Mientras CAPCOM atiende
una escalación no se avisa al humano: se espera a `pending`. Se agrupan las
esperas en intervalos de dos segundos, fuera de la publicación de patches, y se recuerda `agentId + block.since` entre reinicios.
El aviso es genérico, sin prompts, repositorios ni token, dura como máximo cinco
minutos en el servicio push y abre la cola en la ventana existente o en una nueva.
Siempre se muestra una notificación visible, incluso con payload vacío o inválido.
La llegada depende del proveedor y del sistema operativo; un error de envío se
registra sin bloquear el mundo. No se promete entrega garantizada.

**Wake lock implementado.** KEEP AWAKE está activado por defecto, sólo para la
app instalada y visible. Se puede apagar en ajustes. Al ocultar la app se libera;
al volver se solicita de nuevo, sin duplicar solicitudes ni retener una concesión
que llega después de ocultarla. El sistema puede denegarlo por batería y la
consola sigue funcionando. [Fuente: MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).

**Orientación libre.** `orientation: "any"` permite usar el Fold cerrado,
abierto o apaisado; el manifest no fuerza una rotación. La revisión física en
Fold sigue pendiente: una emulación de viewport no prueba bisagras ni el SO.

**Capturas de instalación.** Dos vistas sintéticas del campo, una estrecha y
otra ancha, se generan con `npx tsx test/pwa.shots.ts --isolated` y se publican
en `public/screenshots/`. No contienen datos de la flota real. El mismo arnés
comprueba ajustes en ambos tamaños y alta/baja con transporte push simulado.

**Cuota de caché.** Sigue sin presupuesto explícito; los fallos de cuota no
rompen la consola y se podan los assets de builds anteriores.

## 6. Verificación

### Ampliación push y dispositivos

- `npm run typecheck`: limpio.
- `npm test -- --changed`: **921/921 checks, 73 suites**, incluyendo los cambios
  que ya estaban en el árbol antes de esta entrega.
- `npm test -- push sw update wake-lock`: **33/33** en la corrida específica;
  la suite push incluye API autenticada, persistencia, límite de dispositivos,
  deduplicación y retirada por 410. La corrida final también comprueba que el
  temporizador del hub despacha una espera nueva hacia un transporte simulado.
- `npm run build`: correcto; Vite avisa del chunk principal mayor de 500 kB.
- `npm run visual -- mobile --isolated`: dos capturas, campo y ventana, sin skips
  en la corrida final. El arnés ahora pasa su token y selecciona todos los
  orígenes de la flota sintética; el filtro por defecto ocultaba sus agentes.
- `npx tsx test/pwa.shots.ts --isolated`: ajustes anchos/estrechos, capturas de
  instalación y alta/baja con transporte simulado, correctos. Se inspeccionaron
  las capturas y se corrigió el solapamiento del rótulo PUSH en pantalla estrecha.
  Al cerrar este arnés apareció un aviso ENOENT de su directorio temporal: su
  limpieza ocurre antes de terminar el vaciado del hub. No es una prueba de
  persistencia fallida del hub de producción.
- `npx tsx test/pwa.production.ts`: worker del build real controlando la página,
  payload del handler push, manifest/capturas con dimensiones correctas y
  navegación profunda offline, correctos. **No se verificó la notificación
  nativa**: el navegador de automatización rechazó `showNotification` por falta
  de permiso, incluso con el permiso configurado en el contexto de pruebas.
  La prueba lo declara `UNVERIFIED`; no se envió ningún push externo.

El selector avisa de ficheros sin suite por imports: entre los de esta entrega
están manifest, imágenes, entradas y controles UI, scripts visuales y docs.
El worker sí tiene pruebas que leen el archivo real aunque el grafo no detecta
esa lectura. Los controles y las capturas se cubrieron con los arneses anteriores;
la documentación no tiene pruebas automáticas. Sigue pendiente instalar y
recibir un push real en el Fold, comprobar su rotación física y probar iOS.

### Verificación anterior del casco offline


```
npm run typecheck                     limpio
npm test -- sw                        19/19
npm test -- tailscale                 9/9
npm test -- --changed                 930/930
```

`test/sw.test.ts` carga **el `public/sw.js` real** —el mismo archivo que sirve
el hub— con un `self`, un `caches` y un `fetch` de mentira. Copiar su lógica a
un módulo de pruebas habría dejado la copia pasando y el original haciendo otra
cosa. Cubre, por orden de gravedad: que el hub nunca se cachea (`/api`, `/ws`,
`/mcp`, y ni POST ni otro origen pasan por el worker); que sin red una
navegación —también a una ruta profunda— devuelve el index guardado y los
assets salen de caché; que el index tiene una sola clave y prefiere la red; que
un asset con hash se descarga una vez; la poda, tanto de huérfanos como de
cachés de un worker anterior; y que el relevo no ocurre sin la orden.

### En un navegador de verdad

El registro (`src/ui/pwa.ts`) no lo puede probar el runner: depende de
`navigator.serviceWorker`, que en Node no existe. Se comprobó a mano con el
build de producción servido en `127.0.0.1` —localhost **sí** es contexto
seguro, así que no hizo falta https para esto— y Chromium por Playwright:

- El worker se registra y **controla la página en la primera visita**
  (`navigator.serviceWorker.controller !== null`).
- El precache queda con el casco entero en `orca-shell-v1` (`/`, las dos
  fuentes, los tres iconos, manifest, recovery) y en `orca-assets-v1`
  exactamente los dos `/assets/*` del build servido, leídos del index.
- Cortando el servidor y navegando a una ruta profunda (`/agent/K9`): la
  respuesta es 200 con el index del build, el módulo **se ejecuta** y la
  consola pinta su campo con el handshake encima, que es lo correcto sin hub.
  Antes eso era la pantalla de error del navegador.

### El arranque, contra el tailscale real

`test/tailscale.test.ts` prueba las decisiones con un ejecutor de mentira —que
no se sirve dos veces, que no se pisa una config ajena, que un tailscale
ausente o parado no rompe nada, que `ORCA_TAILSCALE=0` no ejecuta ni un
comando—. Además se levantó ORCA de verdad, con su propio `ORCA_HOME` y en el
puerto 4491 para no tocar el hub vivo: el intento ocurre, falla por lo del §3,
imprime las dos líneas y el arranque continúa con su banner de siempre.

**Lo que sigue sin comprobarse fuera del unit test:** el ciclo completo de
relevo con dos builds reales (que la píldora se encienda por el worker y que
`activatePending` recargue ya con el nuevo), el `serve` terminando bien —hace
falta el interruptor del §3— y el prompt de instalación de Chrome Android.

## 7. Filtros que cubren esta entrega

```
npm test -- sw update push wake-lock tailscale
npx tsx test/pwa.shots.ts --isolated
npm run visual -- mobile --isolated
npm run build && npx tsx test/pwa.production.ts
```
