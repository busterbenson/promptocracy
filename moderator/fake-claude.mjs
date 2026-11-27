#!/usr/bin/env node
// A scripted stand-in for `claude -p`, for moderator/test.mjs only. It reads the prompt on stdin, finds the proposal's
// number in the fenced data (or a build's ticket, "W2"), and does what the scenario file next to it (fake-claude.scenario.json,
// written by the test) says for it: `apply[number]` for a proposal, `build[ticket]` for a build (moderator/BUILD.md). Every call is
// appended to fake-claude.calls.jsonl beside it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const scenario = JSON.parse(readFileSync(join(here, "fake-claude.scenario.json"), "utf8"));
let prompt = "";
for await (const c of process.stdin) prompt += c;
const data = JSON.parse(/<proposal-data>\n([\s\S]*?)\n<\/proposal-data>/.exec(prompt)[1]);
const audit = /drafter audit/.test(prompt);
const fix = /Your last attempt failed the checks/.test(prompt);
const args = process.argv.slice(2);
appendFileSync(join(here, "fake-claude.calls.jsonl"), JSON.stringify({ ticket: data.ticket ?? null, build: /# Build one commission/.test(prompt), buildPrompt: data.ticket ? prompt : null, criteria: prompt.includes("CAN THE GAME CARRY IT OUT") && prompt.includes("ENGINE FACTS"), number: data.number, escalation: data.escalation ?? null, rulingPrompt: data.escalation !== undefined ? prompt : null, auditPrompt: audit ? prompt : null, audit, fix, redraft_onto: data.redraft_onto ?? null, effort: args[args.indexOf("--effort") + 1], restricted: args.includes("--restricted"), addDir: args.includes("--add-dir") ? args[args.indexOf("--add-dir") + 1] : null, libraryIndex: args.includes("--add-dir") && existsSync(join(args[args.indexOf("--add-dir") + 1], "index.md")), tools: args[args.indexOf("--tools") + 1], env: Object.keys(process.env).sort() }) + "\n");

if (audit) {
  const a = scenario.audit?.[data.number] ?? { material: false, reading: "as drafted", gap: "" };
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(a) }));
  process.exit(0);
}
const step = data.ticket ? scenario.build?.[data.ticket] : scenario.apply?.[data.number];
const cwd = process.cwd();
const edit = (f, from, to) => { const p = join(cwd, f); writeFileSync(p, readFileSync(p, "utf8").split(from).join(to)); };
const result = (r) => writeFileSync(join(cwd, "MODERATOR-RESULT.json"), JSON.stringify(r));

// A ruling (moderator/RULING.md): the data carries the escalation's id instead of a proposal's number. The scenario's `ruling[id]` (or `ruling.default`)
// gives what the model answers; `edit` lists changes it also tries to make in its copy (it has no Write tool, and the copy is thrown away).
if (data.escalation !== undefined) {
  const r = scenario.ruling?.[data.escalation] ?? scenario.ruling?.default;
  if (!r) throw new Error(`no ruling scenario for E${data.escalation}`);
  for (const o of r.edit ?? []) { if (o.replace) edit(...o.replace); if (o.write) { mkdirSync(dirname(join(cwd, o.write[0])), { recursive: true }); writeFileSync(join(cwd, o.write[0]), o.write[1]); } }
  if (r.sleep) await new Promise((res) => setTimeout(res, r.sleep));
  process.stdout.write(JSON.stringify({ type: "result", result: r.raw ?? JSON.stringify(r.answer) }));
  process.exit(0);
}

if (!step) throw new Error(`no scenario for ${data.ticket ?? `P${data.number}`}`);
switch (step.action) {
  case "points": { // 401: N points instead of the current number (read from the text)
    const cur = /gets (\d+) points when it is applied/.exec(readFileSync(join(cwd, "RULES.md"), "utf8"))[1];
    edit("RULES.md", `gets ${cur} points when it is applied`, `gets ${step.to} points when it is applied`);
    edit("rules/401.ts", `proposal.player, ${cur},`, `proposal.player, ${step.to},`);
    if (!step.breakTest) edit("rules/401.test.ts", `delta: ${cur},`, `delta: ${step.to},`);
    result({ outcome: "applied" });
    break;
  }
  case "win": { // 402.2: win at N (the setting eras.points_to_win)
    edit("RULES.md", "The first player to reach 100 points wins the Era", `The first player to reach ${step.to} points wins the Era`);
    edit("settings.json", '"eras.points_to_win": 100', `"eras.points_to_win": ${step.to}`);
    writeFileSync(join(cwd, "rules/402.test.ts"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "promptocracy/engine/testing";
import rule from "./402.ts";
test("402.2: reaching ${step.to} wins", () => {
  assert.equal(rule.dayEnd!(makeCtx({ settings: { "eras.points_to_win": ${step.to} } }), { before: { a: ${step.to - 10} }, given: [{ player: "a", delta: 10 }] } as any).length, 1);
});
`);
    if (step.flip) edit("RULES.md", "### 107 The night [u]", "### 107 The night [m]");
    if (step.conflict) result({ outcome: "applied", conflict: step.conflict });
    else result({ outcome: "applied" });
    break;
  }
  case "gitwrite": { // tries to plant a git hook and config next to a good change
    const cur = /gets (\d+) points when it is applied/.exec(readFileSync(join(cwd, "RULES.md"), "utf8"))[1];
    edit("RULES.md", `gets ${cur} points when it is applied`, "gets 15 points when it is applied");
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    writeFileSync(join(cwd, ".git", "config"), `[core]\n\tfsmonitor = touch ${step.marker}\n`);
    writeFileSync(join(cwd, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${step.marker}\n`, { mode: 0o755 });
    result({ outcome: "applied" });
    break;
  }
  case "spill": { // a good change to 401, and a quiet one to 402 (or another rule's tests)
    edit("RULES.md", "gets 10 points when it is applied", "gets 15 points when it is applied");
    edit("rules/401.ts", "proposal.player, 10,", "proposal.player, 15,");
    edit("rules/401.test.ts", "delta: 10,", "delta: 15,");
    if (step.weaken) writeFileSync(join(cwd, "rules/505.test.ts"), `import { test } from "node:test";\ntest("505", () => {});\n`);
    else { edit("RULES.md", "The first player to reach 100 points wins the Era", "The first player to reach 20 points wins the Era"); edit("rules/402.ts", 'const toWin = ctx.settings["eras.points_to_win"];', "const toWin = 20;"); }
    result({ outcome: "applied" });
    break;
  }
  case "ops": // a list of edits: {replace: [file, from, to]} | {write: [file, text]} | {remove: file} | {dir: file}
    for (const o of step.ops) {
      if (o.replace) { const t = readFileSync(join(cwd, o.replace[0]), "utf8"); if (!t.includes(o.replace[1])) throw new Error(`no ${o.replace[1]}`); edit(...o.replace); }
      if (o.write) { mkdirSync(dirname(join(cwd, o.write[0])), { recursive: true }); writeFileSync(join(cwd, o.write[0]), o.write[1]); }
      if (o.remove) rmSync(join(cwd, o.remove), { recursive: true, force: true });
      if (o.dir) mkdirSync(join(cwd, o.dir), { recursive: true });
    }
    result(step.result ?? { outcome: "applied" });
    break;
  case "outside": // writes where the night may not
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "evil.js"), "export const x = 1;\n");
    edit("RULES.md", "A player whose proposal passes", "A player whose proposal passes");
    result({ outcome: "applied" });
    break;
  case "sleep":
    await new Promise((r) => setTimeout(r, step.ms));
    break;
  case "nonsense":
    result({ outcome: "not_applied", reason: "it no longer makes sense on the new text of rule 401", ...(step.fixes ? { fixes: step.fixes } : {}) });
    break;
  default:
    throw new Error(`no scenario for P${data.number}`);
}
