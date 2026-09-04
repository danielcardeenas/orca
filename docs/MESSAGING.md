# El canal agente → agente

Hermano de `docs/ESCALATION.md`, y con la misma forma por la misma razón: un
agente de Claude Code no tiene socket hacia sus pares. Tiene un filesystem. Así
que hablar con otro agente es dejar un archivo y esperar a que el collector lo
recoja.

```
<project>/.orca/out/<id>.json          el agente manda algo
<project>/.orca/in/<id>.json           lo que le llega a él (lo escribe ORCA)
<project>/.orca/in/<id>.read           marca de leído (la escribe el agente)
<project>/.orca/in/<id>.answer.json    la respuesta a un `ask` suyo
```

El collector vigila `.orca/out/` en cada proyecto que conoce (`fs.watch` + poll
de 1s), convierte cada archivo en un `AgentMessage` del contrato y lo emite al
hub como `{t:'message'}`. **El hub decide a quién llega**: la entrega baja como
`{k:'deliver', agentId, message}` y el collector la escribe en el `.orca/in/`
del proyecto de ese agente. Una respuesta baja como `{k:'reply', messageId,
answer, fromAgentId}`.

El CEO es el router a propósito. Veinte agentes con línea directa entre ellos
son veinte agentes interrumpiéndose; enrutado, un mensaje puede retenerse hasta
que su destinatario esté entre turnos, fusionarse con otros, o contestarse sin
despertar a nadie.

Este documento **es** el contrato del lado del agente. La forma que viaja por
el cable vive en `src/shared/types.ts` (`AgentMessage`) y no se toca desde aquí.

---

## 1. Mandar

El agente escribe un JSON en `<project>/.orca/out/<id>.json`. El `<id>` lo elige
él: cualquier nombre de archivo válido que no empiece por `.` y no termine en
`.answer`. En la práctica se usa `orca-tell`, que lo hace bien solo.

```jsonc
{
  // OBLIGATORIO. Qué clase de mensaje es. Ver §2: la diferencia importa.
  "kind": "notice" | "ask" | "handoff" | "warning",

  // Opcional. Tres formas y nada más:
  //   "K9"              un callsign concreto        → scope 'agent'
  //   "project:dijosi"  todos los de ese proyecto   → scope 'project'
  //   "fleet" | null    todo el mundo               → scope 'fleet'
  "to": "K9",

  // OBLIGATORIO. Una línea. Es lo que se pinta sobre una arista del mapa, así
  // que tiene que entenderse sin abrir nada. Máx. 300 caracteres; se recorta.
  "subject": "El endpoint /v1/charges devuelve 402 en sandbox",

  // Opcional, multilínea. El detalle. Máx. 8000 caracteres; se recorta.
  "body": "Desde el deploy de las 14:40.\nLa key de sandbox caducó.",

  // Opcional. Archivos de los que va esto, para que la consola pueda señalar
  // algo concreto. Máx. 20; se recorta.
  "files": ["src/api/charges.ts"],

  // Opcional pero MUY recomendado: tu sessionId. Sin esto el collector se lo
  // atribuye al agente más recientemente activo del proyecto, que con varios
  // agentes en el mismo repo puede equivocarse.
  "agentId": "78b357fe-4480-419f-bd99-7b5d7980e7fd",

  // Opcional. Minutos tras los cuales el mensaje se retira solo.
  // Un `notice` sin esto caduca a las 6h. Un `ask` sin esto NO caduca nunca.
  "ttlMinutes": 120
}
```

Reglas que el agente debe respetar:

- **`kind` y `subject` son obligatorios.** Un archivo sin ellos, o con un `kind`
  inventado, se descarta con un warning en el log y **se borra**: no se reintenta
  eternamente algo que nunca va a ser válido.
- **Escribe atómicamente.** `<id>.json.tmp` y renombra. El collector reintenta al
  siguiente tick si lee un JSON a medias, pero un rename es gratis.
- **`mkdir -p` la carpeta.** El collector NO crea `.orca/out/`. No queremos que un
  daemon de observación escriba dentro de los repos del usuario sin que nadie se
  lo pida. El primer mensaje la crea el agente.
- **Un mensaje por archivo.**
- **Añade `.orca/` a `.gitignore`.**

El collector **borra** el archivo de salida al emitirlo. El registro ya lo tiene
el hub; dejarlo ahí sólo produciría duplicados en el siguiente arranque.

## 2. Los cuatro `kind`, y por qué la diferencia importa

| kind | significa | ¿bloquea? |
|------|-----------|-----------|
| `notice` | "Me he enterado de esto." A alguien puede servirle; nadie debe actuar. | no |
| `ask` | "Necesito esto de ti." | **sí, a QUIEN LO MANDA** |
| `handoff` | "Esto pasa a ser tuyo." Trabajo que cambia de manos, con contexto. | no |
| `warning` | "Cuidado." Algo con lo que el destinatario está a punto de chocar. | no |

Un `ask` sin responder pone a su emisor en
`block = {kind:'peer', messageId, waitingOn, since}`, y eso es lo que dibuja las
cadenas de espera de la consola: A espera a B, que espera a C. Es la única
razón por la que este canal merece existir en lugar de un archivo compartido.

Un `notice` **no bloquea a nadie**, y eso también es deliberado: si bloqueara,
nadie mandaría notices, y el canal se moriría de silencio.

Usa `ask` sólo cuando de verdad no puedes seguir. Para todo lo que simplemente
quieres dejar por escrito, `notice`.

## 3. Enrutado, y el degradado

`to` se resuelve así:

- Un **callsign** (`"K9"`) contra los agentes que ORCA está mirando ahora mismo.
  Prefiere uno no terminado: las etiquetas se reciclan cuando un agente muere.
- `project:<nombre>` contra el nombre, el código o el slug del proyecto, y en una
  segunda pasada por coincidencia parcial (`dijosi` encuentra `dijosi-workers-…`).
- `fleet`, `*`, `null` o ausente: toda la flota.

**Si el destinatario no existe, el mensaje NO se tira.** Sale igual, degradado a
`scope: 'project'` sobre el proyecto del emisor, y el subject lo dice:

```
[no encontré a QQ] ¿Ya migraste la tabla de sesiones?
```

Un aviso mal dirigido se ignora en dos segundos. Uno que nunca se emitió cuesta
una tarde de depuración, porque no deja ni una línea de log en ningún sitio.

## 4. Recibir

El collector escribe en `<project>/.orca/in/<id>.json`, donde `<id>` es el id
que el mensaje tiene en el protocolo (`msg_…`):

```jsonc
{
  "id": "msg_c27a8e9c5dd2b6a1",
  "kind": "ask",
  "scope": "agent",
  "from": "Z1",                       // callsign de quien lo manda
  "fromAgentId": "78b357fe-…",
  "fromProjectId": "…",
  "subject": "¿Ya migraste la tabla de sesiones?",
  "body": null,
  "files": [],
  "at": 1788563552553,
  "expiresAt": null,
  "replyTo": "msg_c27a8e9c5dd2b6a1"   // presente sólo en un `ask`: contéstalo
}
```

Se lee con `orca-read`, que además escribe `<id>.read` junto a cada mensaje que
imprime. Esa marca es lo que el collector vigila para llenar `readBy` en la
consola, así que no la borres a mano.

## 5. Responder un `ask`

Dos caminos, y los dos cierran el mismo bloqueo:

**Desde la consola / el CEO.** El hub baja `{k:'reply', messageId, answer,
fromAgentId}`.

**Desde otro agente**, sin pasar por nadie: se escribe en el *mismo* buzón de
salida un archivo con `replyTo`.

```jsonc
{ "replyTo": "msg_c27a8e9c5dd2b6a1", "answer": "Sí, la migré anoche",
  "agentId": "<tu sessionId>" }
```

o, lo que es lo mismo:

```bash
orca-tell --reply msg_c27a8e9c5dd2b6a1 "Sí, la migré anoche"
```

En ambos casos el collector escribe **dos** cosas en el buzón del que preguntó:

- `<su nombre local>.answer.json` — el nombre que él conoce, que es lo que
  `orca-tell --wait` está esperando;
- `<msgId>.json` con `kind: "notice"` y `subject: "re: …"` — para que la
  respuesta también salga en un `orca-read` de quien ya siguió con otra cosa.
  Si ese archivo tenía marca `.read`, se borra: el contenido cambió, así que el
  mensaje vuelve a ser nuevo.

El `.answer.json` tiene esta forma:

```jsonc
{
  "id": "msg_c27a8e9c5dd2b6a1",
  "replyTo": "msg_c27a8e9c5dd2b6a1",
  "subject": "¿Ya migraste la tabla de sesiones?",
  "answer": "Sí, la migré anoche",
  "at": 1788563590478,
  "answeredBy": "<sessionId de quien contestó>",
  "answeredByCallsign": "K9"
}
```

## 6. Esperar

```bash
orca-tell "¿Ya migraste la tabla de sesiones?" --to T1 --kind ask --wait
```

Bloquea hasta que aparezca el `.answer.json`, imprime la respuesta en stdout y
sale con 0. Con `--timeout <min>` (por defecto 60) sale con 3 si nadie contestó.
Igual que `orca-ask --wait`, y por la misma razón: un agente que espera tiene que
poder decir "me rindo, sigo con una suposición" en vez de colgarse.

Mientras el `ask` está abierto, su emisor aparece en la consola como `blocked`
con `block.kind = "peer"`.

## 7. Ids

El id del protocolo **no** es el nombre del archivo:

```
msg_<sha1(ruta absoluta + " " + hora de creación)[0..16]>
```

Lleva la hora dentro, a diferencia del de una escalación, porque el archivo de
salida se borra al recogerlo: un agente que reusa `out/1.json` para su segundo
mensaje tiene que producir un id distinto, o el hub creería que el primero
cambió de opinión.

## 8. Colisiones de archivo

No es parte de este buzón y no requiere que el agente haga nada — está aquí
porque es la otra mitad de "dos agentes trabajando cerca".

El collector ya lee los transcripts, y Claude Code escribe una línea
`file-history-delta` **antes de cada escritura** (nunca antes de una lectura).
Dos agentes vivos que escriben el mismo archivo dentro de 15 minutos
(`ORCA_COLLISION_WINDOW_MS`) producen una `Collision`, que sale como
`{t:'collision'}` y se retira con `{t:'collision:clear'}` cuando deja de ser
cierta.

Lo que **no** cuenta:

- Sesiones terminadas (`done`, `dead`).
- Lecturas. Que dos agentes lean el mismo archivo es normal y sano.
- Lockfiles, `node_modules/`, `dist/`, `.git/`, `*.log` y todo lo que cuelgue de
  `.orca/`.
- Un agente y **su propio linaje**. Un subagente edita *por* su padre y comparte
  worktree por diseño; avisar de eso sería avisar de que el producto funciona.
  Dos hermanos del mismo padre **sí** cuentan: son dos escritores independientes,
  que es el caso clásico que esto existe para cazar.

Detalle medido, no supuesto: el `backupTime` de un `file-history-snapshot` es la
hora del snapshot, no la de cada escritura — Claude Code re-sella el conjunto
entero cuando entra un archivo nuevo (18 archivos, 3 marcas de tiempo, en un
transcript real). Por eso sólo un `file-history-delta` puede abrir una colisión;
el snapshot vale para saber qué archivos están en el conjunto de edición del
agente y nada más.

## 9. Lo que este canal NO es

- **No es un chat.** Un mensaje, y como mucho una respuesta. Para conversar está
  el CEO.
- **No transporta secretos.** Si necesitas una credencial, pídesela al humano por
  `orca-ask`; llegará como variable de entorno, sin pasar por un archivo del repo.
- **No garantiza atención.** Un `notice` puede no leerlo nadie nunca. Si necesitas
  que alguien actúe, es un `ask`, y entonces tú pagas el precio de esperarlo.

## 10. Ejemplo mínimo, de punta a punta

```bash
# A avisa a K9 de algo con lo que va a chocar.
orca-tell "El endpoint /v1/charges devuelve 402 en sandbox" \
  --to K9 --kind warning --file src/api/charges.ts

# A pregunta algo que lo bloquea, y espera.
ANSWER=$(orca-tell "¿Ya migraste la tabla de sesiones?" --to T1 --kind ask --wait)
echo "T1 dijo: $ANSWER"

# K9, entre turnos, mira su buzón y contesta lo que le toca.
orca-read
orca-tell --reply msg_c27a8e9c5dd2b6a1 "Sí, anoche. La vieja ya no se usa."
```
