import { mountRecoverySetting } from '../recovery-setting.ts';
import { hub } from '../../net/client.ts';
/**
 * The small ones: the breach banner, the help card and the settings card.
 */

import gsap from 'gsap';
import type { WinCtx } from '../wm.ts';
import { EASE, REDUCE } from '../../motion.ts';
import type { Console } from '../../console.ts';
import { level, toggle } from '../../controls.ts';
import { getPref, setPref } from '../../prefs.ts';
import { store } from '../../store.ts';

/** SYS BREACH: the link to the hub is down. The comp's red marquee. */
export function mountBreach(ctx: WinCtx) {
  ctx.setState('breach', 'var(--red)');
  ctx.setTitle('LINK TO THE HUB IS DOWN · RECONNECTING');
  const body = ctx.body;
  body.innerHTML = `<div class="breach marquee"><div class="marquee__track" data-track>${
    Array.from({ length: 3 }).map(() => `<div class="banner"><span class="warn"></span><span class="px px--banner">SYS BREACH</span><span class="warn"></span><span class="px px--banner">LINK DOWN</span></div>`).join('')
  }</div></div>`;
  const track = body.querySelector<HTMLElement>('[data-track]')!;
  let tween: gsap.core.Tween | null = null;
  if (!REDUCE.value) {
    requestAnimationFrame(() => {
      const w = track.scrollWidth / 3;
      tween = gsap.fromTo(track, { x: 0 }, { x: -w, duration: 6, ease: EASE.none, repeat: -1 });
    });
  }
  return { dispose() { tween?.kill(); } };
}

export function mountHelp(ctx: WinCtx) {
  ctx.setTitle('KEYS AND COMMANDS');
  ctx.body.innerHTML = `<div class="win__scroll scroll">
    <div class="sec"><div class="sec__k px">THE FIELD</div><div class="mono sec__v" style="line-height:1.7">drag or scroll · pan
⌘/ctrl+scroll, or pinch · zoom to the cursor
click a tile · select
shift+drag · lasso a group
drag a tile · place it, and it stays
drag a project's label · move the whole region
drag a squad by its label · move the whole block
click a squad's label · select its members
right-click anything · what can be done to it
double-click a tile · open the agent
double-click a squad · open it
double-click a project · frame it</div></div>
    <div class="sec"><div class="sec__k px">KEYS · THE FIELD</div><div class="mono sec__v" style="line-height:1.7">⌘K · command line
F · frame everything      O · tilt
D · deck                  M · minimap
Space · focus (hold)      Tab · next agent that needs you
Backspace · back          \` · walk the window stack
⌥Tab (hold ⌥) · switch windows, release to land</div></div>
    <div class="sec"><div class="sec__k px">KEYS · WINDOWS</div><div class="mono sec__v" style="line-height:1.7">⌥C capcom   ⌥Q queue   ⌥F feed   ⌥E fleet
⌥N spawn    ⌥L launch  ⌥G gallery ⌥T time
⌥M music    ⌥S sound   ⌥H help   ⌥, settings
⌥1…9 · fly to a bookmark   ⌥⇧1…9 · set one
in a window: the letter on each button
Esc · close   - · fold   V · reveal an off-screen tile
in the tray (\`): ← → · Enter · Backspace closes · 1…9 jump</div></div>
    <div class="sec"><div class="sec__k px">THE COMMAND LINE</div><div class="mono sec__v" style="line-height:1.7">anything · talk to CAPCOM
@K9 fix the tests · talk to an agent
@LZ stop and report · talk to a project
/spawn /launch audit /gallery /find K9 /term K9 /dismiss K9 /frame /queue /capcom /feed /fleet /deck /timeline /sfx /music /tilt /help</div></div>
    <div class="sec"><div class="sec__k px">WHO IS ON THE FIELD</div><div class="mono sec__v" style="line-height:1.7">agents ORCA launched (finished ones linger a day) · other sessions while they work or need you; idle an hour, gone
DISMISS (H) hides one · /dismiss finished hides every finished one
SETTINGS › SHOW ALL reveals everyone, dismissed included</div></div>
    <div class="sec"><div class="sec__k px">TERMINALS</div><div class="mono sec__v" style="line-height:1.7">an agent ORCA launched hosted lives in a tmux pane
TERM on its window, T in its menu, or /term K9 · the CLI itself, live
type into it · answer its prompts · ⌘/ctrl+V pastes · close = detach, it keeps running
a session started from your own shell has no pane and cannot be attached</div></div>
  </div>`;
}

/**
 * Settings: the console's own knobs. One today — how bright the subpixel
 * panel under the fleet glows — laid out the way the sound board lays out its
 * master, so a second knob is one more row. Every knob lands live and is
 * remembered (`prefs.ts`).
 */
export function mountSettings(ctx: WinCtx, c: Console): { dispose(): void } {
  ctx.setTitle('THE CONSOLE');
  const body = ctx.body;
  body.innerHTML = `
    <div class="win__scroll scroll" data-settings-scroll>
    <div class="sec" data-recovery-setting></div>
    <div class="sec">
      <div class="sec__k px">PANEL</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">GLOW</label>
        <div data-c="panel"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">COLOR</label>
        <div data-c="color"></div>
      </div>
      <p class="px px--tiny set__hint">THE SUBPIXEL MATRIX UNDER THE FLEET · 0 IS A PLAIN BEZEL · COLOR OFF KEEPS THE GRID IN GREY</p>
    </div>
    <div class="sec">
      <div class="sec__k px">THE FIELD</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">SHOW ALL</label>
        <div data-c="showall"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">DISMISSED</label>
        <div><button class="btn" type="button" data-forget data-key="u">BRING BACK</button></div>
      </div>
      <p class="px px--tiny set__hint" data-hidden-hint></p>
    </div>
    <div class="sec">
      <div class="sec__k px">CAPCOM</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">TASKS</label>
        <div data-c="capTasks"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">ASKS</label>
        <div data-c="capNotches"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">TURN</label>
        <div data-c="capPulse"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">LINKS</label>
        <div data-c="capLinks"></div>
      </div>
      <p class="px px--tiny set__hint">WHAT THE COMMAND POST CARRIES · TASKS: ONE ARC OF THE RING PER OPEN TASK, LIT WHILE IT MOVES · ASKS: AN AMBER NOTCH PER QUESTION NOBODY HAS ANSWERED · TURN: A FASTER PULSE WHILE CAPCOM WORKS, AMBER WHILE IT WAITS ON YOU · LINKS: A FAINT TIE TO EVERY AGENT IT LAUNCHED, WHICH WITH FIFTY OF THEM IS NOISE</p>
    </div>
    <div class="sec">
      <div class="sec__k px">MUSIC</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">AUTO</label>
        <div data-c="music"></div>
      </div>
      <p class="px px--tiny set__hint">PUTS THE LAST RECORD ON WHEN THE CONSOLE OPENS · SPOTIFY STARTS ON YOUR FIRST CLICK OR KEY, A BROWSER PLAYS NO SOUND BEFORE ONE · BANDCAMP ONLY STARTS FROM ITS OWN ▶</p>
    </div>
    </div>
  `;
  const recovery = mountRecoverySetting(body.querySelector<HTMLElement>('[data-recovery-setting]')!, cmd => hub.cmd(cmd), () => store.linkUp);
  const panel = level({
    value: getPref('panel'),
    label: 'panel glow',
    onChange(v) { setPref('panel', v); c.field.setGroundLevel(v); },
  });
  body.querySelector('[data-c="panel"]')!.appendChild(panel.el);
  const color = toggle({
    name: 'panelColor',
    label: 'RGB',
    checked: getPref('panelColor'),
    onChange(on) { setPref('panelColor', on); c.field.setGroundColor(on); },
  });
  body.querySelector('[data-c="color"]')!.appendChild(color.el);
  const music = toggle({
    name: 'musicAutoplay',
    label: 'AUTOPLAY',
    checked: getPref('musicAutoplay'),
    onChange(on) {
      setPref('musicAutoplay', on);
      // Switching it on is a click, which is the gesture the browser wanted.
      if (on) c.startMusic();
    },
  });
  body.querySelector('[data-c="music"]')!.appendChild(music.el);

  /*
   * CAPCOM's halo (field/command.ts), a switch per piece. The field reads
   * these every frame, so nothing has to be told: flipping one shows on the
   * next frame.
   */
  const capcom = ([
    ['capTasks', 'capcomTasks', 'RING'],
    ['capNotches', 'capcomNotches', 'NOTCHES'],
    ['capPulse', 'capcomPulse', 'PULSE'],
    ['capLinks', 'capcomLinks', 'TIES'],
  ] as const).map(([slot, key, label]) => {
    const t = toggle({ name: key, label, checked: getPref(key), onChange(on) { setPref(key, on); } });
    body.querySelector(`[data-c="${slot}"]`)!.appendChild(t.el);
    return t;
  });

  const hint = body.querySelector<HTMLElement>('[data-hidden-hint]')!;
  const paintHint = () => {
    const n = store.hiddenCount();
    hint.textContent = `OFF: THE FLEET — AGENTS ORCA LAUNCHED (A FINISHED ONE STAYS A DAY), PLUS ANY OTHER SESSION WHILE IT WORKS OR NEEDS YOU; IDLE AN HOUR, IT LEAVES · ON: EVERY SESSION THE COLLECTORS REPORT, DISMISSED ONES INCLUDED · ${n} HIDDEN NOW`;
  };
  const showAll = toggle({
    name: 'showAll',
    label: 'EVERYONE',
    checked: getPref('showAll'),
    onChange(on) { setPref('showAll', on); store.refilter(); paintHint(); },
  });
  body.querySelector('[data-c="showall"]')!.appendChild(showAll.el);
  body.querySelector('[data-forget]')!.addEventListener('click', () => {
    const n = store.undismissAll();
    c.note(`${n} dismissed agent${n === 1 ? '' : 's'} back on the field`);
    paintHint();
  });
  paintHint();
  const off = store.on((e) => { if (e.k === 'link') void recovery.refresh(); if (e.k === 'agents' || e.k === 'world') paintHint(); });
  return { dispose() { recovery.dispose(); off(); color.dispose(); music.dispose(); showAll.dispose(); for (const t of capcom) t.dispose(); } };
}
