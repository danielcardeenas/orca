/** Web Push: durable credentials, bounded subscriptions and one alert per human wait. */
import webpush from 'web-push';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldState, Agent } from '../shared/types.ts';
import { isSynthetic } from '../shared/synthetic.ts';

type Subscription = webpush.PushSubscription;
type Send = typeof webpush.sendNotification;
export function subscription(raw: unknown): Subscription {
  const s = raw as Subscription;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 2048) throw new Error('Invalid push subscription');
  const u = new URL(s.endpoint);
  // These services terminate Web Push. Arbitrary URLs would turn this API into SSRF.
  const host = u.hostname;
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash ||
      !(host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
        host === 'web.push.apple.com' || host.endsWith('.push.apple.com') ||
        host === 'wns.windows.com' || host.endsWith('.notify.windows.com'))) throw new Error('Unsupported push service');
  if (!s.keys || !/^[A-Za-z0-9_-]{87}=?$/.test(s.keys.p256dh) ||
      !/^[A-Za-z0-9_-]{22}={0,2}$/.test(s.keys.auth) || Buffer.from(s.keys.p256dh, 'base64url')[0] !== 4) throw new Error('Invalid push keys');
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}
export function humanWait(a: Agent, w: WorldState): boolean {
  if (isSynthetic(w.machines[a.machineId]) || a.state !== 'blocked' || !a.block || a.block.kind === 'peer' || a.block.kind === 'input') return false;
  const e = a.block.escalationId ? w.escalations[a.block.escalationId] : undefined;
  return !e || e.status === 'pending';
}

export class PushService {
  private data: { keys: { publicKey: string; privateKey: string }; subscriptions: Subscription[]; waits: Record<string, number> };
  private file: string;
  private sending = false;
  constructor(dir: string, private send: Send = webpush.sendNotification, private subject = process.env['ORCA_VAPID_SUBJECT'] ?? 'https://orca.local') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'push.json');
    try { this.data = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.data = { keys: webpush.generateVAPIDKeys(), subscriptions: [], waits: {} };
      this.save();
    }
  }
  private save() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  get publicKey() { return this.data.keys.publicKey; }
  get count() { return this.data.subscriptions.length; }
  add(raw: unknown) {
    const s = subscription(raw);
    const list = this.data.subscriptions.filter(x => x.endpoint !== s.endpoint);
    if (list.length >= 32) throw new Error('Push device limit reached');
    this.data.subscriptions = [...list, s]; this.save();
  }
  remove(endpoint: string) {
    this.data.subscriptions = this.data.subscriptions.filter(s => s.endpoint !== endpoint); this.save();
  }
  async observe(w: WorldState): Promise<void> {
    if (this.sending) return;
    const waits = Object.values(w.agents).filter(a => humanWait(a, w));
    const fresh = waits.filter(a => this.data.waits[a.id] !== a.block!.since);
    const next = Object.fromEntries(waits.map(a => [a.id, a.block!.since]));
    if (JSON.stringify(next) !== JSON.stringify(this.data.waits)) { this.data.waits = next; this.save(); }
    if (!fresh.length || !this.count) return;
    this.sending = true;
    try {
      // No prompts, repository names or tokens on the lock screen or push provider.
      const payload = JSON.stringify({ title: 'ORCA · NEEDS YOU', body: `${fresh.length} agent${fresh.length === 1 ? '' : 's'} waiting for your input.`, tag: 'orca-human', url: '/?queue=1' });
      await Promise.all(this.data.subscriptions.map(async s => {
        try { await this.send(s, payload, { TTL: 300, urgency: 'high', timeout: 10_000, vapidDetails: { subject: this.subject, ...this.data.keys } }); }
        catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.remove(s.endpoint);
          else console.warn('[push] delivery failed', status ?? 'network');
        }
      }));
    } finally { this.sending = false; }
  }
}
