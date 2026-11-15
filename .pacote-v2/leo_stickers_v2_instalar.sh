#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

ROOT="${LEO_STICKERS_ROOT:-$HOME/BotFigurinhas}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/assets/economia"
DEST="$ROOT/assets/economia"

echo
echo "🦊 LÉO STICKERS — INSTALADOR DE IMAGENS V2"
echo

if [ ! -d "$ROOT" ] || [ ! -f "$ROOT/index.js" ]; then
  echo "ERRO: não encontrei $ROOT/index.js"
  echo "Confirme que o projeto está em ~/BotFigurinhas."
  exit 1
fi

if [ ! -d "$SOURCE" ]; then
  echo "ERRO: pasta de imagens não encontrada dentro do pacote."
  exit 1
fi

COUNT="$(find "$SOURCE" -type f -name '*.png' | wc -l | tr -d ' ')"
if [ "$COUNT" -ne 17 ]; then
  echo "ERRO: esperava 17 PNGs; encontrei $COUNT. Nada foi instalado."
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
if [ -d "$DEST" ] && [ "$(find "$DEST" -type f 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]; then
  mkdir -p "$ROOT/backups"
  cp -a "$DEST" "$ROOT/backups/economia-imagens-$STAMP"
  echo "✅ Backup das imagens anteriores criado em backups/economia-imagens-$STAMP"
fi

mkdir -p "$DEST"
cp -a "$SOURCE/." "$DEST/"

INSTALLED="$(find "$DEST" -type f -name '*.png' | wc -l | tr -d ' ')"
echo
echo "✅ Instalação das imagens concluída."
echo "🖼️ PNGs presentes na pasta: $INSTALLED"
echo "📁 Destino: $DEST"
echo
echo "Pastas:"
echo "  assets/economia/profissoes"
echo "  assets/economia/loja"
echo "  assets/economia/ui"
echo
echo "Atenção: este pacote instala as imagens. Ele não modifica index.js nem ativa comandos de comércio."
