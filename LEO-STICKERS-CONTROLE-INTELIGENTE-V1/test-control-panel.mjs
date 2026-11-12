import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-control-panel-'));
process.env.LEO_GROUP_CONTROL_FILE = path.join(temp, 'groups.json');
const panel = await import(new URL('./control-panel.js', import.meta.url).href + `?test=${Date.now()}`);
const group = '120363000000000001@g.us';
assert.equal(panel.isGroupBotEnabled(group), true, 'grupo é ativo por padrão');
panel.setGroupBotEnabled(group, false, 'Grupo de teste', 'owner@s.whatsapp.net');
assert.equal(panel.isGroupBotEnabled(group), false, 'grupo pausado fica desativado');
const saved = JSON.parse(fs.readFileSync(process.env.LEO_GROUP_CONTROL_FILE, 'utf8'));
assert.equal(saved.groups[group].groupName, 'Grupo de teste');
assert.equal(saved.groups[group].enabled, false);
panel.setGroupBotEnabled(group, true, 'Grupo de teste', 'owner@s.whatsapp.net');
assert.equal(panel.isGroupBotEnabled(group), true, 'reativação restaura o processamento');

const { __setBaileysApiForTests, sendInteractiveMessage } = await import('./interactive-buttons.js');
let relayed = null;
__setBaileysApiForTests({
  generateWAMessageFromContent: (jid, message) => ({ key: { id: 'TESTMSG' }, message }),
  normalizeMessageContent: message => message
});
await sendInteractiveMessage({
  user: { id: 'bot@s.whatsapp.net' },
  relayMessage: async (...args) => { relayed = args; }
}, '5511999999999@s.whatsapp.net', {
  text: 'Teste',
  buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Abrir', id: 'ls_test' }) }]
});
assert.ok(relayed, 'mensagem interativa foi encaminhada');
assert.equal(relayed[1].interactiveMessage.nativeFlowMessage.buttons.length, 1);
assert.equal(relayed[2].additionalNodes[0].tag, 'biz');
assert.equal(relayed[2].additionalNodes[1].tag, 'bot');

const { __test } = panel;
assert.equal(__test.formatDuration(90061000), '1d 1h 1min 1s');
assert.equal(__test.decodeGroupId(`ls_group_${Buffer.from(group).toString('base64url')}`), group);

let panelRelay = null;
const owner = '5511999999999@s.whatsapp.net';
const panelSock = {
  user: { id: '15551234567@s.whatsapp.net' },
  relayMessage: async (...args) => { panelRelay = args; },
  groupFetchAllParticipating: async () => ({ [group]: { subject: 'Grupo de teste' } }),
  groupMetadata: async () => ({ subject: 'Grupo de teste', participants: [] }),
  sendMessage: async () => ({ key: { id: 'SENT' } }),
  groupRequestParticipantsList: async () => []
};
const context = { isOwner: () => true, senderJid: owner, prefix: '!' };
await panel.handleControlPanelMessage(panelSock, { key: { remoteJid: owner, fromMe: false }, message: { conversation: '!grupos' } }, context);
assert.equal(panelRelay[1].interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
const selectAction = `ls_group_${Buffer.from(group).toString('base64url')}`;
await panel.handleControlPanelMessage(panelSock, { key: { remoteJid: owner, fromMe: false }, message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: selectAction }) } } } }, context);
assert.equal(panelRelay[1].interactiveMessage.nativeFlowMessage.buttons.length, 3, 'seleção de grupo mostra três ações');
const disableAction = `ls_disable_${Buffer.from(group).toString('base64url')}`;
await panel.handleControlPanelMessage(panelSock, { key: { remoteJid: owner, fromMe: false }, message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: disableAction }) } } } }, context);
assert.equal(panel.isGroupBotEnabled(group), false, 'botão Desativar altera grupo selecionado');
fs.rmSync(temp, { recursive: true, force: true });
console.log('PASSOU: pausa persistente por JID, menu de grupos, seleção, botão desativar, restauração, IDs e formatação.');
