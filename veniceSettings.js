/**
 * Venice Translator: the engine object, its defaults and the settings form.
 *
 * Load order (package.json): veniceSettings.js -> veniceAssistant.js -> veniceEngine.js.
 * This file only describes the engine and its settings; the request pipeline is in veniceEngine.js
 * and waits for the state "optionIsLoaded" resolved at the bottom of this file.
 *
 * Settings are stored by Translator++ in sys.config.translatorEngineOptions.veniceTranslator.
 * Keys marked "core" below are read by Translator++ itself (BatchTranslate, CodeEscape), so their
 * names are fixed by the application, not by this add-on.
 */
const thisAddon = this;

const VU = require(thisAddon.getRelativePath("lib/veniceUtils.js"));
const VM = require(thisAddon.getRelativePath("lib/veniceModels.js"));
const VP = require(thisAddon.getRelativePath("lib/venicePrompts.js"));

const ENDPOINT    = "https://api.venice.ai/api/v1/chat/completions";
const KEYS_PAGE   = "https://venice.ai/settings/api";
const MODELS_PAGE = "https://docs.venice.ai/models/text";
const ESCAPE_DOCS = "https://dreamsavior.net/docs/translator/code-escaping-algorithm/";

// ---------------------------------------------------------------------------
// Help texts
// ---------------------------------------------------------------------------

/** Listed under every field that accepts ${NAME} placeholders. */
const VARIABLES_HELP =
    t("Placeholders written as <code>${NAME}</code> are filled in before the request is sent:") +
    "<ul>" +
        t("<li><code>LANG_FROM</code>, <code>LANG_TO</code> — source and target language of the project</li>") +
        t("<li><code>LANG_FROM_FULL</code>, <code>LANG_TO_FULL</code> — the same languages, full names</li>") +
        t("<li><code>SOURCE_TEXT</code> — the packed rows of this request</li>") +
        t("<li><code>MESSAGE_COUNT</code> — how many rows this request carries</li>") +
        t("<li><code>ESCAPE_ALGORITHM_PROMPT</code> — description of the packing format in use</li>") +
        t("<li><code>NEWLINE_STRING</code> — the line break substitute of the project</li>") +
        t("<li><code>ACTOR_INFO</code> — characters mentioned in this request, when the glossary is enabled in Translate All</li>") +
        t("<li><code>CONTEXT</code> — rows above this batch with their translations, when context is enabled</li>") +
        t("<li><code>REFERENCE[table]</code> — a reference table of the project, e.g. <code>${REFERENCE[Common Reference]}</code></li>") +
        t("<li><code>TITLE</code>, <code>ENGINE</code> — title and game engine of the project</li>") +
    "</ul>" +
    t("A placeholder whose value is empty is left in the text as it is.");

/** Shown under the Model field. */
const MODEL_HELP =
    t("ID of the Venice model that does the translation. Pick one from the list or with a button below, or type any ID from the Venice catalog:") +
    ` <a href="${MODELS_PAGE}" external>${MODELS_PAGE}</a>`;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaults = {
    // Connection
    baseUrl                  : ENDPOINT,
    model                    : VM.DEFAULT_MODEL,
    includeVeniceSystemPrompt: false,
    disableThinking          : true,

    // Prompt
    escapeAlgorithm      : VU.DEFAULT_ESCAPE_ALGORITHM, // core
    systemMsgTemplate    : VP.SYSTEM_PROMPT,
    sampleDialog         : VP.SAMPLE_DIALOG[VU.DEFAULT_ESCAPE_ALGORITHM],
    bodyMsgTemplate      : VP.BODY_PROMPT,
    enableContext        : false,
    contextCharacterLimit: 2048,
    enableJailbreak      : false,
    jailbreakTemplate    : VP.JAILBREAK_NOTE,

    // Generation
    maxTokens       : 4096,
    reasoningEffort : "", // empty: the parameter is not sent at all
    temperature     : 0.15,
    top_p           : 1,
    frequencyPenalty: 0,
    presencePenalty : 0,
    useJsonSchema   : true,

    // Batches (core)
    maxRequestLength           : 2000,
    maxConcurrentRequest       : 1,
    rowLimitPerBatch           : 10,
    preserveInvalidReturnedRows: false,
    batchDelay                 : 5000,
    batchTimeOut               : 120000,

    // Checking the reply
    maxRetries                  : 2,
    retryIfRowCountMismatch     : true,
    retryIfLineCountMismatch    : false,
    splitOnRowCountMismatch     : true,
    truncatedReplyMode          : "retry",
    shortenRepetitions          : true,
    promptRetryRowCountMismatch : VP.RETRY_ROW_COUNT,
    promptRetryLineCountMismatch: VP.RETRY_LINE_COUNT,
    promptError                 : VP.RETRY_ERROR,

    // Request body
    customParameters: [],
    dropParameters  : [],
};

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

/** Field handlers: write the edited value straight into the engine options. */
const storeText    = (key) => function(evt) { engine.update(key, $(evt.target).val()); };
const storeInteger = (key) => function(evt) { engine.update(key, parseInt($(evt.target).val())); };
const storeDecimal = (key) => function(evt) { engine.update(key, parseFloat($(evt.target).val())); };
const storeSwitch  = (key) => function(evt) { engine.update(key, $(evt.target).prop("checked")); };
/** Array fields (tabarray) hand their value over through the form node. */
const storeList    = (key) => function() { engine.update(key, this.node.getValue()); };

/** A multi-line prompt field. */
const promptField = (key, height = "120px") => ({
    "key"     : key,
    "type"    : "ace",
    "aceMode" : "text",
    "aceTheme": "twilight",
    "width"   : "100%",
    "height"  : height,
    "wrap"    : true,
    "onChange": storeText(key),
});

/** Button that writes a model ID into the Model field. */
const modelButton = (model) => ({
    "type" : "button",
    "title": model.name,
    "onClick": function(evt) {
        evt.preventDefault();
        $(evt.target).closest("fieldset").find("input[name=model]").val(model.id);
        engine.update("model", model.id);
    }
});

/** Replace the sample dialogue both in the form and in the saved options. */
const applySampleDialog = (node, samples) => {
    engine.update("sampleDialog", samples);
    const field = node.getNodeByKey("sampleDialog");
    if (field) field.setValue(samples);
    else console.warn("[Venice] sample dialogue field not found");
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const engine = new TranslatorEngine({
    translatorType     : "v2",
    id                 : "veniceTranslator",
    name               : t("Venice Translator"),
    description        : thisAddon.package.description,
    version            : thisAddon.package.version,
    delimiter          : "\n\n",
    mode               : "rowByRow",
    showInterceptWindow: false,
    enableOptionManager: false,
    languages          : langTools.getLanguageList(["auto"]),
    lineSubstitute     : "\\r\\n",
    escapeAlgorithm    : defaults.escapeAlgorithm,
    batchTimeOut       : defaults.batchTimeOut,
    batchDelay         : defaults.batchDelay,
    maxRequestLength   : defaults.maxRequestLength,
    model              : defaults.model,

    optionsForm: {
        "id": "tlEngine-" + thisAddon.package.name,

        "schema": {
            "baseUrl": {
                "type": "string",
                "title": t("Target URL"),
                "description": t("Venice chat completions endpoint. Change it only if Venice publishes a different address.") +
                    `<br><code>${ENDPOINT}</code>`,
                "default": defaults.baseUrl,
            },
            "apiKey": {
                "type": "string",
                "title": t("API Key"),
                "description": t("Your Venice API key.") + ` <a href="${KEYS_PAGE}" external>${KEYS_PAGE}</a>`,
                "default": "",
                "required": true
            },
            "model": {
                "type": "string",
                "title": t("Model"),
                "description": MODEL_HELP,
                "default": defaults.model,
                "enum": VM.MODELS.map((model) => model.id),
                "required": true
            },
            "includeVeniceSystemPrompt": {
                "type": "boolean",
                "title": t("Include Venice system prompt"),
                "description": t("Venice prepends a system prompt of its own unless this is off. Keep it off so the model follows your template only."),
                "default": defaults.includeVeniceSystemPrompt
            },
            "disableThinking": {
                "type": "boolean",
                "title": t("Disable thinking"),
                "description": t("Skips the thinking phase of reasoning models: faster and cheaper for translation. The Venice Uncensored models do not reason, so it changes nothing for them."),
                "default": defaults.disableThinking
            },

            "enableContext": {
                "type": "boolean",
                "title": t("Enable context"),
                "description": t("Put the rows above the current batch, together with their translations, into <code>${CONTEXT}</code>. Your system message must contain that placeholder, as the default one does.") +
                    "<br>" + t("Context is what lets the model tell who is speaking, which matters most when the source language leaves the subject out."),
                "default": defaults.enableContext
            },
            "contextCharacterLimit": {
                "type": "number",
                "title": t("Context Character Limit"),
                "description": t("How many characters of previous rows to include at most."),
                "default": defaults.contextCharacterLimit
            },
            "systemMsgTemplate": {
                "type": "string",
                "title": t("System Message Template"),
                "description": t("The rules of the translation, sent as the first message of every request. Name the target language here: without it a model tends to answer in the language of the sample dialogue.") +
                    "<br>" + VARIABLES_HELP,
                "default": defaults.systemMsgTemplate,
                "required": true
            },
            "sampleDialog": {
                "type": "array",
                "default": defaults.sampleDialog,
                "items": {
                    "type": "object",
                    "title": t("Example"),
                    "properties": {
                        "user"     : { "type": "string", "title": t("Request") },
                        "assistant": { "type": "string", "title": t("Reply the model should imitate") },
                    }
                }
            },
            "bodyMsgTemplate": {
                "type": "string",
                "title": t("Body Message Template"),
                "description": t("The request itself, sent as the last user message. It must contain <code>${SOURCE_TEXT}</code>."),
                "default": defaults.bodyMsgTemplate,
                "required": true
            },
            "promptRetryRowCountMismatch": {
                "type": "string",
                "title": t("Retry prompt: wrong number of rows"),
                "description": t("Sent when the reply has more or fewer rows than the request."),
                "default": defaults.promptRetryRowCountMismatch,
            },
            "promptRetryLineCountMismatch": {
                "type": "string",
                "title": t("Retry prompt: wrong number of lines"),
                "description": t("Sent when a row came back with a different number of lines than its source."),
                "default": defaults.promptRetryLineCountMismatch,
            },
            "promptError": {
                "type": "string",
                "title": t("Retry prompt: what was wrong"),
                "description": t("Added after the prompts above and closes the corrective message."),
                "default": defaults.promptError,
            },
            "enableJailbreak": {
                "type": "boolean",
                "title": t("Enable jailbreak note"),
                "description": t("Adds the note below as a system message right before the last user message. The Venice Uncensored models do not need it."),
                "default": defaults.enableJailbreak
            },
            "jailbreakTemplate": {
                "type": "string",
                "title": t("Jailbreak note"),
                "description": t("Text of that note."),
                "default": defaults.jailbreakTemplate
            },

            "maxTokens": {
                "type": "number",
                "title": t("Maximum Tokens"),
                "description": t("Upper limit of one reply. Every request asks for less than this: about 1.5 tokens per character of its rows plus 200, so a model that gets stuck repeating itself stops early. A single row that needs more is sent again with this full limit.") +
                    "<br>" + t("A value above the output limit of the selected model is lowered automatically, and the log says so once."),
                "default": defaults.maxTokens,
                "minimum": 1,
                "maximum": 102400,
            },
            "reasoningEffort": {
                "type": "string",
                "title": t("Reasoning Effort"),
                "description": t("Only for reasoning models. <b>Auto</b> does not send the parameter at all. A model that rejects it gets the request again without it."),
                "default": defaults.reasoningEffort,
                "enum": ["", ...VU.REASONING_EFFORTS],
            },
            "temperature": {
                "type": "number",
                "title": t("Temperature"),
                "description": t("Lower values translate more literally and repeat the source structure; higher values write more freely. 0.15 to 0.3 suits translation. Change either this or top_p, not both."),
                "default": defaults.temperature,
                "minimum": 0,
                "maximum": 2,
            },
            "top_p": {
                "type": "number",
                "title": t("Nucleus sampling (top_p)"),
                "description": t("An alternative to temperature: the model only considers the most likely tokens that together make up this share of the probability mass."),
                "default": defaults.top_p,
                "minimum": 0,
                "maximum": 1,
            },
            "frequencyPenalty": {
                "type": "number",
                "title": t("Frequency Penalty"),
                "description": t("Pushes the model away from words it has already used often. Best left at 0 for translation; it does not stop repetition loops, the engine handles those itself."),
                "default": defaults.frequencyPenalty,
                "minimum": -2,
                "maximum": 2,
            },
            "presencePenalty": {
                "type": "number",
                "title": t("Presence Penalty"),
                "description": t("Pushes the model away from words it has used at all. Best left at 0 for translation."),
                "default": defaults.presencePenalty,
                "minimum": -2,
                "maximum": 2,
            },
            "useJsonSchema": {
                "type": "boolean",
                "title": t("Use JSON Schema"),
                "description": t("Send a strict schema in <code>response_format</code> instead of the deprecated <code>json_object</code>.") +
                    "<br>" + t("With numbered rows the schema also lists every row number, so the model has to return exactly one translation per row."),
                "default": defaults.useJsonSchema,
            },

            "maxRequestLength": {
                "type": "number",
                "title": t("Max Characters per Batch"),
                "description": t("Size of one batch, counted on the source text only, without the prompt. Japanese and Chinese are denser than English: their translations run two to three times longer, so keep the batch smaller for them."),
                "default": defaults.maxRequestLength,
                "attr": { "min": 20, "max": 1024 * 1024 }
            },
            "maxConcurrentRequest": {
                "type": "number",
                "title": t("Max concurrent requests"),
                "description": t("How many requests may be in flight at once. More is faster but reaches the rate limit sooner. Keep it at 1 while context is enabled, otherwise a request leaves before the previous translation is ready and the context goes out incomplete."),
                "default": defaults.maxConcurrentRequest,
                "attr": { "min": 0, "max": 50 }
            },
            "rowLimitPerBatch": {
                "type": "number",
                "title": t("Max row per concurrent requests"),
                "description": t("How many rows go into one request. <b>0</b> sends the whole batch as a single request.") +
                    "<br>" + t("Larger requests cost less overhead, because the system prompt is resent less often, and give the model more context; smaller ones lose less work when a reply has to be thrown away."),
                "default": defaults.rowLimitPerBatch,
                "attr": { "min": 0, "max": 1000 }
            },
            "preserveInvalidReturnedRows": {
                "type": "boolean",
                "title": t("Keep replies with the wrong number of rows"),
                "description": t("Write a reply into the grid even when its row count still does not match. Translations then land in the wrong rows, so leave this off: empty cells can simply be translated again."),
                "default": defaults.preserveInvalidReturnedRows
            },
            "batchDelay": {
                "type": "integer",
                "title": t("Batch delay"),
                "description": t("Pause between batches, in milliseconds."),
                "default": defaults.batchDelay,
            },
            "batchTimeOut": {
                "type": "number",
                "title": t("Batch Timeout"),
                "description": t("How long one HTTP request may take, in milliseconds. A request that takes longer is aborted and sent once more, so a value that is too low means paying twice for slow replies."),
                "default": defaults.batchTimeOut
            },

            "maxRetries": {
                "type": "number",
                "title": t("Number of retry"),
                "description": t("How many corrective retries a reply gets when it fails the checks. Every retry is another paid request."),
                "default": defaults.maxRetries,
                "minimum": 0,
            },
            "retryIfRowCountMismatch": {
                "type": "boolean",
                "title": t("Retry when the number of rows does not match"),
                "description": t("Also covers a reply that is not valid JSON."),
                "default": defaults.retryIfRowCountMismatch,
            },
            "retryIfLineCountMismatch": {
                "type": "boolean",
                "title": t("Retry when the number of lines in a row does not match"),
                "description": t("Useful when message windows have a fixed number of lines. The whole request is sent again, so with many rows per request retries become frequent."),
                "default": defaults.retryIfLineCountMismatch,
            },
            "splitOnRowCountMismatch": {
                "type": "boolean",
                "title": t("Split the request when the row count is still wrong"),
                "description": t("After the retries, split the rows in two and translate each half separately, down to single rows. What came back correctly is kept."),
                "default": defaults.splitOnRowCountMismatch,
            },
            "truncatedReplyMode": {
                "type": "string",
                "title": t("Reply cut off by the token limit"),
                "description": t("What to do when the reply stops in the middle because a row is very long.") +
                    "<ul>" +
                        t("<li><b>Translate the unfinished row again</b>: the half-written row is never put into the grid. Finished rows are kept and the rest is translated in smaller requests; a single row that still does not fit stays empty and is named in the log.</li>") +
                        t("<li><b>Repair and keep the unfinished row</b>: the reply is closed where it stopped and written as it is. The end of that row, and any game code in it, can be missing.</li>") +
                    "</ul>",
                "default": defaults.truncatedReplyMode,
                "enum": ["retry", "repair"],
            },
            "shortenRepetitions": {
                "type": "boolean",
                "title": t("Shorten long repetitions before sending"),
                "description": t("Models copy long runs endlessly, so a character repeated more than five times is cut back to five and a syllable repeated more than four times to four: \"HELP MEEEEEEEEEE\" goes out as \"HELP MEEEEE\". Only the request changes, the grid keeps the original, and digits, spaces and game codes are never touched."),
                "default": defaults.shortenRepetitions,
            },

            "escapeAlgorithm": {
                "type": "string",
                "title": t("Code Escaping Algorithm"),
                "description": t("How the rows of a request are packed for the model.") +
                    "<ul>" +
                        t("<li><b>Numbered rows</b> <code>{\"0\": \"…\"}</code>: every translation comes back under the number of its row, so a merged or dropped line spoils that row only. Recommended.</li>") +
                        t("<li><b>Array of rows</b> <code>[\"…\"]</code>: rows are matched by position, so one merged line shifts everything after it and the whole reply has to be rejected.</li>") +
                    "</ul>" +
                    t("Both formats hide game codes behind <code>${dat[n]}</code> placeholders; which codes are hidden is decided by the escaping patterns in the Translator++ options."),
                "default": defaults.escapeAlgorithm,
                "enum": ["JSONObjectCloaking", "JSONCloaking"],
            },

            "customParameters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "title": t("Parameter"),
                    "properties": {
                        "key"  : { "type": "string", "title": t("Key") },
                        "value": { "type": "string", "title": t("Value") },
                        "type" : {
                            "type": "string",
                            "title": t("Type"),
                            "enum": ["string", "number", "boolean", "javascript"],
                            "description": t("How the value is read. <b>javascript</b> evaluates it as an expression in the scope of <code>window</code>, for example <code>trans.project.title</code>.")
                        },
                    }
                }
            },
            "dropParameters": {
                "type": "json",
                "title": t("Drop Parameters"),
                "description": t("Names of fields that are never sent. Parameters a model rejects are dropped automatically as well, for the rest of the session."),
                "default": defaults.dropParameters
            },
        },

        "form": [
            {
                "type": "formcontrol",
                "title": t("Manage configuration"),
                "onPresetLoad": function(value) {
                    if (!value) return;
                    engine.setOptions(value);
                },
                "onReset": function(node) {
                    engine.resetOptions();
                    node.ownerTree.formDesc.value = engine.getDefaultOptions();
                },
                "presets": [
                    { name: t("Game dialogue"), file: thisAddon.getRelativePath("data/presets/dialogue.jsv") },
                    { name: t("RPG Maker"),     file: thisAddon.getRelativePath("data/presets/rpgmaker.jsv") },
                ]
            },
            {
                "type": "info",
                "content": t("Translates through the Venice.ai chat completions API.") +
                    ` <a href="${KEYS_PAGE}" external>${t("Get an API key")}</a>`
            },
            {
                "type": "fieldset",
                "title": t("Venice API settings"),
                "items": [
                    {
                        "type": "tabs",
                        "id": "veniceTabs",
                        "items": [
                            {
                                "type": "tab",
                                "title": t("Connection"),
                                "items": [
                                    { "key": "baseUrl", "onChange": storeText("baseUrl") },
                                    { "key": "apiKey", "type": "password", "onChange": storeText("apiKey") },
                                    {
                                        "key": "model",
                                        "type": "combobox",
                                        "options": VM.MODELS.map((model) => ({ value: model.id, label: model.name })),
                                        "onChange": storeText("model")
                                    },
                                    {
                                        "type": "actions",
                                        "items": [
                                            ...VM.MODELS.filter((model) => model.quickPick).map(modelButton),
                                            {
                                                "type": "button",
                                                "title": t("Venice model catalog"),
                                                "onClick": function(evt) {
                                                    evt.preventDefault();
                                                    nw.Shell.openExternal(MODELS_PAGE);
                                                }
                                            }
                                        ]
                                    },
                                    { "key": "includeVeniceSystemPrompt", "inlinetitle": t("Include Venice system prompt"), "onChange": storeSwitch("includeVeniceSystemPrompt") },
                                    { "key": "disableThinking", "inlinetitle": t("Disable thinking"), "onChange": storeSwitch("disableThinking") },
                                ]
                            },
                            {
                                "type": "tab",
                                "title": t("Prompt"),
                                "items": [
                                    { "key": "enableContext", "inlinetitle": t("Enable context"), "onChange": storeSwitch("enableContext") },
                                    { "key": "contextCharacterLimit", "onChange": storeInteger("contextCharacterLimit") },
                                    promptField("systemMsgTemplate", "260px"),
                                    {
                                        "type": "html",
                                        "value": t("<h2>Sample dialogue</h2>") +
                                            t("<p>A request and the reply the model should imitate. Keep the examples in your own language pair: examples answered in English make the model answer in English, whatever the target language is.</p>") +
                                            t("<p>An example with an empty half is skipped. The JSON of an example is converted to the packing format in use when the request is sent.</p>")
                                    },
                                    {
                                        "type": "tabarray",
                                        "draggable": false,
                                        "items": {
                                            "type": "section",
                                            "items": [
                                                { "key": "sampleDialog[].user", "type": "ace", "height": "120px" },
                                                { "key": "sampleDialog[].assistant", "type": "ace", "height": "120px" },
                                            ]
                                        },
                                        "onChange": storeList("sampleDialog")
                                    },
                                    {
                                        "type": "actions",
                                        "items": [
                                            {
                                                "type": "button",
                                                "title": t("Add a ready-made example"),
                                                "onClick": function(evt, node) {
                                                    evt.preventDefault();
                                                    evt.stopPropagation();
                                                    const algorithm = VU.normalizeEscapeAlgorithm(engine.getOptions("escapeAlgorithm"));
                                                    const samples = VU.asArray(engine.getOptions("sampleDialog")).concat(VP.SAMPLE_DIALOG[algorithm]);
                                                    applySampleDialog(node, samples);
                                                }
                                            },
                                            {
                                                "type": "button",
                                                "title": t("Clear the examples"),
                                                "onClick": function(evt, node) {
                                                    evt.preventDefault();
                                                    evt.stopPropagation();
                                                    applySampleDialog(node, []);
                                                }
                                            }
                                        ]
                                    },
                                    promptField("bodyMsgTemplate", "100px"),
                                    {
                                        "type": "fieldset",
                                        "title": t("Corrective retries"),
                                        "items": [
                                            {
                                                "type": "html",
                                                "value": t("<p>On a retry the model sees its own failed reply, followed by one user message built from the prompts below.</p>")
                                            },
                                            promptField("promptRetryRowCountMismatch", "110px"),
                                            promptField("promptRetryLineCountMismatch", "110px"),
                                            promptField("promptError", "140px"),
                                        ]
                                    },
                                    { "key": "enableJailbreak", "inlinetitle": t("Enable jailbreak note"), "onChange": storeSwitch("enableJailbreak") },
                                    promptField("jailbreakTemplate", "100px"),
                                ]
                            },
                            {
                                "type": "tab",
                                "title": t("Generation"),
                                "items": [
                                    { "key": "maxTokens", "type": "range", "step": 1, "indicator": true, "onChange": storeInteger("maxTokens") },
                                    {
                                        "key": "reasoningEffort",
                                        "type": "select",
                                        "titleMap": {
                                            ""       : t("Auto: do not send the parameter"),
                                            "none"   : t("None"),
                                            "minimal": t("Minimal"),
                                            "low"    : t("Low"),
                                            "medium" : t("Medium"),
                                            "high"   : t("High"),
                                            "xhigh"  : t("Very high"),
                                            "max"    : t("Maximum")
                                        },
                                        "onChange": storeText("reasoningEffort")
                                    },
                                    { "key": "temperature", "type": "range", "step": 0.05, "indicator": true, "onChange": storeDecimal("temperature") },
                                    { "key": "top_p", "type": "range", "step": 0.1, "indicator": true, "onChange": storeDecimal("top_p") },
                                    { "key": "frequencyPenalty", "type": "range", "step": 0.1, "indicator": true, "onChange": storeDecimal("frequencyPenalty") },
                                    { "key": "presencePenalty", "type": "range", "step": 0.1, "indicator": true, "onChange": storeDecimal("presencePenalty") },
                                    { "key": "useJsonSchema", "inlinetitle": t("Use JSON Schema"), "onChange": storeSwitch("useJsonSchema") },
                                ]
                            },
                            {
                                "type": "tab",
                                "title": t("Extra parameters"),
                                "items": [
                                    {
                                        "type": "info",
                                        "content": t("Fields added to the request body that the form does not cover, for example <code>min_p</code>, <code>top_k</code> or <code>repetition_penalty</code>. They are applied last, so they override anything above.")
                                    },
                                    {
                                        "type": "warn",
                                        "content": "<ul>" +
                                            t("<li>Venice answers with an HTTP error when a parameter is unknown to the model.</li>") +
                                            t("<li>A key used twice keeps its last value.</li>") +
                                            t("<li>A custom <code>venice_parameters</code> replaces the whole object the engine builds.</li>") +
                                            "</ul>"
                                    },
                                    {
                                        "type": "tabarray",
                                        "items": {
                                            "type": "section",
                                            "legend": "{{idx}}. {{value}}",
                                            "items": [
                                                { "key": "customParameters[].key", "valueInLegend": true },
                                                { "key": "customParameters[].value" },
                                                {
                                                    "key": "customParameters[].type",
                                                    "type": "select",
                                                    "titleMap": {
                                                        "string"    : t("Text"),
                                                        "number"    : t("Number"),
                                                        "boolean"   : t("Yes / no"),
                                                        "javascript": t("JavaScript")
                                                    }
                                                },
                                            ]
                                        },
                                        "onChange": storeList("customParameters")
                                    },
                                    {
                                        "key": "dropParameters",
                                        "type": "tag",
                                        "onChange": function() { engine.update("dropParameters", this.getValue() || []); }
                                    },
                                ]
                            },
                        ]
                    },
                    {
                        "type": "actions",
                        "items": [{
                            "type": "button",
                            "title": t("Open the tester"),
                            "onClick": function(evt) {
                                evt.preventDefault();
                                thisAddon.openTesterWindow();
                            }
                        }]
                    }
                ]
            },
            {
                "type": "fieldset",
                "title": t("Batch Translation Setting"),
                "items": [
                    { "key": "batchTimeOut", "onChange": storeInteger("batchTimeOut") },
                    {
                        "key": "batchDelay",
                        "onChange": function(evt) {
                            // Translator++ reserves this field for its patrons; the same check as in its own engines.
                            if (!updater || updater.getUser().level < 100) {
                                ui.alert(t("Sorry, this addon is only available for active patrons only.\nYou can unlock this feature by becoming a $1 patron."), "options");
                                $(evt.target).val(defaults.batchDelay);
                                engine.update("batchDelay", defaults.batchDelay);
                                return;
                            }
                            engine.update("batchDelay", parseInt($(evt.target).val()));
                        }
                    },
                    { "key": "maxRequestLength", "onChange": storeInteger("maxRequestLength") },
                    { "key": "maxConcurrentRequest", "onChange": storeInteger("maxConcurrentRequest") },
                    { "key": "rowLimitPerBatch", "onChange": storeInteger("rowLimitPerBatch") },
                    { "key": "preserveInvalidReturnedRows", "inlinetitle": t("Keep replies with the wrong number of rows"), "onChange": storeSwitch("preserveInvalidReturnedRows") },
                ]
            },
            {
                "type": "fieldset",
                "title": t("Retries and checks"),
                "items": [
                    {
                        "type": "info",
                        "content": t("Every reply is checked before it reaches the grid: the number of rows, optionally the number of lines in each row, and the content of each row (a copy of the source, text left untranslated, a lost game code). A reply that fails is sent back to the model with an explanation, and if that does not help the request is split into smaller ones.") +
                            "<br>" + t("Each retry costs time and money. Frequent retries usually mean the system message has to be clearer, or that fewer rows should go into one request.")
                    },
                    {
                        "key": "maxRetries",
                        "onChange": function(evt) {
                            const value = parseInt($(evt.target).val());
                            engine.update("maxRetries", Number.isNaN(value) ? 0 : value);
                        }
                    },
                    { "key": "retryIfRowCountMismatch", "inlinetitle": t("Retry when the number of rows does not match"), "onChange": storeSwitch("retryIfRowCountMismatch") },
                    { "key": "retryIfLineCountMismatch", "inlinetitle": t("Retry when the number of lines in a row does not match"), "onChange": storeSwitch("retryIfLineCountMismatch") },
                    { "key": "splitOnRowCountMismatch", "inlinetitle": t("Split the request when the row count is still wrong"), "onChange": storeSwitch("splitOnRowCountMismatch") },
                    {
                        "key": "truncatedReplyMode",
                        "type": "select",
                        "titleMap": {
                            "retry" : t("Translate the unfinished row again (recommended)"),
                            "repair": t("Repair and keep the unfinished row")
                        },
                        "onChange": storeText("truncatedReplyMode")
                    },
                    { "key": "shortenRepetitions", "inlinetitle": t("Shorten long repetitions before sending"), "onChange": storeSwitch("shortenRepetitions") },
                ]
            },
            {
                "type": "fieldset",
                "title": t("Packing the rows"),
                "items": [
                    {
                        "type": "info",
                        "content": t("Game codes such as <code>\\C[1]</code> are replaced with <code>${dat[n]}</code> placeholders before the request and put back afterwards. Which codes are hidden is set in the Translator++ options under <b>Custom escape</b>; the field below only decides how the rows are packed.") +
                            ` <a href="${ESCAPE_DOCS}" external>${t("About code escaping")}</a>`
                    },
                    {
                        "key": "escapeAlgorithm",
                        "titleMap": {
                            "JSONObjectCloaking": t("Numbered rows (recommended)"),
                            "JSONCloaking"      : t("Array of rows")
                        },
                        "onChange": function(evt, node) {
                            const value = $(evt.target).val();
                            engine.update("escapeAlgorithm", value);

                            // The examples must speak the same format as the request, or the model imitates the wrong one.
                            const algorithm = VU.normalizeEscapeAlgorithm(value);
                            const conversion = VU.convertSampleDialog(engine.getOptions("sampleDialog"), algorithm);
                            const view = (evt.target[0] || evt.target).ownerDocument.defaultView;
                            if (conversion.payloads > 0) {
                                if (conversion.changed > 0 && view.confirm(t("Rewrite the JSON of your examples for the selected format? Your texts stay as they are."))) {
                                    applySampleDialog(node, conversion.samples);
                                }
                            } else if (view.confirm(t("Load the ready-made examples for the selected format? This replaces the examples you have now."))) {
                                applySampleDialog(node, VP.SAMPLE_DIALOG[algorithm]);
                            }
                        }
                    },
                ]
            },
        ]
    }
}, defaults);

/** Stages Translator++ runs for each batch; the engine's own work happens in "translate". */
engine.translationFlow = [
    "translateWithReference",
    "beforeTranslateCommonRoutine",
    "appendActorName",
    "translate",
    "stripActorName",
    "afterTranslateCommonRoutine",
    "applyToGrid",
    "saveProject",
    "displayResult",
    "logAsBatchManager",
    "batchDelay"
];

/** Extra options this engine adds to the Translate All dialog. */
engine.batchTranslationOptions = function() {
    return {
        schema: {
            "alwaysSparateFile": {
                "type": "boolean",
                "title": t("Always separate file"),
                "description": t("Never mix rows of different files in one batch, so the context of a batch stays within one file."),
                "default": false,
            },
            "addActorName": {
                "type": "boolean",
                "title": t("Add actor name"),
                "description": t("Put the name of the speaker in front of each row and strip it from the translation. It helps with pronouns and gender, and costs extra tokens."),
                "default": false,
            },
            "useActorReference": {
                "type": "boolean",
                "title": t("Load Actor Reference as Glossary"),
                "description": t("Put the characters mentioned in a request into <code>${ACTOR_INFO}</code>, which the default system message already contains. Only the characters of that batch are sent."),
                "default": false,
            },
            "actorReferenceTranslationColumn": {
                "type": "string",
                "title": t("Actor Reference Translation Column"),
                "description": t("Column of the Actor Reference table that holds the translated names, so a name is spelled the same everywhere."),
            },
            "actorReferenceInfoColumn": {
                "type": "string",
                "title": t("Actor's Information Column"),
                "description": t("Column with what else the model should know about a character: gender, age, how they speak."),
            },
            "extraPrompt": {
                "type": "string",
                "title": t("Extra Prompt"),
                "description": t("Added to the system message for this run only.") + "<br>" + VARIABLES_HELP,
            },
        },
        form: [
            {
                "type": "fieldset",
                "title": t("Batches"),
                "items": [
                    { "key": "alwaysSparateFile", "inlinetitle": t("Never mix files in one batch") },
                    { "key": "addActorName", "inlinetitle": t("Send the speaker's name with each row") },
                ]
            },
            {
                "type": "fieldset",
                "title": t("Characters"),
                "items": [
                    {
                        "type": "html",
                        "value": t("<p>Tells the model who the characters of a batch are. For a language that leaves the subject out, such as Japanese, this and the context are what keep gender and pronouns right.</p>")
                    },
                    { "key": "useActorReference", "inlinetitle": t("Load Actor Reference as Glossary") },
                    { "key": "actorReferenceTranslationColumn", "type": "selectcolumn", "title": t("Column with the translated names") },
                    { "key": "actorReferenceInfoColumn", "type": "selectcolumn", "title": t("Column with the character information") },
                ]
            },
            {
                "type": "fieldset",
                "title": t("Prompt"),
                "items": [
                    { "key": "extraPrompt", "type": "ace", "aceMode": "text", "aceTheme": "twilight", "width": "100%", "height": "120px", "wrap": true },
                ]
            },
        ]
    };
};

thisAddon.engine = engine;
thisAddon.resolveState("optionIsLoaded");
