import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStickerSearchArguments, __test as stickerSearchTest } from '../codigo/intelligent-sticker-search.js';
import { __test as rentalTest } from '../codigo/rental-system.js';
import { __test as joinTest } from '../codigo/join-approval.js';

test('busca inteligente usa quantidade padrão cinco', () => {
  assert.deepEqual(parseStickerSearchArguments('gato'), { query: 'gato', amount: 5 });
});

test('busca inteligente limita quantidade a dez', () => {
  assert.deepEqual(parseStickerSearchArguments('cachorro 20'), { query: 'cachorro', amount: 10 });
});

test('busca inteligente preserva tema com várias palavras', () => {
  assert.deepEqual(parseStickerSearchArguments('cachorro triste 3'), { query: 'cachorro triste', amount: 3 });
});

test('normalização remove acentos e pontuação', () => {
  assert.equal(stickerSearchTest.normalize('Cachorrão!'), 'cachorrao');
});

test('cálculo de mensalidade trata fim de mês sem pular mês', () => {
  const source = new Date('2026-01-31T12:00:00.000Z');
  assert.equal(rentalTest.addOneMonth(source).toISOString(), '2026-02-28T12:00:00.000Z');
});

test('planos de aluguel permanecem disponíveis no modo de aprovação manual', () => {
  assert.equal(rentalTest.PLANS.basic.name, 'Basic');
  assert.equal(rentalTest.PLANS.pro.name, 'Pro');
  assert.equal(rentalTest.PLANS.premium.name, 'Premium');
});

test('normalização de JID preserva domínio LID', () => {
  assert.equal(joinTest.normalizeJid('12345@lid'), '12345@lid');
});


test('evento de solicitação separa LID de telefone para o PV', () => {
  const identity = joinTest.participantIdentity({
    participant: '1234567890123@lid',
    participantPn: '5511999999999@s.whatsapp.net',
    action: 'created'
  });
  assert.equal(identity.groupParticipant, '1234567890123@lid');
  assert.equal(identity.participantPn, '5511999999999@s.whatsapp.net');
  assert.equal(identity.participantLid, '1234567890123@lid');
});


test('aprovação recupera telefone privado a partir do LID', async () => {
  const sock = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async lid => lid === '1234567890123@lid' ? '5511999999999@s.whatsapp.net' : null
      }
    }
  };
  const resolved = await joinTest.resolvePrivateJid(sock, { participantLid: '1234567890123@lid' });
  assert.equal(resolved, '5511999999999@s.whatsapp.net');
});

test('aliases do participante aceitam tanto LID quanto telefone', () => {
  const aliases = joinTest.identityAliases({
    participant: '5511999999999@s.whatsapp.net',
    participantLid: '1234567890123@lid',
    groupParticipant: '1234567890123@lid'
  });
  assert.equal(aliases.has('5511999999999@s.whatsapp.net'), true);
  assert.equal(aliases.has('1234567890123@lid'), true);
});
