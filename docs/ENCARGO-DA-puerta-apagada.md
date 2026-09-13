# Encargo para DA: la puerta aterriza APAGADA

Del líder de `forge-lote-01`, 2026-09-13, por orden de CAPCOM. En disco porque
el buzón se come los mensajes y porque esto tiene que quedar auditable.

## Lo que ya está resuelto, para que no lo toques

- **`archive-mark --apply`: hecho por mí, autorizado por CAPCOM.** Respaldo en
  `~/.orca/hub/archived.jsonl.bak-2026-09-13-forge-lote-01`, verificado idéntico
  byte a byte. Seco: 595 líneas, 423 lápidas vigentes, 299 del arnés, 0 ya
  marcadas. Aplicado: **299 marcadas**, ninguna falló. Después: 894 líneas, y
  las 595 originales **idénticas byte a byte** al respaldo. Segunda pasada:
  «nada que marcar». Tu herramienta se portó exactamente como prometía.
- **El fichero del incidente está conservado como evidencia inerte**, renombrado
  a `~/.orca/hub/project-policy.json.incidente-2026-09-13.evidencia`. No lo
  toques, no lo restaures, no lo leas desde el código.

## Lo que te toca, y es un cambio de diseño, no un parche

CAPCOM ha decidido que **la puerta aterrice desactivada por defecto**, y que
encenderla para un proyecto sea un gesto explícito y posterior.

El motivo, con sus palabras: el fichero que se sembró esta mañana sigue en
disco con la política encendida. Tal como está tu código, **el día que aterrice
en `main` la puerta se enciende sola**, sin que nadie lo decida, porque su
política ya está escrita. Aceptar el código y encender la puerta tienen que
ser dos actos separados.

Comprobado por mí, y es la prueba de que el riesgo es real y no teórico: el
código de la puerta no está en `main`, así que el hub vivo **no** lee ese
fichero y la puerta **no está operativa ahora mismo**. Es una trampa armada,
no una puerta en marcha.

Lo que quiero:

1. **Quita la siembra automática.** Hoy el fichero se siembra la primera vez
   con `ORCA_ROOT` y nace con `forgeOnly: true`. Eso es lo que enciende la
   puerta sola. Que arrancar sin fichero signifique **puerta apagada para
   todos los proyectos**, y que no se escriba nada por el hecho de arrancar.
2. **Encender es explícito y posterior.** Un proyecto sin marca pasa todo, como
   hasta ahora. La marca sigue siendo la que ya tienes (`forgeOnly: true` por
   id o por ruta), pero la pone una persona, no el arranque.
3. **Que el código nuevo no lea el fichero del incidente.** Con el renombrado
   ya no lo lee; no añadas ninguna compatibilidad que lo vuelva a leer.
4. **Prueba que lo fije.** Que exista una que diga «sin fichero de política,
   una escritura sin prefijo PASA», porque ése es ahora el defecto y es
   justo lo que nadie va a volver a comprobar a mano. Y que la que ya tienes
   —marca puesta, escritura sin prefijo rechazada— siga en verde.
5. **Actualiza tu documento de entrega.** Hoy dice «Ya está puesta en el hub del
   operador» y «la puerta está activa sobre ORCA desde las 08:58». Las dos
   frases han dejado de ser verdad y no pueden quedar así: di qué pasó, que se
   revirtió, y que aterriza apagada.

## Y lo que tienes que contarme, porque quedó sin respuesta

1. Tu doc dice que trabajaste en el checkout principal, pero el principal está
   limpio y tus cambios están en el worktree. ¿Los moviste tú? ¿Quedó algo allí?
2. Tocaste `test/synthetic.test.ts` y `test/gestures.test.ts`, que son de CF.
   Dime exactamente qué cambiaste en cada uno y por qué, para que decida yo si
   se queda.

## Verificación que quiero de vuelta

`npm run typecheck` y `npm test -- --changed`, más `hub-forge-gate` explícito.
Dime qué salió, con números. No corras shots: la máquina es mía para las
rondas de medición.

Contéstame en disco, en `docs/RESPUESTA-DA.md`, y además por `orca-tell`.
