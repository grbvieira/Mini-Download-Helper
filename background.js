// background.js - LÓGICA NOVA E SIMPLES
class DownloadManager {
  constructor() {
    this.activeDownloads = new Map();
    this.setupListeners();
  }

  setupListeners() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'startDownload') {
        this.startDownload(request.video, request.quality, request.options, sendResponse);
        return true; // mantém conexão viva
      }
    });

    // Monitora downloads do Chrome
    chrome.downloads.onChanged.addListener((delta) => {
      if (!delta.state) return;
      const downloadId = delta.id;
      const item = this.activeDownloads.get(downloadId);
      if (!item) return;

      if (delta.state.current === 'complete') {
        item.status = 'completed';
        this.notifyPopup('downloadSuccess', item);
        this.activeDownloads.delete(downloadId);
      } else if (delta.state.current === 'interrupted') {
        this.notifyPopup('downloadError', { error: 'Download interrompido' });
        this.activeDownloads.delete(downloadId);
      }
    });
  }

  async startDownload(video, quality, options, sendResponse) {
    const title = video.title || 'video';
    const format = options.format || 'mp4';

    this.notifyPopup('status', { message: 'Conectando ao servidor...' });

    try {
      // 1. Testa servidor
      const ping = await fetch('http://localhost:3000/ping').catch(() => null);
      if (!ping?.ok) {
        throw new Error('Servidor não está rodando. Execute: node server.js');
      }

      this.notifyPopup('status', { message: 'Baixando com yt-dlp...' });

      // 2. Envia para o servidor
      const response = await fetch('http://localhost:3000/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          quality: quality.id,
          format: format,
          title: title
        })
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Erro desconhecido');
      }

      this.notifyPopup('status', { message: 'Iniciando download no Chrome...' });

      // 3. Baixa com chrome.downloads
      const downloadId = await chrome.downloads.download({
        url: result.fileUrl,
        filename: result.filename,
        saveAs: false
      });

      const downloadItem = {
        id: downloadId,
        video: video,
        quality: quality,
        status: 'downloading',
        progress: 0
      };

      this.activeDownloads.set(downloadId, downloadItem);
      this.notifyPopup('downloadStarted', downloadItem);

      sendResponse({ success: true });

    } catch (error) {
      console.error('Download falhou:', error);
      this.notifyPopup('downloadError', { error: error.message });
      sendResponse({ success: false, error: error.message });
    }
  }

  notifyPopup(action, data) {
    try {
      chrome.runtime.sendMessage({ action, data });
    } catch (e) {
      // popup fechado
    }
  }
}

// Inicia
new DownloadManager();