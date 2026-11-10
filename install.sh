#!/usr/bin/env bash
# Instalador do Léo Stickers para Termux (Android).
# Uso: bash install.sh [--start]
set -Eeuo pipefail

REPO_URL="https://github.com/leozinpvp/LeoStickers.git"
INSTALL_DIR="${LEO_STICKERS_DIR:-$HOME/LeoStickers}"

log() { printf '\n🦊 %s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

show_help() {
  cat <<'HELP'
Instalador do Léo Stickers para Termux

Uso:
  bash install.sh          Instala/atualiza dependências e prepara a configuração.
  bash install.sh --start  Faz a instalação e inicia o bot ao terminar.
  bash install.sh --help   Mostra esta ajuda.

Para definir outra pasta de instalação:
  LEO_STICKERS_DIR="$HOME/MinhaPasta" bash install.sh
HELP
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help; exit 0 ;;
    --start) ;;
    *) fail "Opção desconhecida: $arg. Use --help para ver as opções." ;;
  esac
done

# Se o arquivo foi baixado diretamente do GitHub, prepara uma cópia local do projeto.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
  [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]] || \
    fail "Execute este instalador dentro do Termux (Android)."

  log "Preparando o Termux para baixar o projeto..."
  pkg update -y
  pkg install -y git

  if [[ -e "$INSTALL_DIR" ]]; then
    [[ -d "$INSTALL_DIR/.git" ]] || fail "A pasta $INSTALL_DIR já existe e não é um clone Git. Não vou sobrescrevê-la. Defina LEO_STICKERS_DIR para escolher outra pasta."
    log "Atualizando o código em $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only || fail "Não consegui atualizar o repositório. Verifique se há alterações locais ou conflitos; nada foi apagado."
  else
    log "Baixando o Léo Stickers em $INSTALL_DIR..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || fail "Falha ao clonar o repositório. Confira sua internet e se o repositório está público ou autenticado."
  fi

  exec bash "$INSTALL_DIR/install.sh" "$@"
fi

cd "$SCRIPT_DIR"
[[ -f package-lock.json ]] || fail "package-lock.json não encontrado. Não vou instalar dependências sem o arquivo de versões travadas."
[[ -f config.exemplo.json ]] || fail "config.exemplo.json não encontrado. O pacote do projeto está incompleto."
[[ -f index.js ]] || fail "index.js não encontrado. Execute o instalador na pasta do Léo Stickers."

[[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]] || \
  fail "Este instalador foi feito para Termux no Android."

log "Atualizando a lista de pacotes..."
pkg update -y

log "Instalando Node.js LTS, FFmpeg, Git, TAR e Nano..."
pkg install -y nodejs-lts ffmpeg git tar nano

command -v node >/dev/null 2>&1 || fail "Node.js não foi instalado corretamente."
command -v npm >/dev/null 2>&1 || fail "npm não foi encontrado após instalar Node.js."
command -v ffmpeg >/dev/null 2>&1 || fail "FFmpeg não foi instalado corretamente."
command -v ffprobe >/dev/null 2>&1 || fail "ffprobe não foi encontrado. Reinstale o pacote ffmpeg."
command -v tar >/dev/null 2>&1 || fail "O comando tar não foi encontrado."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  fail "O projeto precisa do Node.js 20 ou superior; sua versão é $(node --version). Atualize o pacote nodejs-lts no Termux."
fi

log "Instalando as dependências exatas do package-lock.json..."
npm ci --omit=dev --no-audit --no-fund

# Nunca substitui configuração, sessão ou bancos locais já existentes.
if [[ ! -f config.json ]]; then
  cp config.exemplo.json config.json
  log "Criei config.json a partir do exemplo. Você precisa preencher os seus dados antes de iniciar o bot."
else
  log "Configuração existente preservada: config.json não foi alterado."
fi

mkdir -p logs
chmod +x start-bot.sh

log "Validando a sintaxe dos arquivos JavaScript..."
for file in ./*.js; do
  [[ -f "$file" ]] || continue
  node --check "$file"
done

printf '\n✅ Instalação concluída!\n'
printf 'Node.js: %s\n' "$(node --version)"
printf 'npm: %s\n' "$(npm --version)"
printf 'FFmpeg: %s\n' "$(ffmpeg -version | head -n 1)"

if [[ ! -f config.json ]] || grep -q 'NUMERO_DO_PROPRIETARIO' config.json; then
  printf '\n📝 Revise sua configuração com:\n  nano config.json\n'
fi

printf '\nPara iniciar o bot:\n  bash start-bot.sh\n'
printf 'Para parar o supervisor: pressione CTRL+C.\n'

if [[ " ${*:-} " == *" --start "* ]]; then
  log "Iniciando Léo Stickers..."
  exec bash ./start-bot.sh
fi
