# La captura de un resultado: entrega

Misión `mission_mty0u9wtmoc471tc`, squad `canvas-artefactos-01`, miembro 1 (la
captura y el camino de datos). El miembro 2 lleva la presentación en el canvas
y la documenta en [CANVAS-ARTEFACTOS-2026-09-12.md](CANVAS-ARTEFACTOS-2026-09-12.md).

El pedido del operador: *«si pedimos que genere una página web o un pipeline de
diseño de generación de video/imagen o lo que sea que dé de resultado, quiero
verlos en el canvas cerca de los agentes que lo hicieron»*. Y una pregunta
abierta: cómo se captura ese resultado — detectando rutas y URLs en lo que el
agente produce, pidiéndoselo en el brief, o una mezcla.

El camino de datos entero está dibujado en
[artefacto-camino-de-datos.svg](artefacto-camino-de-datos.svg), que además es
la prueba de punta a punta de esta entrega: se publicó por el camino que
dibuja.

## 1. Lo que ya existía

Nada de esto hubo que construirlo. Contra `main` del 2026-09-12:

| Qué | Dónde |
|---|---|
| El índice, y las dos entradas | `src/collector/artifacts.ts` |
| Detección desde el transcript | `src/collector/derive.ts:571` `noteProduced()` |
| Drenaje y atribución | `src/collector/index.ts:1229` |
| Publicación explícita | `bin/orca-show.mjs` → `artifacts.ts` `takeDecl()` |
| El registro | `Artifact`, `src/shared/types.ts:586` |
| Entrada al hub | `world.ts:1016` → `upsertArtifact` → `sanitizeArtifact:747` |
| Servido por HTTP | `server.ts:2494` `serveArtifact`, caché en `~/.orca/artifacts` |
| Lista blanca de lectura | `commands.ts:1315` `artifactRead` |
| Ya se pinta | `gallery.ts`, `artifact.ts`, `mission.ts:545`, `field/media.ts` |

Dos propiedades del diseño que conviene no perder de vista, porque el resto se
apoya en ellas: el **id sale de máquina+ruta**, así que reescribir un archivo
actualiza el artefacto en el sitio donde el operador ya lo tenía puesto en vez
de duplicarlo; y **el hub nombra un id, nunca una ruta**, así que un token
robado no se convierte en un `cat` remoto de ese portátil.

Lo que faltaba no era la cañería. Era que se llenase:

1. **Nada que saliera de Bash se capturaba.** `ffmpeg`, `playwright`, un build,
   un script de render: ninguno pasa por Write. El caso del operador era, letra
   por letra, el que no existía.
2. **La vía explícita estaba muerta.** `orca-show` se instala en el PATH de
   cada worker desde hace una semana (`shims.ts:55`) y ningún brief lo
   mencionaba. Medido antes de tocar nada: cero declaraciones
   `.orca/artifacts/*.json` en todos los proyectos de esta máquina.
3. **Nada distinguía un resultado de un archivo cualquiera**, así que el canvas
   no tenía con qué decidir qué anclar.

## 2. La decisión: declarar manda, detectar es la red

Las tres opciones del operador, con lo que hace fallar a cada una:

**Parsear rutas y URLs de lo que el agente escribe: no.** Falla en las tres
formas a la vez. El agente nombra archivos que *leyó* —un grep, un diff, un
test— y no creó; nombra rutas de scratchpad que no son resultados; y nombra
rutas que no existen. ORCA ya tenía tomada esta decisión en otro sitio y con
otro nombre: se detecta por señal, no por cadena. Lo que se mira es el
`tool_use`, que es un hecho.

**Declarar (`orca-show`): sí, y es la vía principal.** Es lo único que resuelve
el caso que rompe a todo lo demás: un agente que genera cuarenta png no tiene
cuarenta resultados, tiene uno, y sólo él sabe cuál y cómo se llama. Ninguna
detección podrá elegir nunca. Cuesta dos líneas de brief, una vez.

**Detectar: sí, pero como red de seguridad,** porque el modo de fallo de
declarar es un agente que no declara, y eso no se arregla insistiendo en el
brief. Ampliada al hueco que dejaba fuera el caso del operador.

Y la pieza que une las dos y le da al canvas lo que necesitaba:
`Artifact.source`.

| | quién lo eligió | título | en el canvas |
|---|---|---|---|
| `declared` | el agente, a propósito | el que él escribió | se ancla junto a su baldosa |
| `observed` | nadie: apareció | el nombre del archivo | espera en la galería |

La regla tiene **una dirección**: declarar no se pierde. Reescribir con Write la
gráfica que un agente publicó no la degrada, porque si lo hiciera el artefacto
se caería del canvas justo al actualizarse, que es cuando más ganas hay de
mirarlo. Al revés sí: publicar sube lo que ya estaba.

## 3. Lo implementado

| Commit | Qué |
|---|---|
| `e657fc2` | `Artifact.source`, de punta a punta, con el hub validándolo |
| `99e0bac` | los dos pies de squad nombran `orca-show`; prueba que impide prometer un comando que no está en el PATH |
| `4405844` | el svg del camino de datos, publicado por ese camino |
| `9b9f602` | captura por efecto: lo que sale de un proceso |
| `104bbf1` | el techo tira primero lo que nadie eligió |
| `1823a90` | lo que git ignora no entra solo; y un `.zip` no entra ni declarándose `file` |
| `6d5d7da` | un comando de ORCA sabe de qué agente es |

### La captura por efecto

Un `fs.watch` recursivo sobre el árbol del proyecto: el sistema operativo hace
el trabajo, y el callback sólo compara cadenas — statear, atribuir y registrar
es del tick de un segundo que ya existía. Se observa **el archivo, nunca el
comando**: leer `convert a.png b.png` para adivinar qué produjo es volver a
adivinar a partir de una cadena, y ahí `a.png` es una entrada.

Lo que lo hace aceptable es lo acotado que está:

- sólo las extensiones que ya mandaban; nunca dependencias, trabajo intermedio
  ni nada oculto. `out/` **no** se filtra: es donde un render deja su resultado
  tanto como donde un bundler deja el suyo, y perder el caso que motivó todo
  esto para ahorrarse unos html de build es un mal cambio;
- 24 archivos por tick — un checkout de rama renueva el mtime del repo entero,
  y un render por lotes escribe cientos de png en segundos, y ni una cosa ni la
  otra son cientos de resultados;
- **sin agente a quien atribuirlo, no hay registro.** Inventar un dueño es peor
  que perder el archivo;
- y entra como `observed`, así que no ocupa sitio en el campo.

### Lo que git ignora no entra solo

Dos horas después de poner esto en servicio, la flota real dio la medida: 23
capturas del arnés visual en diez minutos, todas en `test/shots/`, todas
atribuidas a agentes que no las habían hecho. El arnés produce imágenes de
verdad; ninguna es un resultado.

El filtro no es una lista de directorios nuestra —eso nunca cierra, mañana hay
otro— sino la que el propio repo escribe y mantiene al día: `git check-ignore`,
un proceso por tick para todo el lote, con los veredictos recordados por ruta.
Cuando git no puede contestar, no se filtra nada: perder un resultado por una
duda es peor que dejar pasar una captura de más.

**Y vale sólo para lo que aparece solo.** Una declaración nunca se filtra por
aquí, y es deliberado: un render de vídeo vive en un directorio ignorado casi
siempre, porque los binarios no se commitean, y colar el filtro ahí mataría el
caso que motivó la captura. Publicarlo sigue siendo la forma de decir «éste
sí».

### El techo, corregido por lo que pasó al ponerlo en servicio

Veinte minutos después de que la captura por efecto entrara en la flota real,
otro agente corrió el arnés visual y metió diez capturas en el índice en un
minuto. El collector tiene 200 huecos y el hub 300: con un techo por edad a
secas, media hora de trabajo de una flota empuja fuera la gráfica que alguien
publicó a propósito. Ahora la cola que se tira es la de lo observado, y sólo se
toca una declaración cuando no queda nada más. La edad ordena dentro de cada
grupo; la retención de 24 h no cambia para nadie.

## 4. El caso real, de punta a punta

Dos, y ninguno es un fixture. Ambos verificados contra el hub vivo.

**Declarado.** `orca-show docs/artefacto-camino-de-datos.svg "El camino de un
artefacto…"` → la declaración entró por `.orca/artifacts`, el collector la
registró como `art_c14af5960557f28f` con `source: declared`, el hub le puso su
url, y `GET /api/artifact/art_c14af5960557f28f` devuelve `200`,
`content-type: image/svg+xml`, 5.989 bytes.

**Observado, que es el caso del operador.** `magick
docs/artefacto-camino-de-datos.svg … docs/artefacto-camino-de-datos.png` desde
Bash: sin `orca-show`, sin Write, un proceso externo escribiendo un archivo. A
los cuatro segundos estaba en `/api/world` — 171.610 bytes, `observed`,
atribuido a su agente. Un pipeline de generación de imagen apareciendo solo en
ORCA, que hasta ese momento era invisible.

### Quién hizo qué

Esto empezó como una nota al pie y resultó ser la pieza que faltaba. Al
verificar los dos artefactos publicados en la consola viva, los dos colgaban de
**otros agentes**, y uno del propio líder de la squad.

La causa: los seis comandos `orca-*` tomaban el agente de
`CLAUDE_SESSION_ID`, y esa variable **viene vacía dentro de un agente de
ORCA**. Sin ella, el collector cae en su heurística —el agente vivo del
proyecto con la actividad más reciente—, que con un agente por repo acierta
siempre y con cinco en el mismo checkout acierta por casualidad. Es exactamente
lo que el operador pidió que no pasara. Y no era sólo cosa de los artefactos:
explicaba también los indicativos cruzados en los mensajes de la tarde, porque
`orca-tell` firmaba igual de mal.

`bin/lib/whoami.mjs` lo resuelve una sola vez para los seis, de la evidencia
más fuerte a la más débil: `--agent`, `CLAUDE_SESSION_ID`, `ORCA_PANE` —que
pone el collector al lanzar, para cualquier proveedor, validada como uuid
porque un pane puede llamarse `orca-capcom`— y, como último recurso, la cadena
de procesos buscando el `--session-id` con el que se lanzó el CLI. Eso último
cubre al agente que ORCA no lanzó; un proveedor que no use esa bandera no
aparece y no rompe nada.

`null` sigue siendo una respuesta legítima: significa «no lo sé», y el
collector conserva su heurística. Lo que ya no ocurre es inventar un id.

## 5. Lo que falla, dicho claro

**La atribución de lo observado sigue siendo aproximada.** Un archivo que
aparece no lleva firma: se le cuelga al agente vivo del proyecto con la
actividad más reciente, y con varios agentes en un checkout se equivoca. El
daño está acotado por diseño, y es otra razón por la que `source` es necesario:
lo observado no se ancla en el campo, así que una atribución torcida cuesta una
línea mal puesta en la galería, no una imagen junto al agente equivocado. La
vía declarada sí es exacta desde `6d5d7da`, y antes de ese commit no lo era —
conviene no fiarse de la atribución de nada anterior.

**No propongo arreglarlo enumerando directorios prohibidos** (`test/shots`,
`docs`, lo que vaya apareciendo). Enumerar lo prohibido nunca cierra: mañana
hay otro directorio. La clasificación correcta ya está puesta, y es la que
decide lo que importa.

## 6. Lo aplazado, con su motivo

- **Las URLs.** Un `http://localhost:5173` del agente no tiene bytes que
  cachear y deja de ser alcanzable en cuanto hay dos Macs, que ya las hay. Para
  enseñar una web están la captura y el `.html`, que ya funcionan hoy.
- **La miniatura en el hub** (`/api/artifact/<id>?thumb=128`), que pidió el
  miembro 2 para no bajarse un png de 400 KB por cada ficha de 128 px. Es la
  costura entre las dos mitades y necesita una decisión que no es mía: hoy el
  hub no tiene ninguna dependencia de imagen, así que las opciones son una
  librería, el `sips` del sistema, generar la miniatura en el collector —que es
  quien tiene el archivo— o dejarlo en el cliente con `createImageBitmap`. Sin
  ella, el camino funciona; con ella, el canvas cuesta bastante menos.
- **Distinguir `file` de `text` al servir.** Hoy `kindOf` no devuelve nunca
  `file`, así que el problema no existe todavía; si la captura se ensancha a
  binarios, `media.ts` los pintaría como texto.

Un binario, por si queda duda, no entra hoy por ninguna puerta: la CLI lo
rechaza (`orca-show: .zip is not something the console can show`) y el collector
lo rechaza otra vez, porque **la extensión manda incluso sobre el `kind`
declarado**. Esa regla no es cosmética: si el `kind` pudiera saltarse la lista
blanca, un `{"path": ".env", "kind": "text"}` en `.orca/artifacts` convertiría
este canal en una forma de sacar los secretos del proyecto por el hub.

## 7. El relevo

**No hace falta ninguno.** El hub y el collector se relevaron durante la misión
(`15:01:57` y `15:07:42`) y volvieron con este código; por eso las dos pruebas
de punta a punta de arriba pudieron hacerse contra la flota real.

Conviene saber cómo ocurre, porque es fácil de leer mal: `tools/supervise.mjs`
**no vigila archivos**. Sólo relanza cuando el proceso sale con el código 75
pidiendo relevo, y quien lo pide es el propio collector al recibir un frame
`restart` del hub (`src/collector/index.ts:1686`) — es decir, el botón de
relevo de la consola. Los dos relevos los disparó alguien desde ahí. Editar
código no reinicia nada por sí solo.

Para confirmarlo en la consola: abrir la galería y mirar cualquier miniatura
reciente, o pedirle al hub `/api/world` y comprobar que los artefactos traen
`source`. Lo declarado y lo observado ya conviven ahí: en el momento de
escribir esto había catorce artefactos, dos declarados y doce observados.

El brief nuevo sólo lo leen los agentes que se lancen a partir de ahora: los
que ya estaban corriendo no lo tienen, y seguirán sin declarar nada.

## Filtros que cubren este documento

```
npm test -- artifacts         las doce pruebas de la captura y del camino
npm test -- squads            el pie, los comandos alcanzables y de quién firma cada uno
npm test                      1362/1362, la suite entera sobre este árbol
npm run typecheck             limpio
```
