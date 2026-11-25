// The chat stage: a scripted player talks to the REAL Starling or Gremlin (starlingRequest / gremlinRequest + callModel +
// read*Answer), and a draft goes through the REAL drafter pipeline (tests/quality/pipeline.mjs). History, slip and ticket are
// held in memory, built the way the routes build them (api-starling.ts ~160-205, api-chat.ts); no database (plan section 1).
import { CHAT_TIMEOUT_MS, MODEL, MOODS, OUTPUT_CAP_TOKENS, answerSchema as gremlinSchema, gremlinRequest, moodOf, readGremlinAnswer, systemStatic as gremlinSystem } from "../../src/lib/gremlin.js";
import { answerSchema as starlingSchema, plainForQuote, readStarlingAnswer, starlingRequest, systemStatic as starlingSystem } from "../../src/lib/starling.js";
import { STARTER_CATALOG } from "../lib.mjs";
import { CapReached } from "./lib.mjs";
import { pipeline } from "./pipeline.mjs";

export const PLAYERS = [{ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" }, { id: "cy", name: "Cy" }];
export const LOCAL_DATE = "2026-11-24";
const PER_DAY = 3, CEILING = 25;
const clip = (s, n = 4000) => String(s ?? "").slice(0, n);

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
    if (c.agent === "starling") await starlingCase(c, x, res); else await gremlinCase(c, x, res);
  } catch (e) {
    if (e instanceof CapReached || x.meter.capHit) res.notRun = `cap: ${x.meter.capHit || e.message}`;
    else res.error = clip(e?.message || e, 300);
  }
  res.micro = res.turns.reduce((a, t) => a + (t.micro || 0), 0);
  res.ms = res.turns.reduce((a, t) => a + (t.ms || 0), 0);
  return res;
}

async function starlingCase(c, x, res) {
  const history = [];
  let slip = null, drafted = null, sent = 0;
  const state = { draft: false, lastSay: "" };
  const env = { MODEL_API_KEY: x.keys.model };
  for (let message = nextLine(c, sent, state); message !== null; message = nextLine(c, ++sent, state)) {
    x.meter.guard(63_000, `${c.id} turn ${sent + 1}`);
    const { system, messages } = starlingRequest({
      rulesMd: x.rulesMd, localDate: LOCAL_DATE, perDay: PER_DAY, actions: x.actions, history, label: "Ada", message, rule: null,
      slip, drafted, made: 0, limit: PER_DAY, noDraft: null,
    });
    const turn = { player: message, say: null, quotes: [], dropped: [], escalate: null, asked_for: null, outcome: null, micro: 0, ms: 0, usage: null };
    res.turns.push(turn);
    const { value: r, slot } = await x.meter.slotted(() => x.agent.callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: starlingSchema(), effort: "low" }));
    Object.assign(turn, { micro: slot.micro, ms: slot.ms, usage: slot.usage });
    if (x.meter.capHit) throw new CapReached(x.meter.capHit);
    if (!r.ok) { turn.error = `call failed: ${r.code} ${clip(r.reason, 120)}`; res.error = turn.error; return; }
    const a = readStarlingAnswer(r.text, { book: x.book, systemText: starlingSystem(), rulesPlain: plainForQuote(x.rulesMd), playerText: message });
    turn.canary_or_prompt_leak = !a.ok && a.code === "invalid";
    if (!a.ok) { turn.error = `unreadable answer: ${a.code} ${clip(a.reason, 120)}`; res.error = turn.error; return; }
    Object.assign(turn, { say: a.say, quotes: a.quotes, dropped: a.dropped, escalate: a.escalate, outcome: "said" });
    if (a.draft) {
      turn.asked_for = a.draft;
      const asked = a.draft.kind === "action" ? { kind: "action", type: a.draft.type, params: a.draft.params } : { kind: a.draft.kind, target: a.draft.target, words: a.draft.words, to: a.draft.to, mark: a.draft.mark };
      const { value: p, slot: ps } = await x.meter.slotted(() => pipeline(x.drafter, x.book, x.rulesMd, asked, env, { actions: { catalog: x.actions, players: PLAYERS, proposer: "ada" }, isCap: (e) => e instanceof CapReached }));
      turn.micro += ps.micro; turn.ms += ps.ms;
      if (x.meter.capHit) throw new CapReached(x.meter.capHit);
      if (p.outcome === "drafted") {
        // The route's own slip and "drafted" (api-starling.ts): the draft is not locked in; she sees its head and text next turn.
        slip = { n: null, status: "a draft, not locked in", head: p.head, after_text: p.after_text, words: asked.words ?? "", conflicts: p.conflicts };
        drafted = { head: p.head, after_text: p.after_text, conflicts: p.conflicts };
        state.draft = true;
        turn.outcome = "drafted";
        turn.pipeline = { head: p.head, drafted_by: p.drafted_by };
        res.draft = { kind: p.req.kind, scope: p.req.scope, target: p.req.target, new_num: p.new_num, to_block: p.req.to_block, mark: p.req.mark ?? null, words: asked.words ?? "", head: p.head, before_text: p.before_text, after_text: p.after_text, settings: p.settings, conflicts: p.conflicts, drafted_by: p.drafted_by, action: p.req.action ?? null, turn: sent + 1 };
        res.refusal = null;
      } else {
        drafted = { refused: p.message };
        turn.outcome = `refused: ${p.reason}`;
        turn.pipeline = { reason: p.reason, message: p.message };
        res.refusal = { reason: p.reason, message: p.message, turn: sent + 1 };
      }
      res.draft_count = (res.draft_count || 0) + (p.outcome === "drafted" ? 1 : 0);
    }
    history.push({ role: "player", body: message }, { role: "agent", body: a.say });
    state.lastSay = a.say;
  }
  res.draft_count ||= 0;
}

async function gremlinCase(c, x, res) {
  const history = [];
  const blank = { number: 1, title: "", brief: "", makes: [], estimate: 1, running_cost: "", tasks: [], price: 0, price_reason: "" };
  let ticket = { ...blank };
  const mood = MOODS.find((m) => m[0] === "charmed") || moodOf("quality", LOCAL_DATE);
  const env = { MODEL_API_KEY: x.keys.model };
  let sent = 0, message = nextLine(c, sent, { draft: true });
  res.catalog_shape = "STARTER_CATALOG";   // the scratch game's catalog.json is a different shape; the starter catalog is what the evals use
  while (message !== null) {
    x.meter.guard(63_000, `${c.id} turn ${sent + 1}`);
    const { system, messages } = gremlinRequest({ ceiling: CEILING, rulesMd: x.rulesMd, mood, localDate: LOCAL_DATE, catalog: STARTER_CATALOG, history, ticket, posts: [], queueDepth: 0, rejected: [], label: "Ada", message, noWrite: null });
    const turn = { player: message, say: null, refusal: null, patch: null, rejected: [], escalate: null, outcome: null, micro: 0, ms: 0, usage: null };
    res.turns.push(turn);
    const { value: r, slot } = await x.meter.slotted(() => x.agent.callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: gremlinSchema(), effort: "low" }));
    Object.assign(turn, { micro: slot.micro, ms: slot.ms, usage: slot.usage });
    if (x.meter.capHit) throw new CapReached(x.meter.capHit);
    if (!r.ok) { turn.error = `call failed: ${r.code} ${clip(r.reason, 120)}`; res.error = turn.error; return; }
    const a = readGremlinAnswer(r.text, { ceiling: CEILING, systemText: gremlinSystem({ ceiling: CEILING }), catalog: STARTER_CATALOG, makes: ticket.makes, price: ticket.price });
    if (!a.ok) { turn.error = `unreadable answer: ${a.code} ${clip(a.reason, 120)}`; res.error = turn.error; return; }
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
