/* House of Cards — Show Stats settlement engine.
   Pure function, integer cents everywhere. Loaded by app.js and unit-tested in Node.

   Money model:
   - Each sale entry: {pay_form, person, direction(+1 in/-1 out), amount_cents}.
   - Platform custody: venmo→manny; cashapp/paypal/square→reggie; zelle→the person on the
     entry (each has their own Zelle); cash→the physical box.
   - Vending machine tallies: one tally = $10 on the box it was tapped under. Machine
     revenue splits 50/50 Manny/Reggie. zelle_<name> boxes land in that person's Zelle;
     the cash box tally is physical cash on site.
   - The starting float is treated as part of the float owner's entitlement and part of
     the physical pot, which stays correct even if the drawer dipped below the float. */
(function (root) {
  const PEOPLE = ['reggie', 'manny', 'hailey'];
  const FORMS = ['cash', 'cashapp', 'venmo', 'paypal', 'zelle', 'square'];
  const TALLY_CENTS = 1000;
  const CONTROLLER = { venmo: 'manny', cashapp: 'reggie', paypal: 'reggie', square: 'reggie' };
  const SEND_VIA = { manny: 'Venmo', reggie: 'Cash App / PayPal / Zelle (his pick)', hailey: 'Zelle' };

  function computeShowReport(input) {
    const cashStart = Math.round(input.cash_start_cents || 0);
    const floatOwner = PEOPLE.indexOf(input.float_owner) >= 0 ? input.float_owner : 'reggie';
    const entries = (input.entries || []).filter(e => !e.deleted);
    const tallies = input.tallies || {};

    // ---- per-form and per-person sales ----
    const form = {}; FORMS.forEach(f => form[f] = { in_cents: 0, out_cents: 0, net_cents: 0, machine_cents: 0 });
    const salesNet = { reggie: 0, manny: 0, hailey: 0 };
    const zelleByPerson = { reggie: 0, manny: 0, hailey: 0 };
    for (const e of entries) {
      const amt = Math.round(e.amount_cents || 0); if (!(amt > 0)) continue;
      const f = form[e.pay_form]; if (!f || PEOPLE.indexOf(e.person) < 0) continue;
      const signed = (e.direction === -1 ? -amt : amt);
      if (signed >= 0) f.in_cents += amt; else f.out_cents += amt;
      f.net_cents += signed;
      salesNet[e.person] += signed;
      if (e.pay_form === 'zelle') zelleByPerson[e.person] += signed;
    }

    // ---- machine tallies ----
    const boxCents = {}; let machineTotal = 0;
    ['cash', 'cashapp', 'venmo', 'paypal', 'square', 'zelle_reggie', 'zelle_manny', 'zelle_hailey'].forEach(b => {
      const c = Math.max(0, Math.round(tallies[b] || 0)) * TALLY_CENTS;
      boxCents[b] = c; machineTotal += c;
      if (b === 'zelle_reggie' || b === 'zelle_manny' || b === 'zelle_hailey') form.zelle.machine_cents += c;
      else form[b].machine_cents += c;
    });
    const machineShare = { reggie: machineTotal / 2, manny: machineTotal / 2, hailey: 0 };

    // ---- entitlements (what each person should walk away with) ----
    const entitlement = {};
    PEOPLE.forEach(p => entitlement[p] = salesNet[p] + machineShare[p] + (p === floatOwner ? cashStart : 0));

    // ---- platform holdings (money already sitting in accounts someone controls) ----
    const holdings = { reggie: 0, manny: 0, hailey: 0 };
    holdings.manny += form.venmo.net_cents + boxCents.venmo;
    holdings.reggie += form.cashapp.net_cents + boxCents.cashapp + form.paypal.net_cents + boxCents.paypal + form.square.net_cents + boxCents.square;
    PEOPLE.forEach(p => holdings[p] += zelleByPerson[p] + boxCents['zelle_' + p]);

    // ---- physical cash pot ----
    const drawerEnd = cashStart + form.cash.net_cents;
    const machineCash = boxCents.cash;
    const pot = drawerEnd + machineCash;

    // ---- who still needs what, after keeping their own platform money ----
    const diff = {}; PEOPLE.forEach(p => diff[p] = entitlement[p] - holdings[p]);

    // conservation: sum(diff) must equal the physical pot
    const sumDiff = PEOPLE.reduce((a, p) => a + diff[p], 0);
    const conserved = (sumDiff === pot);

    // ---- settle: cash first (largest need first), then electronic transfers ----
    const cashOut = { reggie: 0, manny: 0, hailey: 0 };
    let potLeft = pot;
    const owed = PEOPLE.filter(p => diff[p] > 0).sort((a, b) => diff[b] - diff[a]);
    for (const p of owed) { const take = Math.min(diff[p], Math.max(0, potLeft)); cashOut[p] = take; potLeft -= take; }
    // any pot remainder (only when conservation is broken) goes to the float owner so cash never vanishes
    if (potLeft > 0) { cashOut[floatOwner] += potLeft; potLeft = 0; }

    const transfers = [];
    const shortfall = {}; PEOPLE.forEach(p => shortfall[p] = Math.max(0, diff[p] - cashOut[p]));
    const senders = PEOPLE.filter(p => diff[p] < 0).sort((a, b) => diff[a] - diff[b]);
    for (const s of senders) {
      let toSend = -diff[s];
      for (const r of PEOPLE.filter(p => shortfall[p] > 0).sort((a, b) => shortfall[b] - shortfall[a])) {
        if (toSend <= 0) break;
        const amt = Math.min(toSend, shortfall[r]); if (amt <= 0) continue;
        transfers.push({ from: s, to: r, amount_cents: amt, via: SEND_VIA[s] });
        shortfall[r] -= amt; toSend -= amt;
      }
    }

    // ---- verification: everyone ends exactly at entitlement, all cash accounted ----
    const final = {}; PEOPLE.forEach(p => final[p] = holdings[p] + cashOut[p]);
    for (const t of transfers) { final[t.from] -= t.amount_cents; final[t.to] += t.amount_cents; }
    const personsOk = PEOPLE.every(p => final[p] === entitlement[p]);
    const cashOk = (PEOPLE.reduce((a, p) => a + cashOut[p], 0) === pot);
    const noResidual = PEOPLE.every(p => shortfall[p] === 0);
    const verified = conserved && personsOk && cashOk && noResidual;

    const profit = PEOPLE.reduce((a, p) => a + salesNet[p], 0) + machineTotal;

    return {
      version: 1,
      cash_start_cents: cashStart, float_owner: floatOwner,
      forms: form, box_cents: boxCents,
      machine_total_cents: machineTotal, machine_split: machineShare,
      sales_net: salesNet, entitlement, holdings,
      drawer_end_cents: drawerEnd, machine_cash_cents: machineCash, pot_cents: pot,
      cash_out: cashOut, transfers,
      profit_cents: profit,
      entry_count: entries.length,
      verified, checks: { conserved, personsOk, cashOk, noResidual }
    };
  }

  const api = { computeShowReport, PEOPLE, FORMS, TALLY_CENTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HOC_SHOW_MATH = api;
})(typeof window !== 'undefined' ? window : globalThis);
