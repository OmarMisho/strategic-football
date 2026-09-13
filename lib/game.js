'use strict';

// Shared strategic football rule engine.
// Field is normalized to a 0..1 space (x=0..1, y=0..1), portrait orientation.
// y=0 is the TOP of the field, y=1 is the BOTTOM.
// Team 'A' defends the top goal and attacks the bottom goal (attacks downward).
// Team 'B' defends the bottom goal and attacks the top goal (attacks upward).

const FIELD = {
  width: 1.0,
  height: 1.0,
  // goal info (normalized, relative to a goal mouth on a horizontal edge)
  goalHalfWidth: 0.12,   // mouth width from center line
};

const FORMATIONS = {
  '2-1-2': { def: 2, mid: 1, att: 2 },
  '3-1-1': { def: 3, mid: 1, att: 1 },
  '2-2-1': { def: 2, mid: 2, att: 1 },
};

// x fractions used to spread players in a row so they are not too close.
const ROW_X = {
  1: [0.5],
  2: [0.3, 0.7],
  3: [0.18, 0.5, 0.82],
};

// team-relative band positions along the attack axis (0=own goal, 1=opponent goal)
const BAND = {
  def: 0.14,
  mid: 0.5,
  att: 0.84,
};

// Minimum separation to respect so same-team sticks are not too close.
const MIN_TEAM_DIST = 0.22;

function shuffleFormationRow(xs) {
  // keep a deterministic spread but allow row ordering; just return sorted low->high
  return xs.slice().sort((a, b) => a - b);
}

// Build the initial (current) positions for a team's 5 sticks based on formation.
// Returns array of {x, y} in field coordinates.
function formationPositions(formation, team) {
  const spec = FORMATIONS[formation];
  if (!spec) throw new Error('Unknown formation ' + formation);
  const rows = [['def', spec.def], ['mid', spec.mid], ['att', spec.att]];
  const out = [];
  // order rows defense -> mid -> attack
  for (const [band, count] of rows) {
    const xs = shuffleFormationRow(ROW_X[count]);
    for (let i = 0; i < count; i++) {
      const x = xs[i];
      // team-relative position: 0=own goal, 1=opponent goal
      let rel = BAND[band];
      // add slight x jitter is unnecessary; use band center
      let y = rel;
      if (team === 'B') {
        // Team B attacks upward: mirror y (0=top/opponent, 1=bottom/own)
        // For B, its 'def' band is near bottom (own goal).
        // BAND is defined in team-relative attack space already, so just keep.
        y = rel;
      }
      out.push({ x, y });
    }
  }
  return out;
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function normalize(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const m = Math.hypot(dx, dy);
  if (m < 1e-9) return { x: 1, y: 0 };
  return { x: dx / m, y: dy / m };
}

// Check whether segment a->b intersects segment c->d. Returns the intersection
// point or null. Uses normalized coordinates.
function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: a.x + t * r.x, y: a.y + t * r.y };
  }
  return null;
}

// Distance from point p to segment a->b.
function pointSegmentDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * abx, qy = a.y + t * aby;
  return distance(p, { x: qx, y: qy });
}

// Minimum distance between two segments a->b and c->d.
// (Minimum over the four endpoint-to-other-segment distances.)
function segmentsDist(a, b, c, d) {
  return Math.min(
    pointSegmentDist(a, c, d),
    pointSegmentDist(b, c, d),
    pointSegmentDist(c, a, b),
    pointSegmentDist(d, a, b)
  );
}

const STICK_RADIUS = 0.035; // normalized hit radius of a stick
const PASS_CLEARANCE = 0.06; // how close an opponent's path/point must be to the pass line to intercept
const TACKLE_RADIUS = 0.085; // opponent within this of carrier steals the ball

class GameState {
  constructor(formationA, formationB) {
    this.formationA = formationA || '2-1-2';
    this.formationB = formationB || '2-1-2';
    // sticks: each { team, x, y, targetX, targetY (planned shadow), px, py (prev), blocked }
    this.sticks = [];
    this.ball = { x: 0.5, y: 0.5, carrier: null, team: null };
    this.score = { A: 0, B: 0 };
    this.goalsToWin = 2;
    // ball carrier: stick index in this.sticks
    this.carrier = -1;
    this._buildSticks();
    this.assignBallToClosest();
  }

  _buildSticks() {
    const posA = formationPositions(this.formationA, 'A');
    const posB = formationPositions(this.formationB, 'B');
    // Team A lowercase first, B uppercase? We'll keep every stick with a unique id.
    const idsA = ['a1','a2','a3','a4','a5'];
    const idsB = ['b1','b2','b3','b4','b5'];
    this.sticks = [];
    for (let i = 0; i < posA.length; i++) {
      this.sticks.push({ id: idsA[i], team: 'A', x: posA[i].x, y: posA[i].y, targetX: posA[i].x, targetY: posA[i].y, px: posA[i].x, py: posA[i].y, blocked: false });
    }
    for (let i = 0; i < posB.length; i++) {
      this.sticks.push({ id: idsB[i], team: 'B', x: posB[i].x, y: posB[i].y, targetX: posB[i].x, targetY: posB[i].y, px: posB[i].x, py: posB[i].y, blocked: false });
    }
  }

  indexOfTeam(team) {
    const out = [];
    this.sticks.forEach((s, i) => { if (s.team === team) out.push(i); });
    return out;
  }

  // Ball carrier index within this.sticks, or -1
  get carrierIndex() {
    return this.carrier;
  }

  assignBallToClosest() {
    let best = -1, bestD = Infinity;
    this.sticks.forEach((s, i) => {
      const d = distance(this.ball, s);
      if (d < bestD) { bestD = d; best = i; }
    });
    this.carrier = best;
    this.ball.carrier = best;
    this.ball.team = best >= 0 ? this.sticks[best].team : null;
    this.ball.x = this.sticks[best].x;
    this.ball.y = this.sticks[best].y;
  }

  stickById(id) {
    return this.sticks.find((s) => s.id === id);
  }

  // Apply a player's planning action for a tick and record their pass decision.
  // plan = {
  //   moves: { stickId: { dx, dy } }  // for non-carrier sticks
  //   pass: { type: 'none' } | { type: 'keep' } | { type: 'teammate', targetId } | { type: 'shoot' }
  // }
  applyPlan(team, p) {
    const plan = p || { moves: {}, pass: { type: 'none' } };
    const moves = plan.moves || {};
    const idxs = this.indexOfTeam(team);
    for (const i of idxs) {
      const s = this.sticks[i];
      const isCarrier = (i === this.carrier);
      if (isCarrier) {
        // carrier does not move
        s.targetX = s.x; s.targetY = s.y;
        s.blocked = false;
        continue;
      }
      const m = moves[s.id] || { dx: 0, dy: 0 };
      // clamp move magnitude to MAX_STEP
      const MAX_STEP = 0.28;
      let dx = m.dx || 0, dy = m.dy || 0;
      const mag = Math.hypot(dx, dy);
      if (mag > MAX_STEP) { dx = dx / mag * MAX_STEP; dy = dy / mag * MAX_STEP; }
      s.px = s.x; s.py = s.y;
      s.targetX = s.x + dx;
      s.targetY = s.y + dy;
      // keep within bounds
      s.targetX = Math.max(0.03, Math.min(0.97, s.targetX));
      s.targetY = Math.max(0.03, Math.min(0.97, s.targetY));
      s.blocked = false;
    }
    // store pass plan for resolution
    this._planPass = this._planPass || {};
    this._planPass[team] = plan.pass || { type: 'none' };
  }

  resolveTick() {
    // 1. Compute final positions for all moving sticks (with collision blocking)
    this._resolveStickCollisions();

    // 2. Resolve ball action for the carrier team
    const carrierTeam = this.carrier >= 0 ? this.sticks[this.carrier].team : null;
    const passPlan = (this._planPass && this._planPass[carrierTeam]) || { type: 'none' };
    if (carrierTeam) {
      this._resolveBallAction(carrierTeam, passPlan);
    } else {
      // no carrier: put ball with closest
      this.assignBallToClosest();
    }

    // 3. Check goal scoring
    const goal = this._checkGoal();
    this._plans = {}; // clear plans for next tick
    this._planPass = {};
    return { goal, winner: null };
  }

  _resolveStickCollisions() {
    const sticks = this.sticks;
    const blocked = new Set();
    // Apply all moves to final positions.
    for (const s of sticks) { s.x = s.targetX; s.y = s.targetY; }
    // Resolve path crossings / close landings repeatedly (chains).
    for (let pass = 0; pass < sticks.length * 2; pass++) {
      let changed = false;
      for (let i = 0; i < sticks.length; i++) {
        for (let j = i + 1; j < sticks.length; j++) {
          const a = sticks[i], b = sticks[j];
          const ia = { x: a.px, y: a.py }, fa = { x: a.x, y: a.y };
          const ib = { x: b.px, y: b.py }, fb = { x: b.x, y: b.y };
          const pt = segmentIntersection(ia, fa, ib, fb);
          const dEnd = distance(fa, fb);
          if (pt) {
            // paths cross => both sticks are hit; stop each just short of the point
            if (!blocked.has(a.id)) {
              const da = normalize(fa, ia);
              a.x = pt.x - da.x * STICK_RADIUS; a.y = pt.y - da.y * STICK_RADIUS;
              blocked.add(a.id); changed = true;
            }
            if (!blocked.has(b.id)) {
              const db = normalize(fb, ib);
              b.x = pt.x - db.x * STICK_RADIUS; b.y = pt.y - db.y * STICK_RADIUS;
              blocked.add(b.id); changed = true;
            }
          } else if (dEnd < STICK_RADIUS * 1.6 && dEnd > 1e-6) {
            if (!blocked.has(a.id) && !blocked.has(b.id)) {
              const nx = (fb.x - fa.x) / dEnd, ny = (fb.y - fa.y) / dEnd;
              a.x = fa.x - nx * STICK_RADIUS * 0.8; a.y = fa.y - ny * STICK_RADIUS * 0.8;
              b.x = fb.x + nx * STICK_RADIUS * 0.8; b.y = fb.y + ny * STICK_RADIUS * 0.8;
              blocked.add(a.id); blocked.add(b.id); changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
    // clamp inside field
    for (const s of sticks) {
      s.x = Math.max(0.02, Math.min(0.98, s.x));
      s.y = Math.max(0.02, Math.min(0.98, s.y));
      s.blocked = blocked.has(s.id);
    }
    this._blocked = blocked;
  }

  // An opponent that ends up very close to the ball carrier wins the ball.
  _applyTackle() {
    if (this.carrier < 0) return;
    const c = this.sticks[this.carrier];
    let tackle = -1, bestD = Infinity;
    const opp = this.indexOfTeam(c.team === 'A' ? 'B' : 'A');
    for (const oi of opp) {
      const o = this.sticks[oi];
      const d = distance(c, o);
      if (d < TACKLE_RADIUS && d < bestD) { bestD = d; tackle = oi; }
    }
    if (tackle >= 0) {
      this.carrier = tackle;
      this.ball.x = this.sticks[tackle].x;
      this.ball.y = this.sticks[tackle].y;
      this.ball.team = this.sticks[tackle].team;
      this.ball.carrier = tackle;
    }
  }

  // Opponent sticks whose paths or final points come within clearance of the
  // pass line intercept it. Returns the index of the intercepting stick.
  _findInterceptor(team, from, to) {
    const opp = this.indexOfTeam(team === 'A' ? 'B' : 'A');
    let best = -1, bestD = Infinity;
    for (const oi of opp) {
      const o = this.sticks[oi];
      const oStart = { x: o.px, y: o.py }, oEnd = { x: o.x, y: o.y };
      const d = segmentsDist(from, to, oStart, oEnd);
      if (d < PASS_CLEARANCE && d < bestD) { bestD = d; best = oi; }
    }
    return best;
  }

  _resolveBallAction(team, passPlan) {
    if (!passPlan) passPlan = { type: 'keep' };
    // tackle check first (defenders who closed in during movement win the ball)
    this._applyTackle();
    if (this.carrier < 0) return;
    if (this.sticks[this.carrier].team !== team) return; // ball was stolen
    if (passPlan.type === 'keep' || passPlan.type === 'none') {
      const c = this.sticks[this.carrier];
      this.ball.x = c.x; this.ball.y = c.y;
      return;
    }
    if (passPlan.type === 'teammate') {
      const target = this.sticks.find((s) => s.id === passPlan.targetId);
      if (!target || target.team !== team) {
        const c = this.sticks[this.carrier];
        this.ball.x = c.x; this.ball.y = c.y;
        return;
      }
      const from = this.sticks[this.carrier];
      const to = { x: target.x, y: target.y };
      const interceptor = this._findInterceptor(team, from, to);
      if (interceptor >= 0) {
        this.carrier = interceptor;
        this.ball.x = this.sticks[interceptor].x;
        this.ball.y = this.sticks[interceptor].y;
        this.ball.team = this.sticks[interceptor].team;
        this.ball.carrier = interceptor;
        return;
      }
      this.carrier = this.sticks.indexOf(target);
      this.ball.x = target.x; this.ball.y = target.y;
      this.ball.team = team;
      this.ball.carrier = this.carrier;
      return;
    }
    if (passPlan.type === 'shoot') {
      const from = this.sticks[this.carrier];
      const goalY = team === 'A' ? 1.0 : 0.0;
      const to = { x: 0.5, y: goalY };
      const interceptor = this._findInterceptor(team, from, to);
      if (interceptor >= 0) {
        this.carrier = interceptor;
        this.ball.x = this.sticks[interceptor].x;
        this.ball.y = this.sticks[interceptor].y;
        this.ball.team = this.sticks[interceptor].team;
        this.ball.carrier = interceptor;
        return;
      }
      this.ball.x = 0.5;
      this.ball.y = goalY;
      return;
    }
  }

  _checkGoal() {
    const b = this.ball;
    // Team A defends top (y < goal strip), Team B defends bottom (y > goal strip)
    const inMouth = Math.abs(b.x - 0.5) <= FIELD.goalHalfWidth;
    if (inMouth && b.y <= 0.0) {
      // ball crossed top goal -> Team B scores (attacks up), but a goal scored
      // INTO A's goal means B scored.
      this.score.B += 1;
      this.ball.x = 0.5; this.ball.y = 0.5;
      this.assignBallToClosest();
      return { team: 'B' };
    }
    if (inMouth && b.y >= 1.0) {
      this.score.A += 1;
      this.ball.x = 0.5; this.ball.y = 0.5;
      this.assignBallToClosest();
      return { team: 'A' };
    }
    return null;
  }

  // Check if a goal was scored and game over
  checkWinner() {
    if (this.score.A >= this.goalsToWin) return 'A';
    if (this.score.B >= this.goalsToWin) return 'B';
    return null;
  }

  serialize() {
    return {
      formationA: this.formationA,
      formationB: this.formationB,
      sticks: this.sticks.map((s) => ({ id: s.id, team: s.team, x: s.x, y: s.y, targetX: s.targetX, targetY: s.targetY, px: s.px, py: s.py, blocked: s.blocked })),
      ball: { x: this.ball.x, y: this.ball.y, carrier: this.ball.carrier, team: this.ball.team },
      carrier: this.carrier,
      score: { A: this.score.A, B: this.score.B },
      goalsToWin: this.goalsToWin,
    };
  }

  loadState(st) {
    this.formationA = st.formationA;
    this.formationB = st.formationB;
    this.sticks = st.sticks.map((s) => Object.assign({}, s));
    this.ball = Object.assign({}, st.ball);
    this.carrier = st.carrier;
    this.score = { A: st.score.A, B: st.score.B };
    this.goalsToWin = st.goalsToWin;
  }
}

const API = {
  FIELD,
  FORMATIONS,
  formationPositions,
  GameState,
  distance,
  normalize,
  segmentIntersection,
  pointSegmentDist,
  segmentsDist,
  STICK_RADIUS,
  PASS_CLEARANCE,
  TACKLE_RADIUS,
};

// UMD: works in Node (via module.exports) and in the browser (window.SFGame).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.SFGame = API;
}
