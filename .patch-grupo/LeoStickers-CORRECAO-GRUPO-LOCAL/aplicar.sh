#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$HOME/BotFigurinhas"
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$PATCH_DIR/control-panel.js"
TARGET="$ROOT/control-panel.js"

if [ ! -d "$ROOT" ]; then
  echo "ERRO: não encontrei a pasta $ROOT"
  exit 1
fi
if [ ! -f "$TARGET" ]; then
  echo "ERRO: não encontrei $TARGET. Nenhum arquivo foi alterado."
  exit 1
fi
if [ ! -f "$SOURCE" ]; then
  echo "ERRO: o control-panel.js da correção não foi encontrado."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não está disponível no Termux."
  exit 1
fi

if ! node --check "$SOURCE"; then
  echo "ERRO: a correção não passou na verificação de sintaxe."
  exit 1
fi

BACKUP="$TARGET.backup-grupo-local-$(date +%Y%m%d-%H%M%S)"
cp -p "$TARGET" "$BACKUP"
cp "$SOURCE" "$TARGET"

if ! node --check "$TARGET"; then
  cp -p "$BACKUP" "$TARGET"
  echo "ERRO: a verificação após a cópia falhou. Arquivo original restaurado."
  exit 1
fi

chmod 600 "$TARGET"
echo "CORREÇÃO APLICADA COM SUCESSO."
echo "Backup original: $BACKUP"
echo "Agora inicie o bot com: cd ~/BotFigurinhas && bash start-bot.sh"
