# Reconocimiento: la puerta de archivos y los worktrees bajo `.claude`

Informe de sólo lectura. No se ha escrito, ejecutado ni creado nada en el
repositorio; este fichero es el único que he tocado, porque la sesión corre en
modo plan y es el único escribible. Si el informe debe quedar en `docs/`, hay
que copiarlo allí en una sesión que pueda escribir.

## Contexto

La puerta de archivos del hub rechaza con 403 toda ruta que lleve un segmento
`.claude` (`privatePath`, `src/hub/files.ts:146-154`, el segmento en la línea
149). Los worktrees de agente viven en `<proyecto>/.claude/worktrees/<nombre>`,
así que el trabajo aislado de un agente no se puede abrir desde la consola.
Con la política nueva —todo cambio en ORCA pasa por un squad FORGE— eso deja
sin ventana justo el árbol que importa mirar.

## Recomendación: **A**, con una salvedad de forma

**A**, permitir explícitamente `.claude/worktrees` y seguir negando el resto de
`.claude`, porque es la única de las tres que cubre también los worktrees que
**no** crea ORCA —y hoy ésos son todos— sin abrir ninguna clase de contenido
nueva: un worktree sólo contiene lo que git tiene versionado, mientras que la
raíz del proyecto, que ya se sirve, contiene además todo lo que no está en git.

La salvedad es de forma, y es la que decide si A es segura o es un agujero: el
permiso tiene que ser **posicional**, no una comprobación de subcadena. Es
decir: el segmento `.claude` deja de vetar *sólo* cuando el segmento siguiente
es `worktrees`, y todos los segmentos posteriores se siguen examinando con las
mismas reglas. Así `<proyecto>/.claude/worktrees/k9/src/x.ts` pasa, y
`<proyecto>/.claude/worktrees/k9/.claude/settings.json`,
`.../k9/.env` o `.../k9/.ssh/id_ed25519` siguen perdiendo. Un
`path.includes('.claude/worktrees')` haría lo contrario: convertiría cualquier
ruta que empiece ahí en territorio libre, incluida la configuración de un
agente anidado. La comprobación actual recorre segmentos
(`files.ts:147`, `parts.some(...)`), así que la forma posicional encaja sin
reescribir la función.

A tiene además dos consecuencias de fontanería que hay que hacer a la vez o la
puerta se abre y nadie la encuentra:

1. **El navegador no tiene puerta que pulsar.** `resolveServedDir` omite del
   listado toda entrada que `privatePath` excluya (`files.ts:310`), así que
   `.claude` no aparece en la raíz del proyecto, y el navegador sólo navega
   descendiendo por lo que lista (`FileNav`, `src/ui/windows/kinds/files.ts:53`;
   no hay campo para teclear una ruta). Con A tal cual, `.claude/worktrees/k9`
   sería servible y aun así inalcanzable desde BROWSE FILES. Hay dos salidas, y
   la segunda es mejor: listar `.claude` como directorio (que entonces sólo
   contendría `worktrees`), o abrir el navegador directamente en el worktree del
   agente, que la consola ya conoce —`Agent.worktree` viaja en el protocolo,
   `src/shared/types.ts:269-275`— y hoy no usa para nada (`grep worktree src/ui`
   sólo lo encuentra en una frase de la voz de CAPCOM). `openFilesAt` ya acepta
   una raíz arbitraria (`src/ui/main.ts:267`, `main.ts:1022`).
2. **`files:allow` empieza a funcionar sobre worktrees.** `FileRoots.allow`
   decide con el mismo `acceptableRoot` (`src/hub/file-roots.ts:81-83`), que a
   su vez llama a `privatePath` (`files.ts:141`). Hoy autorizar un worktree se
   rechaza con «esa carpeta no puede ser una raíz»; con A se aceptaría. Eso es
   deseable, pero conviene decidirlo a propósito y no descubrirlo.

Lo que **no** recomiendo, y por qué:

- **B** no cierra el problema. Ver el punto 1: la ubicación de los worktrees que
  hoy existen la decide el CLI, no ORCA. Mover los de ORCA arreglaría un caso
  que ahora mismo está apagado y dejaría el caso real en 403. Además rompería
  la alineación de la que vive `foldWorktreeSlug` (`src/collector/projects.ts:33-51`):
  los worktrees de ORCA producirían slugs que el pliegue no reconoce y cada uno
  volvería a aparecer como un proyecto fantasma en el campo, que es exactamente
  el síntoma que ese pliegue existe para quitar. Coste alto, cobertura parcial.
- **C** paga el precio grande por la ganancia pequeña. El veto por nombre de
  segmento es lo que hace que la puerta esté cerrada para nombres que nadie
  enumeró; sustituirlo por una lista de rutas concretas invierte la postura
  justo en la única puerta del hub que lee del disco a petición de un cliente.
  Y para el problema que nos ocupa no hace falta: `~/.claude` no es alcanzable
  hoy por otra razón —ninguna raíz puede caer ahí, porque `acceptableRoot`
  también pasa por `privatePath`— así que C no compra seguridad, sólo la cambia
  de forma. Sí hay un argumento legítimo detrás de C, pero es sobre la **otra
  mitad** de `privatePath` (los nombres de fichero, `files.ts:150`), no sobre el
  veto de segmentos; ver el punto 3.

## 1. Quién decide dónde se crea un worktree

Las dos cosas son verdad, y la que manda es la segunda.

**ORCA sabe crear worktrees, y en una ruta fija.** `WORKTREES_DIR =
path.join('.claude', 'worktrees')` es una constante de módulo
(`src/collector/worktrees.ts:52`), usada por `worktreePath()`
(`worktrees.ts:70-72`) y repetida literalmente en la línea que se escribe en
`.git/info/exclude` (`worktrees.ts:208`). **No es configurable**: no hay env ni
ajuste que la mueva; la única variable del módulo es `ORCA_WORKTREES`, y sólo
enciende o apaga la función (`worktreesEnabled`, `worktrees.ts:64-67`). El
spawn crea el worktree con `git worktree add` desde el propio collector
(`worktrees.ts:250-254`) y después lanza el CLI con `cwd` puesto en él
(`src/collector/commands.ts:522-524`, `commands.ts:532`). En ningún punto ORCA
le nombra al CLI una ruta de worktree: los argumentos que compone son
`--bg`, el prompt y los `opts` de permisos/modelo (`commands.ts:496-508`).

**Pero esa función está apagada, y los worktrees que existen los crea la
herramienta externa.** Tres evidencias:

- El collector vivo (PID 1749/1751, `node .../src/collector/index.ts`) no tiene
  `ORCA_WORKTREES` en su entorno: de sus 84 variables, la única `ORCA_*` es
  `ORCA_SUPERVISED=1`. Leído con `ps eww`, sin tocar el proceso.
- `docs/FORGE.md:112` lo dice explícitamente: «El worktree automático sigue
  dependiendo de `ORCA_WORKTREES`. Si está apagado, FORGE debe crear/verificar
  aislamiento antes de editar». Es decir: con la configuración de hoy, el
  aislamiento de un agente FORGE lo crea el agente con las herramientas del CLI.
- Y esos worktrees caen en el mismo sitio. `foldWorktreeSlug`
  (`src/collector/projects.ts:33-51`) existe precisamente porque `claude --bg`
  corre la sesión en `<proyecto>/.claude/worktrees/<nombre>/` y eso producía un
  proyecto fantasma por agente de fondo; el README lo documenta como propiedad
  de Claude Code, no de ORCA (`README.md:618-622`), y la ruta de ORCA se eligió
  para coincidir con ella a propósito (`worktrees.ts:13-15`, `README.md:513`).
  En el disco del operador hay un slug que lo confirma:
  `~/.claude/projects/-Users-danielcardenas-projects-orca--claude-worktrees-harness-proc-selection`.
  El nombre `harness-proc-selection` no lo pudo poner ORCA: ORCA nombra sus
  worktrees con un short id, un callsign, un nonce `cx-…` o el nombre del
  escuadrón (`commands.ts:522`, `commands.ts:594`, `commands.ts:662`, y `NAME_RE`
  en `worktrees.ts:55`). Es un nombre descriptivo elegido por el CLI.

**Conclusión sobre B:** ORCA controla la ruta de los worktrees que crea ORCA, y
podría moverlos. No controla la de los que crea Claude Code, que son los que
hay. B no es imposible —es implementable en una línea— pero no resuelve el
problema del brief.

## 2. Qué vive realmente bajo `.claude`

**En este repo** (`/Users/danielcardenas/projects/orca/.claude`) hay tres cosas
y ninguna es un secreto:

| qué | clase |
|---|---|
| `settings.json` (versionado, 136 B; claves `$schema`, `enabledPlugins`) | inocuo |
| `settings.local.json` (ignorado por `~/.config/git/ignore`; clave `permissions`) | inocuo, postura de permisos |
| `worktrees/` (vacío ahora mismo) | árbol de trabajo |

En un proyecto cualquiera hay además lo que pone `orca-install`:
`<proyecto>/.claude/skills/<nombre>/SKILL.md` y enlaces en
`<proyecto>/.claude/bin/` (`bin/orca-install.mjs:116`, `:132`, `:165`) — código
y documentación, inocuos. Los shims que ORCA pone hoy en el PATH del worker ya
**no** viven ahí: están en `~/.orca/shims/<perfil>/`
(`src/collector/shims.ts:88`).

**En la home del usuario** (`~/.claude`) la cosa cambia de clase por completo.
No he inspeccionado el contenido de ninguno de estos ficheros —dos intentos de
clasificarlos por dentro los bloqueó el clasificador del sandbox, y me parece
la respuesta correcta—, así que la clasificación es por lo que el propio código
de ORCA dice que son y por sus permisos en disco:

- **Sería grave servirlo por HTTP:** `projects/<slug>/*.jsonl`, los transcripts
  completos de cada sesión (`src/collector/watch.ts:6-7`) — todo lo que el
  operador y los agentes se han dicho, con lo que se haya pegado dentro;
  `history.jsonl` (0600), el historial de prompts; `file-history/` (0700),
  instantáneas de ficheros antes de cada escritura (`src/collector/verify.ts`
  las menciona como `file-history-delta`); `shell-snapshots/`, `session-env/`,
  `sessions/` (0700), `debug/` (0700), `daemon/` (0700) y `daemon.log`;
  `uploads/` (0700). Y, fuera del directorio pero en la misma familia,
  `~/.claude.json` (229 KB), donde vive la confianza por proyecto y la
  configuración de cuenta (`src/collector/trust.ts:19`, `trust.ts:68`).
- **Inocuo o casi:** `settings.json`, `skills/`, `plugins/`,
  `known_marketplaces.json`, `plans/`, `feedback/`, `ide/`, `downloads/`,
  `chrome/`, `telemetry/`, `stats-cache.json` (0600), `cache/`,
  `paste-cache/`, `backups/`, `jobs/<id>/state.json`
  (`src/collector/index.ts:2155`), `tasks/`.
- **Árbol de trabajo:** nada. En la home no hay worktrees; viven en los
  proyectos.

Dos cosas que importan para la decisión. Primera: **la puerta no alcanza
`~/.claude` hoy, y no por el veto de segmentos.** Las raíces servibles son
cuatro subcarpetas de `~/.orca`, las rutas de los proyectos del mundo, los
scratchpads, `ORCA_FILE_ROOTS` y lo autorizado a mano
(`src/hub/server.ts:2560-2572`); ninguna cae en `~/.claude`, y si alguien lo
intentara, `acceptableRoot` lo rechazaría dos veces (por ser ruta privada,
`files.ts:141`, y `file-roots.ts:78-83` para la variante autorizada). El veto de
segmentos es el cinturón, no la puerta. Segunda: **un worktree es menos
sensible que la raíz del proyecto que ya se sirve.** `git worktree add` hace
checkout de lo versionado; un `.env` sin versionar del proyecto no aparece en el
worktree, y si apareciera lo seguiría vetando la mitad de `privatePath` que mira
nombres de fichero.

## 3. Qué más atrapa hoy la regla

El veto por segmento (`files.ts:149`) cubre `.ssh .aws .azure .config .gnupg
.kube .claude .codex .docker .git`. Medido sobre los ficheros versionados de
este repo, el único segmento que dispara es `.claude`, una vez
(`.claude/settings.json`). Casi todos los demás son intención evidente. El que
no lo es: **`.config`**. Cada vez más repos guardan configuración propia en
`.config/` en la raíz (nextest, dependabot, herramientas varias) y eso no es un
almacén de credenciales; el veto lo confunde con `~/.config`. En los proyectos
del operador no encontré ninguno (`ls -d ~/projects/*/.config` sin
coincidencias), así que hoy es teórico.

El daño colateral real está en la **otra** mitad de `privatePath`, la de nombres
de fichero (`files.ts:150`), y es la que da a C su único argumento de verdad:

- `\.env(?:\..*)?` veta también `.env.example` y `.env.sample`, que se versionan
  a propósito y existen para no tener secretos.
- `secrets?(?:\..*)?` veta cualquier fichero cuyo nombre empiece por `secret` o
  `secrets` y siga con un punto: `secrets.md`, `secret.ts`, `secrets.test.ts`.
  Lo mismo `credentials(?:\..*)?` con `credentials.ts`.
- `.*\.(?:pem|key|p12|pfx|…)` veta cualquier `.key`, que en un Mac es también la
  extensión de una presentación de Keynote.

Nada de eso se vio en este repo (cero coincidencias sobre los ficheros
versionados), y no pude barrer los otros proyectos que el hub sirve: los dos
`find` por esos nombres los bloqueó el clasificador del sandbox. Lo anoto como
lectura del patrón, no como medida sobre el disco. **Para la decisión que se
informa esto no pesa a favor de C**: es un problema de la lista de nombres, se
arregla afinando esos patrones, y no tiene nada que ver con los worktrees.
Mezclarlo con esta decisión es agrandar el cambio sin necesidad.

## 4. Enlaces simbólicos

La comprobación **no** es solamente textual, y esto está bien resuelto. La
contención va en dos pasos (`containPath`, `files.ts:185-225`):

1. Se normaliza la ruta pedida y se comprueba `privatePath(lexical)`
   (`files.ts:192-193`) — antes incluso de mirar las raíces.
2. Se resuelve con `realpathSync` y se vuelve a comprobar
   `privatePath(real)` junto con la contención contra las raíces reales
   (`files.ts:219-223`).

Consecuencias, tal como están:

- **Un enlace que apunta dentro de `.claude` no se cuela.** Su ruta léxica está
  limpia, pero `realpathSync` la resuelve y el segundo `privatePath` la rechaza
  con 403 «la ruta apunta fuera de las raíces (symlink)». En un listado, la
  entrada aparece como `other` y no se abre (`files.ts:315-318`). Lo mismo vale
  al revés: un worktree alcanzado por otro camino —un enlace en la raíz del
  proyecto apuntando a `.claude/worktrees/k9`— tampoco se cuela hoy, porque el
  veto se aplica sobre la ruta real. Es decir: **hoy no hay forma de esquivar el
  403 con un enlace, ni a favor ni en contra.**
- Las raíces se endurecen igual: de cada raíz se acepta su forma canónica y sus
  alias de sistema comprobados en disco, se reexamina `acceptableRoot(realRoot)`
  y se exige que el dueño sea el mismo uid (`files.ts:197-212`). Una raíz que
  fuera un enlace hacia `.claude` se descartaría.
- El único detalle que conviene saber, no arreglar: el `node_modules` de un
  worktree es un enlace al del repo principal (`worktrees.ts:266-275`). Si se
  sirviera el worktree, ese enlace resuelve fuera del worktree pero dentro de la
  raíz del proyecto, así que pasaría la contención y se listaría como carpeta.
  Es el mismo `node_modules` que ya se sirve por la raíz del proyecto.

Que el veto esté respaldado por `realpath` es, de hecho, otro argumento contra
las soluciones «de atajo»: no sirve poner un enlace
`<proyecto>/.orca/worktrees/k9 → .claude/worktrees/k9`; la puerta lo resuelve y
lo rechaza igual. La única forma de abrirlo es cambiar la regla.

## 5. Qué cubre la puerta además del navegador

`privatePath` es privada de `files.ts` y no la usa nadie más. Se llega a ella
por tres sitios, todos en el mismo módulo:

- `GET /api/file` — el visor de un fichero (`server.ts:2583-2588`).
- `GET /api/dir` — el navegador de carpetas (`server.ts:2597-2602`).
- `acceptableRoot`, que decide qué puede ser raíz: `ORCA_FILE_ROOTS`, las raíces
  persistidas en `~/.orca/hub/file-roots.json` y el comando `files:allow` que
  el visor ofrece tras un 403 (`file-roots.ts:55`, `:81`;
  `src/shared/protocol.ts:158-160`).

Los dos endpoints exigen el token igual que el socket (`fileGate`,
`server.ts:2574-2581`). Así que abrir `.claude/worktrees` abre exactamente dos
sitios más el botón ALLOW, y nada más. Lo demás del hub que mueve ficheros no
pasa por aquí: los estáticos de la consola se confinan en `dist/` por su cuenta
(`server.ts:563-581`), y **los artefactos van por ID, no por ruta**: el hub
nombra un id y el collector es quien lee los bytes de una ruta que él mismo
registró (`src/collector/artifacts.ts:26-30`, `:414`).

Eso último tiene una consecuencia que conviene tener delante al decidir, porque
enseña que el veto no está protegiendo nada que no esté ya abierto por otra
puerta:

- **`orca-show` desde un worktree funciona hoy.** La declaración viaja por
  `<proyecto>/.orca/artifacts/<id>.json` y los bytes los sirve el collector, sin
  pasar por `privatePath`. (La detección *automática* de artefactos, en cambio,
  ignora todo directorio oculto del camino — `artifacts.ts:499-505` —, así que
  un png escrito dentro del worktree no se publica solo; hay que nombrarlo con
  `orca-show`.)
- **`verify:diff` ya devuelve el parche completo de un worktree.** `pickDir`
  acepta explícitamente `a.worktree.path` como cwd (`src/collector/verify.ts:678`)
  y sólo exige estar dentro de una raíz de proyecto conocida
  (`verify.ts:451-482`), que un worktree bajo `<proyecto>/.claude/worktrees/`
  cumple — está documentado como decisión en `verify.ts:22`.

Dicho de otro modo: desde la consola ya se puede leer el diff del worktree de un
agente y ver los artefactos que publica desde dentro; lo único que el 403 impide
es abrir sus ficheros. Como frontera de seguridad, la regla no está sosteniendo
una línea coherente; está sosteniendo una inconsistencia.

## 6. El 403 mudo

**Sí se puede distinguir, y de hecho el hub ya lo distingue; es la consola la
que tira la información.** Los tres motivos salen por el cable como cuerpo de la
respuesta (`text(res, r.status, r.reason)`, `server.ts:2586`):

- 403 «ruta privada excluida» (`files.ts:193`) — vetada por política.
- 403 «fuera de las raíces de proyecto conocidas» (`files.ts:215`).
- 403 «la ruta apunta fuera de las raíces (symlink)» (`files.ts:222`).
- 404 «no existe» (`files.ts:219`).

Lo que pasa es que `refusal()` ignora el cuerpo en el caso 403 y devuelve una
frase fija: `'OUTSIDE THE PROJECT ROOTS · the hub serves known projects, the
agents' scratchpad and folders you allow'`
(`src/ui/windows/kinds/file.ts:45-52`, usada también por el navegador en
`kinds/files.ts:156`). Para una ruta vetada por política esa frase es
**falsa**, y además el visor ofrece a continuación el botón `ALLOW <carpeta>`
(`file.ts:93-111`) que en este caso no puede funcionar nunca: `files:allow` pasa
por el mismo `acceptableRoot` y contesta «esa carpeta no puede ser una raíz»
(`file-roots.ts:81-83`). Ahí está el tiempo de diagnóstico que se perdió: la
consola dice el motivo equivocado y luego invita a un remedio imposible.

Sobre el riesgo de filtrar: no hay ninguno nuevo. Quien llega a este código ya
pasó el token del hub (`fileGate`, `server.ts:2575`), y el hub tiene un dueño,
no usuarios — es una decisión escrita (`files.ts:29-31`). Además la existencia
ya es distinguible por diseño para lo que cae dentro de una raíz: el doble paso
léxico/real existe justamente «para poder decir 404 y no 403»
(`files.ts:22-24`). Y el orden importa a nuestro favor: `privatePath(lexical)`
se evalúa **antes** de mirar las raíces (`files.ts:192-193`), así que una ruta
privada contesta lo mismo exista o no. Decir «vetada por política» no añade
ninguna señal que el cliente no tenga ya.

Arreglo, si se quiere separado de la decisión A/B/C: que `refusal()` deje de
descartar el cuerpo en 403 y que el botón ALLOW no se ofrezca cuando el motivo
es política y no raíces. Es cosmética con efecto real y no toca la puerta.

## Lo que NO pude comprobar

1. **Si Claude Code permite reubicar sus propios worktrees en local.** Leyendo
   el binario del CLI (2.1.270) alcancé a ver, entre sus cadenas, un ajuste
   `worktree` con un campo `location` descrito como «Directory under which
   Claude Code **Desktop** creates the worktrees of **SSH sessions** that run on
   this machine … instead of `<project>/.claude/worktrees`», y otro campo con un
   valor `'none'` que «lets background jobs edit the working copy directly». El
   siguiente intento de leer el esquema completo se quedó esperando un permiso
   que no se podía conceder y **no lo reintenté**. Así que: **no confirmado** si
   existe un ajuste que mueva los worktrees de un `claude --bg` o de
   `EnterWorktree` locales. Lo que sí está confirmado con el repositorio es lo
   que decide la recomendación: ORCA no nombra ninguna ruta al invocar el CLI
   (`commands.ts:496-532`) y su propia constante es fija y no configurable
   (`worktrees.ts:52`).
2. **Si algún proyecto del operador tiene ficheros inocuos que la mitad de
   nombres veta** (`.env.example`, `*.key`, `.config/`, `secret*.ts`). Los dos
   barridos por nombre los bloqueó el clasificador del sandbox. El análisis del
   punto 3 es lectura del patrón, no medida del disco.
3. **El contenido de lo que hay en `~/.claude`.** Lo clasifiqué por nombre,
   permisos y por lo que el código de ORCA dice que es cada cosa; no abrí
   ninguno. Dos intentos de inventariar variables exportadas en
   `shell-snapshots/` y `session-env/` fueron bloqueados, y me parece correcto
   que lo fueran. Si hace falta certeza sobre esa clasificación, tiene que
   mirarla una persona.
4. **Comportamiento en vivo del 403.** No levanté hub ni consola: el análisis
   del punto 6 es lectura de `server.ts`, `files.ts` y `kinds/file.ts`. Queda
   sin comprobar en la consola viva, que es exactamente la laguna que
   `docs/ENTREGA-RUTAS-PERMITIDAS-2026-09-09.md` ya declaró para el botón ALLOW
   («sólo pasó el typecheck»).

## Verificación

No corrí nada: no hay cambio que verificar y el encargo era de sólo lectura. No
se ejecutó `npm run typecheck` ni ninguna suite, no se creó ni borró ningún
worktree, y no se tocó ningún proceso en marcha (el collector y el hub sólo se
leyeron con `ps`).

Cuando se implemente lo que se decida, los filtros que cubren esta zona son:

```
npm test -- files file-roots worktrees hub commands
npm run shots -- file-browser          # el que ya documenta la regla, test/file-browser.shots.ts:36
npm run shots -- file-viewer
```

Un aviso sobre el primero: `test/file-browser.shots.ts:32-58` contiene hoy un
rodeo (`repoQueElHubSirve`) escrito precisamente porque el hub no sirve rutas
con `.claude` y el shot corrido desde un worktree pedía una carpeta imposible.
Si se adopta A, ese rodeo deja de hacer falta y el shot es el sitio natural para
probar que un worktree sí se lista.

Filtros que cubren esta entrega: `files`, `file-roots`, `worktrees`, `hub`,
`commands`; shots `file-browser`, `file-viewer`.
