#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$HOME/BotFigurinhas"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -d "$ROOT" ] || { echo "❌ Pasta ~/BotFigurinhas não encontrada."; exit 1; }
[ -f "$ROOT/index.js" ] && [ -f "$ROOT/control-panel.js" ] || {
  echo "❌ Não encontrei index.js e control-panel.js no projeto. Nada foi alterado."; exit 1;
}
[ -f "$PATCH_DIR/index.js" ] && [ -f "$PATCH_DIR/control-panel.js" ] || {
  echo "❌ Arquivos do pacote incompletos. Nada foi alterado."; exit 1;
}

if ! grep -q 'preapplyGroupControlCommands' "$PATCH_DIR/index.js" || \
   ! grep -q 'shouldIgnoreGroupTimestamp' "$PATCH_DIR/index.js" || \
   ! grep -q 'pausedAtMs' "$PATCH_DIR/control-panel.js"; then
  echo "❌ O pacote não contém a correção esperada. Nada foi alterado."; exit 1
fi

command -v node >/dev/null 2>&1 || { echo "❌ Node.js não foi encontrado."; exit 1; }
node --check "$PATCH_DIR/index.js"
node --check "$PATCH_DIR/control-panel.js"

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p "$ROOT/index.js" "$ROOT/index.js.backup-fila-pausa-$STAMP"
cp -p "$ROOT/control-panel.js" "$ROOT/control-panel.js.backup-fila-pausa-$STAMP"

cp "$PATCH_DIR/index.js" "$ROOT/index.js"
cp "$PATCH_DIR/control-panel.js" "$ROOT/control-panel.js"

if ! node --check "$ROOT/index.js" || ! node --check "$ROOT/control-panel.js"; then
  cp -p "$ROOT/index.js.backup-fila-pausa-$STAMP" "$ROOT/index.js"
  cp -p "$ROOT/control-panel.js.backup-fila-pausa-$STAMP" "$ROOT/control-panel.js"
  echo "❌ A validação falhou; os arquivos anteriores foram restaurados."; exit 1
fi

echo "✅ Correção da fila instalada e validada."
echo "Backups: index.js.backup-fila-pausa-$STAMP e control-panel.js.backup-fila-pausa-$STAMP"
echo "Inicie com: cd ~/BotFigurinhas && bash start-bot.sh"
