/* House of Cards — cloud social layer (profiles + friends).
   Additive & optional: it sits on top of the local app and uses the same
   Supabase client as the shared logo. If the cloud isn't configured or the
   user hasn't connected, the Friends screen explains how — and the rest of
   the app keeps working fully offline. Requires the one-time Supabase setup
   in SUPABASE_SETUP.md (profiles + friendships tables, an 'avatars' bucket). */

let cloudUser=null;   // Supabase auth user once connected to the cloud
let myProfile=null;   // this user's row in public.profiles
let myCompany=null;   // the company page this user owns (if any)
let fui={ q:'', radius:0, results:null, friends:[], incoming:[], outgoing:[], following:[], followingIds:new Set(),
          blocked:[], blockedIds:new Set(), loaded:false, loc:null, cloc:null, busy:false, mode:'signin' };

function socialReady(){ return cloudOn() && !!cloudUser; }
function KM_PER_MI(){ return 1.609344; }

/* -------- session / auth -------- */
async function cloudInitSession(){
  if(!cloudOn()) return;
  try{
    sb.auth.onAuthStateChange((ev,session)=>{ cloudUser=session?session.user:null; if(!cloudUser){myProfile=null;fui.loaded=false;}
      // arriving via a password-reset email link: let them set the new password right here
      if(ev==='PASSWORD_RECOVERY'){ const np=prompt('Choose a new password (6+ characters):');
        if(np&&np.length>=6){ sb.auth.updateUser({ password:np }).then(({error})=>{
          toast(error?error.message:'Password updated — welcome back.');
          if(!error&&typeof enterCloudUser==='function')enterCloudUser(); }); } } });
    const { data } = await sb.auth.getSession();
    if(data && data.session){ cloudUser=data.session.user;
      if(typeof enterCloudUser==='function'){ await enterCloudUser(); }   // stay signed in across refreshes
      else { await loadMyProfile(); render(); } }
  }catch(e){ console.warn('[HoC] cloud session', e); }
}
async function cloudSignUp(email,pass,name,handle){
  const { data, error } = await sb.auth.signUp({ email, password:pass });
  if(error) return { error:error.message };
  cloudUser=data.user;
  if(data.session){ await upsertProfile({ name, handle:(handle||'').toLowerCase() }); }
  return { ok:true, needsConfirm:!data.session, name, handle };
}
async function cloudSignIn(email,pass){
  const { data, error } = await sb.auth.signInWithPassword({ email, password:pass });
  if(error) return { error:error.message };
  cloudUser=data.user; await loadMyProfile(); return { ok:true };
}
async function cloudSignOut(){ try{ await sb.auth.signOut(); }catch(e){} cloudUser=null; myProfile=null; fui.loaded=false; }
/* Log in to the cloud by either email OR username (handle). Lets the main app
   login screen recognize cloud accounts created on any device. */
async function cloudLoginByKey(key,pass){
  if(!cloudOn()) return { error:'Cloud is off.' };
  key=String(key||'').trim(); if(!key||!pass) return { error:'Enter your login and password.' };
  let email=key;
  if(!key.includes('@')){
    const { data } = await sb.from('profiles').select('email').ilike('handle',key).maybeSingle();
    if(data && data.email) email=data.email; else return { error:'No cloud account for “'+key+'”. Try your email instead, or create the account.' };
  }
  const r=await cloudSignIn(email,pass);
  if(r.error) return { error: /confirm/i.test(r.error) ? 'That account’s email isn’t confirmed. In Supabase: Authentication → turn OFF “Confirm email”, save, then create the account again with a fresh email.' : r.error };
  try{ await loadSocial(); fui.loaded=true; }catch(e){}
  return { ok:true, profile: myProfile || { email, handle:key, name:key } };
}
/* Keep the cloud session in lock-step with whoever is logged into the app.
   Called at login / signup / user-switch with the password the user just typed,
   so the Friends side connects automatically (and Supabase persists it across reloads). */
async function syncCloudToAppUser(u, pass){
  if(!cloudOn()||!u) return;
  try{
    const key=u.email||u.username||'';
    let r = key ? await cloudLoginByKey(key, pass) : { error:'no key' };
    if(!r.ok && u.email){                                   // no cloud account yet → create one on the fly
      const su = await cloudSignUp(u.email, pass, u.name||u.username, u.username||'');
      if(!su.error && !su.needsConfirm){ try{ await loadSocial(); fui.loaded=true; }catch(e){} r={ok:true}; }
    }
    if(!r.ok && cloudUser){ await cloudSignOut(); }         // avoid showing a stale/wrong cloud identity
  }catch(e){ console.warn('[HoC] cloud auto-connect', e); }
  render();
}

/* -------- profile -------- */
async function loadMyProfile(){
  if(!cloudUser) return null;
  const { data } = await sb.from('profiles').select('*').eq('id',cloudUser.id).maybeSingle();
  myProfile=data||null; return myProfile;
}
async function upsertProfile(fields){
  if(!cloudUser) return { error:'not connected' };
  const row=Object.assign({ id:cloudUser.id, email:cloudUser.email }, fields);
  const { data, error } = await sb.from('profiles').upsert(row).select().maybeSingle();
  if(error) return { error:error.message };
  myProfile=data; return { ok:true };
}
async function uploadAvatar(file){
  if(!socialReady()) return { error:'connect to the cloud first (Friends tab)' };
  const ext=((file.name||'').split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'')||'png';
  const path=cloudUser.id+'/avatar.'+ext;
  const { error } = await sb.storage.from('avatars').upload(path,file,{ upsert:true, contentType:file.type||'image/png' });
  if(error) return { error:error.message };
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  const url=data.publicUrl+'?v='+Date.now();
  const r=await upsertProfile({ avatar_url:url });
  return r.error ? r : { ok:true, url };
}

/* -------- location -------- */
function getGPS(){ return new Promise(res=>{ if(!navigator.geolocation){res(null);return;}
  navigator.geolocation.getCurrentPosition(p=>res({lat:p.coords.latitude,lng:p.coords.longitude}),()=>res(null),{timeout:9000,maximumAge:60000}); }); }
async function geocode(q){ if(!q)return null;
  try{ const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q),{headers:{'Accept':'application/json'}});
    const j=await r.json(); if(j&&j[0])return {lat:parseFloat(j[0].lat),lng:parseFloat(j[0].lon)}; }catch(e){} return null; }
function haversineKm(la1,lo1,la2,lo2){ const R=6371,d=Math.PI/180;
  const a=Math.sin((la2-la1)*d/2)**2+Math.cos(la1*d)*Math.cos(la2*d)*Math.sin((lo2-lo1)*d/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a))); }

/* -------- search / friends -------- */
async function searchProfiles(q){
  q=(q||'').replace(/[%,()]/g,' ').trim();
  let query=sb.from('profiles').select('*').eq('discoverable',true).limit(60);
  if(q){ const like='%'+q+'%'; query=query.or('name.ilike.'+like+',handle.ilike.'+like+',company.ilike.'+like); }
  const { data, error } = await query;
  if(error){ console.warn('[HoC] search',error); return []; }
  return (data||[]).filter(p=>!cloudUser||p.id!==cloudUser.id);
}
async function findFriends(q,radiusKm){
  let rows=await searchProfiles(q);
  if(fui.blockedIds && fui.blockedIds.size) rows=rows.filter(p=>!fui.blockedIds.has(p.id));   // hide people you've blocked
  if(radiusKm && myProfile && myProfile.lat!=null && myProfile.lng!=null){
    rows=rows.filter(p=>p.lat!=null&&p.lng!=null)
      .map(p=>{ p._dist=haversineKm(myProfile.lat,myProfile.lng,p.lat,p.lng); return p; })
      .filter(p=>p._dist<=radiusKm).sort((a,b)=>a._dist-b._dist);
  }
  return rows;
}
async function sendFriendRequest(toId){
  const { error } = await sb.from('friendships').insert({ requester:cloudUser.id, addressee:toId, status:'pending' });
  return error ? { error:error.message } : { ok:true };
}
async function respondRequest(relId,accept){
  if(accept) await sb.from('friendships').update({ status:'accepted' }).eq('id',relId);
  else await sb.from('friendships').delete().eq('id',relId);
}
async function loadSocial(){
  if(!cloudUser) return;
  const { data:fr } = await sb.from('friendships').select('*').or('requester.eq.'+cloudUser.id+',addressee.eq.'+cloudUser.id);
  const rows=fr||[]; const ids=new Set();
  rows.forEach(r=>ids.add(r.requester===cloudUser.id?r.addressee:r.requester));
  let profs={};
  if(ids.size){ const { data:ps } = await sb.from('profiles').select('*').in('id',[...ids]); (ps||[]).forEach(p=>profs[p.id]=p); }
  const friends=[],incoming=[],outgoing=[],blocked=[]; const blockedIds=new Set();
  rows.forEach(r=>{ const otherId=r.requester===cloudUser.id?r.addressee:r.requester; const other=profs[otherId]||{id:otherId,name:'(unknown)'};
    if(r.status==='blocked'){ blockedIds.add(otherId); if(r.requester===cloudUser.id) blocked.push({rel:r,other}); return; }
    if(r.status==='accepted') friends.push({rel:r,other});
    else if(r.addressee===cloudUser.id) incoming.push({rel:r,other});
    else outgoing.push({rel:r,other}); });
  fui.friends=friends; fui.incoming=incoming; fui.outgoing=outgoing; fui.blocked=blocked; fui.blockedIds=blockedIds;
  await loadMyCompany();
}
function relatedIds(){ const s=new Set(); fui.friends.forEach(x=>s.add(x.other.id)); fui.incoming.forEach(x=>s.add(x.other.id)); fui.outgoing.forEach(x=>s.add(x.other.id)); return s; }

/* -------- companies (their own searchable, followable pages) -------- */
async function loadMyCompany(){ if(!cloudUser){ myCompany=null; return null; }
  const { data } = await sb.from('companies').select('*').eq('owner',cloudUser.id).maybeSingle();
  myCompany=data||null; return myCompany; }
async function upsertCompany(fields){ if(!cloudUser) return { error:'not connected' };
  const row=Object.assign({ owner:cloudUser.id }, fields); if(myCompany&&myCompany.id)row.id=myCompany.id;
  const { data, error } = await sb.from('companies').upsert(row).select().maybeSingle();
  if(error) return { error:error.message }; myCompany=data; return { ok:true }; }
async function uploadCompanyAvatar(file){ if(!socialReady()) return { error:'connect to the cloud first' };
  if(!myCompany||!myCompany.id){ const r=await upsertCompany({ name:val('co_name')||'My company' }); if(r.error)return r; }
  const ext=((file.name||'').split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'')||'png';
  const path=cloudUser.id+'/company-'+myCompany.id+'.'+ext;
  const { error } = await sb.storage.from('avatars').upload(path,file,{ upsert:true, contentType:file.type||'image/png' });
  if(error) return { error:error.message };
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  return upsertCompany({ avatar_url:data.publicUrl+'?v='+Date.now() }); }
async function searchCompanies(q){ q=(q||'').replace(/[%,()]/g,' ').trim();
  let query=sb.from('companies').select('*').eq('discoverable',true).limit(40);
  if(q){ const like='%'+q+'%'; query=query.or('name.ilike.'+like+',handle.ilike.'+like+',bio.ilike.'+like); }
  const { data, error } = await query; if(error){ console.warn('[HoC] company search',error); return []; } return data||[]; }
async function findCompanies(q,radiusKm){ let rows=await searchCompanies(q);
  if(radiusKm && myProfile && myProfile.lat!=null && myProfile.lng!=null){
    rows=rows.filter(c=>c.lat!=null&&c.lng!=null).map(c=>{ c._dist=haversineKm(myProfile.lat,myProfile.lng,c.lat,c.lng); return c; })
      .filter(c=>c._dist<=radiusKm).sort((a,b)=>a._dist-b._dist); }
  return rows; }
async function loadFollows(){ if(!cloudUser){ fui.following=[]; fui.followingIds=new Set(); return; }
  const { data:fl } = await sb.from('follows').select('*').eq('follower',cloudUser.id);
  const rows=fl||[]; const ids=rows.map(r=>r.company);
  let comps={}; if(ids.length){ const { data:cs } = await sb.from('companies').select('*').in('id',ids); (cs||[]).forEach(c=>comps[c.id]=c); }
  fui.following=rows.map(r=>comps[r.company]).filter(Boolean); fui.followingIds=new Set(ids); }
async function followCompany(id){ const { error } = await sb.from('follows').insert({ follower:cloudUser.id, company:id }); return error?{error:error.message}:{ok:true}; }
async function unfollowCompany(id){ await sb.from('follows').delete().eq('follower',cloudUser.id).eq('company',id); }

/* -------- UI actions (called from inline handlers) -------- */
async function cloudConnect(){
  const email=val('cl_email'), pass=val('cl_pass');
  if(!email||!pass){ toast('Enter your email and password.'); return; }
  if(fui.mode==='signup'){
    const name=val('cl_name')||email.split('@')[0], handle=(val('cl_handle')||email.split('@')[0]).toLowerCase();
    const r=await cloudSignUp(email,pass,name,handle);
    if(r.error){ toast(r.error); return; }
    if(r.needsConfirm){ toast('Account made — check your email to confirm, then Sign in.'); fui.mode='signin'; render(); return; }
    toast('Cloud account created.');
  } else {
    const r=await cloudSignIn(email,pass); if(r.error){ toast(r.error); return; } toast('Connected to the cloud.');
  }
  fui.loaded=false; await loadSocial(); fui.loaded=true; render();
}
/* one-tap reconnect — uses the account you're already logged into the app with */
async function reconnectCloud(){ const pass=val('cl_pass'); if(!pass){ toast('Enter your password.'); return; }
  const u=(typeof me==='function')?me():null; if(!u){ toast('Log into the app first.'); return; }
  toast('Connecting…'); await syncCloudToAppUser(u,pass);
  if(socialReady()) toast('Connected.'); else toast('Couldn’t connect — check your password, and that your account has an email (Settings → My account).'); }
async function cloudDisconnect(){ await cloudSignOut(); toast('Disconnected from the cloud.'); render(); }
async function saveProfile(){
  const fields={ name:val('pf_name'), handle:val('pf_handle').toLowerCase(), company:val('pf_company'), bio:val('pf_bio'), city:val('pf_city') };
  if(fui.loc){ fields.lat=fui.loc.lat; fields.lng=fui.loc.lng; }
  else if(fields.city && (!myProfile || myProfile.city!==fields.city || myProfile.lat==null)){
    toast('Looking up your area…'); const g=await geocode(fields.city); if(g){ fields.lat=g.lat; fields.lng=g.lng; } }
  const r=await upsertProfile(fields);
  if(r.error){ toast('Save failed: '+r.error); return; }
  fui.loc=null; toast('Profile saved & synced.'); render();
}
async function useGPS(){ toast('Getting your location…'); const g=await getGPS();
  if(!g){ toast('Couldn’t read GPS — type a city or ZIP instead.'); return; }
  fui.loc=g; toast('Location captured — tap Save profile to keep it.'); }
async function doFriendSearch(){ fui.q=val('fr_q'); const sel=el('fr_radius'); fui.radius=sel?parseFloat(sel.value)||0:0;
  fui.busy=true; fui.results=null; render();
  const km=fui.radius?fui.radius*KM_PER_MI():0;
  const [people,companies]=await Promise.all([findFriends(fui.q,km),findCompanies(fui.q,km)]);
  fui.results={people,companies}; fui.busy=false; render(); }
async function addFriend(id){ if(!id){ toast('No user to add.'); return; }
  const r=await sendFriendRequest(id);
  if(r.error){ toast(/duplicate/i.test(r.error)?'Already added or request pending.':r.error); return; }
  toast('Friend request sent — they’ll get a notification.'); await loadSocial(); render(); }
async function addCompanyFriend(ownerId){ if(!ownerId){ toast('This shop hasn’t set an owner to add yet.'); return; } return addFriend(ownerId); }
async function respondFriend(relId,accept){ await respondRequest(relId,accept); await loadSocial(); render(); toast(accept?'Friend added!':'Request denied.'); }
async function unfriend(relId){ await sb.from('friendships').delete().eq('id',relId); await loadSocial(); render(); toast('Removed.'); }
async function blockUser(otherId){ if(!socialReady()||!otherId) return;
  const mine=cloudUser.id;
  await sb.from('friendships').delete().or('and(requester.eq.'+mine+',addressee.eq.'+otherId+'),and(requester.eq.'+otherId+',addressee.eq.'+mine+')');
  const { error } = await sb.from('friendships').insert({ requester:mine, addressee:otherId, status:'blocked' });
  if(error){ toast(error.message); return; }
  toast('User blocked.'); await loadSocial(); render(); }
async function unblockUser(otherId){ await sb.from('friendships').delete().eq('requester',cloudUser.id).eq('addressee',otherId).eq('status','blocked');
  await loadSocial(); render(); toast('Unblocked.'); }
async function saveCompany(){
  const fields={ name:val('co_name'), handle:val('co_handle').toLowerCase(), bio:val('co_bio'), city:val('co_city') };
  if(!fields.name){ toast('Enter a company name.'); return; }
  if(fui.cloc){ fields.lat=fui.cloc.lat; fields.lng=fui.cloc.lng; }
  else if(fields.city && (!myCompany || myCompany.city!==fields.city || myCompany.lat==null)){
    toast('Looking up your area…'); const g=await geocode(fields.city); if(g){ fields.lat=g.lat; fields.lng=g.lng; } }
  const r=await upsertCompany(fields); if(r.error){ toast('Save failed: '+r.error); return; }
  fui.cloc=null; toast('Company page saved.'); render(); }
async function useCompanyGPS(){ toast('Getting location…'); const g=await getGPS();
  if(!g){ toast('Couldn’t read GPS — type a city or ZIP instead.'); return; }
  fui.cloc=g; toast('Location captured — tap Save company to keep it.'); }
function onCompanyAvatarPick(input){ const f=input.files[0]; if(!f)return; toast('Uploading logo…');
  uploadCompanyAvatar(f).then(r=>{ if(r.error)toast('Upload failed: '+r.error); else toast('Company logo updated.'); render(); }); }
async function doFollow(id){ const r=await followCompany(id); if(r.error){ toast(r.error); return; } toast('Following.'); await loadFollows(); render(); }
async function doUnfollow(id){ await unfollowCompany(id); toast('Unfollowed.'); await loadFollows(); render(); }
function companyRow(c){
  const dist=(c._dist!=null)?'<span class="tag">'+(c._dist/KM_PER_MI()).toFixed(c._dist<KM_PER_MI()*10?1:0)+' mi</span>':'';
  const mine=myCompany&&myCompany.id===c.id;
  const btn= mine?'<span class="pill owner">yours</span>'
    : '<button class="blue sm" onclick="addCompanyFriend(\''+(c.owner||'')+'\')">＋ Add friend</button>';
  return '<div class="pickrow">'+profileAvatar(c,'sm')+
    '<div style="flex:1;min-width:0"><div style="font-weight:800">🏢 '+esc(c.name||'(company)')+' '+dist+'</div>'+
      '<div class="muted">'+(c.handle?'@'+esc(c.handle):'')+(c.city?' · '+esc(c.city):'')+'</div>'+
      (c.bio?'<div class="muted">'+esc(c.bio)+'</div>':'')+'</div>'+
    '<div class="row" style="gap:6px">'+btn+'</div></div>'; }

/* -------- avatar helpers shared with the top bar -------- */
function profileAvatar(p,size){ const c='avatar-'+(size||'sm');
  return (p&&p.avatar_url) ? '<img class="'+c+'" src="'+esc(p.avatar_url)+'" alt=""/>'
    : '<div class="'+c+' avatar-ph">'+esc(((p&&p.name)||'?').trim().charAt(0).toUpperCase()||'?')+'</div>'; }
function topAvatarHtml(){ return (myProfile&&myProfile.avatar_url) ? '<img class="avatar-sm" src="'+esc(myProfile.avatar_url)+'" alt=""/>' : ''; }

/* -------- the Friends view -------- */
function viewFriends(){
  if(!cloudOn()){
    return '<h2 class="page">Friends</h2><div class="card"><div class="banner">The cloud isn’t configured yet, so friends &amp; cross-device profiles are off. Add your Supabase keys in <b>config.js</b> and follow <b>SUPABASE_SETUP.md</b>.</div></div>';
  }
  if(!cloudUser) return viewCloudConnect();

  // lazy-load friends/requests the first time the tab opens
  if(!fui.loaded){ fui.loaded=true; loadSocial().then(()=>render()).catch(e=>console.warn('[HoC] loadSocial',e)); }
  const p=myProfile||{};
  const loc = fui.loc ? ('GPS set ('+fui.loc.lat.toFixed(3)+', '+fui.loc.lng.toFixed(3)+') — Save to keep')
            : (p.lat!=null ? ('on the map'+(p.city?' · '+esc(p.city):'')) : 'not set — add a city/ZIP or use GPS');

  const profileCard='<div class="card"><h3>Your profile <small class="muted">— visible to other sellers</small></h3>'+
    '<div class="row" style="align-items:center;gap:14px;margin-bottom:8px">'+profileAvatar(p,'lg')+
      '<label class="fld" style="flex:1;min-width:180px;margin:0"><span>Profile picture (syncs to all your devices)</span><input type="file" accept="image/*" onchange="onAvatarPick(this)"/></label></div>'+
    '<div class="grid2">'+fld('Display name',inp('pf_name',p.name||''))+fld('Username',inp('pf_handle',p.handle||'','letters & numbers'))+'</div>'+
    '<div class="grid2">'+fld('Company / shop',inp('pf_company',p.company||'','your store or team'))+fld('City or ZIP',inp('pf_city',p.city||'','for finding nearby sellers'))+'</div>'+
    fld('Bio',inp('pf_bio',p.bio||'','what you collect / sell'))+
    '<div class="row"><button class="gold" onclick="saveProfile()">Save profile</button>'+
      '<button class="ghost" onclick="useGPS()">📍 Use my GPS location</button>'+
      '<span class="muted">Location: '+loc+'</span></div></div>';

  // company page (optional) — makes your shop its own searchable, followable entry
  const c=myCompany||{};
  const cloc = fui.cloc ? 'GPS set — Save to keep'
            : (c.lat!=null ? ('on the map'+(c.city?' · '+esc(c.city):'')) : 'not set');
  const companyCard='<div class="card"><h3>Your company page '+(myCompany?'':'<small class="muted">— optional; makes your shop searchable</small>')+'</h3>'+
    '<div class="row" style="align-items:center;gap:14px;margin-bottom:8px">'+profileAvatar(c,'lg')+
      '<label class="fld" style="flex:1;min-width:180px;margin:0"><span>Company logo</span><input type="file" accept="image/*" onchange="onCompanyAvatarPick(this)"/></label></div>'+
    '<div class="grid2">'+fld('Company name',inp('co_name',c.name||'','your shop / team'))+fld('Company username',inp('co_handle',c.handle||'','@handle'))+'</div>'+
    '<div class="grid2">'+fld('City or ZIP',inp('co_city',c.city||'','shop location'))+fld('Bio',inp('co_bio',c.bio||'','what you sell'))+'</div>'+
    '<div class="row"><button class="gold" onclick="saveCompany()">'+(myCompany?'Save company':'Create company page')+'</button>'+
      '<button class="ghost" onclick="useCompanyGPS()">📍 Use GPS</button><span class="muted">Location: '+cloc+'</span></div></div>';

  const radii=[[0,'Any distance'],[5,'5 mi'],[10,'10 mi'],[25,'25 mi'],[50,'50 mi'],[100,'100 mi'],[250,'250 mi']];
  const radSel='<select id="fr_radius" style="width:auto">'+radii.map(r=>'<option value="'+r[0]+'"'+(fui.radius===r[0]?' selected':'')+'>'+r[1]+'</option>').join('')+'</select>';
  let results;
  if(fui.busy) results='<div class="muted">Searching…</div>';
  else if(fui.results==null) results='<div class="muted">Search people and companies by name, username, or company — or set a radius to find sellers near you. Partial spellings work.</div>';
  else {
    const people=fui.results.people||[], companies=fui.results.companies||[];
    if(!people.length && !companies.length) results='<div class="empty">No matches. Try fewer letters or a wider radius.</div>';
    else { const rel=relatedIds();
      const cHtml=companies.length?companies.map(companyRow).join(''):'<div class="muted">No companies matched.</div>';
      const pHtml=people.length?people.map(pr=>friendRow(pr,rel.has(pr.id)?'related':'add')).join(''):'<div class="muted">No people matched.</div>';
      results='<div class="muted" style="font-weight:800;margin-bottom:4px">Companies</div>'+cHtml+'<hr class="sep"><div class="muted" style="font-weight:800;margin-bottom:4px">People</div>'+pHtml; }
  }
  const searchCard='<div class="card"><h3>Find friends &amp; shops</h3>'+
    '<div class="row" style="align-items:flex-end">'+
      '<label class="fld" style="flex:1;min-width:200px;margin:0"><span>Name, username, or company</span><input id="fr_q" value="'+esc(fui.q||'')+'" placeholder="e.g. reggie, house of cards, smith" onkeydown="if(event.key===\'Enter\')doFriendSearch()"/></label>'+
      '<label class="fld" style="margin:0"><span>Within</span>'+radSel+'</label>'+
      '<button class="gold" onclick="doFriendSearch()">Search</button></div>'+
    '<div style="margin-top:12px">'+results+'</div></div>';

  const reqCard=fui.incoming.length ? '<div class="card"><h3>Friend requests ('+fui.incoming.length+')</h3>'+
    fui.incoming.map(x=>friendRow(x.other,'respond',x.rel.id)).join('')+'</div>' : '';
  const friendsCard='<div class="card"><h3>Your friends ('+fui.friends.length+')</h3>'+
    (fui.friends.length ? fui.friends.map(x=>friendRow(x.other,'friend',x.rel.id)).join('') : '<div class="muted">No friends yet — find some above.</div>')+'</div>';
  const blockedCard=(fui.blocked&&fui.blocked.length) ? '<div class="card"><h3>Blocked ('+fui.blocked.length+')</h3>'+
    fui.blocked.map(x=>friendRow(x.other,'blocked')).join('')+'</div>' : '';

  return '<h2 class="page">Friends <small>connected as '+esc((myProfile&&myProfile.name)||cloudUser.email)+' · <a href="#" onclick="cloudDisconnect();return false">disconnect</a></small></h2>'+
    profileCard+companyCard+searchCard+reqCard+friendsCard+blockedCard;
}
function friendRow(p,action,relId){
  const dist=(p._dist!=null)?'<span class="tag">'+(p._dist/KM_PER_MI()).toFixed(p._dist<KM_PER_MI()*10?1:0)+' mi</span>':'';
  let btn='';
  if(action==='add') btn='<button class="blue sm" onclick="addFriend(\''+p.id+'\')">＋ Add friend</button> <button class="ghost sm" onclick="blockUser(\''+p.id+'\')">Block</button>';
  else if(action==='respond') btn='<button class="gold sm" onclick="respondFriend(\''+relId+'\',true)">Accept</button> <button class="ghost sm" onclick="respondFriend(\''+relId+'\',false)">Deny</button> <button class="red sm" onclick="blockUser(\''+p.id+'\')">Block</button>';
  else if(action==='related') btn='<span class="muted">pending / friend</span>';
  else if(action==='friend') btn='<span class="pill avail">friend</span> <button class="ghost sm" onclick="unfriend(\''+relId+'\')">Remove</button> <button class="ghost sm" onclick="blockUser(\''+p.id+'\')">Block</button>';
  else if(action==='blocked') btn='<button class="ghost sm" onclick="unblockUser(\''+p.id+'\')">Unblock</button>';
  return '<div class="pickrow">'+profileAvatar(p,'sm')+
    '<div style="flex:1;min-width:0"><div style="font-weight:800">'+esc(p.name||'(no name)')+' '+dist+'</div>'+
      '<div class="muted">'+(p.handle?'@'+esc(p.handle):'')+(p.company?' · '+esc(p.company):'')+(p.city?' · '+esc(p.city):'')+'</div>'+
      (p.bio?'<div class="muted">'+esc(p.bio)+'</div>':'')+'</div>'+
    '<div class="row" style="gap:6px">'+btn+'</div></div>';
}
function onAvatarPick(input){ const f=input.files[0]; if(!f)return; toast('Uploading photo…');
  uploadAvatar(f).then(r=>{ if(r.error)toast('Upload failed: '+r.error); else toast('Profile picture updated & synced.'); render(); }); }

/* ============ cloud inventory & state sync (Phase 2) ============ */
/* Inventory rows live in public.items (one row per item — friends can read them,
   powering inventory viewing later). Everything else (sales, shows, trades,
   wish list, settings, audit) is private, so it syncs as one JSONB document in
   public.user_state. Local IndexedDB stays as the offline cache; every save()
   schedules a debounced push of just what changed. */
const STATE_DOC_KEYS=['version','paymentAccounts','settings','shows','currentShowId','trades','wantlist','sales','imageDB','audit'];
let _pushedItems=null, _pushedDoc=null, _pushTimer=null, _pushing=false;

function buildStateDoc(){ const doc={}; STATE_DOC_KEYS.forEach(k=>{ if(state[k]!==undefined)doc[k]=state[k]; }); return doc; }

/* download my cloud copy; returns 'ok' (loaded), 'empty' (no cloud copy yet) or 'error' */
async function pullCloud(){
  if(!socialReady()) return 'error';
  const { data:st, error:e1 } = await sb.from('user_state').select('doc').eq('owner_id',cloudUser.id).maybeSingle();
  if(e1){ console.warn('[HoC] pull state',e1); return 'error'; }
  const { data:rows, error:e2 } = await sb.from('items').select('id,data').eq('owner_id',cloudUser.id);
  if(e2){ console.warn('[HoC] pull items',e2); return 'error'; }
  if(!st||!st.doc) return 'empty';
  Object.assign(state, st.doc);
  state.inventory=(rows||[]).map(r=>r.data);
  _pushedItems={}; (rows||[]).forEach(r=>{ _pushedItems[r.id]=JSON.stringify(r.data); });
  _pushedDoc=JSON.stringify(buildStateDoc());
  return 'ok';
}

function cloudPushSoon(){
  if(!socialReady()||typeof state==='undefined'||!state||typeof ui==='undefined'||!ui.authed) return;
  clearTimeout(_pushTimer); _pushTimer=setTimeout(()=>{ cloudPush().catch(e=>console.warn('[HoC] cloud push',e)); },2500);
}

/* upload only what changed since the last successful push */
async function cloudPush(){
  if(!socialReady()) return;
  if(_pushing){ cloudPushSoon(); return; }
  _pushing=true;
  try{
    if(_pushedItems==null)_pushedItems={};
    const ups=[], have={}, now=new Date().toISOString();
    (state.inventory||[]).forEach(it=>{ if(!it||!it.id)return; const j=JSON.stringify(it); have[it.id]=1;
      if(_pushedItems[it.id]!==j) ups.push({ owner_id:cloudUser.id, id:it.id, data:JSON.parse(j), updated_at:now }); });
    const dels=Object.keys(_pushedItems).filter(id=>!have[id]);
    if(ups.length){ const { error } = await sb.from('items').upsert(ups,{ onConflict:'owner_id,id' }); if(error)throw error;
      ups.forEach(u=>{ _pushedItems[u.id]=JSON.stringify(u.data); }); }
    if(dels.length){ const { error } = await sb.from('items').delete().eq('owner_id',cloudUser.id).in('id',dels); if(error)throw error;
      dels.forEach(id=>{ delete _pushedItems[id]; }); }
    const doc=buildStateDoc(); const dj=JSON.stringify(doc);
    if(dj!==_pushedDoc){ const { error } = await sb.from('user_state').upsert({ owner_id:cloudUser.id, doc, updated_at:now }); if(error)throw error; _pushedDoc=dj; }
  } finally { _pushing=false; }
}
window.addEventListener('online',()=>{ try{ cloudPushSoon(); }catch(e){} });

/* Rare fallback — cloud normally connects automatically when you log into the app.
   Shown only if the auto-connect didn't go through (e.g. password changed or no email on file). */
function viewCloudConnect(){
  const u=(typeof me==='function'&&state&&me())?me():{};
  return '<h2 class="page">Friends <small>connecting your cloud profile…</small></h2>'+
    '<div class="login" style="max-width:440px"><div class="card">'+
    '<div class="banner">You’re signed in as <b>'+esc(u.name||'')+'</b>. Your cloud profile normally connects on its own — if it didn’t, re-enter your password to connect now.</div>'+
    fld('Password',inp('cl_pass','','','password'))+
    '<div class="row" style="margin-top:8px"><button class="gold" onclick="reconnectCloud()">Connect</button></div>'+
    '<div class="muted" style="margin-top:8px">This connects the same account you log into the app with. If you keep seeing this, make sure your account has an email (Settings → My account) and that Supabase “Confirm email” is OFF.</div>'+
    '</div></div>';
}
