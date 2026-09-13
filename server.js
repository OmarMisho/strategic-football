'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { GameState, FORMATIONS } = require('./lib/game.js');

const PORT = process.env.PORT || 8080;
const TICK_MS = 10000;          // 10 seconds per planning round
const ROUND_TICKS = 10;         // 10 ticks per round = 100 seconds
const GOALS_TO_WIN = 2;

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Static file server ----------
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000), rooms: rooms.size }));
    return;
  }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath;
  if (urlPath.startsWith('/lib/')) {
    // serve shared engine from project root
    filePath = path.join(__dirname, urlPath);
  } else {
    filePath = path.join(PUBLIC_DIR, urlPath);
  }
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR) && !filePath.startsWith(path.join(__dirname, 'lib'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ---------- Room / Player model ----------
const rooms = new Map(); // roomId -> room

function genCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function addPlayerToRoom(room, ws, name) {
  const players = room.players;
  const team = players.length === 0 ? 'A' : (players.length === 1 ? 'B' : null);
  if (team === null) return null;
  const player = {
    id: team + '_' + genCode(3),
    ws, name, team,
    formation: '2-1-2',
    flag: null,
    ready: false,
    plan: null,
  };
  players.push(player);
  room.teamToWs.set(team, ws);
  return player;
}

function makeRoom() {
  const room = {
    id: genCode(),
    players: [],
    teamToWs: new Map(),
    state: null,
    hostWs: null,
    phase: 'lobby',          // lobby -> pick -> play -> goal -> ended
    tick: 0,
    roundNum: 1,
    timerMs: 0,
    timerEnds: 0,
    planCount: 0,
    winner: null,
    lastGoal: null,
    tickTimer: null,
    lastActive: Date.now(),
  };
  // ensure unique room id
  while (rooms.has(room.id)) room.id = genCode();
  rooms.set(room.id, room);
  return room;
}

function cleanupRoom(room) {
  if (room.tickTimer) clearTimeout(room.tickTimer);
  rooms.delete(room.id);
}

// ---------- Message helpers ----------
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Personalized lobby state
function lobbyStateFor(room, forPlayer) {
  const others = room.players.filter((p) => p.id !== forPlayer.id);
  return {
    type: 'joined',
    room: room.id,
    player: { id: forPlayer.id, team: forPlayer.team, name: forPlayer.name },
    players: room.players.map((p) => ({ id: p.id, team: p.team, name: p.name, flag: p.flag, ready: p.ready })),
    phase: room.phase,
    goalsToWin: GOALS_TO_WIN,
    formations: Object.keys(FORMATIONS),
    you: forPlayer.team,
  };
}

// Personalized play state: hides the opponent's planned targets during planning.
function playStateFor(room, forPlayer) {
  const st = room.state;
  const s = st.serialize();
  const oppTeam = forPlayer.team === 'A' ? 'B' : 'A';
  if (room.phase === 'plan' || room.phase === 'pick') {
    // hide opponent's targets (shadows)
    for (const stick of s.sticks) {
      if (stick.team === oppTeam) {
        stick.targetX = stick.x; stick.targetY = stick.y;
        stick.planning = false;
      } else {
        stick.planning = true;
      }
      delete stick.px; delete stick.py;
    }
  } else {
    for (const stick of s.sticks) { stick.planning = false; }
  }
  return {
    type: 'state',
    phase: room.phase,
    tick: room.tick,
    round: room.roundNum,
    timerMs: Math.max(0, room.timerEnds - Date.now()),
    tickTotalMs: TICK_MS,
    state: s,
    you: forPlayer.team,
    carrier: s.carrier,
    lastGoal: room.lastGoal,
    winner: room.winner,
    goalsToWin: GOALS_TO_WIN,
  };
}

function broadcast(room, obj, exceptTeam) {
  for (const p of room.players) {
    if (exceptTeam && p.team === exceptTeam) continue;
    send(p.ws, obj);
  }
}

function broadcastState(room) {
  for (const p of room.players) send(p.ws, playStateFor(room, p));
}

// ---------- Game flow ----------
function startGame(room) {
  const fa = room.players.find((p) => p.team === 'A').formation;
  const fb = room.players.find((p) => p.team === 'B').formation;
  room.state = new GameState(fa, fb);
  room.state.goalsToWin = GOALS_TO_WIN;
  room.tick = 0;
  room.winner = null;
  room.lastGoal = null;
  room.phase = 'plan';
  beginTick(room);
}

function beginTick(room) {
  room.planCount = 0;
  for (const p of room.players) p.plan = null;
  room.phase = 'plan';
  room.timerEnds = Date.now() + TICK_MS;
  broadcastState(room);
  // submit timeout automatically (no move = stay)
  room.tickTimer = setTimeout(() => {
    resolveTick(room, true);
  }, TICK_MS);
}

function resolveTick(room, timedOut) {
  if (room.tickTimer) { clearTimeout(room.tickTimer); room.tickTimer = null; }
  room.phase = 'resolve';
  const st = room.state;
  // apply both players' plans
  for (const p of room.players) {
    st.applyPlan(p.team, (p.plan && p.plan.pass) ? {
      moves: (p.plan && p.plan.moves) || {},
      pass: (p.plan && p.plan.pass) || { type: 'keep' },
    } : { moves: {}, pass: { type: 'keep' } });
  }
  const res = st.resolveTick();
  room.lastGoal = res.goal || null;
  room.tick += 1;
  const winner = st.checkWinner();
  room.winner = winner;
  if (winner) {
    room.phase = 'ended';
    broadcastState(room);
    return;
  }
  if (room.tick >= ROUND_TICKS) {
    // round over (100s) with no winner -> reset ball & positions, continue
    room.tick = 0;
    room.roundNum += 1;
    room.lastGoal = res.goal ? res.goal.team : null;
    room.state = new GameState(room.state.formationA, room.state.formationB);
    room.state.score = Object.assign({}, st.score);
    room.state.goalsToWin = GOALS_TO_WIN;
    beginTick(room);
    return;
  }
  const g = res.goal;
  broadcastState(room);
  // small delay after showing resolution then next planning tick
  room.tickTimer = setTimeout(() => beginTick(room), g ? 1600 : 700);
}

// ---------- WebSocket handling ----------
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    // remove player from any room
    for (const room of rooms.values()) {
      const idx = room.players.findIndex((p) => p.ws === ws);
      if (idx >= 0) {
        const removed = room.players.splice(idx, 1)[0];
        room.teamToWs.delete(removed.team);
        if (removePlayerFromRoom(room, removed)) return; // room removed
        // notify remaining
        for (const p of room.players) send(p.ws, lobbyStateFor(room, p));
      }
    }
  });
});

function removePlayerFromRoom(room, removed) {
  if (room.players.length === 0) { cleanupRoom(room); return true; }
  if (room.tickTimer) clearTimeout(room.tickTimer);
  room.phase = 'lobby';
  return false;
}

function handleMessage(ws, msg) {
  const room = [...rooms.values()].find((r) => r.players.some((p) => p.ws === ws));
  if (room) room.lastActive = Date.now();
  switch (msg.type) {
    case 'create': {
      const r = makeRoom();
      const p = addPlayerToRoom(r, ws, msg.name || 'Host');
      r.hostWs = ws;
      send(ws, lobbyStateFor(r, p));
      break;
    }
    case 'join': {
      const target = rooms.get((msg.room || '').toUpperCase());
      if (!target) { send(ws, { type: 'error', error: 'Room not found' }); return; }
      if (target.players.length >= 2) { send(ws, { type: 'error', error: 'Room is full' }); return; }
      const p = addPlayerToRoom(target, ws, msg.name || 'Guest');
      if (!p) { send(ws, { type: 'error', error: 'Room is full' }); return; }
      // notify host and new
      for (const pl of target.players) send(pl.ws, lobbyStateFor(target, pl));
      break;
    }
    case 'ready': {
      if (!room) return;
      const p = room.players.find((pp) => pp.ws === ws);
      if (!p) return;
      if (msg.formation && FORMATIONS[msg.formation]) p.formation = msg.formation;
      if (msg.flag) p.flag = msg.flag;
      p.ready = !!msg.ready;
      const allReady = room.players.length === 2 && room.players.every((pp) => pp.ready);
      if (allReady && room.phase === 'lobby') {
        room.phase = 'pick';
        // both set; start via a short countdown
        room.phase = 'play';
        startGame(room);
        // broadcast start occurs in beginTick
      } else {
        for (const pl of room.players) send(pl.ws, lobbyStateFor(room, pl));
      }
      break;
    }
    case 'plan': {
      if (!room) return;
      const p = room.players.find((pp) => pp.ws === ws);
      if (!p || room.phase !== 'plan') return;
      if (p.plan) return; // already submitted
      // validate moves numeric
      const moves = {};
      if (msg.moves) {
        for (const [id, m] of Object.entries(msg.moves)) {
          moves[id] = { dx: Number(m.dx) || 0, dy: Number(m.dy) || 0 };
        }
      }
      let pass = { type: 'keep' };
      if (msg.pass && msg.pass.type === 'shoot') pass = { type: 'shoot' };
      else if (msg.pass && msg.pass.type === 'teammate') pass = { type: 'teammate', targetId: msg.pass.targetId };
      p.plan = { moves, pass };
      room.planCount++;
      // if both submitted, resolve now
      if (room.planCount >= room.players.length) {
        resolveTick(room, false);
      } else {
        // echo ack to submitting player with their submitted plan
        send(ws, { type: 'plan_ack', moves: p.plan.moves, pass: p.plan.pass });
      }
      break;
    }
    default:
      break;
  }
}

// heartbeat
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// sweep: drop rooms left abandoned (no live client in a lobby for 30 min, or fully empty for 10 min)
const ROOM_LOBBY_MAX_AGE_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const hasLive = room.players.some((p) => p.ws && p.ws.readyState === WebSocket.OPEN);
    const idleFor = now - room.lastActive;
    if ((!hasLive && idleFor > 10 * 60 * 1000) ||
        (hasLive && room.phase === 'lobby' && idleFor > ROOM_LOBBY_MAX_AGE_MS)) {
      cleanupRoom(room);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Strategic Football server running on http://localhost:${PORT}`);
  console.log(`Open on two phones using your LAN IP: http://<your-ip>:${PORT}`);
});
