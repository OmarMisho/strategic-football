'use strict';
// Two-client integration test for the Strategic Football server.
const WebSocket = require('ws');
const wsUrl = 'ws://localhost:8080/';

function client() {
  const ws = new WebSocket(wsUrl);
  const info = { ws, id: null, team: null, queue: [], waiters: [] };
  ws.on('open', () => info.open = true);
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    info.queue.push(msg);
    info.waiters.forEach((w) => w());
    info.waiters = [];
  });
  info.send = (o) => ws.send(JSON.stringify(o));
  info.next = () => new Promise((res) => {
    if (info.queue.length) res(info.queue.shift());
    else info.waiters.push(() => res(info.queue.shift()));
  });
  info.waitFor = (type, t = 15000) => new Promise((res, rej) => {
    const start = Date.now();
    (function poll() {
      const i = info.queue.findIndex((m) => m.type === type);
      if (i >= 0) { const m = info.queue.splice(i, 1)[0]; return res(m); }
      if (info.closed) return rej(new Error('socket closed waiting ' + type));
      if (Date.now() - start > t) return rej(new Error('timeout waiting ' + type));
      setTimeout(poll, 40);
    })();
  });
  return info;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = client();
  const B = client();

  await delay(300);

  // A creates a room
  A.send({ type: 'create', name: 'Ali' });
  const jA = await A.waitFor('joined');
  console.log('A joined', jA.room, jA.you, 'players:', jA.players.length);

  // B joins
  B.send({ type: 'join', room: jA.room, name: 'Sara' });
  const jB = await B.waitFor('joined');
  console.log('B joined', jB.room, jB.you, 'players:', jB.players.length);

  // both ready with formations and flags
  A.send({ type: 'ready', formation: '2-1-2', flag: 'egypt', ready: true });
  B.send({ type: 'ready', formation: '2-2-1', flag: 'england', ready: true });

  // both should get 'state' with phase plan
  const sA = await A.waitFor('state');
  const sB = await B.waitFor('state');
  console.log('Game started. phase:', sA.phase, 'tick:', sA.tick, 'A sticks:', sA.state.sticks.filter(s=>s.team==='A').length, 'B sticks:', sA.state.sticks.filter(s=>s.team==='B').length);
  console.log('carrier id:', sA.carrier, 'you A?', sA.you === 'A' ? 'yes' : 'NO');
  // verify B state hides A targets during plan
  const aStickFromB = sB.state.sticks.find(s=>s.team==='A' && s.targetX !== undefined);
  console.log('B sees A target hidden (planning flag):', sB.state.sticks.filter(s=>s.team==='A').every(s=>!s.planning));

  // A: plan moves; have A carrier pass to a teammate
  const carrierId = sA.state.sticks[sA.state.carrier].id;
  const mate = sA.state.sticks.find((s)=>s.team==='A' && s.id!==carrierId);
  const movesA = {};
  // move A's non-carrier sticks slightly
  const aIdx = sA.state.sticks.filter((s)=>s.team==='A' && s.id!==carrierId);
  aIdx.forEach((s)=> movesA[s.id] = { dx: 0.1, dy: 0.05 });
  A.send({ type: 'plan', moves: movesA, pass: { type: 'teammate', targetId: mate.id } });

  // B: plan random moves, no pass
  const movesB = {};
  sB.state.sticks.filter((s)=>s.team==='B').forEach((s)=> movesB[s.id] = { dx: -0.08, dy: 0.03 });
  B.send({ type: 'plan', moves: movesB, pass: { type: 'keep' } });

  // both submitted -> resolution broadcasts (phase resolve then plan)
  const r1 = await A.waitFor('state');
  console.log('after both plans, A sees phase:', r1.phase, 'tick:', r1.tick);
  console.log('A carrier after tick', r1.carrier, r1.state.carrier);

  // wait for next planning tick
  const r2 = await A.waitFor('state');
  console.log('next phase:', r2.phase, 'tick:', r2.tick);
  const r3 = await A.waitFor('state');
  console.log('3rd phase:', r3.phase, 'tick:', r3.tick);

  // now check a shoot scenario: stop game by closing
  console.log('Score A/B:', JSON.stringify(r2.state.score), r3.state.score);

  A.ws.close(); B.ws.close();
  console.log('TEST OK');
})().catch((e) => { console.error('TEST FAIL', e); process.exit(1); });