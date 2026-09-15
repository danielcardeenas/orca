# Hygiene — memory, measured instead of bounded

**Status:** implemented and verified on the operator's machine.

It started with a screenshot of the HYGIENE window:

```
MEMORY   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░  ≤47G of 48G
```

The operator's question —"why do we have almost all the memory used up?"— was
the right one, and the answer was that we did not.

## 1. What was wrong

The row came from `os.totalmem() - os.freemem()`. On darwin `os.freemem()`
counts only the pages free **at that instant**, and macOS deliberately leaves
almost none: everything spare is file cache or purgeable, and it hands it back as
soon as anyone asks. The subtraction, therefore, gives "47 of 48" on a machine
with nine gigabytes of headroom. Linux has the same bug for the same reason:
`MemFree` is not `MemAvailable`.

The code **already knew** the figure was not a measurement: it marked it `≤`,
with the reason in the tooltip. And even so it was the figure read first, with
the bar almost full, like an emergency.

Hence the rule now written into `shared/hygiene.ts`: **a bound is the
second-best answer**. Marking a number correctly is not measuring it, and a
correctly marked ceiling can still be the number that misleads. `atMost` is for
when the platform will not say — not instead of asking it.

## 2. What was done

`src/collector/memory.ts`, new: the platform is asked on its own terms.

| | darwin (`vm_stat`) | linux (`/proc/meminfo`) |
|---|---|---|
| Committed | `wired + app + compressed`, where app is `anonymous − purgeable` — what Activity Monitor calls *Memory Used* | `MemTotal − MemAvailable` |
| Cache | `file-backed + purgeable` | `Cached + Buffers + SReclaimable` |
| Swap | `sysctl vm.swapusage` | `SwapTotal − SwapFree` |

Three decisions that earn their comment:

- **The cache is a row of its own, not a term in any sum.** It is memory in use
  *and* memory available at the same time; putting it on either side is the
  original mistake in one direction or the other.
- **Swap comes up to the panel** because it is what says whether the pressure is
  real: 80% committed with no swap is a comfortable machine, and that same 80%
  with four gigabytes paged out is not.
- **A missing counter breaks the whole parse.** A zero in "pages occupied by
  compressor" would have subtracted ten gigabytes on this machine and would have
  looked reasonable, which is the worst way to be wrong.

If `vm_stat` or `/proc/meminfo` cannot be read, the usual ceiling comes back —
with its `≤` and with its reason, and never dressed up as a measurement.

The page size is read from `vm_stat`'s header (16K on Apple silicon, 4K on
Intel): assuming it multiplies or divides every figure by four on half the fleet.

## 3. What you see now

```
MEMORY   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░  39G of 48G
  CACHED  RETURNED ON DEMAND        7.5G
  SWAP                       4.2G of 5.0G
```

With no mark, because it is measured. The bar draws what is committed.

The deck's machine strip (`load.memPct`) used the same subtraction and has been
moved to the same source; it returns `null` on the first heartbeat, just like the
CPU, because the heartbeat is synchronous and cannot wait for a subprocess.

## 4. On the wire

`HygieneReport` gains three **optional** readings: `memCachedBytes`,
`swapUsedBytes`, `swapTotalBytes`. Optional because an older collector does not
send them, and absent is not zero: the window omits the row instead of drawing an
empty cache, and `sanitizeReport` leaves the field out of the report instead of
filling it in. The agents' `hygiene_sample` tool exposes them under the name
`memory_cached_returned_on_demand`, long on purpose: an agent that adds cache and
usage together and declares the machine full has read it backwards.

## 5. How to verify it

```
npm run typecheck
npm test -- memory hygiene           42 tests (12 + 30)
npx tsx test/hyg-memory.shots.ts     the section, photographed
```

`memory.test.ts` stores the real `vm_stat` output from the machine in the
screenshot, so the arithmetic that failed is checked with the numbers that failed
— and on either platform, because the parsers are pure.
`hyg-memory.shots.ts` photographs the window and also checks that the bar draws
what is committed: an almost-full bar with nine gigabytes free was the picture of
the bug.

Filters that cover this delivery: `memory`, `hygiene`, `collector`.
