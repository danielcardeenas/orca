/**
 * Spawn: launch an agent into a project with a real brief.
 *
 * The runtime picker lists every CLI the collector knows how to drive. Today
 * that is Claude Code; the others appear as the collector grows adapters, and
 * the console does not pretend otherwise — they stay on the list, greyed, with
 * the reason next to them.
 *
 * Every control here is the console's own (`ui/controls.ts`); each keeps a
 * hidden input, so the form is still read with one `FormData`.
 */

import { store } from '../../store.ts';
import { hub } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { slabBusy, slabFlash } from '../fx.ts';
import { pick, toggle, type PickHandle, type ToggleHandle } from '../../controls.ts';

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const RUNTIMES: { id: string; label: string; ready: boolean }[] = [
  { id: 'claude', label: 'CLAUDE CODE', ready: true },
  { id: 'codex', label: 'CODEX', ready: false },
  { id: 'grok', label: 'GROK', ready: false },
];
const PERMS = ['acceptEdits', 'auto', 'plan', 'manual'];

export function mountSpawn(ctx: WinCtx, c: Console) {
  const p = ctx.win.spec.params ?? {};
  const body = ctx.body;
  const parent = p.parentId ? store.world.agents[p.parentId] : null;
  ctx.setTitle(parent ? `CHILD OF ${parent.callsign}` : 'NEW AGENT');

  const projects = Object.values(store.world.projects).sort((a, b) => a.name.localeCompare(b.name));
  if (!projects.length) {
    body.innerHTML = `<p class="px px--tiny" style="padding:14px 12px;line-height:1.7;color:var(--ink-dim)">NO PROJECTS YET. A COLLECTOR DISCOVERS THEM FROM ~/.claude/projects ON EACH MACHINE.</p>`;
    return;
  }

  body.innerHTML = `
    <form class="form win__scroll scroll" data-form>
      <label><span class="px px--tiny">PROJECT</span><div data-c="project"></div></label>
      <label><span class="px px--tiny">RUNTIME</span><div data-c="runtime"></div></label>
      <label><span class="px px--tiny">MODEL</span><div data-c="model"></div></label>
      <label><span class="px px--tiny">MISSION · ONE LINE, WHY IT EXISTS</span>
        <input class="input" name="mission" placeholder="Leave the build green without touching the public API." required /></label>
      <label><span class="px px--tiny">PROMPT · THE BRIEF IT STARTS WITH</span>
        <textarea class="input" name="prompt" required placeholder="What to do, what not to touch, how to report back."></textarea></label>
      <div class="row row--wrap" style="gap:12px">
        <div data-c="background"></div>
        <div class="row" style="gap:6px"><span class="px px--tiny">PERMISSIONS</span><div data-c="perm" style="width:150px"></div></div>
      </div>
      <button class="slab-btn slab-btn--lg" type="submit" data-key="enter">SPAWN</button>
      <p class="px px--tiny" data-status style="color:var(--ink-dim)"></p>
    </form>
  `;
  const form = body.querySelector<HTMLFormElement>('[data-form]')!;
  const slot = (k: string) => form.querySelector<HTMLElement>(`[data-c="${k}"]`)!;

  const controls: { dispose(): void }[] = [];
  const mount = <T extends PickHandle | ToggleHandle>(k: string, h: T): T => {
    slot(k).appendChild(h.el);
    controls.push(h);
    return h;
  };

  mount('project', pick({
    name: 'project',
    search: projects.length > 6,
    value: p.projectId,
    options: projects.map((pr) => ({
      value: pr.id,
      label: `${pr.code} · ${pr.name}`,
      hint: store.world.machines[pr.machineId]?.hostname ?? '',
    })),
  }));
  mount('runtime', pick({
    name: 'runtime',
    options: RUNTIMES.map((r) => ({
      value: r.id,
      label: r.label,
      hint: r.ready ? '' : 'ADAPTER PENDING',
      disabled: !r.ready,
    })),
  }));
  mount('model', pick({ name: 'model', options: MODELS.map((m) => ({ value: m, label: m })) }));
  mount('background', toggle({ name: 'background', label: 'BACKGROUND · SURVIVES THIS TAB', checked: true }));
  mount('perm', pick({ name: 'perm', options: PERMS.map((x) => ({ value: x, label: x })) }));

  const status = body.querySelector<HTMLElement>('[data-status]')!;
  const goBtn = form.querySelector<HTMLElement>('[type=submit]')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const projectId = String(fd.get('project'));
    status.textContent = 'SPAWNING…';
    // §6.2: ink for a frame, then A3's band along the slab's bottom edge until
    // the hub acks. A spawn takes as long as it takes; the band says so.
    slabFlash(goBtn);
    const busy = slabBusy(goBtn);
    try {
      await hub.cmd({
        k: 'spawn',
        projectId,
        prompt: String(fd.get('prompt')),
        mission: String(fd.get('mission')),
        model: String(fd.get('model')),
        runtime: String(fd.get('runtime') || 'claude'),
        parentId: p.parentId ?? null,
        background: fd.get('background') === 'on',
        permissionMode: String(fd.get('perm')) as 'auto' | 'acceptEdits' | 'plan' | 'manual',
      });
      c.note(`spawned an agent on ${store.world.projects[projectId]?.code ?? projectId}`);
      ctx.close();
    } catch (err) {
      status.textContent = `FAILED · ${(err as Error).message.toUpperCase()}`;
    } finally {
      busy();
    }
  });
  setTimeout(() => form.querySelector<HTMLInputElement>('[name=mission]')?.focus(), 80);

  return { dispose() { controls.forEach((x) => x.dispose()); } };
}
