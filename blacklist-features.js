import fs from 'node:fs';
import path from 'node:path';
import { sendListanegraGif } from './extra-features.js';

const DATA_FILE = path.resolve('./blacklist-data.json');
let cachedData = null;

export const BLACKLIST_COMMANDS = Object.freeze([
  'listanegra',
  'tirarlistanegra'
]);

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
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, DATA_FILE);
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
  // LEO_STICKERS_BLACKLIST_ADMIN_ID_FIX_V1
  return Boolean(participant && (
    participant.admin === 'admin' ||
    participant.admin === 'superadmin' ||
    participant.isAdmin === true ||
    participant.isSuperAdmin === true ||
    participant.admin === true
  ));
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
  for (const type of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage']) {
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
  const jid = String(participant.id || participant.jid || participant.phoneNumber || participant.lid || '');
  if (!jid || !aliases.length) return null;
  const numberSource = participant.phoneNumber || participant.jid || participant.id || participant.lid || '';
  const number = String(numberSource).split('@')[0].split(':')[0].replace(/\D/g, '');
  return { jid, aliases, tag: `@${number || String(jid).split('@')[0]}` };
}

function profileFromJid(jid) {
  const value = String(jid || '');
  const number = value.split('@')[0].split(':')[0].replace(/\D/g, '');
  return { jid: value, aliases: [...identityAliases(value)], tag: `@${number || value.split('@')[0]}` };
}

function senderAliases(ctx) {
  const key = ctx.msg?.key || {};
  return identityAliases(ctx.sender, key.participant, key.participantAlt, key.remoteJidAlt);
}

function botAliases(sock) {
  // LEO_STICKERS_BLACKLIST_ADMIN_ID_FIX_V1: contempla identidade do socket e da autenticação.
  const me = sock?.user || {};
  const authMe = sock?.authState?.creds?.me || {};
  return identityAliases(
    me, authMe,
    me.id, me.lid, me.phoneNumber,
    authMe.id, authMe.lid, authMe.phoneNumber
  );
}

function botIsGroupAdmin(sock, metadata, participants) {
  const aliases = botAliases(sock);
  const bot = participantFor(aliases, participants);
  const ownerMatchesBot =
    aliasesMatch(aliases, identityAliases(metadata?.owner));
  return isAdmin(bot) || ownerMatchesBot;
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
  const botIsAdmin = botIsGroupAdmin(ctx.sock, metadata, participants);
  return { metadata, participants, sender, bot, botIsAdmin };
}

async function requireGroupAdmin(ctx, botMustBeAdmin) {
  const group = await groupContext(ctx);
  if (!group) return null;
  if (!isAdmin(group.sender)) {
    await ctx.send(ctx.jid, '❌ Somente administradores do grupo podem usar este comando.', ctx.msg);
    return null;
  }
  if (botMustBeAdmin && !group.botIsAdmin) {
    console.warn('[LISTA NEGRA][ADMIN_CHECK]', {
      addressingMode: group.metadata?.addressingMode || 'desconhecido',
      participantCount: group.participants.length,
      botFoundInParticipants: Boolean(group.bot),
      botAdminField: group.bot?.admin ?? null,
      botIsAdminFlag: group.bot?.isAdmin === true,
      botIsSuperAdminFlag: group.bot?.isSuperAdmin === true,
      adminParticipantCount: group.participants.filter(isAdmin).length,
      botHasLid: Boolean(
        ctx.sock?.user?.lid ||
        ctx.sock?.authState?.creds?.me?.lid
      )
    });
    await ctx.send(
      ctx.jid,
      '❌ Não consegui confirmar minha permissão de administrador pela lista de participantes. Confira se continuo como administrador e tente novamente.',
      ctx.msg
    );
    return null;
  }
  return group;
}

function groupRecord(data, jid) {
  data.groups ||= {};
  data.groups[jid] ||= {};
  data.groups[jid].blacklist ||= [];
  return data.groups[jid];
}

function getTargetProfiles(ctx, participants) {
  const mentioned = mentionedJids(ctx.msg);
  if (!mentioned.length) {
    const quoted = quotedParticipant(ctx.msg);
    if (quoted) mentioned.push(quoted);
  }
  const targets = [];
  for (const jid of mentioned) {
    const participant = participantFor(identityAliases(jid), participants);
    const profile = participantProfile(participant);
    if (profile && !targets.some(item => aliasesMatch(new Set(item.aliases), new Set(profile.aliases)))) {
      targets.push(profile);
    }
  }
  return targets;
}

function getTargetReferences(ctx, participants) {
  const ids = mentionedJids(ctx.msg);
  if (!ids.length) {
    const quoted = quotedParticipant(ctx.msg);
    if (quoted) ids.push(quoted);
  }
  return [...new Set(ids)].map(jid => {
    const participant = participantFor(identityAliases(jid), participants);
    const profile = participantProfile(participant) || profileFromJid(jid);
    return {
      jid: profile.jid || String(jid),
      aliases: [...identityAliases(jid, participant)],
      tag: profile.tag
    };
  }).filter(item => item.aliases.length);
}

function findBlacklisted(group, aliases) {
  return group.blacklist.findIndex(entry =>
    aliasesMatch(aliases, new Set(entry.aliases || []))
  );
}

async function addToBlacklist(ctx, group, data, record) {
  const targets = getTargetProfiles(ctx, group.participants);
  if (targets.length !== 1) {
    await ctx.send(ctx.jid, 'Use !listanegra @pessoa (ou responda à mensagem dela).', ctx.msg);
    return true;
  }

  const target = participantFor(new Set(targets[0].aliases), group.participants);
  if (!target) {
    await ctx.send(ctx.jid, '❌ Não consegui identificar essa pessoa entre os participantes do grupo.', ctx.msg);
    return true;
  }
  if (isAdmin(target)) {
    await ctx.send(ctx.jid, '❌ A lista negra não remove administradores. Rebaixe a pessoa primeiro, se for apropriado.', ctx.msg);
    return true;
  }

  const targetAliases = identityAliases(target);
  if (aliasesMatch(targetAliases, botAliases(ctx.sock))) {
    await ctx.send(ctx.jid, '❌ Não é possível colocar o próprio bot na lista negra.', ctx.msg);
    return true;
  }
  if (ctx.isOwner?.(target.id) || ctx.isOwner?.(target.phoneNumber)) {
    await ctx.send(ctx.jid, '❌ O dono do bot está protegido contra a lista negra.', ctx.msg);
    return true;
  }

  if (findBlacklisted(record, targetAliases) >= 0) {
    await ctx.send(ctx.jid, `${targets[0].tag} já está na lista negra deste grupo.`, ctx.msg, { mentions: [target.id] });
    return true;
  }

  const targetJid = target.id || target.jid || target.phoneNumber;
  if (!targetJid) {
    await ctx.send(ctx.jid, '❌ Não consegui obter o identificador do participante para registrar a lista negra.', ctx.msg);
    return true;
  }

  record.blacklist.push({
    jid: targetJid,
    aliases: [...targetAliases],
    addedAt: new Date().toISOString(),
    addedBy: [...senderAliases(ctx)][0] || ''
  });
  saveData(data);

  let removedNow = false;
  let removalStatus = 'não confirmado';
  try {
    const result = await ctx.sock.groupParticipantsUpdate(ctx.jid, [targetJid], 'remove');
    const response = Array.isArray(result)
      ? result.find(item => aliasesMatch(identityAliases(item?.jid), targetAliases)) || result[0]
      : null;
    removalStatus = String(response?.status || 'não confirmado');
    removedNow = removalStatus === '200';
  } catch (error) {
    removalStatus = String(error?.message || error).slice(0, 140);
    console.error('[LISTA NEGRA] Falha ao remover imediatamente:', removalStatus);
  }

  const caption = removedNow
    ? `📓 ${targets[0].tag} entrou na LISTA NEGRA deste grupo e foi removido(a). Se tentar entrar novamente, será removido(a) automaticamente. Use !tirarlistanegra @pessoa para liberar.`
    : `📓 ${targets[0].tag} foi registrado(a) na LISTA NEGRA deste grupo. Não consegui confirmar a remoção imediata (status: ${removalStatus}); se entrar novamente, o bot tentará removê-lo(a) automaticamente. Use !tirarlistanegra @pessoa para liberar.`;

  await sendListanegraGif(ctx, caption, [targetJid]);
  return true;
}

async function removeFromBlacklist(ctx, group, data, record) {
  const targets = getTargetReferences(ctx, group.participants);
  if (targets.length !== 1) {
    await ctx.send(ctx.jid, 'Use !tirarlistanegra @pessoa (ou responda à mensagem dela).', ctx.msg);
    return true;
  }

  const target = targets[0];
  const index = findBlacklisted(record, new Set(target.aliases));
  if (index < 0) {
    await ctx.send(ctx.jid, `${target.tag} não está na lista negra deste grupo.`, ctx.msg);
    return true;
  }

  const [removed] = record.blacklist.splice(index, 1);
  saveData(data);
  const removedProfile = profileFromJid(removed.jid || target.jid);
  await ctx.send(
    ctx.jid,
    `✅ ${removedProfile.tag} foi retirado(a) da lista negra. O bot não vai mais remover essa pessoa automaticamente.`,
    ctx.msg,
    { mentions: [removed.jid || target.jid].filter(Boolean) }
  );
  return true;
}

export async function handleBlacklistCommand(ctx) {
  const command = String(ctx.command || '').toLowerCase();
  if (!BLACKLIST_COMMANDS.includes(command)) return false;

  try {
    const removing = command === 'tirarlistanegra';
    const group = await requireGroupAdmin(ctx, !removing);
    if (!group) return true;

    const data = loadData();
    const record = groupRecord(data, ctx.jid);
    if (removing) return await removeFromBlacklist(ctx, group, data, record);
    return await addToBlacklist(ctx, group, data, record);
  } catch (error) {
    console.error(`[LISTA NEGRA ${command}]`, error?.stack || error);
    await ctx.send(ctx.jid, `❌ Não consegui executar !${command}: ${String(error?.message || error).slice(0, 220)}`, ctx.msg);
    return true;
  }
}

export async function handleBlacklistedParticipantUpdate(sock, update) {
  const groupJid = update?.id;
  if (!groupJid?.endsWith('@g.us') || update?.action !== 'add') return;
  if (!fs.existsSync(DATA_FILE)) return;

  const data = loadData();
  const record = data.groups?.[groupJid];
  if (!record || !Array.isArray(record.blacklist) || !record.blacklist.length) return;

  const incoming = Array.isArray(update.participants) ? update.participants : [];
  if (!incoming.length) return;

  let metadata;
  try {
    metadata = await sock.groupMetadata(groupJid);
  } catch (error) {
    console.error('[LISTA NEGRA] Não consegui consultar o grupo após uma entrada:', String(error?.message || error).slice(0, 180));
    return;
  }

  const participants = metadata.participants || [];
  const bot = participantFor(botAliases(sock), participants);
  if (!botIsGroupAdmin(sock, metadata, participants)) {
    console.warn(`[LISTA NEGRA] O bot não é administrador em ${groupJid}; não consegue remover entradas bloqueadas.`);
    return;
  }

  for (const incomingParticipant of incoming) {
    const incomingAliases = identityAliases(incomingParticipant);
    const participant = participantFor(incomingAliases, participants) || incomingParticipant;
    const resolvedAliases = identityAliases(incomingParticipant, participant);
    if (!resolvedAliases.size) continue;

    const blocked = record.blacklist.find(entry =>
      aliasesMatch(resolvedAliases, new Set(entry.aliases || []))
    );
    if (!blocked) continue;

    const participantJid = typeof participant === 'string'
      ? participant
      : participant?.id || participant?.jid || participant?.phoneNumber || blocked.jid;
    if (!participantJid) continue;
    if (isAdmin(participant) || aliasesMatch(resolvedAliases, botAliases(sock))) {
      console.warn('[LISTA NEGRA] Entrada corresponde a administrador ou ao próprio bot; remoção automática ignorada.');
      continue;
    }

    try {
      const result = await sock.groupParticipantsUpdate(groupJid, [participantJid], 'remove');
      const response = Array.isArray(result)
        ? result.find(item => aliasesMatch(identityAliases(item?.jid), resolvedAliases)) || result[0]
        : null;
      if (String(response?.status || '') === '200') {
        console.log(`[LISTA NEGRA] Reentrada bloqueada e participante removido de ${groupJid}.`);
      } else {
        console.warn(`[LISTA NEGRA] Tentativa de remoção sem confirmação (status: ${String(response?.status || 'desconhecido')}).`);
      }
    } catch (error) {
      console.error('[LISTA NEGRA] Falha ao remover participante que voltou:', String(error?.message || error).slice(0, 220));
    }
  }
}
