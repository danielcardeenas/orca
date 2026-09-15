# On-disk retention

ORCA separates disposable telemetry from working data. FLEET's visual cleanup
does not delete files. Claude/Codex transcripts are never deleted.

| File | Automatic policy |
| --- | --- |
| `~/.orca/history.jsonl` | Up to 24 hours, 6,000 snapshots and 250,000 agent×snapshot entries in memory. File capped at 32 MiB after every flush; compaction every hour and at startup when needed. |
| `~/.orca/hub/events/YYYY-MM-DD.jsonl` | 14 UTC dates, including the current one. At most 8 MiB per daily file after every flush. |
| `~/.orca/hub/overflow/YYYY-MM-DD.jsonl` | Same policy as events. |
| `~/.orca/hub/tasks.json` | Durable state of per-task conversations; keeps the TaskStore's own limits. Not deleted by age. |
| `~/.orca/hub/archived.jsonl` | Tombstones of agents archived by hand (`archive_agents`, ARCHIVE FINISHED, `orca archive`). Append-only; a later `undo` lifts the tombstone. At startup the tail is read (2 MiB, up to 5,000 live tombstones). Not deleted by age: it holds for as long as the transcript the collector would keep resending exists. |
| `ceo.jsonl`, `escalations.jsonl`, memories, configuration and results | Outside telemetry deletion. They get no new global limit from this policy. |

The daily logs are reviewed at startup, on write and every six hours. Expired
files are deleted; files that are too large keep their recent tail of complete
records, leaving room for new entries. The timeline is replaced atomically from
its ring. Because of the size limit there may be less than 24 hours available
after a restart on a large fleet. These are ceilings for the telemetry files
after maintenance, not a global limit for all of `~/.orca`; during the
replacement there is also a temporary file.

Appends and compactions share a queue so that a replacement does not erase recent
writes. Startup reads read a bounded tail straight from the file, without loading
a whole JSONL before trimming it. Writes are still batched every 500 ms; the
timeline normally captures every 20 seconds and groups rapid marks at minimum
intervals of five seconds.

## Archiving finished agents

Decision (2026-09-06): **archive with a tombstone, do not delete.** The hub does
not persist agents — it rebuilds them from each collector's snapshot, which also
resends the `done`/`dead` ones while their transcript is still on disk — so "mark
as archived and hide" had nowhere to live: the record is evicted from the world
just as in the one-hour retention and what gets persisted is the tombstone (`id`,
callsign, project, squad, state, when it finished, who archived it). With it the
world rejects the agent when the collector sends it finished again, and readmits
it — lifting the tombstone — if it comes back alive, because a resumed session is
an agent. Nothing is deleted on disk: not the transcript, not the event log, not
the timeline. A finished parent with live children is not archived (the lineage is
preserved, the same rule as in retention). Squads have no record: one whose last
member is archived disappears on its own, and the operation reports it as
`squads_retired`.

## Deleting transcripts (2026-09-07)

Archiving does not free space: it removes from view and leaves a tombstone of a
few hundred bytes. What takes up room are the transcripts, which are not ORCA's —
they are written by the CLI in `~/.claude/projects` and `~/.codex/sessions` — and
they are the record of why the repository ended up as it did.

`orca purge-transcripts` (the `purge_transcripts` tool) deletes them, and it is
the only part of the whole cleanup that cannot be undone. That is why it takes
**two deliberate steps**: it only reaches what has already been archived, so it
has to be retired first; and without `--yes` it counts and measures without
touching anything. The collector, which is the one that has the files, refuses to
delete the transcript of a live session or one it does not know, and it never
derives a path from an id: the only one it deletes is the one it already had on
record for that agent.

Once the file is deleted, its tombstone is retired: it no longer rejects
anything, because nobody is going to resend that agent. That is the **only**
reason a tombstone is retired without the agent coming back alive. A more
ambitious rule was attempted — drop the tombstone when the collector stops naming
the agent — and it is false: the collector recycles what has finished within
seconds and stops reporting it with the transcript intact. Tested against the real
installation, it dropped good tombstones and the agents reappeared, which is
exactly what the tombstone prevents.

The parameters are in `StoreOptions` (`retentionDays`, `maxDailyBytes`) and
`HistoryOptions` (`retentionMs`, `maxFileBytes`, `maxSnapshots`, `maxEntries`).
The values above are the defaults. No manual command needs to be run to turn on
the cleanup with an updated hub.

Measurement from 2026-09-06: roughly 13 MiB in `~/.orca`, about 10 MiB of
timeline, 1.6 MiB of events and 0.65 MiB of overflow. The observed volume was not
urgent; the limits prevent later growth. The tests in `test/retention.test.ts`
cover deletion by age, the size limit, preservation of conversations, partial
reads and simultaneous appends with compaction. `test/transcript-purge.test.ts`
covers the deletion and, above all, what it refuses to delete;
`test/archive.test.ts` covers that the collector's silence does not retire a
tombstone and that the deletion does.
