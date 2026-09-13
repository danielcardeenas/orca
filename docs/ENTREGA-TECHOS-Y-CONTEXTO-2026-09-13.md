# Techos de tokens y contexto de CAPCOM — 2026-09-13

Trabajo sobre el código de ORCA, con base en `05032f9`. No se escribió dentro
de `~/.orca/capcom`, no se reiniciaron servicios ni se tocó la autopsia paralela.

## 1. Default del hub: 23.000.000 tokens

`src/hub/budgets.ts:budgetConfig` leía `ORCA_DEFAULT_BUDGET_TOKENS` con fallback
`null`: ningún límite. Ahora el fallback es 23.000.000, también si el valor está
vacío o es inválido. Un valor positivo explícito conserva prioridad.

Se fija en código porque el repositorio no tiene `.env` ni `.env.example` que
establezcan estos valores. `package.json` permite arrancar el hub por `start`,
`dev:hub`, `dev:orca` y `prod:orca`; `tools/supervise.mjs` hereda el entorno sin
imponer este techo. `src/hub/server.ts` crea el libro con `budgetConfig()`.
Un fallback único cubre todos esos arranques sin exigir un export del operador.

Sigue avisando al 80%; al 100% sólo para cuando falta progreso reciente.
`ORCA_BUDGET_ACTION` sigue siendo `stop` por defecto, con `warn` disponible;
la ventana de progreso sigue siendo tres minutos. La prueba nueva recorre
80%, 100% con progreso y 100% sin progreso usando el default real sin entorno.
Los techos explícitos conservan prioridad. Dos fixtures de pruebas que daban
por ilimitadas sesiones ajenas reciben un techo explícito de 100M para seguir
comprobando la independencia de escuadrones y descendientes.

**Matiz a la petición:** el default ya excluía a CAPCOM y a los subagentes Task
como sujetos independientes; estos últimos cargan al ancestro. Se conserva.
Por tanto, no es un límite universal del comandante ni impide que un worker
que sigue progresando supere 23M. Cuenta entrada + salida + escritura de caché,
no lecturas de caché; no se puede comparar directamente con un total del
journal sin comprobar qué unidades incluye.

**La nota monetaria está desactualizada:** desde el 2026-09-12 se eliminó el
eje monetario, no sólo se desactivó. `BudgetConfig`, `BudgetLimit` y las
herramientas actuales no tienen `budget_usd`; `ORCA_BUDGET_MONEY=1` ya no lo
reactiva. `docs/BUDGETS.md` registra esa retirada y `test/budgets.test.ts`
comprueba que los dólares de libros antiguos se ignoran. No se modificó ese
comportamiento ni se reintrodujo el interruptor.

## 2. Default del collector: cuatro compactaciones

`src/collector/rotation.ts:ROTATION_DEFAULTS.maxCompactions` pasa de 2 a 4.
`rotationConfig()` lo lee para el collector; tampoco hay una configuración de
arranque del repositorio que lo sustituya. La prueba verifica que tres
compactaciones aún no disparan, cuatro sí cuando se permite rotar y un
valor explícito de entorno sigue prevaleciendo.

No cambian los 300 turnos, los 30 segundos de silencio ni el modo de
continuidad. **Hay además un umbral de ventana del 75%**, que puede disparar
antes de la primera compactación y tampoco cambia. El ahorro esperado es
menos arranques por compactaciones; no se promete reducir las rotaciones a la
mitad ni se han reproducido las cifras del journal de la petición.

## 3. Duplicación: aplicable al diseño antiguo, ya corregida

No requiere otro cambio de código. Dos commits anteriores ya arreglaron
exactamente la estructura descrita:

- `59456d2` movió las copias archivadas de `CLAUDE.md` y `AGENTS.md` a `rules/`,
  hermano de `runtime/`, para que el respaldo no sea un ancestro cargable.
- `c63d075` cambió `capcomHandoffsDirFor(dir)` a `${dir}-handoffs`, hermano del
  directorio de CAPCOM. El collector pasa esa raíz a `ProviderHandoffs`.

Hoy un contexto nuevo se prepara en
`~/.orca/capcom-handoffs/<id>/runtime`. `CapcomSession.writeConfig` es el único
dueño del brief del runtime: usa `capcomBrief()` para continuidad y
`cleanCapcomBrief()` para limpio. El respaldo queda en `<id>/rules/`.
`capcom-reset.ts` hace `/clear` en el mismo pane; no crea ni copia un handoff.
`rotation.ts` decide cuándo y por qué rotar, sin copiar los briefs.

La observación de dos briefs largos y otro corto encaja con un handoff limpio
antiguo: brief vivo en `capcom/`, respaldo en `handoffs/<id>/` y política corta
en `runtime/`. Son dos copias íntegras más una política corta, no tres copias
íntegras. En continuidad el runtime puede aportar también el brief completo.

Los archivos antiguos no se reubican automáticamente. El código existente
puede bajar sus respaldos a `rules/` al preparar un relevo, pero una sesión
cuyo cwd siga debajo de `capcom/` conserva ese ancestro hasta un nuevo relevo
hacia el hermano. Esto explica que una sesión antigua conserve el problema
con el código ya corregido. No se inspeccionó su prompt vivo ni se ejecutó
esa migración: la verificación aquí es del generador y de fixtures temporales.

`test/provider-handoff.test.ts` ya comprueba una sola regla por cadena de
ancestros en continuidad, sólo el brief corto en limpio, conservación byte a
byte del respaldo y compatibilidad con archivos antiguos. No se retocaron
prompts ni se añadió una segunda solución al mismo defecto.

## Verificación

- `npm run typecheck`: código 0, también repetido tras el último ajuste.
- `npm test -- --changed`: **647/647 casos, 43 suites**, código 0. Incluye
  `budgets.test.ts` (23), `rotation.test.ts` (14), `collector.test.ts` y
  `worktrees.test.ts` (20). No hubo código editado sin suite que lo cubra;
  el selector excluyó correctamente los cuatro documentos Markdown.
- `npm test -- provider-handoff`: **11/11**, código 0; prueba adicional porque
  el cambio 3 no modifica código y por ello no lo selecciona `--changed`.
- `git diff --check` y `git diff --cached --check`: sin errores.

La primera corrida focal de presupuestos detectó dos fixtures que suponían
sesiones sin límite y una expectativa con nombre de evento incorrecto en la
prueba nueva; se corrigieron. La primera selección completa terminó 646/647:
un fixture de la ruta de relevo usaba tres compactaciones como disparador.
Se ajustó a cuatro y se repitieron las 43 suites completas con el resultado
verde anterior. No se ocultó ni se excluyó ninguna prueba fallida.

No hubo cambios de UI; no se corrieron shots ni escenas visuales. No se
midieron tokens ahorrados en producción ni se reiniciaron hub/collector:
los defaults se leen al arrancar cada servicio y entrarán en vigor con su
próximo arranque, salvo override explícito de entorno.

Commits de código: `1a3d2b0` (techo) y `965469e` (rotación). El tercer commit
es esta entrega: documenta por qué no corresponde duplicar un arreglo ya
presente y cuáles son sus límites para sesiones antiguas.

## Filtros que cubren esta entrega

- `npm test -- --changed`: suites afectadas por el código y las pruebas editados.
- `npm test -- budgets rotation collector worktrees`: filtros de los dos defaults
  y de sus integraciones (incluidos en la selección por cambios).
- `npm test -- provider-handoff`: estructura de briefs ya corregida y legados.
- `npm run typecheck`: comprobación de tipos.
