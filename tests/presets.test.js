/**
 * Checks for the bundled configuration presets (data/presets/*.jsv) and for the prompts they
 * are built from. Run from the add-on folder:  node --test
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const VU = require("../lib/veniceUtils.js");
const VP = require("../lib/venicePrompts.js");
const { PRESETS, FORM_ID } = require("../tools/buildPresets.js");

const PRESETS_DIR = path.join(__dirname, "..", "data", "presets");
const presets = fs.readdirSync(PRESETS_DIR)
    .filter((name) => name.endsWith(".jsv"))
    .map((name) => ({ name, preset: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, name), "utf8")) }));

test("every preset file is what tools/buildPresets.js builds from the prompts", () => {
    assert.deepEqual(presets.map(({ name }) => name).sort(), Object.keys(PRESETS).sort());
    for (const { name, preset } of presets) {
        assert.equal(preset.header?.id, FORM_ID, name);
        assert.deepEqual(preset.value, PRESETS[name], `${name} is out of date: run node tools/buildPresets.js`);
    }
});

test("presets carry no API key, keep game codes masked, send the JSON schema and name the target language", () => {
    for (const { name, preset: { value } } of presets) {
        assert.ok(!("apiKey" in value), name);
        assert.notEqual(value.disableCustomEscape, true, name);
        assert.ok(VU.JSON_ALGORITHMS.includes(value.escapeAlgorithm), name);
        assert.equal(value.useJsonSchema, true, name);
        assert.match(value.systemMsgTemplate, /\$\{LANG_TO\}/, name);
        assert.ok(Number.isInteger(value.maxTokens) && value.maxTokens > 0, name);
    }
});

test("the bundled prompts ask for the target language and protect the placeholders", () => {
    assert.match(VP.SYSTEM_PROMPT, /\$\{LANG_TO\}/);
    assert.match(VP.SYSTEM_PROMPT, /\$\{dat\[n\]\}/);
    assert.match(VP.SYSTEM_PROMPT, /\$\{MESSAGE_COUNT\}/);
    assert.match(VP.BODY_PROMPT, /\$\{SOURCE_TEXT\}/);
    assert.match(VP.RETRY_ROW_COUNT, /\$\{MESSAGE_COUNT\}/);
    assert.match(VP.RETRY_LINE_COUNT, /\$\{LINE_ERRORS\}/);
    assert.match(VP.RETRY_ERROR, /\$\{ERROR_MESSAGE\}/);
});

test("every sample example is valid JSON in the format it belongs to", () => {
    for (const algorithm of VU.JSON_ALGORITHMS) {
        const samples = VP.SAMPLE_DIALOG[algorithm];
        assert.ok(Array.isArray(samples) && samples.length, algorithm);
        for (const [index, sample] of samples.entries()) {
            const label = `${algorithm}, example ${index + 1}`;
            for (const [part, text] of [["request", sample.user], ["reply", sample.assistant]]) {
                const span = VU.findJsonSpan(text);
                assert.ok(span, `${label}: ${part}`);
                assert.doesNotThrow(() => JSON.parse(text.slice(span.start, span.end)), `${label}: ${part}`);
            }
        }
    }
});
