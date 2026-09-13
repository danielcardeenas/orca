# Entrega: la salida de emergencia de un miembro de escuadrón

**13 de septiembre de 2026 · squad `forge-tres-01` · vía de escape**

## El hecho, y lo que se decidió

Un miembro de escuadrón no lleva `orca-ask` en su perfil de atajos
(`src/collector/shims.ts`, `shimsFor`). Es deliberado y sigue siéndolo: escala
a su líder, el líder al humano, y cinco miembros interrumpiendo al operador es
exactamente lo que un escuadrón existe para evitar. Lo que no había era salida
de emergencia: cuando el líder no contesta, nada lo decía.

Se eligió la **opción 2, escalada por espera vencida, implementada en el hub**:
`src/hub/wake.ts` gana un quinto despertador, `[SQUAD <name>]`. Un `ask` de un
miembro a su líder (o a `squad:<suyo>`) sin respuesta llega a CAPCOM a los 15
minutos, otra vez a los 45 y luego cada dos horas; al minuto si el líder ya está
`done`/`dead`, porque entonces nadie va a contestar nunca. Lleva la pregunta y
la llamada exacta de `answer_peer`. A la hora el operador lo ve una vez en su
feed. No se toca ningún perfil de atajos: el miembro sigue sin poder hablar con
el operador.

De paso, el informe de situación (`briefing`, en `src/agents/tools.ts`) marca
`RECIPIENT IS GONE` también cuando un `ask` a `squad:` no tiene a nadie vivo
en el escuadrón salvo quien pregunta. Antes sólo lo decía de los dirigidos a un
agente concreto.

## Por qué así: lo que se midió antes de elegir

La elección salió de leer qué sabe cada pieza, no de una intuición. Esto es lo
que hay en el código a fecha de hoy.

**El recibo (`bin/lib/receipt.mjs`, de hoy).** Vive en el disco del EMISOR, en
`<project>/.orca/receipts/<stem>.json`. Lo escribe `orca-tell` en `filed`; el
propio emisor lo sube a `picked` cuando ve que su fichero ya no está en
`.orca/out`; y el collector lo sube a `delivered`, `undeliverable` o `read`
(`src/collector/messages.ts`, `noteReceipt`, con la marca `.read` que escribe
`orca-read` y que el collector barre en `sweepRead`). Sólo lo lee `orca-tell`,
en `--check` y en `sweepReceipts` al mandar el siguiente mensaje.

**Lo que el hub sabe de un mensaje (`src/hub/world.ts`).** `readBy` no significa
leído: `markDelivered` mete ahí a cada destinatario al despachar el `deliver`.
El collector sólo re-emite un mensaje al hub cuando lo leen si es un `ask`
abierto (`sweepRead` → `this.open`), y `upsertMessage` rechaza frames sobre un
mensaje cuyo emisor vive en otra máquina. Es decir: **el hub sabe que entregó,
no sabe si se leyó**, y no puede saberlo hoy sin tocar el collector y el
significado de `readBy`.

**Lo que el hub sí sabe con certeza.** Que un `ask` existe, de quién, a quién,
desde cuándo, y si tiene `answer`. Y de cada agente, su `squad`, si es `lead`, y
si está `done`/`dead`. Con eso se puede afirmar, sin inferir nada del silencio,
«este miembro lleva N minutos parado en una pregunta a su líder que nadie ha
contestado, y su líder sigue vivo (o no)».

**Lo que ya existía y dónde se cortaba.** `wake.ts` avisa al líder cuando un
miembro termina sin escribirle (`tellLead`, desde el 2026-09-09), y calla a
propósito ante un miembro que se bloquea bajo un líder vivo (`underLead →
return`): seis miembros no son seis turnos de CAPCOM. Correcto mientras el
líder conteste. Cuando no contesta: el aviso de `tellLead` viaja por el mismo
canal que puede estar fallando, y el `briefing` lista la pregunta en `PEER
QUESTIONS UNANSWERED` sólo si CAPCOM lo llama, que ocurre en el latido (cada 15
minutos sin turnos, suprimido si CAPCOM está ocupado o hay una escalación
pendiente). Un miembro bloqueado en un `ask` a su líder no tenía ningún camino
que **empujara** hacia arriba.

## Las dos descartadas, y por qué

**Opción 1, sólo vigilancia desde fuera (el briefing).** Se hizo la mejora
barata que faltaba (escuadrón vacío = nadie contestará), pero no basta como
única respuesta: llega cuando CAPCOM pregunta, y CAPCOM pregunta en el latido,
que se salta cuando está ocupado. En el incidente de hoy el líder estaba
trabajando y CAPCOM también; un miembro parado dos horas es exactamente lo que
pasa desapercibido con un mecanismo de tirar. Se conserva como la mitad de
«mirar»: el wake empuja, el briefing deja ver.

**La variante «barata» de la 2: convertir el recibo en aviso desde el emisor.**
Era lo que había que mirar primero, y no tiene salida:

- El emisor sólo lee sus recibos al **volver a mandar**. Un miembro que ya
  entregó, o que está bloqueado en un `ask --wait`, no vuelve a mandar. No hay
  demonio en su lado, y la información llega en el único momento en que ya no
  puede hacer nada con ella.
- En el fallo de hoy (`filed`, nadie recoge), el único directorio donde el
  emisor podría dejar el aviso es **el mismo que nadie está mirando**. Un aviso
  en un buzón sin lector es el problema, no la solución.
- El único otro canal del emisor es `.orca/ask/`, el del humano. Que
  `orca-tell` escribiera ahí por su cuenta sería darle al miembro `orca-ask`
  por la puerta de atrás: justo lo que la jerarquía —y el brief— prohíbe.

**La otra mitad de la 2: marca `.read` → hub.** Sería el mecanismo correcto para
los `handoff` (que no esperan respuesta y por tanto no tienen `answer` que
mirar): «entregado al líder hace N minutos y sin marca de lectura». La pieza
existe a medias en el collector (`this.delivered` guarda cada entrega hasta que
aparece su `.read`), pero llevarla al hub exige (a) que `sweepRead` re-emita o
mande un frame por cada lectura, no sólo de `ask` abiertos; (b) que `readBy` en
`world.ts` deje de significar «entregado» (hoy `markDelivered` lo llena) o
crezca un campo aparte; (c) aceptar frames de lectura desde la máquina del
destinatario, que `upsertMessage` rechaza. Tres ficheros, dos de ellos en
`src/collector/`, que hoy es dominio de otro miembro del squad, y un cambio de
semántica que toca a `list_messages` (`delivered_to`). Queda como **segunda
etapa documentada, sin código**, por decisión del líder. Lo que cubre la
primera etapa sin ella: todo `ask` (que es donde el miembro está de verdad
parado); lo que no cubre: un `handoff` que el líder no lee, que hoy sigue
dependiendo de que el líder termine o de que CAPCOM mire el briefing.

**Opción 3, salida de emergencia en el perfil.** Descartada. Todo lo que
aporta —«al humano sólo si el líder no está disponible»— lo tiene que decidir el
hub con la misma información que ya usa el wake (si el líder está vivo, si
contestó), así que el wake lo da sin tocar `shims.ts` ni abrir el camino
miembro → humano. Y abrirlo, aunque sea enrutado, cambia lo que el modelo ve:
un miembro atascado busca la salida que ve, y ésa es la razón por la que la
herramienta no está (`shims.ts`, «quitar la herramienta gana a pedir que no se
use»). Además exige elegir qué es «no disponible» para un líder, y ahí es donde
`liveness.ts` ya enseñó que inferir muerte del silencio tira trabajo vivo.

## Qué se hizo, fichero a fichero

- `src/hub/wake.ts`: constantes `SQUAD_WAIT_STEPS_MIN` (15, 45, 120),
  `SQUAD_WAIT_ORPHAN_MIN` (1), `SQUAD_WAIT_ALERT_MIN` (60); config
  `ORCA_SQUAD_WAIT_STEPS` y `ORCA_SQUAD_WAIT_ALERT_MIN`; `SquadWaitEntry`,
  `squadWaitLine`, `squadWaitMessage`, `squadWaitAlertLine`; `squadWaits()`
  en el tick, con `squadWaits` en la marca de agua `wake.json` (por id de
  mensaje: contestar o irse el miembro la cierra sola). `liveLeadOf` se apoya
  en un `leadOf` que también ve al líder ya ido.
- `src/hub/autonomy.ts`: `messages?()` opcional en `AutonomyDeps`, como
  `saidTo`; un arnés sin ella no tiene esperas que ver.
- `src/hub/server.ts`: una línea, `messages: () => Object.values(world.state.messages)`.
- `src/collector/briefs.ts`: un párrafo en el brief de CAPCOM, sólo texto, en
  su propio commit.
- `src/agents/tools.ts`: `briefing`, escuadrón sin nadie vivo → `RECIPIENT IS GONE`.
- `test/wake.test.ts`: seis casos nuevos; `test/briefing.test.ts`: uno.

Commits, todos por rutas con `--only`: `536f290` (wake), `ad16e02` (brief),
`9bbc73f` (briefing). Sin push, sin merge.

## Qué queda sin cubrir, dicho

- El `handoff` no leído (segunda etapa, arriba).
- Un miembro cuyo `ask` nunca fue recogido del `.orca/out` (el primer fallo de
  hoy): el hub no lo ve porque no existe para él. Lo que lo cubre es el
  `NOT PICKED UP` del recibo en el lado del emisor y, cuando el miembro se
  queda idle, el `tellLead` de `wake.ts`. Este wake sólo mira lo que llegó al
  hub.
- Sin CAPCOM vivo el aviso espera y no cuenta como enviado; el operador sí ve
  la alerta a la hora, con CAPCOM o sin él.

## Verificación

- `npm run typecheck`: limpio.
- `npm test -- wake`: 37/37.
- `npm test -- briefing`: 9/9.
- `npm test -- --since=7a61eed` (base de la rama; el árbol es compartido y
  arrastra cambios sin commitear de los otros dos miembros): 1044/1044. Los
  cinco «sin suite que los cubra» que lista (`hud.css`, `window.css`,
  `hud-mobile.shots.ts` y dos docs) son del trabajo de móvil apaisado, no de
  esta entrega.

Filtros que cubren esta entrega: `npm test -- wake briefing`.
