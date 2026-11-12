import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { handleJoinApprovalCommand } from './join-approval.js'; // LEO_STICKERS_JOIN_APPROVAL_HANDLER_IMPORT_FIX_V1
import { handleProtectedModerationCommand } from './protected-moderation.js';

const ROOT = path.resolve('./figurinhas');
const LIBRARY = path.join(ROOT, 'biblioteca');
const SOCIAL_FILE = path.resolve('./social-data.json');
const COLLECTIONS_DIR = path.resolve('./social-collections');
const STATE_FILE = path.resolve('./advanced-data.json');
fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function owner(ctx) { return typeof ctx.isOwner === 'function' && ctx.isOwner(ctx.sender || ctx.jid); }
function user(ctx) { return String(ctx.sender || ctx.jid || '').split('@')[0].split(':')[0]; }
function cleanName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32); }
function random(items, n = 1) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
function idOf(item) { return String(item.id || item.hash || item.filename || ''); }
function mentions(msg) {
  let m = msg?.message;
  for (let i = 0; i < 6 && m; i++) {
    for (const k of ['extendedTextMessage','imageMessage','videoMessage','stickerMessage']) {
      const a = m[k]?.contextInfo?.mentionedJid;
      if (a?.length) return a;
    }
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
  }
  return [];
}
function sendSticker(ctx, buffer) { return ctx.sock.sendMessage(ctx.jid, { sticker: buffer }, { quoted: ctx.msg }); }
function groupAdminAliases(value) {
  const out = new Set();
  const add = v => {
    if (!v) return;
    if (typeof v === 'object') { for (const k of ['id','jid','lid','phoneNumber']) add(v[k]); return; }
    const s = String(v).toLowerCase(); const at = s.lastIndexOf('@');
    if (at < 0) { const n = s.split(':')[0].replace(/\D/g, ''); if (n) out.add(n + '@s.whatsapp.net'); return; }
    out.add(s.slice(0, at).split(':')[0] + s.slice(at));
  };
  add(value); return out;
}
function matches(a,b) { for (const x of a) if (b.has(x)) return true; return false; }
async function requireGroupAdmin(ctx, requireBot = true) {
  if (!ctx.jid.endsWith('@g.us')) { await ctx.send(ctx.jid, 'Este comando só funciona em grupos.', ctx.msg); return false; }
  const meta = await ctx.sock.groupMetadata(ctx.jid); const ps = meta.participants || [];
  const key = ctx.msg?.key || {};
  const sa = new Set([...groupAdminAliases(ctx.sender), ...groupAdminAliases(key.participant), ...groupAdminAliases(key.participantAlt)]);
  const ba = new Set([...groupAdminAliases(ctx.sock.user?.id), ...groupAdminAliases(ctx.sock.user?.lid)]);
  const s = ps.find(p => matches(sa, groupAdminAliases(p)));
  const b = ps.find(p => matches(ba, groupAdminAliases(p)));
  const admin = p => p?.admin === 'admin' || p?.admin === 'superadmin';
  if (!admin(s)) { await ctx.send(ctx.jid, 'Somente administradores do grupo podem usar este comando.', ctx.msg); return false; }
  if (requireBot && !admin(b)) { await ctx.send(ctx.jid, 'Preciso ser administrador do grupo para executar esta ação.', ctx.msg); return false; }
  return true;
}
function state() { const s = readJson(STATE_FILE, {}); s.collections ||= {}; s.groups ||= {}; s.votes ||= {}; s.challenges ||= {}; s.race ||= {}; s.maintenance ||= false; return s; }
function collectionFile(u) { return path.join(COLLECTIONS_DIR, `${u}.json`); }
function collections(u) { return readJson(collectionFile(u), {}); }
function saveCollections(u, c) { writeJson(collectionFile(u), c); }
function catalog(ctx) { return Array.isArray(ctx.items) ? ctx.items : []; }
function findByQuery(items, q) { const x = String(q || '').trim().toLowerCase(); return items.find(i => idOf(i) === x || String(i.filename || '').toLowerCase() === x); }
async function sendItems(ctx, items, limit = 10) {
  let count = 0;
  for (const item of items.slice(0, limit)) {
    try { const b = await ctx.readLibrarySticker(item.filename); if (b) { await sendSticker(ctx, b); count++; const data=readJson(SOCIAL_FILE,{}); data.top ||= {}; const id=idOf(item); if(id){ data.top[id]=(data.top[id]||0)+1; writeJson(SOCIAL_FILE,data); } } } catch (e) { console.error('Falha ao enviar item:', e.message); }
  }
  return count;
}
async function phash(buffer) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-i','pipe:0','-vf','scale=9:8:flags=area,format=gray','-frames:v','1','-f','rawvideo','pipe:1']);
    const chunks=[]; const errs=[]; p.stdout.on('data',x=>chunks.push(x)); p.stderr.on('data',x=>errs.push(x)); p.on('error',reject);
    p.on('close',code=>{ if(code!==0) return reject(new Error(Buffer.concat(errs).toString() || 'Falha na análise visual.')); const d=Buffer.concat(chunks); if(d.length<72) return reject(new Error('Imagem inválida.')); let bits=''; for(let y=0;y<8;y++) for(let x=0;x<8;x++) bits += d[y*9+x] > d[y*9+x+1] ? '1':'0'; resolve(BigInt('0b'+bits)); });
    p.stdin.on('error',()=>{}); p.stdin.end(buffer);
  });
}
function distance(a,b) { let x=a^b, n=0; while(x){ n++; x &= x-1n; } return n; }
async function similarCommand(ctx) {
  if (!ctx.target) return ctx.send(ctx.jid, 'Responda a uma imagem ou figurinha com !figparecida.', ctx.msg);
  const input = await ctx.getMedia(ctx.target); if (!input) return ctx.send(ctx.jid, 'Não consegui ler a imagem enviada.', ctx.msg);
  const base = await phash(input); const scored=[];
  for (const item of catalog(ctx)) { try { const b=await ctx.readLibrarySticker(item.filename); if(b) scored.push({item,score:distance(base,await phash(b))}); } catch {} }
  scored.sort((a,b)=>a.score-b.score); const chosen=scored.filter(x=>x.score<=24).slice(0,8);
  if (!chosen.length) return ctx.send(ctx.jid, 'Não encontrei semelhanças visuais suficientes na biblioteca.', ctx.msg);
  const sent=await sendItems(ctx,chosen.map(x=>x.item),8); return ctx.send(ctx.jid, `🔎 Encontrei ${chosen.length} semelhantes. Enviei ${sent}.`,ctx.msg);
}
async function imageEffect(ctx, mode) {
  if (!ctx.target) return ctx.send(ctx.jid, `Responda a uma imagem ou figurinha com !${mode}.`,ctx.msg);
  const input=await ctx.getMedia(ctx.target); if(!input) return ctx.send(ctx.jid,'Não consegui baixar a imagem.',ctx.msg);
  const filters={
    contorno:'scale=480:480:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,drawbox=x=4:y=4:w=504:h=504:color=white@0.95:t=8,format=yuva420p',
    sombra:'scale=460:460:force_original_aspect_ratio=decrease,pad=512:512:26:26:color=0x00000000,drawbox=x=10:y=10:w=492:h=492:color=black@0.30:t=12,format=yuva420p',
    pixel:'scale=32:32:flags=area,scale=512:512:flags=neighbor,format=yuva420p',
    negativo:'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,negate,format=yuva420p',
    pretoebranco:'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=gray,format=yuva420p',
    recortar:'crop=min(iw\,ih):min(iw\,ih),scale=512:512,format=yuva420p',
    zoom:'crop=iw*0.65:ih*0.65:iw*0.175:ih*0.175,scale=512:512,format=yuva420p',
    desfocar:'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,boxblur=8:2,format=yuva420p'
  };
  const output=await new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-vf',filters[mode],'-frames:v','1','-an','-c:v','libwebp','-quality','80','-f','webp','pipe:1']);const out=[],err=[];p.stdout.on('data',x=>out.push(x));p.stderr.on('data',x=>err.push(x));p.on('error',reject);p.on('close',c=>c===0?resolve(Buffer.concat(out)):reject(new Error(Buffer.concat(err).toString()||'FFmpeg falhou')));p.stdin.on('error',()=>{});p.stdin.end(input);});
  await sendSticker(ctx,output); return ctx.send(ctx.jid,`✅ Efeito ${mode} aplicado.`,ctx.msg);
}

const IMAGE_TRANSFORMS = {
  imgcontorno: 'drawbox=x=3:y=3:w=iw-6:h=ih-6:color=white:t=8',
  imgsombra: 'drawbox=x=10:y=10:w=iw-20:h=ih-20:color=black@0.35:t=5',
  imgpixel: 'scale=48:48:flags=area,scale=1280:1280:force_original_aspect_ratio=decrease:flags=neighbor',
  imgnegativo: 'negate',
  imgpb: 'hue=s=0',
  imgzoom: 'crop=iw*0.7:ih*0.7:iw*0.15:ih*0.15,scale=1280:1280:force_original_aspect_ratio=decrease',
  imgdesfocar: 'boxblur=8:2',
  imgespelhar: 'hflip',
  imggirar: 'transpose=1',
  imgbrilho: 'eq=brightness=0.10',
  imgcontraste: 'eq=contrast=1.35',
  imgsaturacao: 'eq=saturation=1.6',
  imgsepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  imgnitidez: 'unsharp=5:5:1.0:5:5:0.0',
  imgposter: 'posterize=5',
  imgquadrada: 'scale=800:800:force_original_aspect_ratio=increase,crop=800:800',
  imgpaisagem: 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white',
  imgretrato: 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:white',
  imgminiatura: 'scale=320:320:force_original_aspect_ratio=decrease',
  imgcompress: 'scale=1600:1600:force_original_aspect_ratio=decrease'
};

const STICKER_TRANSFORMS = {
  stcontorno: 'drawbox=x=3:y=3:w=iw-6:h=ih-6:color=white:t=8',
  stsombra: 'drawbox=x=10:y=10:w=iw-20:h=ih-20:color=black@0.35:t=5',
  stpixel: 'scale=32:32:flags=area,scale=512:512:flags=neighbor',
  stnegativo: 'negate',
  stpb: 'hue=s=0',
  stzoom: 'crop=iw*0.7:ih*0.7:iw*0.15:ih*0.15,scale=512:512:force_original_aspect_ratio=decrease',
  stdesfocar: 'boxblur=8:2',
  stespelhar: 'hflip',
  stgirar: 'transpose=1',
  stbrilho: 'eq=brightness=0.10',
  stcontraste: 'eq=contrast=1.35',
  stsaturacao: 'eq=saturation=1.6',
  stsepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  stnitidez: 'unsharp=5:5:1.0:5:5:0.0',
  stposter: 'posterize=5',
  stquadrada: 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
  stvertical: 'vflip',
  sthorizontal: 'hflip',
  stmini: 'scale=256:256:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
  stmaxi: 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512'
};

async function transformMediaCommand(ctx, command, asSticker) {
  if (!ctx.target) return ctx.send(ctx.jid, `Responda a uma imagem ou figurinha com !${command}.`, ctx.msg);
  const input = await ctx.getMedia(ctx.target);
  if (!input || !Buffer.isBuffer(input)) return ctx.send(ctx.jid, 'Não consegui baixar a mídia. Envie ou responda a uma imagem/figurinha.', ctx.msg);
  const base = asSticker
    ? 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
    : 'scale=1600:1600:force_original_aspect_ratio=decrease';
  const filter = [base, (asSticker ? STICKER_TRANSFORMS : IMAGE_TRANSFORMS)[command], asSticker ? 'format=yuva420p' : 'format=yuv420p'].filter(Boolean).join(',');
  const args = ['-hide_banner','-loglevel','error','-i','pipe:0','-vf',filter,'-frames:v','1','-an'];
  if (asSticker) args.push('-c:v','libwebp','-quality','82','-compression_level','4','-f','webp','pipe:1');
  else args.push('-c:v','mjpeg','-q:v',command==='imgcompress'?'10':'3','-f','image2pipe','pipe:1');
  const output = await new Promise((resolve,reject) => {
    const proc=spawn('ffmpeg',args); const chunks=[]; const errors=[];
    proc.stdout.on('data',x=>chunks.push(x)); proc.stderr.on('data',x=>errors.push(x));
    proc.on('error',reject);
    proc.on('close',code=>code===0&&Buffer.concat(chunks).length?resolve(Buffer.concat(chunks)):reject(new Error(Buffer.concat(errors).toString()||'Falha ao processar a mídia.')));
    proc.stdin.on('error',()=>{}); proc.stdin.end(input);
  });
  if (asSticker) await ctx.sock.sendMessage(ctx.jid,{sticker:output},{quoted:ctx.msg});
  else await ctx.sock.sendMessage(ctx.jid,{image:output,mimetype:'image/jpeg',caption:`🖼️ Efeito aplicado: ${command}`},{quoted:ctx.msg});
  return true;
}

async function collectionsCommand(ctx, command) {
  const u=user(ctx), c=collections(u), parts=String(ctx.value||'').trim().split(/\s+/), name=cleanName(parts[0]);
  if(command==='criarcolecao') { if(!name) return ctx.send(ctx.jid,'Use !criarcolecao nome.',ctx.msg); if(c[name]) return ctx.send(ctx.jid,'Essa coleção já existe.',ctx.msg); c[name]=[]; saveCollections(u,c); return ctx.send(ctx.jid,`📁 Coleção ${name} criada. Responda a uma figurinha com !adicionarcolecao ${name}.`,ctx.msg); }
  if(command==='minhascolecoes') return ctx.send(ctx.jid,Object.keys(c).length?`📚 SUAS COLEÇÕES\n\n${Object.entries(c).map(([n,a])=>`• ${n}: ${a.length} figurinhas`).join('\n')}`:'Você ainda não criou coleções.',ctx.msg);
  if(command==='adicionarcolecao') { if(!c[name]) return ctx.send(ctx.jid,'Coleção não encontrada. Use !minhascolecoes.',ctx.msg); const target=ctx.target; if(!target) return ctx.send(ctx.jid,'Responda à figurinha que deseja adicionar.',ctx.msg); const buf=await ctx.getMedia(target); if(!buf) return ctx.send(ctx.jid,'Não consegui obter a figurinha.',ctx.msg); const hash=crypto.createHash('sha256').update(buf).digest('hex'); if(c[name].includes(hash)) return ctx.send(ctx.jid,'Essa figurinha já está nessa coleção.',ctx.msg); const dir=path.join(COLLECTIONS_DIR,u); fs.mkdirSync(dir,{recursive:true}); const file=`${hash}.webp`; fs.writeFileSync(path.join(dir,file),buf); c[name].push(hash); saveCollections(u,c); return ctx.send(ctx.jid,`✅ Figurinha adicionada à coleção ${name}.`,ctx.msg); }
  if(command==='exportarcolecao') { if(!c[name]?.length) return ctx.send(ctx.jid,'Coleção vazia ou não encontrada.',ctx.msg); const dir=path.join(COLLECTIONS_DIR,u); const files=c[name].map(h=>path.join(dir,`${h}.webp`)).filter(f=>fs.existsSync(f)); if(!files.length) return ctx.send(ctx.jid,'Os arquivos dessa coleção não foram encontrados.',ctx.msg); const archive=path.join(COLLECTIONS_DIR,`${u}-${name}-${Date.now()}.tar.gz`); const r=spawnSync('tar',['-czf',archive,'-C',dir,...files.map(f=>path.basename(f))]); if(r.status!==0) throw new Error('Não foi possível compactar a coleção.'); await ctx.sock.sendMessage(ctx.jid,{document:fs.readFileSync(archive),mimetype:'application/gzip',fileName:`colecao-${name}.tar.gz`,caption:`📦 Coleção ${name}: ${files.length} figurinhas.`},{quoted:ctx.msg}); fs.rmSync(archive,{force:true}); return true; }
  if(command==='mesclarcolecoes') { const other=cleanName(parts[1]); if(!name||!other||!c[name]||!c[other]||name===other) return ctx.send(ctx.jid,'Use !mesclarcolecoes origem destino (ambas devem existir).',ctx.msg); c[other]=[...new Set([...c[other],...c[name]])]; delete c[name]; saveCollections(u,c); return ctx.send(ctx.jid,`✅ Coleção ${name} mesclada em ${other}.`,ctx.msg); }
}
async function duplicatesCommand(ctx) {
  const map=new Map(); for(const item of catalog(ctx)){try{if(!item.filename || path.basename(item.filename)!==item.filename)continue;const file=path.join(LIBRARY,item.filename);if(!fs.existsSync(file))continue;const h=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(!map.has(h))map.set(h,[]);map.get(h).push(item);}catch{}}
  const groups=[...map.values()].filter(a=>a.length>1); if(!groups.length)return ctx.send(ctx.jid,'✅ Não encontrei duplicadas pelo hash registrado no catálogo.',ctx.msg);
  return ctx.send(ctx.jid,`🧬 DUPLICADAS\n\nGrupos encontrados: ${groups.length}\nArquivos excedentes: ${groups.reduce((n,a)=>n+a.length-1,0)}\n\nNenhum arquivo foi apagado automaticamente.`,ctx.msg);
}
async function recentPacks(ctx) {
  const items=[...catalog(ctx)].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)).slice(0,20);
  if(!items.length)return ctx.send(ctx.jid,'A biblioteca está vazia.',ctx.msg);
  return ctx.send(ctx.jid,'🕘 ADIÇÕES RECENTES\n\n'+items.map((x,i)=>`${i+1}. ${x.title||x.source||x.filename||'Figurinha'} — ${x.createdAt||'data desconhecida'}`).join('\n'),ctx.msg);
}
async function topFig(ctx) {
  const data=readJson(SOCIAL_FILE,{}); const top=data.top||{}; const items=catalog(ctx); const rows=Object.entries(top).map(([id,n])=>({item:items.find(x=>idOf(x)===id||x.filename===id),n})).filter(x=>x.item).sort((a,b)=>b.n-a.n).slice(0,10);
  if(!rows.length)return ctx.send(ctx.jid,'Ainda não há dados suficientes de uso para montar o ranking.',ctx.msg);
  return ctx.send(ctx.jid,'🏆 TOP FIGURINHAS\n\n'+rows.map((x,i)=>`${i+1}. ${x.item.title||x.item.filename} — ${x.n} usos`).join('\n'),ctx.msg);
}
async function dailyFig(ctx) { const items=catalog(ctx); if(!items.length)return ctx.send(ctx.jid,'Biblioteca vazia.',ctx.msg); const day=new Date().toISOString().slice(0,10); const index=parseInt(crypto.createHash('sha256').update(day).digest('hex').slice(0,8),16)%items.length; const item=items[index]; const b=await ctx.readLibrarySticker(item.filename); await sendSticker(ctx,b); return ctx.send(ctx.jid,`🌟 FIGURINHA DO DIA\n${item.title||item.filename||'Destaque da biblioteca'}\nData: ${day}`,ctx.msg); }
async function libraryAge(ctx, newest) { const items=[...catalog(ctx)].sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)); const item=newest?items.at(-1):items[0]; if(!item)return ctx.send(ctx.jid,'Biblioteca vazia.',ctx.msg); const b=await ctx.readLibrarySticker(item.filename); await sendSticker(ctx,b); return ctx.send(ctx.jid,`${newest?'🆕 MAIS NOVA':'🏺 MAIS ANTIGA'}\n${item.title||item.filename||'Figurinha'}\n${item.createdAt||'Data desconhecida'}`,ctx.msg); }
async function exportLibrary(ctx) {
  if(!owner(ctx))return ctx.send(ctx.jid,'Comando exclusivo do dono.',ctx.msg);
  const out=path.resolve(`./biblioteca-export-${Date.now()}.tar.gz`); const r=spawnSync('tar',['-czf',out,'-C',ROOT,'biblioteca','biblioteca.json']); if(r.status!==0)throw new Error(r.stderr?.toString()||'Falha ao exportar biblioteca.'); await ctx.sock.sendMessage(ctx.jid,{document:fs.readFileSync(out),mimetype:'application/gzip',fileName:path.basename(out),caption:`📚 Exportação da biblioteca: ${catalog(ctx).length} registros.`},{quoted:ctx.msg}); fs.rmSync(out,{force:true});
}
async function report(ctx) { const items=catalog(ctx), data=readJson(SOCIAL_FILE,{}), users=new Set([...Object.keys(data.names||{}),...Object.keys(data.scores||{})]); const animated=items.filter(x=>x.animated).length; const size=items.reduce((n,x)=>n+(Number(x.size)||0),0); return ctx.send(ctx.jid,`📊 RELATÓRIO COMPLETO\n\nFigurinhas: ${items.length}\nAnimadas: ${animated}\nEstáticas: ${items.length-animated}\nUsuários conhecidos: ${users.size}\nFavoritos: ${Object.values(data.favorites||{}).reduce((n,a)=>n+(a?.length||0),0)}\nTamanho registrado: ${(size/1024/1024).toFixed(2)} MB\nTempo ligado: ${Math.floor(process.uptime()/60)} min`,ctx.msg); }
async function ownerTools(ctx, command) {
  if(!owner(ctx))return ctx.send(ctx.jid,'🚫 Comando exclusivo do dono.',ctx.msg);
  const s=state(); const args=String(ctx.value||'').trim();
  if(command==='manutencao'){s.maintenance=!s.maintenance;writeJson(STATE_FILE,s);return ctx.send(ctx.jid,`🛠️ Modo manutenção ${s.maintenance?'ATIVADO':'DESATIVADO'}.`,ctx.msg);}
  if(command==='anuncio'){if(!args)return ctx.send(ctx.jid,'Use !anuncio texto.',ctx.msg);const groups=Object.entries(s.groups).filter(([,v])=>v.enabled!==false).map(([jid])=>jid);let sent=0;for(const jid of groups){try{await ctx.sock.sendMessage(jid,{text:`📢 COMUNICADO DO LÉO STICKERS\n\n${args}`});sent++;}catch(e){console.error('Anúncio falhou:',e.message);}}return ctx.send(ctx.jid,`Comunicado enviado para ${sent} grupos registrados.`,ctx.msg);}
  if(command==='bloqueargrupo'||command==='desbloqueargrupo'){const jid=args.includes('@g.us')?args:ctx.jid;if(!jid.endsWith('@g.us'))return ctx.send(ctx.jid,'Informe um JID de grupo ou use o comando dentro do grupo.',ctx.msg);s.groups[jid]||={};s.groups[jid].enabled=command==='desbloqueargrupo'?true:false;writeJson(STATE_FILE,s);return ctx.send(ctx.jid,`${command==='bloqueargrupo'?'🚫 Grupo bloqueado':'✅ Grupo reativado'}: ${jid}`,ctx.msg);}
  if(command==='reiniciargrupo'){if(!ctx.jid.endsWith('@g.us'))return ctx.send(ctx.jid,'Use dentro do grupo.',ctx.msg);if(!await requireGroupAdmin(ctx))return; s.groups[ctx.jid]||={};s.groups[ctx.jid].settings={};writeJson(STATE_FILE,s);return ctx.send(ctx.jid,'♻️ Configurações locais do bot neste grupo foram reiniciadas.',ctx.msg);}
  if(command==='relatorio')return report(ctx);
}
async function socialGame(ctx, command) {
  const s=state(), u=user(ctx), args=String(ctx.value||'').trim();
  if(command==='desafiofig'){const target=ctx.target;if(target){const b=await ctx.getMedia(target);if(!b)return ctx.send(ctx.jid,'Não consegui ler sua figurinha.',ctx.msg);const key=new Date().toISOString().slice(0,10);s.challenges[key]||={};s.challenges[key][u]=crypto.createHash('sha256').update(b).digest('hex');writeJson(STATE_FILE,s);return ctx.send(ctx.jid,'🏁 Figurinha registrada no desafio de hoje!',ctx.msg);}return ctx.send(ctx.jid,'🏁 DESAFIO DO DIA\nEnvie sua melhor figurinha respondendo com !desafiofig. Cada participante pode registrar uma.',ctx.msg);}
  if(command==='votefig'){const key=ctx.jid+':'+new Date().toISOString().slice(0,10);const target=ctx.target;if(target){const b=await ctx.getMedia(target);if(!b)return ctx.send(ctx.jid,'Responda a uma figurinha para registrar seu voto.',ctx.msg);const hash=crypto.createHash('sha256').update(b).digest('hex');s.votes[key]||={};s.votes[key][u]=hash;writeJson(STATE_FILE,s);return ctx.send(ctx.jid,'🗳️ Voto registrado! Um voto por pessoa por dia.',ctx.msg);}const votes=Object.values(s.votes[key]||{});const counts={};for(const h of votes)counts[h]=(counts[h]||0)+1;return ctx.send(ctx.jid,`🗳️ VOTAÇÃO DE HOJE\nVotos: ${votes.length}\nFigurinhas concorrentes: ${Object.keys(counts).length}\nEnvie !votefig respondendo à sua figurinha para votar.`,ctx.msg);}
  if(command==='roubarfig'){const target=mentions(ctx.msg)[0];if(!target)return ctx.send(ctx.jid,'Marque alguém e use !roubarfig. É uma brincadeira: sorteia uma figurinha da biblioteca para você.',ctx.msg);const item=random(catalog(ctx),1)[0];if(!item)return ctx.send(ctx.jid,'Biblioteca vazia.',ctx.msg);const b=await ctx.readLibrarySticker(item.filename);await sendSticker(ctx,b);return ctx.send(ctx.jid,`🎭 Você "roubou" uma figurinha aleatória de @${String(target).split('@')[0]} (na brincadeira)!`,ctx.msg,{mentions:[target]});}
  if(command==='adivinhe'){const items=catalog(ctx);if(!items.length)return ctx.send(ctx.jid,'Biblioteca vazia.',ctx.msg);const item=random(items,1)[0];const title=String(item.title||item.source||'figurinha misteriosa').slice(0,80);s.quiz[ctx.jid]={answer:title.toLowerCase(),user:u,expires:Date.now()+120000};writeJson(STATE_FILE,s);return ctx.send(ctx.jid,`🧩 ADIVINHE A FIGURINHA\nDica: a origem ou descrição começa com a letra "${title[0]?.toUpperCase()||'?'}".\nVocê tem 2 minutos. Responda: !resposta sua resposta`,ctx.msg);}
  if(command==='resposta'){const q=s.quiz[ctx.jid];if(!q||q.expires<Date.now())return ctx.send(ctx.jid,'Não há desafio ativo neste chat.',ctx.msg);if(args.toLowerCase()===q.answer){delete s.quiz[ctx.jid];writeJson(STATE_FILE,s);return ctx.send(ctx.jid,'🎉 Acertou! Boa!',ctx.msg);}return ctx.send(ctx.jid,'Ainda não! Tente novamente.',ctx.msg);}
  if(command==='corridafig'){const key=ctx.jid+':'+new Date().toISOString().slice(0,10);s.race[key]||=[];if(!s.race[key].includes(u))s.race[key].push(u);writeJson(STATE_FILE,s);return ctx.send(ctx.jid,`🏁 CORRIDA DE COLEÇÕES\nParticipantes: ${s.race[key].length}\nSua participação foi registrada! Use !corridafig para entrar.`,ctx.msg);}
}


function groupTargets(ctx) { return mentions(ctx.msg); }
function groupState(ctx) { const s=state(); s.groups[ctx.jid] ||= {enabled:true}; s.groups[ctx.jid].warnings ||= {}; return {s,g:s.groups[ctx.jid]}; }
async function groupAdminCommand(ctx, command) {

  if (['rebaixar', 'remover'].includes(command)) {
    const protection = await handleProtectedModerationCommand({
      sock: ctx.sock,
      ctx,
      targets: groupTargets(ctx),
      isOwner: value => (
        typeof ctx.isOwner === 'function' && ctx.isOwner(value)
      )
    });

    if (protection?.handled) {
      await ctx.send(ctx.jid, protection.message, ctx.msg);
      return true;
    }
  }
  const botNeeded = ['linkgrupo','novolink','fechargrupo','abrirgrupo','promover','rebaixar','remover','aprovar','recusar'].includes(command);
  if (!await requireGroupAdmin(ctx, botNeeded)) return true;
  const args=String(ctx.value||'').trim();
  const targets=groupTargets(ctx);
  const meta=await ctx.sock.groupMetadata(ctx.jid);
  const {s,g}=groupState(ctx);
  const send=(text)=>ctx.send(ctx.jid,text,ctx.msg);
  const targetRequired=async()=>{
    if(!targets.length){await send(`Marque a pessoa que deseja atingir. Exemplo: !${command} @pessoa`);return null;}
    return targets;
  };
  if(command==='infogrupo') {
    const admins=(meta.participants||[]).filter(p=>p.admin==='admin'||p.admin==='superadmin').length;
    return send(`ℹ️ INFORMAÇÕES DO GRUPO\n\nNome: ${meta.subject||'Sem nome'}\nParticipantes: ${(meta.participants||[]).length}\nAdministradores: ${admins}\nCriado em: ${meta.creation?new Date(meta.creation*1000).toLocaleString('pt-BR'):'Não informado'}\nDescrição: ${meta.desc||'Sem descrição'}`);
  }
  if(command==='linkgrupo') { const code=await ctx.sock.groupInviteCode(ctx.jid); return send(`🔗 Link do grupo:\nhttps://chat.whatsapp.com/${code}`); }
  if(command==='novolink') { const code=await ctx.sock.groupRevokeInvite(ctx.jid); return send(`♻️ Link anterior revogado.\nNovo link:\nhttps://chat.whatsapp.com/${code}`); }
  if(command==='fechargrupo'||command==='abrirgrupo') { await ctx.sock.groupSettingUpdate(ctx.jid,command==='fechargrupo'?'announcement':'not_announcement'); return send(command==='fechargrupo'?'🔒 Grupo fechado: somente administradores podem enviar mensagens.':'🔓 Grupo aberto: todos podem enviar mensagens.'); }
  if(command==='mudarnomegrupo') { if(!args)return send('Use !mudarnomegrupo novo nome.'); await ctx.sock.groupUpdateSubject(ctx.jid,args.slice(0,100)); return send('✅ Nome do grupo atualizado.'); }
  if(command==='mudardescgrupo') { if(!args)return send('Use !mudardescgrupo nova descrição.'); await ctx.sock.groupUpdateDescription(ctx.jid,args.slice(0,2048)); return send('✅ Descrição do grupo atualizada.'); }
  if(['promover','rebaixar','remover'].includes(command)) { const list=await targetRequired(); if(!list)return true; const action={promover:'promote',rebaixar:'demote',remover:'remove'}[command]; const result=await ctx.sock.groupParticipantsUpdate(ctx.jid,list,action); const ok=Array.isArray(result)?result.filter(x=>!x.status||x.status===200).length:list.length; return send(`✅ ${command.toUpperCase()}: ${ok} de ${list.length} participante(s) processado(s).`); }
  if(command==='marcaradmins'||command==='marcarmembros') { const selected=(meta.participants||[]).filter(p=>command==='marcaradmins'?(p.admin==='admin'||p.admin==='superadmin'):!(p.admin==='admin'||p.admin==='superadmin')); if(!selected.length)return send('Não há participantes nessa categoria.'); const mentionsList=selected.map(p=>p.id).filter(Boolean); const lines=selected.map(p=>`• @${String(p.id||'').split('@')[0]}`); await ctx.sock.sendMessage(ctx.jid,{text:`${command==='marcaradmins'?'👑 ADMINISTRADORES':'👥 MEMBROS'} (${selected.length})\n\n${lines.join('\n')}`,mentions:mentionsList},{quoted:ctx.msg}); return true; }
  if(command==='aprovar'||command==='recusar') { const pending=await ctx.sock.groupRequestParticipantsList(ctx.jid); if(!targets.length) return send(`📨 Solicitações pendentes: ${pending.length}\nMarque uma pessoa com !${command} @pessoa.`); const action=command==='aprovar'?'approve':'reject'; const result=await ctx.sock.groupRequestParticipantsUpdate(ctx.jid,targets,action); return send(`✅ Solicitação(ões) processada(s): ${(Array.isArray(result)?result.length:0)||targets.length}.`); }
  if(command==='avisar') { const list=await targetRequired(); if(!list)return true; const reason=args.replace(/@\d+/g,'').trim()||'Sem motivo informado'; for(const jid of list){g.warnings[jid]||=[];g.warnings[jid].push({reason:reason.slice(0,180),by:ctx.sender,at:new Date().toISOString()});} writeJson(STATE_FILE,s); return send(`⚠️ Aviso registrado para ${list.length} participante(s). Motivo: ${reason}`); }
  if(command==='avisos') { const list=targets.length?targets:Object.keys(g.warnings); if(!list.length)return send('Não há avisos registrados neste grupo.'); const lines=list.map(jid=>`• @${jid.split('@')[0]}: ${(g.warnings[jid]||[]).length} aviso(s)`); return ctx.sock.sendMessage(ctx.jid,{text:`⚠️ AVISOS DO GRUPO\n\n${lines.join('\n')}`,mentions:list},{quoted:ctx.msg}); }
  if(command==='zeraravisos') { const list=await targetRequired(); if(!list)return true; for(const jid of list)delete g.warnings[jid]; writeJson(STATE_FILE,s); return send('🧹 Avisos dos participantes selecionados foram zerados.'); }
  if(command==='definirregras') { if(!args)return send('Use !definirregras escreva as regras.'); g.rules=args.slice(0,3000); writeJson(STATE_FILE,s); return send('📜 Regras do grupo atualizadas.'); }
  if(command==='regrasgrupo') return send(g.rules?`📜 REGRAS DO GRUPO\n\n${g.rules}`:'Este grupo ainda não possui regras cadastradas.');
  if(command==='limparavisos') { g.warnings={}; writeJson(STATE_FILE,s); return send('🧹 Todos os avisos deste grupo foram apagados.'); }
  return false;
}

export async function handleAdvancedCommand(ctx) {
  const c=String(ctx.command||'').toLowerCase();
  const s=state();
  if(ctx.jid.endsWith('@g.us') && !s.groups[ctx.jid]) { s.groups[ctx.jid]={enabled:true}; writeJson(STATE_FILE,s); }
  if(ctx.jid.endsWith('@g.us') && s.groups[ctx.jid]?.enabled===false && !owner(ctx)) { await ctx.send(ctx.jid,'🚫 O Léo Stickers está desativado neste grupo.',ctx.msg); return true; }
  if(s.maintenance && !owner(ctx) && !['painel','ajuda','menu'].includes(c)) { await ctx.send(ctx.jid,'🛠️ O bot está em manutenção. Tente novamente mais tarde.',ctx.msg); return true; }
  const joinApprovalHandled = await handleJoinApprovalCommand(ctx);
  if(joinApprovalHandled) return true;
  const groupAdminCommands=['infogrupo','linkgrupo','novolink','fechargrupo','abrirgrupo','mudarnomegrupo','mudardescgrupo','promover','rebaixar','remover','marcaradmins','marcarmembros','aprovar','recusar','avisar','avisos','zeraravisos','definirregras','regrasgrupo','limparavisos'];
  if(groupAdminCommands.includes(c)){await groupAdminCommand(ctx,c);return true;}
  if(['figparecida','figsemelhantes'].includes(c)){await similarCommand(ctx);return true;}
  if(c==='figdupla'){const items=random(catalog(ctx),2);if(!items.length)return ctx.send(ctx.jid,'Biblioteca vazia.',ctx.msg);const n=await sendItems(ctx,items,2);return ctx.send(ctx.jid,`⚖️ Duelo visual: ${n} figurinhas enviadas.`,ctx.msg);}
  if(c==='figdodia'){await dailyFig(ctx);return true;}
  if(c==='topfig'){await topFig(ctx);return true;}
  if(c==='figantiga'){await libraryAge(ctx,false);return true;}
  if(c==='fignova'){await libraryAge(ctx,true);return true;}
  if(['contorno','sombra','pixel','negativo','pretoebranco','recortar','zoom','desfocar'].includes(c)){await imageEffect(ctx,c);return true;}
  if(Object.hasOwn(IMAGE_TRANSFORMS,c)){await transformMediaCommand(ctx,c,false);return true;}
  if(Object.hasOwn(STICKER_TRANSFORMS,c)){await transformMediaCommand(ctx,c,true);return true;}
  if(['criarcolecao','adicionarcolecao','minhascolecoes','exportarcolecao','mesclarcolecoes'].includes(c)){await collectionsCommand(ctx,c);return true;}
  if(c==='duplicadas'){await duplicatesCommand(ctx);return true;}
  if(c==='pacotesrecentes'){await recentPacks(ctx);return true;}
  if(c==='exportarbiblioteca'){await exportLibrary(ctx);return true;}
  if(c==='relatoriocompleto'){await report(ctx);return true;}
  if(['manutencao','anuncio','bloqueargrupo','desbloqueargrupo','reiniciargrupo'].includes(c)){await ownerTools(ctx,c);return true;}
  if(['desafiofig','votefig','roubarfig','adivinhe','resposta','corridafig'].includes(c)){await socialGame(ctx,c);return true;}
  return false;
}
