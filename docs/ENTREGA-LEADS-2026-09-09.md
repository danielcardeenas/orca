# Entrega — Líderes de misión: CAPCOM recibe resultados, no trabajo

**Fecha:** 2026-09-09
**Estado:** implementado y verificado (§5). Sin commit: el árbol lo comparten
varias sesiones y el operador decide cuándo.

Cuatro peticiones del operador, en sus palabras, y qué hay de cada una:

| Petición | Qué hay | Dónde |
| --- | --- | --- |
| 1. Separar a CAPCOM de las automejoras: otro agente hace el trabajo, CAPCOM sólo recibe resultados, ni testea | `IMPLEMENT` lanza un agente propio de ORCA como **líder** de la misión `AUTOMEJORA · …`; CAPCOM recibe un turno sólo cuando ese líder termina, para `report_mission` | `hub/server.ts` `improveSend`, `hub/improve.ts` `implement`, `shared/improve.ts` `implementerBrief` |
| 2. Los agentes se saltan al líder y hablan con CAPCOM | Un miembro con líder vivo **no despierta a CAPCOM ni escribe en la misión**: su fin va al líder. El líder es quien despierta a CAPCOM, con el resultado consolidado | `hub/wake.ts`, `hub/missions.ts` `observe` + `underLiveLead`, `collector/briefs.ts` |
| 3. Hablarle al líder de una misión COMPLETED no la devolvía a IN PROGRESS | La línea al líder pasa por el hub (`mission:say`), queda en la conversación y **reabre la misión** (`active`) | `hub/server.ts` `sayInMission`, `shared/protocol.ts` |
| 4. Al abrir una misión: qué es, qué se pidió, qué salió; conversación secundaria; que quede claro a quién se escribe | La ventana abre por **MISSION** (BRIEF · RESULT · WHAT CHANGED · FILES · MEDIA); CONVERSATION es la segunda pestaña y la única con caja; **una sola línea de salida**, con el destinatario escrito encima (`TO K1 · LEAD` / `TO CAPCOM · NO LEAD`) y sin selector | `ui/windows/kinds/mission.ts`, `ui/hud/missions.ts`, `ui/styles/window.css` |

---

## 1. Qué cambia para el operador

**Al pulsar IMPLEMENT en AUTOMEJORA** ya no le llega nada a CAPCOM. Se abre la
misión y en el campo aparece un agente nuevo, líder de un squad `auto-<id>`,
sobre el repo de ORCA, con el brief de la propuesta más cómo se verifica aquí.
La nota de la consola lo dice: `K3 is implementing it as mission … · CAPCOM
only gets the result`. Cuando el líder acaba, su último mensaje cae en la
misión, la ventana lo enseña en RESULT como `K3 · LEAD · NOT YET PUBLISHED BY
CAPCOM`, y CAPCOM recibe un turno con la instrucción de publicarlo y no rehacer
nada. Si no se puede lanzar (el repo de ORCA no está registrado como proyecto),
la misión queda escrita con una línea de ORCA que dice por qué.

**En un squad**, CAPCOM ya no se entera de cada miembro. Se entera del líder.
El brief de CAPCOM tiene dos párrafos nuevos —«A mission lead that finished» y
«An AUTOMEJORA mission»— que le dicen exactamente eso: publicar, no rehacer, no
relanzar. El brief del líder le dice que es también la puerta de entrada y que
no tiene que escribirle a CAPCOM: su último mensaje es el informe.

**En la ventana de una misión**, al abrirla —desde el panel o desde la cinta—
se ve la misión: encargo entero, resultado, cambios, ficheros, media. El pie
dice a quién iría una línea y ofrece `WRITE`; sólo en CONVERSATION hay caja, y
encima de la caja está escrito a quién va y qué va a pasar:

```
TO K1 · LEAD OF THIS MISSION
Goes straight to K1's session (leads auto-x7). Its answer lands in this
thread. CAPCOM is not involved until K1 reports. Sending reopens this mission.
```

Cada línea del hilo dice a quién fue (`YOU → K1`, `YOU → CAPCOM`) y quién
contestó (`K1 · LEAD`, `CAPCOM`, `ORCA`). No hay dos conversaciones: hay una,
y se lee quién habla con quién.

## 2. Diseño, y las decisiones que no son obvias

**El hub decide el destinatario, con la misma regla que la ventana enseña.**
`missionLeadOf` se movió de `ui/hud/mission-status.ts` a `shared/missions.ts`
para que el hub la use al recibir `mission:say`. Antes la ventana mandaba al
líder por `say` directo, sin pasar por la misión: por eso la misión no se
reabría (punto 3) y por eso la respuesta del líder no aparecía en el hilo.
Ahora las dos rutas escriben en la misión primero. Si el líder murió entre la
pintada y el clic, el hub va a CAPCOM y la consola avisa de que fue a otro sitio
del prometido.

**Una línea al líder no es deuda de CAPCOM.** Se guarda con `to: <leadId>`
(`MissionMessage.to`) y `missionDebt` la excluye de `humans`. Sin esto, el
tercer despertador (`[MISSION …] the operator has been waiting 4m`) le
recordaría a CAPCOM una pregunta que era para el líder, y `list_missions` la
listaría como `pending_human`. La deuda de CAPCOM sigue siendo lo que se le
dijo a él.

**Un miembro con líder vivo no habla con la misión.** `observe` lo salta
(`underLiveLead`), y `wake` le manda el aviso al líder en vez de encolarlo para
CAPCOM. La palabra del miembro sigue en CREW (`say` de la nómina) y en su
ventana; lo que ya no hace es disparar un turno del mando. `tellLead` se
extendió al `idle` asentado, porque un agente de Claude Code no termina: para,
y ese paro es lo que el líder necesita saber. Muerto el líder, todo vuelve a
como estaba: el miembro escribe en la misión y despierta a CAPCOM.

**CAPCOM sigue cerrando la misión.** Se consideró que el líder marcara
`completed` él mismo. Se descartó: `report_mission` es el único sello, y
«publicar el texto y marcar completada son la misma llamada» es lo que hace que
RESULT no mienta. Lo que cambia es el coste de ese turno: el prompt le dice que
el líder consolidó y verificó, y que su trabajo es publicar. Es «recibir
resultados», que fue lo pedido.

**El implementador no es hijo de CAPCOM.** `parentId: null`, como el revisor:
colgarlo del mando lo haría «suyo» en el linaje. Que despierte a CAPCOM al
terminar lo decide la misión a la que está atado (`bindSquad`), no el padre.
Lidera un squad de uno (`auto-<id>`) porque «líder de su squad» es lo que lo
hace líder de la misión, y eso es lo que le da al operador un destinatario en
la ventana y le quita a CAPCOM el trabajo.

**La pestaña MISSION conserva el id `results`.** El panel, la cinta y las
ventanas guardadas la piden por ese nombre; cambiar la etiqueta no obliga a
cambiar la clave.

## 3. Archivos

| Fichero | Cambio |
| --- | --- |
| `src/shared/missions.ts` | `MissionMessage.to`; `missionDebt` excluye `to`; `+missionLeadOf`, `+leadPrompt`; `missionResult.latest` (lo último de la flota tras la última palabra de CAPCOM) |
| `src/shared/protocol.ts` | `+{ t: 'mission:say' }`; `improve:send` documenta el ack nuevo (`launched` / `saved`, `callsign`) |
| `src/shared/improve.ts` | `+implementerBrief`, `+implementerSquad` |
| `src/hub/missions.ts` | `message(…, to?)`; `+underLiveLead`; `observe` salta miembros con líder vivo |
| `src/hub/server.ts` | `improveSend` async: misión + `implement` + `bindSquad`, línea de ORCA si falla; `+sayInMission` / `+sayInMissionToCapcom` (compartido con `ceo:say`); `case 'mission:say'`; el prompt a CAPCOM distingue «lead reported: publish, do not redo» de «worker results arrived» |
| `src/hub/improve.ts` | `+implement()` e `implementCommand` (squad + lead, sin `review`, sin padre); `ImplementOutcome` |
| `src/hub/wake.ts` | `+liveLeadOf`; miembro con líder vivo → `tellLead` (done, dead, idle asentado) y nunca `enqueue` |
| `src/collector/briefs.ts` | `leadBrief`: la puerta de entrada y el último mensaje como informe; `capcomBrief`: «A mission lead that finished» y «An AUTOMEJORA mission» |
| `src/ui/hud/mission-status.ts` | `missionLead` delega en `missionLeadOf` |
| `src/ui/hud/missions.ts` | la fila abre siempre MISSION; botones MISSION · CONVERSATION · CREW |
| `src/ui/hud/improve.ts` | `IMPLEMENT` en vez de `SEND TO CAPCOM`; la nota dice quién lo implementa |
| `src/ui/net/client.ts` | `+missionSay`; el eco de `mission:say` lleva `missionId` |
| `src/ui/windows/kinds/mission.ts` | pestañas MISSION · CONVERSATION · CREW; BRIEF; RESULT con lo no publicado; `outletFor` (una línea de salida, sin selector); `YOU → K1`; `LED BY K1` en la cabecera; envío por `missionSay` |
| `src/ui/styles/window.css` | `.mission-win__lead`, `.mission-win__to.is-lead`, `.mission-win__result--fleet` |
| `test/wake.test.ts` | miembro con líder vivo → líder (done e idle), líder → CAPCOM; líder muerto → el miembro despierta a CAPCOM |
| `test/missions.test.ts` | `observe` con líder vivo y con líder muerto; `missionDebt` con `to`; `missionLeadOf` en sus formas; `mission:say` sobre una COMPLETED la reabre y va a CAPCOM sin líder |
| `test/hud-missions.shots.ts`, `test/hud-mobile.shots.ts` | abre por MISSION; BRIEF primero; sin caja fuera de CONVERSATION; `WRITE`; `YOU → CAPCOM`; `TO CAPCOM · NO LEAD` |
| `docs/MISSIONS.md`, `docs/AUTOMEJORA.md` | secciones actualizadas |

## 4. Lo que no cambia, y lo que queda

- `ceo:say` con `missionId` sigue existiendo y va a CAPCOM: es lo que usa la
  línea de comandos global con una misión activa.
- Los alias `report_task` etc. no se tocan.
- **La respuesta del líder llega cuando para.** `observe` vuelca `lastSay` al
  pasar a idle/done; mientras trabaja, el hilo no cambia. Es el mismo mecanismo
  de siempre; lo nuevo es que ahora el hilo recibe la línea del operador y la
  respuesta en el mismo sitio.
- `test/improve-hub.test.ts` corre sin collector: `IMPLEMENT` no puede lanzar
  al implementador y cae en `saved` con su motivo, que es exactamente lo que la
  prueba de «una misión, enlazada, y el segundo clic negado» sigue cubriendo.
  El lanzamiento real se cubre por el mismo camino de spawn que el revisor
  (`improve-agent`), no se duplicó una máquina sintética para él.
- Sin suite unitaria: `src/ui/styles/window.css` y `src/ui/hud/improve.ts`
  (texto de un botón). Los cubren los arneses visuales.

## 5. Verificación

```
npm run typecheck                                   OK
npm test -- missions wake improve squads debrief mission-status briefing capcom
                                                    320/320
npm test -- --changed                               1120/1120
npx tsx test/hud-missions.shots.ts                  verde: abre por MISSION, BRIEF primero,
                                                    sin caja fuera de CONVERSATION, WRITE,
                                                    YOU → CAPCOM, TO CAPCOM · NO LEAD
npx tsx test/hud-improve.shots.ts                   verde, con IMPLEMENT
npx tsx test/hud-mobile.shots.ts                    §6, §6b y §6c (la ventana de misión y su
                                                    caja) en verde; falla después en §6d,
                                                    «other is 44x44 (0x0)»: el botón FRONT
                                                    oculto que añadió la cabecera de ventana
                                                    (`wm.ts`, `data-w-front hidden`) cuenta
                                                    como control de 0×0. Es de otra entrega
                                                    en vuelo, no de ésta; el arnés tiene que
                                                    saltar los `[hidden]`
```

## Validación

```
npm test -- missions wake improve squads debrief mission-status briefing capcom talk drafts
npx tsx test/hud-missions.shots.ts
npx tsx test/hud-mobile.shots.ts
```
