# El brief de CAPCOM deja de cargarse dos y tres veces en cada relevo

Misión `mission_mty1j13oe8grsfbt`. Arreglo de la propuesta `brief-duplicado-en-handoffs`
(`imp_mty1agjag81dlprb`), nacida de la investigación de `docs/INFORME-CONTEXTO-REPETIDO-2026-09-12.md`.
Medido el 2026-09-12 con `tiktoken/cl100k_base` sobre los 13 archivos de traspaso reales de
`~/.orca/capcom/handoffs/` y sobre relevos armados por el código de este árbol.

## El diagnóstico, verificado antes de tocar nada

`src/collector/provider-handoff.ts` prepara un traspaso así:

- `:246` — el destino arranca en `<archivo>/runtime`, un directorio nuevo bajo `~/.orca/capcom/handoffs/<id>/`.
- `:250` — ahí escribe el brief que el destino tiene que leer.
- `:256-258` (antes del arreglo) — copiaba el `CLAUDE.md` y el `AGENTS.md` vivos a `<archivo>/`
  **como respaldo**; el comentario de `:255` lo dice.

Un CLI carga los ficheros de reglas de **todos los directorios ancestros de su cwd**, y
`<archivo>/` es ancestro de `<archivo>/runtime`. El respaldo dejaba de ser un respaldo y pasaba a
ser instrucciones, en cada petición.

Recorrida la cadena de ancestros de los 12 `runtime/` que hay en disco, fichero a fichero:

```
162ee578  3 ficheros   189+4478+4478 =  9145 tok   ← el cwd de la sesión que manda ahora
4fd9dfe4  3 ficheros  6196+4478+4478 = 15152 tok   ← caso peor, traspaso de continuidad
…
TOTAL     36 ficheros           134.288 tok, de los que 31.346 son copia byte a byte
```

**Confirmado en vivo, no de archivo:** el CAPCOM de hoy (`4b002951`) corre en
`handoffs/162ee578…/runtime`, y en su cadena hay tres `CLAUDE.md`; los dos de arriba tienen el
mismo sha256 (`~/.orca/capcom/CLAUDE.md` y `~/.orca/capcom/handoffs/162ee578…/CLAUDE.md`,
19.498 B cada uno). 4.478 tokens repetidos en cada una de sus peticiones.

## El arreglo

`rules/` es hermano de `runtime/`, no ancestro suyo:

- `review()` copia el `CLAUDE.md` y el `AGENTS.md` vivos a `<archivo>/rules/` en vez de a
  `<archivo>/`. Los mismos bytes, un directorio más abajo. El resto del control state —la
  identidad, los legados, las actas de modelo— se queda en la raíz: ningún CLI lo carga.
- El `HANDOFF.md` dice dónde está el respaldo, en vez de decir «en este archivo».
- `demoteArchivedRules()` baja a `rules/` los ficheros de los archivos **ya escritos**. El que
  paga la duplicación es el archivo del traspaso vivo, cuyo `runtime/` es el cwd de la sesión que
  manda; bajarlo deja de cobrarlo sin borrar nada. Mejor esfuerzo, como `prune`: un traspaso no
  puede fallar porque el orden de la casa no se pudiera arreglar.

El cwd (`:246`) y el brief que el destino lee (`:250`) no se tocan.

## La demostración, con cifras

Réplica del `~/.orca/capcom` real —los mismos ficheros de reglas, los mismos 13 archivos—, el
arreglo aplicado, y la cadena de ancestros recorrida otra vez. Idéntico para `CLAUDE.md` y
`AGENTS.md`:

| relevo | antes | después | ahorro |
|---|---|---|---|
| `162ee578` (el vivo, clean) | 3 fich · 9.145 tok (**4.478 dup**) | 2 fich · 4.667 tok (**0 dup**) | 4.478 |
| `4fd9dfe4` (continuidad) | 3 fich · 15.152 tok (**4.478 dup**) | 2 fich · 10.674 tok (**0 dup**) | 4.478 |
| `20360d86` | 3 fich · 8.282 tok | 2 fich · 4.665 tok | 3.617 |
| … 12 relevos | **36 fich · 134.288 tok (31.346 dup)** | **24 fich · 84.857 tok (0 dup)** | **49.431 (36,8 %)** |

**La duplicación byte a byte pasa de 31.346 tokens a cero, en los doce, en los dos ficheros.**
Sobre las dos sesiones relevadas que el informe midió (157 + 102 peticiones), son 1.159.802
tokens de prefijo que ya no se vuelven a enviar.

### Y el relevo sigue arrancando entero

Ejecutado el camino completo que arma un relevo con el código de este árbol —`review()` y después
el `writeConfig()` que `capcom.ts:441` hace al activar—, en los dos modos:

```
── relevo continuity ──
  brief del destino (runtime/CLAUDE.md):        COMPLETO, byte a byte
  AGENTS.md del destino:                        COMPLETO, byte a byte
  respaldo rules/CLAUDE.md:                     idéntico al vivo
  en la raíz del archivo (ancestro del cwd):    no
  checkpoint:                                   dice dónde está el respaldo
  identidad, legados y actas en la raíz:        true
  cadena CLAUDE.md: 2 ficheros → runtime/CLAUDE.md (26375 B) · CLAUDE.md (19498 B)
── relevo clean ──  (mismo resultado; su brief corto de 1.037 B intacto)
```

En el modo **clean** —el del CAPCOM que manda hoy— el brief completo llega ahora **exactamente
una vez**. El respaldo se conserva entero y el destino conserva su brief entero: no se recortó
nada, se movió un fichero.

## La decisión sobre `:249`, que escribe `capcomBrief()` en el cwd

**Se deja como está.** Tres razones, las tres verificadas aquí:

1. **Quitarlo no quitaría un token.** `capcom.ts:441` (`writeConfig`) reescribe ese mismo
   `runtime/CLAUDE.md` con el brief entero al activar el traspaso, y `capcom.ts:807` lo repite en
   la recuperación. Recortar `:249` sólo desincronizaría la preparación de la activación y
   añadiría un tercer dueño del mismo fichero.
2. **Es el único brief garantizado.** Que el brief llegue por la cadena de ancestros está
   confirmado para Claude Code; para Codex, que busca `AGENTS.md` en el raíz del repo y en el
   cwd, no lo está — y `~/.orca/capcom` no es un repo. Un relevo a Codex que confiara en el
   ancestro podría arrancar sin saber quién es. El encargo es explícito: no romper un relevo por
   ahorrar tokens.
3. **El texto de los dos ficheros no es el mismo por regla, sino por coincidencia.** Se escriben
   en momentos distintos: el del cwd, al preparar el relevo; el del ancestro, al arrancar el
   collector. Hoy mismo miden 6.017 y 4.478 tokens en disco porque el brief cambió entre los dos
   momentos. Confiar en el de arriba le daría al relevado un brief más viejo que el que se
   verificó al prepararlo.

**Lo que eso deja sobre la mesa, dicho con su cifra:** cuando el collector y el relevo comparten
versión del brief, un traspaso de *continuidad* sigue cargando ese texto dos veces —medido:
**6.017 tokens por petición**—, una desde `runtime/` y otra desde `~/.orca/capcom/`.

Y esa segunda copia **no se arregla en `:249`**. El destino recibe el brief una sola vez sólo si
el texto vive en un sitio, y el de `~/.orca/capcom/CLAUDE.md` no se puede quitar: es el brief del
CAPCOM que corre directamente ahí. La única salida segura para los dos runtimes es que el
`runtime/` del relevo **deje de colgar de `~/.orca/capcom`** — es decir, `:246`, que esta misión
excluye expresamente. Queda como la propuesta siguiente, y arreglaría de paso un fallo funcional:
un reset **clean**, que promete no inyectar el texto de las reglas persistentes, lo recibe igual
por el ancestro.

*(Menor, ya señalado por el informe y no tocado aquí: `provider-handoff.ts:250` y
`capcom.ts:441` escriben los dos el mismo `runtime/CLAUDE.md`. No cuesta tokens; son dos dueños
de un fichero.)*

## Qué hace falta para que entre en producción

El arreglo vive en el collector. **La sesión de CAPCOM que manda ahora mismo seguirá pagando sus
4.478 tokens por petición hasta que el collector vuelva a preparar un traspaso**: es en ese
momento cuando `demoteArchivedRules()` baja a `rules/` los 13 archivos ya escritos —incluido el
que la sesión viva tiene por ancestro—, y Claude Code, que relee sus ficheros de reglas en cada
petición, deja de verlo en la petición siguiente. No hace falta relevar a CAPCOM para curarlo: el
siguiente NEW CAPCOM o CHANGE MODEL que pase por `review()` lo hace. Un reinicio del collector no
es necesario ni suficiente por sí solo.

No se reinició el hub ni el collector, y no se tocó nada bajo `~/.orca`: todo lo medido «después»
se hizo sobre una réplica en el scratchpad de la sesión.

## Verificación

```
npm run typecheck                  limpio
npm test -- --changed              325/325 (suites alcanzadas por lo tocado)
npm test                           62/62 suites
```

Scripts de medición reproducibles en el scratchpad de la sesión: `cadena.py` (la cadena de
ancestros, en tokens), `resumen.py` (antes/después con duplicación por sha256), `relevo.ts` (el
camino completo de un relevo con el código de este árbol, sobre una réplica del `~/.orca/capcom`
real).

## Filtros que lo cubren

```
npm test -- provider-handoff       el respaldo fuera de la cadena, la degradación de los archivos
                                   ya escritos, y que el destino conserva su brief completo
npm test -- capcom capcom-new      activación y reset: que nada de esto los mueve
```
