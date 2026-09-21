/**
 * Models the settings form offers as shortcuts, with the one fact the engine needs about each:
 * the longest reply the model may write. Maximum Tokens is capped at that limit.
 *
 * Any other model ID can be typed into the Model field; it is then sent as it is, without a cap.
 * Output limits taken from https://api.venice.ai/api/v1/models?type=text (September 2026).
 */
"use strict";

const MODELS = [
    { id: "venice-uncensored-1-2",              name: "Venice Uncensored 1.2",       maxCompletionTokens: 8192,   quickPick: true },
    { id: "venice-uncensored-role-play",        name: "Venice Role Play Uncensored", maxCompletionTokens: 4096,   quickPick: true },
    { id: "gemma-4-uncensored",                 name: "Gemma 4 Uncensored",          maxCompletionTokens: 8192 },
    { id: "olafangensan-glm-4.7-flash-heretic", name: "GLM 4.7 Flash Heretic",       maxCompletionTokens: 24000 },
    { id: "mistral-small-2603",                 name: "Mistral Small 4",             maxCompletionTokens: 65536 },
    { id: "deepseek-v4-flash",                  name: "DeepSeek V4 Flash",           maxCompletionTokens: 32768 },
    { id: "qwen-3-8-flash",                     name: "Qwen 3.8 Flash",              maxCompletionTokens: 131072 },
    { id: "zai-org-glm-5-2",                    name: "GLM 5.2",                     maxCompletionTokens: 131072 },
];

const DEFAULT_MODEL = "venice-uncensored-1-2";

function getModel(id) {
    return MODELS.find((model) => model.id === id);
}

/** Output-token limit of a listed model, or undefined for any other ID. */
function getMaxCompletionTokens(id) {
    return getModel(id)?.maxCompletionTokens;
}

module.exports = {
    MODELS,
    DEFAULT_MODEL,
    getModel,
    getMaxCompletionTokens,
};
