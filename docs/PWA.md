# Installable ORCA — the console as an app on your phone

**Date:** 2026-09-08
**Status:** implemented and verified (§6). One deployment step is still missing,
and it belongs to the operator, not to the code: serving the hub over https
(§3).

---

## 1. Why it could not be installed

The manifest, the icons and the standalone metas had been in place from the
start, and the hub already served `manifest.webmanifest` with the right type and
a cache policy designed for installs (`src/hub/server.ts`). Two things were
missing, and neither was the manifest:

**There was no service worker.** What was missing was startup without a network
and the receiver for notifications. A correction to the original diagnosis:
Chrome allows installing from the menu without a worker with `fetch` since
Chrome 108 on mobile and 112 on desktop; it is not correct to attribute getting
a mere shortcut to that absence alone.
[Source: Chrome](https://developer.chrome.com/blog/update-install-criteria).

**There was no secure context.** The hub listens on `http://0.0.0.0:4479`
(`src/hub/server.ts`), so from a phone you come in through the tailnet's or the
LAN's IP. That is neither `https` nor `localhost`, and outside a secure context
`navigator.serviceWorker` **does not exist**: it is not that the worker fails,
it is that the API is not there. Of the two, this is the one that rules —
without it the first one does not matter.

## 2. What there is now

### `public/sw.js` — the worker

Plain JavaScript in `public/`, no build step. Four strategies, and the decision
about which one applies lives in a pure function, `policy(pathname)`:

| Route | Strategy | Why |
|---|---|---|
| `/api`, `/ws`, `/mcp` | **never touched** | A real-time console serving a five-minute-old world out of a cache is worse than a console that is down: it looks like it works. |
| `/assets/*` | cache first, forever | They carry a hash in the name. They are immutable by construction. |
| `/`, `/index.html`, every navigation | **network first**, cache if there is no network | The index is what points at the hashed assets: it *is* the build. Serving it from cache would leave the console stuck on an old version, and would lie to the `hud/update.ts` sentinel, which reads it to know whether there is a new build. |
| fonts, icons, manifest, sfx, recovery | cache and revalidate in the background | Fixed names, they change little, and startup must not wait for them. |
| anything else | to the network, without storing | The hub answers with the index for every unknown route (SPA); caching by its url would store the same html under twenty keys. |

Three details that are not obvious, and that is why they are tested:

- **The index lives under a single key, `/`.** The sentinel requests it as
  `/?update=…` every minute and a navigation can arrive on any route; they are
  the same document and they share an entry.
- **The precache reads the index.** On `install` the shell is stored (html,
  fonts, icons, recovery) plus the `/assets/*` **that the served index names**,
  instead of a list of hashes that would have to be regenerated on every build —
  a list like that goes stale the day someone builds without remembering.
  Without that step, the first offline startup would have the html cached and
  not its javascript.
- **A 502 does not beat the stored shell.** It is the most frequent case, not an
  edge one: `tailscale serve` outlives ORCA because it lives in tailscaled, so
  with the laptop asleep or the hub stopped, opening the installed app does not
  give a network error — it gives a 502 from the proxy, with Tailscale's page.
  The index goes to the network first, but if what comes back is useless, the
  stored copy wins. With no copy, the error is shown as is: better a real error
  than a blank screen.
- **The asset cache is pruned.** Every build leaves its own with a new hash; on
  activation, whatever the live index no longer names is deleted. Without that
  the cache grows build after build on a phone that never empties it.

### `src/ui/pwa.ts` — registration

Only in production (in development a cache in front turns "I edit and reload"
into "I edit and see the old thing"; besides, the dev server is another port,
4478, and therefore another origin) and only where the API exists. In
development it also unregisters any worker that might have been left behind.

### The changeover: the console still does not reload itself

That is `hud/update.ts`'s doctrine and the worker does not break it. **There is
no `skipWaiting()` in `install`**: the new worker waits, the UPDATE AVAILABLE
pill lights up, and the click — which already flushed drafts — sends
`orca:activate`, waits for the changeover (capped at 1.5 s) and then reloads.
Without that wait the reload would be served by the old worker with the old
cache, and the button would need a second click to do anything.

### The manifest

Added `launch_handler: { client_mode: "focus-existing" }`: tapping the icon with
the app already open returns to it instead of opening a second instance with its
second websocket against the hub.

## 3. How it is served: startup does it

The hub is on `0.0.0.0:4479` over http. `tailscale serve --bg 4479` publishes
that same port over https with a real certificate inside the tailnet, and with
that there is a secure context: the worker registers, Chrome offers to install
and the websocket moves up to `wss://` by itself (`net/client.ts` picks the
scheme from `location.protocol`).

A command you have to remember to type after every restart is a command that one
day does not get typed, so **startup runs it** (`src/hub/tailscale.ts`, called
from `src/orca.ts`). Three things it is not:

- **It does not open anything new.** `serve` is not `funnel`: it does not go out
  to the internet. And the tailnet already reached 4479 over http, because the
  hub listens on `0.0.0.0`. The only thing that changes is that there is now TLS
  and a name too. That is why it can be on by default without being an
  operator's decision: it does not widen the surface, it encrypts it. Turn it
  off with `ORCA_TAILSCALE=0`.
- **It does not stomp on anything.** If the node's 443 already serves something
  else, it is left as it is and said in one line. And if it already points at
  the hub's port it is not run again — under `tsx watch` the hub restarts every
  time someone touches `src/hub/*`.
- **It does not take startup down.** With no tailscale, with the backend
  stopped, without Serve enabled in the tailnet, or with a command that fails,
  the hub carries on and the console stays reachable over http as always. The
  reason is printed exactly as tailscale gives it.

It goes in `src/orca.ts` and **not** in `startHub()`: startHub is brought up by
dozens of suites and by the visual harness, and none of them has any business
touching anyone's tailnet.

### Who owns what

What it leaves in place **outlives ORCA**: `--bg` lives in tailscaled's state,
not in this process. Tailscale's documentation says so: on restarting the
machine, or after `tailscale down` / `up`, "Serve automatically resumes sharing"
([KB 1242](https://tailscale.com/kb/1242/tailscale-serve)). That is, opening
Tailscale on the Mac already leaves the url standing, with ORCA up or not.

What ORCA's startup does is not create it every time: it is to **make sure of
it**. If it is already there, it touches nothing; if someone removed it, it puts
it back. And with the url standing but ORCA stopped, what answers is a 502 from
the proxy — hence the point in §2, which is what makes the installed app start
anyway.

It is removed with `tailscale serve --https=443 off`. Withdrawing it on exit
would be worse: it would be dozens of reconfigurations a day under `tsx watch`.

### Verified on the real tailnet (2026-09-08)

The first attempt down this path failed with `Serve is not enabled on your
tailnet.` — hence the code printing the reason as is and adding where it gets
enabled — and the second, without touching the code, worked. What was left
served:

```
https://<mac>.<tailnet>.ts.net/  →  proxy http://127.0.0.1:4479
```

Checked end to end against that url with the build the hub serves: secure
context (`isSecureContext`), `navigator.serviceWorker` exists, the worker
**controls the page**, the caches end up populated (9 shell entries, 2 asset
entries), `pushManager` available — which is what §5's push needs — and the
console **links up with the hub**, with no handshake. That is: genuinely
installable, not in theory.

The `serve` timeout is 30 s for exactly this reason: the first time a name is
published, tailscaled issues the TLS certificate. The two `status` calls are
local reads and stay at 5 s.

## 4. How it is installed, and the token

The token deliberately does not travel in the manifest: `start_url` is `/`, and
the token lives in the origin's `localStorage` from the first visit with `?k=`
(`net/client.ts`). The practical consequence is the order of the steps:

1. On the phone, open **once**
   `https://<mac>.<tailnet>.ts.net/?k=<token>` — the one in `~/.orca/token`.
2. When the console starts (that is: when the handshake closes), install:
   Chrome → menu → **Install app**. iOS Safari → share → **Add to Home Screen**.

Once installed, the app inherits that `localStorage` and starts up linked.
Installing **before** entering the token leaves the app on a handshake that
never ends, with no way to type it in: `ui/handshake.ts` has no field, and that
is deliberate — the token is not a password the operator knows by heart — so the
way out is to open the url with `?k=` in the browser again.

Changing origin (from the IP to the tailnet name, or the other way round) means
changing `localStorage`: you have to repeat the `?k=` once per origin.

## 5. Push, screen and devices — 2026-09-08 extension

**Notifications implemented.** SETTINGS → THIS DEVICE → ENABLE PUSH asks for
permission from the click and subscribes this device. DISABLE PUSH removes the
registration from the hub and cancels the browser's subscription. On iPhone/iPad
you have to open the app from the home screen; permission requires a direct
interaction. [Source: WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

The hub generates VAPID keys on the first authenticated access to `/api/push`
and stores keys, subscriptions and notified waits in `~/.orca/push.json`
(`ORCA_HOME` if it is defined), mode 0600, with atomic replacement. Keep this
file when migrating the hub: the subscriptions belong to those keys. Optionally,
`ORCA_VAPID_SUBJECT=mailto:operador@tu-dominio` sets the VAPID contact; the
local default value is `https://orca.local`. No Firebase account is needed and
the hub does not have to be exposed to the Internet: it does need HTTPS egress
to the push services.

The API uses the existing authentication on GET/POST/DELETE, requires JSON for
mutations, caps at 32 devices and validates Chrome/Firefox/Safari/Windows
endpoints to stop it becoming a proxy to arbitrary URLs. 404/410 remove expired
subscriptions. An existing subscription is reconciled when the link comes back
or settings are opened, without asking for permission again.

A new wait of type permission/question/error produces a push; waits between
agents, idle agents and synthetic machines do not. While CAPCOM is handling an
escalation the human is not notified: it waits for `pending`. Waits are grouped
in two-second windows, outside the patch publication, and `agentId +
block.since` is remembered across restarts.
The notice is generic, with no prompts, repositories or token, lasts at most
five minutes in the push service and opens the queue in the existing window or
in a new one.
A visible notification is always shown, even with an empty or invalid payload.
Arrival depends on the provider and the operating system; a send error is logged
without blocking the world. Guaranteed delivery is not promised.

**Wake lock implemented.** KEEP AWAKE is on by default, only for the installed
and visible app. It can be turned off in settings. Hiding the app releases it;
coming back requests it again, without duplicating requests or holding on to a
grant that arrives after it was hidden. The system may deny it for battery
reasons and the console keeps working.
[Source: MDN](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).

**Free orientation.** `orientation: "any"` allows using the Fold closed, open or
landscape; the manifest does not force a rotation. The physical review on a Fold
is still pending: a viewport emulation does not test hinges or the OS.

**Install screenshots.** Two synthetic views of the field, one narrow and one
wide, are generated with `npx tsx test/pwa.shots.ts --isolated` and published in
`public/screenshots/`. They contain no data from the real fleet. The same
harness checks settings at both sizes and subscribe/unsubscribe with a simulated
push transport.

**Cache quota.** Still no explicit budget; quota failures do not break the
console and assets from previous builds are pruned.

## 6. Verification

### Push and devices extension

- `npm run typecheck`: clean.
- `npm test -- --changed`: **921/921 checks, 73 suites**, including the changes
  that were already in the tree before this delivery.
- `npm test -- push sw update wake-lock`: **33/33** in the specific run; the
  push suite covers the authenticated API, persistence, the device limit,
  deduplication and removal on 410. The final run also checks that the hub's
  timer dispatches a new wait to a simulated transport.
- `npm run build`: fine; Vite warns that the main chunk is larger than 500 kB.
- `npm run visual -- mobile --isolated`: two screenshots, field and window, with
  no skips in the final run. The harness now passes its token and selects all
  the synthetic fleet's origins; the default filter was hiding its agents.
- `npx tsx test/pwa.shots.ts --isolated`: wide/narrow settings, install
  screenshots and subscribe/unsubscribe with a simulated transport, all fine.
  The screenshots were inspected and the overlap of the PUSH label on a narrow
  screen was fixed. On closing this harness an ENOENT warning about its
  temporary directory appeared: its cleanup happens before the hub finishes
  flushing. It is not evidence of a persistence failure in the production hub.
- `npx tsx test/pwa.production.ts`: the real build's worker controlling the
  page, the push handler's payload, manifest/screenshots with the right
  dimensions and deep navigation offline, all fine. **The native notification
  was not verified**: the automation browser refused `showNotification` for lack
  of permission, even with permission configured in the test context. The test
  declares it `UNVERIFIED`; no external push was sent.

The selector warns about files with no suite by imports: among this delivery's
are the manifest, images, entries and UI controls, visual scripts and docs.
The worker does have tests that read the real file even though the graph does
not detect that read. The controls and the screenshots were covered by the
earlier harnesses; the documentation has no automatic tests. Installing and
receiving a real push on the Fold, checking its physical rotation and testing
iOS are all still pending.

### Earlier verification of the offline shell


```
npm run typecheck                     clean
npm test -- sw                        19/19
npm test -- tailscale                 9/9
npm test -- --changed                 930/930
```

`test/sw.test.ts` loads **the real `public/sw.js`** — the same file the hub
serves — with a fake `self`, a fake `caches` and a fake `fetch`. Copying its
logic into a test module would have left the copy passing and the original doing
something else. It covers, in order of severity: that the hub is never cached
(`/api`, `/ws`, `/mcp`, and that neither POST nor another origin goes through
the worker); that with no network a navigation — including to a deep route —
returns the stored index and the assets come from cache; that the index has a
single key and prefers the network; that a hashed asset is downloaded once; the
pruning, both of orphans and of a previous worker's caches; and that the
changeover does not happen without the order.

### In a real browser

Registration (`src/ui/pwa.ts`) cannot be tested by the runner: it depends on
`navigator.serviceWorker`, which does not exist in Node. It was checked by hand
with the production build served on `127.0.0.1` — localhost **is** a secure
context, so https was not needed for this — and Chromium via Playwright:

- The worker registers and **controls the page on the first visit**
  (`navigator.serviceWorker.controller !== null`).
- The precache ends up with the whole shell in `orca-shell-v1` (`/`, both fonts,
  the three icons, manifest, recovery) and in `orca-assets-v1` exactly the two
  `/assets/*` of the served build, read from the index.
- Cutting the server and navigating to a deep route (`/agent/K9`): the response
  is a 200 with the build's index, the module **runs** and the console paints
  its field with the handshake on top, which is correct with no hub. Before,
  that was the browser's error page.

### Startup, against the real tailscale

`test/tailscale.test.ts` tests the decisions with a fake executor — that it does
not serve twice, that it does not stomp on someone else's config, that an absent
or stopped tailscale breaks nothing, that `ORCA_TAILSCALE=0` does not run a
single command. On top of that, a real ORCA was brought up, with its own
`ORCA_HOME` and on port 4491 so as not to touch the live hub: the attempt
happens, it fails for the reason in §3, it prints the two lines and startup
carries on with its usual banner.

**What is still unchecked outside the unit test:** the full changeover cycle
with two real builds (that the pill lights up because of the worker and that
`activatePending` reloads with the new one), `serve` finishing successfully —
that needs §3's switch — and Chrome Android's install prompt.

## 7. Filters that cover this delivery

```
npm test -- sw update push wake-lock tailscale
npx tsx test/pwa.shots.ts --isolated
npm run visual -- mobile --isolated
npm run build && npx tsx test/pwa.production.ts
```
