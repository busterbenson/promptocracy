#!/usr/bin/env python3
"""prompt_lint.py: stop specifics creeping into durable prompts.

A fix gets written where something failed, and the cheapest edit is a line naming the
case ("no pink inner ears", "round 13"). Over time a prompt that is sent to a model again
and again fills up with past cases that bias every later answer. This lints the prompt
text itself and exits 1 on any hit that is not explicitly kept with a reason.

  prompt_lint.py --config prompt-lint.json            lint every prompt the config lists
  prompt_lint.py --config prompt-lint.json --sizes    also print each prompt's size against its budget
  prompt_lint.py FILE[:SYMBOL] ... [--allow Word]     ad hoc: lint a file, or one symbol's strings

Flags (each hit prints file:line: flag: reason | snippet):
  examples  "e.g." / "for example" / "such as" / "like" / "Examples:" followed by a list
            or a quoted case. One bare noun ("such as a building") is a generic rule and passes.
  past      a round, date, PR or issue number, "last time", "earlier", "previously",
            "we saw", "used to" (habitual): a reference to something that happened.
  proper    a capitalised run that is not at a sentence start and is not on the allowlist.
  budget    the prompt's text is longer than its budget in the config.

Keeping a line: put `prompt-lint: keep <reason>` in a code comment on the same line or on
the comment-only line just above it, or add {"file", "match", "reason"} to the config's
"keep" list (the only way inside a multi-line template literal). The reason is required.
A keep that matches nothing is itself an error, so the list cannot rot.

Extraction (what counts as prompt text):
  .js .mjs .ts   string and template literals; with SYMBOL only those inside that function,
                 class or const. ${expressions} are replaced by a placeholder.
  .py            string literals; with SYMBOL only those inside it; "calls": ["out.append"]
                 narrows that to the arguments of those calls.
  .md .txt       paragraphs; "fenced": true narrows that to the text inside ``` fences.
A prompt marked "advisory" in the config reports its hits without failing, and an
extraction error there (the symbol was renamed) is reported, not fatal.

Exit 0 clean, 1 hits (or a stale keep), 2 a usage or config error (a symbol that is not
found is an error, never a silent pass). Stdlib only, read-only.
"""
import argparse, ast, hashlib, io, json, os, re, sys, tokenize

PUA = ""  # stands for a ${...} / {...} expression inside a literal

# ----------------------------------------------------------------------------------------
# Units: one string literal (or a run of adjacently concatenated ones, or one paragraph).
# ----------------------------------------------------------------------------------------


class Unit:
    def __init__(self, text, lines, start=0):
        self.text = text      # the prompt text, expressions replaced by PUA
        self.lines = lines    # source line number of every character of text
        self.start = start    # source offset (js) or 0; used for symbol ranges

    def line_at(self, i):
        if not self.lines:
            return 0
        return self.lines[min(i, len(self.lines) - 1)]

    def first_line(self):
        return self.lines[0] if self.lines else 0

    def size(self):
        return len(self.text.replace(PUA, ""))


class ExtractError(Exception):
    pass


JS_KW_BEFORE_REGEX = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
                      "case", "do", "else", "yield", "await"}
JS_ESC = {"n": "\n", "t": " ", "r": "", "0": ""}


def js_scan(src):
    """-> (units, toks). toks: (kind, value, offset) for code tokens; kind in id, p, num, str, plus two template
    boundaries: ("tpl", None, off) where a ${ opens and ("tplend", unit index, off) where a template that had one closes."""
    units, toks = [], []
    i, n, line = 0, len(src), 1
    stack = []  # one entry per open ${: [unit, brace_depth, unit index]
    prev = None  # last significant token (kind, value)

    def read_tpl(i, line, unit):
        """Read template text from i until the closing backtick or a ${ ; returns (i, line, closed)."""
        while i < n:
            c = src[i]
            if c == "`":
                return i + 1, line, True
            if c == "$" and src.startswith("${", i):
                unit.text += PUA
                unit.lines.append(line)
                return i + 2, line, False
            if c == "\\" and i + 1 < n:
                e = src[i + 1]
                if e == "\n":
                    line += 1
                    i += 2
                    continue
                ch = JS_ESC.get(e, e)
                for x in ch:
                    unit.text += x
                    unit.lines.append(line)
                i += 2
                continue
            unit.text += c
            unit.lines.append(line)
            if c == "\n":
                line += 1
            i += 1
        raise ExtractError("unterminated template literal")

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            if j < 0:
                raise ExtractError("unterminated block comment")
            line += src.count("\n", i, j)
            i = j + 2
            continue
        if c == "`":
            u = Unit("", [], i)
            units.append(u)
            toks.append(("str", len(units) - 1, i))
            prev = ("str", None)
            i, line, closed = read_tpl(i + 1, line, u)
            if not closed:
                stack.append([u, 0, len(units) - 1])
                toks.append(("tpl", None, i))
                prev = ("p", "{")
            continue
        if c in "'\"":
            u = Unit("", [], i)
            q = c
            j = i + 1
            while j < n and src[j] != q:
                if src[j] == "\\" and j + 1 < n:
                    e = src[j + 1]
                    if e == "\n":
                        line += 1
                        j += 2
                        continue
                    for x in JS_ESC.get(e, e):
                        u.text += x
                        u.lines.append(line)
                    j += 2
                    continue
                if src[j] == "\n":
                    break
                u.text += src[j]
                u.lines.append(line)
                j += 1
            units.append(u)
            toks.append(("str", len(units) - 1, i))
            prev = ("str", None)
            i = j + 1
            continue
        if c.isalpha() or c in "_$":
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            toks.append(("id", src[i:j], i))
            prev = ("id", src[i:j])
            i = j
            continue
        if c.isdigit():
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] in "._"):
                j += 1
            toks.append(("num", src[i:j], i))
            prev = ("num", None)
            i = j
            continue
        if c == "/":
            regex_ok = prev is None or (prev[0] == "p" and prev[1] not in ")]") or (prev[0] == "id" and prev[1] in JS_KW_BEFORE_REGEX)
            if regex_ok:
                j, inclass, ok = i + 1, False, False
                while j < n and src[j] != "\n":
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j] == "[":
                        inclass = True
                    elif src[j] == "]":
                        inclass = False
                    elif src[j] == "/" and not inclass:
                        ok = True
                        break
                    j += 1
                if ok:
                    j += 1
                    while j < n and src[j].isalpha():
                        j += 1
                    toks.append(("num", "regex", i))
                    prev = ("num", None)
                    i = j
                    continue
        # punctuation
        if c == "{":
            if stack:
                stack[-1][1] += 1
        elif c == "}":
            if stack:
                if stack[-1][1] == 0:
                    u, _, ui = stack.pop()
                    i, line, closed = read_tpl(i + 1, line, u)
                    if closed:
                        toks.append(("tplend", ui, i - 1))
                        prev = ("str", None)
                    else:   # the same template's next ${
                        stack.append([u, 0, ui])
                        toks.append(("tpl", None, i))
                        prev = ("p", "{")
                    continue
                stack[-1][1] -= 1
        toks.append(("p", c, i))
        prev = ("p", c)
        i += 1
    if stack:
        raise ExtractError("unterminated ${ in a template literal")
    return _join_concat(units, toks)


def _join_concat(units, toks):
    """"a" + "b" is one prompt split across literals: join the two units (keeping every character's source line) so a list or a
    cue that crosses the boundary is still seen. Only literal + literal chains; an expression in between keeps them apart.
    The left operand is the literal that ends right before the +: for a template with a ${ that is its "tplend" token, not
    the last literal inside the interpolation, and a "tpl" token (a ${ opening) is never an operand."""
    out, dead, into = [], set(), {}
    for t in toks:
        if t[0] == "str" and len(out) >= 2 and out[-1][:2] == ("p", "+") and out[-2][0] in ("str", "tplend"):
            a, b = out[-2][1], t[1]
            while a in into:   # the left literal was itself joined into an earlier one
                a = into[a]
            units[a].text += units[b].text
            units[a].lines.extend(units[b].lines)
            dead.add(b)
            into[b] = a
            out.pop()
            continue
        out.append(t)
    return [u for i, u in enumerate(units) if i not in dead], out


def js_symbol_range(toks, symbol, src):
    """(start_offset, end_offset) of the declaration of `symbol`."""
    k, best, depth = None, None, 0
    for idx, (kind, val, _) in enumerate(toks):
        if kind == "p":
            depth += 1 if val in "([{" else -1 if val in ")]}" else 0
        if kind == "id" and val == symbol and idx > 0 and toks[idx - 1][0] == "id" and toks[idx - 1][1] in ("function", "const", "let", "var", "class"):
            if best is None or depth < best:   # the outermost declaration wins over a local of the same name
                k, best = idx, depth
    if k is None:
        raise ExtractError(f"symbol {symbol!r} not found (a function, class, const, let or var declaration)")
    kw = toks[k - 1][1]
    depth = 0
    if kw in ("function", "class"):
        seen_open = False
        for idx in range(k + 1, len(toks)):
            kind, val, off = toks[idx]
            if kind != "p":
                continue
            if val == "{" and depth == 0 and not (toks[idx - 1][0] == "p" and toks[idx - 1][1] in ":|&<,"):
                seen_open = True   # the body; a { after ":" or "|" or "<" is an object type in the return annotation
            if val in "([{":
                depth += 1
            elif val in ")]}":
                depth -= 1
                if depth == 0 and val == "}" and seen_open:
                    return toks[k][2], off
        raise ExtractError(f"symbol {symbol!r}: no closing brace")
    for idx in range(k + 1, len(toks)):
        kind, val, off = toks[idx]
        if kind == "id" and depth == 0 and val in ("const", "let", "var", "function", "class", "export", "import") \
                and not src[src.rfind("\n", 0, off) + 1:off].strip():
            return toks[k][2], off - 1   # no semicolon: the next declaration at the start of a line ends this one
        if kind != "p":
            continue
        if val in "([{":
            depth += 1
        elif val in ")]}":
            depth -= 1
        elif val == ";" and depth == 0:
            return toks[k][2], off
    return toks[k][2], toks[-1][2]


def js_units(src, symbol):
    units, toks = js_scan(src)
    if not symbol:
        return units
    lo, hi = js_symbol_range(toks, symbol, src)
    return [u for u in units if lo <= u.start <= hi]


# ----------------------------------------------------------------------------------------
# Python
# ----------------------------------------------------------------------------------------

PY_ESC = {"n": "\n", "t": " ", "r": "", "0": "", "\\": "\\", "'": "'", '"': '"'}


def py_literal(raw, line0):
    """Text and per-char lines of one python string literal's source."""
    m = re.match(r"([A-Za-z]*)('''|\"\"\"|'|\")", raw)
    prefix, q = m.group(1).lower(), m.group(2)
    body = raw[m.end():len(raw) - len(q)]
    is_raw, is_f = "r" in prefix, "f" in prefix
    text, lines, line = [], [], line0 + raw[:m.end()].count("\n")
    i = 0
    while i < len(body):
        c = body[i]
        if is_f and c == "{":
            if body.startswith("{{", i):
                text.append("{"); lines.append(line); i += 2
                continue
            depth, j, quote = 1, i + 1, None
            while j < len(body) and depth:
                ch = body[j]
                if quote:   # a string inside the expression: its braces don't nest
                    if ch == "\\":
                        j += 2
                        continue
                    if ch == quote:
                        quote = None
                elif ch in "'\"":
                    quote = ch
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                j += 1
            text.append(PUA); lines.append(line)
            line += body.count("\n", i, j)
            i = j
            continue
        if is_f and c == "}" and body.startswith("}}", i):
            text.append("}"); lines.append(line); i += 2
            continue
        if c == "\\" and not is_raw and i + 1 < len(body):
            e = body[i + 1]
            if e == "\n":
                line += 1; i += 2
                continue
            for x in PY_ESC.get(e, "\\" + e):
                text.append(x); lines.append(line)
            i += 2
            continue
        text.append(c); lines.append(line)
        if c == "\n":
            line += 1
        i += 1
    return "".join(text), lines


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def py_units(src, symbol, calls):
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise ExtractError(f"python syntax error: {e}")
    src_lines = src.splitlines(keepends=True)

    def span(node):
        """((row, col), (row, col)) of a node, columns in characters as tokenize counts them (ast counts UTF-8 bytes)."""
        def col(row, bcol):
            return len(src_lines[row - 1].encode("utf-8")[:bcol].decode("utf-8", "ignore")) if row <= len(src_lines) else bcol
        return (node.lineno, col(node.lineno, node.col_offset)), (node.end_lineno, col(node.end_lineno, node.end_col_offset))

    ranges, scope = [((1, 0), (len(src_lines) + 2, 0))], tree
    if symbol:
        found = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:
                found = node
                break
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == symbol for t in node.targets):
                found = node
                break
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == symbol:
                found = node
                break
        if found is None:
            raise ExtractError(f"symbol {symbol!r} not found")
        ranges, scope = [span(found)], found
    if calls:
        ranges = [span(c) for c in ast.walk(scope) if isinstance(c, ast.Call) and dotted(c.func) in calls]
        if not ranges:
            raise ExtractError(f"no call to {calls} found" + (f" inside {symbol!r}" if symbol else ""))
    in_range = lambda pos: any(a <= pos < b for a, b in ranges)   # two statements can share a line: rows alone are not enough
    offs = [0]
    for l in src_lines:
        offs.append(offs[-1] + len(l))
    abs_off = lambda pos: offs[pos[0] - 1] + pos[1]

    spans = []  # (start_pos, end_pos, first_tok, last_tok) of every literal, outermost only
    fdepth, fstart, fidx = 0, None, None
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    for idx, t in enumerate(toks):
        name = tokenize.tok_name.get(t.type, "")
        if name == "FSTRING_START":
            if fdepth == 0:
                fstart, fidx = t.start, idx
            fdepth += 1
        elif name == "FSTRING_END":
            fdepth -= 1
            if fdepth == 0:
                spans.append((fstart, t.end, fidx, idx))
        elif t.type == tokenize.STRING and fdepth == 0:
            spans.append((t.start, t.end, idx, idx))
    units, prev_last = [], None
    for start, end, first, last in spans:
        if not in_range(start):
            prev_last = None
            continue
        text, lines = py_literal(src[abs_off(start):abs_off(end)], start[0])
        adjacent = prev_last is not None and all(x.type in (tokenize.NL, tokenize.COMMENT) for x in toks[prev_last + 1:first])
        if adjacent and units:
            units[-1].text += text
            units[-1].lines += lines
        else:
            units.append(Unit(text, lines))
        prev_last = last
    return units


# ----------------------------------------------------------------------------------------
# Markdown / text
# ----------------------------------------------------------------------------------------


def md_units(src, fenced):
    # an HTML comment is not prompt text (it is where a keep marker goes)
    lines = [re.sub(r"<!--.*?-->", "", l) for l in src.split("\n")]
    keep = []
    infence = False
    for n, l in enumerate(lines, 1):
        if l.lstrip().startswith("```"):
            infence = not infence
            keep.append(None)
            continue
        keep.append(l if (infence or not fenced) else None)
    units, cur_t, cur_l = [], [], []
    def flush():
        if cur_t:
            text = "\n".join(cur_t)
            ls = []
            for t, n in zip(cur_t, cur_l):
                ls += [n] * (len(t) + 1)
            units.append(Unit(text, ls[:len(text)]))
            cur_t.clear(); cur_l.clear()
    for n, l in enumerate(keep, 1):
        if l is None or not l.strip():
            flush()
        else:
            cur_t.append(l); cur_l.append(n)
    flush()
    if fenced and not units:
        raise ExtractError("no fenced code block with text found")
    return units


def extract(path, src, symbol=None, calls=None, fenced=False):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"):
            return js_units(src, symbol)
        if ext == ".py":
            return py_units(src, symbol, calls)
        if ext in (".md", ".markdown", ".txt"):
            return md_units(src, fenced)
    except ExtractError as e:
        raise ExtractError(f"{path}: {e}")
    raise ExtractError(f"{path}: don't know how to extract prompt text from {ext or 'this file type'}")


# ----------------------------------------------------------------------------------------
# The flags
# ----------------------------------------------------------------------------------------

EX_TRIG = re.compile(r"(?<![\w.])(?:e\.g\.?|for (?:example|instance)|such as|like(?=\s+(?:an?\s|\d|[\"“`]))|(?:examples?|samples?)\s*[:.])", re.I)

MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
PAST = [
    (re.compile(r"\blast (?:time|round|week|night|turn|session|run|month|year|day|tick)\b", re.I), "refers to a past occasion"),
    (re.compile(r"\b(?:earlier|previously|formerly|originally|yesterday|recently|before now)\b", re.I), "refers to what came before"),
    (re.compile(r"\bonce (?:\w+ed|had|was|were|did|made|wrote|ran|saw|took|got|sent)\b", re.I), "refers to something that happened once"),
    (re.compile(r"\bwe (?:saw|'ve seen|have seen|found|hit)\b|\bwe(?:'ve| have) (?:had|seen)\b", re.I), "refers to something that was seen"),
    (re.compile(r"\brounds?\s*#?\d+\b", re.I), "names a round"),
    (re.compile(r"\b(?:PRs?|pull request|issue|ticket|bug)s?\s*#?\d+\b", re.I), "names a PR or issue"),
    (re.compile(r"(?<![&\w])#\d{2,}\b|\b[\w-]+#\d{2,}\b"), "names a PR or issue number"),
    (re.compile(r"\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b"), "names a date"),
    (re.compile(r"\b" + MONTH + r"\s+\d{1,2}(?:st|nd|rd|th)?\b"), "names a date"),
    (re.compile(r"\b\d{1,2}/\d{1,2}/(?:19|20)?\d{2}\b"), "names a date"),
    (re.compile(r"(?<![\d.\-/])(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d\-/])"), "names a date (MM-DD)"),
]
USED_TO = re.compile(r"\bused to\b", re.I)
HABITUAL_SUBJECT = {"we", "it", "they", "he", "she", "i", "you", "this", "that", "there", "which", "who", "things", "players", "agents"}

CAP = re.compile(r"\b[A-Z][a-z][A-Za-z]*\b")
BOUNDARY_CHARS = set(".!?:;\"“”‘(-–—*>/#|[{=" + PUA)


def _strip_code(text):
    return re.sub(r"`[^`\n]*`|<[^<>\n]{0,80}>", lambda m: " " * len(m.group(0)), text)


def example_tail(text, start):
    depth, inq, out = 0, False, []
    for j in range(start, len(text)):
        c = text[j]
        if c in '"“”':
            inq = not inq
        elif not inq:
            if c in "([":
                depth += 1
            elif c in ")]":
                if depth == 0:
                    break
                depth -= 1
            elif c == ";" and depth == 0:
                break
            elif c == "," and depth == 0 and re.match(r",\s+(?:is|are|was|were|be|it|its|you|your|they|we|which|that|then|so|but|and then|do|does|can|will|should|must|has|have|keep|use|say)\b", text[j:]):
                break   # the list is over; a new clause starts
            elif c == "\n":
                if re.match(r"\n\s*(?:\n|[-*]\s|\d+[.)]\s|#)", text[j:]):
                    break
                c = " "
            elif c in ".!?" and depth == 0 and (j + 1 >= len(text) or text[j + 1] in " \n\t"):
                break
        out.append(c)
    return "".join(out)


# ----------------------------------------------------------------------------------------
# patch: a negation followed by a closed list of specifics ("No pink anywhere: inner ears, noses and tongues ...")
# ----------------------------------------------------------------------------------------

# A negation or exclusion. The "n't" forms and "do not" are verb cues: a verb usually follows ("never mention X, Y or Z").
NEG_CUE = re.compile(
    r"(?<![\w'’/-])(?:(?P<verb>(?:do|does|did|must|should|shall|will|would|can|could|may|might)\s+not|cannot|\w+n['’]t|never|avoid|skip)"
    r"|(?P<plain>no|nor|neither|not|without|except|excluding|nothing\s+(?:about|of))(?!\s+to\b))(?![\w-])", re.I)
EMPTY = {"none", "nothing", "nobody", "anything", "anyone", "else", "other", "others", "more", "either"}   # "no marks, none": not a case
DETERMINERS = {"a", "an", "the", "any", "its", "their", "his", "her", "your", "our", "one", "some", "this", "that", "these", "those",
               "more", "than", "of", "all", "every", "each", "even", "also", "ever", "again", "absolutely", "ever", "just", "really"}
NEG_WORDS = {"no", "nor", "never", "not", "neither", "without", "nothing", "and", "or", "but", "except"}
# words that cannot sit inside a noun-phrase item: the clause has turned into a sentence
FINITE = {"is", "are", "was", "were", "be", "been", "being", "use", "uses", "used", "using", "may", "must", "can", "will", "should", "would", "could",
          "keep", "keeps", "stay", "stays", "goes", "go", "has", "have", "had", "do", "does", "did", "it", "its", "you", "your", "they", "we", "i",
          "which", "who", "when", "where", "if", "so", "because", "until", "unless", "since", "while", "then", "instead", "rather", "but", "to", "for", "in", "on", "at", "by",
          "with", "from", "as", "into", "onto", "over", "under", "about", "between", "inside", "outside", "than", "that", "there", "here", "even", "only", "still", "also", "too"}
# an abstract or format-level word is not a concrete case: a list of these is a rule about the output, not a patch
META = {"jargon", "idiom", "idioms", "slang", "filler", "pleasantries", "preamble", "sign-off", "instruction", "instructions", "prompt", "budget", "deadline", "guess", "hedging",
        "markup", "markdown", "formatting", "link", "links", "url", "urls", "heading", "headings", "text", "quote", "quotes",
        "gradient", "gradients", "gloss", "texture", "textures", "title", "number"}   # a list of these is about the output's format, not a case
# common verbs: "never open, list, search or name its directory" is a list of verbs, not of things
VERBS = {"open", "list", "search", "name", "run", "use", "write", "add", "draw", "say", "ask", "tell", "give", "make", "put", "show", "include",
         "repeat", "reveal", "print", "read", "edit", "touch", "refuse", "delete", "remove", "create", "build", "push", "pull", "poll", "sleep",
         "loop", "wait", "leave", "change", "set", "call", "mention", "suggest", "send", "post", "merge", "move", "copy", "paste", "check", "stop",
         "start", "try", "guess", "invent", "assume", "promise", "apologise", "apologize", "explain", "describe", "comment", "answer", "reply",
         "respond", "save", "store", "log", "wait", "retry", "skip", "fix", "ignore", "obey", "follow", "return", "output", "emit", "generate",
         "render", "fill", "rename", "restart", "kill", "arm", "seed", "exercise", "hand-roll", "improvise", "redesign", "widen", "carry"}
COLORS = {"red", "pink", "orange", "yellow", "green", "blue", "purple", "violet", "brown", "grey", "gray", "black", "white", "gold", "golden",
          "silver", "teal", "cyan", "magenta", "beige", "navy", "crimson", "turquoise", "lavender", "maroon", "tan", "cream"}
ABSTRACT_SUFFIX = ("tion", "sion", "ence", "ance", "ity", "ment", "ness", "ship", "ism")   # condition, consequence, exception: ideas, not things
ADJ_SUFFIX = ("y", "ed", "ful", "less", "ous", "ive", "ish", "ly", "ble")
ITEM_SPLIT = re.compile(r",?\s+(?:or|and|nor)\s+|,\s*|\s*/\s*|\s+(?:or|and|nor)\s+")


def _protect(text):
    """Quoted and backticked spans become one placeholder token each (same length as the span, so indexes still map back)."""
    spans = []

    def sub(m):
        n = len(m.group(0))
        spans.append(m.group(0))
        return "\x01" + chr(0xE100 + (len(spans) - 1) % 200) * (n - 2) + "\x02"
    return re.sub(r"`[^`\n]*`|\"[^\"\n]*\"|“[^”\n]*”", sub, text), spans


def _clause(text, start):
    """The text after a cue up to the end of its clause (paren-aware); also returns whether it ended at a colon."""
    depth, j = 0, start
    while j < len(text):
        c = text[j]
        if c in "([":
            depth += 1
        elif c in ")]":
            if depth == 0:
                break
            depth -= 1
        elif c in ";\n" and depth == 0:
            break
        elif c == ":" and depth == 0:
            return text[start:j], True
        elif c in ".!?" and depth == 0 and (j + 1 >= len(text) or text[j + 1] in " \n\t") and not re.search(r"(?:e\.g|i\.e|etc|vs)$", text[start:j + 1]):
            break
        elif text.startswith(" — ", j) or text.startswith(" – ", j):
            break
        j += 1
    return text[start:j], False


PREPS = {"to", "for", "in", "on", "at", "by", "with", "from", "as", "into", "onto", "over", "under", "about", "between", "inside", "outside", "than", "of", "like"}
DEIXIS = {"this", "these", "those", "your", "our", "their", "my", "its"}   # "these instructions", "your system prompt": the prompt talking about itself


def _items(chunk, loose=False):
    """Leading noun-phrase items of a clause fragment: [(words, protected)], stopping where the clause turns into a sentence.
    loose: items of up to six words that may contain prepositions (the segments of "never X, never Y")."""
    out = []
    parts = [p for p in ITEM_SPLIT.split(chunk) if p is not None]
    for part in parts:
        words = [w for w in re.findall(r"[\x01\x02\ue100-\ue1ff]+|[\w'’-]+", part)]
        if not words:
            continue
        # drop repeated negation words and determiners at the front ("no gloss", "never an apology", "and absolutely no floor")
        k = 0
        while k < len(words) and (words[k].lower() in NEG_WORDS or words[k].lower() in DETERMINERS):
            k += 1
        deixis = any(w.lower() in DEIXIS for w in words[:k])
        words = words[k:]
        if not words:
            return out
        prot = any("\x01" in w for w in words)
        low = [w.lower() for w in words]
        bad = FINITE - PREPS if loose else FINITE
        if not prot and (len(words) > (6 if loose else 4) or any(w in bad for w in low)):
            return out
        if prot and len(words) > 3:
            return out
        out.append((words, prot, deixis))
    return out


def _is_adjectivey(words):
    if len(words) == 1:
        w = words[0].lower()
        return "-" in w or w.endswith(ADJ_SUFFIX) and len(w) > 4
    return False


def _concrete(items):
    keep = []
    for item in items:
        words, prot, deixis = item
        low = [w.lower() for w in words]
        if prot:
            keep.append(item)
            continue
        if low[-1] in META or low[0] in META or low[0] in EMPTY:
            continue
        if deixis or _is_adjectivey(words) or (len(low[-1]) > 6 and low[-1].endswith(ABSTRACT_SUFFIX)):
            continue
        keep.append(item)
    return keep

# ---- specificity: is a list item a particular thing, or a general class? --------------------------------------------------
# An item is specific when it carries a quoted or backticked string, a file name or path, a name-with-a-digit ("D1"), a capitalised name
# that is not on the allowlist, or a concrete everyday noun (a body part, an object, an animal, a piece of clothing, a colour, a material).
# A list is a patch when at least two of its items are specific: "(a Redash query, a Zendesk note)", "(beards, metal)", "the left ear,
# the tail tip or the whiskers". General classes ("a reviewer, a helper", "PR bodies, commit messages", "which player, how many") are
# rules that state scope, and so are the keys of a schema and the steps of a procedure.
CONCRETE = set("""head face eye ear nose mouth lip tongue tooth teeth beak bill tail wing leg foot feet paw claw hand finger arm shoulder knee elbow
hair beard moustache mustache whisker brow eyebrow lash horn hoof fin feather fur skin nail thumb toe neck chin cheek belly chest hip spine rib
brain heart muscle musculature bone wrist ankle jaw forehead fist palm
hat cap scarf glove boot shoe sock coat cape cloak robe dress shirt tie belt hem sleeve collar glasses spectacles monocle crown helmet mask badge
ribbon bow satchel backpack purse wallet necklace bracelet earring umbrella cane sword shield spear axe arrow wand lantern jewel jewellery
chair desk bed lamp door window wall floor ceiling roof stair plinth pedestal frame border shadow pillow cup mug bottle plate bowl fork knife
spoon pot pan book pen pencil letter crate barrel bucket basket rope chain wheel car truck bike bus boat plane phone laptop keyboard router
modem cable plug battery charger printer camera clock mirror candle torch toy doll ball kite
tree flower leaf grass rock stone mountain river lake sea ocean beach cloud sun moon rain snow wind water ice mud sand
metal wood glass leather cloth silk plastic iron steel brick concrete rubber wool cotton
cat dog bird fish horse cow pig sheep goat rabbit rat fox wolf bear lion tiger owl crow duck goose hen chicken frog snake lizard turtle bee ant spider
butterfly insect pony mule donkey deer squirrel hedgehog otter seal whale dolphin shark
bread cheese milk egg apple banana cake coffee tea wine beer soup rice meat pizza cookie
stripe spot dot logo emoji icon watermark smiley euro pound yen dollar cent coin banknote flag drum guitar piano violin bell
eyelid cheekbone dimple wrinkle freckle tattoo scar piercing nostril pupil iris knuckle thigh calf heel sole lung stomach throat scalp temple
football cricket tennis soccer baseball basketball golf rugby hockey boxing chess poker
furlong cubit league mile inch yard ounce gallon pint fathom kilogram
peacock parrot eagle hawk swan pigeon sparrow penguin zebra giraffe elephant monkey gorilla camel kangaroo panda koala
person man woman child baby king queen knight wizard pirate robot dragon ghost""".split())
CONCRETE |= COLORS
PATHISH = re.compile(r"[A-Za-z_]/[A-Za-z_]|~/|_|[A-Za-z]\.[a-z]{1,4}\b|^-{1,2}[a-z]|[A-Za-z]\d|\d{4}-\d\d")
SCHEMA = re.compile(r'"[^"\s]{1,40}"\s*:|\{\s*"|"\s*\|\s*"')   # a JSON key or an enum: the quoted words are the format, not cases


POINTER = {"table", "section", "step", "steps", "line", "row", "column", "page", "heading", "fallback", "paragraph", "rule", "clause", "item"}   # cross-references locate; they do not illustrate
LIST_SPLIT = re.compile(r",?\s+(?:or|and|nor)\s+|,\s*")


def _spec_word(w, allow, exempt=False):
    if re.fullmatch(r"P[0-4]", w):
        return False   # a priority scale (P1, P2): a class of severity, not a named thing
    if PATHISH.search(w):
        return True
    if w[:1].isupper() and not w.isupper() and len(w) > 1 and not exempt:
        return True
    lw = w.lower().strip("'’")
    if lw.endswith(("'s", "’s")):
        lw = lw[:-2]
    for cand in (lw, lw[:-1] if lw.endswith("s") else lw, lw[:-2] if lw.endswith("es") else lw, lw[:-3] + "y" if lw.endswith("ies") else lw):
        if cand in CONCRETE:
            return True
    return False


def _item_specific(words, prot, deixis, allow, schema=False, exempt=False):
    """words: the item's words (determiners already stripped). A deictic item ("its head", "these instructions") is the prompt talking about itself.
    exempt: the item opens a sentence, so a capital letter on its first word proves nothing."""
    if prot:
        return not schema and not deixis
    if words[-1].lower() in POINTER:
        return False
    return any(_spec_word(w, allow, exempt and i == 0) for i, w in enumerate(words))


def _count_specific(items, allow, schema=False, exempt_first=False):
    return sum(1 for n, (words, prot, deixis) in enumerate(items) if _item_specific(words, prot, deixis, allow, schema, exempt_first and n == 0))


RUN_CUT = re.compile(r"[.;:!?()\[\]\n]| — | – | -- ")
RUN_LEAD = re.compile(r"^\s*(?:e\.g\.?|i\.e\.?|such as|like|including|incl\.|for example|for instance)\s+", re.I)
SUBORD = {"instead", "rather", "because", "which", "that", "where", "when", "while", "unless", "until", "if", "since", "whose"}
LEAD_CONJ = {"so", "then", "and", "or", "but", "plus", "also", "nor"}
CLAUSE_START = {"before", "after", "when", "while", "if", "once", "until", "unless", "because", "since", "as", "so", "then", "that", "which"}


def list_hits(text, allow=frozenset()):
    """[(index, end, snippet)]: a run of two or more short comma / "or" / "and" separated items, at least two of them specific, wherever it sits
    (in parentheses, after a colon, after a negation or inline). Inside parentheses one named item is enough."""
    prot, _ = _protect(text.replace(PUA, " "))
    schema = bool(SCHEMA.search(text))
    hits = []
    cuts = [m for m in RUN_CUT.finditer(prot)]
    bounds = [(0, None)] + [(m.end(), m.group(0)) for m in cuts]
    ends = [m.start() for m in cuts] + [len(prot)]
    for (start, lead), end in zip(bounds, ends):
        seg = prot[start:end]
        in_paren = lead == "("
        body = RUN_LEAD.sub("", seg)
        if re.search(r"\bthen\b", body):
            continue   # "A, then B": the steps of a procedure, not a list of cases
        off = start + len(seg) - len(body)
        parts = [x for x in LIST_SPLIT.split(body) if x is not None]
        run, runs = [], []
        for part in parts:
            words = re.findall(r"[\x01\x02\ue100-\ue1ff]+|[\w'’./~$<>-]+", part)
            while words and words[0].lower() in LEAD_CONJ:
                words = words[1:]
            if not run and len(words) > 1 and words[0].lower() in VERBS:
                words = words[1:]   # "Remove the badge, the ribbon and ...": the lead-in verb is not part of the first item
            if not words:
                continue
            tail_cut = next((k for k, w in enumerate(words) if k >= 1 and w.lower() in SUBORD), None)
            if tail_cut:
                words = words[:tail_cut]   # "`--max-warnings 0` instead of editing its config": the item, then the rest of the sentence
            low = [w.lower() for w in words]
            bad = FINITE - PREPS
            core = [w for k, w in enumerate(low) if not (all(x in DETERMINERS or x in NEG_WORDS for x in low[:k + 1]))]   # the words after the determiners
            ok = 0 < len(words) <= (8 if in_paren else 6) and not any(w in bad for w in core) and low[0] not in CLAUSE_START \
                and not (len(words) > 1 and low[0] in VERBS)
            if ok:
                run.append(words)
                if tail_cut:
                    if len(run) >= 2:
                        runs.append(run)
                    run = []
            else:
                if len(run) >= 2:
                    runs.append(run)
                run = []
        if len(run) >= 2:
            runs.append(run)
        for r in runs:
            items = []
            for words in r:
                k = 0
                while k < len(words) and (words[k].lower() in NEG_WORDS or words[k].lower() in DETERMINERS):
                    k += 1
                deixis = any(w.lower() in DEIXIS for w in words[:k])
                rest = words[k:]
                if rest:
                    items.append((rest, any("\x01" in w for w in rest), deixis))
            if len(items) < 2:
                continue
            before = (prot[max(0, off - 40):off] + body.split("\x01")[0]).lower()
            keys = bool(re.search(r"\b(?:keys?|fields?|columns?|attributes?|properties|options?|values?|labels?|enum|one of)\b[^.;:]{0,20}$", before))
            n = _count_specific(items, allow, schema or keys, not in_paren)
            named = sum(1 for words, prot_, deixis in items if not deixis and not prot_ and words[-1].lower() not in POINTER and any(PATHISH.search(w) or (w[:1].isupper() and not w.isupper() and w not in allow and len(w) > 1) for w in words))
            if n >= 2 or (in_paren and named >= 1 and len(items) <= 3):
                snip = " ".join(body[:90].split())
                snip = re.sub(r"[\x01\x02\ue100-\ue1ff]+", "…", snip)
                hits.append((off, off + len(body), snip))
    return hits


def patch_hits(text, allow=frozenset()):
    """[(index, reason, snippet)] for a negation followed by a closed list of specifics, or a named colour."""
    prot, spans = _protect(text.replace(PUA, " "))
    hits, covered = [], -1
    for m in NEG_CUE.finditer(prot):
        if m.start() < covered:
            continue
        if m.group("plain") and m.group("plain").lower() == "not" and re.search(r",\s*$", prot[:m.start()]):
            continue   # "a rule, not a block or a clause": a contrast, not a prohibition
        clause, colon = _clause(prot, m.end())
        first = _items(clause)
        cands = [first]
        if m.group("verb"):
            # "never mention coupons, refunds ...", "never ask about the weather ...": the first word is the verb
            words = clause.split(None, 1)
            if len(words) > 1 and words[0].lower().strip(",") not in DETERMINERS and not re.match(r"\s*[\w'’-]+\s*,", clause):
                rest = words[1]
                cands.append(_items(rest))
                w2 = rest.split(None, 1)
                if len(w2) > 1 and w2[0].lower() in PREPS:
                    cands.append(_items(w2[1]))
        for pm in re.finditer(r"\(([^()]*)\)", clause):   # "never X another way (a different tool, script or library)"
            cands.append(_items(pm.group(1)))
        tail = re.split(r"\s(?:with|using|via|through)\s", clause, maxsplit=1)
        if len(tail) == 2:   # "don't exercise endpoints with a `curl`/`wget` POST, PUT or upload"
            cands.append(_items(tail[1]))
        segs = re.split(r",\s*(?:and\s+)?(?:absolutely\s+)?(?=(?:never|no|not|nor)\b)", clause)
        if len(segs) >= 2:   # "never curled over the back, never fanned like a peacock's"
            cands.append(_items(segs[0], True) + [it for sg in segs[1:] for it in _items(sg, True)[:1]])
        if len([it for it in first if it[1]]) >= 2:   # a list of quoted or backticked cases
            cands.append([it for it in first if it[1]])
        ok = None
        if m.group("verb") and first and all(len(it[0]) == 1 and it[0][0].lower() in VERBS for it in first[:2]):
            cands = []   # "never open, list, search or name its directory": verbs, not things
        for c in cands:
            c = _concrete(c)
            if len(c) >= 2 and (_count_specific(c, allow) >= 1):
                ok = c
                break
        if ok is None and m.group("verb") and re.match(r"(?:don['’]t|do\s+not|never|avoid)$", m.group("verb"), re.I):
            for pm in re.finditer(r"\x01([\ue100-\ue1ff]+)\x02", clause[:60]):   # "don't loop on "add a DEBUG line, rerun"": a quoted case of the thing to avoid
                span = spans[ord(pm.group(1)[0]) - 0xE100] if ord(pm.group(1)[0]) - 0xE100 < len(spans) else ""
                if span.startswith(('"', "“")) and len(span.split()) >= 3:
                    ok = [(["quoted case"], True, False)]
                    break
        if ok is None:
            low = [w.lower() for w in re.findall(r"[\w'’-]+", clause)][:3]
            if (m.group("plain") or m.group("verb")) and low and any(w in COLORS for w in low[:2]):
                ok = [(low[:1], False, False)]
            elif colon:
                tail = prot[m.end() + len(clause) + 1:]
                head = re.split(r"[.;\n]", tail, maxsplit=1)[0]
                lead = _items(re.split(r"\b(?:use|uses|are|is|get|gets|stay|stays|take|takes|keep|keeps|should|must|may|can|have|has|follow|come|comes)\b", head, maxsplit=1)[0])
                lead = _concrete(lead)
                if len(lead) >= 2 and re.search(r"\b(?:use|uses|are|is|get|gets|stay|stays|take|takes|keep|keeps|should|must|may|can|have|has|follow|come|comes)\b", head):
                    ok = lead
        if ok is not None:
            covered = m.end() + len(clause)
            snippet = " ".join(prot[m.start():m.end() + len(clause) + (40 if colon else 0)].split())
            snippet = re.sub(r"[\x01\x02\ue100-\ue1ff]+", "…", snippet)
            hits.append((m.start(), snippet))
    return hits


def lint_unit(unit, allow):
    """-> list of (line, flag, reason, snippet)"""
    text, hits = unit.text, []
    add = lambda i, flag, reason, snip: hits.append((unit.line_at(i), flag, reason, " ".join(snip.replace(PUA, "{}").split())[:90], i))

    for m in EX_TRIG.finditer(text):
        tail = example_tail(text, m.end())
        flat = tail.replace(PUA, "X")
        items = [x for x in re.split(r",|\bor\b|\band\b|/", re.sub(r'"[^"]*"|“[^”]*”', lambda q: q.group(0).replace(",", ";"), flat)) if x.strip(" \t:;-")]
        quoted = re.search(r'"[^"]+"|“[^”]+”|`[^`]+`', tail)
        word = m.group(0).strip().lower()
        word = word if word.startswith("e.g") else word.rstrip(":.")
        isverb = lambda x: bool(x.split()) and (x.split()[0].strip(" .;:-").lower() in VERBS or x.split()[0].strip(" .;:-").lower().endswith("ing"))
        verbs_only = not quoted and len(items) >= 2 and all(isverb(x) for x in items) and all(len(x.split()) == 1 for x in items[:2])
        if (quoted or len(items) >= 2) and not verbs_only:   # "such as sending, deleting or paying": a list of kinds of action is the scope, not cases
            add(m.start(), "examples", f'"{word}" is followed by a {"quoted case" if quoted else "list of examples"}: state the general rule and keep the cases out of the prompt', text[m.start():m.end() + 60])

    for rx, why in PAST:
        for m in rx.finditer(text):
            add(m.start(), "past", why, text[max(0, m.start() - 20):m.end() + 25])
    for m in USED_TO.finditer(text):
        before = re.findall(r"[A-Za-z']+", text[max(0, m.start() - 24):m.start()])
        if not before or before[-1].lower() not in HABITUAL_SUBJECT:
            continue   # "a tool used to build", "is used to size": not a past habit
        add(m.start(), "past", 'habitual "used to" refers to how things were', text[max(0, m.start() - 20):m.end() + 25])

    seen_patch = set()
    for i, snip in patch_hits(text, allow):
        seen_patch.add(i)
        add(i, "patch", "a negation followed by a closed list of specifics: name the property the rule is about, not the cases that broke it", snip)
    taken = [(h[4], h[4] + 160) for h in hits]   # a list another flag already reports (an "e.g." tail, a negation clause) is one finding, not two
    for i, end, snip in list_hits(text, allow):
        if any(i - 4 <= lo <= end or lo - 4 <= i <= hi for lo, hi in taken):
            continue
        add(i, "patch", "a list of specific items (names, objects, body parts, commands, quoted strings): state the property or the class, not the cases", snip)

    code_blind = _strip_code(text)
    seen = set()
    for m in re.finditer(r"\b[A-Z][a-z][A-Za-z]*(?: [A-Z][a-z][A-Za-z]*)*\b", code_blind):
        words = m.group(0).split(" ")
        k = m.start() - 1
        while k >= 0 and code_blind[k] in " \t":
            k -= 1
        at_start = k < 0 or code_blind[k] in BOUNDARY_CHARS or code_blind[k] == "\n"
        if at_start:
            words = words[1:]
        words = [w for w in words if w not in allow]
        if not words:
            continue
        run = " ".join(words)
        key = (unit.line_at(m.start()), run)
        if key in seen:
            continue
        seen.add(key)
        add(m.start(), "proper", f'"{run}" looks like a proper noun that is not on the allowlist: a named thing in a durable prompt is a past case or a bias (add game terms to the allowlist)', code_blind[max(0, m.start() - 20):m.end() + 25])
    return hits


# ----------------------------------------------------------------------------------------
# Judged mode (optional): a model labels sentences, the answers are recorded in a file, and the lint only reads the file.
# The lint itself never calls a model, so CI is deterministic and offline. An agent answers an export, the answers are merged
# into the recorded file, and a sentence whose wording changes is simply unjudged again.
# ----------------------------------------------------------------------------------------

JUDGE_PROMPT = """You review lines taken from durable prompts: text that is sent to a model again and again (an app's system prompts, the standard rules an agent brief carries). For each numbered line decide whether it is a PATCH or a RULE.

P (patch): the line, or a clause inside it, exists to rule out or enumerate specific named cases: particular objects, body parts, features, colours, words, commands, tools, places, dates or incidents. Patches are typically added after one failed output ("no pink anywhere: inner ears, noses and tongues use the cream", "never mention coupons, refunds or shipping times", "avoid the words 'delve' and 'tapestry'", a parenthetical naming cases "(a Redash query, a Zendesk note)", "(a parallel agent once published the wrong body)"). Test: if you deleted the named cases, the line would still state the general rule, and the cases only bias later answers toward themselves.

R (rule): everything else. A general rule, a format or tone requirement, a field or schema definition, a voice sample, a structural instruction, a fact the model needs. Lists of format properties (no markup, no links), of abstract categories (deadlines, prices, outcomes, settings), of verbs, or of required fields are R, not P.

Calibrate: most lines are R. Call a line P only when you can point at the specific named case in it.

Output: a single JSON object mapping each line number (as a string) to "P" or "R", nothing else."""


def sentences(unit):
    """[(key, text, line, start, end)] for every sentence of a unit that is long enough to judge. The key is stable across line moves."""
    text = unit.text
    out, pos = [], 0
    for para in re.split(r"\n\s*\n|\n(?=\s*[-*]\s)", text):
        base = text.find(para, pos)
        pos = base + len(para)
        for m in re.finditer(r"\S.*?(?:[.!?](?=\s+[A-Z\"“{(*\-" + PUA + r"])|$)", para, re.S):
            sent = " ".join(m.group(0).replace(PUA, "{}").split())
            words = [w for w in sent.replace("{}", "").split() if w]
            if len(words) < 4 or len(sent) < 25:
                continue
            key = hashlib.sha1(sent.encode()).hexdigest()[:16]
            out.append((key, sent, unit.line_at(base + m.start()), base + m.start(), base + m.end()))
    return out


def load_judged(path):
    try:
        data = json.load(open(path))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise ExtractError(f"cannot read judged file {path}: {e}")
    ans = data.get("answers", {})
    for k, v in ans.items():
        if v.get("label") not in ("P", "R"):
            raise ExtractError(f"judged file {path}: {k} has no P/R label")
    return ans


def judge_export(todo, out_path):
    """Write the unjudged sentences and the prompt for an agent to answer; todo = {key: text}."""
    keys = list(todo)
    json.dump({"prompt": JUDGE_PROMPT, "lines": {str(i + 1): todo[k] for i, k in enumerate(keys)}, "keys": {str(i + 1): k for i, k in enumerate(keys)}},
              open(out_path, "w"), indent=1)
    return len(keys)


def judge_record(judged_path, export_path, answers_path):
    """Merge an agent's answers ({"1": "P", ...}) for an export into the recorded judged file."""
    exp, ans = json.load(open(export_path)), json.load(open(answers_path))
    cur = {}
    try:
        cur = json.load(open(judged_path)).get("answers", {})
    except FileNotFoundError:
        pass
    n = 0
    for num, key in exp["keys"].items():
        label = ans.get(num)
        if label not in ("P", "R"):
            raise ExtractError(f"answers {answers_path}: line {num} has no P or R answer")
        cur[key] = {"label": label, "text": exp["lines"][num][:160]}
        n += 1
    json.dump({"version": 1, "note": "recorded model answers for prompt-lint --judged; keys are sha1 of the sentence", "answers": cur}, open(judged_path, "w"), indent=1, sort_keys=True)
    return n


# ----------------------------------------------------------------------------------------
# Keeps, config, running
# ----------------------------------------------------------------------------------------

MARKER = re.compile(r"prompt-lint:\s*keep\b[ \t]*(.*)")
COMMENT_ONLY = re.compile(r"^\s*(?://|#|/\*|\*|<!--)")


def marker_for(raw_lines, line, in_prompt=frozenset()):
    """(found, reason) for a marker on `line` or on a comment-only line just above it.
    A marker that is part of the prompt text itself (`in_prompt`: its lines) is prompt text, not a comment."""
    for ln in (line, line - 1):
        if ln in in_prompt:
            continue
        if 1 <= ln <= len(raw_lines):
            text = raw_lines[ln - 1]
            if ln == line - 1 and not COMMENT_ONLY.match(text):
                continue
            m = MARKER.search(text)
            if m:
                reason = re.sub(r"(?:\*/|-->)\s*$", "", m.group(1)).strip()
                return True, reason
    return False, ""


class Hit:
    def __init__(self, path, line, flag, reason, snippet):
        self.path, self.line, self.flag, self.reason, self.snippet = path, line, flag, reason, snippet
        self.kept = None  # reason when kept

    def fmt(self, tag=""):
        return f"{self.path}:{self.line}: {self.flag}: {self.reason} | {self.snippet!r}{tag}"


def lint_file(path, src, symbol=None, calls=None, fenced=False, allow=frozenset(), budget=None, keeps=(), root_rel=None, judged=None, unjudged=None):
    """-> (hits, size, errors). `keeps`: config keep entries for this file (each gets 'used' set)."""
    shown = root_rel or path
    units = extract(path, src, symbol, calls, fenced)
    if not units or not any(u.text.strip() for u in units):
        raise ExtractError(f"{path}: no prompt text found" + (f" in {symbol!r}" if symbol else "") + " (a rename would otherwise pass silently)")
    raw_lines = src.split("\n")
    in_prompt = {u.line_at(m.start()) for u in units for m in MARKER.finditer(u.text)}
    size = sum(u.size() for u in units)
    hits, errors = [], []
    seen = set()
    for u in units:
        found = list(lint_unit(u, allow))
        if judged is not None:
            for k, sent, line, lo, hi in sentences(u):
                a = judged.get(k)
                if a is None:
                    if unjudged is not None:
                        unjudged[k] = sent
                elif a["label"] == "P":
                    found.append((line, "judged", "a model judged this sentence to name specific cases (recorded answer): state the general rule instead", sent[:90], lo))
                else:   # a recorded R is the model's read of this sentence: it overrules the heuristic flags on it (not the budget)
                    found = [f for f in found if not lo <= f[4] < hi]
        for line, flag, reason, snip, _ in found:
            key = (line, flag, snip)
            if key in seen:
                continue
            seen.add(key)
            h = Hit(shown, line, flag, reason, snip)
            found, why = marker_for(raw_lines, line, in_prompt)
            if found:
                if why:
                    h.kept = why
                else:
                    errors.append(f"{shown}:{line}: `prompt-lint: keep` needs a reason after it")
            if h.kept is None:
                src_line = raw_lines[line - 1] if 0 < line <= len(raw_lines) else ""
                ext_line = "".join(c for c, l in zip(u.text, u.lines) if l == line)
                for k in keeps:
                    if k["match"] in src_line or k["match"] in ext_line:
                        k["used"] = True
                        h.kept = k["reason"]
                        break
            hits.append(h)
    if budget is not None and size > budget:
        first = units[0].first_line()
        hits.append(Hit(shown, first, "budget", f"the prompt is {size} characters, over its budget of {budget}: shorten it, or raise the budget in a commit that says why", ""))
    return hits, size, errors


def load_config(path):
    try:
        cfg = json.load(open(path))
    except (OSError, ValueError) as e:
        raise ExtractError(f"cannot read config {path}: {e}")
    errs = []
    for i, p in enumerate(cfg.get("prompts", [])):
        if not p.get("file"):
            errs.append(f"prompts[{i}]: file is required")
        if not isinstance(p.get("budget"), int) or p["budget"] <= 0:
            errs.append(f"prompts[{i}] ({p.get('file')}:{p.get('symbol', '')}): budget (characters) is required")
        if not str(p.get("why", "")).strip():
            errs.append(f"prompts[{i}] ({p.get('file')}:{p.get('symbol', '')}): why is required (what this prompt is, and why that budget)")
    for i, k in enumerate(cfg.get("keep", [])):
        if not k.get("file") or not k.get("match"):
            errs.append(f"keep[{i}]: file and match are required")
        if not str(k.get("reason", "")).strip():
            errs.append(f"keep[{i}] ({k.get('file')}, {k.get('match')!r}): reason is required")
    if errs:
        raise ExtractError("config: " + "; ".join(errs))
    return cfg


def run_config(cfg_path, root=None, sizes=False, out=sys.stdout, judged_path=None, export_path=None):
    cfg = load_config(cfg_path)
    root = root or os.path.dirname(os.path.abspath(cfg_path))
    judged_path = judged_path or (os.path.join(root, cfg["judged"]) if cfg.get("judged") else None)
    judged = load_judged(judged_path) if judged_path else None
    unjudged = {}
    base_allow = set(cfg.get("allow", []))
    keeps = [dict(k) for k in cfg.get("keep", [])]
    failing, advisory, kept, errors, lines = [], [], 0, [], []
    for p in cfg.get("prompts", []):
        path = os.path.join(root, p["file"])
        mine = [k for k in keeps if k["file"] == p["file"]]
        name = p["file"] + (":" + p["symbol"] if p.get("symbol") else "")
        try:
            try:
                src = open(path, encoding="utf-8").read()
            except OSError as e:
                raise ExtractError(f"cannot read {p['file']}: {e}")
            hits, size, errs = lint_file(path, src, p.get("symbol"), p.get("calls"), bool(p.get("fenced")),
                                         frozenset(base_allow | set(p.get("allow", []))), p["budget"], mine, p["file"],
                                         judged=None if p.get("advisory") and judged is None else judged, unjudged=unjudged)
        except ExtractError as e:
            if not p.get("advisory"):
                raise
            lines.append(f"  {name}: not checked ({e}); advisory prompt, not failing")
            continue
        errors += errs
        if sizes:
            lines.append(f"  {name}: {size} / {p['budget']} characters")
        for h in hits:
            if h.kept:
                kept += 1
            elif p.get("advisory"):
                advisory.append(h)
            else:
                failing.append(h)
    for k in keeps:
        if not k.get("used"):
            errors.append(f"stale keep: {k['file']} match {k['match']!r} matches no flagged line any more: remove it from the config")
    for l in lines:
        print(l, file=out)
    for h in failing:
        print(h.fmt(), file=out)
    for h in advisory:
        print(h.fmt("  [advisory: not failing]"), file=out)
    for e in errors:
        print(e, file=out)
    note = ""
    if judged is not None:
        note = f", {len(unjudged)} sentences without a recorded judgement" + (" (run with --judge-export)" if unjudged else "")
        if export_path and unjudged:
            judge_export(unjudged, export_path)
            note += f", exported to {export_path}"
    print(f"prompt-lint: {len(cfg.get('prompts', []))} prompts, {len(failing)} hits, {kept} kept, {len(advisory)} advisory, {len(errors)} errors{note}", file=sys.stderr)
    return 1 if failing or errors else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("targets", nargs="*", help="FILE or FILE:SYMBOL")
    ap.add_argument("--config", help="prompt-lint.json (paths in it are relative to its directory, or --root)")
    ap.add_argument("--root", help="directory the config's file paths resolve against")
    ap.add_argument("--allow", action="append", default=[], help="a proper noun that is fine (ad hoc runs)")
    ap.add_argument("--budget", type=int, help="max characters per target (ad hoc runs)")
    ap.add_argument("--calls", action="append", default=[], help="python: only the arguments of this call, e.g. out.append")
    ap.add_argument("--fenced", action="store_true", help="markdown: only the text inside ``` fences")
    ap.add_argument("--sizes", action="store_true", help="print every prompt's size against its budget")
    ap.add_argument("--judged", help="recorded model answers (JSON); sentences answered P are reported as `judged` hits")
    ap.add_argument("--judge-export", metavar="OUT", help="write the sentences that have no recorded answer, with the judging prompt, for an agent to answer")
    ap.add_argument("--judge-record", nargs=2, metavar=("EXPORT", "ANSWERS"), help="merge an agent's answers ({\"1\": \"P\", ...}) for an export into the --judged file")
    a = ap.parse_args(argv)
    try:
        if a.judge_record:
            if not a.judged:
                ap.error("--judge-record needs --judged FILE (the file to merge into)")
            print(f"recorded {judge_record(a.judged, *a.judge_record)} answers in {a.judged}")
            return 0
        if a.config:
            return run_config(a.config, a.root, a.sizes, judged_path=a.judged, export_path=a.judge_export)
        if not a.targets:
            ap.error("give --config, or one or more FILE[:SYMBOL]")
        rc = 0
        unjudged = {}   # accumulated across every target, written once after the loop
        for t in a.targets:
            path, _, sym = t.partition(":")
            src = open(path, encoding="utf-8").read()
            hits, size, errs = lint_file(path, src, sym or None, a.calls or None, a.fenced, frozenset(a.allow), a.budget,
                                         judged=load_judged(a.judged) if a.judged else None, unjudged=unjudged)
            if a.sizes:
                print(f"  {t}: {size} characters")
            for h in hits:
                print(h.fmt("  [kept: " + h.kept + "]" if h.kept else ""))
                if not h.kept:
                    rc = 1
            for e in errs:
                print(e)
                rc = 1
        if a.judge_export and unjudged:
            print(f"exported {judge_export(unjudged, a.judge_export)} unjudged sentences to {a.judge_export}", file=sys.stderr)
        return rc
    except (ExtractError, OSError) as e:
        print(f"prompt-lint: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
