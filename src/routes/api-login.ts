// Log in to THIS game. An address with no seat here gets the same answer as one that has.
import { emailMode } from "../lib/email";
import { issueLink, tooManyLinks } from "../lib/links";
import { Ctx, json, normEmail, playersLine, readJson, seatLimit, seatsTaken, validEmail } from "../lib/util";

/** @rule 102.4 */
export const post = async (ctx: Ctx) => {
  const { env } = ctx;
  const game = ctx.data.game!;
  if (!emailMode(env)) return json({ error: "Email is not configured, so log-in is unavailable." }, 503);
  const body = await readJson(ctx.request);
  if (!body || !validEmail(body.email)) return json({ error: "That doesn't look like an email address." }, 400);
  const email = normEmail(body.email);

  if (await tooManyLinks(env, game.id, email)) return json({ error: "Too many links requested. Wait 15 minutes and try again." }, 429);
  const player = await env.DB.prepare("SELECT id FROM players WHERE game_id = ? AND email = ?").bind(game.id, email).first();
  // A token row is written either way (it counts toward the limits) but only a
  // real player is emailed, and the response never says which case it was.
  const link = await issueLink(ctx, game, {
    email, purpose: "login", send: !!player,
    subject: `Promptocracy: log in to ${game.name}`,
    intro: `Here's your link to log in to ${game.name}, a game of Promptocracy.\n\n${playersLine(await seatsTaken(env, game.id), seatLimit(game), "Players")}`,
    action: "To log in",
  });
  if (!link) return json({ error: "Too many links requested. Wait 15 minutes and try again." }, 429);
  const res: any = { ok: true, message: "If that address has joined this game, a log-in link is on its way." };
  if (emailMode(env) === "dev") res.dev_link = link;
  return json(res);
};
