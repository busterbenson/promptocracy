// The blank-slate board: compass labels and geometry, what a move charts, migration 0002 on a database with
// data, settings, piece colors, spawning, the move action, and the public board API.
// Run: npm test (after e2e.mjs). Real `wrangler dev`, LOCAL D1 only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync as readText } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT, COLORS, authorizeQuery, client, connect, consent, createGame, d1, exchange, finish, form, join, mcp, migrate, newPkce, newState, registerClient, sha256Hex, freePort, startRulesStub, startServer, tool } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";
import { chartOffsets, chartedAround, coordLabel, diagonals, islandCoords, tileLabel, neighbors, parseLabel, validCoord, withinSteps, xLabel, yLabel, zLabel } from "../src/lib/geometry.js";
import { DEFAULT_SETTINGS, getSettings, settingsForSize, spawnSpots, validateSettings } from "../src/lib/settings.js";
import { DIAGONAL_MOVES, SHARED_TILES } from "../src/lib/board-rules.js";
import { dayOpenBinds } from "../src/lib/day-gate.js";

const PIECES = JSON.parse(readText(pjoin(ROOT, "src/lib/pieces.json"), "utf8"));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;

// ---------------------------------------------------------------- labels
console.log("labels");
check("columns: ... 3W 2W 1W | 1E 2E 3E ..., with no zero (x -1 is 1W, x 0 is 1E)", [-3, -2, -1, 0, 1, 2].map(xLabel).join() === "3W,2W,1W,1E,2E,3E");
check("rows: ... 2N 1N | 1S 2S ... (y 0 is 1N, y -1 is 1S, north is up)", [2, 1, 0, -1, -2].map(yLabel).join() === "3N,2N,1N,1S,2S");
check("the seams: 1W and 1E are neighbours (x -1, 0), and so are 1N and 1S (y 0, -1)", xLabel(-1) === "1W" && xLabel(0) === "1E" && yLabel(0) === "1N" && yLabel(-1) === "1S" && J(parseLabel("1N 1W")) === '{"x":-1,"y":0,"z":0}' && J(parseLabel("1S 1E")) === '{"x":0,"y":-1,"z":0}');
check("a tile reads row first, then column: 3N 2E is x 1, y 2", coordLabel(1, 2) === "3N 2E" && J(parseLabel("3N 2E")) === '{"x":1,"y":2,"z":0}');
check("the four center tiles are 1N 1W, 1N 1E, 1S 1W, 1S 1E", [[-1, 0], [0, 0], [-1, -1], [0, -1]].map(([x, y]) => coordLabel(x, y)).join() === "1N 1W,1N 1E,1S 1W,1S 1E");
check("big values: x 999999 is 1000000E, y -1000000 is 1000000S, and back", xLabel(999999) === "1000000E" && yLabel(-1000000) === "1000000S" && J(parseLabel("1000000S 1000000W")) === '{"x":-1000000,"y":-1000000,"z":0}' && coordLabel(-1000000, 999999) === "1000000N 1000000W");
let rt = true;
for (const x of [-1000000, -12345, -100, -9, -2, -1, 0, 1, 2, 9, 100, 12345, 999999]) for (const y of [-1000000, -777, -2, -1, 0, 1, 2, 9, 4321, 999999]) { const p = parseLabel(coordLabel(x, y)); if (!p || p.x !== x || p.y !== y) rt = false; }
check("label <-> integers round-trips across negative, zero-adjacent and big values", rt);
check("labels are case-insensitive and tolerate extra spaces", J(parseLabel("3n 2e")) === '{"x":1,"y":2,"z":0}' && J(parseLabel("  4S   4W ")) === '{"x":-4,"y":-4,"z":0}');
check("things that are not labels are refused (there is no zero row or column; column first is not a label)", ["", "0N 1E", "1N 0E", "0S 0W", "2E 3N", "3N", "3N2E", "N3 E2", "3X 2E", "-1N 1E", "1N 1E 1", "01N 1E", "99999999N 1E", null, undefined, 4, {}].every((v) => parseLabel(v) === null));
check("levels skip zero too: ground (z 0) is 1U, z 1 is 2U, z -1 is 1D, z -2 is 2D (the 1U/1D seam)", [-2, -1, 0, 1, 2].map(zLabel).join() === "2D,1D,1U,2U,3U" && tileLabel(1, 2, 0) === "3N 2E 1U" && tileLabel(-1, -1, -1) === "1S 1W 1D");
check("a label may carry its level: 3N 2E 1U is z 0, 3N 2E 2U is z 1, 3N 2E 1D is z -1; without one it is the ground", J(parseLabel("3N 2E 1U")) === '{"x":1,"y":2,"z":0}' && J(parseLabel("3n 2e 2u")) === '{"x":1,"y":2,"z":1}' && J(parseLabel("3N 2E 1D")) === '{"x":1,"y":2,"z":-1}' && parseLabel("3N 2E 0U") === null && parseLabel("3N 2E 1X") === null && J(parseLabel(tileLabel(5, -6, -3))) === '{"x":5,"y":-6,"z":-3}');
check("coordinates are plain integers up to a million, z included", validCoord(0, 0) && validCoord(-1000000, 1000000, 0) && !validCoord(1000001, 0) && !validCoord(0.5, 0) && !validCoord(0, 0, 1.5) && !validCoord("1", 0) && !validCoord(0, 0, 2000000));
check("neighbours: four orthogonal, four diagonal, kept apart", J(neighbors(2, 3)) === "[[3,3],[2,4],[1,3],[2,2]]" && J(diagonals(2, 3)) === "[[3,4],[1,4],[1,2],[3,2]]");

// ---------------------------------------------------------------- the island, charting, moving
console.log("geometry");
const isl = islandCoords(8, 8);
const L = (x, y) => coordLabel(x, y);
check("the starting island is 8x8 = 64 tiles centered on the origin: columns 4W..4E, rows 4N..4S", isl.length === 64 && new Set(isl.map((c) => c + "")).size === 64 &&
  Math.min(...isl.map((c) => c[0])) === -4 && Math.max(...isl.map((c) => c[0])) === 3 && Math.min(...isl.map((c) => c[1])) === -4 && Math.max(...isl.map((c) => c[1])) === 3 &&
  L(-4, 3) === "4N 4W" && L(3, -4) === "4S 4E" && L(-4, -4) === "4S 4W" && L(3, 3) === "4N 4E");
check("other even sizes are centered too (4x4: 2W..2E, 2N..2S; 12x6)", islandCoords(4, 4).length === 16 && L(-2, 1) === "2N 2W" && Math.max(...islandCoords(12, 6).map((c) => c[0])) === 5 && Math.min(...islandCoords(12, 6).map((c) => c[1])) === -3);
const off = chartOffsets(2);
check("a move charts exactly 21 offsets: the 5x5 square without its 4 corners", off.length === 21 && new Set(off.map((o) => o + "")).size === 21);
check("the four corners (+-2, +-2) are excluded, every other tile of the 5x5 square is in", [[2, 2], [-2, 2], [2, -2], [-2, -2]].every(([a, b]) => !off.some(([x, y]) => x === a && y === b)) && off.every(([x, y]) => Math.abs(x) <= 2 && Math.abs(y) <= 2) && off.some(([x, y]) => x === 2 && y === 1) && off.some(([x, y]) => x === 0 && y === -2) && off.some(([x, y]) => x === 0 && y === 0));
check("it is the tiles with centers within Euclidean distance 2.5 of the piece", off.every(([x, y]) => Math.hypot(x, y) <= 2.5) && (() => { let n = 0; for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) if (Math.hypot(x, y) <= 2.5) n++; return n === 21; })());
check("chartedAround is that shape at a position, in the plain integers (across the 1W/1E seam too)", chartedAround(0, 0, 2).length === 21 && chartedAround(-1, -1, 2).some(([x, y]) => x === 1 && y === 0) && J(chartedAround(5, -7, 2).slice(0, 2)) === J([[4, -9], [5, -9]]) && chartOffsets(1).length === 9 - 0 && chartOffsets(3).length === 37);
check("one step, with diagonals (P1, decided): all 8 neighbours, nothing two away, never the same tile", DIAGONAL_MOVES === true &&
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].every(([dx, dy]) => withinSteps(0, 0, dx, dy, 1)) &&
  [[2, 0], [0, 2], [2, 1], [2, 2], [-2, 0], [0, 0]].every(([dx, dy]) => !withinSteps(0, 0, dx, dy, 1)));
check("1W -> 1E and 1N -> 1S are one step (computed on the plain integers)", withinSteps(-1, 0, 0, 0, 1) && withinSteps(0, 0, 0, -1, 1) && withinSteps(-1, 0, 0, -1, 1) && !withinSteps(-1, 0, 1, 0, 1));
check("without diagonals (the switch) only N, S, E, W count, and a larger distance reaches further", !withinSteps(0, 0, 1, 1, 1, false) && withinSteps(0, 0, 1, 0, 1, false) && withinSteps(0, 0, 2, 0, 2) && !withinSteps(0, 0, 3, 0, 2));
check("the decided questions are pinned: P1 diagonals yes, P2 sharing a tile no", DIAGONAL_MOVES === true && SHARED_TILES === false);

// ---------------------------------------------------------------- migration 0002 on a database with data
console.log("migration 0002");
{
  const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig-"));
  try {
    mkdirSync(pjoin(cfgDir, "m"));
    copyFileSync(pjoin(ROOT, "migrations/0001_init.sql"), pjoin(cfgDir, "m/0001_init.sql"));
    const cfg = pjoin(cfgDir, "wrangler.toml");
    writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
    const W = pjoin(ROOT, "node_modules/.bin/wrangler");
    const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
    run(["d1", "migrations", "apply", "DB"]); // 0001 only
    const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
    sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at) VALUES ('g1','old','Old','a/b','AAAA2222','playing','2026-01-01T00:00:00Z')`);
    for (const [i, n] of ["ada", "bo", "cy"].entries()) {
      sql(`INSERT INTO players (id, game_id, email, display_name, marker, color, score, turn_order, joined_at) VALUES ('p${i}','g1','${n}@x.test','${n}','m${i}','#abcdef',${i * 10},${i},'2026-01-01T00:00:00Z')`);
      sql(`INSERT INTO sessions (id_hash, game_id, player_id, created_at, expires_at) VALUES ('s${i}','g1','p${i}','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')`);
      sql(`INSERT INTO notifications (id, game_id, player_id, kind, body, created_at) VALUES ('n${i}','g1','p${i}','k','b','2026-01-01T00:00:00Z')`);
    }
    sql(`INSERT INTO turns (id, game_id, player_id, round, turn_index, prompt, created_at, updated_at) VALUES ('t1','g1','p1',1,1,'hi','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`);
    sql(`INSERT INTO login_tokens (token_hash, game_id, email, purpose, display_name, marker, created_at, expires_at) VALUES ('h1','g1','new@x.test','join','New','m3','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')`);
    copyFileSync(pjoin(ROOT, "migrations/0002_island_board.sql"), pjoin(cfgDir, "m/0002_island_board.sql"));
    run(["d1", "migrations", "apply", "DB"]); // 0002 on top of data
    const players = sql("SELECT id, color, score, turn_order FROM players ORDER BY turn_order");
    check("existing players keep ids, scores and order, and get palette colors in turn order",
      JSON.stringify(players) === JSON.stringify([{ id: "p0", color: "vermilion", score: 0, turn_order: 0 }, { id: "p1", color: "saffron", score: 10, turn_order: 1 }, { id: "p2", color: "moss", score: 20, turn_order: 2 }]), JSON.stringify(players));
    check("the marker column is gone", !sql("SELECT name FROM pragma_table_info('players')").some((c) => c.name === "marker") && !sql("SELECT name FROM pragma_table_info('login_tokens')").some((c) => c.name === "marker"));
    check("sessions, notifications and turns still point at their players",
      sql("SELECT COUNT(*) AS n FROM sessions s JOIN players p ON p.id = s.player_id AND p.game_id = s.game_id")[0].n === 3 &&
      sql("SELECT COUNT(*) AS n FROM notifications")[0].n === 3 && sql("SELECT COUNT(*) AS n FROM turns")[0].n === 1);
    check("foreign keys are intact after the rebuild", sql("PRAGMA foreign_key_check").length === 0);
    check("the existing game got its seat limit as a setting (the old column's 5; every other default applies) and an empty last-move marker; unused join links were voided",
      sql("SELECT settings FROM games")[0].settings === '{"max_players":5}' && sql("SELECT last_move FROM games")[0].last_move === "" && sql("SELECT COUNT(*) AS n FROM login_tokens")[0].n === 0);
    let dup = "ok"; try { sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('px','g1','x@x.test','x','vermilion',9,'2026-01-01T00:00:00Z',0,0)`); } catch { dup = "refused"; }
    check("the new table keeps one color per player per game", dup === "refused");
    const t = sql("SELECT x, y, z FROM tiles WHERE game_id = 'g1'");
    check("the existing game's 8x8 island is charted: columns x -4..3 (4W..4E), rows y -4..3 (4N..4S), all on the ground",
      t.length === 64 && t.every((u) => u.x >= -4 && u.x <= 3 && u.y >= -4 && u.y <= 3 && u.z === 0) && new Set(t.map((u) => u.x + "," + u.y)).size === 64);
    const pos = sql("SELECT x, y, z FROM players ORDER BY turn_order");
    check("every existing player is placed on a distinct charted tile", new Set(pos.map((u) => u.x + "," + u.y)).size === 3 && pos.every((u) => t.some((v) => v.x === u.x && v.y === u.y && u.z === 0)), JSON.stringify(pos));
    check("tiles have no property columns at all", JSON.stringify(sql("SELECT name FROM pragma_table_info('tiles') ORDER BY cid").map((c) => c.name)) === '["game_id","x","y","z","charted_at"]');
    let dupTile = "ok"; try { sql(`INSERT INTO tiles (game_id, x, y, z, charted_at) VALUES ('g1',0,0,0,'t')`); } catch { dupTile = "refused"; }
    check("a tile exists once per game and place", dupTile === "refused");
    // migration 0004: a seat's piece shape and the way it faces. Additive: existing seats keep working as pawns.
    copyFileSync(pjoin(ROOT, "migrations/0003_mcp_oauth.sql"), pjoin(cfgDir, "m/0003_mcp_oauth.sql"));
    copyFileSync(pjoin(ROOT, "migrations/0004_piece_shape.sql"), pjoin(cfgDir, "m/0004_piece_shape.sql"));
    run(["d1", "migrations", "apply", "DB"]); // 0003 and 0004 on top of data
    const after = sql("SELECT id, color, score, shape, mirrored FROM players ORDER BY turn_order");
    check("migration 0004: every existing seat keeps its id, color and score, and is a pawn facing as drawn", JSON.stringify(after) === JSON.stringify([{ id: "p0", color: "vermilion", score: 0, shape: "pawn", mirrored: 0 }, { id: "p1", color: "saffron", score: 10, shape: "pawn", mirrored: 0 }, { id: "p2", color: "moss", score: 20, shape: "pawn", mirrored: 0 }]), JSON.stringify(after));
    let badFacing = "ok"; try { sql(`UPDATE players SET mirrored = 2 WHERE id = 'p0'`); } catch { badFacing = "refused"; }
    check("migration 0004: a piece faces one way or the other, nothing else", badFacing === "refused" && sql("SELECT name, [notnull] FROM pragma_table_info('login_tokens') WHERE name = 'shape'")[0].notnull === 0 && sql("PRAGMA foreign_key_check").length === 0);
  } catch (e) { fail++; console.log("  FAIL  migration harness:", String(e.stdout || "") + String(e.stderr || "") + (e.stack || e)); }
  finally { for (const d of [st, cfgDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} } }
}


// ---------------------------------------------------------------- settings
console.log("settings");
check("the default settings are valid; they are the seat limit, the island size, the chart radius, the move distance, whether MCP is on, the time zone, the night's budget per change, the proposals a day, Gremlin's messages a day, his price ceiling his thread replies a day, the points that win an Era and the hearts and death settings (601-603), nothing else", validateSettings(DEFAULT_SETTINGS).length === 0 && validateSettings(settingsForSize(16, 12)).length === 0 && J(Object.keys(DEFAULT_SETTINGS)) === '["max_players","board.island","board.chart_radius","turn.move_distance","mcp_enabled","game.timezone","night.apply_minutes","night.apply_effort","proposals.per_day","gremlin.messages_per_day","workshop.price_ceiling","gremlin.thread_replies_per_day","eras.points_to_win","hearts.start","creatures.appear_steps","creatures.bite","death.ghost_days"]' && DEFAULT_SETTINGS["game.timezone"] === "America/Los_Angeles" && DEFAULT_SETTINGS.max_players === 8 && DEFAULT_SETTINGS["board.island"].width === 8 && DEFAULT_SETTINGS["board.chart_radius"] === 2 && DEFAULT_SETTINGS["turn.move_distance"] === 1 && DEFAULT_SETTINGS.mcp_enabled === true);
const bad = (k, v) => validateSettings({ ...DEFAULT_SETTINGS, [k]: v }).length > 0;
check("seats must fit the island: max_players above the spawn spots is refused (8x8 radius 2 leaves 16; 6x6 leaves 4; radius 3 on 8x8 leaves 4)", spawnSpots(8, 8, 2) === 16 && spawnSpots(6, 6, 2) === 4 && spawnSpots(8, 8, 3) === 4 && spawnSpots(4, 4, 2) === 0 && validateSettings(settingsForSize(6, 6)).length === 1 && /spawn spots/.test(validateSettings(settingsForSize(6, 6))[0]) && validateSettings(settingsForSize(6, 6, 4)).length === 0 && validateSettings({ ...DEFAULT_SETTINGS, max_players: 5, "board.chart_radius": 3 }).length === 1 && validateSettings({ ...DEFAULT_SETTINGS, max_players: 4, "board.chart_radius": 3 }).length === 0);
check("bad values are refused: odd or tiny sizes, radii, distances, extra keys", bad("board.island", { width: 3, height: 8 }) && bad("board.island", { width: 7, height: 8 }) && bad("board.island", { width: 8 }) && bad("board.island", { width: 8, height: 8, depth: 1 }) && bad("board.chart_radius", 0) && bad("board.chart_radius", 2.5) && bad("max_players", 0) && bad("max_players", 9) && bad("max_players", 2.5) && bad("turn.move_distance", 0) && bad("turn.move_distance", "1") && validateSettings({ ...DEFAULT_SETTINGS, mystery: 1 }).length > 0);
check("a game's stored settings override only what they name; an invalid stored value falls back to the default",
  getSettings({ "turn.move_distance": 2 })["turn.move_distance"] === 2 && getSettings({ "turn.move_distance": 2 })["board.chart_radius"] === 2 && getSettings({ "turn.move_distance": "far" })["turn.move_distance"] === 1 && getSettings("not json")["board.island"].width === 8 && getSettings(null)["board.chart_radius"] === 2 && getSettings({ nope: 1 }).nope === undefined);
check("settings named __proto__ or constructor are ignored, not thrown on", (() => { try { const s = getSettings(JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2}}')); return s["board.island"].width === 8; } catch { return false; } })());
const rulesText = readText(pjoin(ROOT, "templates/RULES.md"), "utf8");
const named = [...rulesText.matchAll(/\[setting: ([^\]]+)\]/g)].flatMap((m) => m[1].split(",").map((n) => n.trim()));
const inRules = new Set(named), inCode = new Set(Object.keys(DEFAULT_SETTINGS));
check("every [setting: x] named in templates/RULES.md exists in the default settings", named.length > 0 && [...inRules].every((n) => inCode.has(n)), [...inRules].filter((n) => !inCode.has(n)).join());
check("and every default setting is named in templates/RULES.md", [...inCode].every((n) => inRules.has(n)), [...inCode].filter((n) => !inRules.has(n)).join());
check("the starter rules are in hundreds blocks (100 Core, 200 Players and turns, 300 Proposals and rulings, 400 Points and winning, 500 The board), with the day rules of step 1 (107 The night, 203 Days), 302 retired into 107.4, hearts and creatures (600) and how the game ends (404), and the catalog's block (700, making things)",
  ["## 100. Core rules\n", "## 200. Players and turns\n", "## 300. Proposals and rulings\n", "## 400. Points and winning\n", "## 500. The board\n"].every((h) => rulesText.includes(h)) &&
  ["101 Follow the rules [u]", "102 Players [u]", "103 Proposals [u]", "104 Voting [u]", "105 Votes needed [u]", "106 The moderator [u]", "107 The night [u]", "108 When rules conflict [u]", "201 Game size [m]", "202 Your turn [u]", "203 Days [u]", "204 AI clients [m]", "301 Overruling the moderator [m]", "401 Points [m]", "402 Eras [m]", "403 Paradox [m]", "404 How the game ends [m]", "501 The grid [m]", "502 Coordinates [m]", "503 The island [m]", "504 Moving and charting [m]", "505 New players [m]", "601 Hearts [m]", "602 Hostile creatures [m]", "603 Death [m]", "604 Ghosts [m]"].every((h) => rulesText.includes("### " + h + "\n")) && !/^### 302 /m.test(rulesText) &&
  rulesText.includes("## 700. Making things\n") && /^## 600\. Hearts and creatures$/m.test(rulesText) && !/claim|harvest|terrain|meadow|forest|owner|monster/i.test(rulesText.slice(rulesText.indexOf("## 500."))) && !/monster/i.test(rulesText.slice(rulesText.indexOf("## 800."))));
const wrapped = rulesText.replace(/\s+/g, " ");
const must = ["is infinite", "charted or uncharted", "8x8 charted island centered on the origin", "3N 2E", "no zero row or column", "except the 4 corners of that square", "random unoccupied charted tile where a move would chart nothing new", "visible to everyone", "make proposals (103.2)", "diagonals included", "at most once a day", "no other piece stands on", "has at most 8 players"];
check("the rules say what Buster decided: infinite grid, charted/uncharted, 8x8 centered island, 3N 2E, no zero, 5x5 minus corners, random unoccupied start where a move charts nothing new, visible to everyone, propose and move, diagonals, once a day, 8 players", must.every((w) => wrapped.includes(w)), must.filter((w) => !wrapped.includes(w)).join(" | "));
check("mcp_enabled is a boolean setting, true by default: anything else is refused, and a game that stores nothing for it has MCP on", !bad("mcp_enabled", false) && !bad("mcp_enabled", true) && bad("mcp_enabled", "yes") && bad("mcp_enabled", 1) && bad("mcp_enabled", null) && getSettings({}).mcp_enabled === true && getSettings({ max_players: 4 }).mcp_enabled === true && getSettings({ mcp_enabled: false }).mcp_enabled === false && getSettings('{"mcp_enabled":false}').mcp_enabled === false && getSettings({ mcp_enabled: "no" }).mcp_enabled === true);
check("the rule that enables MCP is 204 in the template and names the setting (the sync checks above keep the two in step)", wrapped.includes("### 204 AI clients [m] **204.1** A player may connect an AI client to this game and take their own turns through it. [setting: mcp_enabled]") && inRules.has("mcp_enabled") && inCode.has("mcp_enabled"));

// ---------------------------------------------------------------- the running site
const state = newState();
let srv, stub;
const gidOf = (slug) => d1(state, `SELECT id FROM games WHERE slug = '${slug}'`)[0].id;
const tilesOf = (slug) => d1(state, `SELECT x, y, z FROM tiles WHERE game_id = '${gidOf(slug)}'`);
const playersOf = (slug) => d1(state, `SELECT display_name AS name, x, y, z, turn_order FROM players WHERE game_id = '${gidOf(slug)}' ORDER BY turn_order`);
const tkey = (t) => `${t.x},${t.y},${t.z}`;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hex/main/RULES.md": "# Rules\n" });
  const R = { rulesBase: stub.base, repo: "busterbenson/hex" };
  const g = await createGame(state, { slug: "hex", name: "Blank board", max: 3, ...R });
  const big = await createGame(state, { slug: "eight", name: "Eight", max: 8, size: 8, ...R });
  const prop = await createGame(state, { slug: "prop", name: "Proposals", max: 2, ...R });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "SITE_URL=http://hex.test", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;

  console.log("a new game");
  const row = d1(state, "SELECT settings FROM games WHERE slug = 'eight'")[0];
  check("a new game's row holds every board setting, written out, equal to the defaults", J(JSON.parse(row.settings)) === J(DEFAULT_SETTINGS) && validateSettings(JSON.parse(row.settings)).length === 0);
  check("it starts with no tiles stored: the island is charted the first time anything needs the board", tilesOf("hex").length === 0);
  const b0 = (await client(A).get("/hex/api/board")).data;
  const gridKeys = new Set(islandCoords(8, 8).map((c) => c[0] + "," + c[1]));
  check("reading the board charts the 8x8 island: 64 tiles, 4W..4E by 4N..4S, all on the ground", b0.tiles.length === 64 && b0.tiles.every((t) => t.z === 0 && gridKeys.has(t.x + "," + t.y)) && b0.tiles.some((t) => t.label === "4N 4W 1U") && b0.tiles.some((t) => t.label === "4S 4E 1U") && !b0.tiles.some((t) => /^0|\b0[NSEWUD]/.test(t.label)));
  check("again: it is charted once, not twice", tilesOf("hex").length === 64 && (await client(A).get("/hex/api/board")).data.tiles.length === 64);
  let seatsRefused = "";
  try { await createGame(state, { slug: "zzz", size: 6, ...R }); seatsRefused = "created"; } catch { seatsRefused = "refused"; }
  check("create-game refuses an island too small for the seats (--size 6 with the default 8 players), and accepts it with --max-players 4", seatsRefused === "refused" && (await createGame(state, { slug: "six", size: 6, max: 4, ...R })).slug === "six");
  let refused = "";
  for (const bad of ["3", "17", "x", "7", "5"]) { try { await createGame(state, { slug: "zzz", size: bad, ...R }); refused += "no "; } catch { refused += "yes "; } }
  check("create-game refuses an island size that is not an even number from 4 to 16", refused === "yes yes yes yes yes ", refused);
  let nine = "";
  try { await createGame(state, { slug: "nine", max: 9, ...R }); nine = "created"; } catch { nine = "refused"; }
  check("create-game refuses more than 8 players (a game seats at most 8)", nine === "refused");

  console.log("piece colors and spawning");
  const page = await client(A).get(`/hex/join/${g.code}`);
  check("the join page offers every player color of the palette by name (16, from one data file) and none of the monster-only colors", page.status === 200 && (page.text.match(/name="color"/g) || []).length === PIECES.colors.length && PIECES.colors.length === 16 && PIECES.colors.every((c) => page.text.includes(`<span class="nm">${c.name}</span>`)) && !/Bog|Wraith|Hex pink/.test(page.text) && !page.text.includes('name="marker"'));
  check("and nine shapes: the board-piece set (the Osprey in the Balloon's place), and no Balloon, Ghost or Blob", (page.text.match(/name="shape"/g) || []).length === 9 && ["Lantern keeper", "Frog", "Robot", "Osprey", "Diver", "Wizard", "Crow", "Astronaut", "Pawn"].every((n) => page.text.includes(`<span class="nm">${n}</span>`)) && !/value="(balloon|ghost|blob)"/.test(page.text));
  const ana = await join(A, "hex", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const page2 = await client(A).get(`/hex/join/${g.code}`);
  check("a color someone took is shown as taken and cannot be picked", /value="teal"[^>]*disabled/.test(page2.text) && !/value="cobalt"[^>]*disabled/.test(page2.text) && page2.text.includes("<small>Ana</small>"));
  const dupe = await client(A).post("/hex/api/join", { code: g.code, email: "x@example.com", name: "X", color: "teal" });
  check("joining with a taken color is refused (409)", dupe.status === 409 && /color/i.test(dupe.data.error), dupe.text);
  check("an unknown color is refused (400), and so is a color from the first palette that is no longer offered, a monster-only color, and the old marker field", (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", color: "saffron" })).status === 400 && (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", color: "bog" })).status === 400 && (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", color: "wraith" })).status === 400 && (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", color: "puce" })).status === 400 && (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", marker: "x" })).status === 400 && (await client(A).post("/hex/api/join", { code: g.code, email: "y@example.com", name: "Y", color: "orchid", shape: "dragon" })).status === 400);
  const bo = await join(A, "hex", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt", shape: "frog" });
  const cy = await join(A, "hex", g.code, { email: "cy@example.com", name: "Cy", color: "orchid" });
  const full = await client(A).post("/hex/api/join", { code: g.code, email: "d@example.com", name: "D", color: "indigo" });
  check("max_players 3 is honoured", full.status === 409 && /full/i.test(full.data.error), full.text);
  await new Promise((r) => setTimeout(r, 800)); // emails are sent after the reply
  const outbox = d1(state, "SELECT subject, body FROM outbox").map((o) => o.subject + o.body).join("\n");
  check("the log and emails name players as 'Ana (Teal)'", outbox.includes("You'll play as Teal.") && outbox.includes("Players so far (1 of 3): Ana (Teal).") && outbox.includes("Bo (Cobalt) joined the game.") && (await client(A).get("/hex/api/game")).data.events.some((e) => e.text === "Cy (Orchid) joined the game."), outbox.slice(0, 300));
  const me = await ana.get("/hex/api/me");
  check("/api/me carries the claimed color", me.data.player.color.key === "teal" && me.data.player.color.name === "Teal" && /^#[0-9a-f]{6}$/i.test(me.data.player.color.hex) && !("marker" in me.data.player));
  const game = (await client(A).get("/hex/api/game")).data;
  check("/api/game players carry colors, not markers", game.players.every((p) => p.color?.key && !("marker" in p)) && game.players.map((p) => p.color.key).join() === "teal,cobalt,orchid");
  const bd = (await client(A).get("/hex/api/board")).data;
  check("shapes: Ana joined without naming one and is a pawn, Bo chose the frog; /api/me, /api/game and /api/board carry each piece's shape, and none starts mirrored", me.data.player.shape === "pawn" && game.players.map((p) => p.shape).join() === "pawn,frog,pawn" && bd.pieces.map((p) => p.shape).join() === "pawn,frog,pawn" && bd.pieces.every((p) => p.mirrored === false) && !JSON.stringify([game, bd]).includes("@"));
  check("the color object carries what the piece is drawn from: key, name, main (hex), shade, tint, deep", ["key", "name", "hex", "shade", "tint", "deep"].every((k) => typeof me.data.player.color[k] === "string") && me.data.player.color.hex === PIECES.colors.find((c) => c.key === "teal").main);
  check("a seat from the first palette (a color no longer offered) still draws, in its own color", (() => { d1(state, `UPDATE players SET color = 'saffron' WHERE game_id = '${gidOf("hex")}' AND turn_order = 2`); return true; })() && (await client(A).get("/hex/api/board")).data.pieces[2].color.name === "Saffron" && (await client(A).get("/hex/api/board")).data.pieces[2].color.hex === "#e8b200" && (() => { d1(state, `UPDATE players SET color = 'orchid' WHERE game_id = '${gidOf("hex")}' AND turn_order = 2`); return true; })());
  const inner = new Set(islandCoords(8, 8).filter(([x, y]) => x >= -2 && x <= 1 && y >= -2 && y <= 1).map((c) => c[0] + "," + c[1]));
  const ps = playersOf("hex");
  check("the island leaves exactly 16 spawn spots (the inner 4x4, every tile whose whole chart shape is charted); each piece stands on one, on the ground, and no two share", inner.size === 16 && ps.length === 3 && ps.every((p) => p.z === 0 && inner.has(p.x + "," + p.y)) && new Set(ps.map((p) => p.x + "," + p.y)).size === 3, J(ps));
  check("spawning charts nothing: still the 64 island tiles", tilesOf("hex").length === 64);
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push(await join(A, "eight", big.code, { email: `e${i}@example.com`, name: `E${i}`, color: COLORS[i] }));
  const ninth = await client(A).post("/eight/api/join", { code: big.code, email: "e9@example.com", name: "E9", color: "teal" });
  const p8 = playersOf("eight");
  check("eight players fit, with eight different colors and eight different tiles, and a ninth is turned away", ninth.status === 409 && p8.length === 8 && new Set(p8.map((p) => p.x + "," + p.y)).size === 8 && p8.every((p) => inner.has(p.x + "," + p.y)));
  check("the 9th join attempt fails with a clear message: 'This game is full.'", ninth.status === 409 && ninth.data.error === "This game is full." && d1(state, `SELECT COUNT(*) AS n FROM players WHERE game_id = '${gidOf("eight")}'`)[0].n === 8);
  check("the full join page offers no free piece", (await client(A).get(`/eight/join/${big.code}`)).text.includes("This game is full"));
  // the seat limit is enforced atomically when the link is finished: two people finishing for the last seat
  const last = await createGame(state, { slug: "last", max: 2, ...R });
  await join(A, "last", last.code, { email: "l0@example.com", name: "L0", color: "teal" });
  const lc1 = client(A), lc2 = client(A);
  const lj1 = await lc1.post("/last/api/join", { code: last.code, email: "l1@example.com", name: "L1", color: "cobalt" });
  const lj2 = await lc2.post("/last/api/join", { code: last.code, email: "l2@example.com", name: "L2", color: "orchid" });
  const [lv1, lv2] = await Promise.all([finish(lc1, lj1.data.dev_link), finish(lc2, lj2.data.dev_link)]);
  const lloc = [lv1, lv2].map((v) => v.headers.get("location"));
  check("two people finishing for the last seat at once: exactly one gets it, the other is told the join failed", playersOf("last").length === 2 && lloc.filter((l) => l.includes("notice=joined")).length === 1 && lloc.filter((l) => l.includes("notice=join-failed")).length === 1, lloc.join());
  check("max_players is read from the game's settings, and nothing else caps seats", getSettings(d1(state, "SELECT settings FROM games WHERE slug = 'last'")[0].settings).max_players === 2 && getSettings(d1(state, "SELECT settings FROM games WHERE slug = 'eight'")[0].settings).max_players === 8);
  // spawn is random: over many fresh games the first piece does not always land on the same tile
  const spots = new Set();
  for (let i = 0; i < 6; i++) { const slug = `rnd${i}`; const gg = await createGame(state, { slug, max: 2, ...R }); await join(A, slug, gg.code, { email: "r@example.com", name: "R", color: "teal" }); const p = playersOf(slug)[0]; spots.add(p.x + "," + p.y); }
  check("spawn is random: six games put the first piece on more than one tile", spots.size > 1, [...spots].join(" "));
  // no room: an island too small to have a fully charted shape around any tile
  const tiny = await createGame(state, { slug: "tiny", max: 2, ...R });
  d1(state, `UPDATE games SET settings = '{"board.island":{"width":4,"height":4},"max_players":2}' WHERE slug = 'tiny'`);
  const tc = client(A);
  const tj = await tc.post("/tiny/api/join", { code: tiny.code, email: "t1@example.com", name: "T1", color: "teal" });
  const tv = await finish(tc, tj.data.dev_link);
  check("a game whose island is 4x4 has no spawn spot (settings edited by hand, since create-game refuses it): the join fails with the 'no room on the map yet' notice and takes no seat", tv.status === 303 && tv.headers.get("location") === "/tiny/?notice=no-room" && playersOf("tiny").length === 0, tv.headers.get("location"));
  // occupied spots: a 6x6 island has exactly 4 spawn spots; with the seat limit forced to 5 by hand, the 5th joiner has none left
  const one = await createGame(state, { slug: "one", max: 4, size: 6, ...R });
  d1(state, `UPDATE games SET settings = '{"board.island":{"width":6,"height":6},"max_players":5}' WHERE slug = 'one'`);
  for (let i = 0; i < 4; i++) await join(A, "one", one.code, { email: `o${i}@example.com`, name: `O${i}`, color: COLORS[i] });
  const oc = client(A), oj = await oc.post("/one/api/join", { code: one.code, email: "o9@example.com", name: "O9", color: "sky" });
  const ov = await finish(oc, oj.data.dev_link);
  check("all 4 spawn spots are occupied (two pieces cannot share): the 5th join fails with the no-room notice, and the first four stood on four different tiles", playersOf("one").length === 4 && new Set(playersOf("one").map((q) => q.x + "," + q.y)).size === 4 && ov.status === 303 && ov.headers.get("location") === "/one/?notice=no-room", ov.headers.get("location"));

  console.log("moves");
  const post = (c, body, slug = "hex") => c.post(`/${slug}/api/action`, body);
  const gameOf = async (slug = "hex") => (await client(A).get(`/${slug}/api/game`)).data.game;
  const posOf = (slug, n) => playersOf(slug)[n];
  const setPos = (slug, n, x, y, z = 0) => d1(state, `UPDATE players SET x = ${x}, y = ${y}, z = ${z} WHERE game_id = '${gidOf(slug)}' AND turn_order = ${n}`);
  // A game in play on an open day (day 1, ending far in the future: these tests run on the real clock), with nothing done
  // yet today, or with player `turn` already moved. (There is no turn order any more; `turn` only picks that player.)
  const setTurn = (slug, turn = 0, moved = false, settings = "{}") => d1(state, [
    `UPDATE games SET status = 'playing', settings = '${settings}', day = CASE WHEN day = 0 THEN 1 ELSE day END, phase = 'open' WHERE slug = '${slug}'`,
    `INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) SELECT id, day, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open' FROM games WHERE slug = '${slug}'`,
    `DELETE FROM day_turns WHERE game_id = (SELECT id FROM games WHERE slug = '${slug}')`,
    ...(moved ? [`INSERT INTO day_turns (game_id, day, player_id, moved_at) SELECT g.id, g.day, p.id, '2026-01-01T00:00:00.000Z' FROM games g JOIN players p ON p.game_id = g.id AND p.turn_order = ${turn} WHERE g.slug = '${slug}'`] : []),
  ].join("; "));
  const movedToday = (slug = "hex", n = 0) => d1(state, `SELECT COUNT(*) AS n FROM day_turns t JOIN games g ON g.id = t.game_id AND g.day = t.day JOIN players p ON p.id = t.player_id AND p.turn_order = ${n} WHERE g.slug = '${slug}' AND t.moved_at IS NOT NULL`)[0].n === 1;
  check("logged out is 401", (await post(client(A), { kind: "move", x: 0, y: 0 })).status === 401);
  const early = await post(ana, { kind: "move", x: 0, y: 0 });
  check("in setup, a move is refused (409) and nothing changes", early.status === 409 && /not started/i.test(early.data.error));
  setTurn("hex");
  setPos("hex", 0, 0, 0); setPos("hex", 1, 3, 3); setPos("hex", 2, -3, -3);
  check("an unknown kind is refused, including the removed claim and describe", (await post(ana, { kind: "teleport", x: 0, y: 0 })).status === 400 && (await post(ana, { kind: "claim", x: 0, y: 0 })).status === 400 && (await post(ana, { kind: "describe", x: 0, y: 0, name: "n", description: "d" })).status === 400 && (await post(ana, { x: 0, y: 0 })).status === 400);
  const oot = await post(bo, { kind: "move", x: 2, y: 2 }); // inward, so it charts nothing the later checks rely on being blank
  check("there is no order of play (rule 202.1): Bo, who joined second, moves the same day", oot.status === 200 && J([posOf("hex", 1).x, posOf("hex", 1).y]) === "[2,2]", oot.text);
  setPos("hex", 1, 3, 3);
  check("not a label, or a label with a zero row or column, is refused (400)", (await post(ana, { kind: "move", label: "0N 1E" })).status === 400 && (await post(ana, { kind: "move", label: "A1" })).status === 400 && (await post(ana, { kind: "move", x: 0.5, y: 0 })).status === 400 && (await post(ana, { kind: "move" })).status === 400);
  const far = await post(ana, { kind: "move", x: 2, y: 0 });
  check("two steps away is refused (400): the piece stays and no move is used", far.status === 400 && /step/.test(far.data.error) && posOf("hex", 0).x === 0 && !movedToday(), far.text);
  check("so is the tile you already stand on", (await post(ana, { kind: "move", x: 0, y: 0 })).status === 400);
  const lvl = await post(ana, { kind: "move", x: 1, y: 0, z: 1 });
  check("a different level is refused for now (400)", lvl.status === 400 && /level/.test(lvl.data.error), lvl.text);
  const logBefore = (await client(A).get("/hex/api/game")).data.events.length;
  const diag = await post(ana, { kind: "move", x: 1, y: 1 });
  check("a diagonal step succeeds (P1: diagonals count)", diag.status === 200 && diag.data.ok && diag.data.at.label === "2N 2E 1U" && J([posOf("hex", 0).x, posOf("hex", 0).y, posOf("hex", 0).z]) === "[1,1,0]", diag.text);
  check("the move is logged, naming the tile, and the turn did NOT end (a move is in addition to proposing)", (await client(A).get("/hex/api/game")).data.events[0].text === "Ana (Teal) moved to 2N 2E 1U." && (await client(A).get("/hex/api/game")).data.events.length === logBefore + 1 && movedToday() && !(await ana.get("/hex/api/day")).data.you.ended);
  const again = await post(ana, { kind: "move", x: 2, y: 1 });
  check("a second move the same day is refused (409), at most one a day", again.status === 409 && again.data.error === "You already moved today." && posOf("hex", 0).x === 1, again.text);
  const prp = await ana.post("/hex/api/turn", { kind: "addclause", target: "101", words: "Let there be cats." });
  check("after moving, the same player can still propose a rule change this turn", prp.status === 200 && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gidOf("hex")}' AND status = 'confirmed'`)[0].n === 1, prp.text);
  check("and a proposal does not end the turn", !(await ana.get("/hex/api/day")).data.you.ended);
  // the other order: propose first, then move
  const pa = await join(A, "prop", prop.code, { email: "pa@example.com", name: "Pa", color: "vermilion" });
  const pb = await join(A, "prop", prop.code, { email: "pb@example.com", name: "Pb", color: "onyx" });
  setTurn("prop"); setPos("prop", 0, 0, 0); setPos("prop", 1, 1, 0);
  const prp2 = await pa.post("/prop/api/turn", { kind: "addclause", target: "101", words: "Rain, but only on Tuesdays." });
  const mv2 = await post(pa, { kind: "move", x: -1, y: 1 }, "prop");
  check("propose first, then move: both land in the same turn", prp2.status === 200 && mv2.status === 200 && posOf("prop", 0).x === -1, mv2.text);
  setTurn("prop", 0, false); setPos("prop", 0, 0, 0); setPos("prop", 1, 1, 0);
  const occ = await post(pa, { kind: "move", x: 1, y: 0 }, "prop");
  check("a move onto a tile another piece stands on is refused (409): two pieces cannot share a tile", occ.status === 409 && /another piece/i.test(occ.data.error) && posOf("prop", 0).x === 0 && !movedToday("prop"), occ.text);
  check("and the other player may move the same day", (await post(pb, { kind: "move", x: 2, y: 0 }, "prop")).status === 200);
  // uncharted destination
  setTurn("hex"); setPos("hex", 0, 3, 0);
  const unc = await post(ana, { kind: "move", x: 4, y: 0 }); // one step past the island's east edge (x 3): uncharted
  check("moving onto an uncharted tile is refused (400) and uses no move", unc.status === 400 && /not charted/.test(unc.data.error) && !movedToday() && posOf("hex", 0).x === 3, unc.text);
  // seams: 1N 1W -> 1S 1E in one diagonal step, by label
  setTurn("hex"); setPos("hex", 0, -1, 0);
  const seam = await post(ana, { kind: "move", label: "1s 1e" });
  check("across both seams in one diagonal step: 1N 1W to 1S 1E, named by label", seam.status === 200 && J([posOf("hex", 0).x, posOf("hex", 0).y]) === "[0,-1]", seam.text);
  // facing: a piece turns toward the way it moved on screen (right on screen is east minus north)
  const faceOf = () => d1(state, `SELECT mirrored FROM players WHERE game_id = '${gidOf("hex")}' AND turn_order = 0`)[0].mirrored;
  check("a move to the right on screen (east, or south) mirrors the piece; the board API says so", faceOf() === 1 && (await client(A).get("/hex/api/board")).data.pieces[0].mirrored === true);
  setTurn("hex"); setPos("hex", 0, 0, -1);
  const west = await post(ana, { kind: "move", x: -1, y: -1 });
  check("a move to the left on screen (west, or north) turns it back", west.status === 200 && faceOf() === 0 && (await client(A).get("/hex/api/board")).data.pieces[0].mirrored === false, west.text);
  setTurn("hex"); setPos("hex", 0, -1, -1);
  const north = await post(ana, { kind: "move", x: 0, y: 0 });
  check("a move straight up the screen (north-east, a pure diagonal) keeps the way the piece faces", north.status === 200 && faceOf() === 0 && (setTurn("hex"), true) && (await post(ana, { kind: "move", x: 1, y: 0 })).status === 200 && faceOf() === 1 && (setTurn("hex"), true) && (await post(ana, { kind: "move", x: 0, y: -1 })).status === 200 && faceOf() === 1, north.text);
  // chart on move
  setTurn("hex"); setPos("hex", 0, 3, 0);
  d1(state, `INSERT INTO tiles (game_id, x, y, z, charted_at) VALUES ('${gidOf("hex")}', 4, 0, 0, 'x')`);
  const before = new Set(tilesOf("hex").map(tkey));
  const edge = await post(ana, { kind: "move", label: "1N 5E" });
  const after = tilesOf("hex"), afterSet = new Set(after.map(tkey));
  const shape = chartedAround(4, 0, 2).map(([x, y]) => `${x},${y},0`);
  const expected = new Set([...before, ...shape]);
  check("moving past the island edge charts the 21-tile shape around the new position, and only that", edge.status === 200 && shape.length === 21 && shape.every((k) => afterSet.has(k)) && afterSet.size === expected.size && [...afterSet].every((k) => expected.has(k)) && afterSet.size > before.size, `${before.size} -> ${afterSet.size}`);
  check("the new tiles are blank: just a place, and a charted time", d1(state, `SELECT COUNT(*) AS n FROM tiles WHERE game_id = '${gidOf("hex")}' AND charted_at IS NULL`)[0].n === 0);
  check("the corners of the shape stay uncharted", [[6, 2], [6, -2], [2, 2 + 0]].slice(0, 2).every(([x, y]) => !afterSet.has(`${x},${y},0`)) && afterSet.has("6,1,0") && afterSet.has("6,0,0"));
  setTurn("hex"); setPos("hex", 0, 4, 0);
  const n1 = tilesOf("hex").length;
  const back = await post(ana, { kind: "move", x: 3, y: 0 });
  check("charting a charted tile is a no-op: moving back changes no tile (insert-if-absent)", back.status === 200 && tilesOf("hex").length === n1, `${n1} -> ${tilesOf("hex").length}`);
  // the move distance setting
  setTurn("hex", 0, false, '{"turn.move_distance":2}'); setPos("hex", 0, 0, 0);
  const two = await post(ana, { kind: "move", x: 2, y: 1 });
  check("the move distance is a setting: with 2, a two-step move succeeds", two.status === 200 && posOf("hex", 0).x === 2, two.text);
  setTurn("hex", 0, false, '{"turn.move_distance":2}'); setPos("hex", 0, 0, 0);
  check("and three steps still fails", (await post(ana, { kind: "move", x: 3, y: 0 })).status === 400);
  // two simultaneous moves
  let raceOk = true, raceWhy = "";
  for (let i = 0; i < 6; i++) {
    setTurn("hex"); setPos("hex", 0, 0, 0); setPos("hex", 1, 3, 3);
    const [r1, r2] = await Promise.all([post(ana, { kind: "move", x: 1, y: 0 }), post(ana, { kind: "move", x: 0, y: 1 })]);
    const ok = [r1.status, r2.status].filter((x) => x === 200).length === 1 && [r1, r2].filter((r) => r.status !== 200).every((r) => r.status === 409);
    const events = d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gidOf("hex")}' AND kind = 'piece_moved'`)[0].n;
    if (!ok || !movedToday()) { raceOk = false; raceWhy = `${r1.status} ${r1.text} | ${r2.status} ${r2.text} moved=${movedToday()} events=${events}`; break; }
  }
  check("two simultaneous moves from one player, 6 times: exactly one lands, the other is refused 409, the day is marked as moved", raceOk, raceWhy);
  // (the confirm statement's own day and turn guard is tested in tests/day.mjs and tests/proposals.mjs, against CONFIRM_SQL)
  check("/api/day reports whether you have moved today, and a new day needs no reset (day_turns is per day)", (setTurn("hex", 0, false), (await ana.get("/hex/api/day")).data.you.moved === false) && (setTurn("hex", 0, true), (await ana.get("/hex/api/day")).data.you.moved === true) &&
    (() => { d1(state, `INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at) VALUES ('${gidOf("hex")}', 2, '2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z'); UPDATE games SET day = 2 WHERE slug = 'hex'`); return true; })() && (await ana.get("/hex/api/day")).data.you.moved === false && (d1(state, "UPDATE games SET day = 1 WHERE slug = 'hex'"), true));
  console.log("the public board");
  const raw = await client(A).get("/hex/api/board");
  const pb2 = raw.data;
  check("it is public and never cached", raw.status === 200 && raw.headers.get("cache-control") === "no-store");
  check("it has no email addresses and no ids", !raw.text.includes("@") && !/"(id|player_id|owner_player_id|game_id|email)"/.test(raw.text), raw.text.slice(0, 200));
  check("a tile is only a place: x, y, z and a label, with no properties, terrain, owner or name", pb2.tiles.every((t) => J(Object.keys(t).sort()) === '["label","x","y","z"]') && !/terrain|props|owner|description/.test(raw.text));
  check("every tile and piece carries x, y, z and a full label like '3N 2E 1U'", pb2.tiles.every((t) => t.z === 0 && /^[1-9][0-9]*[NS] [1-9][0-9]*[EW] 1U$/.test(t.label)) && pb2.pieces.length === 3 && pb2.pieces.every((p) => Number.isInteger(p.at.x) && Number.isInteger(p.at.y) && p.at.z === 0 && /^[1-9][0-9]*[NS] [1-9][0-9]*[EW] 1U$/.test(p.at.label)));
  check("pieces report color, score and place; the board reports its settings and the move rules", pb2.pieces[0].color.key === "teal" && pb2.pieces[0].score === 0 && J(pb2.settings) === J(getSettings(d1(state, "SELECT settings FROM games WHERE slug = 'hex'")[0].settings)) && pb2.rules.move_distance === 1 && pb2.rules.diagonal_moves === true && pb2.rules.shared_tiles === false);
  check("an unknown game is 404", (await client(A).get("/nope/api/board")).status === 404);
  check("every piece stands on a charted tile", pb2.pieces.every((p) => pb2.tiles.some((t) => t.x === p.at.x && t.y === p.at.y && t.z === p.at.z)));

  console.log("legacy games");
  const gid = "11111111-2222-3333-4444-555555555555";
  d1(state, `INSERT INTO games (id, slug, name, repo, join_code, status, settings, created_at) VALUES ('${gid}','old','Old game','a/b','ZZZZ2222','setup','{"board.island":{"width":6,"height":4}}','2026-01-01T00:00:00Z')`);
  const lazy = (await client(A).get("/old/api/board")).data;
  check("a game with no tiles gets its island from its stored settings the first time the board is read: 6x4 centered (3W..3E, 2N..2S)", lazy.tiles.length === 24 && Math.min(...lazy.tiles.map((t) => t.x)) === -3 && Math.max(...lazy.tiles.map((t) => t.x)) === 2 && Math.min(...lazy.tiles.map((t) => t.y)) === -2 && Math.max(...lazy.tiles.map((t) => t.y)) === 1);

  d1(state, `DELETE FROM tiles WHERE game_id = '${gid}' AND x = -3 AND y IN (-2, -1, 0)`);
  check("a cut-short island is completed the next time the board is read (6x4 again, 24 tiles); a full one is left alone", tilesOf("old").length === 21 && (await client(A).get("/old/api/board")).data.tiles.length === 24 && tilesOf("old").length === 24 && (await client(A).get("/old/api/board")).data.tiles.length === 24);
  const pg = (await client(A).get("/hex/api/game")).data.game, bg0 = (await client(A).get("/hex/api/board")).data.game;
  check("/api/game and /api/board report the day, not the old turn model (no turn, round, moved or move counter)", pg.day === 1 && bg0.day === 1 && ["turn", "round", "moved", "moves"].every((k) => !(k in pg) && !(k in bg0)), J([pg, bg0]));

  // ---------------------------------------------------------------- the game's MCP server
  console.log("mcp server");
  const SITE = "http://hex.test"; // the server's SITE_URL: the Origin the consent form must come from, and the issuer
  const mg = await createGame(state, { slug: "pilot", name: "Pilot game", max: 2, ...R });
  const mia = await join(A, "pilot", mg.code, { email: "mia@example.com", name: "Mia", color: "teal" });
  const max = await join(A, "pilot", mg.code, { email: "max@example.com", name: "Max", color: "cobalt" });
  setTurn("pilot"); setPos("pilot", 0, 0, 0); setPos("pilot", 1, 3, 3);
  const noLeak = (t) => !/@example\.com/.test(t);

  console.log("  discovery");
  const prm = await client(A).get("/.well-known/oauth-protected-resource/pilot/mcp");
  check("the protected-resource document names this game's MCP address and its own sign-in server", prm.status === 200 && prm.data.resource === `${SITE}/pilot/mcp` && J(prm.data.authorization_servers) === J([`${SITE}/pilot`]), prm.text);
  const asm = await client(A).get("/.well-known/oauth-authorization-server/pilot");
  check("the authorization-server document: code + refresh grants, PKCE S256 only, public clients, endpoints under the game",
    asm.status === 200 && asm.data.issuer === `${SITE}/pilot` && asm.data.authorization_endpoint === `${SITE}/pilot/oauth/authorize` && asm.data.token_endpoint === `${SITE}/pilot/oauth/token` && asm.data.registration_endpoint === `${SITE}/pilot/oauth/register` &&
    J(asm.data.code_challenge_methods_supported) === '["S256"]' && J(asm.data.token_endpoint_auth_methods_supported) === '["none"]' && J(asm.data.grant_types_supported) === '["authorization_code","refresh_token"]', asm.text);
  check("it is also served under the issuer, and an unknown game or a wrong shape is a 404", (await client(A).get("/pilot/.well-known/oauth-authorization-server")).data?.issuer === `${SITE}/pilot` && (await client(A).get("/.well-known/oauth-authorization-server/nope")).status === 404 && (await client(A).get("/.well-known/oauth-protected-resource/pilot")).status === 404 && (await client(A).get("/.well-known/oauth-authorization-server/pilot/mcp")).status === 404);
  const pre = await fetch(`${A}/pilot/mcp`, { method: "OPTIONS", headers: { origin: "https://agent.example", "access-control-request-method": "POST" } });
  check("a browser client's preflight is answered (204, CORS), for the MCP address and the token endpoint", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*" && /authorization/.test(pre.headers.get("access-control-allow-headers")) && (await fetch(`${A}/pilot/oauth/token`, { method: "OPTIONS" })).status === 204);

  console.log("  who may connect");
  const none = await mcp(A, "pilot", null, "tools/list", {});
  check("no token: 401, with a WWW-Authenticate that points at the protected-resource document", none.status === 401 && none.headers.get("www-authenticate") === `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/pilot/mcp"` && /Sign in/.test(none.data.error.message), none.text);
  check("a made-up token is refused (401)", (await mcp(A, "pilot", "x".repeat(43), "tools/list", {})).status === 401 && (await mcp(A, "pilot", "short", "tools/list", {})).status === 401);
  check("MCP only answers POST (405 otherwise): there is no stream to open and no session to end", (await client(A).get("/pilot/mcp")).status === 405 && (await client(A).req("DELETE", "/pilot/mcp")).status === 415);
  const reg = (body) => fetch(`${A}/pilot/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const regBad = async (b) => { const r = await reg(b); return r.status === 400 ? (await r.json()).error : r.status; };
  check("registration refuses return addresses that are not https or localhost http, scripts, fragments, none, too many; and any client that wants a secret",
    (await regBad({ redirect_uris: ["http://evil.example/cb"] })) === "invalid_redirect_uri" && (await regBad({ redirect_uris: ["javascript:alert(1)"] })) === "invalid_redirect_uri" && (await regBad({ redirect_uris: ["https://a.example/cb#x"] })) === "invalid_redirect_uri" &&
    (await regBad({ redirect_uris: [] })) === "invalid_redirect_uri" && (await regBad({})) === "invalid_redirect_uri" && (await regBad({ redirect_uris: Array(6).fill("https://a.example/cb") })) === "invalid_redirect_uri" &&
    (await regBad({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" })) === "invalid_client_metadata" && (await regBad({ redirect_uris: ["https://a.example/cb"], client_name: "   " })) === "invalid_client_metadata");
  const loop = await reg({ client_name: "Local app", redirect_uris: ["http://127.0.0.1:5555/cb", "https://a.example/cb"] });
  check("a loopback http address and an https one are accepted (201), as a public client", loop.status === 201 && (await loop.json()).token_endpoint_auth_method === "none");
  const cid = await registerClient(A, "pilot");
  const pk = newPkce();
  const authUrl = (o = {}, c = cid, p = pk, r = "https://agent.example/cb") => `/pilot/oauth/authorize?${authorizeQuery(c, p, r, o)}`;
  const web = client(A);
  const unreg = await web.get(authUrl({}, cid, pk, "https://evil.example/cb"));
  check("a return address the client did not register is a page, never a redirect (400)", unreg.status === 400 && !unreg.headers.get("location") && /did not register|not one this app registered/.test(unreg.text));
  check("an unknown client is a page too; so is a client registered on another game", (await web.get(authUrl({}, "nope"))).status === 400 && (await web.get(`/one/oauth/authorize?${authorizeQuery(cid, pk)}`)).status !== 200);
  const plain = await web.get(authUrl({ code_challenge_method: "plain" }));
  check("PKCE plain is refused: back to the client with invalid_request", plain.status === 303 && new URL(plain.headers.get("location")).searchParams.get("error") === "invalid_request" && new URL(plain.headers.get("location")).searchParams.get("state") === "st-1");
  check("so is a response type other than code", new URL((await web.get(authUrl({ response_type: "token" }))).headers.get("location")).searchParams.get("error") === "unsupported_response_type");
  const wrongRes = await web.get(authUrl({ resource: "https://other.example/mcp" }));
  check("a resource that is not this game's MCP address is refused (invalid_target); this game's own is accepted", new URL(wrongRes.headers.get("location")).searchParams.get("error") === "invalid_target" && (await web.get(authUrl({ resource: `${SITE}/pilot/mcp` }))).status === 200);
  const login = await web.get(authUrl());
  check("signed out, the authorize page asks for an email and offers no Allow button", login.status === 200 && /Email me a log-in link/.test(login.text) && !/>Allow</.test(login.text));
  const fields = (o = {}) => ({ ...Object.fromEntries(new URLSearchParams(authorizeQuery(cid, pk))), ...o });
  const stranger = await web.form("/pilot/oauth/authorize", fields({ step: "login", email: "stranger@example.com" }), { origin: SITE });
  const decoy = /href="([^"]+auth\/verify[^"]+)"/.exec(stranger.text)?.[1];
  check("an address with no seat gets the same page as one that has (and a decoy link)", stranger.status === 200 && /If that address has joined this game/.test(stranger.text) && !!decoy);
  const dv = await finish(client(A), decoy);
  check("the decoy link gives no session and no redirect: it is the expired-link page", dv.status === 400 && !dv.headers.getSetCookie().length);
  const noSess = await web.form("/pilot/oauth/authorize", fields({ step: "decide", decision: "allow" }), { origin: SITE });
  check("without a session, 'Allow' gives no code: it goes back to the authorize page", noSess.status === 303 && new URL(noSess.headers.get("location"), SITE).pathname === "/pilot/oauth/authorize" && !/code=/.test(noSess.headers.get("location")));
  check("the consent form must come from the site itself (403 with a foreign or no Origin)", (await mia.form("/pilot/oauth/authorize", fields({ step: "decide", decision: "allow" }), { origin: "http://evil.example" })).status === 403 && (await mia.form("/pilot/oauth/authorize", fields({ step: "decide", decision: "allow" }))).status === 403 && d1(state, "SELECT COUNT(*) AS n FROM oauth_codes")[0].n === 0);

  console.log("  signing in through the game's magic link");
  const maxOut = client(A);
  const lg = await maxOut.form("/pilot/oauth/authorize", fields({ step: "login", email: "MAX@example.com" }), { origin: SITE });
  const lgLink = /href="([^"]+auth\/verify[^"]+)"/.exec(lg.text)?.[1];
  const nextSaved = d1(state, "SELECT next FROM login_tokens WHERE next IS NOT NULL ORDER BY created_at DESC LIMIT 1")[0]?.next;
  check("Max asks for a link: the same page, and the link remembers the authorize page it came from", lg.status === 200 && !!lgLink && /^\/pilot\/oauth\/authorize\?/.test(nextSaved || "") && new URLSearchParams(nextSaved.split("?")[1]).get("client_id") === cid);
  const lv = await finish(maxOut, lgLink);
  check("clicking Continue signs him in and sends him back to the consent page (not the board)", lv.status === 303 && lv.headers.get("location") === nextSaved && lv.headers.getSetCookie().some((c) => /^s=/.test(c)), lv.headers.get("location"));
  const cp = await maxOut.get(lv.headers.get("location"));
  check("the consent page puts the host the code goes to first, then the app's own name, and says as whom; with Allow and Deny", cp.status === 200 && /agent\.example \(Test Agent\) wants to play as Max/.test(cp.text) && />Allow</.test(cp.text) && />Deny</.test(cp.text), cp.text.slice(-500));
  const deny = await consent(A, "pilot", maxOut, cid, pk, undefined, "deny", SITE);
  check("Deny goes back to the client with access_denied and its state, and stores no code", deny.status === 303 && deny.headers.get("location") === "https://agent.example/cb?error=access_denied&state=st-1" && d1(state, "SELECT COUNT(*) AS n FROM oauth_codes")[0].n === 0, deny.headers.get("location"));
  const allow = await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE);
  const aloc = new URL(allow.headers.get("location"));
  check("Allow goes back with a one-time code and the state; only a hash of the code is stored", allow.status === 303 && aloc.origin + aloc.pathname === "https://agent.example/cb" && aloc.searchParams.get("state") === "st-1" && !!aloc.searchParams.get("code") && d1(state, "SELECT code_hash FROM oauth_codes").every((r) => /^[0-9a-f]{64}$/.test(r.code_hash) && r.code_hash !== aloc.searchParams.get("code")));
  const code = aloc.searchParams.get("code");
  const wrongV = await exchange(A, "pilot", cid, code, newPkce().verifier);
  check("a wrong PKCE verifier is refused (invalid_grant) and burns the code", wrongV.status === 400 && wrongV.data.error === "invalid_grant" && (await exchange(A, "pilot", cid, code, pk.verifier)).status === 400);
  const code2 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  check("a code does not work with another return address", (await exchange(A, "pilot", cid, code2, pk.verifier, "https://agent.example/other")).status === 400);
  const code3 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  const otherClient = await registerClient(A, "pilot", "Other Agent");
  check("a code does not work for another client", (await exchange(A, "pilot", otherClient, code3, pk.verifier)).status === 400);
  // (a code is claimed before it is checked, so each refusal above spent its code: a fresh one for the good exchange)
  const code4 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  const good = await exchange(A, "pilot", cid, code4, pk.verifier);
  check("the right code and verifier give an access token (1 hour) and a refresh token; only hashes are stored", good.status === 200 && good.data.token_type === "Bearer" && good.data.expires_in === 3600 && !!good.data.access_token && !!good.data.refresh_token && d1(state, "SELECT token_hash FROM oauth_tokens").every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)) && d1(state, `SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = '${good.data.access_token}'`)[0].n === 0);
  check("the same code cannot be used twice", (await exchange(A, "pilot", cid, code4, pk.verifier)).status === 400);
  check("a client of another game is not known here (401 invalid_client)", (await exchange(A, "prop", cid, code4, pk.verifier)).status === 401);
  check("and presenting a spent code again revokes what was issued from it", (await mcp(A, "pilot", good.data.access_token, "tools/list", {})).status === 401 && d1(state, `SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = '${cid}'`)[0].n === 0);
  const code5 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  const good2 = await exchange(A, "pilot", cid, code5, pk.verifier);
  const tokMax = good2.data.access_token;
  check("replaying the first code again does not touch a later sign-in of the same app and player: only that grant's tokens go", (await exchange(A, "pilot", cid, code4, pk.verifier)).status === 400 && (await mcp(A, "pilot", tokMax, "tools/list", {})).status === 200);
  const code7 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  const g7 = await exchange(A, "pilot", cid, code7, pk.verifier);
  const r7 = await (await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: cid, refresh_token: g7.data.refresh_token })).json();
  const otherReplay = await exchange(A, "pilot", otherClient, code7, pk.verifier);
  check("another client presenting a spent code gets nothing and revokes nothing", otherReplay.status === 400 && (await mcp(A, "pilot", r7.access_token, "tools/list", {})).status === 200);
  check("a grant stays one grant through a refresh: replaying its code revokes the refreshed pair, and not the other grant's", (await exchange(A, "pilot", cid, code7, pk.verifier)).status === 400 && (await mcp(A, "pilot", r7.access_token, "tools/list", {})).status === 401 && (await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: cid, refresh_token: r7.refresh_token })).status === 400 && (await mcp(A, "pilot", tokMax, "tools/list", {})).status === 200);
  const mailed = d1(state, "SELECT body FROM outbox WHERE to_addr = 'max@example.com' ORDER BY id DESC LIMIT 1")[0]?.body ?? "";
  check("the log-in email says which host the AI client will be sent to", /connect an AI client at agent\.example\./.test(mailed), mailed.slice(0, 200));
  const longState = "s".repeat(500);
  const cLong = client(A);
  const lgLong = await cLong.form("/pilot/oauth/authorize", fields({ step: "login", email: "max@example.com", state: longState }), { origin: SITE });
  const lvLong = await finish(cLong, /href="([^"]+auth\/verify[^"]+)"/.exec(lgLong.text)?.[1]);
  const cjk = client(A);
  const lgCjk = await cjk.form("/pilot/oauth/authorize", fields({ step: "login", email: "mia@example.com", state: "\u5b57".repeat(500) }), { origin: SITE });
  const lvCjk = await finish(cjk, /href="([^"]+auth\/verify[^"]+)"/.exec(lgCjk.text)?.[1]);
  check("500 characters that each take nine bytes once encoded still make the whole trip (the return path allowance fits every accepted request)", lvCjk.status === 303 && /^\/pilot\/oauth\/authorize\?/.test(lvCjk.headers.get("location")) && (await cjk.get(lvCjk.headers.get("location"))).text.includes(">Allow<"), String(lvCjk.headers.get("location")).slice(0, 100));
  check("the longest state (500 characters) survives the trip through the log-in link to the consent page; a longer one is refused up front, not cut",
    lvLong.status === 303 && /^\/pilot\/oauth\/authorize\?/.test(lvLong.headers.get("location")) && (await cLong.get(lvLong.headers.get("location"))).text.includes(">Allow<") &&
    new URL((await web.get(authUrl({ state: "s".repeat(501) }))).headers.get("location")).searchParams.get("error") === "invalid_request");
  const code6 = new URL((await consent(A, "pilot", maxOut, cid, pk, undefined, "allow", SITE)).headers.get("location")).searchParams.get("code");
  d1(state, `UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code_hash = '${sha256Hex(code6)}'`);
  check("a code past its ten minutes is refused", (await exchange(A, "pilot", cid, code6, pk.verifier)).status === 400);

  // Mia is already signed in on the board: consent is one click.
  const mt = await connect(A, "pilot", mia, SITE);
  const tokMia = mt.access_token;
  check("a player already signed in on the board connects in one step", !!tokMia && tokMia !== tokMax);

  console.log("  the tools");
  const init = await mcp(A, "pilot", tokMia, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check("initialize answers, naming the game and the player", init.status === 200 && init.data.result.serverInfo.name === "promptocracy-pilot" && /Pilot game as Mia/.test(init.data.result.instructions), init.text);
  const TOOLS = ["cancel_ticket", "confirm_proposal", "draft_proposal", "end_turn", "hold_ticket", "list_tickets", "move", "my_state", "name_era", "post_to_ticket", "propose", "read_ballot", "read_board", "read_day", "read_proposals", "read_rules", "read_ticket", "reopen_ticket", "resume_ticket", "start_game", "vote", "withdraw_proposal"];
  // The SDK's own client, as an AI app would use it: initialize, the initialized notification, list, call.
  const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const sdk = new SdkClient({ name: "test-client", version: "1" });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`${A}/pilot/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokMia}` } } }));
    const sdkTools = await sdk.listTools();
    const sdkState = await sdk.callTool({ name: "my_state", arguments: {} });
    check("the SDK's own client connects with the token, lists the 22 tools and calls one", J(sdkTools.tools.map((t) => t.name).sort()) === J(TOOLS) && JSON.parse(sdkState.content[0].text).you.name === "Mia" && sdk.getServerVersion()?.name === "promptocracy-pilot");
  } catch (e) { check("the SDK's own client connects with the token, lists the 22 tools and calls one", false, String(e?.stack || e)); }
  finally { await sdk.close().catch(() => {}); }
  const list = await mcp(A, "pilot", tokMia, "tools/list", {});
  check("the tools are read_rules, read_board, read_day, read_proposals, read_ballot, my_state, draft_proposal, confirm_proposal, withdraw_proposal, propose, vote, move, end_turn, start_game, and the workshop's list_tickets, read_ticket, reopen_ticket, hold_ticket, resume_ticket, cancel_ticket and post_to_ticket: no catch-all action yet", J(list.data.result.tools.map((t) => t.name).sort()) === J(TOOLS), list.text);
  const annot = (n) => list.data.result.tools.find((t) => t.name === n).annotations;
  check("the read tools say they only read; the draft, confirm, withdraw, propose, vote, move and end_turn tools do not", ["read_rules", "read_board", "read_day", "read_proposals", "read_ballot", "my_state"].every((n) => annot(n).readOnlyHint === true) && ["draft_proposal", "confirm_proposal", "withdraw_proposal", "propose", "vote", "move", "end_turn"].every((n) => annot(n).readOnlyHint === false));
  const toolText = (n) => list.data.result.tools.find((t) => t.name === n).description;
  check("end_turn says it is final and has no undo; propose and move say once a day, not once per round", /final/i.test(toolText("end_turn")) && /no undo/i.test(toolText("end_turn")) && /daily limit/i.test(toolText("propose")) && /once a day/i.test(toolText("move")) && !/round|on your turn/i.test(toolText("propose") + toolText("move")));
  check("the proposal tools say drafting is free, confirming is the day's one proposal, ending the turn is final, and the lock returns its message", /free/i.test(toolText("draft_proposal")) && /not yet a proposal/i.test(toolText("draft_proposal")) && /daily limit/i.test(toolText("confirm_proposal")) && /final/i.test(toolText("confirm_proposal")) && /final/i.test(toolText("withdraw_proposal")) && ["draft_proposal", "confirm_proposal", "withdraw_proposal", "propose"].every((n) => /lock/i.test(toolText(n))));
  const rules = await tool(A, "pilot", tokMia, "read_rules");
  check("read_rules returns what /api/rules returns", !rules.isError && rules.text === (await client(A).get("/pilot/api/rules")).text && rules.text === "# Rules\n", rules.text);
  const board = await tool(A, "pilot", tokMia, "read_board");
  check("read_board returns what /api/board returns, with no emails", !board.isError && J(JSON.parse(board.text)) === J((await client(A).get("/pilot/api/board")).data) && noLeak(board.text));
  const dayWeb = (await mia.get("/pilot/api/day")).data;
  const rd = await tool(A, "pilot", tokMia, "read_day");
  const rdData = JSON.parse(rd.text);
  check("read_day returns the day the web route returns: day 1, its end, the lock off, what I may do", !rd.isError && rdData.day === 1 && rdData.ends_at === dayWeb.ends_at && typeof rdData.timezone === "string" && rdData.locked === false && J(rdData.you) === J(dayWeb.you) && rdData.you.can.move.allowed === true && noLeak(rd.text), rd.text);
  const st = await tool(A, "pilot", tokMia, "my_state");
  const s1 = JSON.parse(st.text);
  const b1 = (await client(A).get("/pilot/api/board")).data;
  check("my_state: who I am, where my piece stands, the day and its end, the lock, what I did today, what I can do now",
    s1.you.name === "Mia" && s1.you.turn_order === 0 && s1.you.color === "Teal" && s1.you.score === 0 && s1.you.is_host === true && J(s1.you.at) === J(b1.pieces[0].at) && s1.game.status === "playing" &&
    s1.day.number === 1 && s1.day.ends_at === dayWeb.ends_at && s1.day.timezone === dayWeb.timezone && J(s1.lock) === J({ locked: false, processing_day: null, message: null }) &&
    J(s1.today) === J({ moved: false, proposed: false, proposals: { made: 0, limit: 3 }, ended: false, voted_on: 0, ballot_items: 0 }) && J(s1.you_can) === J(dayWeb.you.can) && noLeak(st.text), st.text);
  check("my_state has no turn order left: no whose_turn, your_turn, round or turn", !("whose_turn" in s1) && !("your_turn" in s1) && !("round" in s1.game) && !("turn" in s1.game));
  const s2 = JSON.parse((await tool(A, "pilot", tokMax, "my_state")).text);
  const maxDay = (await max.get("/pilot/api/day")).data;
  check("Max has a turn today too (no order): his my_state says he may move, propose and end his turn, as the web does", s2.you.name === "Max" && J(s2.you_can) === J(maxDay.you.can) && s2.you_can.move.allowed === true && s2.you_can.propose.allowed === true && s2.you_can.end_turn.allowed === true, J(s2.you_can));
  const pBase = { kind: "reword", target: "101" };
  const emptyP = await tool(A, "pilot", tokMia, "propose", { ...pBase, words: "   " });
  const webEmpty = await mia.post("/pilot/api/proposals", { ...pBase, words: "   " });
  const propRows = () => d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gidOf("pilot")}'`)[0].n;
  check("empty words go through the same validation as the web: same error, nothing recorded", emptyP.isError && emptyP.text === webEmpty.data.error && webEmpty.status === 400 && propRows() === 0, emptyP.text);
  const tooLong = await tool(A, "pilot", tokMia, "propose", { ...pBase, words: "x".repeat(2501) });
  check("so are words over 2500 characters", tooLong.isError && tooLong.text === (await mia.post("/pilot/api/proposals", { ...pBase, words: "x".repeat(2501) })).data.error && propRows() === 0, tooLong.text);
  const noRule = await tool(A, "pilot", tokMia, "propose", { kind: "reword", target: "999", words: "x" });
  check("a rule that does not exist is refused with the web's error", noRule.isError && noRule.text === (await mia.post("/pilot/api/proposals", { kind: "reword", target: "999", words: "x" })).data.error && propRows() === 0, noRule.text);
  const farM = await tool(A, "pilot", tokMia, "move", { x: 3, y: 0 });
  const webFar = await mia.post("/pilot/api/action", { kind: "move", x: 3, y: 0 });
  check("a move out of range: the same error as the web, and the piece stays", farM.isError && farM.text === webFar.data.error && webFar.status === 400 && posOf("pilot", 0).x === 0);
  check("a move with no tile named: the web's error", (await tool(A, "pilot", tokMia, "move", {})).text === (await mia.post("/pilot/api/action", { kind: "move" })).data.error);
  const badLabel = await tool(A, "pilot", tokMia, "move", { label: "0N 1E" });
  check("a label with a zero row is refused with the web's error", badLabel.isError && badLabel.text === (await mia.post("/pilot/api/action", { kind: "move", label: "0N 1E" })).data.error);
  const eventsBefore = (await client(A).get("/pilot/api/game")).data.events.length;
  const cats = { kind: "addclause", target: "101", words: "Cats may vote." };
  const dr = await tool(A, "pilot", tokMia, "draft_proposal", cats);
  const draftId = (dr.text.match(/Draft id: (\S+)/) || [])[1];
  const gmD = (await client(A).get("/pilot/api/game")).data;
  check("draft_proposal returns the draft: its id, the heading, the new text and the votes it needs; it is free and not yet a proposal (a draft row, no log line, still free to propose)",
    !dr.isError && !!draftId && /Add a clause to rule 101/.test(dr.text) && /Cats may vote\./.test(dr.text) && /Needs: unanimous(\n|$)/.test(dr.text) && /only a draft/i.test(dr.text) &&
    d1(state, `SELECT status, kind, target FROM proposals WHERE game_id = '${gidOf("pilot")}'`).map((r) => J(r)).join() === J({ status: "draft", kind: "addclause", target: "101" }) && gmD.events.length === eventsBefore &&
    JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text).today.proposed === false, dr.text);
  const dr2 = await tool(A, "pilot", tokMia, "draft_proposal", cats);
  check("drafting again is allowed (drafting is free and repeatable)", !dr2.isError && /Draft id: /.test(dr2.text) && propRows() === 2);
  const prop1 = await tool(A, "pilot", tokMia, "confirm_proposal", { id: draftId });
  const propRow = d1(state, `SELECT status, number, day_proposed, day_ballot FROM proposals WHERE id = '${draftId}'`)[0];
  const gm = (await client(A).get("/pilot/api/game")).data;
  check("confirm_proposal makes it the day's proposal exactly as the web does: P1, on tomorrow's ballot, the log line, the web's message",
    !prop1.isError && prop1.text === "P1 is on tomorrow's ballot." && J(propRow) === J({ status: "confirmed", number: 1, day_proposed: 1, day_ballot: 2 }) &&
    gm.events.length === eventsBefore + 1 && gm.events[0].kind === "proposal_confirmed" && gm.events[0].text === "Mia (Teal) proposed a change." && gm.game.day === 1, prop1.text);
  const wd = await tool(A, "pilot", tokMia, "withdraw_proposal", { id: draftId });
  check("withdraw_proposal takes it back, until midnight: P1 is withdrawn and the day's proposal is free again", !wd.isError && wd.text === "P1 is withdrawn." && d1(state, `SELECT status FROM proposals WHERE id = '${draftId}'`)[0].status === "withdrawn" && JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text).today.proposed === false, wd.text);
  const wd2 = await tool(A, "pilot", tokMia, "withdraw_proposal", { id: draftId });
  check("a second withdraw is refused with the web's own words, and an id that is not yours is a 404 message", wd2.isError && /P1 is already withdrawn/.test(wd2.text) && (await tool(A, "pilot", tokMax, "withdraw_proposal", { id: draftId })).isError);
  const oneStep = await tool(A, "pilot", tokMia, "propose", cats);
  check("propose is draft + confirm in one call: P2 is on tomorrow's ballot (numbers are never reused)", !oneStep.isError && JSON.parse(oneStep.text).message === "P2 is on tomorrow's ballot." && d1(state, `SELECT number, status FROM proposals WHERE game_id = '${gidOf("pilot")}' AND status = 'confirmed'`).map((r) => J(r)).join() === J({ number: 2, status: "confirmed" }), oneStep.text);
  d1(state, `UPDATE games SET settings = '{"proposals.per_day":1}' WHERE slug = 'pilot'`); // the legacy one-a-day flow below runs at a limit of 1 (tests/proposals-per-day.mjs covers 3)
  const prop2 = await tool(A, "pilot", tokMia, "propose", cats);
  const webTwice = await mia.post("/pilot/api/proposals", cats);
  check("a second proposal the same day is refused with the web's error at a limit of 1: the most a day", prop2.isError && prop2.text === webTwice.data.error && prop2.text === "You've proposed 1 today, the most a day (103.2)." && webTwice.status === 409 && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gidOf("pilot")}' AND status = 'confirmed'`)[0].n === 1);
  const rp = await tool(A, "pilot", tokMia, "read_proposals");
  const rpWeb = await mia.get("/pilot/api/proposals");
  check("read_proposals returns what /api/proposals returns: my confirmed P2, with no votes and no emails", !rp.isError && rp.text === rpWeb.text && JSON.parse(rp.text).proposals.length === 1 && JSON.parse(rp.text).proposals[0].n === "P2" && JSON.parse(rp.text).proposals[0].mine === true && noLeak(rp.text) && !/"yes"|"no"|votes/.test(rp.text));
  { const seen = JSON.parse((await tool(A, "pilot", tokMax, "read_proposals")).text).proposals;   // shown the day it's locked in (Buster, 2026-11-24): not his, no id or words, no votes
    check("Max sees Mia's locked-in P2 the same day, not as his, with no id, words or votes", seen.length === 1 && seen[0].n === "P2" && seen[0].mine === false && !("id" in seen[0]) && !("words" in seen[0]) && !("votes" in seen[0]), JSON.stringify(seen)); }
  const s3 = JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text);
  check("my_state now says I have proposed and may still move and end my turn", s3.today.proposed === true && s3.today.moved === false && s3.you_can.propose.allowed === false && s3.you_can.propose.reason === webTwice.data.error && s3.you_can.move.allowed === true && s3.you_can.end_turn.allowed === true);
  const mv = await tool(A, "pilot", tokMia, "move", { label: "1N 2E" });
  const mvData = JSON.parse(mv.text);
  const gm2 = (await client(A).get("/pilot/api/game")).data;
  check("move goes through the web's rules: the piece moves, the log line is the web's, the reply is the web's",
    !mv.isError && mvData.ok === true && mvData.kind === "move" && mvData.at.label === "1N 2E 1U" && posOf("pilot", 0).x === 1 && posOf("pilot", 0).y === 0 && gm2.events[0].text === "Mia (Teal) moved to 1N 2E 1U.");
  const mvB = await tool(A, "pilot", tokMia, "move", { x: 2, y: 0 });
  const webMv2 = await mia.post("/pilot/api/action", { kind: "move", x: 2, y: 0 });
  check("a second move the same day is refused with the web's error", mvB.isError && mvB.text === webMv2.data.error && webMv2.status === 409 && posOf("pilot", 0).x === 1);
  const s4 = JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text);
  check("my_state agrees: I have moved and proposed, the piece is where the move put it", s4.today.moved === true && s4.today.proposed === true && s4.you_can.move.allowed === false && s4.you_can.move.reason === webMv2.data.error && s4.you.at.x === 1 && s4.you.at.label === "1N 2E 1U");
  const bad2 = await tool(A, "pilot", tokMia, "no_such_tool");
  check("an unknown tool is an error, not a crash", bad2.rpc.status === 200 && (bad2.rpc.data.error || bad2.rpc.data.result?.isError));
  // End turn: final. Once; then nothing more today.
  const turnsBeforeEnd = propRows();
  const end1 = await tool(A, "pilot", tokMia, "end_turn");
  const end1Data = JSON.parse(end1.text);
  const gm3 = (await client(A).get("/pilot/api/game")).data;
  check("end_turn ends my turn for today: the web's reply (day 1, when), and the log line", !end1.isError && end1Data.ok === true && end1Data.day === 1 && typeof end1Data.ended_at === "string" && gm3.events[0].kind === "turn_ended" && gm3.events[0].text === "Mia (Teal) ended their turn.");
  const end2 = await tool(A, "pilot", tokMia, "end_turn");
  const webEnd2 = await mia.post("/pilot/api/end-turn", {});
  check("end_turn is final and works once: a second one is refused with the web's 409 message", end2.isError && end2.text === "Your turn has ended for today." && end2.text === webEnd2.data.error && webEnd2.status === 409);
  const afterM = await tool(A, "pilot", tokMia, "move", { x: 2, y: 0 });
  const afterP = await tool(A, "pilot", tokMia, "propose", cats);
  const afterD = await tool(A, "pilot", tokMia, "draft_proposal", cats);
  check("after End turn, move and propose answer 'Your turn has ended for today.' and nothing is written", afterM.isError && afterM.text === "Your turn has ended for today." && afterP.isError && afterP.text === "Your turn has ended for today." && afterD.isError && afterD.text === "Your turn has ended for today." && posOf("pilot", 0).x === 1 && propRows() === turnsBeforeEnd);
  const s5 = JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text);
  check("my_state after End turn: ended, and none of move, propose, end_turn allowed, each with the reason", s5.today.ended === true && ["move", "propose", "end_turn"].every((k) => s5.you_can[k].allowed === false && s5.you_can[k].reason === "Your turn has ended for today."), J(s5.you_can));
  check("read_day agrees: Mia shows as ended in the players list", JSON.parse((await tool(A, "pilot", tokMia, "read_day")).text).players.find((p) => p.name === "Mia")?.ended === true && JSON.parse((await tool(A, "pilot", tokMax, "read_day")).text).players.find((p) => p.name === "Mia")?.ended === true);
  // The midnight lock: the dev clock one second past the day's end, the cron NOT run. Every write answers the lock message.
  const endsAt = (await client(A).get("/pilot/api/day")).data.ends_at;
  const lockMsg = "The players are sleeping. Chalant is processing day 1; play resumes when it's done.";
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  d1(state, `INSERT OR REPLACE INTO dev_controls (key, value) VALUES ('clock', '${new Date(Date.parse(endsAt) + 1000).toISOString()}')`);
  const turnsBeforeLock = propRows();
  const lockM = await tool(A, "pilot", tokMax, "move", { x: 3, y: 2 });
  const lockP = await tool(A, "pilot", tokMax, "propose", cats);
  const lockD = await tool(A, "pilot", tokMax, "draft_proposal", cats);
  const lockE = await tool(A, "pilot", tokMax, "end_turn");
  check("during the lock (1 s past midnight, cron not run), move, propose and end_turn over MCP return the lock message",
    lockM.isError && lockM.text === lockMsg && lockP.isError && lockP.text === lockMsg && lockD.isError && lockD.text === lockMsg && lockE.isError && lockE.text === lockMsg, J([lockM.text, lockP.text, lockE.text]));
  const webLock = await max.post("/pilot/api/action", { kind: "move", x: 3, y: 2 });
  check("it is the web's own refusal (HTTP 423), nothing was written, and Max has not ended his turn", webLock.status === 423 && webLock.data.error === lockMsg && posOf("pilot", 1).x === 3 && propRows() === turnsBeforeLock && d1(state, `SELECT COUNT(*) AS n FROM day_turns WHERE game_id = '${gidOf("pilot")}' AND ended_at IS NOT NULL`)[0].n === 1);
  const s6 = JSON.parse((await tool(A, "pilot", tokMax, "my_state")).text);
  check("my_state during the lock: locked, the day being processed, the message, and every write refused with it", s6.lock.locked === true && s6.lock.processing_day === 1 && s6.lock.message === lockMsg && ["move", "propose", "end_turn"].every((k) => s6.you_can[k].allowed === false && s6.you_can[k].reason === lockMsg), J(s6.lock));
  check("read_day during the lock says so too, and keeps working (read-only)", JSON.parse((await tool(A, "pilot", tokMax, "read_day")).text).locked === true && !(await tool(A, "pilot", tokMax, "read_board")).isError);
  d1(state, "DELETE FROM dev_controls WHERE key = 'clock'");
  const sessionsBefore = d1(state, "SELECT COUNT(*) AS n FROM sessions")[0].n;
  const viaWeb = await fetch(`${A}/pilot/api/turn`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokMax}` }, body: JSON.stringify({ prompt: "sneaky" }) });
  check("the OAuth token works on /mcp only: the web API still wants a session cookie (401), and no session was created", viaWeb.status === 401 && (await fetch(`${A}/pilot/api/me`, { headers: { authorization: `Bearer ${tokMax}` } })).status === 401 && d1(state, "SELECT COUNT(*) AS n FROM sessions")[0].n === sessionsBefore);

  console.log("  tokens");
  check("a token for this game does not work on another game", (await mcp(A, "prop", tokMia, "tools/list", {})).status === 401 && (await mcp(A, "nope", tokMia, "tools/list", {})).status === 404);
  const otherPlayer = d1(state, `SELECT id FROM players WHERE game_id = '${gidOf("hex")}' LIMIT 1`)[0].id;
  let crossGame = "accepted"; try { d1(state, `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, game_id, player_id, created_at, expires_at) VALUES ('${"a".repeat(64)}', 'access', 'g', '${cid}', '${gidOf("pilot")}', '${otherPlayer}', 't', 't')`); } catch { crossGame = "refused"; }
  let sameGameOk = "refused"; try { d1(state, `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, game_id, player_id, created_at, expires_at) VALUES ('${"c".repeat(64)}', 'access', 'g', '${cid}', '${gidOf("pilot")}', '${d1(state, `SELECT id FROM players WHERE game_id = '${gidOf("pilot")}' LIMIT 1`)[0].id}', 't', 't')`); sameGameOk = "accepted"; } catch {}
  let crossClient = "accepted"; try { d1(state, `INSERT INTO oauth_codes (code_hash, client_id, game_id, player_id, redirect_uri, code_challenge, created_at, expires_at) VALUES ('${"b".repeat(64)}', '${cid}', '${gidOf("hex")}', '${otherPlayer}', 'u', 'c', 't', 't')`); } catch { crossClient = "refused"; }
  check("the database itself refuses a token for a player of another game, and a code for a client of another game (while the same insert for this game goes in)", crossGame === "refused" && crossClient === "refused" && sameGameOk === "accepted");
  d1(state, `DELETE FROM oauth_tokens WHERE token_hash = '${"c".repeat(64)}'`);
  check("a refresh token is not an access token", (await mcp(A, "pilot", mt.refresh_token, "tools/list", {})).status === 401);
  const rf = await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: mt.clientId, refresh_token: mt.refresh_token });
  const rfd = await rf.json();
  check("a refresh token gives a new pair, and the new access token works", rf.status === 200 && rfd.access_token !== tokMia && rfd.refresh_token !== mt.refresh_token && (await mcp(A, "pilot", rfd.access_token, "tools/list", {})).status === 200);
  check("the old refresh token is spent (single use); another client cannot use one either", (await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: mt.clientId, refresh_token: mt.refresh_token })).status === 400 && (await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: cid, refresh_token: rfd.refresh_token })).status === 400);
  check("an unsupported grant is refused", (await (await form(A, "/pilot/oauth/token", { grant_type: "password", client_id: cid })).json()).error === "unsupported_grant_type");
  d1(state, `UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${sha256Hex(rfd.refresh_token)}'`);
  check("an expired refresh token is refused", (await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: mt.clientId, refresh_token: rfd.refresh_token })).status === 400);
  const regIn = (slug) => fetch(`${A}/${slug}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://a.example/cb"] }) });
  let regLast = 0; for (let i = 0; i < 21; i++) regLast = (await regIn("prop")).status;
  check("registration is capped per address (20 an hour, then 429), per game: another game is not affected", regLast === 429 && d1(state, `SELECT COUNT(*) AS n FROM oauth_clients WHERE game_id = '${gidOf("prop")}'`)[0].n === 20 && (await regIn("hex")).status === 201);
  d1(state, `UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${sha256Hex(rfd.access_token)}'`);
  check("an expired access token is refused (401)", (await mcp(A, "pilot", rfd.access_token, "tools/list", {})).status === 401);
  // A log-in link may carry `next`, but only this game's own consent page is honoured: the server checks it again.
  const nextOf = async (n) => { const tk = "tok-" + Math.random().toString(36).slice(2) + "-padding-padding"; d1(state, `INSERT INTO login_tokens (token_hash, game_id, email, purpose, created_at, expires_at, next) VALUES ('${sha256Hex(tk)}', '${gidOf("pilot")}', 'max@example.com', 'login', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', ${n === null ? "NULL" : `'${n}'`})`); return (await finish(client(A), `${SITE}/pilot/auth/verify?token=${tk}`)).headers.get("location"); };
  check("a log-in link's `next` is honoured only for this game's consent page: anything else lands on the board as before",
    (await nextOf("/pilot/oauth/authorize?a=1")) === "/pilot/oauth/authorize?a=1" && (await nextOf(null)) === "/pilot/?notice=welcome-back" && (await nextOf("https://evil.example/")) === "/pilot/?notice=welcome-back" &&
    (await nextOf("//evil.example/pilot/oauth/authorize")) === "/pilot/?notice=welcome-back" && (await nextOf("/pilot/api/me")) === "/pilot/?notice=welcome-back" && (await nextOf("/other/oauth/authorize?a=1")) === "/pilot/?notice=welcome-back");

  console.log("  the rules switch it off");
  const setMcp = (on) => d1(state, `UPDATE games SET settings = '{"mcp_enabled":${on}}' WHERE slug = 'pilot'`);
  setMcp(false);
  const offCall = await tool(A, "pilot", tokMia, "my_state");
  check("with mcp_enabled false, a connected player's call is refused (403) with a plain message that the rules disable MCP", offCall.status === 403 && /rules of this game currently disable MCP/.test(offCall.rpc.data.error.message) && !offCall.rpc.data.result, offCall.rpc.text);
  check("the rules decide first: with no token it is the same 403 message, not a 401 that would start a sign-in", (await mcp(A, "pilot", null, "tools/list", {})).status === 403);
  const offAuth = await web.get(authUrl());
  const offTok = await form(A, "/pilot/oauth/token", { grant_type: "refresh_token", client_id: cid, refresh_token: "x" });
  check("sign-in is closed too: authorize, token and registration refuse with the message; so does discovery",
    offAuth.status === 403 && /disable MCP/.test(offAuth.text) && offTok.status === 403 && /disable MCP/.test((await offTok.json()).error_description) && (await reg({ redirect_uris: ["https://a.example/cb"] })).status === 403 &&
    (await client(A).get("/.well-known/oauth-protected-resource/pilot/mcp")).status === 403 && (await client(A).get("/.well-known/oauth-authorization-server/pilot")).status === 403 &&
    (await mia.form("/pilot/oauth/authorize", fields({ step: "decide", decision: "allow" }), { origin: SITE })).status === 403);
  check("the web game is unaffected: the board still reads, and another game's MCP still answers", (await client(A).get("/pilot/api/board")).status === 200 && (await mia.get("/pilot/api/me")).status === 200 && (await client(A).get("/.well-known/oauth-authorization-server/prop")).status === 200);
  setMcp(true);
  check("switching it back on takes effect at once: the same token works again, with the game's state intact", (await tool(A, "pilot", tokMia, "my_state")).isError === false && JSON.parse((await tool(A, "pilot", tokMia, "my_state")).text).you.at.x === 1);
  setMcp("true");
  check("a stored value that is not a boolean falls back to the default (on)", (await mcp(A, "pilot", tokMia, "tools/list", {})).status === 200);
  d1(state, `UPDATE games SET settings = '{}' WHERE slug = 'pilot'`);
  check("and so does a game that stores no value for it", (await mcp(A, "pilot", tokMia, "tools/list", {})).status === 200);

  console.log("join links made before the design port");
  {
    const lg = await createGame(state, { slug: "legacy", ...R });
    const mk = async (email, color, shapeSql) => { const tk = "tok-" + Math.random().toString(36).slice(2) + "-padding-padding"; d1(state, `INSERT INTO login_tokens (token_hash, game_id, email, purpose, display_name, color, ${shapeSql ? "shape, " : ""}created_at, expires_at) VALUES ('${sha256Hex(tk)}', '${gidOf("legacy")}', '${email}', 'join', 'Old', '${color}', ${shapeSql ? `${shapeSql}, ` : ""}'2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`); return (await finish(client(A), `${SITE}/legacy/auth/verify?token=${tk}`)).headers.get("location"); };
    const l1 = await mk("o1@example.com", "saffron", null), l2 = await mk("o2@example.com", "orchid", "'dragon'"), l3 = await mk("o3@example.com", "jade", "'wizard'");
    const rows = d1(state, `SELECT email, color, shape FROM players WHERE game_id = '${gidOf("legacy")}' ORDER BY turn_order`);
    check("a join link made before shapes existed (no shape, and a color of the first palette) still seats the player: a pawn, in the color they asked for", l1 === "/legacy/?notice=joined" && J(rows[0]) === '{"email":"o1@example.com","color":"saffron","shape":"pawn"}', J(rows));
    check("a link carrying a shape that is not one of the nine seats a pawn, and one carrying a real shape keeps it", l2 === "/legacy/?notice=joined" && rows[1].shape === "pawn" && l3 === "/legacy/?notice=joined" && rows[2].shape === "wizard", J(rows));
  }

  console.log("a game with a bundle runs on its own rules");
  {
    const bg = await createGame(state, { slug: "bundled", name: "Bundled", max: 2, ...R });
    const bea = await join(A, "bundled", bg.code, { email: "bea@example.com", name: "Bea", color: "teal" });
    const bob = await join(A, "bundled", bg.code, { email: "bob@example.com", name: "Bob", color: "cobalt" });
    const rules = await client(A).get("/bundled/api/rules");
    check("/api/rules answers from the bundle (the fixture's text), not from the repo the game row names", rules.status === 200 && /rules of the bundled fixture game/.test(rules.text) && /markdown/.test(rules.headers.get("content-type")) && rules.headers.get("cache-control") === "public, max-age=60", rules.text.slice(0, 80));
    check("a game with no bundle still reads its rules from its repo, as before", (await client(A).get("/hex/api/rules")).text === "# Rules\n");
    check("the fixture's own spawn rule (505: the last open tile) placed the pieces on (1,1) and then (1,0), not on random tiles", J(playersOf("bundled").map((p) => [p.x, p.y])) === "[[1,1],[1,0]]", J(playersOf("bundled")));
    setTurn("bundled");
    const mv = await bea.post("/bundled/api/action", { kind: "move", x: 0, y: 0 });
    check("the fixture's own rule 202 refuses the move (409), with its own words: the game's module, not the starter pack's, decides", mv.status === 409 && mv.data.error === "Moves are closed in the fixture game.", mv.text);
    const bobEnd = await bob.post("/bundled/api/end-turn", {}), bobMove = await bob.post("/bundled/api/action", { kind: "move", x: 0, y: 0 });
    check("the engine's own gate still comes first: after End turn a move is 'Your turn has ended for today.' (409), whatever the rule says", bobEnd.status === 200 && bobMove.status === 409 && bobMove.data.error === "Your turn has ended for today.", bobMove.text);
    const turn = await bea.post("/bundled/api/turn", { kind: "addclause", target: "101", words: "Make the fixture friendlier." });
    check("a proposal is not a move: the fixture's 202 lets it through", turn.status === 200 && turn.data.ok === true, turn.text);
    check("nothing moved", J(playersOf("bundled").map((p) => [p.x, p.y])) === "[[1,1],[1,0]]");
  }

  console.log("a rule that throws is a clean 500, not a crash");
  {
    const tg = await createGame(state, { slug: "throwing", name: "Throwing", max: 2, ...R });
    const tia = await join(A, "throwing", tg.code, { email: "tia@example.com", name: "Tia", color: "teal" });
    setTurn("throwing");
    const tp = await tia.post("/throwing/api/turn", { kind: "addclause", target: "101", words: "Anything." });
    check("a proposal whose rule 202 throws answers 500 with a plain message (not a stack trace), and records no turn", tp.status === 500 && tp.data.error === "A rule could not be checked. Try again later." && !/boom|Error|at /.test(tp.text) && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gidOf("throwing")}'`)[0].n === 0, tp.text);
    const tm = await tia.post("/throwing/api/action", { kind: "move", x: 0, y: 1 });
    check("a move in the same game is not touched by that rule: it is judged by the game's other rules (an uncharted-free island tile, 200)", tm.status === 200, tm.text);
  }

  console.log("static files");
  const js = await client(A).get("/js/board.js");
  check("the board's script is served as JavaScript", js.status === 200 && /javascript/.test(js.headers.get("content-type")), js.status + " " + js.headers.get("content-type"));
  for (const f of ["/js/pieces.js", "/js/pieces-data.js", "/js/rulebook.js", "/js/cards.js", "/js/people.js", "/js/propose.js", "/js/landing.js", "/theme.css"]) check(`${f} is served`, (await client(A).get(f)).status === 200);
  for (const n of ["gremlin", "chalant"]) { const r = await client(A).get(`/portraits/${n}.svg`); check(`/portraits/${n}.svg is served as an SVG symbol #p, cacheable`, r.status === 200 && /image\/svg/.test(r.headers.get("content-type")) && r.text.includes('id="p"') && /max-age/.test(r.headers.get("cache-control") || ""), r.status + " " + r.headers.get("content-type")); }
  check("only the three named portraits are served: another name is a 404, and so is a POST", (await client(A).get("/portraits/other.svg")).status === 404 && (await client(A).post("/portraits/gremlin.svg", {})).status === 404);
  check("nothing else in public/ is reachable (the old WebGL files and three.js are gone), and no path tricks", (await client(A).get("/vendor/three.module.js")).status === 404 && (await client(A).get("/js/board-gl.js")).status === 404 && (await client(A).get("/js/theme.js")).status === 404 && (await client(A).get("/js/nope.js")).status === 404 && (await client(A).get("/js/%2e%2e/board.html")).status === 404 && (await client(A).get("/board.html")).status === 404);
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e, e?.cause);
  if (srv) console.log(srv.log().slice(-1500));
} finally {
  await srv?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}
// ---------------------------------------------------------------- production vars vs local runs
console.log("production vars");
{
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(pjoin(ROOT, "wrangler.toml"), "utf8");
  const vars = toml.slice(toml.indexOf("\n[vars]"), toml.indexOf("[[send_email]]"));
  check("wrangler.toml sets the production sender and site", /^MAIL_FROM = "Chalant <chalant@promptocracy\.us>"$/m.test(vars) && /^SITE_URL = "https:\/\/promptocracy\.us"$/m.test(vars));
  const pv = toml.slice(toml.search(/^\[+previews/m));
  check("the previews config has a block and gives previews no vars, no email binding, no site url",
    pv.length > 20 && !/MAIL_FROM|SITE_URL|send_email|\[previews\.vars\]|\bEMAIL\b|RESEND/.test(pv.replace(/^\s*#.*$/gm, "")), pv.slice(0, 200));
  check("no top-level [vars] key can leak into previews: the only previews tables are D1, the preview art bucket and the AI binding", [...toml.matchAll(/^\[+(previews[^\]]*)\]+/gm)].every((m) => ["previews.d1_databases", "previews.r2_buckets", "previews.ai"].includes(m[1])));
  let local, st2 = newState();
  try {
    migrate(st2);
    const lg = await createGame(st2, { slug: "loc", repo: "busterbenson/hex", rulesBase: stub.base });
    local = await startServer(st2, await freePort(), ["DEV_MODE=1"]); // no MAIL_FROM / SITE_URL given: the harness blanks the production ones
    const p = await join(local.base, "loc", lg.code, { email: "l@example.com", name: "L", color: "teal" });
    const jr = await client(local.base).post("/loc/api/join", { code: lg.code, email: "l2@example.com", name: "L2", color: "cobalt" });
    check("locally the link points at the local origin and mail goes to the outbox, not Cloudflare", jr.data.dev_link.startsWith(local.base + "/loc/auth/verify") && d1(st2, "SELECT COUNT(*) AS n FROM outbox")[0].n >= 2);
    const tok = new URL(jr.data.dev_link).searchParams.get("token");
    const prod = await client(local.base).form("/loc/auth/verify", { token: tok }, { origin: "https://promptocracy.us" });
    check("the production origin is NOT what local runs check against (403)", prod.status === 403, String(prod.status));
    const ok = await client(local.base).form("/loc/auth/verify", { token: tok }, { origin: local.base });
    check("a POST from the dev origin passes the Origin check (303)", ok.status === 303, String(ok.status));
  } catch (e) { fail++; console.log("  FAIL  local-vars harness:", e?.stack || e); }
  finally { await local?.stop(); try { rmSync(st2, { recursive: true, force: true }); } catch {} }
}
await stub?.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
