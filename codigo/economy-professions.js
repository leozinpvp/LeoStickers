// LEO_ECONOMY_PROFESSIONS_V1
// LEO_ECONOMY_COMMERCE_V2
import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = path.resolve('./economia-data.json');
const TIME_ZONE = 'America/Sao_Paulo';
const INITIAL_BALANCE = 500;
const DAILY_REWARD = 300;
const BANK_RATE = 0.002;
const BANK_INTEREST_CAP = 100000;
const WORK_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const MAX_TRANSACTIONS = 40;
const MAX_SECONDARY_PROFESSIONS = 2;

export const ECONOMY_COMMANDS = Object.freeze([
  'menueconomia', 'economia', 'saldo', 'banco', 'depositar', 'sacar',
  'extrato', 'diaria', 'trabalhar', 'profissoes', 'escolherprofissao',
  'confirmarprofissao', 'secundaria', 'confirmarsecundaria', 'minhaprofissao',
  'loja', 'item', 'comprar', 'inventario', 'equipar',
  'mercado', 'anunciar', 'compraroferta', 'cancelarvenda', 'transferir'
]);

const PROFESSIONS = Object.freeze({
  ferreiro: {
    name: 'Ferreiro', emoji: '⚒️', activity: 'forja',
    summary: 'Fabrica ferramentas, armas e equipamentos.',
    buff: { activity: 'forja', percent: 20, label: 'fabricação e forja' },
    debuff: { activity: 'exploracao', percent: 15, label: 'exploração e busca de tesouros' },
    difficulty: 'Média', potential: 'Alto', synergy: 'Minerador e Explorador'
  },
  comerciante: {
    name: 'Comerciante', emoji: '🪙', activity: 'comercio',
    summary: 'Compra, vende e negocia produtos no mercado.',
    buff: { activity: 'comercio', percent: 15, label: 'negociações e vendas' },
    debuff: { activity: 'forja', percent: 10, label: 'fabricação de equipamentos' },
    difficulty: 'Fácil', potential: 'Alto', synergy: 'Explorador e Fazendeiro'
  },
  explorador: {
    name: 'Explorador', emoji: '🧭', activity: 'exploracao',
    summary: 'Explora regiões, encontra materiais e descobre tesouros.',
    buff: { activity: 'exploracao', percent: 20, label: 'exploração e descobertas' },
    debuff: { activity: 'comercio', percent: 15, label: 'comércio e negociações' },
    difficulty: 'Média', potential: 'Alto', synergy: 'Minerador e Comerciante'
  },
  alquimista: {
    name: 'Alquimista', emoji: '⚗️', activity: 'alquimia',
    summary: 'Prepara poções, misturas e consumíveis especiais.',
    buff: { activity: 'alquimia', percent: 15, label: 'produção de poções' },
    debuff: { activity: 'mineracao', percent: 10, label: 'mineração e extração' },
    difficulty: 'Alta', potential: 'Alto', synergy: 'Fazendeiro e Minerador'
  },
  fazendeiro: {
    name: 'Fazendeiro', emoji: '🌾', activity: 'agricultura',
    summary: 'Planta, colhe e produz alimentos e recursos naturais.',
    buff: { activity: 'agricultura', percent: 20, label: 'agricultura e colheitas' },
    debuff: { activity: 'engenharia', percent: 15, label: 'engenharia e máquinas' },
    difficulty: 'Fácil', potential: 'Médio', synergy: 'Alquimista e Comerciante'
  },
  minerador: {
    name: 'Minerador', emoji: '⛏️', activity: 'mineracao',
    summary: 'Extrai minérios, cristais e pedras raras.',
    buff: { activity: 'mineracao', percent: 20, label: 'mineração e extração' },
    debuff: { activity: 'comercio', percent: 15, label: 'comércio e negociações' },
    difficulty: 'Média', potential: 'Alto', synergy: 'Ferreiro e Alquimista'
  },
  pescador: {
    name: 'Pescador', emoji: '🎣', activity: 'pesca',
    summary: 'Pesca, encontra espécies raras e coleta tesouros aquáticos.',
    buff: { activity: 'pesca', percent: 20, label: 'pesca e coleta aquática' },
    debuff: { activity: 'forja', percent: 15, label: 'fabricação e forja' },
    difficulty: 'Fácil', potential: 'Médio', synergy: 'Comerciante e Explorador'
  },
  engenheiro: {
    name: 'Engenheiro', emoji: '⚙️', activity: 'engenharia',
    summary: 'Projeta máquinas, mecanismos e dispositivos.',
    buff: { activity: 'engenharia', percent: 20, label: 'engenharia e construção' },
    debuff: { activity: 'agricultura', percent: 15, label: 'agricultura e colheitas' },
    difficulty: 'Alta', potential: 'Alto', synergy: 'Minerador e Ferreiro'
  }
});

const ACTIVITY_LABELS = Object.freeze({
  forja: 'forja', comercio: 'comércio', exploracao: 'exploração',
  alquimia: 'alquimia', agricultura: 'agricultura', mineracao: 'mineração',
  pesca: 'pesca', engenharia: 'engenharia'
});

const ALIASES = Object.freeze({
  forja: 'ferreiro', ferreiro: 'ferreiro', smith: 'ferreiro',
  comercio: 'comerciante', comerciante: 'comerciante', vendas: 'comerciante',
  exploracao: 'explorador', explorar: 'explorador', explorador: 'explorador',
  alquimia: 'alquimista', alquimista: 'alquimista', pocoes: 'alquimista',
  agricultura: 'fazendeiro', fazenda: 'fazendeiro', fazendeiro: 'fazendeiro',
  mineracao: 'minerador', minerador: 'minerador', mina: 'minerador',
  pesca: 'pescador', pescador: 'pescador',
  engenharia: 'engenheiro', engenheiro: 'engenheiro', maquinas: 'engenheiro'
});

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '');
}

function currentDay() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayNumber(day) {
  const value = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(value) ? Math.floor(value / 86400000) : 0;
}

function formatLC(value) {
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Math.max(0, Math.floor(Number(value) || 0)))} LC`;
}

function playerId(ctx) {
  const raw = String(ctx.sender || ctx.msg?.key?.participant || ctx.msg?.key?.remoteJid || '').trim();
  if (!raw) return '';
  return raw.replace(/:\d+(?=@)/, '').toLowerCase();
}

function defaultState() {
  return { version: 2, players: {}, marketOffers: [], nextOfferId: 1, marketTreasury: 0 };
}

function readState() {
  if (!fs.existsSync(DATA_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('estrutura raiz inválida');
    }
    if (!parsed.players || typeof parsed.players !== 'object' || Array.isArray(parsed.players)) {
      throw new Error('campo players inválido');
    }
    parsed.version = 2;
    parsed.marketOffers = Array.isArray(parsed.marketOffers) ? parsed.marketOffers.filter(offer => offer && typeof offer === 'object' && typeof offer.id === 'string' && typeof offer.sellerId === 'string' && typeof offer.item === 'string') : [];
    parsed.nextOfferId = Math.max(1, Math.floor(Number(parsed.nextOfferId) || 1));
    parsed.marketTreasury = Math.max(0, Math.floor(Number(parsed.marketTreasury) || 0));
    return parsed;
  } catch (error) {
    throw new Error(`O arquivo economia-data.json não pôde ser lido (${error.message}). Ele foi preservado; não vou sobrescrever seus dados.`);
  }
}

function saveState(state) {
  const tempPath = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(tempPath, DATA_FILE);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function createPlayer(id, displayName) {
  const now = new Date().toISOString();
  return {
    id,
    name: String(displayName || 'Jogador').slice(0, 40),
    wallet: INITIAL_BALANCE,
    bank: 0,
    createdAt: now,
    lastInterestDay: currentDay(),
    dailyClaimedDay: null,
    workCooldownUntil: 0,
    primaryProfession: null,
    secondaryProfessions: [],
    pendingPrimaryProfession: null,
    pendingSecondaryProfession: null,
    professionProgress: {},
    card: { showWallet: false, avatarMode: 'whatsapp', avatarId: 'default', frame: 'common', background: 'default' },
    transactions: [{ at: now, type: 'inicial', amount: INITIAL_BALANCE, walletAfter: INITIAL_BALANCE, bankAfter: 0, detail: 'Capital inicial do Léo Stickers' }]
  };
}

function ensurePlayer(state, ctx) {
  const id = playerId(ctx);
  if (!id) throw new Error('Não consegui identificar seu número no WhatsApp.');
  let created = false;
  if (!state.players[id]) {
    state.players[id] = createPlayer(id, ctx.msg?.pushName);
    created = true;
  }
  const player = state.players[id];
  if (ctx.msg?.pushName && player.name !== ctx.msg.pushName) {
    player.name = String(ctx.msg.pushName).slice(0, 40);
  }
  player.wallet = Math.max(0, Math.floor(Number(player.wallet) || 0));
  player.bank = Math.max(0, Math.floor(Number(player.bank) || 0));
  player.secondaryProfessions = Array.isArray(player.secondaryProfessions) ? player.secondaryProfessions : [];
  player.professionProgress ||= {};
  player.transactions = Array.isArray(player.transactions) ? player.transactions : [];
  player.inventory = player.inventory && typeof player.inventory === 'object' && !Array.isArray(player.inventory) ? player.inventory : {};
  player.card ||= { showWallet: false, avatarMode: 'whatsapp', avatarId: 'default', frame: 'common', background: 'default' };
  return { id, player, created };
}

function addTransaction(player, type, amount, detail) {
  player.transactions.push({
    at: new Date().toISOString(),
    type,
    amount: Math.trunc(amount),
    walletAfter: player.wallet,
    bankAfter: player.bank,
    detail: String(detail || '').slice(0, 140)
  });
  if (player.transactions.length > MAX_TRANSACTIONS) {
    player.transactions.splice(0, player.transactions.length - MAX_TRANSACTIONS);
  }
}

function accrueInterest(player) {
  const today = currentDay();
  const previous = typeof player.lastInterestDay === 'string' ? player.lastInterestDay : today;
  const elapsed = Math.max(0, Math.min(3650, dayNumber(today) - dayNumber(previous)));
  if (elapsed === 0) return 0;

  let earned = 0;
  for (let day = 0; day < elapsed; day++) {
    const interest = Math.round(Math.min(player.bank, BANK_INTEREST_CAP) * BANK_RATE);
    if (interest > 0) {
      player.bank += interest;
      earned += interest;
    }
  }
  player.lastInterestDay = today;
  if (earned > 0) addTransaction(player, 'juros', earned, `Rendimento bancário acumulado por ${elapsed} dia(s)`);
  return earned;
}

function professionProgress(player, slug) {
  player.professionProgress[slug] ||= { level: 1, xp: 0 };
  const progress = player.professionProgress[slug];
  progress.level = Math.max(1, Math.min(50, Math.floor(Number(progress.level) || 1)));
  progress.xp = Math.max(0, Math.floor(Number(progress.xp) || 0));
  return progress;
}

function addProfessionXp(player, slug, amount) {
  if (!slug || !PROFESSIONS[slug]) return null;
  const progress = professionProgress(player, slug);
  progress.xp += amount;
  let leveled = false;
  while (progress.level < 50 && progress.xp >= progress.level * 100) {
    progress.xp -= progress.level * 100;
    progress.level++;
    leveled = true;
  }
  if (progress.level >= 50) progress.xp = Math.min(progress.xp, 4999);
  return { ...progress, leveled };
}

function resolveProfession(value) {
  return ALIASES[normalize(value)] || (PROFESSIONS[normalize(value)] ? normalize(value) : null);
}

function progressText(player, slug) {
  const info = professionProgress(player, slug);
  const needed = info.level >= 50 ? 0 : info.level * 100;
  return `Nível ${info.level}${info.level < 50 ? ` • ${info.xp}/${needed} XP` : ' • NÍVEL MÁXIMO'}`;
}

function professionDetails(slug, player = null) {
  const p = PROFESSIONS[slug];
  if (!p) return '';
  const progress = player ? `\n📈 Sua evolução: ${progressText(player, slug)}` : '';
  return `${p.emoji} *${p.name.toUpperCase()}*\n${p.summary}\n\n🟢 *BUFF*\n+${p.buff.percent}% em ${p.buff.label}.\n\n🔴 *DEBUFF*\n-${p.debuff.percent}% em ${p.debuff.label}.\n\n🎯 Dificuldade: ${p.difficulty}\n💰 Potencial econômico: ${p.potential}\n🤝 Combina com: ${p.synergy}${progress}\n\nPara solicitar: !escolherprofissao ${slug}`;
}

function professionList() {
  const lines = Object.entries(PROFESSIONS).map(([slug, p], index) =>
    `${index + 1}. ${p.emoji} *${p.name}* — +${p.buff.percent}% ${p.buff.label}; -${p.debuff.percent}% ${p.debuff.label}.\n   Ver ficha: !profissoes ${slug}`
  );
  return `🧰 *PROFISSÕES DO LÉO STICKERS*\n\nCada carreira tem um buff e um debuff. A profissão principal recebe 100% dos efeitos; as secundárias recebem metade dos bônus e das penalidades.\n\n${lines.join('\n\n')}\n\nEscolha com !escolherprofissao nome. A escolha só será aplicada depois de !confirmarprofissao.`;
}

function parseAmount(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return 0;
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) return 0;
  return amount;
}

function welcomeLine(created) {
  return created ? `🎉 Seu perfil econômico foi criado! Você recebeu ${formatLC(INITIAL_BALANCE)} de capital inicial.\n\n` : '';
}

async function reply(ctx, message) {
  return ctx.send(ctx.jid, message, ctx.msg);
}


// ===== LEO ECONOMIA V2: LOJA, INVENTÁRIO, MERCADO E TRANSFERÊNCIAS =====
const TRANSFER_MAX_SINGLE = 2000;
const TRANSFER_MAX_DAILY = 5000;
const MARKET_FEE_PERCENT = 3;
const MAX_MARKET_QUANTITY = 99;

const STORE_ITEMS = Object.freeze({
  'avatar-raposa': {
    name: 'Avatar Raposa', emoji: '🦊', price: 1500, type: 'avatar',
    description: 'Avatar exclusivo de raposa para personalizar seu cartão de jogador.',
    asset: 'assets/economia/loja/avatar-raposa.png'
  },
  'moldura-neon': {
    name: 'Moldura Neon', emoji: '💠', price: 700, type: 'frame', frame: 'neon',
    description: 'Moldura com visual neon para seu cartão.',
    asset: 'assets/economia/loja/moldura-neon.png'
  },
  'moldura-dourada': {
    name: 'Moldura Dourada', emoji: '🥇', price: 1200, type: 'frame', frame: 'gold',
    description: 'Moldura dourada para destacar seu perfil.',
    asset: 'assets/economia/loja/moldura-dourada.png'
  },
  'moldura-galactica': {
    name: 'Moldura Galáctica', emoji: '🌌', price: 2000, type: 'frame', frame: 'galactic',
    description: 'Moldura especial com tema galáctico.',
    asset: 'assets/economia/loja/moldura-galactica.png'
  },
  'bau-misterioso': {
    name: 'Baú Misterioso', emoji: '🧰', price: 350, type: 'collectible',
    description: 'Item colecionável. Nesta versão ele não é aberto nem gera recompensas aleatórias.',
    asset: 'assets/economia/ui/bau-misterioso.png'
  },
  'cristal-raro': {
    name: 'Cristal Raro', emoji: '💎', price: 600, type: 'collectible',
    description: 'Cristal colecionável para seu inventário.',
    asset: 'assets/economia/ui/cristal-raro.png'
  },
  'trofeu-premium': {
    name: 'Troféu Premium', emoji: '🏆', price: 1500, type: 'collectible',
    description: 'Troféu colecionável de edição premium.',
    asset: 'assets/economia/ui/trofeu-premium.png'
  },
  'emblema-lendario': {
    name: 'Emblema Lendário', emoji: '🔱', price: 2500, type: 'collectible',
    description: 'Emblema colecionável de raridade lendária.',
    asset: 'assets/economia/ui/emblema-lendario.png'
  }
});

function ensureEconomyState(state) {
  if (!Array.isArray(state.marketOffers)) state.marketOffers = [];
  state.nextOfferId = Math.max(1, Math.floor(Number(state.nextOfferId) || 1));
  state.marketTreasury = Math.max(0, Math.floor(Number(state.marketTreasury) || 0));
}

function resolveStoreItem(value) {
  const key = normalize(value).replace(/-/g, '');
  return Object.keys(STORE_ITEMS).find(slug => normalize(slug) === key || normalize(STORE_ITEMS[slug].name) === key) || null;
}

function inventoryCount(player, slug) {
  return Math.max(0, Math.floor(Number(player.inventory?.[slug]) || 0));
}

function changeInventory(player, slug, delta) {
  player.inventory ||= {};
  const next = inventoryCount(player, slug) + Math.trunc(delta);
  if (next > 0) player.inventory[slug] = next;
  else delete player.inventory[slug];
}

function itemIsEquipped(player, slug) {
  const item = STORE_ITEMS[slug];
  if (!item) return false;
  if (item.type === 'avatar') return player.card?.avatarMode === 'custom' && player.card?.avatarId === 'raposa';
  if (item.type === 'frame') return player.card?.frame === item.frame;
  return false;
}

async function replyWithStoreAsset(ctx, message, relativeAsset) {
  const fullPath = path.resolve(relativeAsset || '');
  if (relativeAsset && fs.existsSync(fullPath) && ctx.sock?.sendMessage) {
    try {
      return await ctx.sock.sendMessage(ctx.jid, {
        image: fs.readFileSync(fullPath),
        caption: message
      }, { quoted: ctx.msg });
    } catch (error) {
      console.error('[ECONOMIA V2] Falha ao enviar imagem, usando texto:', error?.message || error);
    }
  }
  return reply(ctx, message);
}

function getMentionedJids(ctx) {
  const found = [];
  const seen = new Set();
  const queue = [ctx.msg?.message];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current.contextInfo?.mentionedJid)) found.push(...current.contextInfo.mentionedJid);
    else if (typeof current.contextInfo?.mentionedJid === 'string') found.push(current.contextInfo.mentionedJid);
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return [...new Set(found.map(value => String(value || '').replace(/:\d+(?=@)/, '').toLowerCase()).filter(Boolean))];
}

function amountAtEnd(value) {
  const match = String(value || '').trim().match(/(?:^|\s)(\d+)\s*$/);
  return match ? parseAmount(match[1]) : 0;
}

function activeOffers(state) {
  return state.marketOffers.filter(offer => offer.status === 'active' && Number(offer.quantity) > 0);
}

function makeOfferId(state) {
  let id;
  do {
    id = `M${String(state.nextOfferId++).padStart(5, '0')}`;
  } while (state.marketOffers.some(offer => offer.id === id));
  return id;
}

function storeHelp() {
  return [
    '🛍️ !loja — ver os itens disponíveis',
    '🔎 !item avatar-raposa — detalhes de um item',
    '🛒 !comprar cristal-raro 2 — comprar quantidade',
    '🎒 !inventario — ver seus itens',
    '✨ !equipar moldura-neon — equipar um cosmético',
    '🌐 !mercado — ver ofertas dos jogadores',
    '📣 !anunciar cristal-raro 1000 2 — anunciar 2 unidades por 1.000 LC cada',
    '🤝 !compraroferta M00001 1 — comprar uma oferta',
    '↩️ !cancelarvenda M00001 — cancelar seu anúncio',
    '💸 !transferir @jogador 500 — enviar LéoCoins'
  ].join('\n');
}

async function handleCommerceCommand(ctx, state, player, command, value) {
  ensureEconomyState(state);
  player.inventory ||= {};
  player.card ||= { showWallet: false, avatarMode: 'whatsapp', avatarId: 'default', frame: 'common', background: 'default' };

  if (command === 'loja') {
    const lines = Object.entries(STORE_ITEMS).map(([slug, item]) =>
      `${item.emoji} *${item.name}* — ${formatLC(item.price)}\n   Código: \`${slug}\`  |  !item ${slug}`
    );
    saveState(state);
    return reply(ctx, `🛍️ *LOJA LÉO STICKERS*\n\n${lines.join('\n\n')}\n\nPara comprar: !comprar código [quantidade]\nOs itens cosméticos ficam no inventário até você equipar. Os colecionáveis não têm abertura aleatória nesta versão.`);
  }

  if (command === 'item') {
    const slug = resolveStoreItem(value);
    if (!slug) {
      saveState(state);
      return reply(ctx, 'Item não encontrado. Use !loja para ver o catálogo.');
    }
    const item = STORE_ITEMS[slug];
    const owned = inventoryCount(player, slug);
    const message = `${item.emoji} *${item.name.toUpperCase()}*\n\n${item.description}\n\n💰 Preço na loja: *${formatLC(item.price)}*\n🎒 Você possui: *${owned}*\n\nComprar: !comprar ${slug}\nVer inventário: !inventario`;
    saveState(state);
    return replyWithStoreAsset(ctx, message, item.asset);
  }

  if (command === 'comprar') {
    const parts = value.split(/\s+/).filter(Boolean);
    const slug = resolveStoreItem(parts[0]);
    const quantity = parts[1] ? parseAmount(parts[1]) : 1;
    if (!slug || !quantity || quantity > MAX_MARKET_QUANTITY) {
      saveState(state);
      return reply(ctx, 'Uso: !comprar código [quantidade]. Consulte !loja. Limite de 99 unidades por compra.');
    }
    const item = STORE_ITEMS[slug];
    const total = item.price * quantity;
    if (!Number.isSafeInteger(total) || total > player.wallet) {
      saveState(state);
      return reply(ctx, `Saldo insuficiente. A compra custa ${formatLC(total)} e sua carteira tem ${formatLC(player.wallet)}.`);
    }
    player.wallet -= total;
    changeInventory(player, slug, quantity);
    addTransaction(player, 'compra na loja', total, `${quantity}x ${item.name}`);
    saveState(state);
    return replyWithStoreAsset(ctx, `✅ *COMPRA REALIZADA!*\n\n${item.emoji} ${item.name} × ${quantity}\n💸 Pago: *${formatLC(total)}*\n👛 Carteira: *${formatLC(player.wallet)}*\n🎒 Use !inventario para ver seus itens.`, item.asset);
  }

  if (command === 'inventario') {
    const entries = Object.entries(player.inventory).filter(([slug, count]) => STORE_ITEMS[slug] && Number(count) > 0);
    const lines = entries.map(([slug, count]) => `${STORE_ITEMS[slug].emoji} *${STORE_ITEMS[slug].name}* × ${Math.floor(Number(count))}${itemIsEquipped(player, slug) ? '  _(equipado)_' : ''}`);
    saveState(state);
    return reply(ctx, `🎒 *INVENTÁRIO DE ${player.name.toUpperCase()}*\n\n${lines.length ? lines.join('\n') : 'Seu inventário está vazio.'}\n\nCosméticos podem ser equipados com !equipar código. Você também pode anunciar itens no !mercado.`);
  }

  if (command === 'equipar') {
    const raw = value.trim();
    if (['padrao', 'padrão', 'default'].includes(raw.toLowerCase())) {
      player.card.avatarMode = 'whatsapp';
      player.card.avatarId = 'default';
      player.card.frame = 'common';
      saveState(state);
      return reply(ctx, '✅ Cartão restaurado ao avatar do WhatsApp e moldura comum.');
    }
    const slug = resolveStoreItem(raw);
    const item = slug ? STORE_ITEMS[slug] : null;
    if (!item || !['avatar', 'frame'].includes(item.type)) {
      saveState(state);
      return reply(ctx, 'Informe um cosmético válido. Exemplo: !equipar avatar-raposa ou !equipar moldura-neon.');
    }
    if (inventoryCount(player, slug) < 1) {
      saveState(state);
      return reply(ctx, `Você ainda não possui ${item.name}. Compre na !loja primeiro.`);
    }
    if (item.type === 'avatar') {
      player.card.avatarMode = 'custom';
      player.card.avatarId = 'raposa';
    } else {
      player.card.frame = item.frame;
    }
    saveState(state);
    return replyWithStoreAsset(ctx, `✨ *COSMÉTICO EQUIPADO!*\n\n${item.emoji} ${item.name} agora está selecionado no seu cartão.`, item.asset);
  }

  if (command === 'mercado') {
    const wantedId = value.trim().toUpperCase();
    const offers = activeOffers(state).filter(offer => !wantedId || offer.id === wantedId).slice(0, 15);
    if (!offers.length) {
      saveState(state);
      return reply(ctx, wantedId ? `Não encontrei a oferta ${wantedId}.` : '🌐 O mercado ainda está vazio. Anuncie itens com !anunciar código preço [quantidade].');
    }
    const lines = offers.map(offer => {
      const item = STORE_ITEMS[offer.item];
      const seller = state.players[offer.sellerId];
      return `${item?.emoji || '📦'} *${item?.name || offer.item}* — ${offer.id}\n   Vendedor: ${seller?.name || 'Jogador'} | Estoque: ${offer.quantity}\n   Preço: ${formatLC(offer.price)} por unidade\n   Comprar: !compraroferta ${offer.id} [qtd]`;
    });
    saveState(state);
    return reply(ctx, `🌐 *MERCADO DE JOGADORES*\n\n${lines.join('\n\n')}\n\n💸 Taxa de venda: ${MARKET_FEE_PERCENT}% descontada do vendedor.\n📌 Mostrando até 15 ofertas ativas.`);
  }

  if (command === 'anunciar') {
    const parts = value.split(/\s+/).filter(Boolean);
    const slug = resolveStoreItem(parts[0]);
    const price = parseAmount(parts[1]);
    const quantity = parts[2] ? parseAmount(parts[2]) : 1;
    if (!slug || !price || price > 10000000 || !quantity || quantity > MAX_MARKET_QUANTITY) {
      saveState(state);
      return reply(ctx, 'Uso: !anunciar código preço [quantidade]. Exemplo: !anunciar cristal-raro 1000 2.');
    }
    if (inventoryCount(player, slug) < quantity) {
      saveState(state);
      return reply(ctx, `Você possui apenas ${inventoryCount(player, slug)} unidade(s) desse item.`);
    }
    if (itemIsEquipped(player, slug)) {
      saveState(state);
      return reply(ctx, 'Esse cosmético está equipado. Equipe outro antes de anunciá-lo.');
    }
    changeInventory(player, slug, -quantity);
    const offer = {
      id: makeOfferId(state), sellerId: player.id,
      item: slug, price, quantity, status: 'active',
      createdAt: new Date().toISOString()
    };
    state.marketOffers.push(offer);
    addTransaction(player, 'anúncio no mercado', 0, `${offer.id}: ${quantity}x ${STORE_ITEMS[slug].name}`);
    saveState(state);
    return reply(ctx, `📣 *ANÚNCIO PUBLICADO!*\n\nCódigo: *${offer.id}*\nItem: ${STORE_ITEMS[slug].emoji} ${STORE_ITEMS[slug].name}\nQuantidade: ${quantity}\nPreço por unidade: ${formatLC(price)}\n\nUse !mercado para acompanhar. Os itens ficam reservados até a venda ou cancelamento.`);
  }

  if (command === 'compraroferta') {
    const parts = value.split(/\s+/).filter(Boolean);
    const offerId = String(parts[0] || '').toUpperCase();
    const quantity = parts[1] ? parseAmount(parts[1]) : 1;
    const offer = state.marketOffers.find(item => item.id === offerId && item.status === 'active');
    if (!offer || !quantity || quantity > MAX_MARKET_QUANTITY) {
      saveState(state);
      return reply(ctx, 'Oferta ou quantidade inválida. Use !mercado para ver os anúncios.');
    }
    if (offer.sellerId === player.id) {
      saveState(state);
      return reply(ctx, 'Você não pode comprar seu próprio anúncio.');
    }
    if (quantity > offer.quantity) {
      saveState(state);
      return reply(ctx, `Essa oferta tem apenas ${offer.quantity} unidade(s) disponíveis.`);
    }
    const seller = state.players[offer.sellerId];
    const item = STORE_ITEMS[offer.item];
    if (!seller || !item) {
      saveState(state);
      return reply(ctx, 'Não foi possível validar o vendedor ou o item dessa oferta.');
    }
    const total = offer.price * quantity;
    if (!Number.isSafeInteger(total) || player.wallet < total) {
      saveState(state);
      return reply(ctx, `Você precisa de ${formatLC(total)} na carteira. Seu saldo é ${formatLC(player.wallet)}.`);
    }
    const fee = Math.floor(total * MARKET_FEE_PERCENT / 100);
    const sellerReceives = total - fee;
    seller.wallet = Math.max(0, Math.floor(Number(seller.wallet) || 0));
    seller.transactions = Array.isArray(seller.transactions) ? seller.transactions : [];
    player.wallet -= total;
    seller.wallet += sellerReceives;
    changeInventory(player, offer.item, quantity);
    offer.quantity -= quantity;
    if (offer.quantity <= 0) offer.status = 'sold';
    state.marketTreasury += fee;
    addTransaction(player, 'compra no mercado', total, `${quantity}x ${item.name}; oferta ${offer.id}`);
    addTransaction(seller, 'venda no mercado', sellerReceives, `${quantity}x ${item.name}; oferta ${offer.id}; taxa ${formatLC(fee)}`);
    saveState(state);
    return reply(ctx, `✅ *COMPRA NO MERCADO CONCLUÍDA!*\n\n${item.emoji} ${item.name} × ${quantity}\n💸 Total pago: ${formatLC(total)}\n👛 Sua carteira: ${formatLC(player.wallet)}\n📣 O vendedor recebeu ${formatLC(sellerReceives)} após taxa de ${formatLC(fee)} (${MARKET_FEE_PERCENT}%).`);
  }

  if (command === 'cancelarvenda') {
    const offerId = value.trim().toUpperCase();
    const offer = state.marketOffers.find(item => item.id === offerId && item.status === 'active');
    if (!offer || offer.sellerId !== player.id) {
      saveState(state);
      return reply(ctx, 'Não encontrei um anúncio ativo seu com esse código.');
    }
    const remaining = Math.max(0, Math.floor(Number(offer.quantity) || 0));
    if (remaining) changeInventory(player, offer.item, remaining);
    offer.quantity = 0;
    offer.status = 'cancelled';
    offer.cancelledAt = new Date().toISOString();
    saveState(state);
    return reply(ctx, `↩️ Anúncio ${offer.id} cancelado. ${remaining} unidade(s) voltaram ao seu inventário.`);
  }

  if (command === 'transferir') {
    const mentions = getMentionedJids(ctx);
    let targetId = mentions[0] || '';
    if (!targetId) {
      const numberMatch = value.match(/@([0-9]{8,16})/);
      if (numberMatch) targetId = `${numberMatch[1]}@s.whatsapp.net`;
    }
    const amount = amountAtEnd(value);
    if (!targetId || !amount) {
      saveState(state);
      return reply(ctx, 'Uso: !transferir @jogador valor\nMarque a pessoa na mensagem e informe o valor.');
    }
    if (amount > TRANSFER_MAX_SINGLE) {
      saveState(state);
      return reply(ctx, `O limite é ${formatLC(TRANSFER_MAX_SINGLE)} por transferência.`);
    }
    if (targetId === player.id) {
      saveState(state);
      return reply(ctx, 'Você não pode transferir LéoCoins para si mesmo.');
    }
    const recipient = state.players[targetId];
    if (!recipient) {
      saveState(state);
      return reply(ctx, 'Esse jogador ainda não tem perfil econômico. Peça para ele usar !saldo primeiro.');
    }
    const today = currentDay();
    const sentToday = player.transferDaily?.day === today ? Math.max(0, Math.floor(Number(player.transferDaily.sent) || 0)) : 0;
    if (sentToday + amount > TRANSFER_MAX_DAILY) {
      saveState(state);
      return reply(ctx, `Seu limite diário é ${formatLC(TRANSFER_MAX_DAILY)}. Você já enviou ${formatLC(sentToday)} hoje e ainda pode enviar ${formatLC(Math.max(0, TRANSFER_MAX_DAILY - sentToday))}.`);
    }
    if (player.wallet < amount) {
      saveState(state);
      return reply(ctx, `Saldo insuficiente. Sua carteira tem ${formatLC(player.wallet)}.`);
    }
    player.wallet -= amount;
    recipient.wallet = Math.max(0, Math.floor(Number(recipient.wallet) || 0)) + amount;
    recipient.transactions = Array.isArray(recipient.transactions) ? recipient.transactions : [];
    player.transferDaily = { day: today, sent: sentToday + amount };
    addTransaction(player, 'transferência enviada', amount, `Para ${recipient.name}`);
    addTransaction(recipient, 'transferência recebida', amount, `De ${player.name}`);
    saveState(state);
    return reply(ctx, `💸 *TRANSFERÊNCIA CONCLUÍDA!*\n\nVocê enviou ${formatLC(amount)} para *${recipient.name}*.\n👛 Sua carteira: ${formatLC(player.wallet)}\n📊 Limite diário usado: ${formatLC(player.transferDaily.sent)} / ${formatLC(TRANSFER_MAX_DAILY)}.`);
  }

  return false;
}

function helpEconomy() {
  return [
    '💰 *ECONOMIA LÉO STICKERS*',
    '',
    '🪙 !saldo — carteira, banco e patrimônio',
    '🏦 !banco — saldo bancário e rendimento diário',
    '📥 !depositar valor — guardar LC',
    '📤 !sacar valor — retirar LC',
    '📜 !extrato — últimas movimentações',
    '🎁 !diaria — receber recompensa diária',
    '🛠️ !trabalhar [atividade] — fazer um trabalho (intervalo de 4 horas)',
    '',
    '🧰 !profissoes — ver todas as carreiras e seus efeitos',
    '🔎 !profissoes ferreiro — ver ficha completa',
    '✅ !escolherprofissao ferreiro — solicitar profissão principal',
    '✅ !confirmarprofissao — confirmar escolha',
    '➕ !secundaria minerador — solicitar profissão secundária',
    '✅ !confirmarsecundaria — confirmar profissão secundária',
    '👤 !minhaprofissao — consultar sua carreira',
    '',
    '🛍️ !loja — loja de cosméticos e colecionáveis',
    '🎒 !inventario — seus itens e quantidades',
    '✨ !equipar código — equipar avatar ou moldura',
    '🌐 !mercado — comprar e vender com jogadores',
    '📣 !anunciar código preço [qtd] — anunciar item',
    '🤝 !compraroferta ID [qtd] — comprar anúncio',
    '↩️ !cancelarvenda ID — cancelar seu anúncio',
    '💸 !transferir @jogador valor — enviar LC',
    '',
    'A loja tem preços fixos; no mercado, jogadores definem os preços. Vendas têm taxa de 3%. Transferências: até 2.000 LC por operação e 5.000 LC por dia.',
    'As LéoCoins são uma moeda fictícia do bot, sem valor monetário real.'
  ].join('\n');
}

function formatDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'data desconhecida';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function getProfessionForActivity(activity) {
  return Object.entries(PROFESSIONS).find(([, p]) => p.activity === activity)?.[0] || null;
}

function workModifier(player, activity) {
  let percent = 0;
  const labels = [];
  const primary = player.primaryProfession ? PROFESSIONS[player.primaryProfession] : null;

  if (primary?.buff.activity === activity) {
    percent += primary.buff.percent;
    labels.push(`buff principal +${primary.buff.percent}%`);
  }
  if (primary?.debuff.activity === activity) {
    percent -= primary.debuff.percent;
    labels.push(`debuff principal -${primary.debuff.percent}%`);
  }

  for (const slug of player.secondaryProfessions) {
    const p = PROFESSIONS[slug];
    if (!p) continue;
    if (p.buff.activity === activity) {
      const value = p.buff.percent / 2;
      percent += value;
      labels.push(`buff secundário +${value}%`);
    }
    if (p.debuff.activity === activity) {
      const value = p.debuff.percent / 2;
      percent -= value;
      labels.push(`debuff secundário -${value}%`);
    }
  }

  const multiplier = Math.max(0.25, 1 + percent / 100);
  return {
    multiplier,
    label: labels.length ? labels.join(' e ') : 'Sem modificador profissional'
  };
}

async function handleEconomyCommandInner(ctx, state, player, created) {
  const command = ctx.command;
  const value = String(ctx.value || '').trim();
  let interestEarned = 0;

  if (command !== 'menueconomia') interestEarned = accrueInterest(player);

  const commerceHandled = await handleCommerceCommand(ctx, state, player, command, value);
  if (commerceHandled !== false) return;

  if (command === 'menueconomia' || command === 'economia') {
    saveState(state);
    return reply(ctx, welcomeLine(created) + helpEconomy());
  }

  if (command === 'saldo') {
    saveState(state);
    return reply(ctx, welcomeLine(created) +
      `💳 *CARTEIRA DE ${player.name.toUpperCase()}*\n\n` +
      `👛 Carteira: *${formatLC(player.wallet)}*\n` +
      `🏦 Banco: *${formatLC(player.bank)}*\n` +
      `💎 Patrimônio financeiro: *${formatLC(player.wallet + player.bank)}*\n` +
      `📈 Juros recebidos nesta consulta: ${formatLC(interestEarned)}\n` +
      `\n${player.primaryProfession ? `🧰 Profissão: ${PROFESSIONS[player.primaryProfession]?.name || 'Não definida'}` : '🧰 Profissão: ainda não escolhida'}\n` +
      `\nUse !banco para detalhes ou !menueconomia para ver os comandos.`);
  }

  if (command === 'banco') {
    saveState(state);
    return reply(ctx, welcomeLine(created) +
      `🏦 *BANCO LÉO STICKERS*\n\n` +
      `Saldo guardado: *${formatLC(player.bank)}*\n` +
      `Rendimento: *0,2% ao dia*\n` +
      `Saldo remunerado máximo: *${formatLC(BANK_INTEREST_CAP)}*\n` +
      `Rendimento recebido nesta consulta: *${formatLC(interestEarned)}*\n\n` +
      `📥 !depositar 1000\n📤 !sacar 500\n📜 !extrato\n\n` +
      `Os juros são calculados automaticamente quando você consulta ou movimenta sua conta.`);
  }

  if (command === 'depositar' || command === 'sacar') {
    const amount = parseAmount(value);
    if (!amount) {
      saveState(state);
      return reply(ctx, `Informe um valor inteiro válido. Exemplo: !${command} 500`);
    }
    if (command === 'depositar') {
      if (amount > player.wallet) {
        saveState(state);
        return reply(ctx, `❌ Você tem apenas ${formatLC(player.wallet)} na carteira.`);
      }
      player.wallet -= amount;
      player.bank += amount;
      addTransaction(player, 'depósito', amount, 'Transferência da carteira para o banco');
    } else {
      if (amount > player.bank) {
        saveState(state);
        return reply(ctx, `❌ Você tem apenas ${formatLC(player.bank)} no banco.`);
      }
      player.bank -= amount;
      player.wallet += amount;
      addTransaction(player, 'saque', amount, 'Transferência do banco para a carteira');
    }
    saveState(state);
    return reply(ctx, `✅ ${command === 'depositar' ? 'Depósito' : 'Saque'} realizado!\n\n👛 Carteira: ${formatLC(player.wallet)}\n🏦 Banco: ${formatLC(player.bank)}`);
  }

  if (command === 'extrato') {
    saveState(state);
    const entries = player.transactions.slice(-10).reverse();
    if (!entries.length) return reply(ctx, welcomeLine(created) + 'Ainda não existem movimentações.');
    const lines = entries.map(item => {
      const negativeTypes = ['depósito', 'compra na loja', 'compra no mercado', 'transferência enviada'];
      const sign = negativeTypes.includes(item.type) ? '−' : '+';
      return `• ${formatDate(item.at)} — ${item.type}: ${sign}${formatLC(item.amount)}\n  _${item.detail}_`;
    });
    return reply(ctx, welcomeLine(created) + `📜 *SEU EXTRATO*\n\n${lines.join('\n\n')}`);
  }

  if (command === 'diaria') {
    const today = currentDay();
    if (player.dailyClaimedDay === today) {
      saveState(state);
      return reply(ctx, `🎁 Você já resgatou sua diária hoje!\nVolte amanhã para receber mais ${formatLC(DAILY_REWARD)}.`);
    }
    player.dailyClaimedDay = today;
    player.wallet += DAILY_REWARD;
    addTransaction(player, 'diária', DAILY_REWARD, 'Recompensa diária');
    saveState(state);
    return reply(ctx, `🎁 *DIÁRIA RESGATADA!*\n\nVocê recebeu *${formatLC(DAILY_REWARD)}*.\n👛 Carteira: ${formatLC(player.wallet)}\n\nVolte amanhã para resgatar novamente.`);
  }

  if (command === 'profissoes') {
    const slug = resolveProfession(value);
    saveState(state);
    return reply(ctx, welcomeLine(created) + (slug ? professionDetails(slug, player) : professionList()));
  }

  if (command === 'escolherprofissao') {
    const slug = resolveProfession(value);
    if (!slug) {
      saveState(state);
      return reply(ctx, '❌ Profissão não reconhecida. Consulte !profissoes e escolha uma das oito opções.');
    }
    if (player.primaryProfession) {
      saveState(state);
      return reply(ctx, `Você já tem *${PROFESSIONS[player.primaryProfession].name}* como profissão principal. Na primeira versão, a troca de carreira ainda não está disponível. Você pode aprender até duas secundárias com !secundaria nome.`);
    }
    player.pendingPrimaryProfession = slug;
    saveState(state);
    return reply(ctx, `📋 *CONFIRME SUA PROFISSÃO PRINCIPAL*\n\n${professionDetails(slug, player)}\n\n⚠️ Esta escolha será sua carreira principal. Para confirmar, digite !confirmarprofissao. Para desistir, escolha outra opção com !escolherprofissao nome.`);
  }

  if (command === 'confirmarprofissao') {
    const slug = player.pendingPrimaryProfession;
    if (!slug || !PROFESSIONS[slug]) {
      saveState(state);
      return reply(ctx, 'Não existe uma profissão pendente. Use !profissoes para consultar as opções.');
    }
    if (player.primaryProfession) {
      player.pendingPrimaryProfession = null;
      saveState(state);
      return reply(ctx, 'Você já possui uma profissão principal.');
    }
    player.primaryProfession = slug;
    player.pendingPrimaryProfession = null;
    professionProgress(player, slug);
    saveState(state);
    return reply(ctx, `🎉 *PROFISSÃO DEFINIDA!*\n\nVocê agora é ${PROFESSIONS[slug].emoji} *${PROFESSIONS[slug].name}*.\nSeu buff principal está ativo e seu debuff também será aplicado nas atividades indicadas.\n\nUse !minhaprofissao para acompanhar sua evolução e !trabalhar para começar.`);
  }

  if (command === 'secundaria') {
    const slug = resolveProfession(value);
    if (!slug) {
      saveState(state);
      return reply(ctx, 'Uso: !secundaria nome\nVocê pode aprender até duas profissões secundárias. Consulte !profissoes.');
    }
    if (!player.primaryProfession) {
      saveState(state);
      return reply(ctx, 'Escolha primeiro sua profissão principal com !escolherprofissao nome.');
    }
    if (slug === player.primaryProfession || player.secondaryProfessions.includes(slug)) {
      saveState(state);
      return reply(ctx, 'Você já possui essa profissão.');
    }
    if (player.secondaryProfessions.length >= MAX_SECONDARY_PROFESSIONS) {
      saveState(state);
      return reply(ctx, 'Você já atingiu o limite de duas profissões secundárias nesta versão.');
    }
    player.pendingSecondaryProfession = slug;
    saveState(state);
    const p = PROFESSIONS[slug];
    return reply(ctx, `➕ *NOVA PROFISSÃO SECUNDÁRIA*\n\n${professionDetails(slug, player)}\n\nComo secundária, os efeitos serão reduzidos pela metade: buff e debuff.\n\nConfirme com !confirmarsecundaria.`);
  }

  if (command === 'confirmarsecundaria') {
    const slug = player.pendingSecondaryProfession;
    if (!slug || !PROFESSIONS[slug]) {
      saveState(state);
      return reply(ctx, 'Não existe profissão secundária pendente. Use !secundaria nome.');
    }
    if (!player.primaryProfession || player.secondaryProfessions.length >= MAX_SECONDARY_PROFESSIONS || slug === player.primaryProfession || player.secondaryProfessions.includes(slug)) {
      player.pendingSecondaryProfession = null;
      saveState(state);
      return reply(ctx, 'Não foi possível adicionar essa profissão secundária. Confira seu limite e suas profissões atuais.');
    }
    player.secondaryProfessions.push(slug);
    player.pendingSecondaryProfession = null;
    professionProgress(player, slug);
    saveState(state);
    return reply(ctx, `✅ ${PROFESSIONS[slug].emoji} *${PROFESSIONS[slug].name}* foi adicionada como profissão secundária!\nOs buffs e debuffs dela funcionam com 50% da força normal.`);
  }

  if (command === 'minhaprofissao') {
    if (!player.primaryProfession) {
      saveState(state);
      return reply(ctx, 'Você ainda não escolheu uma profissão. Use !profissoes para conhecer as opções.');
    }
    const mainSlug = player.primaryProfession;
    const main = PROFESSIONS[mainSlug];
    const secondaries = player.secondaryProfessions.map(slug => {
      const p = PROFESSIONS[slug];
      return `${p.emoji} *${p.name}* — ${progressText(player, slug)} (efeitos 50%)`;
    });
    saveState(state);
    return reply(ctx, `🧰 *SUA CARREIRA*\n\n${main.emoji} *${main.name}* — PRINCIPAL\n${progressText(player, mainSlug)}\n🟢 +${main.buff.percent}% em ${main.buff.label}\n🔴 -${main.debuff.percent}% em ${main.debuff.label}\n\n*SECUNDÁRIAS*\n${secondaries.length ? secondaries.join('\n') : 'Nenhuma ainda. Use !secundaria nome.'}\n\nUse !profissoes para consultar outras carreiras.`);
  }

  if (command === 'trabalhar') {
    const now = Date.now();
    const remaining = Number(player.workCooldownUntil || 0) - now;
    if (remaining > 0) {
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.ceil((remaining % 3600000) / 60000);
      saveState(state);
      return reply(ctx, `🛠️ Você já trabalhou recentemente. Volte em ${hours ? `${hours}h ` : ''}${minutes}min.`);
    }

    let slug = resolveProfession(value);
    let activity = slug ? PROFESSIONS[slug].activity : null;
    if (!value) {
      slug = player.primaryProfession;
      activity = slug ? PROFESSIONS[slug].activity : null;
    }
    if (value && !slug) {
      saveState(state);
      return reply(ctx, 'Atividade não reconhecida. Use: forja, comercio, exploracao, alquimia, agricultura, mineracao, pesca ou engenharia.');
    }

    const base = 85 + Math.floor(Math.random() * 66);
    const modifier = activity ? workModifier(player, activity) : { multiplier: 1, label: 'Trabalho geral', matched: null };
    const reward = Math.max(1, Math.floor(base * modifier.multiplier));
    const taskName = activity ? ACTIVITY_LABELS[activity] : 'serviços gerais';
    player.wallet += reward;
    player.workCooldownUntil = now + WORK_COOLDOWN_MS;
    addTransaction(player, 'trabalho', reward, `Atividade: ${taskName}; ${modifier.label}`);

    let xpLine = '';
    const progressSlug = activity ? getProfessionForActivity(activity) : null;
    if (progressSlug && (progressSlug === player.primaryProfession || player.secondaryProfessions.includes(progressSlug))) {
      const xpAmount = progressSlug === player.primaryProfession ? 15 : 8;
      const gained = addProfessionXp(player, progressSlug, xpAmount);
      xpLine = `\n📚 +${xpAmount} XP em ${PROFESSIONS[progressSlug].name}${gained?.leveled ? ` — SUBIU PARA O NÍVEL ${gained.level}!` : ''}`;
    }

    saveState(state);
    return reply(ctx, `🛠️ *TRABALHO CONCLUÍDO!*\n\nAtividade: *${taskName}*\nPagamento-base: ${formatLC(base)}\nEfeito: ${modifier.label}\n💰 Você recebeu: *${formatLC(reward)}*${xpLine}\n\n👛 Carteira: ${formatLC(player.wallet)}\n⏳ Próximo trabalho em 4 horas.`);
  }

  saveState(state);
  return reply(ctx, 'Comando econômico não reconhecido. Use !menueconomia.');
}

let economyQueue = Promise.resolve();

export async function handleEconomyCommand(ctx) {
  const run = async () => {
    try {
      const state = readState();
      const { player, created } = ensurePlayer(state, ctx);
      ensureEconomyState(state);
      await handleEconomyCommandInner(ctx, state, player, created);
    } catch (error) {
      console.error('[ECONOMIA]', error?.stack || error);
      await reply(ctx, `❌ Não consegui concluir essa operação. ${String(error?.message || error).slice(0, 300)}`);
    }
  };
  const task = economyQueue.then(run, run);
  economyQueue = task.catch(() => {});
  return task;
}

export const PROFESSION_CATALOG = PROFESSIONS;
