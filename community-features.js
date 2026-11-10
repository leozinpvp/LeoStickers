import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { searchGiphyGif, downloadGiphyGif } from './giphy-library.js';
import { findThematicGif } from './gif-matcher.js';

const DATA_FILE = path.resolve('./community-data.json');
let cachedData = null;

export const COUPLE_COMMANDS = [
  'casacomigo', 'aceitarcasamento', 'recusarcasamento', 'divorcio',
  'meucasal', 'casados', 'tempocasados', 'bodas', 'perfilcasal',
  'beijarpar', 'abracarpar', 'elogiarpar', 'declaracao', 'presentepar',
  'encontro', 'promessapar', 'renovarvotos', 'mimo', 'ciumes', 'sorteiodata'
];

export const COMMUNITY_COMMANDS = [
  'seradm', 'mute', 'desmute', 'unmute', 'desmutar', 'ship',
  ...COUPLE_COMMANDS
];
const COUPLE_IMAGE_DIR = path.resolve('./assets/casal');
export const COUPLE_GIF_QUERIES = Object.freeze({
  aceitarcasamento: ['anime couple happy wedding yes', 'anime wedding celebration couple'],
  recusarcasamento: ['anime gentle rejection embarrassed reaction', 'anime heartbreak sad reaction'],
  divorcio: ['anime couple breakup dramatic scene', 'anime dramatic farewell scene'],
  meucasal: ['anime couple holding hands cute scene', 'anime romantic couple together'],
  casados: ['anime wedding couple celebration', 'anime married couple cute scene'],
  tempocasados: ['anime couple anniversary celebration', 'anime couple growing old together'],
  bodas: ['anime wedding anniversary flowers couple', 'anime couple anniversary happy'],
  perfilcasal: ['anime couple profile heart romantic', 'anime couple cute pose together'],
  beijarpar: ['anime couple kiss scene', 'anime romantic kiss'],
  abracarpar: ['anime couple hug scene', 'anime friends warm hug'],
  elogiarpar: ['anime blushing after compliment couple', 'anime shy romantic reaction'],
  declaracao: ['anime love confession scene', 'anime romantic confession under stars'],
  presentepar: ['anime couple giving present surprise', 'anime gift surprise reaction'],
  encontro: ['anime couple date scene', 'anime romantic date night'],
  promessapar: ['anime pinky promise couple scene', 'anime couple promise friendship'],
  renovarvotos: ['anime wedding vow renewal couple', 'anime romantic promise couple'],
  mimo: ['anime cute couple affection scene', 'anime couple caring for each other'],
  ciumes: ['anime jealous girlfriend funny reaction', 'anime jealous boyfriend reaction'],
  sorteiodata: ['anime couple lucky date reaction', 'anime romantic date idea scene']
});

function validCoupleMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.length <= 8 * 1024 * 1024 && buffer.subarray(4, 8).toString() === 'ftyp';
}

async function getCoupleGif(command) {
  const rawQueries = COUPLE_GIF_QUERIES[command];
  const queries = (Array.isArray(rawQueries) ? rawQueries : [rawQueries]).filter(Boolean);
  if (!queries.length) return null;

  const cachePath = path.resolve('./gifs/cache', `casal-anime-v5-${command}.mp4`);
  try {
    const cache = fs.readFileSync(cachePath);
    if (validCoupleMp4(cache)) return cache;
    fs.rmSync(cachePath, { force: true });
  } catch {}

  let lastError = null;
  for (const query of queries) {
    try {
      const results = await searchGiphyGif(query);
      const result = findThematicGif(results, query);
      if (!result) continue;
      const buffer = await downloadGiphyGif(result);
      if (!validCoupleMp4(buffer)) throw new Error('GIF de casal retornou um MP4 inválido.');
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, buffer);
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function sendCoupleMedia(ctx, command, caption, mentions = [], imageName = null) {
  // Comando com arte personalizada: envia somente a imagem. Não acrescenta GIF genérico.
  if (imageName) {
    const imagePath = path.join(COUPLE_IMAGE_DIR, imageName);
    try {
      const image = fs.readFileSync(imagePath);
      await ctx.sock.sendMessage(ctx.jid, {
        image,
        caption,
        ...(mentions.length ? { mentions } : {})
      }, { quoted: ctx.msg });
      return true;
    } catch (error) {
      console.warn(`[IMAGEM CASAL ${command}]`, String(error?.message || error).slice(0, 180));
      await ctx.send(ctx.jid, caption, ctx.msg, mentions.length ? { mentions } : {});
      return true;
    }
  }

  try {
    const gif = await getCoupleGif(command);
    if (gif) {
      await ctx.sock.sendMessage(ctx.jid, {
        video: gif,
        mimetype: 'video/mp4',
        gifPlayback: true,
        caption,
        ...(mentions.length ? { mentions } : {})
      }, { quoted: ctx.msg });
      return true;
    }
  } catch (error) {
    console.warn(`[GIF CASAL ${command}]`, String(error?.message || error).slice(0, 180));
  }
  await ctx.send(ctx.jid, caption, ctx.msg, mentions.length ? { mentions } : {});
  return true;
}
// LEO_COUPLE_MEDIA_ANIME_V2



function loadData() {
  if (cachedData) return cachedData;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    cachedData = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cachedData = {};
  }
  cachedData.groups ||= {};
  return cachedData;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  cachedData = data;
}

function normalizeIdentity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  if (at < 0) {
    const digits = raw.split(':')[0].replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
  }
  return `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`;
}

function identityAliases(...values) {
  const aliases = new Set();
  const add = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['id', 'jid', 'lid', 'phoneNumber', 'participant', 'participantAlt']) {
        add(value[key]);
      }
      return;
    }
    const normalized = normalizeIdentity(value);
    if (normalized) aliases.add(normalized);
  };
  for (const value of values) add(value);
  return aliases;
}

function aliasesMatch(first, second) {
  for (const alias of first) if (second.has(alias)) return true;
  return false;
}

function isAdmin(participant) {
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

function unwrapMessage(message) {
  let current = message || {};
  for (let i = 0; i < 10 && current; i++) {
    const next = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message ||
      current.editedMessage?.message ||
      current.messageContextInfo?.message;
    if (!next) break;
    current = next;
  }
  return current || {};
}

function mentionedJids(msg) {
  const message = unwrapMessage(msg?.message);
  const found = [];
  for (const type of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage']) {
    const context = message[type]?.contextInfo;
    if (Array.isArray(context?.mentionedJid)) found.push(...context.mentionedJid);
  }
  return [...new Set(found.filter(Boolean))];
}

function quotedParticipant(msg) {
  const message = unwrapMessage(msg?.message);
  for (const type of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage']) {
    const context = message[type]?.contextInfo;
    if (context?.quotedMessage && context?.participant) return context.participant;
  }
  return null;
}

function participantFor(aliases, participants) {
  return (participants || []).find(participant =>
    aliasesMatch(aliases, identityAliases(participant))
  ) || null;
}

function participantProfile(participant) {
  if (!participant) return null;
  const aliases = [...identityAliases(participant)];
  const jid = String(participant.id || participant.jid || participant.lid || participant.phoneNumber || '');
  if (!jid || !aliases.length) return null;
  const numberSource = participant.phoneNumber || participant.jid || participant.id || participant.lid || '';
  const number = String(numberSource).split('@')[0].split(':')[0].replace(/\D/g, '');
  return { jid, aliases, tag: `@${number || String(jid).split('@')[0]}` };
}

function senderAliases(ctx) {
  const key = ctx.msg?.key || {};
  return identityAliases(ctx.sender, key.participant, key.participantAlt, key.remoteJidAlt);
}

function botAliases(sock) {
  return identityAliases(sock?.user?.id, sock?.user?.lid, sock?.user?.phoneNumber);
}

async function groupContext(ctx) {
  if (!String(ctx.jid || '').endsWith('@g.us')) {
    await ctx.send(ctx.jid, '❌ Este comando só funciona em grupos.', ctx.msg);
    return null;
  }
  const metadata = await ctx.sock.groupMetadata(ctx.jid);
  const participants = metadata.participants || [];
  const sender = participantFor(senderAliases(ctx), participants);
  const bot = participantFor(botAliases(ctx.sock), participants);
  return { metadata, participants, sender, bot };
}

async function requireGroupAdmin(ctx, requireBot = true) {
  const group = await groupContext(ctx);
  if (!group) return null;
  if (!isAdmin(group.sender)) {
    await ctx.send(ctx.jid, '❌ Somente administradores do grupo podem usar este comando.', ctx.msg);
    return null;
  }
  if (requireBot && !isAdmin(group.bot)) {
    await ctx.send(ctx.jid, '❌ Preciso ser administrador do grupo para executar esta ação.', ctx.msg);
    return null;
  }
  return group;
}

function groupData(data, jid) {
  data.groups ||= {};
  data.groups[jid] ||= {};
  const group = data.groups[jid];
  group.muted ||= [];
  group.couples ||= [];
  group.proposals ||= [];
  return group;
}

function getTargetProfiles(ctx, participants) {
  const mentioned = mentionedJids(ctx.msg);
  if (!mentioned.length) {
    const quoted = quotedParticipant(ctx.msg);
    if (quoted) mentioned.push(quoted);
  }
  const targets = [];
  const visibleTags = String(ctx.value || '').match(/@[\p{L}\p{N}_.-]+/gu) || [];
  for (const jid of mentioned) {
    const participant = participantFor(identityAliases(jid), participants);
    const profile = participantProfile(participant);
    if (profile && !targets.some(item => aliasesMatch(new Set(item.aliases), new Set(profile.aliases)))) {
      if (visibleTags[targets.length]) profile.tag = visibleTags[targets.length];
      targets.push(profile);
    }
  }
  return targets;
}

function findMuted(group, aliases) {
  return group.muted.findIndex(record => aliasesMatch(aliases, new Set(record.aliases || [])));
}

async function muteCommand(ctx, remove = false) {
  const group = await requireGroupAdmin(ctx, true);
  if (!group) return true;
  const targets = getTargetProfiles(ctx, group.participants);
  if (targets.length !== 1) {
    await ctx.send(ctx.jid, `Use !${remove ? 'desmute' : 'mute'} @pessoa (ou responda à mensagem dela).`, ctx.msg);
    return true;
  }

  const target = group.participants.find(participant =>
    aliasesMatch(new Set(targets[0].aliases), identityAliases(participant))
  );
  if (!target) {
    await ctx.send(ctx.jid, '❌ Não consegui identificar essa pessoa no grupo.', ctx.msg);
    return true;
  }
  if (!remove && isAdmin(target)) {
    await ctx.send(ctx.jid, '❌ Para evitar conflito de permissões, não é possível mutar um administrador.', ctx.msg);
    return true;
  }
  if (aliasesMatch(new Set(targets[0].aliases), botAliases(ctx.sock))) {
    await ctx.send(ctx.jid, '❌ Não é possível mutar o próprio bot.', ctx.msg);
    return true;
  }

  const data = loadData();
  const record = groupData(data, ctx.jid);
  const index = findMuted(record, new Set(targets[0].aliases));

  if (remove) {
    if (index < 0) {
      await ctx.send(ctx.jid, `${targets[0].tag} não está mutado(a).`, ctx.msg, { mentions: [target.id] });
      return true;
    }
    record.muted.splice(index, 1);
    saveData(data);
    await ctx.send(ctx.jid, `🔊 ${targets[0].tag} foi desmutado(a).`, ctx.msg, { mentions: [target.id] });
    return true;
  }

  if (index >= 0) {
    await ctx.send(ctx.jid, `${targets[0].tag} já está mutado(a).`, ctx.msg, { mentions: [target.id] });
    return true;
  }

  record.muted.push({
    jid: targets[0].jid,
    aliases: targets[0].aliases,
    addedAt: new Date().toISOString(),
    addedBy: [...senderAliases(ctx)][0] || ''
  });
  saveData(data);
  await ctx.send(
    ctx.jid,
    `🔇 ${targets[0].tag} foi mutado(a). As próximas mensagens dessa pessoa serão apagadas enquanto o bot continuar administrador. Use !desmute para liberar.`,
    ctx.msg,
    { mentions: [target.id] }
  );
  return true;
}

async function serAdmCommand(ctx) {
  if (!ctx.isOwner?.(ctx.sender || ctx.jid)) {
    await ctx.send(ctx.jid, '🚫 Somente o dono do Léo Stickers pode usar !seradm.', ctx.msg);
    return true;
  }
  const group = await groupContext(ctx);
  if (!group) return true;
  if (!group.sender) {
    await ctx.send(ctx.jid, '❌ Não consegui localizar o dono entre os participantes deste grupo.', ctx.msg);
    return true;
  }
  if (!isAdmin(group.bot)) {
    await ctx.send(ctx.jid, '❌ Preciso ser administrador para promover o dono do bot.', ctx.msg);
    return true;
  }
  if (isAdmin(group.sender)) {
    await ctx.send(ctx.jid, '👑 O dono do bot já é administrador deste grupo.', ctx.msg);
    return true;
  }
  const result = await ctx.sock.groupParticipantsUpdate(ctx.jid, [group.sender.id], 'promote');
  if (Array.isArray(result) && result.some(item => item?.status && Number(item.status) !== 200)) {
    await ctx.send(ctx.jid, '❌ O WhatsApp não confirmou a promoção do dono. Confira se ainda tenho permissão de administrador.', ctx.msg);
    return true;
  }
  await ctx.send(ctx.jid, `👑 Solicitação de promoção enviada para ${participantProfile(group.sender)?.tag || 'o dono'}.`, ctx.msg, { mentions: [group.sender.id] });
  return true;
}

function coupleFor(group, aliases) {
  return group.couples.find(couple =>
    aliasesMatch(aliases, new Set(couple.a?.aliases || [])) ||
    aliasesMatch(aliases, new Set(couple.b?.aliases || []))
  ) || null;
}

function partnerIn(couple, aliases) {
  if (aliasesMatch(aliases, new Set(couple.a?.aliases || []))) return couple.b;
  if (aliasesMatch(aliases, new Set(couple.b?.aliases || []))) return couple.a;
  return null;
}

function daysTogether(startedAt) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 'data não disponível';
  const days = Math.max(0, Math.floor((Date.now() - start) / 86400000));
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const rest = days - years * 365 - months * 30;
  const parts = [];
  if (years) parts.push(`${years} ano(s)`);
  if (months) parts.push(`${months} mês(es)`);
  parts.push(`${rest} dia(s)`);
  return parts.join(', ');
}

function getCompatibility(groupJid, first, second) {
  const ids = [first.jid, second.jid].sort();
  const digest = crypto.createHash('sha256').update(`${groupJid}|${ids.join('|')}`).digest();
  return digest.readUInt32BE(0) % 101;
}

function compatibilityText(percent) {
  if (percent >= 90) return '💘 Um casal lendário!';
  if (percent >= 75) return '💕 Tem muita química!';
  if (percent >= 55) return '💗 Pode dar muito certo!';
  if (percent >= 35) return '💛 Uma amizade com potencial?';
  return '😂 Melhor começar pela amizade!';
}

async function shipCommand(ctx) {
  const group = await groupContext(ctx);
  if (!group) return true;
  const targets = getTargetProfiles(ctx, group.participants);
  let pair = [];
  if (targets.length > 2) {
    await ctx.send(ctx.jid, 'Marque no máximo duas pessoas para usar !ship.', ctx.msg);
    return true;
  }
  if (targets.length === 2) {
    pair = targets;
  } else if (targets.length === 1 && group.sender) {
    const self = participantProfile(group.sender);
    pair = [self, targets[0]];
  } else {
    const eligible = group.participants
      .filter(participant => !aliasesMatch(identityAliases(participant), botAliases(ctx.sock)))
      .map(participantProfile)
      .filter(Boolean);
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    pair = eligible.slice(0, 2);
  }
  if (pair.length !== 2 || aliasesMatch(new Set(pair[0].aliases), new Set(pair[1].aliases))) {
    await ctx.send(ctx.jid, 'Use !ship @pessoa1 @pessoa2 (ou marque uma pessoa para formar um ship com você).', ctx.msg);
    return true;
  }
  const percent = getCompatibility(ctx.jid, pair[0], pair[1]);
  const filled = Math.round(percent / 10);
  await sendCoupleMedia(
    ctx,
    'ship',
    `💞 SHIP DO GRUPO\n\n${pair[0].tag} + ${pair[1].tag}\n\n${'❤️'.repeat(filled)}${'🤍'.repeat(10 - filled)} ${percent}%\n${compatibilityText(percent)}`,
    [pair[0].jid, pair[1].jid],
    'ship.png'
  );
  return true;
}

async function proposalCommand(ctx) {
  const group = await groupContext(ctx);
  if (!group) return true;
  const sender = participantProfile(group.sender);
  const targets = getTargetProfiles(ctx, group.participants);
  if (!sender || targets.length !== 1) {
    await ctx.send(ctx.jid, 'Use !casacomigo @pessoa (ou responda à mensagem dela).', ctx.msg);
    return true;
  }
  const target = targets[0];
  if (aliasesMatch(new Set(sender.aliases), new Set(target.aliases))) {
    await ctx.send(ctx.jid, '😂 Você não pode pedir a si mesmo em casamento!', ctx.msg);
    return true;
  }
  const data = loadData();
  const record = groupData(data, ctx.jid);
  const senderSet = new Set(sender.aliases);
  const targetSet = new Set(target.aliases);
  if (coupleFor(record, senderSet) || coupleFor(record, targetSet)) {
    await ctx.send(ctx.jid, '💍 Uma das pessoas já está em um casamento registrado neste grupo.', ctx.msg);
    return true;
  }
  record.proposals = record.proposals.filter(item => Date.now() - Date.parse(item.createdAt) < 86400000);
  if (record.proposals.some(item => aliasesMatch(targetSet, new Set(item.to?.aliases || [])))) {
    await ctx.send(ctx.jid, '💌 Essa pessoa já tem um pedido de casamento aguardando resposta.', ctx.msg);
    return true;
  }
  if (record.proposals.some(item => aliasesMatch(senderSet, new Set(item.from?.aliases || [])))) {
    await ctx.send(ctx.jid, '💌 Você já tem um pedido de casamento aguardando resposta.', ctx.msg);
    return true;
  }
  record.proposals.push({ from: sender, to: target, createdAt: new Date().toISOString() });
  saveData(data);
  await sendCoupleMedia(
    ctx,
    'casacomigo',
    `💍 PEDIDO DE CASAMENTO\n\n${sender.tag} está perguntando a ${target.tag}:\n\n“Quer se casar comigo no Léo Stickers?”\n\n${target.tag}, responda com !aceitarcasamento ou !recusarcasamento. O pedido expira em 24 horas.`,
    [sender.jid, target.jid].filter(Boolean),
    'pedido-casamento.png'
  );
  return true;
}

async function answerProposal(ctx, accept) {
  const group = await groupContext(ctx);
  if (!group) return true;
  const sender = participantProfile(group.sender);
  if (!sender) {
    await ctx.send(ctx.jid, '❌ Não consegui identificar seu perfil neste grupo.', ctx.msg);
    return true;
  }
  const data = loadData();
  const record = groupData(data, ctx.jid);
  const cutoff = Date.now() - 86400000;
  record.proposals = record.proposals.filter(item => Date.parse(item.createdAt) >= cutoff);
  const index = record.proposals.findIndex(item => aliasesMatch(new Set(sender.aliases), new Set(item.to?.aliases || [])));
  if (index < 0) {
    saveData(data);
    await ctx.send(ctx.jid, 'Você não tem nenhum pedido de casamento pendente.', ctx.msg);
    return true;
  }
  const proposal = record.proposals[index];
  if (accept && (coupleFor(record, new Set(proposal.from.aliases)) || coupleFor(record, new Set(proposal.to.aliases)))) {
    record.proposals.splice(index, 1);
    saveData(data);
    await ctx.send(ctx.jid, '❌ Uma das pessoas já está em outro casamento. O pedido foi encerrado.', ctx.msg);
    return true;
  }
  record.proposals.splice(index, 1);
  if (accept) {
    record.couples.push({ a: proposal.from, b: proposal.to, startedAt: new Date().toISOString() });
    saveData(data);
    await sendCoupleMedia(ctx, 'aceitarcasamento', `💞 CASAMENTO CONFIRMADO!\n\n${proposal.from.tag} ❤️ ${proposal.to.tag}\n\nQue comece a história do casal!`, [proposal.from.jid, proposal.to.jid]);
  } else {
    saveData(data);
    await sendCoupleMedia(ctx, 'recusarcasamento', `💌 ${sender.tag} recusou o pedido de ${proposal.from.tag}. Tudo bem: respeito em primeiro lugar.`, [proposal.from.jid, sender.jid]);
  }
  return true;
}

async function coupleCommand(ctx, command) {
  const group = await groupContext(ctx);
  if (!group) return true;
  const sender = participantProfile(group.sender);
  if (!sender) {
    await ctx.send(ctx.jid, '❌ Não consegui identificar você neste grupo.', ctx.msg);
    return true;
  }
  const data = loadData();
  const record = groupData(data, ctx.jid);

  if (command === 'casados') {
    if (!record.couples.length) {
      await ctx.send(ctx.jid, '💍 Ainda não há casais registrados neste grupo. Use !casacomigo @pessoa.', ctx.msg);
      return true;
    }
    const lines = record.couples.map((couple, index) => `${index + 1}. ${couple.a.tag} ❤️ ${couple.b.tag} — ${daysTogether(couple.startedAt)}`);
    const mentions = record.couples.flatMap(couple => [couple.a.jid, couple.b.jid]);
    await sendCoupleMedia(ctx, 'casados', `💞 CASAIS DO GRUPO\n\n${lines.join('\n')}`, mentions);
    return true;
  }

  const couple = coupleFor(record, new Set(sender.aliases));
  if (command === 'meucasal') {
    if (!couple) {
      await ctx.send(ctx.jid, 'Você ainda não está em um casamento do Léo Stickers. Use !casacomigo @pessoa.', ctx.msg);
      return true;
    }
    const partner = partnerIn(couple, new Set(sender.aliases));
    await sendCoupleMedia(ctx, 'meucasal', `💍 SEU CASAL\n\n${sender.tag} ❤️ ${partner.tag}\nDesde: ${new Date(couple.startedAt).toLocaleDateString('pt-BR')}\nTempo juntos: ${daysTogether(couple.startedAt)}`, [sender.jid, partner.jid]);
    return true;
  }

  if (command === 'divorcio') {
    if (!couple) {
      await ctx.send(ctx.jid, 'Você não está em um casamento registrado.', ctx.msg);
      return true;
    }
    record.couples = record.couples.filter(item => item !== couple);
    saveData(data);
    const partner = partnerIn(couple, new Set(sender.aliases));
    await sendCoupleMedia(ctx, 'divorcio', `💔 ${sender.tag} encerrou o casamento com ${partner.tag}. O registro foi removido.`, [sender.jid, partner.jid]);
    return true;
  }

  if (!couple) {
    await ctx.send(ctx.jid, 'Esse comando é para quem está casado no Léo Stickers. Use !meucasal para conferir seu status.', ctx.msg);
    return true;
  }
  const partner = partnerIn(couple, new Set(sender.aliases));
  const duration = daysTogether(couple.startedAt);
  const actions = {
    tempocasados: `⏳ Vocês estão juntos há ${duration}!`,
    bodas: `🎉 Feliz bodas! O casal ${sender.tag} ❤️ ${partner.tag} está junto há ${duration}.`,
    perfilcasal: `💞 PERFIL DO CASAL\n${sender.tag} ❤️ ${partner.tag}\nInício: ${new Date(couple.startedAt).toLocaleDateString('pt-BR')}\nTempo juntos: ${duration}\nCompatibilidade: ${getCompatibility(ctx.jid, sender, partner)}%`,
    beijarpar: `😘 ${sender.tag} mandou um beijo virtual para ${partner.tag}!`,
    abracarpar: `🫂 ${sender.tag} deu um abraço virtual apertado em ${partner.tag}!`,
    elogiarpar: `🌹 ${sender.tag} elogiou ${partner.tag}: “Você deixa o dia mais bonito!”`,
    declaracao: `💌 ${sender.tag} declarou para ${partner.tag}: “Entre tantas pessoas, fico feliz por ter você na minha história.”`,
    presentepar: `🎁 ${sender.tag} entregou um presente surpresa para ${partner.tag}: ${['um buquê de flores','uma caixa de chocolates','um álbum de memórias','um ingresso para um passeio','uma playlist especial'][Math.floor(Math.random() * 5)]}!`,
    encontro: `🗓️ Encontro marcado no faz de conta: ${sender.tag} e ${partner.tag} vão ${['tomar sorvete','ver um filme','passear no parque','jogar juntos','ver o pôr do sol'][Math.floor(Math.random() * 5)]}!`,
    promessapar: `🤝 ${sender.tag} fez uma promessa para ${partner.tag}: ${['sempre ouvir com carinho','apoiar nos dias difíceis','celebrar as pequenas conquistas','manter o respeito e a amizade'][Math.floor(Math.random() * 4)]}.`,
    renovarvotos: `💍 ${sender.tag} renovou os votos com ${partner.tag}: respeito, amizade e parceria!`,
    mimo: `🧸 ${sender.tag} preparou um mimo para ${partner.tag}: ${['um bilhete carinhoso','um abraço virtual','uma música especial','um desenho feito com carinho'][Math.floor(Math.random() * 4)]}.`,
    ciumes: `😅 Nível de ciúmes de ${sender.tag}: ${Math.floor(Math.random() * 101)}%. Lembrete: confiança e respeito são a base!`,
    sorteiodata: `✨ Ideia de encontro para ${sender.tag} e ${partner.tag}: ${['noite de jogos','piquenique','sessão de cinema','passeio fotográfico','competição de culinária'][Math.floor(Math.random() * 5)]}.`
  };
  await sendCoupleMedia(ctx, command, actions[command], [sender.jid, partner.jid]);
  return true;
}

export async function handleCommunityCommand(ctx) {
  const command = String(ctx.command || '').toLowerCase();
  if (!COMMUNITY_COMMANDS.includes(command)) return false;
  try {
    if (command === 'seradm') return await serAdmCommand(ctx);
    if (command === 'mute') return await muteCommand(ctx, false);
    if (['desmute', 'unmute', 'desmutar'].includes(command)) return await muteCommand(ctx, true);
    if (command === 'ship') return await shipCommand(ctx);
    if (command === 'casacomigo') return await proposalCommand(ctx);
    if (command === 'aceitarcasamento') return await answerProposal(ctx, true);
    if (command === 'recusarcasamento') return await answerProposal(ctx, false);
    return await coupleCommand(ctx, command);
  } catch (error) {
    console.error(`[COMUNIDADE ${command}]`, error?.stack || error);
    await ctx.send(ctx.jid, `❌ Não consegui executar !${command}: ${String(error?.message || error).slice(0, 220)}`, ctx.msg);
    return true;
  }
}

export async function handleMutedMessage(sock, msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid?.endsWith('@g.us') || msg?.key?.fromMe || !msg?.key?.id || !fs.existsSync(DATA_FILE)) return false;
  const data = loadData();
  const group = data.groups?.[jid];
  if (!group || !Array.isArray(group.muted) || !group.muted.length) return false;
  const key = msg.key || {};
  const sender = identityAliases(key.participant, key.participantAlt, key.remoteJidAlt);
  if (!sender.size) return false;
  const muted = group.muted.some(record => aliasesMatch(sender, new Set(record.aliases || [])));
  if (!muted) return false;
  try {
    await sock.sendMessage(jid, { delete: msg.key });
  } catch (error) {
    console.error('[MUTE] Não foi possível apagar mensagem de participante mutado:', String(error?.message || error).slice(0, 240));
  }
  // Mesmo quando a exclusão falha, a mensagem mutada não pode executar comandos.
  return true;
}
