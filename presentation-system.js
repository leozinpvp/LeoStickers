import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = path.resolve('./apresentacao-config.json');
const POLL_INTERVAL_MS = 180000;
const pendingSessions = new Map();
let activeSocket = null;
let pollTimer = null;
let pollInProgress = false;

export const PRESENTATION_COMMANDS = Object.freeze(['autoaceitar', 'clausulas']);


function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!config || typeof config !== 'object') throw new Error('configuração inválida');
    return config;
  } catch (error) {
    console.error('[APRESENTAÇÃO] Não foi possível ler a configuração:', String(error?.message || error));
    return { enabled: false };
  }
}

function normalizeGroupName(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanJid(value) {
  return String(value || '').trim().toLowerCase();
}

function unwrapMessage(message) {
  let current = message || {};
  for (let i = 0; i < 10 && current; i++) {
    const next = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message;
    if (!next) break;
    current = next;
  }
  return current || {};
}

function messageText(msg) {
  const message = unwrapMessage(msg?.message);
  return String(
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  ).trim();
}

function hasPhoto(msg) {
  const message = unwrapMessage(msg?.message);
  const image = message.imageMessage;
  return Boolean(image && (image.mimetype || '').toLowerCase().startsWith('image/'));
}

function extractLabel(text, labels) {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text || '').match(new RegExp(`^\\s*(?:${escaped})\\s*[:=-]\\s*(.*?)\\s*$`, 'im'));
  return match ? match[1].trim() : '';
}

function yesNo(value) {
  const v = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (/^(nao|não|n|negativo|recuso|discordo|nenhuma|sem)$/.test(v)) return false;
  if (/^(sim|s|yes|aceito|concordo|sou|tenho)$/.test(v)) return true;
  return null;
}

function parsePresentation(text) {
  const name = extractLabel(text, ['nome']);
  const common = extractLabel(text, ['comum']);
  const ageText = extractLabel(text, ['idade']);
  const ageMatch = ageText.match(/\b(\d{1,3})\b/);
  const age = ageMatch ? Number(ageMatch[1]) : null;
  const ccbText = extractLabel(text, ['ccb', 'sou da ccb', 'denominacao', 'denominação']);
  const rulesText = extractLabel(text, ['regras', 'aceito as regras', 'li e aceito as regras']);
  const relationshipText = extractLabel(text, ['intencao de relacionamento', 'intenção de relacionamento', 'relacionamento']);
  const cargo = extractLabel(text, ['cargo']);
  const instagram = extractLabel(text, ['instagram', '@ do insta', 'insta']);
  const batizadoText = extractLabel(text, ['batizado', 'batizada', 'batismo']);
  const estadoCivil = extractLabel(text, ['estado civil']);
  const pvLiberadoText = extractLabel(text, ['pv liberado', 'privado liberado']);

  let ccb = yesNo(ccbText);
  if (ccb === null && /\bsou da (?:ccb|congregacao crista no brasil)\b/i.test(text)) ccb = true;
  if (ccb === null && /\bnao sou da ccb\b|\bsou de outra denominacao\b/i.test(text)) ccb = false;

  let rulesAccepted = yesNo(rulesText);
  let relationshipIntent = yesNo(relationshipText);
  let batizado = yesNo(batizadoText);
  let pvLiberado = yesNo(pvLiberadoText);

  return { name, common, age, ccb, rulesAccepted, relationshipIntent, cargo, instagram, batizado, estadoCivil, pvLiberado };
}

async function identityAliases(sock, value) {
  const aliases = new Set();
  const add = item => {
    const normalized = cleanJid(item);
    if (normalized) aliases.add(normalized);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (value && typeof value === 'object') {
    for (const key of ['jid', 'id', 'lid', 'phoneNumber', 'participant', 'participantAlt', 'remoteJidAlt']) add(value[key]);
  } else add(value);

  const mapping = sock?.signalRepository?.lidMapping;
  for (const alias of [...aliases]) {
    try {
      if (alias.endsWith('@lid') && typeof mapping?.getPNForLID === 'function') {
        const pn = await mapping.getPNForLID(alias);
        if (pn) add(pn);
      } else if (alias.endsWith('@s.whatsapp.net') && typeof mapping?.getLIDForPN === 'function') {
        const lid = await mapping.getLIDForPN(alias);
        if (lid) add(lid);
      }
    } catch {}
  }
  return aliases;
}

function aliasesOverlap(a, b) {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

function requestJid(request) {
  return request?.jid || request?.id || request?.participant || request?.phoneNumber || null;
}

async function findTargetGroup(sock, config) {
  if (typeof sock.groupFetchAllParticipating !== 'function') {
    throw new Error('Esta versão do socket não oferece groupFetchAllParticipating.');
  }
  const groups = await sock.groupFetchAllParticipating();
  const wanted = normalizeGroupName(config.groupName || 'MOCIDADE CCB');
  const matches = Object.entries(groups || {}).filter(([, group]) =>
    normalizeGroupName(group?.subject) === wanted
  );
  if (matches.length !== 1) {
    if (matches.length > 1) console.warn('[APRESENTAÇÃO] Há mais de um grupo com esse nome; fluxo pausado por segurança.');
    return null;
  }
  return { jid: matches[0][0], subject: matches[0][1]?.subject || config.groupName };
}

async function sendPrompt(sock, jid, groupName) {
  const config = readConfig();
  const required = new Set(config.required || ['foto', 'nome', 'idade', 'comum']);
  const lines = [
    `🙌 Olá! Você solicitou entrada no grupo ${groupName}.`,
    '',
    'Para concluir sua apresentação, responda neste privado. Os dados não serão publicados no grupo:',
    ''
  ];
  if (required.has('foto')) lines.push('📷 Envie uma foto pessoal.');
  if (required.has('nome')) lines.push('Nome: ');
  if (required.has('idade')) lines.push('Idade: ');
  if (required.has('comum')) lines.push('Comum: ');
  if (required.has('cargo')) lines.push('Cargo: ');
  if (required.has('instagram')) lines.push('Instagram: ');
  if (required.has('batizado')) lines.push('Batizado(a): SIM ou NÃO');
  if (required.has('estadoCivil')) lines.push('Estado civil: ');
  if (required.has('pvLiberado')) lines.push('PV liberado: SIM ou NÃO');
  if (config.eligibility?.mustDeclareCCB !== false) lines.push('CCB: SIM ou NÃO');
  if (config.eligibility?.mustAcceptGroupRules !== false) lines.push('Regras: ACEITO ou NÃO');
  if (config.eligibility?.relationshipIntentAllowed === false) lines.push('Intenção de relacionamento no grupo: SIM ou NÃO (é proibida)');
  const optionalLabels = [
    ['foto', 'foto'], ['nome', 'nome'], ['comum', 'comum'],
    ['cargo', 'cargo'], ['instagram', 'Instagram'], ['batizado', 'batismo'],
    ['estadoCivil', 'estado civil'], ['pvLiberado', 'PV liberado']
  ].filter(([key]) => !required.has(key)).map(([, label]) => label);
  if (optionalLabels.length) lines.push('', `Opcional: ${optionalLabels.join(', ')}.`);
  const maximum = config.age?.maximum;
  lines.push(maximum === null || maximum === undefined
    ? 'Não existe idade mínima nem máxima configurada.'
    : `Não existe idade mínima. A idade máxima é ${maximum} anos (inclusive).`);
  lines.push('Não existe prazo para se apresentar; a solicitação fica pendente até ser concluída ou analisada pelos administradores.');
  lines.push('A foto será usada somente para verificar a apresentação e não será armazenada permanentemente pelo bot.');
  lines.push(config.automaticApproval === true
    ? 'Quando todos os campos e declarações exigidos forem claros e compatíveis, o sistema poderá aprovar automaticamente.'
    : 'A aprovação automática está DESATIVADA. Depois da apresentação, os administradores analisarão a solicitação.');
  await sock.sendMessage(jid, { text: lines.join('\n') });
}

async function requestList(sock, groupJid) {
  if (typeof sock.groupRequestParticipantsList !== 'function') {
    throw new Error('Baileys não expõe groupRequestParticipantsList neste socket.');
  }
  const list = await sock.groupRequestParticipantsList(groupJid);
  return Array.isArray(list) ? list : [];
}

async function findRequest(sock, groupJid, aliases) {
  const list = await requestList(sock, groupJid);
  for (const request of list) {
    const jid = requestJid(request);
    if (!jid) continue;
    const requestAliases = await identityAliases(sock, request);
    if (aliasesOverlap(aliases, requestAliases)) return request;
  }
  return null;
}

async function changeRequest(sock, groupJid, jid, action) {
  if (typeof sock.groupRequestParticipantsUpdate !== 'function') {
    throw new Error('Baileys não expõe groupRequestParticipantsUpdate neste socket.');
  }
  return sock.groupRequestParticipantsUpdate(groupJid, [jid], action);
}

async function notifyGroupAdmins(sock, groupJid, text) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const admins = (metadata?.participants || []).filter(participant =>
      participant?.admin === 'admin' || participant?.admin === 'superadmin' ||
      participant?.isAdmin === true || participant?.isSuperAdmin === true
    );
    const recipients = [...new Set(admins.map(participant =>
      participant.id || participant.jid || participant.lid || participant.phoneNumber
    ).filter(Boolean))];
    if (!recipients.length) {
      console.warn('[APRESENTAÇÃO] Não há identificador de administrador disponível para aviso privado.');
      return;
    }
    const result = await Promise.allSettled(recipients.map(jid =>
      sock.sendMessage(jid, { text: `🛡️ LÉO STICKERS — APRESENTAÇÃO\n${text}\nNenhum dado pessoal foi publicado.` })
    ));
    if (result.every(item => item.status === 'rejected')) {
      console.warn('[APRESENTAÇÃO] Não consegui entregar o aviso privado a nenhum administrador.');
    }
  } catch (error) {
    console.warn('[APRESENTAÇÃO] Não consegui avisar os administradores:', String(error?.message || error).slice(0, 160));
  }
}

async function handleApplicant(sock, state, msg) {
  const body = messageText(msg);
  const photoReceived = hasPhoto(msg);
  if (photoReceived) state.photo = true;
  if (!body && !photoReceived) return true;

  const parsed = parsePresentation(body);
  for (const field of ['name', 'common', 'age', 'ccb', 'rulesAccepted', 'relationshipIntent', 'cargo', 'instagram', 'batizado', 'estadoCivil', 'pvLiberado']) {
    if (parsed[field] !== null && parsed[field] !== '') state[field] = parsed[field];
  }

  if (state.age !== null && (!Number.isInteger(state.age) || state.age < 0)) {
    await sock.sendMessage(state.requestJid, { text: 'Não consegui entender a idade. Envie um número inteiro no campo Idade:.' });
    return true;
  }

  const config = readConfig();
  const maxAge = Number.isInteger(config.age?.maximum) ? config.age.maximum : null;
  if (state.age !== null && maxAge !== null && state.age > maxAge) {
    try {
      const current = await findRequest(sock, state.groupJid, state.aliases);
      if (!current) {
        pendingSessions.delete(state.key);
        await sock.sendMessage(state.requestJid, { text: 'Sua solicitação não está mais pendente. Fale com os administradores do grupo se precisar de ajuda.' });
        return true;
      }
      await changeRequest(sock, state.groupJid, requestJid(current), 'reject');
      pendingSessions.delete(state.key);
      await sock.sendMessage(state.requestJid, { text: `Obrigado por responder. O grupo permite participantes até ${maxAge} anos, inclusive. Sua solicitação de entrada foi recusada conforme a regra do grupo.` });
    } catch (error) {
      console.error('[APRESENTAÇÃO] Falha ao recusar solicitação acima de 30:', String(error?.message || error).slice(0, 180));
      await notifyGroupAdmins(sock, state.groupJid, 'Uma solicitação declarou idade acima de 30, mas a recusa automática falhou. Verifiquem as solicitações pendentes.');
    }
    return true;
  }

  const ccbRequired = config.eligibility?.mustDeclareCCB !== false;
  const rulesRequired = config.eligibility?.mustAcceptGroupRules !== false;
  const relationshipAllowed = config.eligibility?.relationshipIntentAllowed === true;
  const violatesClause =
    (ccbRequired && state.ccb === false) ||
    (rulesRequired && state.rulesAccepted === false) ||
    (!relationshipAllowed && state.relationshipIntent === true);

  if (violatesClause) {
    try {
      const current = await findRequest(sock, state.groupJid, state.aliases);
      if (current) await changeRequest(sock, state.groupJid, requestJid(current), 'reject');
      pendingSessions.delete(state.key);
      await sock.sendMessage(state.requestJid, { text: 'Sua resposta não atende às cláusulas de entrada atuais do grupo. A solicitação foi recusada. Obrigado pela compreensão.' });
    } catch (error) {
      console.error('[APRESENTAÇÃO] Falha ao recusar solicitação incompatível:', String(error?.message || error).slice(0, 180));
      await notifyGroupAdmins(sock, state.groupJid, 'Uma resposta não atendeu às regras, mas a recusa automática falhou. Verifiquem as solicitações pendentes.');
    }
    return true;
  }

  const missing = [];
  const required = new Set(config.required || ['foto', 'nome', 'idade', 'comum']);
  if (required.has('foto') && !state.photo) missing.push('foto');
  if (required.has('nome') && !state.name) missing.push('nome');
  if (required.has('idade') && (state.age === null || state.age === undefined)) missing.push('idade');
  if (required.has('comum') && !state.common) missing.push('comum');
  if (required.has('cargo') && !state.cargo) missing.push('cargo');
  if (required.has('instagram') && !state.instagram) missing.push('Instagram');
  if (required.has('batizado') && state.batizado === null) missing.push('batismo (SIM/NÃO)');
  if (required.has('estadoCivil') && !state.estadoCivil) missing.push('estado civil');
  if (required.has('pvLiberado') && state.pvLiberado === null) missing.push('PV liberado (SIM/NÃO)');
  if (ccbRequired && state.ccb === null) missing.push('declaração CCB (SIM/NÃO)');
  if (rulesRequired && state.rulesAccepted === null) missing.push('aceite das regras (ACEITO/NÃO)');
  if (!relationshipAllowed && state.relationshipIntent === null) missing.push('intenção de relacionamento (SIM/NÃO)');

  if (missing.length) {
    await sock.sendMessage(state.requestJid, {
      text: `Recebi sua mensagem. Ainda falta: ${missing.join(', ')}.\n\nEnvie os campos identificados no formulário. Não existe prazo para responder; sua solicitação continuará pendente enquanto isso.`
    });
    return true;
  }

  const declarationsValid =
    (!ccbRequired || state.ccb === true) &&
    (!rulesRequired || state.rulesAccepted === true) &&
    (relationshipAllowed || state.relationshipIntent === false);
  if (!declarationsValid) {
    await sock.sendMessage(state.requestJid, { text: 'Não consegui interpretar alguma declaração. Por segurança, a solicitação continua pendente; revise as respostas exigidas ou fale com os administradores.' });
    if (!state.manualNotified) {
      state.manualNotified = true;
      await notifyGroupAdmins(sock, state.groupJid, 'Uma apresentação ficou ambígua e precisa de verificação manual.');
    }
    return true;
  }

  if (config.automaticApproval !== true) {
    if (!state.manualNotified) {
      state.manualNotified = true;
      await notifyGroupAdmins(sock, state.groupJid, 'Uma apresentação está completa, mas a aprovação automática está desativada na configuração.');
    }
    await sock.sendMessage(state.requestJid, { text: 'Sua apresentação está completa e foi encaminhada para análise dos administradores.' });
    return true;
  }

  try {
    const current = await findRequest(sock, state.groupJid, state.aliases);
    if (!current) {
      pendingSessions.delete(state.key);
      await sock.sendMessage(state.requestJid, { text: 'Sua solicitação não está mais na lista de pendentes. Se ainda precisar entrar, faça uma nova solicitação.' });
      return true;
    }
    const result = await changeRequest(sock, state.groupJid, requestJid(current), 'approve');
    pendingSessions.delete(state.key);
    await sock.sendMessage(state.requestJid, { text: '✅ Sua apresentação foi recebida e sua solicitação de entrada foi aprovada. Seja bem-vindo(a) à Mocidade CCB! Deus abençoe 🙌' });
    console.log('[APRESENTAÇÃO] Solicitação aprovada após formulário completo. Resultado:', Array.isArray(result) ? result.map(item => item?.status || 'ok').join(',') : 'ok');
  } catch (error) {
    console.error('[APRESENTAÇÃO] Falha ao aprovar solicitação:', String(error?.message || error).slice(0, 200));
    await sock.sendMessage(state.requestJid, { text: 'Recebi sua apresentação, mas não consegui concluir a aprovação automaticamente. Sua solicitação continua pendente para os administradores verificarem.' }).catch(() => {});
    await notifyGroupAdmins(sock, state.groupJid, 'Uma apresentação foi concluída, mas a aprovação automática falhou. Verifiquem as solicitações pendentes.');
  }
  return true;
}

async function pollRequests(sock) {
  if (pollInProgress || sock !== activeSocket) return;
  pollInProgress = true;
  try {
    const config = readConfig();
    if (!config.enabled || !config.privatePresentation) return;
    const group = await findTargetGroup(sock, config);
    if (!group) {
      console.warn(`[APRESENTAÇÃO] Grupo "${config.groupName}" não encontrado de forma única; aguardando próxima consulta.`);
      return;
    }
    const requests = await requestList(sock, group.jid);
    const liveKeys = new Set();
    for (const request of requests) {
      const jid = requestJid(request);
      if (!jid) continue;
      const aliases = await identityAliases(sock, request);
      const key = `${group.jid}|${cleanJid(jid)}`;
      liveKeys.add(key);
      let state = pendingSessions.get(key);
      if (!state) {
        state = {
          key, groupJid: group.jid, groupName: group.subject,
          requestJid: jid, aliases, photo: false,
          name: '', common: '', age: null,
          ccb: null, rulesAccepted: null, relationshipIntent: null,
          cargo: '', instagram: '', batizado: null, estadoCivil: '', pvLiberado: null,
          promptSent: false
        };
        pendingSessions.set(key, state);
      } else {
        for (const alias of aliases) state.aliases.add(alias);
      }
      if (!state.promptSent) {
        try {
          await sendPrompt(sock, jid, group.subject);
          state.promptSent = true;
          console.log('[APRESENTAÇÃO] Instruções privadas enviadas para uma solicitação pendente.');
        } catch (error) {
          console.warn('[APRESENTAÇÃO] Não consegui enviar mensagem privada; vou tentar novamente:', String(error?.message || error).slice(0, 180));
        }
      }
    }
    // Remove apenas estados em memória de solicitações que já saíram da fila; nunca remove membros.
    for (const key of pendingSessions.keys()) {
      if (key.startsWith(group.jid + '|') && !liveKeys.has(key)) pendingSessions.delete(key);
    }
  } catch (error) {
    console.warn('[APRESENTAÇÃO] Consulta das solicitações falhou; novas tentativas serão feitas:', String(error?.message || error).slice(0, 220));
  } finally {
    pollInProgress = false;
  }
}


async function canManagePresentation(ctx) {
  try {
    if (typeof ctx.isOwner === 'function' && ctx.isOwner(ctx.sender)) return true;
    if (!String(ctx.jid || '').endsWith('@g.us')) return false;
    const metadata = await ctx.sock.groupMetadata(ctx.jid);
    const senderAliases = await identityAliases(ctx.sock, [
      ctx.sender, ctx.msg?.key?.participant, ctx.msg?.key?.participantAlt,
      ctx.msg?.key?.remoteJidAlt
    ]);
    for (const participant of metadata?.participants || []) {
      const admin = participant?.admin === 'admin' || participant?.admin === 'superadmin' || participant?.isAdmin === true || participant?.isSuperAdmin === true;
      if (!admin) continue;
      const aliases = await identityAliases(ctx.sock, participant);
      if (aliasesOverlap(senderAliases, aliases)) return true;
    }
  } catch (error) {
    console.warn('[APRESENTAÇÃO] Não foi possível confirmar administrador:', String(error?.message || error).slice(0, 140));
  }
  return false;
}

function writeConfig(config) {
  const temp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temp, CONFIG_FILE);
}

function presentationSettingsText(config) {
  const required = new Set(config.required || ['foto', 'nome', 'idade', 'comum']);
  const on = value => value ? '✅ obrigatório' : '— opcional';
  const max = Number.isInteger(config.age?.maximum) ? `${config.age.maximum} anos (inclusive)` : 'sem limite';
  return [
    '📋 CLÁUSULAS DE ENTRADA — MOCIDADE CCB',
    '',
    `Autoaprovar: ${config.automaticApproval ? '🟢 ATIVADO' : '🔴 DESATIVADO'}`,
    `Foto: ${on(required.has('foto'))}`,
    `Nome: ${on(required.has('nome'))}`,
    `Idade: ${on(required.has('idade'))}`,
    `Comum: ${on(required.has('comum'))}`,
    `Cargo: ${on(required.has('cargo'))}`,
    `Instagram: ${on(required.has('instagram'))}`,
    `Batizado(a): ${on(required.has('batizado'))}`,
    `Estado civil: ${on(required.has('estadoCivil'))}`,
    `PV liberado: ${on(required.has('pvLiberado'))}`,
    `Declarar CCB: ${on(config.eligibility?.mustDeclareCCB !== false)}`,
    `Aceitar regras: ${on(config.eligibility?.mustAcceptGroupRules !== false)}`,
    `Intenção de relacionamento: ${config.eligibility?.relationshipIntentAllowed === true ? 'permitida' : 'proibida; resposta NÃO obrigatória'}`,
    `Idade máxima: ${max}`,
    'Idade mínima: nenhuma',
    'Prazo: sem limite; nunca remove por falta de resposta',
    '',
    'Comandos (somente administradores):',
    '!autoaceitar on | off',
    '!clausulas foto on|off',
    '!clausulas nome on|off',
    '!clausulas comum on|off',
    '!clausulas cargo on|off',
    '!clausulas instagram on|off',
    '!clausulas batizado on|off',
    '!clausulas estadocivil on|off',
    '!clausulas pvliberado on|off',
    '!clausulas ccb on|off',
    '!clausulas regras on|off',
    '!clausulas relacionamento proibido|livre',
    '!clausulas idade-maxima 30|sem-limite',
  ].join('\n');
}

export async function handlePresentationCommand(ctx) {
  const command = String(ctx.command || '').toLowerCase();
  if (!PRESENTATION_COMMANDS.includes(command)) return false;

  try {
    if (!(await canManagePresentation(ctx))) {
      await ctx.send(ctx.jid, '❌ Somente administradores do grupo ou o dono do bot podem alterar as regras de entrada.', ctx.msg);
      return true;
    }

    const config = readConfig();
    config.age ||= { minimum: null, maximum: 30, maximumInclusive: true };
    config.eligibility ||= { mustDeclareCCB: true, mustAcceptGroupRules: true, relationshipIntentAllowed: false };
    config.required ||= ['foto', 'nome', 'idade', 'comum'];

    if (command === 'autoaceitar') {
      const mode = String(ctx.value || '').trim().toLowerCase();
      if (!['on', 'off', 'ativar', 'desativar', 'ligar', 'desligar'].includes(mode)) {
        await ctx.send(ctx.jid, 'Uso: !autoaceitar on ou !autoaceitar off\n\n' + presentationSettingsText(config), ctx.msg);
        return true;
      }
      config.automaticApproval = ['on', 'ativar', 'ligar'].includes(mode);
      writeConfig(config);
      await ctx.send(ctx.jid, `✅ Aprovação automática ${config.automaticApproval ? 'ATIVADA' : 'DESATIVADA'}.\n\n${presentationSettingsText(config)}`, ctx.msg);
      console.log('[APRESENTAÇÃO] Autoaprovação alterada por administrador:', config.automaticApproval ? 'ON' : 'OFF');
      return true;
    }

    const parts = String(ctx.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      await ctx.send(ctx.jid, presentationSettingsText(config), ctx.msg);
      return true;
    }
    const [field, value] = parts;
    const enabled = ['on', 'sim', 'ativar', 'ligar', 'obrigatorio', 'obrigatório'].includes(value);
    const disabled = ['off', 'nao', 'não', 'desativar', 'desligar', 'opcional'].includes(value);

    const fieldMap = { estadocivil: 'estadoCivil', pvliberado: 'pvLiberado' };
    const normalizedField = fieldMap[field] || field;
    if (['foto', 'nome', 'comum', 'cargo', 'instagram', 'batizado', 'estadoCivil', 'pvLiberado'].includes(normalizedField)) {
      if (!enabled && !disabled) throw new Error(`Uso: !clausulas ${field} on|off`);
      const required = new Set(config.required);
      if (enabled) required.add(normalizedField); else required.delete(normalizedField);
      config.required = [...required];
      const optional = new Set(config.optional || ['cargo', 'instagram', 'batizado', 'estadoCivil', 'pvLiberado']);
      if (enabled) optional.delete(normalizedField); else optional.add(normalizedField);
      config.optional = [...optional];
    } else if (field === 'idade-maxima' || field === 'idademaxima') {
      if (['sem-limite', 'sem', 'off', 'nenhuma'].includes(value)) {
        config.age.maximum = null;
      } else {
        const age = Number(value);
        if (!Number.isInteger(age) || age < 1 || age > 120) throw new Error('Informe idade máxima entre 1 e 120 ou sem-limite.');
        config.age.maximum = age;
      }
      config.age.minimum = null;
      if (!config.required.includes('idade')) config.required.push('idade');
    } else if (field === 'ccb') {
      if (!enabled && !disabled) throw new Error('Uso: !clausulas ccb on|off');
      config.eligibility.mustDeclareCCB = enabled;
    } else if (field === 'regras') {
      if (!enabled && !disabled) throw new Error('Uso: !clausulas regras on|off');
      config.eligibility.mustAcceptGroupRules = enabled;
    } else if (field === 'relacionamento') {
      if (!['proibido', 'livre', 'permitido'].includes(value)) throw new Error('Uso: !clausulas relacionamento proibido|livre');
      config.eligibility.relationshipIntentAllowed = value !== 'proibido';
    } else {
      throw new Error('Cláusula desconhecida. Use: foto, nome, idade, comum, cargo, instagram, batizado, estadoCivil, pvLiberado, ccb, regras, relacionamento ou idade-maxima.');
    }

    writeConfig(config);
    await ctx.send(ctx.jid, `✅ Cláusula atualizada.\n\n${presentationSettingsText(config)}`, ctx.msg);
    console.log('[APRESENTAÇÃO] Cláusula alterada por administrador:', field, value);
    return true;
  } catch (error) {
    await ctx.send(ctx.jid, `❌ ${String(error?.message || error)}\n\nUse !clausulas para ver todas as opções.`, ctx.msg);
    return true;
  }
}

export function startPresentationWatcher(sock) {
  if (!sock || sock === activeSocket && pollTimer) return;
  if (pollTimer) clearInterval(pollTimer);
  activeSocket = sock;
  pollTimer = setInterval(() => pollRequests(sock), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  pollRequests(sock).catch(error => console.error('[APRESENTAÇÃO]', error));
  console.log('[APRESENTAÇÃO] Monitor de solicitações ativado (sem prazo e sem remoção automática).');
}

export async function handlePresentationMessage(sock, msg) {
  const config = readConfig();
  if (!config.enabled || !config.privatePresentation || msg?.key?.fromMe) return false;
  const remoteJid = cleanJid(msg?.key?.remoteJid);
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return false;
  const key = msg.key || {};
  const aliases = await identityAliases(sock, [remoteJid, key.remoteJidAlt, key.participant, key.participantAlt]);
  for (const state of pendingSessions.values()) {
    if (aliasesOverlap(aliases, state.aliases)) {
      return handleApplicant(sock, state, msg);
    }
  }
  return false;
}
