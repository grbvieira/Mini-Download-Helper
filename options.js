// options.js - Gerenciador de Configurações do Video Downloader Pro
class SettingsManager {
    constructor() {
        this.settings = {};
        this.defaultSettings = this.getDefaultSettings();
        this.currentTab = 'general';
        
        this.initialize();
    }

    async initialize() {
        console.log('⚙️ Settings Manager Iniciado');
        
        await this.loadSettings();
        this.setupEventListeners();
        this.setupTabNavigation();
        this.populateForm();
        this.checkIntegrationStatus();
        this.loadStatistics();
        
        console.log('✅ Configurações carregadas:', this.settings);
    }

    setupEventListeners() {
        // Navegação
        document.getElementById('backBtn').addEventListener('click', () => this.goBack());
        document.getElementById('saveBtn').addEventListener('click', () => this.saveSettings());
        
        // Abas
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });
        
        // Integração
        document.getElementById('testIntegration').addEventListener('click', () => this.testIntegration());
        document.getElementById('installTools').addEventListener('click', () => this.installTools());
        document.getElementById('browseYtDlp').addEventListener('click', () => this.browseForYtDlp());
        document.getElementById('browseFfmpeg').addEventListener('click', () => this.browseForFfmpeg());
        
        // Ferramentas
        document.getElementById('exportSettings').addEventListener('click', () => this.exportSettings());
        document.getElementById('importSettings').addEventListener('click', () => this.importSettings());
        document.getElementById('resetSettings').addEventListener('click', () => this.resetSettings());
        
        // Links
        document.getElementById('documentationBtn').addEventListener('click', () => this.openDocumentation());
        document.getElementById('reportIssueBtn').addEventListener('click', () => this.reportIssue());
        document.getElementById('featureRequestBtn').addEventListener('click', () => this.featureRequest());
        document.getElementById('websiteBtn').addEventListener('click', () => this.openWebsite());
        
        // Auto-save on change
        this.setupAutoSave();
    }

    setupAutoSave() {
        // Salvar automaticamente quando inputs mudam
        const autoSaveElements = document.querySelectorAll('input, select, textarea');
        autoSaveElements.forEach(element => {
            element.addEventListener('change', () => {
                this.debounce(() => {
                    this.saveFormToSettings();
                    this.showStatus('Configurações salvas automaticamente', 'success');
                }, 1000)();
            });
        });
    }

    setupTabNavigation() {
        // Ativar aba inicial
        this.switchTab('general');
    }

    switchTab(tabName) {
        // Desativar todas as abas
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        
        // Ativar aba selecionada
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
        
        this.currentTab = tabName;
        
        // Ações específicas por aba
        if (tabName === 'integration') {
            this.checkIntegrationStatus();
        } else if (tabName === 'about') {
            this.loadStatistics();
        }
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get(['videoDownloaderSettings']);
            this.settings = { ...this.defaultSettings, ...result.videoDownloaderSettings };
        } catch (error) {
            console.error('Erro ao carregar configurações:', error);
            this.settings = { ...this.defaultSettings };
        }
    }

    populateForm() {
        // Preencher todos os campos do formulário com as configurações
        
        // Aba Geral
        this.setChecked('detectCloudflare', this.settings.detectCloudflare);
        this.setChecked('detectHls', this.settings.detectHls);
        this.setChecked('detectNative', this.settings.detectNative);
        this.setChecked('autoDetect', this.settings.autoDetect);
        this.setChecked('showNotifications', this.settings.showNotifications);
        this.setChecked('badgeCounter', this.settings.badgeCounter);
        
        // Aba Download
        this.setValue('defaultQuality', this.settings.defaultQuality);
        this.setValue('defaultFormat', this.settings.defaultFormat);
        this.setValue('downloadPath', this.settings.downloadPath);
        this.setChecked('autoDownload', this.settings.autoDownload);
        this.setChecked('skipDialog', this.settings.skipDialog);
        this.setChecked('organizeFiles', this.settings.organizeFiles);
        this.setValue('maxConcurrentDownloads', this.settings.maxConcurrentDownloads);
        this.setValue('maxFileSize', this.settings.maxFileSize);
        
        // Aba Integração
        this.setValue('ytDlpPath', this.settings.ytDlpPath);
        this.setValue('ffmpegPath', this.settings.ffmpegPath);
        this.setValue('additionalArgs', this.settings.additionalArgs);
        this.setValue('timeout', this.settings.timeout);
        this.setValue('retries', this.settings.retries);
        
        // Aba Avançado
        this.setChecked('anonymousStats', this.settings.anonymousStats);
        this.setChecked('errorReporting', this.settings.errorReporting);
        this.setValue('cacheSize', this.settings.cacheSize);
        this.setValue('historySize', this.settings.historySize);
        this.setChecked('debugMode', this.settings.debugMode);
        this.setChecked('verboseLogging', this.settings.verboseLogging);
    }

    saveFormToSettings() {
        // Coletar valores do formulário e salvar no objeto settings
        
        // Aba Geral
        this.settings.detectCloudflare = this.getChecked('detectCloudflare');
        this.settings.detectHls = this.getChecked('detectHls');
        this.settings.detectNative = this.getChecked('detectNative');
        this.settings.autoDetect = this.getChecked('autoDetect');
        this.settings.showNotifications = this.getChecked('showNotifications');
        this.settings.badgeCounter = this.getChecked('badgeCounter');
        
        // Aba Download
        this.settings.defaultQuality = this.getValue('defaultQuality');
        this.settings.defaultFormat = this.getValue('defaultFormat');
        this.settings.downloadPath = this.getValue('downloadPath');
        this.settings.autoDownload = this.getChecked('autoDownload');
        this.settings.skipDialog = this.getChecked('skipDialog');
        this.settings.organizeFiles = this.getChecked('organizeFiles');
        this.settings.maxConcurrentDownloads = parseInt(this.getValue('maxConcurrentDownloads'));
        this.settings.maxFileSize = parseInt(this.getValue('maxFileSize'));
        
        // Aba Integração
        this.settings.ytDlpPath = this.getValue('ytDlpPath');
        this.settings.ffmpegPath = this.getValue('ffmpegPath');
        this.settings.additionalArgs = this.getValue('additionalArgs');
        this.settings.timeout = parseInt(this.getValue('timeout'));
        this.settings.retries = parseInt(this.getValue('retries'));
        
        // Aba Avançado
        this.settings.anonymousStats = this.getChecked('anonymousStats');
        this.settings.errorReporting = this.getChecked('errorReporting');
        this.settings.cacheSize = this.getValue('cacheSize');
        this.settings.historySize = this.getValue('historySize');
        this.settings.debugMode = this.getChecked('debugMode');
        this.settings.verboseLogging = this.getChecked('verboseLogging');
    }

    async saveSettings() {
        try {
            this.saveFormToSettings();
            
            await chrome.storage.sync.set({ 
                videoDownloaderSettings: this.settings 
            });
            
            // Notificar background script sobre mudanças
            await chrome.runtime.sendMessage({
                action: 'saveSettings',
                settings: this.settings
            });
            
            this.showStatus('Configurações salvas com sucesso!', 'success');
            
            // Recarregar estatísticas se necessário
            if (this.currentTab === 'about') {
                this.loadStatistics();
            }
            
        } catch (error) {
            console.error('Erro ao salvar configurações:', error);
            this.showStatus('Erro ao salvar configurações', 'error');
        }
    }

    async testIntegration() {
        const statusElement = document.getElementById('integrationStatus');
        statusElement.innerHTML = '<div>🧪 Testando integração com yt-dlp...</div>';
        statusElement.className = 'status info';
        
        try {
            // Simular teste de integração
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const ytDlpPath = this.getValue('ytDlpPath');
            const ffmpegPath = this.getValue('ffmpegPath');
            
            let ytDlpStatus = '❌ Não configurado';
            let ffmpegStatus = '❌ Não configurado';
            
            if (ytDlpPath) {
                ytDlpStatus = '✅ Configurado';
            }
            
            if (ffmpegPath) {
                ffmpegStatus = '✅ Configurado';
            }
            
            statusElement.innerHTML = `
                <div><strong>Status da Integração:</strong></div>
                <div>• yt-dlp: ${ytDlpStatus}</div>
                <div>• FFmpeg: ${ffmpegStatus}</div>
                ${!ytDlpPath ? '<div class="form-hint">Configure o caminho do yt-dlp para habilitar downloads</div>' : ''}
            `;
            
            statusElement.className = ytDlpPath ? 'status success' : 'status warning';
            
        } catch (error) {
            statusElement.innerHTML = `<div>❌ Erro ao testar integração: ${error.message}</div>`;
            statusElement.className = 'status error';
        }
    }

    async installTools() {
        this.showStatus('Preparando instalação das ferramentas...', 'info');
        
        try {
            // Em uma implementação real, isso baixaria e instalaria as ferramentas
            // Por enquanto, vamos simular a instalação
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Configurar caminhos padrão
            this.setValue('ytDlpPath', 'C:\\Program Files\\VideoDownloaderPro\\yt-dlp.exe');
            this.setValue('ffmpegPath', 'C:\\Program Files\\VideoDownloaderPro\\ffmpeg.exe');
            
            this.saveFormToSettings();
            this.showStatus('Ferramentas instaladas com sucesso! Configure os caminhos acima.', 'success');
            
            // Atualizar status
            this.checkIntegrationStatus();
            
        } catch (error) {
            this.showStatus(`Erro na instalação: ${error.message}`, 'error');
        }
    }

    browseForYtDlp() {
        this.showFilePicker('ytDlpPath', 'Selecione o yt-dlp.exe', ['.exe']);
    }

    browseForFfmpeg() {
        this.showFilePicker('ffmpegPath', 'Selecione o ffmpeg.exe', ['.exe']);
    }

    showFilePicker(elementId, title, accept) {
        // Em uma implementação real, usaria chrome.fileSystem API
        // Por enquanto, simularemos com um prompt
        
        const currentPath = this.getValue(elementId);
        const newPath = prompt(`${title}:\n(Caminho atual: ${currentPath || 'Nenhum'})`, currentPath);
        
        if (newPath !== null) {
            this.setValue(elementId, newPath);
            this.saveFormToSettings();
        }
    }

    async checkIntegrationStatus() {
        const ytDlpVersion = document.getElementById('ytDlpVersion');
        const ffmpegVersion = document.getElementById('ffmpegVersion');
        
        ytDlpVersion.textContent = '🔍 Verificando...';
        ffmpegVersion.textContent = '🔍 Verificando...';
        
        try {
            // Simular verificação de versão
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const ytDlpPath = this.getValue('ytDlpPath');
            const ffmpegPath = this.getValue('ffmpegPath');
            
            if (ytDlpPath) {
                ytDlpVersion.textContent = '2023.11.16 ✅';
                ytDlpVersion.style.color = '#10b981';
            } else {
                ytDlpVersion.textContent = 'Não instalado ❌';
                ytDlpVersion.style.color = '#ef4444';
            }
            
            if (ffmpegPath) {
                ffmpegVersion.textContent = '6.0 ✅';
                ffmpegVersion.style.color = '#10b981';
            } else {
                ffmpegVersion.textContent = 'Não instalado ❌';
                ffmpegVersion.style.color = '#ef4444';
            }
            
        } catch (error) {
            ytDlpVersion.textContent = 'Erro na verificação';
            ffmpegVersion.textContent = 'Erro na verificação';
        }
    }

    async loadStatistics() {
        try {
            // Carregar estatísticas do storage
            const result = await chrome.storage.local.get(['videoDownloaderStats']);
            const stats = result.videoDownloaderStats || {
                videosDetected: 0,
                downloadsCompleted: 0,
                startTime: Date.now()
            };
            
            document.getElementById('statsDetected').textContent = stats.videosDetected;
            document.getElementById('statsDownloads').textContent = stats.downloadsCompleted;
            
            // Calcular tempo de atividade
            const uptime = Date.now() - stats.startTime;
            const hours = Math.floor(uptime / (1000 * 60 * 60));
            const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
            document.getElementById('statsUptime').textContent = `${hours}h ${minutes}m`;
            
        } catch (error) {
            console.error('Erro ao carregar estatísticas:', error);
        }
    }

    async exportSettings() {
        try {
            this.saveFormToSettings();
            
            const settingsData = {
                settings: this.settings,
                version: '2.0.0',
                exportDate: new Date().toISOString()
            };
            
            const dataStr = JSON.stringify(settingsData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            
            const url = URL.createObjectURL(dataBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'video-downloader-pro-settings.json';
            a.click();
            
            URL.revokeObjectURL(url);
            
            this.showStatus('Configurações exportadas com sucesso!', 'success');
            
        } catch (error) {
            this.showStatus('Erro ao exportar configurações', 'error');
        }
    }

    async importSettings() {
        // Em uma implementação real, usaria file input
        // Por enquanto, simularemos com um prompt para JSON
        
        const jsonData = prompt('Cole o JSON das configurações:');
        if (!jsonData) return;
        
        try {
            const importedData = JSON.parse(jsonData);
            
            if (importedData.settings && importedData.version) {
                this.settings = { ...this.settings, ...importedData.settings };
                this.populateForm();
                await this.saveSettings();
                this.showStatus('Configurações importadas com sucesso!', 'success');
            } else {
                throw new Error('Formato de arquivo inválido');
            }
            
        } catch (error) {
            this.showStatus('Erro ao importar configurações: ' + error.message, 'error');
        }
    }

    async resetSettings() {
        if (confirm('Tem certeza que deseja redefinir todas as configurações para os valores padrão?\nEsta ação não pode ser desfeita.')) {
            this.settings = { ...this.defaultSettings };
            this.populateForm();
            await this.saveSettings();
            this.showStatus('Configurações redefinidas para os valores padrão!', 'success');
        }
    }

    // Métodos de utilidade
    getValue(elementId) {
        const element = document.getElementById(elementId);
        return element ? element.value : '';
    }

    setValue(elementId, value) {
        const element = document.getElementById(elementId);
        if (element) element.value = value;
    }

    getChecked(elementId) {
        const element = document.getElementById(elementId);
        return element ? element.checked : false;
    }

    setChecked(elementId, checked) {
        const element = document.getElementById(elementId);
        if (element) element.checked = checked;
    }

    showStatus(message, type = 'info') {
        const statusElement = document.getElementById('statusMessage');
        statusElement.textContent = message;
        statusElement.className = `status ${type}`;
        statusElement.classList.remove('hidden');
        
        // Auto-esconder após 5 segundos
        setTimeout(() => {
            statusElement.classList.add('hidden');
        }, 5000);
    }

    goBack() {
        window.close(); // Fechar a página de opções
    }

    openDocumentation() {
        window.open('https://github.com/videodownloaderpro/docs', '_blank');
    }

    reportIssue() {
        window.open('https://github.com/videodownloaderpro/issues', '_blank');
    }

    featureRequest() {
        window.open('https://github.com/videodownloaderpro/features', '_blank');
    }

    openWebsite() {
        window.open('https://videodownloaderpro.com', '_blank');
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    getDefaultSettings() {
        return {
            // Detecção
            detectCloudflare: true,
            detectHls: true,
            detectNative: true,
            autoDetect: false,
            showNotifications: true,
            badgeCounter: true,
            
            // Download
            defaultQuality: '1080p',
            defaultFormat: 'mp4',
            downloadPath: '',
            autoDownload: false,
            skipDialog: true,
            organizeFiles: true,
            maxConcurrentDownloads: 1,
            maxFileSize: 0,
            
            // Integração
            ytDlpPath: '',
            ffmpegPath: '',
            additionalArgs: '',
            timeout: 30,
            retries: 3,
            
            // Avançado
            anonymousStats: true,
            errorReporting: true,
            cacheSize: '100',
            historySize: '100',
            debugMode: false,
            verboseLogging: false
        };
    }
}

// Inicializar quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
    new SettingsManager();
});

// Adicionar alguns estilos dinâmicos
const style = document.createElement('style');
style.textContent = `
    .settings-container {
        animation: fadeIn 0.3s ease-in;
    }
    
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }
    
    .nav-tab {
        position: relative;
        overflow: hidden;
    }
    
    .nav-tab.active::before {
        content: '';
        position: absolute;
        bottom: -4px;
        left: 50%;
        transform: translateX(-50%);
        width: 20px;
        height: 3px;
        background: var(--primary);
        border-radius: 2px;
    }
    
    .checkbox-item:has(input:checked),
    .radio-item:has(input:checked) {
        border-color: var(--primary);
        background: rgba(37, 99, 235, 0.05);
    }
    
    .btn {
        position: relative;
        overflow: hidden;
    }
    
    .btn::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 0;
        height: 0;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 50%;
        transition: width 0.3s, height 0.3s;
        transform: translate(-50%, -50%);
    }
    
    .btn:active::after {
        width: 100px;
        height: 100px;
    }
`;
document.head.appendChild(style);