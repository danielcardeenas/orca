/** Strict live permission menus for hosted Claude/Codex terminals; unknown layouts fail closed. */

import { createHash } from 'node:crypto';

export interface ScreenPrompt {
  kind: 'permission' | 'trust';
  runtime: 'claude' | 'codex';
  summary: string;
  /**
   * La pregunta literal que el diálogo está esperando, recortada a una línea.
   *
   * Existe para que un bloqueo pueda decir QUÉ se pregunta y no sólo que algo
   * pasa. Es texto del CLI, no del agente ni del repositorio: el diálogo de
   * confianza pregunta siempre lo mismo, y el de permisos ya trae su contexto
   * saneado en `summary`.
   */
  question: string;
  /** Hash includes unredacted request and options, never exported as text. */
  fingerprint: string;
  onceKey: string | null;
  denyKey: 'Escape';
}

/** Deliberately conservative: an exact menu at the live bottom of the screen. */
export function promptOn(screen: string, _tail = 30): ScreenPrompt | null {
  const lines = screen.replace(/\r/g, '').split('\n');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const trust = lastIndex(lines, l => /Is this a project you created or one you trust\?/.test(l));
  if (trust >= 0 && /Enter to confirm.*Esc to cancel/i.test(lines.at(-1)!)) {
    const text = lines.slice(trust).join('\n');
    if (!/Yes, I trust this folder/.test(text)) return null;
    return {
      kind: 'trust', runtime: 'claude',
      summary: 'Workspace trust requires manual terminal review',
      // Sólo hasta el '?': el resto del párrafo es la explicación larga del CLI.
      question: `${lines[trust]!.trim().split('?')[0]!.trim()}?`,
      fingerprint: hash(text), onceKey: null, denyKey: 'Escape',
    };
  }
  const i = lastIndex(lines, l => /^\s*(?:Do you want to proceed\?|Would you like to run the following command\?|Allow the .+ MCP server to run tool "[^"\n]+"\?)\s*$/.test(l));
  if (i < 0) return null;
  const runtime = /Do you want/.test(lines[i]!) ? 'claude' : 'codex';
  const options: { key: string; label: string }[] = [];
  let footer = false;
  for (const line of lines.slice(i + 1)) {
    const l = line.trim();
    if (!l) continue;
    const m = /^(?:[❯›>]\s*)?([1-9])\.\s*(.+)$/.exec(l);
    if (m && !footer) { options.push({ key: m[1]!, label: /MCP server/.test(lines[i]!) ? m[2]!.split(/\s{2,}/)[0]! : m[2]! }); continue; }
    if (/^(?:enter to submit \| esc to cancel|Press enter to confirm or esc to cancel|Enter to confirm.*|Esc to cancel.*)$/i.test(l)) { footer = true; continue; }
    // MCP arguments / shell command appear before the choices.
    if (!options.length && runtime === 'codex' && !/^[❯›>⏺]/.test(l)) continue;
    return null; // ordinary input / output following a historical menu
  }
  if (options.length < 2 || new Set(options.map(o => o.key)).size !== options.length) return null;
  if (runtime === 'codex' && !footer) return null;
  if (runtime === 'codex' && /following command/.test(lines[i]!) && !lines.slice(i + 1).some(l => /^\s*\$\s+\S/.test(l))) return null;
  // No field is required of an MCP dialog. Demanding one (`action:` was the
  // first fixture's) rejects every tool that names its arguments otherwise —
  // browser_navigate has `url`, browser_click has `ref`, browser_snapshot has
  // none — and rejecting means going blind, not failing safe. The header, the
  // exact option labels and the footer are what identify the menu.
  const once = options.filter(o => /^(?:Yes|Yes, proceed(?: \(y\))?|Allow)$/.test(o.label));
  const deny = options.filter(o => /^(?:No(?:,.*| \(.*\))?|Cancel)$/.test(o.label));
  if (once.length !== 1 || deny.length !== 1) return null;
  if (options.some(o => !/^(?:Yes(?:,.*)?|No(?:,.*| \(.*\))?|Allow(?: for this session)?|Always allow|Cancel)$/.test(o.label))) return null;
  let start = i;
  if (runtime === 'claude') {
    start = i - 1;
    while (start >= 0 && (!lines[start]!.trim() || /This command requires approval/.test(lines[start]!))) start--;
    if (start < 0) return null; // missing request context
  }
  const raw = lines.slice(runtime === 'claude' ? 0 : start).join('\n').replace(/^[ \t]*[❯›>]\s*(?=\d\.)/gm, '').split('\n').map(l => l.trim()).join('\n');
  const context = runtime === 'claude' ? lines[start]!.trim() : lines.slice(i, lines.findIndex((l, n) => n > i && /(?:[1-9])\.\s*(?:Yes|Allow)/.test(l))).join('\n');
  return { kind: 'permission', runtime, summary: safePermissionContext(context) + (runtime === 'claude' ? commandShape(lines.slice(0, i)) : ''), question: lines[i]!.trim(), fingerprint: hash(raw), onceKey: once[0]!.key, denyKey: 'Escape' };
}

function commandShape(lines: string[]): string {
  const command = lines.map(l => (/^\s*(?:│|\$)\s*([A-Za-z0-9_./-]+)/.exec(l) ?? /^\s*⏺ Bash\(([A-Za-z0-9_./-]+)/.exec(l))?.[1]).find(Boolean);
  return command ? `\nCommand: ${command.split('/').pop()} [arguments omitted; inspect terminal]` : '';
}

/** Only confirms that the dialog closed, never that the tool succeeded or was allowed. */
export function permissionClosed(screen: string): boolean {
  if (promptOn(screen)) return false;
  const lines = screen.trimEnd().split('\n');
  return lines.slice(-5).some(l => /^(?:❯\s*|›(?:\s*| Ask Codex to do anything\s*))$/.test(l.trim())) && !lines.slice(-10).some(l => /enter to submit|Enter to confirm|Do you want to proceed|Allow the .* MCP/.test(l));
}

function lastIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (predicate(lines[i]!)) return i;
  return -1;
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/**
 * Una huella de la pantalla, para saber si ALGO se está pintando.
 *
 * No mira lo que dice: sólo si cambia. Es la única señal de "esperando a
 * alguien" que no depende del texto de un diálogo, y por tanto la única que
 * sobrevive a que Codex o Claude reescriban su TUI mañana.
 *
 * Funciona porque las dos CLIs animan mientras trabajan — spinner, segundos
 * transcurridos, tokens — así que un turno abierto pinta algo cada segundo.
 * Una pantalla idéntica durante segundos con el turno abierto significa que
 * nadie está pintando: o pregunta algo, o se colgó. Las dos cosas quieren a
 * un humano.
 *
 * Se normalizan los blancos del final de cada línea porque tmux rellena el
 * ancho del pane y ese relleno cambia con un resize sin que cambie nada.
 */
export function screenSignature(screen: string): string {
  const body = screen.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  return hash(body);
}

/** Keep tool names and operation shape; values may be credentials, even without labels. */
export function safePermissionContext(text: string): string {
  return text.split('\n').map(line => {
    const l = line.trim();
    if (!l) return '';
    if (/^Contains shell syntax \(string\) that cannot be statically analyzed$/.test(l)) return l;
    if (/^Would you like to run the following command\?$/.test(l)) return l;
    if (/^Allow the [A-Za-z0-9_.-]+ MCP server to run tool "[A-Za-z0-9_.-]+"\?$/.test(l)) return l;
    const command = /^\$\s*([A-Za-z0-9_./-]+)/.exec(l);
    if (command) return `Command: ${command[1]!.split('/').pop()} [arguments omitted; inspect terminal]`;
    // Any `name: value` line of an MCP dialog. The name survives (it is the
    // shape of the request); the value never does, unless it is an `action`
    // out of a known, harmless set.
    const field = /^([A-Za-z_][A-Za-z0-9_-]{0,40})\s*:\s*(.*)$/.exec(l);
    if (field) return `${field[1]}: ${field[1] === 'action' && /^(list|new|close|select|navigate)$/.test(field[2]!) ? field[2] : '[value omitted]'}`;
    return '[request details omitted; inspect terminal]';
  }).filter(Boolean).join('\n').slice(0, 1200);
}

/* ── lo que está escribiendo ──────────────────────────────────────── */

/**
 * El texto que el CLI está pintando ahora mismo como respuesta, o null.
 *
 * El transcript sólo recibe un bloque de texto cuando termina; la pantalla lo
 * tiene mientras se escribe. Claude Code pinta cada bloque del asistente como
 * `⏺ ` y una primera línea, y las siguientes con dos espacios de sangría; una
 * línea en blanco separa párrafos. Que el turno sigue abierto lo dice la barra
 * de estado de abajo (`esc to interrupt`) y, cuando cabe, una línea con spinner
 * (`✻ Brewing…`) sobre la caja de entrada.
 *
 * Medido contra Claude Code 2.1.263 en un pane de 104x27:
 *
 *  - La TUI usa la pantalla alterna: `capture-pane` devuelve la ventana
 *    visible y nada de historial. Un bloque más alto que la ventana pierde su
 *    `⏺` por arriba y el spinner por abajo; queda su cola, con sangría de dos
 *    espacios, hasta la caja de entrada. Se devuelve esa cola con `…` delante.
 *  - Entre el spinner y la caja pueden ir líneas de aviso (`tmux detected ·
 *    scroll with PgUp/PgDn`, `● high · /effort`), sangradas tres o más
 *    espacios o alineadas a la derecha. Son pie de página, no conversación.
 *
 * Sólo cuenta el ÚLTIMO bloque, y sólo si es texto: un `⏺ Bash(ls)` o un
 * `⏺ Called orca` con su `⎿` debajo es una tool, y de eso ya habla el
 * transcript en cuanto ocurre. Sin turno abierto se devuelve null aunque haya
 * texto: ese texto ya llegó, o llegará, por el transcript.
 *
 * Si el CLI cambia los glifos, esto deja de ver texto en vivo y la
 * conversación sigue llegando bloque a bloque.
 */
export function liveText(screen: string): string | null {
  // La caja de entrada vacía es `❯` + espacio duro (U+00A0); el eco de un
  // prompt es `❯` + espacio. Para leer texto da igual: todo son espacios.
  const lines = screen.replace(/\r/g, '').replace(/\u00a0/g, ' ').split('\n');
  // La caja de entrada: el último `❯`. Debajo, la barra de estado.
  let input = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_LINE.test(lines[i]!)) { input = i; break; }
  if (input < 0) return null;
  const bar = lines.slice(input + 1).join('\n');
  // Pie de página entre la conversación y la caja: blancos, reglas, spinner, avisos.
  let i = input - 1;
  while (i >= 0 && isFooter(lines[i]!)) i--;
  if (i < 0) return null;
  const spinner = lines.slice(i + 1, input).find((l) => SPINNER.test(l));
  const open = /esc to interrupt/.test(bar) || (!!spinner && /…/.test(spinner) && !DONE.test(spinner));
  if (!open) return null;
  // La última línea de conversación tiene que ser de un bloque de texto.
  const last = lines[i]!;
  if (RESULT.test(last) || PROMPT_LINE.test(last) || SPINNER.test(last)) return null;
  if (!BLOCK.test(last) && !CONT.test(last)) return null;
  // Hacia arriba hasta el `⏺` que abre el bloque, por líneas de continuación.
  let j = i;
  while (j >= 0 && !BLOCK.test(lines[j]!)) {
    const l = lines[j]!;
    if (RESULT.test(l) || PROMPT_LINE.test(l)) return null;
    if (l.trim() && !CONT.test(l)) return null;   // otra cosa encima: no es un bloque limpio
    j--;
  }
  const parts: string[] = [];
  let tail = false;
  if (j < 0) {
    // El `⏺` quedó fuera de la ventana: lo visible es la cola del bloque.
    tail = true;
    j = 0;
    while (j <= i && !lines[j]!.trim()) j++;
    if (j > i) return null;
    parts.push(lines[j]!.slice(2).trimEnd());
  } else {
    const first = lines[j]!.replace(BLOCK, '');
    if (TOOL_HEAD.test(first)) return null;
    parts.push(first.trimEnd());
  }
  for (let k = j + 1; k <= i; k++) {
    const l = lines[k]!;
    parts.push(l.trim() ? l.slice(2).trimEnd() : '');
  }
  // Las líneas de un párrafo se unen con espacio; un blanco es un salto de párrafo.
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/([^\n])\n(?!\n)/g, '$1 ').trim();
  if (!text) return null;
  return tail ? `…${text}` : text;
}

function isFooter(l: string): boolean {
  if (!l.trim() || RULE.test(l) || SPINNER.test(l)) return true;
  // Avisos y ayudas van sangrados tres o más espacios o alineados a la
  // derecha; una línea de texto va a dos. Un `⎿` es conversación (una tool).
  return /^ {3,}\S/.test(l) && !RESULT.test(l);
}

const PROMPT_LINE = /^❯( |$)/;
const RULE = /^─{8,}/;
const BLOCK = /^⏺ /;
/** Una línea de continuación de un bloque: dos espacios y texto. */
const CONT = /^ {2}\S/;
const RESULT = /^\s*⎿/;
/** `✻ Brewing… (esc to interrupt)`, `· Thinking…`, `✢ Transmuting…`, `✽ Misting… (3s · ↓ 68 tokens)`. */
const SPINNER = /^[✻✳✢·✽✶*⠂⠄⠆⠇⠋⠙⠸⠰⠠⠐⠈] \S/u;
const DONE = /\bdone\b|(?:Brewed|Worked|Cooked|Crunched|Churned|Misted|Processed) for/;
/** `Bash(ls -la)`, `Read(src/x.ts)`, `Called orca`, `Update(…)`. */
const TOOL_HEAD = /^(?:Called \S|[A-Z][A-Za-z_]*\()/;
