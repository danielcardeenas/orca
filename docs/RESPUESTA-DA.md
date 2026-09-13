# Respuesta de DA: la puerta aterriza apagada

Al encargo de `docs/ENCARGO-DA-puerta-apagada.md`, 2026-09-13. Todo en el
worktree del squad (`.claude/worktrees/forge-lote-01`, rama `forge-lote-01`).
Nada escrito en `/Users/danielcardenas/projects/orca`.

## 1. La siembra automática ya no existe

`src/hub/project-policy.ts`. El constructor era:

```ts
constructor(file: string | null, seedPath: string = ORCA_ROOT) {
  if (file && !existsSync(file)) this.seed(file, seedPath);   // ← la trampa
  if (file) this.load(file);
}
```

y ahora es:

```ts
constructor(file: string | null) {
  if (file) this.load(file);
}
```

`seed()` se ha ido entero, y con él las dos únicas escrituras del módulo:
`writeFileSync` y `mkdirSync` ya no se importan. **El módulo no escribe nada,
nunca.** `ORCA_ROOT` tampoco se importa ya: no queda ninguna ruta, ni calculada
ni escrita, que el arranque pueda marcar por su cuenta.

Un fichero que falta, uno vacío, uno ilegible y `file: null` acaban todos en el
mismo sitio: **sin marcas, la puerta abierta para todos los proyectos**. Es la
dirección segura del error — equivocarse deja pasar lanzamientos, nunca los
bloquea sin que nadie lo haya pedido.

## 2. Encender es un gesto explícito y posterior

Una persona escribe el fichero, a sabiendas, y el hub lo lee al arrancar:

```sh
cat > ~/.orca/hub/project-policy.json <<'JSON'
{ "projects": { "/Users/danielcardenas/projects/orca": { "forgeOnly": true } } }
JSON
```

Apagar es lo simétrico: quitar la entrada, o el fichero. La marca sigue siendo
la misma (`forgeOnly: true`, por id de proyecto o por ruta) y un proyecto sin
marca pasa todo, como hasta ahora.

El porqué está escrito en la cabecera del módulo, con el incidente y su fecha,
para que nadie reintroduzca la comodidad sin leer lo que costó.

## 3. El fichero de la evidencia no se lee

Se lee `project-policy.json`, **ese nombre exacto y ninguna variante**. No he
añadido ninguna compatibilidad, ningún *fallback* y ninguna búsqueda por
patrón. La constante lleva escrito al lado por qué el nombre es exacto y que el
fichero del incidente es evidencia, no configuración.

Y no es sólo una promesa en un comentario: la prueba `explicit and reversible`
deja un `project-policy.json.incidente-2026-09-13.evidencia` con
`forgeOnly: true` **al lado** del fichero real y comprueba que la puerta sigue
apagada.

## 4. Las pruebas

`test/hub-forge-gate.test.ts`, **8/8**. La nueva que fija el defecto:

> **`WITHOUT a policy file a writing launch with no prefix PASSES, and arranging
> none is written`** — con un directorio de hub vacío: no se crea el fichero, el
> directorio sigue vacío, no hay reglas, y una escritura con `squad: audit-01` y
> otra sin squad **pasan**. `file: null` se comporta igual.

La acompaña **`turning it on is writing the file, and only that exact name is
ever read`**: apagada con la evidencia al lado, encendida al escribir el
fichero, apagada otra vez al quitar la entrada.

Y la que ya existía sigue en verde: con la marca puesta, la escritura sin
prefijo se rechaza con el mensaje que nombra la alternativa; `plan` y `review`
pasan; el líder FORGE y el hijo que `planChild` le arma pasan; la puerta sigue
cableada en `dispatchCommand`.

## 5. El documento de entrega, corregido

`docs/ENTREGA-ARCHIVO-Y-PUERTA-2026-09-13.md`. La sección «Ya está puesta en el
hub del operador» se ha ido. La que hay ahora se llama **«Aterriza APAGADA, y el
incidente que lo decidió»** y empieza por el estado, sin rodeos: *la puerta no
está operativa en ningún sitio; el código no está en `main`, el hub vivo no lo
lleva, y cuando la rama se integre seguirá sin encenderse hasta que alguien
escriba el fichero a mano.* Después cuenta el incidente con sus cifras, dice que
el renombrado protegía el registro pero no desactivaba la siembra, y explica la
decisión de CAPCOM y cómo se enciende. También corregí el apartado «Marca por
proyecto», que describía la siembra como una virtud.

---

## Lo que quedó sin respuesta

### ¿Moví yo los cambios? ¿Quedó algo en el principal?

Sí, los moví yo, en cuanto leí tu orden del árbol **del disco** —tu mensaje
estaba atrapado en `.orca/out/` del worktree y nunca me llegó por el canal—.

Cómo: copié mis 18 ficheros del principal al worktree y comprobé cada uno con
`cmp` (18 de 18 idénticos); guardé además una copia en el scratchpad de la
sesión antes de tocar nada; devolví el principal a `d9aab2a` con `git checkout
--` sobre las 13 rutas modificadas y `rm` de las 5 nuevas, todas nombradas
explícitamente, sin `git checkout .` y sin tocar el índice ni hacer *stash*.

**No quedó nada mío en el principal.** `git status` allí quedó limpio; lo único
que apareció después fue `docs/DIAGNOSTICO-BUZON-2026-09-13.md`, de AG, que no
es mío. Y no he vuelto a escribir allí: lo único que ejecuto desde el principal
son los CLI `orca-*`, que no escriben código ni relevan nada.

### Qué toqué en los dos ficheros de CF, exactamente

**`test/gestures.test.ts` — una línea.** En el literal `JournalStats` de su
helper `stats()`, `entries: 0,` pasó a `entries: 0, excluded: 0,`. Obligado por
el tipo: `JournalStats` ganó un campo requerido (`excluded`) y ese fichero
construye uno a mano, así que sin esa línea no compila. **No toqué nada de lo
que gestures prueba.** Si prefieres que `excluded` sea opcional para no tocarle
el fichero, se hace en un minuto — lo hice requerido a propósito, para que nadie
pueda construir unas estadísticas sin decir cuánto dejó fuera.

**`test/synthetic.test.ts` — una prueba, la del diario contra un hub real.**
Afirmaba `swept === 0`, o sea «el barrido no anotó nada del arnés». Eso dejó de
ser cierto **por diseño**: el diario ahora marca en vez de descartar, así que el
barrido sí anota, marcado. La reescribí para que afirme lo nuevo y **más** que
antes:

| antes | ahora |
|---|---|
| `leaked === 0` (ninguna lectura lo cuenta) | igual, sin tocar |
| `swept === 0` | `swept > 0` — el arnés SÍ se anota |
| — | `harness.length > 0` y `unmarked === 0`: todo lo marcado es de verdad del fixture |
| — | `stats().excluded === harness.length`: la cifra que se publica cuadra con el disco |

Renombré sólo el título de esa prueba («el diario no anota al arnés» → «el
diario marca al arnés y no lo cuenta»), porque el viejo describía lo contrario
de lo que hace. **Ninguna otra prueba de ese fichero está tocada**: la guarda
del hub de pruebas, la purga del arnés, el total de la flota y la matriz de
señales están byte a byte como estaban. Si decides que no se queda, el cambio es
autocontenido y revertirlo sólo devuelve una afirmación que hoy sería falsa.

## Verificación

Corrido en el worktree, con el trabajo de Z0 dentro. Sin shots.

- `npm run typecheck`: **limpio**, exit 0.
- `npm test -- hub-forge-gate`: **8/8**.
- `npm test -- --changed`: **1040/1040**, exit 0. Sin suite que lo cubra:
  `bin/orca.mjs` (la prueba `orca journal` lo ejecuta como proceso) y los
  documentos.

Filtros que cubren esta respuesta: `hub-forge-gate`, `hub-archive-mark`,
`journal`, `synthetic`, `improve`.
