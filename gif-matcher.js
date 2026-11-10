const STOP_WORDS = new Set([
  'anime', 'scene', 'scenes', 'reaction', 'reactions', 'character', 'characters',
  'gets', 'get', 'another', 'the', 'a', 'an', 'and', 'or', 'with', 'for',
  'funny', 'comedy', 'cute', 'happy', 'hard', 'very', 'scene', 'meme', 'moment'
]);

function tokens(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

function stem(word) {
  let out = word;
  if (out.length > 5 && out.endsWith('ing')) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith('ed')) out = out.slice(0, -2);
  else if (out.length > 4 && out.endsWith('s') && !out.endsWith('ss')) out = out.slice(0, -1);
  if (/(pp|gg|tt|ll)$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * Reordena os resultados da GIPHY para privilegiar título/tags que correspondam
 * à ação solicitada. Sem correspondência temática, retorna null em vez de usar
 * um GIF aleatório que possa não ter nada a ver com o comando.
 */
export function findThematicGif(results, query) {
  if (!Array.isArray(results) || !results.length) return null;
  const wanted = [...new Set(tokens(query).filter(word => !STOP_WORDS.has(word)).map(stem))];
  if (!wanted.length) return results[0];

  const ranked = results.map((item, index) => {
    const haystack = new Set(tokens(`${item?.title || ''} ${(item?.tags || []).join(' ')}`).map(stem));
    let score = 0;
    for (const word of wanted) if (haystack.has(word)) score += word.length >= 5 ? 3 : 1;
    return { item, index, score };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return ranked[0]?.item || null;
}
