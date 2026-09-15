# Talking to CAPCOM

Hold `⌥V` and speak; let go and the line is sent. That is the whole of voice
control, and it is that short on purpose.

## What it is and what it is not

**It is not a grammar of commands.** "Open K9", "deck by state": the palette
already does that, with more precision than a recognizer will ever have. CAPCOM
is a language model; "stop K9 and send it yesterday's brief" it understands as
text, and that is why all voice does is produce text and push it in through the
same place as the composer: `hub.say`. CAPCOM receives a written line and does
not know it was spoken. The echo appears in TALK, the delivery stays in the
history, the answer arrives block by block, as always.

**There is no open microphone.** There is no wake word and no continuous
listening. The console listens exactly while the key is held, and that is the
entire security story of a microphone in front of an agent that acts. With `Esc`
while holding, the line is thrown away. If the window loses focus mid-sentence,
the same: nothing half-heard gets sent.

**The mast's TALK button does the same with a finger.** Press and hold listens;
release sends; a cancelled pointer throws the line away. It is the shape it takes
on touch, where `⌥V` does not exist.

## The way back: who decides what gets read

A CAPCOM answer is paragraphs, tool calls, paths and code blocks. Read out loud
in full it is a minute of noise. The temptation is to ask CAPCOM to be brief, and
it is the wrong temptation: it is an instruction it will forget, and it would
also change the written answer, which does want to be complete.

The console decides, with rules, in `src/ui/voice.ts`. There is no model
summarizing.

- **Only the answer to something that was spoken gets read.** A line typed by
  hand gets a written answer, as before. The console remembers the last dictated
  lines and looks in the transcript for the prompt that matches.
- **Only once the turn has finished.** CAPCOM `idle`, or `blocked` on a question.
  Never mid-sentence while the rest is still arriving. That a blocked question is
  read too is the case that matters most: CAPCOM is waiting for you and you are
  not looking at the screen.
- **The conclusion is what gets read.** The text that comes after the last tool
  step. What came before ("Let me look at…") is narration; what comes after is
  what happened.
- **And only its first sentences**, up to `SPOKEN_MAX` (220) characters. Whole
  sentences; if the first one does not fit, it is cut at a word with an ellipsis.
  The full answer stays in the window.
- **Readable.** Before reading, out go the code blocks, the URLs, the markdown
  markers; links keep their words and paths keep their file name:
  `src/ui/main.ts:361` is read as "main.ts".

`SETTINGS › VOICE › READ BACK` turns it off. With that off, `⌥V` still speaks and
the answer stays in the window. Starting to dictate cuts off any read-back in
progress.

## The ears

There are two ways to turn what was said into text, and `SETTINGS › VOICE › EARS`
chooses (`voiceEngine`):

**whisper.cpp in the hub.** The browser records the microphone while the key is
held, converts it to the WAV the binary reads (16 kHz, mono, 16-bit;
`src/ui/audio.ts`, with no ffmpeg anywhere) and on release uploads it to
`POST /api/transcribe`. The hub runs `whisper-cli` (`src/hub/transcribe.ts`) with
**the fleet's names in the prompt**: ORCA, CAPCOM, every live callsign, every
squad, every project, exactly as they are at that moment. That is why it writes
"K9" where the browser wrote "AK9": it was told K9 exists. The audio does not
leave the machine. It costs one or two seconds between releasing and seeing the
line, one and a half of which is loading the model; `whisper-server` with the
model resident would bring that down, and it is left for when it hurts.

While the hub works, the browser's recognizer, if there is one, keeps showing the
words live, and it is the last-resort line if the hub fails mid-sentence. What
gets sent is whisper's.

**The browser.** Web Speech API: words as you speak, with no hints, and the audio
goes to Google or to Apple. Chrome and Safari have it, iOS included; Firefox does
not, and with the hub transcribing it does not need it.

AUTO is whisper whenever the hub says it can, and the browser otherwise. The line
under the selector says which one the next word will use and, when the hub
cannot, why, in the hub's own words.

**What the hub needs.** `whisper-cli` (`brew install whisper-cpp`, or
`ORCA_WHISPER_BIN`) and a `ggml-*.bin` model in `~/.orca/models` (or
`ORCA_WHISPER_MODEL`). The hub downloads nothing on its own: a model is a
gigabyte and a half and that is the operator's decision. The one in use:

```
mkdir -p ~/.orca/models
curl -L -o ~/.orca/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

With several, the hub takes the best by name: large-v3-turbo before large, before
medium, small, base, tiny. A model that appears with the hub already running is
found without a restart. `GET /api/transcribe` says so.

Two things have to hold in the browser, and when one is missing, TALK **is not
drawn**. A tool that cannot work is not a tool; SETTINGS says why it is missing:

- **A secure context.** `localhost:4478` is one. The remote address over plain
  http from `docs/REMOTE-ACCESS.md` is not, and there the browser does not open
  the microphone at all. Voice working from a phone, which is where it is worth
  most, waits on serving https (Tailscale provides its own certificates). That is
  separate work.
- **An ear.** A browser recognizer, or microphone access to record for the hub.

The language is the browser's (`navigator.language`), both for recognizing and
for reading. There is no setting: changing it means changing it in the browser.

### Which voice

The first version took the first browser voice that matched the language, and on
a Mac in es-MX that is "Eddy (Español (México))": Apple lists its joke voices —
Eddy, Flo, Grandma, Bubbles, Zarvox — alongside the real ones, and alphabetically
they come before Paulina. It sounded horrible because it was a joke.

Now it is chosen the way `say` does, in `chooseVoice` (`src/ui/voice.ts`): the
real voice for the exact language, the one the system marks as default before any
other, the local one before the remote one, and the joke ones never on their own.
If there is none for the exact language, one from the same family (es-AR with no
voice of its own reads with Mónica or Paulina). For es-MX that is Paulina, which
is what `say` uses with no settings.

`SETTINGS › VOICE › VOICE` lists the browser's voices, with AUTO as the above,
and PREVIEW reads a sample line in the voice's language. The choice is saved by
name (`voiceName`); a voice that is no longer on the machine falls back to AUTO
without saying anything. The joke ones are still in the list: they can be chosen,
they just are not chosen on their own.

**The enhanced takes.** Apple lists the stock voice and the better downloaded one
as two entries, "Mónica" and "Mónica (mejorada)", with the system's word for it
in its own language in parentheses. There is no list of those words: the good take
is the one carrying a suffix when its plain sibling is also there. AUTO prefers
it, and a name with no suffix in the preference takes its best take: `Mónica`
reads with Mónica (mejorada) if it is downloaded.

**Default: Mónica.** Spanish from Spain, chosen by the operator on 2026-09-09.
What was asked for was Siri voice 2 in Spanish from Spain, and that one does not
exist outside Siri: Apple exposes it neither to `say` nor to the browser, and on
this Mac neither of the two lists it among their 182 voices. Enhanced Mónica is
the closest thing that does exist. On a machine without Mónica, AUTO without
saying anything. For Paulina or another, the selector.

## Where it lives

| Piece | File |
|---|---|
| The rules of what gets read, pure | `src/ui/voice.ts` |
| Microphone, the two ears, synthesis, the LISTENING / TRANSCRIBING / CAPCOM / SENT strip | `src/ui/hud/voice.ts` |
| The floats from the microphone to whisper's WAV, pure | `src/ui/audio.ts` |
| whisper.cpp in the hub, the fleet's vocabulary, `/api/transcribe` | `src/hub/transcribe.ts` |
| `⌥V` held, `Esc`, the release, the blur | `src/ui/main.ts` |
| The TALK button, held | `src/ui/hud/mast.ts` |
| READ BACK, and the why when TALK is not there | `src/ui/windows/kinds/misc.ts` |
| That a chord can be caught inside a text field | `src/ui/keys.ts` |
| The `voiceReply` preference | `src/ui/prefs.ts` |

The strip lives in the dock, above every window, like the command line it
replaces: lime while listening (alive, like FOCUS), cyan while CAPCOM speaks (the
only voice that answers), and SENT for an instant when the line goes out.

## What is left out

- Reading more than the conclusion, or a summary made by a model. If it is ever
  needed, it is a provider adapter, not an instruction to CAPCOM.
- A cloud transcription provider. It would be one more adapter behind
  `/api/transcribe`, with the key in the hub's store; today it is not needed.
- **Neural voices in the hub.** They were built and removed on 2026-09-09.
  Chatterbox Multilingual (MIT) and Fish S2 Pro (research license), each as a warm
  Python child behind a `/api/speak`, with the same sentence as Mónica to compare
  them by ear. On an M4 Pro with PyTorch over Metal, Chatterbox took eight seconds
  per sentence and S2 Pro minutes; neither with MLX nor quantization. For reading
  two sentences after a CAPCOM turn it is not worth it, and the system voice
  stays. OpenAudio S1-mini never even ran: it is gated on Hugging Face and
  fish-speech's code no longer reads its format. If one day there is an MLX port
  or quantized weights, the place is the same: an endpoint in the hub that returns
  WAV, and the system voice as the fallback.
- A resident `whisper-server` to save loading the model on every line.
- Voice for agents that are not CAPCOM. `hub.say` with no agent is CAPCOM (or the
  active mission, exactly like the composer).
- https on remote access, without which there is no microphone from another
  device.

## Verification

`npm test -- voice keys`: the pure rules (markdown to readable, paths to file
name, sentences up to the cap, the conclusion after the last step, reading once
and only what was spoken, staying quiet while CAPCOM works, reading a blocked
question, ignoring what was typed by hand, tolerating folded whitespace,
discarding prompts older than the dictation, requiring the prompt→answer shape,
accepting a mission prompt that carries the line, staying quiet with no text), the
voice choice (Paulina and not Eddy for es-MX, the family when there is no exact
language, the system one and the local one in front, the chosen name above
everything, and a name that no longer exists falling back to AUTO) and the hold's
`whileTyping`.

`npm test -- voice-dom` runs in Chromium the whole wiring of `hud/voice.ts` with a
fake engine and a fake synthesizer (`test/voice.fixture.ts`): holding turns on the
strip and the body; what is heard arrives in parts; releasing sends exactly what
was heard, once, and shows SENT; cancelling sends nothing; nothing heard, nothing
sent; a denied permission warns and sends nothing; the answer to what was spoken
is read once, in cyan, with paths and backticks cleaned up; a line typed by hand
is not read; dictating again silences the read-back; with no engine, TALK does not
exist and `start` says why.

`npm test -- transcribe` tests the hub side without whisper.cpp: a fake binary
that writes down its arguments. Which model is chosen by name, how the vocabulary
is composed (ORCA, CAPCOM, live callsigns, squads, projects, once each, with a
cap), which flags reach the binary and how its output is cleaned (lines merged to
one, `[BLANK_AUDIO]` out), a binary that fails is an error with its last line, and
the endpoint: status, the line, one at a time, 415, 403, 413, 400, 405, and 503
with the reason when it cannot.
`npm test -- audio` tests the floats to WAV: concatenating, resampling from 48 to
16 kHz without losing shape or samples, and the 44-byte header field by field
with the clipping to 16 bits.

Tested with the real binary and the real model on this Mac (M4 Pro, Metal): a
seven-second sentence synthesized with `say`, two seconds on the clock with the
model loading on every call. The prompt with the names changed "Capcom" to
"CAPCOM"; the test sentence came from a synthetic Spanish voice reading English
words, so what it misheard there ("con MIT" for "commit") says nothing about a
human voice.

With no automated coverage: the real microphone and the real voice, the recording
in the browser and its upload, the `⌥V` hold in `main.ts` and the mast's held
TALK; they are tested by hand in Chrome on `localhost:4478`.

Filters that cover this delivery: `voice`, `voice-dom`, `keys`, `transcribe`,
`audio`.
