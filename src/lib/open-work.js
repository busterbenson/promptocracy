// What Gremlin may read of everyone's open work (rule 106.8): every open proposal, every open ticket and the public discussion on the tickets, in both of his conversations.
// This is the pure half (shapes the rows and holds the caps); src/lib/open-work.ts is the one query and src/lib/gremlin.js writes the prompt section. The rule's two limits are
// held HERE, by what is never read: no vote and no vote count is ever selected (rule 104.4), and the discussion is the ticket's public thread, never a chat log (a private
// conversation with Gremlin). Only a game whose rulebook has 106.8 gets any of it: the caller checks (OPEN_WORK_RULE).
import { shownState } from "./tickets.js";

/** The clause the game's rulebook must have for Gremlin to be given this context. */
export const OPEN_WORK_RULE = "106.8";
/** The most proposals and tickets a prompt carries, the newest numbers first; the latest posts of each thread; the most a field, a post or the whole section may take. */
export const OPEN_PROPOSALS_MAX = 40, OPEN_TICKETS_MAX = 40, THREAD_POSTS_PER_TICKET = 5, TEXT_CLIP = 500, POST_CLIP = 300;
/** The statuses of a proposal that is open: locked in today (on the ballot tomorrow) or on the ballot now. A draft is private; every later status is decided. */
export const OPEN_PROPOSAL_STATUSES = ["confirmed", "on_ballot"];
/** The ticket states that are open (a Draft counts only for its own player, and is never another's). */
export const OPEN_TICKET_STATES = ["Proposed", "Ready", "Approved", "Building"];

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const json = (v, d) => { try { return typeof v === "string" ? JSON.parse(v || "") : v ?? d; } catch { return d; } };

/** A ticket's `makes` in a few words: "Flower (item)", "uses Flower from W4", "rule 801.2". @rule 106.2, 106.3 */
export function makesWords(makes) {
  return (Array.isArray(makes) ? makes : []).map((m) => {
    if (!m) return "";
    if (m.kind === "entry") return `${clip(m.name, 60)} (${clip(m.catalogKind, 30)})`;
    if (m.kind === "uses") return `uses ${clip(m.name, 60)} from ${clip(m.num, 10)}`;
    if (m.kind === "rule") return m.num ? `rule ${clip(m.num, 12)}` : `a new rule: ${clip(m.draft, 120)}`;
    return "";
  }).filter(Boolean).join("; ");
}

/**
 * The open work, from rows. `proposals`: {number, kind, scope, target, words, draft_head, after_text, mark, status, ticket_id, name}; `tickets`: {id, number, title, brief, state, held_at,
 * makes, price, player_id, name}; `posts`: {ticket_id, name, author_kind, body, id}. Selects only what is open and public: a Draft proposal is never read, a Draft ticket only
 * for its own player (`viewerId`) and never the one being drafted (`skipId`), and the fields below have no vote in them. Newest first, capped, each thread at its latest posts.
 * Claimed by 106.2 and 106.3, Gremlin's context assembly (the check-rule-claims tag is checked against the template, which has no 106.8). @rule 106.2, 106.3
 */
export function openWorkFrom({ proposals = [], tickets = [], posts = [] }, viewerId = null, skipId = null) {
  const props = proposals
    .filter((p) => p && OPEN_PROPOSAL_STATUSES.includes(p.status) && !p.ticket_id)   // a commission's proposal is its ticket (listed below)
    .sort((a, b) => b.number - a.number).slice(0, OPEN_PROPOSALS_MAX)
    .map((p) => ({ n: `P${p.number}`, owner: String(p.name ?? ""), kind: p.kind, target: String(p.target ?? ""), head: clip(p.draft_head, 160), words: clip(p.words, TEXT_CLIP), after: clip(p.after_text, TEXT_CLIP), mark: p.mark ?? "", when: p.status === "on_ballot" ? "on the ballot now" : "locked in today, on the ballot tomorrow" }));
  const open = tickets
    .filter((t) => t && t.id !== skipId && (OPEN_TICKET_STATES.includes(t.state) || (t.state === "Draft" && viewerId && t.player_id === viewerId)))
    .sort((a, b) => b.number - a.number).slice(0, OPEN_TICKETS_MAX);
  const byTicket = new Map();
  for (const x of [...posts].sort((a, b) => a.id - b.id)) { const l = byTicket.get(x.ticket_id) ?? []; l.push(x); byTicket.set(x.ticket_id, l); }
  const tix = open.map((t) => ({
    n: `W${t.number}`, owner: String(t.name ?? ""), state: shownState(t), title: clip(t.title, 120), brief: clip(t.brief, TEXT_CLIP), makes: makesWords(json(t.makes, [])), price: Number(t.price) || 0,
    discussion: t.state === "Draft" ? [] : (byTicket.get(t.id) ?? []).slice(-THREAD_POSTS_PER_TICKET).map((x) => ({ by: x.author_kind === "player" ? String(x.name ?? "") : x.author_kind === "gremlin" ? "Gremlin" : "Chalant", body: clip(x.body, POST_CLIP) })),
  }));
  return { proposals: props, tickets: tix };
}
