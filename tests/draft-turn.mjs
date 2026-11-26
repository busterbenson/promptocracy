// The general chat turn's draft-and-retry step (src/lib/draft-turn.js), offline with stubs: the ONE function api-chat.ts generalTurn and the quality
// harness (tests/quality/chat.mjs) both call. A draft goes to the drafter; once more if the drafter refuses (rule 103.1); once more if the rule check
// (rule 103.9) blocked it or couldn't run; never a second retry; the check's fixes become the options. No model, no server. Run: npm test.
import { draftTurn } from "../src/lib/draft-turn.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };

/** A scripted turn: `answers` are the model's answers in order (the first is the turn's own), `drafts` what the drafter says to each draft in order. */
function rig({ answers, drafts, noDraft = null, bad = [] }) {
  const log = { asked: [], tried: [], logged: [], after: 0 };
  let ai = 0, di = 0;
  const first = answers[ai++];
  return {
    log,
    run: () => draftTurn({
      r: { ok: true, id: "r1" }, a: first, noDraft,
      ask: async (retry, found) => { log.asked.push({ retry, found }); const a = answers[ai++]; return a ? { ok: true, id: `r${ai}`, a } : { ok: false, code: "failed", usage: null }; },
      read: (r) => (bad.includes(r.id) ? { ok: false } : { ok: true, ...r.a }),
      tryDraft: async (a) => { log.tried.push(a.draft?.words); return drafts[di++]; },
      after: async () => { log.after++; },
      log: async (call, outcome, reason) => { log.logged.push(`${call.id}:${outcome}:${reason}`); },
    }),
  };
}
const ans = (words, extra = {}) => ({ say: `say ${words ?? "none"}`, draft: words ? { kind: "amend", target: "401", words } : null, options: [], ...extra });
const blocked = { status: "blocked", fixes: [{ say: "fix one" }, { say: "fix two" }, { say: "fix three" }, { say: "fix four" }], missing: [{ what: "x", why: "y" }] };

console.log("a draft that passes");
{
  const t = rig({ answers: [ans("w1")], drafts: [{ id: "p1", check: { status: "ok" } }] });
  const o = await t.run();
  check("one draft, no retry, no clock refresh", t.log.asked.length === 0 && t.log.tried.length === 1 && o.res.id === "p1" && o.notes.length === 0 && t.log.after === 0);
  const u = rig({ answers: [ans("w1")], drafts: [{ id: "p1", check: null }] });
  check("a draft with no check (rulebook without 103.9, no key) is not retried", (await u.run(), u.log.asked.length === 0));
}

console.log("the drafter refuses (rule 103.1)");
{
  const t = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ refused: { error: "no" }, why: "refused" }, { id: "p2", check: { status: "ok" } }] });
  const o = await t.run();
  check("one retry with the drafter's reason, the second draft is the one that stands", t.log.asked.length === 1 && t.log.asked[0].retry === "no" && t.log.asked[0].found === undefined && o.res.id === "p2" && o.a.say === "say w2", JSON.stringify(t.log.asked));
  check("the first call is logged only when replaced, and the note says why", t.log.logged.join() === "r1:ok:draft refused: refused; retry after refusal" && o.notes.join() === "retry after refusal: refused", t.log.logged.join());
  check("the clock is read again after the retry", t.log.after === 1);
  const n = rig({ answers: [ans("w1"), ans(null)], drafts: [{ refused: { error: "no" }, why: "refused" }] });
  const on = await n.run();
  check("a retry that makes no draft leaves the refusal standing", on.res.refused?.error === "no" && on.res.why === "no second draft" && n.log.tried.length === 1);
  const f = rig({ answers: [ans("w1")], drafts: [{ refused: { error: "no" }, why: "refused" }] });
  const of = await f.run();
  check("a retry whose call fails is logged and the refusal stands", of.res.refused && f.log.logged.join() === "undefined:failed:retry after refusal failed" && of.notes.length === 0, f.log.logged.join());
  const g = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ refused: { error: "no" }, why: "refused" }], bad: ["r2"] });
  const og = await g.run();
  check("a retry whose answer is unreadable is logged invalid and the refusal stands", og.res.refused && g.log.logged.join() === "r2:invalid:retry after refusal failed", g.log.logged.join());
  const d = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ refused: { error: "gate" }, why: "day gate" }], noDraft: "closed" });
  check("never when the day's gate is what refused", (await d.run(), d.log.asked.length === 0));
  const s = rig({ answers: [ans("w1"), ans("w2"), ans("w3")], drafts: [{ refused: { error: "no" }, why: "refused" }, { refused: { error: "no again" }, why: "refused" }] });
  const os = await s.run();
  check("never a second retry: two refusals end it", s.log.asked.length === 1 && os.res.refused?.error === "no again");
}

console.log("the rule check blocks the draft, or could not run (rule 103.9)");
{
  const t = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: blocked }, { id: "p2", check: { status: "ok" } }] });
  const o = await t.run();
  check("one retry with the check's findings (found), no refusal text", t.log.asked.length === 1 && t.log.asked[0].retry === undefined && t.log.asked[0].found === blocked);
  check("the retry's draft is checked and stands", o.res.id === "p2" && o.a.say === "say w2" && o.notes.join() === "retry after rule check: blocked" && t.log.logged.join() === "r1:ok:rule check blocked; retry after check");
  const u = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: { status: "unchecked", fixes: [] } }, { id: "p2", check: { status: "ok" } }] });
  check("an unchecked draft gets the same retry", (await u.run(), u.log.asked.length === 1 && u.log.asked[0].found.status === "unchecked"));
  const k = rig({ answers: [ans("w1"), ans(null, { options: ["a"] })], drafts: [{ id: "p1", check: blocked }] });
  const ok = await k.run();
  check("a retry that makes no new draft keeps the first slip, with the new words", ok.res.id === "p1" && ok.a.say === "say none" && k.log.tried.length === 1);
  const r = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: blocked }, { refused: { error: "no" }, why: "refused" }] });
  const or = await r.run();
  check("a retry whose draft is refused keeps the first slip (refusal does not erase it)", or.res.id === "p1" && !or.res.refused);
  const s = rig({ answers: [ans("w1"), ans("w2"), ans("w3")], drafts: [{ id: "p1", check: blocked }, { id: "p2", check: blocked }] });
  const os = await s.run();
  check("never a second retry: the retry's blocked draft stands", s.log.asked.length === 1 && os.res.id === "p2");
  const a = rig({ answers: [ans("w1"), ans("w2"), ans("w3")], drafts: [{ refused: { error: "no" }, why: "refused" }, { id: "p2", check: blocked }] });
  const oa = await a.run();
  check("a refusal retry that lands a blocked draft does NOT get a check retry too (one retry in all)", a.log.asked.length === 1 && oa.res.id === "p2");
  const f = rig({ answers: [ans("w1")], drafts: [{ id: "p1", check: blocked }] });
  const of = await f.run();
  check("a check retry whose call fails is logged; the first draft and answer stand", of.res.id === "p1" && of.a.say === "say w1" && f.log.logged.join() === "undefined:failed:retry after rule check failed", f.log.logged.join());
  const d = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: blocked }], noDraft: "closed" });
  check("no check retry when the day's gate is shut", (await d.run(), d.log.asked.length === 0));
}

console.log("the options are the check's fixes");
{
  const t = rig({ answers: [ans("w1", { options: ["his own"] }), ans("w2", { options: ["his own again"] })], drafts: [{ id: "p1", check: blocked }, { id: "p2", check: blocked }] });
  const o = await t.run();
  check("a blocked slip's options are its fixes, three at most, whatever he offered", o.a.options.join() === "fix one,fix two,fix three", o.a.options.join());
  const u = rig({ answers: [ans("w1", { options: ["his own"] }), ans("w2", { options: ["his own"] })], drafts: [{ id: "p1", check: { status: "unchecked", fixes: [] } }, { id: "p2", check: { status: "unchecked", fixes: [] } }] });
  const ou = await u.run();
  check("an unchecked slip keeps his own options", ou.a.options.join() === "his own");
  const e = rig({ answers: [ans("w1", { options: ["his own"] })], drafts: [{ id: "p1", check: { status: "blocked", fixes: [] } }] , noDraft: "closed" });
  check("no fixes: his own options stay", (await e.run()).a.options.join() === "his own");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
