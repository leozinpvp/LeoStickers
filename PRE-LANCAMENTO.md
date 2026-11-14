# Léo Stickers — atualização de pré-lançamento

Este pacote prepara a base do bot para testes internos e um beta fechado. **Não é uma autorização para começar a cobrar clientes ainda**: as integrações externas precisam ser configuradas e testadas no ambiente real do projeto.

## O que foi alterado

### 1. Figurinhas e biblioteca inteligente

- `!s`: cria figurinha preenchendo o quadro 512×512; pode deformar a proporção.
- `!fig`: preserva a proporção, completando o espaço restante com transparência.
- Os dois comandos aceitam foto e vídeo. Vídeos viram WebP animado, respeitando o limite configurado (máximo de 10 segundos) e tentando reduzir o arquivo para até 500 KB.
- `!sn`: modo deformado sem metadados.
- `!figanimada`: mantido como compatibilidade com o comando antigo; continua convertendo vídeo no modo que preserva proporção.
- `!buscarfig tema [quantidade]`: pesquisa **somente as figurinhas já existentes na biblioteca**; quantidade padrão 5, máximo 10.
- `!statusbiblioteca`: mostra total, itens classificados e pendentes.
- `!reindexarfigs`: dono analisa o próximo lote (24 itens por padrão).
- `!reindexarfigs 100`: analisa até 100 itens pendentes.
- `!reindexarfigs tudo`: tenta analisar até 2.000 itens pendentes. Para uma biblioteca grande, é melhor avançar em lotes e observar limites/custos da API.

O Gemini classifica cada figurinha durante a indexação; a busca normal consulta o índice local `figurinhas/ia-index.json`, não envia toda a biblioteca ao Gemini a cada pesquisa. Novas figurinhas coletadas precisam ser indexadas para aparecer na busca inteligente. O índice é um arquivo local e deve entrar nos backups do servidor.

Configure `GEMINI_API_KEY` no `.env`. Não coloque a chave diretamente no código, no Git ou em mensagens. Uma chave que tenha sido compartilhada deve ser revogada e substituída.

### 2. Solicitações de entrada e avisos no PV

- O comando `!aprovarsolicitacao CÓDIGO` agora é encaminhado ao módulo de aprovação correto.
- Os registros guardam separadamente o identificador usado no grupo (LID, quando existir) e o número de telefone usado no PV.
- Na aprovação/recusa, o bot tenta recuperar o número pelo mapeamento LID do Baileys. Se não encontrar, tenta o LID como último recurso.
- Falhas de envio no privado aparecem na resposta do grupo e nos logs, em vez de serem silenciosamente ignoradas.
- A reconciliação de membros considera os aliases PN/LID dos registros antigos.

O WhatsApp pode impedir mensagens privadas para alguém que nunca iniciou conversa com o bot ou que restringiu mensagens. Nesses casos, o bot informa a falha; a pessoa deve abrir o PV e enviar uma mensagem ao bot para iniciar a conversa. Isso não pode ser garantido apenas pelo código.

### 3. Aluguel e Pix

Comandos planejados/implementados na base:

- `!planos`
- `!alugar basic`, `!alugar pro` ou `!alugar premium`
- `!renovar` — abre uma solicitação de renovação para aprovação manual.
- `!meualuguel`

- `!clientes` e `!aluguéis` — proprietário
- `!revogar ID_DO_GRUPO` — proprietário


**A renovação exige nova solicitação e aprovação manual após conferência do pagamento.**

#### Aprovação manual de aluguel

1. O administrador do grupo solicita com `!alugar basic|pro|premium` ou `!renovar`.
2. O bot cria um código de solicitação e avisa o proprietário do bot no privado.
3. O solicitante envia o comprovante diretamente ao responsável, informando o código.
4. Depois de conferir o recebimento fora do bot, o proprietário usa `!aprovaraluguel CÓDIGO` ou `!recusaraluguel CÓDIGO`.
5. `!clientes` lista solicitações pendentes e licenças; `!meualuguel` mostra a situação do grupo; `!revogar ID_DO_GRUPO` revoga uma licença.



## O que ainda não está pronto para produção

- Configurar e validar a chave Gemini no `.env` e indexar o acervo existente.
- Testar o fluxo de solicitação, notificação privada ao proprietário, aprovação, recusa e renovação manual.
- Confirmar os recursos e os preços de cada plano; a matriz de funções por plano ainda não está aplicada.
- Instalar/validar o módulo econômico V3. O usuário informou que ainda não o instalou; este pacote não o declara como pronto.
- Testar conexão, comandos, aprovação/privado, animações, coleta, backup/restauração e licenças no WhatsApp real.
- Fazer beta fechado com 3–5 grupos antes de vender.
- Preparar hospedagem permanente, monitoramento, termos, privacidade, suporte e processo de cancelamento.

## Verificação feita neste pacote

- `npm test`: passou.
- Sintaxe: válida em 18 arquivos JavaScript.
- Testes unitários: 10/10 aprovados.
