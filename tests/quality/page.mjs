// The review page of a quality run: one markdown file (HTML passthrough, as the other chalant-reports pages) with a card per case and
// Good / Bad buttons that POST to the reports server's /e2e-verdict. Everything a model or a player wrote is HTML-escaped.
// Each element sits on its own line with no blank line inside an HTML block, so the markdown renderer leaves it alone.
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// newlines inside <pre> become &#10; so the whole card stays one HTML line (a blank line would end the markdown HTML block)
const pre = (s) => `<pre class="qr-pre">${esc(s).replace(/\r?\n/g, "&#10;")}</pre>`;
const details = (summary, inner) => `<details class="qr-det"><summary>${esc(summary)}</summary>${inner}</details>`;
const usd = (micro) => `$${(micro / 1e6).toFixed(3)}`;
const oneLine = (h) => String(h).replace(/\s*\n\s*/g, " ");

function chatHtml(c) {
  const rows = (c.turns || []).map((t) => {
    const mark = t.outcome && t.outcome !== "said" ? `<div class="qr-ev">${esc(t.outcome)}${t.pipeline?.message ? `: ${esc(t.pipeline.message)}` : ""}${t.pipeline?.head ? `: ${esc(t.pipeline.head)}` : ""}</div>` : "";
    return `<div class="qr-turn"><div class="qr-p"><b>Player</b> ${esc(t.player)}</div><div class="qr-a"><b>${esc("Gremlin")}</b> ${t.say == null ? `<i>${esc(t.error || "no answer")}</i>` : esc(t.say)}</div>${mark}</div>`;
  });
  return rows.join("");
}

function slipHtml(c) {
  if (c.draft) {
    const d = c.draft;
    const act = d.action ? `<div>action: ${esc(d.action.type)} ${esc(JSON.stringify(d.action.params))}</div>` : "";
    return `<div class="qr-slip"><b>${esc(d.head)}</b>${act}<div>drafted by ${esc(d.drafted_by)}, kind ${esc(d.kind)}, target ${esc(d.target)}${d.mark ? `, mark ${esc(d.mark)}` : ""}</div>${d.before_text ? `<div class="qr-lbl">before</div>${pre(d.before_text)}` : ""}<div class="qr-lbl">after</div>${pre(d.after_text)}<div>settings: ${esc(JSON.stringify(d.settings || {}))}; conflicts: ${esc((d.conflicts || []).join(", ") || "none")}</div></div>`;
  }
  if (c.refusal) return `<div class="qr-slip"><b>No slip.</b> Refused (${esc(c.refusal.reason)}): ${esc(c.refusal.message)}</div>`;
  if (c.ticket) return `<div class="qr-slip"><b>Ticket</b> ${esc(c.ticket.title || "(no title)")}: ${esc(c.ticket.brief || "")}<div>makes: ${esc(JSON.stringify(c.ticket.makes || []))}; estimate ${esc(c.ticket.estimate)}; price ${esc(c.ticket.price)} (${esc(c.ticket.price_reason || "")})</div></div>`;
  return `<div class="qr-slip"><i>No slip.</i></div>`;
}

function nightHtml(n) {
  if (!n) return `<div class="qr-night">night: not run in this stage</div>`;
  if (n.status === "n/a") return `<div class="qr-night">night: ${esc(n.reason)}</div>`;
  const parts = [`<div class="qr-night"><b>night: ${esc(n.status)}</b>${n.reason ? ` (${esc(n.reason)})` : ""}; ${esc(n.attempts)} attempt(s), ${Math.round((n.ms || 0) / 1000)} s, claude ${esc(((n.claude || []).reduce((a, x) => a + (x.cost_usd || 0), 0)).toFixed(2))} USD reported (plan usage, not dollars)</div>`];
  if (n.diff_text) parts.push(details("RULES.md and settings.json diff", pre(n.diff_text)));
  if (n.diff_code) parts.push(details("code diff (rules/)", pre(n.diff_code)));
  if (n.check_tail) parts.push(details("the checks' tail", pre(n.check_tail)));
  if (n.audit) parts.push(`<div class="qr-audit">audit: ${n.audit.error ? esc(n.audit.error) : `material gap ${esc(n.audit.material)}. ${esc(n.audit.gap)}`}</div>`);
  return parts.join("");
}

function checksHtml(checks) {
  return `<ul class="qr-checks">${(checks || []).map((k) => `<li class="${k.pass ? "ok" : k.soft ? "soft" : "no"}">${k.pass ? "pass" : k.soft ? "note" : "FAIL"}: ${esc(k.name)}${k.detail ? ` <span class="qr-d">${esc(k.detail)}</span>` : ""}</li>`).join("")}</ul>`;
}

function graderHtml(g) {
  if (!g) return `<div class="qr-grader">grader: not run</div>`;
  if (!g.ok) return `<div class="qr-grader">grader: no answer (${esc(g.error)})</div>`;
  const s = g.scores || {};
  return `<div class="qr-grader"><b>grader (advisory): ${esc(g.verdict)}</b> intent ${esc(s.intent)}, fidelity ${esc(s.fidelity)}, voice ${esc(s.voice)}, efficiency ${esc(s.efficiency)}, night ${s.night == null ? "n/a" : esc(s.night)}<ul>${(g.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
}

const STATUS_LABEL = { pass: "PASS", fail: "FAIL", "expected fail": "EXPECTED FAIL", "now passes": "NOW PASSES: retire known_fail?" };

/** With --repeat: one row a case, k/N reps that passed their code checks, and each rep's first slip (the rule check and the engine note). A case counts only when every rep passes. */
export function repsTable(cs) {
  const ids = [...new Set(cs.map((c) => c.id))];
  if (!cs.some((c) => (c.reps || 1) > 1)) return "";
  const rows = ids.map((id) => {
    const rs = cs.filter((c) => c.id === id), ok = rs.filter((c) => ["pass", "expected fail", "now passes"].includes(c.status)).length;
    const first = rs.map((c) => { const sl = c.turns?.[0]?.slip; return sl ? `${sl.check ?? "unchecked"}${sl.engine_note ? "+note" : ""}` : "no slip"; }).join(" / ");
    return `<tr><td>${esc(id)}</td><td>${ok}/${rs.length}${ok === rs.length ? "" : " FAIL"}</td><td>${esc(first)}</td></tr>`;
  });
  return `<table class="qr-reps"><tr><th>case</th><th>passed</th><th>first slip, per rep</th></tr>${rows.join("")}</table>`;
}

export function cardHtml(c) {
  const kf = c.known_fail ? `<div class="qr-kf">known fail since ${esc(c.known_fail.since)}: ${esc(c.known_fail.why)}</div>` : "";
  return `<section class="qr-card" id="case-${esc(c.id)}${c.rep ? `-r${c.rep}` : ""}"><h2>${esc(c.id)}${c.reps > 1 ? ` rep ${c.rep}/${c.reps}` : ""} <span class="qr-st qr-${esc(String(c.status).replace(/ /g, "-"))}">${esc(c.notRun ? `NOT RUN (${c.notRun})` : STATUS_LABEL[c.status] || c.status)}</span></h2>`
    + `<div class="qr-title">${esc(c.title)} (${esc(c.agent)}), ${usd(c.micro || 0)}, ${Math.round((c.ms || 0) / 1000)} s</div>${kf}`
    + `<div class="qr-intent"><b>Good looks like:</b> ${esc(c.intent)}</div>`
    + chatHtml(c) + slipHtml(c) + nightHtml(c.night) + checksHtml(c.checks) + graderHtml(c.grade)
    + ((c.rep || 1) > 1 ? "" : `<div class="qr-mark" data-case="${esc(c.id)}"><button type="button" data-v="good">Good</button> <button type="button" data-v="bad">Bad</button> <input type="text" maxlength="1000" placeholder="note" aria-label="note for ${esc(c.id)}"> <span class="qr-saved"></span></div>`) + `</section>`;
}

const CSS = `<style>
.qr-card{border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:12px;margin:16px 0}
.qr-card h2{margin:0 0 4px;font-size:1.1rem}
.qr-st{font-size:.75rem;padding:2px 6px;border-radius:4px;border:1px solid currentColor}
.qr-pre{white-space:pre-wrap;word-break:break-word;overflow-x:auto;max-width:100%;font-size:.8rem;background:rgba(128,128,128,.12);padding:8px;border-radius:6px;margin:4px 0}
.qr-turn{margin:8px 0}.qr-p{opacity:.8}.qr-ev{font-size:.85rem;opacity:.7}.qr-lbl{font-size:.75rem;opacity:.6}
.qr-checks{list-style:none;padding:0;margin:8px 0;font-size:.85rem}.qr-checks .no{color:#c0392b}.qr-checks .ok{opacity:.75}.qr-d{opacity:.6}
.qr-slip,.qr-night,.qr-grader,.qr-intent,.qr-kf,.qr-audit{margin:8px 0;font-size:.9rem}
.qr-mark button{padding:8px 16px;margin-right:4px}.qr-mark button.on{font-weight:700;outline:2px solid currentColor}.qr-mark input{max-width:100%;width:14em}
.qr-top{font-size:.9rem;line-height:1.5}\n.qr-reps{font-size:.85rem;margin:8px 0}.qr-reps td,.qr-reps th{padding:2px 8px;text-align:left}
</style>`;

const SCRIPT = `<script>
(function(){
  var RUN=document.getElementById("qr-run").getAttribute("data-run");
  var marks=document.querySelectorAll(".qr-mark");
  function show(m,v,note){var b=m.querySelectorAll("button");for(var i=0;i<b.length;i++){b[i].className=(b[i].getAttribute("data-v")===v)?"on":"";}if(note!==undefined){m.querySelector("input").value=note||"";}}
  function save(m,v){
    var note=m.querySelector("input").value, tag=m.querySelector(".qr-saved");
    fetch("/e2e-verdict",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({run:RUN,case:m.getAttribute("data-case"),verdict:v,note:note})})
      .then(function(r){return r.json();}).then(function(j){tag.textContent=j.ok?"saved":"not saved";if(j.ok)show(m,v);}).catch(function(){tag.textContent="not saved";});
  }
  marks.forEach(function(m){
    var cur=null;
    m.querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){var v=b.getAttribute("data-v");cur=(cur===v)?null:v;show(m,cur);save(m,cur);});});
    m.querySelector("input").addEventListener("change",function(){save(m,cur);});
    m._set=function(v,n){cur=v;show(m,v,n);};
  });
  fetch("/e2e-verdicts?run="+encodeURIComponent(RUN)).then(function(r){return r.json();}).then(function(j){
    if(!j||!j.verdicts)return;
    marks.forEach(function(m){var x=j.verdicts[m.getAttribute("data-case")];if(x)m._set(x.verdict,x.note);});
  }).catch(function(){});
})();
</script>`;

/** Agreement of the grader with Buster over cases he has marked (a list of {grader, buster}). */
export function agreementLine(pairs) {
  if (!pairs.length) return "grader vs your marks: nothing marked yet";
  return `grader agreed with you on ${pairs.filter((p) => p.grader === p.buster).length} of ${pairs.length} marked cases`;
}

/** run: {run_id, stage, date, platform_sha, rules_ref, rules_sha, cost, cap, cases}. */
export function renderPage(run, { agreement = null } = {}) {
  const cs = run.cases || [];
  const codePass = cs.filter((c) => ["pass", "expected fail"].includes(c.status)).length;
  const graded = cs.filter((c) => c.grade?.ok);
  const good = graded.filter((c) => c.grade.verdict === "good").length;
  const cost = run.cost || {};
  const tagline = `${run.stage}: ${codePass}/${cs.length} as expected${graded.length ? `, grader good ${good}/${graded.length}` : ""}, ${usd(cost.api_micro || 0)}`;
  const nightCases = cs.filter((c) => c.night && c.night.status !== "n/a");
  const top = [
    `<div class="qr-top" id="qr-run" data-run="${esc(run.run_id)}">`,
    `<b>${esc(run.stage)} stage</b>, ${esc(run.date)}. Platform ${esc(run.platform_sha)}; rules ${esc(run.rules_ref)} (${esc(run.rules_sha)}).<br>`,
    `Code checks as expected: ${codePass}/${cs.length}. ${graded.length ? `Grader (advisory) good ${good}/${graded.length}. ` : "Grader not run. "}${esc(agreement || "")}<br>`,
    `Cost: ${usd(cost.api_micro || 0)} API dollars (models ${usd(cost.anthropic_micro || 0)}, grader ${usd(cost.gemini_micro || 0)}; prices in code, an estimate until a bill checks them)`,
    `${run.stage === "night" ? `; night: ${esc(cost.claude_calls ?? 0)} claude calls, ${esc((cost.claude_usd ?? 0).toFixed(2))} USD reported API-equivalent, billed to the subscription as plan usage; ${nightCases.length} case(s) went through the night` : ""}.<br>`,
    `Cap: ${run.cap_hit ? `HIT: ${esc(run.cap_hit)}` : "not hit"}. Verdicts you give are saved on the mini.`,
    `</div>`,
  ].join("");
  const fm = ["---", `title: ${JSON.stringify(`Promptocracy quality ${run.date} ${run.stage}`)}`, `date: ${run.date}`, `tagline: ${JSON.stringify(tagline)}`, "---", ""].join("\n");
  return `${fm}${CSS}\n${oneLine(top)}\n${repsTable(cs) ? `${oneLine(repsTable(cs))}\n` : ""}${cs.map((c) => oneLine(cardHtml(c))).join("\n")}\n${SCRIPT}\n`;
}
