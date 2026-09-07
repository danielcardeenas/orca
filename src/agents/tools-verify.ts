/**
 * Pieza B del squad autonomy: herramientas MCP de `verify`.
 *
 * Tres verbos para no fiarse del reporte de un agente:
 *
 *   verify_agent   el resumen: qué archivos tocó, `git diff --stat` de su
 *                  árbol, y la última suite de tests que corrió con su cola.
 *   agent_diff     el patch de verdad, acotado en bytes y filtrable por
 *                  archivo o a lo que el agente tocó.
 *   screenshot     una foto de la consola ORCA, opcionalmente con la cámara
 *                  sobre un agente, un escuadrón o un proyecto.
 *
 * Todo lo que necesitan del hub llega por `ctx.autonomy.verify`; la cámara,
 * por `ctx.show`, que es el mismo camino que la herramienta `show`.
 */

import type { CeoContext, ToolOutcome, ToolSpec } from './tools.ts';
import type { Agent } from '../shared/types.ts';
import { CAMERA_PENDING_MS, findAgentRef, type CameraDirective, type CameraWhat } from '../shared/camera.ts';
import { squadsOf } from '../shared/squads.ts';
import { newId } from '../shared/protocol.ts';

export const TOOLS: ToolSpec[] = [
  {
    name: 'verify_agent',
    description:
      'Check an agent\'s work without trusting its report: the files it actually wrote (from its transcript), `git diff --stat` of its working tree or worktree, untracked file count, and the last test suite it ran — command, whether it passed, and the tail of the output. Call this before accepting a handoff or a "done". Use agent_diff for the patch itself.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent id, or its callsign like "K9".' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'agent_diff',
    description:
      'The patch of an agent\'s working tree (its worktree, if it runs in one): `git diff` against HEAD plus the list of untracked files, size-capped. Narrow it with `files` (paths relative to the repo root) or `only_touched` (only what the agent\'s own Edit/Write calls wrote). A truncated patch says so on its last line; raise `max_bytes` or narrow the files to see the rest. Read-only: nothing is run outside known project roots.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent id, or its callsign like "K9".' },
        files: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only these paths, relative to the repo root. Null for the whole tree.' },
        max_bytes: { type: ['integer', 'null'], description: 'Cap on the patch size. Default 65536, min 1024, max 1048576.' },
        only_touched: { type: 'boolean', description: 'Only files the agent itself wrote, according to its transcript. Default false.' },
      },
      required: ['agent_id', 'files', 'max_bytes', 'only_touched'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the ORCA console and return the PNG path on the hub machine. Optionally point the camera first, like `show`: `what` is agent, agents, squad, project or fleet and `refs` names it (ids or callsigns, a squad name, a project id or code). Needs Playwright with Chromium on the hub. Use it to see what the operator sees — a stuck window, a squad\'s block, the field — not as a substitute for inspect_agent.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: ['string', 'null'], description: 'agent | agents | squad | project | fleet. Null takes the picture as the console is.' },
        refs: { type: ['array', 'null'], items: { type: 'string' }, description: 'What to look at, per `what`. Null or empty for fleet.' },
        open: { type: 'boolean', description: 'Also open the thing\'s window before shooting. Default false.' },
        wait_ms: { type: ['integer', 'null'], description: 'Settle time after moving the camera, in ms. Default 1800, max 15000.' },
      },
      required: ['what', 'refs', 'open', 'wait_ms'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export async function run(ctx: CeoContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome | null> {
  switch (name) {
    case 'verify_agent': return await verifyAgent(ctx, input);
    case 'agent_diff': return await agentDiff(ctx, input);
    case 'screenshot': return await screenshot(ctx, input);
    default: return null;
  }
}

/* ── verify_agent ─────────────────────────────────────────────────── */

function need(ctx: CeoContext): NonNullable<CeoContext['autonomy']>['verify'] {
  const v = ctx.autonomy?.verify;
  if (!v) throw new Error('verify is not mounted on this hub');
  return v;
}

function findAgent(ctx: CeoContext, ref: string): Agent | undefined {
  return ctx.agent(ref) ?? findAgentRef(ctx.agents(), ref);
}

async function verifyAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = String(input.agent_id ?? '').trim();
  const a = findAgent(ctx, ref);
  if (!a) return { result: `no agent matching "${ref}"`, summary: `verify_agent failed: no agent ${ref}`, isError: true };
  const s = await need(ctx).summary(a.id);
  const t = s.lastTestRun;
  const tests = t ? (t.ok === null ? 'running' : t.ok ? 'passed' : 'FAILED') : 'none seen';
  return {
    result: JSON.stringify({
      agent: { id: a.id, callsign: a.callsign, state: a.state },
      branch: s.branch, tree: s.top,
      touched: s.touched, touched_count: s.touchedCount,
      stat: s.stat, untracked: s.untracked,
      last_test_run: t ? {
        command: t.command, ok: t.ok, tail: t.tail,
        at: new Date(t.at).toISOString(),
        finished_at: t.finishedAt ? new Date(t.finishedAt).toISOString() : null,
        exit_code: t.exitCode,
      } : null,
      errors: s.errors,
    }, null, 1),
    summary: `verified ${a.callsign}: ${s.touchedCount} file(s) touched, tests ${tests}${s.errors.length ? `, ${s.errors.length} source(s) unavailable` : ''}`,
    ...(s.errors.length && !s.stat && !s.touchedCount ? { isError: true } : {}),
  };
}

/* ── agent_diff ───────────────────────────────────────────────────── */

async function agentDiff(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = String(input.agent_id ?? '').trim();
  const a = findAgent(ctx, ref);
  if (!a) return { result: `no agent matching "${ref}"`, summary: `agent_diff failed: no agent ${ref}`, isError: true };
  const files = Array.isArray(input.files)
    ? input.files.map((f) => String(f ?? '').trim()).filter(Boolean) : null;
  const maxBytes = typeof input.max_bytes === 'number' && Number.isFinite(input.max_bytes) ? input.max_bytes : null;
  const d = await need(ctx).diff(a.id, {
    files: files && files.length ? files : null,
    maxBytes,
    patch: true,
    onlyTouched: input.only_touched === true,
  });
  const changed = (d.stat.match(/\n/g)?.length ?? 0);
  return {
    result: JSON.stringify({
      agent: { id: a.id, callsign: a.callsign },
      tree: d.top, branch: d.branch, cwd: d.cwd,
      files: d.files, ignored: d.ignored, touched: d.touched,
      stat: d.stat || '(clean)', untracked: d.untracked,
      truncated: d.truncated, bytes: d.bytes, total_bytes: d.totalBytes,
      patch: d.patch ?? '',
      ...(d.note ? { note: d.note } : {}),
    }, null, 1),
    summary: `diff of ${a.callsign}: ${d.bytes} bytes${d.truncated ? ` of ${d.totalBytes} (truncated)` : ''}, ${changed} stat line(s), ${d.untracked.length} untracked`,
  };
}

/* ── screenshot ───────────────────────────────────────────────────── */

/** La directiva que `show` mandaría, resuelta aquí para no importar tools.ts (ciclo). */
function directiveFor(ctx: CeoContext, what: CameraWhat, refs: string[], open: boolean): { d: CameraDirective; shown: string } | { error: string } {
  const base = { id: newId('cam'), at: Date.now(), open, note: 'screenshot', by: 'capcom' as const, until: Date.now() + CAMERA_PENDING_MS };
  switch (what) {
    case 'agent':
    case 'agents': {
      const found: Agent[] = [];
      const missing: string[] = [];
      for (const r of refs) {
        const a = findAgent(ctx, r);
        if (a && !found.some((f) => f.id === a.id)) found.push(a); else if (!a) missing.push(r);
      }
      if (!found.length) return { error: refs.length ? `no agent matching ${missing.map((m) => `"${m}"`).join(', ')}` : 'name at least one agent' };
      return {
        d: { ...base, what: found.length === 1 ? 'agent' : 'agents', refs: found.map((a) => a.id), projectId: null },
        shown: found.map((a) => a.callsign).join(', '),
      };
    }
    case 'squad': {
      const name = (refs[0] ?? '').trim().toLowerCase();
      if (!name) return { error: 'name the squad, e.g. "audit-01"' };
      const sq = squadsOf(ctx.agents()).find((s) => s.name.toLowerCase() === name);
      if (!sq) return { error: `no squad "${name}"` };
      const first = sq.memberIds.map((id) => ctx.agent(id)).find(Boolean);
      return { d: { ...base, what: 'squad', refs: [sq.name], projectId: first?.projectId ?? null }, shown: `squad ${sq.name}` };
    }
    case 'project': {
      const ref = (refs[0] ?? '').trim();
      const p = ctx.project(ref) ?? ctx.projects().find((x) => x.code.toUpperCase() === ref.toUpperCase());
      if (!p) return { error: ref ? `no project "${ref}"` : 'name the project: its id or code' };
      return { d: { ...base, what: 'project', refs: [p.id], projectId: p.id }, shown: `project ${p.code}` };
    }
    case 'fleet':
      return { d: { ...base, what: 'fleet', refs: [], projectId: null }, shown: 'the whole fleet' };
    default:
      return { error: `what must be one of agent, agents, squad, project, fleet — not "${String(what)}"` };
  }
}

async function screenshot(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const v = need(ctx);
  const what = typeof input.what === 'string' && input.what.trim() ? input.what.trim() as CameraWhat : null;
  const refs = (Array.isArray(input.refs) ? input.refs : []).map((r) => String(r ?? '').trim()).filter(Boolean);
  const open = input.open === true;
  const waitMs = typeof input.wait_ms === 'number' && Number.isFinite(input.wait_ms) ? input.wait_ms : undefined;

  let focus: { d: CameraDirective; shown: string } | null = null;
  if (what) {
    if (!ctx.show) return { result: 'this hub has no console to point at', summary: 'screenshot refused: no camera', isError: true };
    const r = directiveFor(ctx, what, refs, open);
    if ('error' in r) return { result: r.error, summary: `screenshot refused: ${r.error}`, isError: true };
    focus = r;
  }

  let consoles = 0;
  const shot = await v.screenshot({
    ...(waitMs !== undefined ? { settleMs: waitMs } : {}),
    onReady: () => { if (focus && ctx.show) consoles = ctx.show(focus.d); },
  });
  return {
    result: JSON.stringify({
      path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height,
      console: shot.url, agents_on_field: shot.agents,
      focused: focus ? focus.shown : null, consoles_moved: focus ? consoles : null,
    }, null, 1),
    summary: `screenshot ${focus ? `of ${focus.shown} ` : ''}saved to ${shot.path}`,
  };
}
