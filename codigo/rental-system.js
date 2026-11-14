import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE = path.resolve(process.env.LEO_RENTAL_DATA_FILE || './rental-data.json');
const ENFORCEMENT = /^(true|1|on|yes)$/i.test(String(process.env.RENTAL_ENFORCEMENT_ENABLED || 'false').trim());
const DAY_MS = 24 * 60 * 60 * 1000;

function readPrice(envName, fallback) {
  const value = Number(String(process.env[envName] || '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : fallback;
}
const PLANS = Object.freeze({
  basic: { name: 'Basic', value: readPrice('LS_PRICE_BASIC', 14.90), description: 'Recursos básicos de figurinhas e biblioteca compartilhada.' },
  pro: { name: 'Pro', value: readPrice('LS_PRICE_PRO', 24.90), description: 'Recursos de figurinhas, animação, biblioteca inteligente, jogos e economia conforme disponibilidade.' },
  premium: { name: 'Premium', value: readPrice('LS_PRICE_PREMIUM', 39.90), description: 'Recursos Pro e opções avançadas de personalização e suporte.' }
});
let currentSock = null;
let expiryTimer = null;

function emptyState() { return { version: 2, requests: {}, licenses: {}, updatedAt: null }; }
function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state || typeof state !== 'object') return emptyState();
    state.requests ||= {};
    state.licenses ||= {};
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[ALUGUEL] Não consegui ler o banco:', error.message);
    return emptyState();
  }
}
function saveState(state) {
  state.version = 2;
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}
function normalizeJid(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw.split(':')[0].replace(/\D/g, '') + '@s.whatsapp.net';
  return `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`;
}
function money(value) { return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function addOneMonth(date) {
  const source = new Date(date);
  const year = source.getUTCFullYear(), month = source.getUTCMonth(), day = source.getUTCDate();
  const next = new Date(Date.UTC(year, month + 1, 1, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds()));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}
function planText() {
  return ['🦊 PLANOS LÉO STICKERS — mensal', '',
    ...Object.entries(PLANS).map(([key, p]) => `• *${p.name}* — ${money(p.value)}\n  !alugar ${key}\n  ${p.description}`),
    '', 'A contratação é por aprovação manual. Após solicitar, envie o comprovante diretamente ao responsável pelo bot. A licença só é ativada após conferência.'].join('\n');
}
function pendingForGroup(state, groupJid) {
  return Object.values(state.requests).filter(r => r.groupJid === groupJid && r.status === 'pending').sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}
async function isRequesterGroupAdmin(ctx) {
  if (ctx.isOwner?.(ctx.sender)) return true;
  if (!String(ctx.jid || '').endsWith('@g.us')) return false;
  const metadata = await ctx.sock.groupMetadata(ctx.jid);
  const sender = normalizeJid(ctx.sender || ctx.msg?.key?.participant);
  return (metadata.participants || []).some(p => [p.id,p.jid,p.phoneNumber,p.lid].map(normalizeJid).includes(sender) && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin));
}
async function notifyOwner(ctx, message) {
  const owner = normalizeJid(ctx.ownerNumber);
  if (!owner || owner === normalizeJid(ctx.sender)) {
    await ctx.send(ctx.jid, '⚠️ Solicitação registrada, mas não consegui localizar o contato do proprietário para avisá-lo. Avise-o manualmente.', ctx.msg);
    return;
  }
  await ctx.sock.sendMessage(owner, { text: message }).catch(async error => {
    console.warn('[ALUGUEL] Não consegui avisar o proprietário:', error?.message || error);
    await ctx.send(ctx.jid, '⚠️ Solicitação registrada, mas o aviso privado ao proprietário falhou. Avise-o manualmente.', ctx.msg);
  });
}
async function createManualRequest(ctx, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error('Plano inválido. Escolha basic, pro ou premium.');
  if (!String(ctx.jid || '').endsWith('@g.us')) throw new Error('Use este comando dentro do grupo que deseja ativar.');
  if (!(await isRequesterGroupAdmin(ctx))) throw new Error('Somente um administrador do grupo pode solicitar o aluguel.');
  const state = loadState();
  const existing = pendingForGroup(state, ctx.jid);
  if (existing) {
    await ctx.send(ctx.jid, `⏳ Já existe uma solicitação aguardando aprovação.\nCódigo: *${existing.code}*\nPlano: *${existing.planName}*\nValor: *${money(existing.value)}*\n\nEnvie o comprovante ao responsável e aguarde a conferência.`, ctx.msg);
    return true;
  }
  const code = `LS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const request = { code, groupJid: ctx.jid, requesterJid: normalizeJid(ctx.sender), plan: planKey, planName: plan.name, value: plan.value, status: 'pending', createdAt: new Date().toISOString() };
  state.requests[code] = request;
  saveState(state);
  await ctx.send(ctx.jid, `📝 *SOLICITAÇÃO DE ALUGUEL REGISTRADA*\n\nPlano: *${plan.name}*\nValor: *${money(plan.value)} / mês*\nCódigo: *${code}*\n\nAgora envie o comprovante diretamente ao responsável pelo Léo Stickers, informando esse código. A ativação será manual após a conferência.`, ctx.msg);
  await notifyOwner(ctx, `🦊 *NOVA SOLICITAÇÃO DE ALUGUEL*\n\nGrupo: ${ctx.jid}\nSolicitante: ${request.requesterJid}\nPlano: ${plan.name}\nValor informado: ${money(plan.value)} / mês\nCódigo: *${code}*\n\nApós conferir o pagamento fora do bot, use !aprovaraluguel ${code} ou !recusaraluguel ${code}.`);
  return true;
}
function licenseSummary(groupJid) {
  const license = loadState().licenses[groupJid];
  if (!license) return '📭 Este grupo ainda não possui aluguel registrado.';
  const active = license.status === 'active' && Date.parse(license.expiresAt || '') > Date.now();
  return [`🦊 ALUGUEL — ${license.planName || license.plan}`, `Status: ${active ? '🟢 ATIVO' : '🔴 EXPIRADO/INATIVO'}`, `Válido até: ${new Date(license.expiresAt).toLocaleString('pt-BR')}`].join('\n');
}
async function listRentals(ctx) {
  if (!ctx.isOwner?.(ctx.sender)) { await ctx.send(ctx.jid, '❌ Comando exclusivo do proprietário do bot.', ctx.msg); return true; }
  const state = loadState();
  const pending = Object.values(state.requests).filter(r => r.status === 'pending');
  const licenses = Object.values(state.licenses);
  const active = licenses.filter(l => l.status === 'active' && Date.parse(l.expiresAt || '') > Date.now());
  const lines = [`🦊 CLIENTES / ALUGUÉIS`, `Licenças ativas: ${active.length}`, `Solicitações pendentes: ${pending.length}`, '', 'PENDENTES:', ...pending.slice(-30).reverse().map(r => `• ${r.code} — ${r.planName} — ${money(r.value)} — ${r.groupJid}`), '', 'LICENÇAS:', ...licenses.slice(-30).reverse().map(l => `• ${l.groupJid} — ${l.planName || l.plan} — ${l.status} — até ${new Date(l.expiresAt).toLocaleDateString('pt-BR')}`)];
  await ctx.send(ctx.jid, lines.join('\n').slice(0, 3500), ctx.msg);
  return true;
}
async function decideRequest(ctx, code, approve) {
  if (!ctx.isOwner?.(ctx.sender)) { await ctx.send(ctx.jid, '❌ Comando exclusivo do proprietário do bot.', ctx.msg); return true; }
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) { await ctx.send(ctx.jid, `Use !${approve ? 'aprovaraluguel' : 'recusaraluguel'} CÓDIGO. Consulte !clientes para ver os pendentes.`, ctx.msg); return true; }
  const state = loadState();
  const request = state.requests[normalized];
  if (!request || request.status !== 'pending') { await ctx.send(ctx.jid, '❌ Solicitação não encontrada ou já processada. Consulte !clientes.', ctx.msg); return true; }
  request.status = approve ? 'approved' : 'rejected';
  request.decidedAt = new Date().toISOString();
  request.decidedBy = normalizeJid(ctx.sender);
  if (approve) {
    const previous = state.licenses[request.groupJid];
    const now = new Date();
    const base = previous?.status === 'active' && Date.parse(previous.expiresAt || '') > now.getTime() ? new Date(previous.expiresAt) : now;
    const expiresAt = addOneMonth(base).toISOString();
    state.licenses[request.groupJid] = { groupJid: request.groupJid, plan: request.plan, planName: request.planName, status: 'active', startedAt: previous?.startedAt || now.toISOString(), expiresAt, approvedAt: now.toISOString(), approvedRequest: normalized };
  }
  saveState(state);
  await ctx.send(ctx.jid, approve ? `✅ Solicitação ${normalized} aprovada. Licença ${request.planName} ativada para ${request.groupJid}.` : `⛔ Solicitação ${normalized} recusada.`, ctx.msg);
  const message = approve ? `🦊✅ *ALUGUEL APROVADO!*\nPlano: ${request.planName}\nAcesso liberado até: ${new Date(state.licenses[request.groupJid].expiresAt).toLocaleDateString('pt-BR')}.` : `❌ A solicitação de aluguel ${normalized} foi recusada. Entre em contato com o responsável se precisar de esclarecimentos.`;
  await ctx.sock.sendMessage(request.groupJid, { text: message }).catch(error => console.warn('[ALUGUEL] Falha ao avisar grupo:', error?.message || error));
  return true;
}
async function manageLicense(ctx, action, value) {
  if (!ctx.isOwner?.(ctx.sender)) { await ctx.send(ctx.jid, '❌ Comando exclusivo do proprietário do bot.', ctx.msg); return true; }
  const target = String(value || '').trim() || (String(ctx.jid).endsWith('@g.us') ? ctx.jid : '');
  if (!target) { await ctx.send(ctx.jid, `Use !${action} ID_DO_GRUPO.`, ctx.msg); return true; }
  const state = loadState(), license = state.licenses[target];
  if (!license) { await ctx.send(ctx.jid, 'Não encontrei licença para esse grupo.', ctx.msg); return true; }
  license.status = 'revoked'; license.revokedAt = new Date().toISOString(); saveState(state);
  await ctx.send(ctx.jid, `✅ Licença revogada para ${target}.`, ctx.msg);
  return true;
}

export function isRentalEnforcementEnabled() { return ENFORCEMENT; }
export function hasActiveRental(groupJid) {
  if (!String(groupJid || '').endsWith('@g.us')) return false;
  const license = loadState().licenses[groupJid];
  return Boolean(license && license.status === 'active' && Date.parse(license.expiresAt || '') > Date.now());
}
export function isRentalExemptCommand(command) {
  return new Set(['planos','alugar','meualuguel','info','menu','ajuda','help','regrasgrupo','regras','entrada','autoaceitar','autoaprovarsolicitacao','solicitacoes','aprovarsolicitacao','recusarsolicitacao','statusbiblioteca','clientes','aluguéis','alugueis','renovar','revogar','revogarrental','aprovaraluguel','recusaraluguel']).has(String(command || '').toLowerCase());
}
export async function handleRentalCommand(ctx) {
  const command = String(ctx.command || '').toLowerCase();
  if (command === 'planos') { await ctx.send(ctx.jid, planText(), ctx.msg); return true; }
  if (command === 'alugar' || command === 'renovar') {
    const current = loadState().licenses[ctx.jid];
    const plan = String(ctx.value || current?.plan || 'pro').trim().toLowerCase();
    try { return await createManualRequest(ctx, plan); }
    catch (error) { await ctx.send(ctx.jid, `❌ Não consegui registrar a solicitação: ${String(error?.message || error).slice(0, 220)}`, ctx.msg); return true; }
  }
  if (command === 'meualuguel') {
    if (!String(ctx.jid || '').endsWith('@g.us')) await ctx.send(ctx.jid, 'Use !meualuguel dentro do grupo.', ctx.msg);
    else await ctx.send(ctx.jid, licenseSummary(ctx.jid), ctx.msg);
    return true;
  }
  if (command === 'clientes' || command === 'aluguéis' || command === 'alugueis') return listRentals(ctx);
  if (command === 'aprovaraluguel') return decideRequest(ctx, ctx.value, true);
  if (command === 'recusaraluguel') return decideRequest(ctx, ctx.value, false);
  if (command === 'revogar' || command === 'revogarrental') return manageLicense(ctx, command, ctx.value);
  return false;
}
export function startRentalScheduler(sock) {
  currentSock = sock || currentSock;
  if (expiryTimer) return true;
  const run = async () => {
    const state = loadState(); let changed = false; const now = Date.now();
    for (const license of Object.values(state.licenses)) {
      if (license.status !== 'active') continue;
      const expiresAt = Date.parse(license.expiresAt || ''); if (!Number.isFinite(expiresAt)) continue;
      if (expiresAt <= now) {
        license.status = 'expired'; license.expiredAt ||= new Date(now).toISOString(); changed = true;
        if (!license.expiredNotifiedAt && currentSock) {
          await currentSock.sendMessage(license.groupJid, { text: '⏰ O aluguel do Léo Stickers expirou. Um administrador pode consultar !planos e solicitar a renovação com !renovar.' }).catch(error => console.warn('[ALUGUEL] Falha ao avisar expiração:', error?.message || error));
          license.expiredNotifiedAt = new Date(now).toISOString();
        }
      } else if (expiresAt - now <= 3 * DAY_MS && expiresAt - now > 0) {
        const key = new Date(expiresAt).toISOString();
        if (license.lastReminderForExpiry !== key && currentSock) {
          await currentSock.sendMessage(license.groupJid, { text: `🔔 O aluguel do Léo Stickers vence em breve (${new Date(expiresAt).toLocaleDateString('pt-BR')}). Um administrador pode usar !renovar para solicitar a renovação.` }).catch(error => console.warn('[ALUGUEL] Falha ao avisar vencimento:', error?.message || error));
          license.lastReminderForExpiry = key; changed = true;
        }
      }
    }
    if (changed) saveState(state);
  };
  run().catch(error => console.error('[ALUGUEL] Erro ao verificar vencimentos:', error?.stack || error));
  expiryTimer = setInterval(() => run().catch(error => console.error('[ALUGUEL] Erro ao verificar vencimentos:', error?.stack || error)), 60 * 60 * 1000);
  expiryTimer.unref?.(); return true;
}
export const __test = { normalizeJid, addOneMonth, PLANS, hasActiveRental };
