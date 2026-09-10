# El turno de CAPCOM, en la línea de comandos

Mandabas una línea desde abajo y la línea se quedaba igual hasta que llegaba
la respuesta. Un mensaje enviado y uno perdido se veían idénticos durante
todo lo que tardara CAPCOM. El único sitio que lo decía era la tira de estado
de la ventana de CAPCOM, que no tiene por qué estar abierta.

## Qué hay ahora

**Un indicador en la línea de comandos.** A la izquierda del chip del
destinatario, un punto y una palabra: THINKING, la herramienta que tiene en
la mano (BASH, READ…), o WAITING ON YOU. Cian mientras piensa y trabaja, que
es el color de CAPCOM; ámbar cuando se ha parado a preguntarte, que es lo
único que el ámbar significa en la consola. El punto respira mientras el turno
está vivo y se queda quieto con `prefers-reduced-motion`. Sin turno, no hay
nada: el indicador no existe, no está apagado.

**Un microsonido cuando CAPCOM coge tu línea.** El evento `capcom.thinking`
suena al pasar de parado a vivo en los treinta segundos siguientes a algo que
le mandaste desde la consola: la línea de comandos, el composer o `⌥V`. Un
turno que empieza solo —una escalación que le reenvía el hub, el siguiente
paso de una misión— se ve en el indicador pero no suena, porque un tic por
cada turno de CAPCOM dejaría de significar nada. Y suena una vez por turno:
pasar de pensar a trabajar es el mismo turno.

El clip es `tick`, el mismo del deck: el sonido más pequeño del set, un
parpadeo y no un anuncio. No hay archivos nuevos en ningún pack; el evento
aparece en la ventana SFX bajo FLEET, como CAPCOM TOOK YOUR LINE, y se puede
cambiar de clip o silenciar como cualquier otro.

## Dónde está

| Pieza | Archivo |
|---|---|
| `capcomTurn`, la palabra que se enseña; `turnStarted`, el momento que suena | `src/shared/capcom.ts` |
| El indicador y su pintado | `src/ui/hud/command.ts` |
| El evento, su clip y la detección sobre el parche de agentes | `src/ui/hud/sound.ts` |
| La etiqueta en SFX | `src/ui/windows/kinds/sfx.ts` |
| `.cmd__turn` | `src/ui/styles/hud.css` |

Las dos funciones son puras y viven en `shared/capcom.ts` junto a `capcomOf`,
porque son la misma pregunta que ya se hacía ahí: quién es CAPCOM y qué está
haciendo. El sonido y el indicador leen el mismo estado; no hay dos maneras de
decidir que CAPCOM está pensando.

## Verificación

`npm test -- turn`: una palabra por estado, la herramienta mientras trabaja,
un bloqueo por otro agente no es esperarte, sin CAPCOM manda la bandera del
comandante API; y el tic sólo al pasar de parado a vivo poco después de tu
línea, no sin línea, no tarde, no dos veces en un turno, no al pararse a
preguntar, no con un reloj adelantado.

Sin cobertura automática: el pintado en `command.ts` y el disparo en
`sound.ts`, que son DOM y audio. Quedan por ver con la consola viva: mandar
una línea a CAPCOM y comprobar que abajo aparece THINKING con el punto, que
cambia a la herramienta, que se va al terminar, y que el tic suena una vez.

Filtros que cubren esta entrega: `turn`.
