# Remote access

ORCA is reached from another device over **Tailscale**, not over a public
tunnel. This document says why that choice was made, what changed in the hub to
support it and how the console is opened from a phone.

## Why Tailscale and not a tunnel

The architecture invites a tunnel: collectors dial outward and only the hub
needs a port, so a `cloudflared` in front of `localhost:4479` would be enough to
get a domain and TLS without opening the router. The problem is what it does to
the authentication model.

The hub has a deliberate back door: with no `ORCA_TOKEN` configured, it accepts
loopback connections without a credential, because on a development machine "it
comes from 127.0.0.1" means "the owner typed it". A proxy on the same machine
breaks that equivalence: `cloudflared` connects to the hub from 127.0.0.1, so
**the entire internet arrives as local**. With no further defenses, putting a
tunnel in front publishes `/mcp` — launching agents, messaging them, killing
them — and `/api/file` — the repos, the scratchpad, `~/.orca` — without a single
error in the log.

Tailscale does not have that problem, and not by luck: connections arrive from
`100.x.x.x`, `isLoopback()` returns false and the hub demands a token all by
itself. The difference that matters is not how much each option protects when
configured well, but what happens when something is forgotten. With the tailnet,
a slip opens nothing; with the tunnel, a slip opens everything.

## What changed in the hub

1. **The local door only exists if the door is local.** `createAuth()` receives
   the listening interface, and `allowLoopbackAnonymous` requires, on top of
   having neither `ORCA_TOKEN` nor `ORCA_STRICT_AUTH`, that the hub listen only
   on loopback. Listening on `0.0.0.0` means a token is asked of everyone,
   localhost included. With no host information it is assumed to be exposed:
   whoever does not say where they listen cannot ask to be presumed safe.

2. **A proxy header revokes the local pass.** `remoteOf()` looks at
   `cf-connecting-ip`, `x-real-ip` and `x-forwarded-for`. If any of them shows
   up, the other end of the socket is an intermediary and not the client: with
   `ORCA_TRUST_PROXY=1` the hub believes the address it declares, and without it
   the request stops counting as local. That way, putting up a tunnel without
   configuring it fails closed instead of opening up silently.

3. **`/api/world`, `/api/traffic` and `/api/memory` require a token.** They were
   public. `traffic` is the literal content of what the agents say to each other
   and `memory` is what the CEO has been storing.

4. **`/api/health` without a token answers the posture and nothing else**: `ok`,
   `protocol`, `harness`, `capcom` and the machine count. It is what
   `hubPosture()` reads in order to refuse to touch a real hub — the protection
   that stops the visual harness from taking down a real CAPCOM — so it has to
   come out without a credential. What no longer comes out without a token are
   hostnames, machine ids, projects and costs.

5. **The collector finds the token on its own.** It used to send
   `ORCA_TOKEN ?? ''` and live off the anonymous door; now it uses
   `sharedToken()` (`src/shared/token.ts`), which falls back to `~/.orca/token`
   just as `bin/orca.mjs` and `bin/orca-recover.mjs` already did. Without this,
   closing the door left the fleet locked out of its own machine: alive in tmux,
   invisible in the console.

## Opening the console from another device

The hub listens on `0.0.0.0` and serves `dist/`, so the built console is
reachable from the tailnet with nothing to configure:

```
http://<mac>.<tailnet>.ts.net:4479/?k=$(cat ~/.orca/token)
```

The `?k=` is only needed the first time: the console stores it in
`localStorage`.

Vite is another matter. It stays on `127.0.0.1:4478` on purpose, and that is why
from a phone there is nothing on that port. To look at the console **in
development** from another device:

```
ORCA_UI_HOST=100.x.y.z npm run dev:ui     # the tailnet only
ORCA_UI_HOST=0.0.0.0       npm run dev:ui     # the café wifi too
```

Vite does not restart when `vite.config.ts` changes: you have to relaunch
`dev:ui`. `allowedHosts: ['.ts.net']` is there so MagicDNS names do not collide
with the DNS rebinding protection, which returns a blank page and explains why
only in the terminal.

## If a tunnel is ever needed

To open the console on somebody else's machine — with no Tailscale client — the
option is Cloudflare Tunnel **with Access in front**, never on its own: Access
authenticates before the request reaches the hub. And with the tunnel you have
to decide about `ORCA_TRUST_PROXY=1`: without it every proxied request demands a
token, which is the right thing; with it the hub believes the declared IP, and
then the only defense is that nobody else can talk to that port.

## Tests

```
npm test -- remote-access hub files
```

`test/remote-access.test.ts` covers the door according to the listening
interface, failing closed when no host is declared, that a tailnet IP does not
count as local and — bringing up a hub with the door open — that a proxy header
turns a 200 into a 401. `test/hub.test.ts` covers that `/api/world`,
`/api/traffic` and `/api/memory` answer 401 without a token and that
`/api/health` without a token keeps `harness` and `capcom` without publishing
the fleet.
