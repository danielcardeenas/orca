# El runtime de un relevo deja de colgar del directorio de CAPCOM

Squad `forge-vivas-01`, 2026-09-13. Continuación de
`docs/BRIEF-DUPLICADO-EN-RELEVOS-2026-09-12.md` (commit `59456d2`), que dejó esto como «la única
salida segura» y como la propuesta siguiente. Medido con `tiktoken/cl100k_base` sobre una réplica
del `~/.orca/capcom` real —sus `CLAUDE.md`/`AGENTS.md` vivos y los ficheros de reglas de los trece
archivos de relevo— con relevos armados por el código de este árbol.

## Por qué es corrección y no eficiencia

El destino de un relevo arrancaba en `~/.orca/capcom/handoffs/<id>/runtime`. Un CLI carga los
ficheros de reglas de **todos** los ancestros de su cwd, y `~/.orca/capcom/CLAUDE.md` —el brief
completo, que `capcom.ts` reescribe al arrancar el collector para el CAPCOM que corre directamente
ahí— era ancestro de ese cwd. El día 12 se quitó la copia del medio (`rules/`), y quedó ésta:

- un relevo de **continuidad** cargaba el brief dos veces: el suyo desde `runtime/` y el vivo desde
  `~/.orca/capcom/`;
- un reset **limpio** —el modo que promete no inyectar las reglas persistentes— escribía su brief
  corto en `runtime/` y recibía igual el largo entero por el ancestro.

Confirmado en vivo por la propia sesión de CAPCOM que encargó esto, que corre en modo limpio y
arrancó con tres copias completas del brief. Y confirmado en disco: los trece archivos siguen con el
`CLAUDE.md` en la raíz y ninguno con `rules/`, porque `demoteArchivedRules` sólo corre al preparar
un relevo y el último es del día 10.

## El arreglo, con la misma forma que el del día 12

`rules/` se hizo hermano de `runtime/` para dejar de ser su ancestro. Aquí se hace lo mismo un
nivel más arriba: **los relevos viven en un directorio hermano del de CAPCOM, no descendiente.**

```
antes   ~/.orca/capcom/handoffs/<id>/{runtime,rules,…}     capcom/CLAUDE.md es ancestro de runtime/
ahora   ~/.orca/capcom-handoffs/<id>/{runtime,rules,…}     ningún ancestro lleva un fichero de reglas
```

- `capcom.ts`: `capcomHandoffsDir()` = `<capcomDir>-handoffs`. Sigue al directorio de CAPCOM
  (`ORCA_CAPCOM_DIR` mueve los dos) y `CapcomSession` lo expone como `handoffsDir`.
- `provider-handoff.ts`: `ProviderHandoffs` recibe `archives()` —dónde archivar— aparte de `dir()`
  —el directorio de control: identidad, reglas vivas, actas—. Sin `archives()` sigue en
  `<dir>/handoffs`, que es lo que un worker usa y no cambia.
- `commands.ts` / `index.ts`: el canal de CAPCOM cablea `archives` y `configure`.
- `shared/workspaces.ts`: `capcomHandoffsHome()`. La consola y el registro de proyectos ya
  clasificaban por prefijo de slug, y el slug no distingue `/` de `-`: `capcom-handoffs/…` cae en
  la misma regla que `capcom/…`. **No es una coincidencia que se tolere**: el nombre se eligió así,
  está escrito en el comentario de `excludedWorkspace`, y `test/workspaces.test.ts` lo afirma para
  que renombrarlo no deje al CAPCOM relevado pintado como un proyecto.
- La guarda de spawn de `commands.ts` cubre también el hermano; `shared/hygiene.ts` lo añade a
  `PROTECTED` y `collector/hygiene.ts` lo mide como `recovery`; `hub/server.ts` lo sirve junto al
  de antes.

### Un solo dueño para `runtime/CLAUDE.md`

Denunciado el día 12 y no tocado entonces: `provider-handoff.ts` escribía el brief al preparar y
`capcom.ts:441` (`writeConfig`) lo reescribía al activar. **El dueño es `CapcomSession.writeConfig`**,
el mismo que escribe los tres ficheros con los que CAPCOM arranca en su directorio, al activar y al
recuperar. `ProviderHandoffs` ya no importa `capcomBrief()`: pide `configure(cwd, mode)` y el canal
de `index.ts` lo resuelve con `writeConfig`. Consecuencias que se ven:

- el runtime queda amueblado entero desde la preparación (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`,
  `.claude/settings.json`), y la activación lo refresca con el mismo código;
- un servicio sin `configure` **rechaza** un relevo con contexto nuevo antes de escribir nada, en
  vez de producir un runtime sin brief;
- el `cwd` del plan es siempre explícito. Sin contexto nuevo, el destino corre donde el origen: un
  worker en su proyecto, CAPCOM en su directorio. Antes se deducía como «abuelo del archivo», que
  con la raíz nueva habría sido `~/.orca`.

`cleanCapcomBrief()` sigue importado en `provider-handoff.ts` por el **prompt** de preparación de
un reset limpio, que no es un fichero.

## La demostración, con cifras

Réplica del `~/.orca/capcom` real, relevos armados con `review()` de este árbol, y la cadena de
ancestros recorrida hasta el padre común (`~/.orca`). Idéntico para `CLAUDE.md` y `AGENTS.md`:

| cadena de reglas del cwd | ficheros | tokens | duplicados |
|---|---|---|---|
| **hoy**: la sesión viva (`162ee578`, clean) | 3 | 189 + 4.478 + 4.478 = **9.145** | 4.478 |
| con `59456d2` solo: relevo clean bajo `capcom/` | 2 | 189 + 4.478 = 4.667 | 0 |
| con `59456d2` solo: relevo continuity bajo `capcom/` | 2 | 6.218 + 4.478 = 10.696 | 0 |
| **ahora**: relevo clean en `capcom-handoffs/` | 1 | **189** | 0 |
| **ahora**: relevo continuity en `capcom-handoffs/` | 1 | **6.218** | 0 |

**Un reset limpio recibe sólo el brief corto: 189 tokens de reglas por petición donde hoy recibe
9.145, de los que 8.956 son el texto que ese modo promete no inyectar.** Un relevo de continuidad
recibe su brief una vez: 6.218 donde recibía 10.696.

Scripts en el scratchpad de la sesión: `relevo.ts` (la réplica y los relevos) y `cadena.py` (la
cadena en tokens). No se tocó nada bajo `~/.orca`; ni hub ni collector se reiniciaron.

## Los trece archivos que hay en disco

Se quedan donde están, en `~/.orca/capcom/handoffs/`. Son el historial de las sesiones anteriores
del mando y no se han borrado ni movido. Lo que les pasa, exactamente:

- **Se siguen encontrando por id.** `planFile()` busca en la raíz nueva y, si no está, en la de
  antes; `has()` y `status()` siguen contestando por ellos (probado).
- **El próximo relevo baja su `CLAUDE.md`/`AGENTS.md` de la raíz a `rules/`**, como `59456d2`
  prometió y todavía no ha hecho: `demoteArchivedRules` recorre las dos raíces. No es un borrado
  ni un traslado del archivo; son sus dos ficheros de reglas un directorio más abajo.
- **La poda de lo superado los sigue alcanzando**, como hasta ahora: dos de ellos conservan
  `source.jsonl` y `conversation.md` (`162ee578`, el vivo, y `53291e39`); el próximo relevo poda
  el que no esté protegido por la identidad y deja `PRUNED.md`. Es el comportamiento que ya
  existía, no uno nuevo; se dice aquí para que nadie lo descubra después.
- **La sesión viva (`162ee578`) sigue pagando el ancestro hasta que se releve.** Su cwd está bajo
  `~/.orca/capcom/` y eso no se mueve —moverlo sería mover el cwd de un proceso en marcha—. Tras
  el próximo relevo pasa de 9.145 a 4.667 tokens (medido: sólo pierde la copia del medio); el
  CAPCOM que la releve, ya en `capcom-handoffs/`, paga 189 ó 6.218 según el modo.

Si el líder o CAPCOM quieren que los trece se trasladen a la raíz nueva, es una operación aparte y
pedida: nada de este cambio la hace.

## Qué hace falta para que entre en producción

El arreglo vive en el collector y en el hub (una línea en `servedRoots`). El primer NEW CAPCOM o
CHANGE MODEL que prepare un relevo con el collector nuevo crea `~/.orca/capcom-handoffs/` y arranca
al destino ahí. La sesión que manda hoy no cambia de sitio; cura al relevarse.

## Verificación

```
npm run typecheck                                   limpio
npm test -- provider-handoff capcom-new workspaces hygiene worker-recovery
                                                    104/104 tras añadir la raíz al sampler de higiene
npm test -- hygiene capcom                          187/187 (todas las suites capcom*)
npm test -- --changed                               108 suites, 1322/1322, código 0
                                                    (árbol compartido: recoge también lo de los
                                                    otros miembros del squad, ya en verde)
```

`--changed` avisó «sin suite que los cubra» por `docs/CAPCOM-RUNTIME-RECOVERY.md` (una ruta en
prosa) y por tres rutas de otros miembros. Sin shots: no hay UI tocada. Sin cubrir por suite: la línea de `hub/server.ts` (`servedRoots`)
y las dos de `collector/index.ts` (el canal `handoffsDir`/`configure`), que son cableado; las
pruebas de relevo cablean lo mismo a mano con un `CapcomSession` real.

## Filtros que lo cubren

```
npm test -- provider-handoff       el archivo y el cwd al lado de CAPCOM, un solo brief en la cadena,
                                   el reset limpio con sólo el corto, los archivos viejos en su sitio,
                                   y el rechazo sin dueño de la configuración
npm test -- capcom-new             activación y reset con la raíz hermana, el brief escrito por writeConfig
npm test -- workspaces             el hermano no es un proyecto
npm test -- hygiene                protegido y medido como recovery
npm test -- worker-recovery        los relevos de workers no se mueven
```
