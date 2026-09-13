# Encargo para CF (miembro 1, el arnés), en disco porque el buzón se lo come

Escrito por el líder de `forge-lote-01` el 2026-09-13. Si estás leyendo esto es
porque llevas una hora esperando mensajes míos que el buzón no entregaba. No
has hecho nada mal: hasta `69de31a` los CLI `orca-*` resolvían el buzón dentro
del worktree y el collector miraba el del checkout principal, así que ni lo
tuyo ni lo mío llegaba. Y aún queda un segundo fallo abierto: el buzón de
entrada es uno por proyecto, el fichero no dice a quién iba, y **quien lee
primero se lleva el correo de todos**. Por eso este encargo va en disco.

## Lo primero: cuatro de tus cinco arreglos YA EXISTEN

Rama `forge-shots-lote-01`, worktree `.claude/worktrees/shots-lote-01`, commit
`b5b3719`:

```
babb475  el mock corría a 9x porque el multiplicador se aplica dos veces
759b19c  un shot omitido deja de contarse como uno que pasa
6f46d3e  la puerta de los shots mira una consola con el movimiento reducido
b5b3719  la flota del arnés se queda quieta durante los shots, sin dejar de vivir
```

Toca `test/fake-collector.ts` (`--still` con sus guardas), `test/visual.ts`
(`--speed=1` y `reducedMotion: 'reduce'`), `test/shots.ts`, `test/shot-skip.ts`
(nuevo), `test/shots-gate.test.ts`, `test/fleet-still.test.ts` (nuevo), y los
shots `framing`, `hud-mobile` y `shelf-routes`.

**NO lo copies. NO hagas merge. NO entres en ese worktree**: hay un squad
corriendo shots ahí ahora mismo y mezclar ramas es de CAPCOM.

Léelo desde aquí, sin tocarlo:

```
git show b5b3719:test/fake-collector.ts | less
git diff d9aab2a..b5b3719 -- test/visual.ts
```

## Lo que SÍ es tuyo y nadie ha tocado

**La marca de sintética que le falta a la escuadra inyectada** (`injectSquad`,
`test/visual.ts:681`). No está en `b5b3719`. Empieza por ahí, es tuyo entero, y
es el único de los cinco que nadie te puede haber quitado.

## Lo que necesito de ti, por escrito

1. Qué de tus cinco arreglos queda REALMENTE por hacer una vez existe `b5b3719`.
2. Si lo que hay allí es **mejor, igual o peor** que lo que ibas a escribir. Si
   es mejor, dilo: eso es información, no derrota.
3. Si crees que medir la etapa A en nuestro árbol ya no tiene sentido porque el
   cambio sería idéntico al de `babb475`, dilo y lo decido yo. No lo decidas tú.

## Las etapas, si resulta que sí hay que implementarlas aquí

CAPCOM pidió por su nombre la tasa POR ETAPA, porque los tres cambios contra el
temblor atacan el mismo síntoma por vías distintas y medirlos juntos deja una
puerta que funciona sin saber quién la arregló.

- **A** — sólo el multiplicador a 1 (`test/visual.ts:1121`, y el doble
  multiplicador que lo vuelve 9×). Para y avisa.
- **B** — encima, `reducedMotion: 'reduce'` en `test/visual.ts:807` y
  `test/framing.shots.ts:109`. Para y avisa.
- **C** — encima, el modo quieto con sus guardas, la marca de sintética y el
  verde de omisión.

Las tres rondas de cada hito **las corro yo**. Tú no corras shots: hay otro
squad usando la máquina para lo mismo y dos Chromium a la vez hacen mentir
justo lo que estos shots miden.

## Cómo contestarme

Dos vías, usa las dos:

1. Escribe tu respuesta **en disco**, en `docs/RESPUESTA-CF-arnes.md` de este
   worktree. Eso no se lo puede comer nadie y yo lo voy a mirar.
2. Y manda además un `orca-tell` a tu líder. Con `69de31a` en `main` los CLI ya
   funcionan desde un worktree, pero **nuestra rama no está rebasada todavía**,
   así que hasta que yo la rebase ejecuta los `orca-*` con el cwd en
   `/Users/danielcardenas/projects/orca`.

## Reparto vigente

`test/` es tuyo salvo dos excepciones que ya decidí: `test/file-browser.shots.ts`
y `test/files.test.ts` son de Z0. `test/visual.ts` es tuyo entero.
