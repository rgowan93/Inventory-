/* House of Cards — Show Stats: live show-day ledger, vending-machine tallies,
   end-of-show settlement + PDF reports. Staff only. Money math lives in show-math.js
   (unit-tested); this file is UI + sync. Multiple staff devices can work the same
   show at once — state lives in Supabase and re-syncs every few seconds. */

const SS_FORMS=[['cash','Cash'],['cashapp','Cash App'],['venmo','Venmo'],['paypal','PayPal'],['zelle','Zelle'],['square','Square']];
const SS_PEOPLE=[['reggie','Reggie'],['manny','Manny'],['hailey','Hailey']];
const SS_BOXES=[['cash','Cash'],['cashapp','Cash App'],['venmo','Venmo'],['paypal','PayPal'],['square','Square'],['zelle_reggie','Zelle — Reggie'],['zelle_manny','Zelle — Manny'],['zelle_hailey','Zelle — Hailey']];
const SS_FORM_NAME={}; SS_FORMS.forEach(f=>SS_FORM_NAME[f[0]]=f[1]);
const SS_PERSON_NAME={}; SS_PEOPLE.forEach(p=>SS_PERSON_NAME[p[0]]=p[1]);
function ssCap(s){ s=String(s||''); return s.charAt(0).toUpperCase()+s.slice(1); }

let _ss={ wrap:null, data:null, tab:'sales', sel:{form:null,person:null,dir:1}, photo:null, busy:false, poll:null, hold:null, winUp:null, pending:{} };

async function ssCreds(){ const c=await _staffCreds(); return c; }
/* Cached-creds-only variant for the background poll: never opens a login modal,
   Face ID sheet, or password prompt from a timer. */
function ssCredsCached(){ const s=staffSession(); if(!s||!_staffPw)return null; return {p_user:s.username,p_pass:_staffPw}; }

function openShowStats(){
  if(!staffSession()){ openLogin(); return; }
  if(_ss.poll){ clearInterval(_ss.poll); _ss.poll=null; }
  ssHoldStop();
  if(_ss.winUp){ window.removeEventListener('pointerup',_ss.winUp); window.removeEventListener('pointercancel',_ss.winUp); _ss.winUp=null; }
  const ex=document.querySelector('.ssmodal'); if(ex)ex.remove();
  const w=document.createElement('div'); w.className='scanmodal pagewrap ssmodal'; document.body.appendChild(w);
  w.innerHTML='<div class="card pagecard">'+pageHead('Show stats','ss_x')+'<div id="ss_body"><div class="muted">Loading…</div></div></div>';
  _ss.wrap=w; _ss.tab='sales'; _ss.sel={form:null,person:null,dir:1}; _ss.photo=null; _ss.pending={};
  ssWireTallies(w);
  const close=()=>{ if(_ss.poll){ clearInterval(_ss.poll); _ss.poll=null; } ssHoldStop();
    if(_ss.winUp){ window.removeEventListener('pointerup',_ss.winUp); window.removeEventListener('pointercancel',_ss.winUp); _ss.winUp=null; }
    _ss.wrap=null; w.remove(); };
  w.querySelector('#ss_x').onclick=close;
  ssRefresh();
  _ss.poll=setInterval(()=>ssRefresh(true), 12000);
}

/* true while the staffer is mid-something a repaint would destroy */
function ssUserBusy(){
  if(_ss.hold)return true;                                        // finger down on a tally box
  const w=_ss.wrap; if(!w)return false;
  const amt=w.querySelector('#ssc_amt'); if(amt&&amt.value)return true;   // typing a sale amount
  const sf=w.querySelector('#ss_startform'); if(sf&&sf.children.length)return true; // start-show form open
  const a=document.activeElement;
  if(a&&w.contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))return true;     // focused in any field
  return false;
}

async function ssRefresh(silent){
  if(!_ss.wrap)return;
  const c = silent ? ssCredsCached() : await ssCreds();
  if(!c){ if(!silent)toast('Unlock to view.'); return; }
  const r=await sbRpc('show_live_get',c);
  if(!r||r.ok!==true){ if(!silent){ const b=_ss.wrap&&_ss.wrap.querySelector('#ss_body'); if(b)b.innerHTML='<div class="muted">Could not load. <button class="sm ghost" onclick="ssRefresh()">Retry</button></div>'; } return; }
  // overlay tally bumps still in flight, so a refresh can't clobber (or double-revert) them
  if(r.tallies){ const pend=_ss.pending||{}; Object.keys(pend).forEach(b=>{ if(pend[b]) r.tallies[b]=Math.max(0,(r.tallies[b]||0)+pend[b]); }); }
  // don't repaint over someone mid-entry (photo + chip picks survive a repaint, so they don't block it)
  if(silent && ssUserBusy()){ _ss.data=r; return; }
  _ss.data=r; ssPaint();
}

function ssPaint(){
  if(!_ss.wrap)return; const body=_ss.wrap.querySelector('#ss_body'); if(!body)return;
  const d=_ss.data||{};
  if(!d.show){ ssPaintIdle(body); return; }
  ssPaintLive(body, d);
}

/* ---------- idle: start a show + history ---------- */
function ssPaintIdle(body){
  body.innerHTML=
    '<div class="card" style="text-align:center">'+
      '<div class="muted" style="margin-bottom:10px">No show is running.</div>'+
      '<button class="gold" style="width:100%;font-size:17px;padding:15px" onclick="ssStartForm()">'+svgIcon('plus')+' Start show</button>'+
    '</div>'+
    '<div id="ss_startform"></div>'+
    '<hr class="sep"><div class="acct-sec">'+svgIcon('chart')+' Profit per show</div><div id="ss_chart"><div class="muted">Loading…</div></div>'+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('box')+' Past shows &amp; PDF log</div><div id="ss_hist"><div class="muted">Loading…</div></div>';
  ssLoadHistory();
}

function ssStartForm(){
  const box=_ss.wrap&&_ss.wrap.querySelector('#ss_startform'); if(!box)return;
  box.innerHTML='<div class="card">'+
    '<label class="fld"><span>Show name (optional)</span><input id="ssf_name" placeholder="e.g. Fort Walton — Aug show"/></label>'+
    '<label class="fld"><span>Cash drawer starting amount (USD)</span><input id="ssf_cash" type="text" inputmode="decimal" placeholder="e.g. 200.00"/></label>'+
    '<label class="fld"><span>Whose cash is the float? (it goes back to them at the end)</span><select id="ssf_owner">'+SS_PEOPLE.map(p=>'<option value="'+p[0]+'"'+(p[0]==='reggie'?' selected':'')+'>'+p[1]+'</option>').join('')+'</select></label>'+
    '<div class="row" style="margin-top:8px"><button class="gold" id="ssf_go" style="flex:1">Start the show</button></div></div>';
  box.querySelector('#ssf_go').onclick=async()=>{
    const amt=parseFloat((box.querySelector('#ssf_cash').value||'').replace(/[^0-9.]/g,''));
    if(isNaN(amt)||amt<0){ toast('Enter the starting cash amount (0 is fine).'); return; }
    const c=await ssCreds(); if(!c)return;
    const r=await sbRpc('show_start',Object.assign({p_name:(box.querySelector('#ssf_name').value||'').trim(),p_cash_start_cents:Math.round(amt*100),p_float_owner:box.querySelector('#ssf_owner').value},c));
    if(r&&r.ok){ toast(r.existing?'A show is already running — joining it.':'Show started! 🎪'); ssRefresh(); }
    else toast((r&&r.error)||'Could not start the show.');
  };
  setTimeout(()=>{ const n=box.querySelector('#ssf_name'); if(n)n.focus(); },60);
}

async function ssLoadHistory(){
  const c=await ssCreds(); if(!c)return;
  const r=await sbRpc('show_reports_list',c);
  const hist=_ss.wrap&&_ss.wrap.querySelector('#ss_hist'), chart=_ss.wrap&&_ss.wrap.querySelector('#ss_chart');
  if(!hist||!chart)return;
  if(!r||r.ok!==true){ hist.innerHTML='<div class="muted">Could not load history.</div>'; chart.innerHTML=''; return; }
  const shows=r.shows||[];
  if(!shows.length){ hist.innerHTML='<div class="muted">No finished shows yet.</div>'; chart.innerHTML='<div class="muted">The tracking graph appears after your first show.</div>'; return; }
  hist.innerHTML=shows.map(s=>{ const dt=s.ended_at?new Date(s.ended_at).toLocaleDateString():'';
    return '<div class="ordcard"><div class="ordhead"><b>'+esc(s.name||('Show #'+s.show_id))+'</b><span class="ordstatus s_complete">'+mUSD(s.profit_cents||0)+'</span></div>'+
      '<div class="muted">'+dt+'</div>'+
      '<div class="row" style="gap:6px;margin-top:8px"><button class="sm ghost" onclick="openShowReport('+s.show_id+')">View report</button>'+
      (s.pdf_url?('<button class="sm ghost" data-url="'+esc(s.pdf_url)+'" onclick="openUrl(this.dataset.url)">PDF</button>'):'')+'</div></div>'; }).join('');
  // profit chart — oldest → newest bars
  const seq=shows.slice().reverse();
  const w=Math.max(280, Math.min(520, seq.length*64)), h=170, pad=26;
  const max=Math.max(1, ...seq.map(s=>s.profit_cents||0)), min=Math.min(0, ...seq.map(s=>s.profit_cents||0));
  const span=max-min||1;
  const bw=Math.min(46,(w-pad*2)/seq.length*0.7);
  let bars='';
  seq.forEach((s,i)=>{ const x=pad+((w-pad*2)/seq.length)*(i+0.5)-bw/2;
    const v=s.profit_cents||0; const y0=pad+((h-pad*2)*(max-Math.max(0,v))/span); const y1=pad+((h-pad*2)*(max-Math.min(0,v))/span);
    bars+='<rect x="'+x.toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(2,(y1-y0)).toFixed(1)+'" rx="4" fill="'+(v>=0?'url(#ssg)':'#ef4a3d')+'"/>'+
      '<text x="'+(x+bw/2).toFixed(1)+'" y="'+(y0-5).toFixed(1)+'" text-anchor="middle" font-size="10" fill="#c7ccdf">'+('$'+Math.round(v/100))+'</text>'+
      '<text x="'+(x+bw/2).toFixed(1)+'" y="'+(h-6)+'" text-anchor="middle" font-size="9" fill="#8f96b0">'+(s.ended_at?new Date(s.ended_at).toLocaleDateString(undefined,{month:'numeric',day:'numeric'}):'')+'</text>'; });
  chart.innerHTML='<div class="card" style="overflow-x:auto"><svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" style="display:block;margin:0 auto">'+
    '<defs><linearGradient id="ssg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>'+bars+'</svg></div>';
}

/* ---------- live show ---------- */
function ssPaintLive(body, d){
  const s=d.show, entries=d.entries||[], tallies=d.tallies||{};
  const started=new Date(s.started_at);
  const net={}; SS_FORMS.forEach(f=>net[f[0]]=0);
  entries.forEach(e=>{ net[e.pay_form]+= (e.direction===-1?-1:1)*e.amount_cents; });
  const drawer=(s.cash_start_cents||0)+net.cash;
  const tallyTotal=SS_BOXES.reduce((a,b)=>a+(tallies[b[0]]||0),0)*1000;
  const salesTotal=entries.reduce((a,e)=>a+(e.direction===-1?-1:1)*e.amount_cents,0);

  body.innerHTML=
    '<div class="card"><div class="ordhead"><b>'+esc(s.name||'Live show')+'</b><span class="ordstatus s_paid">LIVE</span></div>'+
      '<div class="muted">Started '+started.toLocaleString()+' · float '+mUSD(s.cash_start_cents)+' ('+esc(SS_PERSON_NAME[s.float_owner]||s.float_owner)+')</div>'+
      '<div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap">'+
        '<div class="ss-kpi"><span>Sales</span><b>'+mUSD(salesTotal)+'</b></div>'+
        '<div class="ss-kpi"><span>Machine</span><b>'+mUSD(tallyTotal)+'</b></div>'+
        '<div class="ss-kpi"><span>Drawer</span><b>'+mUSD(drawer)+'</b></div>'+
      '</div></div>'+
    '<div class="subtabs" style="justify-content:center">'+
      '<button id="ss_tab_sales" class="'+(_ss.tab==='sales'?'on':'')+'">Sales</button>'+
      '<button id="ss_tab_game" class="'+(_ss.tab==='game'?'on':'')+'">Game</button>'+
    '</div>'+
    '<div id="ss_tabbody"></div>'+
    '<hr class="sep"><div class="row"><button class="red" id="ss_end" style="flex:1">'+svgIcon('lock')+' End show now</button></div>';
  body.querySelector('#ss_tab_sales').onclick=()=>{ _ss.tab='sales'; ssPaint(); };
  body.querySelector('#ss_tab_game').onclick=()=>{ _ss.tab='game'; ssPaint(); };
  body.querySelector('#ss_end').onclick=ssEndShow;
  if(_ss.tab==='game') ssPaintGame(body.querySelector('#ss_tabbody'), d);
  else ssPaintSales(body.querySelector('#ss_tabbody'), d);
}

function ssPaintSales(box, d){
  const entries=d.entries||[];
  const chip=(cls,key,label,sel)=>'<button class="ss-chip'+(sel?' on':'')+'" data-'+cls+'="'+key+'">'+label+'</button>';
  box.innerHTML=
    '<div class="card">'+
      '<div class="ss-lbl">Payment</div><div class="ss-chips">'+SS_FORMS.map(f=>chip('form',f[0],f[1],_ss.sel.form===f[0])).join('')+'</div>'+
      '<div class="ss-lbl">Who gets it / spent it</div><div class="ss-chips">'+SS_PEOPLE.map(p=>chip('person',p[0],p[1],_ss.sel.person===p[0])).join('')+'</div>'+
      (_ss.sel.form==='zelle'?'<div class="muted" style="font-size:12px;margin:-4px 0 8px">Zelle goes to that person\'s own Zelle account.</div>':'')+
      '<div class="ss-lbl">Direction</div><div class="ss-chips">'+
        '<button class="ss-chip ss-add'+(_ss.sel.dir===1?' on':'')+'" data-dir="1">+ Add (money in)</button>'+
        '<button class="ss-chip ss-sub'+(_ss.sel.dir===-1?' on':'')+'" data-dir="-1">− Subtract (money out)</button></div>'+
      '<label class="fld"><span>Amount (USD)</span><input id="ssc_amt" type="text" inputmode="decimal" placeholder="0.00"/></label>'+
      '<div class="row" style="gap:8px"><button class="ghost" id="ssc_photo" style="flex:1">'+svgIcon('camera')+(_ss.photo?' ✓ Photo ready — tap to retake':' Take photo (required)')+'</button></div>'+
      '<div id="ssc_prev">'+(_ss.photo?('<img class="showflyer" style="max-height:160px" src="'+esc(_ss.photo.url)+'"/><div class="row" style="margin-top:6px"><button class="sm ghost" id="ssc_pclear" style="color:#ff6a5c">✕ Remove photo</button></div>'):'')+'</div>'+
      '<div class="row" style="margin-top:10px"><button class="gold" id="ssc_save" style="flex:1">Save sale</button></div>'+
    '</div>'+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('tag')+' This show\'s ledger ('+entries.length+')</div>'+
    '<div id="ssc_ledger">'+(entries.length?entries.map(ssEntryRow).join(''):'<div class="muted">Nothing logged yet.</div>')+'</div>';
  box.querySelectorAll('[data-form]').forEach(b=>b.onclick=()=>{ _ss.sel.form=b.dataset.form; ssPaint(); });
  box.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>{ _ss.sel.person=b.dataset.person; ssPaint(); });
  box.querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>{ _ss.sel.dir=+b.dataset.dir; ssPaint(); });
  box.querySelector('#ssc_photo').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.capture='environment';
    inp.onchange=async()=>{ const f=inp.files[0]; if(!f)return; toast('Uploading photo…'); const up=await uploadMedia(f); if(!up)return; _ss.photo=up; ssPaint(); };
    inp.click(); };
  { const pc=box.querySelector('#ssc_pclear'); if(pc)pc.onclick=()=>{ _ss.photo=null; ssPaint(); }; }
  box.querySelector('#ssc_save').onclick=async()=>{
    if(_ss.busy)return;
    const amt=parseFloat((box.querySelector('#ssc_amt').value||'').replace(/[^0-9.]/g,''));
    if(!_ss.sel.form){ toast('Pick the payment type.'); return; }
    if(!_ss.sel.person){ toast('Pick the person.'); return; }
    if(!(amt>0)){ toast('Enter the amount.'); return; }
    if(!_ss.photo){ toast('Take a photo of what was sold or bought.'); return; }
    _ss.busy=true; const btn=box.querySelector('#ssc_save'); btn.disabled=true; btn.textContent='Saving…';
    const c=await ssCreds(); if(!c){ _ss.busy=false; btn.disabled=false; btn.textContent='Save sale'; return; }
    const r=await sbRpc('show_entry_add',Object.assign({p_show:d.show.id,p_form:_ss.sel.form,p_person:_ss.sel.person,p_dir:_ss.sel.dir,p_amount_cents:Math.round(amt*100),p_photo:_ss.photo.url},c));
    _ss.busy=false;
    if(r&&r.ok){ toast('Logged '+(_ss.sel.dir===-1?'−':'+')+mUSD(Math.round(amt*100))+' ✓'); _ss.photo=null; _ss.sel={form:null,person:null,dir:1}; ssRefresh(); }
    else { btn.disabled=false; btn.textContent='Save sale'; toast((r&&r.error)||'Could not save.'); }
  };
}

function ssEntryRow(e){
  const neg=e.direction===-1;
  return '<div class="ordcard"><div class="ordhead">'+
      '<b style="color:'+(neg?'#ff6a5c':'#34c759')+'">'+(neg?'−':'+')+mUSD(e.amount_cents)+'</b>'+
      '<span class="ordstatus '+(neg?'s_canceled':'s_complete')+'">'+esc(SS_FORM_NAME[e.pay_form]||e.pay_form)+'</span></div>'+
    '<div class="muted">'+esc(SS_PERSON_NAME[e.person]||e.person)+' · '+new Date(e.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+(e.created_by?(' · by '+esc(e.created_by)):'')+'</div>'+
    '<div class="row" style="gap:6px;margin-top:8px">'+
      (e.photo_url?('<button class="sm ghost" data-url="'+esc(e.photo_url)+'" onclick="openPhotoViewer([this.dataset.url],0)">View photo</button>'):'')+
      '<button class="sm ghost" style="color:#ff6a5c" onclick="ssVoid('+(+e.id)+')">Void</button></div></div>';
}

async function ssVoid(id){
  if(!confirm('Void this entry? It will be removed from the show math.'))return;
  const c=await ssCreds(); if(!c)return;
  const r=await sbRpc('show_entry_void',Object.assign({p_id:id},c));
  if(r&&r.ok){ toast('Entry voided.'); ssRefresh(); } else toast((r&&r.error)||'Could not void.');
}

/* ---------- game (vending machine tallies) ---------- */
function ssTallySvg(n){
  n=Math.max(0,n|0); let out=''; const groups=Math.floor(n/5), rem=n%5;
  const mark=(x,cross)=>{ let g=''; for(let i=0;i<(cross?4:x);i++) g+='<line x1="'+(6+i*8)+'" y1="4" x2="'+(6+i*8)+'" y2="26" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>';
    if(cross) g+='<line x1="1" y1="24" x2="35" y2="6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>';
    return '<svg class="ss-tgrp" viewBox="0 0 38 30" width="34" height="27">'+g+'</svg>'; };
  for(let i=0;i<groups;i++) out+=mark(4,true);
  if(rem) out+=mark(rem,false);
  return out||'<span class="muted" style="font-size:12px">tap to add</span>';
}

function ssPaintGame(box, d){
  const t=d.tallies||{};
  box.innerHTML='<div class="muted" style="text-align:center;margin-bottom:10px">Tap a box each time a token is bought with that payment. Each mark = <b style="color:#F4B400">$10</b>. Press &amp; hold to erase.</div>'+
    '<div class="ss-tallygrid">'+SS_BOXES.map(b=>{ const n=t[b[0]]||0;
      return '<div class="ss-tallybox" data-box="'+b[0]+'"><div class="ss-tname">'+b[1]+'</div><div class="ss-tmarks" id="ssm_'+b[0]+'">'+ssTallySvg(n)+'</div><div class="ss-tval" id="ssv_'+b[0]+'">'+n+' · '+mUSD(n*1000)+'</div></div>'; }).join('')+'</div>'+
    '<div class="card" style="margin-top:12px;text-align:center"><div class="muted">Machine total (splits 50/50 Reggie &amp; Manny)</div>'+
    '<div class="big" id="ss_machtotal">'+mUSD(SS_BOXES.reduce((a,b)=>a+(t[b[0]]||0),0)*1000)+'</div></div>';
}

/* Tally taps and press-and-hold use ONE delegated listener on the modal wrap plus a single
   global hold state (_ss.hold). The tally boxes get rebuilt by repaints; per-element
   listeners could leak a running erase interval when their element was detached mid-hold.
   With delegation + global state, a repaint can never orphan a hold. */
function ssWireTallies(w){
  const findBox=e=>{ const el=e.target&&e.target.closest&&e.target.closest('.ss-tallybox'); return el?el.dataset.box:null; };
  w.addEventListener('pointerdown', e=>{
    const box=findBox(e); if(!box)return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    e.preventDefault();
    ssHoldStop();
    const showId=_ss.data&&_ss.data.show&&_ss.data.show.id; if(!showId)return;
    const h={ box:box, showId:showId, downAt:Date.now(), erased:false, timer:null, rep:null };
    _ss.hold=h;
    h.timer=setTimeout(()=>{ if(_ss.hold!==h)return; ssHoldErase(h); h.rep=setInterval(()=>{ if(_ss.hold!==h){ clearInterval(h.rep); return; } ssHoldErase(h); }, 650); }, 600);
  });
  // pointerup/cancel live on window so the hold ALWAYS ends, even if the finger drifts
  // off the box or the element under it was swapped out
  const up=e=>{ const h=_ss.hold; if(!h)return;
    const at=e.target&&e.target.closest&&e.target.closest('.ss-tallybox');
    const tap = e.type==='pointerup' && !h.erased && (Date.now()-h.downAt)<600 && at && at.dataset.box===h.box;
    ssHoldStop();
    if(tap) ssBump(h.showId, h.box, 1); };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  _ss.winUp=up;
  w.addEventListener('contextmenu', e=>{ if(findBox(e))e.preventDefault(); });
}
function ssHoldStop(){ const h=_ss.hold; if(!h)return; clearTimeout(h.timer); clearInterval(h.rep); h.timer=h.rep=null; _ss.hold=null; }
function ssHoldErase(h){ h.erased=true;
  const t=_ss.data&&_ss.data.tallies;
  if(t&&(t[h.box]||0)>0) ssBump(h.showId, h.box, -1);
  else ssHoldStop(); }

function ssTallyPaintBox(box){
  const t=(_ss.data&&_ss.data.tallies)||{};
  const m=document.getElementById('ssm_'+box), v=document.getElementById('ssv_'+box), tot=document.getElementById('ss_machtotal');
  const machTotal=SS_BOXES.reduce((a,b)=>a+(t[b[0]]||0),0)*1000;
  if(m)m.innerHTML=ssTallySvg(t[box]||0); if(v)v.textContent=(t[box]||0)+' · '+mUSD((t[box]||0)*1000);
  if(tot)tot.textContent=mUSD(machTotal);
  const kpis=_ss.wrap&&_ss.wrap.querySelectorAll('.ss-kpi b'); if(kpis&&kpis[1])kpis[1].textContent=mUSD(machTotal);
}

let _ssBumpChain=Promise.resolve();
function ssBump(showId, box, delta){
  const t=_ss.data.tallies; t[box]=Math.max(0,(t[box]||0)+delta);
  _ss.pending[box]=(_ss.pending[box]||0)+delta;   // in flight until the server confirms
  ssTallyPaintBox(box);
  // serialize server bumps so rapid taps all land, in order; a failed bump is rolled
  // back on screen and announced — a tally mark must never silently differ from the server
  _ssBumpChain=_ssBumpChain.then(async()=>{
    const settle=()=>{ _ss.pending[box]=(_ss.pending[box]||0)-delta; };
    const c=ssCredsCached();
    if(!c){ settle(); ssBumpRevert(box, delta); toast('Sign in again — that tally didn\'t save.'); return; }
    const args=Object.assign({p_show:showId,p_box:box,p_delta:delta},c);
    let r=await sbRpc('show_tally_bump',args);
    if(!r){ await new Promise(res=>setTimeout(res,1200)); r=await sbRpc('show_tally_bump',args); }
    settle();
    if(r&&r.ok&&typeof r.count==='number'){ /* server is source of truth on next poll */ }
    else { ssBumpRevert(box, delta); toast((r&&r.error)||'No connection — that tally didn\'t save. Tap it again.'); }
  }).catch(()=>{});
}
function ssBumpRevert(box, delta){
  const t=_ss.data&&_ss.data.tallies; if(!t)return;
  t[box]=Math.max(0,(t[box]||0)-delta);
  ssTallyPaintBox(box);
}

/* ---------- end show + report ---------- */
function ssEndShow(){
  if(document.querySelector('.sse-sheet'))return;   // one confirmation sheet at a time
  const w=document.createElement('div'); w.className='wsheet-wrap show sse-sheet'; document.body.appendChild(w);
  const close=()=>w.remove();
  w.innerHTML='<div class="wsheet-back"></div><div class="wsheet"><div class="wsheet-grip"></div>'+
    '<div class="wsheet-h">End show</div>'+
    '<div style="text-align:center;margin-bottom:14px;line-height:1.5">Are you sure you want to <b>finalize the show</b>, log the results, add it to the profit tracking graph, generate the PDF breakdown of what each person made, and save the PDF to the log?</div>'+
    '<div class="row" style="gap:10px"><button class="ghost" id="sse_no" style="flex:1">No — keep going</button><button class="red" id="sse_yes" style="flex:1">Yes — finalize</button></div></div>';
  w.querySelector('.wsheet-back').onclick=close;
  w.querySelector('#sse_no').onclick=close;
  w.querySelector('#sse_yes').onclick=async()=>{
    const btn=w.querySelector('#sse_yes'); if(btn.disabled)return;
    btn.disabled=true; btn.textContent='Finalizing…';
    const c=await ssCreds(); if(!c){ close(); return; }
    try{ await _ssBumpChain; }catch(e){}   // let any in-flight tally bumps land before snapshotting
    const unlock=()=>{ btn.disabled=false; btn.textContent='Yes — finalize'; };
    // Snapshot → compute → finalize. The server compares our snapshot's fingerprint
    // (entry count, amount sum, newest entry id, exact tallies) against live data under a
    // row lock, and refuses with 'changed' if any device logged anything in between —
    // then we just re-snapshot and recompute, so the saved split always matches reality.
    for(let attempt=0; attempt<4; attempt++){
      const fresh=await sbRpc('show_live_get',c);
      if(!fresh||fresh.ok!==true){ toast('Could not reach the server — nothing was finalized. Try again.'); unlock(); return; }
      if(!fresh.show){ toast('Show was already ended.'); close(); ssRefresh(); return; }
      const s=fresh.show, entries=fresh.entries||[], tallies=fresh.tallies||{};
      const rep=HOC_SHOW_MATH.computeShowReport({cash_start_cents:s.cash_start_cents,float_owner:s.float_owner,entries:entries,tallies:tallies});
      rep.name=s.name||null; rep.started_at=s.started_at; rep.ended_at=new Date().toISOString();
      const fp={ p_entry_count:entries.length,
                 p_amount_sum:entries.reduce((a,e)=>a+(e.amount_cents||0),0),
                 p_max_id:entries.reduce((a,e)=>Math.max(a,e.id||0),0),
                 p_tallies:tallies };
      const er=await sbRpc('show_end',Object.assign({p_show:s.id,p_report:rep,p_pdf:null},fp,c));
      if(er&&er.ok===true){
        close(); toast(rep.verified?'Show finalized — math verified ✓':'Show finalized — ⚠ check the report math');
        try{
          const blob=await ssMakePdf(s, entries, rep);
          const up=await uploadMedia(new File([blob],'show-'+s.id+'-report.pdf',{type:'application/pdf'}));
          if(up&&up.url) await sbRpc('show_report_set_pdf',Object.assign({p_show:s.id,p_pdf:up.url},c));
        }catch(e){ toast('PDF will be available from the report page.'); }
        ssRefresh();
        openShowReport(s.id);
        return;
      }
      if(er&&er.error==='changed'){ continue; }   // a sale/tally landed mid-finalize — recompute with fresh numbers
      if(er&&er.error==='ended'){ toast('Another device already finalized this show.'); close(); ssRefresh(); openShowReport(s.id); return; }
      toast((er&&er.error)||'Could not finalize.'); unlock(); return;
    }
    toast('Sales kept coming in while finalizing — wait for everyone to stop, then tap End show again.');
    unlock();
  };
}

async function openShowReport(showId){
  const c=await ssCreds(); if(!c)return;
  const r=await sbRpc('show_report_get',Object.assign({p_show:showId},c));
  if(!r||r.ok!==true){ toast((r&&r.error)||'Could not load the report.'); return; }
  const s=r.show, rep=r.report||{}, entries=r.entries||[];
  const w=document.createElement('div'); w.className='scanmodal pagewrap'; document.body.appendChild(w);
  const close=()=>w.remove();
  const P=SS_PERSON_NAME, F=SS_FORM_NAME;
  const photos=entries.filter(e=>e.photo_url).map(e=>e.photo_url);
  const cashLine=p=>{ const c2=(rep.cash_out||{})[p]||0; const fl=(p===rep.float_owner&&rep.cash_start_cents)?(' <span class="muted">(includes '+mUSD(rep.cash_start_cents)+' float back)</span>'):'';
    return '<div class="ss-payline">'+svgIcon('wallet')+' <b>'+P[p]+'</b> takes <b>'+mUSD(c2)+'</b> cash'+fl+'</div>'; };
  const formRow=f=>{ const d2=(rep.forms||{})[f]||{}; return '<tr><td>'+F[f]+'</td><td class="money">'+mUSD(d2.in_cents||0)+'</td><td class="money">'+mUSD(d2.out_cents||0)+'</td><td class="money">'+mUSD(d2.machine_cents||0)+'</td><td class="money"><b>'+mUSD((d2.net_cents||0)+(d2.machine_cents||0))+'</b></td></tr>'; };
  const personRow=p=>'<tr><td>'+P[p]+'</td><td class="money">'+mUSD((rep.sales_net||{})[p]||0)+'</td><td class="money">'+mUSD((rep.machine_split||{})[p]||0)+'</td><td class="money">'+(p===rep.float_owner?mUSD(rep.cash_start_cents||0):'—')+'</td><td class="money"><b>'+mUSD((rep.entitlement||{})[p]||0)+'</b></td></tr>';
  w.innerHTML='<div class="card pagecard">'+pageHead((s.name||('Show #'+s.id))+' — report','sr_x')+
    '<div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:6px">'+
      '<div class="ss-kpi"><span>Profit</span><b>'+mUSD(rep.profit_cents||0)+'</b></div>'+
      '<div class="ss-kpi"><span>Machine</span><b>'+mUSD(rep.machine_total_cents||0)+'</b></div>'+
      '<div class="ss-kpi"><span>Entries</span><b>'+(rep.entry_count||entries.length)+'</b></div>'+
    '</div>'+
    (rep.verified
      ?'<div class="banner" style="background:rgba(52,199,89,.15);border:1px solid rgba(52,199,89,.4);color:#7ae0a0">✓ Every dollar is accounted for — totals verified to the cent.</div>'
      :'<div class="banner" style="background:rgba(226,59,46,.14);border:1px solid rgba(226,59,46,.4);color:#ff8a80">⚠ Math check failed — review this report manually before splitting money.</div>')+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('wallet')+' How to split the money</div>'+
    '<div class="card">'+SS_PEOPLE.map(p=>cashLine(p[0])).join('')+
      ((rep.transfers||[]).length?('<hr class="sep">'+rep.transfers.map(t=>'<div class="ss-payline">'+svgIcon('share')+' <b>'+P[t.from]+'</b> sends <b>'+mUSD(t.amount_cents)+'</b> to <b>'+P[t.to]+'</b> <span class="muted">(via '+esc(t.via)+')</span></div>').join('')):'<hr class="sep"><div class="muted" style="text-align:center">No transfers needed — the cash box covers the whole split. 🎉</div>')+
      '<div class="muted" style="margin-top:8px;font-size:12px">Cash on hand: drawer '+mUSD(rep.drawer_end_cents||0)+' + machine '+mUSD(rep.machine_cash_cents||0)+' = '+mUSD(rep.pot_cents||0)+'</div></div>'+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('grid')+' Payment forms</div>'+
    '<div class="card" style="overflow-x:auto"><table><tr><th>Form</th><th>In</th><th>Out</th><th>Machine</th><th>Ends with</th></tr>'+SS_FORMS.map(f=>formRow(f[0])).join('')+'</table></div>'+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('users')+' Per person</div>'+
    '<div class="card" style="overflow-x:auto"><table><tr><th>Person</th><th>Sales</th><th>Machine</th><th>Float</th><th>Walks with</th></tr>'+SS_PEOPLE.map(p=>personRow(p[0])).join('')+'</table></div>'+
    '<div class="row" style="gap:8px;margin-top:12px">'+
      '<button class="gold" id="sr_pdf" style="flex:1">'+svgIcon('download')+' '+(r.pdf_url?'Open PDF':'Make PDF')+'</button>'+
      (photos.length?('<button class="ghost" id="sr_gal" style="flex:1">'+svgIcon('image')+' Photos ('+photos.length+')</button>'):'')+'</div>'+
    '<div class="acct-sec" style="margin-top:14px">'+svgIcon('tag')+' Ledger</div>'+
    (entries.length?entries.map(e=>{ const neg=e.direction===-1;
      return '<div class="ordcard"><div class="ordhead"><b style="color:'+(neg?'#ff6a5c':'#34c759')+'">'+(neg?'−':'+')+mUSD(e.amount_cents)+'</b><span class="ordstatus '+(neg?'s_canceled':'s_complete')+'">'+esc(F[e.pay_form]||e.pay_form)+'</span></div>'+
      '<div class="muted">'+esc(P[e.person]||e.person)+' · '+new Date(e.created_at).toLocaleString()+'</div>'+
      (e.photo_url?('<div class="row" style="margin-top:8px"><button class="sm ghost sr-view" data-pv="'+photos.indexOf(e.photo_url)+'">View photo</button></div>'):'')+'</div>'; }).join(''):'<div class="muted">No entries.</div>')+
    (photos.length?('<div class="acct-sec" style="margin-top:14px">'+svgIcon('image')+' All item photos</div><div class="ss-gal">'+photos.map((u,i)=>'<img loading="lazy" src="'+esc(u)+'" data-pv="'+i+'"/>').join('')+'</div>'):'')+
    '</div>';
  w.querySelector('#sr_x').onclick=close;
  const gal=w.querySelector('#sr_gal'); if(gal)gal.onclick=()=>openPhotoViewer(photos,0);
  w.querySelectorAll('.sr-view').forEach(b=>b.onclick=()=>openPhotoViewer(photos,+b.dataset.pv));
  w.querySelectorAll('.ss-gal img').forEach(img=>img.onclick=()=>openPhotoViewer(photos,+img.dataset.pv));
  // "Open PDF" fires straight from the tap (popup blockers allow it). Building happens on a
  // first tap, saves the link in place, then asks for one more tap to open — never a
  // window.open after long awaits, never a duplicate upload on a double-tap.
  const pb=w.querySelector('#sr_pdf');
  let pdfBusy=false;
  pb.onclick=async()=>{
    if(r.pdf_url){ openUrl(r.pdf_url); return; }
    if(pdfBusy)return; pdfBusy=true; pb.disabled=true; pb.textContent='Building PDF…';
    try{
      const blob=await ssMakePdf(s, entries, rep);
      const up=await uploadMedia(new File([blob],'show-'+s.id+'-report.pdf',{type:'application/pdf'}));
      if(up&&up.url){
        const c2=await ssCreds(); if(c2)await sbRpc('show_report_set_pdf',Object.assign({p_show:s.id,p_pdf:up.url},c2));
        r.pdf_url=up.url;
        pb.disabled=false; pb.innerHTML=svgIcon('download')+' Open PDF';
        toast('PDF is ready — tap Open PDF.');
      } else { pb.disabled=false; pb.innerHTML=svgIcon('download')+' Make PDF'; toast('Could not upload the PDF — try again.'); }
    }catch(e){ pb.disabled=false; pb.innerHTML=svgIcon('download')+' Make PDF'; toast('Could not build the PDF on this device.'); }
    pdfBusy=false;
  };
}

/* ---------- fullscreen photo viewer ---------- */
function openPhotoViewer(urls, idx){
  if(!urls||!urls.length)return; let i=Math.max(0,Math.min(urls.length-1, idx|0));
  const w=document.createElement('div'); w.className='pv-wrap'; document.body.appendChild(w);
  w.innerHTML='<button class="pv-x">✕</button>'+
    (urls.length>1?'<button class="pv-arrow pv-prev">‹</button><button class="pv-arrow pv-next">›</button>':'')+
    '<img class="pv-img" src="'+esc(urls[i])+'"/><div class="pv-count"></div>';
  const img=w.querySelector('.pv-img'), count=w.querySelector('.pv-count');
  const paint=()=>{ img.src=urls[i]; count.textContent=(i+1)+' / '+urls.length; };
  const close=()=>{ document.removeEventListener('keydown',onkey); w.remove(); };
  const prev=()=>{ i=(i-1+urls.length)%urls.length; paint(); };
  const next=()=>{ i=(i+1)%urls.length; paint(); };
  const onkey=e=>{ if(e.key==='Escape')close(); if(e.key==='ArrowLeft')prev(); if(e.key==='ArrowRight')next(); };
  w.querySelector('.pv-x').onclick=close;
  const pb=w.querySelector('.pv-prev'), nb=w.querySelector('.pv-next');
  if(pb)pb.onclick=prev; if(nb)nb.onclick=next;
  w.onclick=e=>{ if(e.target===w)close(); };
  document.addEventListener('keydown',onkey);
  paint();
}

/* ---------- PDF ---------- */
function ssLoadJsPdf(){ return new Promise((res,rej)=>{ if(window.jspdf&&window.jspdf.jsPDF)return res();
  const s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
  s.onload=()=>res(); s.onerror=()=>rej(new Error('Could not load the PDF library.')); document.head.appendChild(s); }); }

async function ssMakePdf(show, entries, rep){
  await ssLoadJsPdf();
  const doc=new window.jspdf.jsPDF({unit:'mm',format:'a4'});
  const P=SS_PERSON_NAME, F=SS_FORM_NAME;
  const $=c=>'$'+((c||0)/100).toFixed(2);
  let y=16;
  const room=n=>{ if(y+n>282){ doc.addPage(); y=16; } };
  const H=(t)=>{ room(12); doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(20,20,20); doc.text(t,14,y); y+=2.5; doc.setDrawColor(200); doc.line(14,y,196,y); y+=6; };
  const L=(t,opts)=>{ room(6); doc.setFont('helvetica',(opts&&opts.bold)?'bold':'normal'); doc.setFontSize((opts&&opts.size)||10); doc.setTextColor.apply(doc,(opts&&opts.color)||[40,40,40]); doc.text(String(t),(opts&&opts.x)||14,y); y+=(opts&&opts.h)||5.5; };
  doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text('House of Cards — Show report',14,y); y+=7;
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(90,90,90);
  doc.text((show.name?show.name+' · ':'')+new Date(rep.started_at||show.started_at).toLocaleString()+'  →  '+new Date(rep.ended_at||show.ended_at||Date.now()).toLocaleString(),14,y); y+=8;
  L('Profit this show: '+$(rep.profit_cents)+'   ·   Machine: '+$(rep.machine_total_cents)+'   ·   Entries: '+(rep.entry_count||entries.length),{bold:true,size:11}); y+=2;
  L(rep.verified?'MATH VERIFIED — every dollar accounted for, to the cent.':'WARNING: math check FAILED — review manually before splitting money.',{bold:true,color:rep.verified?[20,130,60]:[190,30,30]}); y+=3;

  H('How to split the money');
  SS_PEOPLE.forEach(p=>{ const k=p[0]; const c2=(rep.cash_out||{})[k]||0;
    L(P[k]+' takes '+$(c2)+' cash'+((k===rep.float_owner&&rep.cash_start_cents)?('  (includes '+$(rep.cash_start_cents)+' float returned)'):''),{bold:true}); });
  (rep.transfers||[]).forEach(t=>L(P[t.from]+' sends '+$(t.amount_cents)+' to '+P[t.to]+'  (via '+t.via+')',{bold:true,color:[120,60,180]}));
  if(!(rep.transfers||[]).length) L('No transfers needed — the cash box covers the split.',{color:[20,130,60]});
  L('Cash on hand: drawer '+$(rep.drawer_end_cents)+' + machine '+$(rep.machine_cash_cents)+' = '+$(rep.pot_cents)); y+=3;

  H('Payment forms');
  L('Form           In           Out          Machine      Ends with',{bold:true});
  SS_FORMS.forEach(f=>{ const d2=(rep.forms||{})[f[0]]||{};
    L((F[f[0]]+'              ').slice(0,13)+'  '+($(d2.in_cents)+'          ').slice(0,11)+'  '+($(d2.out_cents)+'          ').slice(0,11)+'  '+($(d2.machine_cents)+'          ').slice(0,11)+'  '+$( (d2.net_cents||0)+(d2.machine_cents||0) )); }); y+=3;

  H('Vending machine');
  SS_BOXES.forEach(b=>{ const n=Math.round((rep.box_cents&&rep.box_cents[b[0]]||0)/1000); if(n)L(b[1]+': '+n+' plays = '+$( (rep.box_cents||{})[b[0]] )); });
  L('Machine total '+$(rep.machine_total_cents)+' — split 50/50: Reggie '+$((rep.machine_split||{}).reggie)+' / Manny '+$((rep.machine_split||{}).manny),{bold:true}); y+=3;

  H('Per person');
  L('Person      Sales         Machine      Float        Walks with',{bold:true});
  SS_PEOPLE.forEach(p=>{ const k=p[0];
    L((P[k]+'          ').slice(0,10)+'  '+($((rep.sales_net||{})[k])+'          ').slice(0,12)+'  '+($((rep.machine_split||{})[k])+'          ').slice(0,11)+'  '+((k===rep.float_owner?$(rep.cash_start_cents):'—')+'          ').slice(0,11)+'  '+$((rep.entitlement||{})[k])); }); y+=3;

  H('Sales ledger');
  entries.forEach((e,ix)=>{ room(6);
    const t=(e.direction===-1?'-':'+')+$(e.amount_cents)+'  '+(F[e.pay_form]||e.pay_form)+'  ·  '+(P[e.person]||e.person)+'  ·  '+new Date(e.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+(e.created_by?('  ·  by '+e.created_by):'');
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(e.direction===-1?190:20, e.direction===-1?30:120, e.direction===-1?30:60);
    doc.text((ix+1)+'. '+t,14,y);
    if(e.photo_url){ doc.setTextColor(30,80,200); doc.textWithLink('[View photo]',168,y,{url:e.photo_url}); }
    y+=5.2; });
  y+=3; L('Generated '+new Date().toLocaleString()+' · houseofcardsftwalton.com',{size:8,color:[130,130,130]});
  return doc.output('blob');
}
