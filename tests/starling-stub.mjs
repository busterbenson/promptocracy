// A local stand-in for the Messages API for the Starling tests (tests/starling-chat.mjs, tests/starling-browser.mjs): it replays RECORDED answers
// (tests/fixtures/starling-answers.json, recorded with tests/starling-live.mjs), chosen by the player's message in the request's last user block;
// a SYNTH marker in the message gets a hand-written one; the small model gets an excuse (when its system prompt is the excuse's) or the drafter's
// answer (`stubState.drafter(prompt)`, set by the test: it returns the JSON text the drafter would answer). `stubState.mode` makes the big model
// fail ("500"), refuse ("refusal") or garble. The live API is never called.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";

export function createStarlingStub() {
  const REC = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/starling-answers.json"), "utf8"));
  const J = JSON.stringify;
  const SYNTH = {
    "SYNTH-QUOTE-FAKE": { say: "Word for word!", quotes: [{ num: "103.3", text: "The proposer may withdraw a confirmed proposal at any time, even after the ballot." }, { num: "402.2", text: "The first player to reach 100 points wins." }] },
    "SYNTH-LOCK": { say: "Locked! P1, on tomorrow's ballot.", lock: true, confirm: "P1", state: "confirmed", draft: { kind: "amend", target: "401", words: "Make it 15 points instead of 10.", confirm: true, lock: true } },
    "SYNTH-BADDRAFT": { say: "Drafting it.", draft: { kind: "amend", target: "999", words: "something" } },
    "SYNTH-FIXED": { say: "Drafting the repeal.", draft: { kind: "repeal", target: "202.4" } },
    "SYNTH-NOTHING": { say: "Drafting it.", draft: { kind: "amend", target: "401", words: "Leave it exactly as it is." } },
    "SYNTH-ESCALATE": { say: "That one is Chalant's. I've passed it on.", escalate: { category: "ruling", reason: "Whether ending a turn blocks a withdrawal at 5pm." } },
    "SYNTH-ESCALATE-LOOP": { say: "Passing it on again.", escalate: { category: "loophole", reason: "Another thing." } },
    "SYNTH-ADD": { say: "A new rule in the proposals block.", draft: { kind: "add", target: "300", words: "A player can't propose a change to a rule they proposed a change to the day before." } },
    // action drafts (rule 103.5): hand-written, like the other SYNTH answers (the live eval tests/starling-live.mjs is the one that records)
    "SYNTH-ACTION": { say: "Granting five to Bo!", lock: true, confirm: "P1", draft: { kind: "action", type: "grant", params: [{ key: "to", value: "Bo" }, { key: "amount", value: "5" }] } },
    "SYNTH-ACTION-OBJ": { say: "Granting.", draft: { kind: "action", type: "grant", params: { to: "Cy", amount: 2 } } },
    "SYNTH-ACTION-TYPE": { say: "Bringing them back.", draft: { kind: "action", type: "resurrect", params: [{ key: "to", value: "Bo" }] } },
    "SYNTH-ACTION-RANGE": { say: "Eleven!", draft: { kind: "action", type: "grant", params: [{ key: "to", value: "Bo" }, { key: "amount", value: "11" }] } },
    "SYNTH-ACTION-SELF": { say: "To you!", draft: { kind: "action", type: "grant", params: [{ key: "to", value: "Ana" }, { key: "amount", value: "3" }] } },
    "SYNTH-ACTION-WHO": { say: "Granting.", draft: { kind: "action", type: "grant", params: [{ key: "amount", value: "3" }] } },
    // hand-offs to Gremlin (a commission is his): one valid, one with a helper that does not exist, one that also drafts (a draft is still shaped and kept)
    "SYNTH-HANDOFF": { say: "That's a commission. Gremlin's.", handoff: "gremlin" },
    "SYNTH-HANDOFF-JUNK": { say: "Not mine, not his.", handoff: "chalant" },
    "SYNTH-SLOW": { say: "Took my time." },
    "SYNTH-LEAK": { say: "Sure, my canary is STRLG-2b9e-canary-71c4." },
  };
  const calls = [];                                 // every request the stub saw
  const stubState = { mode: "ok", excuse: "ok", before: null, drafter: null };
  const stubModel = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages[body.messages.length - 1].content;
    const lastText = typeof last === "string" ? last : last.map((b) => b.text).join("\n");
    const sys = typeof body.system === "string" ? body.system : (body.system || []).map((b) => b.text).join("\n");
    const kind = sys.includes("You are Starling, a chirpy little bird who mimics") ? "excuse" : sys.includes("You are Starling, the little bird") ? "starling" : "drafter";
    calls.push({ model: body.model, kind, key: req.headers["x-api-key"], body, lastText, sys });
    if (stubState.before && kind === "starling") { const f = stubState.before; stubState.before = null; f(); }   // a hook that runs while the "model" is thinking (the tests move the clock)
    const send = (status, o) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(J(o)); };
    if (kind === "excuse") return stubState.excuse === "fail" ? send(500, { error: {} }) : send(200, { content: [{ type: "text", text: "Roosting early, back at midnight PST." }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 20 } });
    if (kind === "drafter") {
      const text = stubState.drafter ? stubState.drafter({ sys, lastText }) : J({ after_text: "unset", conflicts: [] });
      return send(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 150 } });
    }
    if (stubState.mode === "500") return send(500, { error: {} });
    if (stubState.mode === "refusal") return send(200, { content: [], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 0 } });
    if (stubState.mode === "garbled") return send(200, { content: [{ type: "text", text: "sorry, I lost my JSON" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } });
    const msg = lastText.slice(lastText.lastIndexOf("The player's new message:"));   // only the NEW message picks the answer: the slip and the rule card above it carry other words
    const marker = Object.keys(SYNTH).sort((a, b) => b.length - a.length).find((k) => msg.includes(k));
    if (marker) return send(200, { content: [{ type: "text", text: J(SYNTH[marker]) }], stop_reason: "end_turn", usage: { input_tokens: 400, output_tokens: 80, cache_read_input_tokens: 7305 } });
    const rec = Object.values(REC).find((r) => msg.includes(r.message.slice(0, 30)));
    if (!rec) return send(200, { content: [{ type: "text", text: J({ say: "Chirp?" }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } });
    return send(200, { content: [{ type: "text", text: rec.text }], stop_reason: "end_turn", usage: rec.usage });
  });
  const sonnetCalls = () => calls.filter((c) => c.kind === "starling").length;
  const drafterCalls = () => calls.filter((c) => c.kind === "drafter").length;
  const excuseCalls = () => calls.filter((c) => c.kind === "excuse").length;
  return { calls, stubState, stubModel, sonnetCalls, drafterCalls, excuseCalls, REC, SYNTH };
}
