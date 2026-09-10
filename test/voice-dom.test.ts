/**
 * ui/hud/voice.ts en Chromium — el gesto entero, con motor y voz de mentira.
 *
 * Lo que vale la pena guardar: mantener escucha y lo enseña; lo oído se ve
 * llegar; soltar manda una vez, exactamente lo oído, y lo dice; cancelar no
 * manda; nada oído, nada mandado; la respuesta a lo dicho se lee una vez y
 * en cian; una línea escrita a mano no se lee; empezar a dictar calla la
 * lectura; sin motor, TALK no existe y `start` dice por qué.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './voice.fixture.ts';
type F = typeof Fixture;

export default {
  suite: 'voice-dom',
  tests: [test('hold, hear, send, read back, in a real DOM', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/voice-fixture', (route) => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><body style="margin:0;background:var(--bezel)"></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}voice-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/voice.fixture.ts' as string); });
      const run = <T,>(fn: (f: F) => T | Promise<T>): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;

      // Con motor y en localhost, TALK existe.
      const ready = await run((f) => ({ supported: f.voice.supported, why: f.why(), hidden: f.shown().hidden }));
      assert.equal(ready.supported, true); assert.equal(ready.why, ''); assert.equal(ready.hidden, true);

      // Mantener: escucha, y se ve. Lo oído llega por partes y se enseña.
      const listening = await run((f) => {
        const started = f.voice.start();
        const again = f.voice.start();
        const empty = f.shown();
        f.hear([{ t: 'para a', final: false }]);
        const partial = f.shown().t;
        f.hear([{ t: 'para a K9', final: true }, { t: 'y avisa', final: false }]);
        return { started, again, empty, partial, full: f.shown().t, rec: { lang: f.FakeRec.last!.lang, continuous: f.FakeRec.last!.continuous, interim: f.FakeRec.last!.interimResults }, listening: f.voice.listening() };
      });
      assert.equal(listening.started, true); assert.equal(listening.again, false); assert.equal(listening.listening, true);
      assert.equal(listening.empty.hidden, false); assert.equal(listening.empty.k, 'LISTENING'); assert.equal(listening.empty.listening, true); assert.equal(listening.empty.bodyListening, true);
      assert.equal(listening.partial, 'para a');
      assert.equal(listening.full, 'para a K9 y avisa');
      assert.deepEqual(listening.rec, { lang: 'es-ES', continuous: true, interim: true });

      // Soltar: el motor termina lo último, y la línea sale una vez.
      const released = await run(async (f) => {
        f.voice.stop();
        // La lista de resultados es acumulativa: el segundo se vuelve definitivo.
        f.hear([{ t: 'para a K9', final: true }, { t: 'y avisa', final: true }], 1);
        await f.tick();
        return { sent: [...f.sent], shown: f.shown(), stopped: f.FakeRec.last!.stopped, listening: f.voice.listening() };
      });
      assert.deepEqual(released.sent, ['para a K9 y avisa']);
      assert.equal(released.shown.k, 'SENT'); assert.equal(released.shown.t, 'para a K9 y avisa'); assert.equal(released.shown.sentCls, true);
      assert.equal(released.shown.bodyListening, false); assert.equal(released.listening, false); assert.equal(released.stopped, 1);

      // Cancelar: se oyó algo y se tira. Nada oído: nada sale, nada queda.
      const dropped = await run(async (f) => {
        f.voice.start(); f.hear([{ t: 'esto no', final: true }]); f.voice.cancel(); await f.tick();
        const afterCancel = { sent: f.sent.length, aborted: f.FakeRec.last!.aborted, hidden: f.shown().hidden };
        f.voice.start(); f.voice.stop(); await f.tick();
        return { afterCancel, afterEmpty: { sent: f.sent.length, hidden: f.shown().hidden, bodyListening: f.shown().bodyListening } };
      });
      assert.deepEqual(dropped.afterCancel, { sent: 1, aborted: 1, hidden: true });
      assert.deepEqual(dropped.afterEmpty, { sent: 1, hidden: true, bodyListening: false });

      // Un fallo de permiso: se avisa, y la línea no sale.
      const blocked = await run(async (f) => {
        f.voice.start(); f.hear([{ t: 'algo', final: true }]); f.fail('not-allowed'); f.FakeRec.last!.onend?.(); await f.tick();
        return { sent: f.sent.length, note: f.notes.at(-1) ?? '' };
      });
      assert.equal(blocked.sent, 1); assert.match(blocked.note, /microphone blocked/);

      // La respuesta a lo dicho, terminado el turno: se lee una vez, en cian.
      const read = await run(async (f) => {
        const now = Date.now();
        f.world('working', [f.prompt('para a K9 y avisa', now), f.say('Voy a mirar.', now + 1)]);
        const early = f.spoken.length;
        f.world('idle', [f.prompt('para a K9 y avisa', now), f.say('Voy a mirar.', now + 1), f.tool(now + 1.5), f.say('Parado. Avisado por `orca say`. Ver src/hub/wake.ts:12.', now + 2)]);
        const once = { spoken: [...f.spoken], shown: f.shown() };
        f.world('idle', [f.prompt('para a K9 y avisa', now), f.say('Voy a mirar.', now + 1), f.tool(now + 1.5), f.say('Parado. Avisado por `orca say`. Ver src/hub/wake.ts:12.', now + 2)]);
        f.endSpeech();
        return { early, once, twice: f.spoken.length, after: f.shown() };
      });
      assert.equal(read.early, 0);
      assert.deepEqual(read.once.spoken, ['Parado. Avisado por orca say. Ver wake.ts.']);
      assert.equal(read.once.shown.k, 'CAPCOM'); assert.equal(read.once.shown.speaking, true); assert.equal(read.once.shown.bodySpeaking, true);
      assert.equal(read.twice, 1);
      assert.equal(read.after.hidden, true); assert.equal(read.after.bodySpeaking, false);

      // Una línea escrita a mano no se lee. Dictar de nuevo calla lo que se estuviera leyendo.
      const typed = await run(async (f) => {
        const now = Date.now();
        f.world('idle', [f.prompt('escrito a mano', now), f.say('Respuesta larga.', now + 1)]);
        const silent = f.spoken.length;
        f.world('idle', [f.prompt('para a K9 y avisa', now + 5), f.say('Otra vez.', now + 6)]);
        const readAgain = f.spoken.length;
        const cancelsBefore = f.cancels;
        f.voice.start();
        const hushed = { cancels: f.cancels > cancelsBefore, bodySpeaking: f.shown().bodySpeaking, k: f.shown().k };
        f.voice.cancel(); await f.tick();
        return { silent, readAgain, hushed };
      });
      assert.equal(typed.silent, 1);
      assert.equal(typed.readAgain, 2);
      assert.deepEqual(typed.hushed, { cancels: true, bodySpeaking: false, k: 'LISTENING' });

      // Sin oído alguno, ni reconocedor ni micrófono: TALK no existe, y pedirlo dice por qué.
      const bare = await run((f) => {
        const v = f.mountBare();
        const started = v.start();
        v.dispose();
        return { supported: v.supported, started, note: f.notes.at(-1) ?? '' };
      });
      assert.equal(bare.supported, false); assert.equal(bare.started, false); assert.match(bare.note, /no microphone access/);

      assert.deepEqual(errors, []);
      return ok('voice in a real DOM', true);
    } finally {
      await browser.close();
      await server.close();
    }
  })],
} satisfies TestModule;
