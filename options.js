const SETTINGS_KEY = "videoDownloaderSettings";

const defaultSettings = {
  detectHls: true,
  detectNative: true,
  defaultQuality: "best",
  downloadPath: "",
  skipDialog: true
};

const fields = {
  detectHls: document.getElementById("detectHls"),
  detectNative: document.getElementById("detectNative"),
  defaultQuality: document.getElementById("defaultQuality"),
  downloadPath: document.getElementById("downloadPath"),
  skipDialog: document.getElementById("skipDialog")
};

const statusMessage = document.getElementById("statusMessage");
const toolStatus = document.getElementById("toolStatus");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const backBtn = document.getElementById("backBtn");
const testToolsBtn = document.getElementById("testToolsBtn");
const clearThumbsBtn = document.getElementById("clearThumbsBtn");
const clearQueueBtn = document.getElementById("clearQueueBtn");

let settings = { ...defaultSettings };
let saveTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadSettings();
  populateForm();
  await checkTools();
}

function bindEvents() {
  saveBtn.addEventListener("click", () => saveSettings("Configurações salvas."));
  resetBtn.addEventListener("click", resetSettings);
  backBtn.addEventListener("click", () => window.close());
  testToolsBtn.addEventListener("click", checkTools);
  clearThumbsBtn.addEventListener("click", clearThumbCache);
  clearQueueBtn.addEventListener("click", clearQueue);

  for (const field of Object.values(fields)) {
    field.addEventListener("change", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveSettings("Configurações salvas automaticamente."), 450);
    });
  }
}

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    if (response?.ok && response.settings) {
      settings = normalizeSettings(response.settings);
      return;
    }
  } catch {}

  try {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = normalizeSettings(result?.[SETTINGS_KEY]);
  } catch {
    settings = { ...defaultSettings };
  }
}

function populateForm() {
  fields.detectHls.checked = settings.detectHls;
  fields.detectNative.checked = settings.detectNative;
  fields.defaultQuality.value = settings.defaultQuality;
  fields.downloadPath.value = settings.downloadPath;
  fields.skipDialog.checked = settings.skipDialog;
}

function readForm() {
  return normalizeSettings({
    detectHls: fields.detectHls.checked,
    detectNative: fields.detectNative.checked,
    defaultQuality: fields.defaultQuality.value,
    downloadPath: fields.downloadPath.value,
    skipDialog: fields.skipDialog.checked
  });
}

async function saveSettings(message) {
  settings = readForm();

  try {
    const response = await sendMessage({
      type: "SAVE_SETTINGS",
      settings
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Falha ao salvar.");
    }

    showStatus(message, "success");
  } catch (error) {
    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
      showStatus(message, "success");
    } catch {
      showStatus(error.message || "Erro ao salvar configurações.", "error");
    }
  }
}

async function resetSettings() {
  if (!confirm("Redefinir as configurações para os valores padrão?")) return;
  settings = { ...defaultSettings };
  populateForm();
  await saveSettings("Configurações redefinidas.");
}

async function checkTools() {
  toolStatus.innerHTML = "";
  setToolStatus("Verificando ferramentas locais...", "info");

  try {
    const response = await sendMessage({ type: "CHECK_TOOLS" });
    if (!response?.ok) throw new Error(response?.error || "Servidor local indisponível.");

    const tools = response.tools || {};
    const rows = [
      ["yt-dlp", tools.yt_dlp?.installed],
      ["FFmpeg", tools.ffmpeg?.installed],
      ["FFprobe", tools.ffprobe?.installed]
    ];

    toolStatus.innerHTML = rows.map(([name, ok]) => `
      <div class="tool-row">
        <span>${name}</span>
        <strong class="${ok ? "ok" : "fail"}">${ok ? "Instalado" : "Não encontrado"}</strong>
      </div>
    `).join("");
  } catch (error) {
    setToolStatus(`${error.message || "Não foi possível verificar as ferramentas."}`, "error");
  }
}

async function clearThumbCache() {
  try {
    const response = await sendMessage({ type: "CLEAR_THUMB_CACHE" });
    if (!response?.ok) throw new Error(response?.error || "Falha ao limpar cache.");
    showStatus("Cache de thumbnails limpo.", "success");
  } catch (error) {
    showStatus(error.message || "Erro ao limpar cache de thumbnails.", "error");
  }
}

async function clearQueue() {
  if (!confirm("Remover todos os itens detectados da fila?")) return;

  try {
    const response = await sendMessage({ type: "CLEAR_ALL" });
    if (!response?.ok) throw new Error(response?.error || "Falha ao limpar fila.");
    showStatus("Fila de mídias limpa.", "success");
  } catch (error) {
    showStatus(error.message || "Erro ao limpar fila.", "error");
  }
}

function normalizeSettings(value = {}) {
  const next = { ...defaultSettings, ...(value || {}) };
  next.detectHls = next.detectHls !== false;
  next.detectNative = next.detectNative !== false;
  next.skipDialog = next.skipDialog !== false;
  next.defaultQuality = normalizeQuality(next.defaultQuality);
  next.downloadPath = safeRelativePath(next.downloadPath || "");
  return next;
}

function normalizeQuality(value) {
  const raw = String(value || "best").trim();
  const quality = raw.toLowerCase();
  const allowed = new Set(["best", "2160p", "1440p", "1080p", "720p", "480p", "360p"]);
  const heightMatch = raw.match(/height<=([0-9]{3,4})/i);
  if (heightMatch) return `${heightMatch[1]}p`;
  return allowed.has(quality) ? quality : "best";
}

function safeRelativePath(input) {
  return String(input || "")
    .replace(/^[a-z]:/i, "")
    .replace(/\\/g, "/")
    .split("/")
    .map(part => part.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim())
    .filter(part => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 160);
}

function setToolStatus(message, type) {
  toolStatus.innerHTML = `<div class="notice ${type}">${message}</div>`;
}

function showStatus(message, type = "info") {
  statusMessage.textContent = message;
  statusMessage.className = `status ${type}`;
  statusMessage.hidden = false;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    statusMessage.hidden = true;
  }, 4000);
}

function sendMessage(message) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return Promise.resolve({ ok: false, error: "Runtime indisponível." });
  }
  return chrome.runtime.sendMessage(message);
}
