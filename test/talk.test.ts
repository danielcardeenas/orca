/**
 * The CAPCOM conversation, end to end and without a browser.
 *
 *   transcript lines → SessionDeriver.drainTalk()   (collector)
 *   talk frame       → World.pushTalk()             (hub: sanitise, dedupe, bound)
 *   TalkItem[]       → foldTalk()                   (console: blocks → exchanges)
 *
 * Each stage is pure enough to test with data, and each has one way to be
 * wrong silently: a dropped block, a duplicated one, a result glued to the
 * wrong call. Those are the cases here.
 */

import { SessionDeriver } from '../src/collector/derive.ts';
import { liveText } from '../src/collector/screen.ts';
import { mergeTalk } from '../src/shared/talk.ts';
import type { LineBatch, TranscriptRef } from '../src/collector/watch.ts';
import { World, sanitizeTalkItem } from '../src/hub/world.ts';
import { classifyPrompt, echoLanded, foldTalk, pendingEchoes, timeOrdered, toolLabel } from '../src/ui/windows/talk.ts';
import { mdLite } from '../src/ui/windows/kinds/ceo.ts';
import type { Agent, TalkItem } from '../src/shared/types.ts';
import { MAX_TALK, MAX_TALK_RESULT } from '../src/shared/types.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

/* ── scaffolding ─────────────────────────────────────────────────── */

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function ref(): TranscriptRef {
  return {
    path: '/tmp/x.jsonl', slug: '-tmp-proj', sessionId: SID, agentId: null,
    metaPath: null, workflowId: null, key: SID,
  };
}
function batch(lines: Record<string, unknown>[]): LineBatch {
  return { ref: ref(), lines, bootstrap: false, mtimeMs: Date.now(), at: Date.now() };
}
let uuidN = 0;
const uuid = () => `u${++uuidN}`;

function assistant(at: number, content: Record<string, unknown>[], stop = 'tool_use', msgId = 'msg_1') {
  return {
    type: 'assistant', uuid: uuid(), timestamp: new Date(at).toISOString(), sessionId: SID,
    message: { id: msgId, model: 'claude-opus-5', stop_reason: stop, content, usage: { output_tokens: 10 } },
  };
}
function user(at: number, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid: uuid(), timestamp: new Date(at).toISOString(), sessionId: SID, message: { content }, ...extra };
}

function derive(lines: Record<string, unknown>[]): TalkItem[] {
  const d = new SessionDeriver(ref(), 'm1', 'p1');
  d.ingest(batch(lines));
  return d.drainTalk();
}

function agent(id: string, machineId = 'm1'): Agent {
  return {
    id, machineId, projectId: 'p1', title: 't', callsign: 'CP', runtime: 'claude', role: 'capcom',
    state: 'idle', block: null, parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 1, updatedAt: 1, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    background: false, shortId: null,
  };
}

function item(o: Partial<TalkItem> & { id: string; kind: TalkItem['kind'] }): TalkItem {
  return { agentId: 'cap', at: 1000, text: '', ...o };
}

const T0 = 1_700_000_000_000;

export default {
  suite: 'talk',
  tests: [

    /* ── collector ─────────────────────────────────────────────── */

    test('a prompt, a thought, a tool, its result and the reply come out in order', () => {
      const items = derive([
        user(T0, 'Que proyectos tengo disponibles?'),
        assistant(T0 + 10, [{ type: 'thinking', thinking: 'let me look' }]),
        assistant(T0 + 20, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls ~/projects' } }]),
        user(T0 + 30, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'orca\naxolots' }]),
        assistant(T0 + 40, [{ type: 'text', text: 'Tienes **dos** proyectos: orca y axolots.' }], 'end_turn'),
      ]);
      return eq('kinds', items.map((i) => `${i.kind}:${i.tool ?? ''}`),
        ['prompt:', 'thinking:', 'tool:Bash', 'result:Bash', 'say:']);
    }),

    test('the prompt and the reply are kept in full, not as one trimmed line', () => {
      const long = 'a'.repeat(1_000) + '\nsecond line';
      const items = derive([user(T0, long), assistant(T0 + 1, [{ type: 'text', text: long }], 'end_turn')]);
      return ok('full text both ways', items[0]!.text === long && items[1]!.text === long);
    }),

    test('a tool result is a glance: bounded, with the error flag', () => {
      const items = derive([
        assistant(T0, [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/x' } }]),
        user(T0 + 1, [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: [{ type: 'text', text: 'x'.repeat(5_000) }] }]),
      ]);
      const r = items[1]!;
      return ok('bounded and flagged', r.kind === 'result' && r.error === true && r.text.length <= MAX_TALK_RESULT + 1 && r.toolUseId === 'toolu_9');
    }),

    test('meta lines and injected CLI text are not conversation', () => {
      const items = derive([
        user(T0, 'context the CLI added', { isMeta: true }),
        user(T0 + 1, '<system-reminder>ignore</system-reminder>'),
        user(T0 + 2, '<command-name>/clear</command-name>'),
        user(T0 + 3, 'real prompt'),
      ]);
      return eq('only the human line', items.map((i) => i.text), ['real prompt']);
    }),

    test('a redacted thinking block is still a step, with empty text', () => {
      const items = derive([assistant(T0, [{ type: 'thinking', thinking: '' }])]);
      return ok('one empty thinking', items.length === 1 && items[0]!.kind === 'thinking' && items[0]!.text === '');
    }),

    test('ids are stable per line and block, and the buffer is bounded', () => {
      const d = new SessionDeriver(ref(), 'm1', 'p1');
      const line = assistant(T0, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
      d.ingest(batch([line]));
      const first = d.drainTalk();
      const lines = Array.from({ length: MAX_TALK + 50 }, (_, i) => user(T0 + i, `p${i}`));
      d.ingest(batch(lines));
      const many = d.drainTalk();
      return ok('stable ids, bounded',
        first.map((i) => i.id).join(',') === `${line.uuid}:0,${line.uuid}:1`
        && many.length === MAX_TALK && many[many.length - 1]!.text === `p${MAX_TALK + 49}`
        && d.drainTalk().length === 0);
    }),

    test('a prompt newer than the last reply means thinking, not idle', () => {
      const d = new SessionDeriver(ref(), 'm1', 'p1');
      d.setLiveness({ alive: true, background: false, shortId: null, pid: 1, name: null, startedAt: null, cliState: 'running', pane: true });
      const now = Date.now();
      d.ingest(batch([user(now - 5000, 'hi'), assistant(now - 4000, [{ type: 'text', text: 'hello' }], 'end_turn')]));
      const idle = d.state(now);
      d.ingest(batch([user(now - 1000, 'and now?')]));
      const thinking = d.state(now);
      const stale = d.state(now + 11 * 60_000);
      return eq('states', [idle, thinking, stale], ['idle', 'thinking', 'idle']);
    }),

    test('mergeTalk puts a late replay back in time order and keeps ties in arrival order', () => {
      const cur = [item({ id: 'b:0', kind: 'say', text: 'today', at: 2000 }), item({ id: 'b:1', kind: 'say', text: 'today 2', at: 2000 })];
      const out = mergeTalk(cur, [item({ id: 'a', kind: 'prompt', text: 'yesterday', at: 1000 }), item({ id: 'b:0', kind: 'say', text: 'dup', at: 2000 })]);
      const same = mergeTalk(out, [item({ id: 'a', kind: 'prompt', text: 'dup', at: 1000 })]);
      return ok('ordered, deduped, identity when nothing new',
        out.map((i) => i.id).join(',') === 'a,b:0,b:1' && same === out);
    }),

    /* ── hub ───────────────────────────────────────────────────── */

    test('the hub appends, dedupes by id, bounds, and emits one op', () => {
      const ops: unknown[] = [];
      const w = new World({ onOps: (o) => ops.push(...o) });
      w.applyCollector({ t: 'hello', v: 1, machine: { id: 'm1', hostname: 'h', platform: 'darwin', version: '1', online: true, lastSeen: 1, connectedAt: 1, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } }, token: 't' }, 'm1');
      w.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent('cap') }, 'm1');
      w.applyCollector({ t: 'talk', machineId: 'm1', agentId: 'cap', items: [item({ id: 'a:0', kind: 'prompt', text: 'hi' }), item({ id: 'b:0', kind: 'say', text: 'hello' })] }, 'm1');
      // A reconnecting collector re-reads the tail and sends the same again.
      w.applyCollector({ t: 'talk', machineId: 'm1', agentId: 'cap', items: [item({ id: 'b:0', kind: 'say', text: 'hello' }), item({ id: 'c:0', kind: 'say', text: 'more' })] }, 'm1');
      const list = w.state.talk?.['cap'] ?? [];
      const talkOps = ops.filter((o) => (o as { o: string }).o === 'talk') as { v: TalkItem[] }[];
      return ok('three unique, two ops',
        list.map((i) => i.id).join(',') === 'a:0,b:0,c:0'
        && talkOps.length === 2 && talkOps[1]!.v.length === 1 && talkOps[1]!.v[0]!.id === 'c:0');
    }),

    test('talk for an unknown agent is dropped; another machine\'s is refused', () => {
      const w = new World();
      w.applyCollector({ t: 'hello', v: 1, machine: { id: 'm1', hostname: 'h', platform: 'darwin', version: '1', online: true, lastSeen: 1, connectedAt: 1, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } }, token: 't' }, 'm1');
      w.applyCollector({ t: 'talk', machineId: 'm1', agentId: 'ghost', items: [item({ id: 'x', kind: 'say', text: 'boo' })] }, 'm1');
      w.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent('cap') }, 'm1');
      // `applyCollector` swallows and logs a bad frame; the proof is that nothing landed.
      w.applyCollector({ t: 'talk', machineId: 'm2', agentId: 'cap', items: [item({ id: 'y', kind: 'say', text: 'x' })] }, 'm2');
      return ok('dropped and refused', !w.state.talk?.['ghost'] && !w.state.talk?.['cap']?.length);
    }),

    test('an agent that leaves takes its conversation with it', () => {
      const w = new World();
      w.applyCollector({ t: 'hello', v: 1, machine: { id: 'm1', hostname: 'h', platform: 'darwin', version: '1', online: true, lastSeen: 1, connectedAt: 1, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } }, token: 't' }, 'm1');
      w.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent('cap') }, 'm1');
      w.applyCollector({ t: 'talk', machineId: 'm1', agentId: 'cap', items: [item({ id: 'a', kind: 'say', text: 'x' })] }, 'm1');
      w.applyCollector({ t: 'agent:gone', machineId: 'm1', id: 'cap' }, 'm1');
      return ok('gone', !w.state.talk?.['cap']);
    }),

    test('sanitising drops junk and keeps the optional fields it recognises', () => {
      const good = sanitizeTalkItem({ id: 'ok', kind: 'result', text: 'x', tool: 'Bash', toolUseId: 'toolu_1', error: true, msgId: 'm', at: 5 }, 'cap');
      const badKind = sanitizeTalkItem({ id: 'k', kind: 'poem', text: 'x' }, 'cap');
      const badId = sanitizeTalkItem({ id: '__proto__', kind: 'say', text: 'x' }, 'cap');
      return ok('shape', !!good && good.tool === 'Bash' && good.toolUseId === 'toolu_1' && good.error === true && good.msgId === 'm' && good.agentId === 'cap'
        && badKind === null && badId === null);
    }),

    /* ── console ───────────────────────────────────────────────── */

    test('blocks fold into exchanges: you, then everything CAPCOM did until it stopped', () => {
      const groups = foldTalk([
        item({ id: '1', kind: 'prompt', text: 'status?', at: 1 }),
        item({ id: '2', kind: 'thinking', text: 'hmm', at: 2 }),
        item({ id: '3', kind: 'tool', tool: 'fleet_status', toolUseId: 't1', text: '', at: 3 }),
        item({ id: '4', kind: 'result', toolUseId: 't1', text: '4 working', at: 4 }),
        item({ id: '5', kind: 'say', text: 'Four working.', at: 5 }),
        item({ id: '6', kind: 'prompt', text: 'thanks', at: 6 }),
      ]);
      const cap = groups[1]!;
      const tool = cap.parts[1]!;
      return ok('shape',
        groups.map((g) => g.role).join(',') === 'human,capcom,human'
        && cap.parts.map((p) => p.kind).join(',') === 'step,step,text'
        && tool.kind === 'step' && tool.step.result?.text === '4 working');
    }),

    test('a result whose call fell off the ring is dropped, not shown orphaned', () => {
      const groups = foldTalk([item({ id: 'r', kind: 'result', toolUseId: 'gone', text: 'late' }), item({ id: 's', kind: 'say', text: 'ok' })]);
      return ok('one capcom group with only the text', groups.length === 1 && groups[0]!.parts.length === 1 && groups[0]!.parts[0]!.kind === 'text');
    }),

    test('the hub\'s wrappers are recognised: a task prompt and a relayed question are not you', () => {
      const t = classifyPrompt('[ORCA MISSION task_abc] Fix the tests\nThis is a separate task conversation…');
      const e = classifyPrompt('[ESCALATION esc_1] K9 asks: may I delete node_modules? · options: yes | no');
      const h = classifyPrompt('what is up');
      return ok('roles', t.role === 'mission' && t.missionId === 'task_abc' && t.text.startsWith('Fix the tests')
        && e.role === 'fleet' && e.escalationId === 'esc_1' && e.text.startsWith('K9 asks')
        && h.role === 'human');
    }),

    test('a local echo is done once its prompt shows up in the transcript', () => {
      const items = [item({ id: 'p', kind: 'prompt', text: 'hello there', at: 10_000 })];
      return ok('landed / not landed',
        echoLanded(' hello there ', 9_500, items) && !echoLanded('something else', 9_500, items)
        && !echoLanded('hello there', 200_000, items));
    }),

    test('an echo the transcript overtook stops being news', () => {
      // Lo que dijiste a las 10:00 no volvió con el mismo texto; lo de las 10:05
      // sí. La cola del CLI es una fila: lo de las 10:00 ya pasó por ella.
      const echoes = [{ at: 10_000, id: 'a' }, { at: 10_005, id: 'b' }];
      const left = pendingEchoes(echoes, (e) => e.at === 10_005);
      // Al revés: lo viejo confirmado no borra lo nuevo, que sigue en cola.
      const queued = pendingEchoes(echoes, (e) => e.at === 10_000);
      return eq('pending', [left.map((e) => e.id), queued.map((e) => e.id)], [[], ['b']]);
    }),

    test('the echo sits where it was written, not at the bottom', () => {
      const rows = [
        { at: 3, html: 'reply' },
        { at: 1, html: 'you' },
        { at: 2, html: 'echo' },
      ];
      return eq('order', timeOrdered(rows), 'youechoreply');
    }),

    test('tool names read like tools, not like MCP routes', () => {
      return eq('labels', ['mcp__orca__inspect_squad', 'mcp__plugin_playwright_playwright__browser_click', 'Bash'].map(toolLabel),
        ['inspect_squad', 'playwright_playwright·browser_click', 'Bash']);
    }),

    test('the launch brief reads as ORCA, not as you', () => {
      return eq('role', classifyPrompt('You are online. Call list_fleet on the `orca` MCP server').role, 'system');
    }),

    /* ── the pane ──────────────────────────────────────────────── */

    test('liveText reads the block being typed, joined into paragraphs', () => {
      const screen = [
        '⏺ Called orca', '', '⏺ Tienes 6 proyectos disponibles:', '',
        '  Para lanzar trabajo: no uses capcom (workspace de control,', '  hereda Bash/Edit/Write denegados).', '',
        '✻ Brewing… (esc to interrupt)', '',
        '──────────────────────────────────────────────── CAPCOM ─', '❯ ', '────────────────────────────────────────────────', '  ⏵⏵ accept edits on',
      ].join('\n');
      return eq('text', liveText(screen), 'Tienes 6 proyectos disponibles:\n\nPara lanzar trabajo: no uses capcom (workspace de control, hereda Bash/Edit/Write denegados).');
    }),

    test('liveText survives footer hints and reads the tail of a block taller than the pane', () => {
      // La caja de entrada real lleva un espacio duro tras el `❯`, y puede llevar un borrador escrito.
      const bar = ['──────────', '❯\u00a0relanza holaid', '──────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 10 agents'];
      const hinted = ['⏺ Diseñar una consola empieza por decidir qué ver', '  en un golpe de vista.', '✽ Misting… (3s · ↓ 68 tokens)',
        "     tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on'", '                                    ● high · /effort', ...bar].join('\n');
      const overflow = ['  la atención, no del inventario: los agentes que esperan', '  tienen que sobresalir.', '', '  La segunda decisión es el modelo de conversación', ...bar].join('\n');
      const overflowDone = ['  la atención, no del inventario.', '──────────', '❯ ', '──────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 10 agents'].join('\n');
      return eq('texts', [liveText(hinted), liveText(overflow), liveText(overflowDone)], [
        'Diseñar una consola empieza por decidir qué ver en un golpe de vista.',
        '…la atención, no del inventario: los agentes que esperan tienen que sobresalir.\n\nLa segunda decisión es el modelo de conversación',
        null,
      ]);
    }),

    test('liveText is null when the turn is done, when the last block is a tool, or with no spinner', () => {
      const tail = ['', '─────────── CAPCOM ─', '❯ ', '───────────'];
      const done = ['⏺ Listo.', '', '✻ Brewed for 44s · done 10:25 AM', '', '※ recap: algo', '  más recap', ...tail].join('\n');
      const tool = ['⏺ Hola', '', '⏺ Bash(ls -la)', '  ⎿  a.txt', '', '✻ Brewing… (esc to interrupt)', ...tail].join('\n');
      const called = ['⏺ Called orca', '', '· Thinking…', ...tail].join('\n');
      const quiet = ['⏺ Hola', ...tail].join('\n');
      // Captura real: el prompt recién enviado hace eco bajo la respuesta anterior y el modelo aún no escribe.
      const echo = ['⏺ fiable de qué hace.', '', '✻ Churned for 17s · done 10:40 AM', '', '❯ Sin herramientas: cuéntame qué es ORCA', '', '✢ Incubating…', ...tail].join('\n');
      return eq('nulls', [liveText(done), liveText(tool), liveText(called), liveText(quiet), liveText(echo)], [null, null, null, null, null]);
    }),

    test('the hub keeps live text per agent and drops it on null', () => {
      const w = new World();
      w.applyCollector({ t: 'hello', v: 1, machine: { id: 'm1', hostname: 'h', platform: 'darwin', version: '1', online: true, lastSeen: 1, connectedAt: 1, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } }, token: 't' }, 'm1');
      w.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent('cap') }, 'm1');
      const rev = w.state.rev;
      w.applyCollector({ t: 'talk:live', machineId: 'm1', agentId: 'cap', text: 'Tienes 6 pro' }, 'm1');
      const shown = w.state.talkLive?.['cap'];
      w.applyCollector({ t: 'talk:live', machineId: 'm1', agentId: 'cap', text: null }, 'm1');
      return ok('live', shown === 'Tienes 6 pro' && w.state.talkLive?.['cap'] === undefined && w.state.rev === rev + 2);
    }),

    test('markdown links are clickable, while HTML and unsafe URLs cannot execute', () => {
      const html = mdLite('[Docs](https://example.com/docs?q=1&b=2) https://example.org\n\n[bad](javascript:alert(1)) <script>alert(1)</script>\n\n`[literal](https://example.com)`');
      return ok('safe links and literal code', html.includes('href="https://example.com/docs?q=1&amp;b=2"')
        && html.includes('rel="noopener noreferrer"') && html.includes('href="https://example.org"')
        && !html.includes('href="javascript:') && !html.includes('<script>')
        && html.includes('<code>[literal](https://example.com)</code>'));
    }),
    test('markdown preserves ordered lists, emphasis, quotes and aligned tables', () => {
      const html = mdLite('3. **Third**\n4. *Fourth*\n\n> A quote\n\nName | Count\n:--- | ---:\nA | 2');
      return ok('structured Markdown', html.includes('<ol start="3" class="talk__ul">') && html.includes('<em>Fourth</em>')
        && html.includes('<blockquote class="talk__quote">') && html.includes('style="text-align:right"')
        && html.includes('<td style="text-align:right">2</td>'));
    }),
    test('markdown highlights known languages and escapes unknown and incomplete fences', () => {
      const known = mdLite('```ts\nconst answer = "yes";\n```');
      const unknown = mdLite('```made-up\n<script>hello</script>');
      return ok('highlighted, escaped and streaming tolerant', known.includes('hljs-keyword') && known.includes('hljs-string')
        && unknown.includes('&lt;script&gt;hello&lt;/script&gt;') && !unknown.includes('<script>'));
    }),
    test('local references remain readable and remote images require an explicit click', () => {
      const html = mdLite('[app.ts](/Users/dan/project/app.ts) ![Preview](https://example.com/image.png)');
      return ok('no broken file navigation or automatic images', html.includes('class="talk__file" title="/Users/dan/project/app.ts"')
        && !html.includes('href="/Users') && !html.includes('<img') && html.includes('href="https://example.com/image.png"'));
    }),

    test('mdLite turns a pipe table into a table and skips its rule', () => {
      const html = mdLite('| Código | Gasto |\n|---|---|\n| AX | $694 |\n\nfin').replace(/\n/g, '');
      return ok('table', html.includes('<th>Código</th><th>Gasto</th>') && html.includes('<td>AX</td><td>$694</td>')
        && !html.includes('---') && html.endsWith('<p>fin</p>'));
    }),

    test('mdLite escapes first and marks up bold, code, fences and bullets', () => {
      const html = mdLite('# Fleet\n- **K9** is `working` <b>x</b>\n```\nls -la\n```\nplain');
      return ok('safe markup',
        html.includes('<h1 class="talk__h">Fleet</h1>')
        && html.includes('<li><strong>K9</strong> is <code>working</code> &lt;b&gt;x&lt;/b&gt;</li>')
        && html.includes('<pre class="talk__pre"><code class="hljs">ls -la\n</code></pre>')
        && html.trimEnd().endsWith('<p>plain</p>'));
    }),
  ],
} satisfies TestModule;
