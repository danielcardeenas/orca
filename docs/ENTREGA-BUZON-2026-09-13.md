# El buzón: por qué una pregunta no llegó y un spawn no contestó

**13 de septiembre de 2026 · squad `forge-buzon-01` · rama `forge-buzon-01`**

Dos caminos de mensajería fallaron en silencio el mismo día. La pregunta que
había que contestar antes de escribir una línea era si compartían raíz, porque
de eso dependía si había un arreglo o dos.

**Comparten una, y hay una segunda que sólo afecta a uno de ellos. Son dos
arreglos, no uno.**

---

## 1. La raíz común: un worktree desconecta a quien entra en él

Los seis CLI del canal de ficheros resolvían el proyecto cada uno por su
cuenta, con la misma línea copiada seis veces:

```js
git rev-parse --show-toplevel
```

Dentro de un `git worktree` esa línea devuelve **el worktree**. El collector
hace lo contrario: `foldWorktreeSlug` (`src/collector/projects.ts:48-51`)
**pliega** el worktree a su repo padre, y `index.ts:498-502` vigila
`<repo padre>/.orca/{out,in,spawn,ask,improve,artifacts}`.

Dos lados resolviendo lo mismo por separado, y discrepando. Un agente que hace
`cd` a un worktree escribe y lee en un directorio que nadie mira: **deja de
existir para la flota sin enterarse**, y sin un error, un reintento ni una
huella. Afecta a los seis caminos, no sólo a los dos que se denunciaron.

### La prueba, no la teoría

- **Camino A reproducido en vivo.** El `orca-spawn` de las 09:16 de esta misma
  misión quedó huérfano en `.claude/worktrees/forge-buzon-01/.orca/spawn/`, sin
  ack. Por eso el líder trabajó cuarenta minutos sin miembro.
- **Camino B, 15 mensajes huérfanos** en los worktrees de otros dos squads,
  entre las 08:41 y las 09:06, más dos publicaciones de `orca-show`.
- **Tres de esos huérfanos eran respuestas a `ask` bloqueantes.** Los tres
  `ask` habían llegado bien (`.orca/in/<id>.json` con su `.read` a las 08:40,
  escritos desde el checkout principal); el líder contestó a las 08:42 ya desde
  el worktree y ninguna respuesta salió. Sus tres miembros esperaron ~40 minutos
  una respuesta que existía, escrita, en disco. El contenido de las tres era
  «cd al worktree»: la orden que rompió el canal de todos ellos.

---

## 2. El segundo fallo, independiente: el buzón no es de nadie

Encontrado por **AG**, y no está causado por el worktree ni se arregla con él.
El diagnóstico completo está en `docs/DIAGNOSTICO-BUZON-2026-09-13.md`.

Un proyecto tiene **un solo `.orca/in/`, compartido por todos sus agentes**; el
fichero depositado **no dice a quién iba** (`inboxPayload` no serializa destino)
y `orca-read` **no filtra por destinatario** — no podría, porque el dato no
está. La marca de leído también es global. **El primer agente que ejecuta
`orca-read` consume el correo de todos los demás**, y los destinatarios
legítimos ven `nothing new`.

Confirmado dos veces, en vivo y sin buscarlo:

- AG marcó leída esta mañana, desde otro squad, una de las dos preguntas que
  motivan esta misión.
- El líder de este squad hizo lo mismo a las 09:41: un `orca-read` suyo se
  llevó un `warning` dirigido a AG y un `handoff` dirigido a otro miembro.

Los dos fallos producen el mismo síntoma —`nothing new`— y se tapan
mutuamente. Por eso nadie los había separado.

**Tercer hallazgo, de diagnóstico y no de pérdida:** `writeAtomic` usa un
temporal de nombre fijo, y un `deliver` por destinatario produce una carrera
que emite `no pude escribir el buzón de entrada` — 288 veces en siete días. No
pierde ningún mensaje: ha desviado dos investigaciones.

---

## 3. Por qué esto era peor de lo que parecía

El checkout principal es **producción**: el hub y el collector vivos corren
sobre él bajo `tsx watch` y se relevan al guardar. Hoy eso dejó una puerta de
denegación sin revisar activa en el hub durante una hora.

Y con el canal roto, **la única forma de que un squad aislado se comunicara era
operar en ese directorio**. No era sólo un canal perdido: era una trampa que
empujaba a la gente hacia el sitio peligroso. Mientras los seis CLI no estén
arreglados, **un worktree es una trampa**.

---

## 4. Lo que se ha hecho

### La raíz (hecho y verificado)

`bin/lib/project-root.mjs`, nuevo: pliega el worktree a su repo padre. **No es
una regla nueva** — es la misma que el collector ya aplica, puesta donde los
seis comandos la comparten. Un fallo así nace de que dos lados resuelven lo
mismo por separado; el arreglo es que haya un solo sitio donde se resuelva.

Dos reglas, en orden: primero el marcador `.claude/worktrees/`, que garantiza
coincidir con `foldWorktreeSlug` porque es la misma comprobación; después
`--git-common-dir` para cualquier otro worktree. Un submódulo no se pliega —
ahí `--git-dir` y `--git-common-dir` son el mismo directorio, y esa igualdad es
lo que los distingue.

Los seis CLI (`orca-tell`, `orca-spawn`, `orca-read`, `orca-ask`, `orca-show`,
`orca-improve`) pierden su copia de `projectRoot` y usan el módulo.

### Capa 1 — el emisor sabe qué pasó con lo que mandó

`bin/lib/receipt.mjs`, nuevo. Un recibo por mensaje en
`<project>/.orca/receipts/<stem>.json`, y `orca-tell --check <id>` lo consulta.
Lo que hace que sirva:

```
ausencia de recibo   nunca se envió
filed y ya viejo     NADIE LO RECOGIÓ  ← el fallo de hoy, ahora consultable
picked               el collector lo tiene
delivered            está en el buzón de N destinatarios
undeliverable        no llegó, y dice por qué
read                 alguien lo consumió
```

Un no-entregado deja de ser una **ausencia** y pasa a ser un **hecho**.

Dos decisiones que costaron una medición cada una:

- **Directorio propio y no `.orca/out/<stem>.receipt.json`**: el watcher de
  mensajes se lleva del buzón de salida todo `.json` que no acabe en
  `.answer.json`, así que borraba el recibo en el mismo tick en que se escribía.
  Duraba menos de un segundo.
- **El emisor cierra el primer salto solo**: si el mensaje ya no está en
  `.orca/out`, es que se lo llevaron, y el recibo se promueve a `picked` sin
  ayuda de nadie. Sin esto, el aviso saltaba en cada envío mientras el lado del
  collector no existiera — y un aviso que salta siempre es ruido que enseña a
  ignorar la línea. Se midió en vivo: tres mensajes entregados, tres avisos
  falsos.

### Capa 2 — una pregunta colgada se ve sola

Sección nueva en `briefing` (`src/agents/tools.ts`): **PEER QUESTIONS
UNANSWERED**, junto a los agentes bloqueados y las misiones que esperan.

`BLOCKED` mira a **quien espera**. Esta mira a **quien debe la respuesta**, que
es el único dato con el que CAPCOM puede hacer algo, y el que no aparecía en
ninguna parte. Si el destinatario ya no está vivo, la línea lo dice: esa
pregunta no la va a contestar nadie nunca.

El umbral son 15 minutos: más que un turno largo de CLI, menos que el rato en
el que la respuesta todavía sirve.

---

## 5. El fallo 2, cerrado (`2373856`)

El **fallo 2**, el **fallo 3** y el lado collector de la capa 1 los cerró **AG**
en su zona exclusiva, y están en la rama:

- La entrega es **por destinatario**: `<msgId>.<agente>.json` y su `.read` al
  lado. El destinatario va en el nombre y **no lo re-deriva el CLI**, porque el
  hub ya resolvió el escuadrón al enrutar — que los dos lados contesten por
  separado la misma pregunta es la forma exacta del fallo del worktree.
- Lo ya entregado sin destinatario (~200 ficheros) **sigue siendo de todos**:
  esconder correo que existe habría sido un fallo peor que el que se arregla.
- `writeAtomic` con temporal de pid y azar, como `trust.ts`.
- El recibo, lado collector: `delivered` con sus destinatarios, `undeliverable`
  con el motivo, `read` cuando aparece la marca — que ahora es por agente, así
  que `readBy` dice por fin **quién** leyó.

## 6. El cableado de los CLI, verificado en vivo por J8

`docs/verificacion-cli-j8.md`. Cubre el único hueco que quedaba declarado.

| CLI | en vivo | resultado |
|---|---|---|
| `orca-tell`, `orca-read`, `orca-show` | sí | plegaron al principal; el collector los consumió |
| `orca-ask` | sí | correcto |
| `orca-spawn` | **no, por decisión** | cableado correcto por lectura; verificarlo lanza un agente real, y con la máquina a 3,6 G de swap eso se escala, no se ejecuta |
| `orca-improve` | no | cableado correcto por lectura; mueve la cola de automejora |

**J8 corrige un dato de la primera versión de esta entrega, y tiene razón:** el
shim no es una copia, es un envoltorio de una línea que hace `exec node
<checkout principal>/bin/orca-<x>.mjs`. Así que el arreglo quedó activo para
toda la flota **en cuanto se fusionó a `main`**, sin reinstalar nada. Donde sí
importa la distinción es al medir antes del merge: invocando el nombre pelado
se mide el código del principal, no el del worktree.

### Un acoplamiento que conviene mirar

J8 estuvo **bloqueado esperando a CAPCOM porque `orca-ask` no está en su PATH**.
Comprobado: el perfil de shims `squad` monta `orca-read orca-recover orca-show
orca-spawn orca-tell` — **sin `orca-ask`**, que sólo está en `full`.

Es coherente con el diseño: un miembro escala a su líder con
`orca-tell --kind ask`, y es el líder quien usa `orca-ask`. Pero eso significa
que **la única vía de escape de un miembro pasa por el canal que hoy estaba
roto**. Cuando la ruta principal falla, no hay alternativa: el miembro se queda
esperando, que es exactamente lo que pasó. No lo llamo fallo porque el diseño
tiene su motivo, pero el acoplamiento es real y hoy costó tiempo.

## 7. Lo que esto desatascó

El arreglo de la raíz está en producción de código desde `69de31a`, y tuvo
efecto inmediato fuera de este squad: en el lote de siete, **cuatro agentes
habían quedado sordos por este mismo fallo**. Uno trabajó hora y media sin que
su líder viera nada y **se le dio por parado**; había entregado cinco arreglos.

Es el argumento de por qué esto no admitía un parche. El síntoma no era «faltan
mensajes»: era «este agente no hace nada», y la conclusión racional ante ese
síntoma es apagarlo. Un canal que falla en silencio no pierde mensajes, pierde
el trabajo de la gente y además hace que parezca culpa suya.

---

## 8. Verificación

```
npm run typecheck                      limpio
npm test -- --changed                  33 suites, 528/528   (la raíz y las dos capas)
npm test -- buzon messages traffic     68/68                (con el fallo 2 dentro)
```

**De extremo a extremo, contra el sistema real**, que es lo que de verdad
defiende este arreglo:

| qué | resultado |
|---|---|
| `orca-tell` desde el worktree, **código viejo** | aterrizó en `<worktree>/.orca/out/` — huérfano, nadie lo recogió |
| `orca-tell` desde el worktree, **código nuevo** | aterrizó en `<principal>/.orca/out/tell_mtz4vh9kmg1qr3.json`, y el collector lo drenó |
| `orca-tell --check <id>` | `filed` → `picked` solo, sin ayuda del collector |
| el aviso de varados | avisó de un envío real no recogido, en vivo, sin que nadie fuera a buscarlo |

El huérfano del código viejo se ha dejado intacto en
`.claude/worktrees/forge-buzon-01/.orca/out/` como el «antes» junto al
«después».

### El recibo, de punta a punta y en vivo

```
$ node bin/orca-tell.mjs --check tell_mtz7ztqqki2msy     (recién mandado)
filed 0s ago, waiting for the collector (normal for a few seconds)
$ …tras el siguiente envío, pasada la gracia
picked up by the collector 35s ago; delivery is out of this machine's hands
```

`filed → picked` **solo, sin ayuda del collector**: la ausencia del fichero en
`.orca/out` ya prueba que se lo llevaron. Seis recibos consecutivos, ni un falso
«no recogido».

### Lo que queda sin cubrir, dicho por su nombre

- **`delivered` y `read` no son observables en vivo todavía.** Están probados
  (`buzon`, `messages`), pero el collector de producción corre el `src/` del
  checkout principal, y ahí el lado collector del recibo aún no está: `grep`
  da 0 menciones en el principal frente a 18 en la rama. **Se verán en cuanto
  CAPCOM fusione**, no antes. El `picked` de arriba sí es real hoy porque lo
  resuelve el emisor.
- **`npm test -- --changed` avisa `sin suite que los cubra` para los seis
  `bin/orca-*.mjs`.** Son ejecutables y nadie los importa, así que el grafo no
  los alcanza. Su lógica está cubierta vía `bin/lib/`, y `bin/orca-read.mjs`
  lo cubren además cuatro pruebas de `buzon.test.ts` que lo **ejecutan** de
  verdad. El cableado de los seis lo verificó J8 en vivo (§6), con dos
  excepciones razonadas: `orca-spawn` y `orca-improve`, comprobados por lectura.
- **No se han corrido los shots.** No se ha tocado UI.
- **No se ha corrido la suite entera** (pasa de diez minutos, y la máquina está
  con 3,6 G de swap y cuatro agentes de otro squad trabajando).

---

## 9. Filtros que cubren este documento

```
npm test -- buzon                      la raíz, el recibo y la pregunta colgada
npm test -- messages                   la entrega por destinatario y writeAtomic
npm test -- briefing                   el informe de situación de CAPCOM
npm test -- worktrees workspaces       el plegado del lado del collector
npm test -- traffic squads             el canal agente ↔ agente
npm test -- --changed                  las suites que alcanza este cambio
```
