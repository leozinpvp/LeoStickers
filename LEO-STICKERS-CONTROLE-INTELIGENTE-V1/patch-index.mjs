import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Informe o caminho do index.js.');
let source = fs.readFileSync(file, 'utf8');
const joinImport = "import { handleApplicantPrivateMessage, handleGroupJoinRequest, resumeGroupJoinRequests } from './join-approval.js';";
if (!source.includes(joinImport)) {
  throw new Error('O index.js não usa o handler de entrada multigrupo V2 esperado. Instale/teste a V2 antes desta atualização.');
}
if (!source.includes('handleGroupJoinRequest(currentSock, update)')) {
  throw new Error('O listener group-participants.update não chama o handler de entrada V2. Não vou substituir seu listener automaticamente.');
}
const controlImport = "import { handleControlPanelMessage, isGroupBotEnabled, recordInboundMessage, recordConnectionUpdate } from './control-panel.js';";
if (!source.includes(controlImport)) source = source.replace(joinImport, `${joinImport}\n${controlImport}`);

// O guard é aplicado no início do evento de participantes; evita que recursos
// de grupo sejam executados enquanto o grupo estiver pausado.
const participantStart = "currentSock.ev.on('group-participants.update', update => {";
if (!source.includes(participantStart)) throw new Error('Listener group-participants.update não encontrado.');
if (!source.includes('LEO_CONTROL_GROUP_PARTICIPANTS_GUARD_V1')) {
  source = source.replace(participantStart, `${participantStart}\n      if (update?.id && !isGroupBotEnabled(update.id)) { console.log('[CONTROLE] Evento de participantes ignorado: grupo pausado.'); return; } // LEO_CONTROL_GROUP_PARTICIPANTS_GUARD_V1`);
}

const joinRequestStart = "currentSock.ev.on('group.join-request', request => {";
if (source.includes(joinRequestStart) && !source.includes('LEO_CONTROL_GROUP_REQUEST_GUARD_V1')) {
  source = source.replace(joinRequestStart, `${joinRequestStart}\n      if (request?.id && !isGroupBotEnabled(request.id)) { console.log('[CONTROLE] Solicitação ignorada: grupo pausado.'); return; } // LEO_CONTROL_GROUP_REQUEST_GUARD_V1`);
}

// Mede as reconexões no processo atual.
const connectionStart = "      async update => {\n        const {\n          connection,\n          lastDisconnect,\n          handshakeReady\n        } = update;";
if (!source.includes('recordConnectionUpdate(update)')) {
  if (!source.includes(connectionStart)) throw new Error('Não encontrei o início esperado do listener connection.update.');
  source = source.replace(connectionStart, "      async update => {\n        recordConnectionUpdate(update); // LEO_CONTROL_CONNECTION_METRICS_V1\n        const {\n          connection,\n          lastDisconnect,\n          handshakeReady\n        } = update;");
}

// Reorganiza o começo do loop para que o corte de mensagens antigas e a pausa
// por grupo aconteçam antes de qualquer handler que possa responder.
const oldMessageBlock = `        for (const msg of messages) {
          if (await handleMutedMessage(currentSock, msg)) continue; // LEO_STICKERS_COMMUNITY_MUTE_HOOK_V1
          const sentAtMs = getMessageTimestampMs(msg);
          if (sentAtMs !== null && sentAtMs < messageCutoffTimestampMs) {
            console.log('[IGNORADA] Mensagem enviada antes do início desta conexão.');
            continue;
          }
          if (await handleApplicantPrivateMessage(currentSock, msg)) continue;`;
const newMessageBlock = `        for (const msg of messages) {
          const sentAtMs = getMessageTimestampMs(msg);
          if (sentAtMs !== null && sentAtMs < messageCutoffTimestampMs) {
            console.log('[IGNORADA] Mensagem enviada antes do início desta conexão.');
            continue;
          }
          recordInboundMessage(); // LEO_CONTROL_MESSAGE_METRICS_V1
          const controlRemoteJid = msg.key?.remoteJid || '';
          if (controlRemoteJid.endsWith('@g.us') && !isGroupBotEnabled(controlRemoteJid)) {
            console.log('[CONTROLE] Mensagem ignorada: bot pausado neste grupo.');
            continue;
          }
          if (await handleMutedMessage(currentSock, msg)) continue; // LEO_STICKERS_COMMUNITY_MUTE_HOOK_V1
          if (await handleControlPanelMessage(currentSock, msg, { isOwner, senderJid: controlRemoteJid, prefix: config.prefix })) continue; // LEO_CONTROL_PANEL_HOOK_V1
          if (await handleApplicantPrivateMessage(currentSock, msg)) continue;`;
if (source.includes(oldMessageBlock)) {
  source = source.replace(oldMessageBlock, newMessageBlock);
} else if (!source.includes('LEO_CONTROL_PANEL_HOOK_V1')) {
  throw new Error('Não encontrei o loop messages.upsert esperado da V2. Nenhum patch adicional foi aplicado.');
}

fs.writeFileSync(file, source);
console.log('Patch do index.js aplicado/verificado.');
