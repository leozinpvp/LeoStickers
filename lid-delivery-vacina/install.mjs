import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const joinPath = path.join(root, 'codigo', 'join-approval.js');
const indexPath = path.join(root, 'index.js');
const marker = 'LEO_JOIN_DM_DELIVERY_TRACKING_V1';

function fail(message) {
  console.error(`\n❌ ${message}`);
  console.error('Nenhum arquivo original foi sobrescrito.');
  process.exit(1);
}

if (!fs.existsSync(joinPath) || !fs.existsSync(indexPath)) {
  fail('Execute este instalador na raiz do projeto, onde existem index.js e codigo/join-approval.js.');
}

let joinSource = fs.readFileSync(joinPath, 'utf8');
let indexSource = fs.readFileSync(indexPath, 'utf8');

if (joinSource.includes(marker) || indexSource.includes(marker)) {
  console.log('✅ A vacina de rastreamento de entrega já está instalada.');
  process.exit(0);
}

function replaceFunction(source, name, replacement, asyncFunction = false) {
  const prefix = asyncFunction ? 'async\\s+function' : 'function';
  const re = new RegExp(`${prefix}\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const matches = source.match(re) || [];
  if (matches.length !== 1) {
    throw new Error(`Função ${name}: encontrei ${matches.length}, esperava exatamente 1.`);
  }
  return source.replace(re, replacement);
}

try {
  // 1) PN e LID passam a ser validados pelo sufixo. Um LID nunca será salvo como PN.
  joinSource = replaceFunction(joinSource, 'participantIdentity', `function participantIdentity(event) {
  const raw = event?.participant ?? event?.participants?.[0] ?? null;
  const object = raw && typeof raw === 'object' ? raw : {};
  const groupParticipant = typeof raw === 'string' ? raw :
    (object.id || object.jid || object.lid || object.participant || object.phoneNumber || '');
  const normalizeCandidate = value => {
    if (!value) return '';
    const jid = normalizeJid(value);
    return jid.endsWith('@s.whatsapp.net') ? jid : '';
  };
  const normalizeLid = value => {
    if (!value) return '';
    const jid = normalizeJid(value);
    return jid.endsWith('@lid') ? jid : '';
  };
  const participantPn = normalizeCandidate(
    event?.participantPn || event?.participantPN || object.participantPn || object.phoneNumber || object.pn ||
    (typeof groupParticipant === 'string' && groupParticipant.endsWith('@s.whatsapp.net') ? groupParticipant : '')
  );
  const participantLid = normalizeLid(
    event?.participantLid || object.lid ||
    (typeof groupParticipant === 'string' && groupParticipant.endsWith('@lid') ? groupParticipant : '')
  );
  return { groupParticipant, participantPn, participantLid, raw };
}`);

  // 2) Não chama lidMapping.getPNForLID (não existe nessa versão do Baileys).
  //    Quando só houver LID, ele próprio será usado como destino privado.
  joinSource = replaceFunction(joinSource, 'resolvePrivateJid', `async function resolvePrivateJid(sock, identity) {
  const direct = normalizeJid(identity?.participantPn || '');
  if (direct.endsWith('@s.whatsapp.net')) return direct;

  const groupId = normalizeJid(identity?.groupParticipant || '');
  if (groupId.endsWith('@s.whatsapp.net')) return groupId;

  const lid = normalizeJid(identity?.participantLid || groupId || '');
  if (lid.endsWith('@lid')) return lid;
  return '';
}`, true);

  // 3) Retorna o WAMessage real de todas as rotas de envio.
  joinSource = replaceFunction(joinSource, 'sendApplicationInvite', `async function sendApplicationInvite(sock, applicant, cfg, app) {
  const useButtons = cfg.inviteMode === 'buttons';
  const text = renderRequestMessage(cfg, app, useButtons);
  if (!useButtons) {
    return await sock.sendMessage(applicant, { text });
  }
  try {
    return await sendInteractiveMessage(sock, applicant, {
      text,
      footer: 'Léo Stickers • Apresentação',
      buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📝 Iniciar apresentação', id: 'ls_start_presentation_' + app.code }) },
        { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: '📋 Copiar modelo', copy_code: buildPresentationCopyTemplate(cfg) }) }
      ]
    });
  } catch (error) {
    console.warn('[APRESENTAÇÃO] Botões indisponíveis; enviando convite em texto:', error?.message || error);
    return await sock.sendMessage(applicant, { text: text + '\\n\\nComo alternativa, envie *!apresentação ' + app.code + '* para começar. O modelo também pode ser copiado manualmente a partir dos campos acima.' });
  }
}`, true);

  // 4) Nos dois fluxos, registra o ID para correlacionar os ACKs do WhatsApp.
  const sendCall = /^(\s*)await sendApplicationInvite\(sock, targetPrivateJid, cfg, app\);\r?\n\s*app\.dmSent = true;/gm;
  const sendMatches = [...joinSource.matchAll(sendCall)];
  if (sendMatches.length !== 2) {
    throw new Error(`Chamadas de sendApplicationInvite: encontrei ${sendMatches.length}, esperava exatamente 2.`);
  }
  joinSource = joinSource.replace(sendCall, (_whole, indent) => `${indent}const inviteMessage = await sendApplicationInvite(sock, targetPrivateJid, cfg, app);
${indent}app.dmSent = true;
${indent}app.dmMessageId = inviteMessage?.key?.id || '';
${indent}app.dmRecipientJid = targetPrivateJid;
${indent}app.dmSendRequestedAt = new Date().toISOString();
${indent}app.dmDeliveryState = app.dmMessageId ? 'pending' : 'submitted_without_message_id';
${indent}console.log('[ENTRADA] Envio aceito pelo Baileys para ' + targetPrivateJid + '; ID=' + (app.dmMessageId || 'não retornado') + '. Aguardando confirmação de entrega.');`);

  // 5) Adiciona o consumidor de messages.update ao próprio módulo.
  joinSource += `\n\n// ${marker}\nconst JOIN_DM_STATUS_NAMES = Object.freeze({\n  0: 'error',\n  1: 'pending',\n  2: 'server_ack',\n  3: 'delivered',\n  4: 'read',\n  5: 'played'\n});\nconst JOIN_DM_STATUS_RANK = Object.freeze({ pending: 1, server_ack: 2, delivered: 3, read: 4, played: 5 });\n\nexport function handleJoinMessageUpdates(updates) {\n  const events = Array.isArray(updates) ? updates : [updates];\n  if (!events.length) return 0;\n  const data = loadData();\n  let changed = 0;\n  const now = new Date().toISOString();\n\n  for (const event of events) {\n    const messageId = String(event?.key?.id || '');\n    const statusCode = Number(event?.update?.status);\n    const state = JOIN_DM_STATUS_NAMES[statusCode];\n    if (!messageId || !state) continue;\n\n    const app = Object.values(data.applications || {}).find(item => item.dmMessageId === messageId);\n    if (!app) continue;\n\n    const previousRank = JOIN_DM_STATUS_RANK[app.dmDeliveryState] || 0;\n    const nextRank = JOIN_DM_STATUS_RANK[state] || 0;\n    if (statusCode !== 0 && nextRank < previousRank) continue;\n\n    app.dmDeliveryState = state;\n    app.dmDeliveryStatusCode = statusCode;\n    app.dmDeliveryUpdatedAt = now;\n    if (statusCode === 0) {\n      app.dmDeliveryError = String(event?.update?.message || event?.update?.error || 'O WhatsApp marcou a mensagem como erro.').slice(0, 240);\n    } else if (statusCode >= 3) {\n      app.dmDeliveredAt ||= now;\n      if (statusCode >= 4) app.dmReadAt ||= now;\n    }\n    console.log('[ENTRADA] Status do convite ' + app.code + ': ' + state + ' (ID ' + messageId + ').');\n    changed++;\n  }\n\n  if (changed) saveData(data);\n  return changed;\n}\n`;

  // 6) Atualiza o import do módulo no index.js, sem assumir posição de coluna.
  const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])\.\/codigo\/join-approval\.js\2\s*;?/g;
  const importMatches = [...indexSource.matchAll(importRe)];
  if (importMatches.length !== 1) {
    throw new Error(`Import de codigo/join-approval.js: encontrei ${importMatches.length}, esperava exatamente 1.`);
  }
  if (!importMatches[0][1].includes('handleJoinMessageUpdates')) {
    indexSource = indexSource.replace(importRe, (_whole, names, quote) => {
      const items = names.split(',').map(item => item.trim()).filter(Boolean);
      items.push('handleJoinMessageUpdates');
      return `import { ${items.join(', ')} } from ${quote}./codigo/join-approval.js${quote};`;
    });
  }

  // 7) Escuta os ACKs emitidos pelo Baileys.
  const credsLine = "currentSock.ev.on('creds.update', saveCreds);";
  const credsCount = indexSource.split(credsLine).length - 1;
  if (credsCount !== 1) {
    throw new Error(`Listener creds.update: encontrei ${credsCount}, esperava exatamente 1.`);
  }
  const listener = `${credsLine}\ncurrentSock.ev.on('messages.update', updates => {\n  try {\n    handleJoinMessageUpdates(updates);\n  } catch (error) {\n    console.warn('[ENTRADA] Falha ao registrar confirmação de entrega do convite:', error?.stack || error);\n  }\n});`;
  indexSource = indexSource.replace(credsLine, listener);

  // Verifica invariantes antes de gravar.
  if (joinSource.includes('getPNForLID')) throw new Error('Ainda sobrou uma chamada getPNForLID no módulo.');
  if ((joinSource.match(/app\.dmMessageId = inviteMessage\?\.key\?\.id/g) || []).length !== 2) {
    throw new Error('Não consegui registrar o ID nas duas rotas de envio.');
  }
  if (!indexSource.includes("currentSock.ev.on('messages.update'")) throw new Error('Listener messages.update não foi inserido.');
} catch (error) {
  fail(error?.message || error);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, `backup-lid-delivery-${stamp}`);
const joinTemp = `${joinPath}.lid-delivery-${process.pid}.tmp.js`;
const indexTemp = `${indexPath}.lid-delivery-${process.pid}.tmp.js`;

try {
  fs.writeFileSync(joinTemp, joinSource, 'utf8');
  fs.writeFileSync(indexTemp, indexSource, 'utf8');

  for (const file of [joinTemp, indexTemp]) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(check.stderr || check.stdout || `Falha em node --check: ${file}`);
  }

  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(joinPath, path.join(backupDir, 'join-approval.js'));
  fs.copyFileSync(indexPath, path.join(backupDir, 'index.js'));

  fs.renameSync(joinTemp, joinPath);
  try {
    fs.renameSync(indexTemp, indexPath);
  } catch (error) {
    fs.copyFileSync(path.join(backupDir, 'join-approval.js'), joinPath);
    throw error;
  }

  console.log('\n✅ VACINA INSTALADA E SINTAXE VALIDADA.');
  console.log(`📁 Backup: ${backupDir}`);
  console.log('✅ PN e LID separados; LID permanece como destino válido.');
  console.log('✅ Convites passam a guardar o ID retornado pelo Baileys.');
  console.log('✅ messages.update registra server_ack, delivered, read, played ou error.');
  console.log('ℹ️ Registros antigos não foram reenviados nem apagados.');
  console.log('\nReinicie o bot e faça um novo pedido de entrada de teste.');
} catch (error) {
  for (const temp of [joinTemp, indexTemp]) {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
  console.error('\n❌ Falha ao gravar a vacina:', error?.message || error);
  console.error('Os backups originais foram mantidos; confira a pasta de backup se ela já tiver sido criada.');
  process.exit(1);
}
