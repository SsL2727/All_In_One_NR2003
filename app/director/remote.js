// Phone remote for the TV director: a small web page for a phone on the same network.
//   GET  /?k=KEY                 the page
//   GET  /api/state?k=KEY        who is on TV, the field, camera, settings that matter
//   POST /api/focus?slot=&k=     put a car on TV (held for manual_hold seconds)
//   POST /api/cam?c=&k=          switch camera
//   POST /api/auto?k=            hand control back to the director
//   POST /api/pause?on=0|1&k=    pause / resume the director
//   POST /api/set?name=&value=&k=  change a director setting
//   POST /api/replay[?id=]  /api/reel  /api/live    crash replays: the best crash (or one by id), the highlight reel, back to live
//   GET  /api/cam-describe?c=       a camera's tune; POST /api/cam-adjust?c=&tune= (live), /api/cam-save, /api/cam-new?base=&name=&tune=,
//                                   /api/cam-delete?id=, /api/cam-label?id=&name=, /api/cam-order?list=, /api/cam-hide?id=&on=, /api/preset?name=
//   GET  /api/dyn                   dynamic cameras: what is learned about the track, the angles and their scores, the one on air
//   POST /api/dyn/test, /api/dyn/forget, /api/dyn/rate?up=1|0     the test camera; forget the track; thumbs up / down for the last shot
//   GET  /preview?track=&name=      a simulated race through a track's camera set; GET /api/camsets/preview?track=&name= its data
//   GET  /api/camsets[?track=&series=]   camera sets; POST /api/camsets/apply?kind=track|series&who=&name=&live=1&save=1, /api/camsets/restore,
//                                   /api/camsets/series?name=   which mod's car cameras the game has (remembered per art series)
//   GET  /api/tape                  the tape transport (RaceVision 1.2.0): speed, position, laps / flags / crashes on the tape
//   POST /api/tape/ctl?do=play|pause|toggle|live|start|slower|faster|slow&n=|fast&n=[&rev=1]|step&d=|seek&f=|lap&n=|crash&n=|jump&kind=L|C|F&d=
// Same endpoints RaceVision's remote used, so apps written for it keep working. The pairing key is the `remote_key` setting.
'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TV director</title><style>
body{margin:0;background:#0e1014;color:#e0e4ec;font:15px system-ui,sans-serif}
header{padding:10px 14px;background:#13161a;border-bottom:1px solid #1e2229}
h1{margin:0;font-size:16px}#tv{color:#e8c84a;margin-top:4px}
.b{display:inline-block;margin:3px;padding:10px 12px;background:#1a1e26;border:1px solid #2a3040;border-radius:6px;min-width:44px;text-align:center}
.b.on{background:#22304a;border-color:#3b5a8a}.b.off{opacity:.35}
.wide{display:block;margin:6px 10px}
.sec{padding:8px 10px 0;color:#7d8594;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.row{display:flex;padding:9px 12px;border-bottom:1px solid #14181e;gap:10px}.row.tv{background:#162235}.row span:nth-child(1){width:2em;text-align:right;color:#7d8594}
.row span:nth-child(2){width:2.6em;color:#e8c84a}.row span:nth-child(3){flex:1}.row span:nth-child(4){color:#7d8594}
</style></head><body><header><h1>🎥 TV director</h1><div id="tv">…</div></header>
<div><button class="b wide" id="auto">Hand back to the director</button><button class="b wide" id="pause">Pause director</button></div>
<button class="b wide" id="view">Open live director map and timeline</button>
<div class="sec">Replays</div><div id="rpl" style="padding:4px 10px"></div>
<div class="sec">Playback <span id="tps" style="text-transform:none;color:#e8c84a"></span> <span id="tpp" style="text-transform:none"></span></div>
<div id="tp" style="padding:4px 10px"><input type="range" id="tpSeek" min="0" max="1000" value="1000" style="width:100%">
<div><button class="b" data-tp="start">|&lt;</button><button class="b" data-tp="step" data-d="-1">&lt; Frame</button><button class="b" data-tp="toggle" id="tpPlay">Play</button><button class="b" data-tp="step" data-d="1">Frame &gt;</button><button class="b" data-tp="live">Live &gt;|</button></div>
<div><button class="b" data-tp="fast" data-n="2" data-rev="1">&lt;&lt; x2</button><button class="b" data-tp="slow" data-n="16">1/17</button><button class="b" data-tp="slow" data-n="7">1/8</button><button class="b" data-tp="slow" data-n="3">1/4</button><button class="b" data-tp="slow" data-n="1">1/2</button><button class="b" data-tp="play">1x</button><button class="b" data-tp="fast" data-n="2">x2</button><button class="b" data-tp="fast" data-n="4">x4</button></div>
<div><button class="b" data-tp="jump" data-kind="C" data-d="-1">&lt; Crash</button><button class="b" data-tp="jump" data-kind="C" data-d="1">Crash &gt;</button><button class="b" data-tp="jump" data-kind="L" data-d="-1">&lt; Lap</button><button class="b" data-tp="jump" data-kind="L" data-d="1">Lap &gt;</button>
 Lap <input type="number" id="tpLap" min="1" style="width:60px;background:#1a1e26;color:#e0e4ec;border:1px solid #2a3040;border-radius:6px;padding:8px"><button class="b" id="tpGo">Go</button></div>
<div id="tpn" style="color:#7d8594;font-size:12px;min-height:16px"></div></div>
<div class="sec">Cameras <span id="camname" style="text-transform:none"></span></div><div id="cams" style="padding:4px 8px"></div>
<div id="adj" style="padding:4px 10px"></div>
<div class="sec">Drivers</div><div id="field"></div>
<script>
const K=new URLSearchParams(location.search).get('k')||'';
const api=(m,p,q)=>fetch('/api/'+p+'?'+new URLSearchParams(Object.assign({k:K},q||{})),{method:m}).then(r=>r.json());
let S=null,EDIT=0,TUNE=null,KIND='';
async function tick(){try{S=await api('GET','state');paint()}catch(e){document.getElementById('tv').textContent='no connection'}}
function paint(){
 const cur=S.director.cur,car=cur&&S.field.find(x=>x.slot===cur.slot);
 document.getElementById('tv').textContent=(S.attached?'':'NR2003 not running · ')+(cur?'On TV: #'+(car?car.num:cur.slot)+' '+(car?car.name:'')+' · cam '+S.camera+' · '+cur.kind:'Nothing on TV yet')+(S.director.manual?' (manual)':'')+(S.director.paused?' (paused)':'');
 document.getElementById('pause').textContent=S.director.paused?'Resume director':'Pause director';
 const c=document.getElementById('cams');c.textContent='';
 for(const cm of (S.library||[])){if(cm.hidden&&EDIT!==cm.id)continue;const b=document.createElement('div');b.className='b'+(S.camera==cm.base&&!EDIT?' on':'')+(EDIT===cm.id?' on':'')+(S.enabledCams.includes(cm.id)?'':' off');b.textContent=cm.id;b.title=cm.name;b.onclick=()=>{api('POST','cam',{c:cm.id}).then(()=>{EDIT=cm.id;edit()}).then(tick)};c.appendChild(b)}
 const rp=document.getElementById('rpl');rp.textContent='';
 const btn=(t,p,q)=>{const b=document.createElement('div');b.className='b';b.textContent=t;b.onclick=()=>api('POST',p,q||{}).then(tick);rp.appendChild(b)};
 btn(S.replay&&S.replay.phase!=='idle'?'⏹ Back to live':'▶ Replay best crash',S.replay&&S.replay.phase!=='idle'?'live':'replay');btn('🎞 Highlight reel','reel');
 for(const x of (S.crashes||[]).slice().reverse().slice(0,8))btn('#'+x.id+' '+x.cars.map(c=>c.num).join(' ')+' · '+x.score,'replay',{id:x.id});
 if(S.replay&&S.replay.phase!=='idle'){const t=document.createElement('div');t.style.margin='4px';t.textContent=S.replay.text;rp.appendChild(t)}
 const f=document.getElementById('field');f.textContent='';
 for(const x of S.field){const r=document.createElement('div');r.className='row'+(S.focus===x.slot?' tv':'');for(const v of [x.pos,x.num,x.name,x.pit?'PIT':Math.round(x.speed*2.237)]){const s=document.createElement('span');s.textContent=v;r.appendChild(s)}r.onclick=()=>api('POST','focus',{slot:x.slot}).then(tick);f.appendChild(r)}
}
const LAB=['x (m, + ahead)','y (m, + left)','z (m, up)','turn (°)','tilt (°)','roll (°)','lens (°)'];
async function edit(){const d=await fetch('/api/cam-describe?'+new URLSearchParams({k:K,c:EDIT})).then(r=>r.json());const a=document.getElementById('adj');a.textContent='';TUNE=d.tune;KIND=d.kind;
 document.getElementById('camname').textContent=(d.library||[]).filter(x=>x.id===EDIT).map(x=>'· '+x.name).join('');
 if(!d.editable||!d.tune){a.textContent='';return}
 const step=[0.1,0.1,0.1,1,1,1,1];
 d.tune.forEach((v,i)=>{const r=document.createElement('div');r.style.cssText='display:flex;align-items:center;gap:6px;margin:3px 0';const l=document.createElement('span');l.style.flex='1';l.textContent=LAB[i]+': '+v;const mk=(t,dv)=>{const b=document.createElement('div');b.className='b';b.textContent=t;b.onclick=()=>{TUNE[i]=Math.round((TUNE[i]+dv)*100)/100;l.textContent=LAB[i]+': '+TUNE[i];api('POST','cam-adjust',{c:EDIT,tune:TUNE.join(',')})};return b};r.append(mk('−',-step[i]),l,mk('+',step[i]));a.appendChild(r)});
 if(d.base===16&&EDIT>=22){
  const stick=document.createElement('div');stick.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0';
  const hold=(label,dh,dd)=>{const b=document.createElement('button');b.className='b';b.textContent=label;let timer=0;const go=()=>{if(dh){TUNE[0]=Math.max(0,Math.min(150,(TUNE[0]||0)+dh*1.17));api('POST','cam-adjust',{c:EDIT,tune:TUNE.join(',')})}if(dd){const dist=Math.max(20,Math.min(500,(Number(S.settings.drone_distance)||100)+dd*3));S.settings.drone_distance=dist;api('POST','set',{name:'drone_distance',value:dist}).then(()=>api('POST','cam-adjust',{c:EDIT,tune:TUNE.join(',')}))}};b.onpointerdown=e=>{e.preventDefault();go();timer=setInterval(go,90)};const stop=()=>{clearInterval(timer);timer=0};b.onpointerup=stop;b.onpointerleave=stop;b.onpointercancel=stop;return b};
  stick.append(hold('▲ Climb',1,0),hold('▼ Descend',-1,0),hold('Closer',0,-1),hold('Farther',0,1));a.appendChild(stick);
  for(const [key,label,min,max] of [['drone_top_mph','Top speed (mph)',100,300],['drone_hover_m','Hover radius (m)',0,80]]){const r=document.createElement('div');r.style.cssText='display:flex;gap:8px;align-items:center;margin:5px 0';const l=document.createElement('span');l.style.flex='1';l.textContent=label;const i=document.createElement('input');i.type='range';i.min=min;i.max=max;i.value=S.settings[key];i.oninput=()=>{S.settings[key]=Number(i.value);api('POST','set',{name:key,value:i.value}).then(()=>api('POST','cam-adjust',{c:EDIT,tune:TUNE.join(',')}))};r.append(l,i);a.appendChild(r)}
 }
 const row=document.createElement('div');const sv=document.createElement('div');sv.className='b';sv.textContent='💾 Save';sv.onclick=()=>api('POST','cam-save',{c:EDIT,tune:TUNE.join(',')}).then(tick);
 const nw=document.createElement('div');nw.className='b';nw.textContent='＋ Save as a new camera';nw.onclick=()=>{const n=prompt('Name of the new camera','Custom');if(n)api('POST','cam-new',{base:d.base,name:n,tune:TUNE.join(',')}).then(tick)};
 const rn=document.createElement('div');rn.className='b';rn.textContent='✎ Rename';rn.onclick=()=>{const n=prompt('Name',(d.library||[]).filter(x=>x.id===EDIT).map(x=>x.name)[0]||'');if(n)api('POST','cam-label',{id:EDIT,name:n}).then(tick)};
 const hd=document.createElement('div');hd.className='b';hd.textContent='🙈 Hide / show';hd.onclick=()=>{const h=((d.library||[]).filter(x=>x.id===EDIT)[0]||{}).hidden;api('POST','cam-hide',{id:EDIT,on:h?0:1}).then(tick)};
 row.append(sv,nw,rn,hd);a.appendChild(row)}
let TP=null,tpDrag=false;
const tpTime=(f,r)=>{const s=Math.max(0,Math.round(f/(r||36)));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const tpSend=(q)=>api('POST','tape/ctl',q).then(()=>setTimeout(tpPoll,250));
async function tpPoll(){try{TP=await api('GET','tape');const t=TP,live=t.mode!==1;
 document.getElementById('tps').textContent=t.speed;
 let lap='';for(const m of t.marks)if(m.t==='L'&&m.f<=t.idx)lap=m.l;
 document.getElementById('tpp').textContent=t.frames>0?(live?tpTime(t.frames,t.rate)+' of race on the tape':tpTime(t.idx,t.rate)+' / '+tpTime(t.frames,t.rate)+(lap?' · '+lap:'')):'';
 if(!tpDrag)document.getElementById('tpSeek').value=live?1000:Math.round(1000*t.idx/Math.max(1,t.frames-1));
 document.getElementById('tpPlay').textContent=!live&&t.step!==0?'Pause':'Play';
 document.getElementById('tp').style.opacity=t.can||!live?1:.5;
 document.getElementById('tpn').textContent=t.msg||(!t.can&&live?t.why:'');}catch(e){}}
document.getElementById('tp').addEventListener('click',e=>{const b=e.target.closest('[data-tp]');if(!b)return;const k=b.dataset.tp,q={do:k};
 if(k==='toggle')q.do=TP&&TP.mode===1&&TP.step!==0?'pause':'play';
 if(b.dataset.n)q.n=b.dataset.n;if(b.dataset.d)q.d=b.dataset.d;if(b.dataset.kind)q.kind=b.dataset.kind;if(b.dataset.rev)q.rev=1;tpSend(q)});
const sk=document.getElementById('tpSeek');sk.oninput=()=>{tpDrag=true};sk.onchange=()=>{tpDrag=false;tpSend({do:'seek',f:(sk.value/1000).toFixed(4)})};
document.getElementById('tpGo').onclick=()=>{const n=parseInt(document.getElementById('tpLap').value,10);if(n>0)tpSend({do:'lap',n})};
tpPoll();setInterval(tpPoll,700);
document.getElementById('auto').onclick=()=>api('POST','auto').then(tick);
document.getElementById('pause').onclick=()=>api('POST','pause',{on:S&&S.director.paused?0:1}).then(tick);
document.getElementById('view').onclick=()=>location.href='/director?k='+encodeURIComponent(K);
tick();setInterval(tick,1500);
</script></body></html>`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

const tune = (v) => String(v == null ? '' : v).split(',').map(Number).filter(Number.isFinite);

class Remote {
  // svc: DirectorService; getKey(): string
  constructor(svc, getKey) { this.svc = svc; this.getKey = getKey; this.server = null; this.port = 0; this.error = ''; }

  start(port) {
    if (this.server && this.port === port) return;
    this.stop();
    this.port = port;
    const srv = http.createServer((req, res) => this._handle(req, res));
    srv.on('error', (e) => { this.error = e.code === 'EADDRINUSE' ? `port ${port} is in use (RaceVision.exe?)` : String(e.message); this.server = null; });
    srv.on('listening', () => { this.error = ''; });
    srv.listen(port, '0.0.0.0');
    this.server = srv;
  }

  stop() { if (this.server) { try { this.server.close(); if (this.server.closeAllConnections) this.server.closeAllConnections(); } catch (e) { /* ignore */ } } this.server = null; this.port = 0; }

  urls() { return this.port ? lanAddresses().map(a => `http://${a}:${this.port}/?k=${encodeURIComponent(this.getKey())}`) : []; }

  // the overlay editor's calls: the body (a layout's JSON, or an uploaded picture) is read whole, the reply can be JSON, PNG, a font or a picture
  _overlayApi(req, res, u) {
    const sub = u.pathname.length > 13 ? u.pathname.slice(13) : '';
    const posts = ['save', 'delete', 'reset', 'duplicate', 'use', 'upload', 'render', 'stylesave', 'styleuse', 'styledelete', 'panelpos'];
    const reply = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (posts.includes(sub) && req.method !== 'POST') return reply(400, 'application/json; charset=utf-8', JSON.stringify({ error: 'use POST' }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 16 * 1024 * 1024) chunks.push(c); });
    req.on('end', async () => {
      if (size > 16 * 1024 * 1024) return reply(413, 'application/json; charset=utf-8', JSON.stringify({ error: 'too big' }));
      const buf = Buffer.concat(chunks);
      try {
        const r = await this.svc.layoutApi(sub, Object.fromEntries(u.searchParams), sub === 'upload' ? buf : buf.toString('utf8'));
        reply(r.code, r.type, r.body);
      } catch (e) { reply(500, 'application/json; charset=utf-8', JSON.stringify({ error: String(e && e.message || e) })); }
    });
  }

  _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (u.searchParams.get('k') !== this.getKey()) return send(403, { error: 'wrong or missing key' });
    const q = (n) => u.searchParams.get(n);
    try {
      if (u.pathname === '/' || u.pathname === '/index.html') return send(200, PAGE, 'text/html');
      if (u.pathname === '/director' || u.pathname === '/director.html') return send(200, fs.readFileSync(path.join(__dirname, 'view.html'), 'utf8'), 'text/html');
      if (u.pathname === '/preview' || u.pathname === '/preview.html') return send(200, fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8'), 'text/html');
      // RaceVision 2.0: the overlay layout editor and its calls (director/layouts.js)
      if (u.pathname === '/overlays' || u.pathname === '/overlays.html') return send(200, fs.readFileSync(path.join(__dirname, 'overlays.html'), 'utf8'), 'text/html');
      if (u.pathname === '/api/overlay' || u.pathname.startsWith('/api/overlay/')) { this._overlayApi(req, res, u); return; }
      if (u.pathname === '/api/state') return send(200, this.svc.getState());
      if (u.pathname === '/api/director/live') return send(200, this.svc.directorLive());
      if (u.pathname === '/api/director/map') return send(200, { map: this.svc.directorLive().map, cars: this.svc.directorLive().cars });
      if (u.pathname === '/api/director/events') return send(200, { events: this.svc.directorEvents(parseFloat(q('from')) || -Infinity) });
      if (u.pathname === '/api/director/at') return send(200, this.svc.directorAt(parseFloat(q('t')) || 0) || {});
      if (u.pathname === '/api/director/files') return send(200, this.svc.directorFiles());
      if (u.pathname === '/api/director/file') { const body = this.svc.directorFile(q('name')); return body === null ? send(404, 'No such recording.', 'text/plain') : send(200, body, 'application/x-ndjson'); }
      const artMatch = /^\/art\/(number|head|manu|logo)\/([A-Za-z0-9_-]+)\.png$/.exec(u.pathname);
      if (artMatch) {
        const file = this.svc.artImage(q('s'), artMatch[1], artMatch[2]);
        if (!file) return send(404, 'No image.', 'text/plain');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
        return res.end(fs.readFileSync(file));
      }
      if (u.pathname === '/api/settings') return send(200, this.svc.getState().settings);
      if (u.pathname === '/api/set') { const n = q('name'); if (!n) return send(400, { error: 'name?' }); this.svc.setConfig({ settings: { [n]: q('value') } }); return send(200, { ok: true }); }
      if (u.pathname === '/api/focus' && req.method === 'GET') { const s = parseInt(q('slot'), 10); if (!(s >= 0 && s < 44)) return send(400, { error: 'bad slot' }); this.svc.focus(s); return send(200, { ok: true }); }
      // dynamic cameras and camera sets (RaceVision, Nov 2026)
      if (u.pathname === '/api/dyn') return send(200, this.svc.dynStatus());
      if (u.pathname === '/api/tape') return send(200, this.svc.tapeState());
      if (u.pathname === '/api/camsets/preview') { const r = this.svc.camsetsPreview(q('track') || '', q('name') || ''); return send(r.error ? 400 : 200, r); }
      if (u.pathname === '/api/camsets') return send(200, this.svc.camsetsState(q('track') || '', q('series') || ''));
      if (u.pathname === '/api/cam-describe') { const c = parseInt(q('c'), 10); if (!(c >= 1 && c <= 40)) return send(400, { error: 'bad camera' }); return send(200, this.svc.camDescribe(c)); }
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      switch (u.pathname) {
        case '/api/focus': { const s = parseInt(q('slot'), 10); if (!(s >= 0 && s < 44)) return send(400, { error: 'bad slot' }); this.svc.focus(s); return send(200, { ok: true }); }
        case '/api/cam': { const c = parseInt(q('c'), 10); if (!(c >= 1 && c <= 40)) return send(400, { error: 'bad camera' }); this.svc.camera(c); return send(200, { ok: true }); }
        case '/api/replay': { const id = parseInt(q('id'), 10); return send(200, { ok: id > 0 ? this.svc.replayCrash(id) : this.svc.replayNow() }); }
        case '/api/reel': return send(200, { ok: this.svc.reel() });
        case '/api/live': return send(200, { ok: this.svc.replayLive() });
        case '/api/cam-adjust': { const c = parseInt(q('c'), 10); if (!(c >= 1 && c <= 40)) return send(400, { error: 'bad camera' }); return send(200, { ok: this.svc.camAdjust(c, tune(q('tune'))) }); }
        case '/api/cam-save': { const c = parseInt(q('c'), 10); if (!(c >= 1 && c <= 40)) return send(400, { error: 'bad camera' }); return send(200, { ok: this.svc.camSave(c, tune(q('tune'))) }); }
        case '/api/cam-new': return send(200, { id: this.svc.camNew(parseInt(q('base'), 10), q('name'), tune(q('tune'))) });
        case '/api/cam-delete': return send(200, { ok: this.svc.camDelete(parseInt(q('id'), 10)) });
        case '/api/cam-label': return send(200, { ok: this.svc.camLabel(parseInt(q('id'), 10), q('name')) });
        case '/api/cam-order': return send(200, { ok: this.svc.camOrder(String(q('list') || '').split(',').map(Number)) });
        case '/api/cam-hide': return send(200, { ok: this.svc.camHide(parseInt(q('id'), 10), q('on') === '1') });
        case '/api/preset': return send(200, { ok: this.svc.applyPreset(q('name')) });
        case '/api/auto': this.svc.auto(); return send(200, { ok: true });
        case '/api/pause': this.svc.pause(q('on') === '1'); return send(200, { ok: true });
        case '/api/set': { const n = q('name'); if (!n) return send(400, { error: 'name?' }); this.svc.setConfig({ settings: { [n]: q('value') } }); return send(200, { ok: true }); }
        case '/api/tape/ctl': { const q2 = Object.fromEntries(u.searchParams); return this.svc.tapeCtl(q2) ? send(200, { ok: true }) : send(400, { error: 'Unknown playback command.' }); }
        case '/api/camsets/series': { const r = this.svc.camsetsSeries(q('name') || ''); return send(r.error ? 400 : 200, r); }
        case '/api/dyn/test': { const r = this.svc.dynTest(); return send(r.error ? 400 : 200, r); }
        case '/api/dyn/forget': return send(200, this.svc.dynForget());
        case '/api/dyn/rate': { const r = this.svc.dynRate(q('up') === '1'); return send(r.error ? 400 : 200, r); }
        case '/api/camsets/apply': case '/api/camsets/restore': {
          const kind = q('kind'), who = q('who'), name = u.pathname.endsWith('restore') ? 'stock' : q('name');
          if (!['track', 'series'].includes(kind) || !who || !name) return send(400, { error: 'kind, who and name?' });
          const r = this.svc.camsetsApply(kind, who, name, q('live') === '1', q('save') === '1');
          return send(200, r);
        }
        default: return send(404, { error: 'unknown' });
      }
    } catch (e) { return send(500, { error: String(e && e.message || e) }); }
  }
}

module.exports = { Remote, lanAddresses, PAGE };
