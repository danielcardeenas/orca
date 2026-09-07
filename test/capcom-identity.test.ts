/**
 * Quién es CAPCOM: un hecho, un archivo.
 *
 * El fallo que motivó esto no se ve en una pantalla y no rompe ninguna prueba
 * de las otras: dos archivos guardaban el mismo hecho con reglas de prioridad
 * implícitas, alguien actualizó uno, y el vigilante devolvió el mando a una
 * sesión ya vaciada. La flota se quedó sin CAPCOM con el proceso corriendo
 * delante. Lo que se prueba aquí es que ese estado ya no se puede representar.
 *
 * Y lo segundo: que una instalación que viene de los dos archivos llega entera.
 * Una migración que pierda el mando es peor que no migrar.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IDENTITY_FILE, clearIdentity, peekIdentity, readIdentity, succeed, writeIdentity,
} from '../src/collector/capcom-identity.ts';
import { test, ok, type TestModule } from './harness.ts';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function temporary<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-identity-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const legacy = (dir: string, name: string, body: unknown) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));

export default {
  suite: 'CAPCOM identity',
  tests: [
    test('a fresh directory has no commander, and saying so is not an error', () => temporary(dir => {
      assert.equal(readIdentity(dir), null);
      assert.equal(peekIdentity(dir), null);
      return ok('no identity is a valid answer', true);
    })),

    test('the migration keeps the record that used to win, and writes it once', () => temporary(dir => {
      // Como estaba en disco el 2026-09-07: la recuperación mandaba sobre la
      // sesión recordada, y ninguna regla escrita decía cuál actualizar.
      legacy(dir, 'session.json', { shortId: 'old-claude', at: 1 });
      legacy(dir, 'codex-recovery.json', { sessionId: OLD, runtime: 'codex', model: 'gpt-6-astra',
        cwd: '/tmp/runtime', contextMode: 'clean', cutoffAt: 99, handoffId: 'plan-1', historyPath: '/tmp/h.md' });
      const migrated = readIdentity(dir)!;
      assert.equal(migrated.sessionId, OLD, 'the recovery wins, as it did before');
      assert.equal(migrated.model, 'gpt-6-astra'); assert.equal(migrated.cwd, '/tmp/runtime');
      assert.equal(migrated.contextMode, 'clean'); assert.equal(migrated.cutoffAt, 99);
      assert.equal(migrated.handoffId, 'plan-1'); assert.equal(migrated.historyPath, '/tmp/h.md');
      // Se escribe una vez, y los viejos se quedan: son evidencia del traspaso
      // y lo que encuentra un collector anterior si alguien vuelve atrás.
      assert.ok(fs.existsSync(path.join(dir, IDENTITY_FILE)));
      assert.ok(fs.existsSync(path.join(dir, 'codex-recovery.json')));
      assert.deepEqual(readIdentity(dir), migrated, 'reading again is stable');
      return ok('the migration is faithful, single-writing and non-destructive', true);
    })),

    test('a bare session.json migrates to a commander with nothing to resume', () => temporary(dir => {
      legacy(dir, 'session.json', { shortId: 'e1065027', at: 1 });
      const migrated = readIdentity(dir)!;
      assert.equal(migrated.sessionId, 'e1065027');
      assert.equal(migrated.runtime, 'claude');
      // `default` es «no declarado»: quien decide cómo relanzar lo lee así en
      // vez de inventarse un modelo, que es lo que un `--bg` nunca declaró.
      assert.equal(migrated.model, 'default');
      return ok('a --bg short id survives as an identity with no resume plan', true);
    })),

    ...([
      ['no session id', { runtime: 'codex', model: 'gpt-6-astra' }, /no usable session id/],
      ['unknown runtime', { sessionId: OLD, runtime: 'grok', model: 'x' }, /unknown runtime/],
      // El caso que el fallo cerrado protege: un modelo preparado junto a un id
      // que no es una sesión hospedada. Reanudar eso lanza un CLI sobre una
      // conversación que no existe.
      ['a model on a short id', { sessionId: 'claude-short', runtime: 'codex', model: 'gpt-6-astra' }, /not a hosted session id but a model is declared/],
    ] as const).map(([what, body, error]) => test(`a broken identity fails closed: ${what}`, () => temporary(dir => {
      writeIdentity(dir, body as never);
      assert.throws(() => readIdentity(dir), error);
      assert.equal(peekIdentity(dir), null, 'and a reader that only wants to look gets nothing, not a crash');
      return ok(`${what}: refused rather than guessed`, true);
    }))),

    test('a record that only carries a handoff trail keeps it, without claiming a model', () => temporary(dir => {
      legacy(dir, 'codex-recovery.json', { sessionId: OLD, historyPath: '/tmp/prior.md', handoffId: 'plan-7' });
      const kept = readIdentity(dir)!;
      assert.equal(kept.historyPath, '/tmp/prior.md'); assert.equal(kept.handoffId, 'plan-7');
      assert.equal(kept.model, 'default', 'an undeclared model is not an invalid record');
      return ok('the trail survives a record that never named a model', true);
    })),

    test('succession carries what does not change and chains what does', () => temporary(dir => {
      const first = { sessionId: OLD, runtime: 'codex' as const, model: 'gpt-6-astra', cwd: '/tmp/runtime' };
      writeIdentity(dir, first);
      // Un `/clear` es el mismo proceso: hereda runtime, modelo y directorio.
      const cleared = succeed(readIdentity(dir), { sessionId: NEW, contextMode: 'clean', cutoffAt: 7 }, 1_000);
      assert.equal(cleared.runtime, 'codex'); assert.equal(cleared.model, 'gpt-6-astra');
      assert.equal(cleared.cwd, '/tmp/runtime');
      assert.equal(cleared.previousSessionId, OLD); assert.equal(cleared.previousModel, 'gpt-6-astra');
      assert.equal(cleared.activatedAt, new Date(1_000).toISOString());
      // Un traspaso sí cambia destino, y lo que se hereda no lo pisa.
      const crossed = succeed(cleared, { sessionId: OLD, runtime: 'claude', model: 'sonnet', cwd: '/tmp/other' }, 2_000);
      assert.equal(crossed.runtime, 'claude'); assert.equal(crossed.model, 'sonnet');
      assert.equal(crossed.cwd, '/tmp/other');
      assert.equal(crossed.previousSessionId, NEW); assert.equal(crossed.previousRuntime, 'codex');
      assert.throws(() => succeed(null, { sessionId: NEW }, 3_000), /needs a runtime and a model/);
      return ok('inherit what holds, chain what moves, refuse to record a partial one', true);
    })),

    test('the 2026-09-07 failure cannot be represented: there is no second record to forget', () => temporary(dir => {
      /*
       * El fallo, reproducido: un `/clear` movió el rol a NEW y actualizó el
       * registro que NO mandaba, dejando el que sí mandaba apuntando a OLD.
       * `ensure` leía ese, devolvía el mando al hilo vaciado, y el hub decía
       * «0 UNDER COMMAND» con el proceso vivo delante.
       *
       * Hoy no hay dos registros que puedan discrepar: escribir el hecho es
       * escribirlo entero, y leerlo devuelve exactamente eso.
       */
      legacy(dir, 'codex-recovery.json', { sessionId: OLD, runtime: 'codex', model: 'gpt-6-astra' });
      legacy(dir, 'session.json', { shortId: OLD, at: 1 });
      const before = readIdentity(dir)!;
      writeIdentity(dir, succeed(before, { sessionId: NEW, contextMode: 'clean', cutoffAt: 5 }, 1_000));

      // La única lectura posible ya dice NEW, y los archivos viejos —que siguen
      // ahí, y siguen diciendo OLD— no tienen voto: no se consultan mientras
      // exista el actual, que es lo que hacía falta para que no volviera a pasar.
      assert.equal(readIdentity(dir)?.sessionId, NEW);
      assert.equal(peekIdentity(dir)?.sessionId, NEW);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'codex-recovery.json'), 'utf8')).sessionId, OLD);
      const reread = readIdentity(dir)!;
      assert.equal(reread.previousSessionId, OLD, 'and the one it replaced is recorded, not overwritten in silence');
      assert.equal(reread.contextMode, 'clean'); assert.equal(reread.cutoffAt, 5);
      return ok('one fact, one file: the split that lost the fleet its command is gone', true);
    })),

    test('writing is atomic and clearing leaves the legacy evidence alone', () => temporary(dir => {
      legacy(dir, 'codex-recovery.json', { sessionId: OLD, runtime: 'codex', model: 'gpt-6-astra' });
      readIdentity(dir);
      writeIdentity(dir, { sessionId: NEW, runtime: 'codex', model: 'gpt-6-astra' });
      assert.equal(readIdentity(dir)?.sessionId, NEW);
      assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0, 'no half-written file is left behind');
      clearIdentity(dir);
      assert.equal(fs.existsSync(path.join(dir, IDENTITY_FILE)), false);
      // Y borrar el hecho no borra la evidencia de cómo se llegó a él… aunque
      // eso signifique que la siguiente lectura vuelve a migrar del archivo viejo.
      assert.ok(fs.existsSync(path.join(dir, 'codex-recovery.json')));
      assert.equal(readIdentity(dir)?.sessionId, OLD);
      return ok('atomic writes, and a clear that keeps the trail', true);
    })),
  ],
} satisfies TestModule;
