# CAPCOM recovery channel

Reload ORCA once to load the recovery listener. After that, a Vite error
overlay, failed script load, uncaught runtime error, or unhandled promise
rejection opens **CAPCOM · RECOVERY** above the console. It can be minimized
without dismissing the underlying error.

For manual access, open `/recovery.html` on the same ORCA host. This page
does not load the application. Both entry points use `public/recovery.js`,
a plain script with its own isolated styles and no application imports.
Vite copies these public files unchanged into the production build.

Write a request and press **Send to CAPCOM**. The visible error details are
attached to the message. Nothing is sent automatically. Replies appear in
the shared CAPCOM conversation, using the existing authenticated hub
connection and `ceo:say` protocol; this does not launch or switch agents.

Drop image files anywhere on the recovery panel, or use **Attach images**.
You can preview and remove up to four PNG, JPEG, WebP or GIF files, each up
to 8 MB. An image-only message is also supported. Files upload only when
you send, through the authenticated `POST /api/recovery-images` endpoint.
The hub checks size and file signatures and saves images with generated
names under `ORCA_HOME/recovery-images` (normally `~/.orca/recovery-images`).
Their absolute paths are included in the CAPCOM prompt so the agent can
open them with its image-reading tool. A CAPCOM on another machine needs
access to the hub's files; these are file references, not inline vision
inputs. Authenticated `/api/file?path=…` can serve the saved images.

Failed uploads or delivery receipts retain the selected images for retry.
Successfully uploaded files are reused during retries in the same page.
Reloading loses unsent image selections and asks for confirmation; text
drafts still survive reload. Saved files remain on the hub until manually
removed, including uploads from messages whose delivery failed.

Delivery receipts distinguish queued, accepted, delivered and failed
messages. Disconnects and timeouts leave the draft intact and warn that
delivery is uncertain. Check the conversation before sending again. Drafts
and the last error are kept in session storage for this browser tab;
successful delivery clears the unchanged draft. Private browsing may
prevent this storage.

**Reload console** returns to the application after a repair. The channel
requires the web server and hub to remain reachable, and a working CAPCOM
to perform repairs. If the hub is down, it reconnects with backoff and
explains that ORCA may need restarting from a terminal. It cannot repair a
stopped server or replenish an agent's credits on its own.

Validation: `npm run build`, `npm test -- recovery-images`, and
`node test/recovery.visual.mjs`. The latter
uses an isolated Vite server with a real TypeScript compile error and a
mock hub, without sending messages to the fleet. Screenshots are written
to `test/shots/recovery/`.
