const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview'
];

const cooldowns = new Map();

function getCooldownMs(message, status) {
  const match = String(message || '').match(/(?:retry|try again)\s+in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (match) {
    const ms = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
    if (ms > 0) return Math.min(ms, 24 * 60 * 60 * 1000);
  }
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(String(message))) return 15 * 60 * 1000;
  if (status === 400 && /model.*(not found|unsupported|invalid)|unknown model/i.test(String(message))) return 24 * 60 * 60 * 1000;
  return 60 * 1000;
}

function canFallback(status, message) {
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status === 403 && /quota|rate.?limit|resource.?exhausted/i.test(String(message))) return true;
  if (status === 400 && /model.*(not found|unsupported|invalid)|unknown model/i.test(String(message))) return true;
  return false;
}

export async function requestGeminiWithFallback(body, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada no .env.');

  const timeoutMs = Number(options.timeoutMs) || 25000;
  const label = String(options.label || 'GEMINI');
  const now = Date.now();
  const available = MODELS.filter(model => (cooldowns.get(model) || 0) <= now);

  if (!available.length) {
    const nextTime = Math.min(...MODELS.map(model => cooldowns.get(model) || now));
    const minutes = Math.max(1, Math.ceil((nextTime - now) / 60000));
    throw new Error('Todos os modelos Gemini estão em cooldown. Tente novamente em aproximadamente ' + minutes + ' minuto(s).');
  }

  let lastError = null;

  for (const model of available) {
    try {
      console.log('[' + label + '] Tentando modelo ' + model + '.');
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = String(payload?.error?.message || ('Gemini respondeu HTTP ' + response.status + '.')).slice(0, 500);
        if (!canFallback(response.status, message)) throw new Error(message);

        cooldowns.set(model, Date.now() + getCooldownMs(message, response.status));
        lastError = new Error(message);
        console.warn('[' + label + '] ' + model + ' falhou (HTTP ' + response.status + '). Tentando o próximo.');
        continue;
      }

      console.log('[' + label + '] Resposta recebida de ' + model + '.');
      return payload;
    } catch (error) {
      const message = String(error?.message || error || 'Erro desconhecido').slice(0, 500);
      if (
        error?.name === 'AbortError' ||
        error?.name === 'TimeoutError' ||
        /timed out|timeout|aborted/i.test(message) ||
        error instanceof TypeError
      ) {
        cooldowns.set(model, Date.now() + 60000);
        lastError = error;
        console.warn('[' + label + '] ' + model + ' falhou por timeout/rede. Tentando o próximo.');
        continue;
      }
      throw error;
    }
  }

  throw new Error('Nenhum modelo Gemini respondeu. Última falha: ' + String(lastError?.message || 'erro desconhecido').slice(0, 350));
}
