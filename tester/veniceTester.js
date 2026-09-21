/**
 * Tester window: sends one request through the engine and shows what came back.
 *
 * "Translation" runs the whole pipeline — templates, masking, checks, retries — so the reply is
 * exactly what a batch would produce, except that nothing is written into the project. "Plain chat"
 * sends the text as a single chat message, without templates and without the JSON format.
 *
 * The engine redacts the API key before handing the request over, so the HTTP tab never shows it.
 */

const ENGINE_KEY = "veniceTranslator/tester/engine";

const engineId = localStorage.getItem(ENGINE_KEY) || "veniceTranslator";
const engine = window.opener?.trans?.getTranslatorEngine(engineId) ?? null;

const el = (id) => document.getElementById(id);
const views = { result: el("result"), raw: el("raw"), http: el("http") };

const HINTS = {
    translate: "The whole field is sent as one row, so paste one scene at a time. "
        + "The languages are those of the open project. Nothing is written into the grid.",
    raw: "Sent as a single chat message: no templates, no JSON format, no checks.",
};

/** Request, reply and errors of the current run, in the order they happened. */
let exchange = [];
/** Tokens the current run has spent, over all of its requests. */
let spent = null;

function setView(name, text, failed = false) {
    views[name].textContent = text;
    views[name].classList.toggle("failed", failed);
}

function showTab(name) {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.target === name);
}

function setStatus(text, failed = false) {
    const status = el("status");
    status.textContent = text;
    status.classList.toggle("failed", failed);
}

const getMode = () => document.querySelector("input[name=mode]:checked").value;

function record(label, data) {
    exchange.push(`${label}:\n${JSON.stringify(data, null, 2)}`);
    setView("http", exchange.join("\n\n"));
}

function countTokens(usage) {
    if (!usage) return;
    spent = {
        input : (spent?.input ?? 0) + (usage.prompt_tokens ?? 0),
        output: (spent?.output ?? 0) + (usage.completion_tokens ?? 0),
    };
}

/** What the engine reports back while it works. */
const callbacks = {
    onBeforeFetch : (request) => record("Request", request),
    onAfterFetch  : (response) => {
        countTokens(response?.usage);
        record("Response", response);
    },
    onRequestError: (error) => record("Error", error),
    getRawResponse: (raw) => setView("raw", String(raw ?? "")),
};

async function send() {
    const text = el("input").value;
    if (!text.trim()) {
        setStatus("Nothing to send.");
        return;
    }
    if (!engine) {
        setStatus(`Engine "${engineId}" was not found in Translator++.`, true);
        return;
    }

    exchange = [];
    spent = null;
    for (const name of Object.keys(views)) setView(name, "");
    el("send").disabled = true;
    setStatus("Waiting for Venice...");
    const startedAt = Date.now();

    try {
        if (getMode() === "translate") {
            const result = await engine.translate(text, callbacks);
            setView("result", result?.translationText || "The engine returned nothing.");
        } else {
            const result = await engine.fetch([{ role: "user", content: text }], callbacks);
            const content = result?.choices?.[0]?.message?.content;
            setView("result", content ?? JSON.stringify(result, null, 2));
            setView("raw", content ?? "");
        }
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const tokens = spent ? `, ${spent.input} tokens in, ${spent.output} out` : "";
        setStatus(`Done in ${seconds} s${tokens}.`);
    } catch (error) {
        setView("result", String(error?.stack ?? error), true);
        setStatus("The request failed. See the Result and HTTP tabs.", true);
    } finally {
        el("send").disabled = false;
        showTab("result");
    }
}

function updateMode() {
    const mode = getMode();
    el("inputTitle").textContent = mode === "translate" ? "Text to translate" : "Message to the model";
    el("inputHint").textContent = HINTS[mode];
}

for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showTab(tab.dataset.target));
for (const radio of document.querySelectorAll("input[name=mode]")) radio.addEventListener("change", updateMode);
el("send").addEventListener("click", send);

// Alt+S and Ctrl+Enter send as well.
document.addEventListener("keydown", (event) => {
    if ((event.altKey && event.key.toLowerCase() === "s") || (event.ctrlKey && event.key === "Enter")) {
        event.preventDefault();
        send();
    }
});

updateMode();
if (engine) {
    el("engineLabel").textContent = `${engine.name || engineId} · ${engine.getOptions("model") || "no model"}`;
    setStatus("Ready. Alt+S or Ctrl+Enter sends.");
} else {
    el("engineLabel").textContent = engineId;
    setStatus(`Engine "${engineId}" was not found. Open the tester from the engine settings.`, true);
}
el("input").focus();
