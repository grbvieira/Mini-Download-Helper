const groupsEl = document.getElementById("groups");
const logsEl = document.getElementById("logs");
const subtitleEl = document.getElementById("subtitle");
const groupTemplate = document.getElementById("groupTemplate");
const itemTemplate = document.getElementById("itemTemplate");

const wsMap = new Map();
let currentData = null;
const userSelections = new Map();
const hasExtensionRuntime =
  typeof chrome !== "undefined" &&
  chrome.runtime?.sendMessage &&
  chrome.tabs?.query;

// Stores the URL of the tab that opened the popup.
let currentActiveTabUrl = "";

document.getElementById("settingsBtn").addEventListener("click", async () => {
  if (!hasExtensionRuntime) return;
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
  } else {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
});

document.getElementById("clearAllBtn").addEventListener("click", async () => {
  if (!hasExtensionRuntime) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_ALL" });
  await refresh();
});

document.getElementById("clearDownloadedBtn").addEventListener("click", async () => {
  if (!hasExtensionRuntime) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_DOWNLOADED" });
  await refresh();
});

// Re-render store updates after applying the active-tab filter.
if (hasExtensionRuntime) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STORE_UPDATED" && message.data) {
      const filteredData = filterDataForTab(message.data, currentActiveTabUrl);
      render(filteredData);
    }
  });

  // Read the active tab URL during popup initialization.
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    currentActiveTabUrl = tabs[0]?.url || "";
    refresh().catch(console.error);
  });
} else {
  currentActiveTabUrl = "https://example.com/aulas/modulo-01";
  render(buildPreviewData());
}

async function refresh() {
  if (!hasExtensionRuntime) {
    render(buildPreviewData());
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_MAIN_DATA" });

  if (!response?.ok) {
    render({
      hits: [],
      logs: [{ type: "error", message: response?.error || "Falha ao carregar" }],
      progress: {}
    });
    return;
  }

  // Apply the active-tab filter before rendering.
  const filteredData = filterDataForTab(response.data, currentActiveTabUrl);
  render(filteredData);
}

function filterDataForTab(data, activeTabUrl) {
  if (!data || !data.hits) return data;
  const activeBase = getBaseUrl(activeTabUrl);
  const filteredHits = [];
  
  for (const group of data.hits) {
    const filteredGroup = group.filter(hit => {
      const isCurrentPage = activeBase && getBaseUrl(hit.page_url) === activeBase;
      // Keep current-page items plus items that are already part of a user action.
      return isCurrentPage || hit.status === 'running' || hit.status === 'pinned' || hit.status === 'downloaded';
    });
    if (filteredGroup.length > 0) {
      filteredHits.push(filteredGroup);
    }
  }
  return { ...data, hits: filteredHits };
}

function getBaseUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(u || '');
  }
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isYouTubeWatchUrl(url) {
  return !!youtubeVideoId(url);
}

function normalizeYouTubeWatchUrl(url) {
  const id = youtubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : "";
}

function youtubeVideoId(url) {
  const parsed = safeUrl(url);
  if (!parsed) return "";
  if (!/(^|\.)youtube\.com$/i.test(parsed.hostname) && !/(^|\.)youtu\.be$/i.test(parsed.hostname)) return "";
  if (/youtu\.be$/i.test(parsed.hostname)) return parsed.pathname.split("/").filter(Boolean)[0] || "";
  if (/\/shorts\//i.test(parsed.pathname)) return parsed.pathname.split("/").filter(Boolean)[1] || "";
  return parsed.searchParams.get("v") || "";
}

function isYouTubeMediaUrl(url) {
  const parsed = safeUrl(url);
  return !!parsed && /(^|\.)googlevideo\.com$/i.test(parsed.hostname) && /\/videoplayback$/i.test(parsed.pathname);
}

function render(data) {
  currentData = structuredCloneSafe(data);

  const rawGroups = currentData?.hits || [];
  const logs = currentData?.logs || [];
  const progress = currentData?.progress || {};

  const visibleGroups = buildDisplayGroups(rawGroups, progress);

  const totalItems = visibleGroups.reduce((sum, group) => sum + group.length, 0);
  subtitleEl.textContent = `${totalItems} mídia(s) detectada(s) nesta aba`;

  groupsEl.innerHTML = "";

  if (!visibleGroups.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nenhuma mídia detectada nesta aba ainda.";
    groupsEl.appendChild(empty);
  } else {
    for (const group of visibleGroups) {
      const first = group[0];
      const groupNode = groupTemplate.content.firstElementChild.cloneNode(true);

      groupNode.querySelector(".group-title").textContent = first?.title || "Grupo";
      groupNode.querySelector(".group-meta").textContent = buildGroupMeta(group);

      const pageLink = groupNode.querySelector(".page-link");
      pageLink.href = first?.page_url || "#";
      pageLink.textContent = shortHost(first?.page_url || "");

      const itemsWrap = groupNode.querySelector(".group-items");
      for (const hit of group) {
        itemsWrap.appendChild(renderItem(hit, pickDisplayProgress(hit, progress)));
      }

      groupsEl.appendChild(groupNode);
    }
  }

  logsEl.textContent = logs
    .map(log => `[${new Date(log.at || Date.now()).toLocaleTimeString()}] ${String(log.type).toUpperCase()}: ${log.message}`)
    .join("\n");

  bindWebSockets(currentData);
}

function buildDisplayGroups(rawGroups) {
  const allHits = [];

  for (const group of rawGroups || []) {
    for (const hit of group || []) {
      if (isUsefulHitForDisplay(hit)) {
        allHits.push(structuredCloneSafe(hit));
      }
    }
  }

  const flattened = filterYouTubeFallbackHitsForDisplay(allHits);

  if (!flattened.length) return [];

  const families = new Map();

  for (const hit of flattened) {
    const familyKey = buildDisplayFamilyKey(hit);
    const existing = families.get(familyKey);

    if (!existing) {
      families.set(familyKey, createDisplayHit(hit));
      continue;
    }

    mergeDisplayHits(existing, hit);
  }

  const displayHits = [...families.values()]
    .map(finalizeDisplayHit)
    .sort((a, b) => {
      return bestVariantScore(b) - bestVariantScore(a) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });

  return displayHits.map(hit => [hit]);
}

function createDisplayHit(hit) {
  const displayHit = structuredCloneSafe(hit);
  displayHit.displaySourceHitIds = [hit.id];
  displayHit.primaryHitId = hit.id;
  displayHit.variants = cloneVariantsWithSource(hit.variants || {}, hit.id, hit.type);
  displayHit.type = chooseDisplayType([hit]);
  displayHit.status = chooseDisplayStatus([hit]);
  displayHit.pinned = !!hit.pinned;
  return displayHit;
}

function finalizeDisplayHit(hit) {
  const finalized = structuredCloneSafe(hit);
  finalized.variants = dedupeVariants(finalized.variants || {}, finalized);

  if (!Object.keys(finalized.variants).length) {
    const fallbackVariant = makeFallbackVariant(finalized);
    finalized.variants = { [fallbackVariant.id]: fallbackVariant };
  }

  const sources = collectDisplaySourceHits(finalized);
  finalized.primaryHitId = choosePrimaryHitId(finalized, sources);
  finalized.type = chooseDisplayType(sources);
  finalized.status = chooseDisplayStatus(sources);
  finalized.filename = finalized.filename || suggestDisplayFilename(finalized);

  return finalized;
}

function cloneVariantsWithSource(variants, sourceHitId, sourceType) {
  const out = {};

  for (const [variantId, variant] of Object.entries(variants || {})) {
    out[variantId] = {
      ...structuredCloneSafe(variant),
      sourceHitId,
      sourceType
    };
  }

  return out;
}

function isUsefulHitForDisplay(hit) {
  if (!hit || !hit.url) return false;

  const url = String(hit.url).toLowerCase();
  if (/\.(m4s|ts|m4f|cmfa|cmfv)(?:$|\?)/i.test(url)) return false;

  return ["hls", "dash", "file"].includes(String(hit.type || "").toLowerCase());
}

function buildDisplayFamilyKey(hit) {
  const host = safeHost(hit.page_url || hit.url);
  const pagePath = normalizePagePath(hit.page_url || hit.url);
  const title = normalizeLoose(hit.title);
  const thumbKey = normalizeLoose(filenameStem(filenameFromUrl(hit.thumbnail || "")));
  const fileKey = normalizeLoose(filenameStem(hit.filename || filenameFromUrl(hit.url)));

  return [host, pagePath, title || fileKey || thumbKey].filter(Boolean).join("::");
}

function mergeDisplayHits(target, source) {
  target.title = preferLonger(target.title, source.title);
  target.thumbnail = chooseBetterThumbnail(target.thumbnail, source.thumbnail);
  target.page_url = target.page_url || source.page_url;
  target.filename = chooseBetterFilename(target.filename, source.filename);
  target.duration = target.duration || source.duration;
  target.lastSeenAt = Math.max(target.lastSeenAt || 0, source.lastSeenAt || 0);
  target.displaySourceHitIds = uniqueArray([...(target.displaySourceHitIds || []), source.id]);
  target.pinned = !!target.pinned || !!source.pinned;

  if (!target.variants) target.variants = {};

  for (const [variantId, variant] of Object.entries(cloneVariantsWithSource(source.variants || {}, source.id, source.type))) {
    const existingEntry = Object.entries(target.variants).find(([, v]) => variantSignature(v) === variantSignature(variant));

    if (!existingEntry) {
      target.variants[variantId] = variant;
      continue;
    }

    const [existingId, existingVariant] = existingEntry;
    if (shouldPreferVariant(variant, existingVariant)) {
      target.variants[existingId] = { ...existingVariant, ...variant, id: existingId };
    }
  }

  const allSources = uniqueHitsById([
    ...collectDisplaySourceHits(target),
    source
  ]);

  target.type = chooseDisplayType(allSources);
  target.status = chooseDisplayStatus(allSources);
  target.primaryHitId = choosePrimaryHitId(target, allSources);
}

function collectDisplaySourceHits(displayHit) {
  const hits = [];
  for (const sourceId of displayHit.displaySourceHitIds || []) {
    const raw = findRawHitById(sourceId);
    if (raw) hits.push(raw);
  }
  return uniqueHitsById(hits);
}

function uniqueHitsById(hits) {
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    if (!hit?.id || seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
  }
  return out;
}

function chooseDisplayType(hits) {
  const types = new Set((hits || []).map(hit => String(hit?.type || "").toLowerCase()));
  if (types.has("hls")) return "hls";
  if (types.has("dash")) return "dash";
  if (types.has("file")) return "file";
  return hits?.[0]?.type || "file";
}

function chooseDisplayStatus(hits) {
  const statuses = new Set((hits || []).map(hit => String(hit?.status || "active").toLowerCase()));
  if (statuses.has("running")) return "running";
  if (statuses.has("pinned")) return "pinned";
  if (statuses.has("downloaded")) return "downloaded";
  return "active";
}

function choosePrimaryHitId(displayHit, hits) {
  const sorted = [...(hits || [])].sort((a, b) => {
    const aType = sourceTypePriority(a?.type);
    const bType = sourceTypePriority(b?.type);
    return bType - aType || bestVariantScore(b) - bestVariantScore(a) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });

  return sorted[0]?.id || displayHit.primaryHitId || displayHit.id;
}

function sourceTypePriority(type) {
  switch (String(type || "").toLowerCase()) {
    case "hls": return 30;
    case "dash": return 20;
    case "file": return 10;
    default: return 0;
  }
}

function chooseBetterThumbnail(a, b) {
  if (a && !isPlaceholderThumb(a)) return a;
  return b || a;
}

function chooseBetterFilename(a, b) {
  const ax = String(a || "").toLowerCase();
  const bx = String(b || "").toLowerCase();
  if (!a) return b;
  if (!b) return a;
  if (ax.endsWith(".mp4") && !bx.endsWith(".mp4")) return a;
  if (bx.endsWith(".mp4") && !ax.endsWith(".mp4")) return b;
  return preferLonger(a, b);
}

function isPlaceholderThumb(url) {
  return String(url || "").startsWith("data:image/svg+xml");
}

function variantSignature(variant) {
  return [
    normalizeVariantLabel(variant.label || ""),
    variant.height || 0,
    variant.width || 0,
    variant.audio_only ? "audio" : "video"
  ].join("::");
}

function shouldPreferVariant(next, current) {
  if (!current) return true;

  const nextScore = sourceVariantPriority(next);
  const currentScore = sourceVariantPriority(current);

  if (nextScore !== currentScore) return nextScore > currentScore;
  return scoreVariant(next) > scoreVariant(current);
}

function sourceVariantPriority(variant) {
  let score = 0;

  const isConcreteHlsVariant =
    variant?.sourceType === "hls" &&
    variant?.media_url &&
    /\.m3u8(?:$|\?)/i.test(variant.media_url);

  // Prefer real HLS child playlists over generic fallback variants.
  if (isConcreteHlsVariant) score += 5000;

  // Real yt-dlp selectors remain stronger than generic stream fallbacks.
  if (variant.ytdlp_format_id) score += 2000;

  if (variant.sourceType === "hls") score += 300;
  else if (variant.sourceType === "dash") score += 200;
  else if (variant.sourceType === "file") score += 100;
  else if (variant.sourceType === "hls_fallback") score += 10;

  if (!variant.audio_only) score += 50;
  return score;
}

function dedupeVariants(variantsObj, hit) {
  const variants = Object.values(variantsObj || {});
  const bestByKey = new Map();

  for (const variant of variants) {
    if (variant.audio_only) continue;

    const label = normalizeVariantLabel(variant.label || "");
    const key = [
      label || "auto",
      variant.height || 0,
      variant.width || 0
    ].join("::");

    const existing = bestByKey.get(key);
    if (!existing || shouldPreferVariant(variant, existing)) {
      bestByKey.set(key, variant);
    }
  }

  const out = {};
  const finalVariants = [...bestByKey.values()].sort((a, b) => scoreVariant(b) - scoreVariant(a));

  for (const variant of finalVariants) {
    out[variant.id] = variant;
  }

  if (!Object.keys(out).length && hit?.url) {
    const fallback = makeFallbackVariant(hit);
    out[fallback.id] = fallback;
  }

  return out;
}

function makeFallbackVariant(hit) {
  return {
    id: "default",
    label: hit?.type === "hls" ? "Auto HLS" : hit?.type === "dash" ? "Auto DASH" : "Arquivo",
    media_url: hit?.url || "",
    ext: "mp4",
    mime: hit?.mime || "",
    audio_only: false,
    width: null,
    height: null,
    bandwidth: null,
    sourceHitId: hit?.primaryHitId || hit?.id,
    sourceType: hit?.type || "file",
    ytdlp_format_id: null
  };
}

function pickDisplayProgress(hit, progressMap) {
  const sourceIds = hit.displaySourceHitIds || [hit.id];
  let best = null;

  for (const sourceId of sourceIds) {
    const progress = progressMap?.[sourceId];
    if (!progress) continue;

    if (!best) {
      best = progress;
      continue;
    }

    const bestPercent = Number(best.percent || 0);
    const nextPercent = Number(progress.percent || 0);
    if (nextPercent > bestPercent) {
      best = progress;
    }
  }

  return best;
}

function renderItem(hit, progress) {
  const node = itemTemplate.content.firstElementChild.cloneNode(true);

  const thumb = node.querySelector(".thumb");
  thumb.src = hit.thumbnail || createPlaceholderThumb(hit.type);
  thumb.alt = hit.title || "thumbnail";
  thumb.onerror = () => {
    thumb.src = createPlaceholderThumb(hit.type);
  };

  node.querySelector(".item-title").textContent = hit.title || "Mídia";

  const statusEl = node.querySelector(".status");
  const pretty = prettyStatus(hit.status || "active");
  statusEl.textContent = pretty;
  statusEl.setAttribute("data-status", pretty);

  node.querySelector(".item-type").textContent = prettyType(hit.type);
  node.querySelector(".item-file").textContent = buildItemInfo(hit);

  const select = node.querySelector(".variant-select");
  const variants = getSortedVariants(hit);
  const duplicateCounts = buildVariantLabelCounts(variants);

  select.innerHTML = "";

  if (!variants.length) {
    const fallback = document.createElement("option");
    fallback.value = "default";
    fallback.textContent = "Auto";
    select.appendChild(fallback);
  } else {
    for (const variant of variants) {
      const option = document.createElement("option");
      option.value = variant.id;
      option.textContent = describeVariantWithContext(variant, duplicateCounts);
      select.appendChild(option);
    }
  }

  if (userSelections.has(hit.id)) {
    const savedVal = userSelections.get(hit.id);
    if (Array.from(select.options).some(opt => opt.value === savedVal)) {
      select.value = savedVal;
    }
  }

  select.addEventListener("change", () => {
    userSelections.set(hit.id, select.value);
  });

  const progressRow = node.querySelector(".progress-row");
  const progressBar = node.querySelector(".progress-bar-inner");
  const progressText = node.querySelector(".progress-text");

  if (progress) {
    progressRow.classList.remove("hidden");
    progressBar.style.width = `${Math.max(0, Math.min(100, progress.percent || 0))}%`;
    progressText.textContent = progress.text || "";
  } else {
    progressRow.classList.add("hidden");
  }

  const downloadBtn = node.querySelector(".download-btn");
  const downloadAsBtn = node.querySelector(".download-as-btn");
  const cancelBtn = node.querySelector(".cancel-btn");
  const copyBtn = node.querySelector(".copy-btn");
  const pinBtn = node.querySelector(".pin-btn");
  const forgetBtn = node.querySelector(".forget-btn");

  downloadBtn.addEventListener("click", async () => {
    userSelections.set(hit.id, select.value);
    await runDisplayAction("download", hit, select.value);
  });

  downloadAsBtn.addEventListener("click", async () => {
    userSelections.set(hit.id, select.value);
    await runDisplayAction("download_as", hit, select.value);
  });

  cancelBtn.addEventListener("click", async () => {
    await runDisplayAction("cancel", hit, select.value);
  });

  copyBtn.addEventListener("click", async () => {
    const result = await runDisplayAction("copy", hit, select.value, false);
    if (result?.copyText) {
      await navigator.clipboard.writeText(result.copyText);
    }
  });

  pinBtn.textContent = hit.pinned ? "Desfixar" : "Fixar";
  pinBtn.addEventListener("click", async () => {
    await runDisplayAction("pin", hit, select.value);
  });

  forgetBtn.addEventListener("click", async () => {
    await runDisplayAction("forget", hit, select.value);
  });

  if (hit.status === "running") {
    downloadBtn.disabled = true;
    downloadAsBtn.disabled = true;
    cancelBtn.classList.remove("hidden");
  } else {
    cancelBtn.classList.add("hidden");
  }

  return node;
}

function buildVariantLabelCounts(variants) {
  const counts = new Map();
  for (const variant of variants) {
    const label = describeVariant(variant);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return counts;
}

function describeVariantWithContext(variant, duplicateCounts) {
  const base = describeVariant(variant);
  if ((duplicateCounts.get(base) || 0) <= 1) return base;

  if (variant.sourceType === "youtube_fmt") return `${base} • YouTube`;
  if (variant.sourceType === "hls") return `${base} • HLS`;
  if (variant.sourceType === "dash") return `${base} • DASH`;
  if (variant.sourceType === "file") return `${base} • MP4`;
  return base;
}

async function runDisplayAction(action, displayHit, variantId, doRefresh = true) {
  const variant = pickDisplayVariant(displayHit, variantId);
  let lastResult = { ok: true };

  if (!hasExtensionRuntime) {
    if (action === "copy") {
      return { ok: true, copyText: variant?.media_url || displayHit.url };
    }
    return lastResult;
  }

  if (action === "download" || action === "download_as" || action === "copy") {
    lastResult = await chrome.runtime.sendMessage({
      type: "ACTION_COMMAND",
      action,
      hitId: displayHit.primaryHitId || displayHit.id,
      variantId: variant?.id,
      sourceHitId: variant?.sourceHitId || displayHit.primaryHitId || displayHit.id,
      sourceVariantId: variant?.id
    });
  } else if (action === "pin" || action === "forget") {
    const sourceIds = (displayHit.displaySourceHitIds || [displayHit.primaryHitId || displayHit.id]).filter(Boolean);

    for (const sourceId of sourceIds) {
      lastResult = await chrome.runtime.sendMessage({
        type: "ACTION_COMMAND",
        action,
        hitId: sourceId
      });

      if (!lastResult?.ok) break;
    }
  } else {
    lastResult = await chrome.runtime.sendMessage({
      type: "ACTION_COMMAND",
      action,
      hitId: displayHit.primaryHitId || displayHit.id,
      variantId: variant?.id,
      sourceHitId: variant?.sourceHitId || displayHit.primaryHitId || displayHit.id,
      sourceVariantId: variant?.id
    });
  }

  if (!lastResult?.ok && lastResult?.error) {
    console.error(lastResult.error);
  }

  if (doRefresh) {
    await refresh();
  }

  return lastResult;
}

function pickDisplayVariant(hit, requestedId) {
  const variants = getSortedVariants(hit);
  if (!variants.length) return makeFallbackVariant(hit);
  return variants.find(v => v.id === requestedId) || variants[0];
}

function bindWebSockets(data) {
  const activeServerIds = new Map();

  for (const group of data?.hits || []) {
    for (const hit of group) {
      const serverId = data?.progress?.[hit.id]?.serverDownloadId || hit.serverDownloadId;
      if (serverId && hit.status === "running") {
        activeServerIds.set(serverId, hit.id);
        ensureWebSocket(serverId, hit.id);
      }
    }
  }

  for (const [serverId, ws] of wsMap.entries()) {
    if (!activeServerIds.has(serverId)) {
      try {
        ws.close();
      } catch { }
      wsMap.delete(serverId);
    }
  }
}

function ensureWebSocket(serverDownloadId, hitId) {
  if (wsMap.has(serverDownloadId)) return;

  const ws = new WebSocket(`ws://localhost:3000/?id=${encodeURIComponent(serverDownloadId)}`);

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "progress") {
        await patchProgress(hitId, {
          percent: typeof msg.percent === "number" ? msg.percent : 0,
          text: msg.size || "Baixando...",
          serverDownloadId
        });
      }

      if (msg.type === "success") {
        await patchProgress(hitId, {
          percent: 100,
          text: `Concluído: ${msg.filename || "arquivo"}`
        });
        await patchStatus(hitId, "downloaded");
      }

      if (msg.type === "error") {
        await patchProgress(hitId, {
          percent: 0,
          text: msg.error === "Download cancelado"
            ? "Cancelado"
            : `Erro: ${msg.error || "falha"}`
        });
        await patchStatus(hitId, "active");
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onclose = () => {
    wsMap.delete(serverDownloadId);
  };

  ws.onerror = () => {
    wsMap.delete(serverDownloadId);
  };

  wsMap.set(serverDownloadId, ws);
}

async function patchProgress(hitId, patch) {
  if (!currentData) return;

  if (!currentData.progress) currentData.progress = {};
  currentData.progress[hitId] = {
    ...(currentData.progress[hitId] || {}),
    ...patch
  };

  if (hasExtensionRuntime) {
    await chrome.runtime.sendMessage({
      type: "PATCH_PROGRESS",
      hitId,
      patch
    }).catch(() => { });
  }

  render(currentData);
}

function filterYouTubeFallbackHitsForDisplay(hits) {
  const richPages = new Set(
    hits
      .filter(isRichYouTubeDisplayHit)
      .map(hit => normalizeYouTubeWatchUrl(hit.page_url || hit.url || ""))
      .filter(Boolean)
  );

  if (!richPages.size) return hits;

  return hits.filter(hit => {
    if (isRichYouTubeDisplayHit(hit)) return true;
    const pageKey = normalizeYouTubeWatchUrl(hit.page_url || "");
    if (!pageKey || !richPages.has(pageKey)) return true;
    return !isYouTubeFallbackDisplayHit(hit);
  });
}

function isRichYouTubeDisplayHit(hit) {
  return (
    hit?.downloadStrategy === "ytdlp_page" ||
    hit?.source === "youtube_page" ||
    Object.values(hit?.variants || {}).some(variant => variant?.sourceType === "youtube_fmt")
  ) && isYouTubeWatchUrl(hit?.page_url || hit?.url || "");
}

function isYouTubeFallbackDisplayHit(hit) {
  if (!hit) return false;
  if (isYouTubeMediaUrl(hit.url || "")) return true;
  if (hit.source === "youtube_page" || hit.downloadStrategy === "ytdlp_page") return false;
  return isYouTubeWatchUrl(hit.page_url || "") && hit.type === "file";
}

function buildPreviewData() {
  const pageUrl = currentActiveTabUrl;
  const now = Date.now();

  return {
    hits: [[
      {
        id: "preview_hls",
        title: "Aula 03 - Introdução a streams adaptativos",
        filename: "aula-03-streams-adaptativos.mp4",
        page_url: pageUrl,
        url: "https://media.example.com/aula-03/master.m3u8",
        type: "hls",
        status: "active",
        thumbnail: "",
        lastSeenAt: now,
        variants: {
          best: {
            id: "best",
            label: "Qualidade Máxima (Original)",
            media_url: "https://media.example.com/aula-03/master.m3u8",
            ext: "mp4",
            width: 1920,
            height: 1080,
            bandwidth: 5000000,
            audio_only: false,
            sourceType: "hls"
          },
          hd: {
            id: "hd",
            label: "1280x720",
            media_url: "https://media.example.com/aula-03/720p.m3u8",
            ext: "mp4",
            width: 1280,
            height: 720,
            bandwidth: 2800000,
            audio_only: false,
            sourceType: "hls"
          }
        }
      },
      {
        id: "preview_file",
        title: "Material complementar - áudio da aula",
        filename: "audio-complementar.m4a",
        page_url: pageUrl,
        url: "https://media.example.com/audio-complementar.m4a",
        type: "file",
        status: "downloaded",
        thumbnail: "",
        lastSeenAt: now - 1000,
        variants: {
          default: {
            id: "default",
            label: "Arquivo (m4a)",
            media_url: "https://media.example.com/audio-complementar.m4a",
            ext: "m4a",
            audio_only: true,
            sourceType: "file"
          }
        }
      }
    ]],
    logs: [
      { type: "info", message: "Preview local do popup carregado", at: now },
      { type: "info", message: "Na extensão, esta lista vem do background.js", at: now }
    ],
    progress: {
      preview_file: {
        percent: 100,
        text: "Concluído"
      }
    }
  };
}

async function patchStatus(hitId, status) {
  if (!currentData) return;

  for (const group of currentData.hits || []) {
    for (const hit of group) {
      if (hit.id === hitId) {
        hit.status = status;
      }
    }
  }

  if (hasExtensionRuntime) {
    await chrome.runtime.sendMessage({
      type: "PATCH_STATUS",
      hitId,
      status
    }).catch(() => { });
  }

  render(currentData);
}

function getSortedVariants(hit) {
  return Object.values(hit.variants || {}).sort((a, b) => scoreVariant(b) - scoreVariant(a));
}

function describeVariant(variant) {
  if (!variant) return "Auto";

  if (variant.label === "Qualidade Máxima (Original)") return variant.label;
  if (variant.sourceType === "youtube_fmt" && variant.label) return variant.label;

  if (variant.audio_only) {
    if (variant.bandwidth) {
      return `Áudio • ${Math.round(variant.bandwidth / 1000)} kbps`;
    }
    return "Áudio";
  }

  if (variant.height) {
    return `${variant.height}p`;
  }

  if (variant.width && variant.height) {
    return `${variant.height}p`;
  }

  if (variant.bandwidth) {
    return `${Math.round(variant.bandwidth / 1000)} kbps`;
  }

  if (variant.label) {
    return normalizeVariantLabel(variant.label);
  }

  return "Auto";
}

function normalizeVariantLabel(label) {
  const raw = String(label || "").trim();

  const resMatch = raw.match(/(\d{3,4})x(\d{3,4})/i);
  if (resMatch) {
    return `${resMatch[2]}p`;
  }

  const pMatch = raw.match(/(\d{3,4})p/i);
  if (pMatch) {
    return `${pMatch[1]}p`;
  }

  return raw || "Auto";
}

function scoreVariant(v) {
  const resolutionScore = (v.width || 0) * (v.height || 0);
  const bandwidthScore = v.bandwidth || 0;
  const audioPenalty = v.audio_only ? -999999999 : 0;
  const sourceBonus = sourceVariantPriority(v);
  return resolutionScore + bandwidthScore + audioPenalty + sourceBonus;
}

function buildGroupMeta(group) {
  const hit = group[0];
  const variants = getSortedVariants(hit);
  const labels = variants.map(v => describeVariant(v)).filter(Boolean);
  const uniqueLabels = [...new Set(labels)];
  const duration = formatDuration(hit.duration);

  if (!uniqueLabels.length) {
    return [duration, `${group.length} item(ns)`].filter(Boolean).join(" • ");
  }

  return [duration, uniqueLabels.join(" • ")].filter(Boolean).join(" • ");
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function prettyType(type) {
  switch ((type || "").toLowerCase()) {
    case "hls":
      return "HLS";
    case "dash":
      return "DASH";
    case "file":
      return "Arquivo";
    default:
      return String(type || "Arquivo").toUpperCase();
  }
}

function prettyStatus(status) {
  switch ((status || "").toLowerCase()) {
    case "active":
      return "Ativo";
    case "running":
      return "Baixando";
    case "downloaded":
      return "Concluído";
    case "pinned":
      return "Fixado";
    case "inactive":
      return "Inativo";
    default:
      return status || "Ativo";
  }
}

function shortHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "página";
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function normalizePagePath(url) {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/\/+$/, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function normalizeLoose(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();
}

function preferLonger(a, b) {
  return String(b || "").length > String(a || "").length ? b : a;
}

function structuredCloneSafe(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

function bestVariantScore(hit) {
  return Math.max(0, ...Object.values(hit.variants || {}).map(scoreVariant), 0);
}

function createPlaceholderThumb(type) {
  const text = encodeURIComponent((type || "media").toUpperCase());
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">` +
    `<rect width="320" height="180" fill="#0d1117"/>` +
    `<rect x="20" y="20" width="280" height="140" rx="12" fill="#161b22" stroke="#2b3445"/>` +
    `<text x="160" y="98" font-family="Arial" font-size="24" fill="#8ea6c9" text-anchor="middle">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildItemInfo(hit) {
  const bits = [];
  const duration = formatDuration(hit.duration);
  if (duration) bits.push(duration);
  if (hit.filename) bits.push(hit.filename);
  return bits.join(" • ") || "sem nome";
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

function filenameStem(value) {
  return String(value || "")
    .replace(/^https?:\/\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .trim();
}

function suggestDisplayFilename(hit) {
  const base = normalizeLoose(filenameStem(hit.title || hit.filename || filenameFromUrl(hit.url || ""))) || "video";
  return `${base}.mp4`;
}

function findRawHitById(hitId) {
  for (const group of currentData?.hits || []) {
    for (const hit of group || []) {
      if (hit.id === hitId) return hit;
    }
  }
  return null;
}

function uniqueArray(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}
