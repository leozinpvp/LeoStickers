#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$HOME/BotFigurinhas"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -d "$ROOT" ] || { echo "❌ Pasta ~/BotFigurinhas não encontrada."; exit 1; }
[ -f "$ROOT/index.js" ] && [ -f "$ROOT/control-panel.js" ] || { echo "❌ Não encontrei index.js e control-panel.js no projeto."; exit 1; }
if ! grep -q 'getGroupBotEnabledAt' "$PATCH_DIR/index.js" || ! grep -q 'enabledAtMs' "$PATCH_DIR/control-panel.js"; then
  echo "❌ Arquivos do patch incompletos. Nada foi alterado."; exit 1
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p "$ROOT/index.js" "$ROOT/index.js.backup-pausa-$STAMP"
cp -p "$ROOT/control-panel.js" "$ROOT/control-panel.js.backup-pausa-$STAMP"
cp "$PATCH_DIR/index.js" "$ROOT/index.js"
cp "$PATCH_DIR/control-panel.js" "$ROOT/control-panel.js"
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/index.js"
  node --check "$ROOT/control-panel.js"
fi
echo "✅ Correção instalada. Backups: index.js.backup-pausa-$STAMP e control-panel.js.backup-pausa-$STAMP"
echo "Agora inicie com: cd ~/BotFigurinhas && bash start-bot.sh"
