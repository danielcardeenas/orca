# Hablarle a CAPCOM

Mantén `⌥V` y habla; suelta y la línea sale. Eso es todo el control por voz, y
es así de corto a propósito.

## Qué es y qué no es

**No es una gramática de órdenes.** «Abre K9», «deck por estado»: eso ya lo
hace la paleta, con más precisión de la que un reconocedor va a tener nunca.
CAPCOM es un modelo de lenguaje; «para a K9 y mándale el brief de ayer» lo
entiende como texto, y por eso lo único que hace la voz es producir texto y
meterlo por el mismo sitio que el composer: `hub.say`. CAPCOM recibe una línea
escrita y no sabe que fue hablada. El eco aparece en TALK, la entrega queda en
el historial, la respuesta llega bloque a bloque, como siempre.

**No hay micrófono abierto.** No hay palabra de activación ni escucha
continua. La consola escucha exactamente mientras la tecla está pulsada, y ésa
es toda la historia de seguridad de un micrófono delante de un agente que
actúa. Con `Esc` mientras se mantiene, la línea se tira. Si la ventana pierde
el foco a media frase, también: no se manda nada a medio oír.

**El botón TALK del mástil hace lo mismo con el dedo.** Pulsar y mantener
escucha; soltar manda; un puntero cancelado tira la línea. Es la forma en un
táctil, donde `⌥V` no existe.

## La vuelta: quién decide qué se lee

Una respuesta de CAPCOM son párrafos, llamadas a herramientas, rutas y bloques
de código. Leída entera en voz alta es un minuto de ruido. La tentación es
pedirle a CAPCOM que sea breve, y es la tentación equivocada: es una
instrucción que olvidará, y que además cambiaría la respuesta escrita, que sí
quiere ser completa.

Decide la consola, con reglas, en `src/ui/voice.ts`. No hay modelo resumiendo.

- **Sólo se lee la respuesta a algo que se dijo.** Una línea escrita a mano
  recibe una respuesta escrita, como antes. La consola recuerda las últimas
  líneas dictadas y busca en el transcript el prompt que coincide.
- **Sólo cuando el turno ha terminado.** CAPCOM en `idle`, o `blocked` en una
  pregunta. Nunca media frase mientras el resto sigue llegando. Que una
  pregunta bloqueada también se lea es el caso que más importa: CAPCOM te está
  esperando y no estás mirando la pantalla.
- **Se lee la conclusión.** El texto que va después del último paso de
  herramienta. Lo de antes («Voy a mirar…») es narración; lo de después es lo
  que pasó.
- **Y sólo sus primeras frases**, hasta `SPOKEN_MAX` (220) caracteres. Frases
  enteras; si la primera no cabe, se corta en una palabra con puntos
  suspensivos. La respuesta completa sigue en la ventana.
- **Legible.** Antes de leer, fuera los bloques de código, las URL, los
  marcadores de markdown; los enlaces se quedan con sus palabras y las rutas
  con su nombre de archivo: `src/ui/main.ts:361` se lee «main.ts».

`SETTINGS › VOICE › READ BACK` lo apaga. Con eso apagado `⌥V` sigue hablando y
la respuesta se queda en la ventana. Empezar a dictar corta cualquier lectura en
marcha.

## Los oídos

Hay dos maneras de convertir lo dicho en texto, y `SETTINGS › VOICE › EARS`
elige (`voiceEngine`):

**whisper.cpp en el hub.** El navegador graba el micrófono mientras la tecla
está pulsada, lo convierte al WAV que lee el binario (16 kHz, mono, 16 bits;
`src/ui/audio.ts`, sin ffmpeg en ningún lado) y al soltar lo sube a
`POST /api/transcribe`. El hub corre `whisper-cli` (`src/hub/transcribe.ts`)
con **los nombres de la flota en el prompt**: ORCA, CAPCOM, cada indicativo
vivo, cada squad, cada proyecto, tal como están en ese momento. Por eso
escribe «K9» donde el navegador escribía «AK9»: se le dijo que K9 existe. El
audio no sale de la máquina. Cuesta uno o dos segundos entre soltar y ver la
línea, de los que uno y medio es cargar el modelo; `whisper-server` con el
modelo residente lo bajaría, y queda para cuando duela.

Mientras el hub trabaja, el reconocedor del navegador, si lo hay, sigue
enseñando las palabras en directo, y es la línea de último recurso si el hub
falla a media frase. Lo que se manda es lo de whisper.

**El navegador.** Web Speech API: palabras según hablas, sin pistas, y el
audio va a Google o a Apple. Chrome y Safari lo tienen, iOS incluido; Firefox
no, y con el hub transcribiendo no le hace falta.

AUTO es whisper siempre que el hub diga que puede, y el navegador si no. La
línea bajo el selector dice cuál usará la siguiente palabra y, cuando el hub
no puede, por qué, con las palabras del propio hub.

**Lo que el hub necesita.** `whisper-cli` (`brew install whisper-cpp`, o
`ORCA_WHISPER_BIN`) y un modelo `ggml-*.bin` en `~/.orca/models` (o
`ORCA_WHISPER_MODEL`). El hub no descarga nada solo: un modelo es un giga y
medio y eso lo decide el operador. El que hay:

```
mkdir -p ~/.orca/models
curl -L -o ~/.orca/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Con varios, el hub coge el mejor por nombre: large-v3-turbo antes que large,
antes que medium, small, base, tiny. Un modelo que aparece con el hub en
marcha se encuentra sin reiniciar. `GET /api/transcribe` lo dice.

Dos cosas tienen que darse en el navegador, y cuando falta una, TALK **no se
dibuja**. Una herramienta que no puede funcionar no es una herramienta;
SETTINGS dice por qué falta:

- **Contexto seguro.** `localhost:4478` lo es. La dirección remota en http
  plano de `docs/REMOTE-ACCESS.md` no, y ahí el navegador no abre el micrófono
  en absoluto. Que la voz funcione desde el móvil, que es donde más vale,
  espera a servir https (Tailscale da certificados propios). Es trabajo aparte.
- **Un oído.** Un reconocedor del navegador, o acceso al micrófono para
  grabar para el hub.

El idioma es el del navegador (`navigator.language`), para reconocer y para
leer. No hay ajuste: cambiarlo es cambiarlo en el navegador.

### Qué voz

La primera versión cogía la primera voz del navegador que coincidiera con el
idioma, y en un Mac en es-MX ésa es «Eddy (Español (México))»: Apple lista sus
voces de broma —Eddy, Flo, Grandma, Bubbles, Zarvox— junto a las de verdad, y
por orden alfabético salen antes que Paulina. Sonaba horrible porque era una
broma.

Ahora se elige como `say`, en `chooseVoice` (`src/ui/voice.ts`): la voz de
verdad del idioma exacto, la marcada por defecto por el sistema antes que
otra, la local antes que la remota, y las de broma nunca por su cuenta. Si no
hay ninguna del idioma exacto, una de la misma familia (es-AR sin voz propia
lee con Mónica o Paulina). Para es-MX eso es Paulina, que es lo que `say` usa
sin ajustes.

`SETTINGS › VOICE › VOICE` lista las voces del navegador, con AUTO como lo
anterior, y PREVIEW lee una línea de muestra en el idioma de la voz. La
elección se guarda por nombre (`voiceName`); una voz que ya no esté en la
máquina vuelve a AUTO sin avisar. Las de broma siguen en la lista: se pueden
elegir, sólo no se eligen solas.

**Las tomas mejoradas.** Apple lista la voz de serie y la descargada mejor
como dos entradas, «Mónica» y «Mónica (mejorada)», con la palabra del sistema
en su idioma entre paréntesis. No hay lista de esas palabras: la toma buena
es la que lleva sufijo cuando su hermana lisa también está. AUTO la prefiere,
y un nombre sin sufijo en la preferencia toma su mejor toma: `Mónica` lee con
Mónica (mejorada) si está descargada.

**Por defecto: Mónica.** Español de España, elegida por el operador el
2026-09-09. Lo que se pidió fue la voz 2 de Siri en español de España, y esa
no existe fuera de Siri: Apple no la expone ni a `say` ni al navegador, y en
este Mac ninguno de los dos la lista entre sus 182 voces. Mónica mejorada es
lo más cercano que sí hay. En una máquina sin Mónica, AUTO sin avisar. Para
Paulina u otra, el selector.

## Dónde está

| Pieza | Archivo |
|---|---|
| Las reglas de qué se lee, puras | `src/ui/voice.ts` |
| Micrófono, los dos oídos, síntesis, la tira LISTENING / TRANSCRIBING / CAPCOM / SENT | `src/ui/hud/voice.ts` |
| Los flotantes del micrófono al WAV de whisper, puro | `src/ui/audio.ts` |
| whisper.cpp en el hub, el vocabulario de la flota, `/api/transcribe` | `src/hub/transcribe.ts` |
| `⌥V` mantenido, `Esc`, la suelta, el blur | `src/ui/main.ts` |
| El botón TALK, mantenido | `src/ui/hud/mast.ts` |
| READ BACK, y el porqué cuando TALK no está | `src/ui/windows/kinds/misc.ts` |
| Que un acorde pueda engancharse dentro de un campo de texto | `src/ui/keys.ts` |
| La preferencia `voiceReply` | `src/ui/prefs.ts` |

La tira vive en el dock, encima de toda ventana, como la línea de comandos a la
que sustituye: lima mientras escucha (vivo, como FOCUS), cian mientras CAPCOM
habla (la única voz que contesta), y SENT un instante cuando la línea sale.

## Lo que queda fuera

- Leer más que la conclusión, o un resumen hecho por un modelo. Si algún día
  hace falta, es un adaptador de proveedor, no una instrucción a CAPCOM.
- Un proveedor de transcripción en la nube. Sería un adaptador más detrás
  de `/api/transcribe`, con la clave en el almacén del hub; hoy no hace falta.
- **Voces neuronales en el hub.** Se montaron y se quitaron el 2026-09-09.
  Chatterbox Multilingual (MIT) y Fish S2 Pro (licencia de investigación),
  cada uno como hijo Python caliente detrás de un `/api/speak`, con la misma
  frase que Mónica para compararlos de oído. En un M4 Pro con PyTorch sobre
  Metal, Chatterbox tardaba ocho segundos por frase y S2 Pro minutos; ninguno
  con MLX ni cuantización. Para leer dos frases tras un turno de CAPCOM no
  compensa, y la voz del sistema se queda. OpenAudio S1-mini ni llegó a
  correr: está cerrado en Hugging Face y su formato ya no lo lee el código
  de fish-speech. Si algún día hay un port MLX o pesos cuantizados, el sitio
  es el mismo: un endpoint en el hub que devuelve WAV, y la voz del sistema
  como reserva.
- `whisper-server` residente para ahorrarse la carga del modelo en cada línea.
- Voz para agentes que no son CAPCOM. `hub.say` sin agente es CAPCOM (o la
  misión activa, exactamente igual que el composer).
- https en el acceso remoto, sin el cual no hay micrófono desde otro aparato.

## Verificación

`npm test -- voice keys`: las reglas puras (markdown a legible, rutas a nombre
de archivo, frases hasta el tope, la conclusión tras el último paso, leer una
vez y sólo lo dicho, callar mientras CAPCOM trabaja, leer una pregunta
bloqueada, ignorar lo escrito a mano, tolerar espacios plegados, descartar
prompts anteriores al dictado, exigir la forma prompt→respuesta, aceptar un
prompt de misión que lleve la línea, callar sin texto), la elección de voz
(Paulina y no Eddy para es-MX, la familia cuando no hay idioma exacto, la del
sistema y la local por delante, el nombre elegido por encima de todo, y un
nombre que ya no existe vuelve a AUTO) y el `whileTyping` del hold.

`npm test -- voice-dom` corre en Chromium el cableado entero de
`hud/voice.ts` con un motor y un sintetizador de mentira
(`test/voice.fixture.ts`): mantener enciende la tira y el body; lo oído llega
por partes; soltar manda una vez exactamente lo oído y enseña SENT; cancelar
no manda; nada oído, nada mandado; un permiso denegado avisa y no manda; la
respuesta a lo dicho se lee una vez, en cian, con rutas y backticks
limpiados; una línea escrita a mano no se lee; dictar de nuevo calla la
lectura; sin motor, TALK no existe y `start` dice por qué.

`npm test -- transcribe` prueba el lado del hub sin whisper.cpp: un binario de
mentira que apunta sus argumentos. Qué modelo se elige por nombre, cómo se
compone el vocabulario (ORCA, CAPCOM, indicativos vivos, squads, proyectos,
una vez cada uno, con tope), qué flags llegan al binario y cómo se limpia su
salida (líneas a una, `[BLANK_AUDIO]` fuera), un binario que falla es un
error con su última línea, y el endpoint: estado, la línea, uno a la vez,
415, 403, 413, 400, 405, y 503 con el motivo cuando no puede.
`npm test -- audio` prueba los flotantes al WAV: concatenar, remuestrear de
48 a 16 kHz sin perder forma ni muestras, y la cabecera de 44 bytes campo a
campo con el recorte a 16 bits.

Probado con el binario y el modelo de verdad en este Mac (M4 Pro, Metal): una
frase de siete segundos sintetizada con `say`, dos segundos de reloj con el
modelo cargando en cada llamada. El prompt con los nombres cambió «Capcom»
por «CAPCOM»; la frase de prueba venía de una voz sintética española leyendo
palabras inglesas, así que lo que mal oyó ahí («con MIT» por «commit») no
dice nada de una voz humana.

Sin cobertura automática: el micrófono y la voz de verdad, la grabación en
el navegador y su subida, la el hold de `⌥V`
en `main.ts` y el TALK mantenido del mástil; se prueban a mano en Chrome
sobre `localhost:4478`.

Filtros que cubren esta entrega: `voice`, `voice-dom`, `keys`, `transcribe`,
`audio`.
