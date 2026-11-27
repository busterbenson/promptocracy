// The chat stage: a scripted player talks to the REAL Gremlin, in the general conversation (generalRequest) or on a ticket (gremlinRequest), with
// callModel + read*Answer; a commission asked in general continues on a ticket and a rule change asked on a ticket continues in general, once per
// message, and a draft goes through the REAL drafter pipeline (tests/quality/pipeline.mjs) and the REAL rule check, with the game's catalog, and the retries after a refusal and after a blocked
// check are src/lib/draft-turn.js, the same function the route calls (api-chat.ts generalTurn). History, slip and ticket are
// held in memory, built the way the route builds them (api-chat.ts generalTurn / ticketTurn); no database (plan section 1).
import { CHAT_TIMEOUT_MS, MODEL, MOODS, OUTPUT_CAP_TOKENS, answerSchema as gremlinSchema, gremlinRequest, moodOf, moveOf, readGremlinAnswer, systemStatic as gremlinSystem } from "../../src/lib/gremlin.js";
import { checkQuote, generalSchema, plainForQuote, readGeneralAnswer, generalRequest, systemStatic as generalSystem } from "../../src/lib/gremlin-rules.js";
import { draftTurn } from "../../src/lib/draft-turn.js";
import { STARTER_CATALOG } from "../lib.mjs";
import { mentionedEntries } from "../../src/lib/entries.js";
import { CapReached, entriesOf } from "./lib.mjs";
import { pipeline } from "./pipeline.mjs";

export const PLAYERS = [{ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" }, { id: "cy", name: "Cy" }];
export const LOCAL_DATE = "2026-11-24";
const PER_DAY = 3, CEILING = 25;
const clip = (s, n = 4000) => String(s ?? "").slice(0, n);

/** The quotes of a raw answer that the rulebook check dropped, with the number and the first words, so a drop can be read from the page (it is only a reason in the stored line). */
function droppedQuotes(text, book) {
  try { return (JSON.parse(text).quotes || []).map((q) => ({ num: q?.num, text: clip(q?.text, 240), why: checkQuote(book, q).dropped })).filter((q) => q.why); } catch { return []; }
}

/** What the player sees on the slip a turn ends with (the harness's turns[i].slip): the draft that stands and its rule check. */
function slipRecord(p, asked, fresh) {
  const c = p.check;
  return {
    kind: p.req.kind, target: p.req.target, words: asked.words ?? "", after_text: p.after_text, head: p.head, fresh,
    check: c?.status ?? null, missing: (c?.missing || []).map((m) => ({ what: m.what, why: m.why })), fixes: (c?.fixes || []).map((f) => f.say),
    engine_note: c?.engine_note ?? null, unchecked_reason: c?.reason ?? null,
  };
}

/** The scripted lines of one case, as a generator of "what to send next" given what has happened so far. */
function nextLine(c, sent, state) {
  if (sent < c.turns.length) return c.turns[sent];
  const extra = sent - c.turns.length;
  if (extra < (c.if_asked || []).length && !state.draft && /\?/.test(state.lastSay || "")) return c.if_asked[extra];
  return null;
}

/** One case of the chat stage. `x`: {meter, agent, drafter, keys, rulesMd, book, actions}. Never throws on a model failure: the case records it. */
export async function runChatCase(c, x) {
  const res = { id: c.id, agent: c.agent, title: c.title, intent: c.intent, turns: [], draft: null, refusal: null, ticket: null, error: null, notRun: null, micro: 0, ms: 0 };
  try {
    if ((c.start || (c.agent === "gremlin" ? "ticket" : "general")) === "general") await generalCase(c, x, res, {}); else await gremlinCase(c, x, res, {});
  } catch (e) {
    if (e instanceof CapReached || x.meter.capHit) res.notRun = `cap: ${x.meter.capHit || e.message}`;
    else res.error = clip(e?.message || e, 300);
  }
  res.micro = res.turns.reduce((a, t) => a + (t.micro || 0), 0);
  res.ms = res.turns.reduce((a, t) => a + (t.ms || 0), 0);
  return res;
}

/** `o`: {sent (turns already used), moved (this message came from a ticket)}. @rule 801.6 */
async function generalCase(c, x, res, o) {
  const history = [];
  let slip = null, drafted = null, sent = o.sent || 0, moved = !!o.moved, standing = null;
  const state = { draft: false, lastSay: "" };
  const env = { MODEL_API_KEY: x.keys.model };
  const entries = entriesOf(c, x.catalog);   // the catalog's entries and what the case's open commissions make (rules 701.4, 703.4)
  for (let message = nextLine(c, sent, state); message !== null; message = nextLine(c, ++sent, state)) {
    x.meter.guard(63_000, `${c.id} turn ${sent + 1}`);
    const request = (retry, found, foundMode) => generalRequest({
      rulesMd: x.rulesMd, localDate: LOCAL_DATE, perDay: PER_DAY, actions: x.actions, history, label: "Ada", message, rule: null,
      slip, drafted, made: 0, limit: PER_DAY, noDraft: null, retry, found, foundMode, redraft: null, entries,
    });
    const { system, messages } = request();
    const turn = { player: message, say: null, quotes: [], dropped: [], escalate: null, asked_for: null, outcome: null, micro: 0, ms: 0, usage: null };
    res.turns.push(turn);
    let { value: r, slot } = await x.meter.slotted(() => x.agent.callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: generalSchema(), effort: "low" }));
    Object.assign(turn, { micro: slot.micro, ms: slot.ms, usage: slot.usage });
    if (x.meter.capHit) throw new CapReached(x.meter.capHit);
    if (!r.ok) { turn.error = `call failed: ${r.code} ${clip(r.reason, 120)}`; res.error = turn.error; return; }
    let a = readGeneralAnswer(r.text, { book: x.book, systemText: generalSystem(), rulesPlain: plainForQuote(x.rulesMd), playerText: message, entries });
    turn.canary_or_prompt_leak = !a.ok && a.code === "invalid";
    if (!a.ok) { turn.error = `unreadable answer: ${a.code} ${clip(a.reason, 120)}`; res.error = turn.error; return; }
    if (a.dropped.length) turn.dropped_quotes = droppedQuotes(r.text, x.book);   // which quotes, so a drop can be read from the page
    Object.assign(turn, { say: a.say, quotes: a.quotes, dropped: a.dropped, escalate: a.escalate, options: a.options, guesses: a.guesses, commission: a.commission, outcome: "said" });
    // a commission asked here: the site opens a ticket and the message goes there (one move a message): the case continues on a ticket with the rest of the script
    if (a.commission && !a.draft && !moved) {
      turn.outcome = "moved to a ticket"; turn.moved = true; res.opened_ticket = true;
      return gremlinCase({ ...c, turns: [message, ...c.turns.slice(sent + 1)] }, x, res, { moved: true, general_turns: res.turns.length });
    }
    if (a.draft) {
      turn.asked_for = a.draft;
      const askedOf = (d) => (d.kind === "action" ? { kind: "action", type: d.type, params: d.params } : { kind: d.kind, target: d.target, words: d.words, to: d.to, mark: d.mark, uses: d.uses });
      const tries = [];   // every draft the drafter was asked for this turn, with its pipeline result
      const read = (call) => readGeneralAnswer(call.text, { book: x.book, systemText: generalSystem(), rulesPlain: plainForQuote(x.rulesMd), playerText: message });
      // The route's draft-and-retry step, itself (src/lib/draft-turn.js): the refusal retry, the retry after a blocked check, the check's fixes as options.
      // Only the I/O is the harness's: the model call, and the pipeline for the draft (which makes the check, with the game's catalog).
      const t = await draftTurn({
        r, a, noDraft: null, read,
        ask: async (retry, found, mode) => {
          const again = request(retry, found, mode);
          const { value: r2, slot: s2 } = await x.meter.slotted(() => x.agent.callModel(env, { model: MODEL, system: again.system, messages: again.messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: generalSchema(), effort: "low" }));
          turn.micro += s2.micro; turn.ms += s2.ms;
          if (x.meter.capHit) throw new CapReached(x.meter.capHit);
          return r2;
        },
        tryDraft: async (ans) => {
          const asked = askedOf(ans.draft);
          const { value: p, slot: ps } = await x.meter.slotted(() => pipeline(x.drafter, x.book, x.rulesMd, asked, env, { actions: { catalog: x.actions, players: PLAYERS, proposer: "ada" }, draftcheck: x.draftcheck, catalog: x.catalog, pending: entries.pending, isCap: (e) => e instanceof CapReached }));
          turn.micro += ps.micro; turn.ms += ps.ms;
          if (x.meter.capHit) throw new CapReached(x.meter.capHit);
          tries.push({ p, asked });
          return p.outcome === "drafted" ? { id: `draft${tries.length}`, check: p.check ?? null, p, asked } : { refused: { error: p.message }, why: p.reason, p, asked };
        },
      });
      a = t.a; r = t.r;
      Object.assign(turn, { say: a.say, quotes: a.quotes, escalate: a.escalate, options: a.options, guesses: a.guesses });
      if (t.notes.length) turn.retry = t.notes;
      if (t.notes.some((n) => /^retry after refusal/.test(n))) { turn.retried = true; turn.first_refusal = tries[0]?.p.message; }
      if (a.draft) turn.asked_for = a.draft;
      const fin = t.res.p ? t.res : { p: tries.at(-1).p, asked: tries.at(-1).asked };
      const { p, asked } = fin;
      if (p.outcome === "drafted") {
        // The route's own slip and "drafted" (api-chat.ts generalTurn): the draft is not locked in; she sees its head, text and check next turn.
        slip = { n: null, status: "a draft, not locked in", head: p.head, after_text: p.after_text, words: asked.words ?? "", conflicts: p.conflicts };
        drafted = { head: p.head, after_text: p.after_text, conflicts: p.conflicts, check: p.check ?? null };
        state.draft = true;
        turn.outcome = "drafted";
        turn.pipeline = { head: p.head, drafted_by: p.drafted_by };
        res.draft = { kind: p.req.kind, scope: p.req.scope, target: p.req.target, new_num: p.new_num, to_block: p.req.to_block, mark: p.req.mark ?? null, words: asked.words ?? "", head: p.head, before_text: p.before_text, after_text: p.after_text, settings: p.settings, conflicts: p.conflicts, drafted_by: p.drafted_by, action: p.req.action ?? null, check: p.check ?? null, uses: (asked.uses || []).length ? asked.uses : ((m) => (m.length === 1 ? [m[0].ref] : []))(mentionedEntries(asked.words, entries)), turn: sent + 1 };   // the route's usesOf: no refs sent, the one entry the words name
        res.refusal = null;
      } else {
        drafted = { refused: p.message };
        turn.outcome = `refused: ${p.reason}`;
        turn.pipeline = { reason: p.reason, message: p.message };
        res.refusal = { reason: p.reason, message: p.message, turn: sent + 1 };
      }
      res.draft_count = (res.draft_count || 0) + (p.outcome === "drafted" ? 1 : 0);
      if (p.outcome === "drafted") turn.slip = slipRecord(p, asked, true);
    }
    // the standing slip after this turn (the draft that stands, or the one from an earlier turn): what the player sees at the end of his answer
    if (!turn.slip && standing) turn.slip = { ...standing, fresh: false };
    if (turn.slip) standing = turn.slip;
    history.push({ role: "player", body: message }, { role: "agent", body: a.say });
    state.lastSay = a.say;
    moved = false;   // one move is for the one message that came here
  }
  res.draft_count ||= 0;
}

/** `o`: {moved (this message came from the general conversation), general_turns}. @rule 801.6 */
async function gremlinCase(c, x, res, o) {
  const history = [];
  const blank = { number: 1, title: "", brief: "", makes: [], estimate: 1, running_cost: "", tasks: [], price: 0, price_reason: "" };
  let ticket = { ...blank };
  const mood = MOODS.find((m) => m[0] === "charmed") || moodOf("quality", LOCAL_DATE);
  const env = { MODEL_API_KEY: x.keys.model };
  const entries = entriesOf(c, x.catalog);   // the catalog's entries and what the case's open commissions make (rules 701.4, 703.4)
  let sent = 0, message = nextLine(c, sent, { draft: true }), moved = !!o.moved;
  res.catalog_shape = "STARTER_CATALOG";   // the scratch game's catalog.json is a different shape; the starter catalog is what the evals use
  while (message !== null) {
    x.meter.guard(63_000, `${c.id} turn ${sent + 1}`);
    const { system, messages } = gremlinRequest({ ceiling: CEILING, rulesMd: x.rulesMd, mood, localDate: LOCAL_DATE, catalog: STARTER_CATALOG, history, ticket, posts: [], queueDepth: 0, rejected: [], label: "Ada", message, noWrite: null, entries });
    const turn = { player: message, say: null, refusal: null, patch: null, rejected: [], escalate: null, outcome: null, micro: 0, ms: 0, usage: null };
    res.turns.push(turn);
    const { value: r, slot } = await x.meter.slotted(() => x.agent.callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: gremlinSchema(), effort: "low" }));
    Object.assign(turn, { micro: slot.micro, ms: slot.ms, usage: slot.usage });
    if (x.meter.capHit) throw new CapReached(x.meter.capHit);
    if (!r.ok) { turn.error = `call failed: ${r.code} ${clip(r.reason, 120)}`; res.error = turn.error; return; }
    const a = readGremlinAnswer(r.text, { ceiling: CEILING, systemText: gremlinSystem({ ceiling: CEILING }), catalog: STARTER_CATALOG, entries, makes: ticket.makes, price: ticket.price });
    if (!a.ok) { turn.error = `unreadable answer: ${a.code} ${clip(a.reason, 120)}`; res.error = turn.error; return; }
    // a rule change or an action asked on a ticket: the message goes to the general conversation, and the case continues there with the rest of the script
    if (moveOf(a) === "general" && !moved) {
      turn.say = a.say; turn.moved = true; turn.outcome = "moved to general"; res.moved_to_general = true;
      return generalCase({ ...c, turns: c.turns }, x, res, { sent, moved: true });
    }
    moved = false;
    Object.assign(turn, { options: a.options });
    const patch = a.refusal ? {} : a.patch;
    Object.assign(turn, { say: a.say, refusal: a.refusal, patch, rejected: a.rejected, escalate: a.escalate, outcome: a.refusal ? "refused" : Object.keys(patch).length ? "wrote" : "said", unbuiltPrice: a.unbuiltPrice, clamped: a.clamped });
    // gremlinWrite's merge: each field the patch carries replaces the ticket's (api-tickets.ts 273)
    ticket = { ...ticket, ...patch };
    if (a.refusal) res.refusal = { reason: "refused", message: a.refusal, turn: sent + 1 };
    history.push({ role: "player", body: message }, { role: "agent", body: a.say });
    message = nextLine(c, ++sent, { draft: true });
  }
  res.ticket = ticket;
}
