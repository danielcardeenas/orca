/**
 * voice.ts — what CAPCOM's answer sounds like.
 *
 * The rules that keep a spoken reply short live in pure functions, and each
 * has a way to be wrong silently: a reply read while it is still arriving, a
 * typed line answered aloud, a diff read character by character. Those are
 * the cases here. The microphone and the synthesiser (`hud/voice.ts`) are
 * browser APIs and are not covered.
 */

import { SPOKEN_MAX, baseName, chooseVoice, conclusion, novelty, pickReply, readable, spokenLine, type Dictation, type VoiceLike } from '../src/ui/voice.ts';
import type { TalkGroup, TalkPart } from '../src/ui/windows/talk.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const text = (t: string, at = 10): TalkPart => ({ kind: 'text', id: `t${at}`, at, text: t });
const tool = (at = 5): TalkPart => ({ kind: 'step', step: { id: `s${at}`, at, kind: 'tool', text: 'ls', tool: 'Bash' } });
const human = (t: string, at = 1): TalkGroup => ({ id: `h${at}`, role: 'human', at, text: t, parts: [] });
const capcom = (parts: TalkPart[], at = 2): TalkGroup => ({ id: `c${at}`, role: 'capcom', at, text: '', parts });
const asked = (t: string, at = 1): Dictation[] => [{ text: t, at }];
const none = new Set<string>();

const mod: TestModule = {
  suite: 'voice',
  tests: [
    test('readable: markers, fences, urls and paths fall away', () => {
      const md = '## Estado\n\n- **K9** terminó `src/ui/main.ts:361` y [el doc](https://x.y/z).\n\n```ts\nconst a = 1;\n```\n\nVer https://example.com/a/b ahora.';
      return eq('read', readable(md), 'Estado K9 terminó main.ts y el doc. Ver ahora.');
    }),
    test('readable: a word with a slash keeps its file name, a lone word stays', () => {
      return eq('paths', readable('mira docs/VOICE.md y también hub.ts, y a/b/c.ts:12:3.'), 'mira VOICE.md y también hub.ts, y c.ts.');
    }),
    test('spokenLine: whole sentences up to the cap, never a fragment of a third', () => {
      const one = 'Primera frase corta. ';
      const two = 'Segunda frase, también corta. ';
      const three = 'x'.repeat(SPOKEN_MAX);
      return eq('two sentences', spokenLine(one + two + three), 'Primera frase corta. Segunda frase, también corta.');
    }),
    test('spokenLine: a single long sentence is cut at a word with an ellipsis', () => {
      const long = Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(' ');
      const line = spokenLine(long);
      return ok('cut', line.length <= SPOKEN_MAX && line.endsWith('…') && !line.slice(0, -1).endsWith(' ') && long.startsWith(line.slice(0, -1)), line);
    }),
    test('spokenLine: nothing to say is empty', () => {
      return eq('empty', [spokenLine(''), spokenLine('```\nonly code\n```'), spokenLine('   ')], ['', '', '']);
    }),
    test('conclusion: the text after the last tool step, not the narration before it', () => {
      const reply = capcom([text('Voy a mirar.', 3), tool(4), text('Hecho.', 5), text('Nada más.', 6)]);
      return eq('after last step', conclusion(reply), 'Hecho.\n\nNada más.');
    }),
    test('conclusion: with no steps, every paragraph', () => {
      return eq('all', conclusion(capcom([text('Uno.', 3), text('Dos.', 4)])), 'Uno.\n\nDos.');
    }),
    test('pickReply: a spoken prompt, a finished reply, read once', () => {
      const groups = [human('estado de la flota'), capcom([tool(3), text('Cuatro trabajan, uno bloqueado.', 4)])];
      const first = pickReply(groups, 'idle', asked('estado de la flota'), none);
      const said = new Set([first?.groupId ?? '']);
      const again = pickReply(groups, 'idle', asked('estado de la flota'), said);
      return eq('once', [first?.text, again], ['Cuatro trabajan, uno bloqueado.', null]);
    }),
    test('pickReply: not while CAPCOM is still working', () => {
      const groups = [human('estado'), capcom([text('Cuatro trabajan.', 4)])];
      const out = (['thinking', 'working', 'booting'] as const).map((s) => pickReply(groups, s, asked('estado'), none));
      return eq('silent while live', out, [null, null, null]);
    }),
    test('pickReply: a question CAPCOM is blocked on is read too', () => {
      const groups = [human('lanza el audit'), capcom([text('¿En qué proyecto?', 4)])];
      return eq('blocked', pickReply(groups, 'blocked', asked('lanza el audit'), none)?.text, '¿En qué proyecto?');
    }),
    test('pickReply: a typed line is not answered aloud', () => {
      const groups = [human('escrito a mano'), capcom([text('Respuesta.', 4)])];
      const other = pickReply(groups, 'idle', asked('otra cosa dicha'), none);
      const nothing = pickReply(groups, 'idle', [], none);
      return eq('typed', [other, nothing], [null, null]);
    }),
    test('pickReply: whitespace the transcript folded still matches', () => {
      const groups = [human('para  a K9\ny avisa', 100), capcom([text('Parado.', 101)], 101)];
      return eq('folded', pickReply(groups, 'idle', asked('para a K9 y avisa', 100), none)?.text, 'Parado.');
    }),
    test('pickReply: a prompt older than the dictation is somebody else\'s', () => {
      const groups = [human('estado', 1_000), capcom([text('Viejo.', 1_001)], 1_001)];
      return eq('stale', pickReply(groups, 'idle', asked('estado', 5_000_000), none), null);
    }),
    test('pickReply: the last exchange must be prompt then reply', () => {
      const onlyPrompt = pickReply([human('estado')], 'idle', asked('estado'), none);
      const fleet: TalkGroup = { id: 'f', role: 'fleet', at: 1, text: 'K9 asks', escalationId: 'e1', parts: [] };
      const relayed = pickReply([fleet, capcom([text('Sí.', 2)])], 'idle', asked('estado'), none);
      const reordered = pickReply([capcom([text('Sí.', 2)]), human('estado', 3)], 'idle', asked('estado', 3), none);
      return eq('shape', [onlyPrompt, relayed, reordered], [null, null, null]);
    }),
    test('pickReply: a mission prompt that carries the spoken line counts', () => {
      const mission: TalkGroup = { id: 'm', role: 'mission', at: 1, text: 'Context…\n\nrevisa el plan\n', missionId: 'ms1', parts: [] };
      return eq('mission', pickReply([mission, capcom([text('Revisado.', 2)])], 'idle', asked('revisa el plan'), none)?.text, 'Revisado.');
    }),
    test('pickReply: a reply with only tool steps has nothing to say', () => {
      return eq('mute', pickReply([human('estado'), capcom([tool(3)])], 'idle', asked('estado'), none), null);
    }),
    // Lo que Chrome lista en un Mac en es-MX, en su orden: las de broma primero.
    test('chooseVoice: like `say` — the real voice for the exact language, never a novelty', () => {
      const mac: VoiceLike[] = [
        { name: 'Eddy (Español (México))', lang: 'es-MX', localService: true },
        { name: 'Flo (Español (México))', lang: 'es-MX', localService: true },
        { name: 'Grandma (Español (México))', lang: 'es-MX', localService: true },
        { name: 'Google español de Estados Unidos', lang: 'es-US', localService: false },
        { name: 'Mónica', lang: 'es-ES', localService: true },
        { name: 'Paulina', lang: 'es-MX', localService: true },
        { name: 'Samantha', lang: 'en-US', localService: true, default: true },
      ];
      return eq('voices', [
        chooseVoice(mac, 'es-MX')?.name,
        chooseVoice(mac, 'es_MX')?.name,
        chooseVoice(mac, 'es-AR')?.name,          // no exact: the family, still a real one
        chooseVoice(mac, 'en-US')?.name,
        chooseVoice(mac, 'fr-FR'),
        chooseVoice(mac, 'es-MX', 'Mónica')?.name, // the operator's pick wins
        chooseVoice(mac, 'es-MX', 'Nadie')?.name,   // a pick that left the machine falls back
        novelty({ name: 'Bubbles', lang: 'en-US' }), novelty({ name: 'Paulina', lang: 'es-MX' }),
      ], ['Paulina', 'Paulina', 'Mónica', 'Samantha', null, 'Mónica', 'Paulina', true, false]);
    }),
    // La lista real de Chrome en este Mac tras descargar las mejoradas: la
    // toma buena lleva la palabra del sistema entre paréntesis, en su idioma.
    test('chooseVoice: a bare name takes its best take, and AUTO prefers the enhanced sibling', () => {
      const mac: VoiceLike[] = [
        { name: 'Paulina (mejorada)', lang: 'es-MX', localService: true, default: true },
        { name: 'Eddy (español (España))', lang: 'es-ES', localService: true },
        { name: 'Mónica', lang: 'es-ES', localService: true },
        { name: 'Mónica (mejorada)', lang: 'es-ES', localService: true },
        { name: 'Paulina', lang: 'es-MX', localService: true },
      ];
      const noDefault = mac.map((v) => ({ ...v, default: false }));
      return eq('takes', [
        chooseVoice(mac, 'es-MX', 'Mónica')?.name,            // the repo default, on this Mac
        chooseVoice(mac, 'es-MX', 'Mónica (mejorada)')?.name, // the exact name still wins
        chooseVoice(mac, 'es-MX', 'Eddy')?.name,              // a bare novelty name is the operator's call
        chooseVoice(mac, 'es-ES')?.name,                      // AUTO in Spain
        chooseVoice(noDefault, 'es-MX')?.name,                // AUTO without the system flag
        chooseVoice(mac.filter((v) => v.name !== 'Mónica'), 'es-MX', 'Mónica')?.name, // only the take is there
        chooseVoice(mac.filter((v) => !v.name.startsWith('Mónica')), 'es-MX', 'Mónica')?.name, // no Mónica: AUTO
        baseName('Mónica (mejorada)'), baseName('Eddy (español (España))'), baseName('Paulina'),
      ], ['Mónica (mejorada)', 'Mónica (mejorada)', 'Eddy (español (España))', 'Mónica (mejorada)', 'Paulina (mejorada)', 'Mónica (mejorada)', 'Paulina (mejorada)', 'Mónica', 'Eddy', 'Paulina']);
    }),
    test('chooseVoice: the system default and a local voice rank above a remote one', () => {
      const list: VoiceLike[] = [
        { name: 'Google US English', lang: 'en-US', localService: false },
        { name: 'Alex', lang: 'en-US', localService: true },
        { name: 'Samantha', lang: 'en-US', localService: true, default: true },
      ];
      const onlyRemote: VoiceLike[] = [{ name: 'Google US English', lang: 'en-US', localService: false }];
      return eq('rank', [chooseVoice(list, 'en-US')?.name, chooseVoice(list.slice(0, 2), 'en-US')?.name, chooseVoice(onlyRemote, 'en-US')?.name],
        ['Samantha', 'Alex', 'Google US English']);
    }),
  ],
};

export default mod;
