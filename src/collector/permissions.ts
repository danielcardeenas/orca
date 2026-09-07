import { promptOn } from './screen.ts';

export interface PermissionRequest {
  agentId: string;
  sessionId: string;
  pane: string;
  identity: string;
  fingerprint: string;
  claimed: boolean;
}
export interface PermissionIO {
  current(): boolean;
  view(): Promise<{ identity: string; screen: string } | null>;
  key(identity: string, key: string): Promise<{ ok: boolean; detail: string }>;
  retire(reason: string): void;
  pending(): void;
}

/** Claim synchronously before any await: duplicates and reconnect retries cannot send twice. */
export async function answerPermission(request: PermissionRequest, answer: string, io: PermissionIO): Promise<{ ok: boolean; detail: string }> {
  if (!/^(allow|once|deny)$/i.test(answer.trim())) return { ok: false, detail: 'Use allow (once) or deny' };
  if (request.claimed || !io.current()) return { ok: false, detail: 'Permission is stale or already requested; no key sent' };
  request.claimed = true;
  const view = await io.view();
  const prompt = view && promptOn(view.screen);
  if (!io.current() || !view || view.identity !== request.identity || !prompt || prompt.fingerprint !== request.fingerprint) {
    io.retire('Permission changed or was answered manually; no key sent');
    return { ok: false, detail: 'Stale permission; no key sent. Wait for the current escalation.' };
  }
  const allow = answer.trim().toLowerCase() !== 'deny';
  const key = allow ? prompt.onceKey : prompt.denyKey;
  if (!key) {
    io.retire('This dialog requires manual terminal review');
    return { ok: false, detail: 'No safe once option; use the terminal' };
  }
  // Never follow a digit with Enter. A TUI may require manual submission.
  io.pending();
  const sent = await io.key(view.identity, key);
  return sent.ok
    ? { ok: true, detail: 'Response requested; pending terminal confirmation. No Enter sent.' }
    : { ok: false, detail: `Delivery uncertain; no retry. Review terminal: ${sent.detail}` };
}
