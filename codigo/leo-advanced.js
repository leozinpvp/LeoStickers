import { execFileSync } from 'node:child_process';
// LEO_STICKERS_ADVANCED_MODULE_V1
// Módulo extra sem IA: APIs públicas, antispam, reputação, automações e agendamentos.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import v8 from 'node:v8';
import { spawn } from 'node:child_process';

const DATA_FILE = path.resolve('./leo-advanced-data.json');
const MAX_API_IMAGE_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 12000;
const API_CACHE_TTL_MS = 3 * 60 * 1000;

const PERFORMANCE_DEFAULTS = {
  memoryMb: 768,
  queueConcurrency: 1,
  maxQueue: 8,
  cacheTtlMs: 180000,
  apiIntervalMs: 350
};
const apiCache = new Map();
const rateBuckets = new Map();
const autoReplyCooldowns = new Map();
let lastApiRequestAt = 0;
let apiRequestChain = Promise.resolve();
let schedulerTimer = null;
let schedulerSock = null;
let schedulerRunning = false;
const downloadQueue = [];

export const ADVANCED_COMMANDS = [
  'menuapi', 'anime', 'manga', 'personagem', 'neko', 'waifu', 'gifapi', 'fila',
  'cachorro', 'clima', 'cotacao', 'cep', 'ddd', 'feriado', 'apihealth',
  'antispam', 'rep', 'darrep', 'toprep',
  'autoadd', 'autodel', 'autolist', 'agendar', 'agendados', 'cancelaragendamento',
  'cargo', 'cargos', 'desempenho'
];







let overloadProtectionActive = false;
let lastMaintenanceAt = 0;

function runPerformanceMaintenance() {
  const now = Date.now();
  const ttl = readData().performance.cacheTtlMs;

  for (const [key, entry] of apiCache) {
    if (!entry || ttl <= 0 || now - entry.at >= ttl) {
      apiCache.delete(key);
    }
  }

  for (const [key, bucket] of rateBuckets) {
    bucket.hits = bucket.hits.filter(at => now - at < 60000);
    if (bucket.blockedUntil <= now && bucket.hits.length === 0) {
      rateBuckets.delete(key);
    }
  }

  for (const [key, timestamp] of autoReplyCooldowns) {
    if (now - timestamp > 60000) autoReplyCooldowns.delete(key);
  }

  if (apiCache.size > 150) {
    const excess = apiCache.size - 150;
    let removed = 0;
    for (const key of apiCache.keys()) {
      apiCache.delete(key);
      if (++removed >= excess) break;
    }
  }

  const memory = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const ratio = memory.heapUsed / heapLimit;

  if (!overloadProtectionActive && ratio >= 0.85) {
    overloadProtectionActive = true;
    console.warn(`[DESEMPENHO] Proteção ativada: heap em ${(ratio * 100).toFixed(1)}%.`);
  } else if (overloadProtectionActive && ratio <= 0.75) {
    overloadProtectionActive = false;
    console.log('[DESEMPENHO] Memória normalizada. Fila liberada.');
  }

  lastMaintenanceAt = now;
}

const activeDownloads = new Map();
let nextDownloadId = 0;

export function withAdvancedDownloadQueue(task, label = 'mídia') {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('Tarefa de download inválida.'));
  }

  runPerformanceMaintenance();
  if (overloadProtectionActive) {
    const error = new Error('Proteção de memória ativa. Aguarde alguns instantes e tente novamente.');
    error.code = 'MEMORY_PROTECTION';
    return Promise.reject(error);
  }

  const config = readData().performance;
  if (downloadQueue.length >= config.maxQueue) {
    const error = new Error('A fila de downloads está cheia. Aguarde alguns pedidos terminarem.');
    error.code = 'QUEUE_FULL';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    downloadQueue.push({
      id: ++nextDownloadId,
      task,
      label: clean(label, 60),
      resolve,
      reject
    });
    processDownloadQueue();
  });
}

function processDownloadQueue() {
  const config = readData().performance;
  const concurrency = Math.max(1, Math.min(3, Number(config.queueConcurrency) || 1));

  while (downloadQueue.length && activeDownloads.size < concurrency) {
    const job = downloadQueue.shift();
    activeDownloads.set(job.id, job.label || 'mídia');

    Promise.resolve()
      .then(() => job.task())
      .then(job.resolve, job.reject)
      .finally(() => {
        activeDownloads.delete(job.id);
        processDownloadQueue();
      });
  }
}

export function getDownloadQueueStatus() {
  const config = readData().performance;
  return {
    active: [...activeDownloads.values()].join(', '),
    waiting: downloadQueue.length,
    running: activeDownloads.size > 0,
    activeCount: activeDownloads.size,
    concurrency: config.queueConcurrency,
    maxWaiting: config.maxQueue
  };
}

function defaultData() {
  return { version: 1, groups: {}, scheduled: [], performance: { ...PERFORMANCE_DEFAULTS } };
}

function readData() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!value || typeof value !== 'object') return defaultData();
    value.groups ||= {};
    value.scheduled = Array.isArray(value.scheduled) ? value.scheduled : [];
    value.performance = {
      ...PERFORMANCE_DEFAULTS,
      ...(value.performance && typeof value.performance === 'object' ? value.performance : {})
    };
    return value;
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(temp, DATA_FILE);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  try { fs.chmodSync(DATA_FILE, 0o600); } catch {}
}


function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'indisponível';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatUptime(seconds) {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${minutes}min`;
}

function getRuntimeInfo() {
  // UNIVERSAL_RUNTIME_DIAGNOSTICS_V1
  const memory = process.memoryUsage();
  const platform = process.platform;

  const readFile = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  };

  const runCommand = (command, args = []) => {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        timeout: 1200,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      return '';
    }
  };

  const hasTermux = Boolean(
    String(process.env.PREFIX || '').includes('com.termux') ||
    fs.existsSync('/data/data/com.termux')
  );

  const isAndroid = Boolean(
    hasTermux ||
    fs.existsSync('/system/build.prop') ||
    fs.existsSync('/system/bin/getprop')
  );

  const getprop = (key) => {
    if (!isAndroid) return '';
    return runCommand('/system/bin/getprop', [key]) ||
           runCommand('getprop', [key]);
  };

  const cpuInfo = readFile('/proc/cpuinfo');
  const cpuLines = cpuInfo.split(/\r?\n/);

  const findCpuInfo = (keys) => {
    for (const line of cpuLines) {
      const match = line.match(/^\s*([^:]+)\s*:\s*(.+)$/);
      if (!match) continue;

      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();

      if (keys.includes(key) && value) return value;
    }
    return '';
  };

  const osCpus = Array.isArray(os.cpus()) ? os.cpus() : [];
  const hostCpus = Math.max(1, osCpus.length || 1);

  let cpus = hostCpus;
  try {
    if (typeof os.availableParallelism === 'function') {
      cpus = Math.max(1, Number(os.availableParallelism()) || hostCpus);
    }
  } catch {
    cpus = hostCpus;
  }

  let cpuSetCount = 0;
  const cpuSetText =
    readFile('/sys/fs/cgroup/cpuset.cpus.effective') ||
    readFile('/sys/fs/cgroup/cpuset/cpuset.cpus');

  if (cpuSetText) {
    for (const part of cpuSetText.split(',')) {
      const range = part.trim().match(/^(\d+)-(\d+)$/);
      const single = part.trim().match(/^\d+$/);

      if (range) {
        cpuSetCount += Math.max(0, Number(range[2]) - Number(range[1]) + 1);
      } else if (single) {
        cpuSetCount += 1;
      }
    }
  }

  let cpuQuota = 0;
  const cpuMax = readFile('/sys/fs/cgroup/cpu.max');

  if (cpuMax) {
    const parts = cpuMax.split(/\s+/);
    const quota = Number(parts[0]);
    const period = Number(parts[1]);

    if (Number.isFinite(quota) && quota > 0 &&
        Number.isFinite(period) && period > 0) {
      cpuQuota = quota / period;
    }
  }

  if (!cpuQuota) {
    const quota = Number(
      readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')
    );
    const period = Number(
      readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
    );

    if (quota > 0 && period > 0) {
      cpuQuota = quota / period;
    }
  }

  if (cpuSetCount > 0) {
    cpus = Math.min(cpus, cpuSetCount);
  }

  if (cpuQuota > 0) {
    cpus = Math.min(cpus, Math.ceil(cpuQuota));
  }

  cpus = Math.max(1, Math.floor(cpus || 1));

  let cpuLimit = 'Não informado pelo sistema';
  if (cpuQuota > 0) {
    cpuLimit = `${cpuQuota.toFixed(2)} CPUs (cota)`;
  } else if (cpuSetCount > 0) {
    cpuLimit = `${cpuSetCount} CPUs (afinidade)`;
  }

  const physicalMemory = Math.max(0, Number(os.totalmem()) || 0);
  const freeMemory = Math.max(0, Number(os.freemem()) || 0);

  const memoryMaxRaw =
    readFile('/sys/fs/cgroup/memory.max') ||
    readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');

  const memoryCurrentRaw =
    readFile('/sys/fs/cgroup/memory.current') ||
    readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');

  const parseMemoryLimit = (raw) => {
    if (!raw || raw === 'max') return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 ||
        value >= Number.MAX_SAFE_INTEGER) return 0;
    return value;
  };

  const cgroupMemoryLimit = parseMemoryLimit(memoryMaxRaw);
  const cgroupMemoryUsed = parseMemoryLimit(memoryCurrentRaw);

  const systemTotalBytes = cgroupMemoryLimit
    ? Math.min(physicalMemory || cgroupMemoryLimit, cgroupMemoryLimit)
    : physicalMemory;

  const cgroupFree = cgroupMemoryLimit
    ? Math.max(0, cgroupMemoryLimit - cgroupMemoryUsed)
    : freeMemory;

  const systemFreeBytes = cgroupMemoryLimit
    ? Math.min(freeMemory || cgroupFree, cgroupFree)
    : freeMemory;

  const memoryLimit = cgroupMemoryLimit
    ? formatBytes(cgroupMemoryLimit)
    : 'Nenhum limite de container detectado';

  const dmiVendor =
    readFile('/sys/class/dmi/id/sys_vendor') ||
    readFile('/sys/devices/virtual/dmi/id/sys_vendor');

  const dmiModel =
    readFile('/sys/class/dmi/id/product_name') ||
    readFile('/sys/devices/virtual/dmi/id/product_name');

  let manufacturer = getprop('ro.product.manufacturer') || dmiVendor;
  let device = getprop('ro.product.model') || dmiModel;
  let cpuModel = '';

  if (isAndroid) {
    cpuModel =
      getprop('ro.soc.model') ||
      getprop('ro.vendor.qti.soc_model') ||
      getprop('ro.hardware') ||
      findCpuInfo(['hardware', 'model name', 'processor', 'model']) ||
      osCpus[0]?.model ||
      '';
  } else if (platform === 'win32') {
    manufacturer ||= runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_ComputerSystem).Manufacturer'
    ]);

    device ||= runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_ComputerSystem).Model'
    ]);

    cpuModel =
      process.env.PROCESSOR_IDENTIFIER ||
      runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)'
      ]);
  } else if (platform === 'darwin') {
    device ||= runCommand('sysctl', ['-n', 'hw.model']);
    cpuModel = runCommand('sysctl', ['-n', 'machdep.cpu.brand_string']);
    manufacturer ||= 'Apple';
  } else {
    cpuModel = findCpuInfo([
      'model name',
      'hardware',
      'processor',
      'cpu model',
      'model'
    ]) || osCpus[0]?.model || '';
  }

  manufacturer ||= 'Não identificado';
  device ||= 'Modelo não informado pelo sistema';
  cpuModel ||= 'Processador não identificado';

  const osReleaseFile = readFile('/etc/os-release');
  const distroMatch = osReleaseFile.match(/^PRETTY_NAME=(.*)$/m);
  const distro = distroMatch
    ? distroMatch[1].replace(/^["']|["']$/g, '')
    : isAndroid
      ? `Android ${getprop('ro.build.version.release') || 'versão não identificada'}`
      : platform === 'win32'
        ? 'Windows'
        : platform === 'darwin'
          ? 'macOS'
          : platform === 'linux'
            ? 'Distribuição Linux não identificada'
            : platform;

  const cgroupInfo =
    readFile('/proc/1/cgroup') +
    readFile('/proc/self/cgroup') +
    readFile('/proc/self/mountinfo');

  const isContainer = Boolean(
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    /docker|containerd|kubepods|lxc|podman/i.test(cgroupInfo)
  );

  let host;
  if (hasTermux) {
    host = 'Termux / Android';
  } else if (isAndroid) {
    host = 'Android';
  } else if (isContainer) {
    host = `Container / ${platform}`;
  } else if (platform === 'win32') {
    host = 'Windows';
  } else if (platform === 'darwin') {
    host = 'macOS';
  } else if (platform === 'linux') {
    host = 'Linux / servidor ou computador';
  } else {
    host = platform;
  }

  return {
    host,
    platform,
    release: os.release(),
    arch: os.arch(),
    cpus,
    hostCpus,
    cpuLimit,
    cpuModel,
    manufacturer,
    device,
    container: isContainer ? 'Sim' : 'Não detectado',
    distro,
    memoryLimit,
    systemTotalBytes,
    node: process.version,
    uptime: formatUptime(process.uptime()),
    rss: formatBytes(memory.rss),
    heapUsed: formatBytes(memory.heapUsed),
    heapTotal: formatBytes(memory.heapTotal),
    heapLimit: formatBytes(v8.getHeapStatistics().heap_size_limit),
    systemTotal: formatBytes(systemTotalBytes),
    systemFree: formatBytes(systemFreeBytes)
  };
}

function groupState(data, jid) {
  data.groups[jid] ||= {
    antiSpam: true,
    autoReplies: [],
    reputation: {},
    repGiven: {},
    moderators: []
  };
  const group = data.groups[jid];
  group.autoReplies = Array.isArray(group.autoReplies) ? group.autoReplies : [];
  group.reputation = group.reputation && typeof group.reputation === 'object' ? group.reputation : {};
  group.repGiven = group.repGiven && typeof group.repGiven === 'object' ? group.repGiven : {};
  group.moderators = Array.isArray(group.moderators) ? group.moderators : [];
  if (typeof group.antiSpam !== 'boolean') group.antiSpam = true;
  return group;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitApiSlot() {
  const previous = apiRequestChain;
  let release;
  apiRequestChain = new Promise(resolve => { release = resolve; });

  await previous;
  try {
    const interval = readData().performance.apiIntervalMs;
    const wait = Math.max(0, lastApiRequestAt + interval - Date.now());
    if (wait > 0) await sleep(wait);
    lastApiRequestAt = Date.now();
  } finally {
    release();
  }
}

async function fetchJson(url, { cacheMs, headers = {} } = {}) {
  const configuredCacheMs = readData().performance.cacheTtlMs;
  if (cacheMs === undefined) {
    cacheMs = configuredCacheMs;
  } else if (cacheMs > 0) {
    cacheMs = Math.min(cacheMs, configuredCacheMs);
  }
  const cached = apiCache.get(url);
  if (cacheMs > 0 && cached && Date.now() - cached.at < cacheMs) return cached.value;

await waitApiSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': 'LEO-STICKERS (https://github.com/leozinpvp/LeoStickers)',
        ...headers
      }
    });
    if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}`);
    const value = await response.json();
    if (cacheMs > 0) {
      apiCache.set(url, { at: Date.now(), value });
      if (apiCache.size > 150) apiCache.delete(apiCache.keys().next().value);
    }
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('A API demorou demais para responder.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url) {
  await waitApiSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'LEO-STICKERS (https://github.com/leozinpvp/LeoStickers)' }
    });
    if (!response.ok) throw new Error(`Falha ao baixar mídia (HTTP ${response.status}).`);
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > MAX_API_IMAGE_BYTES) throw new Error('A imagem passou do limite de 8 MB.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_API_IMAGE_BYTES) throw new Error('Arquivo vazio ou maior que 8 MB.');
    return {
      buffer,
      mimetype: String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0]
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('O download da mídia demorou demais.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function extractText(msg) {
  let current = msg?.message || {};
  for (let i = 0; i < 10; i++) {
    const next = current.ephemeralMessage?.message || current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message || current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message;
    if (!next) break;
    current = next;
  }
  return String(current.conversation || current.extendedTextMessage?.text ||
    current.imageMessage?.caption || current.videoMessage?.caption ||
    current.documentMessage?.caption || '').trim();
}

function getMentions(msg) {
  const content = msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo || msg?.message?.videoMessage?.contextInfo || {};
  return Array.isArray(content.mentionedJid) ? content.mentionedJid : [];
}

function isOwner(ctx) {
  try { return typeof ctx.isOwner === 'function' && ctx.isOwner(ctx.sender); }
  catch { return false; }
}

async function isNativeGroupAdmin(ctx) {
  if (isOwner(ctx)) return true;
  if (!String(ctx.jid || '').endsWith('@g.us')) return true;
  try {
    const metadata = await ctx.sock.groupMetadata(ctx.jid);
    const participant = (metadata.participants || []).find(item =>
      item.id === ctx.sender || item.jid === ctx.sender || item.lid === ctx.sender ||
      item.phoneNumber === ctx.sender
    );
    return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin' || participant.isAdmin));
  } catch {
    return false;
  }
}

async function isGroupManager(ctx) {
  if (await isNativeGroupAdmin(ctx)) return true;
  if (!String(ctx.jid || '').endsWith('@g.us')) return true;
  const data = readData();
  return groupState(data, ctx.jid).moderators.includes(ctx.sender);
}

export function checkAdvancedRateLimit(jid, sender, command) {
  const chat = String(jid || '');
  const user = String(sender || '');
  if (!chat || !user) return { allowed: true };
  if (chat.endsWith('@g.us')) {
    const data = readData();
    const group = data.groups[chat];
    if (group && group.antiSpam === false && command !== 'antispam') return { allowed: true };
  }
  const key = `${chat}|${user}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { hits: [], blockedUntil: 0 };
  if (bucket.blockedUntil > now) {
    return { allowed: false, seconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
  }
  bucket.hits = bucket.hits.filter(at => now - at < 10000);
  bucket.hits.push(now);
  if (bucket.hits.length > 8) {
    bucket.hits = [];
    bucket.blockedUntil = now + 15000;
    rateBuckets.set(key, bucket);
    console.warn(`[ANTISPAM] Comandos em excesso: ${user} em ${chat}`);
    return { allowed: false, seconds: 15 };
  }
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 2000) {
    for (const [itemKey, item] of rateBuckets) {
      if (item.blockedUntil < now && (!item.hits.length || now - item.hits.at(-1) > 60000)) rateBuckets.delete(itemKey);
    }
  }
  return { allowed: true };
}

export async function handleAdvancedAutoReply(sock, msg, prefix = '!') {
  try {
    if (!msg?.message || msg.key?.fromMe) return false;
    const jid = msg.key?.remoteJid || '';
    if (!jid.endsWith('@g.us')) return false;
    const text = extractText(msg);
    if (!text || text.startsWith(String(prefix || '!'))) return false;
    const data = readData();
    const group = data.groups[jid];
    if (!group || !Array.isArray(group.autoReplies) || !group.autoReplies.length) return false;
    const normalized = text.toLocaleLowerCase('pt-BR');
    const match = group.autoReplies.find(item => item?.trigger && normalized.includes(String(item.trigger).toLocaleLowerCase('pt-BR')));
    if (!match) return false;
    const sender = msg.key?.participant || jid;
    const key = `${jid}|${sender}|${match.trigger}`;
    const last = autoReplyCooldowns.get(key) || 0;
    if (Date.now() - last < 12000) return false;
    autoReplyCooldowns.set(key, Date.now());
    await sock.sendMessage(jid, { text: `💬 ${match.response}` }, { quoted: msg });
    return true;
  } catch (error) {
    console.warn('[AUTO-RESPOSTA]', error?.message || error);
    return false;
  }
}

export function startAdvancedScheduler(sock) {
  schedulerSock = sock;
  if (schedulerTimer) return;
  schedulerTimer = setInterval(async () => {
    if (schedulerRunning || !schedulerSock) return;
    schedulerRunning = true;
    try {
      if (Date.now() - lastMaintenanceAt >= 5 * 60 * 1000) {
        runPerformanceMaintenance();
      }

      const data = readData();
      const now = Date.now();
      const due = data.scheduled.filter(item => Number(item.runAt) <= now);
      if (!due.length) return;
      const dueIds = new Set(due.map(item => item.id));
      data.scheduled = data.scheduled.filter(item => !dueIds.has(item.id));
      writeData(data);
      for (const item of due) {
        try {
          await schedulerSock.sendMessage(item.jid, {
            text: `⏰ *MENSAGEM AGENDADA*\n\n${item.text}\n\n🦊 Léo Stickers`
          });
        } catch (error) {
          const retryData = readData();
          const retry = Number(item.retries || 0) + 1;
          if (retry < 3) retryData.scheduled.push({ ...item, retries: retry, runAt: Date.now() + 5 * 60 * 1000 });
          writeData(retryData);
          console.warn('[AGENDAMENTO]', error?.message || error);
        }
      }
    } catch (error) {
      console.warn('[AGENDAMENTO]', error?.message || error);
    } finally {
      schedulerRunning = false;
    }
  }, 5000);
  schedulerTimer.unref?.();
}

function formatDate(date) {
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getWeatherLabel(code) {
  const labels = {
    0: 'Céu limpo', 1: 'Predominantemente limpo', 2: 'Parcialmente nublado', 3: 'Nublado',
    45: 'Nevoeiro', 48: 'Nevoeiro com geada', 51: 'Garoa leve', 53: 'Garoa moderada',
    55: 'Garoa intensa', 61: 'Chuva leve', 63: 'Chuva moderada', 65: 'Chuva forte',
    71: 'Neve leve', 73: 'Neve moderada', 75: 'Neve forte', 80: 'Pancadas leves',
    81: 'Pancadas moderadas', 82: 'Pancadas fortes', 95: 'Trovoada', 96: 'Trovoada com granizo leve',
    99: 'Trovoada com granizo forte'
  };
  return labels[Number(code)] || 'Condição não identificada';
}



async function sendNogitsuImageResults(ctx, items, type) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isCharacter = type === 'personagem';

    const title = clean(
      isCharacter
        ? item.name || 'Personagem sem nome'
        : item.title || item.romanizedTitle || 'Obra sem título',
      110
    );

    const imageUrl = isCharacter ? item.image?.url : item.cover?.url;

    let details = '';

    if (isCharacter) {
      details = `🎬 Conhecido por: ${clean(item.knownFor?.title || 'Não informado', 100)}
🎭 Papel: ${clean(Array.isArray(item.roles) ? item.roles.join(', ') : 'Não informado', 60)}
📚 Obras relacionadas: ${Number(item.workCount) || 0}`;
    } else {
      const status = item.releaseStatus === 'finished'
        ? 'Finalizado'
        : item.releaseStatus === 'releasing'
          ? 'Em lançamento'
          : 'Não informado';

      details = `📅 Ano: ${item.year || 'Não informado'}
📌 Status: ${status}
🎞️ Formato: ${clean(item.publicationFormat || 'Não informado', 35)}
🔞 Classificação: ${clean(item.contentRating || 'Não informado', 30)}`;
    }

    const caption = `${isCharacter ? '🧑‍🎤 PERSONAGEM' : type === 'anime' ? '🎌 ANIME' : '📚 MANGÁ'}
*${i + 1}. ${title}*

${details}

🔎 Fonte: Nogitsu`;

    try {
      if (!imageUrl) throw new Error('Sem imagem');

      const media = await fetchBuffer(imageUrl);

      if (!media?.buffer || !/^image\//i.test(media.mimetype || '')) {
        throw new Error('Imagem inválida');
      }

      await ctx.sock.sendMessage(
        ctx.jid,
        { image: media.buffer, caption },
        { quoted: ctx.msg }
      );
    } catch (error) {
      await ctx.send(ctx.jid, `${caption}\n\n🖼️ Imagem indisponível.`, ctx.msg);
    }
  }
}

async function sendAnimeSearch(ctx, type) {
  const query = clean(ctx.value, 100);

  if (!query) {
    return ctx.send(
      ctx.jid,
      `Uso: !${type} nome\nExemplo: !${type} Naruto`,
      ctx.msg
    );
  }

  const medium = type === 'anime' ? 'anime' : 'manga';
  const url = `https://api.nogitsu.com/v1/search/works?q=${encodeURIComponent(query)}&medium=${medium}&limit=3`;

  const result = await fetchJson(url, { cacheMs: 300000 });
  const items = Array.isArray(result.hits) ? result.hits : [];

  if (!items.length) {
    return ctx.send(ctx.jid, 'Não encontrei resultados para essa pesquisa.', ctx.msg);
  }

  await sendNogitsuImageResults(ctx, items, type);
}

async function sendCharacterSearch(ctx) {
  const query = clean(ctx.value, 100);

  if (!query) {
    return ctx.send(
      ctx.jid,
      'Uso: !personagem nome\nExemplo: !personagem Naruto Uzumaki',
      ctx.msg
    );
  }

  const result = await fetchJson(
    `https://api.nogitsu.com/v1/search/entities?q=${encodeURIComponent(query)}`,
    { cacheMs: 300000 }
  );

  const items = Array.isArray(result.characters)
    ? result.characters.slice(0, 3)
    : [];

  if (!items.length) {
    return ctx.send(ctx.jid, 'Não encontrei esse personagem.', ctx.msg);
  }

  await sendNogitsuImageResults(ctx, items, 'personagem');
}

async function sendNekosImage(ctx, category) {
  const result = await fetchJson(`https://nekos.best/api/v2/${category}`, { cacheMs: 60000 });
  const item = result?.results?.[0];
  if (!item?.url) throw new Error('A API não retornou uma imagem.');
  const media = await fetchBuffer(item.url);
  if (!/^image\//.test(media.mimetype)) throw new Error('A API retornou um formato de imagem inválido.');
  const caption = `🦊 Léo Stickers • ${category}\n${item.anime_name ? `Anime: ${clean(item.anime_name, 80)}\n` : ''}${item.artist_name ? `Artista: ${clean(item.artist_name, 80)}\n` : ''}${item.source_url || ''}`.trim();
  await ctx.sock.sendMessage(ctx.jid, { image: media.buffer, caption }, { quoted: ctx.msg });
}

function convertGifToMp4(buffer) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) {
      return reject(new Error('A API não retornou um GIF válido.'));
    }
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '8',
      '-vf', 'fps=15,scale=498:-2', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '28', '-pix_fmt', 'yuv420p',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'
    ];
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes <= 12 * 1024 * 1024) output.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => {
      if (Buffer.concat(errors).length < 12000) errors.push(chunk);
    });
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('FFmpeg não encontrado no Termux.') : error));
    child.on('close', code => {
      const mp4 = Buffer.concat(output);
      if (code !== 0 || mp4.length < 12 || mp4.subarray(4, 8).toString() !== 'ftyp') {
        return reject(new Error(Buffer.concat(errors).toString().slice(-700) || 'Não consegui converter o GIF.'));
      }
      resolve(mp4);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

async function sendAnimeGifLink(ctx, category) {
  const allowed = new Set(['angry', 'baka', 'bite', 'blush', 'bonk', 'clap', 'cry', 'cuddle', 'dance', 'facepalm', 'happy', 'highfive', 'hug', 'kiss', 'laugh', 'pat', 'poke', 'slap', 'smile', 'wave', 'wink']);
  if (!allowed.has(category)) return ctx.send(ctx.jid, `Categoria inválida. Exemplos: ${[...allowed].slice(0, 12).join(', ')}.\nUso: !gifapi hug`, ctx.msg);
  const result = await fetchJson(`https://nekos.best/api/v2/${category}`, { cacheMs: 60000 });
  const item = result?.results?.[0];
  if (!item?.url) throw new Error('A API não retornou um GIF.');
  const media = await fetchBuffer(item.url);
  const mp4 = await withAdvancedDownloadQueue(() => convertGifToMp4(media.buffer), `GIF ${category}`);
  await ctx.sock.sendMessage(ctx.jid, {
    video: mp4,
    mimetype: 'video/mp4',
    gifPlayback: true,
    caption: `🎞️ GIF DE ANIME — ${category.toUpperCase()}\n${item.anime_name ? `Anime: ${clean(item.anime_name, 80)}\n` : ''}Fonte: Nekos.best`
  }, { quoted: ctx.msg });
}

async function sendDog(ctx) {
  const result = await fetchJson('https://dog.ceo/api/breeds/image/random', { cacheMs: 30000 });
  if (result.status !== 'success' || !result.message) throw new Error('A API de cachorros não retornou uma imagem.');
  const media = await fetchBuffer(result.message);
  await ctx.sock.sendMessage(ctx.jid, { image: media.buffer, caption: '🐶 Cachorrinho aleatório • Léo Stickers' }, { quoted: ctx.msg });
}

async function sendWeather(ctx) {
  const city = clean(ctx.value, 100);
  if (!city) return ctx.send(ctx.jid, 'Uso: !clima cidade\nExemplo: !clima São Paulo', ctx.msg);
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`);
  const place = geo?.results?.[0];
  if (!place) return ctx.send(ctx.jid, 'Não encontrei essa cidade. Tente informar cidade e estado.', ctx.msg);
  const forecast = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&timezone=auto`);
  const current = forecast.current || {};
  const unit = forecast.current_units || {};
  const location = [place.name, place.admin1, place.country].filter(Boolean).join(' - ');
  await ctx.send(ctx.jid,
    `🌦️ *CLIMA AGORA*\n📍 ${location}\n\n` +
    `🌡️ Temperatura: ${current.temperature_2m ?? '--'} ${unit.temperature_2m || '°C'}\n` +
    `🤔 Sensação: ${current.apparent_temperature ?? '--'} ${unit.apparent_temperature || '°C'}\n` +
    `💧 Umidade: ${current.relative_humidity_2m ?? '--'}%\n` +
    `🌧️ Precipitação: ${current.precipitation ?? '--'} ${unit.precipitation || 'mm'}\n` +
    `💨 Vento: ${current.wind_speed_10m ?? '--'} ${unit.wind_speed_10m || 'km/h'}\n` +
    `☁️ Condição: ${getWeatherLabel(current.weather_code)}\n` +
    `🕒 Atualizado: ${current.time || 'agora'}\n\nFonte: Open-Meteo`, ctx.msg);
}

async function sendExchange(ctx) {
  const parts = clean(ctx.value, 30).toUpperCase().split(/\s+/).filter(Boolean);
  const base = parts[0] || 'USD';
  const quote = parts[1] || 'BRL';
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
    return ctx.send(ctx.jid, 'Uso: !cotacao USD BRL\nExemplo: !cotacao EUR BRL', ctx.msg);
  }
  if (base === quote) return ctx.send(ctx.jid, `1 ${base} = 1 ${quote}`, ctx.msg);
  const result = await fetchJson(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`);
  if (!Number.isFinite(Number(result.rate))) throw new Error('Não encontrei essa moeda na API.');
  await ctx.send(ctx.jid,
    `💱 *COTAÇÃO DE MOEDAS*\n\n1 ${base} = ${Number(result.rate).toLocaleString('pt-BR', { maximumFractionDigits: 6 })} ${quote}\n📅 Data da referência: ${result.date}\n\nFonte: Frankfurter. Cotação de referência, não é preço de compra/venda de banco.`, ctx.msg);
}

async function sendCep(ctx) {
  const cep = clean(ctx.value, 20).replace(/\D/g, '');
  if (!/^\d{8}$/.test(cep)) return ctx.send(ctx.jid, 'Uso: !cep 12345678', ctx.msg);
  const data = await fetchJson(`https://brasilapi.com.br/api/cep/v2/${cep}`);
  await ctx.send(ctx.jid,
    `📮 *CONSULTA DE CEP*\n\nCEP: ${data.cep || cep}\nRua: ${data.street || 'Não informado'}\nBairro: ${data.neighborhood || 'Não informado'}\nCidade: ${data.city || 'Não informado'}\nEstado: ${data.state || 'Não informado'}\nServiço: ${data.service || 'BrasilAPI'}`, ctx.msg);
}

async function sendDdd(ctx) {
  const ddd = clean(ctx.value, 4).replace(/\D/g, '');
  if (!/^\d{2}$/.test(ddd)) return ctx.send(ctx.jid, 'Uso: !ddd 11', ctx.msg);
  const data = await fetchJson(`https://brasilapi.com.br/api/ddd/v1/${ddd}`);
  const cities = Array.isArray(data.cities) ? data.cities.slice(0, 35) : [];
  if (!cities.length) return ctx.send(ctx.jid, 'Não encontrei cidades para esse DDD.', ctx.msg);
  return ctx.send(ctx.jid, `📞 *CONSULTA DE DDD ${ddd}*\n\nEstado: ${clean(data.state, 10)}\nCidades: ${cities.join(', ')}${data.cities.length > cities.length ? `\n\nMostrando ${cities.length} de ${data.cities.length} cidades.` : ''}\n\nFonte: BrasilAPI`, ctx.msg);
}

async function sendNextHoliday(ctx) {
  const now = new Date();
  let year = now.getFullYear();
  let holidays = await fetchJson(`https://brasilapi.com.br/api/feriados/v1/${year}`);
  let next = Array.isArray(holidays) ? holidays.find(item => new Date(`${item.date}T23:59:59-03:00`) >= now) : null;
  if (!next) {
    year++;
    holidays = await fetchJson(`https://brasilapi.com.br/api/feriados/v1/${year}`);
    next = Array.isArray(holidays) ? holidays[0] : null;
  }
  if (!next) return ctx.send(ctx.jid, 'Não encontrei o próximo feriado nacional.', ctx.msg);
  const date = new Date(`${next.date}T12:00:00-03:00`).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  await ctx.send(ctx.jid, `📅 *PRÓXIMO FERIADO NACIONAL*\n\n🎉 ${clean(next.name, 100)}\n🗓️ ${date}\n🇧🇷 Brasil`, ctx.msg);
}

async function getMentioned(ctx) {
  const mentions = getMentions(ctx.msg);
  return [...new Set(mentions.filter(item => typeof item === 'string' && item.includes('@')))];
}

async function handleReputation(ctx) {
  if (!ctx.jid.endsWith('@g.us')) return ctx.send(ctx.jid, 'Esse comando funciona dentro de grupos.', ctx.msg);
  const data = readData();
  const group = groupState(data, ctx.jid);
  if (ctx.command === 'toprep') {
    const top = Object.entries(group.reputation).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10);
    if (!top.length) return ctx.send(ctx.jid, 'Ainda não há reputações registradas neste grupo.', ctx.msg);
    const lines = top.map(([jid, points], index) => `${index + 1}. @${jid.split('@')[0]} — ${points} ponto(s)`);
    return ctx.sock.sendMessage(ctx.jid, { text: `🏆 *TOP REPUTAÇÃO*\n\n${lines.join('\n')}`, mentions: top.map(([jid]) => jid) }, { quoted: ctx.msg });
  }
  if (ctx.command === 'darrep') {
    const mentions = await getMentioned(ctx);
    const target = mentions[0];
    if (!target) return ctx.send(ctx.jid, 'Marque alguém para dar reputação. Exemplo: !darrep @pessoa', ctx.msg);
    if (target === ctx.sender) return ctx.send(ctx.jid, 'Você não pode dar reputação para si mesmo.', ctx.msg);
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const giver = `${ctx.sender}|${date}`;
    if (group.repGiven[giver]) return ctx.send(ctx.jid, 'Você já deu reputação hoje. Volte amanhã!', ctx.msg);
    group.repGiven[giver] = target;
    group.reputation[target] = Math.max(0, Number(group.reputation[target]) || 0) + 1;
    for (const key of Object.keys(group.repGiven)) {
      if (!key.endsWith(`|${date}`)) delete group.repGiven[key];
    }
    writeData(data);
    return ctx.sock.sendMessage(ctx.jid, { text: `⭐ @${ctx.sender.split('@')[0]} deu +1 reputação para @${target.split('@')[0]}!\nTotal: ${group.reputation[target]}`, mentions: [ctx.sender, target] }, { quoted: ctx.msg });
  }
  const mentions = await getMentioned(ctx);
  const target = mentions[0] || ctx.sender;
  const points = Number(group.reputation[target]) || 0;
  return ctx.sock.sendMessage(ctx.jid, { text: `⭐ Reputação de @${target.split('@')[0]}: *${points} ponto(s)*`, mentions: [target] }, { quoted: ctx.msg });
}

async function handleAutoReplyCommand(ctx) {
  if (!ctx.jid.endsWith('@g.us')) return ctx.send(ctx.jid, 'Esse recurso funciona em grupos.', ctx.msg);
  if (!(await isGroupManager(ctx))) return ctx.send(ctx.jid, 'Somente administradores do grupo, moderadores cadastrados ou o dono podem alterar respostas automáticas.', ctx.msg);
  const data = readData();
  const group = groupState(data, ctx.jid);
  if (ctx.command === 'autoadd') {
    const pieces = String(ctx.value || '').split('|');
    const trigger = clean(pieces.shift(), 50).toLocaleLowerCase('pt-BR');
    const response = clean(pieces.join('|'), 500);
    if (!trigger || !response) return ctx.send(ctx.jid, 'Uso: !autoadd palavra-chave | resposta', ctx.msg);
    if (group.autoReplies.length >= 20) return ctx.send(ctx.jid, 'Limite de 20 respostas automáticas por grupo atingido.', ctx.msg);
    const exists = group.autoReplies.findIndex(item => item.trigger === trigger);
    if (exists >= 0) group.autoReplies[exists] = { trigger, response };
    else group.autoReplies.push({ trigger, response });
    writeData(data);
    return ctx.send(ctx.jid, `✅ Resposta automática salva.\nQuando alguém escrever: ${trigger}`, ctx.msg);
  }
  if (ctx.command === 'autodel') {
    const trigger = clean(ctx.value, 50).toLocaleLowerCase('pt-BR');
    if (!trigger) return ctx.send(ctx.jid, 'Uso: !autodel palavra-chave', ctx.msg);
    const before = group.autoReplies.length;
    group.autoReplies = group.autoReplies.filter(item => item.trigger !== trigger);
    writeData(data);
    return ctx.send(ctx.jid, before === group.autoReplies.length ? 'Não encontrei essa palavra-chave.' : '🗑️ Resposta automática removida.', ctx.msg);
  }
  const list = group.autoReplies.map((item, index) => `${index + 1}. ${item.trigger} → ${item.response}`).join('\n');
  return ctx.send(ctx.jid, list ? `💬 *RESPOSTAS AUTOMÁTICAS*\n\n${list}` : 'Não há respostas automáticas cadastradas.', ctx.msg);
}

async function handleSchedule(ctx) {
  const data = readData();
  if (ctx.command === 'agendar') {
    if (!(await isGroupManager(ctx))) return ctx.send(ctx.jid, 'Em grupos, somente administradores, moderadores cadastrados ou o dono podem agendar mensagens.', ctx.msg);
    const match = String(ctx.value || '').match(/^(\d{1,4})(s|m|h|d)\s+([\s\S]+)$/i);
    if (!match) return ctx.send(ctx.jid, 'Uso: !agendar 10m mensagem\nUnidades: s (segundos), m (minutos), h (horas), d (dias).', ctx.msg);
    const amount = Number(match[1]);
    const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
    const delayMs = amount * multiplier;
    const message = clean(match[3], 1500);
    if (!Number.isFinite(delayMs) || delayMs < 10000 || delayMs > 7 * 86400000 || !message) {
      return ctx.send(ctx.jid, 'O agendamento deve ser de 10 segundos a 7 dias, com uma mensagem de até 1.500 caracteres.', ctx.msg);
    }
    const id = Math.random().toString(36).slice(2, 7).toUpperCase();
    data.scheduled.push({ id, jid: ctx.jid, text: message, runAt: Date.now() + delayMs, createdBy: ctx.sender, retries: 0 });
    writeData(data);
    return ctx.send(ctx.jid, `⏰ Mensagem agendada!\nCódigo: ${id}\nEnvio: ${formatDate(Date.now() + delayMs)}`, ctx.msg);
  }
  if (ctx.command === 'cancelaragendamento') {
    if (!(await isGroupManager(ctx))) return ctx.send(ctx.jid, 'Somente administradores, moderadores cadastrados ou o dono podem cancelar agendamentos.', ctx.msg);
    const id = clean(ctx.value, 10).toUpperCase();
    if (!id) return ctx.send(ctx.jid, 'Uso: !cancelaragendamento código', ctx.msg);
    const before = data.scheduled.length;
    data.scheduled = data.scheduled.filter(item => !(item.id === id && item.jid === ctx.jid));
    writeData(data);
    return ctx.send(ctx.jid, before === data.scheduled.length ? 'Não encontrei esse agendamento neste chat.' : '🗑️ Agendamento cancelado.', ctx.msg);
  }
  const mine = data.scheduled.filter(item => item.jid === ctx.jid).sort((a, b) => a.runAt - b.runAt);
  if (!mine.length) return ctx.send(ctx.jid, 'Não há mensagens agendadas neste chat.', ctx.msg);
  const lines = mine.slice(0, 15).map(item => `• ${item.id} — ${formatDate(item.runAt)}\n  ${clean(item.text, 100)}`);
  return ctx.send(ctx.jid, `⏰ *AGENDAMENTOS*\n\n${lines.join('\n\n')}`, ctx.msg);
}

async function handleGroupRoles(ctx) {
  if (!ctx.jid.endsWith('@g.us')) return ctx.send(ctx.jid, 'Os cargos extras funcionam em grupos.', ctx.msg);
  if (!(await isNativeGroupAdmin(ctx))) return ctx.send(ctx.jid, 'Somente administradores oficiais do grupo ou o dono podem alterar a lista de moderadores extras.', ctx.msg);
  const data = readData();
  const group = groupState(data, ctx.jid);
  const parts = clean(ctx.value, 100).split(/\s+/).filter(Boolean);
  if (ctx.command === 'cargos' || !parts.length) {
    return ctx.send(ctx.jid, group.moderators.length
      ? `🛡️ *MODERADORES EXTRAS*\n\n${group.moderators.map(item => `• @${item.split('@')[0]}`).join('\n')}`
      : 'Nenhum moderador extra cadastrado. Use !cargo add @pessoa.', ctx.msg);
  }
  const action = parts[0].toLowerCase();
  const target = (await getMentioned(ctx))[0];
  if (!['add', 'del', 'remover'].includes(action) || !target) return ctx.send(ctx.jid, 'Uso: !cargo add @pessoa ou !cargo del @pessoa', ctx.msg);
  if (action === 'add') {
    if (!group.moderators.includes(target)) group.moderators.push(target);
  } else {
    group.moderators = group.moderators.filter(item => item !== target);
  }
  writeData(data);
  return ctx.sock.sendMessage(ctx.jid, { text: action === 'add' ? `✅ @${target.split('@')[0]} recebeu o cargo de moderador extra.` : `🗑️ Cargo extra removido de @${target.split('@')[0]}.`, mentions: [target] }, { quoted: ctx.msg });
}




async function handlePerformanceSetting(ctx) {
  if (!ctx.isOwner(ctx.sender)) {
    return ctx.send(ctx.jid, '🔒 Comando exclusivo do dono.', ctx.msg);
  }

  const args = String(ctx.value || '').trim().toLowerCase().split(/\s+/);
  const action = args[0];
  const number = Number(args[1]);
  const data = readData();
  const config = data.performance;

  if (action === 'limparcache') {
    const total = apiCache.size;
    apiCache.clear();
    return ctx.send(ctx.jid, `🧹 Cache limpo! ${total} itens removidos.`, ctx.msg);
  }

  if (action === 'reset') {
    data.performance = { ...PERFORMANCE_DEFAULTS };
    writeData(data);
    apiCache.clear();
    return ctx.send(ctx.jid, '♻️ Configurações restauradas. Reinicie o bot para aplicar a memória.', ctx.msg);
  }

  if (action === 'fila') {
    if (![1, 2, 3].includes(number)) {
      return ctx.send(ctx.jid, 'Use: !desempenho fila 1, 2 ou 3', ctx.msg);
    }
    config.queueConcurrency = number;
  } else if (action === 'limitefila') {
    if (![4, 8, 12, 20, 30].includes(number)) {
      return ctx.send(ctx.jid, 'Use: !desempenho limitefila 4/8/12/20/30', ctx.msg);
    }
    config.maxQueue = number;
  } else if (action === 'memoria') {
    if (![512, 768, 1024].includes(number)) {
      return ctx.send(ctx.jid, 'Use: !desempenho memoria 512/768/1024', ctx.msg);
    }
    config.memoryMb = number;
    writeData(data);
    return ctx.send(ctx.jid, `🧠 Limite de heap configurado para ${number} MB. Reinicie o bot para aplicar. Isso limita o heap do Node, não toda a RAM do Android.`, ctx.msg);
  } else if (action === 'cache') {
    if (![0, 30, 60, 180, 300].includes(number)) {
      return ctx.send(ctx.jid, 'Use: !desempenho cache 0/30/60/180/300', ctx.msg);
    }
    config.cacheTtlMs = number * 1000;
    apiCache.clear();
  } else if (action === 'intervalo') {
    if (![100, 200, 250, 350, 500, 800].includes(number)) {
      return ctx.send(ctx.jid, 'Use: !desempenho intervalo 100/200/250/350/500/800', ctx.msg);
    }
    config.apiIntervalMs = number;
  } else if (action === 'reiniciar') {
    await ctx.send(ctx.jid, '🔄 Reiniciando o Léo Stickers...', ctx.msg);
    setTimeout(() => process.exit(0), 1200);
    return true;
  } else {
    return false;
  }

  writeData(data);
  return ctx.send(ctx.jid, `✅ ${action} atualizado para ${number}.`, ctx.msg);
}

async function handlePerformanceCommand(ctx) {
  if (!ctx.isOwner(ctx.sender)) {
    return ctx.send(ctx.jid, '🔒 Esse painel é exclusivo do dono do bot.', ctx.msg);
  }

  const data = readData();
  const config = data.performance;
  const runtime = getRuntimeInfo();
  const queue = getDownloadQueueStatus();

  const cacheSize = apiCache.size;
  const active = queue.active || 'Nenhum';
  const waiting = queue.waiting ?? 0;

  const message =
    `⚙️ *PAINEL DE DESEMPENHO — LÉO STICKERS*\n\n` +
    `📱 *AMBIENTE*\n` +
    `• Host: ${runtime.host}\n• Fabricante: ${runtime.manufacturer}\n• Modelo do equipamento: ${runtime.device}\n• Processador: ${runtime.cpuModel}\n• CPUs lógicas detectadas: ${runtime.hostCpus}\n• Limite de CPU: ${runtime.cpuLimit}\n• Container: ${runtime.container}\n• Sistema/distribuição: ${runtime.distro}\n• Limite de RAM do container: ${runtime.memoryLimit}\n` +
    `• Sistema: ${runtime.platform} ${runtime.release}\n` +
    `• Arquitetura: ${runtime.arch}\n` +
    `• CPUs disponíveis para o bot: ${runtime.cpus}\n` +
    `• Node.js: ${runtime.node}\n` +
    `• Ligado há: ${runtime.uptime}\n\n` +
    `🧠 *MEMÓRIA*\n` +
    `• Processo: ${runtime.rss}\n` +
    `• Heap usado: ${runtime.heapUsed}\n` +
    `• Heap total: ${runtime.heapTotal}\n` +
    `• Limite do heap: ${runtime.heapLimit}\n` +
    `• RAM disponível ao ambiente: ${runtime.systemTotal}\n` +
    `• RAM livre: ${runtime.systemFree}\n\n` +
    `📥 *FILA E CACHE*\n` +
    `• Download ativo: ${active}\n` +
    `• Aguardando: ${waiting}\n` +
    `• Itens no cache: ${cacheSize}\n\n` +
    `🛠️ *CONFIGURAÇÕES DO BOT*\n` +
    `• Limite de memória Node: ${config.memoryMb} MB\n` +
    `• Concorrência da fila: ${config.queueConcurrency}\n` +
    `• Máximo aguardando: ${config.maxQueue}\n` +
    `• Cache: ${config.cacheTtlMs / 1000}s\n` +
    `• Intervalo entre APIs: ${config.apiIntervalMs}ms\n\n` +
    `⚙️ *COMANDOS DE CONFIGURAÇÃO*\n` +
    `• !desempenho fila 1/2/3\n` +
    `• !desempenho limitefila 4/8/12/20/30\n` +
    `• !desempenho memoria 512/768/1024\n` +
    `• !desempenho cache 0/30/60/180/300\n` +
    `• !desempenho intervalo 100/200/250/350/500/800\n` +
    `• !desempenho limparcache\n` +
    `• !desempenho reset\n` +
    `• !desempenho reiniciar`;

  return ctx.send(ctx.jid, message, ctx.msg);
}

export async function handleAdvancedCommand(ctx) {
  try {
    switch (ctx.command) {
      case 'desempenho':
        if (ctx.value) {
          const handled = await handlePerformanceSetting(ctx);
          if (handled !== false) return handled;
        }
        return await handlePerformanceCommand(ctx);
      case 'menuapi':
        return ctx.send(ctx.jid,
          '🌐 *MENU DE APIS — LÉO STICKERS*\n\n' +
          '🎌 !anime nome — pesquisa anime\n' +
          '📚 !manga nome — pesquisa mangá\n' +
          '🧑‍🎤 !personagem nome — pesquisa personagem\n' +
          '🐱 !neko — imagem anime SFW\n' +
          '🌸 !waifu — imagem anime SFW\n' +
          '🎞️ !gifapi hug — GIF de anime animado\n' +
          '🐶 !cachorro — foto aleatória de cachorro\n' +
          '🌦️ !clima cidade — clima atual\n' +
          '💱 !cotacao USD BRL — câmbio de referência\n' +
          '📮 !cep 00000000 — consulta CEP\n' +
          '📞 !ddd 11 — cidades de um DDD\n' +
          '📅 !feriado — próximo feriado nacional\n' +
          '🧪 !apihealth — testa as integrações\n' +
          '🗂️ !fila — situação dos downloads\n\n' +
          '🛡️ *COMUNIDADE E AUTOMAÇÃO*\n' +
          '⭐ !rep / !darrep @pessoa / !toprep\n' +
          '💬 !autoadd palavra | resposta / !autodel / !autolist\n' +
          '⏰ !agendar 10m mensagem / !agendados / !cancelaragendamento código\n' +
          '🛡️ !antispam on/off / !cargo add @pessoa / !cargos\n\n' +
          'As APIs públicas não usam IA nem exigem chave neste módulo.', ctx.msg);
      case 'anime':
      case 'manga':
        return await sendAnimeSearch(ctx, ctx.command);
      case 'personagem':
        return await sendCharacterSearch(ctx);
      case 'neko':
      case 'waifu':
        return await sendNekosImage(ctx, ctx.command);
      case 'gifapi':
        return await sendAnimeGifLink(ctx, clean(ctx.value || 'hug', 30).toLowerCase());
      case 'cachorro':
        return await sendDog(ctx);
      case 'clima':
        return await sendWeather(ctx);
      case 'cotacao':
        return await sendExchange(ctx);
      case 'cep':
        return await sendCep(ctx);
      case 'ddd':
        return await sendDdd(ctx);
      case 'feriado':
        return await sendNextHoliday(ctx);
      case 'fila': {
        const status = getDownloadQueueStatus();
        const active = status.active ? `Downloads ativos: ${status.active}` : 'Nenhum download ativo.';
        return ctx.send(ctx.jid, `🗂️ *FILA DE DOWNLOADS*\n\n${active}\nExecutando: ${status.activeCount}/${status.concurrency}\nAguardando: ${status.waiting}/${status.maxWaiting}`, ctx.msg);
      }
      case 'apihealth': {
        await ctx.send(ctx.jid, '🧪 Testando as integrações externas...', ctx.msg);
        const tests = [
          ['Jikan', 'https://api.jikan.moe/v4/anime?q=naruto&limit=1&sfw=true'],
          ['Nekos.best', 'https://nekos.best/api/v2/neko'],
          ['Dog CEO', 'https://dog.ceo/api/breeds/image/random'],
          ['Open-Meteo', 'https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m'],
          ['Frankfurter', 'https://api.frankfurter.dev/v2/rate/usd/brl'],
          ['BrasilAPI', 'https://brasilapi.com.br/api/cep/v2/01001000']
        ];
        const lines = [];
        for (const [name, url] of tests) {
          const started = Date.now();
          try {
            await fetchJson(url, { cacheMs: 0 });
            lines.push(`✅ ${name} — ${Date.now() - started} ms`);
          } catch (error) {
            lines.push(`⚠️ ${name} — ${clean(error?.message || 'indisponível', 70)}`);
          }
        }
        return ctx.send(ctx.jid, `🧪 *TESTE DE APIS*\n\n${lines.join('\n')}\n\nServiços externos podem ficar temporariamente indisponíveis.`, ctx.msg);
      }
      case 'antispam': {
        if (!ctx.jid.endsWith('@g.us')) return ctx.send(ctx.jid, 'O antispam configurável funciona em grupos.', ctx.msg);
        if (!(await isGroupManager(ctx))) return ctx.send(ctx.jid, 'Somente administradores, moderadores cadastrados ou o dono podem alterar o antispam.', ctx.msg);
        const value = clean(ctx.value, 10).toLowerCase();
        if (!['on', 'off'].includes(value)) return ctx.send(ctx.jid, 'Uso: !antispam on ou !antispam off', ctx.msg);
        const data = readData();
        const group = groupState(data, ctx.jid);
        group.antiSpam = value === 'on';
        writeData(data);
        return ctx.send(ctx.jid, value === 'on' ? '🛡️ Antispam ativado para comandos: limite de 8 em 10 segundos.' : '⚠️ Antispam de comandos desativado neste grupo.', ctx.msg);
      }
      case 'rep':
      case 'darrep':
      case 'toprep':
        return await handleReputation(ctx);
      case 'autoadd':
      case 'autodel':
      case 'autolist':
        return await handleAutoReplyCommand(ctx);
      case 'agendar':
      case 'agendados':
      case 'cancelaragendamento':
        return await handleSchedule(ctx);
      case 'cargo':
      case 'cargos':
        return await handleGroupRoles(ctx);
      default:
        return false;
    }
  } catch (error) {
    console.error(`[LEO ADVANCED:${ctx.command}]`, error?.stack || error);
    await ctx.send(ctx.jid, `❌ Não consegui concluir esse comando: ${clean(error?.message || 'erro desconhecido', 180)}`, ctx.msg);
    return true;
  }
}
