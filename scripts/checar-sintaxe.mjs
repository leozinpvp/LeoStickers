import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const excluded = new Set(['node_modules', '.git', 'auth', 'sessions', 'session', 'creds']);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excluded.has(entry.name)) walk(path.join(directory, entry.name));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(directory, entry.name));
  }
}

walk(root);
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`\n[ERRO DE SINTAXE] ${path.relative(root, file)}\n${result.stderr || result.stdout}`);
  }
}

if (failed) {
  console.error(`\n${failed} arquivo(s) com erro de sintaxe de ${files.length}.`);
  process.exitCode = 1;
} else {
  console.log(`✅ Sintaxe válida em ${files.length} arquivo(s) JavaScript.`);
}
