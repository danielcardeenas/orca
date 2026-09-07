# Rotación de CAPCOM: relevar antes de que olvide

Una sesión de CLI compacta su contexto cuando se llena, y lo sigue haciendo
indefinidamente. A la tercera o cuarta compactación el mando trabaja sobre un
resumen de un resumen: nada falla, las respuestas solo se vuelven más vagas.

La salida no es alargar la conversación, es dejar de tratarla como el registro.
El registro es el hub —tareas, escalaciones, memoria persistente— y `briefing`
lo lee en una llamada. Así que una sesión pasada de umbral se sustituye por otra
con el mismo brief. Eso es una rotación, y `src/collector/rotation.ts` es la
regla que dice cuándo.

## Cuándo

Tres señales, cualquiera de ellas basta:

| Señal | Por defecto | Variable |
| --- | --- | --- |
| Fracción de la ventana ocupada por el último prompt | 75 % | `ORCA_CAPCOM_MAX_CONTEXT_PCT` |
| Compactaciones observadas en el transcript | 2 | `ORCA_CAPCOM_MAX_COMPACTIONS` |
| Turnos | 300 | `ORCA_CAPCOM_MAX_TURNS` |

La fracción de la ventana es la señal preferente porque llega **antes** de la
primera compactación: el relevo hereda un checkpoint en vez de un resumen de un
resumen. No sirve como medida de pérdida acumulada —el número cae a unos pocos
miles después de cada compactación—, así que no puede ser la única. Las
compactaciones son la medida de lo ya perdido y solo crecen. Los turnos son la
red para un CLI que no reporta ni ventana ni compactaciones. Un `0` apaga cada
señal; las tres a `0` apagan la rotación.

Codex reporta las tres: `last_token_usage.input_tokens` sobre
`model_context_window` para la ventana, y una línea `compacted` por compactación.
Claude reporta compactaciones (`compact_boundary`) y tokens de contexto.

Y solo cuando es seguro: la sesión ociosa, sin escalaciones pendientes en esta
máquina y en silencio `ORCA_CAPCOM_ROTATE_IDLE_MS` (30 s por defecto). Puede
esperar indefinidamente: un CAPCOM ocupado es un CAPCOM trabajando, tenga el
contexto que tenga. Mientras espera, lo dice una vez en el log.

## Cómo

Dos caminos, según cómo naciera la sesión actual:

- **Relanzar.** Si ORCA eligió su identificador (`claude --session-id`), se para
  el pane y se arranca otro con `CAPCOM_ROTATED_PROMPT`. Se avisa al hub antes,
  para que retenga el correo, y no se carga al tope de relanzamientos: es
  política, no una caída.
- **Traspaso preparado.** Si la sesión venía preparada —cualquier Codex, o un
  traspaso ya activado—, su identificador no era de ORCA y no se puede recrear:
  hay que preparar el relevo, comprobar que arranca y solo entonces retirar al
  anterior. Es exactamente lo que hace `New CAPCOM` a mano; la rotación
  automática pide lo mismo por dentro (`ProviderHandoffs.fresh`), con la
  retención de correo y el archivo que ese camino ya trae. Ver
  [CAPCOM-NEW.md](CAPCOM-NEW.md).

Entre dos intentos de traspaso pasan diez minutos. El umbral que disparó la
rotación sigue superado mientras el CAPCOM actual siga siendo el actual, así que
sin ese freno una preparación que falla por cuota pediría un proceso del CLI
cada diez segundos. Un fallo deja al CAPCOM actual exactamente donde estaba.

## Con qué contexto arranca el relevo

`ORCA_CAPCOM_ROTATE_MODE` elige entre los dos modos de `New CAPCOM`:

- `continuity` (por defecto): hereda el checkpoint corto que escribe el hub
  —tareas abiertas, preguntas sin resolver, reglas persistentes, referencias de
  la flota— y sigue. Una rotación que nadie pidió no debería costarle al
  operador el hilo en el que estaba.
- `clean`: arranca vacío y espera instrucciones. Es lo que un operador elige
  deliberadamente, no lo que conviene a una rotación desatendida.

En ningún caso se tocan tareas, conversaciones del hub, reglas ni workers: eso
es estado del hub y sobrevive a cualquier relevo. Es justamente lo que permite
que la sesión sea desechable.

## Verificación

```sh
npm run typecheck
npm test -- rotation
npm test -- codex
npm test -- capcom capcom-new provider-handoff
```
