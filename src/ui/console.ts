/**
 * What every window and HUD piece can ask the console to do.
 *
 * One object, built in main.ts, so a window never imports another window and
 * the field never imports a window. Everything crosses here.
 */

import type { WorldState } from '../shared/types.ts';
import type { InterruptOutcome } from '../shared/interrupt.ts';
import type { FieldHandle } from './field/field.ts';
import type { DeckSort } from './field/layout.ts';
import type { WindowManager } from './windows/wm.ts';
import type { CtxTarget } from './hud/context.ts';
import type { VoiceHandle } from './hud/voice.ts';

export interface At { x: number; y: number }

export interface Console {
  field: FieldHandle;
  wm: WindowManager;
  /** Push-to-talk into CAPCOM (`hud/voice.ts`). `supported` says whether TALK is drawn at all. */
  voice: VoiceHandle;

  openAgent(agentId: string, at?: At): void;
  /** The agent's pane, live: look at the CLI itself and type into it. */
  openTerminal(agentId: string, at?: At): void;
  openInterrupt(escalationId: string, at?: At): void;
  openArtifact(artifactId: string, at?: At): void;
  /**
   * A file on disk, in ORCA's own viewer (kinds/file.ts). `path` is absolute
   * or `~/…`; `line`/`col` scroll a text file there. One window per path
   * unless `fresh`, which is what ⌘click asks for.
   */
  openFile(file: { path: string; line?: number | null; col?: number | null; agentId?: string | null; project?: string | null }, opts?: { fresh?: boolean; at?: At }): void;
  /**
   * The project's folder on disk, browsed with vim keys (kinds/files.ts).
   * Read-only; one window per project. From the project's context menu.
   */
  openFiles(projectId: string, at?: At): void;
  /**
   * The agent's own worktree, in that same browser. It lives in
   * `<project>/.claude/worktrees/<name>` — the hub serves it, but only that
   * subfolder of `.claude`, so it never shows up in the project's listing and
   * the browser only ever descends through what it lists. Opening it at the
   * root is the door. Does nothing for an agent working on the project's own
   * tree, which has no worktree.
   */
  openWorktree(agentId: string, at?: At): void;
  openProject(projectId: string, at?: At): void;
  openMachine(machineId: string, at?: At): void;
  openGroup(agentIds: string[], at?: At): void;
  /** A squad by name: its leader first, SAY LEAD and SAY ALL. */
  openSquad(name: string, at?: At): void;
  /** La ventana del mando. `at` es el punto que la abrió, cuando viene de la baldosa. */
  openCeo(at?: At): void;
  /**
   * A mission's own window: its conversation, its results, and a line to
   * whoever led it. One window per mission — opening one that is already open
   * raises it instead of making a second — and closing it archives nothing.
   * Both doors call this: the HUD's mission panel and CAPCOM's rail.
   * `tab` picks which third opens; without it, a finished mission opens on its
   * results and a live one on its conversation. See windows/kinds/mission.ts.
   */
  openMission(missionId: string, opts?: { tab?: 'talk' | 'crew' | 'results'; at?: At }): void;
  openQueue(): void;
  openFeed(): void;
  openFleet(): void;
  openSpawn(projectId?: string, parentId?: string): void;
  openHelp(): void;
  /** The console's own knobs: the panel level, and whatever comes next. */
  openSettings(): void;
  /** What ORCA costs the machines it runs on. See windows/kinds/hygiene.ts. */
  openHygiene(): void;
  /** Despliega la sección AUTOMEJORA y la trae a la vista (⌥I). */
  openImprove(): void;
  /**
   * El índice de todo lo que la flota ha hecho. Con un agente, ya filtrado por
   * él: es la puerta del contador de su estantería en el campo.
   */
  openGallery(agentId?: string): void;
  openTimeline(): void;
  /** The sound board: audition every clip, assign one per event. */
  openSfx(): void;
  /** Background music: Bandcamp or Spotify embeds the operator pasted. */
  openMusic(): void;
  /** Open the record player and start the record, as far as the browser and the player allow. */
  startMusic(): void;
  /** Draw a past world instead of the live one; null returns to now. */
  setReplay(world: WorldState | null): void;
  /** Open the launch window; with a preset name and `fire`, launch it straight away. */
  openLaunch(preset?: string, fire?: boolean): void;

  /** Fly the camera to an agent and select it. */
  go(agentId: string): void;
  /** Toggle the comp's align deck: every tile in one ordered grid. Same sort again returns to the field. */
  deck(sort?: DeckSort): void;
  /** Remember the current view so Backspace can come back to it. Call before any programmed flight. */
  pushView(): void;

  /** Talk to agents. Fans out; resolves when every ack is in. */
  say(agentIds: string[], text: string): Promise<{ ok: number; failed: string[] }>;
  /**
   * Cut the turn this agent is in the middle of, and optionally say what to do
   * instead. Not `stop`: the session, its id and its context survive — only
   * the turn in flight is dropped. Answers what actually happened, because
   * "the key went out" and "the CLI recorded the interruption" are different
   * things and the operator is entitled to know which one they got.
   */
  interrupt(agentId: string, text: string | null): Promise<InterruptOutcome | null>;
  stop(agentId: string): Promise<void>;
  answer(escalationId: string, answer: string, rememberAs: string | null): void;
  /** Pull an artifact into the field next to its agent. */
  placeArtifact(artifactId: string): void;
  unplaceArtifact(artifactId: string): void;

  /** A line in the local telemetry, from the console itself. */
  note(text: string, level?: 'info' | 'warn' | 'alert'): void;

  /**
   * The context menu for a thing, at a screen point. The same thing gets
   * the same menu from the field, a window, a list row or the tray; what is
   * in it is written once in `hud/context.ts`.
   */
  menu(target: CtxTarget, at: At): void;
}
