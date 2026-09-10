# El carril del HUD empieza debajo de lo que tiene encima — 2026-09-10

## Pedido

En MISSIONS y SELF-IMPROVEMENT había espacio libre por encima del contenido.
El operador quería que el contenido subiera a ocuparlo.

## Qué era

No era relleno de los paneles: entre cabecera y lista hay 4 px en MISSIONS y
la barra de estado de SELF-IMPROVEMENT va pegada a su cabecera. El hueco
estaba ENCIMA del carril (`.hud__col`), que arrancaba en `--hud-top`, el borde
inferior del mástil entero.

A 1440 px el mástil envuelve: SFX y ? caen a una segunda fila de herramientas
y la telemetría (`.tele`) a una tercera, las dos pegadas a la derecha. El
mástil mide entonces 124 px y su borde queda 70 px por debajo de lo último que
de verdad hay sobre la columna de la izquierda, que es la fila FLEET · CAPCOM.
Las misiones arrancaban a 150 px del borde con campo vacío entre FLEET y su
cabecera; la automejora, empujada por ellas, a 336.

## Qué se hizo

- `src/ui/main.ts`: `railTop()` mide, pieza a pieza, qué tiene el mástil sobre
  la franja horizontal del carril —los hijos directos del mástil, la fila de
  herramientas botón a botón, la telemetría por su texto— y escribe
  `--col-top` con la más baja de las que pisan la columna, más 8 px. Se
  recalcula con el `ResizeObserver` del mástil que ya existía y cuando cargan
  las fuentes. En táctil el carril es `display: contents`, no tiene caja, y no
  se escribe medida: las hojas siguen `--hud-top`.
- `src/ui/styles/hud.css`: `.hud__col` usa `--col-top` para `top` y para el
  techo (`max-height`), con `--hud-top` de reserva. El resto del CSS de ambos
  paneles no cambia; `--hud-top` sigue siendo el borde del mástil para el
  recorte de etiquetas de región y para las hojas móviles.
- `test/hud-missions.shots.ts`: la comprobación «el panel empieza debajo del
  mástil» pasa a decir lo que se quería decir: el panel no pisa ninguna pieza
  del mástil que tenga encima, y empieza a 16 px o menos de la más baja.

Resultado a 1440×900: MISSIONS de 150 a 94 px; SELF-IMPROVEMENT de 336 a 280.
Sin cambios en cabeceras, listas, scroll ni pliegue.

Capturas: `test/shots/hud-rail-before-after.png` (izquierda antes, derecha
después), y las de siempre de los dos arneses.

## Verificación

```
npm run typecheck
npx tsx test/hud-missions.shots.ts
npx tsx test/hud-improve.shots.ts
npm test -- --changed
```

Los tres archivos tocados no los alcanza ninguna suite unitaria (`sin suite que
los cubra`); lo que los cubre son los dos arneses de capturas de arriba, y el
de misiones es el que afirma la geometría.
