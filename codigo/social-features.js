import { handleExtraCommand } from './extra-features.js';
import { handleAdvancedCommand } from './advanced-features.js';
import { handleCommunityCommand } from './community-features.js';
import { handlePresentationCommand } from './presentation-system.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('./figurinhas');
const DATA_FILE = path.resolve('./social-data.json');
const FAVORITES_DIR = path.resolve('./social-favorites');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(FAVORITES_DIR, { recursive: true });

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      favorites: {},
      scores: {},
      blocked: [],
      top: {},
      challenges: {},
      quiz: {}
    }, null, 2));
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {
      favorites: {},
      scores: {},
      blocked: [],
      top: {},
      challenges: {},
      quiz: {}
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeNumber(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function getUser(ctx) {
  return normalizeNumber(ctx.sender || ctx.jid);
}

function getFavoriteFile(user) {
  return path.join(FAVORITES_DIR, `${user}.json`);
}

function getFavorites(user) {
  const file = getFavoriteFile(user);

  if (!fs.existsSync(file)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveFavorites(user, favorites) {
  fs.writeFileSync(
    getFavoriteFile(user),
    JSON.stringify(favorites, null, 2)
  );
}

function ensureData() {
  const data = readData();

  data.favorites ||= {};
  data.scores ||= {};
  data.blocked ||= [];
  data.top ||= {};
  data.challenges ||= {};
  data.quiz ||= {};

  return data;
}

function userJid(msg, jid) {
  return msg?.key?.participant ||
    msg?.key?.remoteJid ||
    jid;
}

function userNumber(msg, jid) {
  return normalizeNumber(userJid(msg, jid));
}

function addPoints(data, user, points = 1) {
  data.scores[user] = (data.scores[user] || 0) + points;
  saveData(data);
}

function recordUse(data, id) {
  if (!id) return;

  data.top[id] = (data.top[id] || 0) + 1;
  saveData(data);
}

async function sendSticker(ctx, buffer) {
  if (!buffer) {
    throw new Error('Figurinha sem conteúdo.');
  }

  await ctx.sock.sendMessage(
    ctx.jid,
    { sticker: buffer },
    { quoted: ctx.msg }
  );
}

async function runFFmpeg(buffer, args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      ...args,
      'pipe:1'
    ]);

    const chunks = [];
    const errors = [];

    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', chunk => errors.push(chunk));

    ffmpeg.on('error', reject);

    ffmpeg.on('close', code => {
      if (code !== 0) {
        return reject(
          new Error(Buffer.concat(errors).toString() || 'Erro no FFmpeg.')
        );
      }

      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdin.end(buffer);
  });
}

async function sendLibraryItems(ctx, items) {
  let sent = 0;

  for (const item of items) {
    try {
      const buffer = await ctx.readLibrarySticker(item.filename);
      if (!buffer) continue;

      await sendSticker(ctx, buffer);
      sent++;
    } catch (error) {
      console.error('Erro ao enviar figurinha:', error.message);
    }
  }

  return sent;
}

function getStickerId(item) {
  return String(
    item.id ||
    item.hash ||
    item.filename ||
    item.file ||
    ''
  );
}

function getStickerName(item) {
  return String(
    item.name ||
    item.title ||
    item.filename ||
    item.id ||
    'Figurinha'
  );
}

function findLibraryItem(items, query) {
  const value = String(query || '').toLowerCase().trim();

  if (!value) return null;

  return items.find(item => {
    return getStickerId(item) === value ||
      getStickerName(item).toLowerCase().includes(value);
  });
}

function randomItems(items, amount) {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy.slice(0, amount);
}

function safeFilename(name) {
  return String(name || 'figurinha')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
}

async function favoriteCommand(ctx, data) {
  const user = getUser(ctx);
  const items = ctx.items || [];
  const query = ctx.value || '';

  const item = findLibraryItem(items, query);

  if (!item) {
    return ctx.send(
      ctx.jid,
      '⭐ Responda a uma figurinha ou informe o nome dela para favoritar.',
      ctx.msg
    );
  }

  const id = getStickerId(item);
  if (!id) {
    return ctx.send(ctx.jid, 'Não consegui identificar essa figurinha.', ctx.msg);
  }

  const favorites = getFavorites(user);

  if (favorites.includes(id)) {
    return ctx.send(ctx.jid, 'Essa figurinha já está nos seus favoritos! ⭐', ctx.msg);
  }

  favorites.push(id);
  saveFavorites(user, favorites);

  return ctx.send(ctx.jid, '⭐ Figurinha adicionada aos seus favoritos!', ctx.msg);
}

async function favoritesCommand(ctx) {
  const user = getUser(ctx);
  const favorites = getFavorites(user);
  const items = ctx.items || [];

  if (!favorites.length) {
    return ctx.send(ctx.jid, 'Você ainda não tem figurinhas favoritas.', ctx.msg);
  }

  const selected = favorites
    .map(id => items.find(item => getStickerId(item) === id))
    .filter(Boolean);

  if (!selected.length) {
    return ctx.send(ctx.jid, 'Seus favoritos não foram encontrados na biblioteca.', ctx.msg);
  }

  const sent = await sendLibraryItems(ctx, selected);

  return ctx.send(
    ctx.jid,
    `⭐ Foram enviadas ${sent} de ${selected.length} figurinhas favoritas.`,
    ctx.msg
  );
}

async function removeFavoriteCommand(ctx) {
  const user = getUser(ctx);
  const query = String(ctx.value || '').trim();

  if (!query) {
    return ctx.send(
      ctx.jid,
      'Informe o nome ou ID da figurinha que deseja retirar dos favoritos.',
      ctx.msg
    );
  }

  const favorites = getFavorites(user);
  const index = favorites.indexOf(query);

  if (index === -1) {
    return ctx.send(ctx.jid, 'Essa figurinha não está nos seus favoritos.', ctx.msg);
  }

  favorites.splice(index, 1);
  saveFavorites(user, favorites);

  return ctx.send(ctx.jid, 'Figurinha removida dos favoritos.', ctx.msg);
}

async function rankingCommand(ctx, data) {
  const ranking = Object.entries(data.scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (!ranking.length) {
    return ctx.send(ctx.jid, 'Ainda não há participantes no ranking.', ctx.msg);
  }

  const lines = ranking.map(([user, points], index) => {
    const number = normalizeNumber(user);
    const name = data.names?.[number];
    const display = name || number || 'Participante';
    return `${index + 1}. ${display} — ${points} pontos`;
  });

  return ctx.send(
    ctx.jid,
    `🏆 RANKING LÉO STICKERS\n\n${lines.join('\n')}`,
    ctx.msg
  );
}

async function topCommand(ctx, data) {
  const ranking = Object.entries(data.top)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (!ranking.length) {
    return ctx.send(ctx.jid, 'Ainda não há dados de uso das figurinhas.', ctx.msg);
  }

  const lines = ranking.map(([id, count], index) => {
    const item = findLibraryItem(ctx.items || [], id);
    const name = item ? getStickerName(item) : id;
    return `${index + 1}. ${name} — ${count} usos`;
  });

  return ctx.send(
    ctx.jid,
    `🔥 FIGURINHAS MAIS USADAS\n\n${lines.join('\n')}`,
    ctx.msg
  );
}

async function packCommand(ctx) {
  const items = ctx.items || [];
  const theme = String(ctx.value || '').toLowerCase().trim();

  if (!theme) {
    return ctx.send(
      ctx.jid,
      '📦 Informe um tema. Exemplo: !pack animais',
      ctx.msg
    );
  }

  const selected = items.filter(item => {
    const name = getStickerName(item).toLowerCase();
    return name.includes(theme);
  });

  if (!selected.length) {
    return ctx.send(
      ctx.jid,
      `Não encontrei figurinhas com o tema "${theme}".`,
      ctx.msg
    );
  }

  const sent = await sendLibraryItems(ctx, selected.slice(0, 20));

  return ctx.send(
    ctx.jid,
    `📦 COLEÇÃO: ${theme.toUpperCase()}\nEnviei ${sent} figurinhas.`,
    ctx.msg
  );
}

async function challengeCommand(ctx, data) {
  const user = getUser(ctx);
  const themes = [
    'Animais',
    'Comida',
    'Memes',
    'Desenhos',
    'Esportes',
    'Música',
    'Filmes',
    'Expressões',
    'Natureza',
    'Objetos'
  ];

  const today = new Date().toISOString().slice(0, 10);
  const current = data.challenges[ctx.jid];

  if (ctx.value === 'feito') {
    if (!current || current.date !== today) {
      return ctx.send(
        ctx.jid,
        'Não existe um desafio ativo para concluir.',
        ctx.msg
      );
    }

    if (current.completed?.includes(user)) {
      return ctx.send(
        ctx.jid,
        'Você já recebeu os pontos deste desafio!',
        ctx.msg
      );
    }

    current.completed ||= [];
    current.completed.push(user);
    addPoints(data, user, 5);

    return ctx.send(
      ctx.jid,
      '🎉 Desafio concluído! Você ganhou 5 pontos.',
      ctx.msg
    );
  }

  const theme = themes[Math.floor(Math.random() * themes.length)];

  data.challenges[ctx.jid] = {
    theme,
    date: today,
    completed: []
  };

  saveData(data);

  return ctx.send(
    ctx.jid,
    `🎯 DESAFIO DE FIGURINHAS\n\nTema: ${theme}\n\nEnvie uma figurinha desse tema!\nUse !desafio feito quando terminar.`,
    ctx.msg
  );
}

async function quizCommand(ctx, data) {
  const questions = [
    {
      question: 'Qual formato é normalmente usado pelas figurinhas animadas do WhatsApp?',
      options: ['A) PNG', 'B) WebP', 'C) JPG'],
      answer: 'b'
    },
    {
      question: 'Qual destes é um formato de imagem?',
      options: ['A) PNG', 'B) MP3', 'C) TXT'],
      answer: 'a'
    },
    {
      question: 'Qual programa é usado para converter mídias neste bot?',
      options: ['A) FFmpeg', 'B) Bloco de notas', 'C) Calculadora'],
      answer: 'a'
    },
    {
      question: 'Qual é o mascote do Léo Stickers?',
      options: ['A) Gato', 'B) Raposa', 'C) Leão'],
      answer: 'b'
    }
  ];

  const user = getUser(ctx);
  const answer = String(ctx.value || '').toLowerCase().trim();
  const active = data.quiz[ctx.jid];

  if (active && answer) {
    if (active.user !== user) {
      return ctx.send(
        ctx.jid,
        'Este quiz foi iniciado por outra pessoa. Aguarde a próxima pergunta.',
        ctx.msg
      );
    }

    if (answer === active.answer) {
      addPoints(data, user, 3);
      delete data.quiz[ctx.jid];

      return ctx.send(
        ctx.jid,
        '✅ Resposta correta! Você ganhou 3 pontos!',
        ctx.msg
      );
    }

    delete data.quiz[ctx.jid];

    return ctx.send(
      ctx.jid,
      `❌ Não foi dessa vez! A resposta correta era ${active.answer.toUpperCase()}.`,
      ctx.msg
    );
  }

  const question = questions[Math.floor(Math.random() * questions.length)];

  data.quiz[ctx.jid] = {
    user,
    answer: question.answer
  };

  saveData(data);

  return ctx.send(
    ctx.jid,
    `🧠 QUIZ LÉO STICKERS\n\n${question.question}\n\n${question.options.join('\n')}\n\nResponda com !quiz a, !quiz b ou !quiz c.`,
    ctx.msg
  );
}

async function rouletteCommand(ctx) {
  const participants = new Map();
  const mentions = ctx.msg?.message?.extendedTextMessage
    ?.contextInfo?.mentionedJid || [];

  for (const jid of mentions) {
    const number = normalizeNumber(jid);
    if (number) participants.set(number, jid);
  }

  const sender = getUser(ctx);
  if (sender) participants.set(sender, sender);

  const list = [...participants.keys()];

  if (list.length < 2) {
    return ctx.send(
      ctx.jid,
      '🎡 Marque pelo menos outra pessoa para participar da roleta.',
      ctx.msg
    );
  }

  const winner = list[Math.floor(Math.random() * list.length)];

  return ctx.send(
    ctx.jid,
    `🎡 ROLETA LÉO STICKERS\n\nParticipantes: ${list.length}\n\n🏆 Sorteado: @${winner}`,
    ctx.msg,
    { mentions: [participants.get(winner)] }
  );
}

async function textStickerCommand(ctx) {
  const text = String(ctx.value || '').trim();

  if (!text) {
    return ctx.send(
      ctx.jid,
      '✍️ Escreva o texto da figurinha. Exemplo: !texto Bom dia!',
      ctx.msg
    );
  }

  const safeText = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .slice(0, 150);

  const buffer = await runFFmpeg(
    Buffer.from(''),
    [
      '-f', 'lavfi',
      '-i', 'color=c=white@0.0:s=512x512:d=1',
      '-vf',
      `drawtext=text='${safeText}':fontcolor=black:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=white@0.8:boxborderw=18,format=yuva420p`,
      '-frames:v', '1',
      '-c:v', 'libwebp',
      '-quality', '80',
      '-f', 'webp'
    ]
  );

  await sendSticker(ctx, buffer);

  return ctx.send(ctx.jid, '✍️ Figurinha de texto criada!', ctx.msg);
}

async function frameStickerCommand(ctx) {
  const target = ctx.target;

  if (!target) {
    return ctx.send(
      ctx.jid,
      '🖼️ Responda a uma imagem ou figurinha com !moldura.',
      ctx.msg
    );
  }

  const buffer = await ctx.getMedia(target);

  if (!buffer) {
    return ctx.send(ctx.jid, 'Não consegui baixar essa mídia.', ctx.msg);
  }

  const output = await runFFmpeg(
    buffer,
    [
      '-vf',
      'scale=440:440:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,drawbox=x=4:y=4:w=504:h=504:color=gold:t=12,format=yuva420p',
      '-frames:v', '1',
      '-c:v', 'libwebp',
      '-quality', '80',
      '-f', 'webp'
    ]
  );

  await sendSticker(ctx, output);

  return ctx.send(ctx.jid, '🖼️ Moldura aplicada!', ctx.msg);
}

const commandCooldowns = new Map();

function checkSocialAccess(ctx, data) {
  const user = getUser(ctx);
  const owner = typeof ctx.isOwner === 'function' &&
    ctx.isOwner(ctx.sender || ctx.jid);

  if (data.blocked.includes(user) && !owner) {
    return {
      allowed: false,
      reason: '🚫 Você está bloqueado de usar os recursos sociais do bot.'
    };
  }

  const key = `${ctx.jid}:${user}`;
  const now = Date.now();
  const last = commandCooldowns.get(key) || 0;

  if (now - last < 1000 && !owner) {
    return {
      allowed: false,
      reason: '⏳ Aguarde um instante antes de enviar outro comando.'
    };
  }

  commandCooldowns.set(key, now);

  return { allowed: true };
}


const pendingGroupBans = new Map();

function getCommandMentions(msg) {
  let message = msg?.message;

  for (let i = 0; i < 6 && message; i++) {
    const types = [
      'extendedTextMessage',
      'imageMessage',
      'videoMessage',
      'documentMessage'
    ];

    for (const type of types) {
      const context = message[type]?.contextInfo;
      if (context?.mentionedJid?.length) {
        return context.mentionedJid;
      }
    }

    if (message.ephemeralMessage?.message) {
      message = message.ephemeralMessage.message;
    } else if (message.viewOnceMessage?.message) {
      message = message.viewOnceMessage.message;
    } else if (message.viewOnceMessageV2?.message) {
      message = message.viewOnceMessageV2.message;
    } else {
      break;
    }
  }

  return [];
}


function normalizeIdentityJid(value) {
  const raw = String(value || '').trim().toLowerCase();

  if (!raw) return '';

  const at = raw.lastIndexOf('@');

  if (at === -1) {
    const number = raw.split(':')[0].replace(/\D/g, '');
    return number ? number + '@s.whatsapp.net' : '';
  }

  const user = raw.slice(0, at).split(':')[0];
  const domain = raw.slice(at);

  return user + domain;
}

function getIdentityAliases(...values) {
  const aliases = new Set();

  function add(value) {
    if (!value) return;

    if (typeof value === 'object') {
      add(value.id);
      add(value.jid);
      add(value.lid);
      add(value.phoneNumber);
      add(value.participant);
      return;
    }

    const normalized = normalizeIdentityJid(value);

    if (normalized) aliases.add(normalized);
  }

  for (const value of values) add(value);

  return aliases;
}

function identitiesMatch(first, second) {
  for (const identity of first) {
    if (second.has(identity)) return true;
  }

  return false;
}

async function getGroupAdminContext(ctx) {
  if (!ctx.jid.endsWith('@g.us')) {
    await ctx.send(ctx.jid, '❌ Este comando só funciona em grupos.', ctx.msg);
    return null;
  }

  const metadata = await ctx.sock.groupMetadata(ctx.jid);
  const participants = metadata.participants || [];

  const messageKey = ctx.msg?.key || {};

  const senderAliases = getIdentityAliases(
    ctx.sender,
    messageKey.participant,
    messageKey.participantAlt,
    messageKey.remoteJidAlt
  );

  const botAliases = getIdentityAliases(
    ctx.sock.user?.id,
    ctx.sock.user?.lid,
    ctx.sock.user?.phoneNumber
  );

  const sender = participants.find(participant => {
    const participantAliases = getIdentityAliases(participant);
    return identitiesMatch(senderAliases, participantAliases);
  });

  const bot = participants.find(participant => {
    const participantAliases = getIdentityAliases(participant);
    return identitiesMatch(botAliases, participantAliases);
  });

  const isAdmin = participant =>
    participant?.admin === 'admin' ||
    participant?.admin === 'superadmin';

  if (!sender || !isAdmin(sender)) {
    await ctx.send(
      ctx.jid,
      '❌ Não consegui confirmar que você é administrador deste grupo.',
      ctx.msg
    );
    return null;
  }

  if (!bot || !isAdmin(bot)) {
    await ctx.send(
      ctx.jid,
      '❌ Preciso ser administrador do grupo para executar esta ação.',
      ctx.msg
    );
    return null;
  }

  return { metadata, participants, sender, bot };
}

async function resolveMassMentionTargets(ctx, metadata) {
  const participants = metadata.participants || [];
  const mode = metadata.addressingMode || 'lid';
  const mapping = ctx.sock?.signalRepository?.lidMapping;
  const targets = [];
  for (const participant of participants) {
    const id = participant.id || participant.jid || participant.lid;
    if (!id) continue;
    let pn = participant.phoneNumber || (String(participant.jid || '').endsWith('@s.whatsapp.net') ? participant.jid : null);
    if (!pn && String(id).endsWith('@lid') && typeof mapping?.getPNForLID === 'function') {
      try { pn = await mapping.getPNForLID(id); } catch {}
    }
    let lid = participant.lid || (String(id).endsWith('@lid') ? id : null);
    if (!lid && String(id).endsWith('@s.whatsapp.net') && typeof mapping?.getLIDForPN === 'function') {
      try { lid = await mapping.getLIDForPN(id); } catch {}
    }
    const mentionJid = mode === 'pn' ? (pn || id) : (lid || id);
    const displayJid = mentionJid;
    const local = String(displayJid).split('@')[0].split(':')[0];
    if (mentionJid && local) targets.push({ mentionJid, label: '@' + local });
  }
  return targets;
}

async function markAllCommand(ctx) {
  const adminContext = await getGroupAdminContext(ctx);
  if (!adminContext) return;

  const metadata = adminContext.metadata;
  const participants = metadata.participants || [];

  if (!participants.length) {
    return ctx.send(ctx.jid, 'Não consegui encontrar os participantes.', ctx.msg);
  }

  const resolved = await resolveMassMentionTargets(ctx, metadata);
  const mentions = resolved.map(item => item.mentionJid);
  const visibleMentions = resolved.map(item => item.label);

  if (!mentions.length) {
    return ctx.send(ctx.jid, 'Não consegui resolver os identificadores dos participantes.', ctx.msg);
  }

  const message = ctx.value.trim() || 'Atenção, pessoal!';
  const body = '📢 ' + message + '\n\n' + visibleMentions.join(' ');

  return ctx.send(ctx.jid, body, ctx.msg, { mentions });
}

async function markInvisibleCommand(ctx) {
  const adminContext = await getGroupAdminContext(ctx);
  if (!adminContext) return;

  const metadata = adminContext.metadata;
  const resolved = await resolveMassMentionTargets(ctx, metadata);
  const mentions = resolved.map(item => item.mentionJid);

  if (!mentions.length) {
    return ctx.send(ctx.jid, 'Não consegui encontrar os participantes.', ctx.msg);
  }

  const message = ctx.value.trim() || 'Atenção, pessoal!';
  const body = '📢 ' + message;

  return ctx.send(ctx.jid, body, ctx.msg, { mentions });
}

async function banCommand(ctx) {
  const adminContext = await getGroupAdminContext(ctx);
  if (!adminContext) return;

  const senderNumber = normalizeNumber(ctx.sender);
  const pendingKey = ctx.jid + ':' + senderNumber;
  const action = ctx.value.trim().toLowerCase();

  if (action === 'cancelar') {
    if (!pendingGroupBans.has(pendingKey)) {
      return ctx.send(ctx.jid, 'Não existe uma remoção pendente sua.', ctx.msg);
    }

    pendingGroupBans.delete(pendingKey);
    return ctx.send(ctx.jid, '✅ Remoção cancelada.', ctx.msg);
  }

  if (action === 'confirmar') {
    const pending = pendingGroupBans.get(pendingKey);

    if (!pending || Date.now() > pending.expires) {
      pendingGroupBans.delete(pendingKey);
      return ctx.send(ctx.jid, '❌ Confirmação expirada ou inexistente. Use !ban @pessoa novamente.', ctx.msg);
    }

    const fresh = await getGroupAdminContext(ctx);
    if (!fresh) return;

    const target = fresh.participants.find(
      p => normalizeNumber(p.id) === pending.targetNumber
    );

    if (!target) {
      pendingGroupBans.delete(pendingKey);
      return ctx.send(ctx.jid, 'Essa pessoa não está mais no grupo.', ctx.msg);
    }

    if (
      target.admin === 'superadmin' ||
      normalizeNumber(target.id) === normalizeNumber(ctx.sock.user?.id || '') ||
      normalizeNumber(target.id) === senderNumber
    ) {
      pendingGroupBans.delete(pendingKey);
      return ctx.send(ctx.jid, '❌ Essa pessoa não pode ser removida por este comando.', ctx.msg);
    }

    await ctx.sock.groupParticipantsUpdate(
      ctx.jid,
      [target.id],
      'remove'
    );

    pendingGroupBans.delete(pendingKey);

    return ctx.send(
      ctx.jid,
      '✅ Remoção executada para @' + target.id.split('@')[0] + '.',
      ctx.msg,
      { mentions: [target.id] }
    );
  }

  const mentioned = getCommandMentions(ctx.msg);

  if (mentioned.length !== 1) {
    return ctx.send(
      ctx.jid,
      'Uso:\n!ban @pessoa - Solicitar remoção\n!ban confirmar - Confirmar\n!ban cancelar - Cancelar',
      ctx.msg
    );
  }

  const targetNumber = normalizeNumber(mentioned[0]);
  const target = adminContext.participants.find(
    p => normalizeNumber(p.id) === targetNumber
  );

  if (!target) {
    return ctx.send(ctx.jid, '❌ Essa pessoa não foi encontrada no grupo.', ctx.msg);
  }

  if (
    target.admin === 'superadmin' ||
    normalizeNumber(target.id) === normalizeNumber(ctx.sock.user?.id || '') ||
    targetNumber === senderNumber
  ) {
    return ctx.send(ctx.jid, '❌ Não é permitido solicitar a remoção dessa pessoa.', ctx.msg);
  }

  pendingGroupBans.set(pendingKey, {
    targetNumber,
    expires: Date.now() + 90000
  });

  return ctx.send(
    ctx.jid,
    '⚠️ CONFIRMAÇÃO DE REMOÇÃO\n\nPessoa: @' +
      target.id.split('@')[0] +
      '\n\nPara executar, envie !ban confirmar.\nPara desistir, envie !ban cancelar.\n\nA confirmação expira em 90 segundos.',
    ctx.msg,
    { mentions: [target.id] }
  );
}


async function blockUser(ctx, data) {
  const owner = typeof ctx.isOwner === 'function' &&
    ctx.isOwner(ctx.sender || ctx.jid);

  if (!owner) {
    return ctx.send(
      ctx.jid,
      '🚫 Somente o dono do bot pode bloquear usuários.',
      ctx.msg
    );
  }

  const target = String(ctx.value || '').replace(/\D/g, '');

  if (!target) {
    return ctx.send(
      ctx.jid,
      'Use !bloquear número ou !bloquear remover número.',
      ctx.msg
    );
  }

  const parts = String(ctx.value).trim().split(/\s+/);
  const action = parts[0].toLowerCase();

  if (action === 'remover') {
    const number = String(parts[1] || '').replace(/\D/g, '');

    if (!number) {
      return ctx.send(ctx.jid, 'Informe o número para desbloquear.', ctx.msg);
    }

    data.blocked = data.blocked.filter(item => item !== number);
    saveData(data);

    return ctx.send(ctx.jid, `✅ Usuário ${number} desbloqueado.`, ctx.msg);
  }

  if (data.blocked.includes(target)) {
    return ctx.send(ctx.jid, 'Esse usuário já está bloqueado.', ctx.msg);
  }

  data.blocked.push(target);
  saveData(data);

  return ctx.send(ctx.jid, `🚫 Usuário ${target} bloqueado.`, ctx.msg);
}

async function removeRecentStickers(ctx) {
  const items = [...(ctx.items || [])];

  if (!items.length) {
    return ctx.send(ctx.jid, 'A biblioteca está vazia.', ctx.msg);
  }

  const libraryDir = path.resolve(ROOT, 'biblioteca');
  const catalogPath = path.join(ROOT, 'biblioteca.json');

  const recent = items
    .filter(item => item.filename)
    .sort((a, b) => {
      const dateA = Date.parse(a.createdAt || '') || 0;
      const dateB = Date.parse(b.createdAt || '') || 0;
      return dateB - dateA;
    })
    .slice(0, 3);

  if (!recent.length) {
    return ctx.send(ctx.jid, 'Não encontrei arquivos válidos para remover.', ctx.msg);
  }

  const removed = [];

  for (const item of recent) {
    const filename = String(item.filename);

    if (filename !== path.basename(filename)) continue;

    const fullPath = path.resolve(libraryDir, filename);

    if (!fullPath.startsWith(libraryDir + path.sep)) continue;

    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      removed.push(getStickerName(item));
    }
  }

  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

    if (Array.isArray(catalog.items)) {
      const removedFiles = new Set(recent.map(item => item.filename));
      catalog.items = catalog.items.filter(
        item => !removedFiles.has(item.filename)
      );
      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    }
  }

  if (!removed.length) {
    return ctx.send(ctx.jid, 'Nenhuma figurinha foi removida. Verifique os arquivos da biblioteca.', ctx.msg);
  }

  return ctx.send(
    ctx.jid,
    '🗑️ FIGURINHAS REMOVIDAS\n\n' +
      removed.map((name, i) => (i + 1) + '. ' + name).join('\n') +
      '\n\nTotal removido: ' + removed.length,
    ctx.msg
  );
}

async function removeSticker(ctx) {
  const query = String(ctx.value || '').trim();

  if (!query) {
    return ctx.send(
      ctx.jid,
      'Use !removerfig nome ou ID da figurinha.',
      ctx.msg
    );
  }

  const items = ctx.items || [];
  const item = findLibraryItem(items, query);

  if (!item) {
    return ctx.send(ctx.jid, 'Figurinha não encontrada.', ctx.msg);
  }

  const filename = String(item.filename || '');

  if (!filename || filename !== path.basename(filename)) {
    return ctx.send(
      ctx.jid,
      'Nome de arquivo inválido. Nada foi removido.',
      ctx.msg
    );
  }

  const libraryDir = path.resolve(ROOT, 'biblioteca');
  const fullPath = path.resolve(libraryDir, filename);

  if (!fullPath.startsWith(libraryDir + path.sep)) {
    return ctx.send(ctx.jid, 'Caminho inválido.', ctx.msg);
  }

  const catalogPath = path.join(ROOT, 'biblioteca.json');

  if (!fs.existsSync(fullPath)) {
    return ctx.send(ctx.jid, 'O arquivo não existe mais.', ctx.msg);
  }

  fs.unlinkSync(fullPath);

  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (Array.isArray(catalog.items)) {
      catalog.items = catalog.items.filter(
        entry => entry.filename !== filename
      );
      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    }
  }

  return ctx.send(
    ctx.jid,
    `🗑️ Figurinha removida da biblioteca: ${getStickerName(item)}`,
    ctx.msg
  );
}

function requireOwner(ctx) {
  return typeof ctx.isOwner === 'function' &&
    ctx.isOwner(ctx.sender || ctx.jid);
}

function safeTextForFFmpeg(value) {
  return String(value || '').trim().slice(0, 140)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, ' ');
}

async function imageTransform(ctx, mode) {
  if (!ctx.target) {
    return ctx.send(ctx.jid, `Responda a uma imagem ou figurinha com !${mode}.`, ctx.msg);
  }
  const input = await ctx.getMedia(ctx.target);
  if (!input) return ctx.send(ctx.jid, 'Não consegui baixar a mídia.', ctx.msg);
  let filter = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p';
  if (mode === 'espelhar') filter = 'hflip,' + filter;
  if (mode === 'inverter') filter = 'negate,' + filter;
  if (mode === 'circulo') {
    filter = "crop='min(iw,ih)':'min(iw,ih)',scale=512:512,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)',format=yuva420p";
  }
  const output = await runFFmpeg(input, [
    '-vf', filter,
    '-frames:v', '1', '-an', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp'
  ]);
  await sendSticker(ctx, output);
  return ctx.send(ctx.jid, `✅ Figurinha ${mode} criada!`, ctx.msg);
}

async function memeCommand(ctx) {
  if (!ctx.target) return ctx.send(ctx.jid, 'Responda a uma imagem com !meme texto do meme.', ctx.msg);
  const text = safeTextForFFmpeg(ctx.value);
  if (!text) return ctx.send(ctx.jid, 'Informe o texto. Exemplo: !meme EU SABIA', ctx.msg);
  const input = await ctx.getMedia(ctx.target);
  if (!input) return ctx.send(ctx.jid, 'Não consegui baixar a imagem.', ctx.msg);
  const output = await runFFmpeg(input, [
    '-vf', `scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=text='${text}':fontcolor=white:fontsize=34:borderw=3:bordercolor=black:x=(w-text_w)/2:y=18,format=yuva420p`,
    '-frames:v', '1', '-an', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp'
  ]);
  await sendSticker(ctx, output);
  return ctx.send(ctx.jid, '😂 Meme criado!', ctx.msg);
}

async function drawCommand(ctx) {
  const text = safeTextForFFmpeg(ctx.value);
  if (!text) return ctx.send(ctx.jid, 'Use !desenhar uma frase ou ideia curta.', ctx.msg);
  const output = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0xF4E7C5:s=512x512:d=1',
      '-vf', `drawbox=x=14:y=14:w=484:h=484:color=0x654321:t=8,drawtext=text='${text}':fontcolor=0x302010:fontsize=38:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=white@0.75:boxborderw=18,format=yuva420p`,
      '-frames:v', '1', '-an', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', 'pipe:1'
    ]);
    const chunks = [];
    const errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(Buffer.concat(errors).toString() || 'Falha ao desenhar a figurinha.')));
  });
  await sendSticker(ctx, output);
  return ctx.send(ctx.jid, '🎨 Figurinha ilustrada com texto criada!', ctx.msg);
}

async function myPackCommand(ctx) {
  const user = getUser(ctx);
  const favorites = getFavorites(user);
  const items = ctx.items || [];
  const animated = items.filter(item => item.animated).length;
  return ctx.send(ctx.jid,
    `📦 MEU PACK — LÉO STICKERS\n\n` +
    `Suas favoritas: ${favorites.length}\n` +
    `Biblioteca disponível: ${items.length}\n` +
    `Animadas na biblioteca: ${animated}\n\n` +
    `Use !exportarpack para receber suas favoritas em um arquivo compactado.`, ctx.msg);
}

async function exportPackCommand(ctx) {
  const user = getUser(ctx);
  const favorites = getFavorites(user);
  if (!favorites.length) return ctx.send(ctx.jid, 'Você ainda não tem favoritas. Use !favorito respondendo a uma figurinha.', ctx.msg);
  const selected = favorites.slice(0, 100);
  const tempRoot = path.resolve('./figurinhas/exports');
  const work = path.join(tempRoot, `pack-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  let copied = 0;
  const manifest = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const fav = selected[i];
      const item = (ctx.items || []).find(entry => getStickerId(entry) === String(fav.id));
      if (!item) continue;
      const buffer = ctx.readLibrarySticker(item.filename);
      const filename = `${String(copied + 1).padStart(3, '0')}.webp`;
      fs.writeFileSync(path.join(work, filename), buffer);
      manifest.push({ file: filename, title: getStickerName(item), hash: item.hash || null });
      copied++;
    }
    if (!copied) return ctx.send(ctx.jid, 'Não consegui localizar os arquivos das suas favoritas.', ctx.msg);
    fs.writeFileSync(path.join(work, 'LEIA-ME.json'), JSON.stringify({ name: 'Meu Pack Léo Stickers', owner: user, total: copied, stickers: manifest }, null, 2));
    const archive = `${work}.tar.gz`;
    const result = spawnSync('tar', ['-czf', archive, '-C', work, '.'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Falha ao compactar o pacote.');
    await ctx.sock.sendMessage(ctx.jid, {
      document: fs.readFileSync(archive),
      mimetype: 'application/gzip',
      fileName: `meu-pack-${user}.tar.gz`,
      caption: `📦 Seu pack foi exportado!\nFigurinhas: ${copied}\n\nÉ um arquivo compactado com as imagens WebP e um catálogo.`
    }, { quoted: ctx.msg });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(`${work}.tar.gz`, { force: true });
  }
}

async function randomPackCommand(ctx) {
  const items = randomItems(ctx.items || [], 10);
  if (!items.length) return ctx.send(ctx.jid, 'A biblioteca está vazia.', ctx.msg);
  const sent = await sendLibraryItems(ctx, items);
  return ctx.send(ctx.jid, `🎲 Pack aleatório enviado: ${sent}/${items.length} figurinhas.`, ctx.msg);
}

async function searchPackCommand(ctx) {
  const query = String(ctx.value || '').trim().toLowerCase();
  if (!query) return ctx.send(ctx.jid, 'Use !packbuscar termo. A busca considera origem e metadados, não nomes genéricos repetidos.', ctx.msg);
  const matches = (ctx.items || []).filter(item =>
    `${item.source || ''} ${item.title || ''} ${item.giphyId || ''}`.toLowerCase().includes(query)
  ).slice(0, 10);
  if (!matches.length) return ctx.send(ctx.jid, 'Não encontrei itens com esses metadados.', ctx.msg);
  const sent = await sendLibraryItems(ctx, matches);
  return ctx.send(ctx.jid, `🔎 Encontrei ${matches.length} figurinhas e enviei ${sent}.`, ctx.msg);
}

async function packStatsCommand(ctx) {
  const items = ctx.items || [];
  const sources = {};
  for (const item of items) sources[item.source || 'Desconhecida'] = (sources[item.source || 'Desconhecida'] || 0) + 1;
  const animated = items.filter(item => item.animated).length;
  return ctx.send(ctx.jid,
    `📊 ESTATÍSTICAS DOS PACKS\n\nFigurinhas: ${items.length}\nAnimadas: ${animated}\nEstáticas: ${items.length - animated}\n\n` +
    Object.entries(sources).map(([name, count]) => `${name}: ${count}`).join('\n'), ctx.msg);
}

async function ownerCommand(ctx) {
  if (!requireOwner(ctx)) return ctx.send(ctx.jid, '🚫 Este comando é exclusivo do dono do bot.', ctx.msg);
  const action = String(ctx.command || '').toLowerCase();
  const base = path.resolve('.');
  const backupDir = path.join(base, 'backups');
  if (action === 'painel') {
    return ctx.send(ctx.jid, '👑 PAINEL DO DONO\n\n!reiniciar\n!backup\n!restaurar nome-do-backup.tar.gz\n!usuarios\n!limparcache\n!logs\n!manutencao\n!anuncio texto\n!bloqueargrupo\n!desbloqueargrupo\n!exportarbiblioteca\n!relatoriocompleto', ctx.msg);
  }
  if (action === 'backup') {
    fs.mkdirSync(backupDir, { recursive: true });
    const filename = `leostickers-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const output = path.join(backupDir, filename);
    const entries = ['index.js','social-features.js','giphy-library.js','approved-commands.js','package.json','config.json','database.json','social-data.json','figurinhas/biblioteca','figurinhas/biblioteca.json'];
    const existing = entries.filter(entry => fs.existsSync(path.join(base, entry)));
    const result = spawnSync('tar', ['-czf', output, ...existing], { cwd: base, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Não foi possível criar o backup.');
    return ctx.send(ctx.jid, `✅ Backup criado em backups/${filename}\nSessão e .env não são incluídos.`, ctx.msg);
  }
  if (action === 'restaurar') {
    const name = path.basename(String(ctx.value || '').trim());
    if (!name || !/^leostickers-backup-[\w.-]+\.tar\.gz$/.test(name)) return ctx.send(ctx.jid, 'Use !restaurar nome-do-backup.tar.gz', ctx.msg);
    const file = path.join(backupDir, name);
    if (!fs.existsSync(file)) return ctx.send(ctx.jid, 'Backup não encontrado na pasta backups.', ctx.msg);
    const list = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
    if (list.status !== 0) throw new Error('Arquivo de backup inválido.');
    const allowed = new Set(['index.js','social-features.js','giphy-library.js','approved-commands.js','package.json','config.json','database.json','social-data.json','figurinhas/biblioteca/','figurinhas/biblioteca.json']);
    const paths = list.stdout.split('\n').filter(Boolean).map(x => x.replace(/^\.\//, '').replace(/\/$/, ''));
    if (paths.some(x => ![...allowed].some(a => x === a || x.startsWith(a + '/')))) throw new Error('O backup contém caminhos não autorizados.');
    const result = spawnSync('tar', ['-xzf', file, '-C', base, '--no-same-owner'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Falha ao restaurar.');
    return ctx.send(ctx.jid, '✅ Backup restaurado. Recomendo reiniciar o bot para carregar os arquivos atualizados.', ctx.msg);
  }
  if (action === 'usuarios') {
    let db = {};
    try { db = JSON.parse(fs.readFileSync(path.join(base, 'database.json'), 'utf8')); } catch {}
    let social = {};
    try { social = JSON.parse(fs.readFileSync(path.join(base, 'social-data.json'), 'utf8')); } catch {}
    const users = new Set([...Object.keys(db.users || {}), ...Object.keys(social.names || {})]);
    return ctx.send(ctx.jid, `👥 USUÁRIOS REGISTRADOS\n\nTotal: ${users.size}\n\n` + [...users].slice(0, 50).map(u => `• ${social.names?.[u] || 'Usuário'} (${u})`).join('\n'), ctx.msg);
  }
  if (action === 'limparcache') {
    const cache = path.join(base, 'figurinhas', 'cache');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    return ctx.send(ctx.jid, '🧹 Cache temporário limpo. Biblioteca preservada.', ctx.msg);
  }
  if (action === 'logs') {
    const candidates = ['logs','log'];
    const files = [];
    for (const dir of candidates) {
      const full = path.join(base, dir);
      if (fs.existsSync(full)) for (const f of fs.readdirSync(full).filter(x => x.endsWith('.log')).slice(0, 10)) files.push(`${dir}/${f}`);
    }
    return ctx.send(ctx.jid, files.length ? `📜 LOGS ENCONTRADOS\n\n${files.join('\n')}` : 'Ainda não existem arquivos .log salvos. Os registros atuais aparecem no terminal do Termux.', ctx.msg);
  }
  if (action === 'reiniciar') {
    await ctx.send(ctx.jid, '🔄 Reiniciando o Léo Stickers...', ctx.msg);
    if (process.env.LEO_STICKERS_SUPERVISED === '1') {
      setTimeout(() => process.exit(0), 1200);
      return true;
    }
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [path.resolve(process.argv[1])], {
      cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore'
    });
    child.unref();
    setTimeout(() => process.exit(0), 1200);
    return true;
  }
}

export async function handleSocialCommand(ctx) {
  const data = ensureData();

  data.names ||= {};
  const participantNumber = getUser(ctx);
  const participantName = ctx.msg?.pushName || ctx.msg?.verifiedBizName;

  if (participantNumber && participantName) {
    data.names[participantNumber] = participantName;
    saveData(data);
  }

  const presentationHandled = await handlePresentationCommand(ctx);
  if (presentationHandled) return true;

  const access = checkSocialAccess(ctx, data);

  if (!access.allowed) {
    await ctx.send(ctx.jid, access.reason, ctx.msg);
    return true;
  }

  const communityHandled = await handleCommunityCommand(ctx); // LEO_STICKERS_COMMUNITY_COMMANDS_V1
  if (communityHandled) return true;

  const extraHandled = await handleExtraCommand(ctx);
  if (extraHandled) return true;

  const advancedHandled = await handleAdvancedCommand(ctx);
  if (advancedHandled) return true;

  switch (String(ctx.command || '').toLowerCase()) {
    case 'favorito':
      await favoriteCommand(ctx, data);
      return true;

    case 'favoritos':
      await favoritesCommand(ctx);
      return true;

    case 'desfavorito':
      await removeFavoriteCommand(ctx);
      return true;

    case 'top':
      await topCommand(ctx, data);
      return true;

    case 'ranking':
      await rankingCommand(ctx, data);
      return true;

    case 'pack':
      await packCommand(ctx);
      return true;

    case 'desafio':
      await challengeCommand(ctx, data);
      return true;

    case 'quiz':
      await quizCommand(ctx, data);
      return true;

    case 'roleta':
      await rouletteCommand(ctx);
      return true;

    case 'texto':
      await textStickerCommand(ctx);
      return true;

    case 'moldura':
      await frameStickerCommand(ctx);
      return true;

    case 'marcar': // LEO_STICKERS_MENUS_AND_MARK_COMMANDS_V1
      await markAllCommand(ctx);
      return true;

    case 'totag':
      await markInvisibleCommand(ctx);
      return true;

    case 'ban':
      await banCommand(ctx);
      return true;

    case 'bloquear':
      await blockUser(ctx, data);
      return true;

    case 'removerfigrec':
      await removeRecentStickers(ctx);
      return true;

    case 'removerfig':
      await removeSticker(ctx);
      return true;

    case 'relatorio': {
      const items = ctx.items || [];
      const animated = items.filter(item => item.animated).length;

      await ctx.send(
        ctx.jid,
        `🦊 RELATÓRIO LÉO STICKERS\n\n` +
        `Tempo ligado: ${Math.floor(process.uptime() / 60)} minutos\n` +
        `Biblioteca: ${items.length} figurinhas\n` +
        `Animadas: ${animated}\n` +
        `Estáticas: ${items.length - animated}\n` +
        `Favoritos cadastrados: ${Object.values(data.favorites).reduce((n, list) => n + list.length, 0)}\n` +
        `Participantes no ranking: ${Object.keys(data.scores).length}\n` +
        `Bloqueios: ${data.blocked.length}`,
        ctx.msg
      );
      return true;
    }

    case 'recortar':
      await handleAdvancedCommand(ctx);
      return true;

    case 'meme': await memeCommand(ctx); return true;
    case 'circulo': await imageTransform(ctx, 'circulo'); return true;
    case 'espelhar': await imageTransform(ctx, 'espelhar'); return true;
    case 'inverter': await imageTransform(ctx, 'inverter'); return true;
    case 'desenhar': await drawCommand(ctx); return true;
    case 'meupack': await myPackCommand(ctx); return true;
    case 'exportarpack': await exportPackCommand(ctx); return true;
    case 'packaleatorio': await randomPackCommand(ctx); return true;
    case 'packbuscar': await searchPackCommand(ctx); return true;
    case 'estatisticaspack': await packStatsCommand(ctx); return true;
    case 'painel': case 'reiniciar': case 'backup': case 'restaurar':
    case 'usuarios': case 'limparcache': case 'logs':
      await ownerCommand(ctx); return true;

    default:
      return false;
  }
}

export { checkSocialAccess };
