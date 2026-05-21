const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();

const PORT = 3000;
const HOST = '127.0.0.1';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const THUMB_DIR = path.join(__dirname, 'thumbs');
const THUMB_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const THUMB_CACHE_CLEAN_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_HTTP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const activeDownloads = new Map();

ensureDirs();
cleanupThumbCache({ maxAgeMs: THUMB_CACHE_MAX_AGE_MS });
setInterval(() => {
  cleanupThumbCache({ maxAgeMs: THUMB_CACHE_MAX_AGE_MS });
}, THUMB_CACHE_CLEAN_INTERVAL_MS).unref();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^chrome-extension:\/\//i.test(origin)) return true;

  try {
    const parsed = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    callback(isAllowedOrigin(origin) ? null : new Error('Origem nao permitida'), true);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' }));

function ensureDirs() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  if (!fs.existsSync(THUMB_DIR)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
  }
}

function countFilesRecursively(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;

  let count = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursively(fullPath);
    } else {
      count += 1;
    }
  }
  return count;
}

function cleanupThumbCache({ maxAgeMs = 0, removeAll = false } = {}) {
  ensureDirs();

  if (removeAll) {
    const deleted = countFilesRecursively(THUMB_DIR);
    fs.rmSync(THUMB_DIR, { recursive: true, force: true });
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    return { deleted };
  }

  const now = Date.now();
  let deleted = 0;

  const cleanupDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) return;

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        cleanupDir(fullPath);
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch { }
        continue;
      }

      try {
        const stats = fs.statSync(fullPath);
        if (!maxAgeMs || now - stats.mtimeMs >= maxAgeMs) {
          fs.unlinkSync(fullPath);
          deleted += 1;
        }
      } catch { }
    }
  };

  cleanupDir(THUMB_DIR);
  return { deleted };
}

function sanitizeTitle(input) {
  const fallback = 'video';
  const value = String(input || fallback)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);

  return value || fallback;
}

function sanitizeFileBase(input) {
  return String(input || 'thumb')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80) || 'thumb';
}

function safeOriginFromReferer(referer) {
  try {
    return new URL(referer).origin;
  } catch {
    return 'https://example.com';
  }
}

function sendWs(downloadId, payload) {
  wss.clients.forEach(client => {
    if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

function sendProgress(downloadId, percent, text, extra = {}) {
  sendWs(downloadId, {
    type: 'progress',
    percent,
    text,
    size: text,
    ...extra
  });
}

function sendError(downloadId, msg) {
  console.log(`Erro [${downloadId}]: ${msg}`);
  sendWs(downloadId, { type: 'error', error: msg });

  wss.clients.forEach(client => {
    if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
      setTimeout(() => client.close(), 500);
    }
  });

  cleanupActiveDownload(downloadId, { kill: true, removeFiles: false });
}

function finalizeDownload(downloadId, finalPath) {
  try {
    const stats = fs.statSync(finalPath);
    if (!stats.size) {
      deleteIfExists(finalPath);
      return sendError(downloadId, 'Arquivo final foi criado vazio. O servidor de origem pode ter bloqueado a playlist ou os segmentos.');
    }

    console.log(`Sucesso [${downloadId}]: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    sendWs(downloadId, {
      type: 'success',
      fileUrl: `http://localhost:${PORT}/files/${encodeURIComponent(path.basename(finalPath))}`,
      filename: path.basename(finalPath),
      sizeBytes: stats.size
    });

    wss.clients.forEach(client => {
      if (client.downloadId === downloadId && client.readyState === WebSocket.OPEN) {
        setTimeout(() => client.close(), 1000);
      }
    });

    cleanupActiveDownload(downloadId, { kill: false, removeFiles: false });
  } catch (e) {
    sendError(downloadId, 'Erro ao finalizar arquivo: ' + e.message);
  }
}

function parseFfmpegTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const match = timeStr.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const [, hh, mm, ss] = match;
  return (Number(hh) * 3600) + (Number(mm) * 60) + Number(ss);
}

function buildFfmpegHttpInputArgs(headerArgs = []) {
  return [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '10',
    '-rw_timeout', '15000000',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-allowed_extensions', 'ALL',
    '-user_agent', DEFAULT_HTTP_USER_AGENT,
    ...headerArgs
  ];
}

function formatFfmpegError(stderrLog) {
  const lines = String(stderrLog || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return 'FFmpeg finalizou sem informar detalhes.';
  }

  const important = lines.filter(line =>
    /error|failed|invalid|forbidden|unauthorized|not found|http|403|404|timed out|opening|unable/i.test(line)
  );

  const selected = (important.length ? important : lines).slice(-6);
  return selected.join(' | ').slice(0, 900);
}

function numberFromUnknown(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRotation(value) {
  const numeric = numberFromUnknown(value);
  if (!Number.isFinite(numeric)) return 0;

  const normalized = Math.round(numeric) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function rotationFromDisplayMatrix(value) {
  const match = String(value || '').match(/rotation\s+of\s+(-?\d+(?:\.\d+)?)\s+degrees/i);
  return match ? normalizeRotation(match[1]) : 0;
}

function readVideoRotation(stream = {}) {
  const tagRotation = normalizeRotation(stream.tags?.rotate);
  if (tagRotation) return tagRotation;

  for (const sideData of stream.side_data_list || []) {
    const directRotation = normalizeRotation(sideData.rotation);
    if (directRotation) return directRotation;

    const matrixRotation = rotationFromDisplayMatrix(sideData.displaymatrix);
    if (matrixRotation) return matrixRotation;
  }

  return 0;
}

function buildOrientationInfo(probeInfo = {}) {
  const video = (probeInfo.streams || []).find(stream => stream.codec_type === 'video') || null;
  if (!video) {
    return {
      hasVideo: false,
      width: null,
      height: null,
      rotation: 0,
      displayWidth: null,
      displayHeight: null,
      isSidewaysVertical: false
    };
  }

  const width = Number.isFinite(video.width) ? video.width : null;
  const height = Number.isFinite(video.height) ? video.height : null;
  const rotation = readVideoRotation(video);
  const rotatedQuarterTurn = rotation === 90 || rotation === 270;
  const displayWidth = rotatedQuarterTurn ? height : width;
  const displayHeight = rotatedQuarterTurn ? width : height;

  return {
    hasVideo: true,
    width,
    height,
    rotation,
    displayWidth: displayWidth || null,
    displayHeight: displayHeight || null,
    isSidewaysVertical: !!(rotatedQuarterTurn && width && height && width > height),
    note: rotatedQuarterTurn
      ? 'Video stream has quarter-turn rotation metadata.'
      : ''
  };
}

async function probeOrientation(url, headerArgs = []) {
  const args = [
    '-v', 'error',
    ...buildFfmpegHttpInputArgs(headerArgs),
    '-show_streams',
    '-show_format',
    '-print_format', 'json',
    url
  ];

  const { stdout } = await runCommand('ffprobe', args, {
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 4
  });

  return buildOrientationInfo(JSON.parse(stdout || '{}'));
}

async function getDurationSeconds(inputPathOrUrl, headerArgs = []) {
  try {
    const args = [
      '-v', 'error',
      ...buildFfmpegHttpInputArgs(headerArgs),
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1'
    ];

    args.push(inputPathOrUrl);

    const ffprobe = spawn('ffprobe', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    return await new Promise((resolve) => {
      ffprobe.stdout.on('data', chunk => { stdout += chunk.toString(); });
      ffprobe.stderr.on('data', chunk => { stderr += chunk.toString(); });

      ffprobe.on('close', () => {
        const duration = parseFloat((stdout || '').trim());
        if (Number.isFinite(duration) && duration > 0) {
          resolve(duration);
        } else {
          if (stderr.trim()) {
            console.log('[ffprobe duration warn]', stderr.trim());
          }
          resolve(null);
        }
      });

      ffprobe.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

function buildHeaderArgs(referer = 'https://example.com', extraHeaders = {}) {
  const normalizedExtraHeaders = normalizeIncomingHttpHeaders(extraHeaders);
  const origin = safeOriginFromReferer(referer);
  const merged = {
    Referer: referer,
    Origin: origin,
    'User-Agent': DEFAULT_HTTP_USER_AGENT,
    ...normalizedExtraHeaders
  };

  const headerBlock = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');

  return headerBlock ? ['-headers', headerBlock] : [];
}

function normalizeIncomingHttpHeaders(headers = {}) {
  const canonicalNames = {
    accept: 'Accept',
    'accept-language': 'Accept-Language',
    authorization: 'Authorization',
    cookie: 'Cookie',
    origin: 'Origin',
    referer: 'Referer',
    'user-agent': 'User-Agent'
  };
  const normalized = {};

  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name || '').toLowerCase();
    const canonicalName = canonicalNames[key];
    if (!canonicalName || value === undefined || value === null || value === '') continue;
    normalized[canonicalName] = value;
  }

  return normalized;
}

function findBestDownloadedFile(prefixBase) {
  const files = fs.readdirSync(DOWNLOAD_DIR);
  const matches = files
    .filter(f => f.startsWith(prefixBase))
    .map(name => {
      const full = path.join(DOWNLOAD_DIR, name);
      const stat = fs.statSync(full);
      return { name, full, size: stat.size };
    })
    .sort((a, b) => b.size - a.size);

  return matches[0] || null;
}

function deleteIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch { }
}

function registerDownload(downloadId, payload = {}) {
  activeDownloads.set(downloadId, {
    process: null,
    extraProcess: null,
    ffmpegMerge: null,
    tempFiles: [],
    finalPath: null,
    cancelled: false,
    ...payload
  });
}

function updateDownload(downloadId, patch = {}) {
  const active = activeDownloads.get(downloadId);
  if (!active) return;
  Object.assign(active, patch);
}

function cleanupActiveDownload(downloadId, { kill = false, removeFiles = false } = {}) {
  const active = activeDownloads.get(downloadId);
  if (!active) return;

  if (kill) {
    for (const proc of [active.process, active.extraProcess, active.ffmpegMerge]) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch { }
      }
    }
  }

  if (removeFiles) {
    for (const filePath of active.tempFiles || []) {
      deleteIfExists(filePath);
    }
    if (active.finalPath) {
      deleteIfExists(active.finalPath);
    }
  }

  activeDownloads.delete(downloadId);
}

function wasCancelled(downloadId) {
  return !!activeDownloads.get(downloadId)?.cancelled;
}

function runCommand(command, args, { timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      try { child.kill('SIGKILL'); } catch { }
      reject(new Error(`${command} excedeu o tempo limite`));
    }, timeout);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { }
        reject(new Error(`${command} excedeu o limite de saida`));
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(-maxBuffer);
      }
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} finalizou com codigo ${code}`));
      }
    });
  });
}

app.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Servidor vivo!', timestamp: new Date().toISOString() });
});

app.get('/check-tools', async (req, res) => {
  const check = async (cmd, args) => {
    try {
      await runCommand(cmd, args, { timeout: 10000, maxBuffer: 1024 * 128 });
      return true;
    } catch {
      return false;
    }
  };

  res.json({
    success: true,
    tools: {
      yt_dlp: { installed: await check('yt-dlp', ['--version']) },
      ffmpeg: { installed: await check('ffmpeg', ['-version']) },
      ffprobe: { installed: await check('ffprobe', ['-version']) }
    }
  });
});

app.use('/files', express.static(DOWNLOAD_DIR));
app.use('/thumbs', express.static(THUMB_DIR));

app.post('/clear-thumbs', (req, res) => {
  try {
    const result = cleanupThumbCache({ removeAll: true });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Falha ao limpar cache de thumbnails',
      details: error.message
    });
  }
});

app.post('/probe-orientation', async (req, res) => {
  const {
    url,
    referer = 'https://example.com',
    headers = {}
  } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL obrigatoria' });
  }

  try {
    const headerArgs = buildHeaderArgs(referer, headers);
    const orientation = await probeOrientation(url, headerArgs);
    res.json({ success: true, orientation });
  } catch (error) {
    res.json({
      success: false,
      error: 'Falha ao analisar orientacao do video',
      details: error.message
    });
  }
});

app.post('/list-formats', async (req, res) => {
  const { url, referer = 'https://example.com' } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL obrigatória' });

  const origin = safeOriginFromReferer(referer);

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--quiet',
    '--flat-playlist',
    '--skip-download',
    '--add-header', `Referer:${referer}`,
    '--add-header', `Origin:${origin}`,
    '--add-header', 'User-Agent:Mozilla/5.0',
    url
  ];

  try {
    const { stdout } = await runCommand('yt-dlp', args, {
      timeout: 90000,
      maxBuffer: 1024 * 1024 * 10
    });

    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) throw new Error('Nenhum JSON válido encontrado');

    let jsonStr = stdout.substring(jsonStart);
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1) jsonStr = jsonStr.substring(0, lastBrace + 1);

    const info = JSON.parse(jsonStr);

    const formats = (info.formats || [])
      .filter(f => f.format_id)
      .map(f => {
        const width = f.width ?? null;
        const height = f.height ?? null;
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        const isProgressive = hasVideo && hasAudio;
        const isVideoOnly = hasVideo && !hasAudio;
        const isAudioOnly = !hasVideo && hasAudio;

        let resolution = '—';
        if (width && height) {
          resolution = `${width}x${height}`;
        } else if (height) {
          resolution = `${height}p`;
        } else if (isAudioOnly) {
          resolution = 'Áudio';
        } else {
          resolution = 'Automática';
        }

        let name = f.format_note || '';
        if (!name) {
          if (isProgressive) name = 'MP4 com áudio';
          else if (isVideoOnly) name = 'Vídeo sem áudio';
          else if (isAudioOnly) name = 'Áudio';
          else name = 'Formato especial';
        }

        const sizeBytes = f.filesize ?? f.filesize_approx ?? null;
        const size = sizeBytes ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : '—';

        return {
          id: isVideoOnly ? `${f.format_id}+bestaudio/best` : String(f.format_id),
          originalId: String(f.format_id),
          name,
          resolution,
          size,
          ext: f.ext || 'mp4',
          hasVideo,
          hasAudio,
          isVideoOnly,
          isAudioOnly,
          note: isVideoOnly ? 'Vai baixar vídeo e áudio separadamente e mesclar.' : ''
        };
      })
      .filter(f => f.hasVideo || f.isAudioOnly);

    if (formats.length === 0 && info.url) {
      formats.push({
        id: 'best',
        originalId: 'best',
        name: 'Vídeo Direto (fallback)',
        resolution: 'Automática',
        size: '—',
        ext: 'mp4',
        hasVideo: true,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: false,
        note: ''
      });
    }

    res.json({
      success: true,
      title: info.title || '',
      duration: info.duration ?? null,
      thumbnail: info.thumbnail || '',
      formats
    });
  } catch (error) {
    console.error('[list-formats ERROR]:', error.message);
    res.json({ success: false, error: 'Falha ao listar formatos', details: error.message });
  }
});


app.post('/download', async (req, res) => {
  const { url, quality = 'best', title, referer = 'https://example.com' } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL obrigatória' });

  ensureDirs();
  const downloadId = uuidv4();
  const safeTitle = sanitizeTitle(title || 'video');
  const origin = safeOriginFromReferer(referer);
  
  const finalPath = path.join(DOWNLOAD_DIR, `${safeTitle}.mp4`);
  const templatePath = path.join(DOWNLOAD_DIR, `${safeTitle}.%(ext)s`);
  // Default to the best available video and audio combination.
  let formatArg = quality;
  if (!quality || quality === 'best' || quality === 'default') {
    formatArg = 'bestvideo+bestaudio/best';
  } else if (!quality.includes('+')) {
    // Pair specific video-only format IDs with the best available audio track.
    formatArg = `${quality}+bestaudio/best`;
  }

  console.log(`\nIniciando download [ID: ${downloadId}] - ${safeTitle} | Formato: ${formatArg}`);

  registerDownload(downloadId, { mode: 'ytdlp', finalPath });
  res.json({ success: true, downloadId });

  const ytdlpArgs = [
    '--no-update',
    '--format', formatArg,
    '--merge-output-format', 'mp4',
    // Convert merged audio to AAC for broad MP4 compatibility.
    '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac -b:a 192k',
    
    '--output', templatePath,
    '--newline', 
    '--progress',
    '--add-header', `Referer:${referer}`,
    '--add-header', `Origin:${origin}`,
    url
  ];

  // spawn streams progress lines continuously for the popup progress bar.
  const ytProcess = spawn('yt-dlp', ytdlpArgs, { windowsHide: true });
  updateDownload(downloadId, { process: ytProcess });

  let errorLog = '';

  ytProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/[\r\n]+/);
    
    lines.forEach(line => {
      // Remove ANSI control characters before parsing yt-dlp output.
      const cleanLine = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      const percentMatch = cleanLine.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
      
      if (percentMatch && !wasCancelled(downloadId)) {
        const percent = Math.round(parseFloat(percentMatch[1]));
        const sizeMatch = cleanLine.match(/of\s+~?\s*([^\s]+(?:\s*[KMGT]i?B)?)/i);
        const speedMatch = cleanLine.match(/at\s+([^\s]+(?:\s*\/s)?)/i);
        const etaMatch = cleanLine.match(/ETA\s+([^\s]+)/i);

        const bits = ['Processando'];
        if (sizeMatch) bits.push(sizeMatch[1]);
        if (speedMatch) bits.push(speedMatch[1]);
        if (etaMatch) bits.push(`ETA ${etaMatch[1]}`);
        
        sendProgress(downloadId, percent, bits.join(' • '));
      } else if (cleanLine.includes('[Merger]') || cleanLine.includes('[ffmpeg]')) {
         sendProgress(downloadId, 99, 'Mesclando áudio e vídeo...');
      }
    });
  });

  ytProcess.stderr.on('data', (data) => errorLog += data.toString());

  ytProcess.on('close', (code) => {
    if (wasCancelled(downloadId)) return;
    if (code !== 0) return sendError(downloadId, `Erro no yt-dlp: ${errorLog.slice(-400)}`);

    if (fs.existsSync(finalPath)) {
      finalizeDownload(downloadId, finalPath);
    } else {
      // Fallback when yt-dlp saves the merged file with a different extension.
      const found = findBestDownloadedFile(safeTitle);
      if (found) {
        try {
          fs.renameSync(found.full, finalPath);
          finalizeDownload(downloadId, finalPath);
        } catch (e) {
          sendError(downloadId, 'Erro ao mover arquivo final: ' + e.message);
        }
      } else {
        sendError(downloadId, 'Arquivo final não encontrado.');
      }
    }
  });
});


app.post('/download-stream', async (req, res) => {
  const {
    url,
    title,
    referer = 'https://example.com',
    type = 'hls',
    headers = {}
  } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL obrigatória' });
  }

  ensureDirs();

  const downloadId = uuidv4();
  const safeTitle = sanitizeTitle(title || 'stream');
  const finalPath = path.join(DOWNLOAD_DIR, `${safeTitle}.mp4`);

  registerDownload(downloadId, { mode: type || 'stream', finalPath, tempFiles: [finalPath] });
  res.json({ success: true, downloadId });

  const headerArgs = buildHeaderArgs(referer, headers);
  const duration = await getDurationSeconds(url, headerArgs);

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-y',
    ...buildFfmpegHttpInputArgs(headerArgs),
    '-i', url,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-bsf:a', 'aac_adtstoasc',
    finalPath
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    windowsHide: true
  });

  updateDownload(downloadId, { process: ffmpeg });

  let stderrLog = '';
  let lastSent = 0;

  ffmpeg.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrLog += text;

    const timeMatch = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
    if (!timeMatch || wasCancelled(downloadId)) return;

    const currentSec = parseFfmpegTimeToSeconds(timeMatch[1]);
    let percent = 0;

    if (duration && duration > 0) {
      percent = Math.max(1, Math.min(99, Math.round((currentSec / duration) * 100)));
    } else {
      // Fallback for HLS streams where duration probing is unavailable.
      percent = Math.min(99, Math.max(1, Math.floor(currentSec / 2)));
    }
    if (percent === 0 || percent >= lastSent + 1) {
      lastSent = percent;
      sendProgress(downloadId, percent, `Baixando stream (${timeMatch[1]})`);
    }
  });

  ffmpeg.on('error', (err) => {
    if (wasCancelled(downloadId)) return;
    sendError(downloadId, `Falha ao iniciar FFmpeg: ${err.message}`);
  });

  ffmpeg.on('close', (code) => {
    if (wasCancelled(downloadId)) return;

    if (code !== 0) {
      return sendError(downloadId, `FFmpeg falhou: ${formatFfmpegError(stderrLog)}`);
    }

    if (!fs.existsSync(finalPath)) {
      return sendError(downloadId, 'FFmpeg finalizou, mas o arquivo não foi encontrado.');
    }

    sendProgress(downloadId, 100, 'Concluído');
    finalizeDownload(downloadId, finalPath);
  });
});

app.post('/thumbnail', async (req, res) => {
  const {
    url,
    title,
    referer = 'https://example.com',
    headers = {}
  } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL obrigatória' });
  }

  ensureDirs();

  const thumbId = uuidv4();
  const baseName = sanitizeFileBase(title || 'thumb') + '_' + thumbId;
  const outputPath = path.join(THUMB_DIR, `${baseName}.jpg`);

  deleteIfExists(outputPath);

  const headerArgs = buildHeaderArgs(referer, headers);

  const ffmpegArgs = [
    ...headerArgs,
    '-y',
    '-ss', '00:00:01.000',
    '-i', url,
    '-frames:v', '1',
    '-q:v', '2',
    '-vf', 'scale=480:-1',
    outputPath
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    windowsHide: true
  });

  let stderrLog = '';

  ffmpeg.stderr.on('data', (chunk) => {
    stderrLog += chunk.toString();
  });

  ffmpeg.on('error', (err) => {
    return res.status(500).json({
      success: false,
      error: 'Falha ao iniciar FFmpeg',
      details: err.message
    });
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({
        success: false,
        error: 'FFmpeg falhou ao gerar thumbnail',
        details: stderrLog.slice(-500)
      });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({
        success: false,
        error: 'Thumbnail não foi gerada'
      });
    }

    return res.json({
      success: true,
      thumbUrl: `http://localhost:${PORT}/thumbs/${encodeURIComponent(path.basename(outputPath))}`,
      filename: path.basename(outputPath)
    });
  });
});

app.post('/cancel-download', (req, res) => {
  const { downloadId } = req.body;
  if (!downloadId) {
    return res.status(400).json({ success: false, error: 'downloadId obrigatório' });
  }

  const active = activeDownloads.get(downloadId);
  if (!active) {
    return res.json({ success: false, error: 'Download não encontrado' });
  }

  try {
    active.cancelled = true;
    cleanupActiveDownload(downloadId, { kill: true, removeFiles: true });
    sendWs(downloadId, { type: 'error', error: 'Download cancelado' });
    return res.json({ success: true });
  } catch (error) {
    return res.json({ success: false, error: error.message });
  }
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  const downloadId = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('id');
  if (downloadId) {
    ws.downloadId = downloadId;
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando em http://${HOST}:${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  if (!isAllowedOrigin(request.headers.origin)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
