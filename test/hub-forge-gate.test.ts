/**
 * La puerta de lanzamiento por proyecto (hub/project-policy.ts).
 *
 * La política acordada —todo cambio en el repositorio de ORCA pasa por un
 * squad FORGE— no valía nada mientras dependiera de la disciplina de quien
 * lanza. Lo que se prueba aquí es la puerta, y sobre todo sus DOS puertas
 * abiertas, que son la mitad que puede romperse en silencio:
 *
 *  - un lanzamiento de sólo lectura pasa siempre. Sin esto habría que montar
 *    un squad FORGE para un reconocimiento que no escribe una línea, y eso
 *    convierte la puerta en un trámite que la gente aprende a rodear;
 *  - el hijo de un líder FORGE pasa. Sin esto la puerta estaría atrapando a
 *    los propios miembros de FORGE, y el único síntoma sería un squad que no
 *    puede crecer.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectPolicy, forgeGate, projectPolicyFile } from '../src/hub/project-policy.ts';
import { spawnWrites } from '../src/shared/forge.ts';
import { planChild } from '../src/collector/spawns.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const ORCA = { id: 'm1/-Users-dan-projects-orca', path: '/Users/dan/projects/orca', code: 'OR' };
const OTHER = { id: 'm1/-Users-dan-projects-axolots', path: '/Users/dan/projects/axolots', code: 'AX' };

/** Una política en un fichero temporal, con ORCA marcado por su ruta. */
function policyWith(projects: Record<string, unknown>): { policy: ProjectPolicy; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-policy-'));
  const file = join(dir, 'project-policy.json');
  writeFileSync(file, JSON.stringify({ projects }));
  return { policy: new ProjectPolicy(file), dir };
}

function spawn(over: Record<string, unknown> = {}): { k: string; squad?: string | null; review?: boolean; permissionMode?: string } {
  return { k: 'spawn', permissionMode: 'auto', ...over };
}

const tests = [
  test('writing without the FORGE prefix is refused, and the refusal names the way through', () => {
    const { policy, dir } = policyWith({ [ORCA.path]: { forgeOnly: true } });
    try {
      const refusal = forgeGate(spawn({ squad: 'audit-01' }), ORCA, policy);
      const noSquad = forgeGate(spawn(), ORCA, policy);
      return ok('refused with an alternative',
        refusal !== null && noSquad !== null
        && refusal.includes('forge-') && refusal.includes('plan') && refusal.includes('audit-01')
        && refusal.includes('project-policy.json')
        && noSquad!.includes('no squad'),
        JSON.stringify({ refusal, noSquad }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a read-only launch always passes: plan mode and a review spawn', () => {
    const { policy, dir } = policyWith({ [ORCA.path]: { forgeOnly: true } });
    try {
      const checks = {
        planMode: forgeGate(spawn({ permissionMode: 'plan' }), ORCA, policy) === null,
        review: forgeGate(spawn({ review: true }), ORCA, policy) === null,
        // Y siguen siendo lecturas aunque nadie les dé squad.
        predicate: !spawnWrites({ permissionMode: 'plan' }) && !spawnWrites({ review: true })
          && spawnWrites({ permissionMode: 'auto' }) && spawnWrites({ permissionMode: 'acceptEdits' })
          // Lo que no se dice, escribe: el defecto del collector edita.
          && spawnWrites({}),
      };
      return ok('read-only passes', Object.values(checks).every(Boolean), JSON.stringify(checks));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a FORGE lead passes, and so does the member it spawns — the prefix covers children', () => {
    const { policy, dir } = policyWith({ [ORCA.path]: { forgeOnly: true } });
    try {
      const lead = forgeGate(spawn({ squad: 'forge-lote-01' }), ORCA, policy);
      /*
       * El miembro no lo lanza el hub: lo pide el líder con `orca-spawn` y lo
       * arma su collector. Lo que se comprueba aquí es que el squad que ese
       * camino le pone al hijo es el del padre, porque de eso —y no de un caso
       * aparte en la puerta— depende que un miembro de FORGE pueda nacer.
       */
      const child = planChild(
        { projectId: ORCA.id, mission: 'Do the thing. Done when the suite is green.', squad: null, model: null, at: 0, file: 'x' } as never,
        { id: 'a_lead', callsign: 'FL', squad: 'forge-lote-01', liveChildren: 0 } as never,
        () => 2,
      );
      const inherited = child.ok ? child.squad : null;
      const childGate = child.ok ? forgeGate(child.cmd, ORCA, policy) : 'child refused';
      return ok('the prefix covers children',
        lead === null && inherited === 'forge-lote-01' && childGate === null,
        JSON.stringify({ lead, inherited, childGate }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('an unmarked project asks for nothing, and the mark works by id as well as by path', () => {
    const byPath = policyWith({ [ORCA.path]: { forgeOnly: true } });
    const byId = policyWith({ [OTHER.id]: { forgeOnly: true } });
    const off = policyWith({ [ORCA.path]: { forgeOnly: false } });
    try {
      const checks = {
        otherProjectFree: forgeGate(spawn({ squad: 'audit-01' }), OTHER, byPath.policy) === null,
        unknownProjectFree: forgeGate(spawn({ squad: 'audit-01' }), undefined, byPath.policy) === null,
        byId: forgeGate(spawn({ squad: 'audit-01' }), OTHER, byId.policy) !== null,
        // La misma ruta con barra final es la misma marca.
        trailingSlash: new ProjectPolicy(null).forgeOnly(ORCA) === false,
        explicitlyOff: forgeGate(spawn({ squad: 'audit-01' }), ORCA, off.policy) === null,
        // Nada que no sea un spawn pasa por aquí.
        notASpawn: forgeGate({ k: 'say' }, ORCA, byPath.policy) === null,
      };
      return ok('scoped to what was marked', Object.values(checks).every(Boolean), JSON.stringify(checks));
    } finally {
      for (const p of [byPath, byId, off]) rmSync(p.dir, { recursive: true, force: true });
    }
  }),

  test('WITHOUT a policy file a writing launch with no prefix PASSES, and arranging none is written', () => {
    /*
     * El defecto nuevo, y la única prueba que fija lo que nadie va a volver a
     * comprobar a mano.
     *
     * La primera versión sembraba el fichero al arrancar y lo escribía con
     * `forgeOnly: true`: la puerta se encendía sola sobre el repo de ORCA sin
     * que nadie lo decidiera, y el 13-09 se encontró armada en el hub del
     * operador por eso mismo. Ahora arrancar no escribe nada y no marca nada.
     * Si un refactor futuro vuelve a cerrar por omisión, el síntoma sería que
     * nadie puede lanzar y nadie sabría por qué: esto lo caza aquí.
     */
    const dir = mkdtempSync(join(tmpdir(), 'orca-policy-none-'));
    try {
      const file = projectPolicyFile(dir);
      const policy = new ProjectPolicy(file);
      const checks = {
        nothingWritten: !existsSync(file) && readdirSync(dir).length === 0,
        noRules: Object.keys(policy.list()).length === 0,
        // Lo que importa de verdad: una ESCRITURA sin prefijo, y pasa.
        writePasses: forgeGate(spawn({ squad: 'audit-01' }), ORCA, policy) === null,
        noSquadPasses: forgeGate(spawn(), ORCA, policy) === null,
        // Y `file: null` (un hub en proceso, una prueba) es lo mismo.
        inMemory: forgeGate(spawn(), ORCA, new ProjectPolicy(null)) === null,
      };
      return ok('off by default', Object.values(checks).every(Boolean), JSON.stringify(checks));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('turning it on is writing the file, and only that exact name is ever read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-policy-on-'));
    try {
      const file = projectPolicyFile(dir);
      /*
       * El fichero que se sembró en el incidente quedó guardado al lado con
       * otro nombre, como evidencia. Es evidencia, no configuración: ningún
       * atajo de compatibilidad debe volver a leerlo.
       */
      writeFileSync(`${file}.incidente-2026-09-13.evidencia`, JSON.stringify({ projects: { [ORCA.path]: { forgeOnly: true } } }));
      const stillOff = forgeGate(spawn({ squad: 'audit-01' }), ORCA, new ProjectPolicy(file));

      // Encender: una persona escribe el fichero, a sabiendas, y el hub lo lee.
      writeFileSync(file, JSON.stringify({ projects: { [ORCA.path]: { forgeOnly: true } } }));
      const on = forgeGate(spawn({ squad: 'audit-01' }), ORCA, new ProjectPolicy(file));
      // Apagar: se quita la entrada, y vuelve a pasar.
      writeFileSync(file, JSON.stringify({ projects: {} }));
      const off = forgeGate(spawn({ squad: 'audit-01' }), ORCA, new ProjectPolicy(file));

      return ok('explicit and reversible',
        stillOff === null && on !== null && on.includes('forge-') && off === null,
        JSON.stringify({ stillOff, on, off }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('an unreadable policy file leaves the gate open instead of taking the hub down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-policy-broken-'));
    try {
      const file = join(dir, 'project-policy.json');
      writeFileSync(file, '{ not json');
      const policy = new ProjectPolicy(file);
      return eq('broken file', forgeGate(spawn({ squad: 'audit-01' }), ORCA, policy), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the gate is WIRED: a real hub refuses the write and lets the read through', async () => {
    const { startHub } = await import('../src/hub/server.ts');
    const { createAuth } = await import('../src/hub/auth.ts');
    const { HubStore } = await import('../src/hub/persist.ts');
    const { AnswerMemory } = await import('../src/hub/memory.ts');
    const { FleetStore } = await import('../src/hub/fleets.ts');
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-hub-'));
    const file = join(dir, 'project-policy.json');
    writeFileSync(file, JSON.stringify({ projects: { [ORCA.id]: { forgeOnly: true } } }));
    const hub = await startHub({
      port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: 'test-token-forge-gate' } as NodeJS.ProcessEnv),
      store: new HubStore({ dir: join(dir, 'hub') }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')),
      fleets: new FleetStore(join(dir, 'fleets')),
      projectPolicyFile: file,
    });
    try {
      hub.world.state.projects[ORCA.id] = { id: ORCA.id, machineId: 'm1', path: ORCA.path, code: 'OR', name: 'orca' } as never;
      const say = async (cmd: Record<string, unknown>): Promise<string> => {
        try { await hub.dispatch(cmd as never); return 'accepted'; }
        catch (err) { return err instanceof Error ? err.message : String(err); }
      };
      const base = { k: 'spawn', projectId: ORCA.id, prompt: 'x', mission: 'x', parentId: null, background: true };
      const write = await say({ ...base, squad: 'audit-01', permissionMode: 'auto' });
      const forge = await say({ ...base, squad: 'forge-lote-01', permissionMode: 'auto' });
      const read = await say({ ...base, permissionMode: 'plan' });
      // Lo que pasa la puerta muere después, en el enrutado: no hay collector.
      const past = (s: string): boolean => s.includes('máquina no conectada');
      return ok('wired into dispatchCommand',
        write.includes('FORGE squad') && past(forge) && past(read),
        JSON.stringify({ write, forge, read }));
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }),
];

export default { suite: 'Puerta de lanzamiento por proyecto', tests } satisfies TestModule;
