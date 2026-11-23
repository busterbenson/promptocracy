// The MCP tools. A THIN ADAPTER: each tool builds a Request for the matching web route and calls that route's
// own handler (api-rules, api-board, api-me, api-game, api-day, api-turn, api-proposals, api-action, api-end-turn, api-votes,
// api-ballot, api-start, api-tickets), so validation, guards, log lines
// and notifications are the web's, and a change to the turn model reaches MCP with no change here.
// The player is attached to the internal Request (actAs); no cookie or token is forged.
// NOT here yet: a catch-all "take an action". It arrives with the moderator.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Player, actAs } from "./auth";
import { Ctx } from "./util";
import { settingsText } from "./proposals.js";
import * as apiAction from "../routes/api-action";
import * as apiBoard from "../routes/api-board";
import * as apiDay from "../routes/api-day";
import * as apiEndTurn from "../routes/api-end-turn";
import * as apiGame from "../routes/api-game";
import * as apiMe from "../routes/api-me";
import * as apiProposals from "../routes/api-proposals";
import * as apiStart from "../routes/api-start";
import * as apiRules from "../routes/api-rules";
import * as apiTurn from "../routes/api-turn";
import * as apiVotes from "../routes/api-votes";
import * as apiBallot from "../routes/api-ballot";
import * as apiTickets from "../routes/api-tickets";
import * as apiEra from "./eras";

type Handler = (ctx: Ctx) => Promise<Response>;
type Result = { status: number; text: string; data: any };

// Call a web route's handler as `player`. The path only matters to handlers that build links from it.
/** @rule 101 */
async function viaRoute(ctx: Ctx, player: Player, handler: Handler, method: "GET" | "POST", name: string, body?: unknown, params: Record<string, string> = {}): Promise<Result> {
  const url = new URL(`/${ctx.data.game!.slug}/api/${name}`, ctx.request.url);
  const request = new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  actAs(request, player);
  const res = await handler({ ...ctx, request, params: { ...ctx.params, ...params } });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, text, data };
}

const reply = (r: Result, text = r.text) => ({ content: [{ type: "text" as const, text: r.status >= 400 ? (r.data?.error ?? text) : text }], isError: r.status >= 400 });
const asJson = (v: unknown) => JSON.stringify(v, null, 2);

export function registerTools(server: McpServer, ctx: Ctx, player: Player) {
  const game = ctx.data.game!;
  const read = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("read_rules", {
    description: "Read this game's rules (the RULES.md in the game's repo), as markdown.",
    annotations: read,
  }, async () => reply(await viaRoute(ctx, player, apiRules.get, "GET", "rules")));

  server.registerTool("read_board", {
    description: "Read the board: the charted tiles, every piece (name, color, score, position), the board's settings and the move rules.",
    annotations: read,
  }, async () => reply(await viaRoute(ctx, player, apiBoard.get, "GET", "board")));

  server.registerTool("read_day", {
    description: "Read today: the day number, when it ends (midnight in the game's time zone), whether the midnight lock is on, what each player has done today, and what you may still do.",
    annotations: read,
  }, async () => reply(await viaRoute(ctx, player, apiDay.get, "GET", "day")));

  server.registerTool("my_state", {
    description: "Who you are in this game, where your piece stands, today's day and the midnight lock, what you have done today (moved, proposed, how many proposals you have made of the day's limit, ended your turn, how many ballot items you voted on) and what you may do right now (move, propose, end_turn, vote).",
    annotations: read,
  }, async () => {
    const [me, g, board, day] = await Promise.all([
      viaRoute(ctx, player, apiMe.get, "GET", "me"), viaRoute(ctx, player, apiGame.get, "GET", "game"), viaRoute(ctx, player, apiBoard.get, "GET", "board"),
      viaRoute(ctx, player, apiDay.get, "GET", "day"),
    ]);
    const bad = [me, g, board, day].find((r) => r.status >= 400);
    if (bad) return reply(bad);
    const piece = board.data.pieces.find((p: any) => p.turn_order === player.turn_order);
    const d = day.data, you = d.you;
    // you.can comes from the day route, which runs the same turnBlock the move, propose and end-turn routes apply.
    return { content: [{ type: "text" as const, text: asJson({
      you: { name: me.data.user.name, turn_order: player.turn_order, color: me.data.player.color.name, score: me.data.player.score, is_host: me.data.player.is_host, at: piece?.at ?? null, hearts: me.data.player.hearts, state: me.data.player.state },
      game: { name: g.data.game.name, slug: g.data.game.slug, status: d.status, winning_score: g.data.game.winning_score, ending: g.data.game.ending ?? null },
      day: { number: d.day, ends_at: d.ends_at, timezone: d.timezone },
      lock: { locked: d.locked, processing_day: d.processing_day, message: d.message },
      today: { moved: you?.moved ?? false, proposed: you?.proposed ?? false, proposals: you?.proposals ?? null, ended: you?.ended ?? false, voted_on: you?.voted ?? 0, ballot_items: d.ballot ?? 0 },
      you_can: you?.can ?? null,
    }) }] };
  });

  // A proposal (rule 103): the player's words and the rule they are about; the moderator drafts the exact change.
  const proposalArgs = {
    kind: z.enum(["reword", "addclause", "add", "repeal", "move", "mark"]).describe("reword = change the text of a rule or one clause; addclause = add a clause to a rule (target a rule, or a clause to add after it); add = a new rule in a block (target the block, like 400); repeal = remove a rule or a clause; move = move a rule to another block (give `to`); mark = lock a rule (everyone must agree to change it) or remove the lock"),
    target: z.string().describe("The rule, clause or block number the change is to, like \"402\", \"402.1\" or, for a new rule, the block \"400\""),
    words: z.string().optional().describe("The change in plain words (reword, addclause, add), up to 2500 characters. With prefilled: true, the exact new text instead"),
    to: z.string().optional().describe("For move: the block the rule goes to, like \"300\""),
    title: z.string().optional().describe("For add: a short title for the new rule"),
    champion: z.boolean().optional().describe("true to make this your Champion's change (rule 402.4): only the Champion, once an Era, on top of the day's proposals, no vote of yours; it takes effect unless every other player votes against it"),
    prefilled: z.boolean().optional().describe("For reword: true when `words` is the exact new wording (the rule's current text, edited), so the moderator uses it as written instead of interpreting it"),
  };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("draft_proposal", {
    description: "Draft a proposal: the moderator turns your words into the exact change (tracked change against the rules), and tells you what it conflicts with and how many votes it needs. Drafting is free and repeatable and is NOT yet a proposal: nothing is on the ballot until you confirm_proposal with the draft's id. Not after you end your turn; not during the midnight lock (the lock message is returned).",
    inputSchema: proposalArgs,
    annotations: write,
  }, async (args) => {
    const r = await viaRoute(ctx, player, apiProposals.post, "POST", "proposals", args);
    if (r.status >= 400) return reply(r);
    const p = r.data?.proposal ?? {};
    const text = [
      `Draft id: ${p.id}`,
      p.head,
      p.before_text ? `Before: ${p.before_text}` : null,
      p.after_text ? `After: ${p.after_text}` : null,
      settingsText(p.settings) ? `Sets: ${settingsText(p.settings)}` : null,
      p.conflict_note ? `Conflicts: ${p.conflict_note}` : null,
      p.needs ? (p.needs.champion ? `Champion's change: stopped only if all ${p.needs.needed} other players vote no` : `Needs: ${p.needs.mark}, ${p.needs.needed} of ${p.needs.of} votes`) : null,
      "This is only a draft. Confirm it with confirm_proposal to make it one of your proposals today (it goes on tomorrow's ballot). my_state shows how many you have made of the day's limit.",
    ].filter(Boolean).join("\n");
    return reply(r, text);
  });

  // The Champion names the Era they won the right to name (rule 402.3), once.
  server.registerTool("name_era", {
    description: "Name the current Era (rule 402.3). Only the Champion can, once per Era, up to 60 characters. Not during the midnight lock or after you end your turn.",
    inputSchema: { name: z.string().describe("The Era's name") },
    annotations: write,
  }, async ({ name }) => {
    const r = await viaRoute(ctx, player, apiEra.post, "POST", "era", { name });
    return reply(r, r.data?.ok ? `Era ${r.data.era.n} is named ${r.data.era.name}.` : r.text);
  });

  server.registerTool("confirm_proposal", {
    description: "Confirm a draft: it becomes one of your proposals of the day (P1, P2, ... in the order confirmed) and goes on tomorrow's ballot. Up to the game's daily limit (proposals.per_day; my_state shows made and limit); you can withdraw it until midnight or until you end your turn (ending your turn is final). Not during the midnight lock (the lock message is returned).",
    inputSchema: { id: z.string().describe("The draft id from draft_proposal") },
    annotations: write,
  }, async ({ id }) => {
    const r = await viaRoute(ctx, player, apiProposals.action("confirm"), "POST", `proposals/${encodeURIComponent(id)}/confirm`, {}, { id });
    return reply(r, r.data?.message ?? r.text);
  });

  server.registerTool("withdraw_proposal", {
    description: "Withdraw your confirmed proposal of today, before midnight and before you end your turn (ending your turn is final: after it a proposal can't be withdrawn). The proposal keeps its number; your proposal for the day is free again. Not during the midnight lock (the lock message is returned).",
    inputSchema: { id: z.string().describe("The proposal id (returned when you drafted it)") },
    annotations: write,
  }, async ({ id }) => {
    const r = await viaRoute(ctx, player, apiProposals.action("withdraw"), "POST", `proposals/${encodeURIComponent(id)}/withdraw`, {}, { id });
    return reply(r, r.data?.withdrawn ? `${r.data.withdrawn} is withdrawn.` : r.text);
  });

  server.registerTool("propose", {
    description: "Propose a change today in one step: draft it and confirm it (draft_proposal, then confirm_proposal). Your words say what to change; the moderator drafts the exact text. Only the confirm counts: up to the game's daily limit (my_state shows made and limit), on tomorrow's ballot; withdraw it until midnight or until you end your turn (ending your turn is final). Not during the midnight lock (the lock message is returned). To see the draft before it counts, use draft_proposal.",
    inputSchema: proposalArgs,
    annotations: write,
  }, async (args) => reply(await viaRoute(ctx, player, apiTurn.post, "POST", "turn", args)));

  server.registerTool("read_proposals", {
    description: "Read the proposals you may see: every proposal that has reached a ballot, and your own confirmed proposal of today (hidden from others until tomorrow). Votes are never shown.",
    annotations: read,
  }, async () => reply(await viaRoute(ctx, player, apiProposals.get, "GET", "proposals")));

  server.registerTool("read_ballot", {
    description: "Read today's ballot: each proposal confirmed yesterday, its exact change, the votes it needs (its mark, of today's players; not voting counts as no; a Champion's change instead says how many of the other players must all vote no to stop it), how many have voted and who, and your own vote. Nobody's vote and no total is shown until midnight, when the ballot is counted. Give `day` to read an earlier day's ballot with its results and every vote.",
    inputSchema: { day: z.number().int().min(1).optional().describe("An earlier day's number, to read its counted ballot. Leave out for today's") },
    annotations: read,
  }, async ({ day }) => reply(await viaRoute(ctx, player, apiBallot.get, "GET", day === undefined ? "ballot" : `ballot?day=${day}`)));

  server.registerTool("vote", {
    description: "Vote yes or no on a proposal on today's ballot (like P3). You may vote on your own proposal (not on your own Champion's change), and change your vote until midnight or until you end your turn (ending your turn is final). Not voting counts as no (except on a Champion's change, which takes effect unless every other player votes no). Nobody sees your vote until midnight. Not during the midnight lock (the lock message is returned).",
    inputSchema: {
      proposal: z.string().describe("The proposal, like \"P3\""),
      vote: z.enum(["yes", "no"]).describe("yes or no"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const r = await viaRoute(ctx, player, apiVotes.post, "POST", "votes", args);
    return reply(r, r.data?.message ?? r.text);
  });

  // The Workshop (rules 801, 804): the commissions of this game, and the discussion on each.
  server.registerTool("list_tickets", {
    description: "List the workshop's tickets (commissions, W1, W2...): each one's title, who asked for it, its state (Draft, Proposed, Ready, Approved, Building, Done, Refused, Failed, Shelved), the nights it will take and its price in points (Ready: passed, but the requester can't pay the whole price yet, so it waits outside the queue). Your own draft is included; other players' drafts are not. Shows the live work and the 5 most recently closed. Read one ticket's brief, tasks, log and discussion with read_ticket.",
    annotations: read,
  }, async () => reply(await viaRoute(ctx, player, apiTickets.get, "GET", "tickets")));

  server.registerTool("read_ticket", {
    description: "Read one ticket: its brief, what it makes (catalog entries and rule numbers), the nights it will take, its price and why, its running cost, its tasks, its log, and its discussion thread.",
    inputSchema: { ticket: z.string().describe("The ticket, like \"W3\"") },
    annotations: read,
  }, async ({ ticket }) => reply(await viaRoute(ctx, player, apiTickets.one, "GET", `tickets/${encodeURIComponent(ticket)}`, undefined, { n: ticket })));

  server.registerTool("reopen_ticket", {
    description: "Reopen a ticket of yours that was refused or failed: it becomes a draft again under the same number, with its log and thread kept. Nothing is refunded or charged. Confirming it again counts as one of the day's proposals. Not during the midnight lock.",
    inputSchema: { ticket: z.string().describe("The ticket, like \"W3\"") },
    annotations: write,
  }, async ({ ticket }) => {
    const r = await viaRoute(ctx, player, apiTickets.action("reopen"), "POST", `tickets/${encodeURIComponent(ticket)}/reopen`, {}, { n: ticket });
    return reply(r, r.data?.ok ? `${String(ticket).toUpperCase().replace(/^(\d)/, "W$1")} is a draft again.` : r.text);
  });

  server.registerTool("post_to_ticket", {
    description: "Post in a ticket's discussion (any player of the game can), up to 2000 characters. Posts are public to the game and can't be edited. Not during the midnight lock.",
    inputSchema: {
      ticket: z.string().describe("The ticket, like \"W3\""),
      body: z.string().describe("What you want to say"),
    },
    annotations: write,
  }, async ({ ticket, body }) => {
    const r = await viaRoute(ctx, player, apiTickets.action("post"), "POST", `tickets/${encodeURIComponent(ticket)}/post`, { body }, { n: ticket });
    return reply(r, r.data?.ok ? `Posted in ${String(ticket).toUpperCase().replace(/^(\d)/, "W$1")}.` : r.text);
  });

  server.registerTool("move", {
    description: "Move your piece to a charted tile within your move distance. Once a day; not after you end your turn; not during the midnight lock. Name the tile by label (like \"3N 2E\") or by integer x and y.",
    inputSchema: {
      label: z.string().optional().describe("Tile label, row first, like \"3N 2E\""),
      x: z.number().int().optional().describe("Column, if you are not giving a label"),
      y: z.number().int().optional().describe("Row, if you are not giving a label"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ label, x, y }) => reply(await viaRoute(ctx, player, apiAction.post, "POST", "action", { kind: "move", ...(label !== undefined ? { label } : { x, y }) })));

  server.registerTool("end_turn", {
    description: "End your turn for today. FINAL: there is no undo. Whatever you have not done today (your move, your proposal) is skipped, and you cannot move, propose or vote until the next day. Not during the midnight lock.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async () => reply(await viaRoute(ctx, player, apiEndTurn.post, "POST", "end-turn", {})));

  server.registerTool("start_game", {
    description: "Start the game: day 1 begins now and runs to midnight in the game's time zone. Only the host (the first player to join) can, and only while the game is still being set up. FINAL: after it the starter rules change only by proposal.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async () => reply(await viaRoute(ctx, player, apiStart.post, "POST", "start", {})));
}
