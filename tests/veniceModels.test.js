/**
 * Unit tests for lib/veniceModels.js.
 * Run from the add-on folder:  node --test
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const VM = require("../lib/veniceModels.js");

test("the two Venice Uncensored models get a button of their own", () => {
    const quick = VM.MODELS.filter((model) => model.quickPick).map((model) => model.id);
    assert.deepEqual(quick, ["venice-uncensored-1-2", "venice-uncensored-role-play"]);
    assert.ok(VM.getModel(VM.DEFAULT_MODEL), "the default model is in the list");
});

test("output limits used to cap max_tokens; an unknown model has none", () => {
    assert.equal(VM.getMaxCompletionTokens("venice-uncensored-1-2"), 8192);
    assert.equal(VM.getMaxCompletionTokens("venice-uncensored-role-play"), 4096);
    assert.equal(VM.getMaxCompletionTokens("gemma-4-uncensored"), 8192);
    assert.equal(VM.getMaxCompletionTokens("some-future-model"), undefined);
});

test("every model entry is complete and unique", () => {
    const ids = new Set();
    for (const model of VM.MODELS) {
        assert.ok(model.id && model.name, JSON.stringify(model));
        assert.ok(Number.isInteger(model.maxCompletionTokens) && model.maxCompletionTokens > 0, model.id);
        assert.ok(!ids.has(model.id), "duplicate " + model.id);
        ids.add(model.id);
    }
});
