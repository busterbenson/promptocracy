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
import argparse, ast, io, json, os, re, sys, tokenize

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
    """-> (units, toks). toks: (kind, value, offset) for code tokens; kind in id, p, num, str."""
    units, toks = [], []
    i, n, line = 0, len(src), 1
    stack = []  # one entry per open ${: [unit, brace_depth]
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
                stack.append([u, 0])
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
                    u, _ = stack.pop()
                    i, line, closed = read_tpl(i + 1, line, u)
                    if not closed:
                        stack.append([u, 0])
                    prev = ("str", None)
                    continue
                stack[-1][1] -= 1
        toks.append(("p", c, i))
        prev = ("p", c)
        i += 1
    if stack:
        raise ExtractError("unterminated ${ in a template literal")
    return units, toks


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
    lo, hi, scope = 1, src.count("\n") + 1, tree
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
        lo, hi, scope = found.lineno, found.end_lineno, found
    ranges = [(lo, hi)]
    if calls:
        ranges = [(c.lineno, c.end_lineno) for c in ast.walk(scope)
                  if isinstance(c, ast.Call) and dotted(c.func) in calls]
        if not ranges:
            raise ExtractError(f"no call to {calls} found" + (f" inside {symbol!r}" if symbol else ""))
    in_range = lambda row: any(a <= row <= b for a, b in ranges)
    src_lines = src.splitlines(keepends=True)
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
        if not in_range(start[0]):
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


def lint_unit(unit, allow):
    """-> list of (line, flag, reason, snippet)"""
    text, hits = unit.text, []
    add = lambda i, flag, reason, snip: hits.append((unit.line_at(i), flag, reason, " ".join(snip.replace(PUA, "{}").split())[:90]))

    for m in EX_TRIG.finditer(text):
        tail = example_tail(text, m.end())
        flat = tail.replace(PUA, "X")
        items = [x for x in re.split(r",|\bor\b|\band\b|/", re.sub(r'"[^"]*"|“[^”]*”', lambda q: q.group(0).replace(",", ";"), flat)) if x.strip(" \t:;-")]
        quoted = re.search(r'"[^"]+"|“[^”]+”|`[^`]+`', tail)
        word = m.group(0).strip().lower()
        word = word if word.startswith("e.g") else word.rstrip(":.")
        if quoted or len(items) >= 2:
            add(m.start(), "examples", f'"{word}" is followed by a {"quoted case" if quoted else "list of examples"}: state the general rule and keep the cases out of the prompt', text[m.start():m.end() + 60])

    for rx, why in PAST:
        for m in rx.finditer(text):
            add(m.start(), "past", why, text[max(0, m.start() - 20):m.end() + 25])
    for m in USED_TO.finditer(text):
        before = re.findall(r"[A-Za-z']+", text[max(0, m.start() - 24):m.start()])
        if not before or before[-1].lower() not in HABITUAL_SUBJECT:
            continue   # "a tool used to build", "is used to size": not a past habit
        add(m.start(), "past", 'habitual "used to" refers to how things were', text[max(0, m.start() - 20):m.end() + 25])

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


def lint_file(path, src, symbol=None, calls=None, fenced=False, allow=frozenset(), budget=None, keeps=(), root_rel=None):
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
        for line, flag, reason, snip in lint_unit(u, allow):
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


def run_config(cfg_path, root=None, sizes=False, out=sys.stdout):
    cfg = load_config(cfg_path)
    root = root or os.path.dirname(os.path.abspath(cfg_path))
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
                                         frozenset(base_allow | set(p.get("allow", []))), p["budget"], mine, p["file"])
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
    print(f"prompt-lint: {len(cfg.get('prompts', []))} prompts, {len(failing)} hits, {kept} kept, {len(advisory)} advisory, {len(errors)} errors", file=sys.stderr)
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
    a = ap.parse_args(argv)
    try:
        if a.config:
            return run_config(a.config, a.root, a.sizes)
        if not a.targets:
            ap.error("give --config, or one or more FILE[:SYMBOL]")
        rc = 0
        for t in a.targets:
            path, _, sym = t.partition(":")
            src = open(path, encoding="utf-8").read()
            hits, size, errs = lint_file(path, src, sym or None, a.calls or None, a.fenced, frozenset(a.allow), a.budget)
            if a.sizes:
                print(f"  {t}: {size} characters")
            for h in hits:
                print(h.fmt("  [kept: " + h.kept + "]" if h.kept else ""))
                if not h.kept:
                    rc = 1
            for e in errs:
                print(e)
                rc = 1
        return rc
    except (ExtractError, OSError) as e:
        print(f"prompt-lint: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
