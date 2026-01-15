// server.js - FINAL CORRIGIDO
const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const util = require('util');
const execPromise = util.promisify(require('child_process').exec);

const app = express();

// === MAPA DE DOWNLOADS ATIVOS ===
const activeDownloads = new Map();

// === CONFIGURAÇÕES ===
const PORT = 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '10mb' }));

// === ROTA DE TESTE ===
app.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Servidor vivo!', timestamp: new Date().toISOString() });
});

// === ROTA: LISTAR FORMATOS ===
app.post('/list-formats', async (req, res) => {
  const { url, referer = 'https://example.com' } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL obrigatória' });

  const origin = new URL(referer).origin;
  
  const cmd = [
    'yt-dlp',
    '--dump-single-json',
    '--no-warnings',
    '--quiet',
    '--flat-playlist',
    '--skip-download',
    `--add-header "Referer:${referer}"`,
    `--add-header "Origin:${origin}"`,
    '--add-header "User-Agent:Mozilla/5.0"',
    `"${url}"`
  ].join(' ');

  try {
    const { stdout } = await execPromise(cmd, { timeout: 90000, maxBuffer: 1024 * 1024 * 10 });
    
    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) throw new Error('Nenhum JSON válido encontrado');
    
    let jsonStr = stdout.substring(jsonStart);
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1) jsonStr = jsonStr.substring(0, lastBrace + 1);

    const info = JSON.parse(jsonStr);

    const formats = (info.formats || []).map(f => {
      const height = f.height ?? null;
      const width = f.width ?? null;
      let name = f.format_note || (height ? `${height}p` : 'Direto / MP4');
      let resolution = '—';

      if (height && width) resolution = `${width}x${height}`;
      else if (height) resolution = `${height}p`;
      else if (f.ext === 'mp4' && f.protocol === 'https' && f.vcodec !== 'none') {
        name = 'MP4 Direto (Qualidade Original)';
        resolution = 'Automática';
      } else {
        name = 'Áudio only / Especial';
        resolution = 'Áudio';
      }

      return {
        id: f.format_id || 'unknown',
        name: name,
        resolution: resolution,
        size: f.filesize ? `${(f.filesize / 1024 / 1024).toFixed(1)} MB` : '—'
      };
    });

    if (formats.length === 0 && info.url) {
      formats.push({ id: 'direct', name: 'Vídeo Direto (fallback)', resolution: 'Automática', size: '—' });
    }

    res.json({ success: true, formats });
  } catch (error) {
    console.error('[list-formats ERROR]:', error.message);
    res.json({ success: false, error: 'Falha ao listar formatos', details: error.message });
  }
});

// === ROTA: DOWNLOAD ===
app.post('/download', async (req, res) => {
  const { url, quality = 'best', title, referer = 'https://example.com' } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL obrigatória' });

  const downloadId = uuidv4();
  
  // Limpeza do nome
  let safeTitle = (title || 'video')
  .replace(/[<>:"/\\|?*]/g, '')   // Remove caracteres proibidos no Windows/Linux
  .replace(/[\x00-\x1F]/g, '')    // Remove caracteres de controle invisíveis
  .trim()                         // Remove espaços sobrando no início e fim
  .substring(0, 100);             // Limita o tamanho para não dar err
  
  const videoTemp = path.join(DOWNLOAD_DIR, `${safeTitle}_video.%(ext)s`);
  const audioTemp = path.join(DOWNLOAD_DIR, `${safeTitle}_audio.%(ext)s`);
  const finalPath = path.join(DOWNLOAD_DIR, `${safeTitle}.mp4`);
  const origin = new URL(referer).origin;

  const videoFormat = quality.includes('+') ? quality.split('+')[0] : 'bestvideo/best';
  const audioFormat = quality.includes('+') ? quality.split('+')[1] : 'bestaudio';

  console.log(`\nIniciando download [ID: ${downloadId}] - ${safeTitle}`);
  
  // Resposta imediata
  res.json({ success: true, downloadId });

  let hasAudio = false;

  // === FUNÇÕES AUXILIARES (DEFINIDAS UMA VEZ SÓ) ===
  const sendProgress = (percent, status) => {
    wss.clients.forEach(client => {
      if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'progress', percent, size: status }));
      }
    });
  };

  const sendError = (msg) => {
    console.log(`Erro [${downloadId}]: ${msg}`);
    wss.clients.forEach(client => {
      if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', error: msg }));
        client.close();
      }
    });
    activeDownloads.delete(downloadId);
  };

  const finalizeDownload = () => {
    try {
      const stats = fs.statSync(finalPath);
      console.log(`Sucesso [${downloadId}]: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      wss.clients.forEach(client => {
        if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'success',
            fileUrl: `http://localhost:${PORT}/files/${encodeURIComponent(path.basename(finalPath))}`,
            filename: path.basename(finalPath)
          }));
          // Não fecha o WS imediatamente para dar tempo do front receber
          setTimeout(() => client.close(), 1000);
        }
      });
      activeDownloads.delete(downloadId);
    } catch (e) {
      sendError('Erro ao finalizar arquivo: ' + e.message);
    }
  };

// === INÍCIO DO PROCESSO (MODIFICADO PARA DEBUG) ===
  const videoCmd = [
    'yt-dlp',
    `--format "${videoFormat}"`,
    `--output "${videoTemp}"`,
    '--newline',
    '--no-part', // Importante para streams que podem falhar no meio
    '--progress',
    // Adiciona headers para enganar o site
    `--add-header "Referer:${referer}"`,
    `--add-header "Origin:${origin}"`,
    '--add-header "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"',
    `"${url}"`
  ].join(' ');

  console.log('Executando comando:', videoCmd); // Mostra o comando exato para você testar se quiser

  const videoChild = exec(videoCmd, { maxBuffer: 1024 * 1024 * 50, timeout: 0 });
  
  // Variável para capturar o erro
  let errorLog = '';

  activeDownloads.set(downloadId, { video: videoChild, audio: null });

  // Captura o progresso (STDOUT)
  videoChild.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    lines.forEach(line => {
      const match = line.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+~?([\d.]+)(\w+)/i);
      if (match) {
        const percent = Math.round(parseFloat(match[1]) * (hasAudio ? 0.7 : 1.0));
        sendProgress(percent, `Vídeo: ${match[2] + match[3]}`);
      }
    });
  });

  // Captura o ERRO (STDERR) - AQUI ESTÁ A CORREÇÃO
  videoChild.stderr.on('data', (data) => {
    errorLog += data;
    // Opcional: Imprime erros em tempo real no console
    console.error(`[yt-dlp LOG]: ${data}`); 
  });

  videoChild.on('close', async (code) => {
    // Se der erro, mostra o log completo do yt-dlp
    if (code !== 0) {
        console.error('\n--- DETALHES DO ERRO ---');
        console.error(errorLog);
        console.error('------------------------\n');
        return sendError(`Erro no yt-dlp: ${errorLog.slice(-100)}`); // Envia os últimos 100 caracteres do erro para o popup
    }

    // ... (o resto do código continua igual: procura o arquivo, checa áudio, etc)
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const videoFile = files.find(f => f.startsWith(`${safeTitle}_video`));
    
    if (!videoFile) return sendError('Arquivo de vídeo não encontrado mesmo após sucesso aparente.');

    // ... Restante da lógica de áudio e FFmpeg ...

    // Checa se tem áudio
    try {
      const { stdout } = await execPromise(`ffprobe -v quiet -select_streams a -show_entries stream=codec_name -of csv=p=0 "${path.join(DOWNLOAD_DIR, videoFile)}"`);
      hasAudio = stdout.trim().length > 0;
    } catch (e) { hasAudio = false; }

    if (hasAudio) {
      try { 
        fs.renameSync(path.join(DOWNLOAD_DIR, videoFile), finalPath); 
        finalizeDownload();
      } catch (e) { sendError('Erro ao renomear arquivo final'); }
    } else {
      // Baixar áudio separado
      console.log('Baixando áudio separado...');
      const audioCmd = [
        'yt-dlp',
        `--format "${audioFormat}"`,
        `--output "${audioTemp}"`,
        '--newline',
        `--add-header "Referer:${referer}"`,
        `"${url}"`
      ].join(' ');

      const audioChild = exec(audioCmd);
      if (activeDownloads.get(downloadId)) {
        activeDownloads.get(downloadId).audio = audioChild;
      }

      audioChild.on('close', (aCode) => {
        const audioFiles = fs.readdirSync(DOWNLOAD_DIR);
        const audioFile = audioFiles.find(f => f.startsWith(`${safeTitle}_audio`));

        if (aCode !== 0 || !audioFile) {
            // Falhou áudio, entrega vídeo mudo
            console.log('Falha no áudio, entregando sem som');
            try { fs.renameSync(path.join(DOWNLOAD_DIR, videoFile), finalPath); } catch {}
            finalizeDownload();
            return;
        }

        // Mesclar
        const ffmpegCmd = `ffmpeg -i "${path.join(DOWNLOAD_DIR, videoFile)}" -i "${path.join(DOWNLOAD_DIR, audioFile)}" -c:v copy -c:a aac -b:a 192k -y "${finalPath}"`;
        exec(ffmpegCmd, (err) => {
            // Limpa temporários
            try { fs.unlinkSync(path.join(DOWNLOAD_DIR, videoFile)); } catch {}
            try { fs.unlinkSync(path.join(DOWNLOAD_DIR, audioFile)); } catch {}
            
            if (err) return sendError('Erro ao mesclar com FFmpeg');
            finalizeDownload();
        });
      });
    }
  });
});

// === WEBSOCKET ===
const wss = new WebSocket.Server({ noServer: true });
wss.on('connection', (ws, req) => {
  const downloadId = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('id');
  if (downloadId) {
    ws.downloadId = downloadId;
    console.log(`[WS] Cliente conectado: ${downloadId}`);
  }
});

// === SERVIR ARQUIVOS E FERRAMENTAS ===
app.use('/files', express.static(DOWNLOAD_DIR));

app.get('/check-tools', async (req, res) => {
  // Simplificado para checar se roda
  const check = async (cmd) => {
    try { await execPromise(cmd); return true; } catch { return false; }
  };
  res.json({
    success: true,
    tools: {
      yt_dlp: { installed: await check('yt-dlp --version') },
      ffmpeg: { installed: await check('ffmpeg -version') }
    }
  });
});

// === INICIAR ===
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});