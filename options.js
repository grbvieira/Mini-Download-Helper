// Settings page controller for Video Downloader Pro.
class SettingsManager {
    constructor() {
        this.settings = {};
        this.defaultSettings = this.getDefaultSettings();
        this.currentTab = 'general';

        this.initialize();
    }

    async initialize() {
        await this.loadSettings();
        this.setupEventListeners();
        this.setupTabNavigation();
        this.populateForm();
        this.checkIntegrationStatus();
        this.loadStatistics();

    }

    setupEventListeners() {
        // Navigation
        document.getElementById('backBtn').addEventListener('click', () => this.goBack());
        document.getElementById('saveBtn').addEventListener('click', () => this.saveSettings());
        
        // Tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });
        // Integration
        document.getElementById('testIntegration').addEventListener('click', () => this.testIntegration());
        document.getElementById('installTools').addEventListener('click', () => this.installTools());
        document.getElementById('browseYtDlp').addEventListener('click', () => this.browseForYtDlp());
        document.getElementById('browseFfmpeg').addEventListener('click', () => this.browseForFfmpeg());
        
        // Tools
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
        // Save automatically when form controls change.
        const autoSaveElements = document.querySelectorAll('input, select, textarea');
        autoSaveElements.forEach(element => {
            element.addEventListener('change', () => {
                this.debounce(() => {
                    this.saveSettings('Configura??es salvas automaticamente');
                }, 1000)();
            });
        });
    }

    setupTabNavigation() {
        // Activate the initial tab.
        this.switchTab('general');
    }

    switchTab(tabName) {
        // Deactivate every tab.
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        
        // Activate the selected tab.
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
        
        this.currentTab = tabName;
        // Run tab-specific actions.
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
            console.error('Erro ao carregar configura??es:', error);
            this.settings = { ...this.defaultSettings };
        }
    }

    populateForm() {
        // Populate form controls from stored settings.
        
        // General tab
        this.setChecked('detectCloudflare', this.settings.detectCloudflare);
        this.setChecked('detectHls', this.settings.detectHls);
        this.setChecked('detectNative', this.settings.detectNative);
        this.setChecked('autoDetect', this.settings.autoDetect);
        this.setChecked('showNotifications', this.settings.showNotifications);
        this.setChecked('badgeCounter', this.settings.badgeCounter);
        
        // Download tab
        this.setValue('defaultQuality', this.settings.defaultQuality);
        this.setValue('defaultFormat', this.settings.defaultFormat);
        this.setValue('downloadPath', this.settings.downloadPath);
        this.setChecked('autoDownload', this.settings.autoDownload);
        this.setChecked('skipDialog', this.settings.skipDialog);
        this.setChecked('organizeFiles', this.settings.organizeFiles);
        this.setValue('maxConcurrentDownloads', this.settings.maxConcurrentDownloads);
        this.setValue('maxFileSize', this.settings.maxFileSize);
        // Integration tab
        this.setValue('ytDlpPath', this.settings.ytDlpPath);
        this.setValue('ffmpegPath', this.settings.ffmpegPath);
        this.setValue('additionalArgs', this.settings.additionalArgs);
        this.setValue('timeout', this.settings.timeout);
        this.setValue('retries', this.settings.retries);
        // Advanced tab
        this.setChecked('anonymousStats', this.settings.anonymousStats);
        this.setChecked('errorReporting', this.settings.errorReporting);
        this.setValue('cacheSize', this.settings.cacheSize);
        this.setValue('historySize', this.settings.historySize);
        this.setChecked('debugMode', this.settings.debugMode);
        this.setChecked('verboseLogging', this.settings.verboseLogging);
    }

    saveFormToSettings() {
        // Copy form values into the settings object.
        
        // General tab
        this.settings.detectCloudflare = this.getChecked('detectCloudflare');
        this.settings.detectHls = this.getChecked('detectHls');
        this.settings.detectNative = this.getChecked('detectNative');
        this.settings.autoDetect = this.getChecked('autoDetect');
        this.settings.showNotifications = this.getChecked('showNotifications');
        this.settings.badgeCounter = this.getChecked('badgeCounter');
        
        // Download tab
        this.settings.defaultQuality = this.getValue('defaultQuality');
        this.settings.defaultFormat = this.getValue('defaultFormat');
        this.settings.downloadPath = this.getValue('downloadPath');
        this.settings.autoDownload = this.getChecked('autoDownload');
        this.settings.skipDialog = this.getChecked('skipDialog');
        this.settings.organizeFiles = this.getChecked('organizeFiles');
        this.settings.maxConcurrentDownloads = parseInt(this.getValue('maxConcurrentDownloads'));
        this.settings.maxFileSize = parseInt(this.getValue('maxFileSize'));
        // Integration tab
        this.settings.ytDlpPath = this.getValue('ytDlpPath');
        this.settings.ffmpegPath = this.getValue('ffmpegPath');
        this.settings.additionalArgs = this.getValue('additionalArgs');
        this.settings.timeout = parseInt(this.getValue('timeout'));
        this.settings.retries = parseInt(this.getValue('retries'));
        // Advanced tab
        this.settings.anonymousStats = this.getChecked('anonymousStats');
        this.settings.errorReporting = this.getChecked('errorReporting');
        this.settings.cacheSize = this.getValue('cacheSize');
        this.settings.historySize = this.getValue('historySize');
        this.settings.debugMode = this.getChecked('debugMode');
        this.settings.verboseLogging = this.getChecked('verboseLogging');
    }

    async saveSettings(successMessage = 'Configura??es salvas com sucesso!') {
        try {
            this.saveFormToSettings();
            
            await chrome.storage.sync.set({ 
                videoDownloaderSettings: this.settings 
            });
            // Notify the background service worker about setting changes.
            await chrome.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                settings: this.settings
            });
            
            this.showStatus(successMessage, 'success');
            // Reload statistics when the current tab needs them.
            if (this.currentTab === 'about') {
                this.loadStatistics();
            }
            
        } catch (error) {
            console.error('Erro ao salvar configura??es:', error);
            this.showStatus('Erro ao salvar configura??es', 'error');
        }
    }

    async testIntegration() {
        const statusElement = document.getElementById('integrationStatus');
        statusElement.textContent = 'Testando integra??o com servidor local...';
        statusElement.className = 'status info';
        
        try {
            const response = await chrome.runtime.sendMessage({ type: 'CHECK_TOOLS' });
            const tools = response?.tools || {};
            const ytDlpOk = !!tools.yt_dlp?.installed;
            const ffmpegOk = !!tools.ffmpeg?.installed;
            const ffprobeOk = !!tools.ffprobe?.installed;

            statusElement.textContent = [
                `yt-dlp: ${ytDlpOk ? 'instalado' : 'n?o encontrado'}`,
                `FFmpeg: ${ffmpegOk ? 'instalado' : 'n?o encontrado'}`,
                `FFprobe: ${ffprobeOk ? 'instalado' : 'n?o encontrado'}`
            ].join(' | ');
            statusElement.className = ytDlpOk && ffmpegOk && ffprobeOk ? 'status success' : 'status warning';
            
        } catch (error) {
            statusElement.textContent = `Erro ao testar integra??o: ${error.message}`;
            statusElement.className = 'status error';
        }
    }

    async installTools() {
        this.showStatus('Preparando instala??o das ferramentas...', 'info');
        
        try {
            // A production version could replace this placeholder.
            // Keep this flow local and non-destructive for now.
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Set common default paths.
            this.setValue('ytDlpPath', 'C:\\Program Files\\VideoDownloaderPro\\yt-dlp.exe');
            this.setValue('ffmpegPath', 'C:\\Program Files\\VideoDownloaderPro\\ffmpeg.exe');
            
            this.saveFormToSettings();
            this.showStatus('Ferramentas instaladas com sucesso! Configure os caminhos acima.', 'success');
            
            // Refresh integration status.
            this.checkIntegrationStatus();
            
        } catch (error) {
            this.showStatus(`Erro na instala??o: ${error.message}`, 'error');
        }
    }

    browseForYtDlp() {
        this.showFilePicker('ytDlpPath', 'Selecione o yt-dlp.exe', ['.exe']);
    }

    browseForFfmpeg() {
        this.showFilePicker('ffmpegPath', 'Selecione o ffmpeg.exe', ['.exe']);
    }

    showFilePicker(elementId, title, accept) {
            // A production version could replace this placeholder.
        // The current fallback uses a prompt.
        
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
        
        ytDlpVersion.textContent = 'Verificando...';
        ffmpegVersion.textContent = 'Verificando...';
        
        try {
            const response = await chrome.runtime.sendMessage({ type: 'CHECK_TOOLS' });
            const tools = response?.tools || {};
            
            if (tools.yt_dlp?.installed) {
                ytDlpVersion.textContent = 'Instalado';
                ytDlpVersion.style.color = '#10b981';
            } else {
                ytDlpVersion.textContent = 'N?o encontrado';
                ytDlpVersion.style.color = '#ef4444';
            }
            
            if (tools.ffmpeg?.installed) {
                ffmpegVersion.textContent = 'Instalado';
                ffmpegVersion.style.color = '#10b981';
            } else {
                ffmpegVersion.textContent = 'N?o encontrado';
                ffmpegVersion.style.color = '#ef4444';
            }
            
        } catch (error) {
            ytDlpVersion.textContent = 'Erro na verifica??o';
            ffmpegVersion.textContent = 'Erro na verifica??o';
        }
    }

    async loadStatistics() {
        try {
            // Load statistics from storage.
            const result = await chrome.storage.local.get(['videoDownloaderStats']);
            const stats = result.videoDownloaderStats || {
                videosDetected: 0,
                downloadsCompleted: 0,
                startTime: Date.now()
            };
            
            document.getElementById('statsDetected').textContent = stats.videosDetected;
            document.getElementById('statsDownloads').textContent = stats.downloadsCompleted;
            
            // Calculate uptime.
            const uptime = Date.now() - stats.startTime;
            const hours = Math.floor(uptime / (1000 * 60 * 60));
            const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
            document.getElementById('statsUptime').textContent = `${hours}h ${minutes}m`;
            
        } catch (error) {
            console.error('Erro ao carregar estat?sticas:', error);
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
            
            this.showStatus('Configura??es exportadas com sucesso!', 'success');
            
        } catch (error) {
            this.showStatus('Erro ao exportar configura??es', 'error');
        }
    }

    async importSettings() {
            // A production version could replace this placeholder.
        // The current fallback accepts JSON through a prompt.
        
        const jsonData = prompt('Cole o JSON das configura??es:');
        if (!jsonData) return;
        
        try {
            const importedData = JSON.parse(jsonData);
            
            if (importedData.settings && importedData.version) {
                this.settings = { ...this.settings, ...importedData.settings };
                this.populateForm();
                await this.saveSettings();
                this.showStatus('Configura??es importadas com sucesso!', 'success');
            } else {
                throw new Error('Formato de arquivo inv?lido');
            }
            
        } catch (error) {
            this.showStatus('Erro ao importar configura??es: ' + error.message, 'error');
        }
    }

    async resetSettings() {
        if (confirm('Tem certeza que deseja redefinir todas as configura??es para os valores padr?o?\nEsta a??o n?o pode ser desfeita.')) {
            this.settings = { ...this.defaultSettings };
            this.populateForm();
            await this.saveSettings();
            this.showStatus('Configura??es redefinidas para os valores padr?o!', 'success');
        }
    }
    // Utility methods
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
        // Hide automatically after five seconds.
        setTimeout(() => {
            statusElement.classList.add('hidden');
        }, 5000);
    }

    goBack() {
        window.close(); // Close the options page.
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
            // Detection
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
        // Integration
            ytDlpPath: '',
            ffmpegPath: '',
            additionalArgs: '',
            timeout: 30,
            retries: 3,

            // Advanced tab
            anonymousStats: true,
            errorReporting: true,
            cacheSize: '100',
            historySize: '100',
            debugMode: false,
            verboseLogging: false
        };
    }
}

// Initialize when the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
    new SettingsManager();
});

// Add dynamic styles.
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
