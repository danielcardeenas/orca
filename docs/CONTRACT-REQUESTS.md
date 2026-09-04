# Peticiones al contrato (`src/shared/`)

Cosas que el hub necesitó y que el contrato no dice, o dice a medias. **Nada de
esto se ha cambiado en `types.ts` ni `protocol.ts`** — el hub se acomodó a lo
que hay. Aquí queda anotado para decidirlo en frío.

Escrito por el agente del hub. Formato: qué falta · qué hice mientras tanto.

---

## 1. `rev`: contador de mutaciones vs. secuencia de frames  ⟵ el importante

`WorldState.rev` "se incrementa en cada mutación" y a la vez el protocolo dice
que en `{t:'patch', rev}` **rev debe ser exactamente el anterior + 1**. Las dos
cosas no pueden ser el mismo número: el bus colapsa una ráfaga de 30 mutaciones
en un solo frame, así que ese frame tendría que ser `rev+30` y la consola
detectaría un hueco y pediría resync sin parar.

**Mientras tanto:**
- `World.state.rev` cuenta mutaciones (+1 exacto por cada una). Es lo que
  reporta `/api/health` como `rev`.
- `PatchBus.rev` es la secuencia de publicación: +1 por frame emitido, sin
  huecos jamás.
- El `{t:'world'}` que recibe una consola va sellado con `PatchBus.rev`, así que
  desde el punto de vista de la consola el contrato se cumple al pie de la letra:
  mundo en rev N, luego N+1, N+2…
- `/api/world` devuelve la misma vista que ve una consola (rev de publicación).

**Petición:** o bien decir en `protocol.ts` que el `rev` del cable es una
secuencia de frames, o añadir a `WorldState` un campo aparte (`mutations`) y
dejar `rev` para el cable. Lo segundo es más honesto.

## 2. Códigos de cierre de WebSocket

El protocolo no define ninguno. El hub usa (y la consola debería reconocer):

| código | significado |
|--------|-------------|
| `4001` | token ausente o inválido |
| `4002` | versión de protocolo incompatible |
| `4003` | `hello` ausente o malformado |
| `4009` | otra conexión reclamó esa `machineId` (reconexión); no reintentar en bucle |

**Petición:** llevarlos a `protocol.ts` como constantes.

## 3. `escalation:answer` y `ceo:say` no llevan id de correlación

`ClientFrame` sólo permite acuse (`{t:'ack', cmdId}`) para `{t:'cmd'}`. Cuando
el humano responde una escalación desde la consola no hay forma de decirle
"llegó" o "la máquina está caída y no pude entregarla".

**Mientras tanto:** el hub aplica la respuesta al mundo (la consola lo ve por el
patch de la escalación) y por debajo emite un `{k:'answer'}` al collector con un
`cmdId` propio; el ack de ese comando se enruta a la consola que lo pidió, así
que llega igual, pero con un id que la consola no reconoce.

**Petición:** `{ t:'escalation:answer'; id; answer; rememberAs; cmdId?: string }`.

## 4. Clave de un `KeyDescriptor`

`{o:'key', id}` necesita un id y `KeyDescriptor` no tiene campo `id`; tiene
`name` + `projectId`.

**Mientras tanto:** el hub indexa por `` `${projectId}/${name}` ``. Está en
`world.ts`; la consola tiene que usar la misma convención.

**Petición:** o un `id` en `KeyDescriptor`, o dejar la convención escrita en
`types.ts`.

## 5. El feed sólo sabe crecer

`{o:'feed', v: FeedItem[]}` es un append. El hub recorta su copia a 500 (lo que
se cae va al log persistente), pero no hay ninguna op que le diga a la consola
"recorta". Si una consola lleva horas abierta, acumula todo.

**Mientras tanto:** el hub nunca manda más de 500 items en un frame y la consola
debe recortar por su cuenta a `MAX_FEED = 500`.

**Petición:** `{o:'feed', v, replace?: boolean}` o un `{o:'feed:trim', keep:n}`.

## 6. No hay op para `ceo.awaitingHuman` ni para los mensajes

`PatchOp` tiene `ceo:thinking` pero no `ceo:awaiting`. Y los mensajes viajan por
`{t:'ceo:message'}`, que no participa de la numeración de `rev`: una consola que
se reconecta y pide resync recupera los mensajes dentro del `{t:'world'}`, pero
un mensaje emitido justo entre el snapshot y el primer patch podría duplicarse.

**Mientras tanto:** los `CeoMessage` llevan `id`; la consola debe deduplicar.

**Petición:** `{o:'ceo:awaiting', v:boolean}` y decir en el protocolo que los
mensajes del CEO se deduplican por `id`.

## 7. `snapshot` no distingue "no hay agentes" de "no los miré"

Si un collector manda un `snapshot` con `agents: []` el hub asume que todo lo que
no aparece murió (los marca `dead`, sin borrarlos). Es la interpretación segura,
pero un collector con un bug de lectura de disco puede matar una flota entera en
la vista.

**Petición:** un `partial?: boolean` en el frame `snapshot`, o un
`{t:'snapshot:begin'|'snapshot:end'}`.

## 8. Métricas parciales en `{t:'agent', patch}`

`Partial<Agent>` implica que `metrics`, si viene, viene entero. En la práctica un
collector manda sólo los contadores que cambiaron.

**Mientras tanto:** el hub **funde** `metrics` en vez de reemplazarlo, así que un
patch con `{metrics:{tokensPerSec:40}}` no borra `costUSD`. Es lo que querrías,
pero conviene que esté escrito.

**Petición:** declarar `metrics?: Partial<AgentMetrics>` en el frame `agent`.

## 9. Respuestas a escalaciones de máquinas caídas

Si el humano responde una escalación cuya máquina está offline, el hub la marca
`answered`, la persiste y la recuerda, pero el agente nunca se entera (y para
entonces está en `dead`). No hay nada en el contrato para "respuesta pendiente de
entrega".

**Mientras tanto:** el ack a la consola sale `ok:false` con
`"máquina no conectada"`, pero la escalación ya figura como respondida.

**Petición:** un estado `answered_undelivered`, o que el collector pida al
reconectar las respuestas que se perdió.

---

# Peticiones del collector

Escrito por el agente del collector, contra Claude Code **2.1.260** en macOS.
Mismas reglas: `types.ts` y `protocol.ts` no se tocaron; el collector se acomodó.

## 10. `Command.permit` no es implementable hoy  ⟵ el importante

`{k:'permit', agentId, allow, scope}` promete contestar un prompt de permisos.
Claude Code 2.1.260 **no expone ninguna forma de hacerlo desde fuera del
proceso**: no hay subcomando (`claude --help` lista `agents`, `attach`, `logs`,
`rm`, `stop`, `respawn`, `auth`, `mcp`… y nada más), no hay archivo de control en
`~/.claude/jobs/<id>/`, y el prompt vive en el TTY de la sesión.

Peor: el bloqueo por permisos ni siquiera se puede *detectar* directamente. El
transcript no escribe una línea "estoy pidiendo permiso"; sólo se ve un
`tool_use` cuyo `tool_result` no llega nunca.

**Mientras tanto:**
- El collector infiere `block.kind = 'permission'` heurísticamente: un `tool_use`
  pendiente >90s, en una tool con guardia (`Bash`, `Edit`, `Write`, `Task`…), y
  con `permissionMode` fuera de `{auto, acceptEdits, bypassPermissions, plan}`.
  Es un buen indicio, no un hecho. Un `Bash` legítimamente lento en modo manual
  se marcará como bloqueado.
- `permit` responde **`ok:false`** con un detalle que dice qué hacer
  (`claude attach`, o relanzar con `--permission-mode`). Fallar explícito es
  mejor que fingir que se hizo algo.

**Petición:** o quitar `permit` del contrato hasta que el CLI lo soporte, o
declararlo `best-effort` para que la consola no ofrezca un botón que miente.

## 11. `Agent.block` no puede llevar las opciones que el agente ya ofreció

Cuando un agente llama a la tool `AskUserQuestion` — que es literalmente "le
estoy preguntando al humano" — el transcript trae la estructura completa:

```jsonc
{"questions":[{"question":"…","header":"Credencial","multiSelect":false,
  "options":[{"label":"Exportar CLOUDFLARE_API_TOKEN","description":"…"}]}]}
```

`Agent['block']` sólo tiene `{kind, summary, escalationId?, since}`. Las opciones,
que son exactamente lo que la consola querría pintar como respuestas de una
pulsación, no caben. `Escalation` sí las tiene, pero una `AskUserQuestion` no es
una escalación de ORCA: nadie escribió un archivo en `.orca/ask/`, y el collector
tampoco puede responderla (ver #10).

**Mientras tanto:** el collector pone la primera pregunta en `block.summary` y
tira las opciones. La consola sabe *qué* pregunta y no *qué puede contestar*.

**Petición:** `block.options?: string[]`, o permitir sintetizar una `Escalation`
de sólo lectura (`status: 'pending'`, sin canal de respuesta).

## 12. Un `Agent` no dice dónde vive

No hay `cwd`, `transcriptPath` ni `sessionId` crudo en `Agent`. El `id` que
inventa el collector para un subagente es `<session-uuid>#<agentId>`, así que ni
siquiera se puede reconstruir el sessionId con un split fiable desde la consola.

Duele en tres sitios: la consola no puede ofrecer "abrir el transcript", no puede
mostrar el comando de `claude attach` (para eso está `shortId`, pero sólo existe
en sesiones background), y el hub no puede deduplicar un agente que aparece desde
dos collectors por un directorio compartido.

**Mientras tanto:** `id` es `<sessionId>` para una sesión raíz y
`<sessionId>#<agentId>` para un subagente. Documentado aquí y en ningún otro
lado, que es exactamente el problema.

**Petición:** `sessionId: string` y `transcriptPath: string` en `Agent`.

## 13. `AgentMetrics.turns` y `.toolCalls` no pueden ser totales de la sesión

En esta máquina hay 2.8GB de transcripts y archivos de hasta 83MB. Contar los
turnos históricos exige parsear el archivo entero, y hacerlo con 539 sesiones al
arrancar es inviable. El collector lee la **cola** (hasta 4MB) y sigue en vivo.

Consecuencia: `turns` y `toolCalls` son *"observados desde que el collector se
enganchó"*, no totales. Para una sesión nueva coinciden; para una de 55 días, no.
`costUSD`, `inputTokens`, `outputTokens`, `linesAdded/Removed`, `apiDurationMs` y
`toolDurationMs` **sí** son totales, porque Claude Code los escribe ya agregados
en una línea `cost-state`.

**Mientras tanto:** el collector rescata el último `cost-state` con una búsqueda
del marcador hacia atrás a nivel de bytes (sin parsear), lo que da métricas de
costo exactas. Verificado: la suma de los 539 agentes da $5663.80, idéntico a un
barrido independiente del corpus. Pero `turns`/`toolCalls` siguen siendo parciales.

**Petición:** partir el tipo en `metrics` (total, autoritativo) y
`observed: {turns, toolCalls}` — o un `metricsPartial: boolean`.

Nota relacionada: **sólo 120 de 539 transcripts tienen `cost-state`**. Claude
Code lo escribe al final de la sesión, así que un agente vivo reporta
`costUSD: 0` legítimamente. No es un bug del collector; conviene que la consola
no pinte "$0.00" como si fuera un dato.

## 14. No hay forma de distinguir sesión raíz / subagente / agente de workflow

`Agent.background` distingue background de interactivo, y `depth > 0` implica que
alguien lo lanzó. Pero en disco hay tres cosas distintas:

```
<slug>/<session>.jsonl                                    sesión raíz
<slug>/<session>/subagents/agent-<id>.jsonl               subagente (tool Task)
<slug>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl agente de workflow
```

Un agente de workflow tiene `depth > 0` igual que un subagente normal, pero
pertenece a una ejecución de workflow que la consola querría agrupar. El
collector conoce el `workflowId` y no tiene dónde ponerlo.

**Mientras tanto:** el `workflowId` se queda dentro del collector. Los agentes de
workflow se ven como subagentes cualesquiera.

**Petición:** `kind: 'session' | 'subagent' | 'workflow'` y `workflowId?: string`.

## 15. `Machine.load.memPct` no significa lo mismo en macOS

`1 - freemem/totalmem` da **99.9%** en un Mac sano: macOS mantiene casi toda la
RAM ocupada con caché y memoria comprimida. Reportado tal cual, la barra de
memoria de la consola está siempre en rojo y no informa de nada.

**Mientras tanto:** el collector reporta el número honesto. `cpuPct` sí es útil
(se calcula por delta entre dos muestras de `os.cpus()`, y por eso el primer
frame lo manda `null`).

**Petición:** definir `memPct` como "presión de memoria" y dejar que cada
plataforma la calcule a su manera, o añadir `memPressure: 'normal'|'warn'|'crit'`.

## 16. `Command.spawn` no cubre lo que el CLI ya sabe hacer

`claude` acepta `--effort <low|medium|high|xhigh|max>`, `--agent <nombre>`,
`--add-dir`, `--allowedTools` y `--name`. `Command.spawn` sólo lleva `model` y
`permissionMode`. `--effort` en particular es la palanca de costo/calidad más
directa que existe y no se puede pedir desde la consola.

**Mientras tanto:** el collector usa `mission` como `--name` (para que
`claude agents` muestre algo legible) y ignora el resto.

**Petición:** `effort?: 'low'|'medium'|'high'|'xhigh'|'max'` y `agent?: string`
en `Command.spawn`.

## 17. `permissionMode` del contrato ≠ el del CLI

`Command.spawn.permissionMode` admite `'auto' | 'acceptEdits' | 'plan' | 'manual'`.
El CLI acepta esos cuatro **más** `bypassPermissions` y `dontAsk`.

**Mientras tanto:** el collector valida contra el conjunto del CLI (los seis) y
rechaza cualquier otra cosa antes de construir el argv. Un valor del contrato
siempre pasa; los dos extra son inalcanzables desde la consola.

**Petición:** alinear el union con el CLI.
