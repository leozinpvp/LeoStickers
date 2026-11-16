import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const JOIN = path.join(ROOT, 'codigo', 'join-approval.js');
const INDEX = path.join(ROOT, 'index.js');
const INTEL = path.join(ROOT, 'codigo', 'intelligent-sticker-search.js');
const SOCIAL = path.join(ROOT, 'codigo', 'social-features.js');
const FUN_SOURCE = path.join(ROOT, 'yamada-fun.js');
const FUN_DEST = path.join(ROOT, 'codigo', 'yamada-fun.js');
const ENV = path.join(ROOT, '.env');
const MARK_JOIN = 'LEO_YAMADA_AI_PERSONALITIES_ACTIONS_V1';
const MARK_INDEX = 'LEO_YAMADA_EXPANSION_V1';
const MARK_SOCIAL = 'LEO_YAMADA_AI_BAN_LID_FIX_V1';

function stop(message) {
  console.error('\n[INSTALADOR YAMADA] ' + message);
  process.exit(1);
}
function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) stop('Não encontrei o ponto esperado: ' + label + '. Nenhum arquivo foi alterado.');
  if (source.indexOf(anchor, first + anchor.length) >= 0) stop('O ponto aparece mais de uma vez: ' + label + '. Nenhum arquivo foi alterado.');
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}
function replaceBetween(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) stop('Não encontrei o início de ' + label + '. Nenhum arquivo foi alterado.');
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) stop('Não encontrei o final de ' + label + '. Nenhum arquivo foi alterado.');
  if (source.indexOf(startAnchor, start + startAnchor.length) >= 0) stop('O início de ' + label + ' aparece mais de uma vez. Nenhum arquivo foi alterado.');
  return source.slice(0, start) + replacement + source.slice(end);
}
function atomicWrite(file, content) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

if (!fs.existsSync(JOIN) || !fs.existsSync(INDEX) || !fs.existsSync(INTEL) || !fs.existsSync(SOCIAL) || !fs.existsSync(path.join(ROOT, 'package.json'))) {
  stop('Execute na raiz do projeto, dentro de ~/BotFigurinhas.');
}
if (!fs.existsSync(FUN_SOURCE)) stop('Não encontrei yamada-fun.js. Extraia todos os arquivos do TAR.GZ na raiz do projeto.');
if (fs.existsSync(FUN_DEST) && !fs.readFileSync(FUN_DEST, 'utf8').includes('LEO_YAMADA_FUN_COMMANDS_V1')) {
  stop('Já existe codigo/yamada-fun.js sem o marcador desta versão. Não vou sobrescrever esse arquivo.');
}

let joinSource = fs.readFileSync(JOIN, 'utf8');
let indexSource = fs.readFileSync(INDEX, 'utf8');
let intelSource = fs.readFileSync(INTEL, 'utf8');
let socialSource = fs.readFileSync(SOCIAL, 'utf8');
const alreadyJoin = joinSource.includes(MARK_JOIN);
const alreadyIndex = indexSource.includes(MARK_INDEX);
const alreadySocial = socialSource.includes(MARK_SOCIAL);
if (alreadyJoin && alreadyIndex && alreadySocial) {
  console.log('[INSTALADOR YAMADA] Esta expansão já está instalada. Nada foi alterado.');
  process.exit(0);
}
if (alreadyJoin || alreadyIndex || alreadySocial) stop('Encontrei marcadores parciais. Para evitar duplicação, não alterei nada.');

// Configuração independente das duas personalidades por grupo.
joinSource = replaceOnce(joinSource,
  '    groupAIEnabled: false,\n    presentationAIEnabled: true,',
  '    groupAIEnabled: false,\n    presentationAIEnabled: true,\n    groupAIPersonality: \'\',\n    presentationAIPersonality: \'\',',
  'configuração padrão das personalidades');
joinSource = replaceOnce(joinSource,
  '  cfg.groupAIEnabled = cfg.groupAIEnabled === true;\n  cfg.presentationAIEnabled = cfg.presentationAIEnabled !== false;',
  '  cfg.groupAIEnabled = cfg.groupAIEnabled === true;\n  cfg.presentationAIEnabled = cfg.presentationAIEnabled !== false;\n  cfg.groupAIPersonality = String(cfg.groupAIPersonality || \'\').slice(0, 700);\n  cfg.presentationAIPersonality = String(cfg.presentationAIPersonality || \'\').slice(0, 700);',
  'normalização das personalidades');

// Registra também o atalho !personalidade.
joinSource = replaceOnce(joinSource,
  "  'solicitacoes', 'aprovarsolicitacao', 'recusarsolicitacao', 'ia'\n]);",
  "  'solicitacoes', 'aprovarsolicitacao', 'recusarsolicitacao', 'ia', 'personalidade'\n]);",
  'registro do comando !personalidade');
joinSource = replaceOnce(joinSource,
  "  if (command === 'ia') return handleIACommand(ctx);",
  "  if (command === 'ia') return handleIACommand(ctx);\n  if (command === 'personalidade') {\n    const raw = String(ctx.value || '').trim();\n    const scoped = /^(grupo|pv|ver|reset)\\b/i.test(raw) ? raw : 'grupo ' + raw;\n    return handleIACommand({ ...ctx, value: 'personalidade ' + scoped });\n  }",
  'roteamento do atalho !personalidade');

// A personalidade do PV controla só o tom; o fluxo de coleta e validação continua sendo o mesmo.
joinSource = replaceOnce(joinSource,
  "    'Você é o assistente de preenchimento de uma apresentação de entrada em um grupo de WhatsApp. Responda em português brasileiro.',",
  "    'Você é o assistente de preenchimento de uma apresentação de entrada em um grupo de WhatsApp. Responda em português brasileiro.',\n    'PERSONALIDADE escolhida pelo administrador (somente estilo, sem mudar regras): ' + String(cfg.presentationAIPersonality || 'acolhedor, claro e respeitoso').slice(0, 700),\n    'A personalidade nunca pode alterar campos, validações, confirmação de idade, consentimento ou decisão de aprovação.',",
  'injeção da personalidade no atendimento privado');

// Todos os módulos usam a versão estável solicitada.
joinSource = replaceOnce(joinSource,
  "  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';",
  "  const model = 'gemini-3.8-flash';",
  'modelo Gemini do assistente');
intelSource = replaceOnce(intelSource,
  "const DEFAULT_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';",
  "const DEFAULT_MODEL = 'gemini-3.8-flash';",
  'modelo Gemini da biblioteca');

// A resposta estruturada separa conversa de pedido de remoção.
const groupHelper = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'group-ai-helper.js.txt'), 'utf8').trimEnd();
joinSource = replaceOnce(joinSource,
  'async function handleIACommand(ctx) {',
  groupHelper + '\n\nasync function handleIACommand(ctx) {',
  'analisador de intenção da IA');

const handleIA = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'handle-ia-command.js.txt'), 'utf8').trimEnd();
joinSource = replaceBetween(joinSource,
  'async function handleIACommand(ctx) {',
  '\nfunction parseOnOff(value) {',
  handleIA + '\n',
  'roteador inteligente do comando !ia');

joinSource = replaceOnce(joinSource,
  "    '!ia pergunta — faz uma pergunta ao assistente quando estiver ativado',",
  "    '!ia pergunta — conversa com o assistente quando estiver ativado',\n    '!ia personalidade grupo texto — define a personalidade da IA no grupo',\n    '!ia personalidade pv texto — define a personalidade da IA nas apresentações privadas',\n    '!ia personalidade ver/reset grupo|pv|ambos — consulta ou redefine personalidades',\n    '!ia confirmar/cancelar — confirma ou cancela uma remoção solicitada pela IA',",
  'ajuda da IA');
joinSource = replaceOnce(joinSource,
  "    '!ia personalidade ver/reset grupo|pv|ambos — consulta ou redefine personalidades',",
  "    '!ia personalidade ver/reset grupo|pv|ambos — consulta ou redefine personalidades',\n    '!personalidade jogador de futebol — atalho para definir o perfil do grupo',",
  'ajuda do atalho !personalidade');
if (!joinSource.includes(MARK_JOIN)) {
  joinSource = joinSource.replace(
    '// LEO_PRESENTATION_GEMINI_ASSISTANT_V1',
    '// LEO_PRESENTATION_GEMINI_ASSISTANT_V1\n// ' + MARK_JOIN
  );
}

// Integra o módulo de cinco comandos novos no roteador principal.
indexSource = replaceOnce(indexSource,
  "import { handleSocialCommand } from './codigo/social-features.js';",
  "import { handleSocialCommand } from './codigo/social-features.js';\nimport { YAMADA_FUN_COMMANDS, handleYamadaFunCommand, startYamadaFunScheduler } from './codigo/yamada-fun.js'; // LEO_YAMADA_EXPANSION_V1",
  'importação dos novos comandos');
indexSource = replaceOnce(indexSource,
  "'recusarsolicitacao', 'ia',",
  "'recusarsolicitacao', 'ia', 'personalidade',",
  'allowlist do comando !personalidade');
indexSource = replaceOnce(indexSource,
  "'entrada','autoaceitar','autoaprovarsolicitacao','criarclausulas','clausulas','solicitacoes','aprovarsolicitacao','recusarsolicitacao',",
  "'entrada','autoaceitar','autoaprovarsolicitacao','criarclausulas','clausulas','solicitacoes','aprovarsolicitacao','recusarsolicitacao','ia','personalidade',",
  'comandos IA no menu de administração');
indexSource = replaceOnce(indexSource,
  '      ...BLACKLIST_COMMANDS\n    ]);',
  '      ...BLACKLIST_COMMANDS,\n      ...YAMADA_FUN_COMMANDS\n    ]);',
  'registro dos novos comandos');
indexSource = replaceOnce(indexSource,
  '        saveStickerToLibrary,\n        send: (to, message, quoted, options = {}) =>\n          sock.sendMessage(\n            to,\n            { text: message, ...options },\n            { quoted }\n          )\n      };',
  '        saveStickerToLibrary,\n        send: (to, message, quoted, options = {}) =>\n          sock.sendMessage(\n            to,\n            { text: message, ...options },\n            { quoted }\n          ),\n        executeAction: async (action, actionValue, actionMsg = msg) => {\n          if (action !== \'ban\') return false;\n          const actionContext = {\n            ...context,\n            msg: actionMsg,\n            command: \'ban\',\n            value: String(actionValue || \'\'),\n            send: (to, message, quoted, options = {}) => sock.sendMessage(\n              to,\n              { text: String(message || \'\').replace(/!ban confirmar/g, \'!ia confirmar\').replace(/!ban cancelar/g, \'!ia cancelar\'), ...options },\n              { quoted }\n            )\n          };\n          return handleSocialCommand(actionContext);\n        }\n      };',
  'ponte protegida para ações da IA');
indexSource = replaceOnce(indexSource,
  '      // LEO_ADVANCED_DISPATCH_V1\n      if (ECONOMY_COMMANDS.includes(command)) {',
  '      // LEO_ADVANCED_DISPATCH_V1\n      if (YAMADA_FUN_COMMANDS.includes(command)) {\n        await handleYamadaFunCommand(context);\n      } else if (ECONOMY_COMMANDS.includes(command)) {',
  'despacho dos novos comandos');
indexSource = replaceOnce(indexSource,
  '        startAdvancedScheduler(currentSock); // LEO_ADVANCED_SCHEDULER_HOOK_V1',
  '        startAdvancedScheduler(currentSock); // LEO_ADVANCED_SCHEDULER_HOOK_V1\n        startYamadaFunScheduler(currentSock); // LEO_YAMADA_FUN_SCHEDULER_V1',
  'inicialização dos lembretes');
indexSource = replaceOnce(indexSource,
  "'\\n!aprovarsolicitacao código / !recusarsolicitacao código' +",
  "'\\n!aprovarsolicitacao código / !recusarsolicitacao código' +\n        '\\n!ia on/off — liga a IA do grupo' +\n        '\\n!personalidade descrição — escolhe uma personalidade livre para a IA do grupo' +\n        '\\n!personalidade pv descrição — escolhe a personalidade do PV das apresentações' +",
  'ajuda do menu administrativo');
indexSource = replaceOnce(indexSource,
  "return '🏆 MENU DE JOGOS E RANKING\\n\\n' + list(['duelo','desafio','quiz','roleta','top','ranking','desafiofig','votefig','roubarfig','adivinhe','resposta','corridafig']);",
  "return '🏆 MENU DE JOGOS E RANKING\\n\\n' + list(['duelo','desafio','quiz','roleta','top','ranking','desafiofig','votefig','roubarfig','adivinhe','resposta','corridafig','impostor','stop','tribunal','campeonato']) + '\\n\\n⏰ Lembretes: !lembrete DD/MM/AAAA HH:MM texto / !lembretes';",
  'menu de jogos e novos recursos');
indexSource = replaceOnce(indexSource,
  '// LEO_GROUP_IA_COMMAND_V1',
  '// LEO_GROUP_IA_COMMAND_V1\n// ' + MARK_INDEX,
  'marcador de instalação no index.js');

// Corrige o fluxo !ban para resolver aliases PN/LID e proteger todos os administradores e o dono do grupo.
const banReplacement = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'ban-command.js.txt'), 'utf8').trimEnd();
socialSource = replaceBetween(socialSource,
  'async function banCommand(ctx) {',
  '\n\nasync function blockUser(ctx, data) {',
  banReplacement + '\n',
  'fluxo de ban com confirmação e aliases PN/LID');

// Arquivos preparados. Só agora começamos a criar backups e gravar.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const targets = [JOIN, INDEX, INTEL, SOCIAL];
if (fs.existsSync(ENV)) targets.push(ENV);
if (fs.existsSync(FUN_DEST)) targets.push(FUN_DEST);
const backups = [];
for (const file of targets) {
  const backup = `${file}.bak-yamada-${stamp}`;
  fs.copyFileSync(file, backup);
  backups.push({ file, backup });
}
let envUpdated = false;
try {
  fs.mkdirSync(path.dirname(FUN_DEST), { recursive: true });
  atomicWrite(FUN_DEST, fs.readFileSync(FUN_SOURCE, 'utf8'));
  atomicWrite(JOIN, joinSource);
  atomicWrite(INDEX, indexSource);
  atomicWrite(INTEL, intelSource);
  atomicWrite(SOCIAL, socialSource);

  let envText = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const envPattern = /^([ \t]*(?:export[ \t]+)?GEMINI_MODEL[ \t]*=[ \t]*).*$/m;
  if (envPattern.test(envText)) envText = envText.replace(envPattern, '$1gemini-3.8-flash');
  else envText = envText.replace(/\s*$/, '') + '\nGEMINI_MODEL=gemini-3.8-flash\n';
  atomicWrite(ENV, envText);
  envUpdated = true;

  for (const file of [JOIN, INDEX, INTEL, SOCIAL, FUN_DEST]) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`Falha de sintaxe em ${path.relative(ROOT, file)}:\n${check.stderr || check.stdout || 'erro desconhecido'}`);
  }
} catch (error) {
  for (const { file, backup } of backups) {
    try { fs.copyFileSync(backup, file); } catch (restoreError) { console.error('[ROLLBACK]', restoreError?.message || restoreError); }
  }
  try { if (!backups.some(item => item.file === FUN_DEST) && fs.existsSync(FUN_DEST)) fs.unlinkSync(FUN_DEST); } catch {}
  stop('Instalação falhou; os arquivos originais foram restaurados. Motivo: ' + (error?.message || error));
}

console.log('\n[INSTALADOR YAMADA] ✅ Expansão instalada e sintaxe validada.');
console.log('• Personalidades livres e independentes para grupo e PV, por grupo.');
console.log('• IA identifica pedidos de remoção; exige administrador, bot admin e confirmação via !ia confirmar.');
console.log('• !ban corrigido para resolver aliases PN/LID e proteger administradores/dono do grupo.');
console.log('• Gemini 3.8 Flash definido nos módulos e em GEMINI_MODEL no .env.');
console.log('• Novos comandos: !impostor, !stop, !tribunal, !lembrete(s) e !campeonato.');
console.log('• O .env foi preservado, exceto GEMINI_MODEL; backup criado junto dos demais arquivos.');
console.log('\nBACKUPS:');
for (const item of backups) console.log('• ' + path.basename(item.backup));
