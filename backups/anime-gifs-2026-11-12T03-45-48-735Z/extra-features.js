import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { searchGiphyGif, downloadGiphyGif } from './giphy-library.js';
import { findThematicGif } from './gif-matcher.js';

export const GAME_GIF_QUERIES = Object.freeze({
  '8ball': ['anime magic 8 ball reaction', 'anime yes or no thinking'],
  dado: ['anime rolling dice reaction', 'anime dice game'],
  moeda: ['anime coin toss reaction', 'anime flipping coin'],
  sorteio: ['anime lottery winner reaction', 'anime raffle winner celebration'],
  escolher: ['anime choosing between two things', 'anime indecisive reaction'],
  parouimpar: ['anime odd or even hand game', 'anime hand guessing game'],
  ppt: ['anime rock paper scissors scene', 'anime janken game'],
  numeroaleatorio: ['anime random number reaction', 'anime number guessing reaction'],
  embaralhar: ['anime card shuffle scene', 'anime shuffling playing cards'],
  anagrama: ['anime word puzzle reaction', 'anime solving letters puzzle'],
  rima: ['anime rap battle scene', 'anime microphone rap reaction'],
  frasealeatoria: ['anime inspirational quote reaction', 'anime dramatic quote scene'],
  emoji: ['anime expressive reaction face', 'anime funny reaction face'],
  roletatemas: ['anime spinning roulette wheel', 'anime random wheel reaction'],
  quemseria: ['anime thinking who is it reaction', 'anime curious pointing scene'],
  desculpa: ['anime apologizing embarrassed scene', 'anime sorry bow reaction'],
  apelido: ['anime teasing nickname reaction', 'anime playful teasing scene'],
  conselho: ['anime serious advice scene', 'anime mentor giving advice'],
  piada: ['anime laughing hard reaction', 'anime comedy laughing scene'],
  perguntaaleatoria: ['anime confused question mark reaction', 'anime puzzled face scene'],
  verdade: ['anime serious truth reaction', 'anime shocked honest reaction'],
  desafioflash: ['anime challenge accepted scene', 'anime determined fighting pose'],
  eununca: ['anime shocked confession reaction', 'anime embarrassed party reaction'],
  quemnunca: ['anime pointing at someone reaction', 'anime surprised group reaction'],
  confissao: ['anime secret whisper scene', 'anime shy confession scene'],
  testeamor: ['anime couple compatibility reaction', 'anime romantic blushing reaction'],
  personalidade: ['anime personality reaction montage', 'anime expressive character reaction'],
  superpoder: ['anime power awakening scene', 'anime aura power up reaction'],
  profissao: ['anime job interview reaction', 'anime office worker reaction'],
  animal: ['anime cute animal reaction', 'anime pet cute scene'],
  heroi: ['anime hero entrance pose', 'anime heroic arrival scene'],
  vilao: ['anime villain evil laugh scene', 'anime villain smirk reaction'],
  elemento: ['anime elemental powers fire water wind', 'anime elemental magic scene'],
  planeta: ['anime outer space planet scene', 'anime galaxy stars reaction'],
  comida: ['anime eating delicious food scene', 'anime food reaction happy'],
  cor: ['anime colorful aura transformation', 'anime rainbow colorful scene'],
  musica: ['anime dancing to music scene', 'anime band performance reaction'],
  filme: ['anime watching movie popcorn scene', 'anime cinema reaction'],
  time: ['anime team victory celebration', 'anime sports team cheering'],
  previsao: ['anime fortune teller crystal ball', 'anime predicting the future scene'],
  sorte: ['anime lucky reaction celebration', 'anime good luck happy scene'],
  azar: ['anime bad luck comedy fail', 'anime unlucky shocked reaction'],
  quemganha: ['anime winner victory pose', 'anime tournament winner celebration'],
  mancheteabsurda: ['anime breaking news shocked reaction', 'anime dramatic news reporter'],
  matar: ['anime dramatic fainting scene no blood', 'anime dramatic defeat reaction'],
  bater: ['anime slap scene reaction', 'anime character gets slapped comedy'],
  beijar: ['anime couple kiss scene', 'anime romantic kiss reaction'],
  chutar: ['anime kick impact fight scene', 'anime character flying kick'],
  abracar: ['anime warm hug scene', 'anime friends hugging tightly'],
  cafune: ['anime head pat scene', 'anime gentle head rub cute'],
  morder: ['anime playful cheek bite scene', 'anime cute bite reaction'],
  empurrar: ['anime comedic shove scene', 'anime character pushing another'],
  highfive: ['anime high five scene', 'anime friends high five celebration'],
  assustar: ['anime jump scare shocked reaction', 'anime scared surprised face'],
  proteger: ['anime protecting friend from attack', 'anime shield block save friend'],
  elogiar: ['anime blushing after compliment', 'anime shy happy compliment reaction'],
  zoar: ['anime teasing laughing scene', 'anime playful roast reaction'],
  salvar: ['anime hero rescue scene', 'anime catching friend before falling'],
  dancinha: ['anime character funny dance scene', 'anime dance meme'],
  cumprimentar: ['anime greeting handshake scene', 'anime waving hello reaction'],
  listanegra: ['death note light yagami writing name notebook']
});

const GAME_GIF_CACHE = path.resolve('./gifs/cache');
const DEATH_NOTE_GIF_URL = 'https://media1.tenor.com/m/qRf5wXcXlDMAAAAd/death-note-light.gif';

function validGameMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.length <= 8 * 1024 * 1024 && buffer.subarray(4, 8).toString() === 'ftyp';
}

async function deathNoteGifBuffer() {
  const gifPath = path.join(GAME_GIF_CACHE, 'listanegra-source.gif');
  const mp4Path = path.join(GAME_GIF_CACHE, 'listanegra.mp4');
  fs.mkdirSync(GAME_GIF_CACHE, { recursive: true });
  try {
    const cached = fs.readFileSync(mp4Path);
    if (validGameMp4(cached)) return cached;
  } catch {}

  let gifBuffer;
  try {
    gifBuffer = fs.readFileSync(gifPath);
  } catch {
    const sourceUrl = new URL(DEATH_NOTE_GIF_URL);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'media1.tenor.com') {
      throw new Error('Origem do GIF Death Note não autorizada.');
    }
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Não foi possível baixar o GIF do Death Note.');
    const finalUrl = new URL(response.url || sourceUrl);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'media1.tenor.com') {
      throw new Error('Redirecionamento do GIF Death Note não autorizado.');
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 5 * 1024 * 1024) throw new Error('O GIF Death Note ultrapassa 5 MB.');
    gifBuffer = Buffer.from(await response.arrayBuffer());
    if (gifBuffer.length < 16 || gifBuffer.length > 5 * 1024 * 1024) throw new Error('GIF Death Note vazio ou grande demais.');
    if (!['GIF87a', 'GIF89a'].includes(gifBuffer.subarray(0, 6).toString())) throw new Error('O arquivo do Death Note não é um GIF válido.');
    fs.writeFileSync(gifPath, gifBuffer);
  }

  const mp4 = await runFFmpeg(gifBuffer, [
    '-hide_banner','-loglevel','error','-i','pipe:0','-t','8',
    '-vf','fps=15,scale=498:-2','-an','-c:v','libx264','-preset','veryfast',
    '-crf','28','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'
  ]);
  if (!validGameMp4(mp4)) throw new Error('Não foi possível preparar o GIF Death Note para o WhatsApp.');
  fs.writeFileSync(mp4Path, mp4);
  return mp4;
}

async function gameGifBuffer(command) {
  fs.mkdirSync(GAME_GIF_CACHE, { recursive: true });
  if (command === 'listanegra') {
    try { return await deathNoteGifBuffer(); }
    catch (tenorError) {
      const queries = GAME_GIF_QUERIES.listanegra || [];
      for (const query of queries) {
        try {
          const results = await searchGiphyGif(query);
          const result = findThematicGif(results, query);
          if (result) {
            const buffer = await downloadGiphyGif(result);
            if (validGameMp4(buffer)) {
              fs.writeFileSync(path.join(GAME_GIF_CACHE, 'listanegra-giphy-v5.mp4'), buffer);
              return buffer;
            }
          }
        } catch {}
      }
      throw tenorError;
    }
  }

  const rawQueries = GAME_GIF_QUERIES[command];
  const queries = (Array.isArray(rawQueries) ? rawQueries : [rawQueries]).filter(Boolean);
  if (!queries.length) return null;

  const cacheKey = `${command}-thematic-v6`;
  const filepath = path.join(GAME_GIF_CACHE, `${command}-thematic-v6.mp4`);
  try {
    const cached = fs.readFileSync(filepath);
    if (validGameMp4(cached)) return cached;
    fs.rmSync(filepath, { force: true });
  } catch {}

  let lastError = null;
  for (const query of queries) {
    try {
      const results = await searchGiphyGif(query);
      const result = findThematicGif(results, query);
      if (!result) continue;
      const buffer = await downloadGiphyGif(result);
      if (!validGameMp4(buffer)) throw new Error('GIPHY não retornou um MP4 válido.');
      fs.writeFileSync(filepath, buffer);
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function replyWithGameGif(ctx, command, caption, mentions = []) {
  let buffer = null;
  try {
    buffer = await gameGifBuffer(command);
  } catch (error) {
    // Sem chave, sem rede ou sem mídia relevante: mantém a brincadeira funcional em texto.
    console.warn(`[GIF ${command}] ${String(error?.message || error).slice(0, 180)}`);
  }

  if (buffer) {
    try {
      await ctx.sock.sendMessage(ctx.jid, {
        video: buffer,
        mimetype: 'video/mp4',
        gifPlayback: true,
        caption,
        ...(mentions.length ? { mentions } : {})
      }, { quoted: ctx.msg });
      return true;
    } catch (error) {
      console.warn(`[ENVIO GIF ${command}] ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  return reply(ctx, caption);
}

// Reutilizado pela moderação: tenta o GIF Death Note e preserva resposta em texto se indisponível.
export async function sendListanegraGif(ctx, caption, mentions = []) {
  return replyWithGameGif(ctx, 'listanegra', caption, mentions);
}

const DATA_FILE = path.resolve('./extra-games.json');
const LIBRARY_DIR = path.resolve('./figurinhas/biblioteca');
function readState(){try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch{return {scores:{},lastGame:{}};}}
function writeState(s){fs.writeFileSync(DATA_FILE,JSON.stringify(s,null,2));}
function who(ctx){return String(ctx.sender||ctx.jid||'').split('@')[0].split(':')[0];}
function pick(a){return a[Math.floor(Math.random()*a.length)];}
function reply(ctx,t){return ctx.send(ctx.jid,t,ctx.msg);}
function runFFmpeg(input,args){return new Promise((resolve,reject)=>{const p=spawn('ffmpeg',args);const out=[],err=[];p.stdout.on('data',x=>out.push(x));p.stderr.on('data',x=>err.push(x));p.on('error',reject);p.on('close',c=>c===0&&Buffer.concat(out).length?resolve(Buffer.concat(out)):reject(new Error(Buffer.concat(err).toString().slice(-1200)||'FFmpeg não conseguiu processar a mídia.')));p.stdin.on('error',()=>{});p.stdin.end(input);});}
function unwrap(m){
  let x=m;
  for(let i=0;i<12&&x;i++){
    if(x.audioMessage||x.videoMessage||x.imageMessage||x.stickerMessage)return x;
    x=x.ephemeralMessage?.message||x.viewOnceMessage?.message||x.viewOnceMessageV2?.message||x.viewOnceMessageV2Extension?.message||x.documentWithCaptionMessage?.message||x.deviceSentMessage?.message||x.editedMessage?.message||x.messageContextInfo?.message;
  }
  return x||{};
}
function getAudioTarget(ctx){
  // Reutiliza o alvo de mídia que o index.js já identificou, inclusive áudio citado.
  if(ctx.target?.type==='audioMessage'&&ctx.target.message&&ctx.target.key)return ctx.target;
  const m=unwrap(ctx.msg?.message||{});
  if(m.audioMessage)return {key:ctx.msg.key,message:ctx.msg.message,type:'audioMessage'};
  const q=m.extendedTextMessage?.contextInfo||m.imageMessage?.contextInfo||m.videoMessage?.contextInfo||m.documentMessage?.contextInfo;
  if(!q?.quotedMessage)return null;
  const qm=unwrap(q.quotedMessage);
  if(!qm.audioMessage)return null;
  return {key:{remoteJid:ctx.msg.key.remoteJid,id:q.stanzaId,participant:q.participant,fromMe:false},message:q.quotedMessage,type:'audioMessage'};
}
async function audioCommand(ctx,c){
  const target=getAudioTarget(ctx);if(!target)return reply(ctx,`🎧 Responda a um áudio ou envie um áudio junto com !${c}.`);
  const input=await ctx.getMedia(target);if(!input?.length)return reply(ctx,'Não consegui baixar o áudio.');
  if(input.length>20*1024*1024)return reply(ctx,'O áudio ultrapassa o limite de 20 MB.');
  if(c==='audinfo'){
    const r=spawnSync('ffprobe',['-v','error','-show_entries','format=duration,size,bit_rate:stream=codec_name,sample_rate,channels','-of','json','-i','pipe:0'],{input,encoding:'utf8',maxBuffer:1024*1024});
    if(r.status!==0)return reply(ctx,'Não consegui analisar esse áudio.');
    let d={};try{d=JSON.parse(r.stdout);}catch{}
    const f=d.format||{},st=d.streams?.[0]||{};return reply(ctx,`🎧 INFORMAÇÕES DO ÁUDIO\nDuração: ${Number(f.duration||0).toFixed(2)} s\nFormato: ${st.codec_name||'desconhecido'}\nTaxa: ${st.sample_rate||'—'} Hz\nCanais: ${st.channels||'—'}\nTamanho: ${(Number(f.size||input.length)/1024).toFixed(1)} KB`);
  }
  const arg=String(ctx.value||'').trim();let af='anull',format='mp3',mime='audio/mpeg',file='audio.mp3',extra=[],post=[];
  const filters={audmono:'pan=mono|c0=0.5*c0+0.5*c1',audstereo:'aformat=channel_layouts=stereo',audnormalizar:'loudnorm=I=-16:TP=-1.5:LRA=11',audgrave:'equalizer=f=110:width_type=h:width=180:g=5',audagudo:'equalizer=f=3500:width_type=h:width=1800:g=4',audeco:'aecho=0.8:0.9:500:0.25',audreverb:'aecho=0.8:0.88:60|100|140:0.35|0.25|0.15',audrapido:'atempo=1.25',audlento:'atempo=0.8',audreverso:'areverse',audfadein:'afade=t=in:st=0:d=2',audfadeout:'afade=t=out:st=1:d=2',audremoverruido:'afftdn=nf=-25',audvoz:'asetrate=44100*1.12,aresample=44100'};
  if(filters[c] && c!=='audmono' && c!=='audstereo')af=filters[c];
  if(c==='audvolume'){let db=Number(arg||'3');if(!Number.isFinite(db))db=3;db=Math.max(-12,Math.min(12,db));af=`volume=${db}dB`;}
  if(c==='audcortar'){const parts=arg.split(/\s+/);const start=Math.max(0,Math.min(600,Number(parts[0]||0)));const end=Math.max(start+0.2,Math.min(600,Number(parts[1]||start+10)));post=['-ss',String(start),'-t',String(end-start)];}
  if(c==='audmono')post.push('-ac','1');
  if(c==='audstereo')post.push('-ac','2');
  if(c==='audmp3'){format='mp3';mime='audio/mpeg';file='convertido.mp3';}
  if(c==='audogg'){format='ogg';mime='audio/ogg; codecs=opus';file='convertido.ogg';}
  if(c==='audwav'){format='wav';mime='audio/wav';file='convertido.wav';}
  if(c==='audmp3'||c==='audogg'||c==='audwav')af='anull';
  const codec=format==='wav'?['-c:a','pcm_s16le']:format==='ogg'?['-c:a','libopus','-b:a','96k']:['-c:a','libmp3lame','-b:a','128k'];
  const output=await runFFmpeg(input,['-hide_banner','-loglevel','error',...extra,'-i','pipe:0',...post,'-vn','-af',af,...codec,'-f',format,'pipe:1']);
  if(output.length>20*1024*1024)return reply(ctx,'O áudio processado ficou maior que 20 MB.');
  await ctx.sock.sendMessage(ctx.jid,{audio:output,mimetype:mime,fileName:file,ptt:false},{quoted:ctx.msg});
  return true;
}

const FUN={
  '8ball':q=>`🎱 ${pick(['Com certeza!','Não conte com isso.','As chances são boas.','Melhor não apostar nisso.','Pergunte novamente depois.','É bem provável!','Minha resposta é sim.','Minha resposta é não.'])}`,
  dado:q=>{let n=Math.max(2,Math.min(100,Number(q)||6));return `🎲 Saiu ${1+Math.floor(Math.random()*n)} (dado de ${n} lados).`;},
  moeda:()=>`🪙 Deu ${pick(['CARA','COROA'])}!`,
  sorteio:q=>{let a=q.split('|').map(x=>x.trim()).filter(Boolean);return a.length<2?'Use !sorteio opção 1 | opção 2 | opção 3.':`🎯 Sorteado: ${pick(a)}`;},
  escolher:q=>{let a=q.split('|').map(x=>x.trim()).filter(Boolean);return a.length<2?'Use !escolher opção 1 | opção 2.':`🤔 Eu escolheria: ${pick(a)}`;},
  parouimpar:q=>{let v=q.toLowerCase().startsWith('p')?'par':q.toLowerCase().startsWith('i')?'ímpar':null;if(!v)return 'Use !parouimpar par ou !parouimpar ímpar.';let n=Math.floor(Math.random()*10)+1;return `✋ Número sorteado: ${n}. Resultado: ${n%2?'ímpar':'par'}. ${n%2===(v==='ímpar')?'Você acertou!':'Dessa vez não!'}`;},
  ppt:q=>{let user=q.toLowerCase();if(!['pedra','papel','tesoura'].includes(user))return 'Use !ppt pedra, !ppt papel ou !ppt tesoura.';let bot=pick(['pedra','papel','tesoura']);let win=user===bot?'Empate!':(['pedra:tesoura','papel:pedra','tesoura:papel'].includes(`${user}:${bot}`)?'Você venceu!':'Eu venci!');return `✊ Você: ${user}\n🤖 Bot: ${bot}\n${win}`;},
  numeroaleatorio:q=>{let n=Math.max(1,Math.min(1000000,Number(q)||100));return `🔢 Seu número: ${1+Math.floor(Math.random()*n)} (entre 1 e ${n}).`;},
  embaralhar:q=>{let a=q.split(/\s+/).filter(Boolean);if(a.length<2)return 'Digite pelo menos duas palavras. Ex.: !embaralhar gato cão peixe';for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return `🔀 ${a.join(' ')}`;},
  anagrama:q=>{let w=q.replace(/\s/g,'');if(w.length<3)return 'Use !anagrama palavra.';let a=[...w];for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return `🔤 Anagrama: ${a.join('')}`;},
  rima:q=>{if(!q)return 'Use !rima palavra.';return `🎤 Ideias de rima para “${q}”: ${pick([`${q} / alegria / poesia`,`coração / emoção / canção`,`caminho / carinho / passarinho`,`brilhar / sonhar / conquistar`,`amizade / felicidade / sinceridade`])}`;},
  frasealeatoria:()=>`💬 ${pick(['A melhor figurinha é aquela enviada na hora certa.','Hoje é um ótimo dia para rir de algo aleatório.','Nem todo herói usa capa; alguns mandam figurinhas.','A criatividade começa com uma ideia maluca.','Se a vida fosse um grupo, eu fixaria as boas lembranças.'])}`,
  emoji:()=>`🎭 ${Array.from({length:5},()=>pick(['😂','🦊','🔥','🎺','🍕','🚀','🌈','🐸','🎮','⭐','🎉','🧩'])).join(' ')}`,
  roletatemas:()=>`🎨 Tema sorteado: ${pick(['animais','comida','música','esportes','filmes','escola','viagem','memes','natureza','jogos','espaço','mistério'])}`,
  quemseria:()=>`🕵️ Quem seria? ${pick(['quem mais ri das próprias piadas?','quem sobreviveria melhor numa ilha?','quem viraria famoso por acidente?','quem sempre chega atrasado?','quem seria o líder de uma missão?','quem mandaria o meme perfeito?'])}`,
  desculpa:()=>`📝 Desculpa aleatória: ${pick(['Meu celular decidiu atualizar bem na hora.','Fui buscar uma coisa e esqueci o que era.','Um pombo interrompeu meus planos.','Meu cérebro abriu muitas abas.','O tempo passou mais rápido do que eu esperava.'])}`,
  apelido:q=>{if(!q)return 'Use !apelido nome.';return `🏷️ Novo apelido para ${q}: ${pick(['Capitão','Lenda','Mestre','Cometa','Raposa','Professor','Pixel','Furacão'])} ${pick(['Supremo','Misterioso','Veloz','Do Caos','Estelar',' lendário'])}`;},
  conselho:()=>`🧠 Conselho aleatório: ${pick(['Faça uma coisa de cada vez.','Perguntar é melhor do que presumir.','Uma pausa também faz parte do progresso.','Guarde cópias do que é importante.','Nem toda discussão precisa de resposta.'])}`,
  piada:()=>`🤣 ${pick(['Por que o livro de matemática ficou triste? Porque tinha muitos problemas.','O que o zero disse para o oito? Belo cinto!','Qual é o instrumento favorito do pão? A flauta, porque ele já é massa.','Por que o computador foi ao médico? Estava com um vírus.','O que a parede falou para a outra? A gente se encontra na esquina.'])}`,
  perguntaaleatoria:()=>`❓ ${pick(['Qual talento você gostaria de aprender?','Qual lugar você gostaria de conhecer?','Qual foi a melhor surpresa que já recebeu?','Se pudesse dominar um instrumento, qual seria?','Que invenção facilitaria sua vida?','Qual personagem fictício seria um bom amigo?'])}`,
  verdade:()=>`🗣️ VERDADE: ${pick(['Qual foi a situação mais engraçada que você já viveu?','Qual habilidade você gostaria de dominar?','Qual música você não enjoa de ouvir?','Qual foi sua maior vergonha engraçada?','Qual sonho você ainda quer realizar?'])}`,
  desafioflash:()=>`🎯 DESAFIO: ${pick(['Fique 1 minuto sem rir.','Mande um emoji que represente seu dia.','Escreva seu nome usando apenas emojis.','Conte uma curiosidade sobre você.','Faça uma rima com a última mensagem do grupo.'])}`,
  eununca:()=>`🙈 EU NUNCA: ${pick(['Eu nunca dormi durante um filme.','Eu nunca mandei mensagem para a pessoa errada.','Eu nunca ri em um momento sério.','Eu nunca esqueci por que entrei em um cômodo.','Eu nunca cantei achando que ninguém estava ouvindo.'])}`,
  quemnunca:()=>`🤔 QUEM NUNCA? ${pick(['Quem nunca perdeu a hora?','Quem nunca cantou no banho?','Quem nunca esqueceu onde colocou o celular?','Quem nunca falou sozinho?','Quem nunca começou a rir e não conseguiu parar?'])}`,
  confissao:()=>`🤫 CONFISSÃO ALEATÓRIA: ${pick(['Já procurei algo que estava na minha mão.','Já abri a geladeira sem saber o que queria.','Já ensaiei uma conversa antes de acontecer.','Já acenei de volta para alguém que não estava acenando para mim.','Já esqueci uma palavra no meio da frase.'])}`,
  testeamor:()=>`💘 TESTE DO AMOR: ${Math.floor(Math.random()*101)}% de sintonia! É só uma brincadeira, não uma previsão real.`,
  personalidade:()=>`🧠 SUA PERSONALIDADE DE HOJE: ${pick(['A mente criativa','O mestre da zoeira','A pessoa conselheira','O explorador curioso','A energia do grupo','O estrategista silencioso'])}`,
  superpoder:()=>`🦸 SEU SUPERPODER SERIA: ${pick(['controlar o tempo por 5 segundos','entender todos os idiomas','teletransportar objetos pequenos','conversar com animais','nunca esquecer uma música','encontrar qualquer coisa perdida'])}`,
  profissao:()=>`💼 PROFISSÃO ALEATÓRIA: ${pick(['astronauta','inventor','chef','detetive','músico','biólogo marinho','diretor de cinema','arquiteto'])}`,
  animal:()=>`🐾 SEU ANIMAL-ESPÍRITO DE BRINCADEIRA: ${pick(['raposa','golfinho','coruja','capivara','lobo','gato','águia','pinguim'])}`,
  heroi:()=>`🦸 SEU NOME DE HERÓI: ${pick(['Capitão Relâmpago','Guardião Cósmico','Mestre da Risada','Sombra Veloz','Comandante Estelar','Doutor Improviso'])}`,
  vilao:()=>`🦹 SEU NOME DE VILÃO DE DESENHO: ${pick(['Doutor Bagunça','Barão do Wi-Fi','Senhor dos Bocejos','Mestre do Caos','Conde do Controle Remoto'])}`,
  elemento:()=>`🌪️ SEU ELEMENTO: ${pick(['fogo','água','terra','ar','luz','energia'])}`,
  planeta:()=>`🪐 SUA VIAGEM ESPACIAL SERIA PARA: ${pick(['Marte','Júpiter','Saturno','Netuno','Vênus','uma lua fictícia cheia de doces'])}`,
  comida:()=>`🍕 SUA COMIDA DE HOJE: ${pick(['pizza','lasanha','hambúrguer','pastel','açaí','pão de queijo','sushi','brigadeiro'])}`,
  cor:()=>`🎨 SUA COR DO DIA: ${pick(['azul elétrico','roxo','verde-esmeralda','vermelho','laranja','prata','dourado','turquesa'])}`,
  musica:()=>`🎵 TRILHA SONORA ALEATÓRIA: ${pick(['uma música épica de aventura','um samba animado','uma valsa elegante','um rock de energia','uma trilha misteriosa','um solo de sopros'])}`,
  filme:()=>`🎬 GÊNERO DO SEU FILME: ${pick(['comédia','aventura','ficção científica','mistério','animação','fantasia','documentário maluco'])}`,
  time:()=>`🏆 TIME DOS SONHOS: ${pick(['os Relâmpagos','as Raposas','os Cometas','os Inventores','as Capivaras','os Foguetes'])}`,
  previsao:()=>`🔮 PREVISÃO NÃO OFICIAL: ${pick(['uma boa surpresa pode aparecer','alguém vai mandar um meme','hoje combina com criatividade','uma conversa renderá boas risadas','seu próximo lanche será especial'])}`,
  sorte:()=>`🍀 NÍVEL DE SORTE: ${Math.floor(Math.random()*101)}%.`,
  azar:()=>`🌧️ ÍNDICE DE AZAR CÔMICO: ${Math.floor(Math.random()*101)}%. Cuidado com as cascas de banana imaginárias!`,
  quemganha:()=>`🥇 VENCEDOR DO DESAFIO IMAGINÁRIO: ${pick(['a raposa','a capivara','o pombo','o robô','o pato','o mestre das figurinhas'])}!`,
  mancheteabsurda:()=>`📰 MANCHETE ABSURDA: ${pick(['Capivara é eleita ministra oficial da soneca.','Pombo abre escola de voo para humanos.','Robô abandona tecnologia para virar padeiro.','Guitarra pede aulas de trombone.','Geladeira anuncia férias por excesso de trabalho.'])}`
};

const INTERACTION_ACTIONS = {
  matar: ['matou', 'assassinou', 'eliminou'],
  bater: ['deu um soco em', 'deu um tapa em', 'acertou um golpe em'],
  beijar: ['beijou', 'deu um beijo em', 'trocou um beijo com'],
  chutar: ['foi desafiado(a) para uma partida de futebol!', 'recebeu um passe de bola inesperado!', 'foi alvo de um chute na bola, não na pessoa!'],
  abracar: ['ganhou um abraço virtual!', 'recebeu um abraço de urso (com carinho)!', 'foi envolvido(a) num abraço coletivo!'],
  cafune: ['ganhou um cafuné virtual!', 'recebeu carinho no cabelo!', 'foi escolhido(a) para uma sessão de cafuné!'],
  morder: ['recebeu uma mordidinha de mentira de desenho animado!', 'foi ameaçado(a) por um biscoito mordedor!', 'escapou por pouco de uma mordida de jacaré de borracha!'],
  empurrar: ['foi empurrado(a) direto para uma piscina de bolinhas!', 'recebeu um empurrãozinho rumo à pista de dança!', 'foi conduzido(a) para uma montanha de almofadas!'],
  highfive: ['trocou um high-five!', 'mandou aquele toca aqui!', 'comemorou com um high-five épico!'],
  assustar: ['levou um susto de mentirinha!', 'foi surpreendido(a) por um fantasma de lençol!', 'recebeu um susto acompanhado de risadas!'],
  proteger: ['foi protegido(a) por um escudo imaginário!', 'ganhou proteção contra a chuva de memes!', 'foi salvo(a) por um guarda-chuva gigante!'],
  elogiar: ['recebeu um elogio: sua presença melhora o grupo!', 'foi lembrado(a) como alguém especial!', 'ganhou o título de pessoa gente boa do dia!'],
  zoar: ['virou personagem de um meme inofensivo!', 'foi convocado(a) para o campeonato de caretas!', 'recebeu uma zoeira leve e amigável!'],
  salvar: ['foi salvo(a) de uma avalanche de figurinhas!', 'foi resgatado(a) de uma ilha de memes!', 'foi salvo(a) por um herói de chinelo!'],
  dancinha: ['foi chamado(a) para uma batalha de dancinhas!', 'ganhou um convite para dançar!', 'entrou numa coreografia improvisada!'],
  cumprimentar: ['recebeu um cumprimento respeitoso!', 'ganhou um aperto de mão virtual!', 'foi saudado(a) com muita consideração!'],
};

const STICKER_FILTERS={
  stcompactar:'scale=512:512:force_original_aspect_ratio=decrease',strotacionar:'rotate=PI/4:ow=rotw(PI/4):oh=roth(PI/4):c=none',strecorte:'crop=min(iw\\,ih):min(iw\\,ih),scale=512:512',stborda:'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',stespaco:'scale=420:420:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',stparar:'select=eq(n\\,0)',stquadro:'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',stnitido:'unsharp=5:5:1.2:5:5:0',stsuave:'gblur=sigma=1.2',stcontrasteauto:'normalize',stsolarizar:'negate=0:enable=lt(random(0)\,0.5)',stposterizar:'lutrgb=r=floor(val/64)*64:g=floor(val/64)*64:b=floor(val/64)*64',stespelhar2:'hflip',stvirar:'vflip',stduotone:'hue=s=0,eq=contrast=1.2',stminiatura:'scale=256:256:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',stgigante:'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',stcontornoextra:'edgedetect=low=0.1:high=0.4,negate',stdesenho:'edgedetect=mode=colormix:high=0.2:low=0.1',stcinema:'eq=saturation=0.75:contrast=1.15:brightness=-0.03',stvintage:'colorchannelmixer=.9:.1:0:0:.05:.85:.1:0:0:.1:.8'};
async function stickerExtra(ctx,c){
  if(c==='staleatoria'||c==='stmaisnova'||c==='stmaisantiga'||c==='stmaisusada'||c==='stdupla'||c==='stcontar'){
    const items=[...(ctx.items||[])];if(!items.length)return reply(ctx,'A biblioteca está vazia.');
    if(c==='stcontar')return reply(ctx,`📚 Biblioteca: ${items.length} figurinhas.`);
    if(c==='stmaisnova'||c==='stmaisantiga'){items.sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));const item=c==='stmaisnova'?items.at(-1):items[0];const b=await ctx.readLibrarySticker(item.filename);await ctx.sock.sendMessage(ctx.jid,{sticker:b},{quoted:ctx.msg});return reply(ctx,`${c==='stmaisnova'?'🆕 Mais nova':'🏺 Mais antiga'}: ${item.title||item.filename||'figurinha'}`);}
    if(c==='stmaisusada'){const d=(()=>{try{return JSON.parse(fs.readFileSync('./social-data.json','utf8'));}catch{return {};}})();const top=d.top||{};const item=items.sort((a,b)=>(top[b.filename]||top[b.id]||0)-(top[a.filename]||top[a.id]||0))[0];const b=await ctx.readLibrarySticker(item.filename);await ctx.sock.sendMessage(ctx.jid,{sticker:b},{quoted:ctx.msg});return reply(ctx,`🏆 Figurinha mais usada: ${item.title||item.filename}`);}
    const count=c==='stdupla'?2:1;for(const item of items.sort(()=>Math.random()-.5).slice(0,count)){const b=await ctx.readLibrarySticker(item.filename);if(b)await ctx.sock.sendMessage(ctx.jid,{sticker:b},{quoted:ctx.msg});}return true;
  }
  const target=ctx.target;if(!target)return reply(ctx,`Responda a uma figurinha com !${c}.`);
  const input=await ctx.getMedia(target);if(!input)return reply(ctx,'Não consegui baixar a figurinha.');
  if(c==='stinfo'){
    const sha=crypto.createHash('sha256').update(input).digest('hex');const animated=input.includes(Buffer.from('ANIM'));return reply(ctx,`🧩 INFORMAÇÕES DA FIGURINHA\nTamanho: ${(input.length/1024).toFixed(1)} KB\nFormato: WebP${animated?' (possivelmente animada)':''}\nSHA-256: ${sha.slice(0,24)}…`);
  }
  if(c==='stsalvar'){
    if(typeof ctx.saveStickerToLibrary!=='function')return reply(ctx,'Função de biblioteca indisponível nesta versão.');
    const result=await ctx.saveStickerToLibrary(input,{source:'user-command',title:'Salva por comando'});return reply(ctx,result?.duplicate?'Essa figurinha já estava na biblioteca.':'✅ Figurinha salva na biblioteca!');
  }
  if(c==='sthash')return reply(ctx,`🔐 SHA-256\n${crypto.createHash('sha256').update(input).digest('hex')}`);
  if(c==='sttexto'||c==='stmarca'){
    const text=String(ctx.value||'').trim().replace(/\\/g,'').replace(/:/g,'').slice(0,50);if(!text)return reply(ctx,`Use !${c} seu texto respondendo à figurinha.`);
    const safe=text.replace(/'/g,"\\'");const filter=`scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,drawtext=text='${safe}':fontcolor=white:fontsize=32:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-text_h-24`;
    const out=await runFFmpeg(input,['-hide_banner','-loglevel','error','-i','pipe:0','-vf',filter,'-frames:v','1','-an','-c:v','libwebp','-quality','80','-f','webp','pipe:1']);await ctx.sock.sendMessage(ctx.jid,{sticker:out},{quoted:ctx.msg});return true;
  }
  let filter=STICKER_FILTERS[c];
  if(c==='stvelocidade'||c==='stloop'){
    if(!input.includes(Buffer.from('ANIM')))return reply(ctx,'Esse comando precisa de uma figurinha animada.');
    const animArgs=['-hide_banner','-loglevel','error','-i','pipe:0','-t','7','-vf',c==='stvelocidade'?'setpts=0.75*PTS,fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p':'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p','-an','-loop','0','-c:v','libwebp','-quality','70','-f','webp','pipe:1'];
    const animated=await runFFmpeg(input,animArgs);if(animated.length>1024*1024)return reply(ctx,'A figurinha animada ultrapassou 1 MB.');await ctx.sock.sendMessage(ctx.jid,{sticker:animated},{quoted:ctx.msg});return true;
  }
  if(c==='stanimar'){
    if(target.type!=='videoMessage')return reply(ctx,'Responda a um vídeo curto com !stanimar.');
    const out=await runFFmpeg(input,['-hide_banner','-loglevel','error','-i','pipe:0','-t','7','-vf','fps=12,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p','-an','-loop','0','-c:v','libwebp','-quality','70','-f','webp','pipe:1']);if(out.length>1024*1024)return reply(ctx,'A figurinha animada ultrapassou 1 MB.');await ctx.sock.sendMessage(ctx.jid,{sticker:out},{quoted:ctx.msg});return true;
  }
  if(!filter)return false;
  const out=await runFFmpeg(input,['-hide_banner','-loglevel','error','-i','pipe:0','-vf',filter,'-frames:v','1','-an','-c:v','libwebp','-quality','78','-f','webp','pipe:1']);
  if(out.length>1024*1024)return reply(ctx,'A figurinha resultante ultrapassou 1 MB.');
  await ctx.sock.sendMessage(ctx.jid,{sticker:out},{quoted:ctx.msg});return true;
}

export const AUDIO_COMMANDS=new Set(['audinfo','audmp3','audogg','audwav','audmono','audstereo','audvolume','audnormalizar','audgrave','audagudo','audeco','audreverb','audrapido','audlento','audreverso','audcortar','audfadein','audfadeout','audremoverruido','audvoz']);
export const STICKER_COMMANDS=new Set(['stinfo','stcompactar','strotacionar','strecorte','stborda','stespaco','stparar','stvelocidade','stloop','stanimar','stsalvar','staleatoria','stmaisnova','stmaisantiga','stmaisusada','stdupla','stcontar','sthash','sttexto','stmarca']);
export const GAME_COMMANDS=[...Object.keys(FUN),...Object.keys(INTERACTION_ACTIONS)];
export const EXTRA_COMMANDS=[...AUDIO_COMMANDS,...GAME_COMMANDS,...STICKER_COMMANDS];

function mentionedUsers(msg){
  let message=msg?.message;
  for(let i=0;i<10&&message;i++){
    for(const type of ['extendedTextMessage','imageMessage','videoMessage','documentMessage','stickerMessage']){
      const context=message[type]?.contextInfo;
      if(context?.mentionedJid?.length)return [...new Set(context.mentionedJid)];
      if(context?.quotedMessage&&context?.participant)return [context.participant];
    }
    message=message.ephemeralMessage?.message||message.viewOnceMessage?.message||message.viewOnceMessageV2?.message||message.viewOnceMessageV2Extension?.message||message.documentWithCaptionMessage?.message||message.deviceSentMessage?.message;
  }
  return [];
}

async function interactionCommand(ctx,command){ // LEO_INTERACTION_DISPLAY_MENTION_V3
  const targets=mentionedUsers(ctx.msg);
  if(!targets.length)return reply(ctx,`Marque alguém ou responda à mensagem da pessoa com !${command}.`);
  const rawTarget=targets[0];
  let target=rawTarget;
  try {
    if (String(ctx.jid || '').endsWith('@g.us')) {
      const metadata=await ctx.sock.groupMetadata(ctx.jid);
      const mode=metadata?.addressingMode || 'lid';
      const mapping=ctx.sock.signalRepository?.lidMapping;
      const aliases=new Set([String(rawTarget).toLowerCase()]);
      if (String(rawTarget).endsWith('@lid') && typeof mapping?.getPNForLID==='function') {
        try { const pn=await mapping.getPNForLID(rawTarget); if (pn) aliases.add(String(pn).toLowerCase()); } catch {}
      } else if (String(rawTarget).endsWith('@s.whatsapp.net') && typeof mapping?.getLIDForPN==='function') {
        try { const lid=await mapping.getLIDForPN(rawTarget); if (lid) aliases.add(String(lid).toLowerCase()); } catch {}
      }
      const participant=(metadata.participants||[]).find(p=>[p.id,p.jid,p.lid,p.phoneNumber].filter(Boolean).some(v=>aliases.has(String(v).toLowerCase())));
      if (participant) {
        const lid=participant.lid || (String(participant.id||'').endsWith('@lid') ? participant.id : null);
        const pn=participant.phoneNumber || (String(participant.jid||'').endsWith('@s.whatsapp.net') ? participant.jid : null);
        if (mode==='pn') {
          target=pn || (lid && typeof mapping?.getPNForLID==='function' ? await mapping.getPNForLID(lid).catch(()=>null) : null) || participant.id || rawTarget;
        } else {
          target=lid || (pn && typeof mapping?.getLIDForPN==='function' ? await mapping.getLIDForPN(pn).catch(()=>null) : null) || participant.id || rawTarget;
        }
      }
    }
  } catch (error) {
    console.warn('[MENÇÃO]',String(error?.message||error).slice(0,140));
  }
  // O texto precisa usar exatamente o mesmo identificador da lista mentions.
  // Em grupos LID, o WhatsApp pode exibir o ID numérico; o telefone não pode ser
  // reconstruído quando a própria sessão não recebeu o mapeamento PN<->LID.
  const tag='@'+String(target).split('@')[0].split(':')[0];
  const action=pick(INTERACTION_ACTIONS[command]);
  const caption = `🦊 ${ctx.msg?.pushName||'Alguém'} ${action} ${tag}`;
  return replyWithGameGif(ctx, command, caption, [target]);
}
export async function handleExtraCommand(ctx){
  const c=String(ctx.command||'').toLowerCase();
  try {
    if(AUDIO_COMMANDS.has(c)) return await audioCommand(ctx,c);
    if(Object.hasOwn(INTERACTION_ACTIONS,c)) return await interactionCommand(ctx,c);
    if(Object.hasOwn(FUN,c)){
      const q=String(ctx.value||'').trim();
      const result=FUN[c](q);
      if(/^(?:Use |Digite |Informe |Responda |Marque )/i.test(result)) return reply(ctx,result);
      return replyWithGameGif(ctx,c,result);
    }
    if(STICKER_COMMANDS.has(c)) return await stickerExtra(ctx,c);
    return false;
  } catch(error) {
    console.error(`[COMANDO ${c}]`, error?.stack || error);
    if(AUDIO_COMMANDS.has(c)) {
      await reply(ctx, `❌ Não consegui processar o áudio.
Detalhe: ${String(error?.message || error).slice(0,350)}
Confira o terminal para ver quantos bytes foram baixados.`);
      return true;
    }
    await reply(ctx, `❌ O comando falhou: ${String(error?.message || error).slice(0,250)}`);
    return true;
  }
}
