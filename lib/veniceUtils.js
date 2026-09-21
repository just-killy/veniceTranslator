/**
 * Pure helpers for the Venice translator engine.
 *
 * The engine supports the two JSON escape algorithms only (JSONObjectCloaking, JSONCloaking),
 * so every reply handled here is JSON. This module uses no Translator++ globals and is
 * unit-tested with plain Node.js:  node --test  (in the add-on folder)
 */
"use strict";

/** Escape algorithm used when the saved setting is empty or no longer supported. */
const DEFAULT_ESCAPE_ALGORITHM = "JSONObjectCloaking";

/** The escape algorithms the engine supports. */
const JSON_ALGORITHMS = ["JSONObjectCloaking", "JSONCloaking"];

/** Accepted values of the OpenAI-compatible `reasoning_effort` parameter. */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** HTTP statuses worth retrying: timeouts, rate limits, overloaded or failing upstreams. */
const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

/** HTTP statuses that retrying cannot fix: bad key, no balance, forbidden. */
const FATAL_STATUSES = [401, 402, 403];

/** Request parameters that are never dropped automatically. */
const PROTECTED_PARAMETERS = ["model", "messages"];

/** Error messages that name a request argument the model does not accept. */
const REJECTED_ARGUMENT_PATTERNS = [
    /Unrecognized request argument supplied:\s*([\w.]+)/i,
    /Argument not supported:\s*([\w.]+)/i,
    /Unsupported parameter:\s*'?([\w.]+)/i,
];

const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;

const THINK_BLOCK   = /<(think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const FENCED_BLOCK  = /```(?:[a-zA-Z0-9]+)?\s*([\s\S]+?)\s*```/;
const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** A supported escape algorithm: an empty or removed value becomes the default. */
function normalizeEscapeAlgorithm(algorithm) {
    return JSON_ALGORITHMS.includes(algorithm) ? algorithm : DEFAULT_ESCAPE_ALGORITHM;
}

/** The value itself when it is an array, otherwise an empty array (for settings that may be unset). */
function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/** JSON.parse that returns `undefined` instead of throwing. */
function tryParseJson(text) {
    if (typeof text !== "string") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isJson(text) {
    return tryParseJson(text) !== undefined;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Cell value as a string; null/undefined become "". */
function toText(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Numeric keys of an object in numeric order ("0", "1", ... "10"). */
function numericKeys(object) {
    return Object.keys(object)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b));
}

/** The Translator++ log renders HTML, so model output and error texts must be escaped. */
function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>]/g, (char) => HTML_ENTITIES[char]);
}

/** One-line excerpt of a long text for log messages. */
function preview(text, maxLength = 300) {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > maxLength ? flat.slice(0, maxLength) + "…" : flat;
}

/** Index of the first "{" or "[" of a text, or -1. */
function firstBracket(text) {
    return text.search(/[[{]/);
}

// ---------------------------------------------------------------------------
// Cleaning model output
// ---------------------------------------------------------------------------

/** Remove <think>/<thinking> blocks; an unterminated block runs to the end of the text. */
function stripThinking(text) {
    return String(text ?? "").replace(THINK_BLOCK, "");
}

/** Content of the first ``` fenced block, or null when there is none. */
function extractFencedBlock(text) {
    return FENCED_BLOCK.exec(text)?.[1].trim() ?? null;
}

/** Remove a leading ```lang fence and a trailing ``` fence (also when the closing one is missing). */
function stripCodeFence(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("```")) return trimmed;
    return trimmed.replace(/^```[\w-]*\s*/, "").replace(/```\s*$/, "").trim();
}

/** Shorten runaway repetitions ("ааааааааааа", "а-а-а-а-а-а-а-а-а-а-") produced by a looping model. */
function collapseStutter(text) {
    return text
        .replace(/([^\s])\1{8,}/gu, (_, char) => char.repeat(4))
        .replace(/(?:[A-Za-zА-Яа-яЁё]-[A-Za-zА-Яа-яЁё]-){5,}/g,
            (run) => run.split("-").filter(Boolean).slice(0, 3).join("-") + "-");
}

/**
 * Walk a JSON text from `start`, outside of string literals. `closeAt` is the index where the
 * bracket at `start` is closed (-1 while it is open); with `untilClosed` the walk stops there.
 */
function scanJson(text, start = 0, untilClosed = false) {
    const closers = [];
    let inString = false;
    let escaped = false;
    let lastComma = -1;
    let closeAt = -1;
    for (let i = start; i < text.length && !(untilClosed && closeAt >= 0); i++) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") closers.push("}");
        else if (char === "[") closers.push("]");
        else if (char === "}" || char === "]") {
            if (closers.pop() && !closers.length && closeAt < 0) closeAt = i;
        } else if (char === ",") lastComma = i;
    }
    return { closers, inString, escaped, lastComma, closeAt };
}

/** Index of the bracket that closes the one at `start` (string-aware), or -1. */
function findClosingBracket(text, start) {
    return scanJson(text, start, true).closeAt;
}

/** Terminate an open string and close every open array/object of a truncated JSON text. */
function closeTruncatedJson(text) {
    const { closers, inString, escaped } = scanJson(text);
    let result = text;
    if (inString) result = (escaped ? result.slice(0, -1) : result) + '"';
    result = result.replace(/[\s,]+$/, "");
    if (/:\s*$/.test(result)) result += '""';
    return result + closers.reverse().join("");
}

/** Drop the trailing, incomplete element of a truncated JSON text, then close it. */
function cutToLastCompleteElement(text) {
    const { lastComma } = scanJson(text);
    return lastComma < 0 ? null : closeTruncatedJson(text.slice(0, lastComma));
}

/**
 * Best-effort repair of a JSON reply that was cut off, typically by a model looping until max_tokens.
 * @returns {string|null} Valid JSON text, or null when it cannot be repaired
 */
function repairTruncatedJson(text) {
    const collapsed = collapseStutter(text);
    return [closeTruncatedJson(collapsed), cutToLastCompleteElement(collapsed)].find(isJson) ?? null;
}

/**
 * Clean a raw model reply and cut the JSON out of it.
 * Valid JSON is never altered. Text after a complete JSON is dropped, and an escaped quote where
 * the last string should have ended is fixed (see closeForgottenString). A reply that still does
 * not parse (usually cut off by the token limit) is either repaired, keeping the unfinished element
 * with runaway repetition shortened ("repair"), or cut back to the last complete element ("drop").
 * @param {*} raw - message.content from the API
 * @param {Object} [options]
 * @param {boolean} [options.stripWordWrap] - Remove <WordWrap> tags (only safe when the source has none)
 * @param {"repair"|"drop"} [options.onTruncated] - What to do with an unfinished reply
 * @returns {{text: string, repaired: boolean}}
 */
function sanitizeModelOutput(raw, { stripWordWrap = false, onTruncated = "repair" } = {}) {
    let text = stripThinking(raw);
    // A fenced block is the reply only when the reply does not start with the JSON itself:
    // a model that keeps writing after the JSON may add empty ```json fences.
    const fenced = extractFencedBlock(text);
    if (fenced !== null && (isJson(fenced) || !/^\s*[[{]/.test(text))) text = fenced;
    if (stripWordWrap) text = text.replace(/<\/?wordwrap>/gi, "");
    text = stripCodeFence(text);

    const start = firstBracket(text);
    if (start > 0) text = text.slice(start);
    if (isJson(text)) return { text, repaired: false };

    // Text after the JSON: commentary ("... Hope this helps!") or a model that kept writing.
    const close = start >= 0 ? findClosingBracket(text, 0) : -1;
    if (close > 0 && isJson(text.slice(0, close + 1))) return { text: text.slice(0, close + 1), repaired: false };

    const quoteFixed = closeForgottenString(text);
    if (quoteFixed !== null) return { text: quoteFixed, repaired: false };

    if (onTruncated === "drop") {
        const cut = cutToLastCompleteElement(text);
        return { text: isJson(cut) ? cut : text, repaired: false };
    }

    const repaired = repairTruncatedJson(text);
    return { text: repaired ?? text, repaired: repaired !== null };
}

// ---------------------------------------------------------------------------
// Repetition loops
// ---------------------------------------------------------------------------

/** One character repeated six times or more; digits, whitespace and code characters are excluded. */
const LONG_CHARACTER_RUN = /([^\s\d\\$\{\}\[\]<>])\1{5,}/gu;
/** A syllable of two or three letters repeated five times or more ("hahahahaha", "ひゃひゃひゃひゃひゃ"). */
const LONG_SYLLABLE_RUN = /(\p{L}{2,3}?)\1{4,}/gu;

/**
 * Shorten long repetitions in a source row before it is sent: a run of one character is cut to
 * five ("HELP MEEEEEEEEEE" → "HELP MEEEEE"), a repeated syllable to four ("hahahahahaha" →
 * "hahahaha"). Models tend to copy long runs endlessly, until the token limit. Digits, whitespace
 * and the characters of game codes and ${…} placeholders are never changed.
 */
function shortenRepetitions(text) {
    return String(text ?? "")
        .replace(LONG_CHARACTER_RUN, (_, char) => char.repeat(5))
        .replace(LONG_SYLLABLE_RUN, (_, unit) => unit.repeat(4));
}

/** shortenRepetitions() for every row of a payload; an unchanged payload is returned as is. */
function shortenPayloadRepetitions(payload) {
    const rows = parseEscapedPayload(payload);
    if (!rows) return payload;
    const shortened = rows.map(shortenRepetitions);
    if (shortened.every((row, index) => row === rows[index])) return payload;
    const algorithm = payload.trimStart().startsWith("[") ? "JSONCloaking" : "JSONObjectCloaking";
    return serializeEscapedPayload(shortened, algorithm);
}

/**
 * A generous upper bound for the reply to a payload: 1.5 tokens per character plus 200, at least
 * 256. A translation needs far less, so a model that gets stuck repeating itself is stopped early
 * instead of using up the whole Maximum Tokens.
 */
function estimateReplyTokens(payload) {
    return Math.max(256, Math.ceil(200 + 1.5 * String(payload ?? "").length));
}

/**
 * Repetition loop at the end of a text: a unit of 1–16 characters repeated at least eight times
 * up to the end (the last repeat may be cut). The last 400 characters are searched, then the
 * start is followed back, character by character, to where the repetition begins; `unit` is the
 * repeated text as it reads from that point.
 * @returns {{start: number, unit: string}|null}
 */
function findTrailingLoop(text) {
    const source = String(text ?? "");
    const offset = Math.max(0, source.length - 400);
    const match = /(.{1,16}?)\1{7,}.{0,16}$/su.exec(source.slice(offset));
    if (!match) return null;
    const length = match[1].length;
    let start = offset + match.index;
    while (start > 0 && source[start - 1] === source[start - 1 + length]) start--;
    return { start, unit: source.slice(start, start + length) };
}

/** A repeated unit that reads like a scream or a stutter ("а", "нет, ", "ха-"), not like code or markup. */
function isScreamUnit(unit) {
    return /\p{L}/u.test(unit) && !/[`"\\{}[\]<>|#*_=\d\t\r\n]/.test(unit);
}

/**
 * Cut a loop back to a few repeats (five characters, or three syllables ending on a whole word).
 * A loop of symbols, code fences or whitespace is removed when it comes after a finished row; inside
 * a row it stands for the rest of the row, which is missing, so there is nothing to rescue (null).
 * @returns {string|null}
 */
function cutLoop(text, { start, unit }) {
    if (!isScreamUnit(unit)) {
        const before = text.slice(0, start);
        return scanJson(before).inString ? null : before.replace(/\s+$/u, "");
    }
    const kept = text.slice(0, start + unit.length * (unit.length === 1 ? 5 : 3));
    if (!/[^\p{L}]/u.test(unit)) return kept;
    // "Нет, нет, нет, н" → "Нет, нет, нет"
    return kept.replace(/\p{L}+$/u, "").replace(/[\s,;:\-–—~]+$/u, "");
}

/**
 * Fix a reply in which the model wrote an escaped quote (\") where the last string should have
 * ended: {"translation":["…помогите…\"]} ```json``` … The closing brackets end up inside the string,
 * and the model keeps writing. The missing quote is added and the rest is dropped.
 * @returns {string|null} Valid JSON text, or null
 */
function closeForgottenString(text) {
    const source = String(text ?? "");
    for (const match of source.matchAll(/\\"(\s*[\]}]\s*\})/g)) {
        const candidate = source.slice(0, match.index + 2) + '"' + match[1];
        if (isJson(candidate)) return candidate;
    }
    return null;
}

/**
 * Rescue a reply that stopped at the token limit because the model got stuck, instead of throwing
 * the whole reply away:
 * - an escaped quote where the last string should have ended (see closeForgottenString): the
 *   translation was complete, the model just kept writing;
 * - a repetition loop at the end ("Аааааа…", "Нет, нет, нет, …"): the loop is cut back to a few
 *   repeats and the JSON is closed. A loop of symbols inside a row is not rescued (see cutLoop).
 * A reply cut off in the middle of ordinary text is not rescued either (null).
 * @param {*} raw - message.content from the API
 * @returns {{text: string, rows: string[], hasIndexGap: boolean, fix: "quote"|"loop"}|null}
 */
function salvageCutOffReply(raw) {
    let text = stripThinking(raw);
    const start = firstBracket(text);
    if (start < 0) return null;
    text = text.slice(start);

    /** @type {"quote"|"loop"} */
    let fix = "quote";
    let candidate = closeForgottenString(text);
    if (candidate === null) {
        const loop = findTrailingLoop(text);
        const cut = loop ? cutLoop(text, loop) : null;
        if (cut === null) return null;
        fix = "loop";
        candidate = closeTruncatedJson(cut);
    }
    const { parsed, rows, hasIndexGap } = extractRows(candidate);
    if (!parsed || !rows.at(-1)?.trim()) return null;
    return { text: candidate, rows, hasIndexGap, fix };
}

// ---------------------------------------------------------------------------
// Rows and validation
// ---------------------------------------------------------------------------

function rowsResult(rows, hasIndexGap = false) {
    return { parsed: true, rows, returnedCount: rows.length, hasIndexGap };
}

/**
 * Pull the translated rows out of a cleaned reply: an array, an index-keyed object, or either
 * of them wrapped in {"translation": ...}.
 * @returns {{parsed: boolean, rows: string[], returnedCount: number, hasIndexGap: boolean}}
 */
function extractRows(content) {
    const payload = tryParseJson(String(content ?? ""));
    const translation = isPlainObject(payload) ? (payload.translation ?? payload.translations ?? payload) : payload;

    if (typeof translation === "string") return rowsResult([translation]);
    if (Array.isArray(translation)) return rowsResult(translation.map(toText));
    if (isPlainObject(translation)) {
        const keys = numericKeys(translation);
        const hasIndexGap = keys.some((key, index) => Number(key) !== index);
        return rowsResult(keys.map((key) => toText(translation[key])), hasIndexGap);
    }
    return { parsed: false, rows: [], returnedCount: 0, hasIndexGap: false };
}

/** Number of lines in a cell; the line-break substitute counts as a line break too. */
function countLines(text, lineSubstitute) {
    const value = String(text ?? "");
    const lines = value.split(/\r\n|\r|\n/).length;
    return lineSubstitute ? Math.max(lines, value.split(String(lineSubstitute)).length) : lines;
}

/** Japanese kana and CJK ideographs; the middle dot (・) and the long-vowel mark (ー) do not count. */
const JAPANESE_TEXT = /[぀-ゟ゠-ヺヽ-ヿ㐀-䶿一-鿿]/;
const JAPANESE_RUNS = /[぀-ヿ㐀-䶿一-鿿]+/g;
const PLACEHOLDERS  = /\$\{dat\[\d+\]\}/g;
/** Target languages written with kanji or kana themselves: Japanese text is no error there. */
const CJK_TARGET    = /^(ja|zh|ko)/i;

/** Placeholders of the source row that the translation lost, e.g. ["${dat[2]}"]. */
function missingPlaceholders(source, translation) {
    const count = (text) => {
        const counts = new Map();
        for (const placeholder of String(text ?? "").match(PLACEHOLDERS) ?? []) {
            counts.set(placeholder, (counts.get(placeholder) ?? 0) + 1);
        }
        return counts;
    };
    const kept = count(translation);
    return [...count(source)]
        .filter(([placeholder, n]) => (kept.get(placeholder) ?? 0) < n)
        .map(([placeholder]) => placeholder);
}

/**
 * Problems inside the rows of a reply that has the right number of rows:
 * - "echo" (fatal): the row is a JSON payload or its unchanged Japanese source, so nothing was translated;
 * - "japanese": Japanese text is left in the row (not checked for Japanese, Chinese or Korean targets);
 * - "code": a ${dat[n]} placeholder of the source is missing, so a game code would be lost.
 * `message` is written for the model (corrective retry), `summary` for the log.
 * @param {string[]} rows - Translated rows as the model returned them (with placeholders)
 * @param {string[]|null} sources - Escaped source rows as sent, or null when unknown
 * @param {string} [targetLanguage] - Target language code, e.g. "ru"
 * @returns {Array<{index: number, kind: string, fatal: boolean, message: string, summary: string}>}
 */
function findRowProblems(rows, sources, targetLanguage) {
    const checkJapanese = Boolean(targetLanguage) && !CJK_TARGET.test(targetLanguage);
    const problems = [];
    rows.forEach((row, index) => {
        const report = (kind, fatal, message, summary) =>
            problems.push({ index, kind, fatal, message: `Element ${index + 1}: ${message}`, summary });
        const text = String(row ?? "");
        const source = sources?.[index];
        const japanese = checkJapanese
            ? (text.replace(PLACEHOLDERS, "").match(JAPANESE_RUNS) ?? []).find((run) => JAPANESE_TEXT.test(run))
            : undefined;
        const unchanged = source !== undefined && text.trim() !== "" && text.trim() === String(source).trim();

        if (/^\s*[[{]\s*"/.test(text) || (unchanged && japanese)) {
            report("echo", true,
                "this is not a translation, it repeats the source text. Translate the text of the element itself.",
                "the model repeated the source instead of translating it");
            return;
        }
        if (japanese) {
            const excerpt = japanese.slice(0, 20);
            report("japanese", false,
                `part of it is still in Japanese ("${excerpt}"). Translate all of it.`,
                `part of it is still in Japanese ("${excerpt}")`);
        }
        const missing = source === undefined ? [] : missingPlaceholders(source, text);
        if (missing.length) {
            report("code", false,
                `${missing.join(", ")} is missing. Keep every \${dat[n]} placeholder exactly as in the source.`,
                `a game code was lost (${missing.join(", ")})`);
        }
    });
    return problems;
}

/**
 * Check a cleaned reply against the source rows.
 * `rowCountError` and `lineErrors` are always computed, but their messages only count when the check
 * is switched on, because those are the ones that trigger a retry. Problems inside the rows (see
 * findRowProblems) always count.
 * @param {Object} params
 * @param {string} params.content - Cleaned reply
 * @param {string[]} params.originals - Unescaped source rows
 * @param {string[]|null} [params.sources] - Escaped source rows as sent (enables the echo and code checks)
 * @param {string} [params.targetLanguage] - Target language code (enables the Japanese-text check)
 * @param {string} [params.lineSubstitute] - Line-break substitute of the engine
 * @param {boolean} [params.checkRowCount]
 * @param {boolean} [params.checkLineCount]
 */
function validateOutput({ content, originals, sources = null, targetLanguage, lineSubstitute, checkRowCount = false, checkLineCount = false }) {
    const expected = originals.length;
    const extracted = extractRows(content);
    const rowCountError = !extracted.parsed || extracted.hasIndexGap || extracted.returnedCount !== expected;

    const lineErrors = rowCountError ? [] : originals.flatMap((original, index) => {
        const sourceLines = countLines(original);
        const translatedLines = countLines(extracted.rows[index], lineSubstitute);
        return sourceLines === translatedLines
            ? []
            : [`- Element ${index + 1}: original has ${sourceLines} line(s), the translated has ${translatedLines}.`];
    });

    const errorMessages = [];
    if (checkRowCount && rowCountError) {
        if (!extracted.parsed) errorMessages.push("The reply is not valid JSON in the required format.");
        else if (extracted.returnedCount !== expected) errorMessages.push(`Row count mismatch. Expected ${expected}, but got ${extracted.returnedCount}.`);
        else errorMessages.push(`Row index gap detected. Expected indexes 0..${expected - 1}.`);
    }
    if (checkLineCount && lineErrors.length) errorMessages.push("Line count mismatch detected.");
    const rowProblems = rowCountError ? [] : findRowProblems(extracted.rows, sources, targetLanguage);
    errorMessages.push(...rowProblems.map((problem) => problem.message));

    return { ...extracted, expected, rowCountError, lineErrors, rowProblems, errorMessages, hasError: errorMessages.length > 0 };
}

/** {"0": row0, "1": row1, ...}: the JSONObjectCloaking shape of a list of rows. */
function indexObject(rows) {
    return { ...rows };
}

/**
 * Escaped source rows of a payload (exactly what the model is asked to translate), or null
 * when the payload cannot be split safely.
 */
function parseEscapedPayload(payload) {
    const parsed = tryParseJson(payload);
    if (Array.isArray(parsed)) return parsed.map(toText);
    if (isPlainObject(parsed)) {
        const keys = numericKeys(parsed);
        if (keys.every((key, index) => Number(key) === index)) return keys.map((key) => toText(parsed[key]));
    }
    return null;
}

/** Inverse of parseEscapedPayload(): the same JSON shape the escape algorithm produces. */
function serializeEscapedPayload(rows, algorithm) {
    return JSON.stringify(algorithm === "JSONObjectCloaking" ? indexObject(rows) : rows);
}

/** Reply in the canonical shape that the escape algorithm's restore() understands. */
function buildResultPayload(rows, algorithm) {
    return JSON.stringify({ translation: algorithm === "JSONObjectCloaking" ? indexObject(rows) : rows });
}

/**
 * Rows "0", "1", "2"… of an index-keyed reply, up to the first missing key (JSONObjectCloaking).
 * Always [] for arrays: a cut-off array cannot show whether its rows still match the source.
 */
function leadingCompleteRows(content, algorithm) {
    if (algorithm !== "JSONObjectCloaking") return [];
    const payload = tryParseJson(String(content ?? ""));
    const map = isPlainObject(payload) ? (payload.translation ?? payload) : undefined;
    if (!isPlainObject(map)) return [];
    const rows = [];
    while (Object.hasOwn(map, rows.length)) rows.push(toText(map[rows.length]));
    return rows;
}

// ---------------------------------------------------------------------------
// Sample dialogue conversion
// ---------------------------------------------------------------------------

/** Rows: an array of strings, an index-keyed object of strings, or either wrapped in {"translation": ...}. */
function isRowsPayload(value) {
    if (Array.isArray(value)) return value.length > 0 && value.every((row) => typeof row === "string");
    if (!isPlainObject(value)) return false;
    if (value.translation !== undefined) return isRowsPayload(value.translation);
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => /^\d+$/.test(key) && typeof value[key] === "string");
}

/**
 * First JSON rows payload embedded in a text, such as the JSON inside a sample prompt.
 * Brackets in plain prose ("keep \C[1] as is") are skipped because they do not hold rows.
 * @returns {{start: number, end: number, value: *}|null} `end` is exclusive
 */
function findJsonSpan(text) {
    const source = String(text ?? "");
    for (const { index: start } of source.matchAll(/[[{]/g)) {
        const close = findClosingBracket(source, start);
        if (close < 0) continue;
        const value = tryParseJson(source.slice(start, close + 1));
        if (isRowsPayload(value)) return { start, end: close + 1, value };
    }
    return null;
}

/** Rows payload rewritten as an array (JSONCloaking) or an index-keyed object (JSONObjectCloaking). */
function convertRowsPayload(value, algorithm) {
    if (isPlainObject(value) && value.translation !== undefined) {
        return { ...value, translation: convertRowsPayload(value.translation, algorithm) };
    }
    const rows = Array.isArray(value) ? value : numericKeys(value).map((key) => value[key]);
    return algorithm === "JSONObjectCloaking" ? indexObject(rows) : rows;
}

/**
 * Rewrite the JSON in sample dialogues for another escape algorithm: arrays for JSONCloaking,
 * index-keyed objects for JSONObjectCloaking. The text around the JSON is kept as is.
 * @param {Object[]} samples - [{user, assistant}, ...]
 * @param {string} algorithm - Target escape algorithm
 * @returns {{samples: Object[], changed: number, payloads: number}} `payloads`: messages that hold
 *          JSON rows; `changed`: messages that were rewritten (0 means `samples` is returned as is)
 */
function convertSampleDialog(samples, algorithm) {
    const list = asArray(samples);
    if (!JSON_ALGORITHMS.includes(algorithm)) return { samples: list, changed: 0, payloads: 0 };

    let changed = 0;
    let payloads = 0;
    const convertText = (text) => {
        const span = findJsonSpan(text);
        if (!span) return text;
        payloads++;
        const converted = JSON.stringify(convertRowsPayload(span.value, algorithm));
        if (converted === JSON.stringify(span.value)) return text;
        changed++;
        return text.slice(0, span.start) + converted + text.slice(span.end);
    };
    const converted = list.map((sample) => ({
        ...sample,
        user: convertText(sample?.user),
        assistant: convertText(sample?.assistant),
    }));
    return { samples: changed ? converted : list, changed, payloads };
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * response_format for a request with `rowCount` rows.
 * Venice follows OpenAI structured outputs: strict mode, every property required,
 * additionalProperties false. For JSONObjectCloaking the schema lists the keys "0".."N-1",
 * so the model has to return exactly one translation per source row.
 */
function buildResponseFormat(algorithm, rowCount, useJsonSchema) {
    if (!useJsonSchema) return { type: "json_object" };

    const keys = Array.from({ length: rowCount }, (_, index) => String(index));
    const translation = algorithm === "JSONObjectCloaking"
        ? {
            type: "object",
            properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
            required: keys,
            additionalProperties: false,
        }
        : { type: "array", items: { type: "string" } };

    return {
        type: "json_schema",
        json_schema: {
            name: "translation_output",
            strict: true,
            schema: {
                type: "object",
                properties: { translation },
                required: ["translation"],
                additionalProperties: false,
            },
        },
    };
}

/** venice_parameters: only the translator's own prompt, no thinking, no web search. */
function buildVeniceParameters({ includeVeniceSystemPrompt = false, disableThinking = true } = {}) {
    return {
        include_venice_system_prompt: Boolean(includeVeniceSystemPrompt),
        strip_thinking_response: true,
        disable_thinking: disableThinking !== false,
        enable_web_search: "off",
    };
}

/** Copy of the request headers that is safe to log or display (the API key is masked). */
function redactHeaders(headers = {}) {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
        [name, name.toLowerCase() === "authorization" ? "Bearer ***" : value]));
}

// ---------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------

function stripHtml(text) {
    return String(text ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Readable summary of Venice (zod) validation details: "field: message; ...". */
function formatValidationDetails(details, issues) {
    const parts = [];
    const describe = (path, message) => (path ? `${path}: ${message}` : String(message));
    const walk = (node, path) => {
        if (!isPlainObject(node)) return;
        for (const message of asArray(node._errors)) parts.push(describe(path, message));
        for (const [key, child] of Object.entries(node)) {
            if (key !== "_errors") walk(child, path ? `${path}.${key}` : key);
        }
    };
    walk(details, "");
    for (const issue of asArray(issues)) {
        if (issue?.message) parts.push(describe(asArray(issue.path).join("."), issue.message));
    }
    return [...new Set(parts)].slice(0, 5).join("; ");
}

/**
 * Normalise an API reply into an error object, or null when the reply is a success.
 * Venice usually answers {"error": "message", "details": {...}}; some routes use the
 * OpenAI shape {"error": {"message", "type", "param", "code"}}.
 * @returns {null|{message: string, status: number, code?: string, param?: string, type?: string,
 *                 details?: Object, retryable: boolean, fatal: boolean}}
 */
function normalizeApiError(status, body, rawText) {
    const ok = status >= 200 && status < 300;
    const rawError = isPlainObject(body) ? body.error : undefined;
    const hasBody = body !== null && typeof body === "object";
    if (ok && hasBody && rawError == null) return null;

    let message = "";
    let code, param, type;
    if (typeof rawError === "string") {
        message = rawError;
    } else if (isPlainObject(rawError)) {
        message = toText(rawError.message);
        ({ code, param, type } = rawError);
    }
    if (!message && ok) message = "The reply is not valid JSON: " + (stripHtml(rawText).slice(0, 200) || "(empty)");
    if (!message) message = stripHtml(rawText).slice(0, 200) || `HTTP ${status}`;

    const details = isPlainObject(body) ? body.details : undefined;
    const detailText = formatValidationDetails(details, isPlainObject(body) ? body.issues : undefined);
    return {
        message: detailText ? `${message} (${detailText})` : message,
        status,
        code,
        param,
        type,
        details,
        retryable: RETRYABLE_STATUSES.includes(status),
        fatal: FATAL_STATUSES.includes(status),
    };
}

/**
 * Request parameters that an error blames and that can be dropped safely.
 * Understands the OpenAI shape (code/param), Venice validation details and the common
 * "unrecognized / unsupported argument" messages.
 * @param {Object} error - Result of normalizeApiError()
 * @param {Object} body - The request body that was sent
 * @returns {string[]}
 */
function findRejectedParameters(error, body = {}) {
    if (!error || error.retryable || error.fatal) return [];
    const message = String(error.message ?? "");
    const candidates = new Set();

    if (error.param) candidates.add(String(error.param));
    for (const pattern of REJECTED_ARGUMENT_PATTERNS) {
        const match = message.match(pattern);
        if (match) candidates.add(match[1]);
    }
    const unrecognized = message.match(/Unrecognized key\(s\) in object:\s*(.+)/i);
    for (const match of unrecognized?.[1].matchAll(/'([^']+)'/g) ?? []) candidates.add(match[1]);
    if (isPlainObject(error.details)) {
        for (const key of Object.keys(error.details)) candidates.add(key);
    }
    for (const key of Object.keys(body)) {
        if (message.includes(key)) candidates.add(key);
    }

    return [...candidates].filter((key) => Object.hasOwn(body, key) && !PROTECTED_PARAMETERS.includes(key));
}

/** Milliseconds until a reset header value: a Unix timestamp (s or ms) or a number of seconds. */
function untilReset(value, now) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return NaN;
    if (number > 1e12) return number - now;
    if (number > 1e9) return number * 1000 - now;
    return number * 1000;
}

/**
 * How long to wait before retrying a failed request.
 * HTTP 429 honours Retry-After and the x-ratelimit-* headers; everything else uses exponential
 * back-off with jitter (about 2 s, 4 s, 8 s ...). The result is always between 1 and 60 seconds.
 * @param {number} status - HTTP status, 0 for network errors and timeouts
 * @param {Object} headers - Response headers with lower-case names
 * @param {number} attempt - 1 for the first retry
 * @param {number} [now] - Current time in ms (injectable for tests)
 */
function getRetryDelayMs(status, headers = {}, attempt = 1, now = Date.now()) {
    const clamp = (ms) => Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.ceil(ms)));

    if (status === 429) {
        const retryAfter = Number(headers["retry-after"]);
        if (retryAfter > 0) return clamp(retryAfter * 1000);

        const waits = [];
        if (headers["x-ratelimit-remaining-requests"] === "0") waits.push(untilReset(headers["x-ratelimit-reset-requests"], now));
        if (headers["x-ratelimit-remaining-tokens"] === "0") waits.push(Number(headers["x-ratelimit-reset-tokens"]) * 1000);
        if (headers["x-ratelimit-resets"] !== undefined) waits.push(untilReset(headers["x-ratelimit-resets"], now));
        const longest = Math.max(0, ...waits.filter(Number.isFinite));
        if (longest > 0) return clamp(longest + 250);
    }

    return clamp(2000 * 2 ** Math.max(0, attempt - 1) + Math.random() * 500);
}

module.exports = {
    DEFAULT_ESCAPE_ALGORITHM,
    JSON_ALGORITHMS,
    REASONING_EFFORTS,

    normalizeEscapeAlgorithm,
    asArray,
    tryParseJson,
    isPlainObject,
    escapeHtml,
    preview,

    closeTruncatedJson,
    sanitizeModelOutput,

    shortenRepetitions,
    shortenPayloadRepetitions,
    estimateReplyTokens,
    findTrailingLoop,
    salvageCutOffReply,

    extractRows,
    countLines,
    findRowProblems,
    validateOutput,
    parseEscapedPayload,
    serializeEscapedPayload,
    buildResultPayload,
    leadingCompleteRows,

    findJsonSpan,
    convertSampleDialog,

    buildResponseFormat,
    buildVeniceParameters,
    redactHeaders,

    normalizeApiError,
    findRejectedParameters,
    getRetryDelayMs,
};
