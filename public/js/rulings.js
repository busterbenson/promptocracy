// History's rulings (rule 106.5): what the moderator ruled at night, grouped by the day whose night made them. Each shows its number, the
// question as the moderator restated it, the rules it relied on (rule pills) and the ruling's text. Labels and data only.
// rulings: [{day, n, question, relies_on, text}] from /api/game; esc and rpill come from the page (rpill(n) draws a rule pill).
export function rulingsHTML(rulings, { esc, rpill }) {
  const list = (Array.isArray(rulings) ? rulings : []).filter((r) => r && Number.isInteger(r.day) && Number.isInteger(r.n));
  if (!list.length) return "";
  const days = [...new Set(list.map((r) => r.day))].sort((a, b) => b - a);
  return `<section class="hrul" aria-label="Rulings">${days.map((d) => `<div class="hrday"><h3 class="hrh">Day ${d}</h3>${list.filter((r) => r.day === d).sort((a, b) => a.n - b.n).map((r) =>
    `<article class="hrr" id="ruling-${d}-${r.n}"><p class="hrn">Ruling ${d}-${r.n}</p><p class="hrq">${esc(r.question)}</p><p class="hrp">${(r.relies_on || []).map((n) => rpill(String(n))).join(" ")}</p><p class="hrt">${esc(r.text)}</p></article>`).join("")}</div>`).join("")}</section>`;
}
