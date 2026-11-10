# Léo Stickers — instalação e entrega

Este repositório contém o código do bot, os módulos utilizados, dependências travadas, assets, GIFs/vídeos e a biblioteca de figurinhas.

## Instalação no Termux (Android)

Depois que o arquivo `install.sh` estiver publicado na branch `main`, a instalação inicial pode ser feita com:

```bash
pkg update -y
pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/leozinpvp/LeoStickers/main/install.sh -o "$HOME/leo-stickers-install.sh"
bash "$HOME/leo-stickers-install.sh"
```

O instalador baixa o repositório para `~/LeoStickers`, instala Node.js LTS, FFmpeg, Git, TAR e Nano, instala as dependências com `npm ci` e valida a sintaxe dos arquivos JavaScript.

Depois, revise a configuração:

```bash
cd ~/LeoStickers
nano config.json
```

Para iniciar:

```bash
bash start-bot.sh
```

Se o projeto já estiver clonado, entre na pasta e execute `bash install.sh`. Para instalar e iniciar em seguida, use `bash install.sh --start`.

O projeto requer Node.js 20 ou superior. O FFmpeg e o ffprobe são usados por recursos de mídia.

## Atualização de uma instalação existente

Dentro da pasta do projeto:

```bash
git pull --ff-only
bash install.sh
```

O instalador não apaga nem substitui `config.json`, a pasta `sessao/` ou os bancos de dados locais. Se a pasta `~/LeoStickers` já existir e não for um clone Git, o instalador interrompe a execução em vez de sobrescrevê-la.

## Segurança

O repositório não deve conter sessão do WhatsApp, `.env`, configuração real, bancos de dados locais, logs, backups, `node_modules` ou histórico de sessão. Nunca publique `config.json`, arquivos de `sessao/` ou tokens. Faça uma nova vinculação do WhatsApp; não reutilize credenciais que já tenham sido expostas.
