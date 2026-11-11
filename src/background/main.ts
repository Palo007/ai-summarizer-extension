// Valid URL patterns for each AI service
const VALID_PATHS: Record<string, string> = {
  "claude.ai": "/new",
  "chatgpt.com": "/",
  "chat.deepseek.com": "/",
  "grok.com": "/",
  "gemini.google.com": "/app",
};
let pendingText: string | null = null;

// Check if a URL matches any of our AI services with the extension parameter
function isValidAiUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const validPath = VALID_PATHS[domain];

    return Boolean(
      validPath &&
        urlObj.pathname === validPath &&
        urlObj.searchParams.has("justTLDR")
    );
  } catch {
    return false;
  }
}

// Handle clicking the extension icon
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage();
  }
  if (message.type === "STORE_TEXT") {
    pendingText = message.text;
    sendResponse({ success: true });
  }
  if (message.type === "RETRIEVE_TEXT") {
    const text = pendingText;
    pendingText = null; // Clear after retrieval
    sendResponse({ text });
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    try {
      // Check if this is one of our AI service URLs
      if (isValidAiUrl(tab.url)) {
        // Send message to inject-prompt script to paste text
        await chrome.tabs.sendMessage(tabId, {
          type: "FROM_BACKGROUND",
          action: "pasteText",
          data: {
            tabId,
            url: tab.url,
          },
        });
      }
    } catch (err) {
      console.error("Error processing tab update:", err);
    }
  }
});

// Handle installation/update events
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Handle first installation
    chrome.runtime.openOptionsPage(); // Open options page on install
  } else if (details.reason === "update") {
    // Handle extension update if needed
    const thisVersion = chrome.runtime.getManifest().version;
    console.log("Updated from", details.previousVersion, "to", thisVersion);
  }
  if (details.reason === "install" || details.reason === "update") {
    chrome.runtime.setUninstallURL("https://justtldr.com/please-stay");
  }
});

chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message.type === 'SUBMIT_FEEDBACK') {
    fetch("https://feedback-to-sheets.onrender.com/feedback/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message.payload)
    })
    .then(response => {
      if (!response.ok) {
        throw new Error('Feedback submission failed');
      }
      sendResponse({ status: 'success' });
    })
    .catch(error => {
      console.error("Feedback submission error:", error);
      sendResponse({ status: 'error', error: error.message });
    });

    return true;
  }
});
// Open the AI service tab from the background, next to the source tab.
// Opening it here (not with window.open in the page) avoids pop-up blocking,
// for example when the summary starts from the keyboard shortcut.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "OPEN_AI_TAB" || !message.url) return;
  const props: chrome.tabs.CreateProperties = { url: message.url, active: true };
  if (sender.tab?.id !== undefined) {
    props.index = sender.tab.index + 1;
    props.openerTabId = sender.tab.id;
  }
  chrome.tabs.create(props);
  sendResponse({ success: true });
});

// Keyboard shortcut (see "commands" in manifest.json): click the summarize
// button that the content script shows on the current page.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "summarize-page") return;
  try {
    if (!tab?.id) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab?.id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const pick = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(
            (button) => !button.disabled
          );
        const button =
          pick('#web-summarizer-root button[title$=" Summary"]') ||
          pick('button[title^="Summarize with "]:not([title="Summarize with AI"])') ||
          pick('button[title="Summarize with AI"]');
        if (button) {
          button.click();
          return true;
        }
        return false;
      },
    });
  } catch (err) {
    console.warn("justTLDR shortcut: cannot run on this page", err);
  }
});
