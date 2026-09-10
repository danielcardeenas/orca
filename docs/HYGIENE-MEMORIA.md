# Higiene — la memoria, medida en vez de acotada

**Estado:** implementado y verificado en la máquina del operador.

Empezó con una captura de la ventana HYGIENE:

```
MEMORY   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░  ≤47G of 48G
```

La pregunta del operador —«¿por qué tenemos ocupada casi toda la memoria?»— era
la correcta, y la respuesta era que no la teníamos.

## 1. Qué estaba mal

La fila salía de `os.totalmem() - os.freemem()`. En darwin `os.freemem()` cuenta
sólo las páginas libres **en ese instante**, y macOS a propósito no deja casi
ninguna: todo lo sobrante es caché de archivos o purgeable, y lo devuelve en
cuanto alguien lo pide. La resta, por tanto, da «47 de 48» en una máquina con
nueve gigas de margen. Linux tiene el mismo error por el mismo motivo:
`MemFree` no es `MemAvailable`.

El código **ya sabía** que la cifra no era una medición: la marcaba `≤`, con el
motivo en el tooltip. Y aun así era la cifra que se leía primero, con la barra
casi llena, como una emergencia.

De ahí la regla que se ha escrito en `shared/hygiene.ts`: **una cota es la
segunda mejor respuesta**. Marcar bien un número no es medirlo, y un techo
correctamente marcado puede seguir siendo el número que engaña. `atMost` es
para cuando la plataforma no quiere decirlo — no en lugar de preguntárselo.

## 2. Qué se hizo

`src/collector/memory.ts`, nuevo: se le pregunta a la plataforma en sus propios
términos.

| | darwin (`vm_stat`) | linux (`/proc/meminfo`) |
|---|---|---|
| Comprometida | `wired + app + compressed`, donde app es `anónimas − purgeables` — lo que el Monitor de Actividad llama *Memory Used* | `MemTotal − MemAvailable` |
| Caché | `file-backed + purgeables` | `Cached + Buffers + SReclaimable` |
| Swap | `sysctl vm.swapusage` | `SwapTotal − SwapFree` |

Tres decisiones que valen su comentario:

- **La caché es una fila propia, no un término de ninguna suma.** Es memoria en
  uso *y* memoria disponible a la vez; meterla en cualquiera de los dos lados es
  el error original en una dirección o en la otra.
- **El swap sube al panel** porque es lo que dice si la presión es real: 80%
  comprometido sin swap es una máquina cómoda, y ese mismo 80% con cuatro gigas
  fuera no lo es.
- **Un contador que falta rompe el parseo entero.** Un cero en «pages occupied
  by compressor» habría restado diez gigas en esta máquina y habría parecido
  razonable, que es la peor forma de estar mal.

Si `vm_stat` o `/proc/meminfo` no se pueden leer, vuelve el techo de siempre —
con su `≤` y con su motivo, y nunca disfrazado de medición.

El tamaño de página se lee de la cabecera de `vm_stat` (16K en Apple silicon,
4K en Intel): darlo por supuesto multiplica o divide por cuatro cada cifra en
media flota.

## 3. Qué se ve ahora

```
MEMORY   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░  39G of 48G
  CACHED  RETURNED ON DEMAND        7.5G
  SWAP                       4.2G of 5.0G
```

Sin marca, porque está medido. La barra dibuja lo comprometido.

La franja de máquina del deck (`load.memPct`) usaba la misma resta y se ha
pasado a la misma fuente; devuelve `null` en el primer latido, igual que la CPU,
porque el latido es síncrono y no puede esperar a un subproceso.

## 4. En el cable

`HygieneReport` gana tres lecturas **opcionales**: `memCachedBytes`,
`swapUsedBytes`, `swapTotalBytes`. Opcionales porque un collector anterior no
las manda, y ausente no es cero: la ventana omite la fila en vez de dibujar una
caché vacía, y `sanitizeReport` deja el campo fuera del informe en vez de
rellenarlo. La herramienta `hygiene_sample` de los agentes las expone con el
nombre `memory_cached_returned_on_demand`, largo a propósito: un agente que
sume caché y uso y declare la máquina llena la ha leído al revés.

## 5. Cómo verificarlo

```
npm run typecheck
npm test -- memory hygiene           42 pruebas (12 + 30)
npx tsx test/hyg-memory.shots.ts     la sección, fotografiada
```

`memory.test.ts` guarda la salida real de `vm_stat` de la máquina de la captura,
así que la aritmética que falló se comprueba con los números que fallaron —y en
cualquiera de las dos plataformas, porque los parseadores son puros.
`hyg-memory.shots.ts` fotografía la ventana y comprueba también que la barra
dibuja lo comprometido: una barra casi llena con nueve gigas libres era la foto
del error.

Filtros que cubren esta entrega: `memory`, `hygiene`, `collector`.
