import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve('./figurinhas');
const CACHE = path.join(ROOT, 'cache');
const LIBRARY = path.join(ROOT, 'biblioteca');
const CATALOG = path.join(ROOT, 'biblioteca.json');

function ensureDirectories() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(LIBRARY, { recursive: true });

  if (!fs.existsSync(CATALOG)) {
    fs.writeFileSync(
      CATALOG,
      JSON.stringify({ version: 1, items: [] }, null, 2)
    );
  }
}

function readCatalog() {
  ensureDirectories();

  try {
    const data = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  } catch {
    throw new Error('O catálogo de figurinhas está inválido.');
  }
}

function writeCatalog(data) {
  fs.writeFileSync(CATALOG, JSON.stringify(data, null, 2));
}

export async function searchGiphy(query) {
  const apiKey = process.env.GIPHY_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('Chave GIPHY não encontrada no arquivo .env.');
  }

  query = String(query || '').trim();

  if (!query) throw new Error('Informe o que deseja pesquisar.');
  if (query.length > 50) {
    throw new Error('A pesquisa pode ter no máximo 50 caracteres.');
  }

  const url = new URL('https://api.giphy.com/v1/stickers/search');

  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '8');
  url.searchParams.set('rating', 'g');
  url.searchParams.set('lang', 'pt');

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.meta?.msg || `GIPHY respondeu com HTTP ${response.status}.`
    );
  }

  const results = (payload.data || []).map(item => {
    const images = item.images || {};

    const rendition =
      images.fixed_height ||
      images.downsized ||
      images.original ||
      images.preview_gif;

    const assetUrl =
      rendition?.webp ||
      rendition?.url ||
      images.original?.url;

    if (!assetUrl) return null;

    return {
      id: item.id,
      title: item.title || 'Figurinha sem título',
      username: item.username || 'Desconhecido',
      pageUrl: item.url || '',
      assetUrl
    };
  }).filter(Boolean);

  const hash = crypto
    .createHash('sha256')
    .update(query.toLowerCase())
    .digest('hex');

  fs.writeFileSync(
    path.join(CACHE, `${hash}.json`),
    JSON.stringify({
      query,
      source: 'GIPHY',
      savedAt: new Date().toISOString(),
      results
    }, null, 2)
  );

  return results;
}

export async function downloadGiphyResult(result) {
  if (!result?.assetUrl) {
    throw new Error('Resultado sem endereço de mídia.');
  }

  const url = new URL(result.assetUrl);

  const allowedHost =
    url.hostname.endsWith('.giphy.com') ||
    url.hostname === 'giphy.com' ||
    url.hostname.endsWith('.giphyusercontent.com');

  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('Endereço de mídia não autorizado.');
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error('Não foi possível baixar a figurinha do GIPHY.');
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);

  if (declaredSize > 15 * 1024 * 1024) {
    throw new Error('Arquivo externo ultrapassa 15 MB.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length || buffer.length > 15 * 1024 * 1024) {
    throw new Error('Arquivo vazio ou grande demais.');
  }

  return buffer;
}

export function saveStickerToLibrary(buffer, metadata = {}) {
  ensureDirectories();

  if (
    buffer.length < 12 ||
    buffer.subarray(0, 4).toString() !== 'RIFF' ||
    buffer.subarray(8, 12).toString() !== 'WEBP'
  ) {
    throw new Error('O arquivo recebido não é uma figurinha WebP válida.');
  }

  if (buffer.length > 1024 * 1024) {
    throw new Error('A figurinha ultrapassa o limite de 1 MB.');
  }

  const hash = crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');

  const filename = `${hash}.webp`;
  const filepath = path.join(LIBRARY, filename);

  const catalog = readCatalog();

  const existing = catalog.items.find(item => item.hash === hash);

  if (existing) {
    return { ...existing, duplicate: true };
  }

  fs.writeFileSync(filepath, buffer);

  const item = {
    hash,
    filename,
    source: metadata.source || 'GIPHY',
    title: metadata.title || 'Figurinha',
    giphyId: metadata.giphyId || null,
    pageUrl: metadata.pageUrl || '',
    animated:
      buffer.includes(Buffer.from('ANIM')) ||
      buffer.includes(Buffer.from('ANMF')),
    size: buffer.length,
    createdAt: new Date().toISOString()
  };

  catalog.items.push(item);
  writeCatalog(catalog);

  return { ...item, duplicate: false };
}

export function listLibrary() {
  return readCatalog().items;
}

export function readLibrarySticker(filename) {
  if (
    typeof filename !== 'string' ||
    path.basename(filename) !== filename ||
    !filename.endsWith('.webp')
  ) {
    throw new Error('Nome de arquivo inválido.');
  }

  const filepath = path.join(LIBRARY, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error('Figurinha não encontrada na biblioteca.');
  }

  return fs.readFileSync(filepath);
}


// Pesquisa GIFs em MP4, preservando a busca de figurinhas já existente.
export async function searchGiphyGif(query) {
  const apiKey = process.env.GIPHY_API_KEY?.trim();
  if (!apiKey) throw new Error('Chave GIPHY não configurada.');

  query = String(query || '').trim();
  if (!query) throw new Error('Informe um termo para buscar GIF.');
  if (query.length > 50) throw new Error('A pesquisa de GIF pode ter até 50 caracteres.');

  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '10');
  // GIFs de interações usam PG-13 para evitar resultados excessivamente infantis; sem gore explícito.
  url.searchParams.set('rating', 'pg-13');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('bundle', 'messaging_non_clips');

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.meta?.msg || `GIPHY respondeu com HTTP ${response.status}.`);
  }

  return (Array.isArray(payload.data) ? payload.data : []).map(item => {
    const images = item.images || {};
    const rendition = images.downsized_small || images.fixed_height || images.original;
    const mp4Url = rendition?.mp4 || images.fixed_height?.mp4 || images.original?.mp4;
    if (!mp4Url) return null;

    let parsed;
    try { parsed = new URL(mp4Url); } catch { return null; }
    const allowedHost = parsed.hostname === 'giphy.com' ||
      parsed.hostname.endsWith('.giphy.com') ||
      parsed.hostname.endsWith('.giphyusercontent.com');
    if (parsed.protocol !== 'https:' || !allowedHost) return null;

    return {
      id: String(item.id || ''),
      title: String(item.title || 'GIF'),
      tags: Array.isArray(item.tags) ? item.tags.map(tag => String(tag || '')).filter(Boolean) : [],
      pageUrl: String(item.url || ''),
      mp4Url: parsed.toString()
    };
  }).filter(item => item && item.id && item.mp4Url);
}

export async function downloadGiphyGif(result) {
  if (!result?.mp4Url) throw new Error('Resultado GIPHY sem endereço MP4.');

  let url;
  try { url = new URL(result.mp4Url); } catch {
    throw new Error('Endereço de GIF inválido.');
  }
  const allowedHost = url.hostname === 'giphy.com' ||
    url.hostname.endsWith('.giphy.com') ||
    url.hostname.endsWith('.giphyusercontent.com');
  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('Endereço de mídia GIPHY não autorizado.');
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Não foi possível baixar o GIF do GIPHY.');
  if (response.url) {
    const finalUrl = new URL(response.url);
    const finalHostAllowed = finalUrl.hostname === 'giphy.com' ||
      finalUrl.hostname.endsWith('.giphy.com') ||
      finalUrl.hostname.endsWith('.giphyusercontent.com');
    if (finalUrl.protocol !== 'https:' || !finalHostAllowed) {
      throw new Error('O endereço final do GIF não é autorizado.');
    }
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);
  const maxBytes = 8 * 1024 * 1024;
  if (declaredSize > maxBytes) throw new Error('O GIF ultrapassa 8 MB.');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 12 || buffer.length > maxBytes) {
    throw new Error('GIF vazio ou grande demais.');
  }
  if (buffer.subarray(4, 8).toString() !== 'ftyp') {
    throw new Error('O arquivo retornado pelo GIPHY não é um MP4 válido.');
  }
  return buffer;
}
