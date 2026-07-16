"""
strategy_compute.py — evaluator for the YAML `compute:` DSL.

CLOSED-FORM strategies declare their math in the strategy catalog YAML
(`strategy-catalog/strategies/<id>.yaml`) under a `compute:` block, instead of a
hand-written calc function. This module evaluates that block in Python; an
identical evaluator (`app/src/strategies/computeDsl.ts`) runs it in the app, so
the math lives in ONE place and never has to be translated by hand.

A `compute:` block:

    compute:
      pool: all                 # base-VMT trip pool (all | commute | recreational | other)
      const: { min_effect: 0.0025, ... }
      row_defaults: { transit_vrh: 0, ... }   # fallbacks for TAZ fields that may be absent
      let:                      # ordered intermediate bindings
        - coverage: "clamp(cov_raw, 0, 1)"
      formula: "-A"             # final expression -> pct_vmt_reduction (negative = reduction)

Scope precedence (later overrides earlier):
    const  <  row_defaults  <  row (imputed TAZ fields)  <  params (user inputs)  <  let bindings

The expression language is intentionally tiny and SAFE — there is no eval(), no
attribute access, no builtins; only arithmetic over the names you place in scope.

Grammar (low -> high precedence):
    or | and | comparison (== != < <= > >=) | + - | * / | unary (- not) | primary
Booleans are numeric (comparisons / and / or / not yield 1.0 or 0.0; truthy iff != 0).
Functions: clamp(x,lo,hi), min(...), max(...), mean(...), abs(x), if(cond,a,b).
"""
from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"""
    \s*(?:
      (?P<num>\d+\.\d+|\.\d+|\d+(?:[eE][+-]?\d+)?|\d+)
    | (?P<op><=|>=|==|!=|[-+*/(),<>])
    | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
    )
""", re.VERBOSE)

_FUNCS = {
    "clamp": lambda x, lo, hi: lo if x < lo else (hi if x > hi else x),
    "min": min,
    "max": max,
    "mean": lambda *a: sum(a) / len(a),
    "abs": abs,
    "if": lambda c, a, b: a if c != 0 else b,
}
_WORD_OPS = {"and", "or", "not"}


def _tokenize(s: str):
    toks, i = [], 0
    while i < len(s):
        m = _TOKEN_RE.match(s, i)
        if not m or m.end() == i:
            if s[i:].strip() == "":
                break
            raise SyntaxError(f"bad token near {s[i:]!r}")
        i = m.end()
        if m.group("num"):
            toks.append(("num", float(m.group("num"))))
        elif m.group("op"):
            toks.append(("op", m.group("op")))
        else:
            nm = m.group("name")
            toks.append(("kw" if nm in _WORD_OPS else "name", nm))
    toks.append(("end", None))
    return toks


class _Parser:
    def __init__(self, toks):
        self.t = toks
        self.p = 0

    def peek(self):
        return self.t[self.p]

    def eat(self, val=None):
        tok = self.t[self.p]
        if val is not None and tok[1] != val:
            raise SyntaxError(f"expected {val!r}, got {tok[1]!r}")
        self.p += 1
        return tok

    def parse(self):
        node = self.p_or()
        if self.peek()[0] != "end":
            raise SyntaxError(f"trailing tokens: {self.t[self.p:]}")
        return node

    def p_or(self):
        node = self.p_and()
        while self.peek() == ("kw", "or"):
            self.eat()
            node = ("or", node, self.p_and())
        return node

    def p_and(self):
        node = self.p_cmp()
        while self.peek() == ("kw", "and"):
            self.eat()
            node = ("and", node, self.p_cmp())
        return node

    def p_cmp(self):
        node = self.p_add()
        while self.peek()[0] == "op" and self.peek()[1] in ("==", "!=", "<", "<=", ">", ">="):
            op = self.eat()[1]
            node = ("cmp", op, node, self.p_add())
        return node

    def p_add(self):
        node = self.p_mul()
        while self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.eat()[1]
            node = ("bin", op, node, self.p_mul())
        return node

    def p_mul(self):
        node = self.p_unary()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/"):
            op = self.eat()[1]
            node = ("bin", op, node, self.p_unary())
        return node

    def p_unary(self):
        if self.peek() == ("op", "-"):
            self.eat()
            return ("neg", self.p_unary())
        if self.peek() == ("kw", "not"):
            self.eat()
            return ("not", self.p_unary())
        return self.p_primary()

    def p_primary(self):
        tok = self.peek()
        if tok[0] == "num":
            self.eat()
            return ("num", tok[1])
        if tok[0] == "op" and tok[1] == "(":
            self.eat("(")
            node = self.p_or()
            self.eat(")")
            return node
        if tok[0] == "name":
            self.eat()
            if self.peek() == ("op", "("):
                self.eat("(")
                args = []
                if self.peek() != ("op", ")"):
                    args.append(self.p_or())
                    while self.peek() == ("op", ","):
                        self.eat(",")
                        args.append(self.p_or())
                self.eat(")")
                return ("call", tok[1], args)
            return ("var", tok[1])
        raise SyntaxError(f"unexpected token {tok!r}")


def _ev(node, scope):
    k = node[0]
    if k == "num":
        return node[1]
    if k == "var":
        if node[1] not in scope:
            raise NameError(f"unknown name {node[1]!r}")
        return float(scope[node[1]])
    if k == "neg":
        return -_ev(node[1], scope)
    if k == "not":
        return 0.0 if _ev(node[1], scope) != 0 else 1.0
    if k == "and":
        return 1.0 if (_ev(node[1], scope) != 0 and _ev(node[2], scope) != 0) else 0.0
    if k == "or":
        return 1.0 if (_ev(node[1], scope) != 0 or _ev(node[2], scope) != 0) else 0.0
    if k == "cmp":
        a, b = _ev(node[2], scope), _ev(node[3], scope)
        op = node[1]
        r = {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]
        return 1.0 if r else 0.0
    if k == "bin":
        a, b = _ev(node[2], scope), _ev(node[3], scope)
        if node[1] == "+":
            return a + b
        if node[1] == "-":
            return a - b
        if node[1] == "*":
            return a * b
        return a / b
    if k == "call":
        fn = _FUNCS.get(node[1])
        if fn is None:
            raise NameError(f"unknown function {node[1]!r}")
        return float(fn(*[_ev(a, scope) for a in node[2]]))
    raise RuntimeError(f"bad node {node!r}")


_CACHE: dict = {}


def evaluate(expr: str, scope: dict) -> float:
    ast = _CACHE.get(expr)
    if ast is None:
        ast = _Parser(_tokenize(expr)).parse()
        _CACHE[expr] = ast
    return float(_ev(ast, scope))


def run_compute(spec: dict, row: dict | None = None, params: dict | None = None) -> float:
    """Evaluate a strategy's `compute` block -> pct_vmt_reduction (negative = reduction)."""
    scope: dict = {}
    scope.update(spec.get("const", {}))
    scope.update(spec.get("row_defaults", {}))
    scope.update(row or {})
    scope.update(params or {})
    for binding in spec.get("let", []):
        (name, expr), = binding.items()
        scope[name] = evaluate(expr, scope)
    return evaluate(spec["formula"], scope)
