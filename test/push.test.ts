import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import assert from 'node:assert/strict';
import { PushService, subscription, humanWait } from '../src/hub/push.ts';
import { emptyWorld, type Agent, type Escalation, type Machine } from '../src/shared/types.ts';
import { test, ok } from './harness.ts';
const key = createECDH('prime256v1'); key.generateKeys();
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
function fixture() {
  const w = emptyWorld();
  w.agents.a = { id: 'a', machineId: 'm', state: 'blocked', block: { kind: 'permission', summary: 'secret', since: 10 } } as Agent;
  w.machines.m = { synthetic: false } as Machine;
  return w;
}
export default { suite: 'push', tests: [
  test('HTTP push API authenticates reads and mutations and persists subscription changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-push-http-'));
    const child = fork(new URL('./push.fixture.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, ORCA_HOME: dir, ORCA_TOKEN: 'push-test-token-isolated', ORCA_HARNESS: '0' },
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hub startup timeout')), 15000);
        child.once('message', m => { clearTimeout(timer); resolve((m as { port: number }).port); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`hub exited ${code}`)); });
      });
      const url = `http://127.0.0.1:${port}/api/push`;
      for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(url, { method })).status, 401);
      const headers = { Authorization: 'Bearer push-test-token-isolated', 'Content-Type': 'application/json' };
      assert.equal((await fetch(url, { headers })).status, 200);
      assert.equal((await fetch(url, { method: 'PUT', headers })).status, 405);
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
      assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(sub) })).status, 200);
      assert.equal(new PushService(dir).count, 1);
      const delivered = new Promise<{ url: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hub did not dispatch push')), 6000);
        child.once('message', m => { clearTimeout(timer); resolve((m as { delivered: { url: string } }).delivered); });
      });
      child.send('block');
      assert.equal((await delivered).url, '/?queue=1');
      assert.equal((await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ endpoint: sub.endpoint }) })).status, 200);
      assert.equal(new PushService(dir).count, 0);
      return ok('HTTP auth and persistence', true);
    } finally {
      if (child.connected) child.send('close');
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      rmSync(dir, { recursive: true, force: true });
    }
  }),

  test('subscriptions reject arbitrary network targets and malformed keys', () => {
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x']) assert.throws(() => subscription({ ...sub, endpoint }));
    assert.throws(() => subscription({ ...sub, keys: { auth: '', p256dh: '' } }));
    assert.deepEqual(subscription(sub), sub);
    return ok('validation', true);
  }),
  test('human waits exclude peers, idle, synthetic and CAPCOM-owned questions', () => {
    const w = fixture(), a = w.agents.a!;
    assert.equal(humanWait(a, w), true);
    a.block!.kind = 'peer'; assert.equal(humanWait(a, w), false);
    a.block!.kind = 'question'; w.machines.m!.synthetic = true; assert.equal(humanWait(a, w), false);
    w.machines.m!.synthetic = false; a.block!.escalationId = 'e';
    w.escalations.e = { status: 'with_ceo' } as Escalation; assert.equal(humanWait(a, w), false);
    w.escalations.e.status = 'pending'; assert.equal(humanWait(a, w), true);
    w.escalations.e.status = 'answered'; assert.equal(humanWait(a, w), false);
    a.state = 'idle'; assert.equal(humanWait(a, w), false);
    return ok('human filter', true);
  }),
  test('durable VAPID, dedup across restart, bounded devices, expiry and privacy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-push-'));
    try {
      const sent: string[] = [];
      const send = (async (_s: unknown, payload: unknown) => { sent.push(String(payload)); return {}; }) as ConstructorParameters<typeof PushService>[1];
      const service = new PushService(dir, send);
      service.add(sub); service.add(sub); assert.equal(service.count, 1);
      assert.equal(statSync(join(dir, 'push.json')).mode & 0o777, 0o600);
      const w = fixture(); await service.observe(w); await service.observe(w); assert.equal(sent.length, 1);
      assert.equal(sent[0]!.includes('secret'), false);
      const restart = new PushService(dir, send); assert.equal(restart.publicKey, service.publicKey);
      await restart.observe(w); assert.equal(sent.length, 1);
      w.agents.a!.block!.since++; await restart.observe(w); assert.equal(sent.length, 2);
      for (let i = 0; i < 31; i++) restart.add({ ...sub, endpoint: sub.endpoint + i });
      assert.throws(() => restart.add({ ...sub, endpoint: sub.endpoint + 'overflow' }));
      const expired = new PushService(dir, (async () => { throw { statusCode: 410 }; }) as ConstructorParameters<typeof PushService>[1]);
      w.agents.a!.block!.since++; await expired.observe(w); assert.equal(expired.count, 0);
      assert.equal(new PushService(dir, send).count, 0);
      return ok('durability and delivery', true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
] };
