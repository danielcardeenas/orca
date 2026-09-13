# Entrega — el buzón segmentado, el temporal único y el recibo del collector

**13 de septiembre de 2026 · AG · squad `forge-buzon-01`**
**Worktree `.claude/worktrees/forge-buzon-01`, rama `forge-buzon-01`.**
**Nada editado en `/Users/danielcardenas/projects/orca`.**

Las tres piezas del encargo (`docs/ENCARGO-AG-buzon.md`), hechas y verdes.

---

## (A) El buzón segmentado — el fallo 2

**El problema.** Un proyecto tiene UN `.orca/in/`. El fichero se llamaba
`<msgId>.json` y no decía a quién iba; la marca de leído era `<msgId>.read`, una
para todos. Con diecisiete agentes sobre el mismo checkout, **el primero que
corría `orca-read` se llevaba el correo de todos** y dejaba la marca en nombre
ajeno. Los destinatarios veían `nothing new`. Le costó tres mensajes al líder de
este squad en una mañana, el último dirigido a sí mismo.

**Lo que hay ahora.** La entrega es por destinatario:

```
<project>/.orca/in/<msgId>.<agente>.json     el mensaje, para ÉL
<project>/.orca/in/<msgId>.<agente>.read     su marca de leído, sólo suya
```

- `inboxStem()` (`src/collector/messages.ts`) compone el nombre; `deliverTo` lo
  usa para el fichero **y para la marca**, así que la marca queda por agente sin
  ningún mecanismo aparte.
- `inboxPayload` serializa además `to`, `toAgentId` y `toSquad`. Antes el
  payload no llevaba ningún campo de destino, y por eso `orca-read` no **podía**
  filtrar aunque quisiera: el dato no existía en disco.
- `reply()` escribe el eco en el buzón **de quien preguntó**
  (`inboxStem(msg.id, msg.fromAgentId)`) y borra su marca, no la de cualquiera.
- `orca-read` muestra sólo lo suyo: `mine(stem)` compara el destinatario del
  nombre con `sessionId()` de `lib/whoami.mjs`.

**Una decisión que me aparté de la letra del encargo, y por qué.** El encargo
decía que `readItems` filtrara «por la identidad de quien lee y su escuadrón».
El destinatario va en el **nombre del fichero**, y `orca-read` **no re-deriva el
escuadrón**. No hay `ORCA_SQUAD` en el entorno de un agente —lo comprobé— así
que el CLI tendría que reconstruir la pertenencia por su cuenta; y el hub ya la
resolvió al enrutar (`server.ts`, `routeMessage` filtra por `a.squad === squad`
y llama al collector una vez por agente). Que los dos lados respondan por
separado la misma pregunta es **exactamente la forma del fallo del worktree** de
esta misma mañana. Aquí se resuelve una vez, donde ya se resolvía.

Efecto secundario que sale gratis: un mensaje por destinatario elimina también
la carrera de escritura del punto (B) por este camino, porque ya no comparten
destino.

**Compatibilidad, que era la parte delicada.** Dos salidas, y las dos se
equivocan hacia enseñar de más, nunca hacia esconder:

1. **Un fichero sin destinatario se le muestra a todo el mundo**, como hasta hoy.
   Son los ~200 ya depositados, y a un mensaje entregado no se le puede inventar
   un destinatario a posteriori. Está escrito en el comentario de `inboxStem`,
   en el de `mine()` y en la ayuda de `orca-read`.
2. **Un lector que no sabe quién es lo ve todo.** `sessionId()` devuelve null
   cuando no puede saberlo, y un lector sin nombre no puede concluir que no hay
   correo suyo: eso convertiría un buzón compartido en uno vacío.
3. `--everyone` abre el buzón entero a mano, por si el filtro se equivoca. Un
   canal que se cae en silencio se arregla con uno que se pueda inspeccionar.

---

## (B) `writeAtomic` — el temporal único

`.{basename}.tmp` derivaba el nombre sólo del destino: correcto con un escritor,
y hay varios. Ahora lleva `pid` + azar, la misma forma que `trust.ts` ya usaba.

Eran **288 avisos en siete días** (22 el día 13) que **no perdían un solo
mensaje** — el fichero es uno y lo escribe el que gana la carrera — y que fueron
la pista que desvió dos investigaciones de una pérdida que estaba en otro sitio.
El comentario dice por qué el nombre era fijo y por qué ya no puede serlo.

---

## (C) El recibo, lado collector

`orca-tell` deja el recibo en `filed` y promueve solo el primer salto a `picked`.
Lo que sólo sabe el collector se anota ahora en `<project>/.orca/receipts/`, **la
ruta corregida** del encargo — no en `.orca/out/`, donde el `scan` se lo llevaría
como un mensaje inválido en el mismo tick.

- `rememberSender()` apunta, al recoger el fichero, dónde vive el recibo del
  emisor y con qué nombre. Es el único instante en el que se ven a la vez el
  `msg.id` del hub y el `stem` que el agente conoce.
- `noteReceipt()` escribe `delivered` (acumulando `recipients` por callsign),
  `undeliverable` (con el motivo en `detail`) y `read` (desde `sweepRead`, que
  ahora ve marcas por agente y por fin sabe **quién** leyó).
- **No escribo `picked`**: el emisor ya cierra ese salto solo.

Tres reglas sobre no mentir, y las tres están probadas:

1. **Sin recibo filiado aquí, no se escribe nada.** Un emisor en otra máquina
   tiene su recibo en el otro disco; aquí se queda en `picked`, que es la
   verdad. Un recibo que miente es peor que uno incompleto.
2. **`delivered` no se degrada a `undeliverable`.** Un mensaje al escuadrón
   puede llegar a tres y fallar con el cuarto: llegó, y el recibo dice a quién.
3. **`read` es el final**, y no vuelve atrás con la siguiente entrega de la
   misma tanda.

El mapa de emisores se poda por edad (24 h, el TTL del propio recibo) y por
tamaño (2000). Perder una entrada sólo cuesta un recibo que se queda en `picked`
— el modo en que este módulo ya se calla cuando no sabe algo con certeza.

---

## Verificación

```
npm run typecheck                    limpio
npm test -- --changed                333/333, 19 suites
npm test -- messages                 37/37
npm test -- buzon                    14/14
```

Todo desde el worktree. No corrí la suite entera (diez minutos, y la máquina
está con swap). No hay cambios de UI, así que no corresponde ni `npm run visual`
ni ningún shot.

**Pruebas nuevas** (6), y cada una es un fallo de hoy convertido en afirmación:

En `test/messages.test.ts`:
- `dos destinatarios, dos archivos: nadie se lleva el correo del otro`
- `un mensaje viejo sin destinatario sigue siendo de todos`
- `dos entregas a la vez del mismo mensaje no se pisan el temporal`
- `el recibo del emisor pasa a delivered, y acumula destinatarios`
- `sin recibo filiado aquí no se inventa ninguno`

En `test/buzon.test.ts` (ejecutan el `orca-read` de este árbol de verdad, en un
subproceso, sobre un buzón temporal):
- `an agent reads only its own mail out of the shared inbox`
- `reading marks it read for me alone, and the other agent still has hers`
- `a stranger still sees the mail that was never addressed to anyone`
- `--everyone still opens the whole shared inbox`

**Dos pruebas existentes actualizadas** al contrato nuevo, no desactivadas:
`la respuesta reaparece como no leída…` y `deliverTo escribe el buzón…` afirmaban
el nombre antiguo. Ahora afirman el nominativo, y la segunda comprueba además
que el payload lleva el destinatario.

### Lo que quedó sin cubrir, y lo digo

- **`npm test -- --changed` avisa `sin suite que los cubra: bin/orca-read.mjs`.**
  El aviso es correcto para el grafo de imports —nadie importa un CLI— pero el
  fichero **sí está cubierto**: las cuatro pruebas nuevas de `buzon.test.ts` lo
  ejecutan como subproceso. Lo escribo aquí para que «los tests pasan» quiera
  decir algo.
- **El fallback de identidad nula no tiene prueba de CLI.** Intenté montarla y
  descubrí por qué no se puede: `sessionId()` sube por el árbol de procesos
  (`whoami.mjs`, `fromProcessTree`) y encuentra el `--session-id` del proceso que
  corre la prueba, aunque se limpien `CLAUDE_SESSION_ID` y `ORCA_PANE`. **Es un
  dato útil por sí mismo**: en la práctica el fallback casi nunca se activa. La
  garantía que de verdad protegía a los ~200 mensajes antiguos —que lo
  no-dirigido sigue siendo de todos— sí está probada, con un lector que no es
  destinatario de nada.
- **Nada de esto se ha ejercido contra la flota viva**, a propósito: el hub y el
  collector de producción corren sobre el checkout principal y no lo he tocado.
  El cambio de nombre del buzón es visible para el collector en cuanto se
  mergee; los ficheros antiguos siguen leyéndose, que es justo lo que las dos
  pruebas de compatibilidad afirman.
- **`markDelivered` del hub sigue contando entregado antes del ack**
  (`src/hub/server.ts`), y `ackTo` sigue descartando el fallo cuando no hay
  consola (`server.ts:1282`). Estaba en mi diagnóstico como tercer arreglo
  posible, **no estaba en mi encargo y no lo he tocado**. El recibo tapa el
  agujero por el lado del emisor, que es lo que hacía falta hoy.

---

## Filtros que cubren este documento

```
npm test -- messages buzon
```
