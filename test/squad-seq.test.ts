/**
 * The hub's squad counter.
 *
 * One property matters: a name it hands out is never one already on the
 * fleet, and never one it handed out before — across a restart, and across a
 * console that numbered its own launches in a browser the hub never saw.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nextSquadName } from '../src/hub/squad-seq.ts';
import { ok, eq, test, throws, type TestModule } from './harness.ts';

function withFile<T>(fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-squad-seq-'));
  try { return fn(join(dir, 'hub', 'squads.json')); } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tests = [
  test('names count up from 01 and survive a fresh read of the file', () => withFile((file) => {
    const a = nextSquadName(file, 'audit', []);
    const b = nextSquadName(file, 'audit', []);
    const c = nextSquadName(file, 'payments', []);
    return ok('names count up per base', a === 'audit-01' && b === 'audit-02' && c === 'payments-01', `${a} ${b} ${c}`);
  })),

  test('a label already on the fleet is skipped, even with an empty counter', () => withFile((file) => {
    const next = nextSquadName(file, 'audit', ['audit-03', 'other-07', null, 'audit-1x']);
    return eq('a label on the fleet is skipped', next, 'audit-04');
  })),

  test('the larger of disk and fleet wins', () => withFile((file) => {
    nextSquadName(file, 'audit', []);
    nextSquadName(file, 'audit', []);
    nextSquadName(file, 'audit', []);
    const next = nextSquadName(file, 'audit', ['audit-02']);
    return eq('disk (03) beats fleet (02)', next, 'audit-04');
  })),

  test('a corrupt counter file is treated as empty, and the fleet still protects the name', () => withFile((file) => {
    const dir = file.slice(0, file.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
    nextSquadName(file, 'audit', []);
    writeFileSync(file, '{not json');
    const next = nextSquadName(file, 'audit', ['audit-01']);
    return eq('corrupt file → fleet labels still respected', next, 'audit-02');
  })),

  test('a base name too long for a suffix, or not a squad name at all, is refused', () => withFile((file) => {
    const tooLong = throws('too long', () => nextSquadName(file, 'a'.repeat(30), []));
    const bad = throws('bad chars', () => nextSquadName(file, 'audit 01', []));
    return ok('bad base names are refused', tooLong.pass && bad.pass);
  })),
];

const suite: TestModule = { suite: 'hub · squad counter', tests };
export default suite;
