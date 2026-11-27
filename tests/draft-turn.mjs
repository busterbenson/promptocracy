// The general chat turn's draft-and-retry step (src/lib/draft-turn.js), offline with stubs: the ONE function api-chat.ts generalTurn and the quality
// harness (tests/quality/chat.mjs) both call. A draft goes to the drafter; once more if the drafter refuses (rule 103.1); when the rule check (rule 103.9) BLOCKS it,
// Gremlin redrafts it himself, up to twice, and the first that passes is the slip; when none passes the player's own first draft stays and one more call explains;
// a check that could not run gets one call. The check's fixes become the options. No model, no server. Run: npm test.
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
      ask: async (retry, found, mode) => { log.asked.push({ retry, found, mode }); const a = answers[ai++]; return a ? { ok: true, id: `r${ai}`, a } : { ok: false, code: "failed", usage: null }; },
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
  const g = rig({ answers: [ans("w1"), ans("w2"), ans(null, { options: ["o"] })], drafts: [{ id: "p1", check: blocked }], bad: ["r2"] });
  const og = await g.run();
  check("a redraft whose answer is unreadable ends the redrafts and is logged; the first draft stays and he explains", og.res.id === "p1" && og.a.say === "say none" && g.log.logged[0] === "r2:invalid:redraft 1 after rule check failed" && g.log.asked.length === 2 && g.log.asked[1].mode === "explain", g.log.logged.join());
  const dr = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: blocked }], noDraft: "closed" });
  check("no redraft when the day's gate is shut", (await dr.run(), dr.log.asked.length === 0));
  const z = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: blocked }, { id: "p2", check: { status: "ok" } }] });
  const oz = await draftTurn({ r: { ok: true, id: "r1" }, a: ans("w1"), ask: async () => ({ ok: true, id: "r2", a: ans("w2") }), read: (x) => ({ ok: true, ...x.a }), tryDraft: async () => ({ id: "p1", check: blocked }), redrafts: 0 });
  check("redrafts: 0 turns it off (the first draft stays, no call)", oz.res.id === "p1" && oz.a.say === "say w1");
  const refusalThenBlock = rig({ answers: [ans("w1"), ans("w2"), ans("w3")], drafts: [{ refused: { error: "no" }, why: "refused" }, { id: "p2", check: blocked }, { id: "p3", check: { status: "ok" } }] });
  const orb = await refusalThenBlock.run();
  check("a refusal retry that lands a blocked draft is still redrafted (refusal then block then ok)", refusalThenBlock.log.asked.length === 2 && refusalThenBlock.log.asked[0].retry === "no" && refusalThenBlock.log.asked[1].mode === "redraft" && orb.res.id === "p3");
}

console.log("a redraft that changes the kind or target must say so in his guesses");
{
  const redraftOf = (draft, guesses) => ({ say: "redraft", draft, options: [], ...(guesses ? { guesses } : {}) });
  const first = { say: "first", draft: { kind: "add", target: "200", words: "Each day has a moon." }, options: [] };
  const go = async (second, drafts) => {
    const log = { tried: 0, logged: [] };
    const o = await draftTurn({ r: { ok: true, id: "r1" }, a: first, ask: async () => ({ ok: true, id: "r2", a: second }), read: (x) => ({ ok: true, ...x.a }), tryDraft: async () => { log.tried++; return drafts[log.tried - 1] ?? { id: "px", check: { status: "ok" } }; }, log: async (c, outcome, why) => { log.logged.push(why); } });
    return { o, log };
  };
  const same = await go(redraftOf({ kind: "add", target: "200", words: "w" }), [{ id: "p1", check: blocked }, { id: "p2", check: { status: "ok" } }]);
  check("the same kind and target needs no guesses line", same.o.res.id === "p2");
  const moved = await go(redraftOf({ kind: "amend", target: "202.2", words: "w" }), [{ id: "p1", check: blocked }, { id: "p2", check: { status: "ok" } }, { id: "p2", check: { status: "ok" } }]);
  check("another kind, unsaid: not drawn (the drafter is not asked), logged, and the first draft stays", moved.log.tried === 1 && moved.o.res.id === "p1" && moved.log.logged.some((l) => /changed the kind or target without saying so/.test(l)), JSON.stringify(moved.log));
  const said = await go(redraftOf({ kind: "amend", target: "202.2", words: "w" }, "I made it an amend of the move."), [{ id: "p1", check: blocked }, { id: "p2", check: { status: "ok" } }]);
  check("another kind, said in the guesses: it counts", said.o.res.id === "p2");
}

console.log("a check that could not run: one call to say so (rule 103.9)");
{
  const u = rig({ answers: [ans("w1"), ans("w2")], drafts: [{ id: "p1", check: { status: "unchecked", fixes: [] } }, { id: "p2", check: { status: "ok" } }] });
  const ou = await u.run();
  check("an unchecked draft gets one call with the findings, in no mode, and its draft stands when it passes", u.log.asked.length === 1 && u.log.asked[0].found.status === "unchecked" && u.log.asked[0].mode === undefined && ou.res.id === "p2");
  const w = rig({ answers: [ans("w1"), ans("w2"), ans("w3")], drafts: [{ id: "p1", check: { status: "unchecked", fixes: [] } }, { id: "p2", check: { status: "unchecked", fixes: [] } }] });
  check("never a second call for an unchecked draft", (await w.run(), w.log.asked.length === 1));
  const x = rig({ answers: [ans("w1")], drafts: [{ id: "p1", check: { status: "unchecked", fixes: [] } }] });
  const ox = await x.run();
  check("an unchecked call that fails is logged; the first draft and answer stand", ox.res.id === "p1" && ox.a.say === "say w1" && x.log.logged.join() === "undefined:failed:retry after rule check failed", x.log.logged.join());
}

console.log("the options are the check's fixes");
{
  const t = rig({ answers: [ans("w1", { options: ["his own"] }), ans("w2", { options: ["his own again"] }), ans("w3", { options: ["third"] }), ans(null, { options: ["explain"] })], drafts: [{ id: "p1", check: blocked }, { id: "p2", check: blocked }, { id: "p3", check: blocked }] });
  const o = await t.run();
  check("a blocked slip's options are its fixes, three at most, whatever he offered", o.a.options.join() === "fix one,fix two,fix three", o.a.options.join());
  const e = rig({ answers: [ans("w1", { options: ["his own"] })], drafts: [{ id: "p1", check: { status: "blocked", fixes: [] } }], noDraft: "closed" });
  check("no fixes: his own options stay", (await e.run()).a.options.join() === "his own");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
