import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_FILE = path.resolve(process.env.LEO_JOIN_APPROVAL_DATA || './join-approval-data.json');
const TEMPLATE_FILE = path.resolve('./apresentacao-config.json');
const PRESENTATION_SCHEMA_VERSION = 3;
// Regra migrada por ID, nunca pelo nome visível do grupo.
const LEGACY_MOCIDADE_GROUP_ID = '120363377675873837@g.us';
const TRANSIENT_PHOTOS = new Map(); // Buffers ficam apenas na memória, nunca no JSON.
const COMMANDS = new Set([
  'entrada', 'autoaceitar', 'autoaprovarsolicitacao', 'criarclausulas', 'clausulas',
  'solicitacoes', 'aprovarsolicitacao', 'recusarsolicitacao'
]);
const FIELD_LABELS = {
  name: ['nome', 'nome completo'],
  age: ['idade'],
  common: ['comum', 'comum congregacao', 'congregacao'],
  role: ['cargo'],
  instagram: ['instagram', 'insta', '@ do insta'],
  baptized: ['batizado', 'batizada', 'batizado(a)'],
  civilStatus: ['estado civil'],
  privateAllowed: ['pv liberado', 'pv'],
  ccb: ['sou da ccb', 'ccb', 'sou membro da ccb', 'denominacao'],
  acceptedClauses: ['aceito as clausulas', 'aceito as regras', 'aceito as regras do grupo', 'regras aceitas'],
  relationshipIntent: ['intencao de relacionamento', 'entrei para relacionamento', 'interesse em relacionamento'],
  publishConsent: ['autorizo publicar no grupo', 'autorizo enviar no grupo', 'autorizo divulgar', 'publicar no grupo', 'divulgar apresentacao', 'autorizo a publicacao']
};
const REQUIRED_FIELD_LABELS = {
  photo: 'foto', name: 'nome', age: 'idade', common: 'comum', role: 'cargo',
  instagram: 'Instagram', baptized: 'batizado(a)', civilStatus: 'estado civil',
  privateAllowed: 'PV liberado'
};

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function loadData() {
  const data = readJson(DATA_FILE, {});
  data.groups ||= {};
  data.applications ||= {};
  data.activeByApplicant ||= {};
  return data;
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9@ ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizeJid(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw.split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net';
  return `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`;
}

function identityAliases(value) {
  const out = new Set();
  const add = item => {
    if (!item) return;
    if (typeof item === 'object') {
      for (const key of ['id', 'jid', 'lid', 'phoneNumber', 'participant', 'participantAlt']) add(item[key]);
      return;
    }
    const jid = normalizeJid(item);
    if (jid) out.add(jid);
  };
  add(value);
  return out;
}

function aliasesMatch(a, b) {
  for (const id of a) if (b.has(id)) return true;
  return false;
}

function defaultClauses(isTemplateGroup) {
  if (isTemplateGroup) {
    return [
      'Declaro que faço parte da Congregação Cristã no Brasil (CCB).',
      'Li e aceito as regras deste grupo e respeito todos os participantes.',
      'Não estou entrando neste grupo com intenção de relacionamento.',
      'Entendo que este grupo é destinado à mocidade da CCB.'
    ];
  }
  return [
    'Declaro que as informações da minha apresentação são verdadeiras.',
    'Li e aceito as regras deste grupo.',
    'Comprometo-me a respeitar os participantes e a finalidade do grupo.'
  ];
}

function isTemplateGroup(subject) {
  const template = readJson(TEMPLATE_FILE, {});
  return normalizeLabel(subject) !== '' &&
    normalizeLabel(subject) === normalizeLabel(template.groupName || '');
}

function makeGroupConfig(groupJid, subject = '') {
  // Cada JID recebe um objeto próprio. O nome do grupo serve apenas para exibição;
  // nunca decide cláusulas, limite etário ou qualquer regra.
  const knownAgeLimit = String(groupJid) === LEGACY_MOCIDADE_GROUP_ID;
  return {
    groupJid,
    groupName: String(subject || '').slice(0, 100),
    enabled: false,
    autoAccept: false,
    clauses: [],
    fields: {
      photo: true,
      name: true,
      age: true,
      common: true,
      role: true,
      instagram: true,
      baptized: true,
      civilStatus: true,
      privateAllowed: true
    },
    presentationSchemaVersion: PRESENTATION_SCHEMA_VERSION,
    publishPresentationToGroup: true,
    requireCCB: false,
    requireNoRelationship: false,
    requireClauseAcceptance: true,
    maxAge: knownAgeLimit ? 30 : null,
    agePolicyConfigured: false,
    minAge: null,
    noDeadline: true,
    createdAt: new Date().toISOString()
  };
}

function getGroupConfig(data, groupJid, subject = '') {
  if (!data.groups[groupJid]) data.groups[groupJid] = makeGroupConfig(groupJid, subject);
  const cfg = data.groups[groupJid];
  cfg.groupJid = groupJid;
  if (subject) cfg.groupName = String(subject).slice(0, 100);
  // Corrige configurações antigas criadas por comparação de nome. Para o grupo
  // conhecido, aplica 30 anos uma única vez; depois o admin pode alterar/off.
  if (groupJid === LEGACY_MOCIDADE_GROUP_ID && cfg.agePolicyConfigured !== true) {
    cfg.maxAge = 30;
    cfg.agePolicyConfigured = true;
  }
  if (cfg.agePolicyConfigured === undefined) cfg.agePolicyConfigured = false;
  cfg.clauses = Array.isArray(cfg.clauses) ? cfg.clauses : [];
  cfg.fields ||= { photo: true, name: true, age: true, common: true };
  // Migração única: a partir desta versão, todos os campos da apresentação
  // enviada pelo usuário são solicitados. O administrador ainda pode desligar
  // campos individualmente depois da migração com !clausulas campo ... off.
  cfg.fieldOverrides ||= {};
  if (Number(cfg.presentationSchemaVersion || 1) < PRESENTATION_SCHEMA_VERSION) {
    for (const key of ['role', 'instagram', 'baptized', 'civilStatus', 'privateAllowed']) {
      if (cfg.fieldOverrides[key] !== true) cfg.fields[key] = true;
    }
    cfg.presentationSchemaVersion = PRESENTATION_SCHEMA_VERSION;
  }
  cfg.presentationSchemaVersion = PRESENTATION_SCHEMA_VERSION;
  cfg.publishPresentationToGroup = true;
  cfg.requireCCB = Boolean(cfg.requireCCB);
  cfg.requireNoRelationship = Boolean(cfg.requireNoRelationship);
  cfg.requireClauseAcceptance = cfg.requireClauseAcceptance !== false;
  cfg.enabled = Boolean(cfg.enabled);
  cfg.autoAccept = Boolean(cfg.autoAccept);
  cfg.noDeadline = true;
  return cfg;
}

function groupAdminAliases(value) {
  return identityAliases(value);
}

async function checkGroupAdmin(ctx, requireBot = false) {
  if (!String(ctx.jid || '').endsWith('@g.us')) {
    await ctx.send(ctx.jid, 'Este comando precisa ser usado dentro do grupo que você deseja configurar.', ctx.msg);
    return null;
  }
  const metadata = await ctx.sock.groupMetadata(ctx.jid);
  const participants = metadata.participants || [];
  const senderAliases = new Set([
    ...groupAdminAliases(ctx.sender),
    ...groupAdminAliases(ctx.msg?.key?.participant),
    ...groupAdminAliases(ctx.msg?.key?.participantAlt)
  ]);
  const botAliases = new Set([
    ...groupAdminAliases(ctx.sock.user?.id),
    ...groupAdminAliases(ctx.sock.user?.lid)
  ]);
  const sender = participants.find(p => aliasesMatch(senderAliases, groupAdminAliases(p)));
  const bot = participants.find(p => aliasesMatch(botAliases, groupAdminAliases(p)));
  const isAdmin = p => p?.admin === 'admin' || p?.admin === 'superadmin' || p?.isAdmin === true || p?.isSuperAdmin === true;
  if (!ctx.isOwner?.(ctx.sender) && !isAdmin(sender)) {
    await ctx.send(ctx.jid, '❌ Somente administradores do grupo podem configurar a entrada.', ctx.msg);
    return null;
  }
  if (requireBot && !isAdmin(bot)) {
    await ctx.send(ctx.jid, '❌ Preciso ser administrador do grupo para ativar/desativar a aprovação de entrada.', ctx.msg);
    return null;
  }
  return metadata;
}

function parseOnOff(value) {
  const v = normalizeLabel(value);
  if (['on', 'ligado', 'ativar', 'ativo', 'sim'].includes(v)) return true;
  if (['off', 'desligado', 'desativar', 'inativo', 'nao', 'não'].includes(v)) return false;
  return null;
}

function helpText() {
  return [
    '🧾 CONTROLE DE ENTRADA POR GRUPO',
    '',
    '!entrada on/off — liga/desliga solicitações e mensagem no PV',
    '!autoaceitar on/off ou !autoaprovarsolicitacao on/off — publica a apresentação autorizada e aprova somente se estiver válida',
    '!criarclausulas regra 1 | regra 2 — cadastra cláusulas exclusivas deste grupo',
    'As cláusulas são independentes por ID; cada grupo cadastra as suas.',
    '!clausulas — lista as cláusulas e configurações',
    '!clausulas adicionar texto — adiciona uma cláusula',
    '!clausulas remover número — remove uma cláusula',
    '!clausulas idade-max 30 — define idade máxima (use off para sem limite)',
    '!clausulas ccb on/off — exige declaração de vínculo com a CCB',
    '!clausulas relacionamento on/off — exige declarar que não entrou por relacionamento',
    '!clausulas campos — mostra o que este grupo pede',
    '!clausulas campo foto|nome|idade|comum|cargo|instagram|batizado|estado civil|pv liberado on/off — configura cada campo',
    '!clausulas campo todos on/off — liga/desliga todos os campos de uma vez',
    '!solicitacoes — lista pedidos e códigos de análise',
    '!aprovarsolicitacao código — aprova solicitação pronta',
    '!recusarsolicitacao código — recusa solicitação',
    '',
    'A apresentação completa (incluindo foto e Instagram) só é publicada no grupo após autorização expressa da pessoa no PV.',
    'Cada grupo tem sua própria configuração, campos e cláusulas. Execute os comandos dentro de cada grupo.',
    'Exemplo: !clausulas campo instagram off (não pede Instagram neste grupo).'
  ].join('\n');
}

function clauseText(cfg) {
  const fields = Object.entries(cfg.fields || {})
    .map(([key, required]) => `${REQUIRED_FIELD_LABELS[key] || key}: ${required ? 'obrigatório' : 'opcional'}`)
    .join('\n');
  const age = cfg.maxAge == null ? 'Sem idade máxima configurada' : `Idade máxima: ${cfg.maxAge} anos`;
  const minAge = cfg.minAge == null ? 'sem idade mínima' : `idade mínima: ${cfg.minAge} anos`;
  return [
    `📜 CLÁUSULAS — ${cfg.groupName || 'Grupo'}`,
    '',
    ...(cfg.clauses.length ? cfg.clauses.map((clause, i) => `${i + 1}. ${clause}`) : ['Nenhuma cláusula cadastrada. Use !criarclausulas.']),
    '',
    `CCB obrigatória: ${cfg.requireCCB ? 'sim' : 'não'}`,
    `Declaração contra intenção de relacionamento: ${cfg.requireNoRelationship ? 'sim' : 'não'}`,
    `${age} (${minAge})`,
    '',
    'CAMPOS DA APRESENTAÇÃO (configuráveis por grupo)',
    fields,
    'Para ver: !clausulas campos | Para alterar: !clausulas campo NOME on/off',
    'Autorização para publicar a apresentação completa no grupo: obrigatória no PV',
    '',
    `Apresentação no PV: ${cfg.enabled ? 'ativada' : 'desativada'}`,
    'Publicação no grupo: após consentimento explícito no PV',
    `Autoaprovação: ${cfg.autoAccept ? 'ativada' : 'desativada'}`,
    'Prazo: sem limite. Sem resposta não remove nem recusa ninguém.'
  ].join('\n');
}

function extractMessage(msg) {
  let current = msg?.message || {};
  for (let i = 0; i < 10; i++) {
    const next = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message;
    if (!next) break;
    current = next;
  }
  const image = Boolean(current.imageMessage);
  const text = current.conversation ||
    current.extendedTextMessage?.text ||
    current.imageMessage?.caption ||
    current.videoMessage?.caption ||
    current.documentMessage?.caption || '';
  return { content: current, image, text: String(text || '').trim() };
}

function parseBoolean(value) {
  const v = normalizeLabel(value);
  if (/^(sim|s|yes|y|aceito|aceita|confirmo|de acordo|ccb)$/.test(v)) return true;
  if (/^(nao|n|no|recuso|nao aceito)$/.test(v)) return false;
  return null;
}

function positionalFieldOrder(cfg = null) {
  const order = [];
  const fields = cfg?.fields || {};
  for (const field of ['name', 'age', 'common']) {
    if (fields[field] !== false) order.push(field);
  }
  for (const field of ['role', 'instagram', 'baptized', 'civilStatus', 'privateAllowed']) {
    if (fields[field]) order.push(field);
  }
  if (cfg?.requireCCB) order.push('ccb');
  if (cfg?.requireClauseAcceptance && cfg?.clauses?.length) order.push('acceptedClauses');
  if (cfg?.requireNoRelationship) order.push('relationshipIntent');
  order.push('publishConsent');
  return order;
}

function positionalExample(cfg = null) {
  const samples = {
    name: 'Leo', age: '15', common: 'Jajá', role: 'Membro', instagram: '@leo',
    baptized: 'Sim', civilStatus: 'Solteiro', privateAllowed: 'Sim',
    ccb: 'Sim', acceptedClauses: 'Sim', relationshipIntent: 'Não', publishConsent: 'Sim'
  };
  return positionalFieldOrder(cfg).map(field => samples[field]).join('\n');
}

function assignApplicationValue(result, field, rawValue, errors = []) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  if (['ccb', 'acceptedClauses', 'relationshipIntent', 'publishConsent'].includes(field)) {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      errors.push(`${field === 'publishConsent' ? 'Autorização para publicar no grupo' : field}: responda somente sim ou não.`);
      return false;
    }
    result[field] = parsed;
    return true;
  }
  if (field === 'age') {
    // Não extrai qualquer número do texto: isso fazia datas, telefones e frases
    // serem interpretados como idade. Aceita apenas "15", "15 anos" ou
    // "tenho 15 anos".
    const match = value.match(/^(?:tenho\s+)?(\d{1,3})(?:\s*anos?)?[.!]?$/i);
    const n = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 120) {
      errors.push('Idade inválida. Envie somente sua idade, por exemplo: 15 ou 15 anos (de 1 a 120).');
      return false;
    }
    result.age = n;
    return true;
  }
  result[field] = value.slice(0, 160);
  return true;
}

function parseApplicationText(text, cfg = null, app = null) {
  const result = {};
  const errors = [];
  const aliases = new Map();
  for (const [field, labels] of Object.entries(FIELD_LABELS)) {
    for (const label of labels) aliases.set(normalizeLabel(label), field);
  }

  const positional = [];
  const lines = String(text || '').split(/[\n;|]+/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    // Formatos identificados: "Nome: Leo", "Nome = Leo", "Nome - Leo".
    const labeled = line.match(/^\s*([^:=—-]{1,60})\s*[:=—-]\s*(.*?)\s*$/);
    if (labeled) {
      const field = aliases.get(normalizeLabel(labeled[1]));
      if (field) assignApplicationValue(result, field, labeled[2], errors);
      continue;
    }

    // Também aceita rótulos sem dois-pontos: "Nome Leo", "Estado civil solteiro".
    const words = line.match(/\S+/g) || [];
    let matchedWithoutColon = false;
    const labelsByWordCount = [...aliases.entries()].sort((a, b) => b[0].split(' ').length - a[0].split(' ').length);
    for (const [label, field] of labelsByWordCount) {
      const count = label.split(' ').length;
      if (words.length <= count) continue;
      if (normalizeLabel(words.slice(0, count).join(' ')) !== label) continue;
      assignApplicationValue(result, field, words.slice(count).join(' '), errors);
      matchedWithoutColon = true;
      break;
    }
    if (matchedWithoutColon) continue;

    // Formato simples: um valor por linha, sem rótulos nem dois-pontos.
    if (!/^[^:=—-]{1,60}\s*[:=—-]/.test(line)) positional.push(line);
  }

  const existing = { ...(app?.fields || {}), ...result };
  const order = positionalFieldOrder(cfg);
  let cursor = 0;
  for (const value of positional) {
    while (cursor < order.length && existing[order[cursor]] !== undefined && existing[order[cursor]] !== null && existing[order[cursor]] !== '') cursor++;
    if (cursor >= order.length) break;
    const field = order[cursor++];
    if (assignApplicationValue(result, field, value, errors)) existing[field] = result[field];
  }
  Object.defineProperty(result, 'errors', { value: errors, enumerable: false });
  return result;
}

function evaluateApplication(app, cfg) {
  const fields = app.fields || {};
  const missing = [];
  if (cfg.fields.photo && !app.photoReceived) missing.push('Foto (envie uma imagem no privado)');
  for (const key of ['name', 'common', 'role', 'instagram', 'baptized', 'civilStatus', 'privateAllowed']) {
    if (cfg.fields[key] && (fields[key] === undefined || fields[key] === null || fields[key] === '')) {
      const labels = { name: 'Nome', age: 'Idade', common: 'Comum', role: 'Cargo', instagram: 'Instagram', baptized: 'Batizado(a)', civilStatus: 'Estado civil', privateAllowed: 'PV liberado' };
      missing.push(labels[key] || key);
    }
  }
  if (cfg.fields.age && (!Number.isInteger(fields.age) || fields.age < 1 || fields.age > 120)) {
    missing.push('Idade válida (1 a 120 anos)');
  } else if (cfg.fields.age && app.ageConfirmed !== true) {
    missing.push('Confirmação explícita da idade (responda SIM depois da pergunta do bot)');
  }
  // Regra eliminatória avaliada antes de campos restantes: ao confirmar uma
  // idade acima do teto, nenhum campo faltante pode transformar o caso em review.
  if (cfg.fields.age && app.ageConfirmed === true && cfg.maxAge != null &&
      Number.isInteger(fields.age) && fields.age > cfg.maxAge) {
    return {
      status: 'rejected', missing: [],
      reasons: [`Idade acima do limite do grupo (${cfg.maxAge} anos)`],
      rejectionType: 'age_maximum'
    };
  }
  if (cfg.requireCCB && fields.ccb !== true && fields.ccb !== false) missing.push('Sou da CCB? (sim/não)');
  if (cfg.requireClauseAcceptance && cfg.clauses.length && fields.acceptedClauses !== true && fields.acceptedClauses !== false) missing.push('Aceito todas as cláusulas? (sim/não)');
  if (cfg.requireNoRelationship && fields.relationshipIntent !== true && fields.relationshipIntent !== false) missing.push('Intenção de relacionamento? Responda não');
  if (fields.publishConsent !== true && fields.publishConsent !== false) missing.push('Autoriza publicar a apresentação completa no grupo? (sim/não)');
  if (missing.length) return { status: 'incomplete', missing };

  const reasons = [];
  if (cfg.fields.age && cfg.minAge != null && Number.isInteger(fields.age) && fields.age < cfg.minAge) {
    reasons.push(`Idade abaixo do limite do grupo (${cfg.minAge} anos)`);
  }
  if (fields.publishConsent === false) reasons.push('A pessoa não autorizou publicar a apresentação no grupo; nada será divulgado nem aprovado automaticamente.');
  if (cfg.requireCCB && fields.ccb === false) reasons.push('A pessoa declarou que não é da CCB');
  if (cfg.requireClauseAcceptance && cfg.clauses.length && fields.acceptedClauses === false) reasons.push('A pessoa não aceitou as cláusulas');
  if (cfg.requireNoRelationship && fields.relationshipIntent === true) reasons.push('A pessoa declarou intenção de relacionamento');
  if (reasons.length) return { status: 'review', missing: [], reasons };
  return { status: 'ready', missing: [], reasons: [] };
}

function findOpenApplication(data, groupJid, applicant) {
  const wanted = normalizeJid(applicant);
  return Object.values(data.applications).find(app =>
    app.groupJid === groupJid && normalizeJid(app.participant) === wanted &&
    !['approved', 'rejected', 'revoked', 'age_rejection_pending', 'joined_age_rejected'].includes(app.status)
  );
}

function createCode(data) {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); }
  while (data.applications[code]);
  return code;
}

function renderRequestMessage(cfg, app) {
  return [
    `🦊 Olá! Recebemos sua solicitação para entrar no grupo *${cfg.groupName || 'grupo'}*.`,
    '',
    `Código da apresentação: *${app.code}*`,
    `Para começar, responda *apresentação* ou *!apresentação ${app.code}* neste PV.`,
    'Se você tiver apenas uma solicitação pendente, não precisa digitar o código.',
    '',
    'Envie tudo somente neste PV. Depois da validação, a solicitação será aprovada conforme a configuração do grupo. A foto e a apresentação só serão publicadas quando o WhatsApp confirmar que você realmente entrou no grupo.',
    'O bot pedirá uma confirmação SIM/NÃO da idade e uma autorização SIM/NÃO para publicar seus dados. A foto ficará apenas temporariamente na memória e não será gravada no banco de dados.',
    '',
    'Não existe prazo para responder. Sua solicitação continuará pendente até ser analisada.',
    '',
    '📝 Envie um dado por linha, nesta ordem. Não precisa escrever os nomes dos campos nem usar dois-pontos:',
    ...positionalFieldOrder(cfg).map(field => ({
      name: 'Nome', age: 'Idade', common: 'Comum', role: 'Cargo', instagram: 'Instagram',
      baptized: 'Batizado(a) (sim/não)', civilStatus: 'Estado civil', privateAllowed: 'PV liberado (sim/não)',
      ccb: 'É da CCB? (sim/não)', acceptedClauses: 'Aceita as cláusulas? (sim/não)',
      relationshipIntent: 'Entrou com intenção de relacionamento? (responda não)',
      publishConsent: 'Autoriza publicar TUDO isso no grupo, incluindo foto e Instagram? (sim/não)'
    })[field]),
    '',
    'Exemplo completo para este grupo (um dado por linha):',
    positionalExample(cfg),
    '',
    '📜 CLÁUSULAS DO GRUPO',
    ...(cfg.clauses.length ? cfg.clauses.map((clause, i) => `${i + 1}. ${clause}`) : ['Nenhuma cláusula extra cadastrada.']),
    '',
    'Envie também uma foto neste privado. Depois de informar a idade, confirme com SIM ou corrija com NÃO. A idade é autodeclarada: a confirmação registra sua declaração, mas não comprova a idade real por documento.'
  ].join('\n');
}

async function notifyAdmins(sock, groupJid, app, summary) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const mentions = (meta.participants || [])
      .filter(p => p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true)
      .map(p => p.id).filter(Boolean);
    const label = app.status === 'review' ? 'precisa de análise manual' : app.status === 'publication_pending' ? 'está com publicação pendente' : 'está pronta para aprovação';
    const detail = summary ? `\nMotivo: ${summary}` : '';
    await sock.sendMessage(groupJid, {
      text: `📨 Uma solicitação de entrada ${label}.\nCódigo: *${app.code}*\nUse !solicitacoes para consultar e !aprovarsolicitacao ${app.code} ou !recusarsolicitacao ${app.code}.${detail}`,
      mentions
    });
  } catch (error) {
    console.error('[ENTRADA] Não foi possível avisar os administradores do grupo:', error?.message || error);
  }
}

function publicPresentationText(app, cfg) {
  const f = app.fields || {};
  const lines = [
    `📋 *APRESENTAÇÃO — ${cfg.groupName || app.groupName || 'GRUPO'}*`,
    '',
    `👤 Nome: ${f.name || '—'}`,
    `🎂 Idade: ${f.age ?? '—'} anos`,
    `🏠 Comum: ${f.common || '—'}`
  ];
  const optional = [
    ['role', '💼 Cargo'], ['instagram', '📱 Instagram'], ['baptized', '🙏 Batizado(a)'],
    ['civilStatus', '💍 Estado civil'], ['privateAllowed', '💬 PV liberado']
  ];
  for (const [key, label] of optional) {
    if (cfg.fields?.[key]) lines.push(`${label}: ${f[key] || '—'}`);
  }
  if (cfg.requireCCB) lines.push(`CCB: ${f.ccb === true ? 'Sim' : 'Não'}`);
  if (cfg.requireClauseAcceptance && cfg.clauses.length) lines.push(`Cláusulas do grupo: ${f.acceptedClauses === true ? 'Aceitas' : 'Não aceitas'}`);
  if (cfg.requireNoRelationship) lines.push(`Intenção de relacionamento: ${f.relationshipIntent === true ? 'Sim' : 'Não'}`);
  lines.push('', '✅ A pessoa autorizou o envio desta apresentação ao grupo.');
  if (String(app.participant || '').endsWith('@s.whatsapp.net')) {
    lines.push(`Solicitante: @${app.participant.split('@')[0]}`);
  }
  return lines.join('\n');
}

async function downloadApplicantPhoto(msg, sock) {
  // Gancho privado usado pelos testes; na operação real a mídia é baixada pelo Baileys.
  if (Buffer.isBuffer(msg?._leoPhotoBuffer)) return msg._leoPhotoBuffer;
  const baileys = await import('@whiskeysockets/baileys');
  const buffer = await baileys.downloadMediaMessage(msg, 'buffer', {}, {
    reuploadRequest: sock.updateMediaMessage
  });
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
}

async function publishApplicationToGroup(sock, data, app, cfg) {
  if (app.presentationPublishedAt) return true;
  try {
    if (cfg.fields.photo && !app.photoPublishedAt) {
      const photo = TRANSIENT_PHOTOS.get(app.code);
      if (!photo) {
        app.status = 'publication_pending';
        app.photoResendRequired = true;
        app.photoReceived = false;
        app.missing = ['Foto: reenvie uma imagem no PV para que eu possa encaminhá-la ao grupo'];
        saveData(data);
        return false;
      }
      const caption = `📸 Foto da apresentação de ${app.fields?.name || 'solicitante'} para ${cfg.groupName || 'o grupo'}.`;
      await sock.sendMessage(app.groupJid, { image: photo, caption });
      app.photoPublishedAt = new Date().toISOString();
      saveData(data);
    }
    const content = { text: publicPresentationText(app, cfg) };
    if (String(app.participant || '').endsWith('@s.whatsapp.net')) content.mentions = [app.participant];
    await sock.sendMessage(app.groupJid, content);
    app.presentationPublishedAt = new Date().toISOString();
    app.photoResendRequired = false;
    saveData(data);
    TRANSIENT_PHOTOS.delete(app.code);
    return true;
  } catch (error) {
    app.status = 'publication_pending';
    app.lastPublicationError = String(error?.message || error).slice(0, 240);
    saveData(data);
    await sock.sendMessage(app.participant, {
      text: '⚠️ Recebi sua apresentação, mas não consegui encaminhá-la ao grupo ainda. Seus dados continuam salvos; não precisa preencher tudo novamente. Vou avisar os administradores.'
    }).catch(() => {});
    await notifyAdmins(sock, app.groupJid, app, `Falha ao publicar a apresentação no grupo: ${app.lastPublicationError}`);
    return false;
  }
}

async function dispatchApplication(sock, data, app, cfg, result) {
  if (result.status === 'incomplete') {
    app.status = app.pendingAgeConfirmation != null ? 'awaiting_age_confirmation' : 'incomplete';
    app.missing = result.missing;
    saveData(data);
    return false;
  }
  if (result.status === 'rejected' && result.rejectionType === 'age_maximum') {
    app.rejectionReason = result.reasons.join('; ');
    app.rejectionType = 'age_maximum';
    if (app.joinedAt) {
      // A pessoa já entrou por uma ação externa; não divulgamos os dados.
      // O bot avisa os administradores, sem tentar remover alguém do grupo.
      app.status = 'joined_age_rejected';
      app.rejectedAt = new Date().toISOString();
      delete data.activeByApplicant[normalizeJid(app.participant)];
      saveData(data);
      await sock.sendMessage(app.participant, {
        text: `⛔ Sua idade informada está acima do limite de *${cfg.maxAge} anos* deste grupo. Sua apresentação não será publicada. Fale com os administradores.`
      }).catch(() => {});
      await notifyAdmins(sock, app.groupJid, app, `A pessoa já havia entrado, mas declarou idade acima do limite (${cfg.maxAge}). A apresentação foi bloqueada e não foi publicada.`);
      return false;
    }

    // Primeiro bloqueia qualquer aprovação local; depois solicita ao WhatsApp
    // a recusa da solicitação de entrada pendente.
    app.status = 'age_rejection_pending';
    delete data.activeByApplicant[normalizeJid(app.participant)];
    saveData(data);
    try {
      const response = await sock.groupRequestParticipantsUpdate(app.groupJid, [app.participant], 'reject');
      const succeeded = Array.isArray(response) && response.some(item => String(item.status || '200') === '200');
      if (!succeeded) throw new Error('WhatsApp não confirmou a recusa da solicitação.');
      app.status = 'rejected';
      app.rejectedAt = new Date().toISOString();
      saveData(data);
      await sock.sendMessage(app.participant, {
        text: `⛔ Sua solicitação para *${cfg.groupName || 'o grupo'}* foi recusada automaticamente porque a idade informada (${app.fields.age} anos) ultrapassa o limite de *${cfg.maxAge} anos*.` 
      }).catch(() => {});
      await notifyAdmins(sock, app.groupJid, app, `Solicitação recusada automaticamente: idade ${app.fields.age}, limite máximo ${cfg.maxAge}.`);
    } catch (error) {
      app.status = 'age_rejection_pending';
      app.lastRejectionError = String(error?.message || error).slice(0, 240);
      saveData(data);
      await sock.sendMessage(app.participant, {
        text: `⛔ Sua idade informada (${app.fields.age} anos) ultrapassa o limite de *${cfg.maxAge} anos*. Sua aprovação está bloqueada. Os administradores foram avisados porque o WhatsApp não confirmou a recusa automática.`
      }).catch(() => {});
      await notifyAdmins(sock, app.groupJid, app, `BLOQUEIO DE IDADE: aprovação proibida. O WhatsApp não confirmou a recusa automática; use !recusarsolicitacao ${app.code} para tentar recusar novamente. Erro: ${app.lastRejectionError}`);
    }
    TRANSIENT_PHOTOS.delete(app.code);
    return false;
  }
  if (result.status === 'review') {
    app.status = app.joinedAt ? 'joined_review' : 'review';
    app.reviewReasons = result.reasons;
    saveData(data);
    await sock.sendMessage(app.participant, {
      text: `⚠️ Sua apresentação foi recebida, mas precisa de análise dos administradores.\n\n${result.reasons.join('\n')}\n\nSua solicitação não será aprovada automaticamente.`
    }).catch(() => {});
    await notifyAdmins(sock, app.groupJid, app, result.reasons.join('; '));
    return false;
  }

  // Se a pessoa já entrou por ação dos administradores, publicar somente agora.
  if (app.joinedAt) {
    const published = await publishApplicationToGroup(sock, data, app, cfg);
    if (!published) {
      if (app.photoResendRequired) {
        await sock.sendMessage(app.participant, {
          text: 'Sua entrada já foi confirmada. Só falta reenviar a foto neste PV para concluir a publicação; os demais dados estão salvos.'
        }).catch(() => {});
      }
      return false;
    }
    app.status = 'approved';
    app.approvedAt ||= new Date().toISOString();
    saveData(data);
    await sock.sendMessage(app.participant, {
      text: `✅ Sua apresentação foi publicada em *${cfg.groupName || 'o grupo'}* após a confirmação da sua entrada. Deus abençoe!`
    }).catch(() => {});
    return true;
  }

  // Não publica enquanto a pessoa ainda estiver apenas como solicitante.
  if (cfg.autoAccept) {
    try {
      app.status = 'approval_pending';
      app.approvalRequestedAt = new Date().toISOString();
      saveData(data);
      const response = await sock.groupRequestParticipantsUpdate(app.groupJid, [app.participant], 'approve');
      const succeeded = Array.isArray(response) && response.some(item => String(item.status || '200') === '200');
      if (!succeeded) throw new Error('WhatsApp não confirmou a aprovação da solicitação.');
      // O retorno de approve não prova que o participante já entrou. Aguardamos
      // group-participants.update com action=add antes de publicar.
      if (app.status === 'approval_pending') app.status = 'awaiting_entry';
      app.approvalAcceptedAt = new Date().toISOString();
      saveData(data);
      await sock.sendMessage(app.participant, {
        text: `✅ Idade e apresentação confirmadas. O WhatsApp recebeu a aprovação para *${cfg.groupName || 'o grupo'}*. Assim que sua entrada for confirmada, publico sua apresentação no grupo.`
      }).catch(() => {});
      return false;
    } catch (error) {
      app.status = 'ready';
      app.lastApprovalError = String(error?.message || error).slice(0, 240);
      saveData(data);
      await sock.sendMessage(app.participant, { text: '✅ Sua apresentação está completa, mas não consegui solicitar a aprovação automática. Os administradores foram avisados.' }).catch(() => {});
      await notifyAdmins(sock, app.groupJid, app, 'A aprovação automática falhou; aprove manualmente. A apresentação só será publicada depois da entrada confirmada.');
      return false;
    }
  }

  app.status = 'ready';
  app.readyAt = new Date().toISOString();
  saveData(data);
  await sock.sendMessage(app.participant, {
    text: `✅ Sua apresentação foi validada e está aguardando a aprovação dos administradores de *${cfg.groupName || 'o grupo'}*. Ela só será publicada depois que o WhatsApp confirmar sua entrada.`
  }).catch(() => {});
  await notifyAdmins(sock, app.groupJid, app, 'Apresentação validada. Aprove a solicitação; a publicação ocorrerá depois do evento de entrada confirmada.');
  return false;
}

export async function handleGroupJoinRequest(sock, event) {
  if (!event || !event.id) return false;
  // Aceita tanto o objeto normalizado pelo index.js quanto o evento bruto
  // do Baileys, que traz participants: [jid, ...].
  if (!event.participant && Array.isArray(event.participants)) {
    let handled = false;
    for (const participant of event.participants) {
      const result = await handleGroupJoinRequest(sock, { ...event, participants: undefined, participant });
      handled = result || handled;
    }
    return handled;
  }
  const participantValue = event.participant || (Array.isArray(event.participants) ? event.participants[0] : null);
  if (!participantValue) return false;
  const data = loadData();
  const groupJid = String(event.id);
  const applicant = normalizeJid(participantValue);
  if (!applicant) return false;

  // Baileys confirma a entrada real pelo evento group-participants.update action=add.
  if (event.action === 'add' || event.action === 'joined') {
    const joinedApp = findOpenApplication(data, groupJid, applicant);
    if (!joinedApp) {
      const ageBlocked = Object.values(data.applications).find(item =>
        item.groupJid === groupJid && normalizeJid(item.participant) === applicant &&
        item.rejectionType === 'age_maximum' && ['rejected', 'age_rejection_pending', 'joined_age_rejected'].includes(item.status)
      );
      if (ageBlocked) {
        await notifyAdmins(sock, groupJid, ageBlocked, 'ALERTA: participante com solicitação bloqueada por idade entrou por uma ação externa. A apresentação não foi publicada.');
        return true;
      }
      return false;
    }
    joinedApp.joinedAt ||= new Date().toISOString();
    const storedCfg = data.groups[groupJid];
    if (!storedCfg?.enabled) {
      joinedApp.status = 'joined_incomplete';
      saveData(data);
      return true;
    }
    const cfg = getGroupConfig(data, groupJid, storedCfg.groupName || joinedApp.groupName || '');
    const result = evaluateApplication(joinedApp, cfg);
    if (result.status !== 'ready') {
      if (result.status === 'rejected' && result.rejectionType === 'age_maximum') {
        joinedApp.status = 'joined_age_rejected';
        joinedApp.rejectionType = 'age_maximum';
        joinedApp.rejectionReason = result.reasons.join('; ');
        joinedApp.rejectedAt = new Date().toISOString();
        saveData(data);
        await sock.sendMessage(applicant, {
          text: `⛔ Sua entrada foi detectada, mas a idade informada (${joinedApp.fields.age} anos) ultrapassa o limite de *${cfg.maxAge} anos*. Sua apresentação não será publicada. Fale com os administradores.`
        }).catch(() => {});
        await notifyAdmins(sock, groupJid, joinedApp, `ALERTA: a pessoa já entrou, mas declarou idade acima do limite (${cfg.maxAge}). A apresentação foi bloqueada e não foi publicada.`);
        return true;
      }
      joinedApp.status = result.status === 'review' ? 'joined_review' : 'joined_incomplete';
      joinedApp.missing = result.missing || [];
      joinedApp.reviewReasons = result.reasons || [];
      saveData(data);
      const explanation = result.status === 'review'
        ? `Sua entrada foi detectada, mas sua apresentação precisa de análise dos administradores:\n${result.reasons.join('\n')}`
        : `Sua entrada foi detectada. Para concluir a apresentação ainda falta:\n${(result.missing || []).join('\n')}`;
      await sock.sendMessage(applicant, { text: explanation }).catch(() => {});
      await notifyAdmins(sock, groupJid, joinedApp, 'A pessoa já entrou, mas a apresentação não está liberada para publicação: ' + (result.reasons || result.missing || []).join('; '));
      return true;
    }
    const published = await publishApplicationToGroup(sock, data, joinedApp, cfg);
    if (!published) {
      joinedApp.status = 'publication_pending';
      saveData(data);
      if (joinedApp.photoResendRequired) {
        await sock.sendMessage(applicant, {
          text: '✅ Sua entrada foi confirmada. Só falta reenviar a foto neste PV para eu concluir a publicação; seus outros dados continuam salvos.'
        }).catch(() => {});
      }
      return true;
    }
    joinedApp.status = 'approved';
    joinedApp.approvedAt ||= new Date().toISOString();
    saveData(data);
    await sock.sendMessage(applicant, {
      text: `✅ Sua entrada em *${cfg.groupName || 'o grupo'}* foi confirmada e sua apresentação completa já foi publicada. Deus abençoe!`
    }).catch(() => {});
    await notifyAdmins(sock, groupJid, joinedApp, 'Entrada confirmada e apresentação publicada.');
    return true;
  }

  if (event.action === 'revoked' || event.action === 'rejected') {
    const existing = findOpenApplication(data, groupJid, applicant);
    if (existing) {
      existing.status = event.action === 'revoked' ? 'revoked' : 'rejected';
      existing.closedAt = new Date().toISOString();
      delete data.activeByApplicant[applicant];
      saveData(data);
    }
    return false;
  }
  if (event.action !== 'created') return false;
  const storedCfg = data.groups[groupJid];
  if (!storedCfg?.enabled) return false;
  const cfg = getGroupConfig(data, groupJid, storedCfg.groupName || '');
  saveData(data);

  let app = findOpenApplication(data, groupJid, applicant);
  if (app) {
    if (app.dmSent) return false;
    try {
      await sock.sendMessage(applicant, { text: renderRequestMessage(cfg, app) });
      app.dmSent = true;
      app.dmSentAt = new Date().toISOString();
      saveData(data);
      return true;
    } catch (error) {
      app.dmError = String(error?.message || error).slice(0, 240);
      saveData(data);
      return false;
    }
  }

  let groupName = cfg.groupName || '';
  try {
    const metadata = await sock.groupMetadata(groupJid);
    groupName = metadata.subject || groupName;
    cfg.groupName = groupName;
  } catch {}

  app = {
    code: createCode(data),
    groupJid,
    groupName,
    participant: applicant,
    status: 'awaiting',
    fields: {},
    photoReceived: false,
    requestedAt: new Date().toISOString(),
    dmSent: false,
    noDeadline: true
  };
  data.applications[app.code] = app;
  saveData(data);

  try {
    await sock.sendMessage(applicant, { text: renderRequestMessage(cfg, app) });
    app.dmSent = true;
    app.dmSentAt = new Date().toISOString();
    saveData(data);
    return true;
  } catch (error) {
    app.dmError = String(error?.message || error).slice(0, 240);
    saveData(data);
    await notifyAdmins(sock, groupJid, app, 'Não consegui enviar a mensagem no privado. Peça para a pessoa iniciar conversa com o bot.');
    console.warn('[ENTRADA] Falha ao abrir PV para solicitante; solicitação preservada.');
    return false;
  }
}

export async function resumeGroupJoinRequests(sock) {
  const data = loadData();
  const enabledGroups = Object.entries(data.groups).filter(([, cfg]) => cfg?.enabled).map(([jid]) => jid);
  let scanned = 0;
  for (const groupJid of enabledGroups) {
    // Reconcilia aplicações pendentes com os membros atuais. Isso recupera
    // entradas que ocorreram antes do bot receber/registrar action=add, sem
    // publicar nada para quem ainda não é membro.
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const candidates = Object.values(data.applications).filter(app =>
        app.groupJid === groupJid &&
        ['ready', 'review', 'approval_pending', 'awaiting_entry', 'joined_incomplete', 'joined_review', 'publication_pending'].includes(app.status)
      );
      for (const app of candidates) {
        const aliases = identityAliases(app.participant);
        const isMember = (metadata.participants || []).some(member => aliasesMatch(aliases, identityAliases(member)));
        if (isMember) {
          await handleGroupJoinRequest(sock, { id: groupJid, participant: app.participant, action: 'add' });
          scanned++;
        }
      }
    } catch (error) {
      console.warn('[ENTRADA] Não foi possível reconciliar membros existentes do grupo:', error?.message || error);
    }
    try {
      const requests = await sock.groupRequestParticipantsList(groupJid);
      for (const request of requests || []) {
        const participant = request.jid || request.participant || request.requester;
        if (!participant) continue;
        await handleGroupJoinRequest(sock, { id: groupJid, participant, action: 'created', method: 'invite_link' });
        scanned++;
      }
    } catch (error) {
      console.warn('[ENTRADA] Não foi possível sincronizar pedidos pendentes de um grupo:', error?.message || error);
    }
  }
  console.log(`[ENTRADA] Sincronização concluída. Grupos ativos: ${enabledGroups.length}; solicitações verificadas: ${scanned}.`);
  return { groups: enabledGroups.length, requests: scanned };
}

export async function handleApplicantPrivateMessage(sock, msg) {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || msg?.key?.fromMe) return false;
  const { image, text } = extractMessage(msg);
  const sender = normalizeJid(remoteJid);
  if (!sender) return false;

  const data = loadData();
  const raw = String(text || '').trim();
  const normalizedStart = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const startMatch = normalizedStart.match(/^!apresentacao(?:\s+([a-f0-9]{6}))?\s*$/i);
  const plainStart = normalizeLabel(raw) === 'apresentacao';
  if (startMatch || plainStart) {
    const requestedCode = startMatch?.[1]?.toUpperCase();
    let app = requestedCode ? data.applications[requestedCode] : null;

    if (!requestedCode) {
      const activeCode = data.activeByApplicant[sender];
      const activeApp = activeCode ? data.applications[activeCode] : null;
      if (activeApp && normalizeJid(activeApp.participant) === sender &&
          !['approved', 'rejected', 'revoked', 'age_rejection_pending', 'joined_age_rejected'].includes(activeApp.status) &&
          (!['ready', 'review'].includes(activeApp.status) || activeApp.ageConfirmed !== true)) {
        app = activeApp;
      } else {
        const pending = Object.values(data.applications)
          .filter(item => normalizeJid(item.participant) === sender && (
            ['awaiting', 'collecting', 'incomplete', 'awaiting_age_confirmation'].includes(item.status) ||
            (['ready', 'review'].includes(item.status) && item.ageConfirmed !== true)
          ))
          .sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
        if (pending.length === 1) app = pending[0];
        else if (pending.length > 1) {
          const choices = pending.slice(0, 8).map(item => `• *${item.groupName || 'Grupo'}*: !apresentação ${item.code}`).join('\n');
          await sock.sendMessage(remoteJid, { text: `Você tem mais de uma solicitação pendente. Escolha o grupo usando o código recebido:\n\n${choices}` });
          return true;
        }
      }
    }

    if (!app || normalizeJid(app.participant) !== sender ||
        ['approved', 'rejected', 'revoked', 'age_rejection_pending', 'joined_age_rejected'].includes(app.status) ||
        (['ready', 'review'].includes(app.status) && app.ageConfirmed === true)) {
      await sock.sendMessage(remoteJid, { text: requestedCode
        ? '❌ Código não encontrado para este número ou solicitação já encerrada. Confira o código recebido no convite.'
        : 'Não encontrei uma solicitação pendente para este número. Primeiro peça para entrar no grupo pelo link e aguarde a mensagem do bot.' });
      return true;
    }
    data.activeByApplicant[sender] = app.code;
    app.status = app.pendingAgeConfirmation != null
      ? 'awaiting_age_confirmation'
      : (app.photoReceived || Object.keys(app.fields || {}).length ? 'incomplete' : 'collecting');
    app.startedAt ||= new Date().toISOString();
    saveData(data);
    const cfg = getGroupConfig(data, app.groupJid, app.groupName);
    saveData(data);
    await sock.sendMessage(remoteJid, {
      text: [
        `📝 Apresentação iniciada para *${app.groupName || 'o grupo'}* (código ${app.code}).`,
        '',
        'Envie um dado por linha, nesta ordem. Não precisa escrever Nome:, Idade: nem usar dois-pontos:',
        ...positionalFieldOrder(cfg).map(field => ({
          name: '1. Nome', age: '2. Idade', common: '3. Comum', role: 'Cargo', instagram: 'Instagram',
          baptized: 'Batizado(a) (sim/não)', civilStatus: 'Estado civil', privateAllowed: 'PV liberado (sim/não)',
          ccb: 'É da CCB? (sim/não)', acceptedClauses: 'Aceita as cláusulas? (sim/não)',
          relationshipIntent: 'Entrou com intenção de relacionamento? (responda não)',
          publishConsent: 'Autoriza publicar TUDO isso no grupo, incluindo foto e Instagram? (sim/não)'
        })[field]),
        '',
        'Exemplo completo para este grupo (um dado por linha):',
        positionalExample(cfg),
        'Também aceito o formato antigo com rótulos, como Nome: Leo.',
        '',
        'A apresentação completa e a foto serão publicadas no grupo de destino. Isso só acontecerá com sua autorização explícita no último campo.',
        'Envie a foto aqui no privado. Ela fica somente na memória durante o processo, sem ser gravada no banco de dados.',
        'Depois que você informar a idade, vou pedir uma confirmação SIM/NÃO antes de considerar esse campo concluído. A idade é autodeclarada: isso confirma sua declaração, mas não comprova a idade real por documento. Não existe prazo para concluir.'
      ].join('\n')
    });
    return true;
  }

  // Do not intercept unrelated bot commands in a private chat.
  if (raw.startsWith('!')) return false;

  const activeCode = data.activeByApplicant[sender];
  const app = activeCode ? data.applications[activeCode] : null;
  if (!app || normalizeJid(app.participant) !== sender || ['approved', 'rejected', 'revoked', 'age_rejection_pending', 'joined_age_rejected'].includes(app.status)) return false;
  const cfg = getGroupConfig(data, app.groupJid, app.groupName);
  let changed = false;
  if (cfg.fields.photo && app.photoReceived && !TRANSIENT_PHOTOS.has(app.code)) {
    // Buffer não sobrevive a reinicializações; peça somente a foto novamente.
    app.photoReceived = false;
  }
  if (image && cfg.fields.photo) {
    try {
      const photoBuffer = await downloadApplicantPhoto(msg, sock);
      if (!photoBuffer.length) throw new Error('A imagem veio vazia.');
      TRANSIENT_PHOTOS.set(app.code, photoBuffer);
      app.photoReceived = true;
      app.photoReceivedAt = new Date().toISOString();
      app.photoResendRequired = false;
      changed = true;
    } catch (error) {
      await sock.sendMessage(remoteJid, { text: '❌ Não consegui baixar essa foto. Envie novamente como imagem normal pelo WhatsApp, sem ser visualização única.' });
      console.warn('[ENTRADA] Não foi possível baixar a foto da apresentação:', error?.message || error);
      return true;
    }
  }
  // Compatibilidade segura: aplicações antigas podem ter uma idade salva sem
  // confirmação explícita. Reabrimos a confirmação antes de permitir aprovação.
  if (cfg.fields.age && app.ageConfirmed !== true && app.pendingAgeConfirmation == null &&
      Number.isInteger(app.fields?.age) && app.fields.age >= 1 && app.fields.age <= 120) {
    app.pendingAgeConfirmation = app.fields.age;
    delete app.fields.age;
    app.status = 'awaiting_age_confirmation';
    saveData(data);
    await sock.sendMessage(remoteJid, {
      text: `🎂 Você informou anteriormente *${app.pendingAgeConfirmation} anos*. Confirma que essa é sua idade atual?

Responda somente *SIM* ou *NÃO*.`
    });
    return true;
  }

  // A idade fica em espera até uma resposta explícita SIM/NÃO.
  let ageConfirmedThisMessage = false;
  if (cfg.fields.age && app.pendingAgeConfirmation != null) {
    const ageReply = normalizeLabel(text);
    const confirmation = ageReply === 'sim' ? true : ageReply === 'nao' ? false : null;
    if (confirmation === null) {
      await sock.sendMessage(remoteJid, {
        text: `🎂 Você informou *${app.pendingAgeConfirmation} anos*. Para confirmar, responda somente *SIM* ou *NÃO*.`
      });
      return true;
    }
    if (confirmation === false) {
      delete app.pendingAgeConfirmation;
      delete app.fields.age;
      app.ageConfirmed = false;
      app.status = 'incomplete';
      saveData(data);
      await sock.sendMessage(remoteJid, {
        text: 'Tudo bem. Não vou registrar essa idade. Envie novamente somente sua idade correta, por exemplo: *15* ou *15 anos*.'
      });
      return true;
    }
    app.fields.age = Number(app.pendingAgeConfirmation);
    app.ageConfirmed = true;
    app.ageConfirmedAt = new Date().toISOString();
    delete app.pendingAgeConfirmation;
    app.status = 'incomplete';
    ageConfirmedThisMessage = true;
    changed = true;
    saveData(data);
    await sock.sendMessage(remoteJid, { text: `✅ Idade confirmada: *${app.fields.age} anos*.` });
  }

  const parsed = parseApplicationText(ageConfirmedThisMessage ? '' : text, cfg, app);
  let ageNeedsConfirmation = false;
  for (const [field, value] of Object.entries(parsed)) {
    if (value !== null && value !== undefined && value !== '') {
      if (field === 'age' && cfg.fields.age) {
        const alreadyConfirmed = app.ageConfirmed === true && Number(app.fields?.age) === Number(value);
        if (!alreadyConfirmed) {
          app.pendingAgeConfirmation = Number(value);
          app.ageConfirmed = false;
          delete app.fields.age;
          ageNeedsConfirmation = true;
          changed = true;
        }
      } else {
        app.fields[field] = value;
        changed = true;
      }
    }
  }
  if (parsed.errors?.length) {
    await sock.sendMessage(remoteJid, { text: `⚠️ Corrija estes dados:\n${parsed.errors.map(item => `• ${item}`).join('\n')}\n\nO restante da apresentação foi mantido.` });
  }
  if (!changed) {
    if (parsed.errors?.length) return true;
    await sock.sendMessage(remoteJid, { text: 'Não consegui identificar os dados. Envie um por linha, na ordem mostrada na apresentação, sem precisar usar dois-pontos. Também aceito Nome Leo ou Nome: Leo. A idade deve ser um número simples, como 15 ou 15 anos.' });
    return true;
  }
  app.updatedAt = new Date().toISOString();
  if (ageNeedsConfirmation) app.status = 'awaiting_age_confirmation';
  saveData(data);

  if (ageNeedsConfirmation) {
    await sock.sendMessage(remoteJid, {
      text: `🎂 Você informou *${app.pendingAgeConfirmation} anos*. Confirma que essa é sua idade atual?\n\nResponda somente *SIM* ou *NÃO*. Se responder NÃO, pedirei a idade novamente.`
    });
    return true;
  }

  const result = evaluateApplication(app, cfg);
  if (result.status === 'incomplete') {
    app.status = 'incomplete';
    app.missing = result.missing;
    saveData(data);
    await sock.sendMessage(remoteJid, {
      text: `Recebi sua atualização! Ainda falta:\n${result.missing.map(item => `• ${item}`).join('\n')}\n\nEnvie somente o que falta. A foto pode ser enviada agora; não precisa repetir dados já recebidos. Não há prazo.`
    });
    return true;
  }

  await sock.sendMessage(remoteJid, { text: '✅ Recebi todos os dados necessários. Vou verificar as cláusulas e encaminhar a solicitação.' });
  await dispatchApplication(sock, data, app, cfg, result);
  if (['approved', 'ready', 'review'].includes(app.status)) delete data.activeByApplicant[sender];
  saveData(data);
  return true;
}

async function commandGroupContext(ctx, requireBot = false) {
  const metadata = await checkGroupAdmin(ctx, requireBot);
  if (!metadata) return null;
  const data = loadData();
  const cfg = getGroupConfig(data, ctx.jid, metadata.subject || '');
  return { data, cfg, metadata };
}

async function toggleEntry(ctx, on) {
  // Ativar exige que o bot seja admin para ligar a aprovação de entrada do WhatsApp.
  // Desativar apenas pausa o atendimento no PV; não desliga a aprovação nativa,
  // evitando que solicitações pendentes sejam afetadas inesperadamente.
  const context = await commandGroupContext(ctx, on);
  if (!context) return true;
  const { data, cfg, metadata } = context;
  try {
    if (on) {
      if (typeof ctx.sock.groupJoinApprovalMode !== 'function') throw new Error('A versão do Baileys não oferece groupJoinApprovalMode.');
      await ctx.sock.groupJoinApprovalMode(ctx.jid, 'on');
    }
    cfg.enabled = on;
    cfg.groupName = metadata.subject || cfg.groupName;
    saveData(data);
    await ctx.send(ctx.jid, on
      ? `✅ Atendimento de solicitações ativado em *${cfg.groupName}*.\nO WhatsApp agora exige solicitação de entrada; quem solicitar receberá as instruções no PV. A apresentação completa será publicada no grupo somente depois de autorização expressa da pessoa.\nUse !autoaprovarsolicitacao on se desejar aprovar automaticamente apenas apresentações válidas.`
      : `⏸️ Mensagens de apresentação no PV pausadas em *${cfg.groupName}*.\nA aprovação de entrada do WhatsApp permanece ligada; pedidos pendentes não foram apagados, aprovados nem recusados.`, ctx.msg);
  } catch (error) {
    await ctx.send(ctx.jid, `❌ Não consegui ativar a aprovação de entrada. Confirme se o bot continua administrador.\nDetalhe: ${String(error?.message || error).slice(0, 180)}`, ctx.msg);
  }
  return true;
}

async function toggleAutoAccept(ctx, on) {
  const context = await commandGroupContext(ctx, on);
  if (!context) return true;
  const { data, cfg } = context;
  if (on && !cfg.enabled) {
    await ctx.send(ctx.jid, 'Primeiro ative as solicitações com !entrada on. Isso liga a aprovação de entrada do WhatsApp e as mensagens no PV.', ctx.msg);
    return true;
  }
  cfg.autoAccept = on;
  saveData(data);
  await ctx.send(ctx.jid, on
    ? '✅ Autoaprovação ativada. Primeiro publico no grupo a apresentação completa autorizada pela pessoa; depois aprovo somente se os campos, cláusulas e idade estiverem válidos. Casos incompletos ou duvidosos vão para os administradores.'
    : '⏸️ Autoaceitação desativada. Apresentações completas ficarão aguardando aprovação dos administradores.', ctx.msg);
  return true;
}

async function createClauses(ctx, args) {
  const context = await commandGroupContext(ctx, false);
  if (!context) return true;
  const { data, cfg, metadata } = context;
  const supplied = String(args || '').trim();
  if (supplied) {
    const clauses = supplied.split('|').map(x => x.trim()).filter(Boolean);
    if (!clauses.length || clauses.length > 15 || clauses.some(x => x.length > 500)) {
      await ctx.send(ctx.jid, 'Use até 15 cláusulas, separadas por |, com no máximo 500 caracteres cada.', ctx.msg);
      return true;
    }
    cfg.clauses = clauses;
  } else {
    await ctx.send(ctx.jid, 'As cláusulas são exclusivas deste grupo. Envie: !criarclausulas regra 1 | regra 2 | regra 3. Não vou copiar cláusulas de outro grupo.', ctx.msg);
    return true;
  }
  cfg.requireClauseAcceptance = true;
  cfg.groupName = metadata.subject || cfg.groupName;
  saveData(data);
  await ctx.send(ctx.jid, `✅ Cláusulas criadas para *${cfg.groupName}*.\n\n${clauseText(cfg)}\n\nPara editar: !clausulas adicionar texto | !clausulas remover número.`, ctx.msg);
  return true;
}

async function editClauses(ctx, args) {
  const context = await commandGroupContext(ctx, false);
  if (!context) return true;
  const { data, cfg } = context;
  const [actionRaw, ...rest] = String(args || '').trim().split(/\s+/);
  const action = normalizeLabel(actionRaw);
  const restText = rest.join(' ').trim();
  if (!action || ['listar', 'lista', 'ver', 'campos', 'campo'].includes(action) && !restText) {
    await ctx.send(ctx.jid, clauseText(cfg) + '\n\n' + helpText(), ctx.msg);
    return true;
  }
  if (['adicionar', 'add', 'nova'].includes(action)) {
    if (!restText) { await ctx.send(ctx.jid, 'Use !clausulas adicionar texto da cláusula.', ctx.msg); return true; }
    if (cfg.clauses.length >= 15) { await ctx.send(ctx.jid, 'Limite de 15 cláusulas atingido.', ctx.msg); return true; }
    cfg.clauses.push(restText.slice(0, 500));
  } else if (['remover', 'remove', 'del'].includes(action)) {
    const index = Number(restText) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= cfg.clauses.length) { await ctx.send(ctx.jid, 'Informe o número de uma cláusula existente. Exemplo: !clausulas remover 2', ctx.msg); return true; }
    cfg.clauses.splice(index, 1);
  } else if (action === 'idade-max') {
    if (['off', 'nenhuma', 'sem', 'none'].includes(normalizeLabel(restText))) cfg.maxAge = null;
    else {
      const age = Number(restText);
      if (!Number.isInteger(age) || age < 1 || age > 120) { await ctx.send(ctx.jid, 'Informe uma idade de 1 a 120 ou use off para retirar o limite.', ctx.msg); return true; }
      cfg.maxAge = age;
    }
    cfg.agePolicyConfigured = true;
  } else if (action === 'ccb') {
    const value = parseOnOff(restText);
    if (value === null) { await ctx.send(ctx.jid, 'Use !clausulas ccb on ou !clausulas ccb off.', ctx.msg); return true; }
    cfg.requireCCB = value;
  } else if (action === 'relacionamento') {
    const value = parseOnOff(restText);
    if (value === null) { await ctx.send(ctx.jid, 'Use !clausulas relacionamento on ou !clausulas relacionamento off.', ctx.msg); return true; }
    cfg.requireNoRelationship = value;
  } else if (action === 'campo') {
    const match = restText.match(/^([a-zA-ZÀ-ÿ() ]+)\s+(on|off)$/i);
    if (!match) { await ctx.send(ctx.jid, 'Use !clausulas campo instagram off ou !clausulas campo todos on/off. Campos: foto, nome, idade, comum, cargo, instagram, batizado, estado civil e pv liberado.', ctx.msg); return true; }
    const label = normalizeLabel(match[1]);
    const fieldMap = { foto: 'photo', nome: 'name', idade: 'age', comum: 'common', cargo: 'role', instagram: 'instagram', batizado: 'baptized', 'estado civil': 'civilStatus', 'pv liberado': 'privateAllowed' };
    const enabled = match[2].toLowerCase() === 'on';
    cfg.fieldOverrides ||= {};
    if (label === 'todos') {
      for (const key of Object.keys(fieldMap).map(name => fieldMap[name])) {
        cfg.fields[key] = enabled;
        cfg.fieldOverrides[key] = true;
      }
    } else {
      const key = fieldMap[label];
      if (!key) { await ctx.send(ctx.jid, 'Campo desconhecido. Use foto, nome, idade, comum, cargo, instagram, batizado, estado civil, pv liberado ou todos.', ctx.msg); return true; }
      cfg.fields[key] = enabled;
      cfg.fieldOverrides[key] = true;
    }
  } else {
    await ctx.send(ctx.jid, helpText(), ctx.msg);
    return true;
  }
  saveData(data);
  await ctx.send(ctx.jid, `✅ Configuração atualizada.\n\n${clauseText(cfg)}`, ctx.msg);
  return true;
}

async function listRequests(ctx) {
  const context = await commandGroupContext(ctx, false);
  if (!context) return true;
  const { data, cfg } = context;
  const items = Object.values(data.applications).filter(app => app.groupJid === ctx.jid && !['approved', 'rejected', 'revoked'].includes(app.status));
  if (!items.length) {
    await ctx.send(ctx.jid, `📨 Não há solicitações abertas neste grupo.\nEntrada: ${cfg.enabled ? 'ativada' : 'desativada'} | Autoaceitação: ${cfg.autoAccept ? 'ativada' : 'desativada'}`, ctx.msg);
    return true;
  }
  const text = items.slice(0, 30).map(app => {
    const labels = {
      awaiting_age_confirmation: 'aguardando confirmação da idade no PV',
      incomplete: 'apresentação incompleta',
      review: 'análise manual — não aprovar automaticamente',
      age_rejection_pending: 'IDADE FORA DO LIMITE — aprovação bloqueada; recusa pendente no WhatsApp',
      ready: 'validada — aguardando aprovação dos administradores',
      approval_pending: 'aprovação solicitada ao WhatsApp',
      awaiting_entry: 'aprovação recebida — aguardando entrada real',
      joined_incomplete: 'já entrou — faltam dados da apresentação',
      joined_review: 'já entrou — apresentação em análise manual',
      publication_pending: 'entrada confirmada — publicação pendente',
      publication_pending_after_join: 'entrada confirmada — publicação pendente'
    };
    const status = labels[app.status] || app.status;
    return `• ${app.code} — ${status}`;
  }).join('\n');
  await ctx.send(ctx.jid, `📨 SOLICITAÇÕES (${items.length})\n\n${text}\n\nUse !aprovarsolicitacao CÓDIGO ou !recusarsolicitacao CÓDIGO.`, ctx.msg);
  return true;
}

async function decideRequest(ctx, code, approve) {
  const context = await commandGroupContext(ctx, true);
  if (!context) return true;
  const { data, cfg } = context;
  const app = data.applications[String(code || '').trim().toUpperCase()];
  if (!app || app.groupJid !== ctx.jid || ['approved', 'rejected', 'revoked'].includes(app.status)) {
    await ctx.send(ctx.jid, '❌ Código não encontrado ou solicitação já encerrada. Use !solicitacoes para consultar.', ctx.msg);
    return true;
  }
  if (approve) {
    const check = evaluateApplication(app, cfg);
    if (check.status !== 'ready') {
      // Também converte solicitações antigas que estavam em análise manual
      // em recusa real quando o administrador tenta aprová-las.
      if (check.status === 'rejected' && check.rejectionType === 'age_maximum' && app.status !== 'age_rejection_pending') {
        await dispatchApplication(ctx.sock, data, app, cfg, check);
        saveData(data);
      }
      await ctx.send(ctx.jid, check.status === 'incomplete'
        ? `❌ Ainda não pode aprovar. Faltam:\n${check.missing.map(x => `• ${x}`).join('\n')}`
        : check.status === 'rejected'
          ? `⛔ APROVAÇÃO BLOQUEADA. Esta solicitação viola um limite obrigatório e não pode ser aprovada pelo bot:\n${(check.reasons || []).join('\n')}`
          : `❌ Não pode aprovar por causa destas condições:\n${(check.reasons || []).join('\n')}`, ctx.msg);
      return true;
    }
  }
  try {
    if (approve) {
      app.status = 'approval_pending';
      app.approvalRequestedAt = new Date().toISOString();
      saveData(data);
    }
    const result = await ctx.sock.groupRequestParticipantsUpdate(ctx.jid, [app.participant], approve ? 'approve' : 'reject');
    const ok = Array.isArray(result) && result.some(row => String(row.status || '200') === '200');
    if (!ok) throw new Error('O WhatsApp não confirmou a operação.');
    if (approve) {
      if (app.status === 'approval_pending') app.status = 'awaiting_entry';
      app.approvalAcceptedAt = new Date().toISOString();
    } else {
      app.status = 'rejected';
      app.rejectedAt = new Date().toISOString();
    }
    saveData(data);
    await ctx.sock.sendMessage(app.participant, { text: approve
      ? `✅ O WhatsApp recebeu a aprovação da sua solicitação para *${cfg.groupName || 'o grupo'}*. Sua apresentação será publicada somente quando sua entrada for confirmada.`
      : `Sua solicitação para *${cfg.groupName || 'o grupo'}* não foi aprovada pelos administradores.` }).catch(() => {});
    await ctx.send(ctx.jid, approve ? `✅ Aprovação solicitada para ${app.code}. Aguardando o WhatsApp confirmar a entrada.` : `⛔ Solicitação ${app.code} recusada.`, ctx.msg);
  } catch (error) {
    if (approve && app.status === 'approval_pending') app.status = 'ready';
    saveData(data);
    await ctx.send(ctx.jid, `❌ Não consegui processar a solicitação: ${String(error?.message || error).slice(0, 180)}`, ctx.msg);
  }
  return true;
}

export async function handleJoinApprovalCommand(ctx) {
  const command = String(ctx.command || '').toLowerCase();
  if (!COMMANDS.has(command)) return false;
  if (command === 'entrada') {
    const value = parseOnOff(ctx.value);
    if (value === null) { await ctx.send(ctx.jid, helpText(), ctx.msg); return true; }
    return toggleEntry(ctx, value);
  }
  if (command === 'autoaceitar' || command === 'autoaprovarsolicitacao') {
    const value = parseOnOff(ctx.value);
    if (value === null) { await ctx.send(ctx.jid, 'Use !autoaprovarsolicitacao on ou !autoaprovarsolicitacao off.', ctx.msg); return true; }
    return toggleAutoAccept(ctx, value);
  }
  if (command === 'criarclausulas') return createClauses(ctx, ctx.value);
  if (command === 'clausulas') return editClauses(ctx, ctx.value);
  if (command === 'solicitacoes') return listRequests(ctx);
  if (command === 'aprovarsolicitacao') return decideRequest(ctx, ctx.value, true);
  if (command === 'recusarsolicitacao') return decideRequest(ctx, ctx.value, false);
  return false;
}

export const __test = {
  normalizeJid,
  normalizeLabel,
  parseApplicationText,
  evaluateApplication,
  makeGroupConfig,
  getGroupConfig,
  LEGACY_MOCIDADE_GROUP_ID,
  defaultClauses,
  positionalFieldOrder,
  assignApplicationValue,
  parseBoolean,
  publicPresentationText,
  TRANSIENT_PHOTOS
};
