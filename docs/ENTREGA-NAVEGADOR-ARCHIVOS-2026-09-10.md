# A file browser with vim keys, from a project's menu

What the operator asked for: "a vim-style file browser that opens as a
window, reachable by right-clicking a project." This is that, and the
decisions that had to be made along the way.

## What's there

Right-click on a project in the field: the menu carries a new row,
**BROWSE FILES** (`b`), right below OPEN PROJECT. It opens a window of the
`files` class (`src/ui/windows/kinds/files.ts`) over the project's folder
on disk: a column of names, folders first, a cursor, and a footer with the
keys. One window per project: asking for it again returns to the same one.

The keys, with the window active and nobody typing:

| key | does |
|---|---|
| `j` `k` ↓ ↑ | move the cursor |
| `l` ↵ → | enter the folder, or open the file |
| `h` ← | go up a folder |
| `gg` `G` | start, end |
| `^d` `^u` | half page |
| `/` | filter the folder by name; ↵ keeps the filter, Esc clears it |
| `q` | close |

Opening a file is the usual viewer (`kinds/file.ts`), in its own window and
in front of the browser, with the project's code in its header. The
browser doesn't edit anything: it's a place to look at a repo while the
agents work on it, and its own header says so.

## Decisions

**Esc doesn't close; `q` does.** The brief proposed `q` or Esc. In ORCA,
Esc belongs to the window manager — it returns a window that's in front
back to the canvas, closes one that's on the canvas — and taking it away
from a single class would be an exception nobody would remember. `q`
always closes; Esc does what it does everywhere.

**The root is a wall, twice.** `file-nav.ts` never builds a path above
`root`: `h` at the root returns `blocked` and the console says so ("AT THE
PROJECT ROOT"). And the hub contains it all again on its own: `/api/dir`
goes through the same `containPath` as `/api/file` (lexical path with no
`..` against the roots, then `realpath` against the real roots), so a
`..`, a folder outside, or a symlink pointing outside all come back 403
even if the console asked for them. What `privatePath` excludes — `.git`,
`.env`, keys — doesn't show up in the listing, because a name that can't
be opened is a row that lies. A symlink inside the project pointing
outside is listed as `other` ("NOT SERVED", struck through): you see it's
there, you don't get in.

**Only the hub's own disk.** A project on another machine
(docs/FLEET-MULTI-MAC.md) gives 404/403 and the window says so with the
same phrase as the viewer; the hub serves what's underneath it, not what
it sees over the socket.

**Keys with a button are dispatched by wm.ts.** UP, OPEN, and FIND carry
`data-key` (`h`, `l ↵`, `/`) like any ORCA button, with its keycap
rendered. The ones without a button (`j`, `k`, `gg`, `G`, `q`, `^d`, `^u`,
arrows) are listened for by the window in the capture phase — before
main.ts hands `/` to the command line and `j` to the field — and only with
focus, outside the tray, and with no text field active. UP and OPEN are
never disabled: a disabled button would swallow `h` and `l` silently, and
the footnote is the answer.

## What changed

- `src/hub/files.ts` — `containPath` (the usual containment, now shared),
  `resolveServedDir`, `DirEntry`, `MAX_DIR_ENTRIES` (2000, with
  `truncated`).
- `src/hub/server.ts` — `GET /api/dir?path=`, `servedRoots()` and
  `fileGate()` shared with `/api/file`.
- `src/shared/gestures.ts` — `files` in `WIN_KINDS`.
- `src/ui/windows/file-nav.ts` — new: the state and the keys, no DOM.
- `src/ui/windows/kinds/files.ts` — new: the window.
- `src/ui/windows/kinds/file.ts` — `refusal` exported.
- `src/ui/windows/wm.ts` — `keyToken` exported; default size for `files`.
- `src/ui/console.ts`, `src/ui/main.ts` — `openFiles(projectId)`,
  `openFile` accepts `project`, `__orca.openFiles(root)` hook for the
  harness.
- `src/ui/hud/context.ts` — BROWSE FILES in the project menu.
- `src/ui/styles/window.css` — `fb__*` block.
- `test/file-browser.test.ts`, `test/file-browser.fixture.ts`,
  `test/file-browser.shots.ts` — new.

## Verification

```
npm run typecheck                       clean
npm test -- file-browser                7/7
npm test -- --changed                   979/979
npx tsx test/file-browser.shots.ts      ok · test/shots/file-browser-0{1,2,3}.png
```

`file-browser` covers navigation without DOM, listing and the hub's
containment (`..`, outside, symlink outside, a file instead of a folder,
no token), and the window in Chromium with the keys against the real
window manager and the menu row. The visual harness does the same with
main.ts in front of the keyboard and the hub serving this repo via
`ORCA_FILE_ROOTS`.

`--changed` flags `src/ui/main.ts` and `window.css` with no suite: the
hook and `openFiles` in main.ts are exercised by the visual harness, and
the CSS is loaded in `file-browser`'s Chromium test.

Filters covering this delivery: `file-browser`, `files`.
Visual harness: `npx tsx test/file-browser.shots.ts`.
