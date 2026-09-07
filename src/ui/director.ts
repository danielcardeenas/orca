/**
 * The camera, taking direction.
 *
 * CAPCOM says "show K9" and the hub relays a `camera` directive to every
 * console (see shared/camera.ts). This is the console's half: turn the
 * references in the directive into a place on the field and fly there, the
 * way the operator would have by hand — the view is pushed first so
 * Backspace comes back, the target is selected, the feed says who asked.
 *
 * A directive may arrive before its target: the agent CAPCOM just launched
 * is a session the collector has not reported yet, and a squad's block does
 * not exist until its first member stands on the field. So a directive that
 * cannot be applied waits — re-tried on every fleet change and on a slow
 * clock, because a tile's spot is a layout the field computes a frame after
 * the store changes — and is dropped, with a line in the feed, when its
 * deadline passes. One pending directive at a time: a newer one replaces an
 * older one that never landed, which is what the operator means by asking
 * for something else.
 */

import type { Console } from './console.ts';
import { store } from './store.ts';
import { findAgentRef, type CameraDirective } from '../shared/camera.ts';
import { squadsOf } from '../shared/squads.ts';
import { getSound } from './hud/sound.ts';

export interface DirectorHandle {
  /** Apply a directive now, or hold it until its target shows. */
  take(d: CameraDirective): void;
  /** The directive still waiting for its target, if any. */
  pending(): CameraDirective | null;
  dispose(): void;
}

/** How often a held directive is retried between fleet changes. */
const RETRY_MS = 400;

/** Where a directive resolved to, for the operator's feed. */
type Landing = { label: string } | null;

export function mountDirector(c: Console): DirectorHandle {
  let held: CameraDirective | null = null;
  let timer = 0;

  function agentsOf(refs: string[]): string[] {
    const ids: string[] = [];
    for (const r of refs) {
      const a = findAgentRef(store.world.agents, r);
      if (a && !ids.includes(a.id)) ids.push(a.id);
    }
    return ids;
  }

  /** Try once. Null means "not there yet"; a landing means it flew. */
  function apply(d: CameraDirective): Landing {
    switch (d.what) {
      case 'agent':
      case 'agents': {
        const ids = agentsOf(d.refs);
        if (!ids.length) return null;
        // The spot is the layout's word, not the store's: an agent that has
        // arrived but has not been laid out yet is not somewhere to fly to.
        const placed = ids.filter((id) => c.field.spotOf(id));
        if (!placed.length) return null;
        c.pushView();
        c.field.select(placed);
        c.field.frameAgents(placed);
        if (d.open) { if (placed.length === 1) c.openAgent(placed[0]!); else c.openGroup(placed); }
        return { label: placed.map((id) => store.world.agents[id]?.callsign ?? id).join(', ') };
      }
      case 'squad': {
        const name = d.refs[0];
        if (!name) return { label: 'nothing' };
        const sq = squadsOf(store.world.agents).find((s) => s.name === name);
        if (!sq) return null;
        const projectId = d.projectId ?? store.world.agents[sq.memberIds[0] ?? '']?.projectId ?? null;
        c.pushView();
        if (!c.field.frameSquad(name, projectId) && !c.field.frameSquad(name)) return null;
        c.field.select(sq.memberIds);
        if (d.open) c.openSquad(name);
        return { label: `squad ${name}` };
      }
      case 'project': {
        const id = d.refs[0] ?? '';
        const p = store.world.projects[id];
        if (!p) return null;
        if (!c.field.layout().regions.some((r) => r.id === id)) return null;
        c.pushView();
        c.field.frameProject(id);
        if (d.open) c.openProject(id);
        return { label: `project ${p.code}` };
      }
      case 'fleet':
        c.pushView();
        c.field.frameAll();
        if (d.open) c.openFleet();
        return { label: 'the whole fleet' };
      default:
        return { label: 'nothing' };
    }
  }

  function landed(d: CameraDirective, at: Landing): void {
    if (!at) return;
    getSound()?.play('frame');
    const who = d.by === 'launch' ? 'LAUNCH' : 'CAPCOM';
    c.note(`${who} → ${at.label}${d.note ? ` · ${d.note}` : ''}`);
  }

  function stop(): void {
    if (timer) { window.clearInterval(timer); timer = 0; }
  }

  function retry(): void {
    if (!held) { stop(); return; }
    if (Date.now() > held.until) {
      const what = held.what === 'squad' ? `squad ${held.refs[0] ?? ''}` : held.refs.join(', ') || held.what;
      c.note(`${held.by === 'launch' ? 'LAUNCH' : 'CAPCOM'} pointed at ${what}, but it never showed on the field`, 'warn');
      held = null;
      stop();
      return;
    }
    const at = apply(held);
    if (at) { const d = held; held = null; stop(); landed(d, at); }
  }

  function take(d: CameraDirective): void {
    // Late by the time it arrived: a hub that queued it, a tab that slept.
    if (Date.now() > d.until) return;
    const at = apply(d);
    if (at) { landed(d, at); return; }
    held = d;
    if (!timer) timer = window.setInterval(retry, RETRY_MS);
  }

  const off = store.on((e) => {
    if (e.k === 'camera') { take(e.directive); return; }
    if (held && (e.k === 'agents' || e.k === 'world' || e.k === 'projects')) retry();
  });

  return {
    take,
    pending: () => held,
    dispose() { off(); stop(); held = null; },
  };
}
