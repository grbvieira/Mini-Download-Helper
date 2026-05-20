(() => {
  const sent = new Set();

  function safeSend(items) {
    if (!items.length) return;
    chrome.runtime.sendMessage({
      type: "REGISTER_CANDIDATES",
      items
    }).catch(() => {});
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function isUsefulImage(url) {
    if (!url) return false;
    if (/^data:/i.test(url)) return false;
    if (/sprite|avatar|icon|logo|emoji|badge/i.test(url)) return false;
    return true;
  }

  function getMetaThumbnail() {
    const selectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'link[rel="image_src"]',
      'link[rel="preload"][as="image"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const value =
        el.getAttribute("content") ||
        el.getAttribute("href") ||
        "";
      const full = normalizeUrl(value);
      if (isUsefulImage(full)) return full;
    }

    return "";
  }

  function getLargestPageImage() {
    const imgs = [...document.images]
      .map(img => {
        const src = normalizeUrl(img.currentSrc || img.src || "");
        return {
          src,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          area: (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0)
        };
      })
      .filter(img =>
        isUsefulImage(img.src) &&
        img.width >= 200 &&
        img.height >= 100
      )
      .sort((a, b) => b.area - a.area);

    return imgs[0]?.src || "";
  }

  function getBestThumbnail(preferred = "") {
    const poster = normalizeUrl(preferred || "");
    if (isUsefulImage(poster)) return poster;

    const metaThumb = getMetaThumbnail();
    if (metaThumb) return metaThumb;

    const largestImg = getLargestPageImage();
    if (largestImg) return largestImg;

    return "";
  }

  function collectFromDom() {
    const items = [];
    const pageThumb = getBestThumbnail();

    for (const video of document.querySelectorAll("video")) {
      const poster = getBestThumbnail(video.poster || pageThumb);
      const currentSrc = normalizeUrl(video.currentSrc || video.src);

      if (currentSrc && !sent.has(currentSrc)) {
        sent.add(currentSrc);
        items.push({
          url: currentSrc,
          type: guessType(currentSrc),
          mime: "",
          title: document.title,
          pageUrl: location.href,
          thumbnail: poster || pageThumb || null
        });
      }

      for (const source of video.querySelectorAll("source")) {
        const src = normalizeUrl(source.src);
        if (src && !sent.has(src)) {
          sent.add(src);
          items.push({
            url: src,
            type: guessType(src),
            mime: source.type || "",
            title: document.title,
            pageUrl: location.href,
            thumbnail: poster || pageThumb || null
          });
        }
      }
    }

    for (const audio of document.querySelectorAll("audio")) {
      const currentSrc = normalizeUrl(audio.currentSrc || audio.src);
      if (currentSrc && !sent.has(currentSrc)) {
        sent.add(currentSrc);
        items.push({
          url: currentSrc,
          type: "file",
          mime: "",
          title: document.title,
          pageUrl: location.href,
          thumbnail: pageThumb || null
        });
      }

      for (const source of audio.querySelectorAll("source")) {
        const src = normalizeUrl(source.src);
        if (src && !sent.has(src)) {
          sent.add(src);
          items.push({
            url: src,
            type: "file",
            mime: source.type || "",
            title: document.title,
            pageUrl: location.href,
            thumbnail: pageThumb || null
          });
        }
      }
    }

    safeSend(items);
  }

  function guessType(url) {
    if (/\.m3u8(?:$|\?)/i.test(url)) return "hls";
    if (/\.mpd(?:$|\?)/i.test(url)) return "dash";
    return "file";
  }

  function reportUrl(url, mime = "") {
    const full = normalizeUrl(url);
    if (!full || sent.has(full)) return;
    if (/^blob:/i.test(full) || /^data:/i.test(full)) return;
    if (/\.(m4s|ts|m4f|cmfa|cmfv)(?:$|\?)/i.test(full)) return;

    sent.add(full);

    safeSend([{
      url: full,
      type: guessType(full),
      mime,
      title: document.title,
      pageUrl: location.href,
      thumbnail: getBestThumbnail()
    }]);
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const request = args[0];
    const url =
      typeof request === "string"
        ? request
        : request?.url || "";

    if (url) reportUrl(url);

    const response = await originalFetch(...args);

    try {
      const ct = response.headers.get("content-type") || "";
      if (/^(video|audio)\//i.test(ct) || /mpegurl|dash\+xml/i.test(ct)) {
        reportUrl(response.url || url, ct);
      }
    } catch {}

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__mdh_url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", () => {
      try {
        const ct = this.getResponseHeader("content-type") || "";
        const candidate = this.responseURL || this.__mdh_url || "";
        if (
          /^(video|audio)\//i.test(ct) ||
          /mpegurl|dash\+xml/i.test(ct) ||
          /\.m3u8(?:$|\?)/i.test(candidate) ||
          /\.mpd(?:$|\?)/i.test(candidate)
        ) {
          reportUrl(candidate, ct);
        }
      } catch {}
    });

    return originalSend.apply(this, args);
  };

  collectFromDom();

  const observer = new MutationObserver(() => {
    collectFromDom();
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "poster", "content"]
  });

  setInterval(collectFromDom, 4000);
})();