/**
 * Unit tests for lib/veniceUtils.js.
 * Run from the add-on folder:  node --test
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const VU = require("../lib/veniceUtils.js");

test("only the two JSON formats are supported; anything else becomes JSONObjectCloaking", () => {
    for (const value of ["", undefined, "none", "JSTemplateCloaking", "HTMLCloakingWrapped", "hexPlaceholder"]) {
        assert.equal(VU.normalizeEscapeAlgorithm(value), "JSONObjectCloaking", String(value));
    }
    assert.equal(VU.normalizeEscapeAlgorithm("JSONCloaking"), "JSONCloaking");
    assert.equal(VU.normalizeEscapeAlgorithm("JSONObjectCloaking"), "JSONObjectCloaking");
});

// ---------------------------------------------------------------------------
// sanitizeModelOutput
// ---------------------------------------------------------------------------

test("sanitize: strips thinking blocks and code fences", () => {
    const raw = "<think>plan the answer</think>\n```json\n{\"translation\":[\"a\"]}\n```";
    assert.deepEqual(VU.sanitizeModelOutput(raw), { text: '{"translation":["a"]}', repaired: false });
    assert.equal(VU.sanitizeModelOutput("<thinking>never closed").text, "");
});

test("sanitize: valid JSON is never altered (a long scream stays intact)", () => {
    const raw = '{"translation":["Аааааааааааааах!","ммммммммммммм"]}';
    assert.deepEqual(VU.sanitizeModelOutput(raw), { text: raw, repaired: false });
});

test("sanitize: drops a preamble and trailing commentary around the JSON", () => {
    const raw = 'Sure! Here it is: {"translation":["a"]} Hope this helps.';
    assert.equal(VU.sanitizeModelOutput(raw).text, '{"translation":["a"]}');
});

test("sanitize: 'repair' closes a truncated array and collapses the runaway stutter", () => {
    const raw = '{"translation":["Привет","А-а-а-а-а-а-а-а-а-а-а-а-а-а';
    const result = VU.sanitizeModelOutput(raw);
    assert.equal(result.repaired, true);
    const rows = JSON.parse(result.text).translation;
    assert.equal(rows.length, 2);
    assert.equal(rows[0], "Привет");
    assert.ok(rows[1].startsWith("А-а-а-") && rows[1].length < 27, rows[1]);
});

test("sanitize: 'repair' drops a dangling key of a truncated object", () => {
    const result = VU.sanitizeModelOutput('{"translation":{"0":"a","1');
    assert.equal(result.repaired, true);
    assert.deepEqual(JSON.parse(result.text), { translation: { 0: "a" } });
});

test("sanitize: 'drop' keeps only the complete elements of a cut-off reply", () => {
    assert.deepEqual(VU.sanitizeModelOutput('{"translation":{"0":"a","1":"Ааааааааааааа', { onTruncated: "drop" }),
        { text: '{"translation":{"0":"a"}}', repaired: false });
    assert.equal(VU.sanitizeModelOutput('{"translation":["a","b', { onTruncated: "drop" }).text, '{"translation":["a"]}');

    const nothingComplete = VU.sanitizeModelOutput('{"translation":{"0":"only one long row', { onTruncated: "drop" });
    assert.equal(VU.extractRows(nothingComplete.text).parsed, false);

    const valid = '{"translation":{"0":"a"}}';
    assert.equal(VU.sanitizeModelOutput(valid, { onTruncated: "drop" }).text, valid);
});

test("sanitize: an unrepairable reply is returned as is", () => {
    assert.deepEqual(VU.sanitizeModelOutput("Sorry, I can't help with that."),
        { text: "Sorry, I can't help with that.", repaired: false });
});

test("sanitize: text after a complete JSON is dropped, even when it holds brackets or code fences", () => {
    assert.equal(VU.sanitizeModelOutput('{"translation":["a"]} ```json``` ```json``` {"x":1}').text, '{"translation":["a"]}');
    assert.equal(VU.sanitizeModelOutput('```json\n{"translation":["a"]}\n```').text, '{"translation":["a"]}');
});

test("sanitize: an escaped quote where the last string should have ended is fixed", () => {
    const array = '{"translation":["Готово!\\nИдём дальше…\\"]} ```json``` ```json```';
    assert.deepEqual(JSON.parse(VU.sanitizeModelOutput(array).text), { translation: ["Готово!\nИдём дальше…\""] });
    const object = '{"translation":{"0":"Ладно! ★\\"}} } 1/1/1999 10:45:10 PM';
    assert.deepEqual(JSON.parse(VU.sanitizeModelOutput(object).text), { translation: { 0: "Ладно! ★\"" } });
});

// ---------------------------------------------------------------------------
// Repetition loops
// ---------------------------------------------------------------------------

test("shortenRepetitions: long runs and syllables are shortened; digits, spaces and codes are not", () => {
    assert.equal(VU.shortenRepetitions("HELP MEEEEEEEEEEEE !!"), "HELP MEEEEE !!");
    assert.equal(VU.shortenRepetitions('${dat[1]}"Hy' + "a".repeat(22)), '${dat[1]}"Hyaaaaa');
    assert.equal(VU.shortenRepetitions("「うわ" + "あ".repeat(9) + "ぁ".repeat(5) + "ああっ！！」"),
        "「うわ" + "あ".repeat(5) + "ぁ".repeat(5) + "ああっ！！」");
    assert.equal(VU.shortenRepetitions("Gy" + "ah".repeat(10) + "a!"), "Gy" + "ah".repeat(4) + "a!");
    assert.equal(VU.shortenRepetitions("Someone help " + "…".repeat(8)), "Someone help " + "…".repeat(5));
    for (const unchanged of ["Level 1000000", "a      b", "\\V[1111111]", "${dat[10]}", "Aaaaah", "hahaha", "Stop ... stop!"]) {
        assert.equal(VU.shortenRepetitions(unchanged), unchanged);
    }
});

test("shortenPayloadRepetitions: rows of both payload shapes; an unchanged payload is returned as is", () => {
    assert.equal(VU.shortenPayloadRepetitions('["Nooooooooooo!","ok"]'), '["Nooooo!","ok"]');
    assert.equal(VU.shortenPayloadRepetitions('{"0":"ok","1":"Aaaaaaaaaaaah"}'), '{"0":"ok","1":"Aaaaaah"}');
    const untouched = '[ "fine",  "text" ]';
    assert.equal(VU.shortenPayloadRepetitions(untouched), untouched);
    assert.equal(VU.shortenPayloadRepetitions("not json"), "not json");
});

test("estimateReplyTokens: 1.5 tokens per character plus 200, at least 256", () => {
    assert.equal(VU.estimateReplyTokens('["a"]'), 256);
    assert.equal(VU.estimateReplyTokens("x".repeat(2000)), 3200);
});

test("findTrailingLoop: finds where a long loop starts; ordinary text has none", () => {
    assert.deepEqual(VU.findTrailingLoop("Ох" + "а".repeat(1000)), { start: 2, unit: "а" });
    assert.equal(VU.findTrailingLoop("Обычный текст, который оборвался посреди предложе"), null);
});

test("salvageCutOffReply: a loop is cut back to a few repeats and the row is kept", () => {
    const scream = VU.salvageCutOffReply('{"translation":["Привет\\n${dat[1]}\\"Ох' + "а".repeat(300));
    assert.deepEqual(scream.rows, ['Привет\n${dat[1]}"Охааааа']);
    assert.equal(scream.fix, "loop");

    const words = VU.salvageCutOffReply('{"translation":["Нет, ' + "нет, ".repeat(60) + "не");
    assert.deepEqual(words.rows, ["Нет, нет, нет"]);

    const partial = VU.salvageCutOffReply('{"translation":{"0":"А","1":"Б' + "б".repeat(50));
    assert.deepEqual(JSON.parse(partial.text), { translation: { 0: "А", 1: "Бббббб" } });
});

test("salvageCutOffReply: junk after a finished row is removed, a forgotten closing quote is fixed", () => {
    assert.deepEqual(VU.salvageCutOffReply('{"translation":["Готово."' + " ```json```".repeat(40)).rows, ["Готово."]);

    const quote = VU.salvageCutOffReply('{"translation":["Готово!\\nИдём дальше…\\"]} ' + "```json``` ".repeat(40));
    assert.deepEqual(quote.rows, ["Готово!\nИдём дальше…\""]);
    assert.equal(quote.fix, "quote");
});

test("salvageCutOffReply: not rescued - ordinary cut-off text, and a loop of symbols inside a row", () => {
    assert.equal(VU.salvageCutOffReply('{"translation":["Обычный текст, который оборвался посреди предложе'), null);
    assert.equal(VU.salvageCutOffReply("no json at all" + "a".repeat(50)), null);
    // Inside a row a loop of symbols stands for the rest of the row, which is missing.
    assert.equal(VU.salvageCutOffReply('{"translation":["ГЛАВА 1","${dat[1]}' + "\\u2014".repeat(100)), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["${dat[1]}' + "—".repeat(100)), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["Готово.' + " ```json```".repeat(40)), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["a","' + "\t".repeat(50)), null);
});

// ---------------------------------------------------------------------------
// Row checks
// ---------------------------------------------------------------------------

test("row checks: a row holding JSON or its unchanged Japanese source is no translation", () => {
    const sources = ["店主\n「いらっしゃい」", "${dat[1]}「うわあっ！？」"];
    const echoed = VU.findRowProblems(['{"0":"店主\\n「いらっしゃい」"}', "${dat[1]}«Что!?»"], sources, "ru");
    assert.deepEqual(echoed.map((p) => [p.index, p.kind, p.fatal]), [[0, "echo", true]]);
    const unchanged = VU.findRowProblems([sources[0], "${dat[1]}«Что!?»"], sources, "ru");
    assert.deepEqual(unchanged.map((p) => [p.index, p.kind]), [[0, "echo"]]);
});

test("row checks: leftover Japanese and a lost placeholder are reported, not fatal", () => {
    const problems = VU.findRowProblems(["Торговецは笑った", "«Что!?»", "Уровень・ー"], ["店主は笑った", "${dat[1]}「うわあっ！？」", "レベル"], "ru");
    assert.deepEqual(problems.map((p) => [p.index, p.kind, p.fatal]), [[0, "japanese", false], [1, "code", false]]);
    assert.match(problems[0].message, /^Element 1: .*は笑った/);
    assert.match(problems[1].message, /\$\{dat\[1\]\} is missing/);
});

test("row checks: no Japanese check for CJK targets or without a target language", () => {
    assert.deepEqual(VU.findRowProblems(["はい"], ["はい"], "ja"), []);
    assert.deepEqual(VU.findRowProblems(["はい"], null, undefined), []);
});

test("validateOutput: problems inside rows always count as errors", () => {
    const result = VU.validateOutput({ content: '{"translation":["{\\"0\\":\\"x\\"}"]}', originals: ["x"], sources: ["x"], targetLanguage: "ru" });
    assert.equal(result.hasError, true);
    assert.equal(result.rowProblems[0].kind, "echo");
    assert.equal(VU.validateOutput({ content: '{"translation":["y"]}', originals: ["x"] }).hasError, false);
});

test("sanitize: <WordWrap> is removed only when requested", () => {
    assert.equal(VU.sanitizeModelOutput('{"translation":["<WordWrap>Hi</wordwrap>"]}', { stripWordWrap: true }).text, '{"translation":["Hi"]}');
    assert.equal(VU.sanitizeModelOutput('{"translation":["<WordWrap>Hi"]}').text, '{"translation":["<WordWrap>Hi"]}');
});

test("closeTruncatedJson: brackets inside strings and dangling tokens", () => {
    assert.equal(VU.closeTruncatedJson('{"a":["x","y'), '{"a":["x","y"]}');
    assert.equal(VU.closeTruncatedJson('{"a":"[not a bracket'), '{"a":"[not a bracket"}');
    assert.equal(VU.closeTruncatedJson('{"a":1,'), '{"a":1}');
    assert.equal(VU.closeTruncatedJson('{"a":'), '{"a":""}');
    assert.equal(VU.closeTruncatedJson('{"a":"x\\'), '{"a":"x"}');
});

// ---------------------------------------------------------------------------
// Rows and validation
// ---------------------------------------------------------------------------

test("extractRows: supported JSON shapes", () => {
    assert.deepEqual(VU.extractRows('{"translation":["a","b"]}').rows, ["a", "b"]);
    assert.deepEqual(VU.extractRows('["a","b"]').rows, ["a", "b"]);
    assert.deepEqual(VU.extractRows('{"translation":"a"}').rows, ["a"]);
    assert.deepEqual(VU.extractRows('{"translations":["a"]}').rows, ["a"]);
    assert.deepEqual(VU.extractRows('{"translation":[1,null,{"x":1}]}').rows, ["1", "", '{"x":1}']);

    const ordered = VU.extractRows('{"translation":{"10":"k","2":"c","0":"a","1":"b"}}');
    assert.deepEqual(ordered.rows, ["a", "b", "c", "k"]);
    assert.equal(ordered.hasIndexGap, true);

    const gap = VU.extractRows('{"translation":{"0":"a","2":"c"}}');
    assert.deepEqual([gap.returnedCount, gap.hasIndexGap], [2, true]);

    assert.equal(VU.extractRows("not json").parsed, false);
});

test("validateOutput: the row check only reports when it is enabled", () => {
    const params = { content: '{"translation":["a"]}', originals: ["x", "y"] };
    const off = VU.validateOutput(params);
    assert.equal(off.rowCountError, true);
    assert.equal(off.hasError, false);
    assert.deepEqual(off.errorMessages, []);

    const on = VU.validateOutput({ ...params, checkRowCount: true });
    assert.equal(on.hasError, true);
    assert.match(on.errorMessages[0], /Expected 2, but got 1/);

    const invalid = VU.validateOutput({ ...params, content: "oops", checkRowCount: true });
    assert.match(invalid.errorMessages[0], /not valid JSON/);
});

test("validateOutput: line counts, including the line-break substitute", () => {
    const params = { content: '{"translation":["one line"]}', originals: ["a\nb"] };
    assert.equal(VU.validateOutput(params).lineErrors.length, 1);
    assert.equal(VU.validateOutput(params).hasError, false);
    assert.equal(VU.validateOutput({ ...params, checkLineCount: true }).hasError, true);

    assert.equal(VU.countLines("a\\r\\nb", "\\r\\n"), 2);
    const substitute = VU.validateOutput({ ...params, content: '{"translation":["x\\\\r\\\\ny"]}', lineSubstitute: "\\r\\n", checkLineCount: true });
    assert.equal(substitute.hasError, false);
});

test("escaped payload: split and rebuild keep the escape algorithm's format", () => {
    const arrayRows = VU.parseEscapedPayload('["a ${dat[1]}","b"]');
    assert.deepEqual(arrayRows, ["a ${dat[1]}", "b"]);
    assert.equal(VU.serializeEscapedPayload(arrayRows.slice(0, 1), "JSONCloaking"), '["a ${dat[1]}"]');

    const objectRows = VU.parseEscapedPayload('{"0":"a","1":"b"}');
    assert.deepEqual(objectRows, ["a", "b"]);
    assert.equal(VU.serializeEscapedPayload(objectRows.slice(1), "JSONObjectCloaking"), '{"0":"b"}');

    assert.equal(VU.parseEscapedPayload('{"0":"a","2":"b"}'), null);
    assert.equal(VU.parseEscapedPayload("a\nb"), null);
});

test("buildResultPayload: canonical reply shapes", () => {
    assert.equal(VU.buildResultPayload(["a", "b"], "JSONCloaking"), '{"translation":["a","b"]}');
    assert.equal(VU.buildResultPayload(["a", "b"], "JSONObjectCloaking"), '{"translation":{"0":"a","1":"b"}}');
});

test("leadingCompleteRows: keyed rows up to the first gap; arrays are not trusted", () => {
    assert.deepEqual(VU.leadingCompleteRows('{"translation":{"0":"a","1":"b","3":"d"}}', "JSONObjectCloaking"), ["a", "b"]);
    assert.deepEqual(VU.leadingCompleteRows('{"0":"a"}', "JSONObjectCloaking"), ["a"]);
    assert.deepEqual(VU.leadingCompleteRows('{"translation":{"1":"b"}}', "JSONObjectCloaking"), []);
    assert.deepEqual(VU.leadingCompleteRows('{"translation":["a","b"]}', "JSONCloaking"), []);
    assert.deepEqual(VU.leadingCompleteRows("not json", "JSONObjectCloaking"), []);
});

// ---------------------------------------------------------------------------
// Sample dialogue conversion
// ---------------------------------------------------------------------------

const ARRAY_SAMPLES = [
    {
        user: 'Translate this from English to Russian:\r\n["Hello, ${dat[1]}!","Line one\\nline two"]',
        assistant: '{"translation":["Привет, ${dat[1]}!","Строка один\\nстрока два"]}',
    },
    {
        user: "No good!\r\nI sent you 2, but you returned 3 texts.",
        assistant: '{"translation":{"0":"Привет, ${dat[1]}!","1":"Строка один\\nстрока два"}}',
    },
];

test("convertSampleDialog: arrays become numbered rows, prose is kept", () => {
    const result = VU.convertSampleDialog(ARRAY_SAMPLES, "JSONObjectCloaking");
    assert.equal(result.payloads, 3);
    assert.equal(result.changed, 2);
    const [first, second] = result.samples;
    assert.equal(first.user, 'Translate this from English to Russian:\r\n{"0":"Hello, ${dat[1]}!","1":"Line one\\nline two"}');
    assert.deepEqual(JSON.parse(first.assistant), { translation: { 0: "Привет, ${dat[1]}!", 1: "Строка один\nстрока два" } });
    assert.equal(second.user, ARRAY_SAMPLES[1].user);
    assert.equal(second.assistant, ARRAY_SAMPLES[1].assistant);
    assert.equal(ARRAY_SAMPLES[0].user.includes('["Hello'), true, "input must not be mutated");
});

test("convertSampleDialog: numbered rows become arrays", () => {
    const result = VU.convertSampleDialog(ARRAY_SAMPLES, "JSONCloaking");
    assert.equal(result.changed, 1);
    assert.deepEqual(JSON.parse(result.samples[1].assistant), { translation: ["Привет, ${dat[1]}!", "Строка один\nстрока два"] });
});

test("convertSampleDialog: nothing to do returns the same list", () => {
    const converted = VU.convertSampleDialog(ARRAY_SAMPLES, "JSONObjectCloaking").samples;
    const again = VU.convertSampleDialog(converted, "JSONObjectCloaking");
    assert.deepEqual([again.changed, again.payloads], [0, 3]);
    assert.equal(again.samples, converted);

    const html = [{ user: "<p>Hello</p>", assistant: "<p>Halo</p>" }];
    assert.deepEqual(VU.convertSampleDialog(html, "JSONObjectCloaking"), { samples: html, changed: 0, payloads: 0 });
});

test("findJsonSpan: skips bracketed game codes in prose", () => {
    const text = 'Keep \\C[1] and [2] unchanged: ["a","b"] please';
    const span = VU.findJsonSpan(text);
    assert.deepEqual(span.value, ["a", "b"]);
    assert.equal(text.slice(span.start, span.end), '["a","b"]');
    assert.equal(VU.findJsonSpan("no json here {placeholder}"), null);
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test("buildResponseFormat: json_object, array schema and exact-key object schema", () => {
    assert.deepEqual(VU.buildResponseFormat("JSONCloaking", 3, false), { type: "json_object" });

    const array = VU.buildResponseFormat("JSONCloaking", 3, true);
    assert.equal(array.type, "json_schema");
    assert.equal(array.json_schema.strict, true);
    assert.equal(array.json_schema.schema.additionalProperties, false);
    assert.deepEqual(array.json_schema.schema.properties.translation, { type: "array", items: { type: "string" } });

    const object = VU.buildResponseFormat("JSONObjectCloaking", 3, true).json_schema.schema.properties.translation;
    assert.deepEqual(Object.keys(object.properties), ["0", "1", "2"]);
    assert.deepEqual(object.required, ["0", "1", "2"]);
    assert.equal(object.additionalProperties, false);
});

test("buildVeniceParameters and redactHeaders", () => {
    assert.deepEqual(VU.buildVeniceParameters(), {
        include_venice_system_prompt: false,
        strip_thinking_response: true,
        disable_thinking: true,
        enable_web_search: "off",
    });
    assert.equal(VU.buildVeniceParameters({ includeVeniceSystemPrompt: true, disableThinking: false }).disable_thinking, false);

    const headers = { Authorization: "Bearer sk-secret", "Content-Type": "application/json" };
    assert.deepEqual(VU.redactHeaders(headers), { Authorization: "Bearer ***", "Content-Type": "application/json" });
    assert.equal(headers.Authorization, "Bearer sk-secret");
});

// ---------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------

test("normalizeApiError: Venice and OpenAI-style error shapes", () => {
    assert.equal(VU.normalizeApiError(200, { choices: [] }, "{}"), null);

    const auth = VU.normalizeApiError(401, { error: "Authentication failed" });
    assert.deepEqual([auth.message, auth.fatal, auth.retryable], ["Authentication failed", true, false]);

    const objectError = VU.normalizeApiError(400, { error: { message: "Unsupported parameter", code: "unsupported_parameter", param: "reasoning_effort" } });
    assert.deepEqual([objectError.message, objectError.code, objectError.param], ["Unsupported parameter", "unsupported_parameter", "reasoning_effort"]);

    const details = VU.normalizeApiError(400, { error: "Invalid request parameters", details: { _errors: [], reasoning_effort: { _errors: ["Invalid enum value"] } } });
    assert.equal(details.message, "Invalid request parameters (reasoning_effort: Invalid enum value)");

    const html = VU.normalizeApiError(502, undefined, "<html><body><h1>502 Bad Gateway</h1></body></html>");
    assert.deepEqual([html.message, html.retryable], ["502 Bad Gateway", true]);

    assert.match(VU.normalizeApiError(200, undefined, "oops").message, /not valid JSON/);
    assert.equal(VU.normalizeApiError(200, { error: { message: "proxy error" } }).message, "proxy error");
});

test("findRejectedParameters: details, param field, zod message; never model/messages", () => {
    const body = { model: "m", messages: [], reasoning_effort: "high", foo: 1, bar: 2, top_p: 1 };

    const fromDetails = VU.normalizeApiError(400, { error: "Invalid request parameters", details: { reasoning_effort: { _errors: ["x"] } } });
    assert.deepEqual(VU.findRejectedParameters(fromDetails, body), ["reasoning_effort"]);

    const fromParam = VU.normalizeApiError(400, { error: { message: "Unsupported parameter", param: "top_p" } });
    assert.deepEqual(VU.findRejectedParameters(fromParam, body), ["top_p"]);

    const zod = VU.normalizeApiError(400, { error: "Unrecognized key(s) in object: 'foo', 'bar'" });
    assert.deepEqual(VU.findRejectedParameters(zod, body).sort(), ["bar", "foo"]);

    const protectedParam = VU.normalizeApiError(400, { error: { message: "Context too long", param: "messages" } });
    assert.deepEqual(VU.findRejectedParameters(protectedParam, body), []);

    assert.deepEqual(VU.findRejectedParameters(VU.normalizeApiError(429, { error: "top_p" }), body), []);
    assert.deepEqual(VU.findRejectedParameters(VU.normalizeApiError(401, { error: "top_p" }), body), []);
});

test("getRetryDelayMs: rate-limit headers, clamping and back-off", () => {
    const now = 1_700_000_000_000;
    assert.equal(VU.getRetryDelayMs(429, { "retry-after": "3" }, 1, now), 3000);
    assert.equal(VU.getRetryDelayMs(429, { "retry-after": "600" }, 1, now), 60000);
    assert.equal(VU.getRetryDelayMs(429, {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": String(1_700_000_010),
    }, 1, now), 10250);
    assert.equal(VU.getRetryDelayMs(429, { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "5" }, 1, now), 5250);

    const first = VU.getRetryDelayMs(503, {}, 1, now);
    assert.ok(first >= 2000 && first <= 2500, String(first));
    const third = VU.getRetryDelayMs(429, {}, 3, now);
    assert.ok(third >= 8000 && third <= 8500, String(third));
    // Rate-limit headers of a successful window are ignored for server errors.
    const serverError = VU.getRetryDelayMs(500, { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": String(1_700_000_050) }, 1, now);
    assert.ok(serverError <= 2500, String(serverError));
});

test("escapeHtml and preview", () => {
    assert.equal(VU.escapeHtml("<p>&</p>"), "&lt;p&gt;&amp;&lt;/p&gt;");
    assert.equal(VU.preview("a\n\n b", 10), "a b");
    assert.equal(VU.preview("x".repeat(20), 5), "xxxxx…");
});
