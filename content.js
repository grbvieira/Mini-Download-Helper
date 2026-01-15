// content.js - DETECÇÃO + PLACEHOLDER DE QUALIDADES
class VideoDetector {
    constructor() {
        this.detectedVideos = new Map();
        this.isInitialized = false;
        this.initialize();
    }

    initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;
        
        console.log('Video Detector Inicializado - Cloudflare Ready');
        this.startMonitoring();
        this.setupMessageListener();
        
        setTimeout(() => {
            this.detectAllVideos();
            this.notifyExtension();
        }, 1000);
    }

    startMonitoring() {
        const observer = new MutationObserver((mutations) => {
            let shouldCheck = false;
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1 && (
                        node.tagName === 'IFRAME' || 
                        (node.querySelector && node.querySelector('iframe[src*="cloudflarestream"]'))
                    )) {
                        shouldCheck = true;
                    }
                });
            });
            
            if (shouldCheck) {
                setTimeout(() => this.detectAllVideos(), 500);
            }
        });

        observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('Content script recebeu:', request.action);
            
            if (request.action === 'detectVideos') {
                this.detectAllVideos();
                const response = {
                    success: true,
                    videos: Array.from(this.detectedVideos.values()),
                    count: this.detectedVideos.size,
                    timestamp: Date.now()
                };
                sendResponse(response);
                return true;
            }
            
            if (request.action === 'ping') {
                sendResponse({ 
                    success: true, 
                    message: 'Content script ativo',
                    videoCount: this.detectedVideos.size
                });
                return true;
            }
            
            sendResponse({ success: false, error: 'Ação desconhecida' });
            return true;
        });
    }

    detectAllVideos() {
        console.log('Executando detecção completa...');
        const previousCount = this.detectedVideos.size;
        this.detectedVideos.clear();
        
        this.detectCloudflareStreams();
        this.detectVideoElements();
        this.detectHlsUrls();
        
        const newCount = this.detectedVideos.size;
        console.log(`Detecção concluída: ${newCount} vídeos encontrados`);
        
        if (newCount > 0 && newCount !== previousCount) {
            this.notifyExtension();
        }
        
        return newCount;
    }

    detectCloudflareStreams() {
        try {
            const iframes = document.querySelectorAll('iframe[src*="cloudflarestream"]');
            console.log(`Encontrados ${iframes.length} iframes Cloudflare`);
            
            iframes.forEach((iframe, index) => {
                this.processCloudflareIframe(iframe, index);
            });
        } catch (error) {
            console.error('Erro ao detectar Cloudflare:', error);
        }
    }

    processCloudflareIframe(iframe, index) {
        const src = iframe.src;
        const jwtMatch = src.match(/cloudflarestream\.com\/([^\/]+)\/iframe/);
        if (!jwtMatch || !jwtMatch[1]) return;
        
        const token = jwtMatch[1];
        const manifestUrl = `https://customer-00w7xjj4f45btxqw.cloudflarestream.com/${token}/manifest/video.m3u8`;
        const thumbnail = this.extractThumbnailFromUrl(src);
        const title = this.extractVideoTitle(iframe);
        
        const videoData = {
            id: `cloudflare-${token.substring(0, 12)}`,
            type: 'cloudflare_stream',
            url: manifestUrl,
            title: title,
            thumbnail: thumbnail,
            duration: 0,
            qualities: this.generatePlaceholderQualities(), // ← PLACEHOLDER
            rawUrl: src,
            videoId: token,
            source: 'iframe',
            detectedAt: Date.now()
        };
        
        this.addVideo(videoData);
    }

    detectVideoElements() {
        const videos = document.querySelectorAll('video[src]');
        videos.forEach((video, index) => {
            const videoData = {
                id: `native-${index}-${Date.now()}`,
                type: 'native_video',
                url: video.src,
                title: this.extractVideoTitle(video),
                thumbnail: video.poster || '',
                duration: video.duration || 0,
                qualities: this.generatePlaceholderQualities(),
                source: 'video_element'
            };
            this.addVideo(videoData);
        });
    }

    detectHlsUrls() {
        const elements = document.querySelectorAll('[src*=".m3u8"], [href*=".m3u8"], [data-src*=".m3u8"]');
        elements.forEach((element, index) => {
            const url = element.src || element.href || element.getAttribute('data-src');
            if (url && url.includes('.m3u8')) {
                const videoData = {
                    id: `hls-${index}-${Date.now()}`,
                    type: 'hls_stream',
                    url: url,
                    title: this.extractVideoTitle(element),
                    thumbnail: '',
                    duration: 0,
                    qualities: this.generatePlaceholderQualities(),
                    source: 'm3u8_url'
                };
                this.addVideo(videoData);
            }
        });
    }

    addVideo(videoData) {
        if (!videoData.url) return;
        
        const enrichedVideo = {
            ...videoData,
            id: videoData.id || `video-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            domain: window.location.hostname,
            pageUrl: window.location.href,
            qualities: videoData.qualities || this.generatePlaceholderQualities()
        };
        
        this.detectedVideos.set(enrichedVideo.id, enrichedVideo);
    }

    generatePlaceholderQualities() {
        return [
            { id: 'loading', name: 'Carregando...', resolution: '—', size: '—', bitrate: '—', codec: '—' }
        ];
    }

    extractVideoTitle(element) {
        return element.title || 
               element.getAttribute('aria-label') ||
               element.getAttribute('data-title') ||
               element.closest('[data-title]')?.getAttribute('data-title') ||
               element.closest('.video-title')?.textContent?.trim() ||
               document.title ||
               `Vídeo ${this.detectedVideos.size + 1}`;
    }

    extractThumbnailFromUrl(url) {
        try {
            const posterMatch = url.match(/poster=([^&]+)/);
            if (posterMatch) return decodeURIComponent(posterMatch[1]);
        } catch (e) {}
        return '';
    }

    notifyExtension() {
        const videos = Array.from(this.detectedVideos.values());
        if (videos.length === 0) return;
        
        try {
            chrome.runtime.sendMessage({
                action: 'videosDetected',
                videos: videos,
                count: videos.length,
                timestamp: Date.now(),
                source: 'content_script'
            });
        } catch (error) {}
    }

    getDetectedVideos() {
        return Array.from(this.detectedVideos.values());
    }
}

const detector = new VideoDetector();
window.videoDetector = detector;

window.debugVideoDetection = function() {
    console.log('=== DEBUG VIDEO DETECTION ===');
    const videos = detector.getDetectedVideos();
    console.log(`${videos.length} vídeos detectados:`);
    videos.forEach(video => {
        console.log(`${video.title}:`, video.url);
    });
    return videos;
};