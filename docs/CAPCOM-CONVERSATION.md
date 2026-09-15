# CAPCOM's conversation

Two things about the CAPCOM window: the order in which a thread reads, and how
you move from one conversation to another. They were two different annoyances
with the same root — the window showed what it had, in the order it had it,
deciding nothing — and they are fixed here.

## The order of the thread

The transcript was never out of order. `mergeTalk` sorts by time and `foldTalk`
respects what it receives. What was out of place was the **local echo**: the
copy of your line that the console paints as soon as it sends it, with
`DELIVERED · 0.1s` underneath, while the CLI's transcript has not confirmed it
yet.

Two bugs, both in `src/ui/windows/kinds/ceo.ts` and `src/ui/windows/talk.ts`:

**They were painted at the end.** The thread was `groups` and then `echoes`, in
two passes. It made no difference when you typed: the echo went below
everything. Now the two sources are merged by time (`timeOrdered`), and an echo
sits at the minute you typed it, not at the foot of whatever CAPCOM has said
since. It holds the same for the general view and for a mission's.

**An echo could stay lit forever.** `echoLanded` compares exact text, and the text
does not always come back the same: the hub wraps some prompts and the CLI joins
whatever it had queued. An echo that is not recognized stays lit forever.
`pendingEchoes` adds a second rule: the CLI's input is a queue, so if something
you said **later** is already in the transcript, what came before went through
as well and its echo is surplus.

The rule is deliberately narrow. "Any newer prompt" will not do: a message of
yours in the queue gets written when its turn comes, and a later prompt from
somebody else — an escalation the hub relays, the startup brief — would clear
your echo precisely while it is waiting. The comparison is only against your own
sends.

## Navigating between missions

It was split across two places and neither had what decides where to go. The
window's dropdown gave title and status, and you had to open it to know what
existed; the HUD panel did have phase, movement and crew, but it is up in the
top right, it folds, and any window covers it.

### The ribbon

> **2026-09-08.** The ribbon stopped being a view selector and became a door:
> each mission has its own window (`kinds/mission.ts`), so clicking a tab opens
> it or brings it to the front instead of swapping CAPCOM's window for that
> conversation. With that, the GENERAL tab disappears from here — CAPCOM is
> nothing more than its own session now — along with the ARCHIVE button, which
> moved to the mission window, and the per-conversation remembered scroll, which
> is now each window's. What follows still holds: the dot, the order and the
> fold under `MORE`. See [MISSIONS.md](MISSIONS.md), "How you navigate".

The dropdown is now an always-visible row of tabs: the open missions, one click
each, with a dot that carries the phase and the time since the last movement.
What is finished folds under `MORE`, which is the old `pick` holding what you no
longer navigate.

The dot comes from `missionRows`, the same computation that paints the HUD
panel, so the window and the panel cannot disagree:

| dot | phase | what it says |
| --- | --- | --- |
| lime | `progress` | there is live crew on it |
| amber | `waiting` | CAPCOM had the last word and nobody is working: **you are up** |
| blue | `queued` | it is with CAPCOM, still no answer |
| off / red | `completed` / `failed` | finished |

The order is the order they were opened in, not the order of movement
(`railSplit`, in `src/ui/hud/mission-status.ts`). That is the difference from
the HUD panel, and it is on purpose: a tab that moves on its own is a tab you
click wrong. The ribbon grows to the right and nothing changes place under the
cursor while the fleet works. The only exception to "what is finished folds" is
the open conversation, which is always visible: a ribbon that does not say where
you are is not navigation.

### The peephole

In GENERAL, a mission appeared as a chip with the phrase "open it to read the
exchange". A dead end: to know what it was about you had to switch views.

The prompt CAPCOM receives is no good for showing — the hub attaches the whole
context of the mission to it and it fills a screen — but the mission's
conversation is. `missionGlimpse` (`src/shared/missions.ts`, next to
`missionDebt`) pulls out the two lines that explain the prompt: the one that
triggered it and the first answer from CAPCOM that came after.

What triggers it is not necessarily yours. You also get into a mission because a
worker reported something and the hub woke CAPCOM with it; that line explains
the prompt just as well, so the peephole accepts any role except CAPCOM, which
is the one that answers. With the previous rule — `human` only — five of the
eleven mission groups in a real session were left with nothing to show.

The line is the one **closest** to the moment, not the last one that fits: the
hub stores the message and then dispatches it, and the one that dates the prompt
is the CLI when it writes it, always a little later. Without that precision, two
prompts from the same mission would both show the newest line.

### Where you left off

Every conversation remembers its scroll. Coming back to a mission returns you to
where you were, instead of to the bottom. It survives a tab change, not a
reload: it is a scroll, not state.

## Validation

```
npm test -- talk missions mission-status capcom-window drafts
npm test -- --changed                  775/775
npm run typecheck
```

`test/talk.test.ts` covers the echo overtaken by the transcript — and the
reverse case, the one still in the queue that must not be cleared — and the
ordering of the two sources by time. `test/mission-status.test.ts` covers that
the ribbon keeps the opening order whatever happens to the fleet, and that what
is finished folds except for the open conversation. `test/missions.test.ts`
covers the peephole: the right line for each prompt, the answer that follows it,
the case with no answer yet, and the prompt triggered by a worker instead of by
the operator.

Also checked against the live console (Playwright on `localhost:4478`, the real
fleet): the ribbon with GENERAL and three missions from the three phases,
switching tabs, and eleven out of eleven mission groups with a peephole where
there used to be six.
