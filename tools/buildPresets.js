/**
 * Builds the bundled presets (data/presets/*.jsv) from lib/venicePrompts.js, so the presets can
 * never drift from the prompts. A preset whose settings did not change is left untouched.
 *
 * Run from the add-on folder after editing the prompts:  node tools/buildPresets.js
 * tests/presets.test.js fails while a preset file differs from what this script would write.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const VP = require("../lib/venicePrompts.js");
const VM = require("../lib/veniceModels.js");
const VU = require("../lib/veniceUtils.js");

const PRESETS_DIR = path.join(__dirname, "..", "data", "presets");
const FORM_ID = "tlEngine-veniceTranslator";

/** Settings every preset shares. */
const BASE = {
    baseUrl: "https://api.venice.ai/api/v1/chat/completions",
    model: VM.DEFAULT_MODEL,

    escapeAlgorithm: VU.DEFAULT_ESCAPE_ALGORITHM,
    disableCustomEscape: false,
    lineSubstitute: "\\r\\n",
    useJsonSchema: true,

    systemMsgTemplate: VP.SYSTEM_PROMPT,
    sampleDialog: VP.SAMPLE_DIALOG[VU.DEFAULT_ESCAPE_ALGORITHM],
    bodyMsgTemplate: VP.BODY_PROMPT,
    promptRetryRowCountMismatch: VP.RETRY_ROW_COUNT,
    promptRetryLineCountMismatch: VP.RETRY_LINE_COUNT,
    promptError: VP.RETRY_ERROR,
    enableJailbreak: false,
    jailbreakTemplate: VP.JAILBREAK_NOTE,

    maxTokens: 4096,
    reasoningEffort: "",
    temperature: 0.15,
    top_p: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,

    maxRequestLength: 2000,
    maxConcurrentRequest: 1,
    rowLimitPerBatch: 10,
    preserveInvalidReturnedRows: false,
    batchDelay: 5000,
    batchTimeOut: 120000,

    maxRetries: 2,
    retryIfRowCountMismatch: true,
    retryIfLineCountMismatch: false,
    splitOnRowCountMismatch: true,
    truncatedReplyMode: "retry",
    shortenRepetitions: true,

    customParameters: [],
    dropParameters: [],
};

/** File name → settings. Context is on in both: it is what keeps speakers and gender straight. */
const PRESETS = {
    "dialogue.jsv": {
        ...BASE,
        enableContext: true,
        contextCharacterLimit: 3000,
    },
    "rpgmaker.jsv": {
        ...BASE,
        systemMsgTemplate: VP.SYSTEM_PROMPT + VP.RPGMAKER_RULES,
        enableContext: true,
        contextCharacterLimit: 3000,
        maxRequestLength: 1500,
    },
};

function writePresets() {
    for (const [name, value] of Object.entries(PRESETS)) {
        const file = path.join(PRESETS_DIR, name);
        const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).value : undefined;
        if (isDeepStrictEqual(current, value)) {
            console.log(`${name}: up to date`);
            continue;
        }
        const preset = { header: { type: "jsonformvalue", date: new Date().toISOString(), id: FORM_ID }, value };
        fs.writeFileSync(file, JSON.stringify(preset, null, 4) + "\n");
        console.log(`${name}: written, ${Object.keys(value).length} settings`);
    }
}

if (require.main === module) writePresets();

module.exports = { PRESETS, FORM_ID };
