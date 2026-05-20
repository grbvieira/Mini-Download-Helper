# Mini Download Helper

Mini Download Helper e uma extensao Chrome Manifest V3 para detectar midias em paginas web, agrupar variantes de qualidade e baixar arquivos diretos, HLS e DASH com apoio de um servidor local Node.js.

> Aviso: esta e uma versao educacional, criada apenas para estudo, pesquisa e aprendizado sobre extensoes de navegador, deteccao de midia e integracao local com ferramentas como `yt-dlp` e `ffmpeg`. Use somente com conteudos que voce tem direito de acessar e armazenar.

O projeto combina a extensao do navegador com um servidor local em `127.0.0.1:3000`. A extensao detecta midias e apresenta a interface; o servidor executa tarefas pesadas com `yt-dlp`, `ffmpeg` e `ffprobe`.

## Recursos

- Deteccao de videos e audios via DOM, `fetch`, XHR e `webRequest`.
- Suporte a arquivos diretos, playlists HLS (`.m3u8`) e manifestos DASH (`.mpd`).
- Agrupamento de variantes por pagina e titulo.
- Escolha de qualidade quando o servidor consegue listar formatos.
- Download direto pelo Chrome para arquivos simples.
- Download e conversao local com `yt-dlp` e `ffmpeg` para streams.
- Progresso em tempo real via WebSocket.
- Geracao de thumbnails pelo servidor local.
- Limpeza automatica do cache de thumbnails.

## Estrutura

```text
.
|-- background.js                  # Service worker da extensao
|-- content.js                     # Coleta midias dentro das paginas
|-- manifest.json                  # Manifest V3
|-- popup.html / popup.css / popup.js
|                                  # Interface principal da extensao
|-- options.html / options.js      # Tela de configuracoes
|-- icons/                         # Icones da extensao
`-- video-downloader-server/
    `-- server.js                  # Servidor local para yt-dlp/ffmpeg
```

## Requisitos

- Node.js 18 ou superior.
- Google Chrome ou navegador Chromium com suporte a extensoes Manifest V3.
- `yt-dlp` disponivel no `PATH`.
- `ffmpeg` e `ffprobe` disponiveis no `PATH`.

No Windows, confirme no PowerShell:

```powershell
yt-dlp --version
ffmpeg -version
ffprobe -version
```

## Instalacao

Instale as dependencias do servidor:

```powershell
npm install
```

Inicie o servidor local:

```powershell
node video-downloader-server\server.js
```

O servidor deve responder em:

```text
http://127.0.0.1:3000
```

## Carregar a extensao no Chrome

1. Abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em **Carregar sem compactacao**.
4. Selecione a pasta raiz deste projeto.
5. Mantenha o servidor local rodando para baixar HLS/DASH, gerar thumbnails e listar formatos.

## Uso

1. Abra uma pagina com video ou audio.
2. Clique no icone da extensao.
3. Escolha a variante/qualidade detectada.
4. Clique em **Baixar** ou **Salvar como**.

Downloads diretos podem usar a API de downloads do Chrome. Streams HLS/DASH dependem do servidor local.

## Servidor local

O servidor escuta apenas em `127.0.0.1` e expoe endpoints para:

- `GET /ping`: verificar se o servidor esta ativo.
- `GET /check-tools`: verificar `yt-dlp`, `ffmpeg` e `ffprobe`.
- `POST /list-formats`: listar formatos com `yt-dlp`.
- `POST /download`: baixar com `yt-dlp`.
- `POST /download-stream`: baixar streams com `ffmpeg`.
- `POST /thumbnail`: gerar thumbnail.
- `POST /clear-thumbs`: limpar cache de thumbnails.
- `POST /cancel-download`: cancelar download ativo.

## Cache de thumbnails

As thumbnails ficam em `video-downloader-server/thumbs`.

O cache e limpo automaticamente pelo servidor:

- ao iniciar;
- a cada 1 hora;
- removendo arquivos com mais de 24 horas;
- quando a extensao envia o comando de limpar tudo.

## Desenvolvimento

Validar sintaxe dos scripts principais:

```powershell
node --check background.js
node --check content.js
node --check popup.js
node --check options.js
node --check video-downloader-server\server.js
```

Verificar dependencias:

```powershell
npm audit --omit=dev
```

## Observacoes de seguranca

- Este projeto e fornecido apenas para fins educacionais e de estudo.
- O servidor local foi projetado para uso na propria maquina e fica preso a `127.0.0.1`.
- O projeto usa permissao `<all_urls>` para detectar midias em paginas variadas.
- Baixe apenas conteudos que voce tem direito de acessar e armazenar.

A documentacao em ingles esta disponivel em [README.en.md](README.en.md).

## Licenca

ISC
