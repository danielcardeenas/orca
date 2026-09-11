/**
 * AUTOMEJORA — ORCA mirándose a sí misma.
 *
 * Una sección aparte del resto de la consola, y aparte a propósito. Todo lo
 * demás que hay en el campo reporta la FLOTA: qué hacen los agentes, quién
 * espera a quién, cuánto cuesta. Esto reporta el INSTRUMENTO: cómo se está
 * usando ORCA y CAPCOM, qué estorba, qué se podría hacer mejor. Son dos
 * asuntos distintos y mezclarlos convierte el panel de misiones en un cajón.
 *
 * ── Una revisión es un AGENTE, no un turno ─────────────────────────
 *
 * Cada revisión la hace un **agente revisor temporal**: ORCA lo lanza por el
 * camino normal de spawn, aparece en el campo con su callsign, su estado y su
 * consumo como cualquier otro, hace su trabajo, reporta a esta sección y
 * termina. No es un turno de CAPCOM.
 *
 * La diferencia no es de implementación, es de lo que el operador puede ver y
 * hacer. Un turno de CAPCOM es invisible mientras dura: no se sabe si está
 * pensando, cuánto lleva, cuánto ha gastado ni cómo pararlo, y compite por el
 * contexto del mando con todo lo demás que la flota le está pidiendo. Un
 * agente se mira, se vuela hasta él, se abre su ventana, se le pone
 * presupuesto y se le para. Y cuando falla, falla como falla un agente —
 * visiblemente— en vez de dejar una revisión colgada que nadie sabe que existe.
 *
 * La sección es permanente; el revisor no. Las propuestas, las preguntas y las
 * decisiones viven aquí y sobreviven a mil revisores.
 *
 * ── Qué produce ────────────────────────────────────────────────────
 *
 * Propuestas. Cada una es una idea sobre el sistema con cuatro partes y un
 * orden fijo, porque es el orden en el que un operador decide:
 *
 *   resumen      una línea. Qué se propone.
 *   motivación   por qué. Con `evidence` cuando la hay: cifras que salieron
 *                del diario y de los contadores de uso, nunca inventadas.
 *   hipótesis    lo que se está suponiendo, cuando la idea no viene de una
 *                medición sino de mirar el sistema y pensar. Es obligatoria
 *                en ese caso: una idea creativa sin hipótesis explícita se
 *                lee como un hecho, y no lo es.
 *   detalle      lo largo, plegado. Accesible, no delante.
 *
 * `impact` y `effort` son opcionales *a propósito*. Una estimación inventada
 * es peor que ninguna: el operador la usa para ordenar y ordena mal. Se
 * rellenan sólo cuando hay algo en lo que apoyarlas.
 *
 * ── Qué NO hace ────────────────────────────────────────────────────
 *
 * Implementar. El revisor propone y no tiene con qué editar (ver `review` en
 * el spawn); lo que dispara trabajo es una decisión del operador, y se ve:
 * SEND abre una misión de CAPCOM con la propuesta entera dentro, y la
 * propuesta queda enlazada a ella (`missionId`). Una propuesta ya enviada no
 * se puede volver a enviar, que es lo que evita dos misiones para la misma
 * idea.
 *
 * ── Privacidad ─────────────────────────────────────────────────────
 *
 * La telemetría son CUENTAS y AGREGADOS: cuántas veces se usó cada
 * herramienta, cuántas escalaciones, cuánto se esperó, cuánto costó. Nunca el
 * texto de una conversación, ni un brief, ni una ruta, ni un secreto. Lo que
 * escribe el revisor pasa además por `redact`, que es un cinturón sobre los
 * tirantes: si en una cifra se le cuela algo con forma de credencial, no se
 * guarda.
 */

import { FORGE_EXECUTION_POLICY, FORGE_SQUAD_PREFIX } from './forge.ts';
import type { CapcomMission } from './missions.ts';

/* ── vocabulario ──────────────────────────────────────────────────── */

/** De qué va la propuesta. Ordena la lista y nada más. */
export type ImproveArea = 'ui' | 'usability' | 'performance' | 'reliability' | 'cost' | 'workflow' | 'other';
export const IMPROVE_AREAS: readonly ImproveArea[] = ['ui', 'usability', 'performance', 'reliability', 'cost', 'workflow', 'other'];

/**
 * De dónde sale la propuesta, y es la distinción que sostiene todo lo demás.
 *
 * `observed` viene de una medición y trae `evidence`. `hypothesis` viene de
 * mirar el sistema y pensar, y trae `hypothesis`. La creatividad no está
 * limitada a lo que se puede medir —una consola que sólo mejora lo que ya
 * sabe contar no llega nunca a lo que todavía no hace— pero tiene que ir
 * marcada, porque el operador decide distinto ante un hecho y ante una
 * corazonada.
 */
export type ImproveKind = 'observed' | 'hypothesis';
export const IMPROVE_KINDS: readonly ImproveKind[] = ['observed', 'hypothesis'];

/**
 * `open` la propuesta está delante. `snoozed` se pospuso hasta una fecha y
 * vuelve sola. `dismissed` se descartó (se conserva: es lo que impide que la
 * siguiente revisión la vuelva a proponer). `sent` ya es una misión.
 *
 * Los dos últimos los dice la MISIÓN, no el operador desde aquí: `completed`
 * es una enviada cuya misión terminó, y `archived` una cuya misión se retiró
 * de la consola. Existen porque el enlace `missionId` era de ida —SEND lo
 * escribía y nadie volvía a mirarlo— y el tablero seguía enseñando como
 * «enviada» un trabajo que el panel de misiones daba por terminado o ya no
 * enseñaba. Van y vuelven con la misión (ver `linkedStatus`); lo que no cambia
 * es que las tres siguen siendo una misión, con su enlace y su marca.
 */
export type ImproveStatus = 'open' | 'snoozed' | 'dismissed' | 'sent' | 'completed' | 'archived';
export const IMPROVE_STATUSES: readonly ImproveStatus[] = ['open', 'snoozed', 'dismissed', 'sent', 'completed', 'archived'];
/** Los estados que sólo existen porque hay una misión detrás. */
export const MISSION_STATUSES: readonly ImproveStatus[] = ['sent', 'completed', 'archived'];

export type ImproveGrade = 'low' | 'medium' | 'high';
export const IMPROVE_GRADES: readonly ImproveGrade[] = ['low', 'medium', 'high'];

/** Una línea de la conversación de una propuesta. */
export interface ImproveNote {
  id: string;
  role: 'human' | 'capcom' | 'system';
  text: string;
  at: number;
}

export interface ImproveProposal {
  id: string;
  /**
   * La identidad de la IDEA, no la de la fila. Dos revisiones que llegan a lo
   * mismo comparten clave y son una sola propuesta con `raised: 2`, en vez de
   * dos filas idénticas y dos avisos. La elige quien la reporta; si no la
   * elige, sale del título (ver `improveKey`).
   */
  key: string;
  /** La revisión que la levantó por primera vez. */
  reviewId: string;
  at: number;
  updatedAt: number;

  title: string;
  area: ImproveArea;
  kind: ImproveKind;
  /** El resumen conciso: lo único que se lee sin abrir nada. */
  summary: string;
  /** Lo largo. Plegado en la consola. */
  detail?: string;
  /** Cifras medidas que sostienen la propuesta. Vacío en una hipótesis. */
  evidence: string[];
  /** Lo que se está suponiendo. Obligatorio cuando `kind` es 'hypothesis'. */
  hypothesis?: string;
  /** Lo que la revisión necesita saber del operador para seguir. */
  question?: string;
  impact?: ImproveGrade;
  effort?: ImproveGrade;

  status: ImproveStatus;
  /** Cuándo la vio el operador. Sin esto es novedad, y la novedad avisa una vez. */
  seenAt?: number;
  /** `snoozed` hasta aquí; pasada la fecha vuelve a `open` sola. */
  snoozeUntil?: number;
  /**
   * La misión que se creó al enviarla a CAPCOM. Es lo que impide duplicarla,
   * y lo que la misión usa para devolverle a la propuesta su cierre y su
   * archivo (`linkedStatus`). Nunca se borra: una misión purgada deja la
   * propuesta en `archived`, que es donde la dejó el archivo previo.
   */
  missionId?: string;
  /** Cuántas revisiones han llegado a esta misma idea. */
  raised: number;
  lastRaisedAt: number;
  /** La conversación: respuestas del operador y lo que contestó CAPCOM. */
  notes: ImproveNote[];
  /**
   * El agente revisor que la propuso, y cómo se llama en el campo.
   *
   * Es el enlace idea → trabajo, y va en la propuesta y no sólo en la revisión
   * porque es lo que se quiere pulsar: desde la ficha, volar hasta el agente
   * que la escribió y abrir lo que hizo. Ausente en una propuesta archivada
   * por una herramienta sin agente detrás.
   */
  agentId?: string;
  callsign?: string;
}

/**
 * En qué punto está una revisión.
 *
 * Siete estados y ninguno es «desconocido», que es lo único inaceptable en una
 * cosa que corre sola: el operador tiene que poder mirar el panel y saber si
 * hay alguien trabajando, si terminó bien, o si murió sin decir nada.
 *
 *   launching  se pidió el spawn y todavía no hay agente que nombrar
 *   running    el agente existe y está en ello
 *   reported   archivó sus propuestas (el final bueno)
 *   ended      el agente terminó SIN reportar
 *   failed     el spawn falló, o el agente murió
 *   cancelled  el operador la paró
 *   expired    pasó `REVIEW_MAX_MS` sin cerrarse de ninguna otra forma
 *   overbudget cruzó su techo de tokens y ORCA lo paró
 *
 * `ended` y `reported` son distintos a propósito. Un agente que termina no
 * demuestra que haya propuesto nada, y decir «revisión completada» cuando no
 * llegó ni una línea sería exactamente la clase de resultado falso que hace
 * inútil un panel.
 */
export type ReviewStatus = 'launching' | 'running' | 'reported' | 'ended' | 'failed' | 'cancelled' | 'expired' | 'overbudget';

/**
 * Los estados con los que una revisión puede seguir viva.
 *
 * `reported` está en la lista a propósito: archivar no es terminar. Un revisor
 * que entrega y sigue mirando puede volver a llamar a `orca-improve` —el
 * brief le dice literalmente que corrija lo rechazado y lo mande otra vez— y
 * sigue gastando presupuesto mientras tanto. Lo que cierra una revisión es
 * `endedAt`, y lo pone `closeReview`.
 */
export const REVIEW_OPEN: readonly ReviewStatus[] = ['launching', 'running', 'reported'];

/** Una pasada de revisión: quién la hizo, cuándo, por qué, y qué salió. */
export interface ImproveReview {
  id: string;
  at: number;
  trigger: 'auto' | 'manual';
  /** Por qué se lanzó ahora. Se enseña: una revisión sin motivo es ruido. */
  reason: string;
  status: ReviewStatus;
  /**
   * El agente revisor. `shortId` es lo que el CLI imprime al arrancar y llega
   * antes que el id de sesión; `agentId` llega cuando la sesión aparece de
   * verdad (ver SPAWN_ACK_TIMEOUT_MS). Los dos se guardan porque durante unos
   * segundos el único nombre que existe es el corto, y el panel tiene que
   * poder decir algo en esos segundos.
   */
  agentId?: string;
  shortId?: string;
  callsign?: string;
  projectId?: string;
  machineId?: string;
  /** Cuándo archivó sus propuestas. */
  reportedAt?: number;
  /**
   * Cuándo se SOLTÓ EL SITIO. No es lo mismo que saber cómo acabó.
   *
   * Sólo se pone cuando el revisor está **confirmado ido**: el mundo lo da por
   * terminal, o ya no está en él. Mientras esto no tenga valor, la revisión
   * bloquea la siguiente — da igual que su resultado ya se sepa, que se le haya
   * pedido parar o que se le haya acabado el reloj. Un agente que puede seguir
   * vivo no deja sitio a otro: dos revisores a la vez es el único fallo de esta
   * sección que no se puede deshacer.
   */
  endedAt?: number;
  /**
   * Cuándo se DECIDIÓ el resultado, que puede ser mucho antes de soltar el
   * sitio: se pasó del techo, se le acabó el reloj, o el operador lo paró. A
   * partir de aquí `status` ya no cambia y lo único que falta es confirmar que
   * el agente se fue.
   */
  outcomeAt?: number;
  /** Cuántas veces se le ha mandado un `stop`, y cuándo el último. */
  stopAttempts?: number;
  lastStopAt?: number;
  /**
   * Cuándo el operador pidió pararla, si la paró.
   *
   * Está separado de `endedAt` a propósito, y es la diferencia entre «lo pedí»
   * y «está parado». Pedir un `stop` no para nada por sí solo: el comando
   * puede fallar, la máquina puede estar desconectada, y el agente sigue vivo
   * gastando. Mientras esto tenga valor y `endedAt` no, la revisión SIGUE
   * OCUPANDO EL SITIO — porque lanzar otra tendría dos revisores vivos a la
   * vez, que es justo lo que no puede pasar.
   */
  cancelledAt?: number;
  filed: number;
  merged: number;
  /** Lo que costó de verdad, leído del propio agente al cerrarse. */
  costUSD?: number;
  tokens?: number;
  /** El techo con el que se lanzó, para poder decir «gastó X de Y». */
  budgetTokens?: number;
  /**
   * Con qué se lanzó DE VERDAD, no con qué estaba configurado.
   *
   * Se sella al lanzar y no se vuelve a tocar: cambiar el modelo en SETUP no
   * puede reescribir el historial de una pasada que ya corrió con otro, y una
   * revisión en vuelo sigue con el suyo. Es lo que permite comparar lo que
   * propuso un modelo con lo que propuso otro.
   */
  runtime?: string;
  model?: string;
  /** Qué pasó, cuando no fue lo normal. Se enseña tal cual. */
  note?: string;
}

/**
 * Los límites, y son visibles y editables desde la consola a propósito: una
 * revisión periódica que el operador no puede parar ni espaciar es un gasto
 * que no controla.
 */
export interface ImproveConfig {
  paused: boolean;
  /** Mínimo entre revisiones automáticas, en minutos. */
  everyMin: number;
  /** Tope de revisiones automáticas por día. El coste, en una cifra. */
  perDay: number;
  /**
   * Cuánta señal nueva hace falta antes de gastar un turno de CAPCOM. Una
   * consola parada no tiene nada nuevo que contar, y preguntárselo cada seis
   * horas produce seis «nada nuevo» al día.
   */
  minSignal: number;
}

export const IMPROVE_DEFAULTS: Readonly<ImproveConfig> = {
  paused: false,
  // Seis horas: por debajo, dos revisiones miran la misma jornada y proponen
  // lo mismo; por encima, una semana de fricción se acumula sin que nadie la
  // mire. Cuatro revisiones al día como techo, que es el mismo número visto
  // desde el lado del gasto.
  everyMin: 360,
  perDay: 4,
  // Cuarenta gestos o hechos nuevos. Una sesión real de trabajo pasa de eso en
  // minutos; una consola abierta y quieta no llega nunca.
  minSignal: 40,
};

/**
 * Contadores de uso. Sólo NOMBRES y CUENTAS.
 *
 * `mcp:<tool>` es una herramienta que CAPCOM llamó. `ui:<frame>` es algo que
 * la consola pidió al hub. Nada más entra aquí: con la cuenta se ve qué se usa
 * y qué no, que es la pregunta, y con el contenido no se vería mejor.
 */
export interface ImproveUsage {
  /** Desde cuándo cuentan estos números. */
  since: number;
  counts: Record<string, number>;
  total: number;
}

export interface ImproveState {
  config: ImproveConfig;
  proposals: Record<string, ImproveProposal>;
  /** Las últimas, la más nueva primero. */
  reviews: ImproveReview[];
  usage: ImproveUsage;
  /** Contadores acumulados desde la última revisión: la «señal nueva». */
  signal: ImproveUsage;
  /**
   * Qué presupuesto se le pone a un revisor. Visible y editable, como el resto
   * de los límites: es lo que cuesta cada pasada.
   */
  budgetTokens: number;
  /**
   * Con qué CLI y con qué modelo nace el revisor. Elegido por el operador y
   * guardado; `null` significa «lo que diga el entorno», que es exactamente lo
   * que hacía antes de que esto se pudiera elegir.
   *
   * Nulos por defecto a propósito: una instalación que ya tenía
   * `ORCA_IMPROVE_RUNTIME`/`_MODEL` puestos sigue comportándose igual al
   * actualizar, y nadie se encuentra un modelo nuevo elegido por ORCA.
   */
  runtime: string | null;
  model: string | null;
  /**
   * Por qué el tablero no se está guardando, cuando no se guarda.
   *
   * Viaja hasta el panel a propósito. Una sección que acepta decisiones del
   * operador y las pierde al reiniciar sin decirlo es peor que una que no
   * existe: el operador cree que descartó algo y vuelve mañana.
   */
  degraded?: string;
}

export function emptyUsage(since: number): ImproveUsage {
  return { since, counts: {}, total: 0 };
}

export function emptyState(now: number): ImproveState {
  return {
    config: { ...IMPROVE_DEFAULTS },
    proposals: {},
    reviews: [],
    usage: emptyUsage(now),
    signal: emptyUsage(now),
    budgetTokens: REVIEWER_BUDGET_TOKENS,
    runtime: null,
    model: null,
  };
}

/* ── topes ────────────────────────────────────────────────────────── */

export const MAX_TITLE = 90;
export const MAX_SUMMARY = 400;
export const MAX_DETAIL = 4_000;
export const MAX_EVIDENCE = 6;
export const MAX_EVIDENCE_CHARS = 240;
export const MAX_QUESTION = 400;
export const MAX_NOTE = 4_000;
export const MAX_NOTES = 40;
/** Propuestas guardadas. Pasado el tope se podan las cerradas más viejas. */
export const MAX_PROPOSALS = 60;
/** Revisiones guardadas, para la línea «última revisión». */
export const MAX_REVIEWS = 40;
/** Distintos contadores de uso. Un nombre nuevo pasado el tope se ignora. */
export const MAX_COUNTERS = 200;
/** Cuántas propuestas puede archivar una sola llamada. */
export const MAX_PER_REPORT = 8;
/**
 * Pasado esto, una revisión en vuelo se da por perdida y deja de bloquear la
 * siguiente. CAPCOM puede morir, rotar o simplemente no llamar a la
 * herramienta; sin caducidad, la primera revisión que se pierde apaga la
 * sección para siempre.
 */
export const REVIEW_MAX_MS = 45 * 60_000;

/**
 * Cuántas veces se le manda `stop` a un revisor que no se muere, y cada cuánto.
 *
 * Cinco intentos con espera creciente: 20 s, 40 s, 80 s, 160 s, 320 s — unos
 * diez minutos en total. Acotado a propósito: un `stop` que no funciona cinco
 * veces no va a funcionar la sexta, y un reintento por segundo para siempre es
 * ruido en el collector y en el log.
 *
 * **Agotar los intentos NO suelta el sitio.** Lo único que suelta el sitio es
 * que el mundo confirme que el agente se fue. Si nadie lo confirma, la sección
 * se queda bloqueada Y LO DICE, con el número de intentos: un bloqueo visible
 * es un problema que alguien puede mirar; dos revisores a la vez, no.
 *
 * En la práctica hay tres formas reales de salir, y ninguna hace falta
 * forzarla: el agente pasa a `done`/`dead`, desaparece del mundo, o su máquina
 * se cae y el hub da por muertos a sus agentes (`BEAT_TIMEOUT_MS`).
 */
export const STOP_ATTEMPTS = 5;
export const STOP_BACKOFF_MS: readonly number[] = [20_000, 40_000, 80_000, 160_000, 320_000];

/**
 * Cuánto puede estar `idle` un revisor antes de darlo por terminado.
 *
 * Medido el 2026-09-08 en la primera revisión real: un agente de Claude Code
 * **no termina solo**. Acaba su turno, pasa a `idle` y se queda ahí esperando
 * otro prompt que nadie le va a mandar. Sin esto, un revisor que ya archivó
 * ocupaba el sitio hasta el reloj de pared —45 minutos— y seguía siendo una
 * sesión viva: exactamente el «agente permanente» que esta sección promete que
 * no deja.
 *
 * Un minuto, y no menos: un CLI pasa por `idle` entre dos llamadas a
 * herramienta, y cerrarle la revisión a los cinco segundos sería matarlo
 * mientras piensa. Es el mismo criterio que el asentamiento del idle en
 * `hub/wake.ts`.
 */
export const REVIEWER_IDLE_MS = 60_000;

/**
 * El techo de tokens de UN revisor, y qué garantiza exactamente.
 *
 * 400.000 de entrada + salida + escritura de caché; la LECTURA de caché no
 * cuenta (`ceilingTokens`, shared/tokens.ts). Una pasada de revisión es leer
 * un informe de una pantalla, mirar el repo un rato y escribir media docena de
 * propuestas.
 *
 * Hasta el 2026-09-11 la lectura contaba, y ninguna revisión pudo terminar:
 * un CLI con un prompt de sistema grande relee su prefijo cacheado en cada
 * llamada. AJ (`rev_mtw8cgp3dupemnnh`) se paró a los 46 s «at 451k of a 400k
 * ceiling» con 0 propuestas; por mensaje eran 230.615, de los que 227.946 eran
 * lectura de caché. Con la regla de ahora esa misma corrida llevaba 114.008, y
 * la sesión entera de AJ —hasta archivar sus ocho propuestas— 224.040: el
 * techo de 400k le deja terminar y sigue parando lo que se desboca, así que no
 * se ha movido.
 *
 * ── Lo que NO es ───────────────────────────────────────────────────
 *
 * **No es un techo duro, y no se debe vender como tal.** Medido en la primera
 * revisión real (`rev_mtschaq0u83g1or2`, 2026-09-08): el revisor cruzó los 400k
 * en menos de un minuto y llegó a marcar 1,1M antes de que nadie lo parara. Tres
 * razones, y ninguna se arregla subiendo el número:
 *
 *   1. **La medida llega tarde y da saltos.** El consumo se deriva del
 *      transcript que el collector relee; en esa misma sesión la cifra pasó por
 *      201k, 1.116.804 y 622.319 antes de asentarse. Nadie puede frenar en un
 *      punto que todavía no ha visto. (Los saltos hacia arriba eran además un
 *      error de cuenta: el collector sumaba el `usage` de cada línea, y Claude
 *      Code repite el del mensaje en cada bloque. Corregido en
 *      collector/derive.ts el 2026-09-11; lo tardío sigue siendo cierto.)
 *   2. **Frenar es mandar un comando.** `stop` viaja al collector y puede
 *      tardar o fallar; entre que se decide y que el proceso muere hay turnos.
 *   3. **Una llamada a un modelo no se puede partir por la mitad.** Un solo
 *      turno con mucho contexto ya gasta más que el resto de la pasada.
 *
 * Lo que sí garantiza: que ORCA **mire** el consumo en cada tic y en cada
 * cambio de estado del revisor, y que en cuanto lo vea por encima del techo lo
 * pare y cierre la revisión como `overbudget`. Es un freno, no un muro, y el
 * panel lo dice.
 *
 * ── Y no se deduce del tope diario ─────────────────────────────────
 *
 * El tope diario (`perDay`) limita CUÁNTAS revisiones automáticas ocurren;
 * esto limita lo que se le deja gastar a CADA una. Un techo diario repartido
 * entre revisiones sería un presupuesto que encoge según la hora del día, y una
 * revisión lanzada a última hora no puede valer menos que la de por la mañana.
 *
 * **Multiplicar los dos NO da un techo de gasto diario.** `perDay` no ata a la
 * ejecución manual —el operador puede pulsar REVIEW NOW las veces que quiera, y
 * debe poder— y cada pasada puede pasarse de su techo por lo de arriba. El
 * producto (4 × 400k) es el orden de magnitud que se espera en un día
 * automático, no un límite.
 *
 * Se cuenta en TOKENS y no en dólares porque el eje del dinero está apagado
 * salvo que se encienda `ORCA_BUDGET_MONEY=1` (ver hub/budgets.ts), y un
 * presupuesto que casi nunca se evalúa no es un presupuesto.
 */
export const REVIEWER_BUDGET_TOKENS = 400_000;

/**
 * El reloj de pared de una revisión, de punta a punta.
 *
 * Cuarenta y cinco minutos desde que se pide el spawn. Pasado eso la revisión
 * se da por perdida, se para al agente si sigue vivo y se deja sitio a la
 * siguiente. Sin esto, la primera revisión que se cuelga —el spawn se pierde,
 * el agente se atasca, la máquina se desconecta— apagaría la sección para
 * siempre, y ese fallo es silencioso, que es lo que lo hace peligroso.
 */

export const IMPROVE_ID = /^imp_[A-Za-z0-9_-]{1,64}$/;
export const IMPROVE_KEY = /^[a-z0-9][a-z0-9-]{1,60}$/;

/* ── qué se puede elegir ──────────────────────────────────────────── */

/**
 * Los CLI que ORCA sabe lanzar como revisor.
 *
 * Los mismos que `spawn` acepta. Un tercero se añade aquí y en el collector, y
 * no en dos sitios más: la lista corta es lo que impide que un `runtime`
 * escrito a mano llegue a una línea de comandos.
 */
export const REVIEW_RUNTIMES: readonly string[] = ['claude', 'codex'];

/** La forma de un id de modelo, la misma que valida el `spawn` del collector. */
export const MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Los topes del presupuesto de un revisor, y por qué son estos.
 *
 * Veinte mil abajo: por debajo, la sesión se queda sin contexto antes de haber
 * leído el informe, y una revisión que no puede leer no es barata, es inútil.
 * Veinte millones arriba: es un orden de magnitud por encima de lo que gasta
 * un día entero de trabajo real en esta flota, así que como techo cumple su
 * papel —parar lo que se desbocó— sin estorbar a nadie.
 *
 * El servidor recorta a este rango CUALQUIER valor, venga de donde venga: el
 * panel ofrece unos presets, pero también deja escribir uno, y una caja de
 * texto es exactamente por donde entra un cero de más.
 */
export const BUDGET_MIN = 20_000;
export const BUDGET_MAX = 20_000_000;

/** Lo que el operador puede cambiar en SETUP, ya validado. */
export interface ImproveChoice { runtime: string | null; model: string | null }

/**
 * Valida una elección de runtime/modelo, o dice por qué no.
 *
 * Vive aquí y no en el panel porque el que manda es el servidor: la consola no
 * es la única puerta —una prueba, un cliente futuro— y una regla escrita sólo
 * en la interfaz es una regla que no existe.
 *
 * El modelo NO se comprueba contra el catálogo de la máquina. Se comprueba su
 * FORMA, y el catálogo lo enseña el panel para elegir. La diferencia importa:
 * el catálogo es de una máquina y puede cambiar entre que se elige y se lanza,
 * y rechazar aquí un modelo que el CLI sí acepta sería inventarse una
 * limitación. Un modelo que no exista falla en el spawn, con el mensaje del
 * CLI, que es quien lo sabe.
 */
export function validateChoice(patch: { runtime?: unknown; model?: unknown }): { ok: true; value: Partial<ImproveChoice> } | { ok: false; error: string } {
  const out: Partial<ImproveChoice> = {};
  if (patch.runtime !== undefined) {
    if (patch.runtime === null || patch.runtime === '') out.runtime = null;
    else if (typeof patch.runtime === 'string' && REVIEW_RUNTIMES.includes(patch.runtime)) out.runtime = patch.runtime;
    else return { ok: false, error: `runtime must be one of ${REVIEW_RUNTIMES.join(', ')}, or empty to follow the environment` };
  }
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === '') out.model = null;
    else if (typeof patch.model === 'string' && MODEL_ID.test(patch.model)) out.model = patch.model;
    else return { ok: false, error: 'model id may only contain letters, digits, dot, dash and underscore, up to 64 characters' };
  }
  return { ok: true, value: out };
}

/**
 * Lo que se le pondrá al próximo revisor, resolviendo la herencia.
 *
 * La elección del operador gana; sin ella, el entorno; sin él, `claude`. Se
 * calcula en un sitio para que el panel pueda enseñar exactamente lo que va a
 * pasar en vez de una casilla vacía que el operador tiene que interpretar.
 *
 * El modelo del entorno SÓLO se hereda cuando el runtime efectivo es el suyo.
 * `ORCA_IMPROVE_MODEL` es el modelo de `ORCA_IMPROVE_RUNTIME`, no un modelo
 * universal: heredarlo bajo otro CLI produce parejas que no existen —`codex`
 * con el alias `opus`— y el lanzamiento falla por un motivo que el operador no
 * eligió. Sin modelo aplicable, decide el CLI, que es la herencia honesta.
 */
export function effectiveChoice(
  state: Pick<ImproveState, 'runtime' | 'model'>,
  env: { runtime: string; model: string },
): { runtime: string; model: string | null; from: { runtime: 'operator' | 'environment'; model: 'operator' | 'environment' | 'cli' } } {
  const runtime = state.runtime ?? env.runtime;
  const inherited = runtime === env.runtime ? (env.model || null) : null;
  return {
    runtime,
    model: state.model ?? inherited,
    from: {
      runtime: state.runtime ? 'operator' : 'environment',
      model: state.model ? 'operator' : inherited ? 'environment' : 'cli',
    },
  };
}

/* ── higiene del texto ────────────────────────────────────────────── */

/**
 * Tapa lo que tenga forma de credencial antes de guardarlo.
 *
 * Nada de lo que se le pide a la revisión necesita un secreto, así que esto no
 * debería dispararse nunca. Está porque el informe lo escribe un modelo que
 * está leyendo la consola, y «no debería» no es una garantía: un token pegado
 * en una propuesta se queda en disco y sale por el protocolo a cualquier
 * consola conectada.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]|xox[abposr])[-_][A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

function clean(text: unknown, max: number): string {
  return redact(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Igual que `clean` pero conserva los saltos de línea: el detalle es prosa. */
function cleanBlock(text: unknown, max: number): string {
  return redact(String(text ?? '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/**
 * La clave de una idea a partir de su título.
 *
 * Sólo se usa cuando quien reporta no da una. Normaliza acentos, tira todo lo
 * que no sea letra o número y se queda con las seis primeras palabras: dos
 * títulos que dicen lo mismo con distinta puntuación caen en la misma clave, y
 * dos que dicen cosas distintas no.
 */
export function improveKey(title: string): string {
  const slug = title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-');
  return slug.slice(0, 60) || 'sin-titulo';
}

/* ── lo que reporta una revisión ──────────────────────────────────── */

/** Lo que CAPCOM entrega por propuesta. Todo lo demás lo pone el hub. */
export interface ProposalDraft {
  key?: string;
  title: string;
  area?: string;
  kind?: string;
  summary: string;
  detail?: string;
  evidence?: string[];
  hypothesis?: string;
  question?: string;
  impact?: string;
  effort?: string;
}

function grade(v: unknown): ImproveGrade | undefined {
  const s = String(v ?? '').toLowerCase();
  return (IMPROVE_GRADES as readonly string[]).includes(s) ? s as ImproveGrade : undefined;
}

/**
 * Un borrador crudo → una propuesta guardable, o un error legible.
 *
 * Valida en vez de confiar porque el que escribe es un modelo: un `area` que
 * no existe rompe la lista, y una hipótesis sin hipótesis es exactamente la
 * confusión que la sección existe para evitar. Se rechaza con el motivo, que
 * es algo que CAPCOM puede leer y corregir en el mismo turno.
 */
export function normalizeDraft(raw: ProposalDraft): { ok: true; value: Omit<ImproveProposal, 'id' | 'reviewId' | 'at' | 'updatedAt' | 'status' | 'raised' | 'lastRaisedAt' | 'notes'> } | { ok: false; error: string } {
  const title = clean(raw.title, MAX_TITLE);
  if (!title) return { ok: false, error: 'title is required' };
  const summary = clean(raw.summary, MAX_SUMMARY);
  if (!summary) return { ok: false, error: `"${title}": summary is required` };

  const area = String(raw.area ?? 'other').toLowerCase();
  if (!(IMPROVE_AREAS as readonly string[]).includes(area)) {
    return { ok: false, error: `"${title}": area must be one of ${IMPROVE_AREAS.join(', ')}` };
  }
  const kind = String(raw.kind ?? 'observed').toLowerCase();
  if (!(IMPROVE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `"${title}": kind must be observed or hypothesis` };
  }

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .map((e) => clean(e, MAX_EVIDENCE_CHARS)).filter(Boolean).slice(0, MAX_EVIDENCE);
  const hypothesis = clean(raw.hypothesis, MAX_SUMMARY);

  // Las dos reglas que hacen que la marca signifique algo. Sin ellas, `kind`
  // es una etiqueta que el modelo pone al azar y el operador no puede confiar
  // en la distinción que usa para decidir.
  if (kind === 'hypothesis' && !hypothesis) {
    return { ok: false, error: `"${title}": a hypothesis proposal must state its hypothesis` };
  }
  if (kind === 'observed' && evidence.length === 0) {
    return { ok: false, error: `"${title}": an observed proposal must cite the measurements it rests on, or be filed as kind="hypothesis"` };
  }

  const key = raw.key !== undefined && IMPROVE_KEY.test(String(raw.key)) ? String(raw.key) : improveKey(title);
  const detail = cleanBlock(raw.detail, MAX_DETAIL);
  const question = clean(raw.question, MAX_QUESTION);

  return {
    ok: true,
    value: {
      key, title, area: area as ImproveArea, kind: kind as ImproveKind, summary,
      evidence,
      ...(detail ? { detail } : {}),
      ...(hypothesis ? { hypothesis } : {}),
      ...(question ? { question } : {}),
      ...(grade(raw.impact) ? { impact: grade(raw.impact)! } : {}),
      ...(grade(raw.effort) ? { effort: grade(raw.effort)! } : {}),
    },
  };
}

/* ── deduplicación ────────────────────────────────────────────────── */

/**
 * La propuesta que ya dice esto, si la hay.
 *
 * Primero por clave, que es la vía explícita. Y luego por título normalizado,
 * que es la red: quien reporta puede olvidarse de reutilizar la clave, y una
 * propuesta repetida con clave nueva es una fila duplicada y un aviso de más,
 * que es justo lo que no puede pasar en una sección que se ejecuta sola.
 *
 * Mira TODAS las propuestas, descartadas incluidas: descartar algo y que
 * vuelva a la mañana siguiente es la forma más rápida de que el operador deje
 * de mirar la sección.
 */
export function findDuplicate(state: ImproveState, key: string, title: string): ImproveProposal | null {
  const byKey = Object.values(state.proposals).find((p) => p.key === key);
  if (byKey) return byKey;
  const slug = improveKey(title);
  return Object.values(state.proposals).find((p) => improveKey(p.title) === slug) ?? null;
}

/* ── lectura ──────────────────────────────────────────────────────── */

/** Un `snoozed` cuya fecha ya pasó es un `open`, se mire cuando se mire. */
export function effectiveStatus(p: ImproveProposal, now: number): ImproveStatus {
  if (p.status === 'snoozed' && (p.snoozeUntil ?? 0) <= now) return 'open';
  return p.status;
}

/**
 * Lo que una propuesta enviada tiene que decir de su misión, mirando la
 * misión y nada más.
 *
 * Archivada gana a terminada: una misión retirada de la consola se retira del
 * tablero aunque acabara bien, porque lo que el operador quiso al archivarla
 * es no verla. Una `failed` sigue en `sent`: sigue siendo una misión abierta
 * en el panel de misiones, y el operador la reabre desde allí escribiéndole.
 * Es una función y no un campo copiado para que sólo haya UNA regla, y sea la
 * misma en el hub, en el barrido de arranque y en cualquier prueba.
 */
export function linkedStatus(m: Pick<CapcomMission, 'status' | 'archivedAt'>): 'sent' | 'completed' | 'archived' {
  if (m.archivedAt) return 'archived';
  if (m.status === 'completed') return 'completed';
  return 'sent';
}

const AREA_ORDER = new Map(IMPROVE_AREAS.map((a, i) => [a, i]));
const GRADE_WEIGHT: Record<ImproveGrade, number> = { high: 2, medium: 1, low: 0 };

/**
 * El orden de la lista: primero lo que espera decisión, y dentro de eso lo que
 * más promete por menos trabajo. Las que no tienen estimación no se hunden ni
 * flotan: van en medio, ordenadas por fecha, porque no saberlo no es lo mismo
 * que ser poco importante.
 */
export function sortProposals(list: ImproveProposal[], now: number): ImproveProposal[] {
  const rank = (p: ImproveProposal) => {
    const s = effectiveStatus(p, now);
    return s === 'open' ? 0 : s === 'snoozed' ? 1 : s === 'sent' ? 2 : s === 'completed' ? 3 : s === 'dismissed' ? 4 : 5;
  };
  const score = (p: ImproveProposal) => {
    if (!p.impact && !p.effort) return 0;
    return (p.impact ? GRADE_WEIGHT[p.impact] : 1) - (p.effort ? GRADE_WEIGHT[p.effort] : 1) * 0.5;
  };
  return [...list].sort((a, b) => rank(a) - rank(b)
    || score(b) - score(a)
    || (a.question ? 0 : 1) - (b.question ? 0 : 1)
    || (AREA_ORDER.get(a.area) ?? 9) - (AREA_ORDER.get(b.area) ?? 9)
    || b.updatedAt - a.updatedAt);
}

/** Lo que está esperando una decisión del operador. */
export function openProposals(state: ImproveState, now: number): ImproveProposal[] {
  return sortProposals(Object.values(state.proposals).filter((p) => effectiveStatus(p, now) === 'open'), now);
}

/**
 * Lo que todavía no ha visto nadie. Es la única fuente del aviso, y por eso
 * mira `seenAt` y no la fecha: una propuesta que se vio no vuelve a avisar
 * aunque otra revisión la levante otra vez.
 */
export function unseenProposals(state: ImproveState, now: number): ImproveProposal[] {
  return openProposals(state, now).filter((p) => p.seenAt === undefined);
}

/** Las preguntas abiertas al operador: lo que la revisión no puede decidir sola. */
export function openQuestions(state: ImproveState, now: number): ImproveProposal[] {
  return openProposals(state, now).filter((p) => !!p.question && !p.notes.some((n) => n.role === 'human'));
}

/**
 * La revisión que ocupa el sitio ahora mismo, o null.
 *
 * Una y sólo una: es lo que impide dos revisores a la vez. Una que ha pasado
 * de `REVIEW_MAX_MS` NO cuenta, aunque su estado siga diciendo `running`: se
 * dio por perdida, y quien la mire desde fuera tiene que ver el hueco libre
 * aunque el hub todavía no haya pasado por ella para marcarla.
 */
export function activeReview(state: ImproveState, now: number): ImproveReview | null {
  /*
   * Por `endedAt` y por nada más.
   *
   * Antes había además una salida por reloj: pasados `REVIEW_MAX_MS` la
   * revisión dejaba de contar aunque su agente siguiera vivo. Eso ERA el
   * agujero — un revisor que no se moría acababa dejando lanzar a otro encima.
   * Ahora el reloj decide el RESULTADO (`expired`) y no suelta nada: el sitio
   * lo suelta la confirmación de que el agente se fue, y sólo ella.
   */
  void now;
  return state.reviews.find((x) => x.endedAt === undefined) ?? null;
}

/**
 * Por qué una revisión sigue ocupando el sitio cuando su resultado ya se sabe.
 *
 * Devuelve null mientras está simplemente trabajando. Con texto, es lo que el
 * panel enseña y lo que `dueForReview` contesta: el operador tiene que poder
 * distinguir «hay alguien revisando» de «hay alguien que no se muere».
 */
export function heldReason(r: ImproveReview, now: number): string | null {
  if (r.endedAt !== undefined || r.outcomeAt === undefined) return null;
  const tries = r.stopAttempts ?? 0;
  const why = r.status === 'overbudget' ? 'OVER BUDGET'
    : r.status === 'expired' ? 'OUT OF TIME'
      : r.status === 'cancelled' ? 'STOPPED BY THE OPERATOR' : r.status.toUpperCase();
  const attempts = tries > 0 ? ` · STOP SENT ${tries}×` : '';
  const gaveUp = tries >= STOP_ATTEMPTS ? ' · NO MORE RETRIES' : '';
  return `${why}${attempts}${gaveUp} · WAITING FOR THE FLEET TO CONFIRM IT IS GONE · ${minutes(now - r.outcomeAt)}`;
}

/** La revisión que levantó una propuesta, si sigue en la lista. */
export function reviewOf(state: ImproveState, p: ImproveProposal): ImproveReview | null {
  return state.reviews.find((r) => r.id === p.reviewId) ?? null;
}

/**
 * Los agentes que han sido revisores, para que el campo los reconozca.
 *
 * La consola lo deduce del tablero en vez de que se lo diga un campo nuevo del
 * agente: el tablero ya viaja entero, ya es la autoridad sobre qué revisión
 * hizo quién, y guarda `MAX_REVIEWS` pasadas, así que un revisor sigue siendo
 * reconocible mucho después de terminar. Un `role` nuevo en el agente habría
 * que propagarlo por el collector, el hub y el protocolo para no decir nada
 * que esto no diga ya.
 */
export function reviewerIds(state: ImproveState | null): Set<string> {
  const out = new Set<string>();
  for (const r of state?.reviews ?? []) if (r.agentId) out.add(r.agentId);
  return out;
}

/* ── cuándo toca revisar ──────────────────────────────────────────── */

export interface DueVerdict {
  due: boolean;
  /** Por qué sí, o por qué todavía no. Se enseña tal cual en la consola. */
  reason: string;
  /** Cuándo podría tocar, si es cuestión de esperar. */
  nextAt?: number;
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/**
 * Si toca una revisión automática, y si no, por qué no.
 *
 * Cinco condiciones, y las cinco se pueden leer en la consola. Una revisión
 * cuesta un turno de CAPCOM —que es tiempo, contexto y dinero— así que lo
 * caro no es equivocarse de momento: es lanzarla sin que nadie sepa por qué.
 *
 * `capcomBusy` viene de fuera porque aquí no hay flota: la decisión de no
 * interrumpir a un CAPCOM que está en mitad de un turno es del hub, pero el
 * motivo que se enseña sale de aquí, con todos los demás.
 */
export function dueForReview(
  state: ImproveState,
  now: number,
  world: { capcomAlive: boolean; capcomBusy: boolean },
): DueVerdict {
  const cfg = state.config;
  if (cfg.paused) return { due: false, reason: 'PAUSED BY THE OPERATOR' };
  const live = activeReview(state, now);
  if (live) {
    const who = live.callsign ? ` · ${live.callsign}` : '';
    // Ya se sabe cómo acabó pero el agente puede seguir vivo: el sitio sigue
    // ocupado y se dice por qué. «A REVIEWER IS WORKING» sería mentira, y
    // «libre» sería el fallo que no se puede deshacer.
    const held = heldReason(live, now);
    if (held) return { due: false, reason: `${who ? `${who.slice(3)} · ` : ''}${held}` };
    return { due: false, reason: `A REVIEWER IS WORKING${who} · ${minutes(now - live.at)} IN` };
  }
  if (!world.capcomAlive) return { due: false, reason: 'NO CAPCOM SESSION TO ASK' };

  const last = state.reviews[0]?.at ?? 0;
  const waited = now - last;
  const every = Math.max(1, cfg.everyMin) * 60_000;
  if (last > 0 && waited < every) {
    return { due: false, reason: `NEXT IN ${minutes(every - waited)}`, nextAt: last + every };
  }
  const today = state.reviews.filter((r) => now - r.at < 86_400_000).length;
  if (today >= Math.max(1, cfg.perDay)) {
    const oldest = state.reviews.filter((r) => now - r.at < 86_400_000).at(-1)!.at;
    return { due: false, reason: `${today} REVIEWS IN 24H · AT THE DAILY CEILING`, nextAt: oldest + 86_400_000 };
  }
  if (state.signal.total < Math.max(0, cfg.minSignal)) {
    return { due: false, reason: `WAITING FOR SIGNAL · ${state.signal.total}/${cfg.minSignal} SINCE THE LAST REVIEW` };
  }
  // Lo último que se mira, porque es lo que cambia solo: un CAPCOM ocupado lo
  // estará menos dentro de un minuto, y el resto de condiciones no.
  if (world.capcomBusy) return { due: false, reason: 'CAPCOM IS MID-TURN · WAITING FOR IT TO SETTLE' };

  return {
    due: true,
    reason: last > 0
      ? `${minutes(waited)} SINCE THE LAST REVIEW · ${state.signal.total} NEW SIGNALS`
      : `FIRST REVIEW · ${state.signal.total} SIGNALS`,
  };
}

/* ── el informe que se le pasa a la revisión ──────────────────────── */

/**
 * La telemetría, ya en la forma en la que se lee.
 *
 * Cifras y nombres. Ni una ruta, ni una frase de una conversación, ni un
 * brief. Lo que se quiere saber —qué se usa, qué se atasca, qué cuesta— se
 * responde con cuentas, y el contenido sólo añadiría lo que no se debe
 * guardar.
 */
export interface TelemetryDigest {
  windowMs: number;
  lines: string[];
  /** Los contadores más usados, para la tabla de la consola. */
  top: { name: string; n: number }[];
}

export function topCounters(usage: ImproveUsage, limit = 12): { name: string; n: number }[] {
  return Object.entries(usage.counts)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * El brief del agente revisor.
 *
 * No es un turno más en una conversación que ya tiene contexto: es lo PRIMERO
 * y lo ÚNICO que ve una sesión recién nacida, así que tiene que traerlo todo —
 * qué es esto, qué se le pide, con qué mide, con qué contesta, y cuándo
 * termina. Un brief que da por sabido algo produce un agente que gasta su
 * primer cuarto de hora averiguándolo.
 *
 * Cinco cosas, en este orden porque es el orden en el que se desobedecen:
 *
 *   1. quién eres y qué NO eres (no eres un worker de esta flota)
 *   2. los dos trabajos: leer lo medido, y pensar más allá de lo medido
 *   3. con qué se contesta, literalmente, con la línea de comando entera
 *   4. lo que no se hace: implementar, editar, escalar al humano
 *   5. terminar
 *
 * Lo tercero va con el comando escrito tal cual porque un agente que no
 * encuentra su canal se lo inventa: escribe la revisión en prosa, la sesión
 * acaba, y no llega nada. Es exactamente lo que pasaba cuando `orca-tell` no
 * estaba en el PATH (ver collector/shims.ts).
 */
export function reviewerBrief(input: {
  reviewId: string;
  digest: TelemetryDigest;
  openProposals: ImproveProposal[];
  answered: ImproveProposal[];
  /** Dónde va a correr, para que sepa qué repositorio está mirando. */
  projectName?: string;
}): string {
  const open = input.openProposals.length
    ? input.openProposals.map((p) => `  - ${p.key}: ${p.title} [${p.status}${p.missionId ? ` → ${p.missionId}` : ''}]`).join('\n')
    : '  (none)';
  const answered = input.answered.length
    ? input.answered.map((p) => {
      const said = p.notes.filter((n) => n.role === 'human').at(-1);
      return `  - ${p.key}: the operator answered "${said?.text.slice(0, 300) ?? ''}"`;
    }).join('\n')
    : '  (none)';

  return [
    `[ORCA SELF-REVIEW ${input.reviewId}]`,
    '',
    'You are a temporary REVIEW agent inside ORCA, a console that commands fleets of',
    'coding agents. You were launched by ORCA itself, on a clock, to do one job and stop.',
    'You are not a worker on this fleet\'s missions and you have no lead to report to.',
    `The repository you are standing in is ORCA\'s own${input.projectName ? ` (${input.projectName})` : ''}.`,
    '',
    'YOUR JOB — two halves, both wanted:',
    '',
    '  1. Read the telemetry below and say what it shows about how ORCA and CAPCOM are',
    '     actually being used: friction, waste, waits, cost, things nobody touches,',
    '     things touched constantly. Read the code to understand what a number means',
    '     before you draw a conclusion from it.',
    '',
    '  2. Think past it. Propose UI, usability, performance, behaviour and outright new',
    '     capabilities you believe would make this console better, INCLUDING ideas the',
    '     numbers cannot support yet. Those are wanted, not tolerated. File them with',
    '     kind="hypothesis" and state the assumption you are making. Never dress a guess',
    '     as a measurement, and never invent a number: everything in `evidence` must be',
    '     quoted from the telemetry below or measured by you, as it is.',
    '',
    'Read whatever you need: the source, DESIGN.md, docs/, the git log. Take your time,',
    'then file. Fewer and better beats more.',
    '',
    'HOW YOU ANSWER — this is the only channel, and prose is not it:',
    '',
    '  orca-improve report --review ' + input.reviewId + ' --file proposals.json',
    '',
    'where proposals.json is {"proposals": [ … ]} and each proposal is:',
    '',
    '  key        stable slug for the IDEA, lowercase-with-dashes ("capcom-turn-latency").',
    '             Reuse a key from the board below when you mean the same idea.',
    '  title      the idea in a few words. Shown as the row.',
    `  area       one of: ${IMPROVE_AREAS.join(', ')}`,
    '  kind       "observed" (rests on measurements, REQUIRES evidence) or',
    '             "hypothesis" (an idea the data cannot support yet, REQUIRES hypothesis)',
    '  summary    one or two sentences. The only text read without opening anything.',
    '  detail     the long version: how it would work, what it touches, what it breaks.',
    '  evidence   array of measured facts, quoted as given. Required for "observed".',
    '  hypothesis what you are assuming, plainly. Required for "hypothesis".',
    '  question   something only the operator can settle, when it changes the proposal.',
    '  impact     low | medium | high — ONLY with grounds. A guess is worse than nothing.',
    '  effort     low | medium | high — same rule.',
    '',
    `At most ${MAX_PER_REPORT} proposals in one call. \`orca-improve report\` tells you what it`,
    'accepted and, for anything it refused, exactly why — fix it and call it again.',
    'Run `orca-improve --help` if you need the exact flags.',
    '',
    'WHAT YOU DO NOT DO:',
    '',
    '  - You do not implement anything. The operator decides what becomes work, and a',
    '    proposal they approve is handed to CAPCOM as its own mission. You have no edit',
    '    tools: that is deliberate, not an oversight, and it is not something to work',
    '    around with shell commands.',
    '  - You do not interrupt the human. You have no `orca-ask`. Anything you want to',
    '    ask goes in a proposal\'s `question` and reaches them in the panel.',
    '  - You do not put file paths, credentials, or the text of anyone\'s conversation',
    '    into a proposal. Counts, names and figures only.',
    '',
    'WHEN YOU ARE DONE: file, confirm it was accepted, write one line saying what you',
    'proposed, and end your turn. Do not wait for anything. This session is expected to',
    'finish; ORCA closes the review when you do.',
    '',
    `TELEMETRY (last ${Math.round(input.digest.windowMs / 3_600_000)}h). These are the numbers you may quote:`,
    ...input.digest.lines.map((l) => `  ${l}`),
    '',
    'ALREADY ON THE BOARD (do not re-file these; reuse the key to update one):',
    open,
    '',
    'THE OPERATOR ANSWERED THESE SINCE THE LAST REVIEW:',
    answered,
  ].join('\n');
}

/**
 * El texto con el que una propuesta entra en CAPCOM como misión.
 *
 * Va entera —resumen, evidencia, hipótesis, detalle y lo que se habló— porque
 * el que la recibe no ha estado en esta conversación. Y lleva el id de la
 * propuesta para que lo implementado se pueda volver a atar a lo propuesto.
 */
export function proposalHandoff(p: ImproveProposal): string {
  const lines = [
    `[ORCA SELF-IMPROVEMENT ${p.id}] ${p.title}`,
    '',
    `Area: ${p.area} · Kind: ${p.kind}${p.impact ? ` · Impact: ${p.impact}` : ''}${p.effort ? ` · Effort: ${p.effort}` : ''}`,
    '',
    p.summary,
  ];
  if (p.evidence.length) lines.push('', 'Evidence:', ...p.evidence.map((e) => `  - ${e}`));
  if (p.hypothesis) lines.push('', `Hypothesis (unverified): ${p.hypothesis}`);
  if (p.detail) lines.push('', p.detail);
  const talk = p.notes.filter((n) => n.role !== 'system');
  if (talk.length) {
    lines.push('', 'Conversation with the operator:');
    for (const n of talk) lines.push(`  ${n.role}: ${n.text}`);
  }
  lines.push(
    '',
    'The operator approved this for implementation. It came out of an ORCA self-review,',
    'so the work is on ORCA itself. Verify before you claim it is done.',
  );
  return lines.join('\n');
}

/** El título de la misión que abre una propuesta. Corto: es una fila de panel. */
export function proposalMissionTitle(p: ImproveProposal): string {
  return `AUTOMEJORA · ${p.title}`.slice(0, 100);
}

/**
 * El squad del agente que implementa una propuesta. Uno por propuesta, con
 * su id dentro, para que dos AUTOMEJORAS en vuelo no se pisen y para que
 * `bindSquad` pueda atar la misión a su agente antes de que éste tenga id de
 * sesión. Válido para `squadName`: letras, dígitos y guiones.
 */
export function implementerSquad(p: ImproveProposal): string {
  return `${FORGE_SQUAD_PREFIX}${p.id.replace(/[^A-Za-z0-9]/g, '').slice(-12).toLowerCase()}`;
}

/**
 * El brief del agente que IMPLEMENTA una propuesta.
 *
 * Es quien hace el trabajo pesado —leer, cambiar, verificar— en vez de
 * CAPCOM, que sólo publica el resultado. Por eso lleva todo lo que hasta hoy
 * se le mandaba a CAPCOM (`proposalHandoff`) más lo que un implementador
 * necesita y CAPCOM no: cómo se verifica en este repositorio, qué es el
 * entregable y cómo llega su resultado a la misión. Ese último punto es el
 * que evita que salga a buscar un comando para «reportar a CAPCOM»: su
 * último mensaje ES el informe, ORCA lo vuelca en la misión y CAPCOM lo
 * publica.
 */
export function implementerBrief(p: ImproveProposal, missionId: string): string {
  return [
    `[ORCA MISSION ${missionId}] ${proposalMissionTitle(p)}`,
    '',
    'You are FORGE, the specialized self-improvement coordinator and lead of this mission on ORCA\'s own repository.',
    'Coordinate the approved scope end to end; CAPCOM retains final control, safety decisions and publication:',
    'read the code it points at, make the change, and verify it before you call it done.',
    '',
    proposalHandoff(p),
    '',
    'How to verify here: `npm run typecheck` and `npm test -- --changed`. If the change is visual, `npm run visual`.',
    'A "sin suite que los cubra" warning means nothing tests what you touched: write the test, or say so in your report.',
    '',
    'Operational workflow:',
    '1. Proposal and approval: the console gesture approved only the proposal below. Do not approve new scope yourself.',
    '2. Assignment: inspect architecture and AGENTS.md; define acceptance criteria, file ownership and dependencies.',
    '   Delegate bounded tasks only when useful. Give every member these same safety and verification constraints.',
    '3. Follow-up: use the existing squad mailbox and mission crew; read member reports before deciding.',
    '   Reuse mission IDs, agent states, dispatch receipts and recovery incidents; do not maintain a parallel status ledger.',
    '4. Blockers: resolve technical questions inside the squad. Inspect exact quota incidents before a bounded recovery;',
    '   never blindly retry an exhausted option. Resolve routine execution locally; escalate elevated or ambiguous actions to CAPCOM.',
    '5. Verification: inspect and consolidate the actual diffs, including work left by members without a report.',
    '   Run the required checks on the consolidated tree. A spawn receipt, a member saying done, or an idle agent is not proof.',
    '6. Report: include proposal and mission IDs, decisions, files, exact checks and results, uncovered code, risks and limits.',
    '',
    'Safety: verify you are on an isolated branch/worktree before editing; if absent, create an isolated worktree first.',
    'Never test against real sessions, live hub state or production data. Use temporary stores and synthetic agents.',
    'Do not bypass native permission prompts, approve human decisions, publish, deploy, merge, reload services or run destructive actions.',
    FORGE_EXECUTION_POLICY,
    'If scope or authority is insufficient, return a precise blocker to CAPCOM; do not widen approval yourself.',
    '',
    'Commit only your authorized files on your isolated branch when checks pass. Your final message is the consolidated report:',
    'what changed (files), what you ran and what it said, what is left. ORCA carries that last message into the',
    'mission conversation; CAPCOM publishes it and offers to land your branch. Do not message CAPCOM yourself,',
    'do not ask the operator unless nothing else can decide it, and do not report "done" without the verification output.',
    'If the operator writes to you with an [ORCA MISSION] header, answer in your final message the same way.',
  ].join('\n');
}
