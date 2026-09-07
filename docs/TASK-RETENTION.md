# Retirar conversaciones de tarea

Una tarea creada no se podía quitar nunca. `TaskStore` tenía `create`, `message`,
`assign` y `bindSquad`, y ningún camino de vuelta: el selector de la ventana de
mando las mostraba todas para siempre, terminadas incluidas, y al llegar a cien
`create` lanzaba `Task limit reached (100)` y el hub se quedaba sin poder crear
tareas. No era una laguna de la interfaz; no existía la operación.

Ahora hay dos, deliberadamente distintas.

## Archivar, que es lo normal

`archivedAt` retira la tarea de la vista y no toca nada más. Conserva la
conversación entera, sus agentes, su estado y su historia, y se deshace. Una
tarea archivada:

- no sale en el selector de la ventana de mando ni en el panel de tareas del HUD;
- no deja arco en el halo del puesto de mando;
- no aparece en `list_tasks` ni en el checkpoint de continuidad de un CAPCOM nuevo;
- no recoge resultados nuevos de sus workers (`observe` la salta) ni despierta a
  CAPCOM cuando uno de ellos termina;
- **no cuenta contra el tope de cien**, que es lo que desatasca el callejón.

Volver es `restore`, y devuelve la tarea intacta.

## Purgar, que es lo definitivo

`purge` borra la tarea de `tasks.json` sin vuelta atrás, y **exige que esté
archivada**. Dos pasos a propósito: archivar es lo reversible y ya basta para
recuperar el sitio, así que lo único que llega a la purga es lo que alguien
decidió retirar y volvió a decidir borrar. El hub anuncia la baja con
`{ t: 'task', task, purged: true }`; la consola quita la fila en vez de pintarla,
y si era la conversación abierta vuelve a la general.

## Cómo se pide

En la ventana de mando, **ARCHIVE**, junto a NEW TASK, aparece cuando hay una
conversación de tarea abierta. Una tarea todavía activa pide confirmación —sus
workers siguen ahí y su hilo es lo que los explica—; una terminada se va sin
ceremonia.

Desde la barra:

```text
/tasks archive [task_id]     retira la abierta, o la que se nombre
/tasks restore <task_id>     la devuelve
/tasks purge [task_id]       borra, sólo si ya estaba archivada; pide confirmación
/tasks finished              archiva de golpe todas las terminadas
```

`/tasks finished` es el gesto de limpieza habitual: lo que se acumula sin que
nadie lo mire son las `completed` y `failed`.

## Qué NO hace un New CAPCOM limpio

Nada de esto. `New CAPCOM → Clean context` limpia el contexto del CAPCOM —la
sesión nueva no hereda conversación, checkpoint ni reglas— y ahí termina su
alcance. Las tareas, la conversación del hub, las reglas persistidas y los
workers siguen exactamente donde estaban.

Es deliberado en ambos sentidos. Un reset de contexto no debe borrar el registro
del hub por efecto colateral: ese registro es justamente lo que permite que la
sesión sea desechable, y lo que un CAPCOM nuevo lee con `briefing` para saber
qué se debe. Retirar tareas es una decisión aparte, y por eso se pide aparte.
Ver [CAPCOM-NEW.md](CAPCOM-NEW.md) y [CAPCOM-ROTATION.md](CAPCOM-ROTATION.md).

## Verificación

```sh
npm run typecheck
npm test -- tasks
npm test -- command task-status
npm test -- capcom-new provider-handoff
```

Sin cubrir por pruebas: el botón ARCHIVE de la ventana de mando y el comando
`/tasks` de la barra son DOM de la consola, y este repo no tiene arnés de DOM
para el selector. La lógica que ambos invocan —archivar, restaurar, purgar, el
tope, el filtrado de la vista y del listado— sí está cubierta, incluido el
recorrido por WebSocket que usa la consola.
