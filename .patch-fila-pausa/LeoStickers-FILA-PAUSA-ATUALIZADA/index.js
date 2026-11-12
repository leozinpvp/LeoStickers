import { AsyncLocalStorage } from 'node:async_hooks';
import webpmux from 'node-webpmux';
import 'dotenv/config';
import {
  searchGiphy,
  downloadGiphyResult,
  saveStickerToLibrary,
  listLibrary,
  readLibrarySticker
} from './giphy-library.js';
import { handleSocialCommand } from './social-features.js';
import { AUDIO_COMMANDS, EXTRA_COMMANDS, GAME_COMMANDS, STICKER_COMMANDS } from './extra-features.js';
import {
  BLACKLIST_COMMANDS,
  handleBlacklistCommand,
  handleBlacklistedParticipantUpdate
} from './blacklist-features.js';
import { COMMUNITY_COMMANDS, COUPLE_COMMANDS, handleMutedMessage } from './community-features.js';
import { handleApplicantPrivateMessage, handleGroupJoinRequest, resumeGroupJoinRequests } from './join-approval.js';
import { handleControlPanelMessage, isGroupBotEnabled, shouldIgnoreGroupMessage, shouldIgnoreGroupTimestamp, preapplyGroupControlCommands, recordInboundMessage, recordConnectionUpdate, recordOutboundMessage } from './control-panel.js';
import pino from 'pino';
import fs from 'fs';
import crypto from 'node:crypto';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import readline from 'readline';

const BAILEYS_DIR = path.resolve(
  './node_modules/@whiskeysockets/baileys'
);

function requireOneReplacement(source, regex, replacement, label) {
  const globalRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  );
  const matches = [...source.matchAll(globalRegex)];

  if (matches.length === 0) {
    throw new Error(`Não encontrei o trecho esperado: ${label}`);
  }

  if (matches.length !== 1) {
    throw new Error(
      `Encontrei ${matches.length} ocorrências de ${label}; esperado: 1.`
    );
  }

  return source.replace(regex, replacement);
}

function patchMessagesRecv(source) {
  const marker = 'LEO_STICKERS_PAIRING_STAGE_FIX';
  if (source.includes(marker)) return source;

  const pattern = /(case\s+['"]link_code_companion_reg['"]\s*:\s*\r?\n\s*(?:const|let|var)\s+linkCodeCompanionReg\s*=\s*[^;\r\n]+;)/;

  return requireOneReplacement(
    source,
    pattern,
    `$1
            // ${marker}
            if (!linkCodeCompanionReg || linkCodeCompanionReg.attrs?.stage !== 'primary_hello') break;`,
    'notificação link_code_companion_reg'
  );
}

function patchSocket(source) {
  const stageMarker = 'LEO_STICKERS_PAIRING_HANDSHAKE_FIX';
  const nonceMarker = 'LEO_STICKERS_PAIRING_NONCE_FIX';
  const reconnectMarker = 'LEO_STICKERS_PAIRING_RECONNECT_FIX';

  let result = source;

  if (!result.includes(reconnectMarker)) {
    result = requireOneReplacement(
      result,
      /if\s*\(\s*!creds\.me\s*\)\s*\{/,
      `if (!creds.me || (!!creds.pairingCode && !creds.registered)) { /* ${reconnectMarker} */`,
      'condição de reconexão do pareamento'
    );
  }

  if (!result.includes(nonceMarker)) {
    result = requireOneReplacement(
      result,
      /(tag\s*:\s*['"]link_code_pairing_nonce['"][\s\S]{0,180}?content\s*:\s*)['"]0['"]/
      ,
      `$1Buffer.alloc(1) /* ${nonceMarker} */`,
      'nonce do pareamento numérico'
    );
  }

  if (!result.includes(stageMarker)) {
    result = requireOneReplacement(
      result,
      /noise\.finishInit\(\);/,
      `noise.finishInit();
		ev.emit('connection.update', { connection: 'connecting', handshakeReady: true }); /* ${stageMarker} */`,
      'finalização do handshake'
    );
  }

  return result;
}

function patchValidateConnection(source) {
  const marker = 'LEO_STICKERS_REGISTERED_AFTER_PAIRING';
  if (source.includes(marker)) return source;

  const start = source.indexOf('const authUpdate = {');
  if (start < 0) {
    throw new Error('Não encontrei o objeto authUpdate em validate-connection.js.');
  }

  const end = source.indexOf('return {', start);
  if (end < 0) {
    throw new Error('Não encontrei o final de authUpdate em validate-connection.js.');
  }

  const beforeReturn = source.slice(start, end);
  const platformPattern = /(\bplatform\s*:\s*[^,\r\n}]+)(,?)/;
  const platformMatches = [...beforeReturn.matchAll(
    new RegExp(platformPattern.source, 'g')
  )];

  if (platformMatches.length !== 1) {
    throw new Error('A propriedade platform em authUpdate não é única.');
  }

  const match = platformMatches[0];
  const lineStart = beforeReturn.lastIndexOf('\n', match.index);
  const indentMatch = beforeReturn.slice(lineStart + 1, match.index).match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : '\t\t';
  const replacement = `${match[1]},
${indent}registered: true, // ${marker}`;
  const afterMatch = match.index + match[0].length;
  const patchedBlock =
    beforeReturn.slice(0, match.index) +
    replacement +
    beforeReturn.slice(afterMatch);

  return source.slice(0, start) + patchedBlock + source.slice(end);
}

function applyPairingFix() {
  const packageJsonPath = path.join(BAILEYS_DIR, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('Baileys não encontrado em node_modules.');
  }

  const installed = JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf8')
  );

  if (installed.version !== '6.7.18') {
    throw new Error(
      `Este patch foi preparado para Baileys 6.7.18. Instalado: ${installed.version}. Nenhum arquivo foi alterado.`
    );
  }

  const files = [
    {
      relative: 'lib/Socket/messages-recv.js',
      patch: patchMessagesRecv
    },
    {
      relative: 'lib/Socket/socket.js',
      patch: patchSocket
    },
    {
      relative: 'lib/Utils/validate-connection.js',
      patch: patchValidateConnection
    }
  ];

  const prepared = files.map(item => {
    const fullPath = path.join(BAILEYS_DIR, item.relative);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Arquivo interno não encontrado: ${item.relative}`);
    }

    const original = fs.readFileSync(fullPath, 'utf8');
    const updated = item.patch(original);

    return {
      ...item,
      fullPath,
      original,
      updated,
      changed: original !== updated
    };
  });

  const changed = prepared.filter(item => item.changed);

  if (changed.length === 0) {
    console.log('✅ As correções já estão aplicadas.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(
    `./backup-baileys-pareamento-${stamp}`
  );

  fs.mkdirSync(backupDir, { recursive: true });

  for (const item of changed) {
    const backupPath = path.join(backupDir, item.relative);

    fs.mkdirSync(path.dirname(backupPath), {
      recursive: true
    });

    fs.writeFileSync(backupPath, item.original, 'utf8');
  }

  try {
    for (const item of changed) {
      fs.writeFileSync(item.fullPath, item.updated, 'utf8');
    }

    for (const item of prepared) {
      const check = spawnSync(
        process.execPath,
        ['--check', item.fullPath],
        { encoding: 'utf8' }
      );

      if (check.status !== 0) {
        throw new Error(
          `Falha de sintaxe em ${item.relative}:
${check.stderr || check.stdout || 'Erro desconhecido'}`
        );
      }
    }
  } catch (error) {
    for (const item of changed) {
      fs.writeFileSync(item.fullPath, item.original, 'utf8');
    }

    throw new Error(
      `${error.message}
Os arquivos originais foram restaurados a partir das cópias de segurança.`
    );
  }

  console.log('✅ Correções locais aplicadas ao Baileys 6.7.18.');
  console.log(`📁 Cópias de segurança: ${backupDir}`);
  console.log('✅ Sintaxe dos três arquivos internos verificada.');
}

function menu() {
  // LEO_STICKERS_MENUS_AND_MARK_COMMANDS_V1
  return [
    '╭━━━━━━ 🦊 ━━━━━━╮',
    '     *LÉO STICKERS*',
    '╰━━━━━━━━━━━━━━━━╯',
    '',
    'Escolha uma categoria para ver os comandos:',
    '',
    '🧩 !menufigurinhas — Criar, buscar e organizar figurinhas',
    '🖼️ !menuimagem — Efeitos e edição de imagens',
    '🎲 !menubrincadeiras — 60 brincadeiras, cada uma com GIF próprio',
    '🏆 !menujogos — Jogos, desafios e ranking',
    '🎧 !menuaudio — Converter e editar áudios',
    '👥 !menucomunidade — Casal, convivência e grupo',
    '🛡️ !menuadm — Administração e moderação',
    '👑 !menudono — Ferramentas do proprietário',
    'ℹ️ !menuinfo — Ajuda e informações',
    '',
    '🦊 Desenvolvido por Léo'
  ].join('\n');
}

function menuCategory(command) {
  const list = items => items.map(item => '!' + item).join('  ');
  const gameGroups = [
    ['🎲 SORTE, ESCOLHAS E PALAVRAS', ['8ball','dado','moeda','sorteio','escolher','parouimpar','ppt','numeroaleatorio','embaralhar','anagrama']],
    ['💬 CONVERSA E DESAFIOS', ['rima','frasealeatoria','emoji','roletatemas','quemseria','desculpa','apelido','conselho','piada','perguntaaleatoria','verdade','desafioflash','eununca','quemnunca','confissao']],
    ['✨ PERSONALIDADE E IMAGINAÇÃO', ['testeamor','personalidade','superpoder','profissao','animal','heroi','vilao','elemento','planeta','comida','cor','musica','filme','time','previsao','sorte','azar','quemganha','mancheteabsurda']],
    ['🤹 INTERAÇÕES COM PARTICIPANTES', ['matar','bater','beijar','chutar','abracar','cafune','morder','empurrar','highfive','assustar','proteger','elogiar','zoar','salvar','dancinha','cumprimentar']]
  ];
  const adminCommands = [
    'infogrupo','linkgrupo','novolink','fechargrupo','abrirgrupo',
    'mudarnomegrupo','mudardescgrupo','promover','rebaixar','remover',
    'marcar','totag','marcaradmins','marcarmembros','aprovar','recusar',
    'avisar','avisos','zeraravisos','limparavisos','definirregras','regrasgrupo',
    'entrada','autoaceitar','autoaprovarsolicitacao','criarclausulas','clausulas','solicitacoes','aprovarsolicitacao','recusarsolicitacao',
    'mute','desmute','ban','listanegra','tirarlistanegra'
  ];
  const ownerCommands = ['status','grupos','latencia','painel','reiniciar','backup','restaurar','usuarios','limparcache','logs','bloquear'];
  const imageCommands = [
    'imgcontorno','imgsombra','imgpixel','imgnegativo','imgpb','imgzoom','imgdesfocar',
    'imgespelhar','imggirar','imgbrilho','imgcontraste','imgsaturacao','imgsepia',
    'imgnitidez','imgposter','imgquadrada','imgpaisagem','imgretrato','imgminiatura','imgcompress'
  ];
  const stickerBase = [
    's','fig','sn','sticker','togif','edit','toimg','texto','moldura',
    'buscar','importar','precarregar','random','sequencia','mix','colecao',
    'favorito','favoritos','desfavorito','pack','meupack','exportarpack',
    'packaleatorio','packbuscar','estatisticaspack','removerfig','removerfigrec'
  ];
  const games = gameGroups.map(group => group[0] + '\n' + list(group[1])).join('\n\n');

  switch (command) {
    case 'menuadm':
      return '🛡️ MENU DE ADMINISTRAÇÃO\n\n' + list(adminCommands) +
        '\n\n!marcar mensagem — menciona todos e mostra as marcações' +
        '\n!totag mensagem — menciona todos sem exibir a lista de marcações' +
        '\n\n📨 ENTRADA E APRESENTAÇÃO' +
        '\n!entrada on/off — liga/desliga o atendimento de solicitações no PV (por grupo)' +
        '\n!autoaprovarsolicitacao on/off — autoaprova quando a apresentação estiver correta' +
        '\n(Apelido antigo: !autoaceitar on/off)' +
        '\n!criarclausulas — cria cláusulas para este grupo' +
        '\n!clausulas — lista e edita cláusulas, campos e idade máxima' +
        '\n!solicitacoes — lista pedidos pendentes' +
        '\n!aprovarsolicitacao código / !recusarsolicitacao código' +
        '\n\nAções de moderação exigem que você seja administrador; remoções também exigem que o bot seja administrador.';
    case 'menudono':
      return '👑 MENU DO DONO\n\n' + list(ownerCommands) +
        '\n\nComandos exclusivos ou restritos ao proprietário do Léo Stickers.';
    case 'menubrincadeiras':
      return '🎲 MENU DE BRINCADEIRAS — ' + GAME_COMMANDS.length + ' COMANDOS / GIFS PERSONALIZADOS\n\n' + games +
        '\n\nCada brincadeira tem uma busca de GIF própria e cache separado. Se o GIPHY estiver indisponível, o bot responde em texto.';
    case 'menujogos':
      return '🏆 MENU DE JOGOS E RANKING\n\n' + list(['duelo','desafio','quiz','roleta','top','ranking','desafiofig','votefig','roubarfig','adivinhe','resposta','corridafig']);
    case 'menuaudio':
      return '🎧 MENU DE ÁUDIO\n\n' + list([...AUDIO_COMMANDS]) +
        '\n\nResponda a um áudio ou envie um áudio junto com o comando.';
    case 'menufigurinhas':
      return '🧩 MENU DE FIGURINHAS\n\nCRIAÇÃO, BUSCA E BIBLIOTECA\n' + list(stickerBase) +
        '\n\nFERRAMENTAS EXTRAS\n' + list([...STICKER_COMMANDS]) +
        '\n\nPara efeitos em fotos, use !menuimagem.';
    case 'menuimagem':
      return '🖼️ MENU DE EDIÇÃO DE IMAGENS\n\n' + list(imageCommands) +
        '\n\nEnvie uma imagem junto com o comando ou responda à imagem com o comando.';
    case 'menucomunidade':
      return '👥 MENU DE COMUNIDADE\n\n' + list(['seradm','mute','desmute','unmute','desmutar','ship']) +
        '\n\n💞 CASAL\n' + list(COUPLE_COMMANDS) +
        '\n\nOs pedidos de casamento precisam ser aceitos pela outra pessoa. Os dados são separados por grupo.';
    case 'menucasal':
      return '💞 MENU DE CASAL\n\n' + list(COUPLE_COMMANDS) +
        '\n\nOs pedidos de casamento precisam ser aceitos pela outra pessoa. Os registros são separados por grupo.';
    case 'menuinfo':
      return 'ℹ️ AJUDA E INFORMAÇÕES\n\n' + list(['menu','ajuda','ping','info','stats','setpack','setauthor']);
    default:
      return menu();
  }
}

const config = JSON.parse(
  fs.readFileSync('./config.json', 'utf8')
);

const logger = pino({ level: 'error' });

function formatBrazilTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function appendRestartLog(message) {
  try {
    fs.mkdirSync('./logs', { recursive: true });
    fs.appendFileSync(
      './logs/reinicios.log',
      `[${formatBrazilTimestamp()}] ${message}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn('[LOG DE QUEDAS] Não foi possível gravar o horário:', error?.message || error);
  }
}

let db = fs.existsSync('./database.json')
  ? JSON.parse(fs.readFileSync('./database.json', 'utf8'))
  : { stickers: 0, users: {} };

let sock;
let authState = null;
const pendingStickerPacks = new Map();
const ownerCommandContext = new AsyncLocalStorage();

let reconnecting = false;
let reconnectTimer = null;
const giphySearches = new Map(); 
function equalHash(buffer, expectedBase64) {
  if (!expectedBase64) return false;

  const expected = Buffer.from(expectedBase64, 'base64');
  const actual = crypto.createHash('sha256').update(buffer).digest();

  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

async function downloadWhatsAppStickerPack(pack) {
  if (!pack?.mediaKey || !pack?.directPath) {
    throw new Error('O pacote não contém os dados necessários.');
  }

  const mediaKey = Buffer.from(pack.mediaKey, 'base64');

  if (mediaKey.length !== 32) {
    throw new Error('Chave de mídia inválida.');
  }

  if (!String(pack.directPath).startsWith('/')) {
    throw new Error('Caminho de download inválido.');
  }

  const response = await fetch(
    'https://mmg.whatsapp.net' + pack.directPath,
    {
      headers: {
        Origin: 'https://web.whatsapp.com'
      },
      signal: AbortSignal.timeout(30000)
    }
  );

  if (!response.ok) {
    throw new Error('Falha ao baixar o pacote: HTTP ' + response.status);
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);

  if (declaredSize > 25 * 1024 * 1024) {
    throw new Error('Pacote maior que o limite de 25 MB.');
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  if (!encrypted.length || encrypted.length > 25 * 1024 * 1024) {
    throw new Error('Arquivo vazio ou maior que 25 MB.');
  }

  if (!equalHash(encrypted, pack.fileEncSha256)) {
    throw new Error('SHA-256 do arquivo criptografado não confere.');
  }

  if (encrypted.length < 27) {
    throw new Error('Arquivo criptografado incompleto.');
  }

  const macReceived = encrypted.subarray(-10);
  const ciphertext = encrypted.subarray(0, -10);

  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('Tamanho do conteúdo criptografado inválido.');
  }

  const expanded = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      mediaKey,
      Buffer.alloc(0),
      Buffer.from('WhatsApp Sticker Pack Keys'),
      112
    )
  );

  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const expectedMac = crypto
    .createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .subarray(0, 10);

  if (
    macReceived.length !== expectedMac.length ||
    !crypto.timingSafeEqual(macReceived, expectedMac)
  ) {
    throw new Error('MAC inválido. O pacote não será importado.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    cipherKey,
    iv
  );

  const archive = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  if (!equalHash(archive, pack.fileSha256)) {
    throw new Error('SHA-256 do pacote descriptografado não confere.');
  }

  return archive;
}

async function importWhatsAppStickerPack(pack) {
  const stickers = pack.stickers;

  if (!Array.isArray(stickers) || stickers.length === 0) {
    throw new Error('O pacote não possui figurinhas.');
  }

  if (stickers.length > 100) {
    throw new Error('O pacote ultrapassa o limite de 100 figurinhas.');
  }

  const archive = await downloadWhatsAppStickerPack(pack);

  const cacheDir = path.resolve('./figurinhas/cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const tempDir = fs.mkdtempSync(
    path.join(cacheDir, 'whatsapp-pack-')
  );

  const zipPath = path.join(tempDir, 'pacote.zip');

  let imported = 0;
  let duplicates = 0;
  let failed = 0;

  try {
    fs.writeFileSync(zipPath, archive);

    const test = spawnSync(
      'unzip',
      ['-tqq', zipPath],
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024
      }
    );

    if (test.error || test.status !== 0) {
      throw new Error('O arquivo recebido não passou na validação ZIP.');
    }

    const listing = spawnSync(
      'unzip',
      ['-Z1', zipPath],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    if (listing.error || listing.status !== 0) {
      throw new Error('Não foi possível listar as figurinhas do pacote.');
    }

    const entries = listing.stdout
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean);

    const usedEntries = new Set();

    for (const sticker of stickers) {
      try {
        const filename = String(sticker.fileName || '');

        if (
          !/^[A-Za-z0-9._+=-]+\.webp$/i.test(filename)
        ) {
          throw new Error('Nome de arquivo inválido.');
        }

        const entry = entries.find(item => {
          if (usedEntries.has(item)) return false;

          if (item.split('/').includes('..')) return false;

          return path.posix.basename(item) === filename;
        });

        if (!entry) {
          throw new Error('Arquivo não encontrado no pacote.');
        }

        usedEntries.add(entry);

        const extracted = spawnSync(
          'unzip',
          ['-p', zipPath, entry],
          {
            encoding: null,
            timeout: 15000,
            maxBuffer: 2 * 1024 * 1024
          }
        );

        if (extracted.error || extracted.status !== 0) {
          throw new Error('Falha ao extrair o arquivo.');
        }

        const buffer = extracted.stdout;

        if (
          !Buffer.isBuffer(buffer) ||
          buffer.length > 1024 * 1024
        ) {
          throw new Error('Figurinha vazia ou maior que 1 MB.');
        }

        const saved = saveStickerToLibrary(buffer, {
          source: 'WhatsApp',
          title: pack.name || 'Pacote WhatsApp'
        });

        if (saved.duplicate) duplicates++;
        else imported++;

      } catch (error) {
        failed++;
        console.error(
          '[PACOTE WHATSAPP] Falha em uma figurinha:',
          error.message
        );
      }
    }

    return {
      total: stickers.length,
      imported,
      duplicates,
      failed,
      name: pack.name || 'Pacote WhatsApp'
    };

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// LEO_GIPHY_INTEGRATION

function saveDB() {
  fs.writeFileSync(
    './database.json',
    JSON.stringify(db, null, 2)
  );
}

function getNumber(jid = '') {
  return jid.split('@')[0].split(':')[0];
}

function normalizeOwnerJid(jid) {
  const value = String(jid || '').toLowerCase();
  const at = value.lastIndexOf('@');

  if (at === -1) return value.split(':')[0];

  const user = value.slice(0, at).split(':')[0];
  const domain = value.slice(at);

  return user + domain;
}

function isOwner(jid) {
  const ownerPhone = String(config.ownerNumber || '').replace(/\D/g, '');
  const normalizedJid = normalizeOwnerJid(jid);
  const ownerLid = normalizeOwnerJid(authState?.creds?.me?.lid);

  const additionalOwnerLids = Array.isArray(config.ownerLids)
    ? config.ownerLids.map(normalizeOwnerJid).filter(Boolean)
    : [];

  const matchesPhone = Boolean(ownerPhone && getNumber(jid) === ownerPhone);
  const matchesLid = Boolean(ownerLid && normalizedJid === ownerLid);
  const matchesAdditionalLid = additionalOwnerLids.includes(normalizedJid);

  return matchesPhone || matchesLid || matchesAdditionalLid;
}

function unwrap(message) {
  let current = message || {};
  for (let i = 0; i < 12 && current; i++) {
    const wrapped =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.deviceSentMessage?.message ||
      current.editedMessage?.message ||
      current.messageContextInfo?.message;
    if (!wrapped) break;
    current = wrapped;
  }
  return current || {};
}

function getText(msg) {
  const message = unwrap(msg.message);

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  ).trim();
}

function findMedia(msg) {
  const current = unwrap(msg.message);

  const types = [
    'imageMessage',
    'videoMessage',
    'stickerMessage',
    'audioMessage'
  ];

  const type = types.find(item => current[item]);

  if (type) {
    return {
      key: msg.key,
      message: msg.message,
      content: current,
      type
    };
  }

  const context =
    current.extendedTextMessage?.contextInfo;

  if (!context?.quotedMessage) return null;

  const quoted = unwrap(context.quotedMessage);
  const quotedType = types.find(item => quoted[item]);

  if (!quotedType) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: context.stanzaId,
      participant: context.participant,
      fromMe: false
    },
    message: context.quotedMessage,
    content: quoted,
    type: quotedType
  };
}

async function getMedia(target) {
  if (!target?.message || !target?.key) {
    throw new Error('Alvo de mídia sem mensagem ou chave.');
  }

  // Primeiro tenta o download direto do conteúdo de áudio.
  if (target.type === 'audioMessage' && downloadContentFromMessage) {
    try {
      const content = target.content || unwrap(target.message);
      const audio = content?.audioMessage;
      if (!audio) throw new Error('audioMessage não encontrado no alvo.');

      const stream = await downloadContentFromMessage(audio, 'audio');
      const chunks = [];
      let total = 0;
      for await (const chunk of stream) {
        const part = Buffer.from(chunk);
        total += part.length;
        if (total > 25 * 1024 * 1024) throw new Error('Áudio excede 25 MB.');
        chunks.push(part);
      }
      const buffer = Buffer.concat(chunks);
      console.log(`[ÁUDIO] Download direto: ${buffer.length} bytes; mimetype=${audio.mimetype || 'n/d'}; ptt=${Boolean(audio.ptt)}`);
      if (buffer.length) return buffer;
      console.error('[ÁUDIO] Download direto retornou zero bytes; tentando método alternativo.');
    } catch (error) {
      console.error('[ÁUDIO] Falha no download direto:', error?.stack || error);
    }
  }

  // Fallback compatível com o downloader padrão do Baileys.
  try {
    const buffer = await downloadMediaMessage(
      { key: target.key, message: target.message },
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    console.log(`[ÁUDIO] Download alternativo: ${buffer?.length || 0} bytes.`);
    if (buffer?.length) return buffer;
  } catch (error) {
    console.error('[ÁUDIO] Falha no download alternativo:', error?.stack || error);
    throw new Error(`Falha ao baixar mídia pelo Baileys: ${error?.message || error}`);
  }

  throw new Error('Os dois métodos de download retornaram zero bytes. Verifique a mensagem original e a conexão do WhatsApp.');
}


const AUTO_SAVE_FILE = './autosave.json';

function readAutoSaveConfig() {
  try {
    if (!fs.existsSync(AUTO_SAVE_FILE)) {
      fs.writeFileSync(
        AUTO_SAVE_FILE,
        JSON.stringify({ enabled: true, groups: {} }, null, 2)
      );
    }

    const data = JSON.parse(fs.readFileSync(AUTO_SAVE_FILE, 'utf8'));

    return {
      enabled: data.enabled !== false,
      groups: data.groups && typeof data.groups === 'object'
        ? data.groups
        : {}
    };
  } catch (error) {
    console.error('Erro ao ler configuração automática:', error.message);
    return { enabled: false, groups: {} };
  }
}

function getAutoSaveState(jid = '') {
  const data = readAutoSaveConfig();

  if (
    jid.endsWith('@g.us') &&
    typeof data.groups[jid] === 'boolean'
  ) {
    return data.groups[jid];
  }

  return data.enabled;
}

function setAutoSaveState(enabled, jid = '') {
  const data = readAutoSaveConfig();

  if (jid.endsWith('@g.us')) {
    data.groups[jid] = Boolean(enabled);
  } else {
    data.enabled = Boolean(enabled);
  }

  fs.writeFileSync(
    AUTO_SAVE_FILE,
    JSON.stringify(data, null, 2)
  );
}

async function applyLibraryStickerMetadata(sticker) {
  const metadata = {
    'sticker-pack-id': 'leo.stickers',
    'sticker-pack-name': 'O melhor bot de figurinhas',
    'sticker-pack-publisher': 'Léo Stickers 🦊',
    'emojis': ['']
  };

  const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');

  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);

  exifHeader.writeUInt32LE(jsonBuffer.length, 14);

  const image = new webpmux.Image();
  await image.load(sticker);
  image.exif = Buffer.concat([exifHeader, jsonBuffer]);

  const tempPath = path.resolve(
    `./sticker-metadata-${process.pid}-${Date.now()}.webp`
  );

  try {
    await image.save(tempPath);
    return fs.readFileSync(tempPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

async function autoSaveIncomingSticker(msg) {
  try {
    // O estado será consultado depois de identificar o grupo.
    if (!msg?.message || msg.key?.fromMe) return;

    const jid = msg.key?.remoteJid;

    if (!jid || jid === 'status@broadcast') return;

    if (!getAutoSaveState(jid)) return;

    // Não coleta mensagens de visualização única.
    if (isViewOnceMessage(msg.message)) return;

    const content = unwrap(msg.message);

    // Coleta somente figurinhas enviadas diretamente.
    if (!content?.stickerMessage) return;

    const buffer = await getMedia({
      key: msg.key,
      message: msg.message
    });

    const personalizedBuffer = await applyLibraryStickerMetadata(buffer);

    const saved = saveStickerToLibrary(personalizedBuffer, {
      source: 'WhatsApp',
      title: 'Figurinha recebida'
    });

    if (saved.duplicate) {
      console.log('🦊 Figurinha repetida: ignorada.');
    } else {
      console.log(
        `🦊 Figurinha salva! Total na biblioteca: ${listLibrary().length}`
      );
    }
  } catch (error) {
    console.error(
      'Erro ao salvar figurinha automaticamente:',
      error.message
    );
  }
}

function runFFmpeg(buffer, args) {
  return new Promise((resolve, reject) => {
    const processFFmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      ...args,
      'pipe:1'
    ]);

    const output = [];
    const errors = [];

    processFFmpeg.stdout.on('data', chunk => output.push(chunk));
    processFFmpeg.stderr.on('data', chunk => errors.push(chunk));
    processFFmpeg.on('error', reject);

    processFFmpeg.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(errors).toString() || 'Erro no FFmpeg.'
          )
        );
      } else {
        resolve(Buffer.concat(output));
      }
    });

    processFFmpeg.stdin.on('error', () => {});
    processFFmpeg.stdin.end(buffer);
  });
}

async function createSticker(target, withoutMetadata = false) {
  const buffer = await getMedia(target);

  if (buffer.length > config.maxMediaMB * 1024 * 1024) {
    throw new Error('Arquivo muito grande.');
  }

  if (target.type === 'videoMessage') {
    const duration = target.content.videoMessage?.seconds || 0;

    if (duration > config.maxVideoSeconds) {
      throw new Error('Vídeo ultrapassa o limite de duração.');
    }
  }

  const sticker = await runFFmpeg(buffer, [
    '-frames:v', '1',
    '-vf', 'scale=512:512',
    '-an',
    '-c:v', 'libwebp',
    '-quality', String(config.quality),
    '-f', 'webp'
  ]);

  let finalSticker = sticker;

  if (!withoutMetadata) {
    const metadata = {
      'sticker-pack-id': 'leo.stickers',
      'sticker-pack-name': config.packName || 'Léo Stickers',
      'sticker-pack-publisher': config.authorName || 'Léo',
      'emojis': ['']
    };
  
    const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  
    const exifHeader = Buffer.from([
      0x49, 0x49, 0x2A, 0x00,
      0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00,
      0x00, 0x00
    ]);
  
    exifHeader.writeUInt32LE(jsonBuffer.length, 14);
  
    const exif = Buffer.concat([exifHeader, jsonBuffer]);
  
    const image = new webpmux.Image();
    await image.load(sticker);
    image.exif = exif;
  
    const tempPath = path.resolve(
      `./sticker-temp-${process.pid}-${Date.now()}.webp`
    );
  
    try {
      await image.save(tempPath);
      finalSticker = fs.readFileSync(tempPath);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  
  
  }

  if (finalSticker.length > 1024 * 1024) {
    throw new Error('Figurinha maior que 1 MB.');
  }

  await sock.sendMessage(target.key.remoteJid, {
    sticker: finalSticker,
    mimetype: 'image/webp'
  });

  db.stickers++;

  const user = getNumber(target.key.remoteJid);
  db.users[user] = (db.users[user] || 0) + 1;

  saveDB();
}


function makeStickerExif(packName, authorName) {
  const metadata = {
    'sticker-pack-id': 'leo.stickers',
    'sticker-pack-name': packName,
    'sticker-pack-publisher': authorName,
    'emojis': ['']
  };

  const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');

  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00
  ]);

  exifHeader.writeUInt32LE(jsonBuffer.length, 14);
  return Buffer.concat([exifHeader, jsonBuffer]);
}

async function createGif(target, jid, msg) {
  if (!target || target.type !== 'stickerMessage') {
    throw new Error('Responda a uma figurinha animada com !togif.');
  }

  const buffer = await getMedia(target);

  if (buffer.length > config.maxMediaMB * 1024 * 1024) {
    throw new Error('Figurinha muito grande.');
  }

  const animated =
    buffer.includes(Buffer.from('ANIM')) ||
    buffer.includes(Buffer.from('ANMF'));

  if (!animated) {
    throw new Error('Essa figurinha não é animada.');
  }

  const mp4 = await runFFmpeg(buffer, [
    '-an',
    '-vf', 'fps=15,scale=480:-2:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '25',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4'
  ]);

  if (!mp4.length) {
    throw new Error('Não foi possível converter a figurinha.');
  }

  await sock.sendMessage(
    jid,
    {
      video: mp4,
      mimetype: 'video/mp4',
      gifPlayback: true
    },
    { quoted: msg }
  );
}

async function editSticker(target, jid, msg, packName, authorName) {
  if (!target || target.type !== 'stickerMessage') {
    throw new Error('Responda a uma figurinha com !edit.');
  }

  const buffer = await getMedia(target);
  const image = new webpmux.Image();

  await image.load(buffer);

  image.exif = makeStickerExif(packName, authorName);

  const tempPath = path.resolve(
    `./sticker-edit-${process.pid}-${Date.now()}.webp`
  );

  try {
    await image.save(tempPath);

    const editedSticker = fs.readFileSync(tempPath);

    if (editedSticker.length > 1024 * 1024) {
      throw new Error('Figurinha editada maior que 1 MB.');
    }

    await sock.sendMessage(
      jid,
      {
        sticker: editedSticker,
        mimetype: 'image/webp'
      },
      { quoted: msg }
    );
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

async function stickerToImage(target, jid, msg) {
  if (target.type !== 'stickerMessage') {
    throw new Error('Responda a uma figurinha.');
  }

  const buffer = await getMedia(target);

  const png = await runFFmpeg(buffer, [
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-vcodec',
    'png'
  ]);

  await sock.sendMessage(
    jid,
    {
      image: png,
      caption: '🖼️ Imagem convertida!'
    },
    { quoted: msg }
  );
}

async function send(jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text },
    { quoted }
  );
}





// LEO_GIPHY_INTEGRATION
async function prepareExternalSticker(buffer) {
  const isWebP =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP';

  if (isWebP) return buffer;

  return runFFmpeg(buffer, [
    '-frames:v', '1',
    '-vf',
    'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-an',
    '-c:v', 'libwebp',
    '-quality', String(config.quality),
    '-f', 'webp'
  ]);
}

async function importGiphyResult(result) {
  const original = await downloadGiphyResult(result);
  const sticker = await prepareExternalSticker(original);

  return saveStickerToLibrary(sticker, {
    source: 'GIPHY',
    title: result.title,
    giphyId: result.id,
    pageUrl: result.pageUrl
  });
}


/* LEO_NEW_STICKER_COMMANDS */

function shuffleStickers(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

async function createFig(target, jid, msg) {
  if (!target || target.type !== 'imageMessage') {
    throw new Error('Envie uma foto com !fig ou responda a uma foto com !fig.');
  }

  const buffer = await getMedia(target);

  if (buffer.length > config.maxMediaMB * 1024 * 1024) {
    throw new Error('Imagem muito grande.');
  }

  const sticker = await runFFmpeg(buffer, [
    '-frames:v', '1',
    '-vf',
    'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p',
    '-an',
    '-c:v', 'libwebp',
    '-quality', String(config.quality),
    '-f', 'webp'
  ]);

  const image = new webpmux.Image();
  await image.load(sticker);

  image.exif = makeStickerExif(
    config.packName || 'Léo Stickers',
    config.authorName || 'Léo'
  );

  const tempPath = path.resolve(
    './fig-temp-' + process.pid + '-' + Date.now() + '.webp'
  );

  try {
    await image.save(tempPath);
    const finalSticker = fs.readFileSync(tempPath);

    if (finalSticker.length > 1024 * 1024) {
      throw new Error('Figurinha maior que 1 MB.');
    }

    await sock.sendMessage(
      jid,
      { sticker: finalSticker, mimetype: 'image/webp' },
      { quoted: msg }
    );

    db.stickers++;
    const user = getNumber(jid);
    db.users[user] = (db.users[user] || 0) + 1;
    saveDB();
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}


/* LEO_COMMUNITY_DUEL_V1 */

const activeStickerDuels = new Map();

async function sendStickerDuel(jid, msg) {
  if (activeStickerDuels.has(jid)) {
    await send(jid, '⚔️ Já existe um duelo aberto neste chat!', msg);
    return;
  }

  const session = {
    phase: 'collecting',
    candidates: [],
    nominators: new Set(),
    votes: new Map(),
    timer: null
  };

  activeStickerDuels.set(jid, session);

  await send(
    jid,
    '🏆 DUELO DE FIGURINHAS ABERTO!\n\n' +
    'Qualquer participante pode indicar uma figurinha.\n\n' +
    '📩 Responda a uma figurinha com !escolher\n' +
    '👥 Cada pessoa pode indicar uma figurinha.\n' +
    '🥇 As duas primeiras indicações diferentes formam o duelo.',
    msg
  );
}

async function nominateDuelSticker(jid, msg) {
  const session = activeStickerDuels.get(jid);

  if (!session || session.phase !== 'collecting') {
    await send(jid, 'Não existe uma seleção de duelo aberta.', msg);
    return;
  }

  const target = findMedia(msg);

  if (!target || target.type !== 'stickerMessage') {
    await send(
      jid,
      '📩 Responda diretamente a uma figurinha com !escolher.',
      msg
    );
    return;
  }

  const participant = msg.key.participant || msg.key.remoteJid;

  if (session.nominators.has(participant)) {
    await send(jid, 'Você já indicou uma figurinha neste duelo.', msg);
    return;
  }

  try {
    const buffer = await getMedia(target);

    const duplicate = session.candidates.some(
      item => item.buffer.equals(buffer)
    );

    if (duplicate) {
      await send(jid, 'Essa figurinha já foi indicada!', msg);
      return;
    }

    session.nominators.add(participant);

    session.candidates.push({
      buffer,
      name: msg.pushName || 'Participante'
    });

    const number = session.candidates.length;

    await send(
      jid,
      '✅ Figurinha ' + number + ' selecionada por ' +
      (msg.pushName || 'Participante') + '!',
      msg
    );

    if (session.candidates.length < 2) {
      await send(jid, 'Falta mais uma indicação para começar o duelo!');
      return;
    }

    session.phase = 'voting';

    await sock.sendMessage(
      jid,
      {
        sticker: session.candidates[0].buffer,
        mimetype: 'image/webp'
      }
    );

    await send(jid, '🥊 FIGURINHA 1 — ' + session.candidates[0].name);

    await sock.sendMessage(
      jid,
      {
        sticker: session.candidates[1].buffer,
        mimetype: 'image/webp'
      }
    );

    await send(jid, '🥊 FIGURINHA 2 — ' + session.candidates[1].name);

    await send(
      jid,
      '🗳️ VOTAÇÃO ABERTA POR 2 MINUTOS!\n\n' +
      'Para votar na primeira: !votar 1\n' +
      'Para votar na segunda: !votar 2\n\n' +
      'Cada participante tem um voto e pode mudar sua escolha durante a votação.'
    );

    session.timer = setTimeout(() => {
      finishStickerDuel(jid, session).catch(error => {
        console.error('Erro ao finalizar duelo:', error);
      });
    }, 120000);

  } catch (error) {
    console.error('Erro na indicação:', error);
    await send(jid, '❌ Não consegui processar essa figurinha.', msg);
  }
}

async function voteStickerDuel(jid, msg, value) {
  const session = activeStickerDuels.get(jid);

  if (!session || session.phase !== 'voting') {
    await send(jid, 'Não existe votação aberta neste chat.', msg);
    return;
  }

  const choice = value.trim();

  if (choice !== '1' && choice !== '2') {
    await send(jid, 'Use !votar 1 ou !votar 2.', msg);
    return;
  }

  const participant = msg.key.participant || msg.key.remoteJid;

  const previous = session.votes.get(participant);

  session.votes.set(participant, Number(choice));

  await send(
    jid,
    previous
      ? '🔄 Seu voto foi atualizado para a figurinha ' + choice + '.'
      : '✅ Voto registrado na figurinha ' + choice + '!',
    msg
  );
}

async function finishStickerDuel(jid, session) {
  if (activeStickerDuels.get(jid) !== session) return;
  if (session.phase !== 'voting') return;

  session.phase = 'finished';

  if (session.timer) clearTimeout(session.timer);

  let first = 0;
  let second = 0;

  for (const vote of session.votes.values()) {
    if (vote === 1) first++;
    if (vote === 2) second++;
  }

  let result;

  if (first > second) {
    result = '🏆 FIGURINHA 1 VENCEU!';
  } else if (second > first) {
    result = '🏆 FIGURINHA 2 VENCEU!';
  } else {
    result = '🤝 EMPATE!';
  }

  activeStickerDuels.delete(jid);

  await send(
    jid,
    '🏁 RESULTADO DO DUELO\n\n' +
    result + '\n\n' +
    '🥇 Figurinha 1: ' + first + ' votos\n' +
    '🥈 Figurinha 2: ' + second + ' votos\n' +
    '👥 Total de votos: ' + (first + second) + '\n\n' +
    '⏱️ Apuração encerrada após 2 minutos.'
  );
}

async function sendStickerSequence(jid, msg, theme) {
  if (!theme || theme.length > 50) {
    await send(jid, 'Uso: !sequencia gatos', msg);
    return;
  }

  await send(jid, '🔎 Preparando uma sequência sobre: ' + theme, msg);

  const results = await searchGiphy(theme);
  const selected = results.slice(0, 5);

  if (!selected.length) {
    await send(jid, 'Não encontrei figurinhas para esse tema.', msg);
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const item of selected) {
    try {
      const buffer = await downloadGiphyResult(item);
      const sticker = await prepareExternalSticker(buffer);

      await sock.sendMessage(
        jid,
        { sticker, mimetype: 'image/webp' },
        { quoted: msg }
      );

      sent++;
    } catch (error) {
      failed++;
      console.error('Erro na sequência:', error.message);
    }
  }

  await send(
    jid,
    '🎞️ SEQUÊNCIA CONCLUÍDA\n\nTema: ' + theme +
    '\nEnviadas: ' + sent +
    '\nFalhas: ' + failed,
    msg
  );
}

async function sendStickerMix(jid, msg, value) {
  let count = value ? Number(value) : 10;

  if (!Number.isInteger(count) || count < 1 || count > 20) {
    await send(jid, 'Use !mix ou !mix de 1 a 20.', msg);
    return;
  }

  const items = shuffleStickers(listLibrary());

  if (!items.length) {
    await send(jid, '📚 Biblioteca vazia. Use !buscar para encontrar figurinhas.', msg);
    return;
  }

  const selected = items.slice(0, count);

  await send(
    jid,
    '🎲 Preparando seu MIX com ' + selected.length + ' figurinhas!',
    msg
  );

  let sent = 0;

  for (const item of selected) {
    try {
      const sticker = readLibrarySticker(item.filename);

      await sock.sendMessage(
        jid,
        { sticker, mimetype: 'image/webp' },
        { quoted: msg }
      );

      sent++;
    } catch (error) {
      console.error('Erro no MIX:', error.message);
    }
  }

  await send(
    jid,
    '🦊 MIX concluído!\nFigurinhas enviadas: ' + sent,
    msg
  );
}

/* FIM LEO_NEW_STICKER_COMMANDS */

async function sendRandomStickers(jid, msg, value) {
  let count = 1;
  let filter = 'all';

  if (value.toLowerCase() === 'animada') {
    filter = 'animated';
  } else if (value.toLowerCase() === 'estatica') {
    filter = 'static';
  } else if (value) {
    count = Number(value);

    if (!Number.isInteger(count) || count < 1 || count > 5) {
      throw new Error('Use !random ou !random de 1 a 5.');
    }
  }

  const items = listLibrary().filter(item => {
    if (filter === 'animated') return item.animated;
    if (filter === 'static') return !item.animated;
    return true;
  });

  if (!items.length) {
    await send(jid, '📚 A biblioteca está vazia. Use !buscar termo.', msg);
    return;
  }

  const shuffled = [...items].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, items.length));

  for (const item of selected) {
    const sticker = readLibrarySticker(item.filename);

    await sock.sendMessage(
      jid,
      { sticker, mimetype: 'image/webp' },
      { quoted: msg }
    );
  }
}

function isViewOnceMessage(message) {
  const found = [];
  const visited = new WeakSet();

  function inspect(value, path = 'message', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 15) return;
    if (visited.has(value)) return;
    visited.add(value);

    for (const key of Object.keys(value)) {
      const currentPath = path + '.' + key;

      if (/view.?once|ephemeral|quotedMessage/i.test(key)) {
        found.push(currentPath);
      }

      inspect(value[key], currentPath, depth + 1);
    }
  }

  inspect(message);

  console.log('🔍 ESTRUTURA DO !reveal');
  console.log('Chaves principais:', Object.keys(message || {}));
  console.log('Marcadores encontrados:', found.length ? found : 'Nenhum');

  return found.some(path => /view.?once/i.test(path));
}

function isViewOnceTarget(msg) {
  return isViewOnceMessage(msg.message);
}


function logIncomingMessage(msg, jid, text) {
  try {
    const content = unwrap(msg.message);
    const typeKey = Object.keys(content).find(key =>
      key === 'conversation' || key.endsWith('Message')
    ) || 'unknown';

    const types = {
      conversation: 'Texto',
      extendedTextMessage: 'Texto',
      imageMessage: 'Imagem',
      videoMessage: 'Vídeo',
      audioMessage: 'Áudio',
      stickerMessage: 'Figurinha',
      documentMessage: 'Documento',
      contactMessage: 'Contato',
      locationMessage: 'Localização',
      reactionMessage: 'Reação',
      pollCreationMessage: 'Enquete'
    };

    const type = types[typeKey] || typeKey;
    const sender = String(msg.pushName || 'Desconhecido')
      .replace(/[\r\n]/g, ' ');

    const chat = jid.endsWith('@g.us')
      ? `Grupo (${jid})`
      : 'Privado';

    const contentText = String(text || '').trim()
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 5000) || `[${type}]`;

    const time = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    });

    fs.mkdirSync('./logs', { recursive: true });

    fs.appendFileSync(
      './logs/bot.log',
      `[${time}] REMETENTE: ${sender} | LOCAL: ${chat} | TIPO: ${type} | CONTEÚDO: ${contentText}\n`,
      'utf8'
    );
  } catch (error) {
    console.error('Erro no monitor:', error.message);
  }
}

async function handleCommand(msg) {
  if (!msg.message) return;

  const jid = msg.key.remoteJid;
  if (jid?.endsWith('@g.us') && shouldIgnoreGroupMessage(jid, msg)) {
    console.log('[CONTROLE] Mensagem descartada na entrada do comando: enviada durante a pausa do grupo.');
    return;
  }
  const senderJid = msg.key.fromMe
    ? (authState?.creds?.me?.lid || authState?.creds?.me?.id || msg.key.participant || jid)
    : (msg.key.participant || jid);

  if (!jid || jid === 'status@broadcast') return;

  const text = getText(msg);

  // LEO_OWNER_FROM_ME_COMMAND_FIX
  // Aceita somente comandos enviados pelo próprio número dono.
  // Outras mensagens próprias continuam bloqueadas para evitar loops.
  if (
    msg.key.fromMe &&
    (!text.startsWith(config.prefix) || !isOwner(senderJid))
  ) return;

  const isGroup = jid.endsWith('@g.us');

  // Registra mensagens privadas e comandos em grupos.
  if (!isGroup || text.startsWith(config.prefix)) {
    logIncomingMessage(msg, jid, text);
  }

  if (!text.startsWith(config.prefix)) return;
  if (config.privateMode && !isOwner(senderJid)) return;

  const parts = text
    .slice(config.prefix.length)
    .trim()
    .split(/\s+/);

  const rawCommand = (parts.shift() || '').toLowerCase();
  const command = rawCommand === 'gif' ? 'togif' : rawCommand;
  const value = parts.join(' ');

  try {
    
    const SOCIAL_COMMANDS = new Set([
      ...COMMUNITY_COMMANDS,
      'favorito', 'favoritos', 'desfavorito',
      'top', 'ranking', 'pack', 'desafio',
      'quiz', 'roleta', 'texto', 'moldura',
      'marcar', 'totag', 'ban', 'bloquear', 'removerfig', 'removerfigrec', 'relatorio', 'recortar', 'meme', 'circulo', 'espelhar', 'inverter', 'desenhar', 'meupack', 'exportarpack', 'packaleatorio', 'packbuscar', 'estatisticaspack', 'painel', 'reiniciar', 'backup', 'restaurar', 'usuarios', 'limparcache', 'logs',
      'figparecida', 'figsemelhantes', 'figdupla', 'figdodia', 'topfig', 'figantiga', 'fignova',
      'contorno', 'sombra', 'pixel', 'negativo', 'pretoebranco', 'recortar', 'zoom', 'desfocar',
      'criarcolecao', 'adicionarcolecao', 'minhascolecoes', 'exportarcolecao', 'mesclarcolecoes',
      'duplicadas', 'pacotesrecentes', 'exportarbiblioteca', 'relatoriocompleto',
      'manutencao', 'anuncio', 'bloqueargrupo', 'desbloqueargrupo', 'reiniciargrupo',
      'desafiofig', 'votefig', 'roubarfig', 'adivinhe', 'resposta', 'corridafig',
      'infogrupo', 'linkgrupo', 'novolink', 'fechargrupo', 'abrirgrupo',
      'mudarnomegrupo', 'mudardescgrupo', 'promover', 'rebaixar', 'remover',
      'marcaradmins', 'marcarmembros', 'aprovar', 'recusar', 'avisar', 'avisos',
      'zeraravisos', 'definirregras', 'regrasgrupo', 'limparavisos',
      'entrada', 'autoaceitar', 'autoaprovarsolicitacao', 'criarclausulas', 'clausulas', 'solicitacoes', 'aprovarsolicitacao', 'recusarsolicitacao',
      'imgcontorno', 'imgsombra', 'imgpixel', 'imgnegativo', 'imgpb', 'imgzoom', 'imgdesfocar', 'imgespelhar', 'imggirar', 'imgbrilho', 'imgcontraste', 'imgsaturacao', 'imgsepia', 'imgnitidez', 'imgposter', 'imgquadrada', 'imgpaisagem', 'imgretrato', 'imgminiatura', 'imgcompress', 'stcontorno', 'stsombra', 'stpixel', 'stnegativo', 'stpb', 'stzoom', 'stdesfocar', 'stespelhar', 'stgirar', 'stbrilho', 'stcontraste', 'stsaturacao', 'stsepia', 'stnitidez', 'stposter', 'stquadrada', 'stvertical', 'sthorizontal', 'stmini', 'stmaxi',
      ...EXTRA_COMMANDS,
      ...BLACKLIST_COMMANDS
    ]);

    if (SOCIAL_COMMANDS.has(command)) {
      const sender = senderJid;

      const context = {
        sock,
        msg,
        jid,
        sender,
        command,
        value,
        ownerNumber: config.ownerNumber,
        isOwner,
        items: listLibrary(),
        target: findMedia(msg),
        getMedia,
        readLibrarySticker: item =>
          readLibrarySticker(
            typeof item === 'string' ? item : item?.filename
          ),
        saveStickerToLibrary,
        send: (to, message, quoted, options = {}) =>
          sock.sendMessage(
            to,
            { text: message, ...options },
            { quoted }
          )
      };

      if (BLACKLIST_COMMANDS.includes(command)) {
        await handleBlacklistCommand(context);
      } else {
        await handleSocialCommand(context);
      }
      return;
    }

switch (command) {
      case 'aceitarpack': {
        const senderJid = msg.key.fromMe
          ? (authState?.creds?.me?.id || msg.key.participant || jid)
          : (msg.key.participant || jid);


        if (!isOwner(senderJid)) {
          await send(jid, '❌ Somente o dono pode importar pacotes.', msg);
          break;
        }

        const pending = pendingStickerPacks.get(jid);

        if (!pending) {
          await send(
            jid,
            '❌ Nenhum pacote pendente neste chat. Primeiro envie ou encaminhe um pacote de figurinhas.',
            msg
          );
          break;
        }

        if (Date.now() - pending.receivedAt > 10 * 60 * 1000) {
          pendingStickerPacks.delete(jid);
          await send(jid, '⌛ Esse pacote expirou. Encaminhe-o novamente.', msg);
          break;
        }

        await send(
          jid,
          '📦 Recebi o pacote "' +
            (pending.pack.name || 'Sem nome') +
            '". Iniciando validação e importação...',
          msg
        );

        const result = await importWhatsAppStickerPack(pending.pack);

        pendingStickerPacks.delete(jid);

        await send(
          jid,
          '📚 PACOTE IMPORTADO\\n\\n' +
            'Nome: ' + result.name + '\\n' +
            'Total: ' + result.total + '\\n' +
            'Novas: ' + result.imported + '\\n' +
            'Duplicadas: ' + result.duplicates + '\\n' +
            'Falhas: ' + result.failed + '\\n\\n' +
            '🦊 Biblioteca Léo Stickers',
          msg
        );

        break;
      }

      case 'menu':
      case 'ajuda':
        await send(jid, menu(), msg);
        break;

      case 'menuadm':
      case 'menudono':
      case 'menubrincadeiras':
      case 'menujogos':
      case 'menuaudio':
      case 'menufigurinhas':
      case 'menuimagem':
      case 'menucomunidade':
      case 'menucasal':
      case 'menuinfo':
        await send(jid, menuCategory(command), msg);
        break;

      case 'latencia':
      case 'latência': {
        const started = Date.now();
        try {
          const marker = await sock.sendMessage(jid, { text: '🏓 Medindo latência local…' }, { quoted: msg });
          const elapsed = Date.now() - started;
          const report = `🏓 *LÉO STICKERS — LATÊNCIA*\n\nTempo de envio/ack local: *${elapsed} ms*\nConexão: *${sock?.user ? 'CONECTADO 🟢' : 'INICIALIZANDO 🟡'}*\n\n_Essa medida é o tempo até o Baileys concluir o envio/ack local; não representa um ping completo entre aparelhos._`;
          try { await sock.sendMessage(jid, { text: report, edit: marker?.key }); }
          catch { await send(jid, report, msg); }
        } catch (error) {
          await send(jid, `❌ Não consegui medir a latência: ${error?.message || error}`, msg);
        }
        break;
      }

      case 'ping':
        await send(
          jid,
          '🏓 Pong! Léo Stickers está online!',
          msg
        );
        break;

      case 'info':
        await send(
          jid,
          `🦊 ${config.botName}
Versão 1.0.0
Baileys + FFmpeg`,
          msg
        );
        break;

      case 'stats':
        await send(
          jid,
          `📊 ESTATÍSTICAS

Figurinhas: ${db.stickers}
Usuários: ${Object.keys(db.users).length}`,
          msg
        );
        break;


      case 'fig': {
        if (isViewOnceTarget(msg)) {
          await send(jid, '🔒 Peça o reenvio normal da imagem.', msg);
          break;
        }

        const target = findMedia(msg);

        if (!target || target.type !== 'imageMessage') {
          await send(jid, 'Envie uma foto com !fig ou responda a uma foto com !fig.', msg);
          break;
        }

        await send(jid, '🦊 Criando figurinha sem deformação e sem bordas...', msg);
        await createFig(target, jid, msg);
        break;
      }

            case 'duelo': {
        await sendStickerDuel(jid, msg);
        break;
      }

      case 'escolher': {
        await nominateDuelSticker(jid, msg);
        break;
      }

      case 'votar': {
        await voteStickerDuel(jid, msg, value);
        break;
      }

      case 'sequencia': {
        await sendStickerSequence(jid, msg, value);
        break;
      }

      case 'mix': {
        await sendStickerMix(jid, msg, value);
        break;
      }

      case 'sn': {
        if (isViewOnceTarget(msg)) {
          await send(jid, '🔒 Peça ao remetente que reenvie a mídia normalmente.', msg);
          break;
        }

        const target = findMedia(msg);

        if (!target || target.type === 'stickerMessage') {
          await send(
            jid,
            'Envie uma foto ou vídeo com !sn, ou responda à mídia com !sn.',
            msg
          );
          break;
        }

        await send(jid, '⏳ Criando figurinha sem metadados...', msg);
        await createSticker(target, true);
        break;
      }

      case 's':
      case 'sticker': {
        if (isViewOnceTarget(msg)) {
          await send(jid, '🔒 Mídia de visualização única não pode ser convertida. Peça o reenvio normal ao remetente.', msg);
          break;
        }

        const target = findMedia(msg);

        if (!target || target.type === 'stickerMessage') {
          await send(
            jid,
            'Envie uma foto ou vídeo com !s, ou responda à mídia com !s.',
            msg
          );
          break;
        }

        await send(jid, '⏳ Criando figurinha...', msg);
        await createSticker(target);
        break;
      }

      case 'reveal': {
        if (!isViewOnceTarget(msg)) {
          await send(
            jid,
            '🔎 Não identifiquei uma mídia de visualização única. Responda à foto ou ao vídeo com !reveal.',
            msg
          );
          break;
        }

        await send(
          jid,
          '🔒 Mídia de visualização única identificada! Para preservar a privacidade do remetente, peça que ele reenvie a foto ou o vídeo normalmente e autorize o processamento pelo bot.',
          msg
        );
        break;
      }

      case 'togif': {
        if (isViewOnceTarget(msg)) {
          await send(jid, '🔒 Peça o reenvio normal da mídia.', msg);
          break;
        }

        const target = findMedia(msg);

        if (!target || target.type !== 'stickerMessage') {
          await send(jid, 'Responda a uma figurinha animada com !togif.', msg);
          break;
        }

        await send(jid, '🎞️ Convertendo figurinha animada em GIF...', msg);
        await createGif(target, jid, msg);
        break;
      }

      case 'edit': {
        if (isViewOnceTarget(msg)) {
          await send(jid, '🔒 Não posso processar mídia de visualização única.', msg);
          break;
        }

        const target = findMedia(msg);

        if (!target || target.type !== 'stickerMessage') {
          await send(jid, 'Responda a uma figurinha com !edit Kleber | Osvaldo.', msg);
          break;
        }

        const separator = value.indexOf('|');

        if (separator < 0) {
          await send(jid, 'Formato correto: !edit Nome do pacote | Nome do autor', msg);
          break;
        }

        const packName = value.slice(0, separator).trim();
        const authorName = value.slice(separator + 1).trim();

        if (!packName || !authorName) {
          await send(jid, 'Informe os dois nomes. Exemplo: !edit Kleber | Osvaldo', msg);
          break;
        }

        await send(jid, '✏️ Atualizando os metadados...', msg);
        await editSticker(target, jid, msg, packName, authorName);
        break;
      }

      case 'toimg': {
        const target = findMedia(msg);

        if (!target) {
          await send(
            jid,
            'Responda a uma figurinha com !toimg.',
            msg
          );
          break;
        }

        await stickerToImage(target, jid, msg);
        break;
      }

      case 'setpack':
      case 'setauthor': {
        if (!value) {
          await send(
            jid,
            `Uso: !${command} nome`,
            msg
          );
          break;
        }

        if (command === 'setpack') {
          config.packName = value;
        } else {
          config.authorName = value;
        }

        fs.writeFileSync(
          './config.json',
          JSON.stringify(config, null, 2)
        );

        await send(
          jid,
          '✅ Configuração atualizada!',
          msg
        );
        break;
      }



      case 'buscarenv': {
        if (!value) {
          await send(jid, 'Uso: !buscarenv chocolate', msg);
          break;
        }

        await send(jid, '🔎 Pesquisando e preparando as prévias no GIPHY...', msg);

        const results = await searchGiphy(value);

        if (!results.length) {
          await send(jid, 'Não encontrei resultados para essa pesquisa.', msg);
          break;
        }

        giphySearches.set(jid, {
          results,
          createdAt: Date.now()
        });

        const lines = results.map((item, index) =>
          `${index + 1}. ${item.title} — @${item.username}`
        );

        await send(
          jid,
          '🦊 PRÉVIAS DO GIPHY\n\n' +
          lines.join('\n') +
          '\n\nVou enviar as figurinhas para você visualizar. ' +
          'Isso NÃO importa nada para sua biblioteca.\n\nPowered By GIPHY',
          msg
        );

        let enviados = 0;
        let falhas = 0;

        for (let i = 0; i < results.length; i++) {
          const item = results[i];

          try {
            const buffer = await downloadGiphyResult(item);
            const sticker = await prepareExternalSticker(buffer);

            await sock.sendMessage(
              jid,
              { sticker, mimetype: 'image/webp' },
              { quoted: msg }
            );

            enviados++;
          } catch (error) {
            falhas++;
            console.error('Erro na prévia GIPHY:', error.message);
          }
        }

        await send(
          jid,
          `✅ Prévia concluída!\nFigurinhas exibidas: ${enviados}\nFalhas: ${falhas}\n\nPara importar uma, use !importar número.`,
          msg
        );

        break;
      }

      case 'buscar': {
        if (!value) {
          await send(jid, 'Uso: !buscar gato', msg);
          break;
        }

        await send(jid, '🔎 Pesquisando figurinhas no GIPHY...', msg);

        const results = await searchGiphy(value);

        if (!results.length) {
          await send(jid, 'Não encontrei resultados para essa pesquisa.', msg);
          break;
        }

        giphySearches.set(jid, {
          results,
          createdAt: Date.now()
        });

        const lines = results.map((item, index) =>
          `${index + 1}. ${item.title} — @${item.username}`
        );

        await send(
          jid,
          '🦊 RESULTADOS DO GIPHY\n\n' +
          lines.join('\n') +
          '\n\nUse !importar número para guardar uma figurinha.\n\nPowered By GIPHY',
          msg
        );
        break;
      }

      case 'importar': {
        const number = Number(value);

        if (!Number.isInteger(number) || number < 1) {
          await send(jid, 'Uso: !importar 1', msg);
          break;
        }

        const search = giphySearches.get(jid);

        if (!search || Date.now() - search.createdAt > 30 * 60 * 1000) {
          await send(jid, 'Sua pesquisa expirou. Faça outra com !buscar.', msg);
          break;
        }

        const selected = search.results[number - 1];

        if (!selected) {
          await send(jid, 'Número não encontrado nos resultados.', msg);
          break;
        }

        await send(jid, '⬇️ Baixando e preparando a figurinha...', msg);

        const saved = await importGiphyResult(selected);
        const sticker = readLibrarySticker(saved.filename);

        await sock.sendMessage(
          jid,
          { sticker, mimetype: 'image/webp' },
          { quoted: msg }
        );

        await send(
          jid,
          saved.duplicate
            ? '♻️ Essa figurinha já estava na biblioteca!'
            : '✅ Figurinha adicionada à biblioteca global!',
          msg
        );
        break;
      }

      case 'precarregar': {
        if (!value) {
          await send(jid, 'Uso: !precarregar memes', msg);
          break;
        }

        await send(jid, '📥 Preparando pré-carregamento...', msg);

        const results = await searchGiphy(value);
        const selected = results.slice(0, 5);

        if (!selected.length) {
          await send(jid, 'Não encontrei figurinhas para importar.', msg);
          break;
        }

        let imported = 0;
        let duplicates = 0;
        let failed = 0;

        for (const result of selected) {
          try {
            const saved = await importGiphyResult(result);

            if (saved.duplicate) duplicates++;
            else imported++;
          } catch (error) {
            failed++;
            console.error('Falha ao pré-carregar:', error.message);
          }
        }

        await send(
          jid,
          `📚 PRÉ-CARREGAMENTO CONCLUÍDO\n\nNovas: ${imported}\nDuplicadas: ${duplicates}\nFalhas: ${failed}\n\nPowered By GIPHY`,
          msg
        );
        break;
      }


      case 'auto': {
        const action = value.trim().toLowerCase();
        const senderJid = msg.key.fromMe
          ? (authState?.creds?.me?.id || msg.key.participant || jid)
          : (msg.key.participant || jid);

        if (isGroup) {
          if (action === 'off') {
            setAutoSaveState(false, jid);
            await send(jid, '🔴 Coleta automática DESATIVADA somente neste grupo.', msg);
          } else if (action === 'on') {
            setAutoSaveState(true, jid);
            await send(jid, '🟢 Coleta automática ATIVADA neste grupo!', msg);
          } else {
            await send(jid, 'Uso:\n!auto off - Desativar neste grupo\n!auto on - Ativar neste grupo\n!autosave - Consultar estado', msg);
          }
        } else {
          if (!isOwner(senderJid)) {
            await send(jid, '❌ Somente o dono pode alterar a configuração global no privado.', msg);
            break;
          }

          if (action === 'off') {
            setAutoSaveState(false);
            await send(jid, '🔴 Coleta automática global DESATIVADA.', msg);
          } else if (action === 'on') {
            setAutoSaveState(true);
            await send(jid, '🟢 Coleta automática global ATIVADA!', msg);
          } else {
            await send(jid, 'Uso:\n!auto on - Ativar globalmente\n!auto off - Desativar globalmente\n!autosave - Consultar estado', msg);
          }
        }
        break;
      }

      case 'autosave': {
        const enabled = getAutoSaveState(jid);

        await send(
          jid,
          `🦊 COLETA AUTOMÁTICA\n\nEstado: ${enabled ? '🟢 ATIVADA' : '🔴 DESATIVADA'}\nFigurinhas na biblioteca: ${listLibrary().length}`,
          msg
        );

        break;
      }

      case 'random': {
        await sendRandomStickers(jid, msg, value);
        break;
      }

      case 'colecao': {
        const items = listLibrary();
        const animated = items.filter(item => item.animated).length;
        const statics = items.length - animated;

        await send(
          jid,
          `📚 BIBLIOTECA LÉO STICKERS\n\nTotal: ${items.length}\nAnimadas: ${animated}\nEstáticas: ${statics}\n\nFontes: WhatsApp e GIPHY`,
          msg
        );
        break;
      }

      case 'echo': {
        if (!value.trim()) {
          await send(jid, 'Uso: !echo sua mensagem', msg);
          break;
        }

        if (value.length > 1000) {
          await send(jid, 'Limite de 1000 caracteres.', msg);
          break;
        }

        await send(jid, value, msg);
        break;
      }

      default:
        await send(
          jid,
          '❓ Comando desconhecido. Digite !menu.',
          msg
        );
    }
  } catch (error) {
    console.error('Erro:', error);

    await send(
      jid,
      `❌ Erro: ${error.message}`,
      msg
    ).catch(() => {});
  }
}

function perguntarNumero() {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(
      'Digite seu número com DDI e DDD: ',
      answer => {
        rl.close();
        resolve(answer.replace(/\D/g, ''));
      }
    );
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMessageTimestampMs(msg) {
  const raw = msg?.messageTimestamp;
  const seconds = raw && typeof raw.toNumber === 'function'
    ? raw.toNumber()
    : Number(raw);

  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds >= 1_000_000_000_000 ? seconds : seconds * 1000;
}

// LEO_STICKERS_OUTGOING_TYPING_QUEUE_V2
function getOutgoingTextForPresence(content) {
  if (!content || typeof content !== 'object') return '';
  return [content.text, content.caption]
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n');
}

function estimateTypingIndicatorMs(text) {
  // Digitação rápida, com limite para não atrasar demais as respostas.
  const characters = [...String(text || '')].length;
  const estimated = Math.ceil((characters / 8) * 1000);
  return Math.min(3000, Math.max(700, estimated));
}

function installOutgoingMessageQueue(socket) {
  if (!socket || socket.__leoOutgoingQueueInstalled) return;

  const originalSendMessage = socket.sendMessage.bind(socket);
  const pending = [];
  const activeByChat = new Map();
  let active = 0;
  const MAX_CONCURRENT_SENDS = 2;

  Object.defineProperty(socket, '__leoOutgoingQueueInstalled', {
    value: true,
    configurable: false,
    enumerable: false
  });

  function pump() {
    while (active < MAX_CONCURRENT_SENDS && pending.length) {
      const job = pending.shift();
      active++;
      run(job).then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function run(job) {
    const { jid, content, options, ownerNoTyping: queuedOwnerNoTyping, sourceGroupJid, sourceTimestampMs } = job;
    // A resposta pode ter ficado esperando na fila enquanto o grupo foi pausado.
    // Revalida no momento do envio para descartar saídas antigas já enfileiradas.
    if (sourceGroupJid && shouldIgnoreGroupTimestamp(sourceGroupJid, sourceTimestampMs)) {
      console.log('[FILA SAÍDA] Resposta antiga descartada: mensagem enviada durante a pausa do grupo.');
      return { skipped: true, reason: 'group-paused-backlog' };
    }
    const outgoingText = getOutgoingTextForPresence(content);
    // O comando de latência deve responder imediatamente, sem indicador de digitação.
    const isLatencyProbe = /^🏓\s*Medindo latência local/i.test(outgoingText);
    const isEdit = Boolean(options && options.edit);
    const ownerIsUsingThisChat = queuedOwnerNoTyping === true || socket.__leoOwnerChats?.has(jid) === true;
    const useTyping = jid !== 'status@broadcast' && !isLatencyProbe && !isEdit &&
      !ownerIsUsingThisChat &&
      typeof socket.sendPresenceUpdate === 'function';

    if (useTyping) {
      const count = activeByChat.get(jid) || 0;
      activeByChat.set(jid, count + 1);
      if (count === 0) {
        try { await socket.sendPresenceUpdate('composing', jid); }
        catch (error) { console.warn('[DIGITAÇÃO] Não foi possível iniciar presença:', error?.message || error); }
      }
      await delay(estimateTypingIndicatorMs(outgoingText));
    }

    const sendStartedAt = performance.now();
    try {
      const result = await originalSendMessage(jid, content, options);
      recordOutboundMessage(performance.now() - sendStartedAt, true);
      return result;
    } catch (error) {
      recordOutboundMessage(performance.now() - sendStartedAt, false);
      throw error;
    } finally {
      if (useTyping) {
        const count = Math.max(0, (activeByChat.get(jid) || 1) - 1);
        if (count === 0) {
          activeByChat.delete(jid);
          try { await socket.sendPresenceUpdate('paused', jid); }
          catch (error) { console.warn('[DIGITAÇÃO] Não foi possível encerrar presença:', error?.message || error); }
        } else {
          activeByChat.set(jid, count);
        }
      }
    }
  }

  // Até dois envios simultâneos: um comando não fica preso esperando toda a
  // digitação/resposta anterior. As mensagens recebidas continuam sendo tratadas.
  socket.sendMessage = function (jid, content, options) {
    return new Promise((resolve, reject) => {
      const sourceContext = ownerCommandContext.getStore() || {};
      pending.push({
        jid,
        content,
        options,
        ownerNoTyping: sourceContext.owner === true,
        sourceGroupJid: sourceContext.sourceGroupJid || '',
        sourceTimestampMs: sourceContext.sourceTimestampMs ?? null,
        resolve,
        reject
      });
      pump();
    });
  };
}

async function start(baileys) {
  if (reconnecting) return;

  reconnecting = true;
  const messageCutoffTimestampMs = Date.now(); // LEO_IGNORE_MESSAGES_BEFORE_SOCKET_START

  try {
    console.log('Consultando versão do WhatsApp Web...');

    const result = await baileys.fetchLatestBaileysVersion();
    const version = result.version;

    console.log('Versão encontrada:', version.join('.'));
    console.log('Versão mais recente:', result.isLatest);

    const { state, saveCreds } =
      await baileys.useMultiFileAuthState('./sessao');

    authState = state;

    let phoneNumber = '';

    if (!state.creds.registered) {
      if (state.creds.pairingCode && state.creds.me?.id) {
        phoneNumber = getNumber(state.creds.me.id);

        console.log(
          'Tentando continuar o pareamento pendente salvo na sessão...'
        );
      } else {
        phoneNumber = await perguntarNumero();
      }

      if (!/^\d{10,15}$/.test(phoneNumber)) {
        throw new Error(
          'Número inválido. Use DDI + DDD + número.'
        );
      }
    }

    console.log('Conectando ao WhatsApp...');
    process.env.LEO_STICKERS_MESSAGE_CUTOFF_SECONDS = String(Math.floor(Date.now() / 1000)); // LEO_STICKERS_EARLY_MESSAGE_FILTER_V2
    const currentSock = baileys.default.default({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock = currentSock;
    installOutgoingMessageQueue(currentSock);

    let pairingRequested = false;

    currentSock.ev.on('creds.update', saveCreds);

    currentSock.ev.on('group-participants.update', update => {
      if (update?.id && !isGroupBotEnabled(update.id)) { console.log('[CONTROLE] Evento de participantes ignorado: grupo pausado.'); return; } // LEO_CONTROL_GROUP_PARTICIPANTS_GUARD_V1
      console.log('[ENTRADA] Evento de participante:', JSON.stringify({ id: update?.id, action: update?.action, participants: update?.participants }));
      handleBlacklistedParticipantUpdate(currentSock, update).catch(error => {
        console.error('[LISTA NEGRA] Erro no evento de participantes:', error?.stack || error);
      });
      handleGroupJoinRequest(currentSock, update).catch(error => {
        console.error('[ENTRADA] Erro ao confirmar entrada/publicar apresentação:', error?.stack || error);
      });
    });

    // Solicitações de entrada são emitidas pelo Baileys 6.7.18 em group.join-request.
    currentSock.ev.on('group.join-request', request => {
      if (request?.id && !isGroupBotEnabled(request.id)) { console.log('[CONTROLE] Solicitação ignorada: grupo pausado.'); return; } // LEO_CONTROL_GROUP_REQUEST_GUARD_V1
      handleGroupJoinRequest(currentSock, request).catch(error => {
        console.error('[ENTRADA] Erro ao tratar solicitação:', error?.message || error);
      });
    });

    currentSock.ev.on(
      'connection.update',
      async update => {
        recordConnectionUpdate(update); // LEO_CONTROL_CONNECTION_METRICS_V1
        const {
          connection,
          lastDisconnect,
          handshakeReady
        } = update;

        if (connection === 'connecting') {
          console.log('Estabelecendo conexão...');
        }

        // O patch em Baileys emite este evento quando o handshake termina.
        if (
          handshakeReady &&
          !state.creds.registered &&
          !pairingRequested
        ) {
          pairingRequested = true;

          try {
            await currentSock.waitForSocketOpen();
            await delay(400);

            const code =
              await currentSock.requestPairingCode(phoneNumber);

            console.log('\n==============================');
            console.log('🔐 CÓDIGO: ' + code);
            console.log('==============================');

            console.log('WhatsApp > Aparelhos conectados');
            console.log('Conectar com número de telefone');
            console.log('Digite o código imediatamente.\n');
          } catch (error) {
            console.error(
              'Erro ao solicitar código:',
              error.message
            );

            console.log(
              'O pareamento não foi solicitado. A sessão foi preservada.'
            );
          }
        }

        if (connection === 'open') {
          reconnecting = false;

          console.log('\n🦊 LÉO STICKERS CONECTADO!');
          console.log('🕒 Reconectado em:', formatBrazilTimestamp(), '(horário de Brasília)');
          appendRestartLog('WhatsApp conectado/reconectado.');
          console.log('Digite !menu no WhatsApp.');
          resumeGroupJoinRequests(currentSock).catch(error => {
            console.error('[ENTRADA] Falha ao sincronizar solicitações pendentes:', error?.message || error);
          });
        }

        if (connection === 'close') {
          reconnecting = false;

          const error = lastDisconnect?.error;
          const status = error?.output?.statusCode;

          console.log('\n⚠️ CONEXÃO ENCERRADA');
          console.log('🕒 Horário da queda:', formatBrazilTimestamp(), '(horário de Brasília)');
          console.log('Código:', status ?? 'desconhecido');
          console.log(
            'Motivo:',
            error?.message ?? 'Não informado'
          );
          appendRestartLog(
            `QUEDA DA CONEXÃO | Código: ${status ?? 'desconhecido'} | Motivo: ${(error?.message ?? 'Não informado').slice(0, 200)}`
          );

          if (
            status === baileys.DisconnectReason.loggedOut ||
            status === 401
          ) {
            console.log(
              'Autenticação recusada. A sessão foi preservada.'
            );
            return;
          }

          if (
            status === baileys.DisconnectReason.restartRequired ||
            status === 515
          ) {
            console.log(
              'WhatsApp solicitou reinicialização do socket.'
            );

            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
            }

            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              start(baileys).catch(console.error);
            }, 1500);

            return;
          }

          if (!state.creds.registered) {
            console.log(
              'Pareamento interrompido. A sessão foi preservada.'
            );

            console.log(
              'Não será gerado outro código automaticamente.'
            );

            return;
          }

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          console.log('Tentando reconectar em 5 segundos...');

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            start(baileys).catch(console.error);
          }, 5000);
        }
      }
    );

    currentSock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        console.log(
          `[DIAGNÓSTICO] Evento recebido: type=${type} | mensagens=${messages?.length ?? 0}`
        );

        if (type !== 'notify') return;

        // Registra !grupo off/on de todo o lote antes de processar qualquer
        // mensagem. Isso impede a fila do próprio lote de adiantar mensagens antigas.
        const ownerForPreapply = authState?.creds?.me?.lid || authState?.creds?.me?.id || '';
        const preappliedToggles = preapplyGroupControlCommands(messages, isOwner, ownerForPreapply, config.prefix, messageCutoffTimestampMs);
        if (preappliedToggles > 0) {
          console.log(`[CONTROLE] ${preappliedToggles} comando(s) de pausa/reativação pré-registrado(s).`);
        }

        for (const msg of messages) {
          const sentAtMs = getMessageTimestampMs(msg);
          if (sentAtMs !== null && sentAtMs < messageCutoffTimestampMs) {
            console.log('[IGNORADA] Mensagem enviada antes do início desta conexão.');
            continue;
          }
          recordInboundMessage(msg, config.prefix); // LEO_CONTROL_MESSAGE_METRICS_V2
          const controlRemoteJid = msg.key?.remoteJid || '';
          const controlSenderJid = msg.key?.participant || (msg.key?.fromMe ? (authState?.creds?.me?.lid || authState?.creds?.me?.id || controlRemoteJid) : controlRemoteJid);
          // O painel precisa ser tratado antes do bloqueio de grupo pausado,
          // para que o proprietário consiga reativar um grupo pelo próprio grupo.
          const panelHandled = await ownerCommandContext.run(
            { owner: isOwner(controlSenderJid) },
            () => handleControlPanelMessage(currentSock, msg, { isOwner, senderJid: controlSenderJid, prefix: config.prefix })
          );
          if (panelHandled) continue; // LEO_CONTROL_PANEL_HOOK_V3
          if (controlRemoteJid.endsWith('@g.us') && shouldIgnoreGroupMessage(controlRemoteJid, msg)) {
            console.log('[CONTROLE] Mensagem descartada: enviada durante a pausa do grupo ou sem horário verificável.');
            continue;
          }
          if (await handleMutedMessage(currentSock, msg)) continue; // LEO_STICKERS_COMMUNITY_MUTE_HOOK_V1
          if (await handleApplicantPrivateMessage(currentSock, msg)) continue;
          console.log(
            '[IDENTIFICADOR REMETENTE]',
            'nome=' + (msg.pushName || 'Sem nome'),
            'participant=' + (msg.key?.participant || 'Sem participant'),
            'fromMe=' + String(!!msg.key?.fromMe),
            'remoteJid=' + (msg.key?.remoteJid || 'Sem remoteJid')
          );

          const packProbe = unwrap(msg.message);

          // LEO_WHATSAPP_PACK_CAPTURE
          const receivedPack = packProbe?.stickerPackMessage;

          if (
            receivedPack?.mediaKey &&
            receivedPack?.directPath &&
            Array.isArray(receivedPack.stickers)
          ) {
            pendingStickerPacks.set(msg.key.remoteJid, {
              pack: receivedPack,
              receivedAt: Date.now()
            });

            console.log(
              '[PACOTE WHATSAPP] Recebido:',
              receivedPack.name || 'Sem nome',
              '| Figurinhas:',
              receivedPack.stickers.length
            );
          }
          const messageTypes = Object.keys(packProbe || {});
          const ordinaryTypes = [
            'conversation',
            'extendedTextMessage',
            'imageMessage',
            'videoMessage',
            'stickerMessage',
            'audioMessage',
            'documentMessage',
            'contactMessage',
            'locationMessage'
          ];

          if (
            messageTypes.some(key => /sticker.*pack|pack.*sticker/i.test(key)) ||
            !messageTypes.some(key => ordinaryTypes.includes(key))
          ) {
            console.log('\n========== MENSAGEM ESPECIAL ==========');
            console.log('Tipos:', messageTypes);
            if (!packProbe?.stickerPackMessage) {
              console.log(JSON.stringify(packProbe, null, 2)?.slice(0, 15000));
            } else {
              console.log('[PACOTE WHATSAPP] Dados criptográficos ocultados.');
            }
            console.log('========================================\n');
          }

          await autoSaveIncomingSticker(msg);
          // O dono não recebe indicador de digitando; usuários comuns continuam recebendo.
          const commandTextForPresence = getText(msg);
          const ownerSenderForPresence = msg.key?.fromMe
            ? (authState?.creds?.me?.lid || authState?.creds?.me?.id || msg.key?.participant || controlRemoteJid)
            : (msg.key?.participant || controlRemoteJid);
          const ownerNoTyping = isOwner(ownerSenderForPresence);
          await ownerCommandContext.run(
            {
              owner: ownerNoTyping,
              sourceGroupJid: controlRemoteJid.endsWith('@g.us') ? controlRemoteJid : '',
              sourceTimestampMs: sentAtMs
            },
            () => handleCommand(msg)
          );
        }
      }
    );
  } catch (error) {
    reconnecting = false;

    console.error('Erro ao iniciar o bot:', error);

    console.log(
      'Inicialização interrompida. Corrija o erro antes de tentar novamente.'
    );
  }
}

let downloadMediaMessage;

async function main() {
  console.log('🦊 Preparando Léo Stickers...');

  applyPairingFix();

  if (process.argv.includes('--verificar-patch')) {
    console.log('Verificação concluída. O bot não foi iniciado.');
    return;
  }

  const baileys = await import('@whiskeysockets/baileys');
downloadMediaMessage = baileys.downloadMediaMessage;

  console.log('🦊 Iniciando Léo Stickers...');

  await start(baileys);
}

main().catch(error => {
  console.error('Erro fatal:', error);
  process.exitCode = 1;
});
