import webpush from 'web-push';
import { startHub } from '../src/hub/server.ts';
import type { Agent } from '../src/shared/types.ts';
// Exercise hub scheduling without sending anything to an external push service.
webpush.sendNotification = (async (_sub: unknown, payload: unknown) => {
  process.send?.({ delivered: JSON.parse(String(payload)) });
  return {};
}) as typeof webpush.sendNotification;
const hub = await startHub({ host: '127.0.0.1', port: 0, harness: false, quiet: true });
process.send?.({ port: hub.port });
process.on('message', m => {
  if (m === 'block') {
    hub.world.state.agents['push-test'] = { id: 'push-test', machineId: 'test', state: 'blocked', block: { kind: 'permission', since: Date.now() } } as Agent;
  } else void hub.close().then(() => process.exit(0));
});
