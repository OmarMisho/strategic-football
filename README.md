# Strategic Football

A turn-based strategic football game for two players on two phones.

Each player controls **5 sticks** (flag icons). Every **10 seconds** you secretly drag your
sticks to where they should run (a **shadow** shows the plan + a small line from the current
position to the planned spot). When the 10s clock ends, all stretches are applied at once:

- Criscrossing sticks **hit each other** and get blocked.
- The **ball** is passed stick-to-stick; a pass is **cut/intercepted** if an opponent's stick
  sits on (or runs across) the pass line → the defender wins the ball and counter-attacks.
- The ball holder cannot move, but may **pass to a teammate** (whose planned position receives it)
  or **shoot** at the goal.
- First to **2 goals** wins.

## How it works

- One **round = 100 seconds = 10 ticks of 10 seconds**.
- Each player picks a **formation** (2-1-2, 3-1-1, 2-2-1) and a **flag icon** before the match
  (flags are chosen in **Settings** on the main screen).
- The game runs **portrait** on mobile browsers, timers at the top.

## Running

Requires Node.js 18+.

```bash
npm install
npm start
```

Server listens on **http://localhost:8080**.

### Two players, two phones

1. Open **http://<your-computer-LAN-IP>:8080** on both phones (same Wi-Fi).
2. Player 1 taps **Create Room**, shares the 4-letter room code.
3. Player 2 taps **Join**, types the code.
4. Both pick a formation + tap **Ready** → the match begins.

> To play across the internet, run the server on any public host (e.g. a VPS) and open
> `http://<public-ip>:8080` on the phones.

### Solo practice

Tap **Play vs AI** on the main menu to try the mechanics without a server (runs fully in the browser).

## Controls (in-game)

- **Drag** any of your (green-ringed) sticks to "stretch" it — a shadow + line shows the planned move.
- Tap your **ball holder** (shows a football) to enter pass mode, then:
  - tap a **teammate** to pass to their planned position,
  - tap the opposite **goal** to shoot,
  - tap anywhere else to keep the ball / exit.
- Press **CONFIRM PLAN** to lock your moves early, or wait for the 10s clock.
- The host's sticks are shown with a green ring, the guest's with a red ring.

## Project layout

```
strategic-football/
├── server.js          # HTTP static + WebSocket game server (authoritative)
├── lib/game.js        # shared rule engine (formations, collisions, passes, goals) — UMD
├── public/
│   ├── index.html     # screens: home / lobby / game / settings
│   ├── style.css      # portrait, mobile-first styling
│   └── game.js        # client: canvas rendering + touch planning + practice AI
└── test-e2e.js        # two-client integration test (create/join/plan/resolve)
```

## Rules engine notes

- Field is a normalized 0..1 portrait plane; team **A** attacks the bottom goal, team **B** the top.
- **Blocking:** two sticks whose paths cross (or that land within 1.6× stick radius) both stop at the
  point of hit.
- **Interception:** an opponent's stick whose **path or final position** passes within `PASS_CLEARANCE`
  of the pass line wins the ball.
- **Tackle:** an opponent landing within `TACKLE_RADIUS` of the holder steals the ball.