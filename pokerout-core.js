/* PokerOut core — money maths, settlement engine, and the shared game store.
   Pure calculation functions are side-effect free; the store is the only layer
   that touches persistence, so it can be swapped for a real-time backend
   (Firestore / Supabase) without touching the UI or the maths. */
(function (global) {
  'use strict';

  // ---------- currency ----------
  const CURRENCIES = { INR: { code: 'INR', symbol: '₹', locale: 'en-IN' } };
  let activeCurrency = 'INR';
  function setCurrency(code) { if (CURRENCIES[code]) activeCurrency = code; }

  function formatMoney(n, opts) {
    const cur = CURRENCIES[activeCurrency];
    const v = Math.round(Number(n) || 0);
    const abs = Math.abs(v).toLocaleString(cur.locale);
    if (v < 0) return '−' + cur.symbol + abs;
    if (opts && opts.signed && v > 0) return '+' + cur.symbol + abs;
    return cur.symbol + abs;
  }

  function parseAmount(raw, opts) {
    const allowZero = !opts || opts.allowZero !== false;
    const step = opts && opts.step;
    const s = String(raw == null ? '' : raw).replace(/[₹,\s]/g, '');
    if (s === '') return { ok: false, error: 'Enter an amount.' };
    if (/^-/.test(s)) return { ok: false, error: "Amounts can't be negative." };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Whole rupees only — digits, no decimals.' };
    const n = parseInt(s, 10);
    if (!allowZero && n === 0) return { ok: false, error: 'Amount must be more than ' + formatMoney(0) + '.' };
    if (n > 100000000) return { ok: false, error: 'That amount looks too large.' };
    if (step && n % step !== 0) return { ok: false, error: 'Please enter an amount in multiples of ' + formatMoney(step) + '.' };
    return { ok: true, value: n };
  }

  function cleanName(raw) { return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 20); }

  // ---------- pure selectors ----------
  const approvedPlayers = g => g.players.filter(p => p.approved === 'approved');
  const txFor = (g, pid) => g.transactions.filter(t => t.playerId === pid);
  const MONEY_STEP = 100; // V1: buy-ins and rebuys move in ₹100 steps; final stacks are exact
  const hasBuyIn = (g, pid) => g.transactions.some(t => t.playerId === pid && t.type === 'buy-in' && t.status === 'approved');
  // Seated = approved AND initial buy-in recorded. Only seated players count toward stacks & settlement.
  const seatedPlayers = g => approvedPlayers(g).filter(p => hasBuyIn(g, p.playerId));
  const isLive = g => g.status === 'lobby' || g.status === 'playing';

  function investedFor(g, pid) {
    // Total Invested = initial buy-in + sum of approved rebuys (only approved money counts)
    return txFor(g, pid).filter(t => t.status === 'approved').reduce((s, t) => s + t.amount, 0);
  }

  function playerSummary(g, pid) {
    const approved = txFor(g, pid).filter(t => t.status === 'approved');
    const invested = approved.reduce((s, t) => s + t.amount, 0);
    const fs = g.finalStacks[pid];
    const stack = fs && fs.submitted ? fs.amount : null;
    return {
      invested,
      buyIns: approved.filter(t => t.type === 'buy-in').length,
      rebuys: approved.filter(t => t.type === 'rebuy').length,
      stack,
      net: stack == null ? null : stack - invested, // Net P/L = Final Stack − Total Invested
    };
  }

  function totals(g) {
    const approvedTx = g.transactions.filter(t => t.status === 'approved');
    return {
      moneyIn: approvedTx.reduce((s, t) => s + t.amount, 0),
      approvedRebuys: approvedTx.filter(t => t.type === 'rebuy').length,
      playerCount: seatedPlayers(g).length,
      approvedCount: approvedPlayers(g).length,
      pendingPlayers: g.players.filter(p => p.approved === 'pending'),
      pendingRebuys: g.transactions.filter(t => t.status === 'pending'),
    };
  }

  function balanceCheck(g) {
    const ps = seatedPlayers(g);
    const moneyIn = totals(g).moneyIn;
    let stacksTotal = 0, submitted = 0;
    ps.forEach(p => { const fs = g.finalStacks[p.playerId]; if (fs && fs.submitted) { stacksTotal += fs.amount; submitted++; } });
    const allSubmitted = ps.length > 0 && submitted === ps.length;
    const diff = stacksTotal - moneyIn;
    return { moneyIn, stacksTotal, diff, submitted, expected: ps.length, allSubmitted, balanced: allSubmitted && diff === 0 };
  }

  function netBalances(g) {
    return seatedPlayers(g).map(p => { const s = playerSummary(g, p.playerId); return { playerId: p.playerId, invested: s.invested, stack: s.stack, net: s.net }; });
  }

  // Leaderboard: presentation of the same Net P/L the settlement uses. Sorted by Net P/L (never stack),
  // standard competition ranking for ties (1,1,3), ties listed alphabetically so order is deterministic.
  function leaderboard(g) {
    const nameOf = pid => (g.players.find(p => p.playerId === pid) || {}).username || '';
    const rows = netBalances(g).filter(b => b.net != null).map(b => ({ ...b, username: nameOf(b.playerId) }))
      .sort((a, b) => b.net - a.net || a.username.localeCompare(b.username));
    let rank = 0;
    return rows.map((r, i) => { if (i === 0 || r.net !== rows[i - 1].net) rank = i + 1; return { ...r, rank }; });
  }

  // Minimum-practical settlement. Works on net balances, so chains (A→B→C) collapse automatically.
  // 1) settle exact debtor/creditor matches in one payment each; 2) greedy largest-to-largest.
  // Produces at most (non-zero players − 1) payments; all integers.
  function computeSettlements(balances) {
    const sum = balances.reduce((s, b) => s + b.net, 0);
    if (sum !== 0) throw new Error('Balances must sum to zero (got ' + sum + ')');
    const byAmt = (a, b) => b.amt - a.amt || (a.id < b.id ? -1 : 1);
    const debtors = balances.filter(b => b.net < 0).map(b => ({ id: b.playerId, amt: -b.net })).sort(byAmt);
    const creditors = balances.filter(b => b.net > 0).map(b => ({ id: b.playerId, amt: b.net })).sort(byAmt);
    const out = [];
    const pay = (d, c, amt) => { out.push({ fromPlayer: d.id, toPlayer: c.id, amount: amt }); d.amt -= amt; c.amt -= amt; };
    debtors.forEach(d => { const c = creditors.find(c => c.amt > 0 && c.amt === d.amt); if (c) pay(d, c, d.amt); });
    for (;;) {
      const d = debtors.filter(x => x.amt > 0).sort(byAmt)[0];
      const c = creditors.filter(x => x.amt > 0).sort(byAmt)[0];
      if (!d || !c) break;
      pay(d, c, Math.min(d.amt, c.amt));
    }
    return out;
  }

  // ---------- store ----------
  const KEY = 'pokerout:v1:games';
  const SESSION_KEY = 'pokerout:v1:session:';
  const listeners = new Set();
  let bc = null;
  try { bc = 'BroadcastChannel' in global ? new BroadcastChannel('pokerout') : null; } catch (e) {}
  const emit = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  if (bc) bc.onmessage = emit;
  try { global.addEventListener('storage', e => { if (e.key === KEY) emit(); }); } catch (e) {}

  function loadAll() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function saveAll(all) { localStorage.setItem(KEY, JSON.stringify(all)); }
  function broadcast() { if (bc) bc.postMessage(1); emit(); }
  function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }
  function getGame(code) {
    const g = loadAll()[code] || null;
    if (g && g.status === 'open') g.status = 'playing'; // games saved by the earlier build
    return g;
  }

  const uid = p => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const fail = error => ({ ok: false, error });
  const MISSING = "That game doesn't exist. Check the code and try again.";

  // Read-modify-write against the latest stored copy, so concurrent tabs never clobber each other.
  function mutate(code, fn) {
    const all = loadAll();
    const g = all[code];
    if (!g) return fail(MISSING);
    if (g.status === 'open') g.status = 'playing';
    const draft = JSON.parse(JSON.stringify(g));
    const r = fn(draft);
    if (r && r.error) return fail(r.error);
    draft.version = (draft.version || 0) + 1;
    draft.updatedAt = Date.now();
    all[code] = draft;
    try { saveAll(all); } catch (e) { return fail("Couldn't save — your change wasn't applied. Try again."); }
    broadcast();
    return { ok: true, game: draft, result: r };
  }

  const isHost = (g, actor) => g.hostId === actor;
  const hostOnly = (g, actor) => (isHost(g, actor) ? null : { error: 'Only the host can do that.' });
  const findPlayer = (g, pid) => g.players.find(p => p.playerId === pid);
  const makeTx = (playerId, type, amount, status, approvedBy) => ({
    transactionId: uid('t'), playerId, type, amount, status, approvedBy: approvedBy || null, requestedAt: Date.now(), timestamp: Date.now(),
  });

  function newCode(all) { let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (all[c]); return c; }

  function createGame({ gameName, username, buyIn, rebuy }) {
    const all = loadAll();
    const code = newCode(all), now = Date.now(), hostId = uid('p'), gameId = uid('g');
    const game = {
      gameId, gameCode: code, gameName, hostId, status: 'lobby', currency: activeCurrency,
      defaultBuyIn: buyIn, defaultRebuy: rebuy, createdAt: now, endedAt: null, settledAt: null, version: 1,
      players: [{ playerId: hostId, username, gameId, approved: 'approved', role: 'host', joinedAt: now }],
      transactions: [makeTx(hostId, 'buy-in', buyIn, 'approved', hostId)],
      finalStacks: {}, settlements: [],
    };
    all[code] = game;
    try { saveAll(all); } catch (e) { return fail("Couldn't create the game. Try again."); }
    broadcast();
    return { ok: true, game, playerId: hostId };
  }

  function createSampleGame() {
    const r = createGame({ gameName: 'Friday Poker', username: 'Thene', buyIn: 500, rebuy: 500 });
    const code = r.game.gameCode;
    mutate(code, g => {
      const add = (name, status, txs) => {
        const pid = uid('p');
        g.players.push({ playerId: pid, username: name, gameId: g.gameId, approved: status, role: 'player', joinedAt: Date.now() });
        (txs || []).forEach(([type, amt, st]) => g.transactions.push(makeTx(pid, type, amt, st, st === 'approved' ? g.hostId : null)));
      };
      add('Rahul', 'approved', [['buy-in', 500, 'approved']]);
      add('Aditya', 'approved', [['buy-in', 1000, 'approved']]);
      add('Karan', 'approved', [['buy-in', 500, 'pending']]);
      add('Priya', 'pending');
      add('Dev', 'pending');
    });
    return { ok: true, game: getGame(code), playerId: r.playerId };
  }

  function joinGame(rawCode, rawName) {
    const code = String(rawCode || '').replace(/\D/g, '');
    if (code.length !== 4) return fail('Game codes are 4 digits.');
    const name = cleanName(rawName);
    if (!name) return fail('Pick a username so the host knows who you are.');
    let pid;
    const r = mutate(code, g => {
      if (g.status === 'ended') return { error: "This game has ended — new players can't join." };
      if (!isLive(g)) return { error: "This game isn't taking players." };
      if (g.status === 'settled') return { error: 'This game is already settled.' };
      const clash = g.players.find(p => p.approved !== 'rejected' && p.username.toLowerCase() === name.toLowerCase());
      if (clash) return { error: '“' + name + '” is already taken in this game. Try another name.' };
      pid = uid('p');
      g.players.push({ playerId: pid, username: name, gameId: g.gameId, approved: 'pending', role: 'player', joinedAt: Date.now() });
    });
    return r.ok ? { ok: true, game: r.game, playerId: pid } : r;
  }

  function withdrawJoin(code, pid) {
    return mutate(code, g => { g.players = g.players.filter(p => !(p.playerId === pid && p.approved === 'pending')); });
  }

  function decidePlayer(code, actor, pid, approve) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      const p = findPlayer(g, pid);
      if (!p) return { error: 'That player left before you decided.' };
      if (p.approved !== 'pending') return { error: p.username + ' was already ' + p.approved + '.' };
      if (approve && !isLive(g)) return { error: 'The session has ended — no new players.' };
      p.approved = approve ? 'approved' : 'rejected';
      p.decidedAt = Date.now();
    });
  }

  function requestBuyIn(code, pid, amount) {
    return mutate(code, g => {
      if (!isLive(g)) return { error: 'Buy-ins are closed — the session has ended.' };
      const p = findPlayer(g, pid);
      if (!p || p.approved !== 'approved') return { error: 'The host needs to approve you first.' };
      if (hasBuyIn(g, pid)) return { error: 'Your buy-in is already recorded.' };
      if (g.transactions.some(t => t.playerId === pid && t.status === 'pending')) return { error: 'Your buy-in is waiting for host approval.' };
      g.transactions.push(makeTx(pid, 'buy-in', amount, 'pending', null));
    });
  }

  function startGame(code, actor) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status !== 'lobby') return { error: 'The game has already started.' };
      const waiting = approvedPlayers(g).filter(p => !hasBuyIn(g, p.playerId));
      if (waiting.length) return { error: 'Waiting for ' + waiting.map(p => p.username).join(', ') + ' to buy in.' };
      if (seatedPlayers(g).length < 2) return { error: 'You need at least 2 players to start.' };
      g.status = 'playing'; g.startedAt = Date.now();
    });
  }

  function removePlayer(code, actor, pid) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (!isLive(g)) return { error: "Players can't be removed after the session ends." };
      if (pid === g.hostId) return { error: "The host can't be removed." };
      const p = findPlayer(g, pid);
      if (!p) return { error: 'Player not found.' };
      if (hasBuyIn(g, pid)) return { error: 'This player has money in the game — correct their amounts instead.' };
      g.transactions.forEach(t => { if (t.playerId === pid && t.status === 'pending') { t.status = 'rejected'; t.note = 'Removed by host'; } });
      p.approved = 'rejected'; p.removed = true; p.decidedAt = Date.now();
    });
  }

  function requestRebuy(code, pid, amount) {
    return mutate(code, g => {
      if (g.status === 'lobby') return { error: 'Rebuys open once the host starts the game.' };
      if (g.status !== 'playing') return { error: 'Buy-ins are closed — the session has ended.' };
      const p = findPlayer(g, pid);
      if (!p || p.approved !== 'approved') return { error: "You're not an active player in this game." };
      if (!hasBuyIn(g, pid)) return { error: 'Make your initial buy-in first.' };
      if (g.transactions.some(t => t.playerId === pid && t.status === 'pending')) return { error: 'You already have a rebuy waiting for host approval.' };
      g.transactions.push(makeTx(pid, 'rebuy', amount, 'pending', null));
    });
  }

  function cancelRebuy(code, pid, txId) {
    return mutate(code, g => {
      const t = g.transactions.find(t => t.transactionId === txId);
      if (!t || t.playerId !== pid) return { error: 'Rebuy not found.' };
      if (t.status !== 'pending') return { error: 'The host already handled this rebuy.' };
      t.status = 'cancelled'; t.timestamp = Date.now();
    });
  }

  function decideTx(code, actor, txId, approve) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      const t = g.transactions.find(t => t.transactionId === txId);
      if (!t) return { error: 'Rebuy not found.' };
      if (t.status !== 'pending') return { error: 'This rebuy was already ' + t.status + '.' };
      if (!isLive(g)) return { error: "The session has ended — this can't be approved." };
      if (approve && t.type === 'rebuy' && g.status !== 'playing') return { error: 'Rebuys open once the game starts.' };
      t.status = approve ? 'approved' : 'rejected';
      t.approvedBy = approve ? actor : null;
      t.timestamp = Date.now();
    });
  }

  function addRebuy(code, actor, pid, amount) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status !== 'playing') return { error: 'Rebuys are only open while the game is running.' };
      const p = findPlayer(g, pid);
      if (!p || p.approved !== 'approved' || !hasBuyIn(g, pid)) return { error: 'That player has no buy-in yet.' };
      g.transactions.push(makeTx(pid, 'rebuy', amount, 'approved', actor));
    });
  }

  function editTx(code, actor, txId, amount) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status === 'settled') return { error: 'This game is settled — amounts are locked.' };
      const t = g.transactions.find(t => t.transactionId === txId);
      if (!t || t.status !== 'approved') return { error: 'Only approved amounts can be corrected.' };
      t.amount = amount; t.edited = true; t.editedAt = Date.now();
    });
  }

  function voidTx(code, actor, txId) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status === 'settled') return { error: 'This game is settled — amounts are locked.' };
      const t = g.transactions.find(t => t.transactionId === txId);
      if (!t || t.status !== 'approved' || t.type !== 'rebuy') return { error: 'Only approved rebuys can be removed.' };
      t.status = 'rejected'; t.note = 'Removed by host'; t.timestamp = Date.now();
    });
  }

  function endSession(code, actor) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status === 'lobby') return { error: 'Start the game before ending it.' };
      if (g.status !== 'playing') return { error: 'The session has already ended.' };
      g.transactions.forEach(t => { if (t.status === 'pending') { t.status = 'rejected'; t.note = 'Session ended'; t.timestamp = Date.now(); } });
      g.players.forEach(p => { if (p.approved === 'pending') { p.approved = 'rejected'; p.decidedAt = Date.now(); } });
      g.status = 'ended'; g.endedAt = Date.now();
    });
  }

  function reopenSession(code, actor) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status !== 'ended') return { error: 'Only an ended session can be reopened.' };
      g.status = 'playing'; g.endedAt = null;
    });
  }

  function submitStack(code, actor, pid, amount) {
    return mutate(code, g => {
      if (actor !== pid && !isHost(g, actor)) return { error: "You can only enter your own final stack." };
      if (isLive(g)) return { error: 'Final stacks open once the host ends the session.' };
      if (g.status === 'settled') return { error: 'This game is settled — stacks are locked.' };
      const p = findPlayer(g, pid);
      if (!p || p.approved !== 'approved' || !hasBuyIn(g, pid)) return { error: 'That player never bought in.' };
      g.finalStacks[pid] = { playerId: pid, amount, submitted: true, submittedAt: Date.now(), enteredBy: actor };
    });
  }

  function finalize(code, actor) {
    return mutate(code, g => {
      const e = hostOnly(g, actor); if (e) return e;
      if (g.status !== 'ended') return { error: 'End the session before settling.' };
      const b = balanceCheck(g);
      if (!b.allSubmitted) return { error: 'Waiting for ' + (b.expected - b.submitted) + ' more final stack' + (b.expected - b.submitted === 1 ? '' : 's') + '.' };
      if (b.diff !== 0) return { error: "Numbers don't match — settlement is locked until they do." };
      g.settlements = computeSettlements(netBalances(g)).map(s => ({ settlementId: uid('s'), ...s, paid: false, paidAt: null }));
      g.status = 'settled'; g.settledAt = Date.now();
    });
  }

  function setPaid(code, actor, sid, paid) {
    return mutate(code, g => {
      const s = g.settlements.find(s => s.settlementId === sid);
      if (!s) return { error: 'Payment not found.' };
      if (!isHost(g, actor) && actor !== s.fromPlayer) return { error: 'Only the payer or the host can mark this.' };
      s.paid = !!paid; s.paidAt = paid ? Date.now() : null; s.markedBy = actor;
    });
  }

  // ---------- per-device session (survives refresh / app close) ----------
  function getSession(dev) { try { return JSON.parse(localStorage.getItem(SESSION_KEY + dev)) || null; } catch (e) { return null; } }
  function setSession(dev, s) { try { localStorage.setItem(SESSION_KEY + dev, JSON.stringify(s)); } catch (e) {} }
  function clearSession(dev) { try { localStorage.removeItem(SESSION_KEY + dev); } catch (e) {} }

  function peekGameLocal(rawCode) {
    const g = getGame(String(rawCode || '').replace(/\D/g, ''));
    if (!g) return { ok: false, error: MISSING };
    return { ok: true, gameName: g.gameName, status: g.status, hostName: (findPlayer(g, g.hostId) || {}).username };
  }

  // =====================================================================
  // Remote mode — Supabase. Activated when /config.json provides
  // { supabaseUrl, supabaseAnonKey }. The database is the source of truth;
  // every write goes through a security-definer RPC that checks the
  // caller's per-player secret, so permissions are enforced server-side.
  // =====================================================================
  const LOCAL = {
    getGame, createGame, createSampleGame, joinGame, peekGame: peekGameLocal, withdrawJoin, decidePlayer, requestBuyIn, startGame,
    removePlayer, requestRebuy, cancelRebuy, decideTx, addRebuy, editTx, voidTx, endSession, reopenSession, submitStack, finalize, setPaid,
  };
  let mode = 'local', sb = null;
  const cache = {};   // code -> state | null (not found) ; undefined = not loaded yet
  const creds = {};   // `${code}:${playerId}` -> { gameId, secret }
  const watched = {}; // code -> { gameId, playerId, secret, channel, timer }
  const NET = "Couldn't reach PokerOut — check your connection. Nothing was changed.";
  const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  function friendly(err) {
    const m = (err && (err.message || err.details)) || '';
    if (/fetch|network|timeout|Load failed/i.test(m)) return NET;
    return m || 'Something went wrong — nothing was changed.';
  }
  async function rpc(fn, args) {
    if (!sb) return fail(NET);
    try {
      const { data, error } = await sb.rpc(fn, args || {});
      if (error) return fail(friendly(error));
      return { ok: true, data };
    } catch (e) { return fail(NET); }
  }
  function applyState(code, state) {
    const prev = cache[code];
    if (prev && state && (state.version || 0) < (prev.version || 0)) return; // ignore stale responses
    cache[code] = state; emit();
  }
  function ping(code) {
    const w = watched[code];
    if (w && w.channel) { try { w.channel.send({ type: 'broadcast', event: 'changed', payload: { at: Date.now() } }); } catch (e) {} }
  }
  async function refresh(code) {
    const w = watched[code]; if (!w) return;
    const r = await rpc('get_game', { p_game: w.gameId, p_player: w.playerId, p_secret: w.secret });
    if (r.ok) applyState(code, r.data || null);
    else if (r.error !== NET) applyState(code, null); // invalid / expired → "game no longer exists"
  }
  function watch(code, gameId, playerId, secret) {
    if (!code || !gameId || !secret) return;
    creds[code + ':' + playerId] = { gameId, secret };
    if (watched[code] && watched[code].playerId === playerId) return;
    forget(code);
    const w = (watched[code] = { gameId, playerId, secret, channel: null, timer: null });
    if (sb) {
      w.channel = sb.channel('pokerout:' + gameId, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'changed' }, () => refresh(code))
        .subscribe(status => { if (status === 'SUBSCRIBED') refresh(code); });
    }
    // Fallback poll — cheap, and covers dropped sockets on flaky mobile networks
    w.timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') refresh(code); }, 5000);
    refresh(code);
  }
  function forget(code) {
    const w = watched[code]; if (!w) return;
    clearInterval(w.timer);
    if (w.channel && sb) { try { sb.removeChannel(w.channel); } catch (e) {} }
    delete watched[code];
  }
  try {
    global.addEventListener('online', () => Object.keys(watched).forEach(refresh));
    global.document && global.document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Object.keys(watched).forEach(refresh); });
  } catch (e) {}

  const act = (fnName, build) => async (code, actor, ...rest) => {
    const c = creds[code + ':' + actor];
    if (!c) return fail('This device lost its seat — rejoin with the game code.');
    const r = await rpc(fnName, Object.assign({ p_game: c.gameId, p_player: actor, p_secret: c.secret }, build ? build(...rest) : {}));
    if (!r.ok) { refresh(code); return r; }
    applyState(code, r.data); ping(code);
    return { ok: true, game: r.data };
  };
  const seat = (res) => {
    const { state, playerId, secret } = res.data || {};
    if (!state) return fail('Something went wrong — nothing was changed.');
    cache[state.gameCode] = state;
    watch(state.gameCode, state.gameId, playerId, secret);
    emit();
    return { ok: true, game: state, playerId, secret, gameId: state.gameId };
  };

  const REMOTE = {
    getGame: code => cache[code],
    createGame: async ({ gameName, username, buyIn, rebuy }) => {
      const r = await rpc('create_game', { p_name: gameName, p_username: username, p_buy_in: buyIn, p_rebuy: rebuy });
      return r.ok ? seat(r) : r;
    },
    createSampleGame: async () => fail('Sample tables are only available in preview.'),
    joinGame: async (rawCode, rawName) => {
      const code = String(rawCode || '').replace(/\D/g, '');
      if (code.length !== 4) return fail('Game codes are 4 digits.');
      const name = cleanName(rawName);
      if (!name) return fail('Pick a username so the host knows who you are.');
      const r = await rpc('join_game', { p_code: code, p_username: name });
      return r.ok ? seat(r) : r;
    },
    peekGame: async rawCode => {
      const r = await rpc('peek_game', { p_code: String(rawCode || '').replace(/\D/g, '') });
      if (!r.ok) return r;
      return r.data ? Object.assign({ ok: true }, r.data) : fail(MISSING);
    },
    withdrawJoin: act('withdraw_join'),
    decidePlayer: act('decide_player', (target, approve) => ({ p_target: target, p_approve: !!approve })),
    requestBuyIn: act('request_buy_in', amount => ({ p_amount: amount })),
    startGame: act('start_game'),
    removePlayer: act('remove_player', target => ({ p_target: target })),
    requestRebuy: act('request_rebuy', amount => ({ p_amount: amount })),
    cancelRebuy: act('cancel_request', txId => ({ p_tx: txId })),
    decideTx: act('decide_tx', (txId, approve) => ({ p_tx: txId, p_approve: !!approve })),
    addRebuy: act('add_rebuy', (target, amount) => ({ p_target: target, p_amount: amount })),
    editTx: act('edit_tx', (txId, amount) => ({ p_tx: txId, p_amount: amount })),
    voidTx: act('void_tx', txId => ({ p_tx: txId })),
    endSession: act('end_session'),
    reopenSession: act('reopen_session'),
    submitStack: act('submit_stack', (target, amount) => ({ p_target: target, p_amount: amount })),
    // Settlement is computed with the same engine as preview; the server re-derives every
    // player's net and rejects the payments unless they reproduce those balances exactly.
    finalize: async (code, actor) => {
      const g = cache[code];
      if (!g) return fail(MISSING);
      const b = balanceCheck(g);
      if (!b.allSubmitted || b.diff !== 0) return fail("Numbers don't match — settlement is locked until they do.");
      const payments = computeSettlements(netBalances(g)).map(s => ({ from: s.fromPlayer, to: s.toPlayer, amount: s.amount }));
      return act('finalize_game', () => ({ p_payments: payments }))(code, actor);
    },
    setPaid: act('set_paid', (sid, paid) => ({ p_settlement: sid, p_paid: !!paid })),
  };

  const ready = (async () => {
    let cfg = global.POKEROUT_CONFIG || null;
    if (!cfg && typeof fetch === 'function') {
      try { const r = await fetch('config.json', { cache: 'no-store' }); if (r.ok) cfg = await r.json(); } catch (e) {}
    }
    if (cfg && cfg.supabaseUrl && cfg.supabaseAnonKey) {
      mode = 'remote';
      try {
        const mod = await import(SUPABASE_ESM);
        sb = mod.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      } catch (e) { console.error('PokerOut: backend client failed to load', e); }
    }
    if (mode === 'remote' && 'serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    return mode;
  })();

  const impl = () => (mode === 'remote' ? REMOTE : LOCAL);
  const api = {};
  Object.keys(LOCAL).forEach(k => { api[k] = (...a) => impl()[k](...a); });

  global.PO = Object.assign(api, {
    CURRENCIES, setCurrency, formatMoney, parseAmount, cleanName, MONEY_STEP,
    hasBuyIn, seatedPlayers, investedFor, playerSummary, totals, balanceCheck, netBalances, leaderboard, computeSettlements,
    subscribe, getSession, setSession, clearSession, ready,
    get mode() { return mode; },
    // Resume a saved seat after refresh / reopen (remote: starts live sync; local: no-op)
    resume(session) { if (mode === 'remote' && session) watch(session.gameCode, session.gameId, session.playerId, session.secret); },
    forget(code) { if (mode === 'remote') { forget(code); delete cache[code]; } },
    joinUrl(code) { try { return mode === 'remote' ? location.origin + '/join/' + code : location.origin + location.pathname + '?join=' + code; } catch (e) { return '/join/' + code; } },
    homeUrl() { try { return mode === 'remote' ? location.origin + '/' : location.origin + location.pathname; } catch (e) { return '/'; } },
  });
})(typeof window !== 'undefined' ? window : globalThis);
