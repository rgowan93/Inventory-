/* House of Cards — local beta (self-contained, offline, browser-stored).
   No build step, no server, no internet required. Data lives in this browser
   (IndexedDB). Use Settings → Reset to clear test data before your first show. */

/* ============================== constants ============================== */
const METHODS = ['cash','venmo','cashapp','paypal','square','zelle'];
const METHOD_LABEL = {cash:'Cash',venmo:'Venmo',cashapp:'Cash App',paypal:'PayPal',square:'Square',zelle:'Zelle'};
const CONDITIONS = ['NM','LP','MP','HP','DMG'];
const COND_NAME = {NM:'Near Mint',LP:'Lightly Played',MP:'Moderately Played',HP:'Heavily Played',DMG:'Damaged'};
const CATEGORIES = ['Pokemon','One Piece','Magic','Sports','Other'];
const VARIANCES = ['Normal','Holofoil','Reverse Holofoil','Foil','Promo'];
const LANGUAGES = ['EN','JP','CN','Other'];

/* ============================== cloud (Supabase) ============================== */
let sb = null;                       // Supabase client, or null when offline-only
function cloudOn(){ return !!sb; }
function initCloud(){
  try{ const c=window.HOC_CONFIG||{};
    if(c.SUPABASE_URL && c.SUPABASE_ANON_KEY && window.supabase){
      sb = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
      console.log('[HoC] cloud connected:', c.SUPABASE_URL);
    } else { console.log('[HoC] running offline (no Supabase config)'); }
  }catch(e){ console.warn('[HoC] cloud init failed', e); sb=null; }
}
function logoBucket(){ return (window.HOC_CONFIG&&window.HOC_CONFIG.LOGO_BUCKET)||'branding'; }
/* public URL of the shared landing logo (same for every device); cache-busted by version */
function cloudLogoUrl(){ const c=window.HOC_CONFIG||{}; if(!c.SUPABASE_URL)return null;
  const v=(state&&state.settings&&state.settings.cloudLogoV)||0;
  return c.SUPABASE_URL+'/storage/v1/object/public/'+logoBucket()+'/logo.png?v='+v; }
/* upload the chosen file to Supabase Storage so the landing logo is shared everywhere */
async function uploadCloudLogo(file){
  if(!cloudOn()) return false;
  const { error } = await sb.storage.from(logoBucket()).upload('logo.png', file, { upsert:true, contentType:file.type||'image/png' });
  if(error){ console.warn('[HoC] logo upload', error); toast('Cloud upload failed: '+error.message); return false; }
  state.settings.cloudLogoV = Date.now();   // bump version so every device refetches
  return true;
}

/* ============================== state ============================== */
let state = null;
let ui = { route:'dashboard', cart:[], cartPayments:[], focusId:null, sellPanel:null, showPanel:null,
           tradeDraft:null, inForm:{}, zellePick:null, authed:false, loginUser:null, loginMode:'login', authView:'wall', menuOpen:false };

/* audit trail — everyone on a company shares access, but every change is signed by who made it */
function logChange(area,detail){ if(!state)return; state.audit=state.audit||[]; state.audit.push({id:uid('log'),at:Date.now(),userId:state.currentUserId,area,detail}); if(state.audit.length>3000)state.audit=state.audit.slice(-3000); }

/* simple local password hash (this is a trusted-team local app, not bank-grade) */
function hashPass(s){ s=String(s==null?'':s); let h=5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))>>>0; } return 'h'+h.toString(36); }
function freshUser(id,name){ return {id,name,pass:hashPass('test'),secQ:'',secA:'',mustChange:true}; }

function freshState(){
  const reggie=freshUser('u_reggie','Reggie'), manny=freshUser('u_manny','Manny'), hailey=freshUser('u_hailey','Hailey');
  return {
    version:3,
    users:[reggie,manny,hailey],
    currentUserId:reggie.id,
    paymentAccounts:{cash:'drawer',venmo:manny.id,cashapp:reggie.id,paypal:reggie.id,square:reggie.id,zelle:'prompt'},
    settings:{ cashFloat:200, floatOwnerId:reggie.id, prizePrice:10, prizePlaysPerShow:400, prizeSplit:[reggie.id,manny.id], buyPct:70 },
    inventory:[], shows:[], currentShowId:null, trades:[], wantlist:[], sales:[], imageDB:{}, audit:[]
  };
}
/* identity key for the shared image database (so re-adding the same card reuses its image) */
function cardKey(it){ const graded=(it.grade&&it.grade.toLowerCase()!=='ungraded')?'graded':'raw';
  return [norm(it.category),norm(it.set),norm(it.number),norm(it.name),norm(it.variance),norm(it.language||'EN'),graded,(it.upc?norm(it.upc):'')].join('|'); }
function dbEntry(it){ const e=state.imageDB[cardKey(it)]; return (e&&e.photo)?e:null; }
function dbSave(it,photo,source){ const k=cardKey(it); const e=state.imageDB[k]||{rejected:[]};
  if(e.source==='manual'&&source==='fetch')return; // never let a fetch overwrite a human-picked image
  e.photo=photo; e.source=source; e.updated=Date.now(); e.rejected=e.rejected||[]; state.imageDB[k]=e; }

/* ============================== persistence (IndexedDB) ============================== */
/* Reuse a single DB connection. iOS Safari throws "internal error / connection lost"
   if you open a fresh connection on every write, so we cache one and reopen only if
   it drops. Writes also swallow errors (logged to console) and retry on the next change. */
let _db=null;
function openDB(){
  if(_db) return Promise.resolve(_db);
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('houseofcards',1);
    open.onupgradeneeded=()=>{ if(!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv'); };
    open.onsuccess=()=>{ _db=open.result; _db.onclose=()=>{_db=null;}; _db.onversionchange=()=>{try{_db.close();}catch(e){} _db=null;}; resolve(_db); };
    open.onerror=()=>{ _db=null; reject(open.error); };
  });
}
function idb(mode, fn){
  return openDB().then(db=>new Promise((resolve,reject)=>{
    let req; try{ const tx=db.transaction('kv',mode); const store=tx.objectStore('kv'); req=fn(store);
      tx.oncomplete=()=>resolve(req&&req.result); tx.onerror=()=>{_db=null;reject(tx.error);}; tx.onabort=()=>{_db=null;reject(tx.error);}; }
    catch(e){ _db=null; reject(e); }
  }));
}
const loadState=()=>idb('readonly',s=>s.get('state')).catch(()=>null);
let saveTimer=null;
function save(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>{
  try{ idb('readwrite',s=>s.put(JSON.parse(JSON.stringify(state)),'state')).catch(e=>{ _db=null; console.warn('[HoC] save retry next change', e); }); }
  catch(e){ console.warn('[HoC] save skipped', e); } },150); }

/* ============================== helpers ============================== */
let _c=0;
const uid=p=>(p||'id')+'_'+Date.now().toString(36)+'_'+(_c++).toString(36);
const money=n=>'$'+(Number(n)||0).toFixed(2);
const userName=id=>{const u=state.users.find(u=>u.id===id);return u?u.name:'—';};
const me=()=>state.users.find(u=>u.id===state.currentUserId);
const initials=u=>String((u&&u.name)||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';
function avatarTag(u,size){ const c='avatar-'+(size||'sm'); return (u&&u.avatar)
  ? '<img class="'+c+'" src="'+esc(u.avatar)+'" alt=""/>'
  : '<div class="'+c+' avatar-ph">'+esc(initials(u))+'</div>'; }
/* the signed-in person's avatar: prefer their synced cloud photo, else the local one */
function currentAvatarTag(size){ if(typeof myProfile!=='undefined'&&myProfile&&myProfile.avatar_url)
  return '<img class="avatar-'+(size||'sm')+'" src="'+esc(myProfile.avatar_url)+'" alt=""/>'; return avatarTag(me(),size); }
const el=id=>document.getElementById(id);
const val=id=>{const e=el(id);return e?e.value.trim():'';};
const num=id=>{const v=parseFloat(val(id));return isNaN(v)?0:v;};
function toast(msg){const t=el('toast');t.innerHTML='<div class="toast">'+msg+'</div>';setTimeout(()=>{t.innerHTML='';},2600);}
function genBarcodeId(){ const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<5;i++)s+=a[Math.floor(Math.random()*a.length)];return 'HOC-'+s; }
const currentShow=()=>state.shows.find(s=>s.id===state.currentShowId)||null;
const openShow=()=>{const s=currentShow();return (s&&s.status==='open')?s:null;};
const condPill=c=>'<span class="pill '+(c||'nm').toLowerCase()+'">'+(c||'NM')+'</span>';
const statusPill=s=>'<span class="pill '+s+'">'+s+'</span>';
function userSel(id,cur){return '<select id="'+id+'">'+state.users.map(u=>'<option value="'+u.id+'"'+((cur||state.currentUserId)===u.id?' selected':'')+'>'+u.name+'</option>').join('')+'</select>';}

/* ============================== Code39 barcode ============================== */
const CODE39={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
function barcodeSVG(text,height){
  height=height||34; const narrow=2, wide=5, gap=narrow; const data='*'+(text.toUpperCase())+'*'; let x=0; let rects='';
  for(let c=0;c<data.length;c++){ const pat=CODE39[data[c]]; if(!pat)continue;
    for(let i=0;i<9;i++){ const w=pat[i]==='w'?wide:narrow; if(i%2===0){ rects+='<rect x="'+x+'" y="0" width="'+w+'" height="'+height+'" fill="#000"/>'; } x+=w; } x+=gap; }
  return '<svg width="'+x+'" height="'+height+'" viewBox="0 0 '+x+' '+height+'" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">'+rects+'</svg>';
}

/* ============================== stock image (generated placeholder) ============================== */
function stockImage(item){
  const name=(item.name||'Card').slice(0,22), set=(item.set||'').slice(0,22), num=(item.number||'');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="220" height="300" viewBox="0 0 220 300">'+
    '<rect width="220" height="300" rx="14" fill="#1b2740" stroke="#F4B400" stroke-width="6"/>'+
    '<circle cx="110" cy="92" r="42" fill="#F3E9D6" stroke="#000" stroke-width="5"/>'+
    '<path d="M68 92 A42 42 0 0 1 152 92 Z" fill="#E23B2E" stroke="#000" stroke-width="5"/>'+
    '<circle cx="110" cy="92" r="14" fill="#F3E9D6" stroke="#000" stroke-width="5"/>'+
    '<text x="110" y="180" text-anchor="middle" font-family="Arial" font-size="15" font-weight="bold" fill="#F3E9D6">'+escx(name)+'</text>'+
    '<text x="110" y="205" text-anchor="middle" font-family="Arial" font-size="12" fill="#cdd3e6">'+escx(set)+'</text>'+
    '<text x="110" y="225" text-anchor="middle" font-family="Arial" font-size="12" fill="#cdd3e6">'+escx(num)+'</text>'+
    '<text x="110" y="275" text-anchor="middle" font-family="Arial" font-size="10" fill="#8893b5">stock image</text></svg>';
  return 'data:image/svg+xml;utf8,'+encodeURIComponent(svg);
}
const escx=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/* ============================== camera scanner (works in Safari via ZXing) ============================== */
function loadScript(src){ return new Promise((res,rej)=>{ if(document.querySelector('script[data-src="'+src+'"]')){res();return;} const s=document.createElement('script'); s.src=src; s.dataset.src=src; s.onload=()=>res(); s.onerror=()=>rej(new Error('load '+src)); document.head.appendChild(s); }); }
async function openScanner(onCode){
  if(!window.isSecureContext){ toast('Camera needs the hosted version (https). On a double-clicked file the browser blocks the camera — type the code or use a USB/Bluetooth scanner.'); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast('No camera available here.'); return; }
  const wrap=document.createElement('div'); wrap.className='scanmodal';
  wrap.innerHTML='<video autoplay playsinline muted></video><div class="hint">Point the camera at the barcode…</div>'+
    '<div class="scanbar" style="max-width:520px;width:100%;margin-top:6px"><input id="scanManual" placeholder="…or type the code and press Add"/><button class="gold" id="scanAdd">Add</button></div>'+
    '<div class="row" style="margin-top:10px"><button class="red" id="scanClose">Cancel</button></div>';
  document.body.appendChild(wrap);
  const video=wrap.querySelector('video'); let stream=null, stop=false, zx=null;
  const cleanup=()=>{ stop=true; try{if(zx&&zx.reset)zx.reset();}catch(e){} if(stream)stream.getTracks().forEach(t=>t.stop()); wrap.remove(); };
  const done=code=>{ cleanup(); onCode(code); };
  wrap.querySelector('#scanClose').onclick=cleanup;
  wrap.querySelector('#scanAdd').onclick=()=>{ const v=wrap.querySelector('#scanManual').value.trim(); if(v)done(v); };
  wrap.querySelector('#scanManual').onkeydown=e=>{ if(e.key==='Enter'){ const v=e.target.value.trim(); if(v)done(v); } };
  try{ stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}); video.srcObject=stream; await video.play().catch(()=>{}); }
  catch(e){ cleanup(); toast('Could not open camera (permission denied?).'); return; }
  // Path A: native BarcodeDetector (Chrome/Edge/Android)
  if('BarcodeDetector' in window){ try{ const det=new window.BarcodeDetector({formats:['code_39','qr_code','code_128','ean_13','ean_8','upc_a','upc_e']});
      const tick=async()=>{ if(stop)return; try{ const codes=await det.detect(video); if(codes&&codes.length){ done(codes[0].rawValue); return; } }catch(e){} setTimeout(tick,250); }; tick(); return; }catch(e){} }
  // Path B: ZXing from CDN (Safari / iOS and everywhere else)
  wrap.querySelector('.hint').textContent='Starting scanner…';
  try{ await loadScript('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
    const ZX=window.ZXing; if(!ZX){throw new Error('no zxing');}
    if(stop)return;
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; video.srcObject=null; } // let ZXing drive the camera
    zx=new ZX.BrowserMultiFormatReader();
    wrap.querySelector('.hint').textContent='Point the camera at the barcode…';
    zx.decodeFromVideoDevice(null,video,(result,err)=>{ if(stop)return; if(result){ done(result.getText()); } });
  }catch(e){ wrap.querySelector('.hint').textContent='Auto-scan needs internet the first time — type the code below instead.'; }
}

/* ============================== settlement engine ============================== */
/* Builds method × person matrix: how much of each payment method belongs to each
   person (by their share of each sale's items). Plus drawer, cash-outs, buyouts. */
function computeSettlement(show){
  const sales=state.sales.filter(s=>s.showId===show.id && s.status!=='voided');
  const users=state.users; const split=state.settings.prizeSplit||[];
  const matrix={}; METHODS.forEach(m=>{matrix[m]={};users.forEach(u=>matrix[m][u.id]=0);});
  const methodTotals={}; METHODS.forEach(m=>methodTotals[m]=0);
  const perPerson={}; users.forEach(u=>perPerson[u.id]=0);
  let prizeRev=0, totalRevenue=0;

  sales.forEach(sale=>{
    let lineTotal=0; const ownerShare={}; users.forEach(u=>ownerShare[u.id]=0);
    sale.lines.forEach(ln=>{ const amt=Number(ln.soldPrice)||0; lineTotal+=amt; totalRevenue+=amt;
      if(ln.type==='prize'){ prizeRev+=amt; if(split.length){ const sh=amt/split.length; split.forEach(id=>ownerShare[id]=(ownerShare[id]||0)+sh); } }
      else { ownerShare[ln.ownerId]=(ownerShare[ln.ownerId]||0)+amt; } });
    sale.payments.forEach(p=>{ const amt=Number(p.amount)||0; methodTotals[p.method]=(methodTotals[p.method]||0)+amt;
      if(lineTotal>0){ users.forEach(u=>{ const portion=amt*(ownerShare[u.id]/lineTotal); matrix[p.method][u.id]+=portion; perPerson[u.id]+=portion; }); } });
  });

  const cashOuts=show.cashOuts||[]; let totalCashOut=0; const cashOutBy={}; users.forEach(u=>cashOutBy[u.id]=0);
  cashOuts.forEach(co=>{ const a=Number(co.amount)||0; totalCashOut+=a; cashOutBy[co.userId]=(cashOutBy[co.userId]||0)+a; });

  const buyouts=[]; const buyoutNet={}; users.forEach(u=>buyoutNet[u.id]=0);
  state.trades.filter(t=>t.showId===show.id).forEach(t=>{ if(t.buyout&&t.buyout.payerId){ Object.entries(t.buyout.payees||{}).forEach(([payeeId,amt])=>{ amt=Number(amt)||0; if(amt<=0)return; buyoutNet[t.buyout.payerId]-=amt; buyoutNet[payeeId]+=amt; buyouts.push({payerId:t.buyout.payerId,payeeId,amt}); }); } });

  const cashSales=methodTotals.cash||0;
  const drawerExpected=(show.cashFloat||0)+cashSales-totalCashOut;
  const drawerDistributable=cashSales-totalCashOut;

  // take-home per person = their earnings − cash already taken ± buyouts
  const takeHome={}; users.forEach(u=>takeHome[u.id]=perPerson[u.id]-cashOutBy[u.id]+buyoutNet[u.id]);

  return {sales,matrix,methodTotals,perPerson,prizeRev,totalRevenue,cashSales,totalCashOut,cashOutBy,
    drawerExpected,drawerDistributable,buyouts,buyoutNet,takeHome,cashOuts,float:show.cashFloat||0};
}
function ownerProfit(show){
  const sales=state.sales.filter(s=>s.showId===show.id && s.status!=='voided');
  const profit={}; state.users.forEach(u=>profit[u.id]=0);
  sales.forEach(s=>s.lines.forEach(ln=>{ if(ln.type==='prize')return; profit[ln.ownerId]=(profit[ln.ownerId]||0)+((Number(ln.soldPrice)||0)-(Number(ln.costBasis)||0)); }));
  return profit;
}

/* ============================== CSV import ============================== */
function parseCSV(text){
  const rows=[]; let i=0,field='',row=[],inQ=false;
  while(i<text.length){ const ch=text[i];
    if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false; } else field+=ch; }
    else { if(ch==='"')inQ=true; else if(ch===','){row.push(field);field='';} else if(ch==='\n'){row.push(field);rows.push(row);row=[];field='';} else if(ch==='\r'){} else field+=ch; }
    i++; }
  if(field.length||row.length){row.push(field);rows.push(row);} return rows.filter(r=>r.some(c=>c.trim()!==''));
}
function header(headers,names){ const low=headers.map(h=>h.toLowerCase().trim()); for(const n of names){ const idx=low.findIndex(h=>h===n||h.includes(n)); if(idx>=0)return idx; } return -1; }

/* ============================== rendering ============================== */
const TABS=[['dashboard','Dashboard'],['inventory','Inventory'],['add','Add Item'],['import','Import CSV'],['labels','Print Labels'],
  ['sell','Sell'],['trades','Trades'],['wishlist','Wish List'],['history','Sold History'],['reports','Reports'],['friends','Friends'],['activity','Activity'],['settings','Settings']];
const PARENT={checkout:'sell',newtrade:'trades',scanreview:'inventory'};
const VIEWS={dashboard:viewDashboard,inventory:viewInventory,add:viewAdd,import:viewImport,labels:viewLabels,scanreview:viewScanReview,
  sell:viewSell,checkout:viewCheckout,trades:viewTrades,newtrade:viewNewTrade,wishlist:viewWishlist,history:viewHistory,reports:viewReports,
  friends:(typeof viewFriends==='function'?viewFriends:viewDashboard),activity:viewActivity,settings:viewSettings};
function go(route){ ui.route=route; ui.focusId=null;
  if(window.innerWidth<760){ ui.menuOpen=false; }   // on phones the menu overlays content, so collapse it once you pick a destination
  render(); window.scrollTo(0,0); }
function setMenu(open){ ui.menuOpen=open; if(state&&state.settings)state.settings.menuOpen=open; applyMenu(); if(state)save(); }
function toggleMenu(){ setMenu(!ui.menuOpen); }
function closeMenu(){ setMenu(false); }
function applyMenu(){ const open=!!ui.menuOpen&&ui.authed; const n=el('tabs');
  if(n)n.classList.toggle('open',open); document.body.classList.toggle('menu-open',open); }
function render(){
  const logo=el('brandLogo'); if(logo){ if(state&&state.settings&&state.settings.logo){ logo.src=state.settings.logo; } else if(!logo.dataset.set){ logo.dataset.set='1'; logo.src='logo.png'; logo.onerror=()=>{logo.onerror=null;logo.src='logo.svg';}; } }
  const mb=el('menuBtn'); if(mb)mb.style.display=ui.authed?'':'none';
  if(!ui.authed){ el('whoBar').innerHTML=''; el('tabs').innerHTML=''; ui.menuOpen=false; applyMenu();
    const av=ui.authView||'wall';
    if(av==='login'){ stopBounce(); el('view').innerHTML=viewLogin(); }
    else if(av==='signup'){ stopBounce(); el('view').innerHTML=viewSignup(); }
    else if(av==='subscribe'){ stopBounce(); el('view').innerHTML=viewSubscribe(); }
    else if(av==='landing'){ el('view').innerHTML=viewLanding(); startBounce(); }
    else { stopBounce(); el('view').innerHTML=viewWall(); if(typeof wallLoadStats==='function')wallLoadStats(); if(typeof wallEnsureCustomer==='function')wallEnsureCustomer(); }
    const bn0=el('botnav'); if(bn0)bn0.style.display='none';
    afterRenderFocus(); updateImgChip(); return; }
  stopBounce();
  // first-time setup: walk new users through setting their email + own password
  if(me() && me().mustChange){
    el('whoBar').innerHTML='<button class="sm ghost" onclick="logout()">Log out</button>';
    el('tabs').innerHTML=''; document.body.classList.remove('menu-open');
    const bn1=el('botnav'); if(bn1)bn1.style.display='none';
    el('view').innerHTML=viewOnboard(); afterRenderFocus(); return;
  }
  el('whoBar').innerHTML=currentAvatarTag('sm')+'<span class="muted">'+esc(me().name)+'</span>'+
    '<select id="userSwitch" onchange="switchUserPrompt(this.value)">'+state.users.map(u=>'<option value="'+u.id+'"'+(u.id===state.currentUserId?' selected':'')+'>'+u.name+'</option>').join('')+'</select>'+
    '<button class="sm ghost" onclick="logout()">Log out</button>';
  const active=PARENT[ui.route]||ui.route;
  el('tabs').innerHTML='<div class="menu-brand"><b>HOUSE</b> OF CARDS</div>'+
    '<button class="menu-collapse" onclick="closeMenu()">‹ Collapse menu</button>'+
    TABS.map(([r,l])=>{ let label=l;
      if(r==='friends'&&typeof fui!=='undefined'&&fui.incoming&&fui.incoming.length) label+=' <span class="badge">'+fui.incoming.length+'</span>';
      return '<button class="'+(active===r?'active':'')+'" onclick="go(\''+r+'\')">'+label+'</button>'; }).join('');
  applyMenu();
  const bn=el('botnav'); if(bn){ bn.style.display='flex';
    bn.innerHTML=BOTNAV.map(([r,ic,l])=>{ let badge='';
      if(r==='friends'&&typeof fui!=='undefined'&&fui.incoming&&fui.incoming.length) badge='<span class="nbadge">'+fui.incoming.length+'</span>';
      return '<button class="'+(active===r?'on':'')+'" onclick="go(\''+r+'\')"><span class="ic">'+ic+badge+'</span>'+l+'</button>'; }).join(''); }
  el('view').innerHTML=(VIEWS[ui.route]||viewDashboard)();
  afterRenderFocus(); updateImgChip();
}
/* Collectr-style primary destinations (the ☰ menu still has everything) */
const BOTNAV=[['dashboard','🏠','Home'],['inventory','🃏','Cards'],['sell','🛒','Sell'],['friends','👥','Social'],['settings','⚙️','Profile']];
function afterRenderFocus(){ if(ui.focusId){ const f=el(ui.focusId); if(f){ f.focus(); try{const n=f.value.length;f.setSelectionRange(n,n);}catch(e){} } } }

/* -------- Landing page (huge bouncing logo + Login/Sign up) -------- */
function landingLogo(){
  if(cloudOn()) return cloudLogoUrl();                         // shared across devices (falls back via onerror if absent)
  if(state&&state.settings&&state.settings.logo) return state.settings.logo;  // local copy
  return 'logo.png';                                           // bundled fallback
}
const FEATURES=[
  ['📦','Inventory','Track every card with photos, condition, grade, set, language and cost — singles, sealed, anything.'],
  ['🏷️','Labels & barcodes','Auto-generate barcode IDs and print price labels for your showcase.'],
  ['🛒','Point of sale','Ring up sales fast with a cart, split payments (cash, Venmo, Cash App, PayPal, Square, Zelle) and instant receipts.'],
  ['🎪','Shows & cash-outs','Run live shows, track the cash float, log cash-outs per person and finalize with a full report.'],
  ['🔄','Trades','Log two-way trades; incoming cards drop straight into intake, outgoing come out of stock.'],
  ['⭐','Wish list','Keep a want-list so you know what to hunt for at the next show or break.'],
  ['📥','CSV import & pricing','Bulk-import inventory and re-price in seconds from a price CSV.'],
  ['📊','Reports','See profit by person, by show, and your sold history at a glance.'],
  ['👥','Shared team access','Everyone on your company shares the same data — and every change is signed by who made it.'],
  ['🕵️','Activity audit','A full, searchable log of who did what, so nothing ever gets lost.']];
function viewLanding(){
  return '<div class="landing">'+
    '<div class="landing-top">'+
      '<button class="gold" onclick="ui.authView=\'login\';render()">Login</button>'+
      '<button class="blue" onclick="ui.authView=\'signup\';render()">Sign up</button></div>'+
    '<div class="bounce-area" id="bounceArea"><img id="bounceLogo" class="bounce-logo" src="'+landingLogo()+'" onerror="this.onerror=null;this.src=\'logo.svg\'" alt="House of Cards"/></div>'+
    '<div class="landing-cap"><b>HOUSE</b> OF CARDS</div>'+
    '<div class="landing-tag">The all-in-one inventory, point-of-sale & show manager for trading-card sellers.</div>'+
    '<div class="landing-info">'+
      '<h3 class="landing-h">Everything you need to run your card business</h3>'+
      '<div class="features">'+FEATURES.map(f=>'<div class="feat"><div class="feat-ic">'+f[0]+'</div><div><div class="feat-t">'+f[1]+'</div><div class="feat-d">'+f[2]+'</div></div></div>').join('')+'</div>'+
      '<div class="landing-cta"><button class="blue lg" onclick="ui.authView=\'signup\';render()">Get started — sign up</button>'+
        '<button class="ghost lg" onclick="ui.authView=\'login\';render()">I already have an account</button></div>'+
    '</div>'+
  '</div>'; }

/* ============================== Public "wall" landing (card-show front page) ==============================
   Fancy, customer-facing page: social + payment QR codes and a "Join our text updates" capture.
   No login/sign-up shown. The owner reaches the real app by tapping the title 5×. */
const WALL_LINKS = {
  facebook:'https://m.facebook.com/profile.php?id=61587226816031&name=xhp_nt__fb__action__open_user',
  instagram:'houseofcards_850', tiktok:'houseofcards57',
  venmo:'https://venmo.com/code?user_id=2145411963813888862&created=1779586134',
  cashapp:'https://cash.app/$rgowan',
  paypal:'Taylorgowan845',
  collectr:[ {name:'Reggie', url:'https://app.getcollectr.com/showcase/profile/f60bc1b7-32a8-44e8-a3ed-4016dfb6d4f6'},
             {name:'Manny',  url:'https://app.getcollectr.com/showcase/profile/6a3e41fe-4604-4024-ba28-e005ef4ff3a6'},
             {name:'Hailey', url:'https://app.getcollectr.com/showcase/profile/2c06f053-9f8a-4883-8e45-6a38e97d027e'} ],
  contact:[ {name:'Reggie', phone:'7313639478'}, {name:'Manny', phone:'2567633389'}, {name:'Hailey', phone:'3213059361'} ],
  website:'', tagline:'Singles • Slabs • Sealed'
};
function wallCfg(){ return Object.assign({}, WALL_LINKS, (state.settings&&state.settings.wall)||{}); }
const _isUrl=s=>/^https?:\/\//i.test(s||'');
function venmoUrl(h){ return _isUrl(h)?h:'https://venmo.com/u/'+String(h).replace(/^@/,''); }
function cashUrl(h){ return _isUrl(h)?h:'https://cash.app/$'+String(h).replace(/^\$/,''); }
function paypalUrl(h){ return _isUrl(h)?h:'https://paypal.me/'+String(h).replace(/^@/,''); }
function igUrl(h){ return _isUrl(h)?h:'https://instagram.com/'+String(h).replace(/^@/,''); }
function ttUrl(h){ return _isUrl(h)?h:'https://www.tiktok.com/@'+String(h).replace(/^@/,''); }
function qrImg(data,size){ size=size||320; return '<img class="qr" loading="lazy" src="https://api.qrserver.com/v1/create-qr-code/?size='+size+'x'+size+'&margin=12&qzone=2&data='+encodeURIComponent(data)+'" alt="QR code"/>'; }
function viewWall(){
  const w=wallCfg();
  const j=s=>String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const tile=(label,inner,sub,onclick)=>'<div class="qrtile'+(onclick?' tap':'')+'"'+(onclick?(' onclick="'+onclick+'"'):'')+'>'+
    '<div class="qrlabel">'+label+'</div>'+inner+(sub?('<div class="qrsub">'+sub+'</div>'):'')+(onclick?'<div class="qrtap">Tap to open ↗</div>':'')+'</div>';
  const social=(label,url,sub)=>tile(label, url?qrImg(url):'<div class="qrmiss">link coming soon</div>', sub, url?("openUrl('"+j(url)+"')"):'');
  const pay=(label,url,photo,sub)=>tile(label, url?qrImg(url):(photo?('<img class="qr qrphoto" loading="lazy" src="'+photo+'"/>'):'<div class="qrmiss">coming soon</div>'), sub, url?("gateOpen('"+j(url)+"')"):'');
  const coll=c=>tile(esc(c.name)+'&rsquo;s cards', qrImg(c.url), 'Scan to view on Collectr', "gateOpen('"+j(c.url)+"')");
  const pageUrl=(location.href||'').split('#')[0];
  const contacts=(w.contact||[]).filter(c=>c&&c.phone);
  const staff=!!staffSession();
  const cust=wallCustomer;
  const cartBtn='<button class="custbtn" onclick="openCart()">🛒 Cart (<span id="cartCount">'+cartCount()+'</span>)</button>';
  const custBar = cloudOn() ? ('<div class="custbar">'+(cust
    ? '<span class="custhi">👤 '+esc(cust.name||cust.email||'Member')+'</span>'+cartBtn+'<button class="custbtn" onclick="openCustomerAccount()">My account</button><button class="custbtn" onclick="customerSignOut()">Sign out</button>'
    : '<span class="custhi muted">Customer portal</span>'+cartBtn+'<button class="custbtn gold" onclick="openCustomerLogin()">Sign in</button><button class="custbtn" onclick="openCustomerSignup()">Create account</button>'
  )+'</div>') : '';
  let active=ui.wallTab||'home'; if(active==='members'&&!staff) active='home';
  const TABS=[['home','🏠 Home'],['market','🛒 Marketplace'],['share','Share Us!!'],['social','Follow on Social'],['pay','Pay at Show'],['contact','Contact Us'],['reviews','Reviews'],['photos','Photos & Videos']];
  if(staff) TABS.push(['orders','📦 Orders'+(_newOrderCount?(' <span class="tabbadge">'+_newOrderCount+'</span>'):'')],['members','Members']);
  const tabbar='<div class="walltabs">'+TABS.map(t=>'<button class="walltab'+(t[0]===active?' on':'')+'" data-k="'+t[0]+'" onclick="setWallTab(\''+t[0]+'\')">'+t[1]+'</button>').join('')+'</div>';
  const panel=(k,inner)=>'<div class="wpanel" data-wtab="'+k+'"'+(k===active?'':' style="display:none"')+'>'+inner+'</div>';

  const homePanel=
    '<div class="wall-sec" onclick="mediaSecTap()">Follow Us On Our Journey</div>'+
    '<div id="wShowsAdmin"></div>'+
    '<div id="wShows" class="showlist"><div class="muted" style="text-align:center">Loading…</div></div>'+
    ((w.collectr&&w.collectr.filter(c=>c&&c.url).length)?(
      '<div class="wall-sec">Our Collection</div><div class="qrgrid">'+
      w.collectr.filter(c=>c&&c.url).map(coll).join('')+'</div>'
    ):'');
  const marketPanel=
    '<div class="wall-sec">Marketplace</div>'+
    '<div class="muted" style="text-align:center;margin:-6px 0 12px">Buy It Now — add to cart and check out. All sales final.</div>'+
    '<div id="wMarketAdmin"></div>'+
    '<div id="wMarketControls"></div>'+
    '<div id="wMarket" class="mktgrid"><div class="muted" style="text-align:center">Loading…</div></div>';
  const sharePanel=
    '<div class="wall-sec">Share our page</div><div class="qrgrid">'+
      '<div class="qrtile tap" onclick="sharePage()"><div class="qrlabel">Our Page</div>'+qrImg(pageUrl)+'<div class="qrsub">Scan it — or tap to share the link</div></div>'+
    '</div>';
  const socialPanel=
    '<div class="wall-sec">Follow on Social Media</div>'+
    '<div class="qrgrid">'+
      social('Facebook', w.facebook, 'Scan to follow')+
      social('Instagram', w.instagram?igUrl(w.instagram):'', w.instagram?('@'+String(w.instagram).replace(/^@/,'')):'')+
      social('TikTok', w.tiktok?ttUrl(w.tiktok):'', w.tiktok?('@'+String(w.tiktok).replace(/^@/,'')):'')+
    '</div>';
  const payPanel=
    '<div class="wall-sec">Pay at Show</div>'+
    '<div class="qrgrid">'+
      pay('Venmo', w.venmo?venmoUrl(w.venmo):'', '', w.venmo)+
      pay('Cash App', w.cashapp?cashUrl(w.cashapp):'', '', w.cashapp)+
      pay('PayPal', w.paypal?paypalUrl(w.paypal):'', 'assets/wall/paypal-photo.jpeg', w.paypal)+
    '</div>';
  const contactPanel=
    '<div class="wall-sec">Contact Us</div>'+
    (contacts.length?(
      '<div class="muted" style="text-align:center;margin:-6px 0 12px">Questions or requests? Text us:</div>'+
      '<div class="qrgrid">'+contacts.map(c=>{ const sms='sms:'+String(c.phone).replace(/[^\d+]/g,''); return tile('Text '+esc(c.name), qrImg(sms), 'Tap to text', "openUrl('"+sms+"')"); }).join('')+'</div>'
    ):'<div class="muted" style="text-align:center">Contact info coming soon.</div>');
  const reviewsPanel=
    '<div class="wall-sec">Reviews</div>'+
    '<div class="card revcard"><div id="wRevAvg" class="revavg">Loading reviews…</div>'+
      '<button class="wall-share" onclick="openReview()">★ Leave a review</button>'+
      '<div id="wRevList" class="revlist"></div></div>';
  const photosPanel=
    '<div class="wall-sec" onclick="mediaSecTap()">Show Photos &amp; Videos</div>'+
    '<div id="wMediaAdmin"></div>'+
    '<div id="wMedia" class="mediagrid"><div class="muted" style="text-align:center">Loading…</div></div>';
  const ordersPanel=
    '<div class="wall-sec">Orders</div>'+
    '<div class="muted" style="text-align:center;margin:-6px 0 12px">New orders land here — name, address, items, and payment status.</div>'+
    '<div id="wOrdersControls"></div>'+
    '<div id="wOrders"><div class="muted" style="text-align:center">Loading…</div></div>';
  const membersPanel=
    '<div class="wall-sec">Members</div>'+
    '<div class="muted" style="text-align:center;margin:-6px 0 12px">Everyone who joined the page — staff only.</div>'+
    '<div id="wMemberList"><div class="muted" style="text-align:center">Loading…</div></div>';

  return '<div class="wall">'+
    custBar+
    '<div class="wall-hero">'+
      '<img class="wall-logo" src="logo.png?v=2" onerror="this.onerror=null;this.src=\'logo.svg\'" alt="House of Cards"/>'+
      '<div class="wall-title" onclick="wallSecretTap()"><b>HOUSE</b> OF CARDS</div>'+
      '<div class="wall-tag">'+esc(w.tagline||'')+'</div>'+
      (cust
        ? '<button class="wall-cta" onclick="openCustomerAccount()">👋 Welcome back, '+esc((cust.name||'').split(' ')[0]||'friend')+'</button>'
        : '<button class="wall-cta" onclick="openCustomerSignup()">📲 Create your free account</button>')+
      '<div class="wall-cta-sub">First dibs on new singles &amp; show deals</div>'+
      '<div class="wall-stats"><span>👥 <b id="wMembers">—</b> members</span><span class="dot">•</span><span>👀 <b id="wVisits">—</b> visits</span></div>'+
    '</div>'+
    tabbar+
    '<div class="walltabwrap">'+
      panel('home',homePanel)+
      panel('market',marketPanel)+
      panel('share',sharePanel)+
      panel('social',socialPanel)+
      panel('pay',payPanel)+
      panel('contact',contactPanel)+
      panel('reviews',reviewsPanel)+
      panel('photos',photosPanel)+
      (staff?panel('orders',ordersPanel):'')+
      (staff?panel('members',membersPanel):'')+
    '</div>'+
    (w.website?('<div class="wall-foot">'+esc(w.website)+'</div>'):'')+
    (staff
      ? '<div class="wall-foot"><span style="color:var(--muted);font-size:11px">Staff: '+esc(staffSession().username)+' · </span><button class="staff-signin" onclick="openStaffAccount()">Account</button><button class="staff-signin" onclick="staffLogout()">Sign out</button></div>'
      : '<div class="wall-foot"><button class="staff-signin" onclick="openStaffLogin()">Staff</button></div>')+
  '</div>';
}
function setWallTab(key){ ui.wallTab=key;
  document.querySelectorAll('.walltab').forEach(b=>b.classList.toggle('on', b.dataset.k===key));
  document.querySelectorAll('.wpanel').forEach(p=>{ p.style.display=(p.dataset.wtab===key)?'':'none'; });
  if(key==='members') loadMembers();
  if(key==='orders') loadOrders();
  if(key==='market') loadMarket();
  try{ window.scrollTo({top:0,behavior:'smooth'}); }catch(e){ try{ window.scrollTo(0,0); }catch(_){} }
}
/* tap-to-open: pay & Collectr links capture name+phone the FIRST time on a device, then bypass; socials open directly */
function leadRegistered(){ try{ return !!localStorage.getItem('hoc_lead'); }catch(e){ return false; } }
function openUrl(url){ try{ window.open(url,'_blank','noopener'); }catch(e){ location.href=url; } }
function gateOpen(url){ if(leadRegistered()){ openUrl(url); return; } openLeadGate(url); }
function saveLead(name,phone){ saveTextSignup(name,phone); try{ localStorage.setItem('hoc_lead','1'); }catch(e){} cloudLead(name,phone); }
function cloudLead(name,phone){ const cfg=window.HOC_CONFIG||{}; const base=(cfg.SUPABASE_URL||'').replace(/\/$/,''); const key=cfg.SUPABASE_ANON_KEY||''; if(!base||!key)return;
  try{ fetch(base+'/rest/v1/leads',{method:'POST',headers:{'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify({name:name,phone:phone,created_at:new Date().toISOString()})}).catch(()=>{}); }catch(e){} }
function openLeadGate(url){
  const w=document.createElement('div'); w.className='scanmodal';
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="font-size:20px;color:var(--gold)">Quick intro first 👋</h3>'+
    '<div class="muted" style="margin-bottom:10px">Drop your name &amp; number once — then you\'re set and won\'t see this again on this phone.</div>'+
    '<label class="fld"><span>Your name</span><input id="lg_name" autocomplete="name" placeholder="First name"/></label>'+
    '<label class="fld"><span>Mobile number</span><input id="lg_phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 123-4567"/></label>'+
    '<div class="row" style="margin-top:10px"><button class="gold" id="lg_go" style="flex:1">Continue →</button><button class="ghost" id="lg_cancel">Cancel</button></div></div>';
  document.body.appendChild(w);
  const close=()=>w.remove();
  w.querySelector('#lg_cancel').onclick=close;
  w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.querySelector('#lg_go').onclick=()=>{ const name=(w.querySelector('#lg_name').value||'').trim(); const phone=(w.querySelector('#lg_phone').value||'').trim();
    if(phone.replace(/\D/g,'').length<10){ toast('Please enter a valid 10-digit mobile number.'); return; }
    saveLead(name,phone); close(); openUrl(url); };
  setTimeout(()=>{ const n=w.querySelector('#lg_name'); if(n)n.focus(); },60);
}
/* ---- Wall cloud bits (reviews + counters). All degrade gracefully if the tables aren't set up. ---- */
function sbBase(){ const c=window.HOC_CONFIG||{}; return {base:(c.SUPABASE_URL||'').replace(/\/$/,''), key:c.SUPABASE_ANON_KEY||''}; }
async function sbGet(path){ const {base,key}=sbBase(); if(!base||!key)return null; try{ const r=await fetch(base+'/rest/v1/'+path,{headers:{apikey:key,Authorization:'Bearer '+key}}); if(!r.ok)return null; return await r.json(); }catch(e){ return null; } }
async function sbRpc(fn,args){ const {base,key}=sbBase(); if(!base||!key)return null; try{ const r=await fetch(base+'/rest/v1/rpc/'+fn,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args||{})}); if(!r.ok)return null; return await r.json(); }catch(e){ return null; } }
async function sbInsert(table,obj){ const {base,key}=sbBase(); if(!base||!key)return false; try{ const r=await fetch(base+'/rest/v1/'+table,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(obj)}); return r.ok; }catch(e){ return false; } }
async function sbFn(name,body){ const {base,key}=sbBase(); if(!base||!key)return null; try{ const r=await fetch(base+'/functions/v1/'+name,{method:body?'POST':'GET',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}); return await r.json(); }catch(e){ return null; } }
function starStr(n){ n=Math.max(0,Math.min(5,n|0)); return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n); }
let _visitBumped=false, _wallVisits=null;
async function wallLoadStats(){
  const set=(id,t)=>{ const e=el(id); if(e)e.textContent=t; };
  if(!_visitBumped){ _visitBumped=true; const v=await sbRpc('bump_visits'); if(typeof v==='number')_wallVisits=v; }
  if(_wallVisits!=null) set('wVisits',_wallVisits);
  const m=await sbRpc('member_count'); if(typeof m==='number') set('wMembers',m);
  const rev=await sbGet('reviews?select=name,stars,comment,created_at&order=created_at.desc&limit=200');
  if(Array.isArray(rev)){ const n=rev.length; const avg=n?(rev.reduce((a,r)=>a+(+r.stars||0),0)/n):0;
    set('wRevAvg', n?(avg.toFixed(1)+' ★  ·  '+n+' review'+(n===1?'':'s')):'No reviews yet — be the first!');
    const list=el('wRevList'); if(list){ list.innerHTML=rev.slice(0,12).map(r=>'<div class="rev"><div class="revstars">'+starStr(r.stars)+'</div>'+(r.comment?('<div class="revtext">'+esc(r.comment)+'</div>'):'')+'<div class="revby">— '+(r.name?esc(r.name):'Anonymous')+'</div></div>').join(''); }
  } else { set('wRevAvg','Reviews open soon'); }
  loadShows();
  loadMedia();
  loadMarket();
  if(staffSession()){
    if(ui.wallTab==='members') loadMembers();
    if(ui.wallTab==='orders') loadOrders(); else checkNewOrders();
  }
}
/* ---- Follow Us On Our Journey: staff post shows (name/address/date/time); everyone sees them ---- */
function showCardWall(s){
  const date=s.event_date?new Date(s.event_date+'T00:00:00').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}):'';
  const when=[date,s.event_time].filter(Boolean).join(' · ');
  const addr=s.address?('<a class="showaddr" href="https://maps.google.com/?q='+encodeURIComponent(s.address)+'" target="_blank" rel="noopener">📍 '+esc(s.address)+'</a>'):'';
  const flyer=s.flyer_url?('<img class="showflyer" loading="lazy" src="'+esc(s.flyer_url)+'" onclick="openUrl(\''+esc(s.flyer_url)+'\')"/>'):'';
  const adminRow=isAdmin()?('<div class="row" style="gap:8px;margin-top:8px;justify-content:center">'+
    '<button class="sm ghost" onclick="showFlyer('+s.id+')">'+(s.flyer_url?'Edit flyer':'Add flyer')+'</button>'+
    '<button class="sm red" onclick="deleteShow('+s.id+')">Delete</button></div>'):'';
  return '<div class="showcard">'+flyer+'<div class="showname">'+esc(s.name)+'</div>'+(when?('<div class="showwhen">'+esc(when)+'</div>'):'')+addr+adminRow+'</div>';
}
function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
async function loadShows(){
  const adm=el('wShowsAdmin'); if(adm){ adm.innerHTML = isAdmin()
    ? '<div class="row" style="justify-content:center;margin-bottom:12px"><button class="gold" onclick="openAddShow()">＋ Add a show</button></div>' : ''; }
  if(staffSession()&&_staffPw){ sbRpc('show_purge_past',{p_user:staffSession().username,p_pass:_staffPw}); }  // purge past shows (staff only; display already filters to upcoming)
  const cont=el('wShows'); if(!cont)return;
  const s=await sbGet('shows?select=id,name,address,event_date,event_time,flyer_url&event_date=gte.'+todayStr()+'&order=event_date.asc&limit=50');
  if(!Array.isArray(s)){ cont.innerHTML='<div class="muted" style="text-align:center">Coming soon.</div>'; return; }
  if(!s.length){ cont.innerHTML='<div class="muted" style="text-align:center">No upcoming shows posted yet — check back soon!</div>'; return; }
  cont.innerHTML=s.map(showCardWall).join('');
}
function openAddShow(){ if(!staffSession()){ openStaffLogin(); return; }
  const w=document.createElement('div'); w.className='scanmodal';
  let flyer=null;  // {path,url} once a flyer image is uploaded
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="color:var(--gold)">Add a show</h3>'+
    '<label class="fld"><span>Show name</span><input id="sh_name" placeholder="e.g. Pensacola Card Show"/></label>'+
    '<label class="fld"><span>Address</span><input id="sh_addr" placeholder="123 Main St, City, ST"/></label>'+
    '<div class="grid2"><label class="fld" style="margin:0"><span>Date</span><input id="sh_date" type="date"/></label>'+
    '<label class="fld" style="margin:0"><span>Time</span><input id="sh_time" type="text" placeholder="10am–4pm"/></label></div>'+
    '<label class="fld"><span>Flyer image (optional)</span><div class="row" style="gap:8px"><button class="ghost" id="sh_flyer" style="flex:1">📷 Upload flyer</button></div></label>'+
    '<div id="sh_flyerprev"></div>'+
    '<div class="row" style="margin-top:10px"><button class="gold" id="sh_go" style="flex:1">Add show</button><button class="ghost" id="sh_x">Cancel</button></div></div>';
  document.body.appendChild(w); const close=()=>w.remove(); w.querySelector('#sh_x').onclick=close; w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.querySelector('#sh_flyer').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
    inp.onchange=async()=>{ const f=inp.files[0]; if(!f)return; toast('Uploading flyer…'); const up=await uploadMedia(f); if(!up)return; flyer=up;
      const pv=w.querySelector('#sh_flyerprev'); if(pv)pv.innerHTML='<img class="showflyer" src="'+esc(up.url)+'"/>'; w.querySelector('#sh_flyer').textContent='✓ Flyer ready — tap to replace'; };
    inp.click(); };
  w.querySelector('#sh_go').onclick=async()=>{ const name=(w.querySelector('#sh_name').value||'').trim(); if(!name){ toast('Enter a show name.'); return; }
    const date=w.querySelector('#sh_date').value; if(!date){ toast('Please pick a show date (it auto-removes the day after).'); return; }
    const addr=(w.querySelector('#sh_addr').value||'').trim(); const time=(w.querySelector('#sh_time').value||'').trim()||null;
    const id=await staffDo('show_add',{p_name:name,p_address:addr,p_date:date,p_time:time,p_flyer:flyer?flyer.url:null},'Show added.');
    if(id){ close(); loadShows(); } };
  setTimeout(()=>{ const n=w.querySelector('#sh_name'); if(n)n.focus(); },60);
}
async function showFlyer(id){ if(!staffSession()){ openStaffLogin(); return; }
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=async()=>{ const f=inp.files[0]; if(!f)return; toast('Uploading flyer…'); const up=await uploadMedia(f); if(!up)return;
    const ok=await staffDo('show_set_flyer',{p_id:id,p_flyer:up.url},'Flyer saved.'); if(ok)loadShows(); };
  inp.click();
}
async function deleteShow(id){ if(!isAdmin())return; if(!confirm('Remove this show?'))return;
  const ok=await staffDo('show_delete',{p_id:id}); if(ok)loadShows(); }
function openReview(){
  let chosen=5;
  const w=document.createElement('div'); w.className='scanmodal';
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="color:var(--gold)">Leave a review</h3>'+
    '<div id="rvStars" class="rvstars">'+[1,2,3,4,5].map(i=>'<span data-v="'+i+'">★</span>').join('')+'</div>'+
    '<label class="fld"><span>Comment (optional)</span><textarea id="rv_c" rows="3" placeholder="How was your experience?"></textarea></label>'+
    '<label class="fld"><span>Name (optional — leave blank to stay anonymous)</span><input id="rv_n" autocomplete="name"/></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="rv_go" style="flex:1">Submit review</button><button class="ghost" id="rv_x">Cancel</button></div></div>';
  document.body.appendChild(w);
  const paint=()=>w.querySelectorAll('#rvStars span').forEach(s=>s.classList.toggle('on',(+s.dataset.v)<=chosen));
  w.querySelectorAll('#rvStars span').forEach(s=>s.onclick=()=>{ chosen=+s.dataset.v; paint(); }); paint();
  const close=()=>w.remove();
  w.querySelector('#rv_x').onclick=close;
  w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.querySelector('#rv_go').onclick=async()=>{ const name=(w.querySelector('#rv_n').value||'').trim(); const comment=(w.querySelector('#rv_c').value||'').trim();
    const ok=await sbInsert('reviews',{name:name||null,stars:chosen,comment:comment||null});
    if(!ok){ toast('Couldn\'t submit — reviews aren\'t enabled yet.'); return; }
    close(); toast('Thanks for the review! ⭐'); wallLoadStats();
  };
  setTimeout(()=>{ const c=w.querySelector('#rv_c'); if(c)c.focus(); },60);
}
/* ---- Show photo/video gallery (admin = the 5 staff phones; everyone can view/like/comment) ---- */
const ADMIN_PHONES=['7313639478','7313639465','3213059361','2567633389','8505438759'];
function myName(){ try{ const a=JSON.parse(localStorage.getItem('hoc_textSignups')||'[]'); const l=a[a.length-1]; return (l&&l.name)||''; }catch(e){ return ''; } }
function savedName(){ let n=''; try{ n=localStorage.getItem('hoc_name')||''; }catch(e){} return n||myName()||''; }
function rememberName(n){ n=(n||'').trim(); if(n){ try{ localStorage.setItem('hoc_name',n); }catch(e){} } }
function myPhone(){ try{ const a=JSON.parse(localStorage.getItem('hoc_textSignups')||'[]'); const l=a[a.length-1]; return (l&&l.phone)||''; }catch(e){ return ''; } }
function staffSession(){ try{ return JSON.parse(localStorage.getItem('hoc_staff')||'null'); }catch(e){ return null; } }
function setStaffSession(o){ try{ if(o)localStorage.setItem('hoc_staff',JSON.stringify(o)); else localStorage.removeItem('hoc_staff'); }catch(e){} }
let _staffPw=null;  // in-memory only: the signed-in staff member's password hash, so admin actions don't re-prompt each time
function staffLogout(){ setStaffSession(null); _staffPw=null; ui.wallTab='home'; toast('Signed out.'); render(); }
// Run a staff-only write RPC (add/delete shows, flyers, media, comments). Requires a real
// staff sign-in; confirms the password once per session, then caches it in memory.
async function staffDo(fn,args,okMsg){
  const s=staffSession(); if(!s){ toast('Please sign in as staff to do that.'); openStaffLogin(); return null; }
  if(!_staffPw){ const p=prompt('Confirm your staff password:'); if(p===null||p==='')return null; _staffPw=hashPass(p); }
  const res=await sbRpc(fn,Object.assign({p_user:s.username,p_pass:_staffPw},args||{}));
  if(res===null||res===false){ _staffPw=null; toast('Couldn’t verify your staff password — try again.'); return null; }
  if(okMsg)toast(okMsg);
  return res;
}
async function loadMembers(){
  const cont=el('wMemberList'); if(!cont)return;
  const s=staffSession(); if(!s){ cont.innerHTML='<div class="muted" style="text-align:center">Staff only.</div>'; return; }
  if(!_staffPw){ const p=prompt('Confirm your staff password to view members:'); if(!p){ cont.innerHTML='<div class="muted" style="text-align:center">Enter your password to view members. <button class="sm ghost" onclick="loadMembers()">Try again</button></div>'; return; } _staffPw=hashPass(p); }
  cont.innerHTML='<div class="muted" style="text-align:center">Loading…</div>';
  const res=await sbRpc('staff_members',{p_user:s.username,p_pass:_staffPw});
  if(!res||res.ok!==true){ _staffPw=null; cont.innerHTML='<div class="muted" style="text-align:center">Couldn\'t verify your password. <button class="sm ghost" onclick="loadMembers()">Try again</button></div>'; return; }
  const m=res.members||[];
  if(!m.length){ cont.innerHTML='<div class="muted" style="text-align:center">No members have joined yet.</div>'; return; }
  const accts=m.filter(x=>x.kind==='account').length;
  cont.innerHTML='<div class="memcount">'+m.length+' member'+(m.length===1?'':'s')+' · '+accts+' with account'+(accts===1?'':'s')+'</div>'+m.map(x=>{
    const ph=String(x.phone||'').replace(/[^\d+]/g,''); const d=x.created_at?new Date(x.created_at).toLocaleDateString():'';
    const badge=x.kind==='account'?'<span class="membadge acct">account</span>':'<span class="membadge">contact</span>';
    const idJs=JSON.stringify(String(x.id)); const nmJs=JSON.stringify(x.name||x.phone||'this member');
    return '<div class="memrow"><div class="memmain"><div class="memname">'+esc(x.name||'(no name)')+' '+badge+'</div>'+
      (x.email?('<div class="mememail">'+esc(x.email)+'</div>'):'')+'</div>'+
      (ph?('<a class="memphone" href="tel:'+ph+'">'+esc(x.phone)+'</a>'):'<span class="memphone">—</span>')+
      '<div class="memdate">'+esc(d)+'</div>'+
      '<button class="memdel" title="Remove" onclick=\'removeMember("'+esc(x.kind)+'",'+idJs+','+nmJs+')\'>✕</button></div>'; }).join('');
}
async function removeMember(kind,id,name){
  if(!staffSession()){ openStaffLogin(); return; }
  if(!confirm('Remove '+(name||'this member')+'? This deletes their '+(kind==='account'?'account':'contact')+'.')) return;
  const ok=await staffDo('staff_member_delete',{p_kind:kind,p_id:String(id)});
  if(ok){ toast('Removed.'); loadMembers(); }
}
/* ---- Customer accounts (marketplace): Supabase Auth + customers table (one phone per account) ---- */
let wallCustomer=null;       // signed-in customer's profile {id,name,email,phone} or null
let _wallCustInit=false;
async function ensureCustomerRow(u){
  if(!u) return null;
  try{ const {data:row}=await sb.from('customers').select('id,name,email,phone').eq('id',u.id).maybeSingle();
    if(row) return row;
    const md=u.user_metadata||{};   // back-fill from signup metadata (covers the email-confirm-on flow)
    const {data:ins}=await sb.from('customers').insert({id:u.id,name:md.name||'',email:u.email||'',phone:md.phone||null}).select('id,name,email,phone').maybeSingle();
    return ins||{id:u.id,email:u.email||'',name:md.name||'',phone:md.phone||''};
  }catch(e){ return {id:u.id,email:u.email||'',name:'',phone:''}; }
}
async function loadWallCustomer(){
  if(!cloudOn()){ wallCustomer=null; return; }
  try{ const {data}=await sb.auth.getSession();
    if(data&&data.session){ wallCustomer=await ensureCustomerRow(data.session.user); }
    else wallCustomer=null;
  }catch(e){ wallCustomer=null; }
}
function wallEnsureCustomer(){ if(_wallCustInit||!cloudOn())return; _wallCustInit=true; loadWallCustomer().then(()=>{ if(wallCustomer)render(); }).catch(()=>{}); }
async function customerSignUp(name,email,phone,pass){
  if(!cloudOn()) return {error:'Accounts are offline right now.'};
  const free=await sbRpc('phone_available',{p_phone:phone});
  if(free===false) return {error:'That phone number already has an account.'};
  const {data,error}=await sb.auth.signUp({email,password:pass,options:{data:{name:name,phone:phone}}});
  if(error) return {error:error.message};
  if(!data.session) return {ok:true,needsConfirm:true};
  const ins=await sb.from('customers').insert({id:data.user.id,name:name,email:email,phone:phone});
  if(ins.error) return {error:/duplicate|unique/i.test(ins.error.message)?'That phone number already has an account.':ins.error.message};
  wallCustomer={id:data.user.id,name:name,email:email,phone:phone};
  return {ok:true};
}
async function customerSignIn(email,pass){
  if(!cloudOn()) return {error:'Accounts are offline right now.'};
  const {data,error}=await sb.auth.signInWithPassword({email,password:pass});
  if(error) return {error:/confirm/i.test(error.message)?'Please confirm your email first, then sign in.':error.message};
  await loadWallCustomer();
  if(wallCustomer&&!wallCustomer.name){ /* legacy/edge: profile row missing — leave as-is for now */ }
  return {ok:true};
}
async function customerSignOut(){ try{ await sb.auth.signOut(); }catch(e){} wallCustomer=null; toast('Signed out.'); render(); }
function openCustomerSignup(){
  if(!cloudOn()){ toast('Accounts are offline right now.'); return; }
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="color:var(--gold)">Create your account</h3>'+
    '<div class="muted" style="margin-bottom:8px">One account per phone number. Use it to buy and track orders.</div>'+
    '<label class="fld"><span>Full name</span><input id="cu_n" autocomplete="name"/></label>'+
    '<label class="fld"><span>Email</span><input id="cu_e" type="email" autocomplete="email" autocapitalize="off"/></label>'+
    '<label class="fld"><span>Mobile phone</span><input id="cu_ph" type="tel" inputmode="tel" autocomplete="tel"/></label>'+
    '<label class="fld"><span>Password</span><input id="cu_p" type="password" autocomplete="new-password"/></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="cu_go" style="flex:1">Create account</button><button class="ghost" id="cu_x">Close</button></div>'+
    '<div style="text-align:center;margin-top:10px"><button class="btn-link" id="cu_have">Already have an account? Sign in</button></div></div>';
  w.querySelector('#cu_x').onclick=close;
  w.querySelector('#cu_have').onclick=()=>{ close(); openCustomerLogin(); };
  w.querySelector('#cu_go').onclick=async()=>{
    const name=(w.querySelector('#cu_n').value||'').trim(); const email=(w.querySelector('#cu_e').value||'').trim();
    const phone=(w.querySelector('#cu_ph').value||'').trim(); const pass=w.querySelector('#cu_p').value||'';
    if(!name){ toast('Enter your name.'); return; }
    if(!/^\S+@\S+\.\S+$/.test(email)){ toast('Enter a valid email.'); return; }
    if(phone.replace(/\D/g,'').length<10){ toast('Enter a valid 10-digit phone.'); return; }
    if(pass.length<6){ toast('Password must be at least 6 characters.'); return; }
    const r=await customerSignUp(name,email,phone,pass);
    if(r.error){ toast(r.error); return; }
    if(r.needsConfirm){ close(); toast('Check your email to confirm, then sign in.'); return; }
    close(); toast('Welcome, '+name+'!'); render();
  };
  setTimeout(()=>{ const n=w.querySelector('#cu_n'); if(n)n.focus(); },60);
}
function openCustomerLogin(){
  if(!cloudOn()){ toast('Accounts are offline right now.'); return; }
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.innerHTML='<div class="card" style="max-width:400px;width:100%"><h3 style="color:var(--gold)">Sign in</h3>'+
    '<label class="fld"><span>Email</span><input id="ci_e" type="email" autocomplete="email" autocapitalize="off"/></label>'+
    '<label class="fld"><span>Password</span><input id="ci_p" type="password" autocomplete="current-password"/></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="ci_go" style="flex:1">Sign in</button><button class="ghost" id="ci_x">Close</button></div>'+
    '<div style="text-align:center;margin-top:10px"><button class="btn-link" id="ci_new">New here? Create an account</button></div></div>';
  w.querySelector('#ci_x').onclick=close;
  w.querySelector('#ci_new').onclick=()=>{ close(); openCustomerSignup(); };
  w.querySelector('#ci_go').onclick=async()=>{
    const email=(w.querySelector('#ci_e').value||'').trim(); const pass=w.querySelector('#ci_p').value||'';
    if(!email||!pass){ toast('Enter your email and password.'); return; }
    const r=await customerSignIn(email,pass);
    if(r.error){ toast(r.error); return; }
    close(); toast('Welcome back'+(wallCustomer&&wallCustomer.name?', '+wallCustomer.name.split(' ')[0]:'')+'!'); render();
  };
  setTimeout(()=>{ const e=w.querySelector('#ci_e'); if(e)e.focus(); },60);
}
function openCustomerAccount(){
  const c=wallCustomer; if(!c){ openCustomerLogin(); return; }
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.innerHTML='<div class="card" style="max-width:420px;width:100%;max-height:90vh;overflow:auto"><h3 style="color:var(--gold)">Your account</h3>'+
    '<div class="memrow"><div class="memmain"><div class="memname">'+esc(c.name||'(no name)')+'</div>'+(c.email?('<div class="mememail">'+esc(c.email)+'</div>'):'')+'</div></div>'+
    (c.phone?('<div class="muted" style="margin:8px 2px">📱 '+esc(c.phone)+'</div>'):'')+
    '<div class="row" style="margin:8px 0"><button class="ghost" id="cu_notif" style="flex:1">🔔 Enable order notifications</button></div>'+
    '<hr class="sep"><div class="muted" style="margin-bottom:6px">My orders</div><div id="ca_orders"><div class="muted">Loading…</div></div>'+
    '<div class="row" style="margin-top:10px"><button class="ghost" id="ca_out" style="flex:1">Sign out</button><button class="gold" id="ca_x">Close</button></div></div>';
  w.querySelector('#ca_x').onclick=close;
  w.querySelector('#cu_notif').onclick=()=>enableNotifications('customer');
  w.querySelector('#ca_out').onclick=()=>{ close(); customerSignOut(); };
  loadMyOrders(w.querySelector('#ca_orders'));
}
async function loadMyOrders(cont){
  if(!cont||!cloudOn())return;
  try{ const { data, error } = await sb.from('orders').select('id,status,fulfillment,total_cents,created_at,tracking_number,pickup_slot,order_items(listing_id,title,price_cents)').order('created_at',{ascending:false}).limit(50);
    if(error||!data||!data.length){ cont.innerHTML='<div class="muted">No orders yet.</div>'; return; }
    cont.innerHTML=data.map(o=>{ const items=(o.order_items||[]).map(i=>'<button class="lnkitem" onclick="openPurchasedListing('+(i.listing_id||0)+')">'+esc(i.title)+'</button>').join('');
      const extra=o.tracking_number?(' · Tracking: '+esc(o.tracking_number)):(o.pickup_slot?(' · Pickup: '+esc(o.pickup_slot)):'');
      return '<div class="ordcard"><div class="ordhead"><b>Order #'+o.id+'</b><span class="ordstatus s_'+esc(o.status)+'">'+esc(o.status)+'</span></div>'+
        '<div class="muted">'+new Date(o.created_at).toLocaleDateString()+' · '+mUSD(o.total_cents)+' · '+esc(o.fulfillment)+extra+'</div>'+
        (items?('<div class="lnkitems">'+items+'</div>'):'')+'</div>'; }).join('');
  }catch(e){ cont.innerHTML='<div class="muted">Could not load orders.</div>'; }
}
/* ============================== Marketplace (Phase 2: listings + browse + cart) ============================== */
const LISTING_CONDITIONS=['Sealed','Graded','Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged','New','Used'];
let _mktItems=[]; let _mktSub='active', _mktSort='new', _mktSearch='';
function mUSD(c){ return '$'+(((+c||0)/100).toFixed(2)); }
function listingPayload(it,ov){ return Object.assign({
  title:it.title||'', description:it.description||'', condition:it.condition||'',
  price_cents:it.price_cents||0, qty:(it.qty!=null?it.qty:1), photos:it.photos||[],
  local_pickup:!!it.local_pickup, shipping_offered:!!it.shipping_offered,
  shipping_cents:it.shipping_cents||0, status:it.status||'active' }, ov||{}); }
async function loadMarket(){
  const cont=el('wMarket'); if(!cont)return;
  const adm=el('wMarketAdmin'); if(adm) adm.innerHTML = staffSession()
    ? '<div class="row" style="justify-content:center;margin-bottom:14px"><button class="gold" onclick="openListingEdit()">＋ Add listing</button></div>' : '';
  let items=null;
  if(staffSession()&&_staffPw){ const r=await sbRpc('staff_listings',{p_user:staffSession().username,p_pass:_staffPw}); if(r&&r.ok)items=r.listings; }
  if(!items){ const r=await sbGet('listings?select=id,title,description,condition,price_cents,qty,photos,local_pickup,shipping_offered,shipping_cents,status&status=neq.hidden&order=created_at.desc&limit=200'); items=Array.isArray(r)?r:[]; }
  _mktItems=items;
  drawMarketControls();
  renderMarketGrid();
}
function drawMarketControls(){
  const c=el('wMarketControls'); if(!c)return;
  const subs=[['active','Active'],['sold','Sold']]; if(staffSession())subs.push(['hidden','Hidden']);
  c.innerHTML='<div class="mktbar"><input id="mktSearch" class="mktsearch" placeholder="Search cards…" value="'+esc(_mktSearch)+'"/>'+
    '<select id="mktSort" class="mktsort">'+['new:Newest','plow:Price ↑','phigh:Price ↓','name:Name A–Z'].map(o=>{const p=o.split(':');return '<option value="'+p[0]+'"'+(_mktSort===p[0]?' selected':'')+'>'+p[1]+'</option>';}).join('')+'</select></div>'+
    '<div class="mktsubs">'+subs.map(s=>'<button class="mktsub'+(_mktSub===s[0]?' on':'')+'" onclick="setMktSub(\''+s[0]+'\')">'+s[1]+'</button>').join('')+'</div>';
  const si=el('mktSearch'); if(si)si.oninput=()=>{ _mktSearch=si.value; renderMarketGrid(); };
  const so=el('mktSort'); if(so)so.onchange=()=>{ _mktSort=so.value; renderMarketGrid(); };
}
function setMktSub(s){ _mktSub=s; drawMarketControls(); renderMarketGrid(); }
function renderMarketGrid(){
  const cont=el('wMarket'); if(!cont)return;
  let items=(_mktItems||[]).slice();
  if(_mktSub==='sold') items=items.filter(x=>x.status==='sold');
  else if(_mktSub==='hidden') items=items.filter(x=>x.status==='hidden');
  else items=items.filter(x=>x.status!=='sold'&&x.status!=='hidden');
  const q=_mktSearch.trim().toLowerCase();
  if(q) items=items.filter(x=>(((x.title||'')+' '+(x.description||'')+' '+(x.condition||'')).toLowerCase().indexOf(q)>=0));
  items.sort((a,b)=>{ if(_mktSort==='plow')return (a.price_cents||0)-(b.price_cents||0); if(_mktSort==='phigh')return (b.price_cents||0)-(a.price_cents||0); if(_mktSort==='name')return String(a.title||'').localeCompare(String(b.title||'')); return (b.id||0)-(a.id||0); });
  if(!items.length){ cont.innerHTML='<div class="muted" style="text-align:center">No '+(_mktSub==='sold'?'sold items':(_mktSub==='hidden'?'hidden items':'items'))+(q?' match your search':(staffSession()&&_mktSub==='active'?' yet — tap “Add listing”.':'.'))+'</div>'; return; }
  cont.innerHTML=items.map(mktCard).join('');
}
function mktCard(it){
  const ph=(it.photos&&it.photos.length)?it.photos[0]:'';
  const sold=it.status==='sold'||(it.qty!=null&&it.qty<=0); const hidden=it.status==='hidden';
  const img=ph?('<img class="mktimg" loading="lazy" src="'+esc(ph)+'"/>'):'<div class="mktimg mktnoimg">No photo</div>';
  const tags=[]; if(it.local_pickup)tags.push('Pickup'); if(it.shipping_offered)tags.push('Ships'+(it.shipping_cents?(' '+mUSD(it.shipping_cents)):''));
  const badge=sold?'<div class="mktflag sold">SOLD</div>':(hidden?'<div class="mktflag hid">HIDDEN</div>':'');
  const buy=(!sold&&!hidden)?('<button class="sm gold" onclick="event.stopPropagation();addToCart('+it.id+')">Add to cart</button>'):'';
  const staffCtl=staffSession()?('<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">'+
    '<button class="sm ghost" onclick="event.stopPropagation();openListingEdit('+it.id+')">Edit</button>'+
    '<button class="sm ghost" onclick="event.stopPropagation();toggleListingHidden('+it.id+')">'+(hidden?'Unhide':'Hide')+'</button>'+
    '<button class="sm ghost" onclick="event.stopPropagation();markListingSold('+it.id+')">'+(sold?'Relist':'Mark sold')+'</button>'+
    '<button class="sm red" onclick="event.stopPropagation();deleteListing('+it.id+')">Delete</button></div>'):'';
  return '<div class="mktcard" onclick="openListing('+it.id+')">'+badge+img+
    '<div class="mkttitle">'+esc(it.title)+'</div>'+
    '<div class="mktprice">'+mUSD(it.price_cents)+'</div>'+
    (it.condition?('<div class="mktcond">'+esc(it.condition)+'</div>'):'')+
    (tags.length?('<div class="mkttags">'+tags.map(t=>'<span class="mkttag">'+esc(t)+'</span>').join('')+'</div>'):'')+
    (buy?('<div style="margin-top:8px">'+buy+'</div>'):'')+staffCtl+'</div>';
}
function openListing(id){ const it=(_mktItems||[]).find(x=>x.id===id); if(it)showListingDetail(it,{buyable:true}); }
async function openPurchasedListing(id){
  if(!id){ toast('Listing details are no longer available.'); return; }
  const r=await sbGet('listings?select=id,title,description,condition,price_cents,qty,photos,local_pickup,shipping_offered,shipping_cents,status&id=eq.'+id+'&limit=1');
  if(Array.isArray(r)&&r.length) showListingDetail(r[0],{buyable:false});
  else toast('This listing is no longer available.');
}
function showListingDetail(it,opts){
  opts=opts||{};
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  const sold=it.status==='sold'||(it.qty!=null&&it.qty<=0);
  const gallery=(it.photos&&it.photos.length)?it.photos.map(p=>'<img class="mktdetimg" loading="lazy" src="'+esc(p)+'"/>').join(''):'<div class="mktimg mktnoimg" style="max-width:none">No photo</div>';
  const ship=it.shipping_offered?('Ships'+(it.shipping_cents?(' for '+mUSD(it.shipping_cents)):'')+(it.local_pickup?' · or local pickup':'')):(it.local_pickup?'Local pickup only':'');
  const action=(opts.buyable&&!sold)
    ? '<button class="gold" id="md_add" style="flex:1">Add to cart</button>'
    : '<button class="ghost" style="flex:1" disabled>'+(sold?'Sold':'Not for sale')+'</button>';
  w.innerHTML='<div class="card" style="max-width:460px;width:100%;max-height:90vh;overflow:auto"><div class="mktdetgal">'+gallery+'</div>'+
    '<h3 style="color:var(--gold);margin:10px 0 2px">'+esc(it.title)+'</h3>'+
    '<div class="mktprice" style="font-size:22px">'+mUSD(it.price_cents)+'</div>'+
    (it.condition?('<div class="mktcond">Condition: '+esc(it.condition)+'</div>'):'')+
    (ship?('<div class="muted" style="margin:6px 0">'+esc(ship)+'</div>'):'')+
    (it.description?('<div style="margin:8px 0;white-space:pre-wrap">'+esc(it.description)+'</div>'):'')+
    '<div class="row" style="margin-top:10px">'+action+'<button class="ghost" id="md_x">Close</button></div></div>';
  w.querySelector('#md_x').onclick=close;
  const add=w.querySelector('#md_add'); if(add)add.onclick=()=>{ addToCart(it.id); close(); };
}
async function openListingEdit(id){
  if(!staffSession()){ openStaffLogin(); return; }
  const it=(id!=null)?(_mktItems||[]).find(x=>x.id===id):null;
  let photos=(it&&Array.isArray(it.photos))?it.photos.slice():[];
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  const condOpts=LISTING_CONDITIONS.map(c=>'<option'+((it&&it.condition===c)?' selected':'')+'>'+c+'</option>').join('');
  function drawPhotos(){ const d=w.querySelector('#lp_thumbs'); if(!d)return; d.innerHTML=photos.length?photos.map((p,i)=>'<span class="lpthumb"><img src="'+esc(p)+'"/><button type="button" data-i="'+i+'" class="lpdel">✕</button></span>').join(''):'<span class="muted">No photos yet</span>';
    d.querySelectorAll('.lpdel').forEach(b=>b.onclick=()=>{ photos.splice(+b.dataset.i,1); drawPhotos(); }); }
  w.innerHTML='<div class="card" style="max-width:460px;width:100%;max-height:90vh;overflow:auto"><h3 style="color:var(--gold)">'+(it?'Edit listing':'Add listing')+'</h3>'+
    '<label class="fld"><span>Title</span><input id="lp_title" value="'+esc(it?it.title:'')+'" placeholder="e.g. Charizard PSA 10"/></label>'+
    '<label class="fld"><span>Description</span><textarea id="lp_desc" rows="3">'+esc(it?(it.description||''):'')+'</textarea></label>'+
    '<div class="grid2"><label class="fld" style="margin:0"><span>Price (USD)</span><input id="lp_price" type="number" step="0.01" inputmode="decimal" value="'+(it?((it.price_cents||0)/100):'')+'"/></label>'+
    '<label class="fld" style="margin:0"><span>Condition</span><select id="lp_cond">'+condOpts+'</select></label></div>'+
    '<div class="grid2"><label class="fld" style="margin:0"><span>Quantity</span><input id="lp_qty" type="number" inputmode="numeric" value="'+(it&&it.qty!=null?it.qty:1)+'"/></label>'+
    '<label class="fld" style="margin:0"><span>Shipping cost (USD)</span><input id="lp_ship" type="number" step="0.01" inputmode="decimal" value="'+(it?((it.shipping_cents||0)/100):'')+'"/></label></div>'+
    '<label class="chkrow"><input type="checkbox" id="lp_pickup"'+((!it||it.local_pickup)?' checked':'')+'/> <span>Local pickup available</span></label>'+
    '<label class="chkrow"><input type="checkbox" id="lp_shipoff"'+((it&&it.shipping_offered)?' checked':'')+'/> <span>Offer shipping (uses the cost above)</span></label>'+
    '<div class="fld"><span>Photos</span><div id="lp_thumbs" class="lpthumbs"></div><button class="ghost" id="lp_addphoto" style="margin-top:6px">📷 Add photo</button></div>'+
    '<div class="row" style="margin-top:10px"><button class="gold" id="lp_save" style="flex:1">Save listing</button><button class="ghost" id="lp_x">Cancel</button></div></div>';
  w.querySelector('#lp_x').onclick=close; drawPhotos();
  w.querySelector('#lp_addphoto').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
    inp.onchange=async()=>{ const f=inp.files[0]; if(!f)return; toast('Uploading…'); const up=await uploadMedia(f); if(!up)return; photos.push(up.url); drawPhotos(); };
    inp.click(); };
  w.querySelector('#lp_save').onclick=async()=>{
    const title=(w.querySelector('#lp_title').value||'').trim(); if(!title){ toast('Enter a title.'); return; }
    const price_cents=Math.round((parseFloat(w.querySelector('#lp_price').value)||0)*100);
    const ship_cents=Math.round((parseFloat(w.querySelector('#lp_ship').value)||0)*100);
    const qty=Math.max(0,parseInt(w.querySelector('#lp_qty').value,10)||1);
    const data={title:title, description:(w.querySelector('#lp_desc').value||'').trim(), condition:w.querySelector('#lp_cond').value,
      price_cents:price_cents, qty:qty, photos:photos,
      local_pickup:w.querySelector('#lp_pickup').checked, shipping_offered:w.querySelector('#lp_shipoff').checked,
      shipping_cents:ship_cents, status:(it?it.status:'active')};
    const r=await staffDo('listing_save',{p_id:(id!=null?id:null),p_data:data},'Listing saved.');
    if(r){ close(); loadMarket(); }
  };
  setTimeout(()=>{ const t=w.querySelector('#lp_title'); if(t)t.focus(); },60);
}
async function deleteListing(id){ if(!staffSession()){ openStaffLogin(); return; } if(!confirm('Delete this listing?'))return;
  const ok=await staffDo('listing_delete',{p_id:id},'Listing deleted.'); if(ok)loadMarket(); }
async function toggleListingHidden(id){ const it=(_mktItems||[]).find(x=>x.id===id); if(!it)return;
  const next=it.status==='hidden'?'active':'hidden';
  const r=await staffDo('listing_save',{p_id:id,p_data:listingPayload(it,{status:next})}); if(r)loadMarket(); }
async function markListingSold(id){ const it=(_mktItems||[]).find(x=>x.id===id); if(!it)return;
  const next=(it.status==='sold')?'active':'sold';
  const r=await staffDo('listing_save',{p_id:id,p_data:listingPayload(it,{status:next})}); if(r)loadMarket(); }
/* ---- Cart (local; secure checkout arrives in Phase 3 with Square) ---- */
function cartGet(){ try{ return JSON.parse(localStorage.getItem('hoc_cart')||'[]'); }catch(e){ return []; } }
function cartSet(a){ try{ localStorage.setItem('hoc_cart',JSON.stringify(a)); }catch(e){} const c=el('cartCount'); if(c)c.textContent=a.length; }
function cartCount(){ return cartGet().length; }
function addToCart(id){
  const it=(_mktItems||[]).find(x=>x.id===id); if(!it){ toast('Item not found.'); return; }
  if(it.status!=='active'){ toast('That item isn’t available.'); return; }
  const cart=cartGet(); if(cart.some(x=>x.id===id)){ toast('Already in your cart.'); return; }
  cart.push({id:it.id,title:it.title,price_cents:it.price_cents,shipping_cents:it.shipping_cents,shipping_offered:it.shipping_offered,local_pickup:it.local_pickup,photo:(it.photos&&it.photos[0])||''});
  cartSet(cart); toast('Added to cart 🛒');
}
function removeFromCart(id){ cartSet(cartGet().filter(x=>x.id!==id)); openCart(); }
function openCart(){
  const ex=document.querySelector('.cartmodal'); if(ex)ex.remove();
  const cart=cartGet();
  const w=document.createElement('div'); w.className='scanmodal cartmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  const sub=cart.reduce((a,x)=>a+(+x.price_cents||0),0);
  const rows=cart.length?cart.map(x=>'<div class="memrow"><div class="memmain"><div class="memname">'+esc(x.title)+'</div><div class="mememail">'+mUSD(x.price_cents)+(x.shipping_offered?(' · ships'+(x.shipping_cents?' '+mUSD(x.shipping_cents):'')):' · pickup')+'</div></div>'+
    '<button class="memdel" onclick="removeFromCart('+x.id+')">✕</button></div>').join(''):'<div class="muted" style="text-align:center;margin:10px 0">Your cart is empty.</div>';
  w.innerHTML='<div class="card" style="max-width:440px;width:100%;max-height:90vh;overflow:auto"><h3 style="color:var(--gold)">Your cart</h3>'+rows+
    (cart.length?('<div class="cartsub">Subtotal: <b>'+mUSD(sub)+'</b></div><div class="muted" style="margin:6px 0">Shipping, FL sales tax, and secure card payment are added at checkout.</div>'):'')+
    '<div class="row" style="margin-top:10px"><button class="gold" id="ck_go" style="flex:1"'+(cart.length?'':' disabled')+'>Checkout</button><button class="ghost" id="ck_x">Close</button></div></div>';
  w.querySelector('#ck_x').onclick=close;
  const go=w.querySelector('#ck_go'); if(go)go.onclick=()=>{ close(); openCheckout(); };
}
/* ---- Checkout (Square Web Payments SDK -> checkout Edge Function) ---- */
let _sqPayments=null,_sqCard=null;
function squareSdkUrl(){ const env=((window.HOC_CONFIG||{}).SQUARE_ENV||'sandbox').toLowerCase(); return env==='production'?'https://web.squarecdn.com/v1/square.js':'https://sandbox.web.squarecdn.com/v1/square.js'; }
function loadSquareSdk(){ return new Promise((res,rej)=>{ if(window.Square)return res(window.Square); const s=document.createElement('script'); s.src=squareSdkUrl(); s.onload=()=>res(window.Square); s.onerror=()=>rej(new Error('Square SDK failed to load')); document.head.appendChild(s); }); }
async function openCheckout(){
  const cfg=window.HOC_CONFIG||{};
  if(!cfg.SQUARE_APP_ID||!cfg.SQUARE_LOCATION_ID){ toast('Payments aren’t configured yet.'); return; }
  if(!wallCustomer){ toast('Please sign in to check out.'); openCustomerLogin(); return; }
  const cart=cartGet(); if(!cart.length){ toast('Your cart is empty.'); return; }
  const canShip=cart.every(x=>x.shipping_offered); const canPickup=cart.every(x=>x.local_pickup);
  if(!canShip&&!canPickup){ toast('Your cart mixes pickup-only and ship-only items — please order them separately.'); return; }
  let fulfillment=canPickup?'pickup':'ship';
  const w=document.createElement('div'); w.className='scanmodal checkoutmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w&&!w.dataset.busy)close(); });
  _sqCard=null;
  function val2(id){ const e=w.querySelector('#'+id); return e?(e.value||'').trim():''; }
  function totals(ful){ const sub=cart.reduce((a,x)=>a+(+x.price_cents||0),0); const ship=ful==='ship'?cart.reduce((a,x)=>a+(+x.shipping_cents||0),0):0; const tax=Math.round(sub*0.075); return {sub,ship,tax,total:sub+ship+tax}; }
  function render(){
    const t=totals(fulfillment);
    const fulPick=(canShip&&canPickup)?('<div class="row" style="gap:8px;margin:8px 0"><button class="'+(fulfillment==='pickup'?'gold':'ghost')+'" id="ful_pickup" style="flex:1">Local pickup</button><button class="'+(fulfillment==='ship'?'gold':'ghost')+'" id="ful_ship" style="flex:1">Ship to me</button></div>'):('<div class="muted" style="margin:8px 0">'+(fulfillment==='ship'?'Shipping':'Local pickup only')+'</div>');
    const addr=fulfillment==='ship'?(
      '<label class="fld"><span>Full name</span><input id="sh_name" value="'+esc(wallCustomer.name||'')+'"/></label>'+
      '<label class="fld"><span>Street address</span><input id="sh_a1"/></label>'+
      '<label class="fld"><span>Apt/Suite (optional)</span><input id="sh_a2"/></label>'+
      '<div class="grid2"><label class="fld" style="margin:0"><span>City</span><input id="sh_city"/></label><label class="fld" style="margin:0"><span>State</span><input id="sh_state"/></label></div>'+
      '<div class="grid2"><label class="fld" style="margin:0"><span>ZIP</span><input id="sh_zip" inputmode="numeric"/></label><label class="fld" style="margin:0"><span>Phone</span><input id="sh_phone" type="tel" inputmode="tel" value="'+esc(wallCustomer.phone||'')+'"/></label></div>'
    ):'<div class="muted" style="margin:6px 0">We’ll message you pickup details after payment.</div>';
    w.innerHTML='<div class="card" style="max-width:460px;width:100%;max-height:92vh;overflow:auto"><h3 style="color:var(--gold)">Checkout</h3>'+
      '<div class="ckitems">'+cart.map(x=>'<div class="ckrow"><span>'+esc(x.title)+'</span><span>'+mUSD(x.price_cents)+'</span></div>').join('')+'</div>'+
      fulPick+addr+
      '<div class="cktot"><div class="ckrow"><span>Subtotal</span><span>'+mUSD(t.sub)+'</span></div>'+
      (t.ship?('<div class="ckrow"><span>Shipping</span><span>'+mUSD(t.ship)+'</span></div>'):'')+
      '<div class="ckrow"><span>Sales tax (7.5%)</span><span>'+mUSD(t.tax)+'</span></div>'+
      '<div class="ckrow cktotal"><span>Total</span><span>'+mUSD(t.total)+'</span></div></div>'+
      '<div class="muted" style="margin:8px 0 4px">Card details</div><div id="sq-card" class="sqcard"></div>'+
      '<div id="sq-err" class="ckerr"></div>'+
      '<div class="muted" style="font-size:11px;margin:6px 0">🔒 Secure payment by Square. <b>All sales final.</b></div>'+
      '<div class="row" style="margin-top:8px"><button class="gold" id="ck_pay" style="flex:1">Pay '+mUSD(t.total)+'</button><button class="ghost" id="ck_cancel">Cancel</button></div></div>';
    w.querySelector('#ck_cancel').onclick=close;
    if(canShip&&canPickup){ w.querySelector('#ful_pickup').onclick=()=>{ if(fulfillment!=='pickup'){fulfillment='pickup';render();mountCard();} }; w.querySelector('#ful_ship').onclick=()=>{ if(fulfillment!=='ship'){fulfillment='ship';render();mountCard();} }; }
    w.querySelector('#ck_pay').onclick=pay;
  }
  async function mountCard(){ const er=w.querySelector('#sq-err');
    try{ const Square=await loadSquareSdk(); if(!_sqPayments)_sqPayments=Square.payments(cfg.SQUARE_APP_ID,cfg.SQUARE_LOCATION_ID);
      const host=w.querySelector('#sq-card'); if(!host)return; host.innerHTML=''; _sqCard=await _sqPayments.card(); await _sqCard.attach('#sq-card');
    }catch(e){ if(er)er.textContent='Could not load the secure card form. Refresh and try again.'; }
  }
  async function pay(){
    const btn=w.querySelector('#ck_pay'); const er=w.querySelector('#sq-err'); if(er)er.textContent='';
    if(!_sqCard){ if(er)er.textContent='The card form isn’t ready yet — one moment.'; return; }
    let ship=null;
    if(fulfillment==='ship'){ ship={name:val2('sh_name'),address1:val2('sh_a1'),address2:val2('sh_a2'),city:val2('sh_city'),state:val2('sh_state'),zip:val2('sh_zip'),phone:val2('sh_phone')};
      if(!ship.name||!ship.address1||!ship.city||!ship.state||!ship.zip){ if(er)er.textContent='Please complete the shipping address.'; return; } }
    w.dataset.busy='1'; btn.disabled=true; btn.textContent='Processing…';
    let tok;
    try{ const res=await _sqCard.tokenize(); if(res.status!=='OK')throw new Error((res.errors&&res.errors[0]&&res.errors[0].message)||'Please check your card details.'); tok=res.token; }
    catch(e){ if(er)er.textContent=String(e.message||e); btn.disabled=false; btn.textContent='Pay'; delete w.dataset.busy; return; }
    const payload={token:tok,idempotency_key:((crypto.randomUUID&&crypto.randomUUID())||String(Date.now())),item_ids:cart.map(x=>x.id),fulfillment:fulfillment,ship:ship,billing_same:true};
    let out=null;
    try{ const {data,error}=await sb.functions.invoke('checkout',{body:payload});
      if(error){ try{ out=await error.context.json(); }catch(_){ out=null; } } else out=data;
    }catch(e){ out=null; }
    if(out&&out.ok){ cartSet([]); close(); openOrderConfirm(out.order_id,out.total_cents); }
    else { if(er)er.textContent=(out&&out.error)||'Payment didn’t go through. Please try again.'; btn.disabled=false; btn.textContent='Pay'; delete w.dataset.busy; }
  }
  render(); mountCard();
}
function openOrderConfirm(id,total){
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w); const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.innerHTML='<div class="card" style="max-width:420px;width:100%;text-align:center"><h3 style="color:var(--gold)">Order placed! 🎉</h3>'+
    '<div style="font-size:40px;margin:6px 0">✅</div>'+
    '<div style="font-weight:800">Order #'+id+'</div><div class="muted" style="margin:6px 0">Paid '+mUSD(total)+'. We’ll be in touch with pickup or shipping details. You can see it under <b>My account → My orders</b>.</div>'+
    '<button class="gold" id="oc_x" style="width:100%;margin-top:8px">Done</button></div>';
  w.querySelector('#oc_x').onclick=close;
  loadWallCustomer().then(()=>render());
}
/* ---- Staff Orders (view + basic fulfillment; full workflow in Phase 4) ---- */
function orderActions(o){
  if(o.status==='complete'||o.status==='canceled')return '';
  const b=[];
  if(o.fulfillment==='ship') b.push('<button class="sm ghost" onclick="orderShip('+o.id+')">Add tracking / Shipped</button>');
  else b.push('<button class="sm ghost" onclick="orderReady('+o.id+')">Set pickup time / Ready</button>');
  b.push('<button class="sm gold" onclick="orderComplete('+o.id+')">Mark complete</button>');
  return '<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">'+b.join('')+'</div>';
}
function orderCard(o){
  const items=(o.items||[]).map(i=>'<div class="ckrow"><span>'+esc(i.title)+'</span><span>'+mUSD(i.price_cents)+'</span></div>').join('');
  const addr=o.fulfillment==='ship'
    ? '<div class="muted" style="margin:4px 0">📦 '+esc([o.ship_name,o.ship_address1,o.ship_address2,o.ship_city,o.ship_state,o.ship_zip].filter(Boolean).join(', '))+(o.ship_phone?(' · '+esc(o.ship_phone)):'')+'</div>'
    : '<div class="muted" style="margin:4px 0">🏪 Local pickup</div>';
  return '<div class="ordcard"><div class="ordhead"><b>Order #'+o.id+'</b><span class="ordstatus s_'+esc(o.status)+'">'+esc(o.status)+'</span></div>'+
    '<div class="muted">'+new Date(o.created_at).toLocaleString()+'</div>'+
    '<div style="margin-top:4px"><b>'+esc(o.customer_name||o.customer_email||'Customer')+'</b>'+(o.customer_email?(' · '+esc(o.customer_email)):'')+'</div>'+
    addr+'<div class="ckitems">'+items+'</div>'+
    '<div class="cktot"><div class="ckrow"><span>Subtotal</span><span>'+mUSD(o.subtotal_cents)+'</span></div>'+(o.shipping_cents?('<div class="ckrow"><span>Shipping</span><span>'+mUSD(o.shipping_cents)+'</span></div>'):'')+'<div class="ckrow"><span>Tax</span><span>'+mUSD(o.tax_cents)+'</span></div><div class="ckrow cktotal"><span>Total</span><span>'+mUSD(o.total_cents)+'</span></div></div>'+
    (o.tracking_number?('<div class="muted">Tracking: '+esc(o.tracking_number)+'</div>'):'')+(o.pickup_slot?('<div class="muted">Pickup: '+esc(o.pickup_slot)+'</div>'):'')+
    orderActions(o)+'</div>';
}
async function orderUpdate(id,status,tracking,pickup){
  const s=staffSession(); if(!s){ openStaffLogin(); return null; }
  if(!_staffPw){ const p=prompt('Confirm your staff password:'); if(p===null||p==='')return null; _staffPw=hashPass(p); }
  const r=await sbFn('order-update',{p_user:s.username,p_pass:_staffPw,id:id,status:status,tracking:tracking||'',pickup:pickup||''});
  if(!r||r.ok!==true){ _staffPw=null; toast((r&&r.error)||'Couldn’t update — check your password.'); return null; }
  return r;
}
async function orderShip(id){ const t=prompt('Tracking number (optional):'); if(t===null)return; if(await orderUpdate(id,'shipped',t,'')){ toast('Marked shipped — customer notified.'); loadOrders(); } }
async function orderReady(id){ const s=prompt('Pickup location & available time slots:'); if(s===null)return; if(await orderUpdate(id,'ready','',s)){ toast('Marked ready — customer notified.'); loadOrders(); } }
async function orderComplete(id){ if(!confirm('Mark this order complete?'))return; if(await orderUpdate(id,'complete','','')){ toast('Order complete.'); loadOrders(); } }
/* ---- Web Push (app notifications) ---- */
function urlB64ToUint8(base64){ const pad='='.repeat((4-base64.length%4)%4); const b=(base64+pad).replace(/-/g,'+').replace(/_/g,'/'); const raw=atob(b); const arr=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i); return arr; }
async function enableNotifications(kind){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||typeof Notification==='undefined'){ toast('Notifications aren’t supported on this device/browser.'); return; }
  const cfg=window.HOC_CONFIG||{}; if(!cfg.VAPID_PUBLIC){ toast('Notifications aren’t configured yet.'); return; }
  const standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone;
  if(/iphone|ipad|ipod/i.test(navigator.userAgent||'') && !standalone){ toast('On iPhone: tap Share → Add to Home Screen, then open the app and enable notifications.'); return; }
  try{
    const perm=await Notification.requestPermission(); if(perm!=='granted'){ toast('Notifications were not enabled.'); return; }
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:urlB64ToUint8(cfg.VAPID_PUBLIC)});
    const j=sub.toJSON()||{}; const keys=j.keys||{}; const endpoint=j.endpoint, p256dh=keys.p256dh, auth=keys.auth;
    if(!endpoint||!p256dh||!auth){ toast('Could not set up notifications.'); return; }
    if(kind==='staff'){ const s=staffSession(); if(!s){ toast('Sign in as staff first.'); return; } if(!_staffPw){ const p=prompt('Confirm your staff password:'); if(!p)return; _staffPw=hashPass(p); }
      const r=await sbRpc('push_subscribe_staff',{p_user:s.username,p_pass:_staffPw,p_endpoint:endpoint,p_p256dh:p256dh,p_auth:auth});
      if(r===true) toast('🔔 Staff notifications enabled!'); else { _staffPw=null; toast('Could not enable (check your password).'); } }
    else { if(!wallCustomer){ toast('Please sign in first.'); return; } const {error}=await sb.from('push_subscriptions').upsert({endpoint:endpoint,p256dh:p256dh,auth:auth,audience:'customer',customer_id:wallCustomer.id},{onConflict:'endpoint'}); if(!error) toast('🔔 Notifications enabled!'); else toast('Could not enable notifications.'); }
  }catch(e){ toast('Could not enable notifications.'); }
}
let _ordSub='active', _ordersCache=[], _newOrderCount=0;
async function loadOrders(){
  const cont=el('wOrders'); if(!cont)return; const s=staffSession(); if(!s){ cont.innerHTML='<div class="muted" style="text-align:center">Staff only.</div>'; return; }
  if(!_staffPw){ const p=prompt('Confirm your staff password to view orders:'); if(!p){ cont.innerHTML='<div class="muted" style="text-align:center">Enter your password. <button class="sm ghost" onclick="loadOrders()">Try again</button></div>'; return; } _staffPw=hashPass(p); }
  cont.innerHTML='<div class="muted" style="text-align:center">Loading…</div>';
  const r=await sbRpc('staff_orders',{p_user:s.username,p_pass:_staffPw});
  if(!r||r.ok!==true){ _staffPw=null; cont.innerHTML='<div class="muted" style="text-align:center">Couldn’t verify your password. <button class="sm ghost" onclick="loadOrders()">Try again</button></div>'; return; }
  _ordersCache=r.orders||[];
  const maxId=_ordersCache.reduce((m,o)=>Math.max(m,o.id||0),0);
  try{ localStorage.setItem('hoc_lastOrderSeen',String(maxId)); }catch(e){}
  _newOrderCount=0; const btn=document.querySelector('.walltab[data-k="orders"]'); if(btn)btn.innerHTML='📦 Orders';
  renderOrders();
}
function setOrdSub(s){ _ordSub=s; renderOrders(); }
function renderOrders(){
  const cont=el('wOrders'); if(!cont)return;
  const c=el('wOrdersControls'); if(c){ const subs=[['active','Active'],['complete','Complete']]; c.innerHTML='<div class="mktsubs">'+subs.map(x=>'<button class="mktsub'+(_ordSub===x[0]?' on':'')+'" onclick="setOrdSub(\''+x[0]+'\')">'+x[1]+'</button>').join('')+'</div>'; }
  let o=_ordersCache.slice();
  if(_ordSub==='complete') o=o.filter(x=>x.status==='complete'||x.status==='canceled');
  else o=o.filter(x=>x.status!=='complete'&&x.status!=='canceled');
  if(!o.length){ cont.innerHTML='<div class="muted" style="text-align:center">No '+_ordSub+' orders.</div>'; return; }
  cont.innerHTML='<div class="memcount">'+o.length+' '+_ordSub+' order'+(o.length===1?'':'s')+'</div>'+o.map(orderCard).join('');
}
async function checkNewOrders(){
  if(!staffSession()||!_staffPw)return;
  const r=await sbRpc('staff_orders',{p_user:staffSession().username,p_pass:_staffPw});
  if(!r||r.ok!==true)return;
  _ordersCache=r.orders||[];
  let lastSeen=0; try{ lastSeen=+(localStorage.getItem('hoc_lastOrderSeen')||0); }catch(e){}
  _newOrderCount=_ordersCache.filter(o=>(o.id||0)>lastSeen && o.status!=='canceled').length;
  const btn=document.querySelector('.walltab[data-k="orders"]'); if(btn)btn.innerHTML='📦 Orders'+(_newOrderCount?(' <span class="tabbadge">'+_newOrderCount+'</span>'):'');
  if(_newOrderCount>0 && ui.wallTab!=='orders') toast('🛎️ '+_newOrderCount+' new order'+(_newOrderCount===1?'':'s')+' — check the Orders tab!');
}
function isAdmin(){ return !!staffSession(); }  // add/delete/edit show only for a signed-in staff member (old phone-unlock retired)
/* ---- Staff sign-in (username + password; claim on first use; secret-question reset) ---- */
function openStaffLogin(){
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w);
  const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  function shell(inner){ w.innerHTML='<div class="card" style="max-width:400px;width:100%">'+inner+'</div>'; }
  function loginStep(){
    shell('<h3 style="color:var(--gold)">Staff sign in</h3>'+
      '<label class="fld"><span>Username</span><input id="st_u" autocapitalize="off"/></label>'+
      '<label class="fld"><span>Password</span><input id="st_p" type="password"/></label>'+
      '<div class="row" style="margin-top:8px"><button class="gold" id="st_go" style="flex:1">Sign in</button><button class="ghost" id="st_x">Close</button></div>'+
      '<div style="text-align:center;margin-top:10px"><button class="btn-link" id="st_first">First time / forgot password?</button></div>');
    w.querySelector('#st_x').onclick=close;
    w.querySelector('#st_go').onclick=async()=>{ const u=(w.querySelector('#st_u').value||'').trim(); const p=w.querySelector('#st_p').value||'';
      if(!u||!p){ toast('Enter username and password.'); return; }
      const r=await sbRpc('staff_login',{p_user:u,p_pass:hashPass(p)});
      if(Array.isArray(r)&&r.length){ _staffPw=hashPass(p); setStaffSession({username:r[0].username,phone:r[0].phone,email:r[0].email}); close(); toast('Welcome, '+r[0].username+'!'); render(); }
      else toast('Wrong username or password.'); };
    w.querySelector('#st_first').onclick=async()=>{ const u=(w.querySelector('#st_u').value||'').trim(); if(!u){ toast('Type your username first.'); return; }
      const st=await sbRpc('staff_status',{p_user:u});
      if(!Array.isArray(st)||!st.length){ toast('No staff account with that username.'); return; }
      if(st[0].claimed) forgotStep(u, st[0].sec_q); else claimStep(u); };
  }
  function claimStep(u){
    shell('<h3 style="color:var(--gold)">Set up your account</h3><div class="muted" style="margin-bottom:8px">First sign-in for <b>'+esc(u)+'</b> — pick a password and a security question.</div>'+
      '<label class="fld"><span>New password</span><input id="c_p" type="password"/></label>'+
      '<label class="fld"><span>Email</span><input id="c_e" type="email"/></label>'+
      '<label class="fld"><span>Security question</span><input id="c_q" placeholder="e.g. First pet\'s name"/></label>'+
      '<label class="fld"><span>Answer</span><input id="c_a"/></label>'+
      '<div class="row" style="margin-top:8px"><button class="gold" id="c_go" style="flex:1">Create account</button><button class="ghost" id="c_b">Back</button></div>');
    w.querySelector('#c_b').onclick=loginStep;
    w.querySelector('#c_go').onclick=async()=>{ const p=w.querySelector('#c_p').value||''; const e=(w.querySelector('#c_e').value||'').trim(); const q=(w.querySelector('#c_q').value||'').trim(); const a=(w.querySelector('#c_a').value||'').trim();
      if(p.length<4){ toast('Password must be at least 4 characters.'); return; } if(!q||!a){ toast('Set a security question and answer.'); return; }
      const ok=await sbRpc('staff_claim',{p_user:u,p_pass:hashPass(p),p_email:e||null,p_q:q,p_a:hashPass(a.toLowerCase())});
      if(ok===true){ _staffPw=hashPass(p); setStaffSession({username:u,email:e}); close(); toast('Account created — you\'re signed in!'); render(); }
      else toast('That account is already set up — try signing in.'); };
  }
  function forgotStep(u,q){
    shell('<h3 style="color:var(--gold)">Reset password</h3><div class="muted" style="margin-bottom:8px">Security question:</div><div style="font-weight:800;margin-bottom:8px">'+esc(q||'(none set)')+'</div>'+
      '<label class="fld"><span>Your answer</span><input id="f_a"/></label>'+
      '<label class="fld"><span>New password</span><input id="f_p" type="password"/></label>'+
      '<div class="row" style="margin-top:8px"><button class="gold" id="f_go" style="flex:1">Reset &amp; sign in</button><button class="ghost" id="f_b">Back</button></div>');
    w.querySelector('#f_b').onclick=loginStep;
    w.querySelector('#f_go').onclick=async()=>{ const a=(w.querySelector('#f_a').value||'').trim(); const p=w.querySelector('#f_p').value||'';
      if(!a||p.length<4){ toast('Enter your answer and a new password (4+ chars).'); return; }
      const ok=await sbRpc('staff_reset',{p_user:u,p_ans:hashPass(a.toLowerCase()),p_newpass:hashPass(p)});
      if(ok===true){ _staffPw=hashPass(p); const r=await sbRpc('staff_login',{p_user:u,p_pass:hashPass(p)}); if(Array.isArray(r)&&r.length){ setStaffSession({username:r[0].username,phone:r[0].phone,email:r[0].email}); } close(); toast('Password reset — signed in!'); render(); }
      else toast('That answer doesn\'t match.'); };
  }
  loginStep();
}
function openStaffAccount(){ const s=staffSession(); if(!s)return;
  const w=document.createElement('div'); w.className='scanmodal'; document.body.appendChild(w); const close=()=>w.remove(); w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.innerHTML='<div class="card" style="max-width:400px;width:100%"><h3 style="color:var(--gold)">'+esc(s.username)+'’s account</h3>'+
    '<label class="fld"><span>Email</span><input id="a_e" type="email" value="'+esc(s.email||'')+'"/></label>'+
    '<hr class="sep"><div class="muted" style="margin-bottom:6px">Change password (optional):</div>'+
    '<label class="fld"><span>Current password</span><input id="a_old" type="password"/></label>'+
    '<label class="fld"><span>New password</span><input id="a_new" type="password"/></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="a_save" style="flex:1">Save</button><button class="ghost" id="a_x">Close</button></div>'+
    '<hr class="sep"><div class="muted" style="margin-bottom:6px">Add a staff member <span style="opacity:.8">— they pick their own password on first sign-in via “First time / forgot password?”.</span></div>'+
    '<label class="fld"><span>New staff username</span><input id="ns_u" autocapitalize="off"/></label>'+
    '<label class="fld"><span>Their phone (optional)</span><input id="ns_ph" inputmode="tel"/></label>'+
    '<label class="fld"><span>Your password (to authorize)</span><input id="ns_pw" type="password"/></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="ns_go" style="flex:1">Create staff account</button></div>'+
    '<hr class="sep"><div class="muted" style="margin-bottom:6px">Phone notifications</div>'+
    '<div class="row"><button class="ghost" id="st_notif" style="flex:1">🔔 Enable order alerts on this phone</button></div>'+
    '<hr class="sep"><div class="muted" style="margin-bottom:6px">Square payments (setup check)</div>'+
    '<div class="row"><button class="ghost" id="sq_test" style="flex:1">Test Square connection</button></div>'+
    '<div id="sq_result" class="muted" style="margin-top:6px"></div></div>';
  w.querySelector('#a_x').onclick=close;
  w.querySelector('#st_notif').onclick=()=>enableNotifications('staff');
  w.querySelector('#sq_test').onclick=async()=>{ const out=w.querySelector('#sq_result'); out.textContent='Checking…';
    const r=await sbFn('square-health');
    if(!r){ out.textContent='Could not reach the server.'; return; }
    if(r.ok){ const loc=(r.locations&&r.locations[0])?(r.locations[0].id+' ('+(r.locations[0].name||'')+')'):'no locations'; out.innerHTML='✅ Connected — env: <b>'+esc(r.env)+'</b>, location: <b>'+esc(loc)+'</b>'; }
    else { out.innerHTML='❌ '+esc(r.error||'Not connected')+(r.status?(' (HTTP '+r.status+')'):''); } };
  w.querySelector('#a_save').onclick=async()=>{ const email=(w.querySelector('#a_e').value||'').trim(); const oldp=w.querySelector('#a_old').value||''; const newp=w.querySelector('#a_new').value||'';
    if(!oldp){ toast('Enter your current password to save changes.'); return; } if(newp&&newp.length<4){ toast('New password must be 4+ characters.'); return; }
    const ok=await sbRpc('staff_update',{p_user:s.username,p_old:hashPass(oldp),p_newpass:newp?hashPass(newp):'',p_email:email});
    if(ok===true){ _staffPw=hashPass(newp||oldp); s.email=email; setStaffSession(s); close(); toast('Saved.'); render(); }
    else toast('Current password is incorrect.'); };
  w.querySelector('#ns_go').onclick=async()=>{ const nu=(w.querySelector('#ns_u').value||'').trim(); const nph=(w.querySelector('#ns_ph').value||'').replace(/\D/g,''); const pw=w.querySelector('#ns_pw').value||'';
    if(!/^[a-z0-9_]{2,}$/.test(nu.toLowerCase())){ toast('Username: 2+ letters/numbers, no spaces.'); return; }
    if(!pw){ toast('Enter your own password to authorize.'); return; }
    const res=await sbRpc('staff_create',{p_user:s.username,p_pass:hashPass(pw),p_newuser:nu,p_newphone:nph||null});
    if(res==='ok'){ toast(nu.toLowerCase()+' added — they sign in with “First time / forgot password?”.'); w.querySelector('#ns_u').value=''; w.querySelector('#ns_ph').value=''; w.querySelector('#ns_pw').value=''; }
    else if(res==='exists') toast('That username already exists.');
    else if(res==='baduser') toast('Username: 2+ letters/numbers, no spaces.');
    else if(res==='auth') toast('Your password is incorrect.');
    else toast('Couldn’t add staff (cloud not reachable).'); };
}
let _mediaTaps=0,_mediaTapT=0;
function mediaSecTap(){ const n=Date.now(); if(n-_mediaTapT>1500)_mediaTaps=0; _mediaTapT=n; if(++_mediaTaps>=4){ _mediaTaps=0; staffUnlock(); } }  // hidden: 4 taps on the section title to unlock staff upload
function staffUnlock(){ const p=(prompt('Staff: enter your mobile number to unlock uploads')||'').replace(/\D/g,''); if(!p)return;
  if(ADMIN_PHONES.some(n=>n.slice(-10)===p.slice(-10))){ try{ localStorage.setItem('hoc_admin_phone',p); }catch(e){} toast('Staff upload unlocked.'); loadMedia(); }
  else toast('That number isn\'t on the staff list.'); }
async function uploadMedia(file){ const {base,key}=sbBase(); if(!base||!key){ toast('Cloud not set up.'); return null; }
  const ext=((file.name||'').split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'')||'bin';
  const path=Date.now()+'-'+Math.random().toString(36).slice(2,8)+'.'+ext;
  try{ const r=await fetch(base+'/storage/v1/object/show-media/'+path,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':file.type||'application/octet-stream','x-upsert':'true'},body:file});
    if(!r.ok){ toast('Upload failed ('+r.status+').'); return null; }
    return {path:path, url:base+'/storage/v1/object/public/show-media/'+path}; }catch(e){ toast('Upload failed.'); return null; } }
function pickMedia(){ if(!staffSession()){ openStaffLogin(); return; } const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*,video/*';
  inp.onchange=async()=>{ const f=inp.files[0]; if(!f)return; toast('Uploading…'); const up=await uploadMedia(f); if(!up)return;
    const caption=(prompt('Add a caption (optional):')||'').trim(); const kind=(f.type||'').indexOf('video')===0?'video':'photo';
    const id=await staffDo('media_add',{p_kind:kind,p_path:up.path,p_url:up.url,p_caption:caption,p_uploader:myName()||null},'Posted! 🎉');
    if(id)loadMedia(); };
  inp.click(); }
async function deleteMedia(id){ if(!isAdmin())return; if(!confirm('Delete this post?'))return;
  const ok=await staffDo('media_delete',{p_id:id},'Deleted.'); if(ok)loadMedia(); }
function likedKey(id){ return 'hoc_like_'+id; }
function mediaLiked(id){ try{ return !!localStorage.getItem(likedKey(id)); }catch(e){ return false; } }
async function toggleLike(id){ const liked=mediaLiked(id); const delta=liked?-1:1;
  try{ if(liked)localStorage.removeItem(likedKey(id)); else localStorage.setItem(likedKey(id),'1'); }catch(e){}
  const n=await sbRpc('like_media',{mid:id,delta:delta}); const s=el('lk'+id); if(s&&typeof n==='number')s.textContent=n;
  const b=el('lb'+id); if(b)b.classList.toggle('gold',!liked); }
async function loadComments(id){ const c=el('cm'+id); if(!c)return; const list=await sbGet('media_comments?select=id,name,body,created_at&media_id=eq.'+id+'&order=created_at.asc&limit=100');
  if(Array.isArray(list)) c.innerHTML=list.map(x=>'<div class="cmt"><b>'+(x.name?esc(x.name):'Anon')+':</b> '+esc(x.body)+(isAdmin()?(' <button class="cmtdel" onclick="deleteComment('+x.id+','+id+')">✕</button>'):'')+'</div>').join(''); }
async function deleteComment(cid,mid){ if(!isAdmin())return; if(!confirm('Delete this comment?'))return;
  const ok=await staffDo('comment_delete',{p_id:cid}); if(ok)loadComments(mid); }
function openComments(id){ const w=document.createElement('div'); w.className='scanmodal';
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="color:var(--gold)">Add a comment</h3>'+
    '<label class="fld"><span>Name (required)</span><input id="cm_n" autocomplete="name" value="'+esc(savedName())+'"/></label>'+
    '<label class="fld"><span>Comment</span><textarea id="cm_b" rows="3"></textarea></label>'+
    '<div class="row"><button class="gold" id="cm_go" style="flex:1">Post</button><button class="ghost" id="cm_x">Cancel</button></div></div>';
  document.body.appendChild(w); const close=()=>w.remove(); w.querySelector('#cm_x').onclick=close; w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.querySelector('#cm_go').onclick=async()=>{ const name=(w.querySelector('#cm_n').value||'').trim(); const body=(w.querySelector('#cm_b').value||'').trim();
    if(!name){ toast('Please enter your name.'); return; } if(!body){ toast('Type a comment first.'); return; }
    rememberName(name); const ok=await sbInsert('media_comments',{media_id:id,name:name,body:body});
    if(!ok){ toast('Couldn\'t post comment.'); return; } close(); loadComments(id); };
  setTimeout(()=>{ const f=w.querySelector(savedName()?'#cm_b':'#cm_n'); if(f)f.focus(); },60); }
function mediaCard(it){
  const media=(it.kind==='video')?('<video class="mmedia" src="'+esc(it.url)+'" controls playsinline preload="metadata"></video>'):('<img class="mmedia" loading="lazy" src="'+esc(it.url)+'"/>');
  const del=isAdmin()?('<button class="sm red" onclick="deleteMedia('+it.id+')">Delete</button>'):'';
  return '<div class="mcard">'+media+
    (it.caption?('<div class="mcap">'+esc(it.caption)+'</div>'):'')+
    '<div class="mmeta">'+(it.uploader?(esc(it.uploader)+' · '):'')+new Date(it.created_at).toLocaleString()+'</div>'+
    '<div class="row" style="gap:8px;margin-top:6px"><button id="lb'+it.id+'" class="sm '+(mediaLiked(it.id)?'gold':'ghost')+'" onclick="toggleLike('+it.id+')">❤ <span id="lk'+it.id+'">'+(it.likes||0)+'</span></button>'+
      '<button class="sm ghost" onclick="openComments('+it.id+')">💬 Comment</button>'+del+'</div>'+
    '<div id="cm'+it.id+'" class="mcomments"></div></div>';
}
async function loadMedia(){
  const adm=el('wMediaAdmin'); if(adm){ adm.innerHTML = isAdmin()
    ? '<div class="row" style="justify-content:center;margin-bottom:14px"><button class="gold" onclick="pickMedia()">＋ Add photo / video</button></div>'
    : ''; }  // upload is invisible to everyone but the 5 staff phones
  const cont=el('wMedia'); if(!cont)return;
  const m=await sbGet('media?select=id,kind,url,caption,uploader,likes,created_at&order=created_at.desc&limit=60');
  if(!Array.isArray(m)){ cont.innerHTML='<div class="muted" style="text-align:center">Gallery opens soon.</div>'; return; }
  if(!m.length){ cont.innerHTML='<div class="muted" style="text-align:center">No posts yet — check back during the show!</div>'; return; }
  cont.innerHTML=m.map(mediaCard).join(''); m.forEach(it=>loadComments(it.id));
}
function sharePage(){ const url=location.href;
  if(navigator.share){ navigator.share({title:'House of Cards', text:'House of Cards — cards, singles & deals', url:url}).catch(()=>{}); return; }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(()=>toast('Link copied — paste to share.')).catch(()=>toast(url)); return; }
  toast(url);
}
let _wallTaps=0,_wallTapT=0;
function wallSecretTap(){ const n=Date.now(); if(n-_wallTapT>1500)_wallTaps=0; _wallTapT=n; if(++_wallTaps>=5){ _wallTaps=0; ui.authView='landing'; render(); } }
function openTextSignup(){
  const w=document.createElement('div'); w.className='scanmodal';
  w.innerHTML='<div class="card" style="max-width:420px;width:100%"><h3 style="font-size:20px;color:var(--gold)">Join our page</h3>'+
    '<div class="muted" style="margin-bottom:10px">Get first dibs on new singles, breaks &amp; show deals. We only text the good stuff — no spam.</div>'+
    '<label class="fld"><span>Your name</span><input id="w_name" autocomplete="name" placeholder="First name"/></label>'+
    '<label class="fld"><span>Mobile number</span><input id="w_phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 123-4567"/></label>'+
    '<div class="row" style="margin-top:10px"><button class="gold" id="w_sub" style="flex:1">Sign me up</button><button class="ghost" id="w_cancel">Cancel</button></div></div>';
  document.body.appendChild(w);
  const close=()=>w.remove();
  w.querySelector('#w_cancel').onclick=close;
  w.addEventListener('click',e=>{ if(e.target===w)close(); });
  w.querySelector('#w_sub').onclick=()=>{
    const name=(w.querySelector('#w_name').value||'').trim();
    const phone=(w.querySelector('#w_phone').value||'').trim();
    if(phone.replace(/\D/g,'').length<10){ toast('Please enter a valid 10-digit mobile number.'); return; }
    saveLead(name,phone);
    w.innerHTML='<div class="card" style="max-width:420px;width:100%;text-align:center"><div style="font-size:40px">🎉</div><h3 style="font-size:22px;color:var(--gold)">You\'re in!</h3><div class="muted" style="margin:8px 0 14px">Thanks'+(name?(', '+esc(name)):'')+' — watch your phone for updates from House of Cards.</div><button class="gold" onclick="this.closest(\'.scanmodal\').remove()">Done</button></div>';
  };
  setTimeout(()=>{ const n=w.querySelector('#w_name'); if(n)n.focus(); },60);
}
function signupList(){ try{ return JSON.parse(localStorage.getItem('hoc_textSignups')||'[]'); }catch(e){ return []; } }
function saveTextSignup(name,phone){ const a=signupList(); a.push({name:name,phone:phone,ts:Date.now()}); try{ localStorage.setItem('hoc_textSignups',JSON.stringify(a)); }catch(e){} }
function exportSignups(){ const a=signupList(); if(!a.length){ toast('No sign-ups collected yet.'); return; }
  const csv='Name,Phone,Date\n'+a.map(r=>'"'+String(r.name||'').replace(/"/g,'""')+'","'+String(r.phone||'')+'","'+new Date(r.ts).toLocaleString()+'"').join('\n');
  const link=document.createElement('a'); link.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv); link.download='house-of-cards-text-signups.csv'; link.click(); toast('Exported '+a.length+' sign-up(s).'); }
function clearSignups(){ if(!confirm('Delete all text sign-ups collected on this device? Export first if you want to keep them.'))return; localStorage.removeItem('hoc_textSignups'); toast('Cleared.'); render(); }
function uploadLogoPrompt(){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=async ()=>{ const f=inp.files[0]; if(!f)return;
    const r=new FileReader(); r.onload=async ()=>{ state.settings.logo=r.result;   // keep a local copy for this device
      if(cloudOn()){ toast('Uploading logo…'); const ok=await uploadCloudLogo(f); if(ok)toast('Logo saved to the cloud — it’s the landing logo on every device now.'); }
      else { toast('Logo set for this device.'); }
      save(); render(); };
    r.readAsDataURL(f); }; inp.click(); }
let bounceRAF=null;
function startBounce(){ const area=el('bounceArea'), logo=el('bounceLogo'); if(!area||!logo)return; stopBounce();
  let x=24,y=24,dx=2.4,dy=2.0;
  const step=()=>{ try{
    if(document.hidden){ bounceRAF=requestAnimationFrame(step); return; } // don't churn in the background
    const aw=area.clientWidth, ah=area.clientHeight, lw=logo.clientWidth||180, lh=logo.clientHeight||180;
    if(aw>0&&ah>0){ x+=dx; y+=dy;
      if(x<=0){x=0;dx=Math.abs(dx);} if(y<=0){y=0;dy=Math.abs(dy);}
      if(x+lw>=aw){x=aw-lw;dx=-Math.abs(dx);} if(y+lh>=ah){y=ah-lh;dy=-Math.abs(dy);}
      logo.style.transform='translate('+x+'px,'+y+'px)'; }
    bounceRAF=requestAnimationFrame(step);
  }catch(e){ stopBounce(); } };
  bounceRAF=requestAnimationFrame(step); }
function stopBounce(){ if(bounceRAF){ cancelAnimationFrame(bounceRAF); bounceRAF=null; } }

/* -------- accounts: helpers + plans -------- */
const PLANS=[
  {id:'monthly',name:'Monthly',price:'',per:'',blurb:'Full access, billed monthly. Cancel anytime.'},
  {id:'yearly', name:'Yearly', price:'',per:'',blurb:'Best value — save vs. paying monthly.'}];
function findUser(key){ key=String(key||'').trim().toLowerCase(); if(!key)return null;
  return state.users.find(u=>String(u.username||'').toLowerCase()===key)
      || state.users.find(u=>String(u.email||'').toLowerCase()===key)
      || state.users.find(u=>String(u.name||'').toLowerCase()===key) || null; }

/* -------- Sign up (account details) -------- */
function viewSignup(){
  return '<div class="login"><h2 class="page">Create your account <small>start selling with House of Cards</small></h2><div class="card">'+
    fld('Full name',inp('su_name','','first & last'))+
    fld('Username',inp('su_username','','letters & numbers, no spaces'))+
    fld('Email address',inp('su_email','','you@example.com','email'))+
    fld('Password',inp('su_pass','','at least 3 characters','password'))+
    fld('Confirm password',inp('su_pass2','','','password'))+
    fld('Security question (for password reset)',inp('su_q','','e.g. First pet\'s name'))+
    fld('Security answer',inp('su_a','','your answer'))+
    '<div class="row"><button class="gold" onclick="doSignup()">Continue to subscription →</button><button class="ghost" onclick="ui.authView=\'landing\';render()">Back</button></div>'+
    '<div class="muted" style="margin-top:8px">Already have an account? <a href="#" onclick="ui.authView=\'login\';render();return false">Log in</a>. Everyone on a company shares full access; every change is signed by who made it.</div>'+
  '</div></div>'; }
async function doSignup(){ const name=val('su_name').trim(); if(!name){ toast('Enter your name.'); return; }
  const username=val('su_username').trim().toLowerCase(); if(!/^[a-z0-9_]{3,}$/.test(username)){ toast('Username: 3+ letters/numbers, no spaces.'); return; }
  if(state.users.some(u=>String(u.username||'').toLowerCase()===username)){ toast('That username is taken.'); return; }
  const email=val('su_email').trim(); if(!/^\S+@\S+\.\S+$/.test(email)){ toast('Enter a valid email address.'); return; }
  if(state.users.some(u=>String(u.email||'').toLowerCase()===email.toLowerCase())){ toast('That email already has an account.'); return; }
  const p=val('su_pass'); if(p.length<3){ toast('Password needs at least 3 characters.'); return; }
  if(p!==val('su_pass2')){ toast('Passwords don’t match.'); return; }
  const u={id:uid('u'),name,username,email,pass:hashPass(p),secQ:val('su_q'),secA:val('su_a')?hashPass(val('su_a').toLowerCase()):'',mustChange:false,subscription:{status:'pending',since:0}};
  state.users.push(u); ui.newUserId=u.id; ui.authView='subscribe'; save(); render();
  // also create the matching cloud account so this login works on every device and is searchable
  if(cloudOn()&&typeof cloudSignUp==='function'){ try{ const r=await cloudSignUp(email,p,name,username);
    if(r&&r.needsConfirm) toast('Heads up: turn OFF “Confirm email” in Supabase so friends/cloud connect automatically.');
    else if(r&&r.error&&!/registered|already|exists/i.test(r.error)) console.warn('[HoC] cloud signup',r.error); }catch(e){ console.warn(e); } } }

/* -------- Subscription portal -------- */
function viewSubscribe(){
  const u=state.users.find(x=>x.id===ui.newUserId)||{}; const sel=ui.planPick||'monthly';
  const plans=PLANS.map(p=>'<button class="plan'+(p.id===sel?' on':'')+'" onclick="ui.planPick=\''+p.id+'\';render()">'+
      '<div class="plan-name">'+p.name+'</div>'+(p.price?'<div class="plan-price">'+p.price+'<span>'+p.per+'</span></div>':'<div class="plan-price plan-tbd">Pricing soon</div>')+'<div class="plan-blurb">'+p.blurb+'</div></button>').join('');
  return '<div class="login"><h2 class="page">Choose your plan <small>welcome, '+esc(u.name||'')+'</small></h2><div class="card">'+
    '<div class="plans">'+plans+'</div>'+
    '<div class="row" style="margin-top:12px"><button class="gold lg" onclick="doSubscribe()">Subscribe & enter</button>'+
      '<button class="ghost" onclick="enterAfterSignup(\'trial\')">Start free trial instead</button></div>'+
    '<div class="muted" style="margin-top:10px">Your account is created. Subscribe to unlock everything, or start a free trial and add billing later from Settings.</div>'+
  '</div></div>'; }
function doSubscribe(){ const u=state.users.find(x=>x.id===ui.newUserId); if(!u)return;
  const url=(window.HOC_CONFIG&&window.HOC_CONFIG.SUBSCRIBE_URL)||'';
  if(url){ const plan=ui.planPick||'monthly'; const full=url+(url.includes('?')?'&':'?')+'plan='+plan+'&email='+encodeURIComponent(u.email||'');
    window.open(full,'_blank'); toast('Finish checkout in the new tab, then come back.'); enterAfterSignup('subscribing'); }
  else { toast('Billing isn’t connected yet — starting your free trial.'); enterAfterSignup('trial'); } }
function enterAfterSignup(status){ const u=state.users.find(x=>x.id===ui.newUserId); if(!u)return;
  u.subscription={status:status||'trial',plan:ui.planPick||'monthly',since:Date.now()};
  state.currentUserId=u.id; ui.authed=true; ui.authView='landing'; ui.route='dashboard'; ui.newUserId=null; state.session={userId:u.id,since:Date.now()};
  logChange('account','signed up ('+u.subscription.status+')'); save(); toast('Welcome, '+u.name+'!'); render(); }

/* -------- Login -------- */
function viewLogin(){
  if(ui.loginMode==='forgot'){
    const usr=ui.forgotUser?state.users.find(x=>x.id===ui.forgotUser):null;
    if(!usr){ return '<div class="login"><h2 class="page">Reset password</h2><div class="card">'+
        fld('Username or email',inp('lg_fkey','','your username or email'))+
        '<div class="row"><button class="gold" onclick="doForgotFind()">Find my account</button><button class="ghost" onclick="ui.loginMode=\'login\';render()">Back</button></div>'+
      '</div></div>'; }
    return '<div class="login"><h2 class="page">Reset password <small>'+esc(usr.name)+'</small></h2><div class="card">'+
      (usr.secQ?fld('Security question',('<div class="banner">'+esc(usr.secQ)+'</div>'))+fld('Your answer',inp('lg_ans','',''))+
        fld('New password',inp('lg_new','','','password'))+
        '<div class="row"><button class="gold" onclick="doReset()">Reset password</button><button class="ghost" onclick="ui.forgotUser=null;render()">Back</button></div>'
        :'<div class="banner">'+esc(usr.name)+' hasn\'t set a security question, so self-reset isn\'t available. If the password was never changed, sign in with <b>test</b>.</div><div class="row" style="margin-top:10px"><button class="ghost" onclick="ui.forgotUser=null;render()">Back</button></div>')+
      '</div></div>'; }
  return '<div class="login"><h2 class="page">Sign in <small>House of Cards</small></h2><div class="card">'+
    fld('Username or email',inp('lg_username','','your username or email'))+
    fld('Password',inp('lg_pass','','','password'))+
    '<div class="row"><button class="gold" onclick="doLogin()">Sign in</button>'+
    '<button class="ghost" onclick="ui.loginMode=\'forgot\';ui.forgotUser=null;render()">Forgot password?</button>'+
    '<button class="ghost" onclick="ui.authView=\'signup\';render()">Sign up</button>'+
    '<button class="ghost right" onclick="ui.authView=\'landing\';render()">← Home</button></div>'+
    '<div class="muted" style="margin-top:8px">Tip: existing team members log in with their username and the default password <b>test</b> until they change it.</div>'+
    '</div></div>';
}
async function doLogin(){ const key=val('lg_username'), pass=val('lg_pass');
  const u=findUser(key);
  if(u && u.pass===hashPass(pass)){
    state.currentUserId=u.id; ui.authed=true; ui.route='dashboard'; state.session={userId:u.id,since:Date.now()}; save();
    if(cloudOn()&&typeof syncCloudToAppUser==='function'){ syncCloudToAppUser(u,pass); } // auto-connect cloud in the background
    render(); return;
  }
  // cloud account created on another device or on the Friends tab — recognize it here too
  if(cloudOn()&&typeof cloudLoginByKey==='function'){
    const r=await cloudLoginByKey(key,pass);
    if(r&&r.ok){ const pr=r.profile||{};
      let lu=findUser(pr.handle)||findUser(pr.email)||findUser(key);
      if(!lu){ lu={id:uid('u'),name:pr.name||pr.handle||key,username:(pr.handle||'').toLowerCase(),email:pr.email||'',pass:hashPass(pass),secQ:'',secA:'',mustChange:false,subscription:{status:'cloud',since:Date.now()}}; state.users.push(lu); }
      else { lu.pass=hashPass(pass); if(pr.email)lu.email=pr.email; }
      state.currentUserId=lu.id; ui.authed=true; ui.route='dashboard'; state.session={userId:lu.id,since:Date.now()}; save(); toast('Welcome, '+lu.name+'!'); render(); return;
    }
    if(r&&r.error&&!u){ toast(r.error); return; }
  }
  toast(u?'Wrong password.':'No account with that username or email.');
}
function doForgotFind(){ const u=findUser(val('lg_fkey')); if(!u){ toast('No account found for that.'); return; } ui.forgotUser=u.id; render(); }
function doReset(){ const u=ui.forgotUser?state.users.find(x=>x.id===ui.forgotUser):null; if(!u||!u.secQ)return;
  if(u.secA!==hashPass(val('lg_ans').toLowerCase())){ toast('That answer doesn\'t match.'); return; }
  const np=val('lg_new'); if(np.length<3){ toast('Pick a password of at least 3 characters.'); return; }
  u.pass=hashPass(np); u.mustChange=false; save(); ui.loginMode='login'; ui.forgotUser=null; toast('Password reset — sign in now.'); render();
}
function logout(){ ui.authed=false; ui.loginMode='login'; ui.authView='wall'; stopImgJob(); state.session=null; save();
  if(typeof cloudSignOut==='function'){ try{ cloudSignOut(); }catch(e){} }   // clear cloud session so the next login connects fresh
  render(); }
function switchUserPrompt(id){ if(id===state.currentUserId)return; const u=state.users.find(x=>x.id===id); if(!u)return;
  const p=prompt('Password for '+u.name+' (each person signs into their own account):'); if(p===null){ render(); return; }
  if(u.pass!==hashPass(p)){ toast('Wrong password — staying as '+me().name+'.'); render(); return; }
  state.currentUserId=u.id; state.session={userId:u.id,since:Date.now()}; save(); toast('Now acting as '+u.name);
  if(cloudOn()&&typeof syncCloudToAppUser==='function'){ syncCloudToAppUser(u,p); }   // reconnect cloud as the switched-to user
  render();
}

/* -------- First-time setup (set your email + own password → also your cloud login) -------- */
function viewOnboard(){ const u=me();
  return '<div class="login" style="max-width:440px"><h2 class="page">Welcome, '+esc(u.name)+'! <small>finish setting up your account</small></h2><div class="card">'+
    '<div class="banner">Set your email and a password you’ll remember. You’ll use these to sign in here — and they automatically connect your cloud profile so friends &amp; sync just work.</div>'+
    fld('Your email',inp('ob_email',u.email||'','you@example.com','email'))+
    fld('Choose a password',inp('ob_pass','','at least 3 characters','password'))+
    fld('Confirm password',inp('ob_pass2','','','password'))+
    '<div class="row" style="margin-top:6px"><button class="gold lg" onclick="doOnboard()">Save & continue</button></div>'+
    '<div class="muted" style="margin-top:8px">You can change these later in Settings → My account.</div>'+
  '</div></div>'; }
async function doOnboard(){ const u=me(); const email=val('ob_email').trim();
  if(!/^\S+@\S+\.\S+$/.test(email)){ toast('Enter a valid email address.'); return; }
  if(state.users.some(x=>x.id!==u.id&&String(x.email||'').toLowerCase()===email.toLowerCase())){ toast('That email is already used by another account here.'); return; }
  const p=val('ob_pass'); if(p.length<3){ toast('Password needs at least 3 characters.'); return; }
  if(p!==val('ob_pass2')){ toast('Passwords don’t match.'); return; }
  u.email=email; u.pass=hashPass(p); u.mustChange=false; logChange('account','completed first-time setup'); save();
  toast('All set — welcome aboard!');
  if(cloudOn()&&typeof syncCloudToAppUser==='function'){ try{ await syncCloudToAppUser(u,p); }catch(e){} }
  render();
}

/* -------- Dashboard -------- */
function viewDashboard(){
  const inv=state.inventory;
  const avail=inv.filter(i=>i.status==='available').length;
  const intake=inv.filter(i=>i.status==='intake').length;
  const show=openShow();
  const totalValue=inv.filter(i=>i.status==='available').reduce((a,i)=>a+(Number(i.listPrice)||0),0);
  let showCard;
  if(show){ const st=computeSettlement(show);
    showCard='<div class="card"><h3>Current show: '+esc(show.name)+'</h3><div class="kpi" style="grid-template-columns:repeat(3,1fr)">'+
      kpi('Sales',money(st.totalRevenue))+kpi('Items sold',countSold(show))+kpi('Drawer (expected)',money(st.drawerExpected))+
      '</div><div class="row" style="margin-top:12px"><button class="gold" onclick="go(\'sell\')">Go to Sell</button>'+
      '<button class="blue" onclick="go(\'reports\')">Finalize / Reports</button></div></div>';
  } else { showCard='<div class="card"><h3>No show running</h3><p class="muted">Start a show to begin selling (drawer opens with the '+money(state.settings.cashFloat)+' float).</p><button class="gold" onclick="go(\'reports\')">Go to Reports to start a show</button></div>'; }
  return '<h2 class="page">Dashboard <small>'+new Date().toLocaleDateString()+' · acting as '+me().name+'</small></h2>'+
    '<div class="kpi">'+kpi('Available',avail)+kpi('In intake',intake)+kpi('Inventory value',money(totalValue))+kpi('Shows logged',state.shows.length)+'</div>'+
    '<div style="height:14px"></div>'+
    '<div class="card"><h3>Scan cards</h3><p class="muted" style="margin:2px 0 10px">Snap several Pokémon cards in a row — they identify in the background. Then review prices &amp; grades and add them all to inventory.</p>'+
    '<button class="gold" style="font-size:16px;padding:12px 18px" onclick="openCardScanner()">📷 Scan cards</button> '+
    '<button class="ghost" onclick="scanCardForPrice()">Quick price check</button></div>'+
    '<div style="height:14px"></div>'+showCard+
    '<div class="card"><h3>Quick actions</h3><div class="row">'+
    '<button onclick="go(\'add\')">＋ Add item</button><button onclick="go(\'sell\')">Sell</button>'+
    '<button onclick="go(\'labels\')">Print labels</button><button onclick="go(\'trades\')">Trades</button>'+
    '<button class="ghost" onclick="loadSample()">Load sample data</button></div></div>';
}
function kpi(label,v){return '<div class="card"><div class="big">'+v+'</div><div class="muted">'+label+'</div></div>';}
function countSold(show){let n=0;state.sales.filter(s=>s.showId===show.id&&s.status!=='voided').forEach(s=>s.lines.forEach(l=>{if(l.type!=='prize')n+=(l.qty||1);}));return n;}

/* -------- Inventory -------- */
let invFilter={q:'',owner:'',tab:'available'};
function viewInventory(){
  const all=state.inventory;
  const cnt={available:0,intake:0,sold:0,review:0};
  all.forEach(i=>{ if(i.status==='available')cnt.available++; else if(i.status==='intake'&&!i.needsReview)cnt.intake++; if(i.status==='sold'||i.status==='traded')cnt.sold++; if(i.needsReview)cnt.review++; });
  let items=all.slice().reverse();
  const tab=invFilter.tab;
  if(tab==='available')items=items.filter(i=>i.status==='available');
  else if(tab==='intake')items=items.filter(i=>i.status==='intake'&&!i.needsReview); // review items live only on the Review tab
  else if(tab==='review')items=items.filter(i=>i.needsReview);
  else if(tab==='sold')items=items.filter(i=>i.status==='sold'||i.status==='traded');
  const q=invFilter.q;
  if(q)items=items.filter(i=>smatch(i.name+' '+i.set+' '+i.number+' '+i.barcode+' '+(i.rarity||'')+' '+(i.grade||''),q));
  if(invFilter.owner)items=items.filter(i=>i.ownerId===invFilter.owner);
  const ownerOpts='<option value="">All owners</option>'+state.users.map(u=>'<option value="'+u.id+'"'+(invFilter.owner===u.id?' selected':'')+'>'+u.name+'</option>').join('');
  const stockCount=all.filter(i=>(!i.photo||i.stock)&&!i.realImage).length;
  const sub=(id,label)=>'<button class="'+(tab===id?'on':'')+'" onclick="invFilter.tab=\''+id+'\';render()">'+label+'</button>';
  const subtabs='<div class="subtabs">'+sub('available','In stock ('+cnt.available+')')+sub('intake','Intake ('+cnt.intake+')')+
    (cnt.review?sub('review','🔍 Review ('+cnt.review+')'):'')+sub('sold','Sold/Traded ('+cnt.sold+')')+sub('all','All ('+all.length+')')+'</div>';
  const rows=items.map(i=>'<tr>'+
    '<td><div class="invitem">'+photoThumb(i)+'<div><div>'+esc(i.name||'(unnamed)')+(i.needsReview?' <span class="reviewbadge">review</span>':'')+'</div>'+
      '<div class="muted">'+esc(i.set||'')+(i.number?' · #'+esc(i.number):'')+(i.language&&i.language!=='EN'?' · '+i.language:'')+(i.variance&&i.variance!=='Normal'?' · '+esc(i.variance):'')+'</div>'+
      '<div style="margin-top:3px">'+condPill(i.condition)+' '+(i.grade&&i.grade!=='Ungraded'?'<span class="tag">'+esc(i.grade)+'</span> ':'')+statusPill(i.status)+'</div></div></div></td>'+
    '<td><span class="pill owner">'+userName(i.ownerId)+'</span></td>'+
    '<td><span class="money">'+money(i.listPrice)+'</span>'+(i.priceOverride?' 🔒':'')+(i.costBasis?'<div class="muted">cost '+money(i.costBasis)+'</div>':'')+(i.suggestedPrice?'<div class="muted">sugg '+money(i.suggestedPrice)+'</div>':'')+'</td>'+
    '<td><div class="muted" style="font-family:monospace">'+esc(i.barcode)+'</div><div class="row" style="margin-top:6px">'+
      '<button class="sm" onclick="editItem(\''+i.id+'\')">Edit</button>'+
      (i.status==='available'?'<button class="sm gold" onclick="addBarcodeToCart(\''+i.barcode+'\')">Add to cart</button>':'')+
      ((i.status==='intake'&&i.needsReview)?'<button class="sm blue" onclick="finishIntake(\''+i.id+'\')">Confirm</button>':'')+
      ((i.status==='intake'&&!i.needsReview)?'<button class="sm blue" onclick="finishIntake(\''+i.id+'\')">Finish intake</button>':'')+
      '<button class="sm ghost" onclick="markWrongImage(\''+i.id+'\')" title="fetch a different image">🚫 Wrong pic</button>'+
      ((i.status==='available'||i.status==='intake')?'<button class="sm red" onclick="deleteItem(\''+i.id+'\')">Delete</button>':'')+
      '</div></td></tr>').join('');
  return '<h2 class="page">Inventory <small>'+items.length+' shown · each copy has its own barcode</small></h2>'+
    '<div class="card">'+subtabs+'<div class="grid2">'+
      '<label class="fld"><span>Search (partial — "char" finds Charizard)</span><input id="invSearch" value="'+esc(invFilter.q)+'" oninput="invFilter.q=this.value;ui.focusId=\'invSearch\';render()" placeholder="name, set, number, barcode"/></label>'+
      '<label class="fld"><span>Owner</span><select onchange="invFilter.owner=this.value;render()">'+ownerOpts+'</select></label>'+
    '</div><div class="row">'+(invFilter.q?'<button class="sm ghost" onclick="invFilter.q=\'\';render()">✕ clear search</button>':'')+
      '<button class="sm blue" onclick="searchByImage()">📷 Search by photo</button></div>'+
    '<div class="row" style="margin-top:8px"><button onclick="go(\'add\')">＋ Add item</button><button class="ghost" onclick="go(\'labels\')">Print labels</button>'+
      '<button class="blue" onclick="startImgJob()">🖼 Fetch real card images'+(stockCount?' ('+stockCount+')':'')+'</button>'+
      '</div><div class="muted" style="margin-top:6px">Tap a card image to zoom. Image fetch runs in the background — keep working or switch tabs. Wrong picture? Tap “🚫 Wrong pic” for the next match.</div></div>'+
    (items.length?'<div class="card"><table><thead><tr><th>Item</th><th>Owner</th><th>Price</th><th>Barcode / actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
      :'<div class="empty">Nothing here. <a onclick="go(\'add\')">Add an item</a> or <a onclick="loadSample()">load sample data</a>.</div>');
}
function photoThumb(i){return i.photo?'<img class="ph" style="cursor:zoom-in" onclick="zoomItem(\''+i.id+'\')" src="'+i.photo+'"/>':'<div class="ph">no photo</div>';}
function zoomItem(id){ const it=state.inventory.find(x=>x.id===id); if(!it||!it.photo)return;
  const w=document.createElement('div'); w.className='scanmodal'; w.style.cursor='zoom-out';
  w.innerHTML='<img src="'+it.photo+'" style="max-width:94vw;max-height:82vh;border-radius:14px;border:3px solid var(--gold)"/>'+
    '<div class="hint">'+esc(it.name||'')+(it.number?' · #'+esc(it.number):'')+(it.set?' · '+esc(it.set):'')+'</div>';
  w.onclick=()=>w.remove(); document.body.appendChild(w); }

/* ===== card images: shared DB + background fetch (pokemontcg.io → TCGdex), free ===== */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let imgJob={running:false,done:0,total:0,found:0,stop:false};
function startImgJob(){
  if(imgJob.running){ toast('Image fetch already running.'); return; }
  if(navigator.onLine===false){ toast('You look offline — connect to wifi to fetch images.'); return; }
  const items=state.inventory.filter(i=>(!i.photo||i.stock)&&!i.realImage);
  if(!items.length){ toast('All items already have real images.'); return; }
  imgJob={running:true,done:0,total:items.length,found:0,stop:false};
  toast('Fetching '+items.length+' image(s) in the background — keep working.');
  runImgJob(items);
}
function stopImgJob(){ imgJob.stop=true; }
async function runImgJob(items){
  updateImgChip();
  for(const it of items){
    if(imgJob.stop)break;
    try{ const got=await fetchOneItem(it); if(got)imgJob.found++; }catch(e){}
    imgJob.done++;
    if(imgJob.done%3===0){ save(); if(ui.authed&&ui.route==='inventory'){ /* light repaint of thumbs only via chip */ } }
    updateImgChip();
    await sleep(150);
  }
  imgJob.running=false; save(); updateImgChip();
  if(!imgJob.stop){ toast('Image fetch done — '+imgJob.found+' found of '+imgJob.total+'.'); }
  if(ui.authed&&ui.route==='inventory')render();
}
function updateImgChip(){ const c=el('imgchip'); if(!c)return;
  if(!imgJob.running){ c.style.display='none'; return; }
  c.style.display='flex';
  c.innerHTML='<span>🖼 Fetching images '+imgJob.done+'/'+imgJob.total+' · '+imgJob.found+' found</span><button class="red sm" onclick="stopImgJob()">Stop</button>';
}
/* fetch (or reuse) one item's image; returns true if an image was set */
async function fetchOneItem(it){
  // 1) reuse from our own image database first (instant, offline)
  const e=dbEntry(it);
  if(e && !(it.rejected||[]).includes(e.source==='fetch'?e.srcUrl:'manual')){
    it.photo=e.photo; it.stock=(e.source!=='manual'); it.realImage=true; it.imgSrc=e.srcUrl||'db'; return true;
  }
  if(navigator.onLine===false) return false;
  const rejected=new Set([...(it.rejected||[]), ...((state.imageDB[cardKey(it)]||{}).rejected||[])]);
  const cands=await lookupCandidates(it);
  const pick=cands.find(u=>!rejected.has(u));
  if(!pick) return false;
  const data=await toDataURL(pick);
  it.photo=data; it.stock=true; it.realImage=true; it.imgSrc=pick;
  dbSave(it,data,'fetch'); state.imageDB[cardKey(it)].srcUrl=pick;
  return true;
}
/* returns an ordered list of candidate image URLs (best match first) */
async function lookupCandidates(it){
  const out=[]; const number=(it.number||'').split('/')[0].trim();
  try{ const headers=state.settings.ptcgKey?{'X-Api-Key':state.settings.ptcgKey}:{};
    const q='name:"'+(it.name||'').replace(/"/g,'')+'"'+(number?(' number:'+number):'');
    const r=await fetch('https://api.pokemontcg.io/v2/cards?pageSize=12&q='+encodeURIComponent(q),{headers});
    if(r.ok){ const j=await r.json(); let data=(j.data||[]);
      if(it.set){ data=data.slice().sort((a,b)=>(b.set&&norm(b.set.name)===norm(it.set)?1:0)-(a.set&&norm(a.set.name)===norm(it.set)?1:0)); }
      data.forEach(c=>{ const u=c.images&&(c.images.large||c.images.small); if(u)out.push(u); }); }
  }catch(e){}
  try{ const lang=(it.language==='JP')?'ja':(it.language==='CN'?'zh-tw':'en');
    const r=await fetch('https://api.tcgdex.net/v2/'+lang+'/cards?name='+encodeURIComponent(it.name||''));
    if(r.ok){ let arr=await r.json(); if(Array.isArray(arr)){
      if(number)arr=arr.slice().sort((a,b)=>(String(b.localId)===number?1:0)-(String(a.localId)===number?1:0));
      arr.slice(0,12).forEach(c=>{ if(c.image)out.push(c.image+'/high.png'); }); } }
  }catch(e){}
  return out;
}
/* user says the picture is wrong → remember it as rejected, pull the next candidate */
async function markWrongImage(id){ const it=state.inventory.find(x=>x.id===id); if(!it)return;
  const bad=it.imgSrc||(it.photo&&it.photo.slice(0,40));
  it.rejected=it.rejected||[]; if(bad&&!it.rejected.includes(bad))it.rejected.push(bad);
  const k=cardKey(it); const dbe=state.imageDB[k]; if(dbe){ dbe.rejected=dbe.rejected||[]; if(bad&&!dbe.rejected.includes(bad))dbe.rejected.push(bad); if(dbe.srcUrl===bad){ delete dbe.photo; delete dbe.srcUrl; } }
  it.realImage=false; it.photo=stockImage(it); it.stock=true;
  save(); toast('Looking for a different picture…'); render();
  if(navigator.onLine===false){ toast('Offline — reconnect, then it will refetch.'); return; }
  const got=await fetchOneItem(it); save(); toast(got?'Got a different image.':'No other match found — upload one via Edit.'); if(ui.route==='inventory')render();
}
async function toDataURL(url){ try{ const r=await fetch(url); if(!r.ok)return url; const b=await r.blob();
  return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=()=>res(url);fr.readAsDataURL(b);}); }catch(e){ return url; } }
/* image fields for a brand-new item: reuse our saved DB image if we have one, else a placeholder */
function imageForNew(data){ const e=dbEntry(data); if(e)return {photo:e.photo,stock:(e.source!=='manual'),realImage:true,imgSrc:e.srcUrl||'db'}; return {photo:stockImage(data),stock:true}; }

/* -------- Add / Edit item (intake) -------- */
let editingId=null, pendingPhoto=null;
function viewAdd(){
  const it=editingId?state.inventory.find(i=>i.id===editingId):null;
  const g=(k,d)=>it?(it[k]??d):d;
  const sel=(id,opts,cur)=>'<select id="'+id+'">'+opts.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  const ownerSel='<select id="f_owner">'+state.users.map(u=>'<option value="'+u.id+'"'+((g('ownerId',state.currentUserId))===u.id?' selected':'')+'>'+u.name+'</option>').join('')+'</select>';
  return '<h2 class="page">'+(it?'Edit item':'Add item')+' <small>Photo only required if condition is NOT Near Mint · barcode auto-created</small></h2>'+
    '<div class="card"><div class="row noprint" style="margin-bottom:10px"><button class="blue" onclick="scanOnAdd()">📷 Scan barcode / UPC</button>'+
      '<button class="blue" onclick="scanCardFront()">🃏 Scan card front (auto-read)</button>'+
      '<button class="gold" onclick="scanCardForPrice()">💲 Scan → price check</button>'+
      '<span class="muted">barcode/UPC opens an existing label or fills the UPC; card-front reads the name/number for you to review; price check looks up market value</span></div>'+
    '<div class="grid2">'+
      fld('Category',sel('f_cat',CATEGORIES,g('category','Pokemon')))+
      fld('Set',inp('f_set',g('set',''),'e.g. Surging Sparks'))+
      fld('Card name / product',inp('f_name',g('name',''),'e.g. Pikachu ex'))+
      fld('Card number',inp('f_number',g('number',''),'e.g. 238/191'))+
      fld('Rarity',inp('f_rarity',g('rarity',''),'e.g. SIR'))+
      fld('Variance',sel('f_var',VARIANCES,g('variance','Normal')))+
      fld('Language',sel('f_lang',LANGUAGES,g('language','EN')))+
      fld('Grade',inp('f_grade',g('grade','Ungraded'),'Ungraded or e.g. PSA 10'))+
      fld('Condition (raw)',sel('f_cond',CONDITIONS,g('condition','NM')))+
      fld('Owner',ownerSel)+
      fld('What we paid (cost, private)',inp('f_cost',g('costBasis',''),'owner-only, never shown to others','number'))+
      fld('List price',inp('f_price',g('listPrice',''),'sale price','number'))+
      fld('UPC / scanned code',inp('f_upc',g('upc',''),'sealed product (optional)'))+
    '</div>'+
    '<label class="fld"><span>Photo (required only if condition is worse than NM · graded slabs get the cert number blurred)</span><input id="f_photo" type="file" accept="image/*" onchange="previewPhoto(this)"/></label>'+
    '<div id="photoPrev">'+(g('photo','')?'<img class="ph" style="width:80px;height:110px" src="'+g('photo','')+'"/>':'')+'</div>'+
    '<label class="fld"><span><input type="checkbox" id="f_override" style="width:auto;display:inline" '+(g('priceOverride',false)?'checked':'')+'/> Lock price (manual override — CSV/feeds won\'t change it; auto-on for graded)</span></label>'+
    '<hr class="sep"><div class="row">'+
      '<button class="gold" onclick="saveItem(true)">'+(it?'Save changes':'Save & print label')+'</button>'+
      (it?'':'<button class="blue" onclick="saveItem(false)">Save to intake</button>')+
      '<button class="ghost" onclick="cancelEdit()">Cancel</button>'+
      (it?'<button class="red right" onclick="deleteItem(\''+it.id+'\')">Delete</button>':'')+
    '</div></div>';
}
function previewPhoto(input){ const f=input.files[0]; if(!f)return; const r=new FileReader();
  r.onload=()=>{ const grade=val('f_grade'); const graded=grade&&grade.toLowerCase()!=='ungraded';
    if(graded){ openCertBlur(r.result, out=>setPendingPhoto(out)); } else { setPendingPhoto(r.result); } };
  r.readAsDataURL(f); }
function setPendingPhoto(dataUrl){ pendingPhoto=dataUrl; const p=el('photoPrev'); if(p)p.innerHTML='<img class="ph" style="width:80px;height:110px" src="'+pendingPhoto+'"/>'; }
function collectItem(){ return {category:val('f_cat'),set:val('f_set'),name:val('f_name'),number:val('f_number'),rarity:val('f_rarity'),variance:val('f_var'),language:val('f_lang'),grade:val('f_grade'),condition:val('f_cond'),ownerId:val('f_owner'),costBasis:num('f_cost'),listPrice:num('f_price'),priceOverride:el('f_override').checked,upc:val('f_upc')}; }
function needsPhoto(cond){ return cond && cond!=='NM'; }
function saveItem(makeAvailable){
  const data=collectItem(); if(!data.name){toast('Card name is required');return;}
  if(data.grade&&data.grade.toLowerCase()!=='ungraded')data.priceOverride=true;
  if(editingId){ const it=state.inventory.find(i=>i.id===editingId); Object.assign(it,data); it.needsReview=false;
    if(pendingPhoto){ it.photo=pendingPhoto; it.stock=false; it.realImage=true; it.imgSrc='manual'; dbSave(it,pendingPhoto,'manual'); }
    logChange('inventory','edited "'+(it.name||'item')+'" ('+it.barcode+')'); save();toast('Saved.');editingId=null;pendingPhoto=null;go('inventory');return; }
  let photo=pendingPhoto, fromDB=false;
  if(!photo){ const e=dbEntry(data); if(e){ photo=e.photo; data.stock=(e.source!=='manual'); data.realImage=true; data.imgSrc=e.srcUrl||'db'; fromDB=true; } } // reuse our saved image
  if(makeAvailable && needsPhoto(data.condition) && (!photo||data.stock)){ toast('Condition '+data.condition+' needs a real photo of THIS copy. Add one, or use "Save to intake".'); return; }
  if(!photo){ photo=stockImage(data); data.stock=true; } // generated placeholder as last resort
  const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:photo,stock:data.stock||false,suggestedPrice:0,status:makeAvailable?'available':'intake',dateAdded:Date.now()},data);
  if(pendingPhoto){ item.realImage=true; item.imgSrc='manual'; dbSave(item,pendingPhoto,'manual'); } // a real photo becomes this card's saved image
  state.inventory.push(item); logChange('inventory','added "'+(item.name||'item')+'" ('+item.barcode+')'+(makeAvailable?' to stock':' to intake')); save(); pendingPhoto=null;
  if(makeAvailable){ toast('Added & ready'+(fromDB?' (reused saved image)':'')+'. Printing label…'); printLabels([item.id]); } else toast('Saved to intake'+(fromDB?' (reused saved image)':'')+'.');
  go('inventory');
}
function scanOnAdd(){ openScanner(code=>{ code=(code||'').trim(); if(!code)return; const it=state.inventory.find(i=>i.barcode.toUpperCase()===code.toUpperCase()); if(it){ toast('Found existing item — opening to edit.'); editItem(it.id); } else { const f=el('f_upc'); if(f)f.value=code; toast('Scanned '+code+' → added to UPC field.'); } }); }

/* -------- Scan card FRONT → OCR (free, on-device) → Review tab -------- */
function scanCardFront(){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.capture='environment';
  inp.onchange=()=>{ const f=inp.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>ocrCardImage(r.result); r.readAsDataURL(f); }; inp.click(); }
/* OCR a card image then identify it via the collector number + set total. Shared by add-scan and image-search. */
async function readCardFromImage(dataUrl){ let text='';
  try{ if(navigator.onLine===false)throw new Error('offline');
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    if(!window.Tesseract)throw new Error('no ocr');
    const res=await window.Tesseract.recognize(dataUrl,'eng'); text=(res&&res.data&&res.data.text)||'';
  }catch(e){}
  const p=parseCardText(text);
  let name=p.name||'', set='', number=p.number||'', rarity='', matched=false;
  if(p.number){ const info=await identifyCard(parseInt(p.number,10), p.total, p.name);
    if(info){ name=info.name; set=info.set; number=info.number||p.number; rarity=info.rarity; matched=true; } }
  return {name,set,number,rarity,matched};
}
async function ocrCardImage(dataUrl){ toast('Reading the card… (first time downloads the reader)');
  const c=await readCardFromImage(dataUrl);
  const data={category:'Pokemon',set:c.set,name:c.name,number:c.number,rarity:c.rarity,variance:'Normal',language:'EN',grade:'Ungraded',condition:'NM',ownerId:state.currentUserId,costBasis:0,listPrice:0,priceOverride:false};
  const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:dataUrl,stock:false,realImage:true,imgSrc:'manual',suggestedPrice:0,status:'intake',needsReview:true,dateAdded:Date.now()},data);
  state.inventory.push(item); save();
  toast(c.matched?('Identified: '+c.name+(c.set?(' · '+c.set):'')+(c.number?(' #'+c.number):'')+' → review & confirm.'):(c.name?('Read "'+c.name+'" — couldn\'t match a set, please confirm.'):'Saved to Review — add the details.'));
  editItem(item.id);
}
/* upload a photo of a card → identify it → search inventory for it */
function searchByImage(){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.capture='environment';
  inp.onchange=()=>{ const f=inp.files[0]; if(!f)return; const r=new FileReader(); r.onload=async()=>{ toast('Reading the card to search…'); const c=await readCardFromImage(r.result);
    if(!c.name){ toast('Couldn\'t read the card — try a clearer, straight-on photo.'); return; }
    invFilter.q=c.name; invFilter.tab='all'; render(); toast('Searching inventory for "'+c.name+'".'); }; r.readAsDataURL(f); }; inp.click(); }
/* look up the real card by collector number + set total (and a rough name) via pokemontcg.io */
async function identifyCard(number,total,nameGuess){
  if(!number||navigator.onLine===false)return null;
  const headers=state.settings.ptcgKey?{'X-Api-Key':state.settings.ptcgKey}:{};
  const tryq=async q=>{ try{ const r=await fetch('https://api.pokemontcg.io/v2/cards?pageSize=60&q='+encodeURIComponent(q),{headers}); if(!r.ok)return []; const j=await r.json(); return j.data||[]; }catch(e){ return []; } };
  let data=[]; if(nameGuess)data=await tryq('number:'+number+' name:"'+nameGuess.replace(/"/g,'')+'"');
  if(!data.length)data=await tryq('number:'+number);
  if(!data.length)return null;
  let cands=data;
  if(total){ const t=data.filter(c=>c.set&&(c.set.printedTotal===total||c.set.total===total)); if(t.length)cands=t; } // "/078" pins the set (Pokémon GO = 78 cards)
  let pick=cands[0];
  if(nameGuess){ const ng=norm(nameGuess); const m=cands.find(c=>norm(c.name).includes(ng)||ng.includes(norm(c.name))); if(m)pick=m; }
  return {name:pick.name||'',set:(pick.set&&pick.set.name)||'',number:(pick.number||number)+(pick.set&&pick.set.printedTotal?('/'+pick.set.printedTotal):''),rarity:pick.rarity||''};
}
function parseCardText(text){ text=String(text||'');
  const m=text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/); let number='',total=0;
  if(m){ number=m[1]+'/'+m[2]; total=parseInt(m[2],10)||0; }
  const NOISE=/(evolves|stage|basic|weakness|resist|retreat|illus|pok[eé]mon|nintendo|creatures|game freak|ability|energy|trainer|flip a coin|damage|^no\.|©|\bhp\b|\bgo\b|wild|pigeon|put|attach|search|coin)/i;
  const lines=text.split(/\n/).map(s=>s.trim()).filter(Boolean);
  let name='',best=0;
  lines.slice(0,7).forEach(l=>{ if(NOISE.test(l))return; const a=l.replace(/[^A-Za-z .'\-]/g,'').trim(); const letters=a.replace(/[^A-Za-z]/g,''); if(letters.length>best&&letters.length>=4){best=letters.length;name=a;} });
  return {name,number,total};
}

/* ============================== Scan a card → instant price quote ==============================
   Identity + raw price come ONLY from pokemontcg.io (a Pokemon-only database), so a misread can
   never match a video game like the old PriceCharting lookup did. Graded numbers are ESTIMATES
   derived from the real ungraded market price via configurable multipliers. */
const GRADE_LADDER=[['Ungraded',1],['Grade 7',1.0],['Grade 8',1.25],['Grade 9',1.7],['Grade 9.5',2.4],['PSA 10',4.0],['BGS 10',5.5]];
function buyPct(){ const p=Number(state.settings&&state.settings.buyPct); return (p>0&&p<=100)?p:70; }

function scanCardForPrice(){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.capture='environment';
  inp.onchange=()=>{ const f=inp.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>priceFromImage(r.result); r.readAsDataURL(f); }; inp.click(); }

async function priceFromImage(dataUrl){
  if(navigator.onLine===false){ toast('You\'re offline — a price check needs internet.'); return; }
  let name='',number='',total=0;
  if(geminiKey()){
    toast('Reading the card with AI…');
    try{ const v=await aiIdentify(dataUrl); name=v.name||''; number=v.number||''; total=Number(v.setTotal)||0; }
    catch(e){ toast('Card reader failed: '+((e&&e.message)||e)); return; }   // loud, not silent — no garbage fallback when a key is set
  } else {
    toast('Reading the card… (no AI key set — add one free in Profile for accuracy)');
    let text='';
    try{ await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
      if(window.Tesseract){ const res=await window.Tesseract.recognize(dataUrl,'eng'); text=(res&&res.data&&res.data.text)||''; }
    }catch(e){}
    const p=parseCardText(text); name=p.name||''; number=p.number||''; total=p.total||0;
  }
  if(!number && (!name || name.length<3)){ toast('Couldn\'t read the card — try a straight-on, well-lit photo with the number (e.g. 065/086) showing.'); return; }
  toast('Looking up '+(name||('#'+number))+'…');
  const cands0=await lookupCard(name, number?parseInt(number,10):0, total); const card=cands0.length?cands0[0]:null;
  if(!card){ showPriceQuote({name:name||'',number:number||'',set:'',rarity:'',ungraded:0,unknown:true}, dataUrl); return; }
  showPriceQuote(card, dataUrl);
}
function geminiKey(){ return (state.settings&&state.settings.geminiKey)||(window.HOC_CONFIG&&window.HOC_CONFIG.GEMINI_API_KEY)||''; }
/* Different keys/regions have free quota on different models — try several and remember the one that works. */
const GEMINI_MODELS=['gemini-2.5-flash','gemini-2.0-flash','gemini-flash-latest','gemini-1.5-flash','gemini-1.5-flash-8b'];
async function aiIdentify(dataUrl){
  const key=geminiKey(); if(!key) throw new Error('no AI key — add a free one in Profile');
  const saved=(state.settings&&state.settings.geminiModel)||(window.HOC_CONFIG&&window.HOC_CONFIG.GEMINI_MODEL)||'';
  const list=[]; if(saved)list.push(saved); GEMINI_MODELS.forEach(m=>{ if(!list.includes(m))list.push(m); });
  let lastErr=null;
  for(const model of list){
    try{ const o=await geminiCall(dataUrl,key,model);
      if(state.settings && state.settings.geminiModel!==model){ state.settings.geminiModel=model; save(); }  // pin the working model
      return o;
    }catch(e){ lastErr=e; const msg=((e&&e.message)||'')+'';
      if(/\b(429|404)\b|quota|limit|not\s*found|not\s*available|unsupported|model/i.test(msg)) continue;  // model-specific → try next
      throw e;  // key/auth/other → stop
    }
  }
  const lm=((lastErr&&lastErr.message)||'')+'';
  if(/429|quota|limit/i.test(lm)) throw new Error('Your Google key has no free quota for these models right now. In Google AI Studio (aistudio.google.com) make sure the free tier is enabled, or pick a model under Profile → Card reader.');
  throw lastErr||new Error('AI reader failed');
}
/* Single Google Gemini vision call. THROWS a descriptive error on failure (so callers show the real reason). */
async function geminiCall(dataUrl,key,model){
  let media='image/jpeg', data=String(dataUrl||'');
  const m=data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s); if(m){ media=m[1]; data=m[2]; }
  if(!data) throw new Error('no image');
  model=model||'gemini-2.0-flash';
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+encodeURIComponent(key);
  const prompt='This is a photo of a trading card (usually Pokémon). Identify it and return JSON with these fields: '+
    'name = the printed card name exactly (e.g. "Mega Greninja ex"); '+
    'number = the LEFT part of the collector number as printed, digits only (e.g. "22" from "022/068"); '+
    'setTotal = the RIGHT part as an integer (e.g. 68 from "022/068"; use 0 if unreadable); '+
    'setName = the set name if visible, else ""; isPokemon = true/false. '+
    'Read carefully through foil glare and stylized fonts.';
  const body={ contents:[{parts:[{inline_data:{mime_type:media,data:data}},{text:prompt}]}],
    generationConfig:{ responseMimeType:'application/json', responseSchema:{ type:'OBJECT',
      properties:{ name:{type:'STRING'}, number:{type:'STRING'}, setTotal:{type:'INTEGER'}, setName:{type:'STRING'}, isPokemon:{type:'BOOLEAN'} },
      required:['name','number','setTotal','setName','isPokemon'] } } };
  let r;
  try{ r=await fetch(url,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); }
  catch(e){ throw new Error('network/CORS blocked ('+((e&&e.message)||e)+')'); }
  if(!r.ok){ let t=''; try{t=await r.text();}catch(_){ } let msg=''; try{ msg=((JSON.parse(t)||{}).error||{}).message||''; }catch(_){ }
    throw new Error('AI '+r.status+(msg?(' — '+msg):' — check your key in Profile')); }
  const j=await r.json();
  const txt=j&&j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts&&j.candidates[0].content.parts[0]&&j.candidates[0].content.parts[0].text;
  if(!txt) throw new Error('no result from AI');
  let o; try{ o=JSON.parse(txt); }catch(_){ throw new Error('bad AI response'); }
  if(!o||(!o.name&&!o.number)) throw new Error('card not recognized — try a clearer photo');
  return o;
}

/* resolve the real card (best match) from pokemontcg.io */
async function identifyCardFull(number,total,nameGuess){ const a=await identifyCandidates(number,total,nameGuess); return a.length?a[0]:null; }
/* return ranked candidate cards (best first) so the user can pick the right printing */
async function identifyCandidates(number,total,nameGuess){
  const headers=state.settings.ptcgKey?{'X-Api-Key':state.settings.ptcgKey}:{};
  const tryq=async q=>{ try{ const r=await fetch('https://api.pokemontcg.io/v2/cards?pageSize=60&q='+encodeURIComponent(q),{headers}); if(!r.ok)return []; const j=await r.json(); return j.data||[]; }catch(e){ return []; } };
  const nm=nameGuess?String(nameGuess).replace(/"/g,''):'';
  let data=[];
  if(number&&nm) data=await tryq('number:'+number+' name:"'+nm+'"');
  if(!data.length&&number) data=await tryq('number:'+number);
  if(!data.length&&nm) data=await tryq('name:"'+nm+'"');
  if(!data.length) return [];
  const ng=nm?norm(nm):'';
  data.sort((a,b)=>{
    const at=total&&a.set&&(a.set.printedTotal===total||a.set.total===total)?1:0;
    const bt=total&&b.set&&(b.set.printedTotal===total||b.set.total===total)?1:0;
    if(at!==bt)return bt-at;
    const an=ng&&(norm(a.name).includes(ng)||ng.includes(norm(a.name)))?1:0;
    const bn=ng&&(norm(b.name).includes(ng)||ng.includes(norm(b.name)))?1:0;
    return bn-an;
  });
  return data.slice(0,8).map(c=>cardFromPtcg(c,number));
}
/* turn a pokemontcg.io card object into our quote shape, picking the best market price */
function cardFromPtcg(pick,number){
  const prices=(pick.tcgplayer&&pick.tcgplayer.prices)||{};
  const order=['holofoil','reverseHolofoil','normal','1stEditionHolofoil','1stEdition','unlimitedHolofoil'];
  let ungraded=0, variant='';
  for(const k of order){ const v=prices[k]; if(v){ const m=v.market||v.mid||v.high||v.low; if(m){ungraded=m;variant=k;break;} } }
  if(!ungraded){ for(const k in prices){ const v=prices[k]; const m=v.market||v.mid||v.high; if(m){ungraded=m;variant=k;break;} } }
  if(!ungraded && pick.cardmarket && pick.cardmarket.prices){ const cm=pick.cardmarket.prices; const eur=cm.averageSellPrice||cm.trendPrice||0; if(eur){ ungraded=eur*1.08; variant='cardmarket(€)'; } }
  return { name:pick.name||'', set:(pick.set&&pick.set.name)||'',
    number:(pick.number||number)+(pick.set&&pick.set.printedTotal?('/'+pick.set.printedTotal):''),
    rarity:pick.rarity||'', image:(pick.images&&(pick.images.large||pick.images.small))||'',
    ungraded:Math.round((ungraded||0)*100)/100, variant,
    tcgUrl:(pick.tcgplayer&&pick.tcgplayer.url)||'', unknown:false };
}
/* ===== Scrydex (pro card DB + real graded prices) via the secure proxy; falls back to pokemontcg.io ===== */
function scrydexOn(){ return !!(window.HOC_CONFIG&&window.HOC_CONFIG.SUPABASE_URL) && (!state.settings || state.settings.useScrydex!==false); }
async function scrydexGet(path,params){
  const cfg=window.HOC_CONFIG||{}; const base=(cfg.SUPABASE_URL||'').replace(/\/$/,''); const key=cfg.SUPABASE_ANON_KEY||'';
  if(!base) throw new Error('no supabase url');
  const qs=new URLSearchParams(Object.assign({path:path},params||{})).toString();
  const r=await fetch(base+'/functions/v1/scrydex?'+qs,{headers:{'Authorization':'Bearer '+key,'apikey':key}});
  const j=await r.json().catch(()=>null);
  if(!r.ok) throw new Error('Scrydex '+r.status+((j&&j.error)?(' — '+j.error):''));
  return j;
}
function scTotal(c){ const e=c.expansion||c.set||{}; return e.total||e.printed_total||e.printedTotal||0; }
async function scrydexCandidates(name,number,total){
  const q=[]; if(number)q.push('number:'+number); if(name)q.push('name:"'+String(name).replace(/"/g,'')+'"');
  const j=await scrydexGet('cards',{q:q.join(' '),include:'prices',pageSize:30});
  const data=(j&&(j.data||j.cards||(Array.isArray(j)?j:null)))||[];
  if(!Array.isArray(data)||!data.length) return [];
  const ng=name?norm(name):'';
  data.sort((a,b)=>{ const at=total&&scTotal(a)===total?1:0, bt=total&&scTotal(b)===total?1:0; if(at!==bt)return bt-at;
    const an=ng&&(norm(a.name||'').includes(ng)||ng.includes(norm(a.name||'')))?1:0;
    const bn=ng&&(norm(b.name||'').includes(ng)||ng.includes(norm(b.name||'')))?1:0; return bn-an; });
  return data.slice(0,8).map(scrydexCard);
}
function scrydexCard(c){
  const e=c.expansion||c.set||{};
  let img=c.image||c.image_url||''; const ims=c.images;
  if(!img&&ims){ img=ims.large||ims.small||(Array.isArray(ims)?(ims[0]&&(ims[0].large||ims[0].url||ims[0])):'')||''; }
  const pr=scrydexPrices(c);
  return { name:c.name||'', set:e.name||'', number:(c.number||'')+(scTotal(c)?('/'+scTotal(c)):''),
    rarity:c.rarity||'', image:typeof img==='string'?img:(img&&(img.large||img.url))||'',
    ungraded:pr.ungraded, graded:pr.graded, tcgUrl:'', unknown:false, source:'scrydex', _raw:c };
}
/* Best-effort price extraction — defensive across likely shapes; refined once we see your real card JSON. */
function scrydexPrices(c){
  let ungraded=0; const graded={}; const num=v=>{ const n=Number(v&&typeof v==='object'?(v.market||v.value||v.price||v.mid):v); return isFinite(n)&&n>0?n:0; };
  const p=c.prices||c.pricing||c.market||null; if(!p) return {ungraded:0,graded:{}};
  if(Array.isArray(p)){
    p.forEach(row=>{ const comp=(row.company||row.grader||row.type||'').toString().toUpperCase(); const g=(row.grade!=null?String(row.grade):''); const val=num(row.market||row.price||row.value||row);
      if(!val)return; if(!comp&&!g){ if(!ungraded)ungraded=val; } else if(/RAW|UNGRADED/.test(comp)&&!g){ if(!ungraded)ungraded=val; } else { graded[(comp?comp+' ':'')+g]=val; } });
  } else if(typeof p==='object'){
    ['raw','ungraded','market','nm','near_mint'].forEach(k=>{ if(!ungraded&&p[k]!=null) ungraded=num(p[k]); });
    const g=p.graded||p.grades; if(g&&typeof g==='object'){ Object.keys(g).forEach(comp=>{ const gg=g[comp]; if(gg&&typeof gg==='object'){ Object.keys(gg).forEach(gr=>{ const val=num(gg[gr]); if(val)graded[comp.toUpperCase()+' '+gr]=val; }); } else { const val=num(gg); if(val)graded[comp.toUpperCase()]=val; } }); }
  }
  return { ungraded:Math.round(ungraded*100)/100, graded };
}
/* unified lookup: Scrydex first (if on), else pokemontcg.io */
async function lookupCard(name,number,total){
  if(scrydexOn()){ try{ const a=await scrydexCandidates(name,number,total); if(a.length)return a; }catch(e){ console.warn('[HoC] scrydex',e); } }
  return await identifyCandidates(number,total,name);
}
/* search links so the user can verify against real sold listings */
function ebaySold(q){ return 'https://www.ebay.com/sch/i.html?_nkw='+encodeURIComponent(q+' pokemon')+'&LH_Sold=1&LH_Complete=1'; }
function priceChartingLink(q){ return 'https://www.pricecharting.com/search-products?q='+encodeURIComponent(q+' pokemon')+'&type=prices'; }

let lastQuote=null;
function showPriceQuote(card,dataUrl){
  lastQuote={card,photo:dataUrl};
  const title=card.name||'Unknown card';
  const sub=[card.set,card.number?('#'+card.number):'',card.rarity].filter(Boolean).join(' · ');
  const img=card.image||dataUrl;
  const u=Number(card.ungraded)||0;
  let body;
  if(card.unknown || !u){
    const reason=card.unknown?'We couldn\'t match this exact card in the Pokémon database (very new sets can take a while to appear).':'No market price is listed for this card yet.';
    body='<div class="banner" style="margin:10px 0">'+reason+' Use the links below to check real sold prices, or add it manually.</div>';
  } else {
    const offer=u*buyPct()/100;
    const gmap=(card.graded)||{};
    const rows=GRADE_LADDER.map(([label,mult])=>{
      const real=(label==='Ungraded')?u:gmap[label];
      const val=(real!=null)?real:(label==='Ungraded'?u:u*mult);
      const est=(label!=='Ungraded')&&(real==null);
      return '<tr><td>'+label+(est?' <span class="muted">est.</span>':'')+'</td><td class="money" style="text-align:right">'+money(val)+'</td></tr>';
    }).join('');
    body='<table style="width:100%;margin:8px 0"><tbody>'+rows+'</tbody></table>'+
      '<div class="banner" style="margin:8px 0"><b>Suggested cash offer if buying: '+money(offer)+'</b><br><span class="muted">'+buyPct()+'% of ungraded market — change your % in Profile → Scan &amp; pricing.</span></div>'+
      '<div class="muted" style="font-size:12px">Ungraded = live market'+(card.variant?(' ('+card.variant+')'):'')+' from TCGplayer via pokemontcg.io. Graded values are estimates from that price — always confirm against real sold listings below.</div>';
  }
  const q=(card.name?card.name:'')+(card.number?(' '+String(card.number).split('/')[0]):'');
  const links='<div class="row" style="margin-top:10px;justify-content:center">'+
    '<a class="btn-link" target="_blank" rel="noopener" href="'+ebaySold(q)+'">eBay solds ↗</a>'+
    (card.tcgUrl?'<a class="btn-link" target="_blank" rel="noopener" href="'+card.tcgUrl+'">TCGplayer ↗</a>':'')+
    '<a class="btn-link" target="_blank" rel="noopener" href="'+priceChartingLink(q)+'">PriceCharting ↗</a></div>';
  const wrap=document.createElement('div'); wrap.className='scanmodal';
  wrap.innerHTML='<div class="card" style="max-width:460px;width:100%;max-height:92vh;overflow:auto;text-align:left">'+
    '<div class="row" style="gap:12px;align-items:flex-start">'+
      '<img src="'+img+'" style="width:96px;height:auto;border-radius:10px;border:2px solid var(--gold);background:#000"/>'+
      '<div style="flex:1;min-width:140px"><h3 style="margin:0 0 4px">'+esc(title)+'</h3><div class="muted">'+esc(sub||'—')+'</div></div></div>'+
    body+links+
    '<hr class="sep"><div class="row" style="justify-content:center">'+
      (card.name?'<button class="gold" id="pqAdd">Add to inventory</button>':'')+
      '<button class="ghost" id="pqClose">Close</button></div></div>';
  document.body.appendChild(wrap);
  const close=()=>wrap.remove();
  wrap.querySelector('#pqClose').onclick=close;
  wrap.addEventListener('click',e=>{ if(e.target===wrap)close(); });
  const addBtn=wrap.querySelector('#pqAdd'); if(addBtn)addBtn.onclick=()=>{ close(); addQuotedToInventory(); };
}
/* prefill the Add screen from the last quote (with its real photo + market price) */
function addQuotedToInventory(){
  if(!lastQuote)return; const c=lastQuote.card;
  const data={category:'Pokemon',set:c.set||'',name:c.name||'',number:c.number||'',rarity:c.rarity||'',variance:'Normal',language:'EN',grade:'Ungraded',condition:'NM',ownerId:state.currentUserId,costBasis:0,listPrice:Number(c.ungraded)||0,priceOverride:false};
  const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:lastQuote.photo,stock:false,realImage:true,imgSrc:'manual',suggestedPrice:Number(c.ungraded)||0,status:'intake',needsReview:true,dateAdded:Date.now()},data);
  state.inventory.push(item); logChange('inventory','added "'+(item.name||'item')+'" via price scan'); save();
  toast('Added to Review — confirm the details.'); editItem(item.id);
}

/* ============================== Continuous card scanner (Collectr-style) ==============================
   Snap many cards in a row; each identifies in the background (AI vision → pokemontcg.io). Then a
   review screen shows Your Picture vs the matched card, alternate matches, and live grade/condition
   pricing before you add them all to inventory. */
function openCardScanner(){
  if(!geminiKey() && !confirm('Tip: add a FREE AI vision key in Profile → "Card reader" for accurate scanning. Scan with the basic reader anyway?')) { go('settings'); return; }
  ui.scanQueue=ui.scanQueue||[];
  const wrap=document.createElement('div'); wrap.className='scanmodal'; wrap.id='cardScanModal';
  wrap.innerHTML=
    '<div class="hint" id="csHint">Point at a card and tap Capture. Keep going — cards identify while you scan.</div>'+
    '<video id="csVideo" playsinline autoplay muted style="width:min(92vw,460px);border:3px solid var(--gold);border-radius:14px;background:#000"></video>'+
    '<div class="row" style="margin-top:12px;justify-content:center"><button class="gold" id="csCap" style="font-size:17px;padding:14px 26px">📸 Capture</button>'+
      '<button class="blue" id="csReview">Review ('+ui.scanQueue.length+')</button>'+
      '<button class="red" id="csClose">Done</button></div>'+
    '<div id="csStrip" class="csstrip"></div>'+
    '<div class="row" style="justify-content:center;margin-top:6px"><label class="btn-link" style="cursor:pointer">Upload photos instead<input id="csFiles" type="file" accept="image/*" multiple style="display:none"></label></div>';
  document.body.appendChild(wrap);
  let stream=null; const video=wrap.querySelector('#csVideo');
  const cleanup=()=>{ try{ if(stream)stream.getTracks().forEach(t=>t.stop()); }catch(e){} wrap.remove(); };
  (async()=>{ try{ if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw 0;
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}); video.srcObject=stream; await video.play().catch(()=>{}); }
    catch(e){ const h=wrap.querySelector('#csHint'); if(h)h.textContent='Camera unavailable here — tap "Upload photos instead".'; } })();
  function grab(){ if(!video.videoWidth)return null; const W=Math.min(1000,video.videoWidth), s=W/video.videoWidth;
    const c=document.createElement('canvas'); c.width=W; c.height=Math.round(video.videoHeight*s);
    c.getContext('2d').drawImage(video,0,0,c.width,c.height); return c.toDataURL('image/jpeg',0.82); }
  wrap.querySelector('#csCap').onclick=()=>{ const d=grab(); if(!d){ toast('Camera still starting…'); return; } addScanItem(d);
    video.style.opacity='0.35'; setTimeout(()=>{ if(video)video.style.opacity='1'; },110); };
  wrap.querySelector('#csFiles').onchange=(e)=>{ [...e.target.files].forEach(f=>{ const r=new FileReader(); r.onload=()=>addScanItem(r.result); r.readAsDataURL(f); }); };
  wrap.querySelector('#csReview').onclick=()=>{ if(!ui.scanQueue.length){ toast('Capture at least one card first.'); return; } cleanup(); go('scanreview'); };
  wrap.querySelector('#csClose').onclick=()=>{ cleanup(); if(ui.scanQueue.length) go('scanreview'); };
  renderScanStrip();
}
function addScanItem(photo){
  ui.scanQueue=ui.scanQueue||[];
  const it={id:uid('scan'),photo:photo,status:'reading',card:null,candidates:[],read:null,grade:'Ungraded',variant:'Normal',condition:'NM',qty:1,ownerId:state.currentUserId,error:''};
  ui.scanQueue.push(it); renderScanStrip(); processScanItem(it);
}
async function processScanItem(it){
  try{
    let name='',number='',total=0;
    if(geminiKey()){ const v=await aiIdentify(it.photo); name=v.name||''; number=v.number||''; total=Number(v.setTotal)||0; }
    else { const c=await readCardFromImage(it.photo); name=c.name||''; const parts=(c.number||'').split('/'); number=(parts[0]||'').replace(/\D/g,''); total=parseInt(parts[1]||'0',10)||0; }
    it.read={name,number,total};
    const cands=await lookupCard(name, number?parseInt(number,10):0, total);
    if(cands.length){ it.candidates=cands; it.card=cands[0]; it.status='done'; }
    else { it.card={name:name,number:number,set:'',rarity:'',ungraded:0,unknown:true}; it.status='nomatch'; }
  }catch(e){ it.status='error'; it.error=(e&&e.message)||'failed'; }
  renderScanStrip(); if(ui.route==='scanreview')render();
}
function renderScanStrip(){ const m=el('cardScanModal'); if(!m)return;
  const s=m.querySelector('#csStrip'); if(s)s.innerHTML=(ui.scanQueue||[]).map(scanThumb).join('');
  const rv=m.querySelector('#csReview'); if(rv)rv.textContent='Review ('+(ui.scanQueue||[]).length+')'; }
function scanThumb(it){ const tag=it.status==='reading'?'⏳':(it.status==='done'?'✓':(it.status==='nomatch'?'?':'⚠'));
  return '<div class="csitem"><img src="'+it.photo+'"/><span class="cstag">'+tag+'</span></div>'; }
function scanItemPrice(it){ const c=it.card||{}; if(c.graded&&c.graded[it.grade]!=null) return c.graded[it.grade];  // real Scrydex graded price
  const u=Number(c.ungraded)||0; if(!u)return 0; const g=GRADE_LADDER.find(x=>x[0]===it.grade); return u*((g&&g[1])||1); }  // else estimate from raw
/* ---- Scan review screen ---- */
function viewScanReview(){
  const q=ui.scanQueue||[];
  if(!q.length) return '<h2 class="page">Scan review</h2><div class="card"><div class="empty">No scanned cards yet.</div><button class="gold" onclick="openCardScanner()">📷 Scan cards</button></div>';
  const ready=q.filter(it=>it.card&&!it.card.unknown).length;
  const working=q.filter(it=>it.status==='reading').length;
  return '<h2 class="page">Scan review <small>'+q.length+' scanned · '+ready+' identified'+(working?(' · '+working+' reading…'):'')+'</small></h2>'+
    '<div class="card noprint"><div class="row"><button class="gold" onclick="addAllScans()">＋ Add all to inventory</button>'+
      '<button class="blue" onclick="openCardScanner()">📷 Scan more</button>'+
      '<button class="ghost right" onclick="clearScans()">Clear all</button></div>'+
      '<div class="muted" style="margin-top:6px">Tap a grade to update the price. Wrong match? Pick an alternate below the card or edit the name/number and Re-look up.</div></div>'+
    q.map((it,i)=>scanReviewCard(it,i)).join('');
}
function scanReviewCard(it,i){
  if(it.status==='reading') return '<div class="card"><div class="srow"><img class="sthumb" src="'+it.photo+'"/><div style="flex:1"><b>Reading…</b><div class="muted">identifying this card</div></div><button class="sm red" onclick="discardScan('+i+')">✕</button></div></div>';
  if(it.status==='error') return '<div class="card"><div class="srow"><img class="sthumb" src="'+it.photo+'"/><div style="flex:1"><b style="color:var(--red)">Couldn\'t read</b><div class="muted">'+esc(it.error||'')+'</div><div style="margin-top:6px"><input id="sc_name'+i+'" placeholder="type card name"/> <input id="sc_num'+i+'" placeholder="number" style="max-width:90px"/> <button class="sm blue" onclick="relookupScan('+i+')">🔄 Look up</button></div></div><button class="sm red" onclick="discardScan('+i+')">✕</button></div></div>';
  const c=it.card||{name:'',number:'',ungraded:0,unknown:true};
  const price=scanItemPrice(it);
  const cand=(it.candidates&&it.candidates.length>1)?'<div class="candpick">'+it.candidates.map((cd,ci)=>'<img class="'+(it.card===cd?'on':'')+'" src="'+(cd.image||it.photo)+'" title="'+esc(cd.name||'')+' '+esc(cd.set||'')+'" onclick="pickScanCand('+i+','+ci+')"/>').join('')+'</div>':'';
  const grades=GRADE_LADDER.map(g=>'<span class="chip '+(it.grade===g[0]?'on':'')+'" onclick="setScan('+i+',\'grade\',\''+g[0]+'\')">'+g[0]+'</span>').join('');
  const opt=(arr,cur)=>arr.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('');
  const ownerSel='<select onchange="setScan('+i+',\'ownerId\',this.value)">'+state.users.map(u=>'<option value="'+u.id+'"'+(it.ownerId===u.id?' selected':'')+'>'+esc(u.name)+'</option>').join('')+'</select>';
  return '<div class="card">'+
    '<div class="srow">'+
      '<img class="sthumb" src="'+it.photo+'"/>'+(c.image?'<img class="sthumb" src="'+c.image+'"/>':'')+
      '<div style="flex:1;min-width:150px">'+
        '<input id="sc_name'+i+'" value="'+esc(c.name||'')+'" style="font-weight:800"/>'+
        '<div class="row" style="gap:6px;margin-top:5px"><input id="sc_num'+i+'" value="'+esc((c.number||'').split('/')[0])+'" placeholder="number" style="max-width:90px"/><button class="sm blue" onclick="relookupScan('+i+')">🔄 Re-look up</button></div>'+
        '<div class="muted" style="margin-top:4px">'+esc(c.set||(c.unknown?'no match — edit name/number then Re-look up':''))+(c.number?(' · #'+esc(c.number)):'')+'</div>'+
        '<div class="big" style="font-size:22px;margin-top:4px">'+money(price)+(it.grade!=='Ungraded'?' <span class="muted" style="font-size:12px">est.</span>':'')+'</div>'+
      '</div>'+
      '<button class="sm red" onclick="discardScan('+i+')">✕</button>'+
    '</div>'+cand+
    '<div style="margin-top:8px">'+grades+'</div>'+
    '<div class="grid3" style="margin-top:8px">'+
      '<label class="fld" style="margin:0"><span>Raw condition</span><select onchange="setScan('+i+',\'condition\',this.value)">'+opt(CONDITIONS,it.condition)+'</select></label>'+
      '<label class="fld" style="margin:0"><span>Variant</span><select onchange="setScan('+i+',\'variant\',this.value)">'+opt(VARIANCES,it.variant)+'</select></label>'+
      '<label class="fld" style="margin:0"><span>Qty</span><input type="number" min="1" value="'+(it.qty||1)+'" onchange="setScan('+i+',\'qty\',Math.max(1,parseInt(this.value)||1))"/></label>'+
    '</div>'+
    '<label class="fld" style="margin:8px 0 0"><span>Owner</span>'+ownerSel+'</label>'+
  '</div>';
}
function setScan(i,field,val){ const it=(ui.scanQueue||[])[i]; if(!it)return; it[field]=val; render(); }
function pickScanCand(i,ci){ const it=(ui.scanQueue||[])[i]; if(!it||!it.candidates)return; it.card=it.candidates[ci]; render(); }
function discardScan(i){ if(!ui.scanQueue)return; ui.scanQueue.splice(i,1); render(); }
function clearScans(){ if(!confirm('Discard all scanned cards?'))return; ui.scanQueue=[]; render(); }
async function relookupScan(i){ const it=(ui.scanQueue||[])[i]; if(!it)return;
  const nm=(val('sc_name'+i)||'').trim(); const num=(val('sc_num'+i)||'').replace(/\D/g,'');
  if(!nm && !num){ toast('Type a name or number first.'); return; }
  toast('Looking up '+(nm||('#'+num))+'…');
  const cands=await lookupCard(nm, num?parseInt(num,10):0, it.read&&it.read.total);
  if(cands.length){ it.candidates=cands; it.card=cands[0]; it.status='done'; }
  else { it.card={name:nm,number:num,set:'',rarity:'',ungraded:0,unknown:true}; it.status='nomatch'; toast('Still no match — you can add it manually.'); }
  render();
}
function addAllScans(){ const q=ui.scanQueue||[]; let added=0;
  q.forEach(it=>{ const c=it.card; const name=(c&&c.name)||(it.read&&it.read.name)||''; if(!name)return;
    const price=scanItemPrice(it);
    for(let n=0;n<(it.qty||1);n++){
      const data={category:'Pokemon',set:(c&&c.set)||'',name:name,number:(c&&c.number)||'',rarity:(c&&c.rarity)||'',variance:it.variant||'Normal',language:'EN',grade:it.grade||'Ungraded',condition:it.condition||'NM',ownerId:it.ownerId||state.currentUserId,costBasis:0,listPrice:Math.round(price*100)/100,priceOverride:(it.grade&&it.grade!=='Ungraded')};
      const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:it.photo,stock:false,realImage:true,imgSrc:'manual',suggestedPrice:Number(c&&c.ungraded)||0,status:'intake',needsReview:true,dateAdded:Date.now()},data);
      state.inventory.push(item); added++;
    }
  });
  if(!added){ toast('Nothing identified yet to add.'); return; }
  logChange('inventory','added '+added+' card(s) via scan'); save(); ui.scanQueue=[]; toast('Added '+added+' card(s) to Review.'); go('inventory');
}

/* -------- Graded slab: blur the certification number before saving -------- */
function openCertBlur(dataUrl,cb){ const img=new Image();
  img.onload=()=>{ const maxW=Math.min(window.innerWidth*0.9,420); const scale=Math.min(1,maxW/img.width); const cw=Math.round(img.width*scale), ch=Math.round(img.height*scale);
    const wrap=document.createElement('div'); wrap.className='scanmodal';
    wrap.innerHTML='<div class="hint">Graded slab — drag the box over the certification number, then Apply.</div>'+
      '<div class="blurwrap" id="bw"><canvas id="bcv" width="'+cw+'" height="'+ch+'"></canvas><div class="blurbox" id="bbox"></div></div>'+
      '<div class="row" style="margin-top:12px"><button class="gold" id="bApply">Apply blur &amp; use</button><button class="ghost" id="bSkip">Use without blur</button><button class="red" id="bCancel">Cancel</button></div>';
    document.body.appendChild(wrap);
    const cv=wrap.querySelector('#bcv'), ctx=cv.getContext('2d'); ctx.drawImage(img,0,0,cw,ch);
    const box=wrap.querySelector('#bbox');
    let bx=cw*0.18, by=ch*0.03, bw=cw*0.64, bh=Math.max(20,ch*0.10);
    const place=()=>{ box.style.left=bx+'px'; box.style.top=by+'px'; box.style.width=bw+'px'; box.style.height=bh+'px'; }; place();
    let drag=false,ox=0,oy=0; const pt=e=>{ const r=cv.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; };
    box.addEventListener('pointerdown',e=>{ drag=true; const p=pt(e); ox=p.x-bx; oy=p.y-by; try{box.setPointerCapture(e.pointerId);}catch(_){ } e.preventDefault(); });
    box.addEventListener('pointermove',e=>{ if(!drag)return; const p=pt(e); bx=Math.max(0,Math.min(cw-bw,p.x-ox)); by=Math.max(0,Math.min(ch-bh,p.y-oy)); place(); });
    box.addEventListener('pointerup',e=>{ drag=false; try{box.releasePointerCapture(e.pointerId);}catch(_){ } });
    const cleanup=()=>wrap.remove();
    wrap.querySelector('#bCancel').onclick=cleanup;
    wrap.querySelector('#bSkip').onclick=()=>{ cleanup(); cb(dataUrl); };
    wrap.querySelector('#bApply').onclick=()=>{ pixelate(ctx,bx,by,bw,bh); const out=cv.toDataURL('image/jpeg',0.9); cleanup(); cb(out); };
  };
  img.onerror=()=>cb(dataUrl); img.src=dataUrl;
}
function pixelate(ctx,x,y,w,h){ x=Math.round(x);y=Math.round(y);w=Math.round(w);h=Math.round(h); if(w<2||h<2)return; const block=Math.max(6,Math.round(w/14));
  for(let yy=y; yy<y+h; yy+=block){ for(let xx=x; xx<x+w; xx+=block){ try{ const d=ctx.getImageData(xx,yy,1,1).data; ctx.fillStyle='rgb('+d[0]+','+d[1]+','+d[2]+')'; ctx.fillRect(xx,yy,Math.min(block,x+w-xx),Math.min(block,y+h-yy)); }catch(e){} } }
  ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fillRect(x,y,w,h);
}
function editItem(id){editingId=id;pendingPhoto=null;go('add');}
function cancelEdit(){editingId=null;pendingPhoto=null;go('inventory');}
function deleteItem(id){ const it=state.inventory.find(i=>i.id===id); const nm=it?(it.name||'this item'):'this item'; if(!confirm('Delete "'+nm+'" permanently? This cannot be undone.'))return; state.inventory=state.inventory.filter(i=>i.id!==id);logChange('inventory','deleted "'+nm+'"');save();toast('Deleted.');editingId=null;go('inventory'); }
function finishIntake(id){ const it=state.inventory.find(i=>i.id===id); if(needsPhoto(it.condition)&&(!it.photo||it.stock)){editItem(id);toast('Condition '+it.condition+' needs a real photo before selling.');return;} it.status='available';it.needsReview=false;logChange('inventory','finalized "'+(it.name||'item')+'" to in-stock');save();toast('Item is now available.');render(); }

/* -------- Import CSV -------- */
const COND_MAP={'near mint':'NM','nm':'NM','mint':'NM','lightly played':'LP','lp':'LP','moderately played':'MP','mp':'MP','heavily played':'HP','hp':'HP','damaged':'DMG','dmg':'DMG','played':'MP'};
function mapCond(s){s=(s||'').toLowerCase().trim();return COND_MAP[s]||(CONDITIONS.includes((s||'').toUpperCase())?s.toUpperCase():'NM');}
function detectLang(name){const n=(name||'').toUpperCase();if(n.includes('(JP)')||n.includes(' JP'))return 'JP';if(n.includes('(CN)'))return 'CN';return 'EN';}
const norm=s=>String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]/g,'');
function gradeMatch(a,b){const ag=(a||'Ungraded').toLowerCase().trim(),bg=(b||'Ungraded').toLowerCase().trim();const au=ag==='ungraded'||ag==='',bu=bg==='ungraded'||bg==='';if(au&&bu)return true;return ag===bg;}
function rowMatches(it,r){ if(it.ownerId!==state.currentUserId)return false; if(norm(it.number)!==norm(r.number))return false;
  if(r.set && norm(it.set)!==norm(r.set) && !norm(it.set).includes(norm(r.set)) && !norm(r.set).includes(norm(it.set)))return false;
  if(it.condition!==r.condition)return false; if((it.language||'EN')!==r.language)return false; if(!gradeMatch(it.grade,r.grade))return false; return true; }
let csvRows=null, csvSummary=null;
function viewImport(){
  if(!csvRows){
    return '<h2 class="page">Import CSV <small>bulk price update / add inventory — tied to '+me().name+'</small></h2>'+
      (csvSummary?'<div class="card"><h3>Last import</h3><div class="banner">'+csvSummary+'</div><button class="ghost" onclick="csvSummary=null;render()">Dismiss</button></div>':'')+
      '<div class="card"><div class="banner">Upload a CSV export (e.g. Collectr). Matched to <b>your</b> inventory by set + number + variance + grade + condition + language.</div>'+
      '<label class="fld" style="margin-top:12px"><span>Choose CSV file</span><input id="csvFile" type="file" accept=".csv,text/csv" onchange="onCSVFile(this)"/></label>'+
      '<div class="row"><button class="ghost" onclick="downloadSampleCSV()">Download a sample CSV</button></div>'+
      '<div class="muted" style="margin-top:8px">Graded/locked items are never auto-repriced — CSV only updates their <i>suggested</i> price.</div></div>';
  }
  const matched=csvRows.filter(r=>r.matches.length>0).length, unmatched=csvRows.length-matched;
  const rows=csvRows.map((r,idx)=>{ const cls=r.removed?'opacity:.35':'';
    const tag=r.removed?'<span class="tag">removed</span>':(r.matches.length?'<span class="pill avail">match ×'+r.matches.length+'</span>':'<span class="pill sold">no match</span>');
    const actSel=r.locked?'<span class="tag">🔒 suggested only</span>':'<select onchange="csvRows['+idx+'].action=this.value">'+[['use','Use new price'],['keep','Keep current'],['skip','Skip']].map(([v,l])=>'<option value="'+v+'"'+(r.action===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';
    const cur=r.matches.length?money(r.matches[0].listPrice):'—';
    return '<tr style="'+cls+'"><td><div>'+esc(r.name)+'</div><div class="muted">'+esc(r.set)+' #'+esc(r.number)+' · '+r.condition+(r.language!=='EN'?' · '+r.language:'')+(r.grade&&r.grade!=='Ungraded'?' · '+esc(r.grade):'')+'</div><div style="margin-top:3px">'+tag+'</div></td>'+
      '<td class="money">'+cur+'</td><td style="width:110px"><input type="number" value="'+r.newPrice+'" onchange="csvRows['+idx+'].newPrice=parseFloat(this.value)||0"/></td>'+
      '<td>'+actSel+'</td><td>'+(r.removed?'<button class="sm ghost" onclick="csvRows['+idx+'].removed=false;render()">undo</button>':'<button class="sm red" onclick="csvRows['+idx+'].removed=true;render()">✕</button>')+'</td></tr>'; }).join('');
  return '<h2 class="page">Import CSV — review <small>'+matched+' matched · '+unmatched+' unmatched · '+me().name+'</small></h2>'+
    '<div class="card noprint"><div class="row"><button class="gold" onclick="commitCSV(\'update\')">Update prices only</button>'+
      '<button class="blue" onclick="commitCSV(\'add\')">Add new + update prices</button>'+
      '<button class="ghost right" onclick="csvRows=null;render()">Cancel / new file</button></div>'+
      '<div class="muted" style="margin-top:8px"><b>Update prices only</b>: change prices on items you own. <b>Add new + update</b>: also create unmatched rows as new inventory (into intake).</div></div>'+
    '<div class="card"><table><thead><tr><th>CSV item</th><th>Current</th><th>New price</th><th>Action</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function onCSVFile(input){ const f=input.files[0]; if(!f)return; const reader=new FileReader();
  reader.onload=()=>{ try{ const rows=parseCSV(reader.result); if(rows.length<2){toast('CSV looks empty.');return;} const H=rows[0];
    const ci={set:header(H,['set']),name:header(H,['product','name','card name']),number:header(H,['card number','number','card num','card nu']),variance:header(H,['variance','variant']),grade:header(H,['grade']),cond:header(H,['card condition','condition']),price:header(H,['market price','market','price']),override:header(H,['price override','override'])};
    if(ci.number<0&&ci.name<0){toast('Could not find a card name/number column.');return;}
    csvRows=rows.slice(1).map(cells=>{ const get=i=>i>=0?(cells[i]||'').trim():''; const name=get(ci.name),set=get(ci.set),number=get(ci.number);
      const grade=get(ci.grade)||'Ungraded',condition=mapCond(get(ci.cond)),language=detectLang(name),variance=get(ci.variance)||'Normal';
      const price=parseFloat((get(ci.price)||'0').replace(/[^0-9.\-]/g,''))||0; const ovRaw=get(ci.override).toLowerCase(); const csvOverride=ovRaw==='true'||ovRaw==='1'||ovRaw==='yes';
      const r={name,set,number,grade,condition,language,variance,newPrice:price,csvMarket:price,csvOverride,removed:false};
      r.matches=state.inventory.filter(it=>it.status!=='sold'&&rowMatches(it,r));
      const graded=(grade&&grade.toLowerCase()!=='ungraded'); const anyLocked=r.matches.some(m=>m.priceOverride);
      r.locked=csvOverride||graded||anyLocked; r.action=r.locked?'keep':'use'; return r; });
    toast('Parsed '+csvRows.length+' rows.'); render();
  }catch(e){ toast('Could not read that CSV.'); } };
  reader.readAsText(f);
}
function commitCSV(mode){ if(!csvRows)return; let updated=0,added=0,skipped=0,suggestedOnly=0;
  csvRows.forEach(r=>{ if(r.removed){skipped++;return;}
    if(r.matches.length){ r.matches.forEach(it=>{ it.suggestedPrice=r.csvMarket; if(r.locked){suggestedOnly++;return;} if(r.action==='use'){it.listPrice=r.newPrice;updated++;} else if(r.action==='skip'){skipped++;} }); }
    else { if(mode==='add'&&r.action!=='skip'){ const data={category:'Pokemon',set:r.set,name:r.name,number:r.number,rarity:'',variance:r.variance,language:r.language,grade:r.grade,condition:r.condition,ownerId:state.currentUserId,costBasis:0,listPrice:r.newPrice};
      state.inventory.push(Object.assign({id:uid('item'),barcode:genBarcodeId(),suggestedPrice:r.csvMarket,priceOverride:(r.grade&&r.grade.toLowerCase()!=='ungraded'),status:'intake',dateAdded:Date.now()},imageForNew(data),data)); added++; } else skipped++; } });
  logChange('import','CSV import — '+updated+' repriced, '+added+' added, '+skipped+' skipped'); save(); csvSummary=updated+' price(s) updated · '+added+' new item(s) added to intake · '+suggestedOnly+' locked/graded (suggested only) · '+skipped+' skipped.';
  csvRows=null; toast('Import complete.'); go('import');
}
function downloadSampleCSV(){ const csv='Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Quantity,Market Price,Price Override\n'+
  'Pokemon,Surging Sparks,Pikachu ex,238/191,SIR,Holofoil,Ungraded,Near Mint,1,349.00,FALSE\nPokemon,Prismatic Evolutions,Umbreon ex,161/131,SIR,Holofoil,Ungraded,Near Mint,1,1500.00,FALSE\nPokemon,151,Charizard ex,199/165,SIR,Holofoil,PSA 10,Near Mint,1,800.00,FALSE\nPokemon,Base Set,Blastoise,2/102,Holo,Holofoil,Ungraded,Lightly Played,1,225.00,FALSE\n';
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='house-of-cards-sample.csv';a.click();toast('Sample CSV downloaded.'); }

/* -------- Print labels (batch grid, NO price) -------- */
function viewLabels(){
  const items=state.inventory.filter(i=>i.status==='available'||i.status==='intake');
  const rows=items.map(i=>'<label class="fld" style="margin:4px 0"><span style="display:inline"><input type="checkbox" class="lblchk" value="'+i.id+'" style="width:auto;display:inline"/> '+esc(i.name)+' — '+esc(i.set)+' '+esc(i.number)+' ('+i.condition+') · '+i.barcode+'</span></label>').join('');
  return '<h2 class="page">Print labels <small>fits ~5 across a sheet — select, print, cut apart</small></h2>'+
    '<div class="card noprint"><div class="banner">Labels show name, set, number &amp; condition above a scannable barcode. <b>No price on the label</b> (so price changes never mean reprinting).</div>'+
    '<div class="row" style="margin:10px 0"><button class="sm" onclick="toggleAllLabels(true)">Select all</button><button class="sm ghost" onclick="toggleAllLabels(false)">Clear</button><button class="gold right" onclick="printSelectedLabels()">🖨 Print selected</button></div>'+
    (items.length?rows:'<div class="empty">No items to label.</div>')+'</div><div id="labelSheet"></div>';
}
function toggleAllLabels(on){document.querySelectorAll('.lblchk').forEach(c=>c.checked=on);}
function printSelectedLabels(){const ids=[...document.querySelectorAll('.lblchk:checked')].map(c=>c.value);if(!ids.length){toast('Select at least one item.');return;}printLabels(ids);}
function printLabels(ids){ const items=ids.map(id=>state.inventory.find(i=>i.id===id)).filter(Boolean);
  const html=items.map(i=>'<div class="barcode-label"><div class="nm">'+esc(i.name)+'<br>'+esc(i.set)+' '+esc(i.number)+'<br>'+i.condition+(i.grade&&i.grade!=='Ungraded'?' · '+esc(i.grade):'')+'</div>'+barcodeSVG(i.barcode,34)+'<div class="id">'+i.barcode+'</div></div>').join('');
  el('labelSheet').innerHTML='<div class="card"><div style="display:flex;flex-wrap:wrap">'+html+'</div></div>'; setTimeout(()=>window.print(),200);
}

/* -------- Sell (POS) -------- */
function viewSell(){
  const show=openShow();
  if(!show) return '<h2 class="page">Sell</h2><div class="card"><h3>No show running</h3><p class="muted">Start a show first.</p><button class="gold" onclick="go(\'reports\')">Go to Reports</button></div>';
  const lines=ui.cart.map((c,idx)=>cartLineHTML(c,idx)).join('');
  let panel='';
  if(ui.sellPanel==='manual') panel='<div class="card"><h3>Manual item</h3><div class="grid2">'+fld('Description',inp('m_desc','','penny sleeves, bulk lot…'))+fld('Price',inp('m_price','','','number'))+fld('Owner (whose sale)',userSel('m_owner'))+'</div><div class="row"><button class="gold" onclick="addManualLine()">Add to cart</button><button class="ghost" onclick="ui.sellPanel=null;render()">Cancel</button></div></div>';
  if(ui.sellPanel==='prize') panel='<div class="card"><h3>Prize plays</h3><div class="grid2">'+fld('How many plays',inp('p_qty','1','','number'))+fld('Total price',inp('p_price',state.settings.prizePrice,'','number'))+'</div><div class="muted">Default '+money(state.settings.prizePrice)+' each · splits 50/50 Reggie/Manny.</div><div class="row"><button class="gold" onclick="addPrizeLine()">Add to cart</button><button class="ghost" onclick="ui.sellPanel=null;render()">Cancel</button></div></div>';
  return '<h2 class="page">Sell <small>'+esc(show.name)+' · drawer float '+money(show.cashFloat)+'</small></h2>'+
    '<div class="card"><h3>Add to cart</h3><div class="scanbar"><input id="scanInput" placeholder="Scan or type barcode, then Enter" onkeydown="if(event.key===\'Enter\'){addBarcodeToCart(this.value);this.value=\'\';}"/>'+
      '<button class="gold" onclick="var i=el(\'scanInput\');addBarcodeToCart(i.value);i.value=\'\'">Add</button>'+
      '<button class="blue" onclick="openScanner(c=>addBarcodeToCart(c))">📷 Scan</button></div>'+
    '<div class="row" style="margin-top:10px"><button class="sm" onclick="ui.sellPanel=\'manual\';render()">Manual item</button><button class="sm" onclick="ui.sellPanel=\'prize\';render()">Prize play</button></div></div>'+
    panel+
    '<div class="card"><h3>Cart</h3>'+(ui.cart.length?lines:'<div class="empty">Cart is empty — scan a barcode to begin.</div>')+
      '<hr class="sep"><div class="row"><div class="big">'+money(cartTotal())+'</div>'+(ui.cart.length?'<button class="gold right" onclick="go(\'checkout\')">Payment →</button><button class="ghost" onclick="ui.cart=[];render()">Clear cart</button>':'')+'</div></div>';
}
function cartLineHTML(c,idx){ const adj=c.listPrice!=null&&Number(c.soldPrice)!==Number(c.listPrice);
  return '<div class="cart-line"><div style="flex:1"><div>'+esc(c.desc)+'</div><div class="muted">'+(c.type==='card'?('owner '+userName(c.ownerId)):c.type)+(adj?' · was '+money(c.listPrice):'')+'</div>'+
    (adj?'<input style="margin-top:5px;font-size:12px" value="'+esc(c.discountReason||'')+'" placeholder="reason for adjusted price (tracked)" onchange="ui.cart['+idx+'].discountReason=this.value"/>':'')+'</div>'+
    '<div style="width:110px"><input type="number" value="'+c.soldPrice+'" onchange="setCartPrice('+idx+',this.value)"/></div><button class="sm red" onclick="removeCart('+idx+')">✕</button></div>';
}
function addBarcodeToCart(code){ code=(code||'').trim().toUpperCase(); if(!code)return; const it=state.inventory.find(i=>i.barcode.toUpperCase()===code);
  if(!it){toast('No item with barcode '+code);return;} if(it.status==='sold'){toast('That copy is already sold.');return;} if(it.status==='intake'){toast('That item is still in intake.');return;}
  if(ui.cart.some(c=>c.itemId===it.id)){toast('Already in cart.');return;} pingWantList(it);
  ui.cart.push({itemId:it.id,type:'card',desc:it.name+' '+(it.number||'')+' ('+it.condition+')',ownerId:it.ownerId,listPrice:Number(it.listPrice)||0,soldPrice:Number(it.listPrice)||0,costBasis:Number(it.costBasis)||0,discountReason:''}); render(); toast('Added: '+it.name);
}
function addManualLine(){ const desc=val('m_desc'); if(!desc){toast('Enter a description.');return;} const price=num('m_price'); ui.cart.push({itemId:null,type:'manual',desc:desc,ownerId:val('m_owner'),listPrice:price,soldPrice:price,costBasis:0,discountReason:''}); ui.sellPanel=null; render(); }
function addPrizeLine(){ const qty=parseInt(val('p_qty'))||1; const price=num('p_price'); ui.cart.push({itemId:null,type:'prize',desc:qty+' prize play(s)',ownerId:null,qty:qty,listPrice:state.settings.prizePrice*qty,soldPrice:price,costBasis:0,discountReason:''}); ui.sellPanel=null; render(); }
function setCartPrice(idx,v){ const c=ui.cart[idx]; const np=parseFloat(v)||0; c.soldPrice=np; if(np>=Number(c.listPrice||0))c.discountReason=''; render(); /* an inline "reason" field appears on adjusted lines */ }
function removeCart(idx){ui.cart.splice(idx,1);render();}
function cartTotal(){return ui.cart.reduce((a,c)=>a+(Number(c.soldPrice)||0),0);}

/* -------- Checkout -------- */
function viewCheckout(){ const total=cartTotal(); const paid=ui.cartPayments.reduce((a,p)=>a+(Number(p.amount)||0),0); const remain=total-paid;
  const method=ui.checkoutMethod||'cash'; const needZelle=state.paymentAccounts[method]==='prompt';
  const pays=ui.cartPayments.map((p,idx)=>'<div class="cart-line"><div style="flex:1">'+METHOD_LABEL[p.method]+(p.receivedById?' → '+userName(p.receivedById):(state.paymentAccounts[p.method]!=='drawer'?' → '+userName(state.paymentAccounts[p.method]):' → drawer'))+'</div><div class="money">'+money(p.amount)+'</div><button class="sm red" onclick="ui.cartPayments.splice('+idx+',1);render()">✕</button></div>').join('');
  return '<h2 class="page">Payment <small>total due '+money(total)+'</small></h2>'+
    '<div class="card"><h3>Add payment</h3><div class="grid3">'+
    '<label class="fld"><span>Method</span><select id="payMethod" onchange="ui.checkoutMethod=this.value;render()">'+METHODS.map(m=>'<option value="'+m+'"'+(m===method?' selected':'')+'>'+METHOD_LABEL[m]+'</option>').join('')+'</select></label>'+
    '<label class="fld"><span>Amount</span><input id="payAmount" type="number" value="'+(remain>0?remain.toFixed(2):'')+'"/></label>'+
    (needZelle?'<label class="fld"><span>Whose Zelle received it?</span>'+userSel('payZelle')+'</label>':'<div></div>')+
    '</div><button class="gold" onclick="addPayment()">Add payment</button></div>'+
    '<div class="card"><h3>Payments</h3>'+(ui.cartPayments.length?pays:'<div class="muted">None yet.</div>')+'<hr class="sep"><div>Paid <span class="money">'+money(paid)+'</span> · Remaining <span class="money" style="color:'+(Math.abs(remain)<0.005?'var(--ok)':'var(--gold)')+'">'+money(remain)+'</span></div></div>'+
    '<div class="row"><button class="blue" onclick="go(\'sell\')">← Back to cart</button><button class="gold right" onclick="completeSale()">✔ Complete sale</button></div>';
}
function addPayment(){ const method=val('payMethod'); let amount=parseFloat(val('payAmount'))||0; if(amount<=0){toast('Enter an amount.');return;} let receivedById=null;
  if(state.paymentAccounts[method]==='prompt'){ receivedById=val('payZelle')||state.currentUserId; } ui.cartPayments.push({method,amount,receivedById}); render(); }
function completeSale(){ const total=cartTotal(); const paid=ui.cartPayments.reduce((a,p)=>a+(Number(p.amount)||0),0);
  if(!ui.cart.length){toast('Cart empty.');return;} if(Math.abs(total-paid)>0.005){ if(!confirm('Payments ('+money(paid)+') don\'t match total ('+money(total)+'). Record anyway?'))return; }
  const show=openShow(); if(!show){toast('No open show.');return;}
  const sale={id:uid('sale'),showId:show.id,createdById:state.currentUserId,createdAt:Date.now(),status:'completed',
    lines:ui.cart.map(c=>({id:uid('ln'),itemId:c.itemId,type:c.type,desc:c.desc,ownerId:c.ownerId,qty:c.qty||1,listPrice:c.listPrice,soldPrice:Number(c.soldPrice)||0,costBasis:c.costBasis||0,discountReason:c.discountReason||''})),
    payments:ui.cartPayments.slice()};
  state.sales.push(sale); ui.cart.forEach(c=>{ if(c.itemId){const it=state.inventory.find(i=>i.id===c.itemId); if(it)it.status='sold';} });
  logChange('sales','rang up '+sale.lines.length+' line(s) — '+money(total)); ui.cart=[];ui.cartPayments=[];save();toast('Sale recorded ✔');go('sell');
}

/* -------- Trades -------- */
function viewTrades(){
  const list=state.trades.slice().reverse().map(t=>{ const out=t.outItems.reduce((a,i)=>a+(Number(i.value)||0),0); const credit=t.inItems.reduce((a,i)=>a+(Number(i.tradeValue)||0),0); const market=t.inItems.reduce((a,i)=>a+(Number(i.marketPrice)||0),0); const pct=out>0?Math.round((credit/out)*100):0;
    return '<div class="card"><div class="row"><b>Trade '+new Date(t.createdAt).toLocaleDateString()+'</b><span class="right tag">our out '+money(out)+' · credit given '+money(credit)+' · incoming market '+money(market)+' · trading at '+pct+'%</span></div>'+
      '<div class="grid2"><div><div class="muted">We gave (out):</div>'+(t.outItems.map(i=>'• '+esc(i.desc)+' — '+money(i.value)+' ('+userName(i.ownerId)+')').join('<br>')||'—')+'</div>'+
      '<div><div class="muted">We received (in):</div>'+(t.inItems.map(i=>'• '+esc(i.name)+' '+esc(i.number)+' — credit '+money(i.tradeValue)+' / market '+money(i.marketPrice)).join('<br>')||'—')+'</div></div>'+
      (t.buyout&&t.buyout.payerId?'<div class="banner" style="margin-top:8px">Buyout: '+userName(t.buyout.payerId)+' keeps incoming inventory, pays '+Object.entries(t.buyout.payees||{}).map(([id,a])=>userName(id)+' '+money(a)).join(', ')+' at finalize.</div>':'')+
      '<div class="row" style="margin-top:10px"><button class="sm red" onclick="deleteTrade(\''+t.id+'\')">Delete trade</button></div></div>'; }).join('');
  return '<h2 class="page">Trades <small>customer never sees our values; internal shows both sides + %</small></h2>'+
    '<div class="card noprint"><button class="gold" onclick="startTrade()">＋ New trade</button></div>'+
    (state.trades.length?list:'<div class="empty">No trades logged.</div>');
}
function startTrade(){ const show=openShow(); ui.tradeDraft={out:[],in:[],keeperId:state.currentUserId,search:''}; ui.inForm={}; go('newtrade'); if(!show)toast('Tip: start a show so buyouts settle in that show\'s report.'); }
function viewNewTrade(){ const d=ui.tradeDraft; if(!d){go('trades');return '';}
  const q=d.search.toLowerCase();
  let pool=state.inventory.filter(i=>i.status==='available'&&!d.out.some(o=>o.itemId===i.id));
  if(q)pool=pool.filter(i=>smatch(i.name+' '+i.set+' '+i.number,q));
  const poolRows=pool.slice(0,40).map(i=>'<div class="pickrow"><div style="flex:1">'+esc(i.name)+' '+esc(i.number)+' <span class="muted">'+esc(i.set)+' · '+i.condition+' · '+userName(i.ownerId)+'</span></div><div class="money">'+money(i.listPrice)+'</div><button class="sm gold" onclick="tradeAddOut(\''+i.id+'\')">Add</button></div>').join('');
  const outRows=d.out.map((o,idx)=>'<div class="pickrow"><div style="flex:1">'+esc(o.desc)+' <span class="muted">'+userName(o.ownerId)+'</span></div><div class="money">'+money(o.value)+'</div><button class="sm red" onclick="ui.tradeDraft.out.splice('+idx+',1);render()">✕</button></div>').join('');
  const inRows=d.in.map((it,idx)=>'<div class="pickrow"><div style="flex:1">'+esc(it.name)+' '+esc(it.number)+' <span class="muted">'+esc(it.set)+(it.language!=='EN'?' · '+it.language:'')+'</span></div><div class="muted">credit '+money(it.tradeValue)+' / market '+money(it.marketPrice)+'</div><button class="sm red" onclick="ui.tradeDraft.in.splice('+idx+',1);render()">✕</button></div>').join('');
  const outVal=d.out.reduce((a,o)=>a+o.value,0), credit=d.in.reduce((a,i)=>a+(Number(i.tradeValue)||0),0); const pct=outVal>0?Math.round(credit/outVal*100):0;
  const owners=[...new Set(d.out.map(o=>o.ownerId))];
  const buyoutBlock=owners.length>1?'<div class="card"><h3>Buyout (multiple owners gave items)</h3><label class="fld"><span>Who keeps the incoming inventory & buys the others out?</span>'+userSel('t_keeper',d.keeperId)+'</label><div class="muted">Others get paid their outgoing value at finalize.</div></div>':'';
  return '<h2 class="page">New trade <small>trading at '+pct+'% (credit '+money(credit)+' for our '+money(outVal)+')</small></h2>'+
    '<div class="card"><h3>1 · What we GIVE (from our inventory)</h3>'+
      '<div class="scanbar"><input id="tradeSearch" value="'+esc(d.search)+'" oninput="ui.tradeDraft.search=this.value;ui.focusId=\'tradeSearch\';render()" placeholder="Search inventory by name/set/number"/><button class="blue" onclick="openScanner(c=>tradeAddOutByBarcode(c))">📷 Scan</button></div>'+
      '<div style="max-height:230px;overflow:auto;margin-top:8px">'+(poolRows||'<div class="muted">No matches.</div>')+'</div>'+
      '<hr class="sep"><div class="muted">Selected to give ('+d.out.length+'):</div>'+(outRows||'<div class="muted">none yet</div>')+'</div>'+
    '<div class="card"><h3>2 · What we RECEIVE (their cards)</h3><div class="grid3">'+
      fld('Card name',inp('in_name','','e.g. Charizard ex'))+fld('Set name',inp('in_set','',''))+fld('Card number',inp('in_number','',''))+
      fld('Language','<select id="in_lang">'+LANGUAGES.map(l=>'<option'+(l==='EN'?' selected':'')+'>'+l+'</option>').join('')+'</select>')+
      fld('Trade value given (our cost)',inp('in_tradeval','','what we credited','number'))+
      fld('Market price',inp('in_market','','current market','number'))+
    '</div><div class="row"><button class="blue" onclick="tradeAddIn()">＋ Add this card</button></div>'+
      '<hr class="sep"><div class="muted">Receiving ('+d.in.length+'):</div>'+(inRows||'<div class="muted">none yet</div>')+'</div>'+
    buyoutBlock+
    '<div class="card"><div class="muted">Incoming cards become inventory (owner = '+(owners.length>1?'the buyer':userName(owners[0]||state.currentUserId))+') with your cost set to the trade value given — so we always know what we have in it.</div>'+
      '<div class="row" style="margin-top:10px"><button class="gold" onclick="saveTrade()">Save trade</button><button class="ghost" onclick="ui.tradeDraft=null;go(\'trades\')">Cancel</button></div></div>';
}
function tradeAddOut(itemId){ const it=state.inventory.find(i=>i.id===itemId); if(!it)return; ui.tradeDraft.out.push({itemId:it.id,desc:it.name+' '+(it.number||''),value:Number(it.listPrice)||0,ownerId:it.ownerId}); render(); }
function tradeAddOutByBarcode(code){ const it=state.inventory.find(i=>i.barcode.toUpperCase()===(code||'').trim().toUpperCase()); if(!it){toast('No match for '+code);return;} if(it.status!=='available'){toast('That item isn\'t available.');return;} if(ui.tradeDraft.out.some(o=>o.itemId===it.id)){toast('Already added.');return;} tradeAddOut(it.id); }
function tradeAddIn(){ const name=val('in_name'); if(!name){toast('Enter the card name.');return;} ui.tradeDraft.in.push({name,set:val('in_set'),number:val('in_number'),language:val('in_lang'),tradeValue:num('in_tradeval'),marketPrice:num('in_market'),condition:'NM'}); render(); }
function saveTrade(){ const d=ui.tradeDraft; if(!d.out.length&&!d.in.length){toast('Add at least one item.');return;}
  const owners=[...new Set(d.out.map(o=>o.ownerId))]; let buyout=null; let keeperId=owners[0]||state.currentUserId;
  if(owners.length>1){ keeperId=val('t_keeper')||d.keeperId; const payees={}; owners.filter(o=>o!==keeperId).forEach(o=>{ payees[o]=d.out.filter(x=>x.ownerId===o).reduce((a,x)=>a+x.value,0); }); buyout={payerId:keeperId,payees}; }
  const outItemIds=d.out.map(o=>o.itemId); const inItemIds=[];
  d.in.forEach(it=>{ const data={category:'Pokemon',set:it.set,name:it.name,number:it.number,rarity:'',variance:'Normal',language:it.language,grade:'Ungraded',condition:it.condition||'NM',ownerId:keeperId,costBasis:Number(it.tradeValue)||0,listPrice:Number(it.marketPrice)||0};
    const inv=Object.assign({id:uid('item'),barcode:genBarcodeId(),suggestedPrice:Number(it.marketPrice)||0,priceOverride:false,status:'intake',dateAdded:Date.now(),fromTrade:true},imageForNew(data),data); state.inventory.push(inv); inItemIds.push(inv.id); });
  d.out.forEach(o=>{ const it=state.inventory.find(i=>i.id===o.itemId); if(it)it.status='traded'; });
  const show=openShow();
  state.trades.push({id:uid('trade'),showId:show?show.id:null,createdAt:Date.now(),outItems:d.out.slice(),inItems:d.in.slice(),buyout,keeperId,outItemIds,inItemIds});
  logChange('trades','logged a trade — gave '+d.out.length+', received '+d.in.length); ui.tradeDraft=null; save(); toast('Trade saved. Incoming cards added to intake.'); go('trades');
}
function deleteTrade(id){ const t=state.trades.find(x=>x.id===id); if(!t)return; if(!confirm('Delete this trade? Outgoing items go back to available; incoming items (if unsold) are removed.'))return;
  (t.outItemIds||[]).forEach(iid=>{ const it=state.inventory.find(i=>i.id===iid); if(it&&it.status==='traded')it.status='available'; });
  (t.inItemIds||[]).forEach(iid=>{ const it=state.inventory.find(i=>i.id===iid); if(it&&it.status!=='sold')state.inventory=state.inventory.filter(x=>x.id!==iid); });
  state.trades=state.trades.filter(x=>x.id!==id); logChange('trades','deleted a trade & reverted items'); save(); toast('Trade deleted & reverted.'); render();
}

/* -------- Wish list -------- */
function pingWantList(item){ state.wantlist.forEach(w=>{ const hay=item.name+' '+(item.set||'')+' '+(item.number||''); const needle=w.text+' '+(w.set||'')+' '+(w.number||'');
  if(smatch(hay,w.text)&&(!w.number||norm(w.number)===norm(item.number))&&w.userId!==state.currentUserId){ toast('🔔 '+userName(w.userId)+' wants this: '+w.text); } }); }
let wishQ='';
function viewWishlist(){ let list=state.wantlist.slice().reverse();
  if(wishQ)list=list.filter(w=>smatch((w.text+' '+(w.set||'')+' '+(w.number||'')+' '+userName(w.userId)),wishQ));
  const rows=list.map(w=>'<div class="cart-line"><div style="flex:1"><b>'+esc(w.text)+'</b>'+(w.qty&&w.qty>1?' <span class="tag">×'+w.qty+'</span>':'')+
      '<div class="muted">'+(w.category?esc(w.category)+' · ':'')+(w.set?esc(w.set)+' ':'')+(w.number?'#'+esc(w.number)+' ':'')+'· wanted by '+userName(w.userId)+(w.maxPrice?' · up to '+money(w.maxPrice):'')+(w.note?' · '+esc(w.note):'')+'</div></div>'+
      '<button class="sm red" onclick="delWant(\''+w.id+'\')">✕</button></div>').join('');
  return '<h2 class="page">Wish list <small>when anyone scans/sells a match, the wanter gets pinged</small></h2>'+
    '<div class="card"><h3>Add a card you\'re hunting</h3><div class="grid3">'+
      fld('Card name',inp('w_text','','e.g. Umbreon VMAX'))+
      fld('Set (optional)',inp('w_set','','e.g. Evolving Skies'))+
      fld('Card number (optional)',inp('w_number','','e.g. 215/203'))+
      fld('Category',('<select id="w_cat">'+CATEGORIES.map(c=>'<option'+(c==='Pokemon'?' selected':'')+'>'+c+'</option>').join('')+'</select>'))+
      fld('How many',inp('w_qty','1','','number'))+
      fld('Max price (optional)',inp('w_max','','budget','number'))+
    '</div><label class="fld"><span>Note (optional)</span><input id="w_note" placeholder="condition, foil only, etc."/></label>'+
    '<button class="gold" onclick="addWant()">Add to my wish list</button></div>'+
    '<div class="card"><label class="fld"><span>Search wish list (partial)</span><input id="wishSearch" value="'+esc(wishQ)+'" oninput="wishQ=this.value;ui.focusId=\'wishSearch\';render()" placeholder="name, set, number"/></label></div>'+
    (list.length?'<div class="card">'+rows+'</div>':'<div class="empty">Nothing on the wish list yet.</div>'); }
function addWant(){ const t=val('w_text'); if(!t){toast('Enter a card name.');return;}
  state.wantlist.push({id:uid('want'),userId:state.currentUserId,text:t,set:val('w_set'),number:val('w_number'),category:val('w_cat'),qty:parseInt(val('w_qty'))||1,maxPrice:num('w_max'),note:val('w_note')});
  save();toast('Added to wish list.');render(); }
function delWant(id){state.wantlist=state.wantlist.filter(w=>w.id!==id);save();render();}

/* -------- Sold history -------- */
let histQ='';
function viewHistory(){ const sold=[];
  state.sales.filter(s=>s.status!=='voided').forEach(s=>s.lines.forEach(l=>{ if(l.type!=='prize') sold.push({...l,when:s.createdAt,payMethods:s.payments.map(p=>METHOD_LABEL[p.method]).join('+')}); }));
  let rows=sold.sort((a,b)=>b.when-a.when); if(histQ)rows=rows.filter(r=>smatch(r.desc+' '+userName(r.ownerId),histQ));
  const freq={}; sold.forEach(r=>{const k=r.desc.replace(/\s+\(.*\)$/,'').trim();freq[k]=(freq[k]||0)+1;}); const top=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const trh=top.map(([k,n])=>'<span class="tag" style="margin:3px">'+esc(k)+' ×'+n+'</span>').join(' ');
  const body=rows.map(r=>'<tr><td>'+new Date(r.when).toLocaleDateString()+'</td><td>'+esc(r.desc)+'</td><td>'+userName(r.ownerId)+'</td><td class="money">'+money(r.soldPrice)+'</td><td class="muted">'+(r.discountReason?'↓ '+esc(r.discountReason):'')+'</td><td class="muted">'+r.payMethods+'</td></tr>').join('');
  return '<h2 class="page">Sold history <small>'+sold.length+' line items sold</small></h2>'+
    (top.length?'<div class="card"><h3>Trending (sells most often)</h3>'+trh+'</div>':'')+
    '<div class="card"><label class="fld"><span>Search sold items</span><input id="histSearch" value="'+esc(histQ)+'" oninput="histQ=this.value;ui.focusId=\'histSearch\';render()" placeholder="card name"/></label></div>'+
    (rows.length?'<div class="card"><table><thead><tr><th>Date</th><th>Item</th><th>Owner</th><th>Sold</th><th>Adj</th><th>Pay</th></tr></thead><tbody>'+body+'</tbody></table></div>':'<div class="empty">No matches.</div>');
}

/* -------- Reports / shows / finalize -------- */
function viewReports(){ const show=openShow(); let cur='';
  if(show){ const st=computeSettlement(show);
    let panel='';
    if(ui.showPanel==='cashout') panel='<div class="card"><h3>Record a cash-out</h3><div class="grid3">'+fld('Who took cash',userSel('co_user'))+fld('Amount',inp('co_amt','','','number'))+fld('Note',inp('co_note','','what for'))+'</div><div class="row"><button class="gold" onclick="addCashOut()">Save cash-out</button><button class="ghost" onclick="ui.showPanel=null;render()">Cancel</button></div></div>';
    cur='<div class="card"><h3>Open show: '+esc(show.name)+'</h3><div class="kpi" style="grid-template-columns:repeat(3,1fr)">'+kpi('Revenue',money(st.totalRevenue))+kpi('Drawer expected',money(st.drawerExpected))+kpi('Items sold',countSold(show))+'</div>'+
      '<div class="row" style="margin-top:12px"><button class="sm" onclick="ui.showPanel=\'cashout\';render()">Record cash-out</button><button class="blue right" onclick="finalizeShow()">Finalize show & report</button></div>'+
      (show.cashOuts&&show.cashOuts.length?'<hr class="sep"><div class="muted">Cash-outs: '+show.cashOuts.map(c=>userName(c.userId)+' '+money(c.amount)+(c.note?' ('+esc(c.note)+')':'')).join(', ')+'</div>':'')+'</div>'+panel;
  } else {
    let panel=ui.showPanel==='start'?'<div class="card"><h3>Start a show</h3><label class="fld"><span>Show name</span><input id="sh_name" value="Card Show '+new Date().toLocaleDateString()+'"/></label><div class="muted">Drawer opens with the '+money(state.settings.cashFloat)+' float.</div><div class="row"><button class="gold" onclick="startShow()">Start show</button><button class="ghost" onclick="ui.showPanel=null;render()">Cancel</button></div></div>':'';
    cur='<div class="card"><h3>No open show</h3><button class="gold" onclick="ui.showPanel=\'start\';render()">＋ Start a show</button></div>'+panel;
  }
  const finals=state.shows.filter(s=>s.status==='finalized').reverse().map(s=>'<div class="cart-line"><div style="flex:1"><b>'+esc(s.name)+'</b><div class="muted">finalized '+new Date(s.finalizedAt).toLocaleString()+'</div></div><button class="sm gold" onclick="viewReport(\''+s.id+'\')">View / print</button></div>').join('');
  return '<h2 class="page">Reports <small>start a show, take sales, finalize for the money breakdown</small></h2>'+cur+
    '<div class="card"><h3>Finalized shows</h3>'+(finals||'<div class="muted">None yet.</div>')+'</div><div id="reportOut"></div>';
}
function startShow(){ if(openShow()){toast('A show is already open.');return;} const name=val('sh_name')||'Card Show'; const show={id:uid('show'),name,date:Date.now(),status:'open',cashFloat:state.settings.cashFloat,prizePlaysStart:state.settings.prizePlaysPerShow,cashOuts:[],finalizedAt:null}; state.shows.push(show);state.currentShowId=show.id;ui.showPanel=null;logChange('shows','started show "'+name+'"');save();toast('Show started.');go('sell'); }
function addCashOut(){ const show=openShow();if(!show)return; const amt=num('co_amt'); if(amt<=0){toast('Enter an amount.');return;} show.cashOuts=show.cashOuts||[]; show.cashOuts.push({id:uid('co'),userId:val('co_user'),amount:amt,note:val('co_note')}); logChange('shows','cash-out '+money(amt)+' to '+userName(val('co_user'))); ui.showPanel=null; save();toast('Cash-out recorded.');render(); }
function finalizeShow(){ const show=openShow();if(!show)return; if(!confirm('Finalize "'+show.name+'"? No more sales can be added.'))return; show.status='finalized';show.finalizedAt=Date.now();logChange('shows','finalized show "'+show.name+'"');save();toast('Show finalized.');render();viewReport(show.id); }
function viewReport(showId){ const show=state.shows.find(s=>s.id===showId);const st=computeSettlement(show);const profit=ownerProfit(show);
  // matrix table: rows = method, cols = each person, + method total
  const head='<tr><th>Method → who gets it</th>'+state.users.map(u=>'<th>'+u.name+'</th>').join('')+'<th>Method total</th></tr>';
  const mrows=METHODS.filter(m=>st.methodTotals[m]>0.005).map(m=>{ const acct=state.paymentAccounts[m]; const held=acct==='drawer'?'drawer':(acct==='prompt'?'per sale':userName(acct));
    return '<tr><td>'+METHOD_LABEL[m]+' <span class="muted">('+held+')</span></td>'+state.users.map(u=>'<td class="money">'+money(st.matrix[m][u.id])+'</td>').join('')+'<td class="money"><b>'+money(st.methodTotals[m])+'</b></td></tr>'; }).join('');
  const totalRow='<tr><td><b>Each person earned</b></td>'+state.users.map(u=>'<td class="money"><b>'+money(st.perPerson[u.id])+'</b></td>').join('')+'<td class="money"><b>'+money(st.totalRevenue)+'</b></td></tr>';
  // take-home summary
  const thRows=state.users.map(u=>'<tr><td>'+u.name+'</td><td class="money">'+money(st.perPerson[u.id])+'</td><td class="money">'+money(st.cashOutBy[u.id])+'</td><td class="money">'+(st.buyoutNet[u.id]>=0?'+':'')+money(st.buyoutNet[u.id])+'</td><td class="money"><b>'+money(st.takeHome[u.id])+'</b></td><td class="money">'+money(profit[u.id])+'</td></tr>').join('');
  const cashoutRows=st.cashOuts.map(c=>'<li>'+userName(c.userId)+' took '+money(c.amount)+' from drawer'+(c.note?' — '+esc(c.note):'')+'</li>').join('');
  const buyoutRows=st.buyouts.map(b=>'<li>'+userName(b.payerId)+' pays '+userName(b.payeeId)+' '+money(b.amt)+' (trade buyout)</li>').join('');
  const html='<div class="card" id="reportCard"><h2 style="margin-top:0">House of Cards — Show Report</h2>'+
    '<div class="muted">'+esc(show.name)+' · '+new Date(show.date).toLocaleDateString()+(show.finalizedAt?' · finalized '+new Date(show.finalizedAt).toLocaleString():'')+'</div><hr class="sep">'+
    '<h3>How the money splits — each method to each person</h3>'+
    '<table><thead>'+head+'</thead><tbody>'+mrows+totalRow+'</tbody></table>'+
    '<div class="muted" style="margin-top:6px">Each method\'s money is divided by who owned the items in those sales. "(drawer)"=cash on hand; the others sit in that person\'s account, so they pay out the portions shown to the others.</div>'+
    '<div class="banner" style="margin-top:12px">Cash drawer: float '+money(st.float)+' (stays in) + cash sales '+money(st.cashSales)+' − cash-outs '+money(st.totalCashOut)+' = <b>expected '+money(st.drawerExpected)+'</b>. Distributable cash: <b>'+money(st.drawerDistributable)+'</b>.</div>'+
    '<h3 style="margin-top:16px">Final take-home per person</h3>'+
    '<table><thead><tr><th>Person</th><th>Earned</th><th>Cash already taken</th><th>Trade buyout</th><th>Take-home</th><th>Profit*</th></tr></thead><tbody>'+thRows+'</tbody></table>'+
    '<div class="muted" style="margin-top:6px">*Profit = sold − your cost (owner-only figure).</div>'+
    (st.prizeRev>0?'<p>Prize machine '+money(st.prizeRev)+' split 50/50: '+state.settings.prizeSplit.map(id=>userName(id)+' '+money(st.prizeRev/state.settings.prizeSplit.length)).join(', ')+'.</p>':'')+
    (cashoutRows?'<h3 style="margin-top:14px">Cash-outs</h3><ul>'+cashoutRows+'</ul>':'')+
    (buyoutRows?'<h3 style="margin-top:14px">Trade buyouts (settled now)</h3><ul>'+buyoutRows+'</ul>':'')+
    '<div class="row noprint" style="margin-top:14px"><button class="gold" onclick="window.print()">🖨 Print / Save PDF</button></div></div>';
  el('reportOut').innerHTML=html; el('reportOut').scrollIntoView({behavior:'smooth'});
}

/* -------- Activity / audit log -------- */
let actFilter={q:'',user:''};
function viewActivity(){ let log=(state.audit||[]).slice().reverse();
  if(actFilter.user)log=log.filter(e=>e.userId===actFilter.user);
  if(actFilter.q)log=log.filter(e=>smatch((e.detail||'')+' '+(e.area||'')+' '+userName(e.userId),actFilter.q));
  const userOpts='<option value="">Everyone</option>'+state.users.map(u=>'<option value="'+u.id+'"'+(actFilter.user===u.id?' selected':'')+'>'+esc(u.name)+'</option>').join('');
  const rows=log.slice(0,500).map(e=>'<tr><td class="muted" style="white-space:nowrap">'+new Date(e.at).toLocaleString()+'</td>'+
    '<td><span class="pill owner">'+esc(userName(e.userId))+'</span></td><td><span class="tag">'+esc(e.area||'')+'</span></td><td>'+esc(e.detail||'')+'</td></tr>').join('');
  return '<h2 class="page">Activity <small>every change is signed by who made it — '+(state.audit||[]).length+' logged</small></h2>'+
    '<div class="card"><div class="grid2">'+
      '<label class="fld"><span>Search</span><input id="actSearch" value="'+esc(actFilter.q)+'" oninput="actFilter.q=this.value;ui.focusId=\'actSearch\';render()" placeholder="what / who / area"/></label>'+
      '<label class="fld"><span>Who</span><select onchange="actFilter.user=this.value;render()">'+userOpts+'</select></label>'+
    '</div><div class="muted">Everyone on the team shares full company access; this log is how you trace who did what.</div></div>'+
    (log.length?'<div class="card"><table><thead><tr><th>When</th><th>Who</th><th>Area</th><th>Change</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="empty">No activity logged yet.</div>');
}

/* -------- Settings -------- */
function viewSettings(){ const s=state.settings;
  const acctSel=(m)=>{const cur=state.paymentAccounts[m];const opts=[['drawer','Cash drawer (no owner)'],['prompt','Ask per sale']].concat(state.users.map(u=>[u.id,u.name]));return '<select onchange="setAcct(\''+m+'\',this.value)">'+opts.map(([v,l])=>'<option value="'+v+'"'+(cur===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';};
  const acctRows=METHODS.map(m=>'<tr><td>'+METHOD_LABEL[m]+'</td><td>'+acctSel(m)+'</td></tr>').join('');
  return '<h2 class="page">Settings</h2>'+
    '<div class="card"><h3>Payment accounts — who receives each method</h3><table><tbody>'+acctRows+'</tbody></table><div class="muted" style="margin-top:8px">Default: Cash→drawer · Venmo→Manny · Cash App/PayPal/Square→Reggie · Zelle→ask per sale.</div></div>'+
    '<div class="card"><h3>Show defaults</h3><div class="grid3">'+fld('Cash float',inp('s_float',s.cashFloat,'','number'))+fld('Prize price',inp('s_prize',s.prizePrice,'','number'))+fld('Prize plays/show',inp('s_plays',s.prizePlaysPerShow,'','number'))+'</div><button class="gold" onclick="saveSettings()">Save defaults</button><div class="muted" style="margin-top:6px">Prize machine splits 50/50 Reggie ↔ Manny.</div></div>'+
    '<div class="card"><h3>Branding / logo</h3>'+(s.logo?'<img src="'+s.logo+'" style="height:60px;border-radius:10px;border:2px solid var(--gold);background:#000;margin-bottom:8px"/><br>':'')+
      '<label class="fld"><span>Upload your House of Cards logo (shows top-left)</span><input type="file" accept="image/*" onchange="saveLogo(this)"/></label>'+
      (s.logo?'<button class="ghost" onclick="state.settings.logo=null;save();render();toast(\'Logo removed.\')">Remove logo</button>':'')+
      '<div class="muted" style="margin-top:6px">Saved on this device. To show it on every device automatically, also drop the file as <b>logo.png</b> in the app folder.</div></div>'+
    '<div class="card"><h3>Card reader (AI vision) — free</h3><label class="fld"><span>Google Gemini API key — lets the scanner read cards as well as a human (free tier)</span>'+inp('s_gemini',(s.geminiKey||''),'paste your free key from aistudio.google.com')+'</label><button class="gold" onclick="saveGeminiKey()">Save key</button>'+(s.geminiKey?' <span class="tag">✓ key saved</span>':'')+'<div class="muted" style="margin-top:6px">Get a free key at <b>aistudio.google.com/apikey</b> → "Create API key" → paste it here. Stored only on this device. Without a key, scanning falls back to basic on-device reading.</div></div>'+
    '<div class="card"><h3>Pro pricing (Scrydex)</h3><label class="fld" style="display:flex;align-items:center;gap:8px"><input type="checkbox" style="width:auto" '+(s.useScrydex!==false?'checked':'')+' onchange="setUseScrydex(this.checked)"><span style="margin:0">Use Scrydex for identification &amp; real graded prices (falls back to free pokemontcg.io)</span></label><button class="blue" onclick="testScrydex()">Test connection</button><div class="muted" style="margin-top:6px">Keys live in your Supabase Edge Function secrets (SCRYDEX_API_KEY / SCRYDEX_TEAM_ID), not in the app. Deploy the <b>scrydex</b> function, then tap Test.</div></div>'+
    '<div class="card"><h3>Scan &amp; pricing</h3><label class="fld"><span>Cash offer % — when buying, offer this share of the ungraded market price</span>'+inp('s_buypct',(s.buyPct||70),'e.g. 70','number')+'</label><button class="gold" onclick="saveBuyPct()">Save %</button><div class="muted" style="margin-top:6px">Used by the "Scan a card → price" cash-offer line. Graded ladder values are estimates from the live ungraded market price (TCGplayer via pokemontcg.io); always confirm big cards against real sold listings.</div></div>'+
    '<div class="card"><h3>Card image source (free)</h3><label class="fld"><span>pokemontcg.io API key — OPTIONAL (free; leave blank to use without a key)</span>'+inp('s_ptcg',s.ptcgKey||'','optional, only speeds up big batches')+'</label><button class="gold" onclick="savePtcg()">Save key</button><div class="muted" style="margin-top:6px">No key needed — image fetching works free without one (pokemontcg.io + TCGdex fallback). A key just raises the daily limit for big imports.</div></div>'+
    '<div class="card"><h3>My account — '+esc(me().name)+'</h3>'+
      '<div class="muted" style="margin-bottom:8px">Each person signs into their own account. You can only change your own password.</div>'+
      '<div class="row" style="align-items:center;gap:14px;margin-bottom:6px">'+currentAvatarTag('lg')+
        '<label class="fld" style="flex:1;min-width:180px;margin:0"><span>Profile picture</span><input type="file" accept="image/*" onchange="saveAvatar(this)"/></label>'+
        ((!socialReadySafe()&&me().avatar)?'<button class="ghost sm" onclick="removeAvatar()">Remove</button>':'')+'</div>'+
      '<div class="muted" style="margin-bottom:10px">'+(socialReadySafe()?'Synced to all your devices via your cloud profile (manage it on the Friends tab).':'Saved on this device. Connect on the <b>Friends</b> tab to sync it across devices.')+'</div><hr class="sep">'+
      '<div class="row" style="align-items:flex-end"><label class="fld" style="flex:1;min-width:200px;margin:0"><span>Email (used to sign in &amp; for cloud)</span>'+inp('ac_email',me().email||'','you@example.com','email')+'</label><button class="blue" onclick="saveEmail()">Save email</button></div>'+
      '<div class="muted" style="margin:6px 0 10px">After changing your email, sign in with it + your password and your cloud profile links automatically.</div><hr class="sep">'+
      '<div class="grid2">'+fld('Current password',inp('ac_cur','','','password'))+fld('New password',inp('ac_new','','at least 3 characters','password'))+'</div>'+
      '<button class="gold" onclick="changePassword()">Update my password</button>'+
      '<hr class="sep"><div class="muted" style="margin-bottom:6px">Security question (lets you reset your own password if you forget it):</div>'+
      '<div class="grid2">'+fld('Question',inp('ac_q',me().secQ||'','e.g. First pet\'s name'))+fld('Answer',inp('ac_a','',me().secA?'(saved — type to change)':'your answer'))+'</div>'+
      '<button class="blue" onclick="saveSecurityQ()">Save security question</button></div>'+
    '<div class="card"><h3>Team</h3>'+state.users.map(u=>'• '+esc(u.name)+(u.id===state.currentUserId?' (you)':'')+(u.pass===hashPass('test')?' <span class="muted">— still using default password</span>':'')).join('<br>')+'<div class="muted" style="margin-top:6px">Everyone\'s password starts as <b>test</b> until they change it.</div></div>'+
    '<div class="card"><h3>Text sign-ups ('+signupList().length+')</h3><div class="muted" style="margin-bottom:8px">People who joined your text list from the front wall (saved on this device). Export before a factory reset.</div><div class="row"><button class="gold" onclick="exportSignups()">Export CSV</button><button class="red ghost" onclick="clearSignups()">Clear</button></div></div>'+
    '<div class="card"><h3>Beta — reset data</h3><div class="banner">Clear everything you entered while testing so you start clean for your first real show.</div><div class="row" style="margin-top:10px"><button class="red" onclick="resetTestData()">Clear test data (keep team & settings)</button><button class="red ghost" onclick="factoryReset()">Full factory reset</button><button class="ghost right" onclick="loadSample()">Load sample data</button></div></div>'+
    '<div class="card"><h3>About</h3><div class="muted">Local beta — data stored only in this browser, works offline. Camera scanning works on the hosted (https) version in Safari and Chrome (the first scan downloads the scanner, so it needs internet once). Card-front auto-read and online image fetching need internet; reused/saved images and everything else work offline.</div></div>';
}
function setAcct(m,v){state.paymentAccounts[m]=v;logChange('settings','set '+METHOD_LABEL[m]+' account');save();toast('Updated.');}
function saveSettings(){state.settings.cashFloat=num('s_float');state.settings.prizePrice=num('s_prize');state.settings.prizePlaysPerShow=num('s_plays');logChange('settings','updated show defaults');save();toast('Saved.');}
function savePtcg(){state.settings.ptcgKey=val('s_ptcg');save();toast('Image API key saved.');}
function saveBuyPct(){ let p=Math.round(num('s_buypct')); if(!(p>0&&p<=100))p=70; state.settings.buyPct=p; save(); toast('Cash offer set to '+p+'%.'); }
function saveGeminiKey(){ state.settings.geminiKey=(val('s_gemini')||'').trim(); save(); toast(state.settings.geminiKey?'Card reader key saved — scanning now uses AI.':'Key cleared.'); render(); }
function setUseScrydex(on){ state.settings.useScrydex=!!on; save(); toast(on?'Scrydex enabled.':'Scrydex off — using free pokemontcg.io.'); }
async function testScrydex(){ toast('Testing Scrydex…');
  try{ const j=await scrydexGet('cards',{q:'name:"Charizard"',include:'prices',pageSize:1});
    const card=(j&&(j.data||j.cards||j))||[]; const c=Array.isArray(card)?card[0]:card;
    if(!c){ toast('Connected, but no card returned — check the query.'); return; }
    const w=document.createElement('div'); w.className='scanmodal';
    w.innerHTML='<div class="card" style="max-width:480px;width:100%;max-height:90vh;overflow:auto"><h3>Scrydex connected ✓</h3><div class="muted">Sample card JSON below — screenshot or copy it to me so I can lock in the exact graded-price fields.</div>'+
      '<textarea readonly style="width:100%;height:46vh;font:11px monospace;margin-top:8px">'+esc(JSON.stringify(c,null,2))+'</textarea>'+
      '<div class="row" style="margin-top:10px"><button class="ghost" onclick="this.closest(\'.scanmodal\').remove()">Close</button></div></div>';
    document.body.appendChild(w);
  }catch(e){ toast('Scrydex test failed: '+((e&&e.message)||e)); }
}
function saveLogo(input){ const f=input.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ state.settings.logo=r.result; save(); toast('Logo updated.'); render(); }; r.readAsDataURL(f); }
function socialReadySafe(){ return typeof socialReady==='function' && socialReady(); }
function saveAvatar(input){ const f=input.files[0]; if(!f)return;
  if(socialReadySafe()){ toast('Uploading photo…'); uploadAvatar(f).then(r=>{ if(r.error)toast('Cloud upload failed: '+r.error); else toast('Profile picture updated & synced.'); render(); }); return; }
  const r=new FileReader(); r.onload=()=>{ me().avatar=r.result; logChange('account','updated profile picture'); save(); toast('Profile picture updated.'); render(); }; r.readAsDataURL(f); }
function removeAvatar(){ me().avatar=null; save(); toast('Profile picture removed.'); render(); }
function changePassword(){ const u=me(); if(u.pass!==hashPass(val('ac_cur'))){ toast('Current password is wrong.'); return; } const np=val('ac_new'); if(np.length<3){ toast('New password needs at least 3 characters.'); return; } u.pass=hashPass(np); u.mustChange=false; logChange('account','changed own password'); save(); toast('Password updated.'); render(); }
function saveEmail(){ const u=me(); const e=val('ac_email').trim(); if(!/^\S+@\S+\.\S+$/.test(e)){ toast('Enter a valid email address.'); return; }
  if(state.users.some(x=>x.id!==u.id&&String(x.email||'').toLowerCase()===e.toLowerCase())){ toast('That email is already used by another account here.'); return; }
  u.email=e; logChange('account','updated email'); save(); toast('Email saved. Sign in with it + your password to link your cloud login.'); render(); }
function saveSecurityQ(){ const u=me(); const q=val('ac_q'); const a=val('ac_a'); if(!q){ toast('Enter a question.'); return; } u.secQ=q; if(a)u.secA=hashPass(a.toLowerCase()); save(); toast('Security question saved.'); render(); }
function resetTestData(){ if(!confirm('Clear all inventory, sales, shows, trades and wish list? Team & settings stay.'))return; state.inventory=[];state.sales=[];state.shows=[];state.trades=[];state.wantlist=[];state.currentShowId=null;ui.cart=[];ui.cartPayments=[];save();toast('Test data cleared.');go('dashboard'); }
function factoryReset(){ if(!confirm('FULL reset to factory defaults? Cannot be undone.'))return; stopImgJob(); state=freshState();ui={route:'dashboard',cart:[],cartPayments:[],focusId:null,sellPanel:null,showPanel:null,tradeDraft:null,inForm:{},authed:false,loginMode:'login'};save();toast('Factory reset done — sign in again.');render(); }

/* -------- sample data -------- */
function loadSample(){ if(state.inventory.length&&!confirm('Add sample items on top of existing data?'))return;
  const samp=[['Pokemon','Surging Sparks','Pikachu ex','238/191','SIR','Holofoil','EN','Ungraded','NM','u_reggie',180,329],
    ['Pokemon','Prismatic Evolutions','Umbreon ex','161/131','SIR','Holofoil','EN','Ungraded','NM','u_manny',900,1450],
    ['Pokemon','151','Charizard ex','199/165','SIR','Holofoil','EN','PSA 10','NM','u_reggie',400,720],
    ['Pokemon','Base Set','Blastoise','2/102','Holo','Holofoil','EN','Ungraded','LP','u_hailey',120,210],
    ['Pokemon','Paldea Evolved','Iono','254/193','SIR','Holofoil','EN','Ungraded','NM','u_manny',55,98]];
  samp.forEach(r=>{ const data={category:r[0],set:r[1],name:r[2],number:r[3],rarity:r[4],variance:r[5],language:r[6],grade:r[7],condition:r[8],ownerId:r[9],costBasis:r[10],listPrice:r[11]};
    state.inventory.push(Object.assign({id:uid('item'),barcode:genBarcodeId(),suggestedPrice:r[11],priceOverride:r[7]!=='Ungraded',photo:stockImage(data),stock:true,status:'available',dateAdded:Date.now()},data)); });
  save();toast('Sample items added.');go('inventory');
}

/* ============================== utils ============================== */
/* partial search: every typed word must appear somewhere (so "char base" finds a Base-Set Charizard) */
function smatch(text,q){ text=String(text==null?'':text).toLowerCase(); const terms=String(q||'').toLowerCase().split(/\s+/).filter(Boolean); return terms.every(t=>text.includes(t)); }
function fld(label,inner){return '<label class="fld"><span>'+label+'</span>'+inner+'</label>';}
function inp(id,v,ph,type){return '<input id="'+id+'" type="'+(type||'text')+'" value="'+(v==null?'':esc(String(v)))+'" placeholder="'+(ph||'')+'"/>';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* ============================== boot ============================== */
(async function init(){
  initCloud();
  try{ state=await loadState(); }catch(e){ state=null; }
  if(!state){ state=freshState(); save(); }
  state.sales=state.sales||[];state.trades=state.trades||[];state.wantlist=state.wantlist||[];state.imageDB=state.imageDB||{};state.audit=state.audit||[];
  // migrate users to have passwords/security questions (default password "test"), usernames + email
  state.users.forEach(u=>{ if(!u.pass){ u.pass=hashPass('test'); u.mustChange=true; } if(u.secQ===undefined)u.secQ=''; if(u.secA===undefined)u.secA='';
    if(!u.username)u.username=(u.name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'')||('user'+Math.floor(Math.random()*9000+1000));
    if(u.email===undefined)u.email=''; if(u.subscription===undefined)u.subscription={status:'owner',since:0}; });
  if(state.settings.menuOpen===undefined)state.settings.menuOpen=(window.innerWidth>=760);
  ui.menuOpen=state.settings.menuOpen;
  // stay logged in across refreshes: restore the saved session
  if(state.session && state.session.userId && state.users.some(u=>u.id===state.session.userId)){
    state.currentUserId=state.session.userId; ui.authed=true; ui.route='dashboard';
  }
  save();
  render();
  if(typeof cloudInitSession==='function'){ try{ await cloudInitSession(); }catch(e){ console.warn(e); } }
})();
