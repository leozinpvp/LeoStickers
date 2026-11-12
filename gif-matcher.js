const STOP_WORDS = new Set([
  'scene', 'scenes', 'reaction', 'reactions', 'character', 'characters',
  'gets', 'get', 'another', 'the', 'a', 'an', 'and', 'or', 'with', 'for',
  'funny', 'comedy', 'cute', 'happy', 'hard', 'very', 'moment', 'moments',
  'video', 'gif', 'no', 'blood', 'dramatic', 'final', 'opponent', 'between',
  'close', 'up', 'anime', 'manga', 'romantic', 'emotional', 'gentle',
  'couple', 'person', 'someone', 'someone', 'character'
]);

// Marcadores de franquias/personagens: evidência mais forte que a palavra
// genérica "anime" perdida em um slug de jogo ou anúncio.
const ANIME_FRANCHISE_MARKERS = [
  'naruto', 'boruto', 'sasuke', 'itachi', 'kakashi', 'hinata hyuga',
  'one piece', 'luffy', 'roronoa zoro', 'zoro', 'sanji', 'nami one piece',
  'demon slayer', 'kimetsu no yaiba', 'tanjiro', 'nezuko', 'zenitsu',
  'rengoku', 'akaza', 'shinobu kocho', 'giyu tomioka', 'inosuke',
  'jujutsu kaisen', 'jjk', 'satoru gojo', 'gojo', 'sukuna', 'yuji itadori',
  'itadori', 'toji fushiguro', 'toji', 'megumi fushiguro', 'nobara kugisaki',
  'chainsaw man', 'denji', 'makima', 'pochita', 'power chainsaw man',
  'spy x family', 'anya forger', 'anya', 'loid forger', 'yor forger',
  'dragon ball', 'goku', 'vegeta', 'gohan', 'frieza', 'piccolo',
  'attack on titan', 'shingeki no kyojin', 'eren yeager', 'eren',
  'levi ackerman', 'levi', 'mikasa ackerman', 'my hero academia',
  'boku no hero', 'izuku midoriya', 'deku', 'bakugo', 'todoroki',
  'bleach', 'ichigo kurosaki', 'ichigo', 'one punch man', 'saitama', 'genos',
  'hunter x hunter', 'killua', 'gon freecss', 'kurapika',
  'fullmetal alchemist', 'frieren', 'sailor moon', 'pokemon', 'pikachu',
  'haikyuu', 'blue lock', 'jojo bizarre adventure', 'jojo', 'evangelion',
  'tokyo ghoul', 'death note', 'light yagami', 'ryuk', 'mob psycho',
  'horimiya', 'kaguya sama', 'kaguya shinomiya', 'chika fujiwara',
  'sword art online', 'kirito', 'asuna yuuki', 'sao', 'toradora',
  'fruits basket', 'k on', 'violet evergarden', 'bocchi the rock',
  'komi san', 'your name', 'weathering with you', 'umamusume', 'uma musume',
  'zero two', 'darling in the franxx', 'franxx', 'noragami', 'maomao',
  'kusuriya no hitorigoto', 'apothecary diaries', 'lycoris recoil',
  'fairy tail', 'natsu dragneel', 'black clover', 'asta', 'dr stone',
  'senku', 'tokyo revengers', 'mikey', 'draken', 're zero', 'rem re zero',
  'konosuba', 'overlord', 'bunny girl senpai', 'rascal does not dream',
  'my dress up darling', 'marin kitagawa', 'oshi no ko', 'ai hoshino',
  'vinland saga', 'thorfinn', 'solo leveling', 'sung jinwoo', 'dandadan',
  'momo ayase', 'okarun', 'sakamoto days', 'wind breaker anime',
  'funimation', 'crunchyroll', 'toei animation', 'ufotable', 'mappa',
  'kyoto animation', 'studio pierrot', 'bones studio'
];

const GENERIC_ANIME_WORDS = ['anime', 'manga'];

const GAMING_OR_AD_MARKERS = [
  'xbox', 'playstation', 'fortnite', 'magic the gathering', 'mtg arena',
  'gaming trailer', 'game trailer', 'gameplay', 'console', 'product ad'
];

const BLOCKED_TERMS = [
  'hentai', 'ecchi', 'nsfw', 'porn', 'porno', 'sexual', 'sex', 'nude',
  'naked', 'boob', 'boobs', 'breast', 'groin', 'nuts', 'genital', 'genitals',
  'masturbation', 'erotic', 'explicit', 'uncensored', 'lewd', 'strip tease',
  'striptease', 'guro', 'gore'
];

const ACTION_GROUPS = [
  {
    id: 'fight',
    triggers: ['fight', 'fighting', 'battle', 'combat', 'attack', 'attacking', 'sword', 'duel', 'slash', 'defeat'],
    matches: ['fight', 'fighting', 'battle', 'combat', 'attack', 'attacking', 'duel', 'sword', 'slash', 'clash', 'punch', 'smash'],
    searches: ['anime fight', 'anime battle', 'demon slayer fight', 'naruto fight', 'jujutsu kaisen fight']
  },
  {
    id: 'slap',
    triggers: ['slap', 'slapped', 'slapping', 'smack', 'punch', 'hit'],
    matches: ['slap', 'slapped', 'slapping', 'smack', 'smacked', 'punch', 'punched', 'hit'],
    searches: ['anime slap', 'kimetsu no yaiba slap', 'naruto slap']
  },
  {
    id: 'kick',
    triggers: ['kick', 'kicked', 'kicking'],
    matches: ['kick', 'kicked', 'kicking', 'roundhouse'],
    searches: ['anime kick', 'anime kicking', 'jujutsu kaisen kick']
  },
  {
    id: 'hug',
    triggers: ['hug', 'hugging', 'embrace', 'cuddle'],
    matches: ['hug', 'hugging', 'embrace', 'embracing', 'cuddle', 'cuddling'],
    searches: ['anime hug', 'fruits basket hug', 'spy x family hug']
  },
  {
    id: 'kiss',
    triggers: ['kiss', 'kissing'],
    matches: ['kiss', 'kissing', 'kissed'],
    searches: ['anime kiss', 'anime couple kiss', 'anime romantic kiss']
  },
  {
    id: 'headpat',
    triggers: ['headpat', 'headpats', 'pat', 'pats', 'stroking', 'petting', 'nade'],
    matches: ['headpat', 'headpats', 'pat', 'pats', 'stroking', 'stroke', 'petting', 'pet', 'nade'],
    searches: ['anime head pat', 'anime headpat', 'anime headpats', 'umamusume head pat', 'noragami head pat']
  },
  {
    id: 'handshake',
    triggers: ['handshake', 'shake', 'greeting', 'greet', 'wave', 'waving', 'hello', 'highfive'],
    matches: ['handshake', 'shake', 'shaking', 'greeting', 'greet', 'wave', 'waving', 'hello', 'highfive'],
    searches: ['anime handshake', 'goku vegeta handshake', 'anime high five']
  },
  {
    id: 'dance',
    triggers: ['dance', 'dancing'],
    matches: ['dance', 'dancing', 'dancer'],
    searches: ['anime dance', 'anime dancing', 'anime dance meme']
  },
  {
    id: 'cry',
    triggers: ['cry', 'crying', 'tears', 'sad'],
    matches: ['cry', 'crying', 'cries', 'tears', 'weep', 'weeping', 'sobbing'],
    searches: ['anime crying', 'anime tears', 'anime sad']
  },
  {
    id: 'wedding',
    triggers: ['wedding', 'marriage', 'married', 'bride', 'groom'],
    matches: ['wedding', 'marriage', 'married', 'bride', 'groom'],
    searches: ['anime wedding', 'anime bride groom', 'anime marriage']
  },
  {
    id: 'jealousy',
    triggers: ['jealous', 'jealousy'],
    matches: ['jealous', 'jealousy'],
    searches: ['anime jealousy', 'anime jealous']
  },
  {
    id: 'confession',
    triggers: ['confession', 'confess'],
    matches: ['confession', 'confess', 'confessing'],
    searches: ['anime confession', 'anime love confession']
  }
];

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function itemFields(item) {
  return {
    title: normalize(item?.title || ''),
    slug: normalize(item?.slug || ''),
    source: normalize(item?.source || ''),
    tags: normalize(Array.isArray(item?.tags) ? item.tags.join(' ') : '')
  };
}

function hasPhrase(text, phrase) {
  const normalizedPhrase = normalize(phrase);
  return Boolean(normalizedPhrase) && (` ${text} `).includes(` ${normalizedPhrase} `);
}

function hasAnyPhrase(text, phrases) {
  return phrases.some(phrase => hasPhrase(text, phrase));
}

function animeEvidence(item) {
  const fields = itemFields(item);
  const all = [fields.title, fields.slug, fields.source, fields.tags].filter(Boolean).join(' ');

  // Uma franquia/personagem identificável é prova forte. "anime" solto no slug
  // não basta: pode aparecer em nome de campanha ou jogo, como o caso do Xbox.
  if (hasAnyPhrase(all, ANIME_FRANCHISE_MARKERS)) return 3;

  // Evidência genérica só vale quando está no título ou no campo de origem,
  // nunca quando aparece isolada apenas no slug.
  if (hasAnyPhrase(fields.title, GENERIC_ANIME_WORDS) ||
      hasAnyPhrase(fields.source, GENERIC_ANIME_WORDS)) {
    if (hasAnyPhrase(all, GAMING_OR_AD_MARKERS)) return 0;
    return 1;
  }

  return 0;
}

function hasAnimeSignal(item) {
  return animeEvidence(item) > 0;
}

function isBlocked(item) {
  const fields = itemFields(item);
  const all = [fields.title, fields.slug, fields.source, fields.tags].filter(Boolean).join(' ');
  return hasAnyPhrase(all, BLOCKED_TERMS);
}

function actionGroupForQuery(query) {
  const queryTokens = new Set(tokens(query));
  const compact = normalize(query).replace(/ /g, '');

  // Head pat precisa de "pat" junto de "head" ou da forma composta.
  if ((queryTokens.has('head') && (queryTokens.has('pat') || queryTokens.has('pats'))) ||
      compact.includes('headpat') || queryTokens.has('stroking') || queryTokens.has('nade')) {
    return ACTION_GROUPS.find(group => group.id === 'headpat');
  }

  return ACTION_GROUPS.find(group =>
    group.triggers.some(word => queryTokens.has(word) || compact.includes(normalize(word).replace(/ /g, '')))
  ) || null;
}

function actionEvidence(fields, group) {
  if (!group) return 0;
  let score = 0;
  for (const word of group.matches) {
    if (hasPhrase(fields.title, word)) score += 6;
    if (hasPhrase(fields.slug, word)) score += 4;
    if (hasPhrase(fields.source, word)) score += 3;
    if (hasPhrase(fields.tags, word)) score += 2;
  }
  return score;
}

function expandGifQueries(input) {
  const originals = (Array.isArray(input) ? input : [input])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const output = [];
  const add = value => {
    const query = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    if (query && !output.includes(query) && output.length < 9) output.push(query);
  };

  // Mantém as consultas originais na frente, mas limita as variantes para não
  // multiplicar excessivamente as chamadas à API.
  for (const query of originals) add(query);

  for (const query of originals) {
    if (output.length >= 6) break;
    const words = tokens(query).filter(word => !STOP_WORDS.has(word));
    const hasAnime = /\b(anime|manga)\b/i.test(query);
    const compact = [
      ...(hasAnime ? ['anime'] : []),
      ...words.filter(word => word !== 'anime' && word !== 'manga')
    ];
    add(compact.slice(0, 4).join(' '));
    add(compact.slice(0, 3).join(' '));
  }

  const firstAction = originals.map(actionGroupForQuery).find(Boolean);
  if (firstAction) {
    for (const query of firstAction.searches) add(query);
  }

  return output;
}

function findThematicGif(results, query) {
  if (!Array.isArray(results) || !results.length) return null;

  const group = actionGroupForQuery(query);
  const wanted = [...new Set(tokens(query).filter(word => !STOP_WORDS.has(word)))];

  const ranked = results.map((item, index) => {
    const fields = itemFields(item);
    const anime = animeEvidence(item);
    const blocked = isBlocked(item);
    const action = actionEvidence(fields, group);
    let relevance = 0;

    for (const word of wanted) {
      if (hasPhrase(fields.title, word)) relevance += 3;
      if (hasPhrase(fields.slug, word)) relevance += 2;
      if (hasPhrase(fields.tags, word)) relevance += 1;
    }

    // A ação precisa aparecer nos metadados. Isso impede que "anime + battle"
    // selecione uma explosão de videogame sem relação clara com o comando.
    const actionRequired = Boolean(group);
    const valid = anime > 0 && !blocked && (!actionRequired || action > 0);
    const score = (anime * 4) + action + relevance;

    return { item, index, valid, score };
  }).filter(entry => entry.valid);

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.item || null;
}

export { hasAnimeSignal, expandGifQueries, findThematicGif };
