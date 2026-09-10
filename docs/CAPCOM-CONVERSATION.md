# La conversación de CAPCOM

Dos cosas de la ventana de CAPCOM: en qué orden se lee un hilo, y cómo se pasa
de una conversación a otra. Eran dos molestias distintas con la misma raíz —la
ventana enseñaba lo que tenía, en el orden en que lo tenía, sin decidir nada— y
se arreglan aquí.

## El orden del hilo

El transcript nunca estuvo desordenado. `mergeTalk` ordena por hora y `foldTalk`
respeta lo que recibe. Lo que se salía de sitio era el **eco local**: la copia de
tu línea que la consola pinta en cuanto la manda, con `DELIVERED · 0.1s` debajo,
mientras el transcript del CLI todavía no la ha confirmado.

Dos fallos, los dos en `src/ui/windows/kinds/ceo.ts` y `src/ui/windows/talk.ts`:

**Se pintaban al final.** El hilo era `groups` y después `echoes`, en dos pasadas.
Daba igual cuándo escribiste: el eco iba debajo de todo. Ahora las dos fuentes se
mezclan por hora (`timeOrdered`), y un eco se sienta en el minuto en que lo
escribiste, no al pie de lo que CAPCOM haya dicho desde entonces. Vale igual para
la vista general y para la de una misión.

**Un eco podía no apagarse nunca.** `echoLanded` compara texto exacto, y el texto
no siempre vuelve igual: el hub envuelve algunos prompts y el CLI junta lo que
tenía en cola. Un eco que no se reconoce se queda encendido para siempre.
`pendingEchoes` añade una segunda regla: la entrada del CLI es una fila, así que
si algo que dijiste **después** ya está en el transcript, lo de antes ya pasó por
ahí y su eco sobra.

La regla es deliberadamente estrecha. No vale «cualquier prompt más nuevo»: un
mensaje tuyo en cola se escribe cuando le toca, y un prompt ajeno posterior —una
escalación que el hub relaya, el brief de arranque— borraría tu eco justo
mientras espera. La comparación es sólo contra tus propios envíos.

## La navegación entre misiones

Estaba partida en dos sitios y ninguno tenía lo que decide a dónde ir. El
desplegable de la ventana daba título y estado, y había que abrirlo para saber
qué existía; el panel del HUD sí tenía fase, movimiento y tripulación, pero está
arriba a la derecha, se pliega, y cualquier ventana lo tapa.

### La cinta

> **2026-09-08.** La cinta dejó de ser un selector de vista y pasó a ser una
> puerta: cada misión tiene su propia ventana (`kinds/mission.ts`), así que
> pulsar una pestaña la abre o la trae al frente en vez de cambiar la ventana de
> CAPCOM por su conversación. Con ello desaparecen de aquí la pestaña GENERAL
> —CAPCOM ya no es más que su propia sesión—, el botón ARCHIVE, que se fue a la
> ventana de la misión, y el scroll recordado por conversación, que ahora es el
> de cada ventana. Lo que sigue vale igual: el punto, el orden y el pliegue bajo
> `MORE`. Ver [MISSIONS.md](MISSIONS.md), «Cómo se navega».

El desplegable es ahora una fila de pestañas siempre visible: las misiones
abiertas, un clic cada una, con un punto que lleva la fase y el tiempo desde el
último movimiento. Lo terminado se pliega bajo `MORE`, que es el `pick` de antes
con lo que ya no se navega.

El punto sale de `missionRows`, el mismo cálculo que pinta el panel del HUD, así
que la ventana y el panel no pueden discrepar:

| punto | fase | qué dice |
| --- | --- | --- |
| lima | `progress` | hay tripulación viva en ello |
| ámbar | `waiting` | CAPCOM dijo la última palabra y nadie trabaja: **te toca** |
| azul | `queued` | está con CAPCOM, todavía sin respuesta |
| apagado / rojo | `completed` / `failed` | terminada |

El orden es el de apertura, no el de movimiento (`railSplit`, en
`src/ui/hud/mission-status.ts`). Es la diferencia con el panel del HUD, y es a
propósito: una pestaña que se mueve sola es una pestaña que se pulsa mal. La
cinta crece por la derecha y nada cambia de sitio bajo el cursor mientras la
flota trabaja. La única excepción a «lo terminado se pliega» es la conversación
abierta, que siempre se ve: una cinta que no dice dónde estás no es navegación.

### La mirilla

En GENERAL, una misión aparecía como un chip con la frase «ábrela para leer el
intercambio». Un callejón: para saber de qué iba había que cambiar de vista.

El prompt que recibe CAPCOM no sirve para enseñarlo —el hub le adjunta el
contexto entero de la misión y ocupa una pantalla—, pero la conversación de la
misión sí. `missionGlimpse` (`src/shared/missions.ts`, junto a `missionDebt`)
saca las dos líneas que explican el prompt: la que lo provocó y la primera
respuesta de CAPCOM que vino después.

Lo que lo provoca no es forzosamente tuyo. A una misión se entra también porque
un worker reportó algo y el hub despertó a CAPCOM con ello; esa línea explica el
prompt igual de bien, así que la mirilla acepta cualquier rol menos CAPCOM, que
es quien contesta. Con la regla anterior —sólo `human`— cinco de los once grupos
de misión de una sesión real se quedaban sin nada que enseñar.

La línea es la **más cercana** al momento, no la última que quepa: el hub guarda
el mensaje y luego lo despacha, y quien fecha el prompt es el CLI cuando lo
escribe, siempre un poco después. Sin esa precisión, dos prompts de la misma
misión enseñarían los dos la línea más nueva.

### El sitio donde lo dejaste

Cada conversación recuerda su scroll. Volver a una misión te devuelve donde
estabas, en vez de al fondo. Sobrevive al cambio de pestaña, no a la recarga:
es un scroll, no un estado.

## Validación

```
npm test -- talk missions mission-status capcom-window drafts
npm test -- --changed                  775/775
npm run typecheck
```

`test/talk.test.ts` cubre el eco adelantado por el transcript —y el caso
inverso, el que sigue en cola y no debe borrarse— y el orden por hora de las dos
fuentes. `test/mission-status.test.ts` cubre que la cinta conserva el orden de
apertura pase lo que pase con la flota, y que lo terminado se pliega salvo la
conversación abierta. `test/missions.test.ts` cubre la mirilla: la línea correcta
para cada prompt, la respuesta que le sigue, el caso sin respuesta todavía y el
prompt que provocó un worker en vez del operador.

Comprobado además contra la consola viva (Playwright sobre `localhost:4478`, la
flota real): la cinta con GENERAL y tres misiones de las tres fases, el cambio de
pestaña, y once de once grupos de misión con mirilla donde antes había seis.
