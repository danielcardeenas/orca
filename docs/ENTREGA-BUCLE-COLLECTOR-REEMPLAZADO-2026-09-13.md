# El bucle de dos collectors con el mismo id de máquina

2026-09-13. Agente 6F, squad `forge-vivas-01`, worktree
`.claude/worktrees/forge-vivas-01-bucle`, rama `forge-vivas-01-bucle` desde
`ad48def`. Cierra la pieza 1 del reconocimiento del tablero
(`docs/RECONOCIMIENTO-TABLERO-AUTOMEJORA-2026-09-13.md`, «collector-reemplazado-bucle»).

## Veredicto

**El bucle ya no puede sostenerse a un segundo, y cuando empieza se ve.** Las
tres piezas del diagnóstico están tocadas, cada una con su prueba:

| Pieza | Antes | Ahora |
|---|---|---|
| El hub cierra con 4009 y calla | ninguna línea, ningún contador | `collector sustituido: <máquina>, pid A echa a pid B` siempre; evento `machine:replaced` siempre; a partir del segundo en diez minutos, `warn` y alerta en el feed |
| El collector ignora el código | `close` sin argumentos, reintenta igual | lee `(code, reason)`; con `CLOSE_REPLACED` espera 30 s, luego 60, 120, 240 y 300, y lo dice en `warn` con el culpable |
| La espera se resetea al abrir | `open` → 1 s, y en el bucle abre siempre | se resetea por **durar** (60 s), no por abrir; una conexión de un segundo cuenta como fallo |

Doce vueltas del bucle antiguo eran unos 14 segundos. Con la política nueva son
48 minutos, y a partir de la quinta cada vuelta son cinco minutos.

## Una decisión que cambia lo escrito en el reconocimiento

El reconocimiento decía: «que `close` mire `code === 4009`, no reconecte y lo
diga alto». **El desplazado sí reconecta, con escalera lenta**: 30 s la primera
vez, doblando hasta 5 min, y sólo baja tras quedarse 5 min conectado.

El motivo: el otro proceso puede ser un zombi que muere a los diez minutos, o
un `tsx watch` que se relevó dos veces. Un collector que hubiera dejado de
llamar dejaría la máquina offline con un collector vivo dentro, hasta que
alguien la reiniciara a mano, que es peor que lo que venimos a arreglar.

**El peor caso resultante, con dos collectors vivos que no mueren:** un
reemplazo cada 5 min (cada lado se queda 5 min y espera 5), y el hub lo avisa
desde el segundo en diez minutos, con los dos pids, en el log, en el evento
`machine:replaced` y como alerta en el feed. Antes era un reemplazo por
segundo, sin ninguna línea que lo distinguiera de una reconexión.

Las dos comprobaciones que el líder pidió ver están en `test/reconnect.test.ts`:

1. **El echado no reconecta al segundo**: `desplazado: abrir y ser echado al
   segundo no vuelve a 1 s` reproduce el bucle del 10-09 (abre, lo echan a los
   1.150 ms, vuelve) doce veces y afirma que la primera espera tras un 4009
   es exactamente 30 s, la segunda 60, la tercera 120, y ninguna baja de 30.
2. **La escalera no baja por un `open`, sólo tras 5 min conectado**:
   `desplazado: la escalera baja sólo tras quedarse cinco minutos` sube la
   racha a cuatro, vuelve y aguanta 4:59 (racha 5, espera 5 min), y luego
   aguanta 5:00 (racha 1, espera 30 s).

## Por qué así, y no de otra forma

**Dos escaleras, no una.** Que te echen no es que se caiga la red, así que el
reemplazo lleva su propia escalera (30 s → 5 min) y no toca la de red (1 s → 30
s). Si después de dos reemplazos el hub se cae de verdad, el collector vuelve
en un segundo, como siempre: la pelea por la identidad no debe hacer pagar al
hub caído. La prueba `las dos escaleras son independientes` lo afirma.

**El reset es por durar.** Una conexión que abre y muere en un segundo no es
una conexión exitosa. Era el supuesto falso que sostenía el bucle: el hub echa
al anterior *después* de aceptar al nuevo, así que el socket del desplazado
abre siempre. Ahora la escalera de red vuelve al primer peldaño sólo si la
conexión duró 60 s, y la de reemplazo sólo si el collector volvió y se quedó
cinco minutos sin que nadie lo echara (= ganó).

**El hub no elige, cuenta.** No puede saber cuál de los dos es el legítimo
(en un reinicio el legítimo es el nuevo; en el bucle, cualquiera). Así que no
decide: registra cada reemplazo y avisa desde el segundo en diez minutos. La
ventana es de minutos y no de segundos porque, con la política nueva, la pelea
se turna cada cinco minutos; una ventana de segundos ya no la vería.

**El ping-pong se reconoce por señal, no por frecuencia.** El `hello` lleva
ahora un `instance` (pid, cwd, startedAt) que es lo único que distingue dos
collectors de la misma máquina. Con eso el hub sabe si el que entra es uno al
que echaron dentro de la ventana, y el aviso lo dice con otras palabras: «se
están echando el uno al otro», con los dos pids y los dos cwd. Un desarrollador
reiniciando el collector tres veces en diez minutos (A→B→C→D) también avisa,
pero como «sustituido N veces», sin acusar ping-pong. Es información cierta y
rara; no la he suprimido.

**El culpable viaja en el motivo de cierre.** El día 10 nadie supo qué segundo
collector corría, porque ni el código ni los eventos lo decían. Ahora el 4009
lleva `reemplazado por pid N en <cwd>` (acotado a 123 bytes, el límite del
protocolo WebSocket), el desplazado lo escribe en su log, y el evento
`machine:replaced` lleva las dos instancias. La próxima vez, la pregunta abierta
del reconocimiento tiene respuesta en los dos lados. No he ido a buscar quién
fue aquel día, como se pidió.

**Sin subir `PROTOCOL_VERSION`.** `instance` es opcional. Un collector viejo
contra este hub entra igual; el hub cuenta sus reemplazos sin poder acusar
ping-pong (la prueba `sin instancia` lo cubre). Un collector nuevo contra un
hub viejo recibe el 4009 sin motivo y espera igual: la escalera no depende del
texto.

## Qué queda como estaba

- El hub sigue aceptando al recién llegado y echando al anterior. Rechazar al
  segundo rompería el reinicio normal (el viejo está muriendo, no contesta).
- `machine:reconnect` se sigue emitiendo en cada `hello`; `machine:replaced`
  va aparte y no lo sustituye, para que las cuentas de días anteriores sigan
  siendo comparables.

## Sin cubrir

El cableado de la política dentro de `Collector` (`src/collector/index.ts`,
`connect`/`scheduleReconnect`/`sendHello`) no tiene prueba directa: la clase no
se exporta y su constructor levanta tmux, watchers y ptys. La política entera
vive en `src/collector/reconnect.ts` y está probada sin socket; el cableado son
diez líneas que le pasan `code` y `Date.now()`. No he reproducido el bucle con
dos collectors reales contra el hub del operador, y no debía: la prueba de
integración lo hace con dos sockets crudos contra un hub aislado en directorio
temporal.

## Verificación

- `npm run typecheck`: limpio.
- `npm test -- reconnect`: 7/7.
- `npm test -- hub`: 50/50, incluida la integración nueva
  `dos collectors con el mismo id → el echado recibe 4009 con el culpable, y el hub avisa a la segunda`.
- `npm test -- --changed`: 77 suites (tocar `src/shared/protocol.ts` alcanza
  casi todo); resultado en la entrega al líder.

Filtros que cubren esta entrega: `reconnect`, `hub`.
