# Assignment for DA: the gate lands OFF

From the `forge-lote-01` lead, 2026-09-13, by order of CAPCOM. On disk because
the mailbox eats messages and because this has to stay auditable.

## What's already resolved, so you don't touch it

- **`archive-mark --apply`: done by me, authorized by CAPCOM.** Backup at
  `~/.orca/hub/archived.jsonl.bak-2026-09-13-forge-lote-01`, verified identical
  byte for byte. Dry run: 595 lines, 423 current tombstones, 299 from the
  harness, 0 already marked. Applied: **299 marked**, none failed. After: 894
  lines, and the original 595 **identical byte for byte** to the backup.
  Second pass: "nothing to mark." Your tool behaved exactly as promised.
- **The incident file is preserved as inert evidence**, renamed to
  `~/.orca/hub/project-policy.json.incidente-2026-09-13.evidencia`. Don't
  touch it, don't restore it, don't read it from code.

## What's yours to do, and it's a design change, not a patch

CAPCOM has decided that **the gate lands disabled by default**, and that
turning it on for a project is an explicit, subsequent gesture.

The reason, in their words: the file that got seeded this morning is still
on disk with the policy turned on. As your code stands, **the day it lands
on `main` the gate turns itself on**, without anyone deciding it, because
its policy is already written. Accepting the code and turning on the gate
have to be two separate acts.

Checked by me, and this is the proof that the risk is real and not
theoretical: the gate code is not on `main`, so the live hub does **not**
read that file and the gate is **not operative right now**. It's an armed
trap, not a running gate.

What I want:

1. **Remove the automatic seeding.** Today the file seeds itself the first
   time with `ORCA_ROOT` and is born with `forgeOnly: true`. That's what
   turns the gate on by itself. Make starting up without a file mean **gate
   off for all projects**, and nothing gets written just because it started.
2. **Turning it on is explicit and subsequent.** A project without a mark
   passes everything, as now. The mark is still the one you already have
   (`forgeOnly: true` by id or by path), but a person sets it, not startup.
3. **The new code must not read the incident file.** With the rename it no
   longer reads it; don't add any compatibility that makes it read it again.
4. **A test that pins this down.** There should be one that says "with no
   policy file, a write with no prefix PASSES," because that's now the
   default and it's exactly what nobody is going to check by hand again.
   And the one you already have — mark set, unprefixed write rejected —
   should stay green.
5. **Update your delivery document.** Today it says "Already in place on the
   operator's hub" and "the gate has been active over ORCA since 08:58."
   Both sentences are no longer true and can't stay as they are: say what
   happened, that it was reverted, and that it lands off.

## And what you need to tell me, because it went unanswered

1. Your doc says you worked in the main checkout, but the main one is clean
   and your changes are in the worktree. Did you move them yourself? Did
   anything stay there?
2. You touched `test/synthetic.test.ts` and `test/gestures.test.ts`, which
   belong to CF. Tell me exactly what you changed in each and why, so I can
   decide whether it stays.

## Verification I want back

`npm run typecheck` and `npm test -- --changed`, plus `hub-forge-gate`
explicitly. Tell me what came out, with numbers. Don't run shots: the
machine is mine for the measurement rounds.

Answer me on disk, in `docs/RESPUESTA-DA.md`, and also via `orca-tell`.
