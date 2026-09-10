# FORGE · permisos rutinarios y elevados

Misión: `forge-permissions-01`.

FORGE lanza su líder y descendientes con `permissionMode: auto`. La política
común autoriza lecturas, búsquedas locales, typecheck, tests y edición dentro
del worktree/proyecto y alcance asignados. Antes de acciones elevadas o
ambiguas, pausa la acción y pide revisión de CAPCOM: borrado, detención de
procesos, recarga de servicios, deploy/publicación/push/merge, secretos, red
externa, salir del proyecto (incluidos symlinks) o cambiar permisos.

Se inspeccionaron spawn, los argv de runtimes, los briefs, dispatchForge,
publisher y el canal de escalaciones antes de editar. Una revisión independiente
de solo lectura confirmó los contratos y el límite de la postura auto.

## Cambios consolidados

- `src/shared/forge.ts`: política de ejecución común, independiente de la
  identificación de squads usada por publisher.
- `src/shared/improve.ts`: brief inicial del líder con política rutinaria y
  escalación elevada; reemplaza la instrucción anterior de usar manual.
- `src/hub/improve.ts`: líder FORGE en auto; conserva la postura previa de
  este árbol para implementadores ajenos a FORGE.
- `src/collector/spawns.ts`: hijos en auto; conserva herencia de squad,
  padre, límites y condición de miembro.
- `src/collector/briefs.ts`: collector añade la política a líderes y miembros
  FORGE, aunque el brief de tarea no la incluya.
- `test/forge.test.ts`, `test/improve-agent.test.ts`: fronteras de permisos,
  herencia en hijos/nietos, propagación del brief, publicación y control final.
- `docs/FORGE.md`, `docs/AUTOMEJORA.md`: contrato actualizado y límites.

El miembro escala al líder mediante `orca-tell`; el líder usa `orca-ask` para
CAPCOM. Si CAPCOM no está disponible, sigue el fallback existente a cola
humana. El líder no puede concederse autoridad elevada. Puede continuar
trabajo independiente mientras espera. No se añade otro canal ni se responden
automáticamente prompts nativos.

La exclusión existente de `publisher.finishedOwnWork` sigue basándose en
`forge-…`, independiente de permisos: ni lead ni miembro terminado dispara
publicación. El informe no cierra automáticamente la misión. CAPCOM conserva
revisión final, cierre y publicación.

## Verificación

- `npm test -- forge improve-agent spawns permissions publisher`: **50/50**.
  Incluye herencia del squad frente a un intento de elegir otro, nietos auto,
  política inyectada sin depender de la tarea, todas las categorías elevadas,
  agentes ordinarios sin esa política, publisher excluyendo FORGE y misión
  activa tras el informe del líder.
- `npm run typecheck`: primera corrida bloqueada por TS2322 en
  `test/capcom-feedback.fixture.ts:58`, cambio concurrente ajeno: `pane` string
  donde se espera boolean. Avisado al proyecto sin editar su fixture. Tras
  su corrección concurrente, la segunda corrida pasó sin diagnósticos.
- `npm test -- --changed`: **873/873**, 69 suites seleccionadas por 57
  archivos del árbol compartido, incluidos cambios ajenos a esta misión.
- `git diff --check`: correcto al consolidar; el whitespace concurrente de
  `src/ui/windows/kinds/ceo.ts` detectado inicialmente ya fue corregido.

## Riesgos y límites

Esta es una política operativa, no un clasificador de shell ni una sandbox.
El nombre de un comando no acredita sus efectos: un test que borra datos,
detiene procesos o usa red externa también debe escalar. Los tests de texto
comprueban que se entrega la instrucción; no prueban obediencia de un modelo.

En el launcher actual, Codex auto desactiva aprobaciones y sandbox por defecto;
`ORCA_CODEX_APPROVALS=1` restaura `on-request`/`workspace-write`. Claude recibe
su modo auto nativo. Esa traducción no cambia en esta misión. La exclusión
de publisher sí es un control en código, pero no impide que un agente que
incumpla el brief invoque publicación por shell.

Se preservaron los cambios preexistentes y concurrentes del árbol compartido.
No se ejecutaron publicaciones, deploys, acciones destructivas ni pruebas
contra sesiones reales. Las fixtures usan agentes sintéticos y stores
temporales. No hay cambios visuales; no se ejecutó `npm run visual`.
El selector avisó de falta de suites para 17 archivos del árbol compartido:
`DESIGN.md`, `README.md`, `bin/orca.mjs`, `docs/AUTOMEJORA.md`,
`docs/ENTREGA-VENTANAS-CANVAS-2026-09-09.md`, `src/ui/hud/command.ts`,
`src/ui/main.ts`, `src/ui/styles/hud.css`, `src/ui/styles/window.css`,
`src/ui/windows/kinds/agent.ts`, `src/ui/windows/kinds/misc.ts`,
`docs/ENTREGA-AGENT-CONTEXT-STOP-2026-09-10.md`,
`docs/ENTREGA-APARCAR-OCIOSOS-2026-09-10.md`,
`docs/ENTREGA-FORGE-CANVAS-2026-09-10.md`,
`docs/ENTREGA-VENTANAS-CONTROL-2026-09-10.md`, `docs/FORGE.md` y
`test/capcom-feedback.fixture.ts`. Este documento, creado durante la corrida,
tampoco tiene suite de contenido. Todo el código modificado por esta misión
sí está alcanzado por las suites seleccionadas.

Filtros de cobertura: `forge`, `improve-agent`, `spawns`, `permissions`, `publisher`, `squads`, `commands`, `codex`.
