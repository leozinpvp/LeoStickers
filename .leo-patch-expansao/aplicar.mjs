import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const packageDir = path.dirname(new URL(import.meta.url).pathname);
const indexPath = path.join(projectRoot, 'index.js');
const modulePath = path.join(projectRoot, 'leo-advanced.js');
const gitignorePath = path.join(projectRoot, '.gitignore');
const sourceModulePath = path.join(packageDir, 'leo-advanced.js');

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}
function exactlyOne(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: encontrei ${count} ocorrências; precisava de exatamente 1.`);
  return source.replace(needle, replacement);
}
function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Falha de sintaxe em ${path.basename(file)}.`);
}

if (!fs.existsSync(indexPath)) fail(`Não achei ${indexPath}. Entre na pasta ~/BotFigurinhas e execute o instalador novamente.`);
if (!fs.existsSync(sourceModulePath)) fail('O arquivo leo-advanced.js não está junto do instalador. Extraia o ZIP completo.');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) fail(`O módulo usa fetch nativo e precisa de Node 18 ou superior. Instalado: ${process.versions.node}`);

const originalIndex = fs.readFileSync(indexPath, 'utf8');
const originalModule = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : null;
const originalGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : null;
let updatedGitignore = originalGitignore || '';
let updated = originalIndex;
const moduleSource = fs.readFileSync(sourceModulePath, 'utf8');

try {
  const importMarker = 'LEO_ADVANCED_IMPORT_V1';
  const advancedImportLine = `import { ADVANCED_COMMANDS, checkAdvancedRateLimit, handleAdvancedAutoReply, startAdvancedScheduler, handleAdvancedCommand, withAdvancedDownloadQueue } from './leo-advanced.js'; // ${importMarker}`;
  if (!updated.includes(importMarker)) {
    const controlImport = updated.match(/^import \{ handleControlPanelMessage,[^\n]* from '\.\/control-panel\.js';$/m);
    if (!controlImport) throw new Error('Não encontrei a importação do control-panel.js esperada no seu index.js.');
    updated = exactlyOne(updated, controlImport[0], controlImport[0] + `\n${advancedImportLine}`, 'Importação do painel');
  } else {
    const oldAdvancedImport = updated.match(/^import \{[^\n]+ from '\.\/leo-advanced\.js'; \/\/ LEO_ADVANCED_IMPORT_V1$/m);
    if (!oldAdvancedImport) throw new Error('Encontrei o marcador do módulo, mas não consegui localizar sua importação.');
    if (!oldAdvancedImport[0].includes('withAdvancedDownloadQueue')) {
      updated = exactlyOne(updated, oldAdvancedImport[0], advancedImportLine, 'Atualização da importação avançada');
    }
  }

  const menuMarker = 'LEO_ADVANCED_ROOT_MENU_V1';
  if (!updated.includes(menuMarker)) {
    const audioMenuLine = "    '🎧 !menuaudio — Converter e editar áudios',";
    updated = exactlyOne(
      updated,
      audioMenuLine,
      `${audioMenuLine}\n    '🌐 !menuapi — APIs de anime, GIFs, clima e utilidades', // ${menuMarker}`,
      'Entrada do menu principal'
    );
  }

  const commandMarker = 'LEO_ADVANCED_SOCIAL_COMMANDS_V1';
  if (!updated.includes(commandMarker)) {
    updated = exactlyOne(
      updated,
      'const SOCIAL_COMMANDS = new Set([',
      `const SOCIAL_COMMANDS = new Set([\n      ...ADVANCED_COMMANDS, // ${commandMarker}`,
      'Registro dos novos comandos'
    );
  }

  const rateMarker = 'LEO_ADVANCED_ANTISPAM_HOOK_V1';
  if (!updated.includes(rateMarker)) {
    const needle = '    const SOCIAL_COMMANDS = new Set([';
    const addition = `    // ${rateMarker}\n    const advancedRate = checkAdvancedRateLimit(jid, senderJid, command);\n    if (!advancedRate.allowed) {\n      await send(jid, '🛡️ Antispam: aguarde ' + advancedRate.seconds + ' segundo(s) antes de enviar mais comandos.', msg);\n      return;\n    }\n`;
    updated = exactlyOne(updated, needle, addition + needle, 'Ponto de aplicação do antispam');
  }

  const audioQueueMarker = 'LEO_ADVANCED_DOWNLOAD_QUEUE_MP3_V1';
  if (!updated.includes(audioQueueMarker)) {
    updated = exactlyOne(
      updated,
      'const audioData = await downloadYouTubeAudio(selected);',
      `const audioData = await withAdvancedDownloadQueue(() => downloadYouTubeAudio(selected), 'YouTube MP3'); // ${audioQueueMarker}`,
      'Download de áudio do YouTube'
    );
  }

  const videoQueueMarker = 'LEO_ADVANCED_DOWNLOAD_QUEUE_MP4_V1';
  if (!updated.includes(videoQueueMarker)) {
    updated = exactlyOne(
      updated,
      'const videoData = await downloadCreativeCommonsVideo(selected);',
      `const videoData = await withAdvancedDownloadQueue(() => downloadCreativeCommonsVideo(selected), 'YouTube MP4'); // ${videoQueueMarker}`,
      'Download de vídeo do YouTube'
    );
  }

  const dispatchMarker = 'LEO_ADVANCED_DISPATCH_V1';
  if (!updated.includes(dispatchMarker)) {
    const oldDispatch = `      if (BLACKLIST_COMMANDS.includes(command)) {\n        await handleBlacklistCommand(context);\n      } else {\n        await handleSocialCommand(context);\n      }`;
    const newDispatch = `      // ${dispatchMarker}\n      if (ADVANCED_COMMANDS.includes(command)) {\n        await handleAdvancedCommand(context);\n      } else if (BLACKLIST_COMMANDS.includes(command)) {\n        await handleBlacklistCommand(context);\n      } else {\n        await handleSocialCommand(context);\n      }`;
    updated = exactlyOne(updated, oldDispatch, newDispatch, 'Distribuição dos comandos sociais');
  }

  const schedulerMarker = 'LEO_ADVANCED_SCHEDULER_HOOK_V1';
  if (!updated.includes(schedulerMarker)) {
    updated = exactlyOne(
      updated,
      "        if (type !== 'notify') return;",
      `        if (type !== 'notify') return;\n        startAdvancedScheduler(currentSock); // ${schedulerMarker}`,
      'Inicialização do agendador'
    );
  }

  const autoReplyMarker = 'LEO_ADVANCED_AUTOREPLY_HOOK_V1';
  if (!updated.includes(autoReplyMarker)) {
    updated = exactlyOne(
      updated,
      '          await autoSaveIncomingSticker(msg);',
      `          await autoSaveIncomingSticker(msg);\n          await handleAdvancedAutoReply(currentSock, msg, config.prefix); // ${autoReplyMarker}`,
      'Ponto de respostas automáticas'
    );
  }

  // Protege dados operacionais novos e backups contra envio acidental ao GitHub.
  const privateEntries = ['leo-advanced-data.json', 'backup-expansao-sem-ia-*/'];
  for (const entry of privateEntries) {
    if (!updatedGitignore.split(/\r?\n/).includes(entry)) {
      updatedGitignore += `${updatedGitignore.endsWith('\n') || !updatedGitignore ? '' : '\n'}${entry}\n`;
    }
  }

  // Detecta divergências importantes antes de tocar nos arquivos.
  for (const marker of [importMarker, menuMarker, commandMarker, rateMarker, audioQueueMarker, videoQueueMarker, dispatchMarker, schedulerMarker, autoReplyMarker]) {
    if (!updated.includes(marker)) throw new Error(`Falhou a validação do marcador ${marker}.`);
  }

  if (updated === originalIndex && originalModule === moduleSource && updatedGitignore === (originalGitignore || '')) {
    console.log('✅ A expansão já está aplicada e atualizada. Nenhum arquivo precisou ser regravado.');
    process.exit(0);
  }

  const backupName = `backup-expansao-sem-ia-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const backupDir = path.join(projectRoot, backupName);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(indexPath, path.join(backupDir, 'index.js'));
  if (originalModule !== null) fs.copyFileSync(modulePath, path.join(backupDir, 'leo-advanced.js'));
  if (originalGitignore !== null) fs.copyFileSync(gitignorePath, path.join(backupDir, '.gitignore'));

  try {
    fs.writeFileSync(modulePath, moduleSource, 'utf8');
    fs.writeFileSync(indexPath, updated, 'utf8');
    fs.writeFileSync(gitignorePath, updatedGitignore, 'utf8');
    checkSyntax(modulePath);
    checkSyntax(indexPath);
  } catch (error) {
    fs.writeFileSync(indexPath, originalIndex, 'utf8');
    if (originalModule === null) {
      try { fs.unlinkSync(modulePath); } catch {}
    } else {
      fs.writeFileSync(modulePath, originalModule, 'utf8');
    }
    if (originalGitignore === null) {
      try { fs.unlinkSync(gitignorePath); } catch {}
    } else {
      fs.writeFileSync(gitignorePath, originalGitignore, 'utf8');
    }
    throw new Error(`${error.message}\nOs arquivos originais foram restaurados.`);
  }

  console.log('\n✅ EXPANSÃO SEM IA INSTALADA!');
  console.log('✅ index.js e leo-advanced.js passaram no node --check.');
  console.log(`📁 Backup: ${backupName}`);
  console.log('📄 Dados novos serão salvos em leo-advanced-data.json.');
  console.log('🔐 .env, sessão, database.json e biblioteca não foram alterados.');
  console.log('🔒 Arquivo de dados novo e backups locais foram adicionados ao .gitignore.');
  console.log('\nReinicie o bot para carregar os comandos novos.');
} catch (error) {
  fail(error.message);
}
