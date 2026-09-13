# Journal: contabilidad y trazabilidad

Los fines son muestras acumuladas. La lectura agrupa por
`(machineId, agentId)` y suma el máximo de `entryTokens()` de cada sesión,
también para el total y el promedio por proyecto. Las entradas sin identidad
se mantienen independientes. Los fines, estados y duraciones siguen siendo
registros de tramos; no se han convertido en sesiones únicas.

## Componentes y compatibilidad

`usage.tokens` conserva la magnitud histórica para compatibilidad, ahora
deduplicada, con `usageBasis: legacy-mixed-ceiling-session-max`.
No representa tokens nuevos ni coste. La descripción y el resumen de
`journal_stats`, el CLI y el digest señalan esa limitación.

`tokenComponents`, global y por proyecto, ofrece máximos acumulados
independientes por sesión para entrada, salida, lectura y escritura de caché.
No suma thinking otra vez. Expone sesiones medidas y sin medición.
`cacheWriteKnown` es la parte observada; `cacheWrite` y `newTokens`
son null cuando faltan escrituras o sesiones medidas. Una sesión con alguna
muestra sin cacheWrite sigue marcada incompleta aunque otra muestra lo traiga:
no se inventa su máximo histórico ausente.

## Corpus congelado

Se copiaron sólo los siete JSONL a `/tmp/orca-journal-frozen-exhfd88r`.
El manifiesto de hashes y el corpus quedan fuera del repositorio.
Verificación: 2026-09-13 06:11 UTC, usando `journal_stats` del código modificado
sobre esa copia y una agrupación independiente para contrastarlo.

| Magnitud | Resultado |
| --- | ---: |
| Fines medidos | 263 |
| Sesiones medidas | 216 |
| Sesiones con fines repetidos | 25 |
| Suma ingenua de entryTokens por fin | 3.053.476.288 |
| journal_stats, máximos por sesión | 2.672.037.994 |
| Exceso eliminado | 381.438.294 |
| Factor de inflación anterior | 1,142751823× |

El exceso es exactamente la suma de cada grupo menos su máximo. Coincide
con el corpus de G1; una cifra fija sobre el corpus vivo no habría sido un
criterio reproducible. El fixture permanente es sintético: 100, 150 y 120
para una sesión, más 40 para el mismo agentId en otra máquina; devuelve 190,
no 410 ni 160.

Las componentes de esa copia son entrada 291.440.174, salida 13.611.953,
lectura de caché 3.339.521.495 y escritura conocida 12.079.685.
Hay 164 sesiones con muestras sin escritura de caché; el total de tokens
nuevos es desconocido. Estas componentes no deben reconciliarse sumándolas
contra la antigua magnitud mixta: ésta usa criterios distintos según la
presencia de cacheWrite.

## Trazabilidad hacia adelante

La razón del watchdog viaja por la rotación directa o queda guardada en el
plan del relevo preparado y se emite al activarlo. Se registran también
traspasos manuales, resets con cambio de sesión y recuperaciones.
Los relevos detectados sin aviso dicen causa desconocida. Las rotaciones
históricas quedan intactas.

Las respuestas emitidas por World llevan el id de la escalación. Las
preguntas creadas por CAPCOM también lo conservan. Un id explícito es
autoritativo: el journal no toma los metadatos de otra pregunta abierta del
mismo agente cuando no encuentra ese id.

El origen `from: ceo` se guarda en la escalación y sobrevive a su
serialización y sanitización. Hay dos entradas al triaje: el evento en
server.ts y el barrido periódico, que llama a sweep y después a offer.
El evento filtra from y offer lo vuelve a comprobar para proteger ambas
rutas, llamadas directas y reintentos. La prueba usa un CAPCOM sustituto,
sin ceoAttempt, conserva el id y comprueba que no hay entrega ni triaje;
repite offer y sweep tras restaurar el registro y crear un router nuevo.
No depende de un mapa de exclusiones en memoria.

## Precisiones respecto del encargo

- Las retiradas ya tenían id y causa en closeEscalation y pruebas para sus
  seis vías de cierre en este HEAD. Se conserva ese recorrido y se prueba
  además el emparejamiento después de reiniciar el journal.
- World omitía el id de las respuestas. Además, upsertEscalationLocal
  omitía deliberadamente el id de la pregunta como protección anti-bucle.
  Son dos omisiones distintas; no se ha reconstruido la causa de cada
  registro histórico ni acreditado retrospectivamente los 81 pendientes.
- El barrido no filtraba from. Tenía guardias por identidad del CAPCOM
  actual y ceoAttempt; no bastaban para un origen durable tras un relevo.
- El código ya tiene compactaciones por defecto en 4. No se modificaron
  presupuestos, umbrales ni aprobación de permisos.

No se modificaron datos vivos, CAPCOM ni archivos históricos. No hay
cambios de UI ni se ejecutaron shots o escenas visuales.

## Verificación

- `npm run typecheck`: correcto sobre el código final.
- `npm test -- --changed`: 110 suites, 1.332/1.332 pruebas correctas
  sobre el código final; sin avisos de archivos sin suite.
- `npm test -- capcom journal rotation provider-handoff`: 209/209,
  incluida la prueba anti-bucle y el emparejamiento tras reiniciar el journal.
- `npm test -- journal improve gestures`: 145/145 para componentes y
  sus lectores. La corrida final afectada también incluye estas suites.
- `git diff --check`: correcto.

Las primeras iteraciones detectaron errores de tipado en fixtures y dos
fallos en las pruebas nuevas; quedaron corregidos antes de estas corridas
finales. No se presenta una corrida sin ejecutar suites como verificación.

Filtros de cobertura: `journal`, `rotation`, `capcom`,
`capcom-new`, `provider-handoff`, `improve`, `gestures`.
