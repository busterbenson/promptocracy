// Gremlin's choices come below the slip, and the Summary bar's pills are today's proposals (Buster, 2026-11-26). The pure parts of public/js/chat.js:
// where the options go in the log, and what the bar shows. The browser run is tests/browser-chat.py. Run: node tests/chat-bar.mjs
import { barPills, optionsPlace } from "../public/js/chat.js";
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
check("no choices: nowhere", optionsPlace(-1, 3) === "none" && optionsPlace(-1, -1) === "none");
check("choices on the line the slip follows: after the slip, never before it", optionsPlace(4, 4) === "slip");
check("choices with the slip at the end of the log: after that slip", optionsPlace(4, -1) === "end");
check("choices on a line the slip does not follow (an older draft's line): right after the line", optionsPlace(4, 2) === "line");
check("no state: no bar", barPills(null) === null && barPills({}) === null);
const b = barPills({ today: { list: ["P13", "P14"], limit: 3, made: 2 } });
check("the bar's pills are the Today row's list, and 1 of 3 left", b.list.join() === "P13,P14" && b.left === 1 && b.limit === 3);
check("never a negative count left", barPills({ today: { list: [], limit: 3, made: 5 } }).left === 0);
check("a copy: the bar cannot change the window's list", (() => { const t = { list: ["P1"], limit: 3, made: 1 }; barPills({ today: t }).list.push("P2"); return t.list.length === 1; })());
check("a commission's pill carries its ticket, a plain proposal's none", (() => { const x = barPills({ today: { list: ["P1", "P2"], limit: 3, made: 2, tickets: { P2: "W4" } } }); return x.tickets.P2 === "W4" && !x.tickets.P1; })());
check("no tickets map from the server: an empty one", Object.keys(barPills({ today: { list: ["P1"], limit: 3, made: 1 } }).tickets).length === 0);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
