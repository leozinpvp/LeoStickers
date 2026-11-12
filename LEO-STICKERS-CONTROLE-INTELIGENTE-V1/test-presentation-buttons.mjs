import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-presentation-buttons-'));
process.env.LEO_JOIN_APPROVAL_DATA = path.join(temp, 'join-data.json');
process.env.LEO_GROUP_CONTROL_FILE = path.join(temp, 'group-control.json');
const { __setBaileysApiForTests } = await import('./interactive-buttons.js');
let relayed;
__setBaileysApiForTests({
  generateWAMessageFromContent: (_jid, message) => ({ key: { id: 'INVITE' }, message }),
  normalizeMessageContent: message => message
});
const join = await import('./join-approval.js');
const groupJid = '120363000000000071@g.us';
const applicant = '5511999888777@s.whatsapp.net';
const cfg = join.__test.makeGroupConfig(groupJid, 'Grupo teste botões');
cfg.enabled = true;
fs.writeFileSync(process.env.LEO_JOIN_APPROVAL_DATA, JSON.stringify({
  groups: { [groupJid]: cfg }, applications: {}, activeByApplicant: {}
}));
const sentTexts = [];
const sock = {
  user: { id: '5511888777666@s.whatsapp.net' },
  relayMessage: async (...args) => { relayed = args; },
  groupMetadata: async () => ({ subject: 'Grupo teste botões', participants: [] }),
  sendMessage: async (jid, message) => { sentTexts.push({ jid, message }); return { key: { id: 'SENT' } }; }
};
await join.handleGroupJoinRequest(sock, { id: groupJid, participant: applicant, action: 'created' });
assert.ok(relayed, 'convite interativo foi enviado');
const buttons = relayed[1].interactiveMessage.nativeFlowMessage.buttons;
assert.equal(buttons[0].name, 'quick_reply');
assert.equal(buttons[1].name, 'cta_copy');
const startId = JSON.parse(buttons[0].buttonParamsJson).id;
assert.match(startId, /^ls_start_presentation_[a-f0-9]{6}$/i);
assert.match(JSON.parse(buttons[1].buttonParamsJson).copy_code, /Nome:/);

await join.handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant, fromMe: false },
  message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: startId }) } } }
});
assert.ok(sentTexts.some(item => String(item.message?.text || '').includes('Apresentação iniciada')),
  'o botão Iniciar apresentação iniciou o fluxo sem comando digitado');
fs.rmSync(temp, { recursive: true, force: true });
console.log('PASSOU: convite envia botão Copiar modelo + Iniciar apresentação; resposta do botão abre o formulário pelo código.');
