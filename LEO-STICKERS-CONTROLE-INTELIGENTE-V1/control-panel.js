import fs from 'node:fs';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { sendInteractiveMessage } from './interactive-buttons.js';

const STATE_FILE = path.resolve(process.env.LEO_GROUP_CONTROL_FILE || './group-bot-control.json');
const startedAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let messagesReceived = 0;
let reconnects = 0;
let wasConnected = false;
let lastSendAckMs = null;
const pausedNoticeAt = new Map();

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (value && typeof value === 'object') {
      value.groups ||= {};
      return value;
    }
  } catch {}
  return { groups: {} };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.renameSync(temp, STATE_FILE); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

export function isGroupBotEnabled(groupJid) {
  if (!String(groupJid || '').endsWith('@g.us')) return true;
  const saved = readState().groups[groupJid];
  return saved?.enabled !== false;
}

export function setGroupBotEnabled(groupJid, enabled, groupName = '', changedBy = '') {
  if (!String(groupJid || '').endsWith('@g.us')) throw new Error('ID de grupo inválido.');
  const state = readState();
  const old = state.groups[groupJid] || {};
  state.groups[groupJid] = {
    ...old,
    enabled: Boolean(enabled),
    groupName: String(groupName || old.groupName || '').slice(0, 100),
    updatedAt: new Date().toISOString(),
    updatedBy: String(changedBy || '').slice(0, 100)
  };
  writeState(state);
  return state.groups[groupJid];
}

export function recordInboundMessage() { messagesReceived++; }

export function recordConnectionUpdate(update = {}) {
  if (update.connection === 'open') {
    if (wasConnected) reconnects++;
    wasConnected = true;
  } else if (update.connection === 'close' && wasConnected) {
    // A reconexão só é contada quando a conexão voltar a abrir.
  }
}

async function reconcileAfterActivation(sock) {
  try {
    const module = await import('./join-approval.js');
    if (typeof module.resumeGroupJoinRequests === 'function') {
      await module.resumeGroupJoinRequests(sock);
    }
  } catch (error) {
    console.warn('[CONTROLE] Não foi possível reconciliar solicitações ao reativar grupo:', error?.message || error);
  }
}

export function wasGroupPauseRecentlyNotified(groupJid, intervalMs = 30 * 60 * 1000) {
  const now = Date.now();
  const previous = pausedNoticeAt.get(groupJid) || 0;
  if (now - previous < intervalMs) return true;
  pausedNoticeAt.set(groupJid, now);
  return false;
}

function normalizeAction(message) {
  let current = message || {};
  for (let i = 0; i < 10; i++) {
    const next = current.ephemeralMessage?.message || current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message || current.viewOnceMessageV2Extension?.message ||
      current.deviceSentMessage?.message;
    if (!next) break;
    current = next;
  }
  const native = current.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (native?.paramsJson) {
    try {
      const params = JSON.parse(native.paramsJson);
      const action = params.id || params.selectedRowId || params.selected_row_id || params.rowId || params.row_id;
      if (action) return String(action);
    } catch {}
  }
  return String(current.buttonsResponseMessage?.selectedButtonId ||
    current.listResponseMessage?.singleSelectReply?.selectedRowId ||
    current.templateButtonReplyMessage?.selectedId || '');
}

function decodeGroupId(action) {
  const encoded = action.slice(action.lastIndexOf('_') + 1);
  try {
    const prefix = action.startsWith('ls_enable_') ? 'ls_enable_' : action.startsWith('ls_disable_') ? 'ls_disable_' : action.startsWith('ls_group_') ? 'ls_group_' : '';
    const payload = prefix ? action.slice(prefix.length) : encoded;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return decoded.endsWith('@g.us') ? decoded : '';
  } catch { return ''; }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}min` : '', `${s}s`].filter(Boolean).join(' ');
}

function bytesToMb(value) { return `${(value / 1024 / 1024).toFixed(1)} MB`; }

function getGroupsObject(sock) {
  return sock.groupFetchAllParticipating();
}

async function sendGroupMenu(sock, chatJid, page = 0) {
  const groupsObject = await getGroupsObject(sock);
  const groups = Object.entries(groupsObject || {})
    .filter(([jid]) => jid.endsWith('@g.us'))
    .map(([jid, meta]) => ({ jid, name: String(meta?.subject || meta?.name || jid).slice(0, 70), enabled: isGroupBotEnabled(jid) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const rows = visible.map(group => ({
    id: `ls_group_${Buffer.from(group.jid).toString('base64url')}`,
    title: `${group.enabled ? '🟢' : '🔴'} ${group.name}`.slice(0, 72),
    description: group.enabled ? 'Bot ativo neste grupo' : 'Bot pausado neste grupo'
  }));
  if (currentPage > 0) rows.push({ id: `ls_page_${currentPage - 1}`, title: '⬅️ Página anterior', description: 'Ver grupos anteriores' });
  if (currentPage < pageCount - 1) rows.push({ id: `ls_page_${currentPage + 1}`, title: '➡️ Próxima página', description: 'Ver mais grupos' });
  const state = readState();
  const savedPaused = Object.entries(state.groups).filter(([, item]) => item?.enabled === false).length;
  const manualCommands = visible.map(group => `• ${group.name}\n  !grupo ${group.enabled ? 'off' : 'on'} ${group.jid}`).join('\n');
  const text = `⚙️ *CONTROLE DE GRUPOS — LÉO STICKERS*\n\nGrupos encontrados: *${groups.length}*\nAtivos: *${groups.filter(g => g.enabled).length}*\nPausados: *${groups.filter(g => !g.enabled).length}*\nConfigurações de pausa salvas: *${savedPaused}*\n\nSelecione um grupo para alterar o funcionamento do bot.\nPágina *${currentPage + 1}/${pageCount}*\n\nSe os botões não aparecerem, use o comando indicado para o grupo desejado:\n${manualCommands || 'Nenhum grupo disponível nesta página.'}`;
  try {
    await sendInteractiveMessage(sock, chatJid, {
      text,
      footer: 'Somente o proprietário pode alterar esses controles.',
      buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({
        title: 'Selecionar grupo', sections: [{ title: 'Grupos do WhatsApp', rows: rows.length ? rows : [{ id: 'ls_empty', title: 'Nenhum grupo encontrado' }] }]
      }) }]
    });
  } catch (error) {
    const lines = groups.slice(0, 30).map((g, i) => `${i + 1}. ${g.enabled ? '🟢' : '🔴'} ${g.name}\n   !grupo ${g.enabled ? 'off' : 'on'} ${g.jid}`).join('\n');
    await sock.sendMessage(chatJid, { text: `${text}\n\n*Alternativa sem botões:*\n${lines || 'Nenhum grupo encontrado.'}\n\nPara abrir o seletor novamente, envie !grupos.` });
    console.warn('[CONTROLE] Não foi possível enviar menu interativo:', error?.message || error);
  }
}

async function sendGroupActions(sock, chatJid, groupJid, groupName) {
  const enabled = isGroupBotEnabled(groupJid);
  const state = readState().groups[groupJid] || {};
  const currentName = groupName || state.groupName || groupJid;
  try {
    await sendInteractiveMessage(sock, chatJid, {
      text: `⚙️ *${currentName}*\n\nStatus atual: *${enabled ? 'ATIVO 🟢' : 'DESATIVADO 🔴'}*\n\nO bot continua conectado ao WhatsApp. Esta opção apenas pausa ou libera as funções dele neste grupo.`,
      footer: 'A alteração é salva neste aparelho.',
      buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🟢 Ativar bot', id: `ls_enable_${Buffer.from(groupJid).toString('base64url')}` }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🔴 Desativar bot', id: `ls_disable_${Buffer.from(groupJid).toString('base64url')}` }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '↩️ Voltar aos grupos', id: 'ls_groups' }) }
      ]
    });
  } catch (error) {
    await sock.sendMessage(chatJid, { text: `⚙️ *${currentName}*\nStatus: ${enabled ? 'ATIVO' : 'DESATIVADO'}\n\nUse !grupo ${enabled ? 'off' : 'on'} ${groupJid} para alterar ou !grupos para voltar.` });
  }
}

async function sendStatus(sock, chatJid) {
  let groupCount = null;
  try { groupCount = Object.keys(await getGroupsObject(sock) || {}).filter(jid => jid.endsWith('@g.us')).length; } catch {}
  const mem = process.memoryUsage();
  const eventLoopP95 = Number(loopDelay.percentile(95) / 1e6).toFixed(1);
  const state = readState();
  const paused = Object.values(state.groups).filter(group => group?.enabled === false).length;
  const uptime = formatDuration(Date.now() - startedAt);
  let placeholder;
  const sendStart = performance.now();
  try { placeholder = await sock.sendMessage(chatJid, { text: '🦊 Coletando status do Léo Stickers…' }); }
  catch (error) { console.warn('[STATUS] Falha ao enviar marcador:', error?.message || error); return; }
  lastSendAckMs = performance.now() - sendStart;
  const finalText = `🦊 *LÉO STICKERS — STATUS*\n\nConexão: *${sock.user ? 'CONECTADO 🟢' : 'INICIALIZANDO 🟡'}*\nTempo ligado neste processo: *${uptime}*\nMemória RSS: *${bytesToMb(mem.rss)}*\nHeap usado: *${bytesToMb(mem.heapUsed)}*\nMensagens recebidas: *${messagesReceived}*\nReconexões após a primeira conexão: *${reconnects}*\nGrupos conectados: *${groupCount == null ? 'indisponível' : groupCount}*\nGrupos pausados: *${paused}*\nAtraso do event loop (p95): *${eventLoopP95} ms*\nTempo até confirmação local do envio: *${lastSendAckMs.toFixed(1)} ms*\n\n_Essa medição é o tempo até o Baileys concluir o envio/ack local, não um ping completo da internet até o aparelho._`;
  try {
    await sock.sendMessage(chatJid, { text: finalText, edit: placeholder?.key });
  } catch {
    await sock.sendMessage(chatJid, { text: finalText });
  }
}

export async function handleControlPanelMessage(sock, msg, context = {}) {
  const remoteJid = msg?.key?.remoteJid || '';
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || msg?.key?.fromMe) return false;
  const isOwner = typeof context.isOwner === 'function' && context.isOwner(context.senderJid || remoteJid);
  const content = msg?.message || {};
  let current = content;
  for (let i = 0; i < 10; i++) {
    const next = current.ephemeralMessage?.message || current.viewOnceMessage?.message || current.viewOnceMessageV2?.message || current.deviceSentMessage?.message;
    if (!next) break;
    current = next;
  }
  const text = String(current.conversation || current.extendedTextMessage?.text || '').trim();
  const action = normalizeAction(content);
  const prefix = String(context.prefix || '!');
  const normalized = text.toLowerCase();
  const statusCommand = normalized === `${prefix}status` || normalized === '!status';
  const groupsCommand = normalized === `${prefix}grupos` || normalized === '!grupos';
  const manualGroupMatch = normalized.match(/^!grupo\s+(on|off)\s+(\d{5,25}@g\.us)$/i);
  if (!isOwner && (statusCommand || groupsCommand || action.startsWith('ls_') || manualGroupMatch)) {
    await sock.sendMessage(remoteJid, { text: '⛔ Este painel é exclusivo do proprietário do bot.' });
    return true;
  }
  if (statusCommand) { await sendStatus(sock, remoteJid); return true; }
  if (groupsCommand || action === 'ls_groups') { await sendGroupMenu(sock, remoteJid, 0); return true; }
  if (manualGroupMatch) {
    const groupJid = manualGroupMatch[2];
    let name = groupJid;
    try { name = (await sock.groupMetadata(groupJid)).subject || name; } catch {}
    const value = setGroupBotEnabled(groupJid, manualGroupMatch[1] === 'on', name, context.senderJid || remoteJid);
    if (value.enabled) await reconcileAfterActivation(sock);
    await sock.sendMessage(remoteJid, { text: `${value.enabled ? '🟢 Bot ativado' : '🔴 Bot desativado'} em *${value.groupName || groupJid}*.` });
    return true;
  }
  if (action.startsWith('ls_page_')) {
    const page = Number(action.slice('ls_page_'.length));
    await sendGroupMenu(sock, remoteJid, Number.isInteger(page) ? page : 0);
    return true;
  }
  if (action.startsWith('ls_group_')) {
    const groupJid = decodeGroupId(action);
    if (!groupJid) { await sock.sendMessage(remoteJid, { text: 'Não consegui identificar esse grupo. Envie !grupos novamente.' }); return true; }
    let name = groupJid;
    try { name = (await sock.groupMetadata(groupJid)).subject || name; } catch {}
    await sendGroupActions(sock, remoteJid, groupJid, name);
    return true;
  }
  if (action.startsWith('ls_enable_') || action.startsWith('ls_disable_')) {
    const enabled = action.startsWith('ls_enable_');
    const groupJid = decodeGroupId(action);
    if (!groupJid) { await sock.sendMessage(remoteJid, { text: 'ID de grupo inválido. Abra !grupos novamente.' }); return true; }
    let name = groupJid;
    try { name = (await sock.groupMetadata(groupJid)).subject || name; } catch {}
    const value = setGroupBotEnabled(groupJid, enabled, name, context.senderJid || remoteJid);
    if (value.enabled) await reconcileAfterActivation(sock);
    await sock.sendMessage(remoteJid, { text: `${value.enabled ? '🟢 Bot ativado' : '🔴 Bot desativado'} em *${value.groupName || groupJid}*.\n\nAs configurações de entrada e apresentação deste grupo foram preservadas.` });
    await sendGroupActions(sock, remoteJid, groupJid, name);
    return true;
  }
  return false;
}

export const __test = { readState, normalizeAction, formatDuration, decodeGroupId, STATE_FILE };
