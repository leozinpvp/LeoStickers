import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { sendInteractiveMessage } from './interactive-buttons.js';

const STATE_FILE = path.resolve(process.env.LEO_GROUP_CONTROL_FILE || './group-bot-control.json');
const startedAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const eventLoopUtilizationStart = performance.eventLoopUtilization();
let messagesReceived = 0;
let commandsReceived = 0;
let reconnects = 0;
let wasConnected = false;
let outgoingSucceeded = 0;
let outgoingFailed = 0;
let lastSendAckMs = null;
let maxSendAckMs = 0;
let totalSendAckMs = 0;
const sendAckSamples = [];
const MAX_SEND_ACK_SAMPLES = 100;
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

// Retorna o instante da última reativação. Mensagens anteriores ou iguais a
// esse marco foram enviadas durante a pausa e não devem ser processadas.
export function getGroupBotEnabledAt(groupJid) {
  if (!String(groupJid || '').endsWith('@g.us')) return 0;
  const value = Number(readState().groups[groupJid]?.enabledAtMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getMessageTimestampMs(msg) {
  const raw = msg?.messageTimestamp;
  const seconds = raw && typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds >= 1_000_000_000_000 ? seconds : seconds * 1000;
}

export function setGroupBotEnabled(groupJid, enabled, groupName = '', changedBy = '', changedAtMs = null) {
  if (!String(groupJid || '').endsWith('@g.us')) throw new Error('ID de grupo inválido.');
  const state = readState();
  const old = state.groups[groupJid] || {};
  state.groups[groupJid] = {
    ...old,
    enabled: Boolean(enabled),
    // A marca usa o timestamp da mensagem que reativou o grupo (precisão do
    // WhatsApp: segundos). Assim, backlog anterior não vira resposta atrasada.
    enabledAtMs: enabled ? (Number(changedAtMs) > 0 ? Number(changedAtMs) : Date.now()) : (old.enabledAtMs || 0),
    groupName: String(groupName || old.groupName || '').slice(0, 100),
    updatedAt: new Date().toISOString(),
    updatedBy: String(changedBy || '').slice(0, 100)
  };
  writeState(state);
  return state.groups[groupJid];
}

function getIncomingText(msg) {
  let current = msg?.message || {};
  for (let i = 0; i < 12; i++) {
    const next = current.ephemeralMessage?.message || current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message || current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message || current.deviceSentMessage?.message ||
      current.editedMessage?.message || current.messageContextInfo?.message;
    if (!next) break;
    current = next;
  }
  return String(current.conversation || current.extendedTextMessage?.text ||
    current.imageMessage?.caption || current.videoMessage?.caption ||
    current.documentMessage?.caption || current.buttonsResponseMessage?.selectedDisplayText || '').trim();
}

export function recordInboundMessage(msg, prefix = '!') {
  messagesReceived++;
  const text = getIncomingText(msg);
  if (text && prefix && text.startsWith(String(prefix))) commandsReceived++;
}

export function recordOutboundMessage(durationMs, success = true) {
  if (success) {
    outgoingSucceeded++;
    const value = Math.max(0, Number(durationMs) || 0);
    lastSendAckMs = value;
    maxSendAckMs = Math.max(maxSendAckMs, value);
    totalSendAckMs += value;
    sendAckSamples.push(value);
    if (sendAckSamples.length > MAX_SEND_ACK_SAMPLES) sendAckSamples.shift();
  } else {
    outgoingFailed++;
  }
}

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
  const manualCommands = visible.map(group => `• *${group.name}* — !grupo ${group.enabled ? 'off' : 'on'} ${group.name}`).join('\n');
  const text = `⚙️ *CONTROLE DE GRUPOS — LÉO STICKERS*\n\nGrupos encontrados: *${groups.length}*\nAtivos: *${groups.filter(g => g.enabled).length}*\nPausados: *${groups.filter(g => !g.enabled).length}*\nConfigurações de pausa salvas: *${savedPaused}*\n\nSelecione um grupo para alterar o funcionamento do bot.\nPágina *${currentPage + 1}/${pageCount}*\n\nSe os botões não aparecerem, use !grupo on/off seguido do nome exato do grupo:\n${manualCommands || 'Nenhum grupo disponível nesta página.'}`;
  try {
    await sendInteractiveMessage(sock, chatJid, {
      text,
      footer: 'Somente o proprietário pode alterar esses controles.',
      buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({
        title: 'Selecionar grupo', sections: [{ title: 'Grupos do WhatsApp', rows: rows.length ? rows : [{ id: 'ls_empty', title: 'Nenhum grupo encontrado' }] }]
      }) }]
    });
  } catch (error) {
    const lines = groups.slice(0, 30).map((g, i) => `${i + 1}. ${g.enabled ? '🟢' : '🔴'} *${g.name}* — !grupo ${g.enabled ? 'off' : 'on'} ${g.name}`).join('\n');
    await sock.sendMessage(chatJid, { text: `${text}\n\n*Alternativa sem botões (sem exibir IDs):*\n${lines || 'Nenhum grupo encontrado.'}\n\nPara abrir o seletor novamente, envie !grupos.` });
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
  const statusStartedAt = performance.now();
  let groupsObject = null;
  let groupFetchMs = null;
  try {
    const groupFetchStart = performance.now();
    groupsObject = await getGroupsObject(sock);
    groupFetchMs = performance.now() - groupFetchStart;
  } catch {}

  const groupIds = groupsObject
    ? Object.keys(groupsObject).filter(jid => jid.endsWith('@g.us'))
    : [];
  const groupCount = groupsObject ? groupIds.length : null;
  const state = readState();
  const pausedCurrentGroups = groupsObject
    ? groupIds.filter(jid => state.groups[jid]?.enabled === false).length
    : null;
  const savedPaused = Object.values(state.groups).filter(group => group?.enabled === false).length;
  const stalePaused = pausedCurrentGroups == null ? null : Math.max(0, savedPaused - pausedCurrentGroups);

  const mem = process.memoryUsage();
  const uptimeMs = Date.now() - startedAt;
  const uptime = formatDuration(uptimeMs);
  const heapUsagePct = mem.heapTotal > 0 ? (mem.heapUsed / mem.heapTotal) * 100 : 0;
  const cpu = process.cpuUsage();
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const cpuAveragePct = uptimeMs > 0 ? (cpuMs / uptimeMs) * 100 : 0;
  const elu = performance.eventLoopUtilization(eventLoopUtilizationStart);
  const loopP50 = Number(loopDelay.percentile(50) / 1e6);
  const loopP95 = Number(loopDelay.percentile(95) / 1e6);
  const loopMax = Number(loopDelay.max / 1e6);
    const ackSorted = [...sendAckSamples].sort((a, b) => a - b);
  const ackP95 = ackSorted.length ? ackSorted[Math.min(ackSorted.length - 1, Math.ceil(ackSorted.length * 0.95) - 1)] : null;
  const ackAverage = outgoingSucceeded ? totalSendAckMs / outgoingSucceeded : null;
  const messagesPerMinute = uptimeMs > 0 ? messagesReceived / (uptimeMs / 60000) : 0;
  const commandsPerMinute = uptimeMs > 0 ? commandsReceived / (uptimeMs / 60000) : 0;
  const load = os.loadavg();
  const cpuCount = os.cpus()?.length || 0;
  const memoryRssPct = os.totalmem() > 0 ? (mem.rss / os.totalmem()) * 100 : null;
  const externalPct = mem.heapTotal + mem.external > 0 ? (mem.external / (mem.heapTotal + mem.external)) * 100 : 0;

  let placeholder;
  const placeholderStart = performance.now();
  try { placeholder = await sock.sendMessage(chatJid, { text: '🦊 Coletando 37 indicadores do Léo Stickers…' }); }
  catch (error) { console.warn('[STATUS] Falha ao enviar marcador:', error?.message || error); return; }
  const placeholderAckMs = performance.now() - placeholderStart;
  lastSendAckMs = placeholderAckMs;

  const fmtMs = value => value == null || !Number.isFinite(value) ? 'indisponível' : `${value.toFixed(1)} ms`;
  const fmtPct = value => value == null || !Number.isFinite(value) ? 'indisponível' : `${value.toFixed(1)}%`;
  const fmtMb = value => bytesToMb(value);
  const fmtSec = value => `${(value / 1000).toFixed(1)} s`;
  const finalText = `🦊 *LÉO STICKERS — STATUS AVANÇADO*\n` +
    `_${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_\n\n` +
    `*🟢 CONEXÃO E TEMPO*\n` +
    `1. Conexão WhatsApp: *${sock.user ? 'CONECTADO 🟢' : 'INICIALIZANDO 🟡'}*\n` +
    `2. Identidade da sessão: *${sock.user ? 'autenticada' : 'não disponível'}*\n` +
    `3. Tempo ligado neste processo: *${uptime}*\n` +
    `4. Reconexões após a primeira conexão: *${reconnects}*\n` +
    `5. Grupos conectados: *${groupCount == null ? 'indisponível' : groupCount}*\n` +
    `6. Grupos pausados: *${pausedCurrentGroups == null ? 'indisponível' : pausedCurrentGroups}*\n` +
    `7. Pausas salvas de grupos não encontrados: *${stalePaused == null ? 'indisponível' : stalePaused}*\n` +
    `8. Tempo para consultar grupos: *${fmtMs(groupFetchMs)}*\n\n` +
    `*📨 MOVIMENTO DO BOT*\n` +
    `9. Mensagens recebidas desde o início: *${messagesReceived}*\n` +
    `10. Comandos identificados pelo prefixo: *${commandsReceived}*\n` +
    `11. Média de mensagens recebidas/min: *${messagesPerMinute.toFixed(1)}*\n` +
    `12. Média de comandos recebidos/min: *${commandsPerMinute.toFixed(1)}*\n` +
    `13. Envios concluídos sem erro pelo Baileys: *${outgoingSucceeded}*\n` +
    `14. Envios com erro: *${outgoingFailed}*\n\n` +
    `*⚡ TEMPO DE RESPOSTA E EVENT LOOP*\n` +
    `15. Última chamada de envio local: *${fmtMs(lastSendAckMs)}*\n` +
    `16. Tempo médio da chamada de envio: *${fmtMs(ackAverage)}*\n` +
    `17. Tempo p95 (últimos ${sendAckSamples.length} envios): *${fmtMs(ackP95)}*\n` +
    `18. Maior tempo de envio local: *${fmtMs(maxSendAckMs || null)}*\n` +
    `19. Event Loop p50: *${fmtMs(loopP50)}*\n` +
    `20. Event Loop p95: *${fmtMs(loopP95)}*\n` +
    `21. Event Loop máximo desde o início: *${fmtMs(loopMax)}*\n` +
    `22. Utilização do Event Loop: *${fmtPct(elu.utilization * 100)}*\n\n` +
    `*🧠 MEMÓRIA E CPU*\n` +
    `23. RAM RSS do processo: *${fmtMb(mem.rss)}* (${fmtPct(memoryRssPct)} da RAM do aparelho)\n` +
    `24. Heap usado/total: *${fmtMb(mem.heapUsed)} / ${fmtMb(mem.heapTotal)}*\n` +
    `25. Ocupação do Heap: *${fmtPct(heapUsagePct)}*\n` +
    `26. Memória externa: *${fmtMb(mem.external)}* (${fmtPct(externalPct)} do conjunto externo + heap)\n` +
    `27. ArrayBuffers: *${fmtMb(mem.arrayBuffers || 0)}*\n` +
    `28. CPU média do processo: *${fmtPct(cpuAveragePct)}* (desde o início; pode passar de 100% em vários núcleos)\n` +
    `29. CPU acumulada — usuário/sistema: *${fmtSec(cpu.user / 1000)} / ${fmtSec(cpu.system / 1000)}*\n\n` +
    `*🛠️ AMBIENTE*\n` +
    `30. Node.js: *${process.version}*\n` +
    `31. Sistema/arquitetura: *${process.platform} / ${process.arch}*\n` +
    `32. Núcleos de CPU detectados: *${cpuCount || 'indisponível'}*\n` +
    `33. Carga do sistema (1/5/15 min): *${load.map(n => n.toFixed(2)).join(' / ')}*\n` +
    `34. PID do processo: *${process.pid}*\n` +
    `35. Memória livre do aparelho: *${fmtMb(os.freemem())}*\n` +
    `36. Memória total do aparelho: *${fmtMb(os.totalmem())}*\n` +
    `37. Tempo para montar este relatório: *${fmtMs(performance.now() - statusStartedAt)}*\n\n` +
    `_Contadores e picos reiniciam quando o processo reinicia. Os tempos medem a duração local da chamada sendMessage do Baileys; não são ping nem confirmação de entrega ao aparelho. Event Loop é medido desde o início do processo; carga do sistema depende do suporte do Android._`;
  try {
    await sock.sendMessage(chatJid, { text: finalText, edit: placeholder?.key });
  } catch {
    await sock.sendMessage(chatJid, { text: finalText });
  }
}

export async function handleControlPanelMessage(sock, msg, context = {}) {
  const remoteJid = msg?.key?.remoteJid || '';
  if (!remoteJid || remoteJid === 'status@broadcast') return false;
  // Em grupos, o remetente real vem de key.participant (pode ser @lid).
  // Não usar remoteJid como remetente, pois ele é o ID do grupo.
  const senderJid = context.senderJid || msg?.key?.participant || (msg?.key?.fromMe ? context.ownerJid : remoteJid);
  const isOwner = typeof context.isOwner === 'function' && context.isOwner(senderJid);
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
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Aceita !grupo on/off sem alvo (atua no grupo da própria mensagem)
  // e também mantém !grupo on/off NOME para controlar outro grupo.
  const manualGroupMatch = normalized.match(new RegExp(`^${escapedPrefix}grupo\\s+(on|off)(?:\\s+(.+))?$`, 'i'));
  if (!isOwner && (statusCommand || groupsCommand || action.startsWith('ls_') || manualGroupMatch)) {
    await sock.sendMessage(remoteJid, { text: '⛔ Este painel é exclusivo do proprietário do bot.' });
    return true;
  }
  if (statusCommand) { await sendStatus(sock, remoteJid); return true; }
  if (groupsCommand || action === 'ls_groups') { await sendGroupMenu(sock, remoteJid, 0); return true; }
  if (manualGroupMatch) {
    const requested = String(manualGroupMatch[2] || '').trim();
    let groupJid = requested;
    let name = requested;

    // Sem nome/ID: controla o grupo onde o proprietário enviou o comando.
    if (!requested) {
      if (!remoteJid.endsWith('@g.us')) {
        await sock.sendMessage(remoteJid, { text: '❌ Para usar !grupo on/off sem nome, envie o comando dentro do próprio grupo. Para controlar outro grupo, use !grupos.' });
        return true;
      }
      groupJid = remoteJid;
      name = remoteJid;
      try { name = (await sock.groupMetadata(groupJid)).subject || name; } catch {}
    } else if (!requested.endsWith('@g.us')) {
      // Mantém compatibilidade com a forma antiga: !grupo on/off NOME.
      const allGroups = await getGroupsObject(sock);
      const matches = Object.entries(allGroups || {}).filter(([jid, meta]) =>
        jid.endsWith('@g.us') && String(meta?.subject || meta?.name || '').trim().toLocaleLowerCase('pt-BR') === requested.toLocaleLowerCase('pt-BR')
      );
      if (matches.length !== 1) {
        await sock.sendMessage(remoteJid, { text: matches.length > 1 ? '⚠️ Existem grupos com nomes iguais. Use os botões do !grupos para escolher com segurança.' : '❌ Não encontrei um grupo com esse nome exato. Confira a grafia e tente novamente.' });
        return true;
      }
      groupJid = matches[0][0];
      name = String(matches[0][1]?.subject || matches[0][1]?.name || requested);
    } else {
      try { name = (await sock.groupMetadata(groupJid)).subject || name; } catch {}
    }

    const enabled = manualGroupMatch[1] === 'on';
    const value = setGroupBotEnabled(groupJid, enabled, name, context.senderJid || remoteJid, getMessageTimestampMs(msg));
    if (value.enabled) await reconcileAfterActivation(sock);
    await sock.sendMessage(remoteJid, { text: `${value.enabled ? '🟢 Bot ativado' : '🔴 Bot desativado'} em *${value.groupName || groupJid}*.${requested ? '' : '\n\nEste comando controlou somente o grupo atual.'}` });
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
    const value = setGroupBotEnabled(groupJid, enabled, name, context.senderJid || remoteJid, getMessageTimestampMs(msg));
    if (value.enabled) await reconcileAfterActivation(sock);
    await sock.sendMessage(remoteJid, { text: `${value.enabled ? '🟢 Bot ativado' : '🔴 Bot desativado'} em *${value.groupName || groupJid}*.\n\nAs configurações de entrada e apresentação deste grupo foram preservadas.` });
    await sendGroupActions(sock, remoteJid, groupJid, name);
    return true;
  }
  return false;
}

export const __test = { readState, normalizeAction, formatDuration, decodeGroupId, STATE_FILE };
