import { stateOf } from "../engine/host";
import { getPlayer } from "../lib/auth";
import { Ctx, colorOf, json } from "../lib/util";

export const get = async ({ env, request, data }: Ctx) => {
  const p = await getPlayer(env, request, data.game!);
  if (!p) return json({ error: "Not logged in." }, 401);
  return json({
    user: { email: p.email, name: p.display_name },
    player: { color: colorOf(p.color), shape: p.shape, score: p.score, turn_order: p.turn_order, is_host: !!p.is_host, hearts: p.hearts ?? 3, state: stateOf(p) },
  });
};
