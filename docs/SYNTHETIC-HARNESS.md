# El arnés en cuarentena

`npm run mock` se conecta al hub real del 4479 si nadie lo impide. Alguien lo
arrancó para fotografiar la isla de workspaces y lo dejó quince minutos puesto.
Sus agentes de fixture escalan preguntas —"Should I upgrade three.js to
0.185?", "Which database should the migration target?"—, el hub no tenía forma
de distinguir una escalación inventada de una real, y se las enrutó todas al
CAPCOM de verdad: nueve minutos seguidos contestándolas, el contexto del 100%
al 10%, una compactación por el camino.

Y el bucle que lo hace peor: fotografiar esa isla **exige** arrancar el mock,
así que trabajar en el arnés era lo que quemaba al mando que trabajaba en el
arnés.

## La marca, que es la que protege siempre

Una máquina se declara `synthetic: true` en su `hello`. La marca la pone quien
la merece —`test/fake-collector.ts`— y el hub la cree, porque es una
declaración que **sólo quita permisos**: nadie gana nada declarándose falso.
Eso es lo que la hace segura de aceptar del cable, y lo que la mantiene en pie
aunque alguien arranque el mock a mano contra el puerto que sea, que es
exactamente como ocurrió.

La regla no es un filtro sobre CAPCOM sino una **cuarentena simétrica**: lo
sintético y lo real no se hablan en ninguna dirección.

- **Escalaciones.** `CapcomRouter.offer` no se la ofrece al mando si viene del
  otro mundo. Vale también para `sweep`, que es el que reofrece cada barrido lo
  que quedó pendiente: sin eso, ciento treinta preguntas muertas volvían a
  llamar a la puerta cada minuto. Se anota una línea en el feed por máquina, no
  una por pregunta.
- **Mensajes entre agentes.** Un `squad` se resuelve por la etiqueta y por nada
  más, así que un escuadrón sintético llamado como uno de verdad le pegaba el
  mensaje en el pane a agentes reales. Ahora no cruza. La excepción es el
  operador (`fromAgentId: 'ceo'`, sin máquina detrás): la voz del humano manda
  también sobre el arnés.

Lo que el arnés necesita no se pierde: la pregunta sintética **sigue en el
mundo, `pending`**, que es justo lo que hay que poder mirar y fotografiar. Y si
algún día el mock levanta su propio CAPCOM, dentro de su mundo todo funciona.

La marca es pegajosa: una máquina que ya se declaró fixture no sale de la
cuarentena porque una reconexión llegue sin marca.

## La puerta, que evita la confusión de raíz

El mock arrancado a mano **no arranca contra un hub con mando vivo**. Lo
pregunta por `/api/health`, que ahora dice quién manda, y se niega:

```
[fake] ws://localhost:4479 tiene mando vivo (ZG).
[fake] no arranco ahí: usa --isolated para un hub propio, o --anyway si de verdad quieres.
```

`--isolated` da un mundo entero propio —su `ORCA_HOME` temporal, su puerto, su
hub— y dice cómo apuntarle una consola. Es el mismo aislamiento y las mismas
palabras que `test/visual.ts --isolated`, a propósito: un segundo mecanismo
paralelo sería otra cosa que aprender y otra que olvidar.

`--anyway` es la salida explícita. El arnés visual la usa, porque él ya decidió
antes qué puede compartir (`sharing`), y porque con la cuarentena puesta
compartir hub ya no le cuesta el mando a nadie.

`test/visual.ts` reconoce la flota sintética por la marca y no por el nombre de
las máquinas: el hub tiene que saber cuáles son fixtures de todos modos, y
comparar hostnames se rompería en silencio el día que el mock se renombre.

## Irse sin dejar restos

Un collector de verdad que se apaga deja sesiones que **siguen existiendo en
disco**, y el hub hace bien en conservarlas. Las del mock no existen en ninguna
parte: cuando el proceso muere no queda nada a lo que correspondan. Así que
ahora se retira al recibir SIGTERM o SIGINT — `agent:gone` por cada agente,
`escalation:withdraw` por cada pregunta abierta, y espera al cierre del socket,
porque `process.exit` no espera a nadie.

Y del lado del hub: **la pregunta se va con el agente**. Un agente desalojado,
archivado o cuya sesión ya no existe no puede recibir la respuesta, así que
dejarla `pending` era dejar en la cola del humano una pregunta que ya no le
sirve a nadie. Así es como el hub llegó a tener ciento treinta.

Los agentes decorativos del mock —los que producen la isla de fuera de la
flota— van `pinned`: el reciclador de terminados no los toca. Antes
desaparecían a los veinte segundos, de modo que la isla que se iba a
fotografiar se vaciaba sola.

## Verificación

```sh
npm run typecheck
npm test -- synthetic
npm test -- capcom hub messages traffic squads
npm test -- cli workspaces
npm test -- --changed
```

Las dos pruebas que importan —la escalación sintética que no llega al mando y
el mensaje de escuadrón que no cruza— se ponen rojas si se quita la guarda; se
comprobó desactivándola. Cada una lleva su contraparte real en el mismo test,
para que un hub que no enrutase nada en absoluto no las pasara.

Sin cubrir por pruebas: `--isolated` y la puerta que se niega ante un mando
vivo se ejercitaron a mano (contra el hub real, que dijo que no; y levantando un
mundo aislado con sus 24 agentes y 5 escalaciones), pero no hay prueba
automática: las dos levantan procesos de verdad. `npm run visual` tampoco se
corrió en esta entrega — no se tocó UI, y el aislamiento de puertos que sí se
tocó lo cubre `visual-ports`.
