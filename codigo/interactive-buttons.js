/**
 * Envio de mensagens interativas nativas do WhatsApp usando o protocolo
 * disponível no Baileys 6.7.18. A compatibilidade final depende do cliente WhatsApp.
 */
let injectedBaileysApi = null;

export function __setBaileysApiForTests(api) {
  injectedBaileysApi = api;
}

async function getBaileysApi() {
  if (injectedBaileysApi) return injectedBaileysApi;
  const imported = await import('@whiskeysockets/baileys');
  const api = imported.default || imported;
  if (typeof api.generateWAMessageFromContent !== 'function') {
    throw new Error('generateWAMessageFromContent não está disponível nesta versão do Baileys.');
  }
  return api;
}

function makeBizNodes(isGroup) {
  const nodes = [{
    tag: 'biz', attrs: {}, content: [{
      tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{
        tag: 'native_flow', attrs: { v: '9', name: 'mixed' }
      }]
    }]
  }];
  if (!isGroup) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  return nodes;
}

export async function sendInteractiveMessage(sock, jid, options = {}) {
  if (!sock || typeof sock.relayMessage !== 'function') {
    throw new Error('O socket atual não oferece relayMessage().');
  }
  const api = await getBaileysApi();
  const { generateWAMessageFromContent, normalizeMessageContent } = api;
  const buttons = Array.isArray(options.buttons) ? options.buttons : [];
  if (!buttons.length) throw new Error('A mensagem interativa precisa ter pelo menos um botão.');

  const interactiveMessage = {
    body: { text: String(options.text || ' ') },
    ...(options.title ? { header: { title: String(options.title), hasMediaAttachment: false } } : {}),
    ...(options.footer ? { footer: { text: String(options.footer) } } : {}),
    nativeFlowMessage: { buttons }
  };
  const content = { interactiveMessage };
  const userJid = sock.user?.id || sock.authState?.creds?.me?.id;
  const generated = generateWAMessageFromContent(jid, content, {
    userJid,
    ...(options.messageId ? { messageId: options.messageId } : {})
  });
  if (!generated?.key?.id || !generated?.message) {
    throw new Error('O Baileys não conseguiu gerar a mensagem interativa.');
  }
  // A validação também detecta incompatibilidades de protobuf antes do relay.
  const normalized = typeof normalizeMessageContent === 'function'
    ? normalizeMessageContent(generated.message)
    : generated.message;
  if (!normalized?.interactiveMessage?.nativeFlowMessage?.buttons?.length) {
    throw new Error('O conteúdo nativo de botões não foi reconhecido pelo protobuf.');
  }

  await sock.relayMessage(jid, generated.message, {
    messageId: generated.key.id,
    additionalNodes: makeBizNodes(String(jid).endsWith('@g.us'))
  });
  return generated;
}
