// content.js - VERSÃO: ESPIÃO INTELIGENTE (COM THUMBNAILS)

// 1. Script injetado que entende JSON
const spyScript = `
(function() {
    // Função recursiva para caçar vídeos e thumbs dentro de objetos JSON
    function scanObjectForMedia(obj) {
        if (!obj || typeof obj !== 'object') return;

        // Se for array, varre cada item
        if (Array.isArray(obj)) {
            obj.forEach(item => scanObjectForMedia(item));
            return;
        }

        // Se for objeto, procura pares de vídeo/imagem
        let foundVideo = null;
        let foundImage = null;
        
        const keys = Object.keys(obj);
        
        // Passo 1: Identifica candidatos
        keys.forEach(key => {
            const value = obj[key];
            if (typeof value === 'string') {
                // É vídeo? (mp4, m3u8, mpd, mov)
                if (value.match(/https?:.*\\.(mp4|m3u8|mpd|mov)(\\?.*)?$/i)) {
                    foundVideo = value;
                }
                // É imagem? (jpg, png, webp, jpeg)
                else if (value.match(/https?:.*\\.(jpg|jpeg|png|webp)(\\?.*)?$/i)) {
                    // Prioriza imagens que tenham "thumb", "poster" ou "preview" no nome da chave ou valor
                    if (!foundImage || key.match(/thumb|poster|cover|preview/i)) {
                        foundImage = value;
                    }
                }
            }
            // Continua a busca profunda (recursão)
            else if (typeof value === 'object') {
                scanObjectForMedia(value);
            }
        });

        // Passo 2: Se achou vídeo neste nível, manda pra extensão
        if (foundVideo) {
            // Limpa barras invertidas de JSON
            const cleanVideo = foundVideo.replace(/\\\\/g, '/');
            const cleanThumb = foundImage ? foundImage.replace(/\\\\/g, '/') : null;

            window.dispatchEvent(new CustomEvent('VideoDownloader_Found', {
                detail: { 
                    url: cleanVideo,
                    thumbnail: cleanThumb
                }
            }));
        }
    }

    function tryParseAndScan(data) {
        if (typeof data !== 'string') return;
        
        try {
            // Tenta tratar como JSON
            const json = JSON.parse(data);
            scanObjectForMedia(json);
        } catch (e) {
            // Se falhar o JSON, usa o método antigo (Regex Bruta) como fallback
            // mas agora tentando pegar thumbs vizinhas é muito difícil via Regex, 
            // então foca no JSON que é 99% dos casos de carrossel.
        }
    }

    // --- INTERCEPTA FETCH ---
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch(...args);
        const clone = response.clone();
        clone.text().then(text => tryParseAndScan(text)).catch(() => {});
        return response;
    };

    // --- INTERCEPTA XHR ---
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(...args) {
        this.addEventListener('load', function() {
            tryParseAndScan(this.responseText);
        });
        originalOpen.apply(this, args);
    };
})();
`;

// 2. Classe Principal
class VideoDetector {
    constructor() {
        this.detectedVideos = new Map();
        this.initialize();
    }

    initialize() {
        this.injectSpy();
        this.setupMessageListener();
        this.startDomMonitoring();
        setTimeout(() => this.scanDom(), 1000);
    }

    injectSpy() {
        const script = document.createElement('script');
        script.textContent = spyScript;
        (document.head || document.documentElement).appendChild(script);
        script.remove();

        window.addEventListener('VideoDownloader_Found', (e) => {
            if (e.detail && e.detail.url) {
                this.addVideo(e.detail.url, 'api_json', null, { 
                    thumbnail: e.detail.thumbnail 
                });
            }
        });
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'detectVideos') {
                this.scanDom();
                sendResponse({ 
                    success: true, 
                    videos: Array.from(this.detectedVideos.values()),
                    count: this.detectedVideos.size
                });
            }
        });
    }

    startDomMonitoring() {
        const observer = new MutationObserver(() => this.scanDom());
        observer.observe(document, { childList: true, subtree: true });
    }

    scanDom() {
        // Varredura visual (Tags <video>, Iframes)
        document.querySelectorAll('video').forEach(v => {
            const src = v.currentSrc || v.src;
            if (src && src.startsWith('http')) {
                this.addVideo(src, 'video_tag', v, { thumbnail: v.poster });
            }
        });

        document.querySelectorAll('iframe[src*="cloudflarestream"]').forEach(iframe => {
            const match = iframe.src.match(/cloudflarestream\.com\/([^\/]+)\/iframe/);
            if (match) {
                const url = `https://customer-00w7xjj4f45btxqw.cloudflarestream.com/${match[1]}/manifest/video.m3u8`;
                const thumb = `https://customer-00w7xjj4f45btxqw.cloudflarestream.com/${match[1]}/thumbnails/thumbnail.jpg`;
                this.addVideo(url, 'cloudflare', iframe, { thumbnail: thumb });
            }
        });
    }

    addVideo(url, source, element = null, extraData = {}) {
        if (!url || !url.startsWith('http')) return;
        if (url.match(/\.(js|css|html|jpg|png|svg)/i)) return; // Ignora se a URL principal for imagem

        const cleanKey = url.split('?')[0];

        // Se já existe, atualiza a thumbnail se a nova for melhor
        if (this.detectedVideos.has(cleanKey)) {
            const existing = this.detectedVideos.get(cleanKey);
            if (!existing.thumbnail && extraData.thumbnail) {
                existing.thumbnail = extraData.thumbnail;
                this.notifyExtension();
            }
            return;
        }

        // Tenta descobrir o título
        let title = 'Vídeo Detectado';
        if (element) {
            title = element.getAttribute('title') || 
                    element.getAttribute('aria-label') || 
                    element.closest('[data-title]')?.getAttribute('data-title') ||
                    document.title;
        } else {
            try {
                const parts = url.split('?')[0].split('/');
                const filename = parts[parts.length - 1];
                if (filename && filename.length > 3) title = decodeURIComponent(filename);
            } catch(e){}
        }

        this.detectedVideos.set(cleanKey, {
            id: `vid-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            url: url,
            title: title,
            thumbnail: extraData.thumbnail || '', // Usa a thumb capturada do JSON
            type: source,
            pageUrl: window.location.href,
            qualities: [{ id: 'auto', name: 'Automático', resolution: 'HD', size: '?' }]
        });
        
        this.notifyExtension();
    }
    
    notifyExtension() {
        try {
            chrome.runtime.sendMessage({
                action: 'videosDetected',
                count: this.detectedVideos.size
            });
        } catch(e) {}
    }
}

new VideoDetector();