// GET /api/me/items (the Yours page): a player's own proposals and tickets in every state, and nothing of anyone else's; a visitor gets 401.
// A real `wrangler dev` on a throwaway LOCAL D1; the rows are written straight to it. Run: node tests/yours.mjs
import { readdirSync, readFileSync } from "node:fs";
import { PROPOSAL_STATES, TICKET_STATES } from "../public/js/yours.js";
import { SHOWN_STATES as STATES } from "../src/lib/tickets.js";
import { client, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };

console.log("the page lists every state there is");
check("its ticket groups are the ticket states, in order", JSON.stringify(TICKET_STATES) === JSON.stringify(STATES));
const mig = readdirSync(new URL("../migrations/", import.meta.url)).sort().map((f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8")).join("\n");
const checkList = [...mig.matchAll(/status TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \(([^)]*)\)\)/g)].pop();
const dbStatuses = checkList ? [...checkList[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
check("its proposal groups are the statuses the proposals table allows (the last migration's list)", dbStatuses.length > 0 && JSON.stringify([...dbStatuses].sort()) === JSON.stringify(PROPOSAL_STATES.map(([s]) => s).sort()), JSON.stringify(dbStatuses));

const state = newState();
let srv = null, stub = null;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/yr/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "yr", name: "Yours", max: 6, rulesBase: stub.base, repo: "busterbenson/yr" });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const Ana = await join(srv.base, "yr", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const Bo = await join(srv.base, "yr", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const visitor = client(srv.base);
  startPlaying(state, "yr");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'yr'")[0].id;
  const day = d1(state, `SELECT day FROM games WHERE id = '${gid}'`)[0].day;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  let num = 0;
  const prop = (who, status, extra = {}) => {
    const n = status === "draft" ? null : ++num, id = `q-${who}-${status}-${extra.kind || "amend"}-${extra.day ?? day}`;
    const confirmed = status !== "draft";
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at, title)
      VALUES ('${id}', '${gid}', ${n}, '${pid(who)}', ${extra.day ?? day}, ${confirmed ? (extra.day ?? day) + 1 : "NULL"}, '${extra.kind || "amend"}', 'rule', '403', 'Head ${id}', 'code', 's', ${confirmed ? "'majority'" : "NULL"}, '${status}', '2026-11-1${num % 10}T00:00:00.000Z', ${confirmed ? "'x'" : "NULL"}, 'Title ${id}')`);
    return id;
  };
  const statuses = PROPOSAL_STATES.map(([s]) => s);
  for (const s of statuses) prop("Ana", s);
  prop("Ana", "draft", { day: day + 7, kind: "repeal" });   // a draft of another day can never be locked in: not listed
  prop("Ana", "passed", { kind: "commission" });            // a commission proposal is its ticket: not listed under the proposals
  for (const s of statuses) prop("Bo", s);
  let t = 0;
  const tix = (who, s) => { const n = ++t, held = s === "On hold"; d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, state, held_at, price, created_at, updated_at) VALUES ('t${n}', '${gid}', ${n}, '${pid(who)}', 'Ticket ${n} ${s}', '${held ? "Ready" : s}', ${held ? "'2026-11-1" + (n % 10) + "T00:00:00.000Z'" : "NULL"}, ${s === "Ready" || held ? 12 : 3}, '2026-11-1${n % 10}T00:00:00.000Z', '2026-11-1${n % 10}T00:00:00.000Z')`); return n; };
  for (const s of STATES) tix("Ana", s);
  for (const s of STATES) tix("Bo", s);
  d1(state, `UPDATE players SET score = 5 WHERE id = '${pid("Ana")}'`);

  console.log("Ana's items");
  const r = await Ana.get("/yr/api/me/items");
  check("200 for a player", r.status === 200, r.text.slice(0, 200));
  const d = r.data || {};
  check("every proposal status is there once (her draft of today included), none of Bo's", statuses.every((s) => d.proposals.filter((p) => p.status === s).length === 1) && d.proposals.length === statuses.length && d.proposals.every((p) => p.mine), JSON.stringify((d.proposals || []).map((p) => p.status)));
  check("a draft of another day and a commission proposal are not listed", !d.proposals.some((p) => p.kind === "commission" || p.kind === "repeal"));
  check("every ticket state is there once, all hers", STATES.every((s) => d.tickets.filter((x) => x.state === s).length === 1) && d.tickets.length === STATES.length && d.tickets.every((x) => x.mine), JSON.stringify((d.tickets || []).map((x) => x.state)));
  const ready = (d.tickets || []).find((x) => x.state === "Ready");
  check("a Ready ticket carries its price and her points come with the list", ready && ready.price === 12 && d.score === 5, JSON.stringify(ready));
  check("a proposal has its P-number once it is locked in, and none while it is a draft", d.proposals.filter((p) => p.status !== "draft").every((p) => /^P\d+$/.test(p.n)) && d.proposals.find((p) => p.status === "draft").n === null);
  check("nothing in it names a row id of someone else or an email", !/@example\.com/.test(r.text) && !r.text.includes(pid("Bo")));

  console.log("Bo's items, and a visitor's");
  const rb = await Bo.get("/yr/api/me/items");
  check("Bo gets his own and none of Ana's", rb.status === 200 && rb.data.proposals.length === statuses.length && rb.data.tickets.length === STATES.length && rb.data.tickets.every((x) => x.by.name === "Bo") && rb.data.proposals.every((p) => p.by.name === "Bo"));
  check("a visitor gets 401 and no list", (await visitor.get("/yr/api/me/items")).status === 401);
  check("it is read-only: a POST is not a route", (await Ana.post("/yr/api/me/items", {})).status === 404);
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
