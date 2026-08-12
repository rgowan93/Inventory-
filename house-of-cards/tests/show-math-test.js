// Unit tests for the show settlement engine (run: node tests/show-math-test.js)
const { computeShowReport } = require('../show-math.js');
const $ = d => Math.round(d * 100);
let fails = 0;
function T(name, fn) { try { fn(); console.log('PASS', name); } catch (e) { fails++; console.log('FAIL', name, '—', e.message); } }
function eq(a, b, what) { if (a !== b) throw new Error(what + ': got ' + a + ' want ' + b); }
function E(form, person, dir, dollars) { return { pay_form: form, person, direction: dir, amount_cents: $(dollars) }; }

T("Reggie's worked example WITH the $200 drawer reserve", () => {
  const entries = [];
  for (const f of ['cash','cashapp','venmo','paypal','zelle','square'])
    for (const p of ['reggie','manny','hailey']) entries.push(E(f, p, 1, 50));
  const r = computeShowReport({ cash_start_cents: $(200), float_owner: 'reggie', entries, tallies: {} });
  eq(r.verified, true, 'verified');
  eq(r.kept_cents, $(200), 'drawer keeps $200 for next show');
  eq(r.kept_by, 'reggie', 'kept cash counts as float owner\'s');
  eq(r.entitlement.reggie, $(500), 'reggie entitled (300 sales + 200 float)');
  // pot $350, $200 stays in the drawer → only $150 cash to hand out
  eq(r.cash_out.hailey, $(150), 'hailey takes the distributable cash');
  eq(r.cash_out.manny, $(0), 'manny gets his via transfer');
  eq(r.cash_out.reggie, $(0), 'reggie takes no pocket cash');
  // reggie's kept $200 exceeds his cash need ($0) → he sends the difference
  eq(r.transfers.reduce((a,t)=>a+t.amount_cents,0), $(200), 'reggie sends $200 total');
  eq(r.transfers.every(t=>t.from==='reggie'), true, 'reggie is the sender');
  eq(r.profit_cents, $(900), 'profit');
  eq(r.cash_out.reggie + r.cash_out.manny + r.cash_out.hailey + r.kept_cents, r.pot_cents, 'every physical dollar accounted');
});

T("next_float_cents: 0 reproduces the old no-reserve split", () => {
  const entries = [];
  for (const f of ['cash','cashapp','venmo','paypal','zelle','square'])
    for (const p of ['reggie','manny','hailey']) entries.push(E(f, p, 1, 50));
  const r = computeShowReport({ cash_start_cents: $(200), float_owner: 'reggie', entries, tallies: {}, next_float_cents: 0 });
  eq(r.verified, true, 'verified');
  eq(r.kept_cents, 0, 'nothing kept');
  eq(r.cash_out.hailey, $(250), 'hailey takes cash');
  eq(r.cash_out.manny, $(100), 'manny takes cash');
  eq(r.transfers.length, 0, 'no transfers needed');
});

T("machine split 50/50 + tallies land where tapped (reserve swallows the small pot)", () => {
  const r = computeShowReport({ cash_start_cents: 0, float_owner: 'reggie', entries: [],
    tallies: { cash: 3, venmo: 2, zelle_hailey: 1 } }); // $30 cash, $20 venmo, $10 hailey zelle = $60 machine
  eq(r.machine_total_cents, $(60), 'machine total');
  eq(r.entitlement.manny, $(30), 'manny half');
  eq(r.entitlement.reggie, $(30), 'reggie half');
  eq(r.holdings.manny, $(20), 'manny holds venmo tallies');
  eq(r.holdings.hailey, $(10), 'hailey holds her zelle tally');
  eq(r.pot_cents, $(30), 'machine cash pot');
  eq(r.kept_cents, $(30), 'whole pot stays in the drawer (< $200)');
  eq(r.verified, true, 'verified');
  eq(r.cash_out.reggie + r.cash_out.manny + r.cash_out.hailey, 0, 'no pocket cash');
  // reggie's kept $30 covers his $30 need exactly; hailey's extra $10 goes to manny
  eq(r.transfers.reduce((a,t)=>a+t.amount_cents,0), $(10), 'hailey sends $10');
  eq(r.transfers[0].from, 'hailey', 'sender is hailey');
  eq(r.transfers[0].to, 'manny', 'receiver is manny');
});

T("reserve bigger than the float owner's need → they send the overage", () => {
  const r = computeShowReport({ cash_start_cents: 0, float_owner: 'reggie',
    entries: [E('cash','manny',1,250)], tallies: {} });
  eq(r.kept_cents, $(200), 'kept');
  eq(r.cash_out.manny, $(50), 'manny takes what cash is left');
  eq(r.transfers.length, 1, 'one transfer');
  eq(r.transfers[0].from, 'reggie', 'reggie sends');
  eq(r.transfers[0].to, 'manny', 'to manny');
  eq(r.transfers[0].amount_cents, $(200), 'the kept overage');
  eq(r.verified, true, 'verified');
});

T("subtract entries: buying a collection with drawer cash below float", () => {
  const r = computeShowReport({ cash_start_cents: $(200), float_owner: 'reggie',
    entries: [E('cash','reggie',-1,300), E('venmo','manny',1,400)], tallies: {} });
  eq(r.checks.conserved, true, 'conserved even with negative pot');
  eq(r.kept_cents, 0, 'nothing to keep from a negative pot');
  eq(r.transfers.length, 0, 'nothing to transfer, reggie simply ate the drawer');
});

T("odd tally count halves exactly (3 tallies = $30 → $15/$15)", () => {
  const r = computeShowReport({ cash_start_cents: 0, float_owner: 'reggie', entries: [], tallies: { cash: 3 } });
  eq(r.machine_split.reggie, $(15), 'reggie 15');
  eq(r.machine_split.manny, $(15), 'manny 15');
  eq(r.verified, true, 'verified');
});

T("cents precision: $12.37 + $0.63 sale", () => {
  const r = computeShowReport({ cash_start_cents: 0, float_owner: 'reggie',
    entries: [E('cashapp','hailey',1,12.37), E('cash','hailey',1,0.63)], tallies: {} });
  eq(r.entitlement.hailey, 1300, 'hailey exactly $13.00');
  eq(r.verified, true, 'verified');
});

T("empty show: the float just stays in the drawer for next time", () => {
  const r = computeShowReport({ cash_start_cents: $(150), float_owner: 'hailey', entries: [], tallies: {} });
  eq(r.verified, true, 'verified');
  eq(r.kept_cents, $(150), 'float rolls forward');
  eq(r.kept_by, 'hailey', 'still hailey\'s money');
  eq(r.cash_out.hailey, 0, 'no pocket cash needed');
  eq(r.transfers.length, 0, 'no transfers');
  eq(r.profit_cents, 0, 'no profit');
});

T("accounts matrix: every dollar in every account attributed to a person", () => {
  const r = computeShowReport({ cash_start_cents: $(200), float_owner: 'reggie',
    entries: [E('zelle','manny',1,40), E('cashapp','hailey',1,60)],
    tallies: { cashapp: 2 } });
  eq(r.accounts.cashapp.total_cents, $(80), 'cash app total (sale + machine)');
  eq(r.accounts.cashapp.by_person.hailey, $(60), 'hailey\'s part of cash app');
  eq(r.accounts.cashapp.by_person.reggie, $(10), 'reggie\'s machine half');
  eq(r.accounts.cashapp.by_person.manny, $(10), 'manny\'s machine half');
  eq(r.accounts.zelle_manny.total_cents, $(40), 'manny\'s zelle');
  eq(r.accounts.cash.total_cents, $(200), 'drawer = float');
  eq(r.accounts.cash.by_person.reggie, $(200), 'float is reggie\'s');
  eq(r.checks.acctOk, true, 'account matrix sums to entitlements');
  eq(r.verified, true, 'verified');
});

T("fuzz: 300 random shows all verify and conserve cash", () => {
  const forms=['cash','cashapp','venmo','paypal','zelle','square'], people=['reggie','manny','hailey'];
  const boxes=['cash','cashapp','venmo','paypal','square','zelle_reggie','zelle_manny','zelle_hailey'];
  let seed=1234; const rnd=()=>((seed=(seed*1103515245+12345)>>>0)/4294967296);
  for(let s=0;s<300;s++){
    const entries=[]; const n=Math.floor(rnd()*50);
    for(let i=0;i<n;i++) entries.push(E(forms[Math.floor(rnd()*6)], people[Math.floor(rnd()*3)], rnd()<0.85?1:-1, Math.floor(rnd()*30000)/100+1));
    const tallies={}; boxes.forEach(b=>{ if(rnd()<0.5) tallies[b]=Math.floor(rnd()*20); });
    const r=computeShowReport({ cash_start_cents: Math.floor(rnd()*40000), float_owner: people[Math.floor(rnd()*3)], entries, tallies });
    if(r.pot_cents>=0){
      if(!r.verified) throw new Error('show '+s+' failed verification');
      const out=r.cash_out.reggie+r.cash_out.manny+r.cash_out.hailey;
      if(out+r.kept_cents!==r.pot_cents) throw new Error('show '+s+' cash leak: '+(out+r.kept_cents)+' vs pot '+r.pot_cents);
    } else if(!r.checks.conserved) throw new Error('show '+s+' not conserved');
  }
});


T("trades: recorded per person but never move money", () => {
  const base = { cash_start_cents: $(200), float_owner: 'reggie',
    entries: [E('cash','hailey',1,300), E('cashapp','manny',1,120)], tallies: {} };
  const noTrade = computeShowReport(base);
  const withTrade = computeShowReport(Object.assign({}, base, { entries: base.entries.concat([
    E('trade','reggie',1,80), E('trade','manny',1,45)
  ])}));
  eq(withTrade.verified, true, 'verified with trades');
  eq(withTrade.trades.total_cents, $(125), 'trade total');
  eq(withTrade.trades.by_person.reggie, $(80), 'reggie trade value');
  eq(withTrade.trades.by_person.manny, $(45), 'manny trade value');
  eq(withTrade.trades.count, 2, 'trade line count');
  // the money settlement is IDENTICAL with or without the trade lines
  for (const p of ['reggie','manny','hailey']) {
    eq(withTrade.entitlement[p], noTrade.entitlement[p], p+' entitlement unchanged');
    eq(withTrade.cash_out[p], noTrade.cash_out[p], p+' cash unchanged');
  }
  eq(withTrade.pot_cents, noTrade.pot_cents, 'pot unchanged');
  eq(withTrade.profit_cents, noTrade.profit_cents, 'money profit unchanged');
  eq(withTrade.transfers.length, noTrade.transfers.length, 'transfers unchanged');
});
console.log(fails ? ('\n' + fails + ' FAILURES') : '\nALL PASS');
process.exit(fails ? 1 : 0);
