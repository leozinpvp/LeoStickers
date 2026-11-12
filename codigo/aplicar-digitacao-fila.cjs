'use strict';

// Aplicador seguro da fila de envios + indicador de composição do Léo Stickers.
// Execute este arquivo na pasta do projeto, onde está o index.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const indexPath = path.resolve(process.cwd(), 'index.js');
const marker = 'LEO_STICKERS_OUTGOING_TYPING_QUEUE_V1';

if (!fs.existsSync(indexPath)) {
  console.error('❌ Não encontrei index.js na pasta atual.');
  console.error('Entre em ~/BotFigurinhas e execute novamente.');
  process.exit(1);
}

const original = fs.readFileSync(indexPath, 'utf8');
if (original.includes(marker)) {
  console.log('✅ A fila de envios e o indicador já estão instalados.');
  process.exit(0);
}

const startMarker = 'async function start(baileys) {';
const socketMarker = '    sock = currentSock;';

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

if (countOccurrences(original, startMarker) !== 1) {
  console.error('❌ Não encontrei um único ponto seguro para inserir a função.');
  console.error('Nenhum arquivo foi alterado.');
  process.exit(1);
}
if (countOccurrences(original, socketMarker) !== 1) {
  console.error('❌ Não encontrei um único ponto seguro para instalar a fila no socket.');
  console.error('Nenhum arquivo foi alterado.');
  process.exit(1);
}

const helper = `// ${marker}
function getOutgoingTextForPresence(content) {
  if (!content || typeof content !== 'object') return '';
  return [content.text, content.caption]
    .filter(value => typeof value === 'string' && value.trim())
    .join('\\n');
}

function estimateTypingIndicatorMs(text) {
  // Referência: digitador rápido (~80 palavras/minuto, cerca de 8 caracteres/segundo).
  // O tempo é limitado para não deixar conversas esperando excessivamente.
  const characters = [...String(text || '')].length;
  const estimated = Math.ceil((characters / 8) * 1000);
  return Math.min(3000, Math.max(700, estimated));
}

function installOutgoingMessageQueue(socket) {
  if (!socket || socket.__leoOutgoingQueueInstalled) return;

  const originalSendMessage = socket.sendMessage.bind(socket);
  let sendQueue = Promise.resolve();

  Object.defineProperty(socket, '__leoOutgoingQueueInstalled', {
    value: true,
    configurable: false,
    enumerable: false
  });

  // Uma fila global: nenhuma chamada sendMessage começa enquanto outra não termina.
  socket.sendMessage = function (jid, content, options) {
    const task = sendQueue.then(async () => {
      const outgoingText = getOutgoingTextForPresence(content);
      let composingStarted = false;

      if (jid !== 'status@broadcast' && typeof socket.sendPresenceUpdate === 'function') {
        try {
          await socket.sendPresenceUpdate('composing', jid);
          composingStarted = true;
          await delay(estimateTypingIndicatorMs(outgoingText));
        } catch (error) {
          console.warn('[DIGITAÇÃO] Não foi possível atualizar presença:', error?.message || error);
        }
      }

      try {
        return await originalSendMessage(jid, content, options);
      } finally {
        if (composingStarted) {
          try {
            await socket.sendPresenceUpdate('paused', jid);
          } catch (error) {
            console.warn('[DIGITAÇÃO] Não foi possível encerrar presença:', error?.message || error);
          }
        }
      }
    });

    // Uma falha não pode travar os próximos envios da fila.
    sendQueue = task.catch(() => undefined);
    return task;
  };
}
`;

let updated = original.replace(startMarker, helper + '\n' + startMarker);
updated = updated.replace(
  socketMarker,
  socketMarker + '\n    installOutgoingMessageQueue(currentSock);'
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.resolve(`backup-digitacao-fila-${stamp}`);
const backupPath = path.join(backupDir, 'index.js');
const tempPath = path.join(process.cwd(), `index.js.typing-check-${process.pid}.js`);

try {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(indexPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(tempPath, updated, 'utf8');

  const check = spawnSync(process.execPath, ['--check', tempPath], {
    encoding: 'utf8'
  });

  if (check.status !== 0) {
    throw new Error(check.stderr || check.stdout || 'Falha na verificação de sintaxe.');
  }

  fs.renameSync(tempPath, indexPath);
  console.log('✅ Indicador de “digitando…” e fila única instalados!');
  console.log('✅ Sintaxe do index.js verificada.');
  console.log('📁 Backup original:', backupPath);
  console.log('📨 Todos os envios via sock.sendMessage agora passam pela mesma fila.');
} catch (error) {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {}
  console.error('❌ Não consegui aplicar a alteração:', error.message);
  console.error('O index.js original foi preservado.');
  process.exit(1);
}
