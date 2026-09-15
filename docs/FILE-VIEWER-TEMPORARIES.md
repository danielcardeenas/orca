# Temporaries in the file viewer

Local verification: 2026-09-06, hub user UID 501. Names and metadata were
inspected, without opening the contents of any existing temporaries.

## Paths covered

- `/private/tmp/claude-501` exists, belongs to UID 501 and has mode 0700.
  `/tmp/claude-501` is its real alias through `/tmp -> /private/tmp`.
- `$TMPDIR/claude-501` is accepted when it exists as a directory belonging to
  the hub user and is not a symlink. The observed TMPDIR is
  `/var/folders/z0/hnljtxdx78jchvhd9srjfsdw0000gn/T/`, whose canonical form is
  `/private/var/folders/z0/hnljtxdx78jchvhd9srjfsdw0000gn/T/`.
  No `claude-501` was found there during the inspection.
- The authorized roots accept their declared path, their `realpath` and their
  macOS `/tmp` and `/var` aliases, only when they are verified to resolve to the
  same root.
- Projects and the explicit roots from `ORCA_FILE_ROOTS` remain available. An
  entry can be one specific file: it does not authorize its siblings.

No other automatic root was added: the inspection did not justify one.
`/private/temp` does not exist and is not invented as an alias. The
`/private/tmp/claude-mcp-browser-bridge-danielcardenas` directory and the
`com.anthropic.claudefordesktop.ShipIt.*` directories in TMPDIR are not taken
in.

## Limits

Not accepted as roots: `/private`, `/var`, `/private/var`, `/tmp`,
`/private/tmp`, `/private/temp`, `/var/tmp`, `/private/var/tmp`, the whole
TMPDIR, or the containers under `/var/folders` and `/private/var/folders`.
The same validation is applied after resolving symlinks in the roots.

Containment by `realpath`, a regular file and ownership by the hub user are
required, both on the existing root and on the file (on systems with UIDs).
`claude-<another UID>` scratchpads, escaping symlinks, directories, FIFOs and
other special files are rejected. The 16 MiB limit is kept.

Known private names are excluded before and after `realpath`:
`.ssh`, `.aws`, `.azure`, `.config`, `.gnupg`, `.kube`, `.claude`, `.codex`,
`.docker`, `.git`, `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.claude.json`,
`credentials`, `secret`/`secrets` with their extensions, known SSH keys,
PEM/KEY/P12/PFX/keychain files, `.orca/token`, `.orca/config*` and `/etc`,
including its `/private/etc` alias. This policy also applies to projects and to
explicit authorizations. It does not inspect contents and does not detect
arbitrarily renamed secrets: only reviewed artifacts should be authorized.

HTML and SVG keep the `sandbox` CSP; the transport keeps `nosniff`, `no-store`,
HEAD and ranges for media. Neither the linkifier nor the viewer was modified.

## Activation

1. Pick these changes up on the hub's next authorized start. This task did not
   restart the real hub or the real collector.
2. Keep `ORCA_STRICT_AUTH=1` or a configured `ORCA_TOKEN`, and connect the
   console with that token. The endpoint keeps the existing authentication
   policy: without either variable, development mode allows loopback with no
   token.
3. Your own scratchpad roots are checked on every request, with no configuration
   to add. For a single reviewed artifact, set for example
   `ORCA_FILE_ROOTS=/private/tmp/entrega-revisada.png`, or one specific reviewed
   subfolder, in the environment of the next start. Do not authorize the
   temporary parent. Entries are separated with `:`; preserve the relevant
   previous authorizations.
4. Open the linkified path in the authenticated console.

## Reproducible evidence

```sh
ORCA_HOME=$(mktemp -d /tmp/orca-task02-hub-XXXXXX) npm test -- files
```

Result: **34/34**. Test hub on loopback and a free port, synthetic token, hub
storage separated by `ORCA_HOME`, and fixtures with unique names. It covers
declared/canonical paths, macOS's real reverse alias, the TMPDIR scratchpad,
single-file authorization, text, PNG, HTML/CSP, HEAD, audio/video by Range, 401
with no token or a wrong one, 403 for private paths/escapes/another user, 404
for FIFO/directory/missing, and 413 for size.
Media uses synthetic bytes to verify the HTTP contract; it does not attest to
audiovisual decoding or to a visual review in a browser.
No fixtures or pre-existing files are deleted.

`npm run typecheck`: **clean on the final check**. An earlier pass found hygiene
errors from shared editing (`estimated`/`Confidence`), reported to the team and
already gone by the time the task closed.
