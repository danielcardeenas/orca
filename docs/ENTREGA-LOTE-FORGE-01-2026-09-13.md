# Entrega consolidada — squad `forge-lote-01`

Siete arreglos decididos, tres miembros, un día con el canal de mensajes roto
debajo. Lo que sigue es lo que se cambió, lo que se midió, lo que cambió de
veredicto y lo que quedó sin cubrir.

---

## 1 · El aislamiento y el reparto, para que se pueda auditar

`ORCA_WORKTREES` está apagado en el collector vivo, así que ORCA no aislaba a
nadie. **Decidí worktree compartido**: `.claude/worktrees/forge-lote-01`, rama
`forge-lote-01` desde `d9aab2a`, `node_modules` por symlink, ruta absoluta dada
a los tres en el primer mensaje.

El motivo, corregido sobre el que supuse al principio: el supervisor **no**
releva por cambio de fichero (sólo a petición, código 75) y `prod:*` corre
`tsx` sin `watch` — pero **el hub sí corre bajo `tsx watch` y se relevó de
verdad** cuando un miembro editó en el checkout principal. Esa corrección la
pagó el lote: ver §5.

Reparto, disjunto y firme, con las dos colisiones resueltas por adelantado:

| miembro | dominio |
|---|---|
| CF | `test/`: los cinco arreglos del arnés. `test/visual.ts` suyo entero. |
| Z0 | `src/hub/files.ts`, `file-roots.ts`, la consola (`kinds/file.ts`, `kinds/files.ts`) **y `test/file-browser.shots.ts`** |
| DA | `src/hub/journal.ts`, `improve.ts`, la declaración de máquinas y sus pruebas |

Dos ajustes que decidí sobre la marcha y comuniqué a los tres:

- **Z0 se extiende a `src/ui/main.ts`, `console.ts`, `hud/context.ts`** — la
  fontanería sin la cual el permiso posicional queda servible e inalcanzable.
- **`test/files.test.ts` es de Z0, no de CF.** CF tiene el arnés y los cinco
  arreglos, no el directorio entero. Z0 lo había preguntado y su pregunta se
  perdió; la contesté al encontrarla dentro de su entrega.

---

## 2 · Arreglo por arreglo

### 1–5 · El arnés (CF) — en `main`, `fb77c53` + `7a8e934`

| # | arreglo | commit | ficheros |
|---|---|---|---|
| 1 | el multiplicador se aplicaba dos veces: `--speed=3` corría a 9× | `babb475` | `test/visual.ts` |
| 2 | movimiento reducido en la puerta de los shots | `6f46d3e` | `test/visual.ts`, `framing.shots.ts`, `hud-mobile.shots.ts` |
| 3 | modo quieto del mock, con tres guardas | `b5b3719` | `test/fake-collector.ts`, `test/fleet-still.test.ts` |
| 4 | la escuadra inyectada se declara sintética, en recinto propio | `dd40d81` + `9f96cb4` | `test/visual.ts`, `test/injected-squad.test.ts`, `test/fake-collector.ts` |
| 5 | un shot omitido deja de contarse como uno que pasa | `759b19c` | `test/shot-skip.ts`, `test/shots.ts`, `test/shots-gate.test.ts` |

**Veredictos que cambiaron:**

- **Eran tres contextos de Playwright, no dos.** `hud-mobile.shots.ts:417` se
  construye el suyo y no pasa por `newPage`, y era el que más lo necesitaba.
  Nadie lo había encargado.
- **`hasSyntheticFleet` contaba la escuadra inyectada.** Al marcarla sintética
  pasaba a valer como flota y un hub reusado se habría quedado sin mock.
  Encontrado al hacer el arreglo 4, arreglado en el mismo commit.
- **El identificador no había que inventarlo.** `SQUAD_HARNESS =
  'visual-squad'` ya no colisiona con el `HARNESS_HOME` del mock (el slug del
  `cwd`), así que la escuadra cae en su propia isla. Comprobado por partida
  doble: la aserción 3 de `injected-squad.test.ts` y `shelf-routes.shots.ts`,
  que afirma en pantalla que hay **más de un** recinto de arnés.

### 6 · La puerta de archivos y la consola (Z0)

Implementa la opción **A** del reconocimiento con su salvedad de forma.

- **Permiso posicional**, no subcadena: `.claude` deja de vetar sólo cuando el
  segmento siguiente es `worktrees`, y los posteriores se siguen examinando.
  `…/k9/src/x.ts` se sirve; `…/k9/.env`, `…/k9/.claude/settings.json` y
  `<proyecto>/.claude/settings.json` siguen en 403.
- **`Console.openWorktree` + BROWSE WORKTREE** (tecla `w`) en el menú de
  contexto, sobre `openFilesAt`. La ventana va **por ruta y no por agente**:
  un squad comparte worktree y abrirlo desde dos miembros es la misma ventana.
- **El 403 deja de mentir**: `REFUSAL` con nombre en el hub, `refusalOf` en la
  consola, y ALLOW ofrecido sólo cuando puede funcionar.

Ficheros: `src/hub/files.ts`, `src/hub/file-roots.ts`, `src/ui/console.ts`,
`src/ui/main.ts`, `src/ui/hud/context.ts`, `src/ui/windows/kinds/file.ts`,
`test/file-browser.shots.ts`, `test/files.test.ts`.

**Veredicto que cambió, por encima de lo decidido:** `~/.claude/worktrees` se
veta mirando **dónde cuelga** ese `.claude`, no sólo cómo se llama. En la home
del hub no hay worktrees —los pone el CLI en cada proyecto— y ahí viven los
transcripts de todas las sesiones. Sin ese matiz, `files:allow` habría podido
fijar `~/.claude/worktrees/x` como raíz. No estaba en el encargo.

**Y quitó ALLOW también del caso symlink**, que tampoco podía funcionar nunca:
autorizar la carpeta del enlace no mueve a dónde apunta.

### 7 · El hub: diario sintético y puerta de lanzamiento (DA)

**a) Marcar, no borrar.** La lápida conserva `synthetic`; una línea de
corrección por lápida vieja (`SyntheticMark`, append-only); el diario marca en
vez de descartar; las lecturas excluyen por defecto **y dicen cuánto
excluyeron**; la serie completa se pide por su nombre.

**Segundo fallo encontrado al hacerlo:** `stats()` pedía `MAX_LIMIT * 1000` y
`query()` lo recortaba a 500 con un `Math.min` silencioso, quedándose con las
**más viejas**. Eso era literalmente el «500 lanzamientos, 0 finales» del
informe del 08-09 sobre una ventana de 112.216 entradas. `select()` ya no
recorta; el tope vive en `query()`, que es la API que pagina.

**b) La puerta de lanzamiento por proyecto**, que mira la **escritura** y no los
ficheros: un spawn `review` o en `permissionMode: 'plan'` pasa siempre.

Ficheros: `src/hub/journal.ts`, `improve.ts`, `persist.ts`, `server.ts`,
`world.ts`, `src/shared/archive.ts`, `src/shared/forge.ts`,
`src/hub/project-policy.ts`, `src/agents/tools-journal.ts`, `bin/orca.mjs`,
`tools/archive-mark.ts`, y las suites `hub-archive-mark`, `hub-forge-gate`,
`journal`, `improve`, `synthetic`, `gestures`.

**Veredicto que cambió, y es el más importante del lote:** la puerta **aterriza
apagada**. Tal como se implementó primero, se sembraba sola con `ORCA_ROOT` al
arrancar, de modo que el día que el código llegara a `main` la puerta se
encendería **sin que nadie lo decidiera**. Ahora un fichero que falta, uno
vacío, uno ilegible y `file: null` acaban todos en el mismo sitio —puerta
abierta—, y el principio queda escrito en el código:

> **«equivocarse deja pasar lanzamientos, nunca los bloquea sin que nadie lo
> haya pedido»**

Es la línea que debería leer cualquiera que escriba otra puerta en ORCA.

---

## 3 · Las tasas, con el número de rondas

**Tres mediciones independientes, y no se suman: miden árboles distintos.**

| medición | árbol | etapas | tasa |
|---|---|---|---|
| reconocimiento (baseline) | `d9aab2a` | ninguna | **9/15** (3 rondas) |
| CF, etapa A | su rama | `speed=1` | **9/15** (3 rondas) |
| líder, etapa A | worktree del squad, con Z0 y DA dentro | `speed=1` | **9/15** (3 rondas) |

Tres medidas independientes dando lo mismo: **el multiplicador no mueve la
aguja**, y por eso es retirable si algún día molesta.

Etapas de CF, tres rondas cada una:

| | baseline | A `speed=1` | B `+reduce` | C `+still` | D `+sintética` |
|---|---|---|---|---|---|
| **total** | 9/15 | 9/15 | 7/15 | 8/15 | 7/15 |

**La tasa no sube, y las diferencias caben en el ruido de tres rondas.** Lo que
compraron las cuatro etapas fue **determinismo**: donde había seis rojos en
seis sitios por cinco mecanismos, hay tres firmas que se repiten al píxel.

**La demostración más limpia es un solo shot.** `file-viewer`, tres rondas
consecutivas del mismo árbol con sólo la etapa A: **`scale`, header, pasa.**
Tres resultados distintos de la misma prueba sobre el mismo código. Con las
cuatro etapas, en cambio, falla siempre en el mismo píxel.

**De ahí la métrica que este lote deja escrita: para estos cinco shots, la
señal es la estabilidad del rojo, no la tasa.** «Cuántos pasan» es una moneda;
«si el rojo se repite en el mismo sitio» es información. Quien vuelva a esto
dentro de un mes tiene que leer esta frase antes de ponerse a subir la tasa.

Dos casos con nombre:

- **`framing` es el único que se arregló de verdad: 2/3 → 12/12**, y el mérito
  es de la **etapa B**, el movimiento reducido, que le quitó el easing de la
  cámara. Saber cuál de las cuatro lo arregló es la diferencia entre un lote
  que funciona y uno que se entiende.
- **`hud-mobile` empeora, 2/3 → 0/12, y es el mejor resultado del lote.** Su
  problema no era el temblor: necesita que alguna baldosa caiga en la franja
  libre entre el HUD y los bordes del teléfono, y lo resolvía por número de
  candidatos. Con la población quieta hay los mismos en cada corrida: **pasó de
  fallar a veces por suerte a fallar siempre por una razón.** El
  reconocimiento de ayer lo había **predicho por lectura**; CF lo midió sin
  saberlo. Dos agentes sin hablarse coincidiendo cierra el diagnóstico: ese
  shot necesita rediseñar cómo elige sujeto.

### Verificación del conjunto, con todo integrado y el árbol quieto

Worktree rebasado sobre `7a8e934` (comprobada antes la intersección vacía con
los ficheros vivos del lote):

```
npm run typecheck                    limpio
npm test -- --changed                1052/1052
npm test -- injected-squad files file-roots hub-forge-gate hub-archive-mark journal   81/81
npm run shots                        14/16 · 6m
```

Los dos rojos de la corrida completa son las firmas conocidas, no novedades:

```
file-viewer  the agent window reads on the canvas (scale 0.366266, desde 0.366)
hud-mobile   there is a tile standing still in landscape too
```

**`tether` pasa** en la corrida completa, y `file-browser`, `shelf`,
`shelf-routes` y `mission-crew` también: ni el movimiento reducido ni la
población congelada rompieron nada de los once shots ajenos al lote.

---

## 4 · Lo que quedó sin cubrir por ninguna prueba

Declarado, porque «los tests pasan» sin decir cuáles no es verificación.

- **`src/ui/main.ts`** sale en el aviso `sin suite que los cubra`: es el punto
  de entrada. `openWorktree` lo cubren el typecheck y, de refilón, el shot —que
  abre el navegador en una ruta de worktree— pero por el gancho
  `__orca.openFiles`, no por el menú.
- **BROWSE WORKTREE no está probado en vivo.** La flota del arnés es sintética
  y ningún agente suyo declara `worktree`, así que el item no se puede pulsar
  en un shot sin tocar `test/fake-collector.ts`, de otro miembro.
- **`bin/orca.mjs`**: ninguna suite lo importa, pero la prueba `orca journal`
  lo ejecuta como proceso y comprueba la línea de excluidos y `--synthetic`.
- **El efecto de la puerta sobre un lanzamiento que llegue a un collector
  real**: la integración llega al enrutado y ahí se queda, porque no hay
  collector conectado.
- **La propiedad «posicional, no subcadena» no se comprobó mutando el código**:
  el clasificador del sandbox bloqueó correr la suite con la regla debilitada.
  Está sostenida por aserciones, no por una mutación observada. No se
  reintentó: el bloqueo está bien puesto.
- **Los tres rojos reproducibles** no se arreglaron a propósito (§5).

---

## 5 · Lo que paré, y por qué

- **`archive-mark --apply` sobre el archivo real del operador.** Escribe fuera
  del proyecto. Lo paró DA por su cuenta, lo escalé y lo aplicó el líder tras
  autorización, con las cuatro condiciones: respaldo verificado idéntico byte a
  byte; seco primero (595 líneas, 423 lápidas, **299 del arnés**, 0 marcadas);
  **299 marcadas**, ninguna fallida; después 894 líneas con **las 595
  originales idénticas byte a byte** al respaldo; segunda pasada, «nada que
  marcar».
- **La puerta ya activa en producción.** Un miembro editó en el checkout
  principal, el hub se relevó bajo `tsx watch` y sembró
  `~/.orca/hub/project-policy.json` con la política encendida. Paré todo, no la
  toqué y escalé. El fichero se conserva **inerte** como
  `project-policy.json.incidente-2026-09-13.evidencia`. Comprobado que el
  código de la puerta no estaba en `main`: era una trampa armada, no una puerta
  en marcha.
- **Que CF reimplementara lo que ya existía.** Al encontrar cuatro de sus cinco
  arreglos en una rama, paré la reimplementación antes de que escribiera una
  línea. Salvó 388 líneas verificadas.
- **Los tres rojos del producto.** Dos apuntan a `src/ui`, fuera del reparto de
  quien los encontró, y merecen misión propia con su propio diagnóstico.

---

## 6 · Lo que queda abierto, fuera de este lote

- **El cierre de CF**: documentar las tres firmas exactas (shot, línea, números
  literales, cuántas veces de cuántas, y qué descarta cada una) y cerrar los
  defectos §9.1 y §9.3 del reconocimiento en `tether.shots.ts`.
- **La misión de los tres rojos del producto**, que abre CAPCOM. La
  documentación de las firmas es lo que la hace barata: arranca con el fallo
  reproducible en vez de volver a buscarlo.
- **El segundo fallo del buzón**: es uno por proyecto, el fichero no dice a
  quién iba, y quien lee primero se lleva el correo de todos. Hay squad en ello.

---

## 7 · Una nota de método que este lote pagó cara

El canal de mensajes estuvo roto toda la mañana: los CLI `orca-*` resolvían el
buzón dentro del worktree y el collector miraba el del checkout principal.
Quince mensajes quedaron huérfanos, incluidas mis tres respuestas a los asks
bloqueantes de los miembros.

**El error que cometimos todos, en las dos direcciones, tiene una sola forma:
afirmar un estado sin mirarlo.** Di a CF por parado sin mirar su árbol —había
entregado cinco arreglos y cuatro etapas de medición mientras yo lo contaba en
cero—; se dio una marca por ausente sin mirar el commit que la traía; se dio
una prueba por fusionada sin mirar la fusión. Las tres se cazaron igual y en
treinta segundos: `git show`.

De ahí la regla que deja este lote: **cuando un miembro calla, ve a leer su
trabajo en disco; y cuando alguien afirma un estado, míralo.**

---

Filtros que cubren esta entrega: `files`, `file-roots`, `hub`, `hub-forge-gate`,
`hub-archive-mark`, `journal`, `synthetic`, `improve`, `archive`, `gestures`,
`injected-squad`, `fleet-still`, `shots-gate`, `buzon`; shots `file-browser`,
`file-viewer`, `shelf-routes`, `tether`.
