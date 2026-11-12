#!/data/data/com.termux/files/usr/bin/bash

cd "$(dirname "$0")" || exit 1
mkdir -p logs

RESTART_LOG="./logs/reinicios.log"
RESTART_DELAY=5
STOP_REQUESTED=0
export LEO_STICKERS_SUPERVISED=1

now() {
  TZ=America/Sao_Paulo date '+%d/%m/%Y %H:%M:%S'
}

stop_supervisor() {
  STOP_REQUESTED=1
}
trap stop_supervisor INT TERM

while [ "$STOP_REQUESTED" -eq 0 ]; do
  printf '[%s] Iniciando Léo Stickers...\n' "$(now)" | tee -a "$RESTART_LOG"
  MEMORY_MB="$(node -e 'try { const d=require("./leo-advanced-data.json"); const n=Number(d.performance?.memoryMb); console.log([512,768,1024].includes(n) ? n : 768); } catch { console.log(768); }')"
    node --max-old-space-size="$MEMORY_MB" index.js
  BOT_STATUS=$?

  if [ "$STOP_REQUESTED" -eq 1 ]; then
    break
  fi

  printf '[%s] ⚠️ PROCESSO DO BOT ENCERROU (código %s). Reinício automático em %s segundos.\n' \
    "$(now)" "$BOT_STATUS" "$RESTART_DELAY" | tee -a "$RESTART_LOG"
  sleep "$RESTART_DELAY"
done

printf '[%s] Supervisor encerrado manualmente.\n' "$(now)" | tee -a "$RESTART_LOG"
