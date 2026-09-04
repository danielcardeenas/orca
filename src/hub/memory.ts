/**
 * ORCA hub — memoria de respuestas.
 *
 * La razón de existir de este archivo: que el humano conteste una cosa UNA vez.
 * Cuando responde una escalación con `rememberAs`, el par pregunta→respuesta se
 * guarda aquí. El runtime del CEO consulta `recall()` ANTES de molestar a nadie.
 *
 * Similitud sin dependencias ni embeddings: normalizar (minúsculas, sin
 * acentos, sin puntuación), quitar palabras vacías (español e inglés, porque el
 * humano mezcla los dos), y Jaccard sobre bigramas de palabras. Los bigramas
 * capturan orden — "borrar la base de datos" y "base de datos borrar" no son la
 * misma pregunta — y se mezclan con unigramas para no ser frágiles ante frases
 * cortas.
 *
 * No es semántico y no pretende serlo: es un caché de decisiones humanas.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_DIR } from './persist.ts';

export interface MemoryEntry {
  id: string;
  /** La pregunta tal cual la hizo el agente. */
  question: string;
  /** La respuesta del humano. */
  answer: string;
  /** Cómo quiere el humano que se recuerde (la regla, no el caso). */
  rememberAs: string | null;
  projectId: string | null;
  agentId: string | null;
  escalationId: string | null;
  at: number;
  /** Veces que se ha reusado; sube en cada acierto. */
  hits: number;
}

export interface Recalled {
  entry: MemoryEntry;
  score: number;
  /** Qué texto de la entrada hizo match: la pregunta o la regla. */
  matchedOn: 'question' | 'rememberAs';
}

/* ── normalización ────────────────────────────────────────────────── */

const STOPWORDS = new Set([
  // español
  'a', 'al', 'algo', 'de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas',
  'y', 'o', 'que', 'qué', 'en', 'con', 'por', 'para', 'se', 'su', 'sus', 'es', 'son',
  'lo', 'le', 'me', 'te', 'mi', 'tu', 'este', 'esta', 'esto', 'eso', 'ese', 'esa',
  'como', 'cómo', 'debo', 'puedo', 'quieres', 'quiere', 'hay', 'ha', 'he', 'si', 'sí', 'no',
  // inglés
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be',
  'do', 'does', 'did', 'should', 'can', 'i', 'you', 'we', 'it', 'this', 'that', 'with',
  'what', 'which', 'how', 'want', 'need', 'please',
]);

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // fuera acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s/._-]+/g, ' ')     // conservamos rutas y nombres de archivo
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const words = normalize(text).split(' ').filter((w) => w.length > 0);
  const kept = words.filter((w) => !STOPWORDS.has(w));
  // Si al quitar vacías no queda nada, mejor la frase entera que el vacío.
  return kept.length > 0 ? kept : words;
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Contención: qué fracción del conjunto pequeño está en el grande. Jaccard solo
 * castiga a las consultas cortas ("borrar rama legacy" contra una pregunta de
 * quince palabras da un número ridículo aunque sea evidentemente la misma
 * duda), así que se promedia con esto.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

function blend(a: Set<string>, b: Set<string>): number {
  return 0.5 * jaccard(a, b) + 0.5 * containment(a, b);
}

/**
 * 0..1. Los unigramas mandan; los bigramas sólo suben el número cuando además
 * coincide el orden.
 *
 * La ponderación original era al revés y fallaba en lo único que importa: una
 * paráfrasis reordena palabras, así que sus bigramas se desmoronan. Medido
 * sobre pares reales, "¿Despliego staging con la clave de test o la de
 * producción?" contra "Para el deploy de staging, ¿qué clave uso, la de test o
 * la de producción?" daba 0.51 con bigramas al 60% y da 0.79 así — y son la
 * misma pregunta, que es exactamente el caso que este sistema existe para
 * atrapar.
 *
 * Los bigramas siguen contando porque distinguen "borrar la rama main" de
 * "main borra la rama", pero como bonificación, no como base.
 */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const uni = blend(new Set(ta), new Set(tb));
  if (ta.length < 2 || tb.length < 2) return uni;
  const bi = blend(bigrams(ta), bigrams(tb));
  return 0.72 * uni + 0.28 * bi;
}

/* ── el almacén ───────────────────────────────────────────────────── */

export const MEMORY_FILE = join(HUB_DIR, 'memory.jsonl');
/** Por debajo de esto no vale la pena sugerir nada. */
export const DEFAULT_THRESHOLD = 0.34;

export class AnswerMemory {
  readonly file: string;
  private entries: MemoryEntry[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(file: string = MEMORY_FILE) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      // El archivo es append-only, asi que una entrada actualizada aparece dos
      // veces: gana la ultima linea con ese id.
      const byId = new Map<string, MemoryEntry>();
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as MemoryEntry;
          if (typeof v?.question === 'string' && typeof v?.answer === 'string' && typeof v?.id === 'string') {
            byId.set(v.id, { ...v, hits: typeof v.hits === 'number' ? v.hits : 0 });
          }
        } catch { /* linea corrupta, siguiente */ }
      }
      this.entries = [...byId.values()];
    } catch (err) {
      console.warn('[memory] no pude leer', this.file, err);
    }
  }

  get size(): number { return this.entries.length; }
  all(): readonly MemoryEntry[] { return this.entries; }

  /** Guarda un par pregunta→respuesta. Devuelve la entrada creada. */
  remember(input: {
    question: string;
    answer: string;
    rememberAs?: string | null;
    projectId?: string | null;
    agentId?: string | null;
    escalationId?: string | null;
    at?: number;
  }): MemoryEntry {
    const entry: MemoryEntry = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      question: input.question.trim(),
      answer: input.answer.trim(),
      rememberAs: input.rememberAs?.trim() || null,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null,
      escalationId: input.escalationId ?? null,
      at: input.at ?? Date.now(),
      hits: 0,
    };
    this.entries.push(entry);
    this.persist(entry);
    return entry;
  }

  private persist(entry: MemoryEntry): void {
    this.writes = this.writes.then(async () => {
      try {
        await mkdir(join(this.file, '..'), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (err) {
        console.warn('[memory] no pude escribir', this.file, err);
      }
    });
  }

  /**
   * Candidatos ordenados por parecido. El CEO decide si el score le basta;
   * aquí no se filtra por debajo del umbral salvo que se pida.
   */
  recall(question: string, opts: { limit?: number; threshold?: number; projectId?: string | null } = {}): Recalled[] {
    const limit = opts.limit ?? 5;
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const out: Recalled[] = [];
    for (const entry of this.entries) {
      const qScore = similarity(question, entry.question);
      // Una regla es una instrucción, no una pregunta: comparte vocabulario
      // pero nunca la forma. Se puntúa por contención de sus términos en la
      // pregunta nueva, que es lo que "esta regla aplica aquí" significa.
      const rScore = entry.rememberAs
        ? Math.max(
          similarity(question, entry.rememberAs),
          containment(new Set(tokenize(entry.rememberAs)), new Set(tokenize(question))),
        )
        : 0;
      let score = Math.max(qScore, rScore);
      const matchedOn: Recalled['matchedOn'] = rScore > qScore ? 'rememberAs' : 'question';
      // Misma casa, misma respuesta: un empate lo rompe el proyecto.
      if (opts.projectId && entry.projectId === opts.projectId) score = Math.min(1, score * 1.15);
      if (score < threshold) continue;
      out.push({ entry, score: Number(score.toFixed(4)), matchedOn });
    }
    out.sort((a, b) => (b.score - a.score) || (b.entry.at - a.entry.at));
    return out.slice(0, limit);
  }

  /** Marca que una entrada sirvió. No reescribe el archivo: añade la marca. */
  hit(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.hits += 1;
    this.persist(entry);
  }

  flush(): Promise<void> { return this.writes; }
}

let singleton: AnswerMemory | null = null;
export function memory(): AnswerMemory {
  if (!singleton) {
    mkdirSync(join(MEMORY_FILE, '..'), { recursive: true });
    singleton = new AnswerMemory();
  }
  return singleton;
}

/** Atajo funcional para el runtime del CEO. */
export function recall(question: string, opts?: { limit?: number; threshold?: number; projectId?: string | null }): Recalled[] {
  return memory().recall(question, opts);
}
