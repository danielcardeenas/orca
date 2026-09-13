# Entrega: la puerta de archivos abre los worktrees, y el 403 deja de mentir

Implementa lo que recomendó `RECONOCIMIENTO-PUERTA-ARCHIVOS-2026-09-13.md`
(opción **A** con la salvedad de forma) y arregla los dos defectos que ese
mismo informe documentó en la cara de la consola.

Árbol de trabajo: `.claude/worktrees/forge-lote-01`, rama `forge-lote-01`,
desde `d9aab2a`. Sin commit, sin push, sin merge: eso lo decide CAPCOM.

## 1. El permiso es posicional

`privatePath` (`src/hub/files.ts`) recorría los segmentos de la ruta y vetaba
cualquiera que se llamase `.claude`. Ahora ese segmento deja de vetar **sólo**
cuando el siguiente es `worktrees`, y todos los posteriores se siguen
examinando con las mismas reglas:

| ruta | antes | ahora |
|---|---|---|
| `<proyecto>/.claude/worktrees/k9/src/x.ts` | 403 | **se sirve** |
| `<proyecto>/.claude/worktrees/k9/.env` | 403 | 403 |
| `<proyecto>/.claude/worktrees/k9/.claude/settings.json` | 403 | 403 |
| `<proyecto>/.claude/settings.json` | 403 | 403 |
| `~/.claude/worktrees/…` | 403 | 403 |

La última fila es una decisión propia, no del informe, y es la única pieza que
añadí por encima de lo pedido. La excepción mira **dónde cuelga** ese
`.claude`, no sólo cómo se llama: en la home del hub no hay worktrees —los
pone el CLI dentro de cada proyecto— y ahí viven los transcripts de todas las
sesiones. Sin ese matiz, `files:allow` habría podido fijar
`~/.claude/worktrees/x` como raíz si alguien lo creara, y eso rompe en
silencio la invariante que el módulo tiene escrita en su cabecera («ni `~`,
ni `/etc`, ni el propio `~/.orca`»). Por eso `privatePath` recibe ahora
`home`, como ya hacía `acceptableRoot`.

Una comprobación de subcadena (`path.includes('.claude/worktrees')`) habría
hecho lo contrario que la posicional: convertir en territorio libre todo lo
que empiece ahí, `.env` y `.ssh` anidados incluidos. La diferencia está
probada, no sólo comentada: ver el punto 4.

## 2. Dos consecuencias, hechas a propósito

**El navegador ya tiene puerta.** `resolveServedDir` omite del listado lo que
`privatePath` excluye, así que `.claude` sigue sin aparecer en la raíz del
proyecto —y así debe ser— y el navegador sólo desciende por lo que lista: sin
nada más, el worktree sería servible e inalcanzable. La salida es la que
recomendaba el informe: **abrir el navegador directamente en el worktree del
agente**. `Agent.worktree` ya viajaba en el protocolo y no lo usaba nadie.

- `Console.openWorktree(agentId, at)` (`src/ui/console.ts`, `src/ui/main.ts`),
  sobre el `openFilesAt` que ya existía. La ventana va **por ruta**, no por
  agente: un squad entero comparte worktree y abrirlo desde dos miembros tiene
  que ser la misma ventana.
- **BROWSE WORKTREE** en el menú de contexto de un agente (`src/ui/hud/context.ts`),
  tecla `w`, sólo cuando el agente tiene worktree.

**`files:allow` ahora acepta worktrees.** Decide con el mismo `acceptableRoot`,
que decide con el mismo `privatePath`. Es deseable —quien puede mirar ese
árbol puede fijarlo— y está dicho donde estaba escrito lo contrario, en la
cabecera de `src/hub/file-roots.ts`. Lo que no cambia: el resto de `.claude`
sigue sin poder ser raíz, ni `~/.claude`.

## 3. El 403 que mentía, y el botón que no podía funcionar

El hub distinguía cuatro motivos en el cuerpo de la respuesta desde siempre.
`refusal()` los tiraba y pintaba una frase fija —«OUTSIDE THE PROJECT ROOTS»—
que para una ruta vetada por política es **falsa**, y ofrecía debajo un
`ALLOW` que `files:allow` iba a negar con la misma comprobación que acababa de
negar la ruta. Ahí se fue el tiempo de diagnóstico de un shot en rojo.

- Los motivos tienen nombre y un solo sitio: `REFUSAL` en `src/hub/files.ts`.
- `refusalOf(status, body)` (`src/ui/windows/kinds/file.ts`) lee el cuerpo y
  devuelve la línea **y** si ALLOW puede hacer algo. `refusal()` se queda como
  la línea sola, que es lo único que necesita el navegador de carpetas.
- ALLOW se ofrece sólo en el motivo «fuera de las raíces». También lo quité
  del caso **symlink**, que el brief no pedía: autorizar la carpeta del enlace
  no mueve a dónde apunta, así que ese botón tampoco podía funcionar nunca.
  Un 403 que no reconocemos conserva el comportamiento de antes (se enseña el
  cuerpo y se ofrece ALLOW).

Decir la verdad no filtra nada nuevo: quien llega ya pasó el token, el hub
tiene un dueño y no usuarios, y `privatePath` se evalúa **antes** de mirar las
raíces, así que una ruta vetada contesta lo mismo exista o no.

La tabla de la UI es una copia del vocabulario del hub, no un import: este
módulo se empaqueta para el navegador y `hub/files.ts` trae `node:fs` detrás.
Las dos mitades las ata el shot, que importa `REFUSAL` y lo compara con lo que
sale en pantalla.

## 4. Verificación

Todo corrido en este worktree, y todo en verde:

```
npm run typecheck                         limpio
npm test -- files file-roots hub          77/77
npm test -- --changed                     427/427 · 8 ficheros → 33 suites
npm run shots -- file-browser             OK  21s
npm run shots -- file-viewer              OK  22s
```

La prueba que el cambio pedía y que no existía está en
`test/file-browser.shots.ts`, contra el hub de verdad y sobre un proyecto de
mentira que el propio fichero fabrica en un temporal (`arbolDeMentira`), para
no depender de dónde se corra:

- `/api/dir` del worktree → 200, y `/api/file` de `…/k9/src/dentro.ts` → 200.
- `…/k9/.env`, `…/k9/.claude/settings.json` y `<proyecto>/.claude/settings.json`
  → 403 **con motivo `REFUSAL.private`**, no el de raíces.
- `<fuera>/fuera.txt` → 403 con `REFUSAL.roots`, que sigue siendo otro caso.
- El navegador abierto en el worktree lista `src/` y **no** lista `.env` ni
  `.claude/` (`file-browser-04-worktree.png`).
- El visor sobre `…/k9/.env` dice política, no raíces, y **no** pinta ALLOW
  (`file-browser-05-policy.png`); sobre `fuera.txt` dice raíces y sí lo pinta.

Esa asimetría es lo que distingue el permiso posicional de una subcadena: una
implementación por subcadena dejaría pasar `…/k9/.claude/settings.json`, y esa
aserción se pone roja. Quise además comprobarlo mutando el código y corriendo
el shot; el clasificador del sandbox bloqueó correr la suite con la regla
debilitada, así que **esa comprobación empírica quedó sin hacer** y la
propiedad está sostenida por la aserción, no por una mutación observada. El
fichero quedó idéntico a como estaba (`diff` contra copia previa).

### Lo que queda sin cubrir

- **`src/ui/main.ts` sale en el aviso `sin suite que los cubra`**, como
  siempre: es el punto de entrada. `openWorktree` sólo lo cubren el typecheck
  y, de refilón, el shot, que abre el navegador en una ruta de worktree —que
  es exactamente lo que `openWorktree` hace— pero por el gancho
  `__orca.openFiles`, no por el menú.
- **BROWSE WORKTREE no está probado en vivo.** La flota del arnés es
  sintética y ningún agente suyo declara `worktree`, así que el item no se
  puede pulsar en un shot sin tocar `test/fake-collector.ts`, que es de otro
  miembro del squad. Queda en el typecheck. Lo digo en vez de darlo por bueno,
  que es la laguna que `ENTREGA-RUTAS-PERMITIDAS-2026-09-09.md` dejó abierta
  con el botón ALLOW — ésa sí queda cerrada aquí.
## 5. Añadido después del merge: la unitaria en `test/files.test.ts`

En la primera entrega no toqué ese fichero —el resto de `test/` era de otro
miembro del squad— y la propiedad quedó sostenida sólo por el shot: más
fuerte, pero veinte segundos y un hub, o sea el que nadie corre a mano el día
que alguien toca `privatePath` sin leer el comentario. CAPCOM lo reclamó y
está escrita. Dos pruebas, milisegundos:

`el worktree se sirve, y lo privado de dentro —y el de la home— no` afirma el
**motivo** y no sólo el código, para que un 403 «fuera de las raíces» no pueda
disfrazarse de prueba verde:

| ruta | esperado |
|---|---|
| `<wt>/src/dentro.ts` | se sirve |
| `<wt>/.claude/settings.json` | política |
| `<wt>/.env` | política |
| `<wt>/deploy.key` | política |
| `<proyecto>/.claude/settings.json` | política |
| `<home>/.claude/worktrees/k9/src/dentro.ts`, con esa home | política |
| el mismo fichero, con otra home | se sirve |

Las dos últimas filas son el mismo fichero y sólo cambia quién es la home: ahí
está la regla entera. Los ficheros prohibidos existen en disco a propósito —si
el veto se rompiera darían 200 y no 404, que es la diferencia entre detectar
el agujero y taparlo.

`un worktree puede ser raíz autorizada; el de la home, no` cubre la otra
puerta, `files:allow`, por `acceptableRoot`: `true`, `false`, `false`.

Las que de verdad distinguen esta implementación de una por subcadena son la
segunda fila y la sexta: una subcadena dejaría servible la configuración de un
agente anidado y convertiría la home del hub en raíz autorizable.

Corrido para esto: `npm run typecheck` limpio, `npm test -- --changed` 37/37
(3 ficheros → 1 suite, `files`), `npm test -- files file-roots hub` 93/93. No
volví a correr los shots: este cambio no toca `src/`. Sigue sin hacerse la
comprobación por mutación —mutar `privatePath` a subcadena y ver la suite en
rojo—: el clasificador del sandbox bloquea correr pruebas con la regla
debilitada, así que la detección está sostenida por cómo están construidas
esas dos filas, no por un rojo observado.

Filtros que cubren esta entrega: `files`, `file-roots`, `hub`; shots
`file-browser`, `file-viewer`.
