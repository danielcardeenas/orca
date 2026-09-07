/**
 * What a tile calls an agent, and what it lets through.
 *
 * The tile has one line for a name and one for the last word, so the two
 * helpers behind them are checked on the strings the fleet actually produced:
 * the spawned squad whose title was its own brief, the session known only by
 * its id, and the last word that arrived in markdown.
 */

import { bareId, nameOf, plain, promptish } from '../src/ui/util.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const BRIEF = 'Eres el agente A en una prueba corta de saludo entre dos agentes. Escribe en saludo/saludo.log';

export default {
  suite: 'tiles',
  tests: [
    test('plain() drops the marks and keeps the words', () => {
      const got = [
        plain('**No he podido escribir los archivos.** Falta Bash.'),
        plain('## Recomendación: **MX$1,490 base** + `MX$800`'),
        plain('Listo. - **Commit** `66ad4329` — fix(co'),
        plain('Ver [el log](https://x.y/z) | Work'),
        plain('a_b_c snake_case stays'),
      ];
      return eq('plain() drops the marks and keeps the words', got, [
        'No he podido escribir los archivos. Falta Bash.',
        'Recomendación: MX$1,490 base + MX$800',
        'Listo. Commit 66ad4329 — fix(co',
        'Ver el log · Work',
        'a_b_c snake_case stays',
      ]);
    }),

    test('a brief is not a name; a short title is', () => {
      return ok('a brief is not a name; a short title is',
        promptish(BRIEF) && promptish('You are the lead of a ping-pong exercise') && promptish('Eres el lead')
        && !promptish('Make the docs describe what the code does') && !promptish('CAPCOM') && !promptish('test'),
        `${promptish(BRIEF)} ${promptish('CAPCOM')}`);
    }),

    test('bareId(): a session id is not a title', () =>
      ok('bareId(): a session id is not a title', bareId('32823974') && bareId('9585cb99') && !bareId('AX-25') && !bareId('CAPCOM'))),

    test('nameOf(): the mission when the title is the brief or an id, the title otherwise', () => {
      const got = [
        nameOf({ title: BRIEF, mission: 'Escribir saludo/saludo.log' }),
        nameOf({ title: BRIEF, mission: BRIEF }),
        nameOf({ title: '9585cb99', mission: 'Prueba corta de sanidad de ORCA' }),
        nameOf({ title: '9585cb99', mission: null }),
        nameOf({ title: 'Make the docs describe what the code actually does', mission: 'Make the docs describe what the code actually does' }),
        nameOf({ title: 'CAPCOM', mission: 'ORCA fleet command: survey, brief, unblock' }),
        nameOf({ title: '**hola** puedes oirme', mission: null }),
        nameOf({ title: '', mission: 'Test' }),
      ];
      return eq('nameOf(): the mission when the title is the brief or an id, the title otherwise', got, [
        'Escribir saludo/saludo.log',
        BRIEF,
        'Prueba corta de sanidad de ORCA',
        '9585cb99',
        'Make the docs describe what the code actually does',
        'CAPCOM',
        'hola puedes oirme',
        'Test',
      ]);
    }),
  ],
} satisfies TestModule;
