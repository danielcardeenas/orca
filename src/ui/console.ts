/**
 * What every window and HUD piece can ask the console to do.
 *
 * One object, built in main.ts, so a window never imports another window and
 * the field never imports a window. Everything crosses here.
 */

import type { WorldState } from '../shared/types.ts';
import type { FieldHandle } from './field/field.ts';
import type { DeckSort } from './field/layout.ts';
import type { WindowManager } from './windows/wm.ts';
import type { CtxTarget } from './hud/context.ts';

export interface At { x: number; y: number }

export interface Console {
  field: FieldHandle;
  wm: WindowManager;

  openAgent(agentId: string, at?: At): void;
  openInterrupt(escalationId: string, at?: At): void;
  openArtifact(artifactId: string, at?: At): void;
  openProject(projectId: string, at?: At): void;
  openMachine(machineId: string, at?: At): void;
  openGroup(agentIds: string[], at?: At): void;
  /** A squad by name: its leader first, SAY LEAD and SAY ALL. */
  openSquad(name: string, at?: At): void;
  openCeo(): void;
  openQueue(): void;
  openFeed(): void;
  openFleet(): void;
  openSpawn(projectId?: string, parentId?: string): void;
  openHelp(): void;
  /** The console's own knobs: the panel level, and whatever comes next. */
  openSettings(): void;
  openGallery(): void;
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
