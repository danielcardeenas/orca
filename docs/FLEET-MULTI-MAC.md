# Una flota en dos Macs

Un hub, un collector por máquina, y CAPCOM repartiendo el trabajo entre las
dos sin que nadie tenga que nombrarlas. Este documento dice qué había, qué
faltaba para que un segundo Mac fuera **capacidad** y no sólo **presencia**, y
cómo se suma uno.

## Lo que ya estaba

La arquitectura siempre fue de varias máquinas: `Machine` se define como «tu
Mac, un VPS, un contenedor», cada collector mantiene una única conexión
saliente al hub, y el hub enruta cada comando por `machineId`. CAPCOM se apaga
solo en un collector que marca a un hub remoto, así que dos máquinas nunca
llevan dos CAPCOM. El acceso por Tailscale ya está resuelto en
`docs/REMOTE-ACCESS.md`: el hub escucha en `0.0.0.0:4479` y el arranque lo
publica por https dentro de la tailnet.

Lo que se ve igual desde cualquier sitio, sin hacer nada: agentes, feed,
conversaciones, escalaciones, mensajes, artefactos (viajan como bytes por el
collector), la charla con el CEO, journal, costes y presupuestos. Todo vive en
el hub o llega hasta él.

## Lo que faltaba

Conectar el segundo collector funcionaba. Lo que no funcionaba era que le
llegara trabajo:

1. **CAPCOM no veía las máquinas.** `list_fleet` devolvía proyectos, bloqueados
   y escuadrones. Ni cuántas máquinas hay, ni cuál está cargada, ni en cuál
   vive cada proyecto.

2. **Dos clones eran uno.** El id de proyecto lleva la máquina
   (`<machineId>/<slug>`), pero CAPCOM habla en códigos, y el mismo repo
   clonado en dos Macs es dos proyectos con el mismo código. `findProject`
   hacía `find` por código: siempre el primero, siempre la misma máquina. El
   segundo Mac podía estar vacío y no recibir nunca nada.

3. **Una ruta nueva con dos máquinas era un error.** `spawn_agent` con una
   ruta absoluta que ORCA no conoce la registra en el collector que la tiene.
   Con una máquina no hay duda; con dos, `projectFor` se negaba: «a path does
   not say which one owns it».

4. **El CLI también se negaba.** `orca spawn AX "..."` con dos clones de AX
   fallaba con «matches 2 projects — use the id».

## Lo que cambió

Todo en `src/agents/tools.ts`, salvo el brief y el CLI.

- **`list_fleet` lista las máquinas.** Cada una con `name`, `online`,
  `live_agents`, `cpu_pct`, `mem_pct` y los códigos de proyecto que tiene,
  incluidos los clones sin ninguna sesión todavía, que la lista de proyectos
  sigue dejando fuera. Cada proyecto lleva además `machine`. El resumen dice
  «2/2 machines online» sólo cuando hay más de una.

- **El clon menos cargado se lo lleva.** `pickProject` ordena las
  coincidencias: primero las máquinas en línea, luego las de menos agentes
  vivos, luego menos CPU. Un clon del arnés sintético sortea siempre último.
  Con una sola coincidencia devuelve lo mismo que antes: en un Mac nada
  cambia, ni el texto del resumen.

- **`machine` en `spawn_agent`, `launch_squad` y `register_project`.** Un
  hostname (entero o su primera etiqueta) o un id de `list_fleet`. Fija el
  lanzamiento a esa máquina; una desconocida o fuera de línea es un rechazo
  legible que lista las que hay. Un escuadrón nunca se parte entre máquinas:
  sus miembros comparten disco.

- **Una ruta se pregunta a todas.** Con varias máquinas, `projectFor` manda
  `project:register` a cada collector real en línea. Cada uno la registra si
  tiene la carpeta y la rechaza si no; entre las que la tienen se lanza en la
  menos cargada. Si ninguna la tiene, el error trae el motivo de cada una.

- **El brief de CAPCOM** dice que la flota puede abarcar varias máquinas, que
  el reparto es automático, cuándo nombrar una, y que lo que un worker
  commitea llega a la otra máquina por git y no por ORCA.

- **`orca spawn|squad|launch --machine <host|id>`.** Y sin `--machine`, dos
  clones del mismo repo (mismo código, misma ruta, máquinas distintas) ya no
  son ambigüedad: el CLI pasa el código y el hub reparte.

## Sumar un segundo Mac

En el Mac nuevo, con Tailscale en la misma tailnet:

```
git clone <repo de orca> ~/projects/orca && cd ~/projects/orca && npm install
mkdir -p ~/.orca && scp <mac-principal>:~/.orca/token ~/.orca/token && chmod 600 ~/.orca/token
ORCA_HUB_URL=ws://<mac-principal>.<tailnet>.ts.net:4479 ORCA_WORKTREES=1 npm run prod:collector
```

Con el hub publicado por `tailscale serve`, vale también
`ORCA_HUB_URL=wss://<mac-principal>.<tailnet>.ts.net`. El collector le añade la
ruta del socket él solo.

Lo que tiene que haber en el Mac nuevo:

- **El mismo commit de ORCA.** El hub rechaza formatos de cable viejos por
  versión de collector; dos checkouts distintos son dos protocolos distintos.
- **`claude` (y `codex`, si se usa) con sesión iniciada, y tmux.** Los workers
  corren ahí; el hub sólo manda.
- **Los repos clonados, en la misma ruta que en el Mac principal.** No es
  obligatorio, pero con la misma ruta `spawn_agent /Users/dan/projects/x`
  encuentra la carpeta en las dos y el visor de archivos de la consola, que lee
  del disco del hub, enseña lo que un worker del otro Mac cita.
- **Un remoto git común.** Es el punto de encuentro de los resultados: un
  worker deja commits en el disco del Mac donde corrió. Con `ORCA_WORKTREES=1`
  cada worker trabaja en su rama, y el brief debe pedirle push cuando alguien
  en la otra máquina necesita lo que hizo.

Para comprobar que se ha sumado:

```
orca health          # «2 collectors»
orca ls              # los proyectos de las dos máquinas
```

## Lo que sigue siendo por máquina

- **Claves de proyecto** (`key:set`): nunca salen de la máquina que las guarda.
  Un proyecto que necesita una clave la necesita en cada clon que la use.
- **Presupuestos por proyecto**: van por id, y dos clones son dos ids. El de
  escuadrón y el de agente no cambian.
- **`/api/file`** lee del disco del hub. Un archivo que no es artefacto y no
  está en el Mac principal no se abre desde la consola.
- **Un proyecto sin sesiones** no aparece en la lista de proyectos de
  `list_fleet` (como siempre), pero sí en `machines[].projects`, que es donde
  CAPCOM mira qué máquina tiene una copia.

## Pruebas

```
npm test -- multi-machine capcom cli briefing
```

`test/multi-machine.test.ts` es la suite nueva, toda en caja: un `CeoContext`
con dos máquinas, dos clones y un `dispatch` que apunta a dónde fue cada
comando. Cubre el survey con máquinas y carga, el reparto al clon menos
cargado, `machine` por hostname, etiqueta corta e id, el rechazo legible de una
máquina desconocida o fuera de línea, el alta de una ruta sólo en la máquina
que la tiene y el rechazo con motivos cuando ninguna la tiene, un escuadrón
entero en un solo clon, que con una máquina el resumen es el de siempre, y
que el arnés sintético nunca recibe trabajo real.

`test/cli.test.ts` añade un caso con un hub de verdad y una segunda máquina
inyectada con un clon del proyecto de la flota falsa: `orca spawn <code>
--machine <host>` cae en esa máquina, sin `--machine` el CLI ya no dice
«matches 2 projects» sino que se lo deja al hub, y una máquina inventada es
exit 1 con la lista de las que reportan.

Lo que no cubre ninguna prueba: dos Macs de verdad. El collector remoto, el
token compartido y la tailnet están probados en `docs/REMOTE-ACCESS.md` para la
consola, no para un segundo collector con workers. La primera vez que se sume
un Mac hay que mirar `orca health` y `list_fleet` antes de fiarse.
