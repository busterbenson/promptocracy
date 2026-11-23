// Players on the page: the piece drawn small, and the player pill (their piece + name) used everywhere a name appears.
import { ensureDefs, pieceSVG } from "/js/pieces.js";
import { CANVAS, HEIGHT, FIT, MID } from "/js/pieces-data.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const hexOf = (c) => (c && /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#888");

/**
 * The piece, small: a player's traced shape in their color. The viewBox is centred on the middle of the piece's painted height (MID: the art stands on its floor
 * ellipse, so how far it reaches above and below the foot point differs by shape), so every shape's visual mass sits at the middle of the box and a pill's text lines up with it.
 */
export function mini(p, cls = "") {
  ensureDefs();
  const mid = (MID[p.shape] ?? MID.pawn) * HEIGHT / CANVAS.tall * (FIT[p.shape] || FIT.pawn);
  return `<svg ${cls ? `class="${cls}" ` : ""}viewBox="-22 ${(mid - 25).toFixed(1)} 44 50" aria-hidden="true">${pieceSVG({ shape: p.shape, color: p.color, scale: 1, clip: false })}</svg>`;
}

/**
 * The player pill: piece + name, "(you)" on your own. A button that opens their card (data-pl is the color key, which is
 * unique in a game). `shapeOf(color)` finds the piece's shape from the players list; a proposer only carries name and color.
 */
export function playerPill(by, { you = false, shapeOf = () => "pawn" } = {}) {
  if (!by) return "";
  const p = { shape: by.shape || shapeOf(by.color), color: by.color };
  return `<button type="button" class="plpill" data-pl="${esc(by.color.key)}" aria-label="Open ${esc(by.name)}${you ? " (you)" : ""}'s player card">${mini(p, "pico")}<span>${esc(by.name)}${you ? " (you)" : ""}</span></button>`;
}
