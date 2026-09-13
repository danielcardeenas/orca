# Diagnóstico: la pregunta que nunca llegó al líder

**13 de septiembre de 2026 · camino B del squad `forge-buzon-01` · AG**
**Sólo diagnóstico: no se ha tocado una línea de producción.**

---

## Resumen en cinco líneas

1. **No es un fallo de entrega: es un fallo de recogida.** Un agente que corre
   dentro de un `git worktree` escribe sus mensajes en un buzón de salida que
   **nadie vigila jamás**. El fichero se queda en disco para siempre.
2. **Hay 13 mensajes perdidos en disco ahora mismo**, de hoy, entre las 08:41 y
   las 09:06, incluidas **tres respuestas a `ask`** y el handoff final de un
   líder. Nunca existieron para ORCA.
3. **El canal es sordo y mudo en las dos direcciones**: lo que el hub entrega a
   ese agente va al `.orca/in/` del checkout principal, y su `orca-read` mira el
   del worktree, que está vacío.
4. **`orca-tell` devuelve «éxito» por haber escrito en algún sitio.** Dice
   `sent: tell_xxx` en cuanto renombra un fichero en su propio disco. No sabe —
   ni puede saber — si alguien lo recogió.
5. **Hay un segundo fallo, independiente y tan grave**: el `.orca/in/` es
   **uno por proyecto, no por agente**, el fichero depositado **no dice a quién
   iba**, y `orca-read` **no filtra por destinatario**. El primer agente que lee
   se lleva el correo de todos los demás. *Yo mismo marqué leída esta mañana una
   de las dos preguntas que motivan esta misión.*
6. **La pista que todo el mundo ha estado siguiendo es falsa.** El aviso
   `no pude escribir el buzón de entrada` (288 veces en siete días) **no pierde
   ningún mensaje**: es una carrera cosmética de escritura que he reproducido
   cinco de cinco veces. Envenenó el diagnóstico previo.

Los dos fallos reales producen el mismo síntoma —`nothing new`— y se tapan
mutuamente. Por eso nadie los había separado.

---

## 1. Dónde se pierde: el camino completo de un mensaje

### El camino, paso a paso

| # | Quién | Qué hace | Dónde |
|---|-------|----------|-------|
| 1 | el agente | `orca-tell … --to squad:X` | — |
| 2 | `orca-tell` | calcula la raíz con `git rev-parse --show-toplevel` | `bin/orca-tell.mjs:122-133` |
| 3 | `orca-tell` | escribe `.tmp` + `rename` en `<raíz>/.orca/out/<id>.json` | `bin/orca-tell.mjs:185-195` |
| 4 | `orca-tell` | **imprime `sent:` y sale con 0** | `bin/orca-tell.mjs:197-206` |
| 5 | collector | vigila `<project.path>/.orca/out` y recoge | `src/collector/messages.ts:205-221` |
| 6 | collector | valida, emite al hub, **borra el fichero** | `src/collector/messages.ts:247-299` |
| 7 | hub | resuelve el escuadrón sobre la flota entera | `src/hub/server.ts:1538-1553` |
| 8 | hub | un `deliver` por destinatario, y lo da por entregado | `src/hub/server.ts:1618-1621` |
| 9 | collector | resuelve el cwd del destinatario **desde el registro de proyectos** | `src/collector/commands.ts:1408-1416` |
| 10 | collector | escribe `<project.path>/.orca/in/<id>.json` | `src/collector/messages.ts:445-457` |
| 11 | el destinatario | `orca-read` lee `<git root>/.orca/in/` | `bin/orca-read.mjs:110` |
| 12 | `orca-read` | escribe `<id>.read` y **borra los caducados** | `bin/orca-read.mjs:139-142, 186-193` |

Los pasos **2 y 11** usan el **git root real del agente**. Los pasos **5 y 9**
usan el **`project.path` del registro**. Cuando el agente corre en un worktree,
**esos dos valores son distintos**, y el canal se parte por los dos extremos.

### El punto exacto de pérdida

`src/collector/projects.ts:177-215`, en `ensure()`:

```ts
const slug = foldWorktreeSlug(rawSlug);                    // :179  el worktree se dobla sobre su padre
const hint = matchesSlug(cwdHint, slug) ? cwdHint : null;  // :181  …y por eso el cwd real se DESCARTA
```

`foldWorktreeSlug` (`src/collector/projects.ts:48-51`) corta el slug por
`--claude-worktrees-`, así que
`-Users-…-orca--claude-worktrees-forge-lote-01` se pliega a
`-Users-…-orca`. Acto seguido `matchesSlug` (`:297-300`) compara
`pathToSlug(cwd)` con **el slug ya plegado**: nunca coinciden, `hint` queda
`null`, y `project.path` se queda siendo el checkout principal. Confirmado
contra el hub vivo (`GET /api/world`): existen dos proyectos, y el de ORCA
tiene `path: /Users/danielcardenas/projects/orca`. Ningún worktree figura como
proyecto.

El plegado es **deliberado y correcto** para lo que se escribió — el comentario
de `:33-45` lo explica: sin él, cinco agentes de fondo partían la flota en cinco
islas. El daño colateral no es la atribución, es que **cuatro buzones viajan
pegados a `project.path`**:

```
src/collector/index.ts:498-502    escalations · improveDrops · messages · artifacts · spawns
```

Con lo cual, para un agente en worktree:

- **`messages.track(p.id, p.path)`** (`src/collector/index.ts:500`) apunta
  `outDir` a `<principal>/.orca/out` (`src/collector/messages.ts:157`). El
  `.orca/out/` del worktree **no lo lee nadie, nunca**. → *pérdida total, sin
  error, sin reintento, sin huella.*
- **`cwdOf()`** (`src/collector/commands.ts:1408-1416`) devuelve el principal,
  así que `deliverTo` escribe en `<principal>/.orca/in/`
  (`src/collector/messages.ts:445-447`) — un directorio que el agente **no
  mira**. → *entregado a un buzón que nadie lee.*

### La prueba, en disco, ahora mismo

```
.claude/worktrees/forge-lote-01/.orca/out/   12 ficheros   08:41:59 – 09:06:24
.claude/worktrees/shots-lote-01/.orca/out/    1 fichero    09:05:33
.claude/worktrees/*/.orca/in/                 0 ficheros (el directorio ni existe)
```

Los trece llevan `"cwd": "…/.claude/worktrees/…"` dentro del propio payload.
Ninguno aparecía en `~/.orca/hub/events/2026-09-13.jsonl` como `message:new`.
Para ORCA **no ocurrieron**.

> **Nota de las 09:23, posterior a la medición.** Los trece fueron rescatados a
> mano —renombrados a `*.json.rescued` y reenviados— y entraron todos de golpe
> a las `09:23:21`, entre 17 y 42 minutos tarde. **Esto confirma el diagnóstico,
> no lo refuta**: ORCA no los recogió nunca por su cuenta; hizo falta que una
> persona o un agente fuera a buscarlos al disco. La medición de arriba es de
> las 09:15 y los ficheros `.rescued` siguen ahí como evidencia. Un mensaje que
> llega 40 minutos tarde, y sólo porque alguien lo rescató, es un mensaje
> perdido: los tres `ask` que contenía ya no desbloqueaban nada.

Entre ellos, con nombre y hora:

- `tell_mtz3a5jh647nr2.json` (08:42:06) — **respuesta al `ask` de CF**
  (`msg_aec1c8dbed2c768e`) diciéndole en qué árbol trabajar. Dos minutos después
  CF seguía esperando; a las **08:44:58** mandó *«Sin respuesta sobre el árbol:
  arranco en el checkout principal»* y tomó la decisión contraria a la que su
  líder ya había escrito. **Esa cadena está completa en los eventos del hub y
  es la demostración del coste.**
- `tell_mtz3a9oxgds3rk.json`, `tell_mtz3ac4vsex3qi.json` (08:42) — otras dos
  respuestas a `ask`.
- `tell_mtz45eep7ofz1f.json` (09:06:24) — el líder escribiendo *«Z0: leí tu
  entrega en disco (terminaste sin escribirme). Decido lo que preguntaste y no
  me llegó»*. **El mensaje en el que el líder describe el fallo también se
  perdió por el fallo.**
- `tell_mtz3x6o2dbqlih.json` (09:00:01) — el handoff de entrega de la puerta de
  archivos, al squad entero.

El emisor de doce de los trece es `fe66369f` = **HW, el líder de
`forge-lote-01`**. Estaba trabajando dentro del worktree. **Nada de lo que dijo
en 25 minutos salió de su disco**, y ni él ni sus tres miembros lo supieron.

---

## 2. Pérdida, o entrega sin lectura: son las dos, y son dos fallos distintos

El líder pedía distinguir tres cosas. Hay evidencia de dos de ellas, y son
independientes:

**(a) Nunca se deposita — PÉRDIDA REAL.** El caso de hoy. El fichero de salida
no se recoge porque el directorio no está vigilado. Nadie escribe nada en
ningún sitio. *Ésta es la que hay que arreglar.*

**(b) Se deposita donde el destinatario no mira — ENTREGA SIN LECTURA.** El
reverso del mismo desajuste: el hub cree que entregó, `world.markDelivered()`
(`src/hub/server.ts:1621`) lo registra, la consola lo pinta entregado, y el
fichero está en un directorio que ese agente nunca abre. Indistinguible desde
fuera de un agente que simplemente no lee su correo.

**(c) Se deposita y otro se lo lleva antes de que su destinatario lo vea —
CONFIRMADA, y es un segundo fallo independiente.** Ver §2 bis. No es un borrado:
es que **el buzón no es de nadie en particular** y el primero que lee tapa a
todos los demás. (El único borrado propiamente dicho lo hace `orca-read` con los
caducados, `bin/orca-read.mjs:139-142`, y sólo tras seis horas de olvido; un
`ask` nunca caduca por defecto, `src/collector/messages.ts:599-603`.)

---

## 2 bis. El buzón no está segmentado: el primero que lee se lleva el correo ajeno

Esto lo encontré al final, y es tan grave como lo del worktree.

**Un proyecto tiene UN solo `.orca/in/`, compartido por todos sus agentes.**
`deliverTo` escribe un fichero por mensaje en `<project.path>/.orca/in/`
(`src/collector/messages.ts:445-447`) — el mismo directorio para los diecisiete
agentes que ORCA tiene hoy en `orca`.

**El fichero depositado no dice a quién iba.** `inboxPayload`
(`src/collector/messages.ts:606-622`) serializa `from`, `fromAgentId`,
`fromProjectId`, `subject`, `body`… y **ningún campo de destino**: ni
`toAgentId`, ni `toSquad`, ni `scope` de destino útil.

**Y `orca-read` no filtra por destinatario.** `readItems()`
(`bin/orca-read.mjs:118-155`) descarta por extensión, por caducidad, por marca
`.read` y por `--kind`. **No hay una sola comparación con la identidad de quien
lee** — no podría haberla, porque el dato no está en el fichero.

**La marca de leído también es global**: `<id>.read`, una por mensaje
(`bin/orca-read.mjs:186-193`). El primer agente del proyecto que ejecute
`orca-read` **consume el correo de todos los demás**, y los legítimos
destinatarios ven `nothing new`.

### La prueba es esta misma sesión

Soy `AG`, del escuadrón `forge-buzon-01`. En mi buzón, leídos y marcados por mí
esta mañana, hay mensajes dirigidos a **`squad:forge-lote-01`** (al que no
pertenezco) y handoffs de `HW` dirigidos por callsign a **`CF`, `DA` y `Z0`**.
Entre ellos, `msg_f9d9f9a4066cf447`: **la segunda pregunta de Z0 a su líder
sobre tocar `test/files.test.ts`** — una de las dos preguntas que motivan esta
misión. **La marqué leída yo**, desde otro escuadrón, antes de que HW pudiera
verla.

Esto explica, mejor que ninguna otra hipótesis, el caso original de la propuesta
del tablero (*«el buzón de 2S dejó de recibir entregas del hub»*): no dejó de
recibirlas — **alguien se las leía primero**.

Y explica el diagnóstico equivocado que HW se hizo a sí mismo a las 09:23:
*«lo mandaste a squad:forge-lote-01 y un mensaje al squad no alcanza al propio
líder»*. **Eso es falso**: `routeMessage` incluye al líder si lleva la etiqueta
del escuadrón y sólo excluye al emisor (`src/hub/server.ts:1564-1566`). Lo que
pasaba es lo otro — HW estaba en el worktree, y encima el buzón es común.

Un fallo hace invisible al otro, y los dos producen el mismo síntoma:
`nothing new`.

### Y una cuarta cosa que NO es ninguna de las tres

`ORCA deliver: no pude escribir el buzón de entrada` — **288 veces en siete
días**, 22 de ellas hoy. Es la pista que siguió HV el 12 de septiembre
(`msg_a224fbdda7ab7cc5`: *«tu buzón no recibe mis envíos de squad, el hub dice
"no pude escribir el buzón de entrada"»*) y la que sostiene el diagnóstico
previo de la propuesta de automejora.

**No pierde ningún mensaje.** Es una carrera de escritura:

`writeAtomic` (`src/collector/messages.ts:631-643`) usa un temporal de **nombre
fijo**, derivado sólo del destino:

```ts
const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
```

`routeMessage` despacha **un `deliver` por destinatario**
(`src/hub/server.ts:1606-1620`), y todos los destinatarios del mismo proyecto
comparten el mismo `inDir` y el mismo `msg.id` — o sea, **el mismo fichero
destino y el mismo temporal**. El primero en renombrar se lleva el `.tmp`; los
demás fallan con `ENOENT` en el `rename` y devuelven `false`.

Reproducido en frío, cinco corridas de cinco, con una réplica literal de
`writeAtomic` (`Promise.all` de tres escrituras al mismo destino):

```
FALLO: ENOENT rename  ×2
resultados: [true,false,false] → 1 ok / 2 fallos     (5 de 5 corridas)
```

Cuadra al dígito con lo observado hoy:

| mensaje | destinatarios (miembros − emisor) | fallos en el feed |
|---|---|---|
| cualquiera a `squad:forge-lote-01` (DA, CF, HW, Z0) | 3 | **2** |
| los míos a `squad:forge-buzon-01` (BW, AG) | 1 | **0** |

El contenido llega igual: el fichero es uno solo y lo escribe el que gana. El
daño es de diagnóstico — **grita en el sitio equivocado y ha desviado dos
investigaciones**. Efecto secundario menor y real: los perdedores no se apuntan
en `delivered` (`src/collector/messages.ts:450-455`), así que el `readBy` de
esos destinatarios nunca se rellena.

---

## 3. El destinatario en mitad de un turno

- **Se acumula, no se sobrescribe.** Cada mensaje es un fichero con su propio
  id, derivado de ruta + instante (`src/collector/messages.ts:579-581`). Un
  líder que tarda veinte minutos encuentra los veinte mensajes al volver.
- **No hay ningún empujón.** El comando `deliver` **sólo escribe un fichero**
  (`src/collector/commands.ts:1271-1284`). No pega nada en el pane — eso lo hace
  `say`, que es otro camino (`src/collector/commands.ts:722-744`). Un agente
  sólo ve su correo si **él** ejecuta `orca-read`.
- **Un agente `idle` nunca lo ve.** `idle` no es terminal
  (`src/shared/types.ts:755`: sólo `done` y `dead` lo son), así que el hub
  entrega. Pero un agente `idle` está esperando a que le hablen: no va a
  ejecutar `orca-read` por su cuenta. El mensaje queda en disco indefinidamente.
- **Si termina la sesión con mensajes sin leer**, los ficheros se quedan ahí sin
  dueño. Nadie los barre salvo el propio `orca-read` de un agente futuro del
  mismo proyecto, y sólo si han caducado. Un `ask` sin caducidad queda para
  siempre. En el lado del hub, `forgetAgent` (`src/collector/messages.ts:558-566`)
  retira el `ask` del que **preguntó** cuando éste muere — pero nada retira ni
  reasigna el mensaje que el **muerto** tenía sin leer.
- Para el que pregunta con `--wait`, el reloj es de **60 minutos por defecto**
  (`bin/orca-tell.mjs:56`) y el bloqueo es real: yo mismo aparezco como
  `state: blocked` en el hub por el `ask` de esta misión.

---

## 4. Qué puede saber el emisor hoy: nada útil

**Sí: `orca-tell` devuelve «éxito» por haber escrito en algún sitio.** Lo digo
con esas palabras porque el líder lo pidió así, y porque es exacto:

```js
renameSync(tmpPath, finalPath);      // bin/orca-tell.mjs:187
…
console.log(`sent: ${id} …`);        // bin/orca-tell.mjs:202
process.exit(0);                     // bin/orca-tell.mjs:206
```

El `sent:` significa **«he conseguido crear un fichero en mi propio disco»**, y
nada más. No hay ninguna diferencia observable entre depositado, entregado y
leído. Los trece mensajes perdidos de hoy imprimieron `sent:` y salieron con 0.

Peor aún, **el hub tampoco lo sabe, y donde podría saberlo lo tira**:

- `routeMessage` hace `delivered.push(a.id)` **inmediatamente después de
  despachar** (`src/hub/server.ts:1618-1619`), sin esperar el ack del collector.
- El ack sí vuelve (`src/collector/index.ts:1739-1744`) y llega a `resolveAck`
  (`src/hub/server.ts:1408-1414`) → `ackTo(p.consoleId, …)`.
- Pero `routeMessage` despachó con `consoleId = null`, y `ackTo` empieza así:

```ts
if (!consoleId) return;              // src/hub/server.ts:1282
```

**Un `deliver` que falla se descarta en silencio en el hub.** El único rastro es
una línea de feed que escribe el collector por su cuenta
(`src/collector/index.ts:1745-1746`), con el texto `deliver: <detalle>` y **sin
id de mensaje, sin emisor y sin destinatario**: no permite reconstruir qué se
perdió ni de quién era. Es justo lo que se ve en los eventos.

Lo que sí funciona: `routeNewMessage` (`src/hub/server.ts:1628-1651`) sí grita
cuando **nadie** era destinatario, con `level: 'alert'` para un `ask`. Ese
camino está bien hecho. Por eso los cinco «sin entregar» de hoy sí son legibles.
El agujero es el otro: **entregado a alguien, y fallando**.

---

## 5. El histórico: esto pasa todos los días

Contado sobre `~/.orca/hub/events/*.jsonl`:

| día | `message:new` | `no pude escribir el buzón` | `sin entregar` |
|---|---|---|---|
| 09-07 | 25 | 81 | 1 |
| 09-08 | 995 | 0 | 37 |
| 09-09 | 518 | 38 | 12 |
| 09-10 | 163 | 39 | 18 |
| 09-11 | 10 | 0 | 5 |
| 09-12 | 57 | **108** | 12 |
| 09-13 | 18 | **22** | 5 |
| **total** | **1786** | **288** | **90** |

Dos lecturas, y son distintas:

- Las **288** son la carrera de `writeAtomic` (§2), ruido. Escalan con el tamaño
  de los escuadrones, no con la pérdida.
- Los **90 «sin entregar»** sí son mensajes que no llegaron a nadie, y **sí
  dejaron huella**. Un ejemplo de ayer, de `CN`: seis informes de trabajo
  terminado, seguidos, todos *«sin entregar — no había nadie a quien
  entregárselo»*.

**Y la pérdida del worktree no aparece en ninguna columna, porque es invisible
por construcción.** El único censo posible es contar ficheros huérfanos en los
`.orca/out/` de los worktrees, y eso sólo funciona mientras el worktree exista:
un worktree borrado se lleva los mensajes consigo sin dejar nada. Hoy son 13 en
dos worktrees. **No puedo saber cuántos hubo en los worktrees ya retirados** —
lo declaro como hueco, no lo estimo.

Lo que sí se puede afirmar: **cada squad FORGE que siga la costumbre del
worktree** (`docs/`, memoria del operador, y el propio brief de esta misión)
**pierde todo lo que su gente diga desde allí**. No es un caso raro: es el modo
de trabajo recomendado.

---

## 6. La propuesta del tablero: acierta en el síntoma, falla en el mecanismo

`imp_mty3dqoidjzcsyqv` — *«El buzón de un agente dejó de recibir entregas del
hub y nadie se enteró»*, abierta, `impact: medium`.

**Lo que acierta**, y hay que conservarlo: el efecto (las dos partes creen que
hubo conversación), el coste real (*«no es el mensaje perdido, es la decisión
que no se tomó»* — exactamente lo que le pasó a CF a las 08:44), y que la
recuperación depende de una costumbre y no del sistema.

**En lo que se equivoca**, y por eso el arreglo que sugiere no habría servido:

1. Su evidencia principal (*«el hub dice "no pude escribir el buzón de
   entrada"»*) es **la carrera cosmética**. Perseguirla no habría arreglado
   nada.
2. Pide **una señal de recepción** («que el emisor sepa si su mensaje fue
   leído»). Útil, pero llega tarde para el caso de hoy: **no hay nada que
   acusar recibo de**, porque el mensaje nunca entró en el sistema. Una señal de
   lectura sobre un mensaje que no existe no se dispara.
3. Su sugerencia de alcance («que una pregunta sin respuesta sea visible») es
   correcta como red de seguridad y **equivocada como primer arreglo**: cubre
   (b) y (c), no (a).
4. `impact: medium` se queda corto. Afecta a **todo el modo de trabajo FORGE**.

Sugiero al líder actualizarla con esto en vez de abrir una nueva: la clave
`buzon-de-agente-deja-de-recibir` ya tiene el historial y dos casos citados.

---

## 7. El arreglo obvio, dicho y no escrito

Como se me pidió: lo digo, no lo implemento. La forma la decide el líder.

**Lo mínimo que cierra el agujero de hoy** — que el collector vigile el buzón de
salida **donde el agente corre de verdad**, no donde vive su proyecto. El cwd ya
está disponible en el mismo punto donde hoy se descarta
(`src/collector/index.ts:493-509`: `d.cwd` está ahí, y el `else` ya contempla
el caso). `MessageWatcher.track` está indexado por `projectId`
(`src/collector/messages.ts:150-160`), así que admitir N directorios por
proyecto es un cambio de forma, no de concepto. Mismo argumento para
`deliverTo`: el destino debería salir del cwd del agente, no de `project.path`
(`src/collector/commands.ts:1408-1416`). **La atribución al proyecto padre no
hay que tocarla** — el plegado resuelve un problema real; lo que sobra es que
los buzones cuelguen de él.

**Lo mínimo que cierra el segundo agujero (§2 bis)**: que el fichero del buzón
diga a quién va. `inboxPayload` (`src/collector/messages.ts:606-622`) ya tiene
`msg.toAgentId` y `msg.toSquad` a mano y no los serializa; añadirlos es el
cambio pequeño. Con eso, `orca-read` puede descartar lo que no es suyo — pero
necesita saber quién es, y hoy no lo sabe: `bin/orca-read.mjs` no consulta
`whoami.mjs`, al revés que `orca-tell` (`bin/orca-tell.mjs:41`). **Mientras la
marca `.read` siga siendo una sola por mensaje, un filtro en la lectura no
basta**: haría falta o una marca por lector (`<id>.read.<agente>`) o un
subdirectorio por agente. Ésa es una decisión de forma, y es del líder.

**Un parche de una línea que quita 288 falsos positivos**: dar al temporal de
`writeAtomic` un sufijo único (pid + aleatorio), como ya hace
`src/collector/trust.ts:185` en este mismo repo. Es barato, es local, y
**despeja el feed para que el próximo fallo de verdad se vea**. No arregla la
pérdida; hace que dejemos de confundirla.

**Lo que haría el fallo imposible de repetir en silencio**: que `routeMessage`
espere el ack antes de dar un destinatario por entregado
(`src/hub/server.ts:1618-1621`), y que un `deliver` fallido pase por
`routeNewMessage`, que ya sabe gritar bien (`src/hub/server.ts:1628-1651`).

Los tres son independientes y se pueden decidir por separado.

---

## 8. Lo que no pude comprobar — huecos declarados

- **Cuántos mensajes se perdieron en worktrees ya borrados.** No hay censo
  posible: la pérdida no deja huella y el worktree se lleva la evidencia.
- **Cuántos mensajes se ha comido el agente equivocado (§2 bis).** El mecanismo
  está probado por lectura de código y por un caso vivo —el mío—, pero la marca
  `.read` no guarda **quién** leyó, así que el histórico no es reconstruible.
  Los 85 `.read` del buzón de `orca` no dicen de quién son.
- **Si el fallo se comporta igual con la flota en dos Macs.** Todo lo medido es
  de un collector, el de esta máquina. El hub es el único que ve las dos
  (`src/hub/server.ts:1538-1553`), y no he podido observarlo con dos.
- **Si un agente en worktree recibe `say`** (el otro canal, el que sí pega en el
  pane). `cwdOf` le afecta igual (`src/collector/commands.ts:719`), pero el pane
  se resuelve por otro camino y no lo he seguido hasta el final.
- **La causa del pico de 09-07 (81 fallos con sólo 25 mensajes).** No cuadra con
  la fórmula de la carrera; puede ser otra cosa. No lo he investigado.
- **No he ejecutado ninguna suite de ORCA**: no toqué código de producción, así
  que `npm test -- --changed` no tiene nada que elegir. El único código que
  escribí es la réplica de `writeAtomic` en el scratchpad, fuera del repo.

### Sin suite que lo cubra

`test/messages.test.ts` cubre bien la validación, el enrutado, el degradado y el
ciclo del `ask` (32 casos). **No hay una sola prueba** de:

- un emisor cuyo cwd es un worktree (que su `.orca/out` se recoja),
- dos `deliverTo` concurrentes del mismo `msg.id` en el mismo `inDir`,
- que el destino de `deliverTo` sea el directorio donde el destinatario lee,
- que un agente lea sólo lo suyo: hoy ninguna prueba pone **dos agentes** sobre
  el mismo buzón, que es justo la condición del fallo de §2 bis.

`test/worktrees.test.ts` existe pero mira el aterrizaje de ramas, no los buzones.
Las tres pruebas que faltan son exactamente las tres afirmaciones de este
informe, y las tres son baratas.

---

## Filtros que cubren este documento

```
npm test -- messages mail-wait worktrees
```

Ninguno de los tres cubre hoy lo diagnosticado aquí; se listan porque son las
suites que un arreglo tendría que ampliar.
