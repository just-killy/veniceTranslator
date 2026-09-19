/**
 * Toolbar button "Ask Venice": opens the Translator++ chat assistant with this engine's
 * endpoint, key and model already filled in, so asking the model something on the side
 * needs no second set-up. It is a plain chat: no templates, no JSON format, no grid.
 */
const thisAddon = this;

thisAddon.openChatAssistant = function() {
    const engine = thisAddon.engine;
    if (!engine) {
        console.error("[Venice] The engine is not ready yet.");
        return;
    }

    nw.Window.open("www/addons/basicUtils/assistant/chat.html", {
        id      : "veniceTranslator-chat",
        width   : 520,
        height  : 640,
        position: "mouse",
    }, (chatWindow) => {
        chatWindow.on("loaded", () => {
            chatWindow.focus();
            const assistant = chatWindow.window?.chatAssistant;
            if (!assistant) {
                console.error("[Venice] The chat assistant did not load.");
                return;
            }

            // The assistant reads its settings once it is initialised, not before.
            assistant.on("initialized", () => {
                if (!assistant.settings) {
                    console.error("[Venice] The chat assistant has no settings object.");
                    return;
                }
                Object.assign(assistant.settings, {
                    apiUrl: engine.getOptions("baseUrl"),
                    apiKey: engine.getOptions("apiKey"),
                    model : engine.getOptions("model"),
                });
                assistant.populateSettingsModal();
                assistant.updateParametersBar();
            });
        });
    });
};

(async () => {
    await addonLoader.until("uiReady");
    const toolbar = ui.Toolbar.getById("translator");
    toolbar.addButtonGroup("veniceTranslator");
    toolbar.addButton({
        id     : "veniceTranslatorChat",
        group  : "veniceTranslator",
        title  : t("Ask Venice"),
        icon   : "icon-chat",
        onClick: () => thisAddon.openChatAssistant(),
    });
})();
