'use strict';
// Goal scoring path over the live server.
const WebSocket = require('ws');
const wsUrl = 'ws://localhost:8080/';
function client() {
  const ws = new WebSocket(wsUrl);
  const info = { ws, queue: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    info.queue.push(m);
    info.waiters.forEach((w) => w());
    info.waiters = [];
  });
  info.send = (o) => ws.send(JSON.stringify(o));
  info.waitFor = (type, t = 20000) => new Promise((res, rej) => {
    const start = Date.now();
    (function poll() {
      const i = info.queue.findIndex((m) => m.type === type);
      if (i >= 0) return res(info.queue.splice(i, 1)[0]);
      if (info.closed) return rej(new Error('closed'));
      if (Date.now() - start > t) return rej(new Error('timeout'));
      setTimeout(poll, 40);
    })();
  });
  return info;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = client(), B = client();
  await delay(300);
  A.send({ type: 'create', name: 'Ali' });
  const jA = await A.waitFor('joined');
  B.send({ type: 'join', room: jA.room, name: 'Sara' });
  await B.waitFor('joined');
  A.send({ type: 'ready', formation: '2-1-2', flag: 'egypt', ready: true });
  B.send({ type: 'ready', formation: '2-2-1', flag: 'england', ready: true });
  const s0 = await A.waitFor('state');
  console.log('start carrier', s0.state.carrier, s0.state.sticks[s0.state.carrier].id);

  // strategy: A advances by passing to its deepest (attack) stick toward bottom goal.
  // Step A: pass ball forward to the deepest A stick each tick, then shoot.
  let scored = false;
  let passedUp = false;
  for (let t = 0; t < 12 && !scored; t++) {
    const m = await A.waitFor('state');
    A.state = m;
    if (m.phase === 'plan') {
      const carrier = m.state.sticks[m.state.carrier];
      const meA = m.you === 'A';
      const movePlan = { moves: {}, pass: { type: 'keep' } };
      const aSticks = m.state.sticks.filter((s) => s.team === 'A' && s.id !== carrier.id);
      if (meA && carrier.team === 'A') {
        if (!passedUp) {
          // pass to deepest A stick, move others downfield
          const deepest = aSticks.reduce((a, b) => (b.y > a.y ? b : a));
          movePlan.pass = { type: 'teammate', targetId: deepest.id };
          for (const s of aSticks) movePlan.moves[s.id] = { dx: 0, dy: 0.3 };
          passedUp = true;
        } else {
          // carrier should now be deep; shoot
          movePlan.pass = { type: 'shoot' };
          for (const s of aSticks) movePlan.moves[s.id] = { dx: 0, dy: 0.1 };
        }
      } else {
        // A doesn't have ball yet; move A sticks around B
        for (const s of aSticks) movePlan.moves[s.id] = { dx: 0.1 * (t % 2 ? 1 : -1), dy: 0.1 };
      }
      A.send({ type: 'plan', moves: movePlan.moves, pass: movePlan.pass });
      B.send({ type: 'plan', moves: {}, pass: { type: 'keep' } });
      const r1 = await A.waitFor('state');
      if (r1.lastGoal) { scored = true; console.log('GOAL by', r1.lastGoal, 'score', r1.state.score.A + '-' + r1.state.score.B); }
      await delay(100);
    }
  }
  console.log('score check done.', scored ? 'GOAL CONFIRMED' : 'no goal this run');
  A.ws.close(); B.ws.close();
})().catch((e) => { console.error('GOAL TEST FAIL', e); process.exit(1); });