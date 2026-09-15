# The handshake that never ends

With a token the hub does not accept, the console celebrated.

The socket opened —opening a socket needs no permission—, the console took the
link as good right there, sent the `hello`, and the hub closed. Retry, socket
open, "LINK UP" again: the full-screen lime flash the console reserves for a
fleet coming up, and its sound, every few seconds and forever. The operator
watched the console cheering non-stop while looking at a frozen world, and
nowhere did it say "your token is not valid".

Two fixes, one underneath the other.

## The link is declared when the hub answers

`store.setLink(true)` was in `ws.onopen`, which is before anyone has told you who
you are. Now it is in `handle()`: the first frame that arrives from the hub is
the proof that there is a link **and** that the token was valid, because there is
no other way to receive one. An open socket that closes immediately is no longer
a link, so there is no flash, no sound and no cycle.

The same place sets `setAuth(true)`. A close with `CLOSE_UNAUTHORIZED` sets
`setAuth(false)`. The close codes now live in `shared/protocol.ts` — hub and
console agree on them, and the console cannot import anything from the hub;
`hub/auth.ts` re-exports them for whoever was already asking it for them.

A dropped link and a rejected token are two different conditions and they are
looked at differently: the network comes back on its own and the world already on
screen is still the last known truth, whereas a token is not fixed by waiting.

## The screen

With the token rejected, the console retreats behind the boot's handshake beat:
the same label, the same eight blocks, the same classes (`ui/handshake.ts`, `pass`
scene from `boot.ts`). With the difference that is the whole message: it **does
not complete**. At boot the eight blocks give way to the lime sweep that says
"accepted"; here they go out and start over. A handshake that does not close is
exactly what is happening.

- **No error text and no field.** It is not a login screen: nothing typed there
  fixes this —the token lives on the hub's disk and in the console's
  `localStorage`— and a box would promise a way out that does not exist. It does
  not say what failed either: someone looking at somebody else's console has no
  business finding out how this one authenticates.
- **You cannot type behind it.** The panel covers the screen and swallows the
  mouse; the keyboard is stopped by a capture listener on `window`, which runs
  before `main.ts`'s shortcuts. Without this there would be commands being typed
  against a link that does not exist.
- **It goes away by itself.** The client retries with backoff; as soon as the hub
  answers with a frame, the screen withdraws without ceremony.

## Verification

```sh
npm run typecheck
npm test -- --changed
```

No suite covers it, and that is said out loud: the behaviour lives in the DOM, in
gsap and in a real `WebSocket`, and this repo's tests are pure node. It was
checked by hand against a strict hub (`ORCA_STRICT_AUTH=1`) with Playwright, all
four paths:

- invalid token → the screen appears and cycles (8 blocks lit, off, start over);
- twelve seconds with that token → **zero** lime flashes (`[data-alarm-flash]`
  was sampled at 10 Hz and never rose above 0); before there was one per retry;
- a keystroke with the screen up → it does not reach `window` and opens nothing;
- the hub restarted accepting that token → the screen withdraws by itself and the
  console comes back.
