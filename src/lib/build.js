// Stale-tab protection (site plumbing). A tab left open across a deploy keeps running the page code it loaded, against the rules the new deploy
// serves (2026-11-22: a phone ran yesterday's rulebook.js against today's RULES.md). Every page that loads /js modules is stamped with the deploy's id:
//   - <meta name="build">: the id this page was built for;
//   - an import map sending "/js/" to "/v/<id>/js/", so a new deploy means new module URLs (no cache, bfcache or module cache can hand back old
//     code) while modules that import each other as "/js/x.js" or "./x.js" still share ONE instance; the Worker serves /v/<id>/js/<f> from /js/<f>;
//   - the entry scripts' own src (an import map does not apply to a script's src) rewritten the same way;
//   - an inline guard (inline so it cannot itself be stale) that asks GET /api/version on load, when the tab becomes visible and on a bfcache restore,
//     and reloads once if the id differs (not while a text field holds text: the next check tries again, so nothing a player typed is lost). One reload per target id (sessionStorage), so a deploy that is still rolling out can never loop.
// Nothing is shown to the player: no banner, no text.

/** The deploy's id: BUILD_ID (tests), else the Workers version metadata binding (wrangler.toml [version_metadata]), else "dev". */
export const buildId = (env) => {
  const id = (env && (env.BUILD_ID || (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id))) || "dev";
  return String(id);
};

const PLAIN = /^[A-Za-z0-9._-]{1,64}$/;

/** The inline guard. Reload only when the server answers a different, plain id; never on an error; once per target id. */
export const guardScript = () => `<script>(function(){var m=document.querySelector('meta[name=build]');if(!m)return;var id=m.content,busy=false;
function typing(){var f=document.querySelectorAll('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])');for(var i=0;i<f.length;i++)if(f[i].value)return true;return false}
function check(){if(busy)return;busy=true;fetch('/api/version',{cache:'no-store'}).then(function(r){return r.ok?r.text():''}).then(function(t){busy=false;t=t.trim();
if(!/^[A-Za-z0-9._-]{1,64}$/.test(t)||t===id)return;if(typing())return;var k='build-reload';try{if(sessionStorage.getItem(k)===t)return;sessionStorage.setItem(k,t)}catch(e){return}location.reload()}).catch(function(){busy=false})}
check();document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')check()});
addEventListener('pageshow',function(e){if(e.persisted)check()})})()</script>`;

/** Stamp an HTML page with the build id, or return null when it loads no /js module (nothing to go stale). */
export function stampHtml(html, id) {
  if (!PLAIN.test(id)) throw new Error("build id is not plain: " + id);
  if (!html.includes('"/js/')) return null;
  const head = `<meta name="build" content="${id}"><script type="importmap">{"imports":{"/js/":"/v/${id}/js/"}}</script>${guardScript()}`;
  const body = html.replace(/(<script\b[^>]*\bsrc=")\/js\//g, `$1/v/${id}/js/`);
  const at = body.search(/<head[^>]*>/i);
  if (at < 0) return null;
  const end = at + body.slice(at).match(/<head[^>]*>/i)[0].length;
  return body.slice(0, end) + head + body.slice(end);
}
