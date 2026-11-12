import 'dotenv/config';
import { searchGiphyGif } from './giphy-library.js';
import { findThematicGif, expandGifQueries } from './gif-matcher.js';

const tests = [
  ['matar', ['anime sword battle defeat scene no blood', 'anime sword fight', 'anime battle']],
  ['bater', ['anime comedy slap scene reaction', 'anime slap']],
  ['beijar', ['anime romantic kiss scene couple', 'anime kiss']],
  ['abracar', ['anime emotional hug scene', 'anime hug']],
  ['cafune', ['anime gentle head pat scene', 'anime head pat']],
  ['cumprimentar', ['anime character greeting waving hello', 'anime handshake']],
  ['dancinha', ['anime character funny dance scene', 'anime dance']],
  ['casal', ['anime couple romantic kiss scene', 'anime couple kiss']]
];

for (const [command, originals] of tests) {
  console.log(`\n========== ${command.toUpperCase()} ==========`);
  let selected = null;
  const queries = expandGifQueries(originals);
  console.log('Consultas:', queries.join(' | '));

  for (const query of queries) {
    try {
      const results = await searchGiphyGif(query);
      const match = findThematicGif(results, query);
      console.log(`${query}: ${results.length} resultados | ${match?.title || 'sem correspondência'}`);
      if (match) {
        selected = { ...match, selectedByQuery: query };
        break;
      }
    } catch (error) {
      console.log(`${query}: ERRO ${error.message}`);
    }
  }

  console.log('RESULTADO FINAL:', selected?.title || 'NENHUM GIF');
  if (selected) console.log('Consulta que encontrou:', selected.selectedByQuery);
}
