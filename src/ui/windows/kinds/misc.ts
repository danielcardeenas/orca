import { mountPushSettings } from '../../push.ts';
import { deviceWake } from '../../pwa.ts';
import { mountRecoverySetting } from '../recovery-setting.ts';
import { hub } from '../../net/client.ts';
/**
 * The small ones: the breach banner, the help card and the settings card.
 */

import gsap from 'gsap';
import type { WinCtx } from '../wm.ts';
import { EASE, REDUCE } from '../../motion.ts';
import type { Console } from '../../console.ts';
import { level, pick, toggle } from '../../controls.ts';
import { DISPLAY_FONTS, MONO_FONTS, setDisplayFont, setMonoFont } from '../../fonts.ts';
import { getPref, setPref } from '../../prefs.ts';
import { store } from '../../store.ts';
import { voiceUnavailable } from '../../hud/voice.ts';

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
click an agent · open its window; click again · close
double-click a squad · open it
double-click a project · frame it</div></div>
    <div class="sec"><div class="sec__k px">KEYS · THE FIELD</div><div class="mono sec__v" style="line-height:1.7">⌘K · command line
F · frame everything      O · tilt
D · deck                  M · minimap
Space · focus (hold)      Tab · next agent that needs you
⌥V (hold) · talk to CAPCOM, let go to send, Esc to drop
Backspace · back          \` · walk the window stack
⌥Tab (hold ⌥) · switch windows, release to land</div></div>
    <div class="sec"><div class="sec__k px">KEYS · WINDOWS</div><div class="mono sec__v" style="line-height:1.7">⌥C capcom   ⌥Q queue   ⌥F feed   ⌥E fleet
⌥N spawn    ⌥L launch  ⌥G gallery ⌥T time
⌥M music    ⌥S sound   ⌥H help   ⌥, settings
⌥1…9 · fly to a bookmark   ⌥⇧1…9 · set one
in a window: the letter on each button
FRONT · bring to front   CANVAS · return to its place
PIN · fix the foreground window to the screen
Esc · return from front, otherwise close   - · fold   + · bring to front
V · reveal the source
tray click / Enter · open or minimize; fly to distant windows
in the tray (\`): ← → · - folds · + brings forward · Backspace closes · 1…9 jump
a tile reads off view when its window is out on the canvas, off screen</div></div>
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
 * Settings: the console's own knobs — the two faces the world is set in, how
 * bright the subpixel panel under the fleet glows, who is on the field, what
 * CAPCOM's halo carries — laid out the way the sound board lays out its
 * master, so another knob is one more row. Every knob lands live and is
 * remembered (`prefs.ts`).
 */
export function mountSettings(ctx: WinCtx, c: Console): { dispose(): void } {
  ctx.setTitle('THE CONSOLE');
  const body = ctx.body;
  body.innerHTML = `
    <div class="win__scroll scroll" data-settings-scroll>
    <div class="sec" data-device-settings></div>
    <div class="sec" data-recovery-setting></div>
    <div class="sec">
      <div class="sec__k px">TYPE</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">DISPLAY FONT</label>
        <div data-c="fontDisplay"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">MONO FONT</label>
        <div data-c="fontMono"></div>
      </div>
      <p class="px px--tiny set__hint">THE FACE EVERY LABEL IS SET IN, AND THE ONE A MACHINE WROTE IN · TINY5 IS THE PIXEL TYPE THE WORLD WAS DRAWN FOR, AND THE ONLY ONE THAT TURNS THE SMOOTHING OFF · LANDS LIVE, ON EVERY WINDOW AT ONCE</p>
    </div>
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
        <label class="px px--tiny set__lab">MISSIONS</label>
        <div data-c="capMissions"></div>
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
      <p class="px px--tiny set__hint">WHAT THE COMMAND POST CARRIES · MISSIONS: ONE ARC OF THE RING PER OPEN MISSION, LIT WHILE IT MOVES · ASKS: AN AMBER NOTCH PER QUESTION NOBODY HAS ANSWERED · TURN: A FASTER PULSE WHILE CAPCOM WORKS, AMBER WHILE IT WAITS ON YOU · LINKS: A FAINT TIE TO EVERY AGENT IT LAUNCHED, WHICH WITH FIFTY OF THEM IS NOISE</p>
    </div>
    <div class="sec">
      <div class="sec__k px">VOICE</div>
      <div class="set__row">
        <label class="px px--tiny set__lab">READ BACK</label>
        <div data-c="voiceReply"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">VOICE</label>
        <div class="row" data-c="voiceName"></div>
      </div>
      <div class="set__row">
        <label class="px px--tiny set__lab">EARS</label>
        <div class="row" data-c="voiceEngine"></div>
      </div>
      <p class="px px--tiny set__hint" data-engine-hint></p>
      <p class="px px--tiny set__hint" data-voice-hint>HOLD ⌥V OR THE MAST'S TALK AND SPEAK; LET GO AND THE LINE GOES TO CAPCOM AS IF TYPED · READ BACK: THE FIRST SENTENCES OF ITS CONCLUSION, ONLY FOR A LINE YOU SPOKE, ONLY ONCE IT IS DONE · THE WHOLE REPLY STAYS IN THE WINDOW · VOICE: AUTO IS WHAT <code>say</code> WOULD USE, THE SYSTEM VOICE FOR YOUR LANGUAGE; THE LIST IS THE BROWSER'S</p>
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
  const disposePush = mountPushSettings(body.querySelector<HTMLElement>('[data-device-settings]')!, deviceWake());
  const recovery = mountRecoverySetting(body.querySelector<HTMLElement>('[data-recovery-setting]')!, cmd => hub.cmd(cmd), () => store.linkUp);
  /*
   * The two faces. Both land on the whole console the moment they are picked —
   * `fonts.ts` writes the custom properties onto <html> — so there is nothing
   * here to repaint and nothing to reload.
   */
  const fontDisplay = pick({
    name: 'fontDisplay',
    options: DISPLAY_FONTS.map((f) => ({ value: f.id, label: f.label, hint: f.hint })),
    value: getPref('fontDisplay'),
    onChange(v) { setDisplayFont(v); },
  });
  body.querySelector('[data-c="fontDisplay"]')!.appendChild(fontDisplay.el);
  const fontMono = pick({
    name: 'fontMono',
    options: MONO_FONTS.map((f) => ({ value: f.id, label: f.label, hint: f.hint })),
    value: getPref('fontMono'),
    onChange(v) { setMonoFont(v); },
  });
  body.querySelector('[data-c="fontMono"]')!.appendChild(fontMono.el);

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
    ['capMissions', 'capcomMissions', 'RING'],
    ['capNotches', 'capcomNotches', 'NOTCHES'],
    ['capPulse', 'capcomPulse', 'PULSE'],
    ['capLinks', 'capcomLinks', 'TIES'],
  ] as const).map(([slot, key, label]) => {
    const t = toggle({ name: key, label, checked: getPref(key), onChange(on) { setPref(key, on); } });
    body.querySelector(`[data-c="${slot}"]`)!.appendChild(t.el);
    return t;
  });

  // Read back is a switch; whether TALK exists at all is the browser's call,
  // and when it said no the hint says why instead of a switch that does nothing.
  const voiceReply = toggle({ name: 'voiceReply', label: 'SPEAK', checked: getPref('voiceReply'), onChange(on) { setPref('voiceReply', on); if (!on) c.voice.hush(); } });
  body.querySelector('[data-c="voiceReply"]')!.appendChild(voiceReply.el);
  if (!c.voice.supported) {
    const why = voiceUnavailable();
    body.querySelector<HTMLElement>('[data-voice-hint]')!.textContent = `TALK IS OFF THE MAST · ${why.toUpperCase()}`;
  }
  /*
   * The voice, from the browser's own list. Chrome hands the list over empty
   * and fills it a beat later (`voiceschanged`), so the picker is rebuilt
   * when it lands — never while it is open under the pointer. AUTO is what
   * `say` would use (voice.ts), which is the answer to "that voice is awful":
   * the first match for es-MX in the raw list is Apple's Eddy.
   */
  const voiceHost = body.querySelector<HTMLElement>('[data-c="voiceName"]')!;
  let voicePick: ReturnType<typeof pick> | null = null;
  const buildVoices = () => {
    if (voicePick?.isOpen()) return;
    voicePick?.dispose();
    voiceHost.innerHTML = '';
    const list = c.voice.voices();
    voicePick = pick({
      name: 'voiceName',
      search: list.length > 12,
      options: [{ value: '', label: 'AUTO', hint: 'like say' }, ...list.map((v) => ({ value: v.name, label: v.name, hint: v.lang }))],
      value: list.some((v) => v.name === getPref('voiceName')) ? getPref('voiceName') : '',
      onChange(v) { setPref('voiceName', v); c.voice.preview(); },
    });
    voiceHost.appendChild(voicePick.el);
    const preview = document.createElement('button');
    preview.type = 'button'; preview.className = 'chip'; preview.textContent = 'PREVIEW';
    preview.addEventListener('click', () => c.voice.preview());
    voiceHost.appendChild(preview);
  };
  buildVoices();
  const onVoices = () => buildVoices();
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', onVoices);

  /*
   * The ears. AUTO is whisper.cpp on the hub when the hub can, else the
   * browser; the line under it says which one the next word will use and,
   * when the hub cannot, why — the same words the hub gave.
   */
  const engineHint = body.querySelector<HTMLElement>('[data-engine-hint]')!;
  const paintEngine = () => {
    const { engine, hub } = c.voice.engine();
    const hubLine = hub.ready ? `HUB: WHISPER.CPP READY · ${(hub.model ?? '').toUpperCase()}` : `HUB: CANNOT TRANSCRIBE · ${hub.reason.toUpperCase()}`;
    engineHint.textContent = `NEXT LINE: ${engine === 'whisper' ? 'WHISPER ON THE HUB, WITH THE FLEET\'S NAMES IN ITS PROMPT; NOTHING LEAVES THE MACHINE' : 'THE BROWSER, WORDS AS YOU SPEAK, AUDIO TO GOOGLE OR APPLE'} · ${hubLine}`;
  };
  const voiceEngine = pick({
    name: 'voiceEngine',
    options: [
      { value: 'auto', label: 'AUTO', hint: 'hub if it can' },
      { value: 'whisper', label: 'WHISPER', hint: 'hub, whisper.cpp' },
      { value: 'browser', label: 'BROWSER', hint: 'web speech' },
    ],
    value: getPref('voiceEngine'),
    onChange(v) { setPref('voiceEngine', v as 'auto' | 'whisper' | 'browser'); paintEngine(); },
  });
  body.querySelector('[data-c="voiceEngine"]')!.appendChild(voiceEngine.el);
  const recheck = document.createElement('button');
  recheck.type = 'button'; recheck.className = 'chip'; recheck.textContent = 'RECHECK HUB';
  recheck.addEventListener('click', () => { void c.voice.refresh().then(paintEngine); });
  body.querySelector('[data-c="voiceEngine"]')!.appendChild(recheck);
  paintEngine();
  void c.voice.refresh().then(paintEngine);

  const hint = body.querySelector<HTMLElement>('[data-hidden-hint]')!;
  const paintHint = () => {
    const n = store.hiddenCount();
    hint.textContent = `OFF: THE FLEET — AGENTS ORCA LAUNCHED (A FINISHED ONE STAYS TEN MINUTES), PLUS ANY OTHER SESSION WHILE IT WORKS OR NEEDS YOU; IDLE AN HOUR, IT LEAVES · ON: EVERY SESSION THE COLLECTORS REPORT, DISMISSED ONES INCLUDED · ${n} HIDDEN NOW`;
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
  return { dispose() { disposePush(); recovery.dispose(); off(); fontDisplay.dispose(); fontMono.dispose(); color.dispose(); music.dispose(); showAll.dispose(); voiceReply.dispose(); voicePick?.dispose(); voiceEngine.dispose(); if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', onVoices); for (const t of capcom) t.dispose(); } };
}
