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
           tradeDraft:null, inForm:{}, zellePick:null, authed:false, loginUser:null, loginMode:'login', authView:'landing', menuOpen:false };

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
    settings:{ cashFloat:200, floatOwnerId:reggie.id, prizePrice:10, prizePlaysPerShow:400, prizeSplit:[reggie.id,manny.id] },
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
const PARENT={checkout:'sell',newtrade:'trades'};
const VIEWS={dashboard:viewDashboard,inventory:viewInventory,add:viewAdd,import:viewImport,labels:viewLabels,
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
    const av=ui.authView||'landing';
    if(av==='login'){ stopBounce(); el('view').innerHTML=viewLogin(); }
    else if(av==='signup'){ stopBounce(); el('view').innerHTML=viewSignup(); }
    else if(av==='subscribe'){ stopBounce(); el('view').innerHTML=viewSubscribe(); }
    else { el('view').innerHTML=viewLanding(); startBounce(); }
    afterRenderFocus(); updateImgChip(); return; }
  stopBounce();
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
  el('view').innerHTML=(VIEWS[ui.route]||viewDashboard)();
  afterRenderFocus(); updateImgChip();
}
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
  if(cloudOn()&&typeof cloudSignUp==='function'){ try{ const r=await cloudSignUp(email,p,name,username); if(r&&r.error&&!/registered|already|exists/i.test(r.error)) console.warn('[HoC] cloud signup',r.error); }catch(e){ console.warn(e); } } }

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
  state.currentUserId=u.id; ui.authed=true; ui.authView='landing'; ui.route='dashboard'; ui.newUserId=null;
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
    state.currentUserId=u.id; ui.authed=true; ui.route='dashboard'; save();
    if(u.mustChange||u.pass===hashPass('test')){ toast('Tip: set your own password in Settings → My account.'); }
    if(cloudOn()&&typeof cloudLoginByKey==='function'&&u.email){ cloudLoginByKey(u.email,pass).then(()=>render()).catch(()=>{}); } // also connect cloud
    render(); return;
  }
  // cloud account created on another device or on the Friends tab — recognize it here too
  if(cloudOn()&&typeof cloudLoginByKey==='function'){
    const r=await cloudLoginByKey(key,pass);
    if(r&&r.ok){ const pr=r.profile||{};
      let lu=findUser(pr.handle)||findUser(pr.email)||findUser(key);
      if(!lu){ lu={id:uid('u'),name:pr.name||pr.handle||key,username:(pr.handle||'').toLowerCase(),email:pr.email||'',pass:hashPass(pass),secQ:'',secA:'',mustChange:false,subscription:{status:'cloud',since:Date.now()}}; state.users.push(lu); }
      else { lu.pass=hashPass(pass); if(pr.email)lu.email=pr.email; }
      state.currentUserId=lu.id; ui.authed=true; ui.route='dashboard'; save(); toast('Welcome, '+lu.name+'!'); render(); return;
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
function logout(){ ui.authed=false; ui.loginMode='login'; ui.authView='landing'; stopImgJob(); render(); }
function switchUserPrompt(id){ if(id===state.currentUserId)return; const u=state.users.find(x=>x.id===id); if(!u)return;
  const p=prompt('Password for '+u.name+' (each person signs into their own account):'); if(p===null){ render(); return; }
  if(u.pass!==hashPass(p)){ toast('Wrong password — staying as '+me().name+'.'); render(); return; }
  state.currentUserId=u.id; save(); toast('Now acting as '+u.name); render();
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
      '<span class="muted">barcode/UPC opens an existing label or fills the UPC; card-front reads the name/number for you to review</span></div>'+
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
    '<div class="card"><h3>Card image source (free)</h3><label class="fld"><span>pokemontcg.io API key — OPTIONAL (free; leave blank to use without a key)</span>'+inp('s_ptcg',s.ptcgKey||'','optional, only speeds up big batches')+'</label><button class="gold" onclick="savePtcg()">Save key</button><div class="muted" style="margin-top:6px">No key needed — image fetching works free without one (pokemontcg.io + TCGdex fallback). A key just raises the daily limit for big imports.</div></div>'+
    '<div class="card"><h3>My account — '+esc(me().name)+'</h3>'+
      '<div class="muted" style="margin-bottom:8px">Each person signs into their own account. You can only change your own password.</div>'+
      '<div class="row" style="align-items:center;gap:14px;margin-bottom:6px">'+currentAvatarTag('lg')+
        '<label class="fld" style="flex:1;min-width:180px;margin:0"><span>Profile picture</span><input type="file" accept="image/*" onchange="saveAvatar(this)"/></label>'+
        ((!socialReadySafe()&&me().avatar)?'<button class="ghost sm" onclick="removeAvatar()">Remove</button>':'')+'</div>'+
      '<div class="muted" style="margin-bottom:10px">'+(socialReadySafe()?'Synced to all your devices via your cloud profile (manage it on the Friends tab).':'Saved on this device. Connect on the <b>Friends</b> tab to sync it across devices.')+'</div><hr class="sep">'+
      '<div class="grid2">'+fld('Current password',inp('ac_cur','','','password'))+fld('New password',inp('ac_new','','at least 3 characters','password'))+'</div>'+
      '<button class="gold" onclick="changePassword()">Update my password</button>'+
      '<hr class="sep"><div class="muted" style="margin-bottom:6px">Security question (lets you reset your own password if you forget it):</div>'+
      '<div class="grid2">'+fld('Question',inp('ac_q',me().secQ||'','e.g. First pet\'s name'))+fld('Answer',inp('ac_a','',me().secA?'(saved — type to change)':'your answer'))+'</div>'+
      '<button class="blue" onclick="saveSecurityQ()">Save security question</button></div>'+
    '<div class="card"><h3>Team</h3>'+state.users.map(u=>'• '+esc(u.name)+(u.id===state.currentUserId?' (you)':'')+(u.pass===hashPass('test')?' <span class="muted">— still using default password</span>':'')).join('<br>')+'<div class="muted" style="margin-top:6px">Everyone\'s password starts as <b>test</b> until they change it.</div></div>'+
    '<div class="card"><h3>Beta — reset data</h3><div class="banner">Clear everything you entered while testing so you start clean for your first real show.</div><div class="row" style="margin-top:10px"><button class="red" onclick="resetTestData()">Clear test data (keep team & settings)</button><button class="red ghost" onclick="factoryReset()">Full factory reset</button><button class="ghost right" onclick="loadSample()">Load sample data</button></div></div>'+
    '<div class="card"><h3>About</h3><div class="muted">Local beta — data stored only in this browser, works offline. Camera scanning works on the hosted (https) version in Safari and Chrome (the first scan downloads the scanner, so it needs internet once). Card-front auto-read and online image fetching need internet; reused/saved images and everything else work offline.</div></div>';
}
function setAcct(m,v){state.paymentAccounts[m]=v;logChange('settings','set '+METHOD_LABEL[m]+' account');save();toast('Updated.');}
function saveSettings(){state.settings.cashFloat=num('s_float');state.settings.prizePrice=num('s_prize');state.settings.prizePlaysPerShow=num('s_plays');logChange('settings','updated show defaults');save();toast('Saved.');}
function savePtcg(){state.settings.ptcgKey=val('s_ptcg');save();toast('Image API key saved.');}
function saveLogo(input){ const f=input.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ state.settings.logo=r.result; save(); toast('Logo updated.'); render(); }; r.readAsDataURL(f); }
function socialReadySafe(){ return typeof socialReady==='function' && socialReady(); }
function saveAvatar(input){ const f=input.files[0]; if(!f)return;
  if(socialReadySafe()){ toast('Uploading photo…'); uploadAvatar(f).then(r=>{ if(r.error)toast('Cloud upload failed: '+r.error); else toast('Profile picture updated & synced.'); render(); }); return; }
  const r=new FileReader(); r.onload=()=>{ me().avatar=r.result; logChange('account','updated profile picture'); save(); toast('Profile picture updated.'); render(); }; r.readAsDataURL(f); }
function removeAvatar(){ me().avatar=null; save(); toast('Profile picture removed.'); render(); }
function changePassword(){ const u=me(); if(u.pass!==hashPass(val('ac_cur'))){ toast('Current password is wrong.'); return; } const np=val('ac_new'); if(np.length<3){ toast('New password needs at least 3 characters.'); return; } u.pass=hashPass(np); u.mustChange=false; logChange('account','changed own password'); save(); toast('Password updated.'); render(); }
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
  save();
  render();
  if(typeof cloudInitSession==='function'){ try{ await cloudInitSession(); }catch(e){ console.warn(e); } }
})();
