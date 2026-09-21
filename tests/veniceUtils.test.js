/**
 * Unit tests for lib/veniceUtils.js, in the order of the module's sections.
 * Run from the add-on folder:  node --test
 *
 * Every text below is invented for the test. Japanese appears only where a check is about
 * Japanese text; the other rows are English, and the target language is English or French.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const VU = require("../lib/veniceUtils.js");

/** A reply cut off in the middle of ordinary text: nothing in it can be rescued. */
const CUT_OFF_REPLY = '{"translation":["This sentence stops in the midd';
/** The model wrote \" where the last string should have ended, then went on writing. */
const FORGOTTEN_QUOTE = '{"translation":["Done.\\nMoving on…\\"]}';
/** Empty code fences a model keeps emitting after it has finished. */
const FENCES = " ```json```".repeat(40);

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

test("normalizeEscapeAlgorithm: only the two JSON formats are kept, anything else becomes JSONObjectCloaking", () => {
    for (const value of ["", undefined, "none", "JSTemplateCloaking", "HTMLCloakingWrapped", "hexPlaceholder"]) {
        assert.equal(VU.normalizeEscapeAlgorithm(value), "JSONObjectCloaking", String(value));
    }
    assert.equal(VU.normalizeEscapeAlgorithm("JSONCloaking"), "JSONCloaking");
    assert.equal(VU.normalizeEscapeAlgorithm("JSONObjectCloaking"), "JSONObjectCloaking");
});

test("escapeHtml and preview", () => {
    assert.equal(VU.escapeHtml("<p>&</p>"), "&lt;p&gt;&amp;&lt;/p&gt;");
    assert.equal(VU.preview("a\n\n b", 10), "a b");
    assert.equal(VU.preview("x".repeat(20), 5), "xxxxx…");
});

// ---------------------------------------------------------------------------
// Cleaning model output
// ---------------------------------------------------------------------------

test("sanitizeModelOutput: thinking blocks and code fences are removed", () => {
    const raw = "<think>plan the answer</think>\n```json\n{\"translation\":[\"a\"]}\n```";
    assert.deepEqual(VU.sanitizeModelOutput(raw), { text: '{"translation":["a"]}', repaired: false });
    assert.equal(VU.sanitizeModelOutput("<thinking>never closed").text, "");
});

test("sanitizeModelOutput: valid JSON is never altered, long runs included", () => {
    const raw = '{"translation":["Aaaaaaaaaaaaaah!","Hmmmmmmmmmmmm"]}';
    assert.deepEqual(VU.sanitizeModelOutput(raw), { text: raw, repaired: false });
});

test("sanitizeModelOutput: text before and after the JSON is dropped, brackets and fences included", () => {
    assert.equal(VU.sanitizeModelOutput('Sure! Here it is: {"translation":["a"]} Hope this helps.').text, '{"translation":["a"]}');
    assert.equal(VU.sanitizeModelOutput('{"translation":["a"]} ```json``` ```json``` {"x":1}').text, '{"translation":["a"]}');
    assert.equal(VU.sanitizeModelOutput('```json\n{"translation":["a"]}\n```').text, '{"translation":["a"]}');
});

test("sanitizeModelOutput: <WordWrap> tags are removed only when requested", () => {
    assert.equal(VU.sanitizeModelOutput('{"translation":["<WordWrap>Hi</wordwrap>"]}', { stripWordWrap: true }).text, '{"translation":["Hi"]}');
    assert.equal(VU.sanitizeModelOutput('{"translation":["<WordWrap>Hi"]}').text, '{"translation":["<WordWrap>Hi"]}');
});

test("sanitizeModelOutput: an escaped quote where the last string should have ended is fixed", () => {
    assert.deepEqual(JSON.parse(VU.sanitizeModelOutput(FORGOTTEN_QUOTE + " ```json``` ```json```").text),
        { translation: ["Done.\nMoving on…\""] });
    assert.deepEqual(JSON.parse(VU.sanitizeModelOutput('{"translation":{"0":"Okay!\\"}} } and some more words').text),
        { translation: { 0: "Okay!\"" } });
});

test("sanitizeModelOutput 'repair': a truncated reply is closed and a runaway stutter shortened", () => {
    const latin = VU.sanitizeModelOutput('{"translation":["Hello","A-a-a-a-a-a-a-a-a-a-a-a-a-a');
    assert.equal(latin.repaired, true);
    assert.deepEqual(JSON.parse(latin.text).translation, ["Hello", "A-a-a-a-a"]);

    // The stutter pattern knows the Cyrillic alphabet as well.
    const cyrillic = VU.sanitizeModelOutput('{"translation":["о-о-о-о-о-о-о-о-о-о-о-о-о');
    assert.deepEqual(JSON.parse(cyrillic.text).translation, ["о-о-о-о"]);

    const danglingKey = VU.sanitizeModelOutput('{"translation":{"0":"a","1');
    assert.equal(danglingKey.repaired, true);
    assert.deepEqual(JSON.parse(danglingKey.text), { translation: { 0: "a" } });
});

test("sanitizeModelOutput 'drop': only the complete elements of a cut-off reply are kept", () => {
    const drop = { onTruncated: "drop" };
    assert.deepEqual(VU.sanitizeModelOutput('{"translation":{"0":"a","1":"Aaaaaaaaaaaaa', drop),
        { text: '{"translation":{"0":"a"}}', repaired: false });
    assert.equal(VU.sanitizeModelOutput('{"translation":["a","b', drop).text, '{"translation":["a"]}');
    assert.equal(VU.extractRows(VU.sanitizeModelOutput('{"translation":{"0":"one long row', drop).text).parsed, false);

    const valid = '{"translation":{"0":"a"}}';
    assert.equal(VU.sanitizeModelOutput(valid, drop).text, valid);
});

test("sanitizeModelOutput: a reply that is not JSON at all comes back as it is", () => {
    const refusal = "Sorry, I can't help with that.";
    assert.deepEqual(VU.sanitizeModelOutput(refusal), { text: refusal, repaired: false });
});

test("closeTruncatedJson: brackets inside strings and dangling tokens", () => {
    assert.equal(VU.closeTruncatedJson('{"a":["x","y'), '{"a":["x","y"]}');
    assert.equal(VU.closeTruncatedJson('{"a":"[not a bracket'), '{"a":"[not a bracket"}');
    assert.equal(VU.closeTruncatedJson('{"a":1,'), '{"a":1}');
    assert.equal(VU.closeTruncatedJson('{"a":'), '{"a":""}');
    assert.equal(VU.closeTruncatedJson('{"a":"x\\'), '{"a":"x"}');
});

// ---------------------------------------------------------------------------
// Repetition loops
// ---------------------------------------------------------------------------

test("shortenRepetitions: long runs and repeated syllables are shortened; digits, spaces and codes are not", () => {
    assert.equal(VU.shortenRepetitions("NOOOOOOOOOOOO !!"), "NOOOOO !!");
    assert.equal(VU.shortenRepetitions('${dat[1]}"Wh' + "e".repeat(22)), '${dat[1]}"Wheeeee');
    assert.equal(VU.shortenRepetitions("「うわ" + "あ".repeat(9) + "ぁ".repeat(5) + "っ！」"),
        "「うわ" + "あ".repeat(5) + "ぁ".repeat(5) + "っ！」");
    assert.equal(VU.shortenRepetitions("Mu" + "ha".repeat(10) + "!"), "Mu" + "ha".repeat(4) + "!");
    assert.equal(VU.shortenRepetitions("Wait " + "…".repeat(8)), "Wait " + "…".repeat(5));
    for (const unchanged of ["Level 1000000", "a      b", "\\V[1111111]", "${dat[10]}", "Aaaaah", "hahaha", "Stop ... stop!"]) {
        assert.equal(VU.shortenRepetitions(unchanged), unchanged);
    }
});

test("shortenPayloadRepetitions: rows of both payload shapes; an unchanged payload is returned as it is", () => {
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

test("findTrailingLoop: where a long loop starts; ordinary text has none", () => {
    assert.deepEqual(VU.findTrailingLoop("Oh" + "a".repeat(1000)), { start: 2, unit: "a" });
    assert.equal(VU.findTrailingLoop(CUT_OFF_REPLY), null);
});

test("salvageCutOffReply: a loop is cut back to a few repeats and the row is kept", () => {
    const scream = VU.salvageCutOffReply('{"translation":["Hello\\n${dat[1]}\\"Oh' + "a".repeat(300));
    assert.deepEqual(scream.rows, ['Hello\n${dat[1]}"Ohaaaaa']);
    assert.equal(scream.fix, "loop");

    const words = VU.salvageCutOffReply('{"translation":["No, ' + "no, ".repeat(60) + "n");
    assert.deepEqual(words.rows, ["No, no, no"]);

    const secondRow = VU.salvageCutOffReply('{"translation":{"0":"A","1":"B' + "b".repeat(50));
    assert.deepEqual(JSON.parse(secondRow.text), { translation: { 0: "A", 1: "Bbbbbb" } });
});

test("salvageCutOffReply: junk after a finished row is removed, a forgotten closing quote is fixed", () => {
    assert.deepEqual(VU.salvageCutOffReply('{"translation":["Done."' + FENCES).rows, ["Done."]);

    const quote = VU.salvageCutOffReply(FORGOTTEN_QUOTE + FENCES);
    assert.deepEqual(quote.rows, ["Done.\nMoving on…\""]);
    assert.equal(quote.fix, "quote");
});

test("salvageCutOffReply: nothing is rescued from ordinary cut-off text or from a loop of symbols inside a row", () => {
    assert.equal(VU.salvageCutOffReply(CUT_OFF_REPLY), null);
    assert.equal(VU.salvageCutOffReply("no json at all" + "a".repeat(50)), null);
    // Inside a row, a loop of symbols stands for the rest of the row, which is missing.
    assert.equal(VU.salvageCutOffReply('{"translation":["Chapter 1","${dat[1]}' + "\\u2014".repeat(100)), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["${dat[1]}' + "—".repeat(100)), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["Done.' + FENCES), null);
    assert.equal(VU.salvageCutOffReply('{"translation":["a","' + "\t".repeat(50)), null);
});

// ---------------------------------------------------------------------------
// Rows and validation
// ---------------------------------------------------------------------------

test("extractRows: every supported reply shape", () => {
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

test("validateOutput: the row count only counts as an error when its check is on", () => {
    const params = { content: '{"translation":["a"]}', originals: ["x", "y"] };
    const off = VU.validateOutput(params);
    assert.deepEqual([off.rowCountError, off.hasError, off.errorMessages], [true, false, []]);

    const on = VU.validateOutput({ ...params, checkRowCount: true });
    assert.equal(on.hasError, true);
    assert.match(on.errorMessages[0], /Expected 2, but got 1/);

    assert.match(VU.validateOutput({ ...params, content: "oops", checkRowCount: true }).errorMessages[0], /not valid JSON/);
});

test("validateOutput: line counts, the line-break substitute included", () => {
    const params = { content: '{"translation":["one line"]}', originals: ["a\nb"] };
    assert.equal(VU.validateOutput(params).lineErrors.length, 1);
    assert.equal(VU.validateOutput(params).hasError, false);
    assert.equal(VU.validateOutput({ ...params, checkLineCount: true }).hasError, true);

    assert.equal(VU.countLines("a\\r\\nb", "\\r\\n"), 2);
    const substitute = VU.validateOutput({ ...params, content: '{"translation":["x\\\\r\\\\ny"]}', lineSubstitute: "\\r\\n", checkLineCount: true });
    assert.equal(substitute.hasError, false);
});

test("validateOutput: a problem inside a row always counts as an error", () => {
    const echoed = VU.validateOutput({ content: '{"translation":["{\\"0\\":\\"x\\"}"]}', originals: ["x"], sources: ["x"], targetLanguage: "en" });
    assert.equal(echoed.hasError, true);
    assert.equal(echoed.rowProblems[0].kind, "echo");
    assert.equal(VU.validateOutput({ content: '{"translation":["y"]}', originals: ["x"] }).hasError, false);
});

test("findRowProblems: a row holding JSON or its unchanged Japanese source is no translation", () => {
    const sources = ["準備はできた。\n出発しよう。", "${dat[1]}「本当に？」"];
    const translated = '${dat[1]}"Really?"';

    const json = VU.findRowProblems(['{"0":"準備はできた。\\n出発しよう。"}', translated], sources, "en");
    assert.deepEqual(json.map((problem) => [problem.index, problem.kind, problem.fatal]), [[0, "echo", true]]);

    const unchanged = VU.findRowProblems([sources[0], translated], sources, "en");
    assert.deepEqual(unchanged.map((problem) => [problem.index, problem.kind]), [[0, "echo"]]);
});

test("findRowProblems: leftover Japanese and a lost placeholder are reported, not fatal", () => {
    const problems = VU.findRowProblems(
        ["The innkeeper は笑った", '"Really?"', "Level・ー"],
        ["宿屋の主人は笑った", "${dat[1]}「本当に？」", "レベル"],
        "en");
    assert.deepEqual(problems.map((problem) => [problem.index, problem.kind, problem.fatal]), [[0, "japanese", false], [1, "code", false]]);
    assert.match(problems[0].message, /^Element 1: .*は笑った/);
    assert.match(problems[1].message, /\$\{dat\[1\]\} is missing/);
});

test("findRowProblems: no Japanese check for a CJK target or without a target language", () => {
    assert.deepEqual(VU.findRowProblems(["はい"], ["はい"], "ja"), []);
    assert.deepEqual(VU.findRowProblems(["はい"], null, undefined), []);
});

test("parseEscapedPayload and serializeEscapedPayload keep the escape algorithm's format", () => {
    const arrayRows = VU.parseEscapedPayload('["a ${dat[1]}","b"]');
    assert.deepEqual(arrayRows, ["a ${dat[1]}", "b"]);
    assert.equal(VU.serializeEscapedPayload(arrayRows.slice(0, 1), "JSONCloaking"), '["a ${dat[1]}"]');

    const objectRows = VU.parseEscapedPayload('{"0":"a","1":"b"}');
    assert.deepEqual(objectRows, ["a", "b"]);
    assert.equal(VU.serializeEscapedPayload(objectRows.slice(1), "JSONObjectCloaking"), '{"0":"b"}');

    assert.equal(VU.parseEscapedPayload('{"0":"a","2":"b"}'), null);
    assert.equal(VU.parseEscapedPayload("a\nb"), null);
});

test("buildResultPayload: the canonical reply shapes", () => {
    assert.equal(VU.buildResultPayload(["a", "b"], "JSONCloaking"), '{"translation":["a","b"]}');
    assert.equal(VU.buildResultPayload(["a", "b"], "JSONObjectCloaking"), '{"translation":{"0":"a","1":"b"}}');
});

test("leadingCompleteRows: numbered rows up to the first gap; arrays are not trusted", () => {
    assert.deepEqual(VU.leadingCompleteRows('{"translation":{"0":"a","1":"b","3":"d"}}', "JSONObjectCloaking"), ["a", "b"]);
    assert.deepEqual(VU.leadingCompleteRows('{"0":"a"}', "JSONObjectCloaking"), ["a"]);
    assert.deepEqual(VU.leadingCompleteRows('{"translation":{"1":"b"}}', "JSONObjectCloaking"), []);
    assert.deepEqual(VU.leadingCompleteRows('{"translation":["a","b"]}', "JSONCloaking"), []);
    assert.deepEqual(VU.leadingCompleteRows("not json", "JSONObjectCloaking"), []);
});

// ---------------------------------------------------------------------------
// Sample dialogue conversion
// ---------------------------------------------------------------------------

const SAMPLES = [
    {
        user: 'Translate from English into French:\r\n["Hello, ${dat[1]}!","Line one\\nline two"]',
        assistant: '{"translation":["Bonjour, ${dat[1]} !","Ligne un\\nligne deux"]}',
    },
    {
        user: "Wrong number of rows.\r\nThe request had 2, the reply has 3.",
        assistant: '{"translation":{"0":"Bonjour, ${dat[1]} !","1":"Ligne un\\nligne deux"}}',
    },
];

test("convertSampleDialog: arrays become numbered rows, the prose around them is kept", () => {
    const result = VU.convertSampleDialog(SAMPLES, "JSONObjectCloaking");
    assert.deepEqual([result.payloads, result.changed], [3, 2]);
    const [first, second] = result.samples;
    assert.equal(first.user, 'Translate from English into French:\r\n{"0":"Hello, ${dat[1]}!","1":"Line one\\nline two"}');
    assert.deepEqual(JSON.parse(first.assistant), { translation: { 0: "Bonjour, ${dat[1]} !", 1: "Ligne un\nligne deux" } });
    assert.equal(second.user, SAMPLES[1].user);
    assert.equal(second.assistant, SAMPLES[1].assistant);
    assert.ok(SAMPLES[0].user.includes('["Hello'), "the input is not mutated");
});

test("convertSampleDialog: numbered rows become arrays", () => {
    const result = VU.convertSampleDialog(SAMPLES, "JSONCloaking");
    assert.equal(result.changed, 1);
    assert.deepEqual(JSON.parse(result.samples[1].assistant), { translation: ["Bonjour, ${dat[1]} !", "Ligne un\nligne deux"] });
});

test("convertSampleDialog: with nothing to convert the same list comes back", () => {
    const converted = VU.convertSampleDialog(SAMPLES, "JSONObjectCloaking").samples;
    const again = VU.convertSampleDialog(converted, "JSONObjectCloaking");
    assert.deepEqual([again.changed, again.payloads], [0, 3]);
    assert.equal(again.samples, converted);

    const html = [{ user: "<p>Hello</p>", assistant: "<p>Bonjour</p>" }];
    assert.deepEqual(VU.convertSampleDialog(html, "JSONObjectCloaking"), { samples: html, changed: 0, payloads: 0 });
});

test("findJsonSpan: bracketed game codes in prose are skipped", () => {
    const text = 'Keep \\C[1] and [2] unchanged: ["a","b"] please';
    const span = VU.findJsonSpan(text);
    assert.deepEqual(span.value, ["a", "b"]);
    assert.equal(text.slice(span.start, span.end), '["a","b"]');
    assert.equal(VU.findJsonSpan("no json here {placeholder}"), null);
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

test("buildResponseFormat: json_object, the array schema and the exact-key object schema", () => {
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

    const headers = { Authorization: "Bearer sk-test", "Content-Type": "application/json" };
    assert.deepEqual(VU.redactHeaders(headers), { Authorization: "Bearer ***", "Content-Type": "application/json" });
    assert.equal(headers.Authorization, "Bearer sk-test", "the original headers are not changed");
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

test("findRejectedParameters: validation details, the param field, zod messages; never model or messages", () => {
    const body = { model: "m", messages: [], reasoning_effort: "high", foo: 1, bar: 2, top_p: 1 };

    const fromDetails = VU.normalizeApiError(400, { error: "Invalid request parameters", details: { reasoning_effort: { _errors: ["x"] } } });
    assert.deepEqual(VU.findRejectedParameters(fromDetails, body), ["reasoning_effort"]);

    const fromParam = VU.normalizeApiError(400, { error: { message: "Unsupported parameter", param: "top_p" } });
    assert.deepEqual(VU.findRejectedParameters(fromParam, body), ["top_p"]);

    const zod = VU.normalizeApiError(400, { error: "Unrecognized key(s) in object: 'foo', 'bar'" });
    assert.deepEqual(VU.findRejectedParameters(zod, body).sort(), ["bar", "foo"]);

    const protectedParameter = VU.normalizeApiError(400, { error: { message: "Context too long", param: "messages" } });
    assert.deepEqual(VU.findRejectedParameters(protectedParameter, body), []);

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
    // Rate-limit headers only matter for HTTP 429, not for server errors.
    const serverError = VU.getRetryDelayMs(500, { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": String(1_700_000_050) }, 1, now);
    assert.ok(serverError <= 2500, String(serverError));
});
