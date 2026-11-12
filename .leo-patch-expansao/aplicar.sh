#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_ROOT/index.js" ]; then
  echo "❌ Não encontrei index.js em: $PROJECT_ROOT"
  echo "Extraia a pasta .leo-patch-expansao dentro de ~/BotFigurinhas e rode bash .leo-patch-expansao/aplicar.sh"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js não encontrado no Termux."
  exit 1
fi

node "$SCRIPT_DIR/aplicar.mjs" "$PROJECT_ROOT"
