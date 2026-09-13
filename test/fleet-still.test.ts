/**
 * El modo quieto de la flota sintética: nadie nace, nadie muere, todo lo demás
 * sigue vivo.
 *
 * Para qué existe, en una frase: toda la flota del mock vive en UNA isla cuyo
 * número de columnas es `ceil(sqrt(n · 1,35))`, así que cada alta o baja
 * recoloca baldosas y, al cruzar un umbral, las recoloca todas — y los shots
 * están midiendo píxeles encima. Medido a `--speed=3`: un nacimiento cada
 * 0,84 s, y la población pasando de 26 a más de 100 en dos minutos y medio.
 *
 * Lo que se guarda aquí son las dos mitades que hacen que `still` sirva, y
 * que se rompen en silencio la una sin la otra:
 *
 *   la población      No cambia ni un id. Son TRES guardas —no retirar, no
 *   no se mueve       entrar en `done` y el presupuesto de hijos a cero— y
 *                     quitar cualquiera de ellas deja la flota creciendo o
 *                     apagándose.
 *   y sigue viva      Los agentes siguen transicionando. `shelf.shots.ts`
 *                     espera noventa segundos a que el mock publique un
 *                     artefacto con bytes, y eso lo produce la entrada en
 *                     `working` con `Write`: una flota congelada del todo
 *                     dejaría ese shot sin nada que mirar.
 *
 * Con `speed` alto para que quepa en unos segundos de reloj: lo que se mide
 * es la mecánica, no el ritmo.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, test, sleep, until, type TestModule } from './harness.ts';
import { startFakeFleet } from './fake-collector.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { FleetStore } from '../src/hub/fleets.ts';

const TOKEN = 'test-token-fleet-still';

async function withHub<T>(fn: (hub: Hub) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-still-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  try { return await fn(hub); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Los ids de la flota y en qué estado está cada uno, ahora mismo. */
function census(hub: Hub): { ids: Set<string>; states: Map<string, string> } {
  const agents = Object.values(hub.world.state.agents);
  return {
    ids: new Set(agents.map((a) => a.id)),
    states: new Map(agents.map((a) => [a.id, a.state])),
  };
}

export default {
  suite: 'Flota sintética · el modo quieto',
  tests: [
    test('con `still` no entra ni sale un agente, y los que hay siguen cambiando', async () => {
      return await withHub(async (hub) => {
        const fleet = startFakeFleet({
          hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 20, still: true,
        });
        try {
          await until(() => Object.keys(hub.world.state.agents).length > 5, 8000);
          const a = census(hub);
          await sleep(6000);
          const b = census(hub);
          const nacidos = [...b.ids].filter((id) => !a.ids.has(id));
          const idos = [...a.ids].filter((id) => !b.ids.has(id));
          // Vivos: alguno cambió de estado en esos segundos. Es lo que hace
          // que el mock siga publicando artefactos con la población quieta.
          const cambiaron = [...a.states].filter(([id, s]) => b.states.has(id) && b.states.get(id) !== s);
          return ok('población congelada y flota viva',
            nacidos.length === 0 && idos.length === 0 && cambiaron.length > 0,
            `${a.ids.size} agentes · ${nacidos.length} altas · ${idos.length} bajas · ${cambiaron.length} cambios de estado`);
        } finally { fleet.stop(); }
      });
    }),

    test('sin `still` la flota se mueve, que es como se sabe que la prueba mide algo', async () => {
      return await withHub(async (hub) => {
        const fleet = startFakeFleet({
          hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 20,
        });
        try {
          await until(() => Object.keys(hub.world.state.agents).length > 5, 8000);
          const a = census(hub);
          // El trasiego es aleatorio: se espera a la primera alta o baja en
          // vez de fijar un plazo, y el fallo es que no llegue ninguna.
          const movio = await until(() => {
            const b = census(hub);
            return [...b.ids].some((id) => !a.ids.has(id)) || [...a.ids].some((id) => !b.ids.has(id));
          }, 20_000);
          const b = census(hub);
          return ok('la flota de siempre rota',
            movio,
            `${a.ids.size} → ${b.ids.size} agentes`);
        } finally { fleet.stop(); }
      });
    }),
  ],
} satisfies TestModule;
