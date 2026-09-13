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

## 5. Lo que NO se ha hecho, y quién lo tiene

El **fallo 2** (segmentar el buzón), el **fallo 3** (`writeAtomic`) y el lado
del collector de la capa 1 (`delivered` / `undeliverable` / `read`) están
repartidos a **AG**, en zona exclusiva suya: `src/collector/messages.ts` y
`bin/orca-read.mjs`. No los ha tocado nadie más.

Sin el fallo 2 arreglado, el correo sigue siendo del primero que lo lee.

---

## 6. Verificación

```
npm run typecheck                      limpio
npm test -- --changed                  33 suites, 528/528
npm test -- buzon                      10/10
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

### Lo que queda sin cubrir, dicho por su nombre

- **`npm test -- --changed` avisa `sin suite que los cubra` para los seis
  `bin/orca-*.mjs`.** Son ejecutables y nadie los importa, así que el grafo no
  los alcanza. Su lógica **sí** está cubierta a través de `bin/lib/` (las dos
  pruebas de plegado y las cuatro del recibo importan los módulos directamente);
  lo que no tiene prueba automática es **el cableado de cada CLI**: que cada uno
  de los seis llame de verdad al módulo. De `orca-tell` hay prueba en vivo; de
  los otros cinco, no. Está encargado a un miembro y **no estaba cerrado al
  entregar esto**.
- **No se han corrido los shots.** No se ha tocado UI.
- **No se ha corrido la suite entera** (pasa de diez minutos, y la máquina está
  con 3,6 G de swap y cuatro agentes de otro squad trabajando).

---

## 7. Filtros que cubren este documento

```
npm test -- buzon                      la raíz, el recibo y la pregunta colgada
npm test -- briefing                   el informe de situación de CAPCOM
npm test -- worktrees workspaces       el plegado del lado del collector
npm test -- traffic squads             el canal agente ↔ agente
npm test -- --changed                  las 33 suites que alcanza este cambio
```
