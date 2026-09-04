# El canal agente → humano

Un agente de Claude Code no tiene socket hacia ORCA. Tiene un filesystem. Por eso
el canal para pedirle algo a un humano es un buzón de archivos dentro del propio
proyecto, y no una API.

```
<project>/.orca/ask/<id>.json            el agente pregunta
<project>/.orca/ask/<id>.answer.json     ORCA responde; el agente hace polling
```

El collector vigila esa carpeta en cada proyecto que conoce (`fs.watch` + poll de
1s), convierte cada pregunta en un `Escalation` del contrato y la emite al hub
como `{t:'escalation'}`. La respuesta viaja de vuelta por el comando
`{k:'answer', escalationId, answer, rememberAs}`.

Este documento **es** el contrato. El runtime del CEO y la skill del agente
dependen de él; cambiarlo sin cambiar los tres lados rompe el canal.

---

## 1. Preguntar

El agente escribe un JSON en `<project>/.orca/ask/<id>.json`. El `<id>` lo elige
el agente: cualquier cosa que sea un nombre de archivo válido y no termine en
`.answer` (un uuid, un timestamp, un slug de la pregunta).

```jsonc
{
  // OBLIGATORIO. Una sola pregunta, en una línea. Es lo que verá el humano
  // en la interrupción de la consola, así que tiene que poder contestarse
  // sin abrir nada más.
  "question": "¿Uso Stripe o Mercado Pago para el piloto?",

  // Opcional. Contexto para que el humano conteste rápido y bien.
  // Va debajo de la pregunta en la consola. Puede ser multilínea.
  "context": "El cliente factura en MXN y ya tiene cuenta de Mercado Pago.\nStripe cobra 3.6% + IVA aquí.",

  // Opcional. Respuestas sugeridas, máximo 12. La consola las pinta como
  // botones de una sola pulsación. Cortas: son etiquetas, no párrafos.
  "options": ["Stripe", "Mercado Pago", "Los dos, detrás de una interfaz"],

  // Opcional, default false. true = el humano SÓLO puede elegir una opción.
  // Sólo tiene efecto si `options` no está vacío. Úsalo cuando texto libre
  // no te sirva de nada (una decisión binaria, un enum).
  "optionsOnly": false,

  // Opcional, default "normal". "low" | "normal" | "blocking".
  // "blocking" significa: no puedo avanzar en NADA sin esto.
  "urgency": "blocking",

  // Opcional pero MUY recomendado. El sessionId de quien pregunta, para que
  // la consola sepa a qué agente pertenece la interrupción. Sin esto el
  // collector se la atribuye al agente más recientemente activo del proyecto,
  // que con varios agentes en el mismo repo puede equivocarse.
  "agentId": "78b357fe-4480-419f-bd99-7b5d7980e7fd",

  // Opcional. Minutos tras los cuales la pregunta se retira sola.
  // Úsalo si vas a morir esperando; evita interrupciones zombi en la consola.
  "ttlMinutes": 120
}
```

Reglas que el agente debe respetar:

- **`question` es obligatorio.** Un archivo sin él se ignora (y se registra un
  warning). Nada más lo es.
- **Escribe atómicamente.** Escribe en `<id>.json.tmp` y renombra a `<id>.json`.
  El collector reintenta cada segundo si lee un JSON a medias, pero un rename es
  gratis y elimina la carrera.
- **`mkdir -p` la carpeta.** El collector NO crea `.orca/ask/` — no queremos que
  un daemon de observación escriba dentro de los repos del usuario sin que nadie
  se lo pida. La primera pregunta la crea el agente.
- **Una pregunta por archivo.** Si necesitas tres respuestas, escribe tres
  archivos; se muestran como tres interrupciones y se responden por separado.
- **Añade `.orca/` a `.gitignore`.** Es estado local, no código del proyecto.

## 2. Esperar

El agente hace polling de `<project>/.orca/ask/<id>.answer.json`. Un patrón que
funciona dentro de una sesión de Claude Code:

```bash
for i in $(seq 1 600); do            # 10 minutos a 1Hz
  [ -f .orca/ask/pago.answer.json ] && cat .orca/ask/pago.answer.json && break
  sleep 1
done
```

Mientras la pregunta está abierta el agente aparece en la consola como
`blocked` con `block.kind = "question"` y `block.escalationId` apuntando a la
escalación. Es el único estado del que la escena 3D tiene permiso de gritar.

## 3. La respuesta

Cuando el humano (o el CEO) contesta, el collector escribe:

```jsonc
{
  "answer": "Mercado Pago",              // lo que dijo el humano, texto libre
  "at": 1788539532517,                   // epoch ms
  "answeredBy": "human",                 // "human" | "ceo"
  "rememberAs": "pasarela preferida",    // null, o el nombre bajo el que el
                                         // humano quiere que se recuerde esto
  "id": "pago"                           // el <id> del archivo original
}
```

...y **borra** `<id>.json`. Ese es el orden, y es deliberado: si el collector
muere entre las dos operaciones, el agente ya tiene su respuesta y la pregunta se
re-emitiría a lo sumo una vez. Al revés se perdería la respuesta.

La respuesta también se escribe atómicamente (`.tmp` + rename), así que el agente
nunca puede leer un JSON incompleto.

## 4. Retirarse

Si el agente resuelve la duda solo, **borra su propio `<id>.json`**. El collector
lo detecta en el siguiente barrido y emite
`{t:'escalation:withdraw', id, reason}`, la interrupción desaparece de la consola
y el agente vuelve a su estado normal. No dejes preguntas abiertas que ya no te
importan: cada una es una interrupción a un humano.

Lo mismo pasa solo cuando vence `ttlMinutes`.

## 5. Ids

El id que viaja por el protocolo **no** es el nombre del archivo. El collector
deriva uno estable y global:

```
esc_<sha1(ruta absoluta del archivo)[0..16]>
```

Es estable entre reinicios del collector (el mismo archivo produce siempre el
mismo id) y no colisiona entre proyectos que casualmente tengan un `ask/1.json`
cada uno. El agente no necesita conocerlo: le basta su propio nombre de archivo.

## 6. Lo que este canal NO es

- **No es un chat.** Una pregunta, una respuesta, se acabó. Para conversar está
  el CEO.
- **No responde prompts de permisos de Claude Code.** Eso es otra cosa
  (`block.kind = "permission"`), y hoy el CLI no expone forma de contestarlos
  desde fuera del proceso — ver `docs/CONTRACT-REQUESTS.md`.
- **No transporta secretos.** Si necesitas una credencial, pídele al humano que
  la guarde con `key:set`; llegará al agente como variable de entorno la próxima
  vez que ORCA lo lance, sin pasar nunca por un archivo del repo.

## 7. Ejemplo mínimo, de punta a punta

```bash
# El agente pregunta.
mkdir -p .orca/ask
cat > .orca/ask/q1.json.tmp <<'JSON'
{"question":"¿Despliego a producción o me quedo en staging?",
 "options":["Producción","Staging"],"optionsOnly":true,
 "urgency":"blocking","agentId":"'"$CLAUDE_SESSION_ID"'"}
JSON
mv .orca/ask/q1.json.tmp .orca/ask/q1.json

# El agente espera.
while [ ! -f .orca/ask/q1.answer.json ]; do sleep 1; done
ANSWER=$(python3 -c "import json;print(json.load(open('.orca/ask/q1.answer.json'))['answer'])")
echo "el humano dijo: $ANSWER"
```
