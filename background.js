const STORE_KEY = "mdh_store_v2";

const MEDIA_EXT_RE =
  /\.(mp4|webm|m4v|mov|mp3|m4a|aac|ogg|ogv|wav|flac)(?:$|\?)/i;
const HLS_RE = /\.m3u8(?:$|\?)/i;
const DASH_RE = /\.mpd(?:$|\?)/i;
const SEGMENT_RE = /\.(m4s|ts|m4f|cmfa|cmfv)(?:$|\?)/i;
const YOUTUBE_MEDIA_RE = /(?:^|\.)googlevideo\.com$/i;
const YOUTUBE_PAGE_RE = /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i;

const HLS_MIME_RE =
  /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i;
const DASH_MIME_RE = /application\/dash\+xml/i;
const DIRECT_MEDIA_MIME_RE = /^(video|audio)\//i;

const SERVER_BASE = "http://localhost:3000";
const SETTINGS_KEY = "videoDownloaderSettings";
const PAGE_THUMB_CACHE_TTL_MS = 15000;
const PAGE_FORMAT_CACHE_TTL_MS = 60000;
const REQUEST_HEADER_CACHE_TTL_MS = 10 * 60 * 1000;

const store = {
  hitsById: {},
  progress: {},
  logs: [],
  directDownloadMap: {}
};
const cancellingHitIds = new Set();

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
const pageThumbCache = new Map();
const pageFormatCache = new Map();
const requestHeaderCache = new Map();

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

  registerBeforeSendHeadersListener();

  chrome.webRequest.onCompleted.addListener(
    onCompleted,
    { urls: ["<all_urls>"] }
  );

  chrome.downloads.onChanged.addListener(onDownloadChanged);
  chrome.downloads.onErased.addListener(onDownloadErased);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onActivated.addListener(onTabActivated);

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

function registerBeforeSendHeadersListener() {
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders", "extraHeaders"]
    );
  } catch {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders"]
    );
  }
}

function onBeforeSendHeaders(details) {
  try {
    const url = details.url || "";
    if (shouldIgnoreUrl(url)) return;

    const lowerUrl = url.toLowerCase();
    if (
      !HLS_RE.test(lowerUrl) &&
      !DASH_RE.test(lowerUrl) &&
      !SEGMENT_RE.test(lowerUrl) &&
      !MEDIA_EXT_RE.test(lowerUrl)
    ) {
      return;
    }

    const headers = requestHeaderArrayToObject(details.requestHeaders || []);
    rememberRequestHeaders(url, headers);
  } catch (error) {
    addLog("warn", `Falha ao capturar headers: ${error.message}`);
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

function onTabUpdated(tabId, changeInfo, tab) {
  const url = changeInfo.url || tab?.url || "";
  if (changeInfo.status === "complete" || changeInfo.url) {
    maybeRegisterYouTubePage(tabId, url, tab?.title).catch(error => {
      addLog("warn", `Falha ao analisar YouTube: ${error.message}`);
    });
  }
}

async function onTabActivated(activeInfo) {
  const tab = await safeGetTab(activeInfo.tabId);
  await maybeRegisterYouTubePage(activeInfo.tabId, tab?.url || "", tab?.title || "").catch(error => {
    addLog("warn", `Falha ao analisar YouTube: ${error.message}`);
  });
}

async function registerNetworkMedia(details, type, contentType, headers) {
  if (!details || details.tabId < 0) return;

  const tab = await safeGetTab(details.tabId);
  const pageUrl = tab?.url || "";
  const pageTitle = tab?.title || "";
  const headerFilename = filenameFromContentDisposition(headers["content-disposition"]);

  if (shouldIgnoreUrl(pageUrl) || isBlacklisted(details.url)) return;
  if (isYouTubeWatchUrl(pageUrl)) {
    maybeRegisterYouTubePage(details.tabId, pageUrl, pageTitle).catch(error => {
      addLog("warn", `Falha ao enriquecer YouTube: ${error.message}`);
    });
  }
  const pageThumbnail = await collectPageThumbnailFromTab(details.tabId, pageUrl);

  const hit = await buildHitFromUrl({
    url: details.url,
    type,
    mime: contentType || "",
    headers,
    tabId: details.tabId,
    pageUrl,
    titleHint: headerFilename || pageTitle,
    headerFilename,
    thumbnail: pageThumbnail,
    contentLength: contentLengthFromHeaders(headers),
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
  if (isYouTubeWatchUrl(pageUrl)) {
    maybeRegisterYouTubePage(tabId, pageUrl, pageTitle).catch(error => {
      addLog("warn", `Falha ao enriquecer YouTube: ${error.message}`);
    });
  }
  const pageThumbnail = item.thumbnail || await collectPageThumbnailFromTab(tabId, pageUrl);

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
    thumbnail: pageThumbnail || null,
    source
  });

  if (!hit) return;

  addOrMergeHit(hit);
}

async function maybeRegisterYouTubePage(tabId, pageUrl, titleHint = "") {
  if (!isYouTubeWatchUrl(pageUrl)) return;

  const normalizedPageUrl = normalizeYouTubeWatchUrl(pageUrl);
  if (!normalizedPageUrl) return;

  const cached = pageFormatCache.get(normalizedPageUrl);
  if (cached?.pending) return cached.pending;
  if (cached?.at && Date.now() - cached.at < PAGE_FORMAT_CACHE_TTL_MS && cached.hitId) {
    return;
  }

  const pending = registerYouTubePageHit(tabId, normalizedPageUrl, titleHint)
    .finally(() => {
      const latest = pageFormatCache.get(normalizedPageUrl);
      if (latest?.pending === pending) {
        pageFormatCache.set(normalizedPageUrl, {
          ...latest,
          pending: null,
          at: Date.now()
        });
      }
    });

  pageFormatCache.set(normalizedPageUrl, { pending, at: Date.now() });
  return pending;
}

async function registerYouTubePageHit(tabId, pageUrl, titleHint = "") {
  const tab = await safeGetTab(tabId);
  const pageTitle = normalizeYouTubeTitle(titleHint || tab?.title || "");
  const pageThumbnail = await collectPageThumbnailFromTab(tabId, pageUrl);
  const formatInfo = await fetchServerFormatInfo(pageUrl, pageUrl);
  const variants = mapYouTubePageFormatsToVariants(formatInfo.formats, pageUrl);

  if (!Object.keys(variants).length) return;

  const title = normalizeTitle(formatInfo.title || pageTitle || "YouTube");
  const hit = {
    id: makeId(buildYouTubeFingerprint(pageUrl)),
    group: "",
    tabId,
    page_url: pageUrl,
    title,
    filename: suggestFilename(pageUrl, "youtube", title),
    status: "active",
    mime: "text/html",
    length: null,
    duration: Number.isFinite(formatInfo.duration) ? formatInfo.duration : null,
    type: "file",
    url: pageUrl,
    source: "youtube_page",
    downloadStrategy: "ytdlp_page",
    thumbnail: formatInfo.thumbnail || pageThumbnail || null,
    pinned: false,
    actions: ["download", "download_as", "copy", "pin", "forget"],
    variants,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    fingerprint: buildYouTubeFingerprint(pageUrl)
  };

  hit.group = buildGroupKey(hit);
  addOrMergeHit(hit);
  removeStaleYouTubeMediaHits(pageUrl, hit.id);
  pageFormatCache.set(pageUrl, { at: Date.now(), hitId: hit.id, pending: null });
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

async function maybeProbeServerOrientation({ url, fallbackUrl, pageUrl }) {
  if (!url) return null;

  try {
    const response = await fetch(`${SERVER_BASE}/probe-orientation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        referer: pageUrl || "https://example.com",
        headers: getDownloadHeadersForUrl(url, [fallbackUrl])
      })
    });

    const json = await response.json();
    if (json?.success && json.orientation?.hasVideo) {
      return json.orientation;
    }

    return null;
  } catch (error) {
    addLog("warn", `Falha ao analisar orientacao: ${error.message}`);
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
  headerFilename = "",
  contentLength = null,
  thumbnail = null,
  source
}) {
  const cleanUrl = sanitizeUrl(url);
  const cleanPageUrl = sanitizeUrl(pageUrl);

  if (!cleanUrl) return null;
  if (SEGMENT_RE.test(cleanUrl)) return null;

  const title = normalizeTitle(titleHint || headerFilename || filenameFromUrl(cleanUrl) || "Mídia detectada");
  const filenameHint = headerFilename || titleHint;

  const baseInfo = {
    id: "",
    group: "",
    tabId,
    page_url: cleanPageUrl,
    title,
    filename: suggestFilename(cleanUrl, type, filenameHint),
    status: "active",
    mime: mime || mimeFromUrl(cleanUrl),
    length: Number.isFinite(contentLength) ? contentLength : null,
    type,
    url: cleanUrl,
    source,
    thumbnail: thumbnail || null,
    orientation: null,
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
    const youtubeVariant = buildYouTubeFormatVariant({
      mediaUrl: cleanUrl,
      pageUrl: cleanPageUrl,
      mime: baseInfo.mime,
      contentLength: baseInfo.length
    });
    const variantId = youtubeVariant?.id || "default";

    baseInfo.variants[variantId] = youtubeVariant || {
      id: variantId,
      label: directLabelFromMime(baseInfo.mime, baseInfo.url),
      media_url: baseInfo.url,
      ext: extensionFromUrl(baseInfo.url) || "mp4",
      mime: baseInfo.mime || mimeFromUrl(baseInfo.url),
      audio_only: isAudioMime(baseInfo.mime),
      width: null,
      height: null,
      bandwidth: null,
      content_length: baseInfo.length
    };

    if (youtubeVariant) {
      baseInfo.downloadStrategy = "ytdlp_page";
      baseInfo.filename = suggestFilename(cleanPageUrl, "youtube", baseInfo.title);
      baseInfo.fingerprint = buildYouTubeFingerprint(cleanPageUrl);
    } else {
      baseInfo.fingerprint = buildFileFingerprint(cleanPageUrl, title, cleanUrl);
    }
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

  if (!baseInfo.orientation) {
    const bestVariant = Object.values(baseInfo.variants || {}).sort((a, b) => variantScore(b) - variantScore(a))[0];
    const probeSourceUrl = bestVariant?.media_url || baseInfo.url;

    baseInfo.orientation = await maybeProbeServerOrientation({
      url: probeSourceUrl,
      fallbackUrl: baseInfo.url,
      pageUrl: baseInfo.page_url
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
    existing.duration = existing.duration || hit.duration;
    existing.orientation = existing.orientation || hit.orientation;
    existing.downloadStrategy = existing.downloadStrategy || hit.downloadStrategy;
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

function removeStaleYouTubeMediaHits(pageUrl, keepId) {
  const normalized = normalizeYouTubeWatchUrl(pageUrl);
  if (!normalized) return;

  let changed = false;
  for (const [id, hit] of Object.entries(store.hitsById)) {
    if (id === keepId) continue;
    const samePage = normalizeYouTubeWatchUrl(hit.page_url || "") === normalized;
    if (samePage && isYouTubeMediaUrl(hit.url || "")) {
      delete store.hitsById[id];
      delete store.progress[id];
      changed = true;
    }
  }

  if (changed) {
    schedulePersist();
    notifyPopup();
  }
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

function buildYouTubeFingerprint(pageUrl) {
  const videoId = youtubeVideoId(pageUrl);
  return `youtube::${videoId || stripQuery(pageUrl)}`;
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
  const hits = filterYouTubeFallbackHits(Object.values(store.hitsById));

  for (const hit of hits) {
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

function filterYouTubeFallbackHits(hits) {
  const richPages = new Set(
    hits
      .filter(isRichYouTubeHit)
      .map(hit => normalizeYouTubeWatchUrl(hit.page_url || hit.url || ""))
      .filter(Boolean)
  );

  if (!richPages.size) return hits;

  return hits.filter(hit => {
    if (isRichYouTubeHit(hit)) return true;
    const pageKey = normalizeYouTubeWatchUrl(hit.page_url || "");
    if (!pageKey || !richPages.has(pageKey)) return true;
    return !isYouTubeFallbackHit(hit);
  });
}

function isRichYouTubeHit(hit) {
  return (
    hit?.downloadStrategy === "ytdlp_page" ||
    hit?.source === "youtube_page" ||
    Object.values(hit?.variants || {}).some(variant => variant?.sourceType === "youtube_fmt")
  ) && isYouTubeWatchUrl(hit?.page_url || hit?.url || "");
}

function isYouTubeFallbackHit(hit) {
  if (!hit) return false;
  if (isYouTubeMediaUrl(hit.url || "")) return true;
  if (hit.source === "youtube_page" || hit.downloadStrategy === "ytdlp_page") return false;
  return isYouTubeWatchUrl(hit.page_url || "") && hit.type === "file";
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

    case "cancel":
      return await cancelDownload(hit);

    default:
      return { ok: false, error: "Ação inválida" };
  }
}

async function cancelDownload(hit) {
  const progress = store.progress[hit.id] || {};
  const serverDownloadId = progress.serverDownloadId || hit.serverDownloadId;
  const directEntry = Object.entries(store.directDownloadMap)
    .find(([, entry]) => entry?.hitId === hit.id);

  if (cancellingHitIds.has(hit.id) || progress.cancelling) {
    return { ok: true, alreadyCancelling: true };
  }

  if (hit.status !== "running" || (!serverDownloadId && !directEntry)) {
    return { ok: false, error: "Nenhum download em andamento para cancelar" };
  }

  cancellingHitIds.add(hit.id);
  setProgress(hit.id, {
    ...progress,
    text: "Cancelando...",
    cancelling: true,
    serverDownloadId: serverDownloadId || null
  });
  notifyPopup();

  try {
    if (serverDownloadId) {
      const response = await fetch(`${SERVER_BASE}/cancel-download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ downloadId: serverDownloadId })
      });
      const json = await response.json();
      if (!json?.success) {
        throw new Error(json?.error || "Falha ao cancelar no servidor local");
      }
    }

    if (directEntry) {
      const [downloadId] = directEntry;
      await chrome.downloads.cancel(Number(downloadId)).catch(() => {});
      delete store.directDownloadMap[downloadId];
    }

    hit.status = hit.pinned ? "pinned" : "active";
    delete hit.serverDownloadId;
    setProgress(hit.id, {
      percent: 0,
      text: "Cancelado",
      serverDownloadId: null,
      chromeDownloadId: null,
      cancelling: false
    });
    addLog("info", `Download cancelado: ${hit.title}`);
    cancellingHitIds.delete(hit.id);
    schedulePersist();
    notifyPopup();
    return { ok: true };
  } catch (error) {
    cancellingHitIds.delete(hit.id);
    setProgress(hit.id, {
      percent: progress.percent || 0,
      text: `Erro ao cancelar: ${error.message}`,
      serverDownloadId: serverDownloadId || null,
      cancelling: false
    });
    schedulePersist();
    notifyPopup();
    return { ok: false, error: error.message };
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
      if (shouldUseYtDlpForFile(hit, variant)) {
        const response = await fetch(`${SERVER_BASE}/download`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: hit.page_url || hit.url,
            quality: ytdlpQualityForVariant(variant),
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

      const downloadId = await chrome.downloads.download({
        url: variant.media_url,
        filename: buildDownloadFilename(hit.filename || suggestFilename(variant.media_url, "file", hit.title)),
        saveAs: saveAs || settings.skipDialog === false,
        conflictAction: "uniquify"
      });

      store.directDownloadMap[downloadId] = { hitId: hit.id };
      setProgress(hit.id, {
        percent: 1,
        text: "Baixando...",
        chromeDownloadId: downloadId
      });
      schedulePersist();
      notifyPopup();
      return { ok: true };
    }

    if (hit.type === "hls") {
      if (isHlsPlaylistVariant(variant)) {
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
            headers: getDownloadHeadersForUrl(variant.media_url, [hit.url])
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
          headers: getDownloadHeadersForUrl(variant.media_url, [hit.url])
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
      text: `${percent}%`,
      chromeDownloadId: delta.id
    });
  }

  if (delta.state?.current === "in_progress") {
    hit.status = "running";
  }

  if (delta.state?.current === "complete") {
    hit.status = "downloaded";
    setProgress(hit.id, {
      percent: 100,
      text: "Concluído",
      chromeDownloadId: delta.id
    });
    delete store.directDownloadMap[delta.id];
  }

  if (delta.error?.current) {
    hit.status = hit.pinned ? "pinned" : "active";
    setProgress(hit.id, {
      percent: 0,
      text: delta.error.current === "USER_CANCELED"
        ? "Cancelado"
        : `Erro: ${delta.error.current}`
    });
    if (delta.error.current !== "USER_CANCELED") {
      addLog("error", `Download erro: ${delta.error.current}`);
    }
    delete store.directDownloadMap[delta.id];
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

function isHlsPlaylistVariant(variant) {
  return !!(
    variant?.media_url &&
    /\.m3u8(?:$|\?)/i.test(variant.media_url)
  );
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
}

function normalizeSettings(value) {
  const next = { ...defaultSettings, ...(value || {}) };
  next.defaultQuality = normalizeQualitySetting(next.defaultQuality);
  next.downloadPath = safeRelativePath(next.downloadPath || "");
  next.skipDialog = next.skipDialog !== false;
  next.detectHls = next.detectHls !== false;
  next.detectNative = next.detectNative !== false;
  return next;
}

function normalizeQualitySetting(value) {
  const raw = String(value || "best").trim();
  const lower = raw.toLowerCase();
  const allowed = new Set(["best", "auto", "2160p", "1440p", "1080p", "720p", "480p", "360p"]);
  if (allowed.has(lower)) return lower === "auto" ? "best" : lower;

  const heightMatch = raw.match(/height<=([0-9]{3,4})/i);
  if (heightMatch) return `${heightMatch[1]}p`;

  return "best";
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

async function collectPageThumbnailFromTab(tabId, pageUrl = "") {
  if (typeof tabId !== "number" || tabId < 0 || !chrome.scripting?.executeScript) {
    return "";
  }

  const cacheKey = `${tabId}:${pageUrl || ""}`;
  const cached = pageThumbCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PAGE_THUMB_CACHE_TTL_MS) {
    return cached.url;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) => {
          try {
            return new URL(value || "", window.location.href).href;
          } catch {
            return "";
          }
        };

        const isUsefulImage = (url) => {
          if (!url || /^data:/i.test(url)) return false;
          return !/sprite|avatar|icon|logo|emoji|badge|spacer/i.test(url);
        };

        const selectors = [
          ["meta[property='og:image:secure_url']", "content"],
          ["meta[property='og:image']", "content"],
          ["meta[property='og:image:url']", "content"],
          ["meta[name='twitter:image']", "content"],
          ["meta[name='twitter:image:src']", "content"],
          ["link[rel='thumbnail']", "href"],
          ["link[rel='image_src']", "href"],
          ["link[as='image']", "href"],
          ["video[poster]", "poster"],
          ["#vp-preview", "data-thumb"]
        ];

        for (const [selector, attr] of selectors) {
          for (const node of document.querySelectorAll(selector)) {
            const candidate = normalize(node.getAttribute(attr));
            if (isUsefulImage(candidate)) return candidate;
          }
        }

        const largest = [...document.images]
          .map(img => {
            const src = normalize(img.currentSrc || img.src || "");
            const width = img.naturalWidth || img.width || 0;
            const height = img.naturalHeight || img.height || 0;
            return { src, width, height, area: width * height };
          })
          .filter(img => isUsefulImage(img.src) && img.width >= 200 && img.height >= 100)
          .sort((a, b) => b.area - a.area)[0];

        return largest?.src || "";
      }
    });

    const url = typeof results?.[0]?.result === "string" ? results[0].result : "";
    pageThumbCache.set(cacheKey, { url, at: Date.now() });
    return url;
  } catch (error) {
    addLog("warn", `Falha ao coletar thumbnail da página: ${error.message}`);
    pageThumbCache.set(cacheKey, { url: "", at: Date.now() });
    return "";
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

function safeOriginFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
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

function requestHeaderArrayToObject(headers) {
  const out = {};
  for (const h of headers) {
    if (!h?.name) continue;
    out[h.name.toLowerCase()] = h.value || "";
  }
  return out;
}

function buildDownloadHeaders(headers = {}) {
  const allowed = [
    "accept",
    "accept-language",
    "authorization",
    "cookie",
    "origin",
    "referer",
    "user-agent"
  ];
  const out = {};

  for (const key of allowed) {
    if (headers[key]) out[key] = headers[key];
  }

  return out;
}

function rememberRequestHeaders(url, headers) {
  const cleanUrl = sanitizeUrl(url);
  const safeHeaders = buildDownloadHeaders(headers);
  if (!cleanUrl || !Object.keys(safeHeaders).length) return;

  cleanupRequestHeaderCache();

  const entry = {
    headers: safeHeaders,
    at: Date.now()
  };
  requestHeaderCache.set(cleanUrl, entry);

  const origin = safeOriginFromUrl(cleanUrl);
  if (origin) {
    requestHeaderCache.set(`origin:${origin}`, entry);
  }
}

function getDownloadHeadersForUrl(url, fallbackUrls = []) {
  cleanupRequestHeaderCache();

  for (const candidate of [url, ...fallbackUrls]) {
    const cleanUrl = sanitizeUrl(candidate);
    const entry = cleanUrl ? requestHeaderCache.get(cleanUrl) : null;
    if (entry) return { ...entry.headers };
  }

  const origin = safeOriginFromUrl(url);
  const originEntry = origin ? requestHeaderCache.get(`origin:${origin}`) : null;
  return originEntry ? { ...originEntry.headers } : {};
}

function cleanupRequestHeaderCache() {
  const now = Date.now();
  for (const [key, entry] of requestHeaderCache.entries()) {
    if (!entry?.at || now - entry.at > REQUEST_HEADER_CACHE_TTL_MS) {
      requestHeaderCache.delete(key);
    }
  }
}

function contentLengthFromHeaders(headers = {}) {
  const directLength = Number.parseInt(headers["content-length"], 10);
  if (Number.isFinite(directLength)) return directLength;

  const range = String(headers["content-range"] || "").match(/\/(\d+)$/);
  if (range) {
    const rangedLength = Number.parseInt(range[1], 10);
    if (Number.isFinite(rangedLength)) return rangedLength;
  }

  return null;
}

function filenameFromContentDisposition(value = "") {
  const header = String(value || "");
  if (!header) return "";

  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
    } catch {}
  }

  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1].trim();

  const plainMatch = header.match(/filename\s*=\s*([^;]+)/i);
  return plainMatch ? plainMatch[1].trim().replace(/^"|"$/g, "") : "";
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

function shouldUseYtDlpForFile(hit, variant) {
  return (
    hit?.downloadStrategy === "ytdlp_page" ||
    variant?.sourceType === "youtube_fmt"
  ) && isYouTubePageUrl(hit?.page_url || "");
}

function ytdlpQualityForVariant(variant) {
  if (variant?.sourceType === "youtube_fmt" && variant.ytdlp_format_id && !variant.audio_only) {
    return variant.ytdlp_format_id;
  }
  if (variant?.sourceType === "youtube_fmt" && variant.audio_only && variant.ytdlp_format_id) {
    return variant.ytdlp_format_id;
  }
  return normalizeDefaultQuality(settings.defaultQuality);
}

function buildYouTubeFormatVariant({ mediaUrl, pageUrl, mime, contentLength }) {
  if (!isYouTubePageUrl(pageUrl) || !isYouTubeMediaUrl(mediaUrl)) return null;

  const parsed = safeUrl(mediaUrl);
  const params = parsed?.searchParams;
  const itag = params?.get("itag") || "";
  const paramMime = params?.get("mime") || mime || mimeFromUrl(mediaUrl);
  const meta = youtubeItagMeta(itag);
  const audioOnly = /^audio\//i.test(paramMime) || meta.audioOnly;
  const height = meta.height || numberParam(params, "height");
  const width = meta.width || numberParam(params, "width");
  const bitrate = numberParam(params, "bitrate");
  const length = contentLength || numberParam(params, "clen");
  const ext = meta.ext || extensionFromMime(paramMime) || "mp4";
  const label = [
    itag ? `FMT ${itag}` : "FMT",
    audioOnly ? "audio" : height ? `${height}p` : "",
    ext.toUpperCase()
  ].filter(Boolean).join(" ");

  return {
    id: `yt_${hashString(`${pageUrl}::${itag || mediaUrl}`)}`,
    label,
    media_url: mediaUrl,
    ext,
    mime: paramMime || mime || "",
    audio_only: audioOnly,
    width,
    height,
    bandwidth: bitrate || null,
    content_length: length || null,
    has_audio: !!meta.hasAudio,
    ytdlp_format_id: itag || "best",
    sourceType: "youtube_fmt"
  };
}

function isYouTubePageUrl(url) {
  const parsed = safeUrl(url);
  return !!parsed && YOUTUBE_PAGE_RE.test(parsed.hostname);
}

function isYouTubeWatchUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed || !isYouTubePageUrl(url)) return false;
  return !!youtubeVideoId(url);
}

function normalizeYouTubeWatchUrl(url) {
  const id = youtubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : "";
}

function isYouTubeMediaUrl(url) {
  const parsed = safeUrl(url);
  return !!parsed && YOUTUBE_MEDIA_RE.test(parsed.hostname) && /\/videoplayback$/i.test(parsed.pathname);
}

function youtubeVideoId(url) {
  const parsed = safeUrl(url);
  if (!parsed) return "";
  if (/youtu\.be$/i.test(parsed.hostname)) return parsed.pathname.split("/").filter(Boolean)[0] || "";
  if (/\/shorts\//i.test(parsed.pathname)) return parsed.pathname.split("/").filter(Boolean)[1] || "";
  return parsed.searchParams.get("v") || "";
}

function normalizeYouTubeTitle(title) {
  return String(title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
}

function numberParam(params, key) {
  const value = Number.parseInt(params?.get(key) || "", 10);
  return Number.isFinite(value) ? value : null;
}

function extensionFromMime(mime) {
  const text = String(mime || "").toLowerCase();
  if (text.includes("webm")) return "webm";
  if (text.includes("mp4") || text.includes("m4a")) return "mp4";
  if (text.includes("mpeg")) return "mp3";
  return "";
}

function youtubeItagMeta(itag) {
  const map = {
    18: { height: 360, ext: "mp4", hasAudio: true },
    22: { height: 720, ext: "mp4", hasAudio: true },
    139: { audioOnly: true, ext: "m4a" },
    133: { height: 240, ext: "mp4" },
    134: { height: 360, ext: "mp4" },
    135: { height: 480, ext: "mp4" },
    136: { height: 720, ext: "mp4" },
    137: { height: 1080, ext: "mp4" },
    160: { height: 144, ext: "mp4" },
    242: { height: 240, ext: "webm" },
    243: { height: 360, ext: "webm" },
    244: { height: 480, ext: "webm" },
    247: { height: 720, ext: "webm" },
    248: { height: 1080, ext: "webm" },
    271: { height: 1440, ext: "webm" },
    278: { height: 144, ext: "webm" },
    313: { height: 2160, ext: "webm" },
    394: { height: 144, ext: "mp4" },
    395: { height: 240, ext: "mp4" },
    396: { height: 360, ext: "mp4" },
    397: { height: 480, ext: "mp4" },
    398: { height: 720, ext: "mp4" },
    399: { height: 1080, ext: "mp4" },
    400: { height: 1440, ext: "mp4" },
    401: { height: 2160, ext: "mp4" },
    140: { audioOnly: true, ext: "m4a" },
    249: { audioOnly: true, ext: "webm" },
    250: { audioOnly: true, ext: "webm" },
    251: { audioOnly: true, ext: "webm" }
  };
  return map[Number(itag)] || {};
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
  const info = await fetchServerFormatInfo(url, referer);
  return info.formats;
}

async function fetchServerFormatInfo(url, referer) {
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

  return {
    title: json.title || "",
    duration: Number.isFinite(json.duration) ? json.duration : null,
    thumbnail: json.thumbnail || "",
    formats: Array.isArray(json.formats) ? json.formats : []
  };
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

function mapYouTubePageFormatsToVariants(formats, pageUrl) {
  const out = {};

  for (const format of formats || []) {
    const parsed = parseResolutionLike(format.resolution || format.name || "");
    const isAudioOnly = !!format.isAudioOnly;
    const id = `ytp_${hashString(`${pageUrl}::${format.id}::${format.resolution || ""}`)}`;
    const ext = format.ext || (isAudioOnly ? "m4a" : "mp4");
    const label = [
      format.originalId ? `FMT ${format.originalId}` : "FMT",
      isAudioOnly ? "audio" : parsed.height ? `${parsed.height}p` : normalizeVariantLabel(format.resolution || ""),
      ext.toUpperCase(),
      format.size && format.size !== "—" ? format.size : ""
    ].filter(Boolean).join(" ");

    out[id] = {
      id,
      label,
      media_url: pageUrl,
      ext,
      mime: "",
      audio_only: isAudioOnly,
      width: parsed.width,
      height: parsed.height,
      bandwidth: null,
      ytdlp_format_id: format.id || "best",
      original_format_id: format.originalId || format.id || "best",
      has_audio: !!format.hasAudio,
      sourceType: "youtube_fmt"
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
  if (variant.sourceType === "youtube_fmt" && variant.label) return variant.label;

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
