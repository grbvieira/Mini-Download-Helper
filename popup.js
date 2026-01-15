// popup.js - CORRIGIDO
class VideoDownloaderPro {
  constructor() {
    this.currentVideos = [];
    this.selectedVideo = null;
    this.selectedQuality = null;
    this.initializeElements(); // Chama setupEventListeners internamente
  }

  async initializeElements() {
    this.elements = {
      detectBtn: document.getElementById('detectBtn'),
      videosList: document.getElementById('videosList'),
      emptyContent: document.getElementById('emptyContent'),
      videoDetail: document.getElementById('videoDetail'),
      previewThumb: document.getElementById('previewThumb'),
      previewTitle: document.getElementById('previewTitle'),
      previewDuration: document.getElementById('previewDuration'),
      qualityGrid: document.getElementById('qualityGrid'),
      formatSelect: document.getElementById('formatSelect'),
      downloadBtn: document.getElementById('downloadBtn'),
      downloadStatus: document.getElementById('downloadStatus'),
      progressBar: document.getElementById('progressBar'),
      progressFill: document.getElementById('progressFill')
    };
    
    this.setupEventListeners();
    this.setupMessageListener();
    await this.checkRequiredTools(); // Chamada única
  }

  setupEventListeners() {
    this.elements.detectBtn.addEventListener('click', () => this.detectVideos());
    this.elements.downloadBtn.addEventListener('click', () => this.startDownload());
  }

  async checkRequiredTools() {
    try {
      const response = await fetch('http://localhost:3000/check-tools');
      const data = await response.json();
      
      // Ajuste conforme o retorno simplificado do server.js novo
      if (!data.tools.yt_dlp.installed || !data.tools.ffmpeg.installed) {
        this.showError('Instale yt-dlp e ffmpeg no sistema para continuar.');
        this.elements.downloadBtn.disabled = true;
        return false;
      }
      return true;
    } catch (error) {
      this.showError('Erro ao conectar ao servidor local (node server.js).');
      this.elements.downloadBtn.disabled = true;
      return false;
    }
  }

  async detectVideos() {
    this.showLoading('Detectando...');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'detectVideos' });

      if (response && response.videos.length > 0) {
        this.handleDetectedVideos(response.videos);
        this.showStatus('Vídeos detectados!', 'success');
      } else {
        this.showError('Nenhum vídeo detectado');
      }
    } catch (error) {
      this.showError('Recarregue a página e tente novamente.');
    }
  }

  handleDetectedVideos(videos) {
    this.currentVideos = videos;
    this.elements.videosList.innerHTML = '';
    
    videos.forEach(video => {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `
        <div class="video-thumb"><img src="${video.thumbnail || ''}"></div>
        <div class="video-info"><h3>${this.escapeHtml(video.title)}</h3></div>
      `;
      card.addEventListener('click', () => {
        document.querySelectorAll('.video-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this.selectVideo(video);
      });
      this.elements.videosList.appendChild(card);
    });
    
    this.elements.emptyContent.style.display = 'none';
  }

  selectVideo(video) {
    this.selectedVideo = video;
    this.elements.videoDetail.classList.add('active');
    this.elements.previewTitle.textContent = video.title;
    this.elements.previewThumb.src = video.thumbnail || '';
    this.loadRealQualities(video);
  }

  async loadRealQualities(video) {
    this.elements.qualityGrid.innerHTML = '<div class="loading">Carregando formatos...</div>';
    
    try {
      const response = await fetch('http://localhost:3000/list-formats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: video.url, referer: video.pageUrl })
      });
      
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      
      this.renderQualityOptions(result.formats);
    } catch (e) {
      this.elements.qualityGrid.innerHTML = `<div class="quality-error">Erro: ${e.message}</div>`;
    }
  }

  renderQualityOptions(qualities) {
    this.elements.qualityGrid.innerHTML = '';
    qualities.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'quality-card' + (i === 0 ? ' selected' : '');
      card.innerHTML = `
        <div class="quality-name">${q.name}</div>
        <div class="quality-res">${q.resolution}</div>
        <div class="quality-size">${q.size}</div>
      `;
      
      if(i === 0) this.selectedQuality = q;
      
      card.addEventListener('click', () => {
        document.querySelectorAll('.quality-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedQuality = q;
        this.elements.downloadBtn.disabled = false;
      });
      this.elements.qualityGrid.appendChild(card);
    });
    this.elements.downloadBtn.disabled = false;
  }

  startDownload() {
    if (!this.selectedVideo || !this.selectedQuality) return;

    this.elements.progressBar.style.display = 'block';
    this.elements.progressFill.style.width = '0%';
    this.showStatus('Iniciando...', 'info');

    fetch('http://localhost:3000/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: this.selectedVideo.url,
        quality: this.selectedQuality.id,
        format: this.elements.formatSelect.value,
        title: this.selectedVideo.title,
        referer: this.selectedVideo.pageUrl
      })
    })
    .then(res => res.json())
    .then(data => {
      if (!data.success) throw new Error(data.error);
      
      // Conectar WebSocket
      const ws = new WebSocket(`ws://localhost:3000/progress?id=${data.downloadId}`);
      
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'progress') {
          this.elements.progressFill.style.width = `${msg.percent}%`;
          this.showStatus(`${msg.percent}% - ${msg.size}`, 'info');
        } else if (msg.type === 'success') {
          this.showStatus('Concluído!', 'success');
          this.elements.progressFill.style.width = '100%';
          chrome.downloads.download({ url: msg.fileUrl, filename: msg.filename });
          ws.close();
        } else if (msg.type === 'error') {
          this.showStatus(`Erro: ${msg.error}`, 'error');
          ws.close();
        }
      };
      
      ws.onerror = () => this.showStatus('Erro na conexão WebSocket', 'error');
    })
    .catch(err => {
      this.showStatus(`Erro: ${err.message}`, 'error');
    });
  }

  showStatus(msg, type) {
    const el = this.elements.downloadStatus;
    el.textContent = msg;
    el.style.color = type === 'error' ? 'red' : (type === 'success' ? 'green' : 'orange');
  }

  showLoading(msg) { this.showStatus(msg, 'info'); }
  showError(msg) { this.showStatus(msg, 'error'); }
  
  setupMessageListener() { /* Mantido simples */ }
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VideoDownloaderPro();
});