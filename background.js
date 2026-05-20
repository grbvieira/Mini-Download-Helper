const STORE_KEY = "mdh_store_v2";

const MEDIA_EXT_RE =
  /\.(mp4|webm|m4v|mov|mp3|m4a|aac|ogg|ogv|wav|flac)(?:$|\?)/i;
const HLS_RE = /\.m3u8(?:$|\?)/i;
const DASH_RE = /\.mpd(?:$|\?)/i;
const SEGMENT_RE = /\.(m4s|ts|m4f|cmfa|cmfv)(?:$|\?)/i;

const HLS_MIME_RE =
  /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i;
const DASH_MIME_RE = /application\/dash\+xml/i;
const DIRECT_MEDIA_MIME_RE = /^(video|audio)\//i;

const SERVER_BASE = "http://localhost:3000";
const SETTINGS_KEY = "videoDownloaderSettings";

const store = {
  hitsById: {},
  progress: {},
  logs: [],
  directDownloadMap: {}
};

const defaultSettings = {
  detectHls: true,
  detectNative: true,
  defaultQuality: "best",
  downloadPath: "",
  skipDialog: true
};

let settings = { ...defaultSettings };
let persistTimer = null;
let loaded = false;

init().catch(err => {
  console.error("Init error:", err);
});

async function init() {
  await loadSettings();
  await loadStore();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch(error => {
        console.error("handleMessage error:", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  });

  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  chrome.webRequest.onCompleted.addListener(
    onCompleted,
    { urls: ["<all_urls>"] }
  );

  chrome.downloads.onChanged.addListener(onDownloadChanged);
  chrome.downloads.onErased.addListener(onDownloadErased);
  chrome.storage.onChanged.addListener(onStorageChanged);

  loaded = true;
  notifyPopup();
}

async function handleMessage(message, sender) {
  if (!message || typeof message !== "object") {
    return { ok: true };
  }

  switch (message.type) {
    case "GET_MAIN_DATA":
      return {
        ok: true,
        data: getMainData()
      };

    case "GET_SETTINGS":
      return {
        ok: true,
        settings
      };

    case "SAVE_SETTINGS":
      settings = normalizeSettings(message.settings);
      await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
      return { ok: true, settings };

    case "CHECK_TOOLS":
      return await checkServerTools();

    case "REGISTER_CANDIDATES":
      if (Array.isArray(message.items)) {
        for (const item of message.items) {
          await registerCandidate(item, sender, "content");
        }
      }
      return { ok: true };

    case "ACTION_COMMAND":
      return await handleActionCommand(message);

    case "CLEAR_ALL":
      await clearAllHits();
      return { ok: true };

    case "CLEAR_THUMB_CACHE":
      return await clearServerThumbCache();

    case "CLEAR_DOWNLOADED":
      clearDownloadedHits();
      return { ok: true };

    case "PATCH_PROGRESS":
      if (message.hitId && message.patch) {
        setProgress(message.hitId, message.patch);
        notifyPopup();
      }
      return { ok: true };

    case "PATCH_STATUS":
      if (message.hitId && message.status) {
        const hit = store.hitsById[message.hitId];
        if (hit) {
          hit.status = message.status;
          schedulePersist();
          notifyPopup();
        }
      }
      return { ok: true };

    default:
      return { ok: true };
  }
}

async function onHeadersReceived(details) {
  try {
    const url = details.url || "";
    const headers = headerArrayToObject(details.responseHeaders || []);
    const contentType = headers["content-type"] || "";
    const lowerUrl = url.toLowerCase();

    if (shouldIgnoreUrl(url)) return;
    if (SEGMENT_RE.test(lowerUrl)) return;

    if (settings.detectHls !== false && (HLS_RE.test(lowerUrl) || HLS_MIME_RE.test(contentType))) {
      await registerNetworkMedia(details, "hls", contentType, headers);
      return;
    }

    if (settings.detectHls !== false && (DASH_RE.test(lowerUrl) || DASH_MIME_RE.test(contentType))) {
      await registerNetworkMedia(details, "dash", contentType, headers);
      return;
    }

    if (settings.detectNative !== false && (MEDIA_EXT_RE.test(lowerUrl) || DIRECT_MEDIA_MIME_RE.test(contentType))) {
      await registerNetworkMedia(details, "file", contentType, headers);
    }
  } catch (error) {
    addLog("error", `onHeadersReceived: ${error.message}`);
  }
}

async function onCompleted(details) {
  try {
    const url = details.url || "";
    if (shouldIgnoreUrl(url)) return;
    if (SEGMENT_RE.test(url)) return;

    const isAdaptive = HLS_RE.test(url) || DASH_RE.test(url);
    const isDirect = MEDIA_EXT_RE.test(url);

    if ((settings.detectHls !== false && isAdaptive) || (settings.detectNative !== false && isDirect)) {
      await registerNetworkMedia(details, guessTypeFromUrl(url), "", {});
    }
  } catch (error) {
    addLog("error", `onCompleted: ${error.message}`);
  }
}

async function registerNetworkMedia(details, type, contentType, headers) {
  if (!details || details.tabId < 0) return;

  const tab = await safeGetTab(details.tabId);
  const pageUrl = tab?.url || "";
  const pageTitle = tab?.title || "";

  if (shouldIgnoreUrl(pageUrl) || isBlacklisted(details.url)) return;

  const hit = await buildHitFromUrl({
    url: details.url,
    type,
    mime: contentType || "",
    headers,
    tabId: details.tabId,
    pageUrl,
    titleHint: pageTitle,
    source: "network"
  });

  if (!hit) return;

  addOrMergeHit(hit);
}

async function registerCandidate(item, sender, source) {
  if (!item?.url) return;
  if (SEGMENT_RE.test(item.url)) return;

  const guessedType = item.type || guessTypeFromUrl(item.url);
  if ((guessedType === "hls" || guessedType === "dash") && settings.detectHls === false) return;
  if (guessedType === "file" && settings.detectNative === false) return;

  const tabId = sender?.tab?.id ?? item.tabId ?? -1;
  if (tabId < 0) return;

  const tab = await safeGetTab(tabId);
  const pageUrl = item.pageUrl || tab?.url || "";
  const pageTitle = item.title || tab?.title || "";

  if (shouldIgnoreUrl(item.url) || shouldIgnoreUrl(pageUrl) || isBlacklisted(item.url)) {
    return;
  }

  const hit = await buildHitFromUrl({
    url: item.url,
    type: guessedType,
    mime: item.mime || "",
    headers: {},
    tabId,
    pageUrl,
    titleHint: pageTitle,
    thumbnail: item.thumbnail || null,
    source
  });

  if (!hit) return;

  addOrMergeHit(hit);
}

async function maybeGenerateServerThumbnail({ url, pageUrl, title, thumbnail }) {
  if (thumbnail) return thumbnail;
  if (!url) return null;

  try {
    const response = await fetch(`${SERVER_BASE}/thumbnail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        title,
        referer: pageUrl || "https://example.com",
        headers: {}
      })
    });

    const json = await response.json();

    if (json?.success && json.thumbUrl) {
      return json.thumbUrl;
    }

    return null;
  } catch (error) {
    addLog("warn", `Falha ao gerar thumbnail no servidor: ${error.message}`);
    return null;
  }
}

async function buildHitFromUrl({
  url,
  type,
  mime,
  headers,
  tabId,
  pageUrl,
  titleHint,
  thumbnail = null,
  source
}) {
  const cleanUrl = sanitizeUrl(url);
  const cleanPageUrl = sanitizeUrl(pageUrl);

  if (!cleanUrl) return null;
  if (SEGMENT_RE.test(cleanUrl)) return null;

  const title = normalizeTitle(titleHint || filenameFromUrl(cleanUrl) || "Mídia detectada");

  const baseInfo = {
    id: "",
    group: "",
    tabId,
    page_url: cleanPageUrl,
    title,
    filename: suggestFilename(cleanUrl, type, titleHint),
    status: "active",
    mime: mime || mimeFromUrl(cleanUrl),
    type,
    url: cleanUrl,
    source,
    thumbnail: thumbnail || null,
    pinned: false,
    actions: ["download", "download_as", "copy", "pin", "forget"],
    variants: {},
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    fingerprint: ""
  };

  if (type === "hls") {
    const manifest = await tryParseHls(cleanUrl, headers);
    baseInfo.variants = buildHlsVariants(cleanUrl, manifest);
    baseInfo.variants = await maybeEnrichAdaptiveVariants({
      url: cleanUrl,
      referer: cleanPageUrl,
      type,
      currentVariants: baseInfo.variants
    });
    baseInfo.filename = suggestFilenameFromVariants(baseInfo.title, baseInfo.variants, "mp4");
    baseInfo.mime = "application/vnd.apple.mpegurl";
    baseInfo.fingerprint = buildHlsFingerprint(cleanPageUrl, title, cleanUrl, baseInfo.variants);
  } else if (type === "dash") {
    const manifest = await tryParseDash(cleanUrl, headers);
    baseInfo.variants = buildDashVariants(cleanUrl, manifest);
    baseInfo.variants = await maybeEnrichAdaptiveVariants({
      url: cleanUrl,
      referer: cleanPageUrl,
      type,
      currentVariants: baseInfo.variants
    });
    baseInfo.filename = suggestFilename(cleanUrl, "dash", baseInfo.title);
    baseInfo.mime = "application/dash+xml";
    baseInfo.fingerprint = buildDashFingerprint(cleanPageUrl, title, cleanUrl, baseInfo.variants);
  } else {
    const variantId = "default";
    baseInfo.variants[variantId] = {
      id: variantId,
      label: directLabelFromMime(baseInfo.mime, baseInfo.url),
      media_url: baseInfo.url,
      ext: extensionFromUrl(baseInfo.url) || "mp4",
      mime: baseInfo.mime || mimeFromUrl(baseInfo.url),
      audio_only: isAudioMime(baseInfo.mime),
      width: null,
      height: null,
      bandwidth: null
    };
    baseInfo.fingerprint = buildFileFingerprint(cleanPageUrl, title, cleanUrl);
  }

  baseInfo.group = buildGroupKey(baseInfo);
  baseInfo.id = makeId(baseInfo.fingerprint || cleanUrl);

  if (!baseInfo.thumbnail) {
    const bestVariant = Object.values(baseInfo.variants || {}).sort((a, b) => variantScore(b) - variantScore(a))[0];
    const thumbSourceUrl = bestVariant?.media_url || baseInfo.url;

    baseInfo.thumbnail = await maybeGenerateServerThumbnail({
      url: thumbSourceUrl,
      pageUrl: baseInfo.page_url,
      title: baseInfo.title,
      thumbnail: baseInfo.thumbnail
    });
  }

  return baseInfo;
}

function addOrMergeHit(hit) {
  const existing = store.hitsById[hit.id];

  if (!existing) {
    store.hitsById[hit.id] = hit;
    addLog("info", `Nova mídia: ${hit.title}`);
  } else {
    existing.lastSeenAt = Date.now();
    existing.title = preferLonger(existing.title, hit.title);
    existing.thumbnail = existing.thumbnail || hit.thumbnail;
    existing.page_url = existing.page_url || hit.page_url;
    existing.mime = existing.mime || hit.mime;
    existing.filename = existing.filename || hit.filename;
    existing.status = existing.pinned
      ? "pinned"
      : existing.status === "downloaded"
        ? "downloaded"
        : "active";
    existing.actions = uniqueArray([...(existing.actions || []), ...(hit.actions || [])]);

    mergeVariants(existing, hit.variants || {});
  }

  schedulePersist();
  notifyPopup();
}

function mergeVariants(existingHit, newVariants) {
  if (!existingHit.variants) existingHit.variants = {};

  for (const [variantId, variant] of Object.entries(newVariants)) {
    const key = variantKey(variant);
    const found = Object.entries(existingHit.variants).find(([, v]) => variantKey(v) === key);
    if (!found) {
      existingHit.variants[variantId] = variant;
    }
  }

  const sorted = Object.values(existingHit.variants).sort((a, b) => variantScore(b) - variantScore(a));
  if (sorted[0]) {
    existingHit.filename = suggestFilenameFromVariants(existingHit.title, existingHit.variants, sorted[0].ext || "mp4");
  }
}

function buildGroupKey(hit) {
  const pageHost = safeUrl(hit.page_url)?.host || "";
  const titleBase = normalizeLoose(hit.title);
  const type = hit.type || "file";
  return `${pageHost}::${titleBase}::${type}`;
}

function buildHlsFingerprint(pageUrl, title, url, variants) {
  const host = safeUrl(pageUrl)?.host || "";
  const topVariant = Object.values(variants || {}).sort((a, b) => variantScore(b) - variantScore(a))[0];
  const basePath = hlsBasePath(url, topVariant?.media_url || url);
  return `hls::${host}::${normalizeLoose(title)}::${basePath}`;
}

function buildDashFingerprint(pageUrl, title, url, variants) {
  const host = safeUrl(pageUrl)?.host || "";
  const topVariant = Object.values(variants || {}).sort((a, b) => variantScore(b) - variantScore(a))[0];
  const basePath = manifestBasePath(topVariant?.media_url || url);
  return `dash::${host}::${normalizeLoose(title)}::${basePath}`;
}

function buildFileFingerprint(pageUrl, title, url) {
  const host = safeUrl(pageUrl)?.host || "";
  const basePath = manifestBasePath(url);
  return `file::${host}::${normalizeLoose(title)}::${basePath}`;
}

function hlsBasePath(masterUrl, mediaUrl) {
  const candidate = mediaUrl || masterUrl;
  return manifestBasePath(candidate);
}

function manifestBasePath(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const trimmed = parts.slice(0, Math.max(0, parts.length - 1)).join("/");
    return `${u.host}/${trimmed}`;
  } catch {
    return url;
  }
}

function normalizeLoose(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();
}

function getGroupedHits() {
  const groups = new Map();

  for (const hit of Object.values(store.hitsById)) {
    if (!groups.has(hit.group)) groups.set(hit.group, []);
    groups.get(hit.group).push(hit);
  }

  const grouped = [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => {
      const aScore = bestVariantScore(a);
      const bScore = bestVariantScore(b);
      return bScore - aScore || b.lastSeenAt - a.lastSeenAt;
    });
    if (sorted[0]) sorted[0].primary = true;
    return sorted;
  });

  grouped.sort((a, b) => {
    const ta = a[0]?.lastSeenAt || 0;
    const tb = b[0]?.lastSeenAt || 0;
    return tb - ta;
  });

  return grouped;
}

function getMainData() {
  return {
    hits: getGroupedHits(),
    actions: {
      download: { title: "Baixar", icon: "download" },
      download_as: { title: "Salvar como", icon: "save" },
      copy: { title: "Copiar URL", icon: "copy" },
      pin: { title: "Fixar", icon: "pin" },
      forget: { title: "Remover", icon: "trash" }
    },
    logs: store.logs.slice(-100),
    progress: store.progress
  };
}

async function handleActionCommand(message) {
  const effectiveHitId = message.sourceHitId || message.hitId;
  const effectiveVariantId = message.sourceVariantId || message.variantId;

  const hit = store.hitsById[effectiveHitId];
  if (!hit) {
    return { ok: false, error: "Mídia não encontrada" };
  }

  switch (message.action) {
    case "download":
      return await startDownload(hit, effectiveVariantId, false);

    case "download_as":
      return await startDownload(hit, effectiveVariantId, true);

    case "copy": {
      const variant = pickVariant(hit, effectiveVariantId);
      return { ok: true, copyText: variant?.media_url || hit.url };
    }

    case "pin":
      hit.pinned = !hit.pinned;
      hit.status = hit.pinned ? "pinned" : hit.status === "downloaded" ? "downloaded" : "active";
      schedulePersist();
      notifyPopup();
      return { ok: true };

    case "forget":
      delete store.hitsById[hit.id];
      delete store.progress[hit.id];
      schedulePersist();
      notifyPopup();
      return { ok: true };

    default:
      return { ok: false, error: "Ação inválida" };
  }
}

async function startDownload(hit, variantId, saveAs) {
  const variant = pickVariant(hit, variantId);
  if (!variant) {
    return { ok: false, error: "Variante não encontrada" };
  }

  hit.status = "running";
  setProgress(hit.id, { percent: 1, text: "Iniciando..." });
  notifyPopup();

  try {
    if (hit.type === "file") {
      const downloadId = await chrome.downloads.download({
        url: variant.media_url,
        filename: buildDownloadFilename(hit.filename || suggestFilename(variant.media_url, "file", hit.title)),
        saveAs: saveAs || settings.skipDialog === false,
        conflictAction: "uniquify"
      });

      store.directDownloadMap[downloadId] = { hitId: hit.id };
      schedulePersist();
      notifyPopup();
      return { ok: true };
    }

    if (hit.type === "hls") {
      const isConcreteHlsVariant =
        variant.media_url &&
        variant.media_url !== hit.url &&
        /\.m3u8(?:$|\?)/i.test(variant.media_url);

      if (isConcreteHlsVariant) {
        const response = await fetch(`${SERVER_BASE}/download-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: variant.media_url,
            title: hit.title,
            referer: hit.page_url || "https://example.com",
            type: "hls",
            headers: {}
          })
        });

        const json = await response.json();
        if (!json.success) {
          throw new Error(json.error || "Falha no servidor local");
        }

        hit.serverDownloadId = json.downloadId;
        setProgress(hit.id, {
          percent: 1,
          text: `Enviado ao FFmpeg (${describeVariant(variant)})`,
          serverDownloadId: json.downloadId
        });

        schedulePersist();
        notifyPopup();
        return { ok: true };
      }

      const response = await fetch(`${SERVER_BASE}/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
          body: JSON.stringify({
            url: hit.url,
            quality: variant.ytdlp_format_id || normalizeDefaultQuality(settings.defaultQuality),
            title: hit.title,
            referer: hit.page_url || "https://example.com"
          })
      });

      const json = await response.json();
      if (!json.success) {
        throw new Error(json.error || "Falha no servidor local");
      }

      hit.serverDownloadId = json.downloadId;
      setProgress(hit.id, {
        percent: 1,
        text: `Enviado ao yt-dlp (${describeVariant(variant)})`,
        serverDownloadId: json.downloadId
      });

      schedulePersist();
      notifyPopup();
      return { ok: true };
    }

    if (hit.type === "dash") {
      const hasSelectableFormat = !!variant.ytdlp_format_id;

      if (hasSelectableFormat) {
        const response = await fetch(`${SERVER_BASE}/download`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: hit.url,
            quality: variant.ytdlp_format_id || normalizeDefaultQuality(settings.defaultQuality),
            title: hit.title,
            referer: hit.page_url || "https://example.com"
          })
        });

        const json = await response.json();
        if (!json.success) {
          throw new Error(json.error || "Falha no servidor local");
        }

        hit.serverDownloadId = json.downloadId;
        setProgress(hit.id, {
          percent: 1,
          text: `Enviado ao yt-dlp (${describeVariant(variant)})`,
          serverDownloadId: json.downloadId
        });

        schedulePersist();
        notifyPopup();
        return { ok: true };
      }

      const response = await fetch(`${SERVER_BASE}/download-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: variant.media_url,
          title: hit.title,
          referer: hit.page_url || "https://example.com",
          type: "dash",
          headers: {}
        })
      });

      const json = await response.json();
      if (!json.success) {
        throw new Error(json.error || "Falha no servidor local");
      }

      hit.serverDownloadId = json.downloadId;
      setProgress(hit.id, {
        percent: 1,
        text: `Enviado ao FFmpeg (${hit.type.toUpperCase()})`,
        serverDownloadId: json.downloadId
      });

      schedulePersist();
      notifyPopup();
      return { ok: true };
    }

    return { ok: false, error: "Tipo de mídia não suportado" };
  } catch (error) {
    hit.status = "active";
    setProgress(hit.id, {
      percent: 0,
      text: `Erro: ${error.message}`
    });
    schedulePersist();
    notifyPopup();
    return { ok: false, error: error.message };
  }
}

function onDownloadChanged(delta) {
  const entry = store.directDownloadMap[delta.id];
  if (!entry) return;

  const hit = store.hitsById[entry.hitId];
  if (!hit) return;

  if (
    typeof delta.bytesReceived?.current === "number" &&
    typeof delta.totalBytes?.current === "number" &&
    delta.totalBytes.current > 0
  ) {
    const percent = Math.min(
      100,
      Math.round((delta.bytesReceived.current / delta.totalBytes.current) * 100)
    );
    setProgress(hit.id, {
      percent,
      text: `${percent}%`
    });
  }

  if (delta.state?.current === "in_progress") {
    hit.status = "running";
  }

  if (delta.state?.current === "complete") {
    hit.status = "downloaded";
    setProgress(hit.id, {
      percent: 100,
      text: "Concluído"
    });
  }

  if (delta.error?.current) {
    hit.status = hit.pinned ? "pinned" : "active";
    setProgress(hit.id, {
      percent: 0,
      text: `Erro: ${delta.error.current}`
    });
    addLog("error", `Download erro: ${delta.error.current}`);
  }

  schedulePersist();
  notifyPopup();
}

function onDownloadErased(downloadId) {
  delete store.directDownloadMap[downloadId];
  schedulePersist();
}

async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = normalizeSettings(data?.[SETTINGS_KEY]);
  } catch (error) {
    addLog("warn", `Falha ao carregar configuracoes: ${error.message}`);
    settings = { ...defaultSettings };
  }
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
}

function normalizeSettings(value) {
  const next = { ...defaultSettings, ...(value || {}) };
  next.defaultQuality = normalizeDefaultQuality(next.defaultQuality);
  next.downloadPath = safeRelativePath(next.downloadPath || "");
  next.skipDialog = next.skipDialog !== false;
  next.detectHls = next.detectHls !== false;
  next.detectNative = next.detectNative !== false;
  return next;
}

async function checkServerTools() {
  try {
    const response = await fetch(`${SERVER_BASE}/check-tools`);
    const json = await response.json();
    return { ok: !!json?.success, tools: json?.tools || {}, error: json?.error };
  } catch (error) {
    return { ok: false, error: error.message, tools: {} };
  }
}

function pickVariant(hit, requestedId) {
  const variants = Object.values(hit.variants || {});
  if (!variants.length) return null;

  if (requestedId && hit.variants[requestedId]) {
    return hit.variants[requestedId];
  }

  return [...variants].sort((a, b) => variantScore(b) - variantScore(a))[0];
}

function setProgress(hitId, patch) {
  store.progress[hitId] = {
    ...(store.progress[hitId] || {}),
    ...patch,
    updatedAt: Date.now()
  };
  schedulePersist();
}

async function clearAllHits() {
  store.hitsById = {};
  store.progress = {};
  store.directDownloadMap = {};
  const thumbResult = await clearServerThumbCache();
  if (!thumbResult.ok) {
    addLog("warn", `Cache de thumbs nao foi limpo: ${thumbResult.error}`);
  }
  addLog("info", "Lista limpa");
  schedulePersist();
  notifyPopup();
}

async function clearServerThumbCache() {
  try {
    const response = await fetch(`${SERVER_BASE}/clear-thumbs`, { method: "POST" });
    const json = await response.json();
    if (!json?.success) {
      return { ok: false, error: json?.error || "Falha no servidor local" };
    }
    return { ok: true, deleted: Number(json.deleted || 0) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function clearDownloadedHits() {
  for (const [id, hit] of Object.entries(store.hitsById)) {
    if (hit.status === "downloaded") {
      delete store.hitsById[id];
      delete store.progress[id];
    }
  }
  schedulePersist();
  notifyPopup();
}

async function loadStore() {
  const data = await chrome.storage.local.get(STORE_KEY);
  const saved = data?.[STORE_KEY];
  if (!saved) return;

  store.hitsById = saved.hitsById || {};
  store.progress = saved.progress || {};
  store.logs = saved.logs || [];
  store.directDownloadMap = {};
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      [STORE_KEY]: {
        hitsById: store.hitsById,
        progress: store.progress,
        logs: store.logs.slice(-200)
      }
    });
  }, 300);
}

function notifyPopup() {
  if (!loaded) return;
  chrome.runtime.sendMessage({
    type: "STORE_UPDATED",
    data: getMainData()
  }).catch(() => { });
}

function addLog(level, message) {
  store.logs.push({
    key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: level,
    message,
    at: Date.now()
  });
  if (store.logs.length > 200) {
    store.logs = store.logs.slice(-200);
  }
  schedulePersist();
}

async function safeGetTab(tabId) {
  try {
    if (typeof tabId !== "number" || tabId < 0) return null;
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function guessTypeFromUrl(url) {
  if (HLS_RE.test(url)) return "hls";
  if (DASH_RE.test(url)) return "dash";
  return "file";
}

function shouldIgnoreUrl(url) {
  return !url || /^chrome-extension:|^moz-extension:|^data:|^blob:/i.test(url);
}

function sanitizeUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return "";
  }
}

function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function headerArrayToObject(headers) {
  const out = {};
  for (const h of headers) {
    if (!h?.name) continue;
    out[h.name.toLowerCase()] = h.value || "";
  }
  return out;
}

function makeId(input) {
  return `hit_${hashString(input)}`;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

function extensionFromUrl(url) {
  const name = filenameFromUrl(url);
  const match = name.match(/\.([a-z0-9]{1,6})$/i);
  return match ? match[1].toLowerCase() : "";
}

function mimeFromUrl(url) {
  const ext = extensionFromUrl(url);
  switch (ext) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "aac": return "audio/aac";
    case "wav": return "audio/wav";
    case "flac": return "audio/flac";
    case "m3u8": return "application/vnd.apple.mpegurl";
    case "mpd": return "application/dash+xml";
    default: return "";
  }
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Mídia detectada";
}

function suggestFilename(url, type, titleHint) {
  const title = normalizeForFilename(titleHint || "");
  const extFromUrl = extensionFromUrl(url);

  if (title) {
    if (type === "hls") return `${title}.mp4`;
    if (type === "dash") return `${title}.mp4`;
    if (extFromUrl) return `${title}.${extFromUrl}`;
    return `${title}.mp4`;
  }

  const raw = filenameFromUrl(url);
  if (raw) return raw;

  if (type === "hls") return "stream.mp4";
  if (type === "dash") return "video.mp4";
  return "download.mp4";
}

function suggestFilenameFromVariants(title, variants, fallbackExt) {
  const ext =
    Object.values(variants || {})[0]?.ext ||
    fallbackExt ||
    "mp4";
  return `${normalizeForFilename(title || "stream")}.${ext}`;
}

function normalizeForFilename(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "download";
}

function safeFilename(name) {
  return String(name || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 200);
}

function buildDownloadFilename(name) {
  const filename = safeFilename(name || "download");
  const folder = safeRelativePath(settings.downloadPath || "");
  return folder ? `${folder}/${filename}` : filename;
}

function safeRelativePath(input) {
  return String(input || "")
    .replace(/^[a-z]:/i, "")
    .replace(/\\/g, "/")
    .split("/")
    .map(part => safeFilename(part).trim())
    .filter(part => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 160);
}

function normalizeDefaultQuality(value) {
  const quality = String(value || "best").trim().toLowerCase();
  const map = {
    "2160p": "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
    "1440p": "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
    "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
    "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
    "360p": "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
    "best": "best",
    "auto": "best"
  };
  return map[quality] || value || "best";
}

function preferLonger(a, b) {
  return (String(b || "").length > String(a || "").length) ? b : a;
}

function uniqueArray(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function isAudioMime(mime) {
  return /^audio\//i.test(mime || "");
}

function directLabelFromMime(mime, url) {
  const ext = extensionFromUrl(url) || "arquivo";
  if (isAudioMime(mime)) return `Áudio (${ext})`;
  return `Arquivo (${ext})`;
}

function variantScore(variant) {
  const resolutionScore = (variant.width || 0) * (variant.height || 0);
  const bandwidthScore = variant.bandwidth || 0;
  return resolutionScore + bandwidthScore;
}

function bestVariantScore(hit) {
  return Math.max(0, ...Object.values(hit.variants || {}).map(variantScore));
}

function variantKey(variant) {
  return `${variant.media_url || ""}::${variant.width || 0}x${variant.height || 0}::${variant.bandwidth || 0}`;
}

function isBlacklisted(url) {
  return false;
}

/* -------------------------- HLS -------------------------- */

async function tryParseHls(url, headers) {
  try {
    const text = await fetchText(url, headers);
    return parseHls(text, url);
  } catch (error) {
    addLog("warn", `Falha ao ler HLS: ${error.message}`);
    return { kind: "media", variants: [] };
  }
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    credentials: "include",
    headers: buildSafeFetchHeaders(headers)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao ler manifesto`);
  }
  return await response.text();
}

function buildSafeFetchHeaders(headers) {
  const out = {};
  const allow = ["referer", "user-agent", "origin", "cookie", "authorization"];
  for (const key of allow) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function parseHls(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const variants = [];
  let pendingStreamInf = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingStreamInf = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }

    if (pendingStreamInf && !line.startsWith("#")) {
      const resolution = String(pendingStreamInf.RESOLUTION || "").split("x");
      variants.push({
        id: `v_${hashString(baseUrl + line)}`,
        label: pendingStreamInf.RESOLUTION
          ? `${pendingStreamInf.RESOLUTION}`
          : pendingStreamInf.BANDWIDTH
            ? `${Math.round(Number(pendingStreamInf.BANDWIDTH) / 1000)} kbps`
            : "HLS",
        media_url: new URL(line, baseUrl).href,
        ext: "mp4",
        mime: "application/vnd.apple.mpegurl",
        audio_only: false,
        width: Number(resolution[0]) || null,
        height: Number(resolution[1]) || null,
        bandwidth: Number(pendingStreamInf.BANDWIDTH) || null
      });
      pendingStreamInf = null;
    }
  }

  return {
    kind: variants.length ? "master" : "media",
    variants
  };
}

function buildHlsVariants(url, manifest) {
  if (manifest?.variants?.length) {
    const out = {};
    for (const v of manifest.variants) {
      out[v.id] = v;
    }
    return out;
  }

  return {
    default: {
      id: "default",
      label: "HLS",
      media_url: url,
      ext: "mp4",
      mime: "application/vnd.apple.mpegurl",
      audio_only: false,
      width: null,
      height: null,
      bandwidth: null
    }
  };
}

async function maybeEnrichAdaptiveVariants({ url, referer, type, currentVariants }) {
  const variants = { ...(currentVariants || {}) };
  // Always expose the original adaptive stream as a maximum-quality option.
  if (type === "hls" || type === "dash") {
    const maxId = `max_${hashString(url)}`;
    variants[maxId] = {
      id: maxId,
      label: "Qualidade Máxima (Original)",
      media_url: url,
      ext: "mp4",
      mime: type === "dash" ? "application/dash+xml" : "application/vnd.apple.mpegurl",
      audio_only: false,
      width: 9999, // Keep this option at the top of the score order.
      height: 0,   // Avoid displaying this synthetic option as 9999p.
      bandwidth: 99999999,
      ytdlp_format_id: "best",
      sourceType: type
    };
  }

  const nonAudioVariants = Object.values(variants).filter(v => !v.audio_only);

  if (type === "hls") {
    const hasConcreteChildPlaylists = nonAudioVariants.some(v => {
      return v.media_url && v.media_url !== url;
    });

    if (hasConcreteChildPlaylists || nonAudioVariants.length >= 2) {
      return variants;
    }
  }

  if (nonAudioVariants.length >= 2) {
    return variants;
  }

  try {
    const serverFormats = await fetchServerFormats(url, referer);
    const mapped = mapServerFormatsToVariants(serverFormats, url, type);

    for (const [variantId, variant] of Object.entries(mapped)) {
      const exists = Object.values(variants).some(v => variantKey(v) === variantKey(variant));
      if (!exists) {
        variants[variantId] = variant;
      }
    }
  } catch (error) {
    addLog("warn", `Falha ao enriquecer ${String(type || "stream").toUpperCase()}: ${error.message}`);
  }

  return variants;
}

async function fetchServerFormats(url, referer) {
  const response = await fetch(`${SERVER_BASE}/list-formats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      referer: referer || "https://example.com"
    })
  });

  const json = await response.json();
  if (!json?.success) {
    throw new Error(json?.error || "Falha ao listar formatos no servidor local");
  }

  return Array.isArray(json.formats) ? json.formats : [];
}

function mapServerFormatsToVariants(formats, url, type) {
  const out = {};

  for (const format of formats || []) {
    const parsed = parseResolutionLike(format.resolution || format.name || "");
    const id = `srv_${hashString(`${url}::${format.id}::${format.resolution || ""}::${format.name || ""}`)}`;

    const ytdlpFormat = format.id || "best";

    out[id] = {
      id,
      label: format.resolution || format.name || "Auto",
      media_url: url,
      ext: format.ext || "mp4",
      mime: type === "dash" ? "application/dash+xml" : "application/vnd.apple.mpegurl",
      audio_only: !!format.isAudioOnly,
      width: parsed.width,
      height: parsed.height,
      bandwidth: null,
      ytdlp_format_id: ytdlpFormat,
      sourceType: type === "hls" ? "hls_fallback" : type
    };
  }

  return out;
}

function parseResolutionLike(value) {
  const text = String(value || "");
  const res = text.match(/(\d{3,4})x(\d{3,4})/i);
  if (res) {
    return {
      width: Number(res[1]) || null,
      height: Number(res[2]) || null
    };
  }

  const p = text.match(/(\d{3,4})p/i);
  if (p) {
    const height = Number(p[1]) || null;
    return {
      width: null,
      height
    };
  }

  return {
    width: null,
    height: null
  };
}

function parseAttributeList(input) {
  const out = {};
  const parts = input.match(/(?:[^,"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

/* -------------------------- DASH -------------------------- */

async function tryParseDash(url, headers) {
  try {
    const text = await fetchText(url, headers);
    return parseDash(text, url);
  } catch (error) {
    addLog("warn", `Falha ao ler DASH: ${error.message}`);
    return { variants: [] };
  }
}

function parseDash(xmlText, baseUrl) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  const reps = [...xml.querySelectorAll("Representation")];

  const variants = reps.map((rep, index) => {
    const width = Number(rep.getAttribute("width")) || null;
    const height = Number(rep.getAttribute("height")) || null;
    const bandwidth = Number(rep.getAttribute("bandwidth")) || null;
    const mime =
      rep.getAttribute("mimeType") ||
      rep.parentElement?.getAttribute("mimeType") ||
      "video/mp4";

    const baseEl =
      rep.querySelector("BaseURL") ||
      rep.parentElement?.querySelector("BaseURL") ||
      xml.querySelector("BaseURL");

    const mediaUrl = baseEl?.textContent?.trim()
      ? new URL(baseEl.textContent.trim(), baseUrl).href
      : baseUrl;

    return {
      id: `dash_${index}_${hashString(mediaUrl)}`,
      label:
        width && height
          ? `${width}x${height}`
          : bandwidth
            ? `${Math.round(bandwidth / 1000)} kbps`
            : `DASH ${index + 1}`,
      media_url: mediaUrl,
      ext: "mp4",
      mime,
      audio_only: /^audio\//i.test(mime),
      width,
      height,
      bandwidth
    };
  });

  return { variants };
}

function buildDashVariants(url, manifest) {
  if (manifest?.variants?.length) {
    const out = {};
    for (const v of manifest.variants) {
      out[v.id] = v;
    }
    return out;
  }

  return {
    default: {
      id: "default",
      label: "DASH",
      media_url: url,
      ext: "mp4",
      mime: "application/dash+xml",
      audio_only: false,
      width: null,
      height: null,
      bandwidth: null
    }
  };
}

function describeVariant(variant) {
  if (!variant) return "Auto";
  // Preserve the custom label for the maximum-quality option.
  if (variant.label === "Qualidade Máxima (Original)") return variant.label;

  if (variant.audio_only) {
    if (variant.bandwidth) return `Áudio • ${Math.round(variant.bandwidth / 1000)} kbps`;
    return "Áudio";
  }

  if (variant.height) return `${variant.height}p`;
  if (variant.width && variant.height) return `${variant.height}p`;
  if (variant.bandwidth) return `${Math.round(variant.bandwidth / 1000)} kbps`;
  if (variant.label) return normalizeVariantLabel(variant.label);

  return "Auto";
}

function normalizeVariantLabel(label) {
  const raw = String(label || "").trim();
  const resMatch = raw.match(/(\d{3,4})x(\d{3,4})/i);
  if (resMatch) return `${resMatch[2]}p`;
  const pMatch = raw.match(/(\d{3,4})p/i);
  if (pMatch) return `${pMatch[1]}p`;
  return raw || "Auto";
}
