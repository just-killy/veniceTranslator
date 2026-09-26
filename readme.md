# Venice Translator for Translator++

A translation engine add-on for [Translator++](https://dreamsavior.net/) that translates game text through the [Venice.ai](https://venice.ai/) API. It appears in Translator++ as the engine **Venice Translator** and works with any model Venice offers: the model ID is a plain text field.

Rows are sent in batches as JSON, game codes stay intact, every reply is checked, and the engine recovers on its own from the typical mistakes of language models: merged or dropped rows, repetition loops, replies cut off by the token limit, rate limits and temporary server errors.

What changed from version to version is listed in [CHANGELOG.md](CHANGELOG.md).

## Contents

1. [Requirements and installation](#requirements-and-installation)
2. [Quick start](#quick-start)
3. [How it works](#how-it-works)
4. [Settings](#settings)
5. [Recommended settings](#recommended-settings)
6. [A new language pair](#a-new-language-pair)
7. [Tester and chat](#tester-and-chat)
8. [Log messages](#log-messages)
9. [Privacy](#privacy)
10. [For developers](#for-developers)

## Requirements and installation

- Translator++ 8.8.8 or newer.
- A Venice API key with credit on the account: <https://venice.ai/settings/api>.

Copy the add-on folder into `<Translator++ folder>/www/addons/`, restart Translator++ and enable **Venice Translator** in the add-on manager. The engine then appears in the list of translator engines.

## Quick start

1. Open the Translator++ options and go to the **Venice Translator** page.
2. Paste your key into **API Key** and choose a model: use one of the buttons, pick an ID from the list, or type any ID from the [Venice model catalog](https://docs.venice.ai/models/text).
3. Load the preset **Game dialogue** under *Manage configuration*.
4. Replace the sample dialogue with two examples in your own language pair (see [A new language pair](#a-new-language-pair)).
5. Click **Open the tester** and translate a few lines to check the key, the model and the prompts.
6. Translate the project: selected cells with right-click → **Translate using**, or everything through the **Translate All** dialog.

## How it works

```
Translator++ batch of rows
   │  Escaping patterns hide game codes:   \C[2]Name\C[0]  →  ${dat[1]}Name${dat[2]}
   │  The packing format numbers the rows: {"0": "...", "1": "..."}
   ▼
Venice Translator
   fetchTranslation ─► translateJob ─► requestTranslation ─► fetch ─► Venice API
                          ▲    │            │  build the chat, send, check the reply,
                          │    │            └─ corrective retries
                          │    └─ wrong row count / reply cut off?
                          └────── translate the rows again in smaller requests
   ▼
reply in the expected shape ─► Translator++ restores the game codes ─► grid
```

1. **Batching.** Translator++ groups rows into batches of up to *Max Characters per Batch*; the engine sends each batch in requests of up to *Max row per concurrent requests* rows.
2. **Masking.** Game codes are replaced with `${dat[n]}` placeholders, according to the patterns in the Translator++ options under **Custom escape**.
3. **Packing.** The rows are packed as JSON: numbered (`{"0": "…"}`, recommended) or as an array.
4. **Request.** The engine builds the chat, sends it and checks the reply.
5. **Recovery.** A bad reply is sent back to the model with an explanation, and then, if needed, translated in smaller requests.

### What one request contains

1. **System message:** your *System Message Template*, the *Extra Prompt* of the Translate All dialog, and — when a row is retried after a repetition loop — a hint to keep repeats short.
2. **Sample dialogue:** your examples, converted to the packing format in use.
3. **User message:** the *Body Message Template* with the packed rows in `${SOURCE_TEXT}`.
4. **On a retry:** the model's failed reply followed by one corrective message.
5. **Jailbreak note, if enabled:** right before the last user message.

`max_tokens` is sized to each request — about 1.5 tokens per character of the packed rows plus 200, never more than *Maximum Tokens* — so a model that gets stuck repeating itself stops early. `reasoning_effort` is sent only when you choose a value. Extra parameters are applied last and override anything else.

### Checking the reply

1. **Cleaning.** `<think>` blocks, code fences and any text before or after the JSON are removed. Valid JSON is never altered.
2. **Checks.** The number of rows; optionally the number of lines in each row; and every row on its own: JSON instead of text or the source repeated unchanged, text left in the source language, a lost `${dat[n]}` placeholder.
3. **Corrective retry.** The model sees its own failed reply and an explanation, up to *Number of retry* times. After that, a row that still repeats its source is left empty; a row with leftover source text or a missing code is written and named in the log.
4. **Split.** If the row count is still wrong, the rows are split in two and translated separately, down to single rows. What came back correctly is kept.
5. **Repetition loops.** Long runs in the source are shortened before sending; a reply that ends in a loop is rescued with its rows intact; a row that cannot be rescued is translated once more on its own, at a temperature of at least 0.7 and with a hint to keep repeats short. Only if it loops again does it stay empty.
6. **Reply cut off by the token limit.** By default the unfinished row is never written and the rest is translated in smaller requests; a single row that does not fit is sent once more with the full *Maximum Tokens*.
7. **Empty rows stay empty,** so *untranslated only* picks them up next time.

### When the API does not answer

| Situation | What the engine does |
|---|---|
| No reply within *Batch Timeout* | Aborts and tries once more. |
| HTTP 429, 408, 500, 502, 503, 504 | Up to 4 attempts, waiting as long as the rate-limit headers say, otherwise about 2, 4 and 8 seconds. |
| HTTP 401, 402, 403 | Bad key, no credit, no access — asking again cannot help. The Venice message is shown once, and the rest of the batch translation is skipped without sending anything and without waiting between batches; those rows stay empty for *untranslated only*. A single translation is simply reported. |
| HTTP 400 naming a parameter | Resends without that parameter and keeps it dropped for this model until Translator++ restarts. |

## Settings

Defaults are in brackets.

### Manage configuration

- **Presets.** **Game dialogue** — the shipped rules with context enabled. **RPG Maker** — the same, plus rules about control codes and narrow message windows, and smaller batches. Loading a preset overwrites the fields it contains, your prompts included; the API key is kept. Save your own setup as a preset first — one per project works well.
- **Reset** restores the defaults and keeps the API key.

### Connection

| Setting | Description |
|---|---|
| **Target URL** (`https://api.venice.ai/api/v1/chat/completions`) | Venice chat completions endpoint. |
| **API Key** | Your Venice API key. |
| **Model** (`venice-uncensored-1-2`) | Any Venice model ID. The buttons and the list are only shortcuts; for the models it knows, the add-on also caps *Maximum Tokens* at their output limit and says so in the log. An unknown ID works just as well, it is simply sent as it is. |
| **Include Venice system prompt** (off) | Venice prepends a prompt of its own unless this is off. |
| **Disable thinking** (on) | Skips the thinking phase of reasoning models. |

### Prompt

| Setting | Description |
|---|---|
| **Enable context** (off) | Adds the rows above the current batch, with their translations, to `${CONTEXT}`. |
| **Context Character Limit** (2048) | Maximum length of that context. |
| **System Message Template** | The rules of the translation. Name the target language here, as the shipped prompt does: without it a model tends to answer in the language of the examples. |
| **Sample dialogue** | Pairs of a request and the reply the model should imitate. A pair with an empty half is skipped; the JSON is converted to the format in use. **Add a ready-made example** appends the bundled pair, **Clear the examples** removes them all. |
| **Body Message Template** | The request itself; must contain `${SOURCE_TEXT}`. |
| **Corrective retries** | Three prompts for a failed reply: wrong number of rows, wrong number of lines, what was wrong. |
| **Enable jailbreak note** (off) | An extra system note before the last user message, for models that refuse or soften text. |

Context covers the rows **above the current batch**; rows of the same batch sent in an earlier request are not part of it. To keep a long dialogue together, set *Max row per concurrent requests* to 0 so the whole batch goes in one request.

#### Template variables

| Variable | Value |
|---|---|
| `LANG_FROM`, `LANG_TO`, `LANG_FROM_FULL`, `LANG_TO_FULL` | Languages of the project |
| `SOURCE_TEXT` | The packed rows of this request |
| `MESSAGE_COUNT` | Number of rows in this request |
| `ESCAPE_ALGORITHM_PROMPT` | Description of the packing format |
| `NEWLINE_STRING` | The line break substitute |
| `ACTOR_INFO` | Characters mentioned in the request (Translate All → *Load Actor Reference as Glossary*) |
| `CONTEXT` | Previous rows with their translations |
| `REFERENCE[name]` | A reference table of the project, e.g. `${REFERENCE[Common Reference]}` |
| `TITLE`, `ENGINE` | Title and game engine of the project |
| `RETURNED_MESSAGE_COUNT`, `LINE_ERRORS`, `ERROR_MESSAGE` | Corrective prompts only |

A placeholder whose value is empty is left in the text unchanged.

### Generation

| Setting | Description |
|---|---|
| **Maximum Tokens** (4096) | Upper limit of one reply; each request asks for less. Raise it only if single rows are very long. |
| **Reasoning Effort** (Auto) | For reasoning models. *Auto* does not send the parameter. |
| **Temperature** (0.15) | Lower is more literal, higher more varied. 0.15–0.3 suits translation. |
| **Nucleus sampling (top_p)** (1) | An alternative to temperature; change one of the two. |
| **Frequency / Presence Penalty** (0) | Best left at 0. They do not stop repetition loops; the engine handles those. |
| **Use JSON Schema** (on) | Sends a strict schema. With numbered rows it also fixes the row count. |

### Extra parameters

| Setting | Description |
|---|---|
| **Parameter** list | Extra fields of the request body: key, value and type (`string`, `number`, `boolean`, or `javascript`, evaluated as an expression). Examples: `min_p`, `top_k`, `repetition_penalty`. A custom `venice_parameters` replaces the whole object. |
| **Drop Parameters** | Fields that are never sent. A parameter a model rejects is dropped automatically for the rest of the session. |

### Batch Translation Setting

| Setting | Description |
|---|---|
| **Batch Timeout** (120000 ms) | How long one HTTP request may take. Too low means paying twice for slow replies. |
| **Batch delay** (5000 ms) | Pause between batches. Changing it requires a Translator++ patron account. |
| **Max Characters per Batch** (2000) | Size of a batch, counted on the source text only. |
| **Max concurrent requests** (1) | Keep it at 1 while context is on, or a request leaves before the previous translation is ready. |
| **Max row per concurrent requests** (10) | Rows per request; 0 sends the whole batch at once. |
| **Keep replies with the wrong number of rows** (off) | Writes translations into the wrong rows. Leave it off. |

### Retries and checks

| Setting | Description |
|---|---|
| **Number of retry** (2) | Corrective retries for a reply that fails the checks. Each one is a paid request. |
| **Retry when the number of rows does not match** (on) | Also covers a reply that is not valid JSON. |
| **Retry when the number of lines in a row does not match** (off) | For fixed-height message windows. The whole request is resent. |
| **Split the request when the row count is still wrong** (on) | Split in two and translate separately, down to single rows. |
| **Reply cut off by the token limit** (*Translate the unfinished row again*) | The other mode, *Repair and keep the unfinished row*, writes the row as it stands; its end and any code in it can be lost. |
| **Shorten long repetitions before sending** (on) | A character repeated more than five times is cut to five, a syllable repeated more than four times to four. Only the request changes; the grid keeps the original. |

### Packing the rows

| Setting | Description |
|---|---|
| **Code Escaping Algorithm** (numbered rows) | **Numbered rows** `{"0": "…"}`: every translation comes back under the number of its row, so a merged or dropped line spoils only that row, the schema can fix the row count, and a cut-off reply keeps what was finished. **Array of rows** `["…"]`: rows are matched by position, so one merged line shifts every row after it and the whole reply has to be rejected. Other Translator++ algorithms join rows line by line, which language models break too easily; a configuration that still names one of them is moved to numbered rows. |
| **Disable custom escape** (off) | Added by Translator++ to every engine: sends the text unmasked. Keep it off. |
| **New line character substitute** (`\r\n`) | Only used for `${NEWLINE_STRING}` and for counting lines; the JSON carries real line breaks. |

Which codes are hidden is not part of this add-on: it is set in the Translator++ options under **Custom escape → Patterns** ([documentation](https://dreamsavior.net/docs/translator/code-escaping-algorithm/custom-pattern/)).

### Translate All dialog

| Option | Description |
|---|---|
| **Always separate file** | Never mix rows of different files in one batch. |
| **Add actor name** | Prepend the speaker's name to each row and strip it from the translation. |
| **Load Actor Reference as Glossary** | Put the characters of the batch into `${ACTOR_INFO}`. |
| **Actor Reference Translation Column**, **Actor's Information Column** | Columns with the translated names and with gender, age or manner of speech. |
| **Extra Prompt** | Added to the system message for this run only. |

## Recommended settings

| Setting | Value |
|---|---|
| Temperature | 0.15, up to 0.3 if the translation feels too literal |
| Maximum Tokens | 4096, more only for very long rows |
| Use JSON Schema, numbered rows | on |
| Enable context | on, 2000–4000 characters |
| Number of retry | 2 |
| Reply cut off by the token limit | Translate the unfinished row again |
| Shorten long repetitions | on |
| Max Characters per Batch | 2000–2500; 1000–1500 when the source language is denser than the target, as Japanese and Chinese are |
| Max concurrent requests | 1 |
| Max row per concurrent requests | 10–20, or 0 for one request per batch |
| Batch Timeout | 120000 ms |

## A new language pair

- **Name the target language in the system message.** This matters most when some rows are in a third language.
- **Write the sample dialogue in your own pair.** The model imitates the examples closely: examples answered in English make it answer in English, whatever the target language. The bundled examples are made-up Japanese lines with Russian replies. Two are enough — one plain, one with a `${dat[n]}` code and a row of two lines.
- **Use a glossary only if it is in your target language.** `${REFERENCE[Common Reference]}` inserts a reference table of the project; a table left over from another language pair pulls the model towards that language.
- **Turn context on for languages that leave the subject out**, such as Japanese. Without it the model guesses who is speaking, and in a language that marks gender in verbs the guess is visible at once. The *Actor Reference* table with an information column adds who is who.
- **Names written in katakana** come out spelled differently from row to row. Put them into the project's *Common Reference* table and insert that table into the prompt.
- **Runs of dashes and other symbols** ("――――") make models repeat forever. Hide them with an escaping pattern such as `/[―─—━]{2,}/g`; long screams need nothing, the engine shortens them.
- The row check reports source text left untranslated, but **a reply in the wrong target language is not detected**.

## Tester and chat

**Open the tester**, at the bottom of the Venice API settings, opens a window that never touches the project.

- **Translation** runs the whole pipeline — templates, masking, checks, retries — on the text in the field, which is sent as a single row, so paste one scene at a time. The languages are those of the open project.
- **Plain chat** sends the text as one chat message, without templates or checks.
- The right-hand pane shows the result, the raw reply and the whole HTTP exchange, with the API key hidden. The status line says how long it took and how many tokens it spent.
- Alt+S or Ctrl+Enter sends. Every send spends tokens.

**Ask Venice**, the toolbar button, opens the Translator++ chat assistant with the endpoint, key and model already filled in.

## Log messages

The engine writes messages prefixed with `[Venice]` to the Translator++ log.

| Message | What to do |
|---|---|
| `HTTP 429: Rate limit exceeded Retrying in N s...` | Nothing. If it repeats, raise *Batch delay* or lower *Max concurrent requests*. |
| `The request timed out after N s...` | Raise *Batch Timeout*. |
| `Venice API error (HTTP 401)` / `(HTTP 402)` | Check the key; top up the account. The rest of the run is skipped, so translate the rows that stayed empty afterwards. |
| `A Custom escape pattern hid a code that another pattern had already hidden...` | Move that pattern above the ones it swallows in *Custom escape → Patterns*. The codes were put back, but Translator++ itself would drop such rows. |
| `The model "..." rejected reasoning_effort...` | Clear that value to save one request per model. |
| `"Maximum Tokens" (N) is above the output limit of ...` | Nothing; the request was capped. |
| `Validation failed (attempt 1 of 3): Row count mismatch...` | Occasional retries are normal. If frequent, send fewer rows per request and keep the JSON schema on. |
| `The reply had N row(s) instead of M. Splitting the request...` | Nothing. |
| `The model got stuck repeating itself...` | Nothing. The end of that row may be missing. |
| `Left untranslated: ...` | The row is empty and will be picked up by *untranslated only*; or translate it by hand. |
| `Check this row: ...` | The row was written but still has source text or lost a game code. Find it by the quoted source. |

## Privacy

- Translator++ keeps the API key with the other engine settings in its configuration file `data/config.json`.
- The key is never written to the console, the batch logs or the tester window, where it appears as `Bearer ***`.
- Requests go only to the *Target URL*, with Venice web search disabled. What you translate is processed by Venice under its own privacy policy.

## For developers

| File | Purpose |
|---|---|
| `package.json` | Manifest and script load order |
| `veniceSettings.js` | The engine object, its defaults and the settings form |
| `veniceAssistant.js` | The **Ask Venice** toolbar button |
| `veniceEngine.js` | The pipeline: requests, retries, checks, recovery |
| `lib/venicePrompts.js` | The shipped prompts, shared by the form, the presets and the tests |
| `lib/veniceModels.js` | Models the add-on knows the limits of; add more here |
| `lib/veniceUtils.js` | Pure helpers: reply cleaning, checks, JSON repair, sample conversion, error handling, back-off |
| `tester/veniceTester.*` | The tester window |
| `data/presets/*.jsv` | Presets, built from `lib/venicePrompts.js` by `tools/buildPresets.js` |
| `tools/buildPresets.js` | Rebuilds the presets after the prompts change: `node tools/buildPresets.js` |
| `tests/*.test.js` | Unit tests |

Scripts load in this order: `veniceSettings.js` → `veniceAssistant.js` → `veniceEngine.js`.

The engine ID `veniceTranslator` and the option names are stored in `sys.config.translatorEngineOptions.veniceTranslator`. Renaming them loses the saved settings, and the batching and escaping options cannot be renamed at all: Translator++ reads them itself.

Tests need Node.js 18 or newer:

```bash
cd "<Translator++ folder>/www/addons/veniceTranslator"
node --test
```

They cover reply cleaning and JSON repair, repetition loops, the row and line checks, splitting and rebuilding payloads, sample conversion, JSON schemas, API errors, retry timing, the model list and the bundled prompts, and they fail when a preset file differs from what `tools/buildPresets.js` builds.
