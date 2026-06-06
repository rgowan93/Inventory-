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

/* ============================== state ============================== */
let state = null;
let ui = { route:'dashboard', cart:[], cartPayments:[], focusId:null, sellPanel:null, showPanel:null,
           tradeDraft:null, inForm:{}, zellePick:null };

function freshState(){
  const reggie={id:'u_reggie',name:'Reggie'}, manny={id:'u_manny',name:'Manny'}, hailey={id:'u_hailey',name:'Hailey'};
  return {
    version:2,
    users:[reggie,manny,hailey],
    currentUserId:reggie.id,
    paymentAccounts:{cash:'drawer',venmo:manny.id,cashapp:reggie.id,paypal:reggie.id,square:reggie.id,zelle:'prompt'},
    settings:{ cashFloat:200, floatOwnerId:reggie.id, prizePrice:10, prizePlaysPerShow:400, prizeSplit:[reggie.id,manny.id] },
    inventory:[], shows:[], currentShowId:null, trades:[], wantlist:[], sales:[]
  };
}

/* ============================== persistence (IndexedDB) ============================== */
function idb(mode, fn){
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('houseofcards',1);
    open.onupgradeneeded=()=>{ if(!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv'); };
    open.onsuccess=()=>{ const db=open.result; const tx=db.transaction('kv',mode); const store=tx.objectStore('kv'); const req=fn(store);
      tx.oncomplete=()=>resolve(req&&req.result); tx.onerror=()=>reject(tx.error); };
    open.onerror=()=>reject(open.error);
  });
}
const loadState=()=>idb('readonly',s=>s.get('state'));
let saveTimer=null;
function save(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ idb('readwrite',s=>s.put(JSON.parse(JSON.stringify(state)),'state')); },150); }

/* ============================== helpers ============================== */
let _c=0;
const uid=p=>(p||'id')+'_'+Date.now().toString(36)+'_'+(_c++).toString(36);
const money=n=>'$'+(Number(n)||0).toFixed(2);
const userName=id=>{const u=state.users.find(u=>u.id===id);return u?u.name:'—';};
const me=()=>state.users.find(u=>u.id===state.currentUserId);
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

/* ============================== camera scanner ============================== */
async function openScanner(onCode){
  if(!window.isSecureContext){ toast('Camera needs the hosted version (https/localhost). On a double-clicked file the browser blocks the camera — type or use a USB/Bluetooth scanner for now.'); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast('No camera available here.'); return; }
  const wrap=document.createElement('div'); wrap.className='scanmodal';
  wrap.innerHTML='<video autoplay playsinline></video><div class="hint">Point the camera at the barcode…</div><div class="row"><button class="red" id="scanClose">Cancel</button></div>';
  document.body.appendChild(wrap);
  const video=wrap.querySelector('video'); let stream=null, stop=false;
  const cleanup=()=>{ stop=true; if(stream)stream.getTracks().forEach(t=>t.stop()); wrap.remove(); };
  wrap.querySelector('#scanClose').onclick=cleanup;
  try{ stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}); video.srcObject=stream; }
  catch(e){ cleanup(); toast('Could not open camera (permission denied?).'); return; }
  if(!('BarcodeDetector' in window)){ wrap.querySelector('.hint').textContent='This browser can\'t auto-detect barcodes. Use Chrome/Edge, or type it in.'; return; }
  let detector; try{ detector=new window.BarcodeDetector({formats:['code_39','qr_code','code_128','ean_13','ean_8']}); }catch(e){ wrap.querySelector('.hint').textContent='Scanner unsupported here — type it in.'; return; }
  const tick=async()=>{ if(stop)return; try{ const codes=await detector.detect(video); if(codes&&codes.length){ const code=codes[0].rawValue; cleanup(); onCode(code); return; } }catch(e){} setTimeout(tick,250); };
  tick();
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
  ['sell','Sell'],['trades','Trades'],['wishlist','Wish List'],['history','Sold History'],['reports','Reports'],['settings','Settings']];
const PARENT={checkout:'sell',newtrade:'trades'};
const VIEWS={dashboard:viewDashboard,inventory:viewInventory,add:viewAdd,import:viewImport,labels:viewLabels,
  sell:viewSell,checkout:viewCheckout,trades:viewTrades,newtrade:viewNewTrade,wishlist:viewWishlist,history:viewHistory,reports:viewReports,settings:viewSettings};
function go(route){ ui.route=route; ui.focusId=null; render(); window.scrollTo(0,0); }
function setUser(id){ state.currentUserId=id; save(); render(); }
function render(){
  const logo=el('brandLogo'); if(logo && !logo.dataset.set){ logo.dataset.set='1'; logo.src='logo.png'; logo.onerror=()=>{logo.onerror=null;logo.src='logo.svg';}; }
  el('userSwitch').innerHTML=state.users.map(u=>'<option value="'+u.id+'"'+(u.id===state.currentUserId?' selected':'')+'>'+u.name+'</option>').join('');
  const active=PARENT[ui.route]||ui.route;
  el('tabs').innerHTML=TABS.map(([r,l])=>'<button class="'+(active===r?'active':'')+'" onclick="go(\''+r+'\')">'+l+'</button>').join('');
  el('view').innerHTML=(VIEWS[ui.route]||viewDashboard)();
  if(ui.focusId){ const f=el(ui.focusId); if(f){ f.focus(); try{const n=f.value.length;f.setSelectionRange(n,n);}catch(e){} } }
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
let invFilter={q:'',owner:'',status:'',cond:''};
function viewInventory(){
  let items=state.inventory.slice().reverse();
  const q=invFilter.q.toLowerCase();
  if(q)items=items.filter(i=>(i.name+' '+i.set+' '+i.number+' '+i.barcode).toLowerCase().includes(q));
  if(invFilter.owner)items=items.filter(i=>i.ownerId===invFilter.owner);
  if(invFilter.status)items=items.filter(i=>i.status===invFilter.status);
  const ownerOpts='<option value="">All owners</option>'+state.users.map(u=>'<option value="'+u.id+'"'+(invFilter.owner===u.id?' selected':'')+'>'+u.name+'</option>').join('');
  const noPhoto=state.inventory.filter(i=>!i.photo).length;
  const rows=items.map(i=>'<tr>'+
    '<td><div class="invitem">'+photoThumb(i)+'<div><div>'+esc(i.name||'(unnamed)')+'</div>'+
      '<div class="muted">'+esc(i.set||'')+(i.number?' · #'+esc(i.number):'')+(i.language&&i.language!=='EN'?' · '+i.language:'')+(i.variance&&i.variance!=='Normal'?' · '+esc(i.variance):'')+'</div>'+
      '<div style="margin-top:3px">'+condPill(i.condition)+' '+(i.grade&&i.grade!=='Ungraded'?'<span class="tag">'+esc(i.grade)+'</span> ':'')+statusPill(i.status)+'</div></div></div></td>'+
    '<td><span class="pill owner">'+userName(i.ownerId)+'</span></td>'+
    '<td><span class="money">'+money(i.listPrice)+'</span>'+(i.priceOverride?' 🔒':'')+(i.costBasis?'<div class="muted">cost '+money(i.costBasis)+'</div>':'')+(i.suggestedPrice?'<div class="muted">sugg '+money(i.suggestedPrice)+'</div>':'')+'</td>'+
    '<td><div class="muted" style="font-family:monospace">'+esc(i.barcode)+'</div><div class="row" style="margin-top:6px">'+
      '<button class="sm" onclick="editItem(\''+i.id+'\')">Edit</button>'+
      (i.status==='available'?'<button class="sm gold" onclick="addBarcodeToCart(\''+i.barcode+'\')">Add to cart</button>':'')+
      (i.status==='intake'?'<button class="sm blue" onclick="finishIntake(\''+i.id+'\')">Finish intake</button>':'')+
      '</div></td></tr>').join('');
  return '<h2 class="page">Inventory <small>'+items.length+' shown · each copy has its own barcode</small></h2>'+
    '<div class="card"><div class="grid3">'+
      '<label class="fld"><span>Search</span><input id="invSearch" value="'+esc(invFilter.q)+'" oninput="invFilter.q=this.value;ui.focusId=\'invSearch\';render()" placeholder="name, set, number, barcode"/></label>'+
      '<label class="fld"><span>Owner</span><select onchange="invFilter.owner=this.value;render()">'+ownerOpts+'</select></label>'+
      '<label class="fld"><span>Status</span><select onchange="invFilter.status=this.value;render()">'+['','available','intake','sold','traded','hold'].map(s=>'<option'+(invFilter.status===s?' selected':'')+'>'+s+'</option>').join('')+'</select></label>'+
    '</div><div class="row"><button onclick="go(\'add\')">＋ Add item</button><button class="ghost" onclick="go(\'labels\')">Print labels</button>'+
      '<button class="blue" onclick="fetchCardImages()">🖼 Fetch real card images (online)</button>'+
      (noPhoto?'<button class="ghost" onclick="fillStockImages()">Placeholder images ('+noPhoto+')</button>':'')+'</div></div>'+
    (items.length?'<div class="card"><table><thead><tr><th>Item</th><th>Owner</th><th>Price</th><th>Barcode / actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
      :'<div class="empty">No items yet. <a onclick="go(\'add\')">Add one</a> or <a onclick="loadSample()">load sample data</a>.</div>');
}
function photoThumb(i){return i.photo?'<img class="ph" src="'+i.photo+'"/>':'<div class="ph">no photo</div>';}
function fillStockImages(){ let n=0; state.inventory.forEach(i=>{ if(!i.photo){ i.photo=stockImage(i); i.stock=true; n++; } }); save(); toast('Added stock images to '+n+' item(s).'); render(); }

/* fetch real card images (free): pokemontcg.io first, TCGdex fallback, cached for offline */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchCardImages(){
  const items=state.inventory.filter(i=>(!i.photo||i.stock)&&!i.realImage);
  if(!items.length){toast('All items already have real images.');return;}
  if(navigator.onLine===false){toast('You look offline — connect to wifi to fetch images.');return;}
  let done=0,found=0; el('toast').innerHTML='<div class="toast">Fetching images for '+items.length+' item(s)…</div>';
  for(const it of items){
    try{ const url=await lookupImage(it); if(url){ it.photo=await toDataURL(url); it.stock=true; it.realImage=true; found++; } }catch(e){}
    done++; if(done%4===0){ save(); el('toast').innerHTML='<div class="toast">Fetched '+done+'/'+items.length+' ('+found+' found)…</div>'; }
    await sleep(160);
  }
  save(); toast('Done — found '+found+' image(s) of '+items.length+'.'); render();
}
async function lookupImage(it){
  const number=(it.number||'').split('/')[0].trim();
  try{ const headers=state.settings.ptcgKey?{'X-Api-Key':state.settings.ptcgKey}:{};
    const q='name:"'+(it.name||'').replace(/"/g,'')+'"'+(number?(' number:'+number):'');
    const r=await fetch('https://api.pokemontcg.io/v2/cards?pageSize=8&q='+encodeURIComponent(q),{headers});
    if(r.ok){ const j=await r.json(); if(j.data&&j.data.length){ let best=j.data[0];
      if(it.set){ const m=j.data.find(c=>c.set&&norm(c.set.name)===norm(it.set)); if(m)best=m; }
      if(best.images&&(best.images.large||best.images.small)) return best.images.large||best.images.small; } }
  }catch(e){}
  try{ const lang=(it.language==='JP')?'ja':(it.language==='CN'?'zh-tw':'en');
    const r=await fetch('https://api.tcgdex.net/v2/'+lang+'/cards?name='+encodeURIComponent(it.name||''));
    if(r.ok){ const arr=await r.json(); if(arr&&arr.length){ let pick=arr[0];
      if(number){ const m=arr.find(c=>String(c.localId)===number); if(m)pick=m; }
      if(pick.image) return pick.image+'/high.png'; } }
  }catch(e){}
  return null;
}
async function toDataURL(url){ try{ const r=await fetch(url); if(!r.ok)return url; const b=await r.blob();
  return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=()=>res(url);fr.readAsDataURL(b);}); }catch(e){ return url; } }

/* -------- Add / Edit item (intake) -------- */
let editingId=null, pendingPhoto=null;
function viewAdd(){
  const it=editingId?state.inventory.find(i=>i.id===editingId):null;
  const g=(k,d)=>it?(it[k]??d):d;
  const sel=(id,opts,cur)=>'<select id="'+id+'">'+opts.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  const ownerSel='<select id="f_owner">'+state.users.map(u=>'<option value="'+u.id+'"'+((g('ownerId',state.currentUserId))===u.id?' selected':'')+'>'+u.name+'</option>').join('')+'</select>';
  return '<h2 class="page">'+(it?'Edit item':'Add item')+' <small>Photo only required if condition is NOT Near Mint · barcode auto-created</small></h2>'+
    '<div class="card"><div class="row noprint" style="margin-bottom:10px"><button class="blue" onclick="scanOnAdd()">📷 Scan barcode / UPC</button><span class="muted">scan an existing label to edit it, or a sealed product\'s UPC</span></div>'+
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
    '<label class="fld"><span>Photo (required only if condition is worse than NM)</span><input id="f_photo" type="file" accept="image/*" onchange="previewPhoto(this)"/></label>'+
    '<div id="photoPrev">'+(g('photo','')?'<img class="ph" style="width:80px;height:110px" src="'+g('photo','')+'"/>':'')+'</div>'+
    '<label class="fld"><span><input type="checkbox" id="f_override" style="width:auto;display:inline" '+(g('priceOverride',false)?'checked':'')+'/> Lock price (manual override — CSV/feeds won\'t change it; auto-on for graded)</span></label>'+
    '<hr class="sep"><div class="row">'+
      '<button class="gold" onclick="saveItem(true)">'+(it?'Save changes':'Save & print label')+'</button>'+
      (it?'':'<button class="blue" onclick="saveItem(false)">Save to intake</button>')+
      '<button class="ghost" onclick="cancelEdit()">Cancel</button>'+
      (it?'<button class="red right" onclick="deleteItem(\''+it.id+'\')">Delete</button>':'')+
    '</div></div>';
}
function previewPhoto(input){ const f=input.files[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{ pendingPhoto=r.result; el('photoPrev').innerHTML='<img class="ph" style="width:80px;height:110px" src="'+pendingPhoto+'"/>'; }; r.readAsDataURL(f); }
function collectItem(){ return {category:val('f_cat'),set:val('f_set'),name:val('f_name'),number:val('f_number'),rarity:val('f_rarity'),variance:val('f_var'),language:val('f_lang'),grade:val('f_grade'),condition:val('f_cond'),ownerId:val('f_owner'),costBasis:num('f_cost'),listPrice:num('f_price'),priceOverride:el('f_override').checked,upc:val('f_upc')}; }
function needsPhoto(cond){ return cond && cond!=='NM'; }
function saveItem(makeAvailable){
  const data=collectItem(); if(!data.name){toast('Card name is required');return;}
  if(data.grade&&data.grade.toLowerCase()!=='ungraded')data.priceOverride=true;
  if(editingId){ const it=state.inventory.find(i=>i.id===editingId); Object.assign(it,data); if(pendingPhoto){it.photo=pendingPhoto;it.stock=false;} save();toast('Saved.');editingId=null;pendingPhoto=null;go('inventory');return; }
  let photo=pendingPhoto;
  if(makeAvailable && needsPhoto(data.condition) && !photo){ toast('Condition '+data.condition+' requires a photo. Add one, or use "Save to intake".'); return; }
  if(!photo){ photo=stockImage(data); data.stock=true; } // auto stock image when none provided
  const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:photo,stock:data.stock||false,suggestedPrice:0,status:makeAvailable?'available':'intake',dateAdded:Date.now()},data);
  state.inventory.push(item); save(); pendingPhoto=null;
  if(makeAvailable){ toast('Added & ready. Printing label…'); printLabels([item.id]); } else toast('Saved to intake.');
  go('inventory');
}
function scanOnAdd(){ openScanner(code=>{ code=(code||'').trim(); if(!code)return; const it=state.inventory.find(i=>i.barcode.toUpperCase()===code.toUpperCase()); if(it){ toast('Found existing item — opening to edit.'); editItem(it.id); } else { const f=el('f_upc'); if(f)f.value=code; toast('Scanned '+code+' → added to UPC field.'); } }); }
function editItem(id){editingId=id;pendingPhoto=null;go('add');}
function cancelEdit(){editingId=null;pendingPhoto=null;go('inventory');}
function deleteItem(id){ if(!confirm('Delete this item permanently?'))return; state.inventory=state.inventory.filter(i=>i.id!==id);save();toast('Deleted.');editingId=null;go('inventory'); }
function finishIntake(id){ const it=state.inventory.find(i=>i.id===id); if(needsPhoto(it.condition)&&(!it.photo||it.stock)){editItem(id);toast('Condition '+it.condition+' needs a real photo before selling.');return;} it.status='available';save();toast('Item is now available.');render(); }

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
      state.inventory.push(Object.assign({id:uid('item'),barcode:genBarcodeId(),suggestedPrice:r.csvMarket,priceOverride:(r.grade&&r.grade.toLowerCase()!=='ungraded'),photo:stockImage(data),stock:true,status:'intake',dateAdded:Date.now()},data)); added++; } else skipped++; } });
  save(); csvSummary=updated+' price(s) updated · '+added+' new item(s) added to intake · '+suggestedOnly+' locked/graded (suggested only) · '+skipped+' skipped.';
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
  ui.cart=[];ui.cartPayments=[];save();toast('Sale recorded ✔');go('sell');
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
  if(q)pool=pool.filter(i=>(i.name+' '+i.set+' '+i.number).toLowerCase().includes(q));
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
    const inv=Object.assign({id:uid('item'),barcode:genBarcodeId(),suggestedPrice:Number(it.marketPrice)||0,priceOverride:false,photo:stockImage(data),stock:true,status:'intake',dateAdded:Date.now(),fromTrade:true},data); state.inventory.push(inv); inItemIds.push(inv.id); });
  d.out.forEach(o=>{ const it=state.inventory.find(i=>i.id===o.itemId); if(it)it.status='traded'; });
  const show=openShow();
  state.trades.push({id:uid('trade'),showId:show?show.id:null,createdAt:Date.now(),outItems:d.out.slice(),inItems:d.in.slice(),buyout,keeperId,outItemIds,inItemIds});
  ui.tradeDraft=null; save(); toast('Trade saved. Incoming cards added to intake.'); go('trades');
}
function deleteTrade(id){ const t=state.trades.find(x=>x.id===id); if(!t)return; if(!confirm('Delete this trade? Outgoing items go back to available; incoming items (if unsold) are removed.'))return;
  (t.outItemIds||[]).forEach(iid=>{ const it=state.inventory.find(i=>i.id===iid); if(it&&it.status==='traded')it.status='available'; });
  (t.inItemIds||[]).forEach(iid=>{ const it=state.inventory.find(i=>i.id===iid); if(it&&it.status!=='sold')state.inventory=state.inventory.filter(x=>x.id!==iid); });
  state.trades=state.trades.filter(x=>x.id!==id); save(); toast('Trade deleted & reverted.'); render();
}

/* -------- Wish list -------- */
function pingWantList(item){ state.wantlist.forEach(w=>{ if(item.name.toLowerCase().includes(w.text.toLowerCase())&&w.userId!==state.currentUserId){ toast('🔔 '+userName(w.userId)+' wants this: '+w.text); } }); }
function viewWishlist(){ const rows=state.wantlist.slice().reverse().map(w=>'<div class="cart-line"><div style="flex:1"><b>'+esc(w.text)+'</b><div class="muted">'+userName(w.userId)+(w.note?' · '+esc(w.note):'')+'</div></div><button class="sm red" onclick="delWant(\''+w.id+'\')">✕</button></div>').join('');
  return '<h2 class="page">Wish list <small>when anyone scans a match, the wanter gets pinged</small></h2>'+
    '<div class="card"><div class="grid2"><label class="fld"><span>Card you\'re hunting</span><input id="w_text" placeholder="e.g. Umbreon VMAX"/></label><label class="fld"><span>Note (optional)</span><input id="w_note" placeholder="condition, budget…"/></label></div><button class="gold" onclick="addWant()">Add to my wish list</button></div>'+
    (state.wantlist.length?'<div class="card">'+rows+'</div>':'<div class="empty">Nothing on the wish list yet.</div>'); }
function addWant(){const t=val('w_text');if(!t){toast('Enter a card.');return;}state.wantlist.push({id:uid('want'),userId:state.currentUserId,text:t,note:val('w_note')});save();toast('Added.');render();}
function delWant(id){state.wantlist=state.wantlist.filter(w=>w.id!==id);save();render();}

/* -------- Sold history -------- */
let histQ='';
function viewHistory(){ const sold=[];
  state.sales.filter(s=>s.status!=='voided').forEach(s=>s.lines.forEach(l=>{ if(l.type!=='prize') sold.push({...l,when:s.createdAt,payMethods:s.payments.map(p=>METHOD_LABEL[p.method]).join('+')}); }));
  let rows=sold.sort((a,b)=>b.when-a.when); const q=histQ.toLowerCase(); if(q)rows=rows.filter(r=>r.desc.toLowerCase().includes(q));
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
function startShow(){ if(openShow()){toast('A show is already open.');return;} const name=val('sh_name')||'Card Show'; const show={id:uid('show'),name,date:Date.now(),status:'open',cashFloat:state.settings.cashFloat,prizePlaysStart:state.settings.prizePlaysPerShow,cashOuts:[],finalizedAt:null}; state.shows.push(show);state.currentShowId=show.id;ui.showPanel=null;save();toast('Show started.');go('sell'); }
function addCashOut(){ const show=openShow();if(!show)return; const amt=num('co_amt'); if(amt<=0){toast('Enter an amount.');return;} show.cashOuts=show.cashOuts||[]; show.cashOuts.push({id:uid('co'),userId:val('co_user'),amount:amt,note:val('co_note')}); ui.showPanel=null; save();toast('Cash-out recorded.');render(); }
function finalizeShow(){ const show=openShow();if(!show)return; if(!confirm('Finalize "'+show.name+'"? No more sales can be added.'))return; show.status='finalized';show.finalizedAt=Date.now();save();toast('Show finalized.');render();viewReport(show.id); }
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

/* -------- Settings -------- */
function viewSettings(){ const s=state.settings;
  const acctSel=(m)=>{const cur=state.paymentAccounts[m];const opts=[['drawer','Cash drawer (no owner)'],['prompt','Ask per sale']].concat(state.users.map(u=>[u.id,u.name]));return '<select onchange="setAcct(\''+m+'\',this.value)">'+opts.map(([v,l])=>'<option value="'+v+'"'+(cur===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';};
  const acctRows=METHODS.map(m=>'<tr><td>'+METHOD_LABEL[m]+'</td><td>'+acctSel(m)+'</td></tr>').join('');
  return '<h2 class="page">Settings</h2>'+
    '<div class="card"><h3>Payment accounts — who receives each method</h3><table><tbody>'+acctRows+'</tbody></table><div class="muted" style="margin-top:8px">Default: Cash→drawer · Venmo→Manny · Cash App/PayPal/Square→Reggie · Zelle→ask per sale.</div></div>'+
    '<div class="card"><h3>Show defaults</h3><div class="grid3">'+fld('Cash float',inp('s_float',s.cashFloat,'','number'))+fld('Prize price',inp('s_prize',s.prizePrice,'','number'))+fld('Prize plays/show',inp('s_plays',s.prizePlaysPerShow,'','number'))+'</div><button class="gold" onclick="saveSettings()">Save defaults</button><div class="muted" style="margin-top:6px">Prize machine splits 50/50 Reggie ↔ Manny.</div></div>'+
    '<div class="card"><h3>Card image source (free)</h3><label class="fld"><span>pokemontcg.io API key — OPTIONAL (free; leave blank to use without a key)</span>'+inp('s_ptcg',s.ptcgKey||'','optional, only speeds up big batches')+'</label><button class="gold" onclick="savePtcg()">Save key</button><div class="muted" style="margin-top:6px">No key needed — image fetching works free without one (pokemontcg.io + TCGdex fallback). A key just raises the daily limit for big imports.</div></div>'+
    '<div class="card"><h3>Team</h3>'+state.users.map(u=>'• '+u.name).join('<br>')+'<div class="muted" style="margin-top:6px">(House of Cards — all free, all can finalize.)</div></div>'+
    '<div class="card"><h3>Beta — reset data</h3><div class="banner">Clear everything you entered while testing so you start clean for your first real show.</div><div class="row" style="margin-top:10px"><button class="red" onclick="resetTestData()">Clear test data (keep team & settings)</button><button class="red ghost" onclick="factoryReset()">Full factory reset</button><button class="ghost right" onclick="loadSample()">Load sample data</button></div></div>'+
    '<div class="card"><h3>About</h3><div class="muted">Local beta — data stored only in this browser, works offline. Camera scanning works on the hosted (https/localhost) version; on a double-clicked file the browser blocks the camera, so type or use a USB/Bluetooth scanner.</div></div>';
}
function setAcct(m,v){state.paymentAccounts[m]=v;save();toast('Updated.');}
function saveSettings(){state.settings.cashFloat=num('s_float');state.settings.prizePrice=num('s_prize');state.settings.prizePlaysPerShow=num('s_plays');save();toast('Saved.');}
function savePtcg(){state.settings.ptcgKey=val('s_ptcg');save();toast('Image API key saved.');}
function resetTestData(){ if(!confirm('Clear all inventory, sales, shows, trades and wish list? Team & settings stay.'))return; state.inventory=[];state.sales=[];state.shows=[];state.trades=[];state.wantlist=[];state.currentShowId=null;ui.cart=[];ui.cartPayments=[];save();toast('Test data cleared.');go('dashboard'); }
function factoryReset(){ if(!confirm('FULL reset to factory defaults? Cannot be undone.'))return; state=freshState();ui={route:'dashboard',cart:[],cartPayments:[],focusId:null,sellPanel:null,showPanel:null,tradeDraft:null,inForm:{}};save();toast('Factory reset done.');render(); }

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
function fld(label,inner){return '<label class="fld"><span>'+label+'</span>'+inner+'</label>';}
function inp(id,v,ph,type){return '<input id="'+id+'" type="'+(type||'text')+'" value="'+(v==null?'':esc(String(v)))+'" placeholder="'+(ph||'')+'"/>';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* ============================== boot ============================== */
(async function init(){
  try{ state=await loadState(); }catch(e){ state=null; }
  if(!state){ state=freshState(); save(); }
  state.sales=state.sales||[];state.trades=state.trades||[];state.wantlist=state.wantlist||[];
  render();
})();
