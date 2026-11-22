// The sentence History ends a game with (rule 404), plain JavaScript so the tests share it.
/** The sentence History ends with (rule 404.2-404.4). Names are looked up by the caller. @rule 404.2, 404.3, 404.4 */
export function endingText(ending, name) {
  if (ending === "paradox") return name ? `The game ended: Paradox. ${name} wins.` : "The game ended: Paradox.";
  if (ending === "last_standing") return `The game ended badly. ${name ?? "The last player"} is the King of Ghosts.`;
  return "The game ended. Everyone is dead.";
}

