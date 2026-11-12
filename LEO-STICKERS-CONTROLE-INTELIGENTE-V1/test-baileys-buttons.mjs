import assert from 'node:assert/strict';
import { sendInteractiveMessage } from './interactive-buttons.js';

let captured;
const sock = {
  user: { id: '15551234567@s.whatsapp.net' },
  relayMessage: async (...args) => { captured = args; return 'mock-ack'; }
};
await sendInteractiveMessage(sock, '15557654321@s.whatsapp.net', {
  text: 'Teste de botões',
  footer: 'Léo Stickers',
  buttons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Iniciar', id: 'ls_start_test' }) },
    { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: 'Copiar', copy_code: 'Nome:\nIdade:' }) }
  ]
});
assert.ok(captured, 'relayMessage foi chamado');
assert.deepEqual(captured[1].interactiveMessage.nativeFlowMessage.buttons.map(button => button.name), ['quick_reply', 'cta_copy']);
assert.equal(captured[2].additionalNodes[0].content[0].attrs.type, 'native_flow');
assert.equal(captured[2].additionalNodes[1].attrs.biz_bot, '1');
await sendInteractiveMessage(sock, '15557654321@s.whatsapp.net', {
  text: 'Escolha um grupo',
  buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({
    title: 'Selecionar grupo', sections: [{ title: 'Grupos', rows: [{ id: 'ls_group_test', title: 'Grupo de teste', description: 'Bot ativo' }] }]
  }) }]
});
assert.equal(captured[1].interactiveMessage.nativeFlowMessage.buttons[0].name, 'single_select');
console.log('PASSOU: Baileys 6.7.18 gerou quick_reply, cta_copy e single_select (relay simulado, sem enviar WhatsApp).');
