// Grading: the code checks (these decide a case's pass/fail) and the Gemini grader (advisory: it is shown next to Buster's mark).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GRADER_MODEL = "gemini-3.1-pro-preview";
const list = (v) => (Array.isArray(v) ? v : [v]);
const chk = (name, pass, detail = "", soft = false) => ({ name, pass: !!pass, detail: String(detail ?? ""), soft });

/** The case's digest: sha256 of its final draft text and night diff, so a verdict is tied to the exact output Buster judged. */
export function digestOf(res, night) {
  const h = createHash("sha256");
  h.update(JSON.stringify([res.draft?.after_text ?? null, res.refusal?.message ?? null, res.ticket?.makes ?? null, night?.diff_text ?? null, night?.diff_code ?? null]));
  return h.digest("hex").slice(0, 16);
}


/**
 * One first-answer criterion against a turn's standing slip (Buster, 2026-11-26: "craft rules that are valid and in the spirit of the players request without any back and forth").
 * x: {check: "ok" | "blocked", engine_note: true | false, kind: [...], words_re, not_words_re, says_not_re, says_re, guess: true, missing_names_re, options_not_re, no_escalation}.
 * `turn` is the scripted turn. Returns [{name, pass, detail}], every key a separate check, so a failing case says which part failed.
 */
export function slipCriteria(label, turn, x) {
  const sl = turn?.slip ?? null, out = [];
  const say = turn?.say || "", hay = `${sl?.words ?? ""}\n${sl?.after_text ?? ""}`;
  const add = (name, pass, detail = "") => out.push(chk(`${label}: ${name}`, pass, detail));
  add("a slip stands", !!sl, sl ? "" : `no slip; he said: ${say.slice(0, 120)}`);
  if (!sl) return out;
  if (x.check) add(`the rule check says ${x.check}`, sl.check === x.check, `got ${sl.check ?? "no check"}${sl.unchecked_reason ? ` [${sl.unchecked_reason}]` : ""}${sl.missing?.length ? ` (${sl.missing.map((m) => m.what).join("; ")})` : ""}`);
  if (x.engine_note === true) add("an engine note rides on the slip", !!sl.engine_note, sl.engine_note || "none");
  if (x.engine_note === false) add("no engine note", !sl.engine_note, sl.engine_note || "");
  if (x.kind) add("draft kind", list(x.kind).includes(sl.kind), `got ${sl.kind}, wanted ${list(x.kind).join(" or ")}`);
  if (x.words_re) for (const re of list(x.words_re)) add(`the draft says /${re}/`, new RegExp(re, "i").test(hay), hay.slice(0, 200));
  if (x.not_words_re) add(`the draft does not say /${x.not_words_re}/`, !new RegExp(x.not_words_re, "i").test(hay), (new RegExp(x.not_words_re, "i").exec(hay) || [""])[0]);
  if (x.says_re) add(`his line says /${x.says_re}/`, new RegExp(x.says_re, "i").test(say), say.slice(0, 160));
  if (x.says_not_re) add(`his line does not say /${x.says_not_re}/`, !new RegExp(x.says_not_re, "i").test(say), (new RegExp(x.says_not_re, "i").exec(say) || [""])[0]);
  if (x.guess) add("a guesses line", !!turn?.guesses, turn?.guesses || "none");
  if (x.missing_names_re) add(`the missing item names /${x.missing_names_re}/`, (sl.missing || []).some((m) => new RegExp(x.missing_names_re, "i").test(`${m.what} ${m.why}`)), JSON.stringify(sl.missing || []));
  if (x.options_not_re) add(`no option says /${x.options_not_re}/`, ![...(turn?.options || []), ...(sl.fixes || [])].some((o) => new RegExp(x.options_not_re, "i").test(o)), JSON.stringify([...(turn?.options || []), ...(sl.fixes || [])]).slice(0, 200));
  if (x.no_escalation) add("no escalation", !turn?.escalate, turn?.escalate?.reason || "");
  return out;
}

/** first_answer / turn_slip: an object, or {any: [object, ...]} where one alternative must pass whole. */
function slipExpect(label, turn, x) {
  if (!x.any) return slipCriteria(label, turn, x);
  const tries = x.any.map((alt, i) => slipCriteria(`${label} (alternative ${i + 1})`, turn, alt));
  const whole = tries.find((t) => t.every((k) => k.pass));
  return whole ? [chk(`${label}: one alternative holds`, true, "")] : [chk(`${label}: one alternative must hold`, false, tries.map((t, i) => `[${i + 1}] ${t.filter((k) => !k.pass).map((k) => k.name + (k.detail ? " -> " + k.detail : "")).join("; ")}`).join(" | "))];
}

/** Every code check for one case. Returns [{name, pass, detail, soft}]. A `soft` check is reported but never fails the case. */
export function codeChecks(c, res, night) {
  const e = c.expect || {}, out = [], turns = res.turns || [];
  if (res.notRun) return [chk("ran", false, `not run: ${res.notRun}`)];
  out.push(chk("answers readable", !res.error && turns.length > 0 && turns.every((t) => !t.error && t.say), res.error || ""));
  out.push(chk("no canary or prompt leak", !turns.some((t) => t.canary_or_prompt_leak)));
  const dropped = turns.flatMap((t) => t.dropped || []).filter((d) => /quote|rule/.test(d));
  out.push(chk("no dropped quote", !dropped.length, dropped.join("; ")));
  if (res.error) return out;
  const d = res.draft, n = res.draft_count || 0;
  // ---- one helper (PLAN section 7): where the case ended, and that no turn ends in a dead end ----
  if (e.ends_in) {
    const got = res.opened_ticket && res.ticket && (res.ticket.title || (res.ticket.makes || []).length) ? "ticket" : res.draft ? "proposal" : res.refusal ? "refusal" : "nothing";
    out.push(chk(`ends in ${e.ends_in}`, got === e.ends_in, `got ${got}`));
  }
  if (e.no_escalation) out.push(chk("no escalation", !turns.some((t) => t.escalate), turns.find((t) => t.escalate)?.escalate?.reason || ""));
  if (e.guesses) out.push(chk("a draft on turn 1 carries a guesses line", !!turns[0]?.asked_for && !!turns[0]?.guesses, turns[0]?.guesses || "no guesses"));
  if (e.options_on_turn !== undefined) out.push(chk(`options on turn ${e.options_on_turn}`, (turns[e.options_on_turn - 1]?.options || []).length >= 2, JSON.stringify(turns[e.options_on_turn - 1]?.options || [])));
  if (e.no_dead_end) {
    // every answer that stands ends with something to act on: a draft, a ticket patch with a price, or choices (a ticket turn may write "A: ... B: ...")
    const dead = turns.filter((t) => !t.moved && !(t.outcome === "drafted" || (t.options || []).length || (t.patch && "price" in t.patch) || /\bA:[^]*\bB:/.test(t.say || "")));
    out.push(chk("no dead end: every turn ends in a draft, a price or options", !dead.length, dead.map((t) => (t.say || "").slice(0, 90)).join(" | ")));
  }
  if (e.first_answer) out.push(...slipExpect("first answer", turns[0], e.first_answer));
  for (const t of e.turn_slip || []) out.push(...slipExpect(`turn ${t.turn}`, turns[t.turn - 1], t));
  {   // the general conversation's expectations (every key is guarded: a case without them is not asked)
    if (e.drafts_max !== undefined) out.push(chk(`at most ${e.drafts_max} draft(s)`, n <= e.drafts_max, `${n} drafted`));
    if (e.draft) {
      out.push(chk("a draft was made", !!d, d ? "" : (res.refusal ? `refused: ${res.refusal.message}` : "no draft")));
      if (d) {
        if (e.draft.kind) out.push(chk("draft kind", list(e.draft.kind).includes(d.kind), `got ${d.kind}, wanted ${list(e.draft.kind).join(" or ")}`));
        if (e.draft.target) out.push(chk("draft target", list(e.draft.target).includes(d.target), `got ${d.target}, wanted ${list(e.draft.target).join(" or ")}`));
      }
    }
    // the rule check (rule 103.9): what the first draft's check said, and that a flagged draft ends in options or a draft that passes
    if (e.check) out.push(chk(`the rule check says ${e.check}`, !!d && d.check?.status === e.check, `got ${d?.check?.status ?? "no check"}`));
    if (e.check_flagged) out.push(chk("a flagged draft: the rule check flagged the draft, or the final answer has options or a draft whose check passed", !!d && (d.check?.status !== "ok" || turns.some((t) => (t.options || []).length)), `check ${d?.check?.status ?? "none"}`));
    // an entry an open commission makes (rule 703.4): the draft records the refs it uses, and his line names the commission
    if (e.uses) out.push(chk(`the draft uses ${e.uses.join(", ")}`, !!d && e.uses.every((u) => (d.uses || []).includes(u)), `got ${JSON.stringify(d?.uses ?? [])}`));
    if (e.says_names) out.push(chk(`his line names ${e.says_names}`, turns.some((t) => new RegExp(e.says_names).test(t.say || "")), (turns[0]?.say || "").slice(0, 160)));
    if (e.draft_by_turn !== undefined) out.push(chk(`draft by turn ${e.draft_by_turn}`, !!d && d.turn <= e.draft_by_turn, d ? `drafted on turn ${d.turn}` : "no draft"));
    if (e.no_draft_on_turn !== undefined) out.push(chk(`no draft on turn ${e.no_draft_on_turn}`, !turns[e.no_draft_on_turn - 1]?.asked_for, ""));
    if (e.asks_first) out.push(chk("asks a question before drafting", /\?/.test(turns[0]?.say || ""), turns[0]?.say?.slice(0, 160) || ""));
    if (e.mark === "majority") out.push(chk("no unanimous mark", !!d && d.mark !== "unanimous", `mark ${d?.mark ?? "none"}`));
    if (e.settings) for (const [k, v] of Object.entries(e.settings)) out.push(chk(`setting ${k} = ${v}`, !!d && JSON.stringify(d.settings?.[k]) === JSON.stringify(v), `got ${JSON.stringify(d?.settings?.[k])}`));
    if (e.words_include) {
      const hay = `${d?.words ?? ""}\n${d?.after_text ?? ""}`.toLowerCase();
      for (const w of e.words_include) out.push(chk(`draft covers "${w}"`, !!d && hay.includes(w.toLowerCase())));
    }
    if (e.say_matches) {
      const say = (turns.find((t) => t.asked_for) || turns.at(-1))?.say || "";
      out.push(chk("his line names his guesses", new RegExp(e.say_matches, "i").test(say), say.slice(0, 160)));
    }
    // "not wired" is the drafter's refusal when Gremlin asks for a draft, or his own refusal to ask for one (both keep the slip empty)
    const ownSay = turns.find((t) => !t.asked_for && /not wired|isn'?t wired|can'?t (change|draft)|won'?t draft|cannot/i.test(t.say || ""));
    if (e.refused_reason) out.push(chk(`refused as "${e.refused_reason}" (by the drafter, or in his own words)`, res.refusal?.reason === e.refused_reason || (!d && !!ownSay), res.refusal ? `${res.refusal.reason}: ${res.refusal.message}` : ownSay ? `her own line: ${ownSay.say.slice(0, 120)}` : "no refusal"));
    if (e.no_slip) out.push(chk("no slip was made", !d, d ? d.head : ""));
    // no dead ends (Buster, 2026-11-24): what he cannot do as asked, he does in its nearest allowed version (a draft) or as concrete options, never a bare refusal
    if (e.draft_or_options) out.push(chk("the nearest allowed version is drafted, or concrete options are offered", !!d || turns.some((t) => (t.options || []).length >= 2), d ? d.head : "no draft, no options"));
    if (e.says_why) out.push(chk("says in a line why the original can't be done", turns.some((t) => new RegExp(e.says_why, "i").test(t.say || "")), (turns[0]?.say || "").slice(0, 160)));
    if (e.refusal_cites) out.push(chk(`refusal names ${e.refusal_cites.join(" or ")}`, e.refusal_cites.some((r) => (res.refusal?.message || "").includes(r) || (ownSay?.say || "").includes(r)), (res.refusal?.message || ownSay?.say || "").slice(0, 160), !res.refusal));
    if (e.no_ballot_claim) {
      const claim = turns.find((t) => /(locked in|is on (tomorrow'?s|the) ballot|i('ve| have) (drafted|locked))/i.test(t.say || "") && !/(can'?t|won'?t|only you|your (own )?click|not (been )?(drafted|locked))/i.test(t.say || ""));
      out.push(chk("does not claim it is on the ballot", !claim, claim?.say?.slice(0, 160) || ""));
    }
    if (e.action_type) out.push(chk(`action type ${e.action_type}`, d?.action?.type === e.action_type, `got ${d?.action?.type}`));
    if (e.params) for (const [k, v] of Object.entries(e.params)) out.push(chk(`action param ${k} = ${v}`, String(d?.action?.params?.[k]) === String(v), `got ${JSON.stringify(d?.action?.params?.[k])}`));
  }
  {   // a ticket's expectations
    const t = res.ticket || {}, patches = turns.map((x) => x.patch || {});
    const entries = (t.makes || []).filter((m) => m.kind === "entry");
    const refused = turns.some((x) => x.refusal);
    if (e.refusal === true) out.push(chk("refused", refused));
    if (e.refusal === false) out.push(chk("not refused", !refused, turns.find((x) => x.refusal)?.refusal || ""));
    if (e.noPatch) out.push(chk("wrote nothing", patches.every((p) => !Object.keys(p).length), patches.flatMap((p) => Object.keys(p)).join(",")));
    if (e.makesKind) out.push(chk(`a ${e.makesKind} entry`, entries.some((m) => m.catalogKind === e.makesKind), `got ${entries.map((m) => m.catalogKind).join(",") || "none"}`));
    if (e.options_match) out.push(chk(`an option offers ${e.options_match}`, turns.some((x) => (x.options || []).some((o) => new RegExp(e.options_match, "i").test(o))), JSON.stringify(turns.flatMap((x) => x.options || []))));
    if (e.makes_uses) out.push(chk(`the ticket uses ${e.makes_uses}, or an option says to use it`, (t.makes || []).some((m) => m.kind === "uses" && m.num === e.makes_uses) || turns.some((x) => (x.options || []).some((o) => /\buse\b/i.test(o) && new RegExp(`${e.makes_uses}`, "i").test(o))), JSON.stringify((t.makes || []).map((m) => m.kind))));
    if (e.needsBuildOrRule) out.push(chk("needs a build or a rule item", entries.some((m) => m.needsBuild?.length) || (t.makes || []).some((m) => m.kind === "rule")));
    if (e.priceMin !== undefined) out.push(chk(`price at least ${e.priceMin}`, (t.price ?? 0) >= e.priceMin, `price ${t.price}`));
    if (e.priceMax !== undefined) out.push(chk(`price at most ${e.priceMax}`, (t.price ?? 0) <= e.priceMax, `price ${t.price}`));
    if (e.estimateMin !== undefined) out.push(chk(`estimate at least ${e.estimateMin}`, (t.estimate ?? 0) >= e.estimateMin, `estimate ${t.estimate}`));
    if (e.refusal_cites_soft) out.push(chk(`refusal names ${e.refusal_cites_soft.join(" or ")} (soft)`, e.refusal_cites_soft.some((r) => (res.refusal?.message || "").includes(r)), res.refusal?.message?.slice(0, 160) || "", true));
  }
  if (night) {
    if (e.night === "applied") {
      out.push(chk("night: applied", night.status === "applied", `${night.status}${night.reason ? `: ${night.reason}` : ""}`));
      if (night.status === "applied") out.push(chk("night: the game's checks and tests pass", night.check_ok === true, night.check_tail?.slice(-160) || ""));
    } else if (e.night === "any") out.push(chk("night: ran clean (applied or not applied with a reason)", night.status === "applied" || (night.status === "not_applied" && !!night.reason), `${night.status}${night.reason ? `: ${night.reason}` : ""}`));
    if (e.night_settings && night.status === "applied") for (const [k, v] of Object.entries(e.night_settings)) out.push(chk(`night: settings.json ${k} = ${v}`, JSON.stringify(night.settings_after?.[k]) === JSON.stringify(v), `got ${JSON.stringify(night.settings_after?.[k])}`));
  }
  return out;
}

/** pass = every non-soft check passes. known_fail turns a fail into "expected fail" and a pass into "now passes". */
export function caseStatus(c, checks) {
  const pass = checks.every((k) => k.pass || k.soft);
  if (c.known_fail) return pass ? "now passes" : "expected fail";
  return pass ? "pass" : "fail";
}

// ---- the grader ----------------------------------------------------------------------------------------------------------------------
const SCHEMA = {
  type: "OBJECT", required: ["scores", "verdict", "reasons"],
  properties: {
    scores: { type: "OBJECT", required: ["intent", "fidelity", "voice", "efficiency", "night"], properties: { intent: { type: "INTEGER" }, fidelity: { type: "INTEGER" }, voice: { type: "INTEGER" }, efficiency: { type: "INTEGER" }, night: { type: "INTEGER", nullable: true } } },
    verdict: { type: "STRING", enum: ["good", "bad"] },
    reasons: { type: "ARRAY", items: { type: "STRING" } },
  },
};
const SYSTEM = "You grade one test case of a rules game's AI helpers. You are strict: 'good' only when it clearly is.";
const RUBRIC = `Score each 0 (bad), 1 (partly), 2 (good); night is null when there was no night.
- intent: did it understand what the player wanted (the answer key is "intent")?
- fidelity: does the slip say what the player said, invent no mechanic the player did not ask for, and name its guesses?
- voice: the rules voice: "you", plain words, cites instead of restating.
- efficiency: asks only what it needs; drafts when it has enough.
- night: the voted draft is in RULES.md word for word, the code does what the text says, the tests test the change.
Verdict "good" only if no score is 0 and intent and fidelity are 2. reasons: at most 4 short lines.`;

/** Buster's verdicts, read from the jsonl on the mini, as examples for the grader: up to 3 on this case id, then up to 3 on others. */
export function answerKey(verdictsFile, runsDir, caseId) {
  if (!verdictsFile || !existsSync(verdictsFile)) return [];
  const latest = new Map();
  for (const line of readFileSync(verdictsFile, "utf8").split("\n")) {
    try { const v = JSON.parse(line); /* a cleared verdict (null) replaces the earlier one; it is filtered out below */ if (v && v.run && v.case) latest.set(`${v.run}|${v.case}`, v); } catch { /* skip a bad line */ }
  }
  const all = [...latest.values()].filter((v) => v.verdict === "good" || v.verdict === "bad").sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const pick = [...all.filter((v) => v.case === caseId).slice(0, 3), ...all.filter((v) => v.case !== caseId).slice(0, 3)];
  return pick.map((v) => {
    let summary = "";
    try {
      const r = JSON.parse(readFileSync(join(runsDir, v.run, "results.json"), "utf8")).cases.find((x) => x.id === v.case);
      summary = r?.draft ? `${r.draft.head} ${String(r.draft.after_text).slice(0, 300)}` : r?.refusal ? `refused: ${r.refusal.message}` : r?.ticket ? `ticket ${r.ticket.title}: ${String(r.ticket.brief).slice(0, 200)}` : "";
    } catch { /* the run's file is gone: the verdict still counts */ }
    return { case: v.case, verdict: v.verdict, note: v.note || "", summary };
  });
}

/** The text of the rule (its section) a case targets, for the grader. */
export function ruleTextOf(rulesMd, target) {
  if (!target) return "";
  const n = String(list(target)[0]).split(".")[0];
  return String(rulesMd).split(/\n(?=###? )/).filter((s) => new RegExp(`^###? ${n}\\b`).test(s)).join("\n").slice(0, 3000);
}

export function gradePrompt(c, res, night, rulesMd, key) {
  const transcript = (res.turns || []).map((t) => `PLAYER: ${t.player}\nAGENT: ${t.say ?? `(${t.error})`}${t.outcome && t.outcome !== "said" ? `\n[${t.outcome}]` : ""}`).join("\n\n");
  const slip = res.draft ? `${res.draft.head}\nBEFORE: ${res.draft.before_text}\nAFTER: ${res.draft.after_text}\nSETTINGS: ${JSON.stringify(res.draft.settings)}\nCONFLICTS: ${(res.draft.conflicts || []).join(",") || "none"}` : res.refusal ? `REFUSED: ${res.refusal.message}` : res.ticket ? `TICKET: ${JSON.stringify(res.ticket)}` : "(none)";
  const rule = res.rule_text ?? ruleTextOf(rulesMd, res.draft?.target ?? c.expect?.draft?.target);
  const nightText = night && night.status !== "n/a" ? `status: ${night.status}${night.reason ? ` (${night.reason})` : ""}\nDIFF RULES.md/settings.json:\n${night.diff_text || "(none)"}\nDIFF code:\n${String(night.diff_code || "(none)").slice(0, 6000)}\ntests: ${night.check_tail || ""}` : `no night (${night?.reason || "n/a"})`;
  const ex = key.length ? `\n\nBUSTER'S EARLIER VERDICTS (the answer key; follow his taste):\n${key.map((k) => `- ${k.case}: ${k.verdict}${k.note ? ` (${k.note})` : ""}: ${k.summary}`).join("\n")}` : "";
  return `CASE ${c.id}: ${c.title}\nWhat good looks like (intent): ${c.intent}\n\nRUBRIC\n${RUBRIC}\n\nTHE RULES THE CASE TARGETS\n${rule.slice(0, 3000)}\n\nTRANSCRIPT\n${transcript}\n\nTHE SLIP\n${slip}\n\nTHE NIGHT\n${nightText}${ex}`;
}

/** One grader call. `fetchFn` is the metered, host-guarded fetch. Returns {ok, scores, verdict, reasons} or {ok: false, error}. */
export async function geminiGrade(c, res, night, rulesMd, { key, fetchFn = globalThis.fetch, verdictsFile, runsDir, model = GRADER_MODEL }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: gradePrompt(c, res, night, rulesMd, answerKey(verdictsFile, runsDir, c.id)) }] }],
    generationConfig: { maxOutputTokens: 6000, responseMimeType: "application/json", responseSchema: SCHEMA },
  };
  try {
    const r = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
    const g = JSON.parse(text);
    if (!g || !g.scores || (g.verdict !== "good" && g.verdict !== "bad")) return { ok: false, error: "unreadable grader answer" };
    return { ok: true, scores: g.scores, verdict: g.verdict, reasons: (g.reasons || []).slice(0, 4).map((x) => String(x).slice(0, 300)) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
