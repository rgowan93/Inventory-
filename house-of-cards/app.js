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
let ui = { route:'dashboard', cart:[], cartPayments:[], scanMode:false };

function freshState(){
  const reggie={id:'u_reggie',name:'Reggie'}, manny={id:'u_manny',name:'Manny'}, hailey={id:'u_hailey',name:'Hailey'};
  return {
    version:1,
    users:[reggie,manny,hailey],
    currentUserId:reggie.id,
    // who physically receives each method. 'drawer'=cash drawer, 'prompt'=ask per sale.
    paymentAccounts:{cash:'drawer',venmo:manny.id,cashapp:reggie.id,paypal:reggie.id,square:reggie.id,zelle:'prompt'},
    settings:{
      cashFloat:200, floatOwnerId:reggie.id,
      prizePrice:10, prizePlaysPerShow:400, prizeSplit:[reggie.id,manny.id]
    },
    inventory:[],
    shows:[],
    currentShowId:null,
    trades:[],
    wantlist:[],
    sales:[]
  };
}

/* ============================== persistence (IndexedDB) ============================== */
function idb(mode, fn){
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('houseofcards',1);
    open.onupgradeneeded=()=>{ if(!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv'); };
    open.onsuccess=()=>{
      const db=open.result;
      const tx=db.transaction('kv',mode);
      const store=tx.objectStore('kv');
      const req=fn(store);
      tx.oncomplete=()=>resolve(req&&req.result);
      tx.onerror=()=>reject(tx.error);
    };
    open.onerror=()=>reject(open.error);
  });
}
const loadState=()=>idb('readonly',s=>s.get('state'));
let saveTimer=null;
function save(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ idb('readwrite',s=>s.put(JSON.parse(JSON.stringify(state)),'state')); },150); }
function wipe(){ return idb('readwrite',s=>s.clear()); }

/* ============================== helpers ============================== */
let _c=0;
const uid=p=>(p||'id')+'_'+Date.now().toString(36)+'_'+(_c++).toString(36);
const money=n=>'$'+(Number(n)||0).toFixed(2);
const userName=id=>{const u=state.users.find(u=>u.id===id);return u?u.name:'—';};
const me=()=>state.users.find(u=>u.id===state.currentUserId);
const el=id=>document.getElementById(id);
const val=id=>{const e=el(id);return e?e.value.trim():'';};
const num=id=>{const v=parseFloat(val(id));return isNaN(v)?0:v;};
function toast(msg){const t=el('toast');t.innerHTML='<div class="toast">'+msg+'</div>';setTimeout(()=>{t.innerHTML='';},2200);}
function genBarcodeId(){ // short, Code39-safe (A-Z0-9-)
  const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<5;i++)s+=a[Math.floor(Math.random()*a.length)];
  return 'HOC-'+s;
}
const currentShow=()=>state.shows.find(s=>s.id===state.currentShowId)||null;
const openShow=()=>{const s=currentShow();return (s&&s.status==='open')?s:null;};
const condPill=c=>'<span class="pill '+(c||'nm').toLowerCase()+'">'+(c||'NM')+'</span>';
const statusPill=s=>'<span class="pill '+s+'">'+s+'</span>';

/* ============================== Code39 barcode (real, scannable) ============================== */
const CODE39={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
function barcodeSVG(text,height){
  height=height||44; const narrow=2, wide=5, gap=narrow;
  const data='*'+(text.toUpperCase())+'*'; let x=0; let rects='';
  for(let c=0;c<data.length;c++){
    const pat=CODE39[data[c]]; if(!pat)continue;
    for(let i=0;i<9;i++){
      const w=pat[i]==='w'?wide:narrow;
      if(i%2===0){ rects+='<rect x="'+x+'" y="0" width="'+w+'" height="'+height+'" fill="#000"/>'; }
      x+=w;
    }
    x+=gap;
  }
  return '<svg width="'+x+'" height="'+height+'" viewBox="0 0 '+x+' '+height+'" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">'+rects+'</svg>';
}

/* ============================== settlement engine ============================== */
/* Computes, for a show: per-method totals, where money physically is (holdings),
   what each person earned, and the net settlement (who pays / receives). */
function computeSettlement(show){
  const sales=state.sales.filter(s=>s.showId===show.id && s.status!=='voided');
  const users=state.users;
  const earnings={}, holdings={}; users.forEach(u=>{earnings[u.id]=0;holdings[u.id]=0;});
  const methodTotals={}; METHODS.forEach(m=>methodTotals[m]=0);
  let prizeRev=0, totalRevenue=0;

  sales.forEach(sale=>{
    sale.lines.forEach(ln=>{
      const amt=Number(ln.soldPrice)||0;
      totalRevenue+=amt;
      if(ln.type==='prize'){ prizeRev+=amt; }
      else { earnings[ln.ownerId]=(earnings[ln.ownerId]||0)+amt; }
    });
    sale.payments.forEach(p=>{
      const amt=Number(p.amount)||0;
      methodTotals[p.method]=(methodTotals[p.method]||0)+amt;
      const acct=state.paymentAccounts[p.method];
      if(acct==='drawer'){ /* drawer cash, allocated below */ }
      else { const owner=(acct==='prompt')?p.receivedById:acct; if(owner) holdings[owner]=(holdings[owner]||0)+amt; }
    });
  });

  // prize split (50/50 reggie/manny by default config)
  const split=state.settings.prizeSplit||[];
  if(split.length && prizeRev>0){ const share=prizeRev/split.length; split.forEach(id=>earnings[id]=(earnings[id]||0)+share); }

  // cash-outs: person took cash from drawer during show -> counts as received & reduces earnings
  const cashOuts=show.cashOuts||[];
  let totalCashOut=0;
  cashOuts.forEach(co=>{ totalCashOut+=Number(co.amount)||0; earnings[co.userId]=(earnings[co.userId]||0)-(Number(co.amount)||0); holdings[co.userId]=(holdings[co.userId]||0)+(Number(co.amount)||0); });

  // trade buyouts settled at finalize: payer pays payees
  const tradeBuyouts=[];
  state.trades.filter(t=>t.showId===show.id).forEach(t=>{
    if(t.buyout && t.buyout.payerId){
      Object.entries(t.buyout.payees||{}).forEach(([payeeId,amt])=>{
        amt=Number(amt)||0; if(amt<=0)return;
        earnings[t.buyout.payerId]=(earnings[t.buyout.payerId]||0)-amt;
        earnings[payeeId]=(earnings[payeeId]||0)+amt;
        tradeBuyouts.push({tradeId:t.id,payerId:t.buyout.payerId,payeeId,amt});
      });
    }
  });

  const cashSales=methodTotals.cash||0;
  const drawerExpected=(show.cashFloat||0)+cashSales-totalCashOut;
  const drawerDistributable=cashSales-totalCashOut; // float retained, not distributed

  // settlement: each user should end at earnings[u]; currently holds holdings[u]; drawer holds distributable.
  const settle={}; users.forEach(u=>settle[u.id]=(earnings[u.id]||0)-(holdings[u.id]||0));

  return {sales,methodTotals,earnings,holdings,prizeRev,totalRevenue,cashSales,totalCashOut,
    drawerExpected,drawerDistributable,settle,cashOuts,tradeBuyouts,float:show.cashFloat||0};
}

/* per-owner profit (cost basis known locally, owner-only concept) */
function ownerProfit(show){
  const sales=state.sales.filter(s=>s.showId===show.id && s.status!=='voided');
  const profit={}; state.users.forEach(u=>profit[u.id]=0);
  sales.forEach(s=>s.lines.forEach(ln=>{
    if(ln.type==='prize')return;
    const cost=Number(ln.costBasis)||0;
    profit[ln.ownerId]=(profit[ln.ownerId]||0)+((Number(ln.soldPrice)||0)-cost);
  }));
  return profit;
}

/* ============================== CSV import ============================== */
function parseCSV(text){
  const rows=[]; let i=0,field='',row=[],inQ=false;
  while(i<text.length){
    const ch=text[i];
    if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false; } else field+=ch; }
    else { if(ch==='"')inQ=true; else if(ch===','){row.push(field);field='';} else if(ch==='\n'){row.push(field);rows.push(row);row=[];field='';} else if(ch==='\r'){} else field+=ch; }
    i++;
  }
  if(field.length||row.length){row.push(field);rows.push(row);}
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}
function header(headers,names){ // find a column index by candidate names
  const low=headers.map(h=>h.toLowerCase().trim());
  for(const n of names){ const idx=low.findIndex(h=>h===n||h.includes(n)); if(idx>=0)return idx; }
  return -1;
}

/* ============================== rendering ============================== */
const TABS=[
  ['dashboard','Dashboard'],['inventory','Inventory'],['add','Add Item'],['labels','Print Labels'],
  ['sell','Sell'],['trades','Trades'],['wishlist','Wish List'],['history','Sold History'],
  ['reports','Reports'],['settings','Settings']
];
function go(route){ ui.route=route; render(); window.scrollTo(0,0); }
function setUser(id){ state.currentUserId=id; save(); render(); }

function render(){
  // logo: prefer logo.png if present, else placeholder svg
  const logo=el('brandLogo'); if(logo && !logo.dataset.set){ logo.dataset.set='1'; logo.src='logo.png'; logo.onerror=()=>{logo.onerror=null;logo.src='logo.svg';}; }
  // user switch
  const us=el('userSwitch'); us.innerHTML=state.users.map(u=>'<option value="'+u.id+'"'+(u.id===state.currentUserId?' selected':'')+'>'+u.name+'</option>').join('');
  // tabs
  el('tabs').innerHTML=TABS.map(([r,l])=>'<button class="'+(ui.route===r?'active':'')+'" onclick="go(\''+r+'\')">'+l+'</button>').join('');
  // view
  const v=el('view');
  const fn=({dashboard:viewDashboard,inventory:viewInventory,add:viewAdd,labels:viewLabels,sell:viewSell,trades:viewTrades,wishlist:viewWishlist,history:viewHistory,reports:viewReports,settings:viewSettings})[ui.route]||viewDashboard;
  v.innerHTML=fn();
}

/* -------- Dashboard -------- */
function viewDashboard(){
  const inv=state.inventory;
  const avail=inv.filter(i=>i.status==='available').length;
  const intake=inv.filter(i=>i.status==='intake').length;
  const show=openShow();
  const totalValue=inv.filter(i=>i.status==='available').reduce((a,i)=>a+(Number(i.listPrice)||0),0);
  let showCard;
  if(show){
    const st=computeSettlement(show);
    showCard='<div class="card"><h3>Current show: '+show.name+'</h3>'+
      '<div class="kpi" style="grid-template-columns:repeat(3,1fr)">'+
      kpi('Sales',money(st.totalRevenue))+kpi('Items sold',countSold(show))+kpi('Drawer (expected)',money(st.drawerExpected))+
      '</div><div class="row" style="margin-top:12px"><button class="gold" onclick="go(\'sell\')">Go to Sell</button>'+
      '<button class="blue" onclick="go(\'reports\')">Finalize / Reports</button></div></div>';
  } else {
    showCard='<div class="card"><h3>No show running</h3><p class="muted">Start a show to begin selling. The drawer opens with the '+money(state.settings.cashFloat)+' float.</p>'+
      '<button class="gold" onclick="startShowPrompt()">＋ Start a show</button></div>';
  }
  return '<h2 class="page">Dashboard <small>'+new Date().toLocaleDateString()+' · acting as '+me().name+'</small></h2>'+
    '<div class="kpi">'+kpi('Available',avail)+kpi('In intake',intake)+kpi('Inventory value',money(totalValue))+kpi('Shows logged',state.shows.length)+'</div>'+
    '<div style="height:14px"></div>'+showCard+
    '<div class="card"><h3>Quick actions</h3><div class="row">'+
    '<button onclick="go(\'add\')">＋ Add item</button>'+
    '<button onclick="go(\'sell\')">Sell</button>'+
    '<button onclick="go(\'labels\')">Print labels</button>'+
    '<button onclick="go(\'trades\')">New trade</button>'+
    '<button class="ghost" onclick="loadSample()">Load sample data</button>'+
    '</div></div>';
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
  if(invFilter.cond)items=items.filter(i=>i.condition===invFilter.cond);
  const ownerOpts='<option value="">All owners</option>'+state.users.map(u=>'<option value="'+u.id+'"'+(invFilter.owner===u.id?' selected':'')+'>'+u.name+'</option>').join('');
  const rows=items.map(i=>'<tr>'+
    '<td><div class="invitem">'+photoThumb(i)+'<div><div>'+esc(i.name||'(unnamed)')+'</div>'+
      '<div class="muted">'+esc(i.set||'')+(i.number?' · #'+esc(i.number):'')+(i.language&&i.language!=='EN'?' · '+i.language:'')+(i.variance&&i.variance!=='Normal'?' · '+esc(i.variance):'')+'</div>'+
      '<div style="margin-top:3px">'+condPill(i.condition)+' '+(i.grade&&i.grade!=='Ungraded'?'<span class="tag">'+esc(i.grade)+'</span> ':'')+statusPill(i.status)+'</div></div></div></td>'+
    '<td><span class="pill owner">'+userName(i.ownerId)+'</span></td>'+
    '<td><span class="money">'+money(i.listPrice)+'</span>'+(i.priceOverride?' <span class="tag" title="manual override – feeds won\'t change this">🔒</span>':'')+
      (i.suggestedPrice?'<div class="muted">sugg '+money(i.suggestedPrice)+'</div>':'')+'</td>'+
    '<td><div class="muted" style="font-family:monospace">'+esc(i.barcode)+'</div>'+
      '<div class="row" style="margin-top:6px"><button class="sm" onclick="editItem(\''+i.id+'\')">Edit</button>'+
      (i.status==='available'?'<button class="sm gold" onclick="addBarcodeToCart(\''+i.barcode+'\')">Add to cart</button>':'')+
      (i.status==='intake'?'<button class="sm blue" onclick="finishIntake(\''+i.id+'\')">Finish intake</button>':'')+
      '</div></td></tr>').join('');
  return '<h2 class="page">Inventory <small>'+items.length+' shown · each copy has its own barcode</small></h2>'+
    '<div class="card"><div class="grid3">'+
      '<label class="fld"><span>Search</span><input value="'+esc(invFilter.q)+'" oninput="invFilter.q=this.value;render()" placeholder="name, set, number, barcode"/></label>'+
      '<label class="fld"><span>Owner</span><select onchange="invFilter.owner=this.value;render()">'+ownerOpts+'</select></label>'+
      '<label class="fld"><span>Status</span><select onchange="invFilter.status=this.value;render()">'+
        ['','available','intake','sold','hold'].map(s=>'<option'+(invFilter.status===s?' selected':'')+'>'+s+'</option>').join('')+'</select></label>'+
    '</div><div class="row"><button onclick="go(\'add\')">＋ Add item</button><button class="ghost" onclick="go(\'labels\')">Print labels</button></div></div>'+
    (items.length?'<div class="card"><table><thead><tr><th>Item</th><th>Owner</th><th>Price</th><th>Barcode / actions</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
      :'<div class="empty">No items yet. <a onclick="go(\'add\')">Add one</a> or <a onclick="loadSample()">load sample data</a>.</div>');
}
function photoThumb(i){return i.photo?'<img class="ph" src="'+i.photo+'"/>':'<div class="ph">no photo</div>';}

/* -------- Add / Edit item (intake) -------- */
let editingId=null;
function viewAdd(){
  const it=editingId?state.inventory.find(i=>i.id===editingId):null;
  const g=(k,d)=>it?(it[k]??d):d;
  const sel=(id,opts,cur)=>'<select id="'+id+'">'+opts.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  const ownerSel='<select id="f_owner">'+state.users.map(u=>'<option value="'+u.id+'"'+((g('ownerId',state.currentUserId))===u.id?' selected':'')+'>'+u.name+'</option>').join('')+'</select>';
  return '<h2 class="page">'+(it?'Edit item':'Add item')+' <small>Front photo + barcode required before it can sell</small></h2>'+
    '<div class="card"><div class="grid2">'+
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
      fld('Your cost (private)',inp('f_cost',g('costBasis',''),'owner-only, never shown to others','number'))+
      fld('List price',inp('f_price',g('listPrice',''),'sale price','number'))+
    '</div>'+
    '<label class="fld"><span>Front photo (required)</span><input id="f_photo" type="file" accept="image/*" onchange="previewPhoto(this)"/></label>'+
    '<div id="photoPrev">'+(g('photo','')?'<img class="ph" style="width:80px;height:110px" src="'+g('photo','')+'"/>':'')+'</div>'+
    '<label class="fld"><span><input type="checkbox" id="f_override" style="width:auto;display:inline" '+(g('priceOverride',false)?'checked':'')+'/> Lock price (manual override — CSV/feeds won\'t change it; required for graded)</span></label>'+
    '<hr class="sep"><div class="row">'+
      '<button class="gold" onclick="saveItem(true)">'+(it?'Save changes':'Save & print label')+'</button>'+
      (it?'':'<button class="blue" onclick="saveItem(false)">Save to intake (finish later)</button>')+
      '<button class="ghost" onclick="cancelEdit()">Cancel</button>'+
      (it?'<button class="red right" onclick="deleteItem(\''+it.id+'\')">Delete</button>':'')+
    '</div></div>';
}
let pendingPhoto=null;
function previewPhoto(input){
  const f=input.files[0]; if(!f)return;
  const r=new FileReader(); r.onload=()=>{ pendingPhoto=r.result; el('photoPrev').innerHTML='<img class="ph" style="width:80px;height:110px" src="'+pendingPhoto+'"/>'; }; r.readAsDataURL(f);
}
function collectItem(){
  return {category:val('f_cat'),set:val('f_set'),name:val('f_name'),number:val('f_number'),rarity:val('f_rarity'),
    variance:val('f_var'),language:val('f_lang'),grade:val('f_grade'),condition:val('f_cond'),ownerId:val('f_owner'),
    costBasis:num('f_cost'),listPrice:num('f_price'),priceOverride:el('f_override').checked};
}
function saveItem(makeAvailable){
  const data=collectItem();
  if(!data.name){toast('Card name is required');return;}
  if(editingId){
    const it=state.inventory.find(i=>i.id===editingId);
    Object.assign(it,data); if(pendingPhoto)it.photo=pendingPhoto;
    save();toast('Saved.');editingId=null;pendingPhoto=null;go('inventory');return;
  }
  const photo=pendingPhoto;
  if(makeAvailable && !photo){toast('Front photo required to make it sellable. Use "Save to intake" to add it later.');return;}
  const item=Object.assign({id:uid('item'),barcode:genBarcodeId(),photo:photo||null,suggestedPrice:0,
    status:makeAvailable?'available':'intake',dateAdded:Date.now()},data);
  state.inventory.push(item); save(); pendingPhoto=null;
  if(makeAvailable){ toast('Added & ready. Printing label…'); printLabels([item.id]); }
  else toast('Saved to intake.');
  go('inventory');
}
function editItem(id){editingId=id;pendingPhoto=null;go('add');}
function cancelEdit(){editingId=null;pendingPhoto=null;go('inventory');}
function deleteItem(id){ if(!confirm('Delete this item permanently?'))return; state.inventory=state.inventory.filter(i=>i.id!==id);save();toast('Deleted.');editingId=null;go('inventory'); }
function finishIntake(id){ const it=state.inventory.find(i=>i.id===id); if(!it.photo){editItem(id);toast('Add a front photo, then save.');return;} it.status='available';save();toast('Item is now available.');render(); }

/* -------- Print labels (batch grid) -------- */
function viewLabels(){
  const items=state.inventory.filter(i=>i.status==='available'||i.status==='intake');
  const rows=items.map(i=>'<label class="fld" style="margin:4px 0"><span style="display:inline">'+
    '<input type="checkbox" class="lblchk" value="'+i.id+'" style="width:auto;display:inline"/> '+esc(i.name)+' — '+esc(i.set)+' '+esc(i.number)+' ('+i.condition+') · '+i.barcode+'</span></label>').join('');
  return '<h2 class="page">Print labels <small>4×6 friendly grid — select, print, cut apart</small></h2>'+
    '<div class="card noprint"><div class="banner">Each label shows the card name, set, number &amp; condition above a real (Code 39) scannable barcode. Print, then cut.</div>'+
    '<div class="row" style="margin:10px 0"><button class="sm" onclick="toggleAllLabels(true)">Select all</button><button class="sm ghost" onclick="toggleAllLabels(false)">Clear</button>'+
    '<button class="gold right" onclick="printSelectedLabels()">🖨 Print selected</button></div>'+
    (items.length?rows:'<div class="empty">No items to label.</div>')+'</div>'+
    '<div id="labelSheet"></div>';
}
function toggleAllLabels(on){document.querySelectorAll('.lblchk').forEach(c=>c.checked=on);}
function printSelectedLabels(){const ids=[...document.querySelectorAll('.lblchk:checked')].map(c=>c.value);if(!ids.length){toast('Select at least one item.');return;}printLabels(ids);}
function printLabels(ids){
  const items=ids.map(id=>state.inventory.find(i=>i.id===id)).filter(Boolean);
  const html=items.map(i=>'<div class="barcode-label"><div class="nm">'+esc(i.name)+'<br>'+esc(i.set)+' '+esc(i.number)+' · '+i.condition+(i.grade&&i.grade!=='Ungraded'?' · '+esc(i.grade):'')+' · '+money(i.listPrice)+'</div>'+barcodeSVG(i.barcode,40)+'<div class="id">'+i.barcode+'</div></div>').join('');
  el('labelSheet').innerHTML='<div class="card"><div style="display:flex;flex-wrap:wrap">'+html+'</div></div>';
  setTimeout(()=>window.print(),200);
}

/* -------- Sell (POS) -------- */
function viewSell(){
  const show=openShow();
  if(!show) return '<h2 class="page">Sell</h2><div class="card"><h3>No show running</h3><p class="muted">Start a show to take sales.</p><button class="gold" onclick="startShowPrompt()">＋ Start a show</button></div>';
  const lines=ui.cart.map((c,idx)=>cartLineHTML(c,idx)).join('');
  const total=cartTotal();
  return '<h2 class="page">Sell <small>'+show.name+' · drawer float '+money(show.cashFloat)+'</small></h2>'+
    '<div class="card"><h3>Scan / add to cart</h3>'+
    '<div class="scanbar"><input id="scanInput" placeholder="Scan or type barcode, then Enter" onkeydown="if(event.key===\'Enter\'){addBarcodeToCart(this.value);this.value=\'\';}"/>'+
      '<button class="gold" onclick="var i=el(\'scanInput\');addBarcodeToCart(i.value);i.value=\'\'">Add</button></div>'+
    '<div class="row" style="margin-top:10px">'+
      '<button class="sm" onclick="pickFromInventory()">Browse inventory</button>'+
      '<button class="sm" onclick="addManualLine()">Manual item</button>'+
      '<button class="sm" onclick="addPrizeLine()">Prize play ('+money(state.settings.prizePrice)+')</button>'+
    '</div></div>'+
    '<div class="card"><h3>Cart</h3>'+(ui.cart.length?lines:'<div class="empty">Cart is empty — scan a barcode to begin.</div>')+
      '<hr class="sep"><div class="row"><div class="big">'+money(total)+'</div>'+
      (ui.cart.length?'<button class="gold right" onclick="go(\'checkout\')">Payment →</button><button class="ghost" onclick="ui.cart=[];render()">Clear cart</button>':'')+'</div></div>'+
    (ui.route==='checkout'?'':'');
}
function cartLineHTML(c,idx){
  const adj=c.listPrice!=null && Number(c.soldPrice)!==Number(c.listPrice);
  return '<div class="cart-line"><div style="flex:1"><div>'+esc(c.desc)+'</div>'+
    '<div class="muted">'+(c.type==='card'?('owner '+userName(c.ownerId)):c.type)+(adj?' · was '+money(c.listPrice)+(c.discountReason?' ('+esc(c.discountReason)+')':''):'')+'</div></div>'+
    '<div style="width:110px"><input type="number" value="'+c.soldPrice+'" onchange="setCartPrice('+idx+',this.value)"/></div>'+
    '<button class="sm red" onclick="removeCart('+idx+')">✕</button></div>';
}
function addBarcodeToCart(code){
  code=(code||'').trim().toUpperCase(); if(!code)return;
  const it=state.inventory.find(i=>i.barcode.toUpperCase()===code);
  if(!it){toast('No item with barcode '+code);return;}
  if(it.status==='sold'){toast('That copy is already sold.');return;}
  if(it.status==='intake'){toast('That item is still in intake (no photo/finish).');return;}
  if(ui.cart.some(c=>c.itemId===it.id)){toast('Already in cart.');return;}
  // want-list ping
  pingWantList(it);
  ui.cart.push({itemId:it.id,type:'card',desc:it.name+' '+(it.number||'')+' ('+it.condition+')',ownerId:it.ownerId,listPrice:Number(it.listPrice)||0,soldPrice:Number(it.listPrice)||0,costBasis:Number(it.costBasis)||0,discountReason:''});
  render(); toast('Added: '+it.name);
}
function pickFromInventory(){
  const items=state.inventory.filter(i=>i.status==='available'&&!ui.cart.some(c=>c.itemId===i.id));
  if(!items.length){toast('No available items.');return;}
  const name=prompt('Type part of a card name to add:\n'+items.slice(0,12).map(i=>'• '+i.name+' '+i.number+' ('+money(i.listPrice)+')').join('\n'));
  if(!name)return; const m=items.find(i=>(i.name+' '+i.number).toLowerCase().includes(name.toLowerCase()));
  if(m)addBarcodeToCart(m.barcode); else toast('No match.');
}
function addManualLine(){
  const desc=prompt('Manual item description (e.g. penny sleeves, bulk lot):'); if(!desc)return;
  const price=parseFloat(prompt('Price:')||'0')||0;
  const owner=prompt('Owner initials R/M/H (whose sale):','R'); const oid={R:'u_reggie',M:'u_manny',H:'u_hailey'}[(owner||'R').toUpperCase()]||state.currentUserId;
  ui.cart.push({itemId:null,type:'manual',desc:desc,ownerId:oid,listPrice:price,soldPrice:price,costBasis:0,discountReason:''});render();
}
function addPrizeLine(){
  const qty=parseInt(prompt('How many prize plays?','1')||'1')||1;
  const price=parseFloat(prompt('Total price (default '+money(state.settings.prizePrice*qty)+'):',(state.settings.prizePrice*qty).toFixed(2))||'0')||0;
  ui.cart.push({itemId:null,type:'prize',desc:qty+' prize play(s)',ownerId:null,qty:qty,listPrice:state.settings.prizePrice*qty,soldPrice:price,costBasis:0,discountReason:''});render();
}
function setCartPrice(idx,v){
  const c=ui.cart[idx];const np=parseFloat(v)||0;
  if(np<c.listPrice && !c.discountReason){c.discountReason=prompt('Reason for the lower price (tracked in report):','haggled')||'adjusted';}
  c.soldPrice=np;render();
}
function removeCart(idx){ui.cart.splice(idx,1);render();}
function cartTotal(){return ui.cart.reduce((a,c)=>a+(Number(c.soldPrice)||0),0);}

/* -------- Checkout -------- */
function viewCheckout(){
  const total=cartTotal();
  const paid=ui.cartPayments.reduce((a,p)=>a+(Number(p.amount)||0),0);
  const remain=total-paid;
  const pays=ui.cartPayments.map((p,idx)=>'<div class="cart-line"><div style="flex:1">'+METHOD_LABEL[p.method]+(p.method==='zelle'?' → '+userName(p.receivedById):(state.paymentAccounts[p.method]!=='drawer'?' → '+userName(state.paymentAccounts[p.method]):' → drawer'))+'</div><div class="money">'+money(p.amount)+'</div><button class="sm red" onclick="ui.cartPayments.splice('+idx+',1);render()">✕</button></div>').join('');
  return '<h2 class="page">Payment <small>total due '+money(total)+'</small></h2>'+
    '<div class="card"><h3>Add payment</h3><div class="grid2">'+
    '<label class="fld"><span>Method</span><select id="payMethod">'+METHODS.map(m=>'<option value="'+m+'">'+METHOD_LABEL[m]+'</option>').join('')+'</select></label>'+
    '<label class="fld"><span>Amount</span><input id="payAmount" type="number" value="'+(remain>0?remain.toFixed(2):'')+'"/></label>'+
    '</div><button class="gold" onclick="addPayment()">Add payment</button></div>'+
    '<div class="card"><h3>Payments</h3>'+(ui.cartPayments.length?pays:'<div class="muted">None yet.</div>')+
    '<hr class="sep"><div class="row"><div>Paid <span class="money">'+money(paid)+'</span> · Remaining <span class="money" style="color:'+(Math.abs(remain)<0.005?'var(--ok)':'var(--gold)')+'">'+money(remain)+'</span></div></div></div>'+
    '<div class="row"><button class="blue" onclick="go(\'sell\')">← Back to cart</button>'+
    '<button class="gold right" onclick="completeSale()">✔ Complete sale</button></div>';
}
function addPayment(){
  const method=val('payMethod'); let amount=parseFloat(val('payAmount'))||0;
  if(amount<=0){toast('Enter an amount.');return;}
  let receivedById=null;
  const acct=state.paymentAccounts[method];
  if(acct==='prompt'){ const who=prompt('Whose '+METHOD_LABEL[method]+' received it? (R / M / H)','R'); receivedById={R:'u_reggie',M:'u_manny',H:'u_hailey'}[(who||'R').toUpperCase()]||state.currentUserId; }
  ui.cartPayments.push({method,amount,receivedById});render();
}
function completeSale(){
  const total=cartTotal(); const paid=ui.cartPayments.reduce((a,p)=>a+(Number(p.amount)||0),0);
  if(!ui.cart.length){toast('Cart empty.');return;}
  if(Math.abs(total-paid)>0.005){ if(!confirm('Payments ('+money(paid)+') don\'t match total ('+money(total)+'). Record anyway?'))return; }
  const show=openShow(); if(!show){toast('No open show.');return;}
  const sale={id:uid('sale'),showId:show.id,createdById:state.currentUserId,createdAt:Date.now(),status:'completed',
    lines:ui.cart.map(c=>({id:uid('ln'),itemId:c.itemId,type:c.type,desc:c.desc,ownerId:c.ownerId,qty:c.qty||1,
      listPrice:c.listPrice,soldPrice:Number(c.soldPrice)||0,costBasis:c.costBasis||0,discountReason:c.discountReason||''})),
    payments:ui.cartPayments.slice()};
  state.sales.push(sale);
  // mark inventory sold
  ui.cart.forEach(c=>{ if(c.itemId){const it=state.inventory.find(i=>i.id===c.itemId); if(it)it.status='sold';} });
  ui.cart=[];ui.cartPayments=[];save();toast('Sale recorded ✔');go('sell');
}

/* -------- Trades -------- */
function viewTrades(){
  const show=openShow();
  const list=state.trades.slice().reverse().map(t=>{
    const out=t.outItems.reduce((a,i)=>a+(Number(i.value)||0),0);
    const inn=t.inItems.reduce((a,i)=>a+(Number(i.value)||0),0);
    const pct=out>0?Math.round((t.customerCredit/out)*100):0;
    return '<div class="card"><div class="row"><b>Trade '+new Date(t.createdAt).toLocaleDateString()+'</b>'+
      '<span class="right tag">our out '+money(out)+' · credit given '+money(t.customerCredit)+' · '+pct+'%</span></div>'+
      '<div class="grid2"><div><div class="muted">We gave (out):</div>'+t.outItems.map(i=>'• '+esc(i.desc)+' — '+money(i.value)+' ('+userName(i.ownerId)+')').join('<br>')+'</div>'+
      '<div><div class="muted">We received (in):</div>'+t.inItems.map(i=>'• '+esc(i.desc)+' — '+money(i.value)).join('<br>')+'</div></div>'+
      (t.buyout&&t.buyout.payerId?'<div class="banner" style="margin-top:8px">Buyout: '+userName(t.buyout.payerId)+' keeps incoming inventory, pays '+Object.entries(t.buyout.payees||{}).map(([id,a])=>userName(id)+' '+money(a)).join(', ')+' at finalize.</div>':'')+
      '</div>';
  }).join('');
  return '<h2 class="page">Trades <small>customer never sees our values; internal shows both sides + %</small></h2>'+
    (show?'<div class="card noprint"><button class="gold" onclick="newTrade()">＋ New trade</button></div>':'<div class="banner noprint" style="margin-bottom:14px">Start a show to log a trade against it.</div>')+
    (state.trades.length?list:'<div class="empty">No trades logged.</div>');
}
function newTrade(){
  const show=openShow(); if(!show){toast('Start a show first.');return;}
  alert('Quick trade entry (beta). You\'ll enter outgoing items (ours), incoming items (theirs), and credit given.');
  const outItems=[]; let more=true;
  while(more){
    const d=prompt('Outgoing item we GAVE (blank to stop):'); if(!d){more=false;break;}
    const v=parseFloat(prompt('Our value for "'+d+'":')||'0')||0;
    const o=prompt('Owner R/M/H:','R'); const oid={R:'u_reggie',M:'u_manny',H:'u_hailey'}[(o||'R').toUpperCase()]||'u_reggie';
    outItems.push({desc:d,value:v,ownerId:oid});
  }
  const inItems=[]; more=true;
  while(more){
    const d=prompt('Incoming item we RECEIVED (blank to stop):'); if(!d){more=false;break;}
    const v=parseFloat(prompt('Our value for "'+d+'":')||'0')||0;
    inItems.push({desc:d,value:v,condition:'NM'});
  }
  const credit=parseFloat(prompt('Trade credit we gave the customer:')||'0')||0;
  // buyout if multiple owners outgoing
  const owners=[...new Set(outItems.map(i=>i.ownerId))];
  let buyout=null;
  if(owners.length>1){
    const payerInit=prompt('Multiple owners gave items. Who keeps the incoming inventory & buys the others out? (R/M/H)','R');
    const payerId={R:'u_reggie',M:'u_manny',H:'u_hailey'}[(payerInit||'R').toUpperCase()]||'u_reggie';
    const payees={};
    owners.filter(o=>o!==payerId).forEach(o=>{ const owed=outItems.filter(i=>i.ownerId===o).reduce((a,i)=>a+i.value,0); payees[o]=owed; });
    buyout={payerId,payees};
  }
  state.trades.push({id:uid('trade'),showId:show.id,createdAt:Date.now(),outItems,inItems,customerCredit:credit,buyout,note:''});
  save();toast('Trade logged.');render();
}

/* -------- Wish list -------- */
function pingWantList(item){
  state.wantlist.forEach(w=>{ if(item.name.toLowerCase().includes(w.text.toLowerCase()) && w.userId!==state.currentUserId){
    toast('🔔 '+userName(w.userId)+' wants this: '+w.text);
  }});
}
function viewWishlist(){
  const rows=state.wantlist.slice().reverse().map(w=>'<div class="cart-line"><div style="flex:1"><b>'+esc(w.text)+'</b><div class="muted">'+userName(w.userId)+(w.note?' · '+esc(w.note):'')+'</div></div><button class="sm red" onclick="delWant(\''+w.id+'\')">✕</button></div>').join('');
  return '<h2 class="page">Wish list <small>when anyone scans a match, the wanter gets pinged</small></h2>'+
    '<div class="card"><div class="grid2"><label class="fld"><span>Card you\'re hunting</span><input id="w_text" placeholder="e.g. Umbreon VMAX"/></label>'+
    '<label class="fld"><span>Note (optional)</span><input id="w_note" placeholder="condition, budget…"/></label></div>'+
    '<button class="gold" onclick="addWant()">Add to my wish list</button></div>'+
    (state.wantlist.length?'<div class="card">'+rows+'</div>':'<div class="empty">Nothing on the wish list yet.</div>');
}
function addWant(){const t=val('w_text');if(!t){toast('Enter a card.');return;}state.wantlist.push({id:uid('want'),userId:state.currentUserId,text:t,note:val('w_note')});save();toast('Added.');render();}
function delWant(id){state.wantlist=state.wantlist.filter(w=>w.id!==id);save();render();}

/* -------- Sold history -------- */
let histQ='';
function viewHistory(){
  const sold=[];
  state.sales.filter(s=>s.status!=='voided').forEach(s=>s.lines.forEach(l=>{ if(l.type!=='prize') sold.push({...l,when:s.createdAt,showId:s.showId,payMethods:s.payments.map(p=>METHOD_LABEL[p.method]).join('+')}); }));
  let rows=sold.sort((a,b)=>b.when-a.when);
  const q=histQ.toLowerCase(); if(q)rows=rows.filter(r=>r.desc.toLowerCase().includes(q));
  // frequency / trend
  const freq={}; sold.forEach(r=>{const k=r.desc.replace(/\s+\(.*\)$/,'').trim();freq[k]=(freq[k]||0)+1;});
  const top=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const trh=top.map(([k,n])=>'<span class="tag" style="margin:3px">'+esc(k)+' ×'+n+'</span>').join(' ');
  const body=rows.map(r=>'<tr><td>'+new Date(r.when).toLocaleDateString()+'</td><td>'+esc(r.desc)+'</td><td>'+userName(r.ownerId)+'</td><td class="money">'+money(r.soldPrice)+'</td><td class="muted">'+(r.discountReason?'↓ '+esc(r.discountReason):'')+'</td><td class="muted">'+r.payMethods+'</td></tr>').join('');
  return '<h2 class="page">Sold history <small>'+sold.length+' line items sold</small></h2>'+
    (top.length?'<div class="card"><h3>Trending (sells most often)</h3>'+trh+'</div>':'')+
    '<div class="card"><label class="fld"><span>Search sold items</span><input value="'+esc(histQ)+'" oninput="histQ=this.value;render()" placeholder="card name"/></label></div>'+
    (rows.length?'<div class="card"><table><thead><tr><th>Date</th><th>Item</th><th>Owner</th><th>Sold</th><th>Adj</th><th>Pay</th></tr></thead><tbody>'+body+'</tbody></table></div>':'<div class="empty">Nothing sold yet.</div>');
}

/* -------- Reports / shows / finalize -------- */
function viewReports(){
  const show=openShow();
  let cur='';
  if(show){
    const st=computeSettlement(show);
    cur='<div class="card"><h3>Open show: '+esc(show.name)+'</h3>'+
      '<div class="kpi" style="grid-template-columns:repeat(3,1fr)">'+kpi('Revenue',money(st.totalRevenue))+kpi('Drawer expected',money(st.drawerExpected))+kpi('Items sold',countSold(show))+'</div>'+
      '<div class="row" style="margin-top:12px"><button class="sm" onclick="addCashOut()">Record cash-out</button>'+
      '<button class="blue right" onclick="finalizeShow()">Finalize show & report</button></div>'+
      (show.cashOuts&&show.cashOuts.length?'<hr class="sep"><div class="muted">Cash-outs: '+show.cashOuts.map(c=>userName(c.userId)+' '+money(c.amount)+(c.note?' ('+esc(c.note)+')':'')).join(', ')+'</div>':'')+
      '</div>';
  } else {
    cur='<div class="card"><h3>No open show</h3><button class="gold" onclick="startShowPrompt()">＋ Start a show</button></div>';
  }
  const finals=state.shows.filter(s=>s.status==='finalized').reverse().map(s=>'<div class="cart-line"><div style="flex:1"><b>'+esc(s.name)+'</b><div class="muted">finalized '+new Date(s.finalizedAt).toLocaleString()+'</div></div><button class="sm gold" onclick="viewReport(\''+s.id+'\')">View / print</button></div>').join('');
  return '<h2 class="page">Reports <small>start a show, take sales, finalize for the money breakdown</small></h2>'+cur+
    '<div class="card"><h3>Finalized shows</h3>'+(finals||'<div class="muted">None yet.</div>')+'</div>'+
    '<div id="reportOut"></div>';
}
function startShowPrompt(){
  if(openShow()){toast('A show is already open.');return;}
  const name=prompt('Show name:', 'Card Show '+new Date().toLocaleDateString()); if(!name)return;
  const show={id:uid('show'),name,date:Date.now(),status:'open',cashFloat:state.settings.cashFloat,
    prizePlaysStart:state.settings.prizePlaysPerShow,cashOuts:[],finalizedAt:null};
  state.shows.push(show);state.currentShowId=show.id;save();toast('Show started. Drawer float '+money(show.cashFloat)+'.');go('sell');
}
function addCashOut(){
  const show=openShow();if(!show)return;
  const who=prompt('Who is taking cash from the drawer? (R/M/H)','R');const uidd={R:'u_reggie',M:'u_manny',H:'u_hailey'}[(who||'R').toUpperCase()]||state.currentUserId;
  const amt=parseFloat(prompt('Amount taken:')||'0')||0; if(amt<=0)return;
  const note=prompt('Note (what for):','')||'';
  show.cashOuts=show.cashOuts||[];show.cashOuts.push({id:uid('co'),userId:uidd,amount:amt,note});save();toast('Cash-out recorded.');render();
}
function finalizeShow(){
  const show=openShow();if(!show)return;
  if(!confirm('Finalize "'+show.name+'"? No more sales can be added.'))return;
  show.status='finalized';show.finalizedAt=Date.now();save();toast('Show finalized.');viewReport(show.id);
}
function viewReport(showId){
  const show=state.shows.find(s=>s.id===showId);const st=computeSettlement(show);const profit=ownerProfit(show);
  const methodRows=METHODS.map(m=>{const acct=state.paymentAccounts[m];const to=acct==='drawer'?'Drawer':(acct==='prompt'?'(per sale)':userName(acct));return '<tr><td>'+METHOD_LABEL[m]+'</td><td class="muted">'+to+'</td><td class="money">'+money(st.methodTotals[m])+'</td></tr>';}).join('');
  const settleRows=state.users.map(u=>{const s=st.settle[u.id];return '<tr><td>'+u.name+'</td><td class="money">'+money(st.earnings[u.id])+'</td><td class="money">'+money(st.holdings[u.id])+'</td><td class="money" style="color:'+(s>=0?'var(--ok)':'var(--red)')+'">'+(s>=0?'receives ':'pays ')+money(Math.abs(s))+'</td><td class="money">'+money(profit[u.id])+'</td></tr>';}).join('');
  const buyoutRows=st.tradeBuyouts.map(b=>'<li>'+userName(b.payerId)+' pays '+userName(b.payeeId)+' '+money(b.amt)+' (trade buyout)</li>').join('');
  const cashoutRows=st.cashOuts.map(c=>'<li>'+userName(c.userId)+' took '+money(c.amount)+' from drawer'+(c.note?' — '+esc(c.note):'')+'</li>').join('');
  const html='<div class="card" id="reportCard">'+
    '<h2 style="margin-top:0">House of Cards — Show Report</h2>'+
    '<div class="muted">'+esc(show.name)+' · '+new Date(show.date).toLocaleDateString()+(show.finalizedAt?' · finalized '+new Date(show.finalizedAt).toLocaleString():'')+'</div><hr class="sep">'+
    '<h3>1 · Where the money is</h3><table><thead><tr><th>Method</th><th>Receives to</th><th>Total</th></tr></thead><tbody>'+methodRows+
      '<tr><td colspan="2"><b>Total revenue</b></td><td class="money"><b>'+money(st.totalRevenue)+'</b></td></tr></tbody></table>'+
    '<div class="banner" style="margin-top:10px">Cash drawer: float '+money(st.float)+' (Reggie\'s, stays in) + cash sales '+money(st.cashSales)+' − cash-outs '+money(st.totalCashOut)+' = <b>expected '+money(st.drawerExpected)+'</b>. Distributable cash (excl. float): <b>'+money(st.drawerDistributable)+'</b>.</div>'+
    '<h3 style="margin-top:16px">2 · Settlement — who gets what</h3>'+
    '<table><thead><tr><th>Person</th><th>Earned</th><th>Holding</th><th>Net</th><th>Profit*</th></tr></thead><tbody>'+settleRows+'</tbody></table>'+
    '<div class="muted" style="margin-top:6px">"Holding" = money already in their accounts + cash they took. "Net" squares everyone to what they earned (paid from/into the drawer cash). *Profit = sold − your cost (owner figure).</div>'+
    (st.prizeRev>0?'<p>Prize machine revenue '+money(st.prizeRev)+' split: '+state.settings.prizeSplit.map(id=>userName(id)+' '+money(st.prizeRev/state.settings.prizeSplit.length)).join(', ')+'.</p>':'')+
    (cashoutRows?'<h3 style="margin-top:14px">Cash-outs</h3><ul>'+cashoutRows+'</ul>':'')+
    (buyoutRows?'<h3 style="margin-top:14px">Trade buyouts (settled now)</h3><ul>'+buyoutRows+'</ul>':'')+
    '<div class="row noprint" style="margin-top:14px"><button class="gold" onclick="window.print()">🖨 Print / Save PDF</button></div>'+
    '</div>';
  el('reportOut').innerHTML=html; el('reportOut').scrollIntoView({behavior:'smooth'});
}

/* -------- Settings -------- */
function viewSettings(){
  const s=state.settings;
  const acctSel=(m)=>{const cur=state.paymentAccounts[m];const opts=[['drawer','Cash drawer (no owner)'],['prompt','Ask per sale']].concat(state.users.map(u=>[u.id,u.name]));
    return '<select onchange="setAcct(\''+m+'\',this.value)">'+opts.map(([v,l])=>'<option value="'+v+'"'+(cur===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';};
  const acctRows=METHODS.map(m=>'<tr><td>'+METHOD_LABEL[m]+'</td><td>'+acctSel(m)+'</td></tr>').join('');
  return '<h2 class="page">Settings</h2>'+
    '<div class="card"><h3>Payment accounts — who receives each method</h3><table><tbody>'+acctRows+'</tbody></table>'+
      '<div class="muted" style="margin-top:8px">Current: Cash→drawer · Venmo→Manny · Cash App/PayPal/Square→Reggie · Zelle→ask per sale.</div></div>'+
    '<div class="card"><h3>Show defaults</h3><div class="grid3">'+
      fld('Cash float',inp('s_float',s.cashFloat,'','number'))+
      fld('Prize price',inp('s_prize',s.prizePrice,'','number'))+
      fld('Prize plays/show',inp('s_plays',s.prizePlaysPerShow,'','number'))+
    '</div><button class="gold" onclick="saveSettings()">Save defaults</button><div class="muted" style="margin-top:6px">Prize machine splits 50/50 Reggie ↔ Manny.</div></div>'+
    '<div class="card"><h3>Team</h3>'+state.users.map(u=>'• '+u.name).join('<br>')+'<div class="muted" style="margin-top:6px">(House of Cards — all free, all can finalize.)</div></div>'+
    '<div class="card"><h3>Beta — reset data</h3>'+
      '<div class="banner">Use this to clear everything you entered while testing so you start clean for your first real show.</div>'+
      '<div class="row" style="margin-top:10px">'+
      '<button class="red" onclick="resetTestData()">Clear test data (keep team & settings)</button>'+
      '<button class="red ghost" onclick="factoryReset()">Full factory reset</button>'+
      '<button class="ghost right" onclick="loadSample()">Load sample data</button>'+
      '</div></div>'+
    '<div class="card"><h3>About</h3><div class="muted">House of Cards — local beta build. All data is stored only in this browser on this device, works offline. The cloud/multi-device version comes after beta testing.</div></div>';
}
function setAcct(m,v){state.paymentAccounts[m]=v;save();toast('Updated.');}
function saveSettings(){state.settings.cashFloat=num('s_float');state.settings.prizePrice=num('s_prize');state.settings.prizePlaysPerShow=num('s_plays');save();toast('Saved.');}
function resetTestData(){ if(!confirm('Clear all inventory, sales, shows, trades and wish list? Team & settings stay. This cannot be undone.'))return;
  state.inventory=[];state.sales=[];state.shows=[];state.trades=[];state.wantlist=[];state.currentShowId=null;ui.cart=[];ui.cartPayments=[];save();toast('Test data cleared. Fresh start ready.');go('dashboard'); }
function factoryReset(){ if(!confirm('FULL reset to factory defaults (team, settings, everything)? Cannot be undone.'))return;
  state=freshState();ui={route:'dashboard',cart:[],cartPayments:[]};save();toast('Factory reset done.');render(); }

/* -------- sample data -------- */
function loadSample(){
  if(state.inventory.length && !confirm('Add sample items on top of existing data?'))return;
  const samp=[
    ['Pokemon','Surging Sparks','Pikachu ex','238/191','SIR','Holofoil','EN','Ungraded','NM','u_reggie',180,329],
    ['Pokemon','Prismatic Evolutions','Umbreon ex','161/131','SIR','Holofoil','EN','Ungraded','NM','u_manny',900,1450],
    ['Pokemon','151','Charizard ex','199/165','SIR','Holofoil','EN','PSA 10','NM','u_reggie',400,720],
    ['Pokemon','Base Set','Blastoise','2/102','Holo','Holofoil','EN','Ungraded','LP','u_hailey',120,210],
    ['Pokemon','Paldea Evolved','Iono','254/193','SIR','Holofoil','EN','Ungraded','NM','u_manny',55,98]
  ];
  samp.forEach(r=>state.inventory.push({id:uid('item'),barcode:genBarcodeId(),category:r[0],set:r[1],name:r[2],number:r[3],rarity:r[4],variance:r[5],language:r[6],grade:r[7],condition:r[8],ownerId:r[9],costBasis:r[10],listPrice:r[11],suggestedPrice:r[11],priceOverride:r[7]!=='Ungraded',photo:null,status:'available',dateAdded:Date.now()}));
  save();toast('Sample items added.');go('inventory');
}

/* ============================== utils ============================== */
function fld(label,inner){return '<label class="fld"><span>'+label+'</span>'+inner+'</label>';}
function inp(id,v,ph,type){return '<input id="'+id+'" type="'+(type||'text')+'" value="'+(v==null?'':esc(String(v)))+'" placeholder="'+(ph||'')+'"/>';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* route extension for checkout (not a tab) */
const _render=render;
render=function(){ if(ui.route==='checkout'){ el('tabs').innerHTML=TABS.map(([r,l])=>'<button class="'+(r==='sell'?'active':'')+'" onclick="go(\''+r+'\')">'+l+'</button>').join(''); el('view').innerHTML=viewCheckout(); const us=el('userSwitch'); us.innerHTML=state.users.map(u=>'<option value="'+u.id+'"'+(u.id===state.currentUserId?' selected':'')+'>'+u.name+'</option>').join(''); const logo=el('brandLogo'); if(logo&&!logo.dataset.set){logo.dataset.set='1';logo.src='logo.png';logo.onerror=()=>{logo.onerror=null;logo.src='logo.svg';};} return; } _render(); };

/* ============================== boot ============================== */
(async function init(){
  try{ state=await loadState(); }catch(e){ state=null; }
  if(!state){ state=freshState(); save(); }
  // migrate missing fields
  state.sales=state.sales||[];state.trades=state.trades||[];state.wantlist=state.wantlist||[];
  render();
})();
