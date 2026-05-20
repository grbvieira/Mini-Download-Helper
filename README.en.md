# Mini Download Helper

Mini Download Helper is a Chrome Manifest V3 extension that detects media on web pages, groups quality variants, and downloads direct files, HLS, and DASH streams with help from a local Node.js server.

> Notice: this is an educational version, created only for study, research, and learning about browser extensions, media detection, and local integration with tools such as `yt-dlp` and `ffmpeg`. Use it only with content you are allowed to access and store.

The project combines a browser extension with a local server on `127.0.0.1:3000`. The extension detects media and renders the UI; the server handles heavier work with `yt-dlp`, `ffmpeg`, and `ffprobe`.

## Features

- Detects video and audio through the DOM, `fetch`, XHR, and `webRequest`.
- Supports direct files, HLS playlists (`.m3u8`), and DASH manifests (`.mpd`).
- Groups variants by page and title.
- Lets the user choose quality when the server can list formats.
- Uses the Chrome downloads API for simple direct files.
- Uses `yt-dlp` and `ffmpeg` locally for stream downloads and conversion.
- Shows real-time progress through WebSocket.
- Generates thumbnails through the local server.
- Automatically cleans the thumbnail cache.

## Structure

```text
.
|-- background.js                  # Extension service worker
|-- content.js                     # Collects media inside pages
|-- manifest.json                  # Manifest V3
|-- popup.html / popup.css / popup.js
|                                  # Main extension UI
|-- options.html / options.js      # Settings page
|-- icons/                         # Extension icons
`-- video-downloader-server/
    `-- server.js                  # Local yt-dlp/ffmpeg server
```

## Requirements

- Node.js 18 or newer.
- Google Chrome or a Chromium browser with Manifest V3 extension support.
- `yt-dlp` available in `PATH`.
- `ffmpeg` and `ffprobe` available in `PATH`.

On Windows, confirm in PowerShell:

```powershell
yt-dlp --version
ffmpeg -version
ffprobe -version
```

## Installation

Install server dependencies:

```powershell
npm install
```

Start the local server:

```powershell
node video-downloader-server\server.js
```

The server should respond at:

```text
http://127.0.0.1:3000
```

## Load the Extension in Chrome

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Click **Load unpacked**.
4. Select the project root folder.
5. Keep the local server running to download HLS/DASH streams, generate thumbnails, and list formats.

## Usage

1. Open a page with video or audio.
2. Click the extension icon.
3. Choose the detected variant or quality.
4. Click **Baixar** or **Salvar como**.

Direct downloads can use the Chrome downloads API. HLS/DASH streams depend on the local server.

## Local Server

The server listens only on `127.0.0.1` and exposes endpoints for:

- `GET /ping`: check whether the server is alive.
- `GET /check-tools`: check `yt-dlp`, `ffmpeg`, and `ffprobe`.
- `POST /list-formats`: list formats with `yt-dlp`.
- `POST /download`: download with `yt-dlp`.
- `POST /download-stream`: download streams with `ffmpeg`.
- `POST /thumbnail`: generate thumbnails.
- `POST /clear-thumbs`: clear the thumbnail cache.
- `POST /cancel-download`: cancel an active download.

## Thumbnail Cache

Thumbnails are stored in `video-downloader-server/thumbs`.

The server cleans the cache automatically:

- on startup;
- every 1 hour;
- by removing files older than 24 hours;
- when the extension sends the clear-all command.

## Development

Validate script syntax:

```powershell
node --check background.js
node --check content.js
node --check popup.js
node --check options.js
node --check video-downloader-server\server.js
```

Check dependencies:

```powershell
npm audit --omit=dev
```

## Security Notes

- This project is provided only for educational and study purposes.
- The local server is intended for use on the same machine and is bound to `127.0.0.1`.
- The project uses `<all_urls>` permission to detect media across varied pages.
- Download only content you have the right to access and store.

Portuguese documentation is available in [README.md](README.md).

## License

ISC
