const DEFAULT_PORTAL_URL = "https://jitsupport.jishnuinfotech.com";
const portalInput = document.querySelector("#portal-url");
const message = document.querySelector("#message");

function normalizedPortalUrl(value) {
  const url = new URL(value.trim());
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Use an HTTPS portal address.");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function getPortalUrl() {
  const { portalUrl = DEFAULT_PORTAL_URL } = await chrome.storage.sync.get("portalUrl");
  return normalizedPortalUrl(portalUrl);
}

chrome.storage.sync.get({ portalUrl: DEFAULT_PORTAL_URL }).then(({ portalUrl }) => {
  portalInput.value = portalUrl;
}).catch(() => {
  portalInput.value = DEFAULT_PORTAL_URL;
});

document.querySelector("#save-url").addEventListener("click", async () => {
  try {
    const portalUrl = normalizedPortalUrl(portalInput.value);
    await chrome.storage.sync.set({ portalUrl });
    portalInput.value = portalUrl;
    message.textContent = "Portal address saved.";
    message.classList.remove("error");
  } catch {
    message.textContent = "Enter a valid HTTPS portal URL (or localhost for development).";
    message.classList.add("error");
  }
});

document.querySelector("#open-portal").addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: await getPortalUrl() });
    window.close();
  } catch {
    message.textContent = "Set a valid portal address first.";
  }
});

document.querySelector("#create-ticket").addEventListener("click", async () => {
  message.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      throw new Error("Open a regular website tab first.");
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: window.location.href,
        selection: window.getSelection()?.toString().trim().slice(0, 2000) || "",
      }),
    });
    const page = result?.result;
    if (!page) throw new Error("Could not read this page.");
    const portalUrl = await getPortalUrl();
    const launch = new URLSearchParams({
      createTicket: "1",
      title: page.title.slice(0, 180),
      url: page.url.slice(0, 2000),
      selection: page.selection,
    });
    await chrome.tabs.create({ url: `${portalUrl}/#${launch.toString()}` });
    window.close();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "Could not start a ticket.";
    message.classList.add("error");
  }
});
