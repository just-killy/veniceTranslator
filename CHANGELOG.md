# Changelog

All notable changes to the Venice Translator add-on are listed in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the add-on follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned as version 1.0.0, the first release. Until then the add-on is developed and tested in the `develop` branch.

### The engine

- Translator engine **Venice Translator** for the Venice.ai chat completions API, with buttons for Venice Uncensored 1.2 and Venice Role Play Uncensored; any other Venice text model can be typed in.
- Rows are sent as JSON, numbered (recommended) or as an array, with a strict JSON schema. Game codes are hidden behind `${dat[n]}` placeholders by the Translator++ escaping patterns and put back after translation.
- `max_tokens` is sized to each request — about 1.5 tokens per character of the packed rows plus 200, never more than *Maximum Tokens* — so a model that gets stuck repeating itself stops after a few hundred tokens instead of using up the whole limit.
- Request timeout, automatic waiting on rate limits and server errors, and automatic removal of parameters a model does not accept. *Maximum Tokens* is capped at the output limit of the selected model.

### Checking the reply

- The number of rows and, optionally, the number of lines in each row.
- Every row on its own: JSON instead of text or the source repeated unchanged, text left untranslated, a lost `${dat[n]}` placeholder.
- A reply that fails goes back to the model with an explanation. If the retries do not help, the request is split in two and translated separately, down to single rows.
- A reply cut off by the token limit never writes a half-finished row; the alternative *Repair* mode closes the reply and keeps it.
- Repetition loops: long runs are shortened before sending, a looping reply is rescued with its rows intact, and a row that cannot be rescued is translated once more at a higher temperature with a hint to keep repeats short.
- A row that could not be translated is written as an empty cell, so *untranslated only* picks it up next time.

### Prompt and settings

- Bundled prompts that name the target language, protect the placeholders and the line breaks, ask for consistent gender and speech, and keep screams short. They live in `lib/venicePrompts.js` and are shared by the settings form, the presets and the tests.
- Presets **Game dialogue** and **RPG Maker**, both with context enabled.
- Context, a character glossary and Translator++ reference tables in the prompt; sample dialogue that is converted when the packing format changes; extra request parameters.
- Settings form in four tabs — Connection, Prompt, Generation, Extra parameters — plus batching, retries and packing.

### Tools

- A tester window that runs the whole pipeline without touching the project and shows the result, the raw reply and the HTTP exchange.
- The **Ask Venice** toolbar button, which opens the Translator++ chat assistant with the endpoint, key and model already filled in.
- The API key is never written to the console, the batch logs or the tester.

### Documentation and tests

- A readme covering the settings, the recovery, the log messages and advice for Japanese source text.
- 46 unit tests for the helpers, the model list, the presets and the prompts (`node --test`).
- `tools/buildPresets.js` builds the presets from the prompts; a test fails when a preset file is out of date.

[Unreleased]: https://github.com/just-killy/veniceTranslator/commits/develop
