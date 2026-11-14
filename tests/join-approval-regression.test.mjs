import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as joinTest } from '../codigo/join-approval.js';

test('envio privado prefere PN quando disponível', () => {
  assert.equal(
    joinTest.selectPrivateRecipient('5511999999999@s.whatsapp.net', '1234567890123@lid'),
    '5511999999999@s.whatsapp.net'
  );
});

test('envio privado usa o LID recebido quando não existe PN', () => {
  assert.equal(
    joinTest.selectPrivateRecipient('', '', '', '1234567890123@lid'),
    '1234567890123@lid'
  );
});

test('envio privado encontra LID nos campos alternativos do evento', () => {
  assert.equal(
    joinTest.selectPrivateRecipient('', '', '', '', '1234567890123@lid'),
    '1234567890123@lid'
  );
});

test('envio privado ignora identificador que não seja PN nem LID', () => {
  assert.equal(joinTest.selectPrivateRecipient('', 'nao-e-jid'), '');
});

test('aviso repetido para administradores é deduplicado por solicitação', () => {
  const app = { code: 'ABC123', status: 'awaiting' };
  const summary = 'Não consegui enviar a mensagem no privado';
  const now = 1_800_000_000_000;
  assert.equal(joinTest.shouldSendAdminNotice(app, summary, now), true);
  assert.equal(joinTest.shouldSendAdminNotice(app, summary, now + 1_000), false);
  assert.equal(joinTest.shouldSendAdminNotice(app, 'Entrada confirmada e apresentação publicada', now + 1_000), true);
  assert.equal(joinTest.shouldSendAdminNotice(app, summary, now + 7 * 60 * 60 * 1000), true);
});
