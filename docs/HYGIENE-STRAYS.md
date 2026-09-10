# Higiene — lo que ORCA dejó atrás en procesos

**Misión:** `mission_mtskpgjhmnn5sbqp`
**Estado:** implementado y verificado, incluida una corrida real contra la
máquina del operador. **Sin commit** (§8).

El canal de mensajes trunca, así que el informe íntegro es éste.

---

## 1. Qué cubría ya el repositorio

Antes de escribir nada, lo que había:

| Ya existía | Qué hacía | Qué NO cubría |
|---|---|---|
| `HygieneSampler` (`collector/hygiene.ts`) | Disco por categoría, volúmenes, CPU/memoria, crecimiento, y **candidatos** de disco. Mide procesos, pero **sólo los que ya conoce**: este collector y los agentes con pid en su liveness. | No descubre procesos. No sabe nada de Vite, ni de puertos, ni de entrypoints colgados. **No borra ni termina nada** — la primera entrega de higiene observa y previsualiza, y lo dice. |
| `hub/harness.ts` + `purge_harness` | **La única capacidad de matar procesos que había.** Reconoce tres programas del arnés y sólo los que apuntan a ESTE hub. | Sólo el arnés. Un Vite o un hub colgados no los ve. |
| `hub/liveness.ts` (`isLiveAgent`, `ghostReason`) | La doctrina: **la muerte exige evidencia positiva; la vida es el valor por defecto**. Permite al hub dar por terminado a un agente con un motivo. | Razona sobre el mundo del hub, no sobre los procesos de la máquina. |
| `shared/archive.ts` + `agents:archive` | Archiva agentes terminados, **ignorando a los vivos**, por ids o por filtro. | Hay que saber a quién archivar: nada detectaba al fantasma. |
| `transcripts:purge`, `stop`, `remove` | Borrar transcripts, parar una sesión, retirar una terminada. | Todas piden que alguien sepa ya qué está de más. |
| Ventana HYGIENE | Informe de disco + `SAMPLE NOW`. | Ninguna acción. |

**En una línea:** ORCA medía muy bien el disco y no miraba los procesos; podía
matar exactamente tres programas del arnés; y sabía archivar agentes que
alguien le nombrara, sin nada que los nombrara.

## 2. Qué se ha añadido

Una segunda mitad de la higiene: lo que ORCA cuesta en **procesos y puertos**.
Viaja en el mismo informe, por el mismo frame, en el mismo panel y en el mismo
reloj lento.

Cuatro clases de resto:

| | |
|---|---|
| `vite` | Un servidor de desarrollo **de este repositorio**, identificado por su **cwd** |
| `orca` | Un entrypoint de ORCA (`src/orca.ts`, `src/hub/server.ts`, `src/collector/index.ts`) |
| `pane` | Un pane de tmux cuyo programa ya salió, o cuyo pid no existe |
| `agent` | Un agente que sigue en el registro con evidencia positiva de que su proceso no está |

## 3. La regla, y por qué no basta con menos

**Matar exige evidencia positiva de orfandad; no matar es el valor por
defecto.** Es la asimetría de `hub/liveness.ts` aplicada a procesos: dejar vivo
un resto cuesta memoria y un puerto; matar uno vivo cuesta el trabajo de
alguien — y aquí «alguien» puede ser el servidor de desarrollo que el operador
tiene delante.

**Nada de esto basta por sí solo**, y ninguno entra en la decisión: llevar
mucho rato arriba · estar ocioso · no aparecer en un latido · tener un puerto
abierto. Hay una prueba que lo fija (`being old, idle or holding a port is not
evidence of anything`).

Se exigen **tres hechos comprobables a la vez**:

1. **Es nuestro.** Para un Vite, su **cwd** es este repositorio — nunca el
   nombre del programa. Hay un Vite en cada proyecto de la máquina, y
   `pkill vite` es exactamente lo que este módulo existe para no hacer. Un
   `vite.config.ts` abierto en un editor tampoco cuenta: se reconoce la **ruta
   dentro de `node_modules`**, no la palabra.
2. **ORCA lo lanzó y su dueño se fue** — un **lease** (§3bis). No «no tiene
   padre»: eso no es prueba de nada.
3. **Sigue siendo el mismo.** Pid **y hora de arranque** se comprueban otra vez
   con una lectura de `ps` **nueva** justo antes de terminarlo — y con ellos el
   lease y las protecciones. Un pid se reutiliza; matar por un pid leído hace
   un minuto es matar a un desconocido.

### 3bis. Por qué `ppid === 1` NO es abandono, y qué lo sustituye

La primera versión de esta entrega daba por abandonado a un proceso porque
estaba reparentado a init. **Es falso.** `nohup npm run dev &`, `setsid`,
`disown` y cualquier arranque deliberadamente desatendido dejan exactamente esa
firma en un proceso **perfectamente sano**, que puede estar sirviendo otra
consola en otro puerto. Ofrecer terminarlo era ofrecer matar el servidor de
alguien, y la única protección que había era el puerto de la consola propia.

No se arregla adivinando mejor: **no se puede saber si un proceso desconocido
sobra**. Se arregla invirtiendo la pregunta.

**El lease** (`src/shared/lease.ts`). Quien lanza algo lo apunta en
`~/.orca/leases/<id>.json`: qué se lanzó (pid **y** hora de arranque), desde
dónde, qué puertos sirve, y **quién lo lanzó**. Lo renueva mientras vive y lo
borra al salir limpiamente. Un lease sin borrar cuyo dueño ya no está **es** la
evidencia: significa que quien lo lanzó se fue de mala manera, que es
exactamente cuando quedan restos.

La regla queda así:

| situación | veredicto |
|---|---|
| sin lease | **`ambiguous`**. «ORCA no lanzó esto, así que no puede saber si sobra. Correr sin padre es lo que dejan `nohup`, `setsid` y `disown`.» |
| lease renovado hace poco | **`protected`** |
| lease caducado pero el dueño sigue vivo (pid + hora) | **`protected`** |
| lease caducado **y** dueño ido | **`orphan`** — el único caso con botón |

**La consecuencia, dicha en voz alta:** un Vite que alguien arrancó a mano, con
o sin `nohup`, **no es terminable desde aquí nunca**. Sólo lo es lo que ORCA
lanzó ella misma. Es menos capacidad y es la correcta.

**Quién escribe leases.** `tools/lease.mjs` envuelve un proceso y lo anota;
`npm run dev:ui` pasa ya por él, así que el Vite de `npm run dev` queda
recogible. Lo que se arranque fuera de ahí no lleva lease, y por tanto no se
ofrece. El intervalo de renovación está duplicado en ese fichero por ser JS
suelto, y hay una prueba que sostiene las dos copias.

**Otras consolas del mismo proyecto.** Se protege el **conjunto** de puertos en
los que hay una consola sirviendo ahora —el de este ORCA y el de todo lease
vivo—, no sólo el propio. Mirar únicamente el de uno mismo dejaba la consola
del vecino en la lista de lo matable.

**Al limpiar se revalida todo, no sólo el pid**: identidad (pid + hora), que el
lease siga caducado y sin dueño, y que el proceso no haya empezado a servir una
consola. Cualquiera de las tres lo devuelve a intocable, con el motivo.

Tres veredictos, y los tres se enseñan:

- **`orphan`** — cumple las tres. Lleva botón.
- **`ambiguous`** — es nuestro pero algo no encaja: cwd ilegible, padre vivo,
  sin hora de arranque, **o sin lease de ORCA**. **Se enseña y no se toca**, y
  el panel dice qué es lo que ORCA no puede saber en vez de fingir un
  diagnóstico.
- **`protected`** — reconocido y dejado en paz, **con el motivo**: el hub, el
  collector, ORCA misma, el Vite que sirve esta consola, el Vite de otro
  proyecto. Se listan a propósito: un panel que sólo enseña lo que va a matar
  no deja comprobar por qué lo demás se salvó, y esa comprobación es el único
  control real sobre una operación que termina procesos.

**Qué se protege explícitamente:** este proceso y su padre · el hub y el
collector · CAPCOM y todo agente vivo (sus pids entran como intocables) · el
Vite del puerto de esta consola · cualquier cwd fuera del repositorio · otras
máquinas (un resto sólo existe en una, y el comando lleva su `machineId`).

**El agente fantasma se RETIRA, no se mata.** No hay proceso que matar, y
fingirlo sería la única forma de hacer esto mal. La acción va por el flujo que
ya existía: `agents:archive` con sus ids, que ignora a los vivos por su cuenta.

## 4. Terminar, con educación y sin mentir

`SIGTERM` → espera 4 s → `SIGKILL` sólo si sigue ahí. Un Vite cierra su puerto
y sus watchers con `SIGTERM`; matarlo en seco deja a veces el socket ocupado,
que es justo el recurso que se quería liberar. Cada resultado dice lo que pasó
de verdad: `stopped` (con la señal que hizo falta) · `refused` (no pasó la
revalidación, con el motivo) · `gone` (ya no estaba: **no se finge** haberlo
matado) · `failed` · `retired`.

`dryRun` hace todas las comprobaciones y no manda ninguna señal.

## 5. Automatización: ninguna, a propósito

La política existente de higiene es explícita: *«this release observes and
previews»*, y `PROTECTED` existe para que nada recuperable sea candidato. Nada
en esta entrega termina un proceso por su cuenta: **el botón es la acción**. No
he añadido un `autoclean` ni una variable de entorno que lo encienda, porque
extender una política de «no borra nada» a «mata procesos solo» no es una
decisión que corresponda a esta entrega.

## 6. La corrida real, y lo que rompió

Contra el hub y el collector vivos del operador, con una sonda desechable: un
`node` de dos líneas en `~/projects/orca/.orca/strays-probe/node_modules/.bin/vite`,
lanzado por un shell que se va —así queda huérfano de verdad, no simulado— con
su cwd dentro del repositorio.

**Resultado:**

```
sonda plantada: pid 21658 (cwd ~/projects/orca/.orca/strays-probe)
sonda detectada como orphan/terminate
— clean — { ok: true, detail: "1/1 terminado(s)",
            data: [{ result: "stopped", signal: "TERM", detail: "exited on SIGTERM" }] }
sonda viva tras limpiar: false
no ofrecidos (y por tanto intactos): 5
  orca · src/orca.ts            pid=62467  → sigue vivo
  orca · src/orca.ts            pid=93251  → sigue vivo
  orca · src/collector/index.ts pid=13533  → sigue vivo
  orca · src/collector/index.ts pid=62457  → sigue vivo
  vite · :4478                  pid=62458  → sigue vivo
```

El Vite real del operador salió `protected` con el motivo *«this is the console
you are looking at»*, y los dos collectors con *«this is ORCA itself»*.

### Lo que la corrida rompió, y está arreglado

**27 agentes vivos marcados como fantasmas.** La primera versión daba por
fantasma a un agente `thinking` que el CLI no lista y que no tiene pid ni pane.
Contra la flota real eso fueron **27 agentes, todos vivos**, y por dos razones
que son la misma:

1. `pid === null` significa **«ORCA nunca supo su pid»** —lo normal en una
   sesión `--bg`— y no «su proceso no existe». Tratar la ausencia de dato como
   prueba de muerte es exactamente el error que `hub/liveness.ts` documenta.
2. Un collector **recién arrancado** no ha mirado la liveness de nadie: su mapa
   está vacío y toda la flota parece muerta. Y el collector se reinicia con
   cada edición bajo `tsx watch`.

Arreglado: un fantasma exige ahora **evidencia positiva** — un pid **conocido**
que no está en `ps`, o un pane que dijo tener y que no está en el servidor de
tmux — y no se afirma nada hasta que la liveness se ha mirado al menos una vez
(`livenessReady`). Tras el arreglo, la misma máquina: **0 fantasmas**, 9 restos
listados, ninguno ofrecido para terminar.

**Segundo hallazgo:** `sanitizeReport` del hub reconstruye el informe campo a
campo, así que descartaba `strays` en silencio. Ahora los valida como todo lo
demás —y con más cuidado, porque cada fila acaba en un botón que mata algo—:
un `verdict` desconocido no puede convertirse en `orphan` por descuido, y una
ruta absoluta no cruza porque lleva el nombre del operador.

**Tercero:** en macOS `/var` es un enlace a `/private/var`, y `lsof` devuelve
siempre la ruta real. Sin resolver enlaces, el cwd de un proceso y la raíz que
se le compara son dos cadenas distintas para el mismo directorio: el detector
no habría encontrado nada, **en silencio**. Salió en la suite contra procesos
reales, no leyendo el código.

## 7. Pruebas

**`npm run typecheck`** — limpio. **`npm test -- --changed` → 909/909**, 0 fallos.

**`npm test -- strays` → 32/32**, en dos suites.

`strays · what ORCA left behind` (22, con la salida de `ps` escrita a mano):
`ps` se lee a números · un Vite se reconoce por su ruta y no por la palabra
(`vim vite.config.ts` y `vitest` no cuentan) · los entrypoints se reconocen y
`test/*` se deja a su propia herramienta · un Vite de este repo reparentado es
huérfano · **un Vite de otro proyecto nunca es nuestro** · sin cwd legible es
ambiguo · con padre vivo es ambiguo · **ORCA nunca se ofrece a sí misma, ni a
su padre, ni a un agente** · el Vite de esta consola está protegido por su
puerto · sin hora de arranque no hay objetivo · **viejo, ocioso y con puerto
abierto sigue sin ser nada** · el resto de la máquina es invisible · los
huérfanos van primero · un pid reciclado se rechaza, y cuatro segundos de
deriva de reloj no son un reciclaje · **un Vite `nohup` de este mismo repo en
un puerto alterno NUNCA se ofrece** · un entrypoint de ORCA recibe la misma
prudencia que un Vite · **otra consola viva del mismo proyecto está protegida**,
no sólo el puerto propio · un lease fresco protege · un dueño que volvió
protege · un lease para un pid reciclado no autoriza nada · el intervalo de
renovación del escritor de leases y el del contrato coinciden.

`strays · against real processes` (10, **procesos de verdad y desechables**,
todo bajo un directorio temporal que hace de repositorio, así que la flota real
queda fuera de alcance **por construcción**): **sólo el que tiene lease con el dueño muerto se ofrece**: el que tiene padre
vivo, el `nohup` sin lease y el de otro proyecto, no —y el dueño muerto es un
proceso que existió de verdad y terminó, no un número inventado— · limpiar lo termina de verdad, y
el `dryRun` lo deja vivo · uno que ignora `SIGTERM` se escala a `SIGKILL` y se
dice · **un pid que murió entre el escaneo y el clic no se mata a ciegas** ·
**un pid reciclado se rechaza y el proceso sigue vivo** · limpiar algo que el
escaneo no ofreció se rechaza · **un agente callado no es un fantasma** · un
collector que no ha mirado no declara a nadie · un fantasma de verdad se retira
sin tocar ningún proceso · nada fuera del sandbox es objetivo.

**`npx tsx test/hyg-strays.shots.ts`** — pasa. Comprueba en el navegador que se
ven las tres clases con su marca, que **sólo lo huérfano lleva botón**, que
`CLEAN n` cuenta sólo huérfanos, que la evidencia se abre y se lee, que lo
protegido dice por qué, que el orden pone lo decidible arriba y que el informe
de disco conserva su sitio.

## 8. Archivos

**Sin commit**, en el árbol compartido con Q8.

**Nuevos (7):** `src/shared/lease.ts` (el contrato del lease) ·
`src/shared/strays.ts` (reglas puras) · `src/collector/strays.ts` (lecturas de
máquina y terminación) · `tools/lease.mjs` (el escritor) ·
`src/ui/styles/strays.css` · `test/strays.test.ts` · `test/strays-live.test.ts` ·
`test/hyg-strays.shots.ts`.

**Tocados, aditivo:** `shared/hygiene.ts` (`strays?` en el informe) ·
`shared/protocol.ts` (`strays:clean`) · `hub/hygiene.ts` (validación) ·
`hub/server.ts` (ruta por máquina, resumen, allowlist) ·
`collector/{index,commands}.ts` · `ui/windows/kinds/hygiene.ts` (**un bloque
nuevo al final del cuerpo**; no se tocó el encabezado, ni el resumen, ni
`SAMPLE NOW`, ni la leyenda, ni `machineBlock()`, ni `paint()`) ·
`ui/main.ts` (una línea de import) · `package.json` (`dev:ui` pasa por el
escritor de leases) · `test/visual.ts` (dos ganchos).

**Coordinación con Q8:** avisé antes de tocar `hygiene.ts`; contestó que no lo
tiene abierto y que adelante. **No se tocó** `window.css`, `hud.css`,
`sections.ts`, `missions.ts`, `mission-status.ts`, `windows/kinds/mission.ts`
ni `controls.ts`. Los estilos nuevos van en hoja propia por eso mismo.

## 9. Activación

- **Activo en cuanto el collector arranca**: el escaneo va con la muestra de
  higiene, en su reloj de diez minutos, y con `SAMPLE NOW`.
- **No hace nada por su cuenta.** La sección aparece sólo si hay algo que
  enseñar, y el botón es del operador.
- Sin `lsof` (o en Windows) el cwd no se puede leer y **todo sale ambiguo**:
  degrada a no ofrecer nada, que es el lado correcto.

## 10. Límites

1. **macOS y Linux.** En Windows `readProcs` devuelve vacío y no hay restos.
2. **El cwd depende de `lsof` en macOS.** Sin él, todo Vite es ambiguo. No hay
   una segunda vía «aproximada» a propósito: lo que no se puede identificar no
   se toca.
3. **Sólo se recoge lo que ORCA lanzó.** Un Vite arrancado a mano, con o sin
   `nohup`, nunca será terminable desde aquí — y un resto anterior a esta
   entrega tampoco, porque no tiene lease. Es deliberado: la alternativa era
   adivinar la intención de un proceso desconocido, y no se puede.
4. **No hay cota de tiempo entre revalidar y matar.** Se lee `ps` y se manda la
   señal en el mismo instante, pero un proceso puede morir y su pid reutilizarse
   en esa ventana. Es una carrera de microsegundos y no se puede cerrar sin
   `pidfd`, que no existe en macOS; queda dicho.
5. **Los agentes fantasma dependen de que ORCA conociera un pid o un pane.** Un
   `--bg` cuyo pid nunca se supo y sin pane no se puede declarar muerto — y eso
   es deliberado tras lo de §6.
6. **No se automatiza nada** (§5).
7. La corrida real terminó **una** sonda desechable. No se ha terminado ningún
   proceso real del operador, y el escaneo sobre su máquina no encontró
   huérfanos que ofrecer.
8. **La corrida productiva del §6 se hizo con la regla vieja** (`ppid === 1`
   bastaba). No se ha repetido: el arreglo está cubierto por fixtures contra
   **procesos reales** —incluido un `nohup` legítimo del mismo repo en puerto
   alterno, excluido, y un proceso con dueño muerto de verdad, elegible— y
   repetirla habría vuelto a terminar procesos en la máquina del operador sin
   añadir nada que esas pruebas no digan ya.

## 11. Cómo verificarlo

```
npm run typecheck
npm test -- strays                  las dos suites (26)
npx tsx test/hyg-strays.shots.ts    la sección, fotografiada
```

Filtros que cubren esta entrega: `strays`, `hygiene`, `collector`.
