import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_SECONDS = 600;

function runYtDlp(args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error('Tempo limite excedido.');
      error.code = 'TIMEOUT';
      finish(error);
    }, timeout);

    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill('SIGKILL');
        const error = new Error('Resposta muito grande.');
        error.code = 'OUTPUT_TOO_LARGE';
        finish(error);
      }
    });

    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });

    child.on('error', error => {
      if (error.code === 'ENOENT') {
        error.code = 'TOOL_MISSING';
        error.message = 'yt-dlp não encontrado.';
      }
      finish(error);
    });

    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error(
          stderr.trim().split('\n').slice(-3).join(' ') ||
          `yt-dlp encerrou com código ${code}.`
        );
        error.code = 'YTDLP_FAILED';
        finish(error);
      } else {
        finish(null, stdout.toString('utf8'));
      }
    });
  });
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'Não informada';
  }
  const n = Math.floor(seconds);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export async function searchYouTube(query) {
  query = String(query || '').trim();

  if (!query) throw new Error('Informe o que deseja pesquisar.');
  if (query.length > 120) {
    throw new Error('A pesquisa pode ter no máximo 120 caracteres.');
  }

  const output = await runYtDlp([
    '--ignore-config',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--dump-single-json',
    '--flat-playlist',
    '--playlist-end', '5',
    `ytsearch5:${query}`
  ]);

  let payload;
  try {
    payload = JSON.parse(output.trim());
  } catch {
    throw new Error('Não consegui interpretar os resultados.');
  }

  return (Array.isArray(payload.entries) ? payload.entries : [])
    .map(entry => {
      const id = String(entry.id || '').trim();
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;

      return {
        id,
        title: String(entry.title || 'Vídeo sem título').slice(0, 180),
        channel: String(
          entry.channel || entry.uploader || 'Canal não informado'
        ).slice(0, 100),
        duration: durationText(Number(entry.duration)),
        durationSeconds: Number(entry.duration) || null,
        url: `https://www.youtube.com/watch?v=${id}`
      };
    })
    .filter(Boolean);
}

export async function downloadCreativeCommonsVideo(video) {
  if (!video?.id || !/^[A-Za-z0-9_-]{6,20}$/.test(video.id)) {
    throw new Error('Vídeo inválido.');
  }

  const url = `https://www.youtube.com/watch?v=${video.id}`;

  const metadataText = await runYtDlp([
    '--ignore-config',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    url
  ]);

  let metadata;
  try {
    metadata = JSON.parse(metadataText.trim());
  } catch {
    throw new Error('Não consegui verificar os dados do vídeo.');
  }

  const duration = Number(metadata.duration || video.durationSeconds || 0);

  if (!duration || duration > MAX_SECONDS) {
    const error = new Error('Vídeo sem duração válida ou maior que 10 minutos.');
    error.code = 'TOO_LONG';
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-play-video-'));

  try {
    await runYtDlp([
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--js-runtimes', 'node',
      '--no-playlist',
      '--no-part',
      '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
      '-o', path.join(tempDir, 'source.%(ext)s'),
      url
    ], 300000);

    const source = fs.readdirSync(tempDir)
      .find(name => name.startsWith('source.'));

    if (!source) {
      throw new Error('O YouTube não gerou o arquivo de origem.');
    }

    const input = path.join(tempDir, source);
    const output = path.join(tempDir, 'leo-play-whatsapp.mp4');

    // Reserva espaço para áudio e contêiner dentro dos 15 MB.
    const audioKbps = 64;
    const targetBytes = 14 * 1024 * 1024;
    const videoKbps = Math.max(
      80,
      Math.min(1800, Math.floor((targetBytes * 8 / duration / 1000) - audioKbps - 20))
    );

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i', input,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', 'scale=854:854:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-b:v', `${videoKbps}k`,
        '-maxrate', `${videoKbps}k`,
        '-bufsize', `${videoKbps * 2}k`,
        '-c:a', 'aac',
        '-b:a', `${audioKbps}k`,
        '-ac', '2',
        '-ar', '44100',
        '-movflags', '+faststart',
        '-threads', '2',
        output
      ];

      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe']
      });

      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Tempo limite da conversão excedido.'));
      }, 300000);

      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-5000);
      });

      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('FFmpeg falhou: ' + stderr.slice(-1200)));
      });
    });

    const stats = fs.statSync(output);

    if (!stats.size || stats.size > MAX_BYTES) {
      const error = new Error('Vídeo convertido ultrapassou 15 MB.');
      error.code = 'VIDEO_SIZE';
      throw error;
    }

    return {
      buffer: fs.readFileSync(output),
      title: String(metadata.title || video.title || 'Vídeo'),
      channel: String(metadata.uploader || metadata.channel || video.channel || 'Canal não informado'),
      license: 'Não verificada',
      url
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}


export async function downloadYouTubeAudio(video) {
  if (!video?.id || !/^[A-Za-z0-9_-]{6,20}$/.test(video.id)) {
    throw new Error('Vídeo inválido.');
  }

  const url = `https://www.youtube.com/watch?v=${video.id}`;
  const metadataText = await runYtDlp([
    '--ignore-config',
    '--no-warnings',
    '--js-runtimes', 'node',
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    url
  ]);

  let metadata;
  try {
    metadata = JSON.parse(metadataText.trim());
  } catch {
    throw new Error('Não consegui verificar os dados do áudio.');
  }

  const duration = Number(metadata.duration || video.durationSeconds || 0);
  if (!duration || duration > MAX_SECONDS) {
    const error = new Error('Áudio sem duração válida ou maior que 10 minutos.');
    error.code = 'TOO_LONG';
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-play-audio-'));

  try {
    await runYtDlp([
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--js-runtimes', 'node',
      '--no-playlist',
      '--no-part',
      '-f', 'bestaudio/best',
      '-o', path.join(tempDir, 'source.%(ext)s'),
      url
    ], 300000);

    const source = fs.readdirSync(tempDir)
      .find(name => name.startsWith('source.'));

    if (!source) {
      throw new Error('O YouTube não gerou o arquivo de áudio.');
    }

    const input = path.join(tempDir, source);
    const output = path.join(tempDir, 'leo-play-whatsapp.mp3');

    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-y',
        '-i', input,
        '-vn',
        '-t', String(MAX_SECONDS),
        '-c:a', 'libmp3lame',
        '-b:a', '96k',
        '-ar', '44100',
        '-ac', '2',
        output
      ], {
        stdio: ['ignore', 'ignore', 'pipe']
      });

      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Tempo limite da conversão de áudio excedido.'));
      }, 300000);

      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-5000);
      });

      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('FFmpeg falhou: ' + stderr.slice(-1200)));
      });
    });

    const stats = fs.statSync(output);
    if (!stats.size || stats.size > MAX_BYTES) {
      const error = new Error('Áudio convertido ultrapassou 15 MB.');
      error.code = 'AUDIO_SIZE';
      throw error;
    }

    return {
      buffer: fs.readFileSync(output),
      title: String(metadata.title || video.title || 'Áudio'),
      channel: String(metadata.uploader || metadata.channel || video.channel || 'Canal não informado'),
      url
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
