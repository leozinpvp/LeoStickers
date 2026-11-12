import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const extensions = new Set(['.js', '.mjs', '.cjs']);
const ignored = new Set([
  '.git',
  'node_modules',
  'backups',
  'cache',
  'temp'
]);

const files = [];

function scan(directory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue;
      if (entry.name.startsWith('backup-')) continue;
      if (entry.name.startsWith('backup_')) continue;

      scan(fullPath);
      continue;
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
}

if (fs.existsSync('index.js')) {
  files.push('index.js');
}

scan('codigo');
scan('scripts');

const uniqueFiles = [...new Set(files)].sort();

let errors = 0;

console.log('');
console.log('🦊 LEO STICKERS — VERIFICAÇÃO');
console.log('==============================');
console.log('');

for (const file of uniqueFiles) {
  const result = spawnSync(
    process.execPath,
    ['--check', file],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    errors++;

    console.error(`❌ ERRO: ${file}`);
    console.error(
      result.stderr ||
      result.stdout ||
      'Erro de sintaxe desconhecido.'
    );
  } else {
    console.log(`✅ ${file}`);
  }
}

console.log('');
console.log(`Arquivos analisados: ${uniqueFiles.length}`);
console.log(`Erros: ${errors}`);

if (errors > 0) {
  console.error('');
  console.error('❌ Existem erros de sintaxe.');
  process.exit(1);
}

console.log('');
console.log('🦊 Todos os arquivos passaram na verificação!');
