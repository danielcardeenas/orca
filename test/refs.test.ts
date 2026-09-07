/**
 * Callsigns in CAPCOM's prose become places on the field.
 *
 * The failure this guards is quiet: a linkifier that reaches inside a tag
 * turns `<td>` into a link when an agent is called TD, and the table stops
 * being a table. So the tests are about what is *not* touched as much as
 * what is.
 */

import type { Agent } from '../src/shared/types.ts';
import { linkRefs, refIndex } from '../src/ui/windows/refs.ts';
import { findAgentRef } from '../src/shared/camera.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

function agent(o: Partial<Agent> & { id: string; callsign: string }): Agent {
  return {
    machineId: 'm1', projectId: 'p1', title: '', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: '', squad: null, lead: false, model: null,
    tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 1_000, updatedAt: 1_000, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    background: true, shortId: null,
    ...o,
  } as Agent;
}

const fleet = [
  agent({ id: 'agent_k9', callsign: 'K9', shortId: 'k9s' }),
  agent({ id: 'agent_td', callsign: 'TD', squad: 'audit-01', lead: true }),
  agent({ id: 'agent_q7', callsign: 'Q7', squad: 'audit-01' }),
  agent({ id: 'cap', callsign: 'CC', role: 'capcom' }),
];

export default {
  suite: 'refs',
  tests: [
    test('the index names agents by callsign, id and short id, and squads by name — never CAPCOM', () => {
      const r = refIndex(fleet);
      return ok('labels resolve',
        r.agents.get('K9') === 'agent_k9' && r.agents.get('agent_k9') === 'agent_k9' && r.agents.get('k9s') === 'agent_k9'
          && !r.agents.has('CC') && r.squads.get('audit-01') === 'p1');
    }),

    test('a callsign in prose is a link; the same letters inside a tag are not', () => {
      const html = linkRefs('<table class="talk__table"><tr><td>TD is on it</td></tr></table>', refIndex(fleet));
      return ok('td tag survives, TD text links',
        html.startsWith('<table class="talk__table"><tr><td>') && html.includes('<a class="ref ref--agent" data-go="agent_td"') && html.split('<a ').length === 2,
        html);
    }),

    test('code blocks and existing links are left alone', () => {
      const html = linkRefs('<pre class="talk__pre"><code>K9</code></pre> <a href="x">K9</a> K9', refIndex(fleet));
      return eq('only the bare K9 links', html.split('data-go=').length - 1, 1, html);
    }),

    test('an id is not eaten by the callsign at its start, and a squad keeps its prefix', () => {
      const html = linkRefs('agent_k9 and squad:audit-01 and audit-010', refIndex(fleet));
      return ok('long label wins; squad: is inside the link; audit-010 is nothing',
        html.includes('data-go="agent_k9"') && html.includes('>agent_k9</a>') && html.includes('data-go-squad="audit-01" data-go-project="p1"')
          && html.includes('>squad:audit-01</a>') && !html.includes('audit-010</a>'),
        html);
    }),

    test('matching is exact: k9 in lower case is a word, not an agent', () => {
      const html = linkRefs('k9 is fine, K9 is a link', refIndex(fleet));
      return eq('one link', html.split('<a ').length - 1, 1, html);
    }),

    test('a dead agent yields its callsign to the live one that reused it', () => {
      const twice = [agent({ id: 'old', callsign: 'K9', state: 'dead', startedAt: 5 }), agent({ id: 'new', callsign: 'K9', startedAt: 9 })];
      return ok('live wins in both the index and the resolver',
        refIndex(twice).agents.get('K9') === 'new' && findAgentRef(twice, 'k9')?.id === 'new');
    }),

    test('findAgentRef takes an id, a short id or a callsign, in that order of certainty', () => {
      return ok('all three forms',
        findAgentRef(fleet, 'agent_td')?.id === 'agent_td' && findAgentRef(fleet, 'k9s')?.id === 'agent_k9'
          && findAgentRef(fleet, 'q7')?.id === 'agent_q7' && findAgentRef(fleet, '') === undefined && findAgentRef(fleet, 'ZZ') === undefined);
    }),
  ],
} satisfies TestModule;
