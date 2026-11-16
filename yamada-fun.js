import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// LEO_YAMADA_FUN_COMMANDS_V1

const DATA_FILE = path.resolve(process.env.LEO_YAMADA_FUN_DATA_FILE || './yamada-fun-data.json');
const REMINDER_TICK_MS = 15_000;
let scheduler = null;
let schedulerSock = null;

export const YAMADA_FUN_COMMANDS = Object.freeze([
  'impostor', 'stop', 'tribunal', 'lembrete', 'lembretes', 'cancelarlembrete', 'campeonato'
]);

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (value && typeof value === 'object') return value;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[YAMADA FUN] Banco não pôde ser lido:', error.message);
  }
  return { version: 1, groups: {} };
}
function saveState(data) {
  const temp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch {}
}
function groupState(data, jid) {
  data.groups ||= {};
  data.groups[jid] ||= { impostor: null, stop: null, tribunal: null, tournament: null, reminders: [] };
  const state = data.groups[jid];
  state.reminders = Array.isArray(state.reminders) ? state.reminders : [];
  return state;
}
function cleanText(value, max = 500) { return String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function normalize(value) {
  return cleanText(value, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9@ ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function senderId(ctx) { return String(ctx.sender || ctx.msg?.key?.participant || ctx.jid || '').split(':')[0]; }
function isGroup(ctx) { return String(ctx.jid || '').endsWith('@g.us'); }
function idAliases(value) {
  const aliases = new Set();
  const add = item => {
    if (!item) return;
    if (typeof item === 'object') { for (const key of ['id', 'jid', 'lid', 'phoneNumber']) add(item[key]); return; }
    const raw = String(item).trim().toLowerCase();
    if (!raw) return;
    const at = raw.lastIndexOf('@');
    if (at < 0) { const digits = raw.split(':')[0].replace(/\D/g, ''); if (digits) aliases.add(`${digits}@s.whatsapp.net`); return; }
    aliases.add(`${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`);
  };
  add(value); return aliases;
}
function aliasesMatch(a, b) { for (const item of a) if (b.has(item)) return true; return false; }
function isAdmin(p) { return p?.admin === 'admin' || p?.admin === 'superadmin' || p?.isAdmin === true || p?.isSuperAdmin === true; }
async function groupMetadata(ctx, requireBot = false) {
  if (!isGroup(ctx)) { await ctx.send(ctx.jid, 'Este comando só funciona em grupos.', ctx.msg); return null; }
  const metadata = await ctx.sock.groupMetadata(ctx.jid);
  const participants = metadata.participants || [];
  const key = ctx.msg?.key || {};
  const sender = participants.find(p => aliasesMatch(new Set([...idAliases(ctx.sender), ...idAliases(key.participant), ...idAliases(key.participantAlt)]), idAliases(p)));
  const bot = participants.find(p => aliasesMatch(new Set([...idAliases(ctx.sock.user?.id), ...idAliases(ctx.sock.user?.lid), ...idAliases(ctx.sock.user?.phoneNumber)]), idAliases(p)));
  if (!ctx.isOwner?.(ctx.sender) && !isAdmin(sender)) { await ctx.send(ctx.jid, 'Somente administradores do grupo podem fazer isso.', ctx.msg); return null; }
  if (requireBot && !isAdmin(bot)) { await ctx.send(ctx.jid, 'Preciso ser administrador do grupo para executar essa ação.', ctx.msg); return null; }
  return { metadata, participants, sender, bot };
}
function mentionIds(msg) {
  let current = msg?.message;
  for (let i = 0; i < 8 && current; i++) {
    for (const type of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage']) {
      const ids = current[type]?.contextInfo?.mentionedJid;
      if (Array.isArray(ids) && ids.length) return ids;
    }
    current = current.ephemeralMessage?.message || current.viewOnceMessage?.message || current.viewOnceMessageV2?.message || current.documentWithCaptionMessage?.message;
  }
  return [];
}
function tag(jid) { return '@' + String(jid || '').split('@')[0].split(':')[0]; }
function mentionsText(ctx, text, ids) { return ctx.sock.sendMessage(ctx.jid, { text, mentions: ids }, { quoted: ctx.msg }); }
function canManageRecord(ctx, record) { return record?.createdBy === senderId(ctx) || Boolean(ctx.isOwner?.(ctx.sender)); }
function parseDateTime(date, time) {
  const match = String(date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const clock = String(time).match(/^(\d{2}):(\d{2})$/);
  if (!match || !clock) return null;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  const hour = Number(clock[1]), minute = Number(clock[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  return check.getTime() + 3 * 60 * 60 * 1000; // Horário de Brasília (UTC-3).
}
function dateText(ms) { return new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

async function impostorCommand(ctx, state, value) {
  const [sub = 'ajuda', ...rest] = value.trim().split(/\s+/);
  const action = normalize(sub);
  let game = state.impostor;
  if (action === 'ajuda' || !action) return ctx.send(ctx.jid, '🕵️ *IMPOSTOR*\n!impostor iniciar — abre uma sala\n!impostor entrar — participa\n!impostor sortear — distribui papéis por PV\n!impostor votar @pessoa — vota\n!impostor resultado — revela o resultado\n!impostor cancelar — encerra a sala', ctx.msg);
  if (action === 'iniciar') {
    if (game && ['lobby', 'playing'].includes(game.phase)) return ctx.send(ctx.jid, 'Já existe uma partida de impostor em andamento.', ctx.msg);
    state.impostor = { phase: 'lobby', createdBy: senderId(ctx), createdAt: Date.now(), players: [senderId(ctx)], votes: {} };
    return ctx.send(ctx.jid, '🕵️ Sala criada! Os participantes devem usar *!impostor entrar*. São necessários pelo menos 3 jogadores. Quem criou pode usar *!impostor sortear* para começar.', ctx.msg);
  }
  if (!game) return ctx.send(ctx.jid, 'Não há partida de impostor ativa. Use !impostor iniciar.', ctx.msg);
  if (action === 'entrar') {
    if (game.phase !== 'lobby') return ctx.send(ctx.jid, 'A partida já começou; não é mais possível entrar.', ctx.msg);
    if (game.players.includes(senderId(ctx))) return ctx.send(ctx.jid, 'Você já está na sala.', ctx.msg);
    if (game.players.length >= 20) return ctx.send(ctx.jid, 'A sala atingiu o limite de 20 jogadores.', ctx.msg);
    game.players.push(senderId(ctx));
    return ctx.send(ctx.jid, `✅ Você entrou! Jogadores: ${game.players.length}.`, ctx.msg);
  }
  if (action === 'sortear') {
    if (game.phase !== 'lobby') return ctx.send(ctx.jid, 'Os papéis já foram distribuídos.', ctx.msg);
    if (game.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    if (game.players.length < 3) return ctx.send(ctx.jid, 'São necessários pelo menos 3 jogadores.', ctx.msg);
    const words = ['abacaxi', 'avião', 'biblioteca', 'chocolate', 'dinossauro', 'futebol', 'hospital', 'microfone', 'montanha', 'piscina', 'sorvete', 'violão', 'vulcão', 'zoológico'];
    game.word = words[Math.floor(Math.random() * words.length)];
    game.impostor = game.players[Math.floor(Math.random() * game.players.length)];
    game.phase = 'playing'; game.votes = {}; game.startedAt = Date.now();
    let delivered = 0;
    for (const player of game.players) {
      const isImpostor = player === game.impostor;
      try {
        await ctx.sock.sendMessage(player, { text: isImpostor ? '🕵️ Você é o IMPOSTOR! Descubra a palavra secreta sem ser descoberto.' : `🤫 Palavra secreta: *${game.word}*. Dê pistas sem falar a palavra.` });
        delivered++;
      } catch (error) { console.warn('[IMPOSTOR] Falha ao entregar papel:', error?.message || error); }
    }
    if (delivered !== game.players.length) {
      state.impostor = null;
      return ctx.send(ctx.jid, '⚠️ Não consegui entregar todos os papéis no privado. A partida foi cancelada para não revelar parcialmente os papéis. Cada jogador precisa conseguir receber mensagens do bot.', ctx.msg);
    }
    return ctx.send(ctx.jid, `🎭 Papéis enviados no PV para ${game.players.length} jogadores! Façam uma rodada de pistas e depois votem com *!impostor votar @pessoa*.`, ctx.msg);
  }
  if (action === 'votar') {
    if (game.phase !== 'playing') return ctx.send(ctx.jid, 'A partida ainda não começou.', ctx.msg);
    if (!game.players.includes(senderId(ctx))) return ctx.send(ctx.jid, 'Só quem entrou na partida pode votar.', ctx.msg);
    const targets = mentionIds(ctx.msg);
    if (targets.length !== 1) return ctx.send(ctx.jid, 'Marque exatamente uma pessoa: !impostor votar @pessoa.', ctx.msg);
    const target = game.players.find(player => aliasesMatch(idAliases(player), idAliases(targets[0])));
    if (!target || target === senderId(ctx)) return ctx.send(ctx.jid, 'Alvo inválido. Você precisa votar em outro jogador da partida.', ctx.msg);
    game.votes[senderId(ctx)] = target;
    return ctx.send(ctx.jid, `🗳️ Voto registrado em ${tag(target)}.`, ctx.msg, { mentions: [target] });
  }
  if (action === 'resultado') {
    if (game.phase !== 'playing') return ctx.send(ctx.jid, 'Não existe uma votação em andamento.', ctx.msg);
    if (game.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    const counts = {};
    for (const target of Object.values(game.votes)) counts[target] = (counts[target] || 0) + 1;
    const top = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    const chosen = top[0] && (!top[1] || top[0][1] > top[1][1]) ? top[0][0] : null;
    const outcome = chosen ? (chosen === game.impostor ? '🎉 O grupo descobriu o impostor!' : '😈 O grupo errou!') : '🤝 Houve empate na votação.';
    const text = `${outcome}\nImpostor: ${tag(game.impostor)}\nPalavra: *${game.word}*\nVotos: ${Object.keys(game.votes).length}/${game.players.length}`;
    state.impostor = null;
    return ctx.send(ctx.jid, text, ctx.msg, { mentions: [game.impostor] });
  }
  if (action === 'cancelar') {
    if (game.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    state.impostor = null;
    return ctx.send(ctx.jid, 'Partida de impostor encerrada.', ctx.msg);
  }
  return ctx.send(ctx.jid, 'Subcomando inválido. Use !impostor ajuda.', ctx.msg);
}

async function stopCommand(ctx, state, value) {
  const [sub = 'ajuda', ...rest] = value.trim().split(/\s+/);
  const action = normalize(sub);
  const rawArgs = value.trim().slice(sub.length).trim();
  if (action === 'ajuda' || !action) return ctx.send(ctx.jid, '📝 *STOP / ADEDONHA*\n!stop iniciar — sorteia letra e abre 90 segundos\n!stop resposta Nome=Ana; Animal=Anta; País=Angola; Comida=Arroz; Objeto=Anel\n!stop finalizar — encerra e calcula pontos', ctx.msg);
  if (action === 'iniciar') {
    if (state.stop && state.stop.phase === 'running' && Date.now() < state.stop.endsAt) return ctx.send(ctx.jid, 'Já existe uma rodada de STOP ativa.', ctx.msg);
    if (state.stop && state.stop.phase === 'running') return ctx.send(ctx.jid, 'A rodada anterior terminou. Use !stop finalizar para ver o resultado antes de iniciar outra.', ctx.msg);
    const letters = 'ABCDEFGHIJKLMNOPRST';
    const letter = letters[Math.floor(Math.random() * letters.length)];
    state.stop = { phase: 'running', letter, createdBy: senderId(ctx), createdAt: Date.now(), endsAt: Date.now() + 90_000, answers: {} };
    return ctx.send(ctx.jid, `📝 *STOP COMEÇOU!*\nLetra: *${letter}*\nCategorias: Nome, Animal, País, Comida e Objeto.\nTempo: 90 segundos.\nEnvie: *!stop resposta Nome=...; Animal=...; País=...; Comida=...; Objeto=...*`, ctx.msg);
  }
  if (!state.stop || state.stop.phase !== 'running') return ctx.send(ctx.jid, 'Não há rodada ativa. Use !stop iniciar.', ctx.msg);
  if (action === 'resposta') {
    if (Date.now() > state.stop.endsAt) return ctx.send(ctx.jid, '⏰ O tempo acabou. Use !stop finalizar para ver o placar.', ctx.msg);
    if (!rawArgs) return ctx.send(ctx.jid, 'Informe as respostas no formato Nome=...; Animal=...; País=...; Comida=...; Objeto=...', ctx.msg);
    const aliases = { nome: 'nome', animal: 'animal', pais: 'país', paises: 'país', comida: 'comida', objeto: 'objeto' };
    const values = {};
    for (const segment of rawArgs.split(/[;|]+/)) {
      const m = segment.match(/^\s*([^=:\-]+)\s*[=:\-]\s*(.*?)\s*$/);
      if (!m) continue;
      const key = aliases[normalize(m[1])];
      if (key) values[key] = cleanText(m[2], 60);
    }
    if (!Object.keys(values).length) return ctx.send(ctx.jid, 'Não reconheci as categorias. Use Nome=...; Animal=...; País=...; Comida=...; Objeto=...', ctx.msg);
    state.stop.answers[senderId(ctx)] = { name: cleanText(ctx.msg?.pushName || senderId(ctx).split('@')[0], 40), values, updatedAt: Date.now() };
    return ctx.send(ctx.jid, `✅ Respostas registradas (${Object.keys(values).length}/5 categorias). Você pode atualizar até o fim do tempo.`, ctx.msg);
  }
  if (action === 'finalizar') {
    const stopRound = state.stop;
    if (Date.now() < stopRound.endsAt && stopRound.createdBy !== senderId(ctx)) {
      const admin = await groupMetadata(ctx);
      if (!admin && !ctx.isOwner?.(ctx.sender)) return true;
    }
    const entries = Object.entries(stopRound.answers);
    const cats = ['nome', 'animal', 'país', 'comida', 'objeto'];
    const counts = Object.fromEntries(cats.map(cat => [cat, {}]));
    for (const [, entry] of entries) for (const cat of cats) {
      const answer = normalize(entry.values?.[cat]);
      if (answer && answer.startsWith(normalize(stopRound.letter))) counts[cat][answer] = (counts[cat][answer] || 0) + 1;
    }
    const scored = entries.map(([jid, entry]) => {
      let score = 0;
      for (const cat of cats) {
        const answer = normalize(entry.values?.[cat]);
        if (!answer || !answer.startsWith(normalize(stopRound.letter))) continue;
        score += counts[cat][answer] > 1 ? 5 : 10;
      }
      return { jid, name: entry.name, score };
    }).sort((a,b) => b.score-a.score);
    state.stop = null;
    const lines = scored.length ? scored.map((item,i)=>`${i+1}. ${item.name} — *${item.score} pontos*`) : ['Ninguém enviou respostas.'];
    return ctx.send(ctx.jid, `🏁 *RESULTADO DO STOP — LETRA ${stopRound.letter}*\n\n${lines.join('\n')}`, ctx.msg);
  }
  return ctx.send(ctx.jid, 'Subcomando inválido. Use !stop ajuda.', ctx.msg);
}

async function tribunalCommand(ctx, state, value) {
  const [sub = 'ajuda', ...rest] = value.trim().split(/\s+/);
  const action = normalize(sub);
  if (action === 'ajuda' || !action) return ctx.send(ctx.jid, '⚖️ *TRIBUNAL DO GRUPO*\n!tribunal @pessoa motivo — abre um julgamento de brincadeira\n!tribunal defesa texto — registra defesa\n!tribunal voto culpado|inocente — vota\n!tribunal encerrar — mostra o resultado\nTudo é brincadeira, sem punição real.', ctx.msg);
  if (action === 'defesa') {
    if (!state.tribunal) return ctx.send(ctx.jid, 'Não há julgamento aberto.', ctx.msg);
    const text = cleanText(rest.join(' '), 500);
    if (!text) return ctx.send(ctx.jid, 'Escreva a defesa depois de !tribunal defesa.', ctx.msg);
    state.tribunal.defenses.push({ by: senderId(ctx), text, at: Date.now() });
    return ctx.send(ctx.jid, '📜 Defesa registrada no tribunal fictício.', ctx.msg);
  }
  if (action === 'voto') {
    if (!state.tribunal) return ctx.send(ctx.jid, 'Não há julgamento aberto.', ctx.msg);
    const vote = normalize(rest[0]);
    if (!['culpado','inocente'].includes(vote)) return ctx.send(ctx.jid, 'Vote com !tribunal voto culpado ou !tribunal voto inocente.', ctx.msg);
    state.tribunal.votes[senderId(ctx)] = vote;
    return ctx.send(ctx.jid, `🗳️ Voto registrado: ${vote}.`, ctx.msg);
  }
  if (action === 'encerrar') {
    const caseFile = state.tribunal;
    if (!caseFile) return ctx.send(ctx.jid, 'Não há julgamento aberto.', ctx.msg);
    if (caseFile.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    const guilty = Object.values(caseFile.votes).filter(v => v === 'culpado').length;
    const innocent = Object.values(caseFile.votes).filter(v => v === 'inocente').length;
    state.tribunal = null;
    return ctx.send(ctx.jid, `⚖️ *TRIBUNAL ENCERRADO*\nAcusado: ${tag(caseFile.target)}\nMotivo: ${caseFile.reason}\nVotos: ${guilty} culpado(s) / ${innocent} inocente(s)\nVeredito: ${guilty === innocent ? 'Empate!' : guilty > innocent ? 'Culpado (de brincadeira)!' : 'Inocente!'}\n\nNenhuma ação real foi tomada.`, ctx.msg, { mentions: [caseFile.target] });
  }
  if (action !== 'abrir' && action !== 'julgar') {
    const mentioned = mentionIds(ctx.msg);
    if (mentioned.length !== 1) return ctx.send(ctx.jid, 'Marque exatamente uma pessoa: !tribunal @pessoa motivo.', ctx.msg);
    if (state.tribunal) return ctx.send(ctx.jid, 'Já existe um julgamento aberto.', ctx.msg);
    const target = mentioned[0];
    state.tribunal = { target, reason: cleanText(rest.join(' '), 300) || 'Acusação misteriosa', createdBy: senderId(ctx), createdAt: Date.now(), votes: {}, defenses: [] };
    return mentionsText(ctx, `⚖️ *TRIBUNAL ABERTO!*\nAcusado: ${tag(target)}\nMotivo: ${state.tribunal.reason}\nA pessoa pode usar !tribunal defesa texto. Todos podem votar com !tribunal voto culpado ou inocente. O criador pode encerrar com !tribunal encerrar.`, [target]);
  }
  return ctx.send(ctx.jid, 'Use !tribunal @pessoa motivo para abrir um julgamento.', ctx.msg);
}

async function reminderCommand(ctx, state, value) {
  const match = value.trim().match(/^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+([\s\S]+)$/);
  if (!match) return ctx.send(ctx.jid, '⏰ Uso: !lembrete DD/MM/AAAA HH:MM texto\nExemplo: !lembrete 20/11/2026 19:30 Ensaio da banda.', ctx.msg);
  const when = parseDateTime(match[1], match[2]);
  const message = cleanText(match[3], 350);
  if (!when || when <= Date.now() + 30_000) return ctx.send(ctx.jid, 'Data/hora inválida ou muito próxima. Use DD/MM/AAAA HH:MM no horário de Brasília e escolha pelo menos 30 segundos no futuro.', ctx.msg);
  const pending = state.reminders.filter(item => !item.sentAt && !item.cancelledAt);
  const byCreator = pending.filter(item => item.createdBy === senderId(ctx));
  if (pending.length >= 25 || byCreator.length >= 10) return ctx.send(ctx.jid, 'Limite atingido: até 25 lembretes pendentes por grupo e 10 por pessoa.', ctx.msg);
  const id = crypto.randomBytes(3).toString('hex').toUpperCase();
  state.reminders.push({ id, message, fireAt: when, createdBy: senderId(ctx), createdAt: Date.now(), sentAt: null, cancelledAt: null });
  return ctx.send(ctx.jid, `✅ Lembrete *${id}* agendado para ${dateText(when)}.\nCancelar: !cancelarlembrete ${id}\nListar: !lembretes`, ctx.msg);
}
async function listReminders(ctx, state) {
  const pending = state.reminders.filter(item => !item.sentAt && !item.cancelledAt).sort((a,b)=>a.fireAt-b.fireAt).slice(0,25);
  if (!pending.length) return ctx.send(ctx.jid, '📭 Não há lembretes pendentes neste grupo.', ctx.msg);
  return ctx.send(ctx.jid, '⏰ *LEMBRETES DO GRUPO*\n\n' + pending.map(item => `• *${item.id}* — ${dateText(item.fireAt)}\n  ${item.message}`).join('\n\n'), ctx.msg);
}
async function cancelReminder(ctx, state, value) {
  const id = cleanText(value, 20).toUpperCase();
  const item = state.reminders.find(row => row.id === id && !row.sentAt && !row.cancelledAt);
  if (!item) return ctx.send(ctx.jid, 'Não encontrei esse lembrete pendente.', ctx.msg);
  if (!canManageRecord(ctx, item) && !(await groupMetadata(ctx))) return true;
  item.cancelledAt = Date.now();
  return ctx.send(ctx.jid, `✅ Lembrete ${id} cancelado.`, ctx.msg);
}

function currentRoundMatches(tournament) {
  return Array.isArray(tournament?.matches) ? tournament.matches : [];
}
function advanceTournament(tournament) {
  let guard = 0;
  while (tournament && tournament.matches.length && tournament.matches.every(m => m.winner) && tournament.matches.length > 1 && guard++ < 20) {
    const winners = tournament.matches.map(m => m.winner);
    const next = [];
    for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i], b: winners[i+1] || null, winner: winners[i+1] ? null : winners[i] });
    tournament.round += 1;
    tournament.matches = next;
  }
  if (tournament?.matches?.length === 1 && tournament.matches[0].winner) tournament.champion = tournament.matches[0].winner;
}
async function tournamentCommand(ctx, state, value) {
  const parts = value.trim().split(/\s+/);
  const sub = normalize(parts.shift() || 'ajuda');
  const args = value.trim().slice((value.trim().match(/^\S+/)?.[0] || '').length).trim();
  let t = state.tournament;
  if (sub === 'ajuda' || !sub) return ctx.send(ctx.jid, '🏆 *CAMPEONATO*\n!campeonato criar nome — cria um torneio\n!campeonato entrar — entra\n!campeonato iniciar — sorteia a chave\n!campeonato jogos — mostra confrontos\n!campeonato resultado @vencedor — registra vencedor da partida\n!campeonato cancelar — cancela', ctx.msg);
  if (sub === 'criar') {
    if (t && !t.champion) return ctx.send(ctx.jid, 'Já existe um campeonato em andamento.', ctx.msg);
    const name = cleanText(args, 80) || 'Campeonato do grupo';
    state.tournament = { name, createdBy: senderId(ctx), createdAt: Date.now(), phase: 'lobby', players: [senderId(ctx)], round: 0, matches: [], champion: null };
    return ctx.send(ctx.jid, `🏆 Campeonato *${name}* criado! Use !campeonato entrar para participar. O organizador inicia com !campeonato iniciar. Máximo: 16 jogadores.`, ctx.msg);
  }
  if (!t) return ctx.send(ctx.jid, 'Não há campeonato ativo. Use !campeonato criar nome.', ctx.msg);
  if (sub === 'entrar') {
    if (t.phase !== 'lobby') return ctx.send(ctx.jid, 'As inscrições já terminaram.', ctx.msg);
    if (t.players.includes(senderId(ctx))) return ctx.send(ctx.jid, 'Você já está inscrito.', ctx.msg);
    if (t.players.length >= 16) return ctx.send(ctx.jid, 'O campeonato aceita no máximo 16 jogadores.', ctx.msg);
    t.players.push(senderId(ctx));
    return ctx.send(ctx.jid, `✅ Inscrição confirmada! ${t.players.length}/16 jogadores.`, ctx.msg);
  }
  if (sub === 'sair') {
    if (t.phase !== 'lobby') return ctx.send(ctx.jid, 'Não é possível sair depois que a chave começou.', ctx.msg);
    t.players = t.players.filter(id => id !== senderId(ctx));
    return ctx.send(ctx.jid, 'Você saiu do campeonato.', ctx.msg);
  }
  if (sub === 'iniciar') {
    if (t.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    if (t.phase !== 'lobby' || t.players.length < 2) return ctx.send(ctx.jid, 'O campeonato precisa de pelo menos 2 jogadores e ainda deve estar em inscrições.', ctx.msg);
    const players = shuffle(t.players);
    t.matches = [];
    for (let i=0;i<players.length;i+=2) t.matches.push({ a: players[i], b: players[i+1] || null, winner: players[i+1] ? null : players[i] });
    t.phase = 'playing'; t.round = 1; advanceTournament(t);
    return ctx.send(ctx.jid, `🏆 *${t.name}* começou!\n${formatMatches(t)}\nRegistre o resultado com !campeonato resultado @vencedor.`, ctx.msg);
  }
  if (sub === 'jogos') return ctx.send(ctx.jid, t.champion ? `🏆 Campeão: ${tag(t.champion)}` : `🏆 *${t.name} — Rodada ${t.round || 'inscrições'}*\n${t.phase === 'lobby' ? `Inscritos: ${t.players.length}\n${t.players.map(tag).join(', ')}` : formatMatches(t)}`, ctx.msg, { mentions: t.players });
  if (sub === 'resultado') {
    if (t.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    const ids = mentionIds(ctx.msg);
    if (ids.length !== 1) return ctx.send(ctx.jid, 'Marque exatamente o vencedor: !campeonato resultado @pessoa.', ctx.msg);
    const winner = t.players.find(id => aliasesMatch(idAliases(id), idAliases(ids[0])));
    if (!winner) return ctx.send(ctx.jid, 'Essa pessoa não está inscrita no campeonato.', ctx.msg);
    const match = t.matches.find(m => !m.winner && [m.a,m.b].some(id => aliasesMatch(idAliases(id), idAliases(winner))));
    if (!match) return ctx.send(ctx.jid, 'Esse jogador não tem uma partida pendente nesta rodada.', ctx.msg);
    match.winner = winner;
    advanceTournament(t);
    if (t.champion) return ctx.send(ctx.jid, `🏆 *CAMPEÃO: ${tag(t.champion)}!* Parabéns!`, ctx.msg, { mentions: [t.champion] });
    return ctx.send(ctx.jid, `✅ Resultado registrado.\n${formatMatches(t)}`, ctx.msg, { mentions: t.players });
  }
  if (sub === 'cancelar') {
    if (t.createdBy !== senderId(ctx) && !(await groupMetadata(ctx))) return true;
    state.tournament = null;
    return ctx.send(ctx.jid, 'Campeonato cancelado.', ctx.msg);
  }
  return ctx.send(ctx.jid, 'Subcomando inválido. Use !campeonato ajuda.', ctx.msg);
}
function formatMatches(t) {
  return t.matches.map((m,i)=>`${i+1}. ${tag(m.a)} vs ${m.b ? tag(m.b) : 'folga'} — ${m.winner ? `vencedor: ${tag(m.winner)}` : 'aguardando resultado'}`).join('\n');
}

export async function handleYamadaFunCommand(ctx) {
  if (!YAMADA_FUN_COMMANDS.includes(String(ctx.command || '').toLowerCase())) return false;
  if (!isGroup(ctx)) { await ctx.send(ctx.jid, 'Este comando funciona dentro de grupos.', ctx.msg); return true; }
  try {
    const data = readState();
    const state = groupState(data, ctx.jid);
    const command = String(ctx.command).toLowerCase();
    const value = String(ctx.value || '');
    let handled = true;
    if (command === 'impostor') await impostorCommand(ctx, state, value);
    else if (command === 'stop') await stopCommand(ctx, state, value);
    else if (command === 'tribunal') await tribunalCommand(ctx, state, value);
    else if (command === 'lembrete') await reminderCommand(ctx, state, value);
    else if (command === 'lembretes') await listReminders(ctx, state);
    else if (command === 'cancelarlembrete') await cancelReminder(ctx, state, value);
    else if (command === 'campeonato') await tournamentCommand(ctx, state, value);
    else handled = false;
    if (handled) saveState(data);
    return handled;
  } catch (error) {
    console.error(`[YAMADA FUN ${ctx.command}]`, error?.stack || error);
    await ctx.send(ctx.jid, `❌ Não consegui executar esse comando: ${String(error?.message || error).slice(0, 180)}`, ctx.msg);
    return true;
  }
}

export function startYamadaFunScheduler(sock) {
  schedulerSock = sock || schedulerSock;
  if (scheduler) return true;
  const tick = async () => {
    const data = readState();
    let changed = false;
    const due = [];
    for (const [jid, state] of Object.entries(data.groups || {})) {
      for (const reminder of state.reminders || []) {
        if (reminder.sentAt || reminder.cancelledAt || Number(reminder.fireAt) > Date.now()) continue;
        reminder.sentAt = Date.now();
        changed = true;
        due.push({ jid, reminder });
      }
      // Rodadas de STOP expiradas continuam disponíveis até !stop finalizar.
    }
    // Marca os lembretes como enviados antes de tentar enviar, evitando duplicação após reinício.
    if (changed) saveState(data);
    for (const { jid, reminder } of due) {
      const message = `⏰ *LEMBRETE DO GRUPO*\n\n${reminder.message}\n\nAgendado para: ${dateText(reminder.fireAt)}\nID: ${reminder.id}`;
      try { await schedulerSock?.sendMessage(jid, { text: message }); }
      catch (error) { console.warn('[LEMBRETE] Falha ao enviar:', error?.message || error); }
    }
  };
  tick().catch(error => console.warn('[YAMADA FUN] Scheduler:', error?.message || error));
  scheduler = setInterval(() => tick().catch(error => console.warn('[YAMADA FUN] Scheduler:', error?.message || error)), REMINDER_TICK_MS);
  scheduler.unref?.();
  return true;
}
