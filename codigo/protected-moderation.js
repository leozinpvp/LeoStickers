import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.resolve(process.cwd(), 'protection-attempts.json');

function flatten(value, output = []) {
  if (value === null || value === undefined) return output;

  if (Array.isArray(value)) {
    for (const item of value) flatten(item, output);
    return output;
  }

  if (typeof value === 'object') {
    for (const key of [
      'id', 'jid', 'lid', 'phoneNumber', 'participant', 'user'
    ]) {
      if (value[key] !== undefined && value[key] !== null) {
        flatten(value[key], output);
      }
    }
    return output;
  }

  output.push(String(value).trim());
  return output;
}

function aliasesOf(...values) {
  const aliases = new Set();

  for (const rawValue of flatten(values)) {
    const raw = String(rawValue).trim().toLowerCase();
    if (!raw) continue;

    const at = raw.lastIndexOf('@');

    if (at === -1) {
      const number = raw.replace(/\D/g, '');
      if (number) aliases.add(`${number}@s.whatsapp.net`);
      continue;
    }

    const local = raw.slice(0, at).split(':')[0].replace(/^\+/, '');
    const domain = raw.slice(at + 1);

    if (local && domain) {
      aliases.add(`${local}@${domain}`);
    }
  }

  return aliases;
}

function intersects(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function isAdmin(participant) {
  return participant?.admin === 'admin' ||
         participant?.admin === 'superadmin' ||
         participant?.isAdmin === true;
}

function isSuperAdmin(participant) {
  return participant?.admin === 'superadmin';
}

function findParticipant(participants, aliases) {
  return participants.find(participant =>
    intersects(aliasesOf(participant), aliases)
  );
}

function ownerMatches(isOwner, values) {
  if (typeof isOwner !== 'function') return false;

  const candidates = [
    ...flatten(values),
    ...aliasesOf(values)
  ];

  for (const candidate of new Set(candidates)) {
    try {
      if (isOwner(candidate)) return true;
    } catch {
      // Uma identidade inválida não deve interromper a proteção.
    }
  }

  return false;
}

function readAttempts() {
  if (!fs.existsSync(DATA_FILE)) {
    return { version: 1, groups: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  if (!parsed || typeof parsed !== 'object' ||
      !parsed.groups || typeof parsed.groups !== 'object') {
    throw new Error('O arquivo de tentativas possui formato inválido.');
  }

  return parsed;
}

function saveAttempts(data) {
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temporary, DATA_FILE);
}

function participantJid(participant) {
  const candidates = flatten(participant);
  const direct = participant?.id ||
                 participant?.jid ||
                 participant?.phoneNumber;

  if (direct) return String(direct);

  return candidates.find(value => value.includes('@')) || null;
}

function assertSuccessfulResponse(result) {
  if (result === undefined || result === null) {
    throw new Error('O WhatsApp não retornou confirmação da ação.');
  }

  if (Array.isArray(result) && result.length === 0) {
    throw new Error('O WhatsApp não confirmou nenhum participante.');
  }

  const rows = Array.isArray(result) ? result : [result];

  for (const row of rows) {
    if (row?.status !== undefined &&
        Number(row.status) !== 200) {
      throw new Error(`O WhatsApp recusou a ação (status ${row.status}).`);
    }
  }
}

export async function handleProtectedModerationCommand({
  sock,
  ctx,
  targets,
  isOwner
}) {
  const groupJid = String(ctx?.jid || '');

  if (!groupJid.endsWith('@g.us')) {
    return { handled: false };
  }

  const targetList = Array.isArray(targets)
    ? targets
    : targets ? [targets] : [];

  if (!targetList.length) {
    return { handled: false };
  }

  const metadata = await sock.groupMetadata(groupJid);
  const participants = metadata?.participants || [];

  const botAliases = aliasesOf(
    sock?.user,
    sock?.authState?.creds?.me
  );

  const groupOwnerAliases = aliasesOf(metadata?.owner);

  const targetIsProtected = targetList.some(target => {
    const targetAliases = aliasesOf(target);
    const targetParticipant = findParticipant(
      participants,
      targetAliases
    );

    return intersects(targetAliases, botAliases) ||
           intersects(targetAliases, groupOwnerAliases) ||
           isSuperAdmin(targetParticipant) ||
           ownerMatches(isOwner, [target, targetParticipant]);
  });

  if (!targetIsProtected) {
    return { handled: false };
  }

  const messageKey = ctx?.msg?.key || {};

  const actorValues = [
    ctx?.sender,
    messageKey.participant,
    messageKey.participantAlt,
    messageKey.remoteJidAlt
  ];

  const actorAliases = aliasesOf(actorValues);
  const actor = findParticipant(participants, actorAliases);

  if (ownerMatches(isOwner, actorValues) ||
      intersects(actorAliases, botAliases) ||
      intersects(actorAliases, groupOwnerAliases) ||
      isSuperAdmin(actor)) {
    return {
      handled: true,
      message: '🛡️ Ação bloqueada: esta conta também está protegida.'
    };
  }

  if (!actor || !isAdmin(actor)) {
    return { handled: false };
  }

  const botParticipant = findParticipant(participants, botAliases);
  const botIsGroupOwner = intersects(botAliases, groupOwnerAliases);

  if (!isAdmin(botParticipant) && !botIsGroupOwner) {
    return {
      handled: true,
      message: '⚠️ Ação bloqueada. Preciso ser administrador do grupo para proteger as contas. Promova o bot novamente e tente depois.'
    };
  }

  const actorJid = participantJid(actor);

  if (!actorJid) {
    return {
      handled: true,
      message: '⚠️ Ação bloqueada: não consegui identificar com segurança o administrador que enviou o comando.'
    };
  }

  const actorKey = [...actorAliases].sort()[0] || actorJid;

  let data;
  try {
    data = readAttempts();
  } catch (error) {
    console.error('[PROTEÇÃO] Não foi possível ler as tentativas:', error);
    return {
      handled: true,
      message: '⚠️ Ação bloqueada por segurança: não consegui ler o registro de proteção.'
    };
  }

  data.groups[groupJid] ||= {};
  const previous = Number(data.groups[groupJid][actorKey] || 0);
  const next = previous + 1;

  const action = next === 1 ? 'demote' : 'remove';

  try {
    const result = await sock.groupParticipantsUpdate(
      groupJid,
      [actorJid],
      action
    );

    assertSuccessfulResponse(result);
  } catch (error) {
    console.error('[PROTEÇÃO] Falha ao aplicar punição:', error?.stack || error);

    return {
      handled: true,
      message: `⚠️ Detectei a tentativa, mas não consegui aplicar a punição. ${String(error?.message || error).slice(0, 180)}`
    };
  }

  data.groups[groupJid][actorKey] = next;

  try {
    saveAttempts(data);
  } catch (error) {
    console.error('[PROTEÇÃO] Falha ao salvar tentativas:', error);

    return {
      handled: true,
      message: '⚠️ A ação de proteção foi executada, mas não consegui salvar o contador de tentativas.'
    };
  }

  console.log(
    `[PROTEÇÃO] Grupo ${groupJid}: ocorrência ${next}, ação ${action}, autor ${actorJid}.`
  );

  return {
    handled: true,
    message: next === 1
      ? '🛡️ Proteção ativada: tentativa contra uma conta protegida detectada. Você perdeu o cargo de administrador (1ª ocorrência).'
      : '🛡️ Segunda tentativa contra uma conta protegida detectada. Você foi removido do grupo.'
  };
}
