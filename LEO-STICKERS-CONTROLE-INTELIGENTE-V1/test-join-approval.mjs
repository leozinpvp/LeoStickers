import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-join-full-presentation-'));
process.env.LEO_JOIN_APPROVAL_DATA = path.join(temp, 'join-approval-data.json');
const mod = await import(new URL('./join-approval.js', import.meta.url).href + `?t=${Date.now()}`);
const { __test, handleJoinApprovalCommand, handleGroupJoinRequest, handleApplicantPrivateMessage } = mod;

function ctxFor(jid, command, value, sock) {
  return {
    jid,
    sender: '5511999990000@s.whatsapp.net',
    msg: { key: { participant: '5511999990000@s.whatsapp.net' } },
    command,
    value,
    sock,
    isOwner: () => true,
    send: async (_jid, message) => { sent.push({ jid: _jid, content: { text: message } }); return true; }
  };
}

assert.equal(__test.normalizeJid('55119999:4@s.whatsapp.net'), '55119999@s.whatsapp.net');

const simpleCfg = __test.makeGroupConfig('120363000000000099@g.us', 'Grupo de teste');
assert.equal(simpleCfg.maxAge, null, 'grupo novo não herda idade/cláusulas de outro grupo');
const knownMocidade = __test.makeGroupConfig(__test.LEGACY_MOCIDADE_GROUP_ID, 'Nome pode mudar sem afetar regra');
assert.equal(knownMocidade.maxAge, 30, 'limite da Mocidade é identificado pelo JID, não pelo nome');
const customA = __test.makeGroupConfig('120363000000000101@g.us', 'Grupo A');
const customB = __test.makeGroupConfig('120363000000000102@g.us', 'Grupo B');
customA.clauses = ['Regra exclusiva do A'];
assert.deepEqual(customB.clauses, [], 'grupo novo começa sem copiar cláusulas de outro grupo');
const isolatedData = { groups: {} };
const isolatedA = __test.getGroupConfig(isolatedData, '120363000000000103@g.us', 'A');
const isolatedB = __test.getGroupConfig(isolatedData, '120363000000000104@g.us', 'B');
isolatedA.clauses.push('Só vale no grupo A');
assert.equal(isolatedB.clauses.length, 0, 'salvar cláusula em um JID não altera o outro');
const overAge = __test.evaluateApplication({ ageConfirmed: true, fields: { age: 60 } }, simpleCfg.maxAge == null ? { ...simpleCfg, maxAge: 30 } : simpleCfg);
assert.equal(overAge.status, 'rejected', 'idade acima do limite deve bloquear mesmo se outros campos faltarem');
assert.equal(overAge.rejectionType, 'age_maximum');
const overAgeSixty = __test.evaluateApplication({ ageConfirmed: true, fields: { age: 60 } }, { ...simpleCfg, maxAge: 30 });
assert.equal(overAgeSixty.status, 'rejected', '60 anos deve ser bloqueado pelo mesmo limite');
assert.deepEqual(__test.positionalFieldOrder(simpleCfg), [
  'name', 'age', 'common', 'role', 'instagram', 'baptized', 'civilStatus',
  'privateAllowed', 'publishConsent'
]);

// Idade: aceita somente uma idade plausível e não coleta números soltos de frases.
for (const value of ['15', '15 anos', 'tenho 15 anos']) {
  const parsedAge = __test.parseApplicationText(`Nome: Leo\nIdade: ${value}`, simpleCfg, { fields: {} });
  assert.equal(parsedAge.age, 15, `deve aceitar ${value}`);
}
for (const value of ['quinze', '15 e meio', '15.5', '0', '121', '2009', 'meu número é 15']) {
  const parsedAge = __test.parseApplicationText(`Nome: Leo\nIdade: ${value}`, simpleCfg, { fields: {} });
  assert.equal(parsedAge.age, undefined, `não deve aceitar ${value} como idade`);
  assert.ok(parsedAge.errors.length, `deve explicar que ${value} não é idade válida`);
}

// Um valor inválido na segunda posição não desloca Comum para Idade.
const invalidPositional = __test.parseApplicationText('Leo\nquinze\nJajá\nMembro', simpleCfg, { fields: {} });
assert.equal(invalidPositional.name, 'Leo');
assert.equal(invalidPositional.age, undefined);
assert.equal(invalidPositional.common, 'Jajá');
assert.equal(invalidPositional.role, 'Membro');
assert.ok(invalidPositional.errors.length);

const fullPositionalCfg = { ...simpleCfg, clauses: ['Regra exclusiva do teste'], requireCCB: true, requireNoRelationship: true, requireClauseAcceptance: true };
const fullPositional = __test.parseApplicationText([
  'Leo', '15', 'Jajá', 'Membro', '@leo', 'Sim', 'Solteiro', 'Sim',
  'Sim', 'Sim', 'Não', 'Sim'
].join('\n'), fullPositionalCfg, { fields: {} });
assert.equal(fullPositional.name, 'Leo');
assert.equal(fullPositional.age, 15);
assert.equal(fullPositional.common, 'Jajá');
assert.equal(fullPositional.role, 'Membro');
assert.equal(fullPositional.instagram, '@leo');
assert.equal(fullPositional.baptized, 'Sim');
assert.equal(fullPositional.civilStatus, 'Solteiro');
assert.equal(fullPositional.privateAllowed, 'Sim');
assert.equal(fullPositional.ccb, true);
assert.equal(fullPositional.acceptedClauses, true);
assert.equal(fullPositional.relationshipIntent, false);
assert.equal(fullPositional.publishConsent, true);

// Migração de grupos antigos: liga todos os dados completos sem sobrescrever
// um campo que o administrador desligar explicitamente após a atualização.
const oldGroupConfig = __test.makeGroupConfig('120363000000000098@g.us', 'Grupo antigo');
oldGroupConfig.presentationSchemaVersion = 1;
oldGroupConfig.fields.role = false;
oldGroupConfig.fields.instagram = false;
const migrated = __test.getGroupConfig({ groups: { [oldGroupConfig.groupJid]: oldGroupConfig } }, oldGroupConfig.groupJid);
assert.equal(migrated.fields.role, true);
assert.equal(migrated.fields.instagram, true);
const overridden = { ...oldGroupConfig, presentationSchemaVersion: 1, fields: { ...oldGroupConfig.fields, role: false }, fieldOverrides: { role: true } };
const preservedOverride = __test.getGroupConfig({ groups: { [overridden.groupJid]: overridden } }, overridden.groupJid);
assert.equal(preservedOverride.fields.role, false);

const groupJid = '120363000000000001@g.us';
const group2 = '120363000000000002@g.us';
const applicant = '5511888887777@s.whatsapp.net';
const applicant2 = '5511888886666@s.whatsapp.net';
const applicant3 = '5511888885555@s.whatsapp.net';
const applicant4 = '5511888884444@s.whatsapp.net';
const applicant5 = '5511888883333@s.whatsapp.net';
const sent = [];
const approved = [];
let joinMode = null;
const sock = {
  user: { id: '5511777776666@s.whatsapp.net' },
  groupMetadata: async jid => ({
    id: jid,
    subject: jid === groupJid ? 'MOCIDADE CCB' : 'OUTRO GRUPO',
    participants: [
      { id: '5511999990000@s.whatsapp.net', admin: 'superadmin' },
      { id: '5511777776666@s.whatsapp.net', admin: 'admin' }
    ]
  }),
  groupJoinApprovalMode: async (jid, mode) => { assert.equal(jid, groupJid); joinMode = mode; },
  sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; },
  groupRequestParticipantsUpdate: async (jid, jids, action) => {
    approved.push({ jid, jids, action });
    return jids.map(jid => ({ status: '200', jid }));
  },
  groupRequestParticipantsList: async () => [],
  updateMediaMessage: async () => null
};

await handleJoinApprovalCommand(ctxFor(groupJid, 'criarclausulas', 'Respeite todos os participantes | Mantenha o foco no propósito deste grupo', sock));
await handleJoinApprovalCommand(ctxFor(groupJid, 'entrada', 'on', sock));
assert.equal(joinMode, 'on');
await handleJoinApprovalCommand(ctxFor(groupJid, 'autoaprovarsolicitacao', 'on', sock));

// Todos os campos do formulário original são obrigatórios para este grupo.
let db = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
db.groups[groupJid].fields = {
  photo: true, name: true, age: true, common: true, role: true, instagram: true,
  baptized: true, civilStatus: true, privateAllowed: true
};
db.groups[groupJid].maxAge = 30;
db.groups[groupJid].minAge = null;
db.groups[groupJid].requireCCB = true;
db.groups[groupJid].requireNoRelationship = true;
db.groups[groupJid].requireClauseAcceptance = true;
db.groups[groupJid].presentationSchemaVersion = 2;
fs.writeFileSync(process.env.LEO_JOIN_APPROVAL_DATA, JSON.stringify(db, null, 2));

async function startAndSendImage(person, codeCommand = 'apresentação') {
  assert.equal(await handleGroupJoinRequest(sock, { id: groupJid, participant: person, action: 'created' }), true);
  const all = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
  const app = Object.values(all.applications).find(x => x.participant === person);
  assert.ok(app?.code);
  assert.equal(await handleApplicantPrivateMessage(sock, {
    key: { remoteJid: person, fromMe: false },
    message: { conversation: codeCommand === 'apresentação' ? codeCommand : `!apresentação ${app.code}` }
  }), true);
  assert.equal(await handleApplicantPrivateMessage(sock, {
    key: { remoteJid: person, fromMe: false },
    message: { imageMessage: { mimetype: 'image/jpeg' } },
    _leoPhotoBuffer: Buffer.from(`photo-${person}`)
  }), true);
  return app;
}

const fullForm = [
  'Nome: Maria Silva',
  'Idade: 15 anos',
  'Comum: Centro',
  'Cargo: Membro',
  'Instagram: @maria',
  'Batizado(a): Sim',
  'Estado civil: Solteira',
  'PV liberado: Sim',
  'Sou da CCB: Sim',
  'Aceito as cláusulas: Sim',
  'Intenção de relacionamento: Não',
  'Autorizo publicar no grupo: Sim'
].join('\n');

const app1 = await startAndSendImage(applicant, 'apresentação');
assert.equal(await handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant, fromMe: false },
  message: { conversation: fullForm }
}), true);

let resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app1.code].status, 'awaiting_age_confirmation');
assert.equal(resultDb.applications[app1.code].pendingAgeConfirmation, 15);
assert.equal(resultDb.applications[app1.code].fields.age, undefined, 'idade não pode ser registrada antes da confirmação');
assert.equal(approved.length, 0, 'não pode aprovar antes da confirmação explícita da idade');
await handleJoinApprovalCommand(ctxFor(groupJid, 'aprovarsolicitacao', app1.code, sock));
assert.equal(approved.length, 0, 'nem o comando manual pode ignorar a confirmação da idade');
assert.equal(sent.filter(x => x.jid === groupJid && (Buffer.isBuffer(x.content?.image) || x.content?.text?.includes('APRESENTAÇÃO —'))).length, 0, 'não pode publicar enquanto a pessoa ainda não entrou');
assert.ok(sent.some(x => x.jid === applicant && /15 anos.*confirma/i.test(x.content.text)), 'bot deve perguntar se a idade está correta');
await handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant, fromMe: false },
  message: { conversation: 'confirmo' }
});
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app1.code].pendingAgeConfirmation, 15, 'somente SIM/NÃO deve responder à confirmação');
assert.equal(approved.length, 0, 'resposta diferente de SIM não pode aprovar');

await handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant, fromMe: false },
  message: { conversation: 'SIM' }
});
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app1.code].fields.age, 15);
assert.equal(resultDb.applications[app1.code].ageConfirmed, true);
assert.equal(resultDb.applications[app1.code].status, 'awaiting_entry');
assert.equal(approved.length, 1, 'depois de confirmar idade pode solicitar aprovação');
assert.equal(resultDb.applications[app1.code].presentationPublishedAt, undefined, 'a publicação deve aguardar a entrada real');

await handleGroupJoinRequest(sock, { id: groupJid, participants: [applicant], action: 'add' });
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app1.code].status, 'approved');
assert.ok(resultDb.applications[app1.code].presentationPublishedAt);
assert.ok(sent.some(x => x.jid === groupJid && Buffer.isBuffer(x.content.image)), 'foto deve ser publicada no grupo só depois da entrada');
const publicText = sent.find(x => x.jid === groupJid && typeof x.content.text === 'string' && x.content.text.includes('APRESENTAÇÃO —'));
assert.ok(publicText, 'a apresentação completa deve ser publicada no grupo');
for (const detail of ['Maria Silva', '15 anos', 'Centro', 'Membro', '@maria', 'Solteira', 'Aceitas']) {
  assert.ok(publicText.content.text.includes(detail), `a publicação deve incluir ${detail}`);
}
assert.equal(approved.length, 1);
assert.equal(approved[0].action, 'approve');
assert.equal(approved[0].jids[0], applicant);

// 15 anos passa; acima de 30 anos deve ser recusado definitivamente pelo WhatsApp.
const app2 = await startAndSendImage(applicant2, '!apresentação');
const tooOldForm = fullForm.replace('Idade: 15 anos', 'Idade: 31 anos');
const beforeOverAgePosts = sent.filter(x => x.jid === groupJid && x.content?.text?.includes('APRESENTAÇÃO —')).length;
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant2, fromMe: false }, message: { conversation: tooOldForm } });
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant2, fromMe: false }, message: { conversation: 'SIM' } });
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app2.code].status, 'rejected');
assert.equal(approved.length, 2, 'a idade acima do limite deve gerar uma recusa, nunca aprovação');
assert.equal(approved[1].action, 'reject', 'o bot deve enviar a recusa ao WhatsApp');
assert.equal(approved[1].jids[0], applicant2);
await handleJoinApprovalCommand(ctxFor(groupJid, 'aprovarsolicitacao', app2.code, sock));
assert.equal(approved.filter(item => item.action === 'approve' && item.jids[0] === applicant2).length, 0, 'administrador não pode aprovar idade acima do limite pelo bot');
assert.ok(sent.some(x => x.jid === groupJid && /solicitação já encerrada/.test(x.content?.text || '')), 'bot deve impedir uma nova aprovação depois da recusa definitiva');
assert.equal(sent.filter(x => x.jid === groupJid && x.content?.text?.includes('APRESENTAÇÃO —')).length, beforeOverAgePosts, 'idade fora do limite não pode publicar a apresentação');

// Se a API do WhatsApp falhar ao recusar, o bot mantém a aprovação bloqueada.
const app5 = await startAndSendImage(applicant5, '!apresentação');
const originalRequestUpdate = sock.groupRequestParticipantsUpdate;
sock.groupRequestParticipantsUpdate = async (jid, jids, action) => {
  if (action === 'reject' && jids[0] === applicant5) throw new Error('falha simulada da API');
  return originalRequestUpdate(jid, jids, action);
};
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant5, fromMe: false }, message: { conversation: tooOldForm } });
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant5, fromMe: false }, message: { conversation: 'SIM' } });
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app5.code].status, 'age_rejection_pending');
await handleJoinApprovalCommand(ctxFor(groupJid, 'aprovarsolicitacao', app5.code, sock));
assert.equal(approved.filter(item => item.action === 'approve' && item.jids[0] === applicant5).length, 0, 'falha na API também não pode liberar aprovação manual');
assert.ok(sent.some(x => x.jid === groupJid && /APROVAÇÃO BLOQUEADA/.test(x.content?.text || '')), 'administrador deve receber aviso de bloqueio');
// A recusa pode ser tentada novamente pelo comando manual.
sock.groupRequestParticipantsUpdate = originalRequestUpdate;
await handleJoinApprovalCommand(ctxFor(groupJid, 'recusarsolicitacao', app5.code, sock));
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app5.code].status, 'rejected');

// Responder NÃO cancela a idade provisória e exige novo valor; nunca aprova.
const app4 = await startAndSendImage(applicant4, '!apresentação');
await handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant4, fromMe: false },
  message: { conversation: 'Nome: João\nIdade: 18' }
});
let ageDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(ageDb.applications[app4.code].pendingAgeConfirmation, 18);
await handleApplicantPrivateMessage(sock, {
  key: { remoteJid: applicant4, fromMe: false },
  message: { conversation: 'NÃO' }
});
ageDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(ageDb.applications[app4.code].fields.age, undefined);
assert.equal(ageDb.applications[app4.code].pendingAgeConfirmation, undefined);
assert.equal(ageDb.applications[app4.code].ageConfirmed, false);
assert.equal(approved.filter(item => item.action === 'approve').length, 1, 'responder NÃO nunca pode aprovar');

// Sem autorização, não publica dados nem foto e não aprova.
const app3 = await startAndSendImage(applicant3, 'apresentação');
const noConsentForm = fullForm.replace('Autorizo publicar no grupo: Sim', 'Autorizo publicar no grupo: Não');
const beforeNoConsentPosts = sent.filter(x => x.jid === groupJid && x.content?.text?.includes('APRESENTAÇÃO —')).length;
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant3, fromMe: false }, message: { conversation: noConsentForm } });
await handleApplicantPrivateMessage(sock, { key: { remoteJid: applicant3, fromMe: false }, message: { conversation: 'SIM' } });
resultDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(resultDb.applications[app3.code].status, 'review');
assert.equal(approved.filter(item => item.action === 'approve').length, 1, 'sem consentimento não pode aprovar');
assert.equal(sent.filter(x => x.jid === groupJid && x.content?.text?.includes('APRESENTAÇÃO —')).length, beforeNoConsentPosts, 'sem consentimento não pode publicar');

// Outros grupos mantêm configuração independente, com formulário completo por padrão.
await handleJoinApprovalCommand(ctxFor(group2, 'criarclausulas', 'Seja respeitoso | Não faça propaganda', sock));
db = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.notEqual(db.groups[groupJid], db.groups[group2]);
assert.equal(db.groups[group2].enabled, false);
assert.equal(db.groups[group2].autoAccept, false);
assert.equal(db.groups[group2].fields.instagram, true);
assert.equal(db.groups[group2].fields.civilStatus, true);
assert.deepEqual(db.groups[group2].clauses, ['Seja respeitoso', 'Não faça propaganda']);

// Cada administrador personaliza os campos do próprio grupo, sem afetar os demais.
await handleJoinApprovalCommand(ctxFor(group2, 'clausulas', 'campo instagram off', sock));
await handleJoinApprovalCommand(ctxFor(group2, 'clausulas', 'campo cargo off', sock));
db = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(db.groups[group2].fields.instagram, false);
assert.equal(db.groups[group2].fields.role, false);
assert.equal(db.groups[group2].fields.instagram, false);
assert.equal(db.groups[groupJid].fields.instagram, true, 'configuração de outro grupo deve permanecer intacta');
await handleJoinApprovalCommand(ctxFor(group2, 'clausulas', 'campo todos off', sock));
db = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.ok(Object.values(db.groups[group2].fields).every(value => value === false), 'todos deve desligar todos os campos');
await handleJoinApprovalCommand(ctxFor(group2, 'clausulas', 'campo nome on', sock));
db = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(db.groups[group2].fields.name, true, 'campo individual pode ser reativado depois de todos off');
assert.equal(db.groups[group2].fields.age, false);

await handleJoinApprovalCommand(ctxFor(groupJid, 'entrada', 'off', sock));
assert.equal(joinMode, 'on', 'pausar mensagens privadas não deve desligar aprovação nativa');
const pausedDb = JSON.parse(fs.readFileSync(process.env.LEO_JOIN_APPROVAL_DATA, 'utf8'));
assert.equal(pausedDb.groups[groupJid].enabled, false);

console.log('PASSOU: confirmação SIM/NÃO, 15 anos aceito, 31 anos recusado, bloqueio manual mesmo com falha da API, consentimento e publicação somente após entrada real.');
fs.rmSync(temp, { recursive: true, force: true });
