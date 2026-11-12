#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/backup-controle-inteligente-$STAMP"
STAGE="$(mktemp -d "$ROOT/.leo-control-stage.XXXXXX")"
INSTALL_OK=0
EXISTED_CONTROL=0
EXISTED_BUTTONS=0

rollback() {
  rc=$?
  if [ "$INSTALL_OK" -ne 1 ]; then
    echo "❌ Falha na atualização. Restaurando os arquivos anteriores..."
    [ ! -f "$BACKUP/index.js" ] || cp -p "$BACKUP/index.js" "$ROOT/index.js"
    [ ! -f "$BACKUP/join-approval.js" ] || cp -p "$BACKUP/join-approval.js" "$ROOT/join-approval.js"
    if [ "$EXISTED_CONTROL" -eq 1 ] && [ -f "$BACKUP/control-panel.js" ]; then cp -p "$BACKUP/control-panel.js" "$ROOT/control-panel.js"; else rm -f "$ROOT/control-panel.js"; fi
    if [ "$EXISTED_BUTTONS" -eq 1 ] && [ -f "$BACKUP/interactive-buttons.js" ]; then cp -p "$BACKUP/interactive-buttons.js" "$ROOT/interactive-buttons.js"; else rm -f "$ROOT/interactive-buttons.js"; fi
    echo "Backup: $BACKUP"
  fi
  rm -rf "$STAGE"
  exit "$rc"
}
trap rollback EXIT

for f in index.js join-approval.js package.json; do
  [ -f "$ROOT/$f" ] || { echo "❌ Não encontrei $f em $ROOT. Extraia o pacote dentro de ~/BotFigurinhas."; exit 1; }
done
BAILEYS="$ROOT/node_modules/@whiskeysockets/baileys"
[ -f "$BAILEYS/package.json" ] || { echo "❌ Baileys não encontrado em node_modules."; exit 1; }
VERSION="$(node -p "require('$BAILEYS/package.json').version")"
[ "$VERSION" = "6.7.18" ] || { echo "❌ Esta atualização foi preparada para Baileys 6.7.18; instalado: $VERSION. Nada foi alterado."; exit 1; }
grep -q "LEGACY_MOCIDADE_GROUP_ID" "$ROOT/join-approval.js" || { echo "❌ O módulo multigrupo V2 não foi encontrado. Instale/teste a atualização V2 primeiro."; exit 1; }
grep -q "agePolicyConfigured" "$ROOT/join-approval.js" || { echo "❌ O sistema de idade V2 não foi encontrado. Nada foi alterado."; exit 1; }
for f in join-approval.js control-panel.js interactive-buttons.js patch-index.mjs test-join-approval.mjs test-control-panel.mjs test-baileys-buttons.mjs test-presentation-buttons.mjs; do
  [ -f "$SCRIPT_DIR/$f" ] || { echo "❌ Arquivo do pacote ausente: $f"; exit 1; }
done

mkdir -p "$BACKUP"
cp -p "$ROOT/index.js" "$BACKUP/index.js"
cp -p "$ROOT/join-approval.js" "$BACKUP/join-approval.js"
if [ -f "$ROOT/control-panel.js" ]; then EXISTED_CONTROL=1; cp -p "$ROOT/control-panel.js" "$BACKUP/control-panel.js"; fi
if [ -f "$ROOT/interactive-buttons.js" ]; then EXISTED_BUTTONS=1; cp -p "$ROOT/interactive-buttons.js" "$BACKUP/interactive-buttons.js"; fi

cp "$ROOT/index.js" "$STAGE/index.js"
cp "$SCRIPT_DIR/join-approval.js" "$STAGE/join-approval.js"
cp "$SCRIPT_DIR/control-panel.js" "$STAGE/control-panel.js"
cp "$SCRIPT_DIR/interactive-buttons.js" "$STAGE/interactive-buttons.js"

node "$SCRIPT_DIR/patch-index.mjs" "$STAGE/index.js"
for f in index.js join-approval.js control-panel.js interactive-buttons.js; do node --check "$STAGE/$f"; done

# Testes sem rede e sem alterar o banco de dados real do bot.
LEO_JOIN_APPROVAL_DATA="$STAGE/test-join-approval-data.json" node "$SCRIPT_DIR/test-join-approval.mjs"
node "$SCRIPT_DIR/test-control-panel.mjs"
node "$SCRIPT_DIR/test-baileys-buttons.mjs"
node "$SCRIPT_DIR/test-presentation-buttons.mjs"

# Instalação atômica por arquivo; sessão/.env/node_modules e bancos ficam intactos.
for f in join-approval.js control-panel.js interactive-buttons.js index.js; do
  cp "$STAGE/$f" "$ROOT/$f.tmp-$$"
  mv -f "$ROOT/$f.tmp-$$" "$ROOT/$f"
done
for f in index.js join-approval.js control-panel.js interactive-buttons.js; do node --check "$ROOT/$f"; done

INSTALL_OK=1
trap - EXIT
rm -rf "$STAGE"
echo "✅ Léo Stickers — Controle Inteligente V1 instalado."
echo "Backup: $BACKUP"
echo "Preservados: sessão, .env, node_modules, start-bot.sh e bancos de apresentação existentes."
echo "Comandos: !status e !grupos (no PV do proprietário)."
echo "Os botões precisam ser conferidos no WhatsApp real; os testes locais não enviam mensagens." 
