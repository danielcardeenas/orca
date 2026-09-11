/**
 * Qué tokens cuentan contra un techo.
 *
 * Una sola regla para todo lo que compara consumo con un límite: el techo del
 * revisor de AUTOMEJORA, los presupuestos de agente, escuadrón y misión
 * (`set_budget`, los avisos `[BUDGET …]`), el árbol de linaje que ve CAPCOM y
 * lo que enseña la consola. Antes eran cinco copias de la misma suma; ahora es
 * esta función, y cambiar el criterio es cambiarlo aquí.
 *
 * ── La regla ────────────────────────────────────────────────────────
 *
 * Entrada + salida + escritura de caché. La LECTURA de caché no cuenta.
 *
 * Un CLI con un prompt de sistema grande relee todo su prefijo cacheado en
 * cada llamada. Eso suma cientos de miles de «tokens» que cuestan una fracción
 * (los proveedores cobran la lectura a la décima parte) y que no son trabajo
 * nuevo: medido en la revisión `rev_mtw8cgp3dupemnnh` (AJ, 2026-09-11), a los
 * 46 s llevaba 227.946 leídos de caché contra 12 de entrada y 2.657 de salida.
 * Contados, el techo de 400k paraba a cualquier revisor antes de que pudiera
 * archivar nada. Descontados, esa misma corrida llevaba 114.008.
 *
 * - Razonamiento/thinking: ya viene dentro de la salida en los dos CLI;
 *   sumarlo sería contarlo dos veces.
 * - Escritura de caché: SÍ cuenta. Es contexto nuevo que el modelo procesa, y
 *   en Claude es casi toda la entrada (`input_tokens` sale en 12 porque el
 *   resto entra por `cache_creation_input_tokens`). Sin ella el techo de un
 *   agente de Claude no mediría casi nada.
 * - Dinero: no. El coste no es fiable en todos los runtimes (Codex escribe $0).
 *
 * ── Un collector anterior ───────────────────────────────────────────
 *
 * `cacheWriteTokens` lo pone el adaptador. Un collector que todavía no lo
 * manda no sabe separar la escritura de la entrada, y contar sólo entrada +
 * salida dejaría el techo de un agente de Claude en un par de miles: un freno
 * que nunca frena. Para ése se mantiene la suma vieja, con la lectura dentro,
 * hasta que el collector se reinicie con el código nuevo. Frenar de más es
 * recuperable; no frenar, no.
 */

import type { AgentMetrics } from './types.ts';

type TokenMetrics = Pick<AgentMetrics, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;

/** Los tokens que se comparan con un techo. Ver arriba. */
export function ceilingTokens(m: Partial<TokenMetrics> | null | undefined): number {
  if (!m) return 0;
  const base = (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
  if (typeof m.cacheWriteTokens === 'number') return base + m.cacheWriteTokens;
  return base + (m.cacheReadTokens ?? 0);
}
