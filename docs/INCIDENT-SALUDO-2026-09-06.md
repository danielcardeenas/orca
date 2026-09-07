# Prueba de saludo: 6 de septiembre de 2026

Horas de Taipei (UTC+8). Revisados eventos del hub, transcripts de Claude,
pantallas actuales de tmux y los archivos producidos. No se enviaron mensajes,
no se pulsaron teclas ni se detuvieron agentes durante esta revisión.

## Lo que ocurrió

- 09:19:28: el usuario pide «lanza dos agentes que se saluden».
- 09:19:46: CAPCOM anuncia el squad `saludo-01` y promete avisar. Añade por
  iniciativa propia escritura de logs dentro de su proyecto `capcom`.
- 09:20:03: A (`QM`, `ebc67eca-db0f-4ea2-8bcf-38d444a94627`) envía el saludo.
- 09:20:14: B (`B1`, `9b35c8d3-90d6-43cb-a340-87ecbef148ef`) responde.
- 09:20:36: A confirma. El saludo solicitado ya está completo.
- 09:21:00: B reporta que no puede escribir archivos; tampoco su subagente.
- Hasta 09:27:27: A intenta delegar la escritura en más agentes, varios en la
  misma carpeta restringida. Los eventos registran subdelegación hasta depth 3.
  Finalmente un trabajador del proyecto ORCA escribe los logs en la ruta pedida.
- 09:27:41: A da su respuesta final y queda idle. CAPCOM conserva su respuesta
  de 09:19:46; no recibió un turno de finalización.

Los tiempos de mensajes se contrastaron con llamadas `mcp__orca__relay` en los
transcripts, no solo con los logs reconstruidos por el trabajador.

## Causas

1. Los trabajadores se lanzaron dentro de `~/.orca/capcom`. Heredaron las
   instrucciones de coordinador y `.claude/settings.json`, que deniega Bash,
   Edit, Write y NotebookEdit. La restricción no se limita al proceso CAPCOM.
2. Una prueba de saludo se convirtió en una tarea de escritura no solicitada.
   Delegar otra vez dentro de la misma carpeta reprodujo el bloqueo.
3. No hubo devolución automática del resultado a CAPCOM. Que un trabajador
   termine su turno no termina su proceso hospedado ni inicia un turno del jefe.
4. En la inspección de pantalla, «¿ya terminaron los agentes de saludo?» estaba
   todavía en el editor de CAPCOM, sin un turno correspondiente en su transcript.
   Por tanto, paste/Enter y acuse del collector no prueban aceptación por el CLI.
   No se pulsó Enter para no interferir con una entrada que podía estar editando
   el usuario. Hace falta un contrato de aceptación por el runtime.
5. `inspect_agent("B1")` devolvió inicialmente un agente ajeno del proyecto
   axolots. Los callsigns se repiten entre proyectos; A corrigió la consulta
   usando el ID completo. Es otra ambigüedad pendiente de resolver.

## Corrección aplicada

El collector rechaza lanzamientos de trabajadores en la carpeta de CAPCOM y
sus descendientes, resolviendo también rutas reales. No se relajan permisos.
`list_fleet` señala el proyecto de control, y los briefs prohíben usarlo para
trabajadores, añadir artefactos a pruebas mínimas o prometer avisos sin una ruta
de retorno real. La suite de squads pasa 22/22 y el typecheck pasa.

Esta corrección evita repetir la herencia de restricciones. No implementa aún
la aceptación verificable por el CLI, el retorno automático al jefe ni la
resolución no ambigua de callsigns.

## Evidencia local

- `~/.orca/hub/ceo.jsonl`
- `~/.orca/hub/events/2026-09-06.jsonl`
- `~/.claude/projects/-Users-danielcardenas--orca-capcom/57ec8a2f-771f-49de-ab56-60a30bce72f0.jsonl` (CAPCOM)
- Mismo directorio: transcripts de A y B con los IDs anteriores.
- `~/.orca/capcom/saludo/saludo.log`
- `~/.orca/capcom/saludo/saludoB.log`
