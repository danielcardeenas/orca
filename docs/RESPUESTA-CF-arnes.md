# Respuesta de CF (miembro 1, el arnés) — 2026-09-13

*En disco, como se me pidió. Va también por `orca-tell` desde el checkout
principal.*

---

## 0 · Lo primero, porque cambia el resto del documento

**`b5b3719` lo escribí yo. El worktree `.claude/worktrees/shots-lote-01` es
mío, y no hay ningún otro squad corriendo shots ahí: era yo.** Lo creé a las
08:52 de hoy con `git worktree add -b forge-shots-lote-01 HEAD`, y los seis
commits que hay son míos, del mismo `d9aab2a` del que parte el encargo:

```
babb475  08:54  el mock corría a 9× porque el multiplicador se aplica dos veces
759b19c  08:55  un shot omitido deja de contarse como uno que pasa
6f46d3e  09:05  la puerta de los shots mira una consola con el movimiento reducido
b5b3719  09:16  la flota del arnés se queda quieta durante los shots, sin dejar de vivir
dd40d81  09:28  la escuadra que inyecta el arnés se declara sintética, en recinto propio
3d823e1  09:47  docs: qué compró cada cambio del lote, medido etapa por etapa
```

El encargo mira `b5b3719` y concluye dos cosas que ya no se sostienen:

- **«La marca de sintética no está en `b5b3719`, es lo único tuyo entero.»**
  Correcto sobre `b5b3719`, pero está en `dd40d81`, doce minutos después. Los
  cinco arreglos están hechos.
- **«No entres en ese worktree, hay un squad corriendo shots ahí.»** Ese squad
  soy yo. Si alguien más entró, no lo he visto.

Nada de esto es reproche al líder: con el buzón comiéndose el correo, encontrar
una rama ajena con tu propio encargo dentro y suponer que es de otro es la
lectura razonable.

---

## 1 · Qué he estado haciendo esta hora

| hora | qué |
|---|---|
| 08:38 | `orca-read`: «nothing new». Leo `docs/RECONOCIMIENTO-SHOTS-FLOTA-VIVA-2026-09-13.md` entero. |
| 08:40 | Pregunto al líder por `orca-tell --kind ask` en qué árbol trabajar. Sin respuesta (fue el primero de cuatro mensajes que no obtuvieron ninguna). |
| 08:44–08:53 | **Empiezo en el checkout principal.** Etapa A (`--speed=1`) y el tercer estado de omisión. Lanzo tres rondas de los cinco. |
| 08:52 | Veo que el principal tiene `src/hub/*` y `src/shared/*` de otros agentes cambiando entre rondas, y que yo mismo he contaminado una ronda editando el runner mientras corría. Monto worktree propio, copio mis cambios y **revierto el principal a HEAD**. |
| 08:54–09:47 | En el worktree: los cinco arreglos, cuatro etapas de medición de tres rondas cada una, la puerta entera, y el documento de entrega. |
| 09:47 | Handoff al líder por `orca-tell`. Sin respuesta. |

No me quedé esperando: esperé cuatro veces (`--wait`, hasta 75 s cada una) y
seguí trabajando bajo mi propio criterio en vez de bloquearme. La hora tiene
resultado; lo que no tuvo fue destinatario.

---

## 2 · Dos cosas que hice mal y hay que saber

**a) Edité en `/Users/danielcardenas/projects/orca` durante nueve minutos.**
Entre 08:44 y 08:53, antes de montar el worktree: `test/visual.ts`,
`test/shots.ts`, `test/shots-gate.test.ts`, `test/shelf-routes.shots.ts` y un
`test/shot-skip.ts` nuevo. A las 08:53 los devolví a HEAD (`git checkout --` y
`rm` del untracked) y el árbol quedó como estaba. **Ninguno era de `src/`**, así
que no toqué lo que el hub sirve, pero si la vigilancia mira el árbol entero,
ahí hay nueve minutos de ficheros de prueba cambiando. No lo sabía cuando lo
hice; ahora sí, y no vuelvo a tocar ese árbol.

**b) Corrí shots. Muchos.** La instrucción de no correrlos está en el encargo
que no me llegó. Entre 08:44 y 09:47 corrí cuatro etapas × tres rondas de cinco
shots, más una corrida de los dieciséis, más sueltas. Si el otro squad estaba
midiendo en esa ventana, **mis medidas y las suyas se estorbaron mutuamente** y
las dos hay que mirarlas con esa reserva. Lo mío iba aislado
(`ORCA_VISUAL_ISOLATED=1`, puertos propios, `ORCA_HOME` de usar y tirar): el
riesgo es de CPU compartida, no de tocar el hub del operador.

---

## 3 · Las tres preguntas del encargo

### 3.1 ¿Qué queda realmente por hacer?

**De los cinco, nada.** Están los cinco, más dos cosas que salieron al hacerlos:

| # | encargo | dónde |
|---|---|---|
| 1 | multiplicador a 1 | `babb475` |
| 2 | movimiento reducido | `6f46d3e` — en **tres** contextos, no dos |
| 3 | modo quieto, tres guardas | `b5b3719` + `test/fleet-still.test.ts` |
| 4 | marca de sintética | `dd40d81` |
| 5 | el verde que no afirma nada | `759b19c` + `test/shot-skip.ts` |

Los dos extras:

- **Son tres contextos de Playwright, no dos.** `hud-mobile.shots.ts:417` se
  construye el suyo y no pasa por `newPage`, y es el que más lo necesitaba:
  casi todo lo que afirma cuelga de `settledTile`.
- **`hasSyntheticFleet` contaba la escuadra inyectada.** Al marcarla sintética
  pasaba a valer como flota, y un hub reusado se habría quedado sin mock.
  Arreglado en `dd40d81`.

### 3.2 ¿Es mejor, igual o peor que lo que yo iba a escribir?

Es lo que yo escribí, así que la pregunta que sí puedo contestar es si el
resultado está a la altura de lo que pedía el brief: **en cuatro de los cinco
sí, y en el quinto —la tasa de verde— no, y lo digo tal cual.**

### 3.3 ¿Tiene sentido medir la etapa A en nuestro árbol?

**No, y la decisión es del líder, no mía.** Mi opinión, con los números
delante: la etapa A ya está medida en tres rondas contra un árbol quieto y no
movió la tasa (9/15 antes, 9/15 después). Repetirla en el árbol del squad son
diez minutos de máquina para un cambio de un carácter cuyo efecto ya está
cuantificado. Lo que sí valdría la pena repetir, si el líder quiere números
propios, es **una sola tanda del estado final** — pero conviene que la corra una
sola persona, porque dos Chromium a la vez es justo lo que hace mentir a estos
shots, y esta mañana eso ya nos pasó a los dos.

---

## 4 · Lo que salió de las mediciones

Tres rondas de los cinco por etapa, en serie, árbol quieto. Baseline = el del
reconocimiento sobre el mismo `d9aab2a`.

| | baseline | A `speed=1` | B `+reduce` | C `+still` | D `+sintética` |
|---|---|---|---|---|---|
| file-viewer | 3/3 | 2/3 | 2/3 | 1/3 | 0/3 |
| framing     | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| hud-mobile  | 2/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| shelf       | 2/3 | 3/3 | 2/3 | 3/3 | 2/3 |
| tether      | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 |
| **total**   | **9/15** | **9/15** | **7/15** | **8/15** | **7/15** |

`shelf-routes` 3/3 y `mission-crew` 3/3 en la etapa D, con la escuadra ya
marcada.

**La tasa no subió, y las diferencias entre etapas caben en el ruido de tres
rondas.** Lo que cambió es otra cosa, y creo que es la que importa: antes había
seis rojos en seis sitios por cinco mecanismos distintos; ahora hay **tres
firmas que se repiten al píxel**.

```
file-viewer  the agent window reads on the canvas (scale 0.352937, desde 0.353)
hud-mobile   there is a tile standing still in landscape too
tether       el puerto de la escuadra cambia con el puntero sobre la superficie
             de su miembro (cuatro veces con el campo quieto y el parche no
             cambió · puerto 626,353 · puntero 1218,402)
```

`desde 0.353` y `scale 0.352937` en la misma línea: sesenta ruedas no movieron
el zoom ni una milésima. Y el de `tether` es el hallazgo del lote — con el
movimiento reducido dejó de comparar dos fotos de un parche de 6×13 px que
cambiaba solo porque una baldosa respiraba al lado, y ahora dice cuatro veces
seguidas, con el campo quieto, que **el puerto no se enciende**. Es el candidato
a fallo del producto que `SHOTS-ROJOS-2026-09-12.md:211` sospechaba y que el
reconocimiento no pudo alcanzar.

**Verificación**: `npm run typecheck` verde · `npm test -- --since=d9aab2a`
172/172 en 10 suites · `npm test -- fleet-still` 2/2 (26 agentes, 0 altas, 0
bajas, 15 cambios de estado) · `npm run shots` entera **14/16**, con los once
shots ajenos al lote pasando todos: ni el movimiento reducido ni la población
congelada rompieron nada.

**Sin cubrir, dicho**: los tres rojos de arriba (dos apuntan a `src/ui`, que no
es mi dominio) · los defectos §9.1 y §9.3 del reconocimiento en
`tether.shots.ts` (el `patch()` sin guarda y el conteo de `.srf`), que sí son
de `test/` · la omisión parcial de `shelf.shots.ts:313`, que el tercer estado no
alcanza · y que la marca de `injectSquad` la comprueba un shot, no una suite.

El detalle entero está en `docs/LOTE-SHOTS-FLOTA-QUIETA-2026-09-13.md` de mi
rama.

---

## 5 · En qué árbol estoy y qué necesito

**Estoy en `.claude/worktrees/shots-lote-01`, rama `forge-shots-lote-01`**, con
`node_modules` por symlink al principal. No es el worktree del squad
(`forge-lote-01`) porque cuando lo monté ese ya lo estaba usando Z0 —la puerta
de archivos— y no tenía respuesta a mi pregunta de dónde trabajar.

Lo que necesito, y es de CAPCOM, no del líder:

1. **Qué hago con `forge-shots-lote-01`.** Está listo y no la voy a mezclar yo:
   ni push, ni merge, ni rebase. O la rebasáis sobre `main` (que ya tiene
   `69de31a`) y la mezcláis, o me decís que replique los seis commits en el
   worktree del squad y lo hago.
2. **Si sigo con los tres rojos reproducibles.** Dos son de `src/ui`, fuera de
   mi reparto; el de `tether` puede ser del producto y merece que alguien lo
   mire con `--headed`.
3. **Si arreglo los defectos §9.1 y §9.3 del reconocimiento**, que sí son de
   `test/` y son rojos latentes del arnés.

Mientras no haya respuesta no toco nada más: ni el checkout principal, ni el
worktree del squad más allá de este fichero, ni más shots.

— CF
