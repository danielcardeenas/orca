# Una escalación retirada ya no cuenta como pregunta sin respuesta · 2026-09-13

**Squad forge-vivas-01, propuesta `escalaciones-retiradas-cuentan-sin-respuesta`.**
Rama `forge-vivas-01` desde `main` @ `ad48def`. El diagnóstico está en
`docs/RECONOCIMIENTO-TABLERO-AUTOMEJORA-2026-09-13.md` (§4) y se confirmó entero.

## Lo que pasaba, medido

El diario sólo enganchaba `escalation:new` y `escalation:answered`. Una pregunta
que dejaba de existir sin respuesta (el agente siguió solo, el diálogo de permisos
cambió, el agente se fue, la sustituyó otra, caducó, alguien la descartó) no
escribía nada, y `stats()` la contaba en `unanswered` para siempre.

Sobre el diario real del operador (`~/.orca/hub/journal/`, sólo máquina real):

| | |
|---|---|
| Preguntas anotadas | 85 |
| Respuestas anotadas | 4 |
| Contadas como «sin respuesta» hasta hoy | 81 |
| De ellas, del 10-09 | 76 |

El 10-09 la máquina real retiró 68 escalaciones (`events/2026-09-10.jsonl`: 56
«Permission dialog changed», 8 «answered manually», 4 «no longer observable») y no
contestó ninguna. Es exactamente el día del bucle de permisos (`permiso-reescalado-cada-4s`),
y en el diario se leía como 76 preguntas desatendidas.

Y no era sólo el diario: el evento `escalation:withdraw` del mundo llevaba el
motivo en prosa y **nada más** —ni el id de la escalación ni el agente—, así que
aunque el diario lo hubiera escuchado no habría podido casarlo con la pregunta.
Además, de los seis caminos por los que el mundo cierra una pregunta sin
respuesta, **cuatro no emitían ningún evento**:

| Cierre | Antes | Ahora (`cause`) |
|---|---|---|
| El collector la retira (agente siguió, sesión terminó, contestada en terminal) | evento sin id | `agent` |
| El collector retira un diálogo de permisos (pantalla cambió, diálogo desapareció) | evento sin id | `permission` |
| El agente sale del mundo (`dropAgent`) | evento sin id | `gone` |
| La sustituye otro diálogo de permisos del mismo agente (`upsertEscalation`) | **nada** | `superseded` |
| Caduca por `expiresAt` (`sweep`) | **nada** | `expired` |
| Caduca por desborde de la cola (`evictTerminal`) | **nada** | `expired` |
| Una persona la descarta desde la consola (`dismissEscalation`) | **nada** | `dismissed` |

La causa se deduce de lo que el hub sabe (si la escalación era de permisos, quién
la cierra), nunca del texto del motivo, que es prosa del collector y se guarda tal
cual para leerla. `permission` va aparte de `agent` a propósito: es la clase que
engorda cuando el detector minta una escalación por cada cambio de pantalla, y
sólo se ve si se cuenta.

## Lo que cambia

- `src/shared/types.ts`: `WithdrawCause` y `WITHDRAW_CAUSES`, junto a `EscalationStatus`.
- `src/hub/world.ts`: un único `closeEscalation(e, status, cause, reason)` por el
  que pasan los seis cierres. Fija el estado, publica el registro y emite
  `escalation:withdraw` con `agentId`, `projectId` y `data: { id, cause, reason }`
  (`WithdrawData`). Idempotente: una escalación ya cerrada no se anota dos veces.
  Efecto colateral deliberado: `dismissEscalation` ya no vuelve `withdrawn` una
  escalación `answered` o `expired`.
- `src/hub/lifecycle.ts`: evento tipado `escalation:withdrawn` (`EscalationWithdrawn`).
  Un evento viejo sin `data` se traduce con causa `agent`, que era lo único que
  existía entonces.
- `src/hub/journal.ts`: entrada nueva `kind: 'withdraw'` con `escalationId`,
  `question`, `cause`, `reason` y `waitedMs`, casada con la pregunta por id y, sin
  id, por agente (como la respuesta); se escribe aunque no encuentre la pregunta
  abierta (hub reiniciado). `stats().escalations` pasa a `EscalationStats`:
  `withdrawn`, `withdrawnBy` (por causa) y `unanswered` = preguntadas en la
  ventana y ni contestadas ni retiradas dentro de ella. Las retiradas no entran en
  `avgWaitMs`: nadie esperó por una pregunta que dejó de hacer falta.
  `escalatedBriefs[].withdrawn` dice la causa cuando la pregunta se retiró.
- Los cuatro sitios que consumen el recuento, ahora con la misma regla y las
  mismas cifras:
  - `src/hub/improve.ts` (digest de AUTOMEJORA): `N asked · capcom answered A ·
    human answered H · W withdrawn (no answer was owed: permission 56, agent 12) ·
    U unanswered (asked in the window, still open) · avg wait`.
  - `src/agents/tools-journal.ts` (`journal_stats`, resumen y descripciones):
    `N escalation(s) (A answered, W withdrawn, U unanswered)`. El `journal` MCP
    acepta `kind: 'withdraw'` y compacta `reason` como compacta `question`.
  - `bin/orca.mjs` (`orca journal --stats`): `escalations N (capcom A, human H,
    withdrawn W, open U)`.
  - El JSON de `stats()` que devuelven `journal_stats` y el hub.

## Segundo hallazgo: los consumidores no se contradecían, pero no decían lo mismo

Los cuatro leían la misma `stats()`, así que las cifras coincidían; lo que no
coincidía era **qué cifra enseñaba cada uno**. El digest decía `unanswered`; el CLI
la llamaba `open`; el resumen de `journal_stats` sólo decía `asked` y callaba las
demás, así que CAPCOM, leyendo su propio resumen, no veía el número que el revisor
sí veía en el digest. Ahora los tres enseñan asked / answered / withdrawn /
unanswered con las mismas palabras.

## Sobre la propuesta de las 24 horas

`capcom-not-in-the-loop` afirma que CAPCOM «no contestó» en 24 h, y su evidencia
es `escalations: 0 asked · capcom answered 0 · human answered 0 · 0 unanswered`.
**Este defecto no la explica**: el defecto infla `unanswered`, y ahí es cero. Sus
ceros vienen de la ventana vaciada y del arnés, como ya dice el barrido (§10). La
que sí queda explicada entera por este defecto es la propia
`escalaciones-retiradas-cuentan-sin-respuesta`, cuya evidencia es el digest
`132 asked · 132 unanswered` con `0 owed an answer` en el mismo informe.

## Lo que no cambia

- **El histórico no se reescribe.** Las 76 del 10-09 siguen sin entrada `withdraw`
  en disco, porque el evento de entonces no llevaba id y no hay con qué casarlas.
  En cualquier ventana que incluya el 10-09 seguirán saliendo como `unanswered`;
  la ventana del digest es de 24 h, así que ya no las ve. Reclasificarlas a mano
  sería inventar una causa.
- **El collector no cambia.** El protocolo sigue mandando `escalation:withdraw`
  con motivo en prosa; la causa la pone el hub. Cuando el bucle de permisos se
  arregle (`permiso-reescalado-cada-4s`), la cifra `permission` del digest es la
  que debe bajar.
- **La UI no cambia**: nadie en `src/ui` consume el recuento.

## Verificación

- `npm run typecheck`: **sin errores en los ficheros de esta entrega**. El árbol
  compartido del squad tiene errores de otros miembros en vuelo
  (`src/collector/commands.ts`, `src/collector/index.ts`,
  `src/collector/provider-handoff.ts`, `test/affected.test.ts`); no son de aquí.
- `npm test -- journal`: 23/23, incluidas las dos pruebas nuevas:
  - *a withdrawn escalation is a withdraw entry with its cause: counted apart,
    never as unanswered, and every reader says the same*: por el ciclo de vida,
    cuatro preguntas, tres retiradas (dos `agent`, una `permission`, una de ellas
    con el evento viejo sin `data`), una abierta; afirma la entrada en disco, el
    `stats()`, la consulta por `kind`, `escalatedBriefs`, el resumen de
    `journal_stats` y la línea del digest.
  - *every way the world closes a question without an answer reaches the journal
    with its id and cause*: un `World` real cableado como en `server.ts`; los
    seis cierres llegan al diario con id y causa, una retirada repetida no se
    anota dos veces, y `unanswered` es 1.
- `npm test -- improve gestures`: 120/120 (las fixtures de `JournalStats` cambian
  sólo por el tipo).
- `npm test -- --changed` (108 suites, porque `shared/types.ts` llega a casi
  todo): **1291/1315, 24 fallos**, ninguno de esta entrega. 23 son de `Fresh
  CAPCOM` y `Provider handoff` («Nobody can furnish a fresh CAPCOM directory
  here», `src/collector/provider-handoff.ts:350`, edición en vuelo del relevo
  hermano en el mismo árbol) y 1 de `Affected suites` (`test/affected.test.ts:46`,
  con `test/affected.ts` modificado por otro miembro). Se corrió sobre el árbol
  compartido con esas ediciones a medias; conviene repetirla con el lote quieto.
  `Fleet journal`, `AUTOMEJORA`, `gestures`, `hub`, `permissions` y `synthetic`
  pasaron enteras, y la línea del CLI salió como `escalations 0 (capcom 0, human
  0, withdrawn 0, open 0)`.
- `bin/orca.mjs` sale como «sin suite que los cubra» por el grafo de imports; la
  prueba `orca journal` de `test/journal.test.ts` lo ejecuta como proceso y
  comprueba que `--stats` arranca por `launches` y trae la línea de excluidos, no
  las palabras nuevas.
- No se corrió ningún shot: no hay cambio de UI ni de CSS.

Filtros que cubren esta entrega: `journal`, `improve`, `gestures`, `synthetic`,
`permissions`, `hub`.
