/**
 * Venice translator engine: request pipeline.
 *
 * The engine object and its settings form are created in veniceSettings.js. This script adds
 * what happens when Translator++ asks the engine to translate:
 *
 *   fetchTranslation()               entry point, called by TranslatorEngine.translate()
 *     └ translateJob()               recovers from cut-off replies and wrong row counts
 *         ├ requestTranslation()     prompt → reply → validation → corrective retries
 *         │   └ fetch()              HTTP request with back-off and parameter fallback
 *         │       └ sendRequest()    one round trip limited by a timeout
 *         └ translateParts()         smaller follow-up requests (each one a translateJob again)
 *
 * Only the two JSON escape algorithms are supported (JSONObjectCloaking, JSONCloaking).
 * Parsing, validation, JSON repair and error normalisation live in lib/veniceUtils.js.
 */
const thisAddon = this;
await thisAddon.until("optionIsLoaded");

const libGPT     = require("www/js/LibGpt.js");
const VU         = require(thisAddon.getRelativePath("lib/veniceUtils.js"));
const VM         = require(thisAddon.getRelativePath("lib/veniceModels.js"));
const thisEngine = thisAddon.engine;

/** Attempts for HTTP 429/5xx replies, the first request included. */
const MAX_HTTP_ATTEMPTS = 4;
/** Attempts after a network error or a timeout, the first request included. */
const MAX_NETWORK_ATTEMPTS = 2;
/** How many times a request is resent after dropping parameters the model rejected. */
const MAX_PARAMETER_FIXES = 3;
/** Used when "Batch Timeout" holds no valid number; the same as the default setting. */
const DEFAULT_REQUEST_TIMEOUT = 120000;
/** Temperature (at least) of the one extra attempt for a row the model got stuck repeating on. */
const LOOP_RETRY_TEMPERATURE = 0.7;
/** Added to the system prompt of that attempt. */
const LOOP_HINT = 'Write screams, moans and stutters with at most three repeats (for example "Aaah!", not "Aaaaaaaa..."), then translate the rest of the line.';

/** Models whose output-limit cap has already been reported in the log. */
const cappedModels = new Set();

/**
 * Parameters rejected by a model during this session, keyed by model ID.
 * Kept in memory only: after switching models the parameter may be valid again.
 * @type {Map<string, Set<string>>}
 */
const rejectedParameters = new Map();

const wait      = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log       = (message) => ui.log(VU.escapeHtml(`[Venice] ${message}`));
const emptyRows = (count) => Array(count).fill("");
const capAt     = (value, limit) => (limit && value > limit ? limit : value);

function rememberRejectedParameters(model, parameters) {
    rejectedParameters.set(model, new Set([...(rejectedParameters.get(model) ?? []), ...parameters]));
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/**
 * Escape algorithm in effect: always one of the two JSON formats. An empty value or one that is
 * no longer offered (saved by an older version) resolves to JSONObjectCloaking.
 */
thisEngine.getEscapeAlgorithm = function() {
    return VU.normalizeEscapeAlgorithm(this.getOptions("escapeAlgorithm"));
};

/**
 * Make the core preprocessing use the same escape algorithm as the rest of the pipeline.
 * CodeEscape.unescape() treats an empty text as "restore the whole request" (text || this.text), so a
 * row the engine leaves empty would come back as the JSON of the entire request and end up in the
 * cell. Empty rows are restored as empty rows instead.
 */
thisEngine.preProcessText = function(text, options) {
    this.escapeAlgorithm = this.getEscapeAlgorithm();
    const textObj = TranslatorEngine.prototype.preProcessText.call(this, text, options);
    const unescape = textObj?.unescape;
    if (typeof unescape === "function") {
        textObj.unescape = function(value, ...rest) {
            return (value ?? "") === "" ? "" : unescape.call(this, value, ...rest);
        };
    }
    return textObj;
};

/** Replace a saved escape algorithm that is no longer offered, so the form shows what is used. */
thisEngine.migrateOptions = function() {
    const effective = this.getEscapeAlgorithm();
    if (this.getOptions("escapeAlgorithm") !== effective) this.update("escapeAlgorithm", effective);
};

thisEngine.getMaxRetries = function() {
    const value = parseInt(this.getOptions("maxRetries"));
    return value > 0 ? value : 0;
};

/** Timeout of one HTTP request, taken from "Batch Timeout". */
thisEngine.getRequestTimeout = function() {
    const value = Number(this.getOptions("batchTimeOut"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_REQUEST_TIMEOUT;
};

/**
 * What to do with a reply cut off by the token limit: "retry" (default, the unfinished row is
 * translated again in a smaller request) or "repair" (the reply is closed and kept as is).
 */
thisEngine.getTruncatedReplyMode = function() {
    return this.getOptions("truncatedReplyMode") === "repair" ? "repair" : "retry";
};

/** ID of the model the requests go to. */
thisEngine.getModelId = function() {
    return this.getOptions("model") || this.model;
};

/** Output limit of the selected model, when the add-on knows it. */
thisEngine.getModelOutputLimit = function() {
    return VM.getMaxCompletionTokens(this.getModelId());
};

/** max_tokens actually sent for the full setting: capped at the output limit of a known model. */
thisEngine.getEffectiveMaxTokens = function() {
    return capAt(Number(this.getOptions("maxTokens")), this.getModelOutputLimit());
};

/**
 * max_tokens of one translation request: never more than its reply can need (VU.estimateReplyTokens:
 * about 1.5 tokens per source character), so a model that gets stuck repeating itself stops early.
 * A single row that really needs more is sent again with the full setting (job.fullTokenLimit).
 * adaptParameters() still caps the value at the model's output limit.
 */
thisEngine.getRequestMaxTokens = function(job) {
    const setting = Number(this.getOptions("maxTokens"));
    const estimate = VU.estimateReplyTokens(job?.payload);
    if (!Number.isFinite(setting) || setting <= 0) return estimate;
    return job?.fullTokenLimit ? setting : Math.min(setting, estimate);
};

/** The request's max_tokens as the model receives it (capped at its output limit), for log messages. */
thisEngine.getSentMaxTokens = function(job) {
    return capAt(this.getRequestMaxTokens(job), this.getModelOutputLimit());
};

/** Temperature of the extra attempt for a looping row: the setting, raised to LOOP_RETRY_TEMPERATURE. */
thisEngine.getLoopRetryTemperature = function() {
    return Math.max(LOOP_RETRY_TEMPERATURE, Number(this.getOptions("temperature")) || 0);
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** The request body as sent. A method of its own because Translator++'s batch logging calls it too. */
thisEngine.requestBodyToString = function(requestBody) {
    return JSON.stringify(requestBody);
};

/**
 * Build the chat-completions request body from the settings.
 * @param {Object[]} messages
 * @param {Object|null} [responseFormat]
 * @param {number} [maxTokens] - max_tokens of this request (default: the Maximum Tokens setting)
 * @param {number} [temperature] - temperature of this request (default: the Temperature setting)
 * @returns {Object}
 */
thisEngine.buildRequestBody = function(messages, responseFormat, maxTokens, temperature) {
    let body = {
        model            : this.getModelId(),
        messages,
        temperature      : temperature ?? this.getOptions("temperature"),
        max_tokens       : maxTokens ?? this.getOptions("maxTokens"),
        top_p            : this.getOptions("top_p"),
        frequency_penalty: this.getOptions("frequencyPenalty"),
        presence_penalty : this.getOptions("presencePenalty"),
        venice_parameters: VU.buildVeniceParameters({
            includeVeniceSystemPrompt: this.getOptions("includeVeniceSystemPrompt"),
            disableThinking          : this.getOptions("disableThinking"),
        }),
    };

    // Only sent when chosen explicitly: support and accepted values depend on the model.
    const reasoningEffort = this.getOptions("reasoningEffort");
    if (VU.REASONING_EFFORTS.includes(reasoningEffort)) body.reasoning_effort = reasoningEffort;
    if (responseFormat) body.response_format = responseFormat;

    // Custom parameters are applied last, so they can override anything above (venice_parameters too).
    body = libGPT.renderCustomParameters(VU.asArray(this.getOptions("customParameters")), body);
    body = libGPT.dropParameters(body, [
        ...VU.asArray(this.getOptions("dropParameters")),
        ...(rejectedParameters.get(body.model) ?? []),
    ]);
    return this.adaptParameters(body);
};

/** Per-model quirks. Venice normalises most parameters itself. */
thisEngine.adaptParameters = function(requestBody) {
    const model = String(requestBody.model ?? "");
    const outputLimit = VM.getMaxCompletionTokens(model);
    if (outputLimit && Number(requestBody.max_tokens) > outputLimit) {
        if (!cappedModels.has(model)) {
            cappedModels.add(model);
            log(`"Maximum Tokens" (${requestBody.max_tokens}) is above the output limit of ${model}; sending ${outputLimit}.`);
        }
        requestBody.max_tokens = outputLimit;
    }
    if (model.startsWith("grok-")) {
        // xAI models reject the penalty parameters.
        delete requestBody.presence_penalty;
        delete requestBody.frequency_penalty;
    }
    return requestBody;
};

/**
 * One HTTP round trip limited by the request timeout.
 * Rejects only on network errors and timeouts; HTTP errors are returned as a reply.
 * @returns {Promise<{status: number, headers: Object, text: string, body: *}>}
 */
thisEngine.sendRequest = async function(url, request) {
    const timeout    = this.getRequestTimeout();
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...request, signal: controller.signal });
        const text = await response.text();
        return { status: response.status, headers: Object.fromEntries(response.headers), text, body: VU.tryParseJson(text) };
    } catch (error) {
        if (!controller.signal.aborted) throw error;
        const timeoutError = new Error(`The request timed out after ${Math.round(timeout / 1000)} s.`);
        timeoutError.name = "TimeoutError";
        throw timeoutError;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Send a chat-completions request to Venice.
 * - HTTP 429/5xx, network errors and timeouts are retried with back-off.
 * - Parameters the model rejects are dropped for the rest of the session and the request is resent.
 * - The API key never reaches logs: batchInfo and onBeforeFetch receive a redacted copy.
 * @param {Object[]} messages - e.g. [{role: "user", content: "..."}]
 * @param {Object} [options]
 * @param {Object|null} [options.responseFormat] - response_format to request
 * @param {number} [options.maxTokens] - max_tokens of this request (default: the Maximum Tokens setting)
 * @param {number} [options.temperature] - temperature of this request (default: the Temperature setting)
 * @param {Object} [options.batchInfo] - Batch translation info; request and response are recorded there
 * @param {Function} [options.onBeforeFetch] - Receives the (redacted) request
 * @param {Function} [options.onAfterFetch] - Receives the reply
 * @returns {Promise<Object>} API reply, or `{error: {message, status, ...}}` when the request finally failed
 */
thisEngine.fetch = async function(messages, options = {}) {
    const url     = this.getOptions("baseUrl") || this.baseUrl;
    const apiKey  = this.getOptions("apiKey");
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let body = this.buildRequestBody(messages, options.responseFormat, options.maxTokens, options.temperature);
    const request = { method: "POST", headers, redirect: "follow", body: this.requestBodyToString(body) };
    const recordRequest = () => {
        const loggable = { ...request, headers: VU.redactHeaders(headers), body };
        if (options.batchInfo?.info) options.batchInfo.info.request = loggable;
        return loggable;
    };

    const loggableRequest = recordRequest();
    options.onBeforeFetch?.(loggableRequest);
    await this.checkOnlineStatus?.();

    let httpAttempts = 0;
    let networkAttempts = 0;
    let parameterFixes = 0;
    let result;
    for (;;) {
        let response;
        try {
            response = await this.sendRequest(url, request);
        } catch (networkError) {
            networkAttempts++;
            if (networkAttempts < MAX_NETWORK_ATTEMPTS) {
                const delay = VU.getRetryDelayMs(0, {}, networkAttempts);
                log(`${networkError.message} Retrying in ${Math.round(delay / 1000)} s...`);
                await wait(delay);
                continue;
            }
            result = {
                error: {
                    message: networkError.message,
                    status : 0,
                    code   : networkError.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
                },
            };
            break;
        }

        if (options.batchInfo?.info) {
            options.batchInfo.info.response = { status: response.status, body: response.body ?? response.text };
        }
        const error = VU.normalizeApiError(response.status, response.body, response.text);
        if (!error) {
            result = response.body;
            break;
        }

        httpAttempts++;
        if (error.retryable && httpAttempts < MAX_HTTP_ATTEMPTS) {
            const delay = VU.getRetryDelayMs(response.status, response.headers, httpAttempts);
            log(`HTTP ${response.status}: ${error.message} Retrying in ${Math.round(delay / 1000)} s...`);
            await wait(delay);
            continue;
        }

        const rejected = VU.findRejectedParameters(error, body);
        if (rejected.length && parameterFixes < MAX_PARAMETER_FIXES) {
            parameterFixes++;
            rememberRejectedParameters(body.model, rejected);
            log(`The model "${body.model}" rejected ${rejected.join(", ")}: ${error.message} `
                + `Resending without it; it stays dropped for this model until Translator++ restarts.`);
            body = libGPT.dropParameters(body, rejected);
            request.body = this.requestBodyToString(body);
            recordRequest();
            continue;
        }

        result = { ...(VU.isPlainObject(response.body) ? response.body : {}), error };
        break;
    }

    options.onAfterFetch?.(result);
    return result;
};

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translator++ entry point, called by TranslatorEngine.translate().
 * @param {string|string[]} texts - Escaped payload: one JSON string holding every row
 * @param {string} _sourceLanguage - Source language code (the prompt takes the languages from the project)
 * @param {string} targetLanguage - Target language code
 * @param {Object} textObj - Escape-algorithm object; `originalTexts` are the unescaped rows
 * @param {Object} [options] - Translation options (batchInfo, translatorOptions, tester callbacks...)
 * @returns {Promise<string>} Reply in the shape textObj.afterTranslation() expects
 */
thisEngine.fetchTranslation = async function(texts, _sourceLanguage, targetLanguage, textObj, options) {
    options ??= {};
    let payload = Array.isArray(texts) ? texts.join("\n") : String(texts ?? "");
    const originals = Array.isArray(textObj?.originalTexts) ? textObj.originalTexts
        : Array.isArray(texts) ? texts
        : [payload];

    // Long runs such as "Hyaaaaaaaaaaaa" make the model loop; only the request changes, not the grid.
    if (this.getOptions("shortenRepetitions") !== false) payload = VU.shortenPayloadRepetitions(payload);

    const job = { payload, originals, algorithm: this.getEscapeAlgorithm(), options, targetLanguage };
    const content = await this.translateJob(job, 0);
    options.getRawResponse?.(content);
    return content;
};

/**
 * Translate one job and recover from two kinds of bad replies:
 * - a reply cut off by the token limit ("retry" mode): see recoverTruncatedJob();
 * - a wrong number of rows after every retry: the rows are split in two and translated
 *   separately (recursively, down to single rows), so one problematic line no longer leaves
 *   the whole batch untranslated.
 * @param {{payload: string, originals: string[], algorithm: string, options: Object}} job
 * @param {number} depth - 0 for the request Translator++ made, >0 for follow-up requests (no retries)
 * @returns {Promise<string>}
 */
thisEngine.translateJob = async function(job, depth) {
    const maxRetries = depth === 0 ? this.getMaxRetries() : 0;
    const { content, validation, truncated, looped } = await this.requestTranslation(job, maxRetries);
    if (truncated && this.getTruncatedReplyMode() === "retry") return this.recoverTruncatedJob(job, depth, content, looped);
    if (!validation.rowCountError || !this.getOptions("splitOnRowCountMismatch")) return content;

    const total = job.originals.length;
    const rows  = VU.parseEscapedPayload(job.payload);
    if (!rows || rows.length !== total || total < 2) return content;

    const middle = Math.ceil(total / 2);
    log(`The reply had ${validation.returnedCount} row(s) instead of ${total}. `
        + `Splitting the request into ${middle} + ${total - middle} row(s).`);
    const translated = await this.translateParts(job, depth, rows, [[0, middle], [middle, total]]);
    return VU.buildResultPayload(translated, job.algorithm);
};

/**
 * A reply was cut off by the token limit ("retry" mode). The unfinished row is never written:
 * rows the model completed are kept and the remaining ones are translated in smaller requests.
 * With JSONObjectCloaking the completed rows are recognised by their keys; a cut-off JSONCloaking
 * array cannot be trusted (a merged row earlier in it would go unnoticed), so its rows are
 * translated again in halves. A single row cut off below Maximum Tokens (the request asked for
 * less, see getRequestMaxTokens) is sent once more with the full setting; a row that does not fit
 * even then is left empty.
 * @param {Object} job
 * @param {number} depth
 * @param {string} content - The reply cut back to its complete elements (plus a rescued looping row)
 * @param {boolean} [looped] - The reply ended in a repetition loop that could not be rescued. A single row is
 *        translated once more with a higher temperature and a hint (job.loopRetry), then left empty.
 * @returns {Promise<string>}
 */
thisEngine.recoverTruncatedJob = async function(job, depth, content, looped = false) {
    const total = job.originals.length;
    const rows  = VU.parseEscapedPayload(job.payload);
    const kept  = VU.leadingCompleteRows(content, job.algorithm).slice(0, total);
    if (kept.length === total) return VU.buildResultPayload(kept, job.algorithm);

    if (total === 1 || !rows || rows.length !== total) {
        const source = VU.preview(job.originals.join(" / "), 120);
        const leaveEmpty = () => VU.buildResultPayload(emptyRows(total), job.algorithm);
        if (looped && !job.loopRetry) {
            // A longer limit would only give the loop more room; a higher temperature and a hint usually break it.
            log(`The model got stuck repeating itself on this row; translating it once more with temperature `
                + `${this.getLoopRetryTemperature()} and a hint to keep repeats short.`);
            return this.translateJob({ ...job, loopRetry: true }, depth + 1);
        }
        if (looped) {
            log(`Left untranslated: the model got stuck repeating itself on this row, and the repetition cannot be cut off `
                + `without losing the rest of the row. Translate it by hand, or hide the repeated characters with a `
                + `Custom escape pattern. Source: ${source}`);
            return leaveEmpty();
        }
        const used = this.getSentMaxTokens(job);
        const full = this.getEffectiveMaxTokens();
        if (!job.fullTokenLimit && used < full) {
            log(`The row needs a longer reply than max_tokens = ${used}; translating it again with Maximum Tokens (${full}).`);
            return this.translateJob({ ...job, fullTokenLimit: true }, depth + 1);
        }
        log(`Left untranslated: even on its own, the reply for this row did not fit into max_tokens = ${used} `
            + `(a very long row). Translate it by hand or raise "Maximum Tokens". Source: ${source}`);
        return leaveEmpty();
    }

    const middle = Math.ceil(total / 2);
    let ranges = [[0, middle], [middle, total]];
    if (kept.length > 0) ranges = [[kept.length, total]];
    else if (job.algorithm === "JSONObjectCloaking") ranges = [[0, 1], [1, total]];

    log(`The unfinished row is not written: ${kept.length} of ${total} row(s) were complete. `
        + `Translating the remaining ${total - kept.length} row(s) in smaller requests.`);
    const rest = await this.translateParts(job, depth, rows, ranges);
    return VU.buildResultPayload([...kept, ...rest], job.algorithm);
};

/**
 * Translate slices of a job as separate, smaller requests (each one goes through translateJob again).
 * @param {Object} job
 * @param {number} depth
 * @param {string[]} rows - Escaped rows of the job
 * @param {Array<[number, number]>} ranges - [start, end) slices to translate, in order
 * @returns {Promise<string[]>} One translation per row of the slices; "" where a slice failed
 */
thisEngine.translateParts = async function(job, depth, rows, ranges) {
    const translated = [];
    for (const [start, end] of ranges) {
        const part = {
            ...job,
            payload  : VU.serializeEscapedPayload(rows.slice(start, end), job.algorithm),
            originals: job.originals.slice(start, end),
        };
        const partRows = VU.extractRows(await this.translateJob(part, depth + 1));
        const isAligned = partRows.returnedCount === end - start && !partRows.hasIndexGap;
        translated.push(...(isAligned ? partRows.rows : emptyRows(end - start)));
    }
    return translated;
};

/**
 * Ask the model to translate a job, retrying with corrective prompts while the reply fails
 * validation (only the checks enabled in the settings trigger a retry). In "retry" mode a reply
 * cut off by the token limit is not resent as is (it would be cut off again): translateJob()
 * continues with smaller requests instead.
 * @returns {Promise<{content: string, validation: Object, truncated: boolean, looped: boolean}>}
 *          `looped`: the reply ended in a repetition loop (rescued or not)
 */
thisEngine.requestTranslation = async function(job, maxRetries) {
    const { algorithm, originals, options } = job;
    const parameters     = this.buildTemplateParameters(job);
    const responseFormat = VU.buildResponseFormat(algorithm, originals.length, Boolean(this.getOptions("useJsonSchema")));
    const maxTokens      = this.getRequestMaxTokens(job);
    const temperature    = job.loopRetry ? this.getLoopRetryTemperature() : undefined;
    const promptOptions  = job.loopRetry ? { ...options, loopHint: LOOP_HINT } : options;
    const sources        = VU.parseEscapedPayload(job.payload);
    const lineSubstitute = this.getOptions("lineSubstitute");
    const retryMessages  = [];
    let content = "";
    let validation;
    let truncated = false;
    let looped = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const conversation = this.buildConversation(parameters, retryMessages, promptOptions);
        const reply = await this.fetch(conversation, { ...options, responseFormat, maxTokens, temperature });
        if (!reply) throw new Error("Venice returned an empty response.");
        if (reply.error) {
            options.onRequestError?.(reply.error);
            const status = reply.error.status ? ` (HTTP ${reply.error.status})` : "";
            throw new Error(`Venice API error${status}: ${reply.error.message}`);
        }

        const choice = reply.choices?.[0];
        const raw = choice?.message?.content;
        truncated = choice?.finish_reason === "length";
        if (truncated) log(`The reply was cut off by the token limit (max_tokens = ${this.getSentMaxTokens(job)}).`);

        // A model stuck in a loop would loop again on a retry, so such a reply is rescued in both modes,
        // provided the rescued row keeps all the lines of its source (otherwise the end of the row is missing).
        let salvaged = truncated ? VU.salvageCutOffReply(raw) : null;
        if (salvaged) {
            const last = salvaged.rows.length - 1;
            if (last >= originals.length
                || VU.countLines(salvaged.rows[last], lineSubstitute) !== VU.countLines(originals[last])) salvaged = null;
        }
        looped = truncated && (salvaged !== null || VU.findTrailingLoop(raw) !== null);
        let dropUnfinished = false;
        if (salvaged) {
            content = salvaged.text;
            truncated = salvaged.hasIndexGap || salvaged.rows.length < originals.length;
            if (salvaged.fix === "quote") log("The model kept writing after the translation; the extra text was removed.");
            else log(`The model got stuck repeating itself; the repetition was cut off and the row kept: `
                + VU.preview(salvaged.rows.at(-1), 80));
        } else {
            dropUnfinished = truncated && this.getTruncatedReplyMode() === "retry";
            const cleaned = VU.sanitizeModelOutput(raw, {
                stripWordWrap: !/<wordwrap>/i.test(job.payload),
                onTruncated  : dropUnfinished ? "drop" : "repair",
            });
            if (cleaned.repaired) log("A truncated JSON reply was repaired and kept.");
            content = cleaned.text;
        }

        validation = VU.validateOutput({
            content,
            originals,
            sources,
            targetLanguage: job.targetLanguage,
            lineSubstitute,
            checkRowCount : Boolean(this.getOptions("retryIfRowCountMismatch")),
            checkLineCount: Boolean(this.getOptions("retryIfLineCountMismatch")),
        });
        if (salvaged || dropUnfinished || !validation.hasError) break;

        log(`Validation failed (attempt ${attempt + 1} of ${maxRetries + 1}): ${validation.errorMessages.join(" ")} `
            + `Reply: ${VU.preview(content)}`);
        if (attempt >= maxRetries) break;
        retryMessages.push(...this.buildRetryMessages(content, validation, parameters));
    }

    // Hand Translator++ the shape its escape algorithm restores reliably, whatever shape the model chose.
    // Row problems that survived the retries: an echoed source is not written, the others are logged.
    if (!validation.rowCountError) {
        const rows = validation.rows.map((row, index) => {
            const problems = validation.rowProblems.filter((problem) => problem.index === index);
            if (!problems.length) return row;
            const source = VU.preview(originals[index], 80);
            if (problems.some((problem) => problem.fatal)) {
                log(`Left untranslated: the model repeated the source instead of translating it. Source: ${source}`);
                return "";
            }
            log(`Check this row: ${problems.map((problem) => problem.summary).join("; ")}. Source: ${source}`);
            return row;
        });
        content = VU.buildResultPayload(rows, algorithm);
    }
    return { content, validation, truncated, looped };
};

/** Values for the ${VARIABLE} placeholders of the prompt templates. */
thisEngine.buildTemplateParameters = function(job) {
    const { payload, originals, algorithm, options } = job;
    let context = "";
    try {
        context = options.batchInfo?.info?.contextsToString?.() || "";
    } catch (error) {
        console.warn("[Venice] Unable to build the context", error);
    }
    // compileTemplate() leaves a placeholder untouched when its value is falsy, hence String().
    return {
        SOURCE_TEXT            : payload,
        ESCAPE_ALGORITHM_PROMPT: libGPT.getEscapeAlgorithmTemplateString(algorithm),
        NEWLINE_STRING         : this.getOptions("lineSubstitute"),
        MESSAGE_COUNT          : String(originals.length),
        ACTOR_INFO             : getActorInfo(originals, options) || "N/A",
        CONTEXT                : context || "N/A",
    };
};

function getActorInfo(originals, options) {
    if (!options.translatorOptions?.useActorReference) return "";
    if (typeof options.batchInfo?.[Symbol.iterator] !== "function") return "";
    try {
        return BatchTranslate.getMentionedActor(originals, options);
    } catch (error) {
        console.warn("[Venice] Unable to collect the actor information", error);
        return "";
    }
}

/**
 * Messages of one request: system prompt (+ extra prompt of the batch), sample dialogue,
 * the translation request and the corrective retry messages. The jailbreak note, when enabled,
 * goes right before the last user message.
 */
thisEngine.buildConversation = function(parameters, retryMessages = [], options = {}, algorithm = this.getEscapeAlgorithm()) {
    const render = (template) => (template ? libGPT.compileTemplate(template, parameters) : "");
    const conversation = [];

    const systemTemplate = [this.getOptions("systemMsgTemplate"), options.translatorOptions?.extraPrompt, options.loopHint]
        .filter(Boolean)
        .join("\n");
    if (systemTemplate) conversation.push({ role: "system", content: render(systemTemplate) });

    // The model imitates the examples, so their JSON goes out in the shape of the current escape
    // algorithm even if the saved samples use the other one (the settings are left untouched).
    for (const sample of VU.convertSampleDialog(this.getOptions("sampleDialog"), algorithm).samples) {
        if (!sample?.user || !sample?.assistant) continue;
        conversation.push({ role: "user", content: render(sample.user) }, { role: "assistant", content: render(sample.assistant) });
    }

    conversation.push({ role: "user", content: render(this.getOptions("bodyMsgTemplate")) }, ...retryMessages);

    // Mistral-based models (the Venice Uncensored ones) expect a conversation to end with the user's turn.
    const jailbreak = this.getOptions("enableJailbreak") && this.getOptions("jailbreakTemplate");
    if (jailbreak) conversation.splice(-1, 0, { role: "system", content: jailbreak });
    return conversation;
};

/**
 * The invalid reply followed by one user message with the corrective prompts
 * (a single message keeps strict user/assistant alternation for any chat template).
 */
thisEngine.buildRetryMessages = function(content, validation, parameters) {
    const retryParameters = {
        ...parameters,
        RETURNED_MESSAGE_COUNT: String(validation.returnedCount),
        LINE_ERRORS           : validation.lineErrors.join("\n"),
        ERROR_MESSAGE         : validation.errorMessages.join("\n"),
    };
    const render = (key) => {
        const template = this.getOptions(key);
        return template ? libGPT.compileTemplate(template, retryParameters) : "";
    };

    const prompts = [];
    if (this.getOptions("retryIfRowCountMismatch") && validation.parsed && validation.rowCountError) {
        prompts.push(render("promptRetryRowCountMismatch"));
    }
    if (this.getOptions("retryIfLineCountMismatch") && validation.lineErrors.length) {
        prompts.push(render("promptRetryLineCountMismatch"));
    }
    prompts.push(render("promptError"));

    return [
        { role: "assistant", content: content || "(empty reply)" },
        { role: "user", content: prompts.filter(Boolean).join("\n\n") },
    ];
};

/** Called by Translator++ for a batch with nothing left to translate (every row came from the cache). */
thisEngine.onEmptyBatch = async function(batchInfo) {
    batchInfo.info ??= {};
    batchInfo.info.response = {
        status: 304,
        body: {
            created: 0,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            choices: [{ finish_reason: "Zero job/Loaded from cache" }],
        },
    };
};

// ---------------------------------------------------------------------------
// Tester window and registration
// ---------------------------------------------------------------------------

thisAddon.openTesterWindow = function(engineName = thisEngine.id) {
    localStorage.setItem("veniceTranslator/tester/engine", engineName);
    nw.Window.open(thisAddon.getRelativePath("tester/veniceTester.html"), {
        id    : "veniceTranslator-tester",
        width : 800,
        height: 600,
        title : "Venice Translator tester",
    });
};

/**
 * Adds the engine to Translator++'s engine list (TranslatorEngine.init) and loads the saved options.
 * Add-ons are loaded after the document is ready and the configuration is read, so this runs right
 * away. Never pass an async function to $(document).ready(): the main window uses jQuery 1.12, whose
 * isFunction() does not recognise async functions, so the callback is silently dropped and the
 * engine never appears in the settings.
 */
async function registerEngine() {
    try {
        await thisEngine.init();
        thisEngine.migrateOptions();
    } catch (error) {
        console.error("[Venice] Engine initialisation failed:", error);
    }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", registerEngine, { once: true });
else registerEngine();
