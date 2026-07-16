// Evaluator for the YAML `compute:` DSL, the TypeScript twin of
// scripts/strategy_compute.py. Closed-form strategies declare their math in the
// strategy catalog YAML (compiled into catalog.json); this runs it in the app so
// the math lives in ONE place and is never hand-translated. The two evaluators
// are kept byte-identical in behaviour (IEEE-754 doubles, same grammar); a
// golden test (computeDsl.test.ts) pins the app output to the Python engine.
//
// Grammar (low -> high precedence):
//   or | and | comparison (== != < <= > >=) | + - | * / | unary (- not) | primary
// Booleans are numeric (1/0); a value is truthy iff !== 0.
// Functions: clamp(x,lo,hi), min(...), max(...), mean(...), abs(x), if(cond,a,b).
//
// Safe by construction: no eval(), no property access, no host globals, only
// arithmetic over the names placed in `scope`.

export interface ComputeSpec {
  /** Base-VMT trip pool the reduction applies to. */
  pool: "all" | "commute" | "recreational" | "other";
  /** Named constants available to every expression. */
  const?: Record<string, number>;
  /** Fallbacks for TAZ row fields that may be absent from the app's data. */
  row_defaults?: Record<string, number>;
  /** Ordered intermediate bindings, each a single-key { name: expr } map. */
  let?: Record<string, string>[];
  /** Final expression -> pct_vmt_reduction (negative = reduction). */
  formula: string;
}

type Node =
  | ["num", number]
  | ["var", string]
  | ["neg", Node]
  | ["not", Node]
  | ["and", Node, Node]
  | ["or", Node, Node]
  | ["cmp", string, Node, Node]
  | ["bin", string, Node, Node]
  | ["call", string, Node[]];

type Tok = ["num", number] | ["op", string] | ["name", string] | ["kw", string] | ["end", null];

const FUNCS: Record<string, (...a: number[]) => number> = {
  clamp: (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  mean: (...a) => a.reduce((s, v) => s + v, 0) / a.length,
  abs: Math.abs,
  if: (c, a, b) => (c !== 0 ? a : b),
};
const WORD_OPS = new Set(["and", "or", "not"]);

const TOKEN_RE =
  /\s*(?:(\d+\.\d+|\.\d+|\d+(?:[eE][+-]?\d+)?|\d+)|(<=|>=|==|!=|[-+*/(),<>])|([A-Za-z_][A-Za-z0-9_]*))/y;

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(s);
    if (!m || m.index !== i || m[0].length === 0) {
      if (s.slice(i).trim() === "") break;
      throw new SyntaxError(`bad token near ${JSON.stringify(s.slice(i))}`);
    }
    i = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) toks.push(["num", parseFloat(m[1])]);
    else if (m[2] !== undefined) toks.push(["op", m[2]]);
    else toks.push([WORD_OPS.has(m[3]) ? "kw" : "name", m[3]]);
  }
  toks.push(["end", null]);
  return toks;
}

class Parser {
  private t: Tok[];
  private p = 0;
  constructor(toks: Tok[]) {
    this.t = toks;
  }
  private peek(): Tok {
    return this.t[this.p];
  }
  private is(type: string, val?: string): boolean {
    const [a, b] = this.t[this.p];
    return a === type && (val === undefined || b === val);
  }
  private eat(val?: string): Tok {
    const tok = this.t[this.p];
    if (val !== undefined && tok[1] !== val) throw new SyntaxError(`expected ${val}, got ${tok[1]}`);
    this.p++;
    return tok;
  }
  parse(): Node {
    const node = this.pOr();
    if (this.peek()[0] !== "end") throw new SyntaxError("trailing tokens");
    return node;
  }
  private pOr(): Node {
    let n = this.pAnd();
    while (this.is("kw", "or")) {
      this.eat();
      n = ["or", n, this.pAnd()];
    }
    return n;
  }
  private pAnd(): Node {
    let n = this.pCmp();
    while (this.is("kw", "and")) {
      this.eat();
      n = ["and", n, this.pCmp()];
    }
    return n;
  }
  private pCmp(): Node {
    let n = this.pAdd();
    while (this.is("op") && ["==", "!=", "<", "<=", ">", ">="].includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      n = ["cmp", op, n, this.pAdd()];
    }
    return n;
  }
  private pAdd(): Node {
    let n = this.pMul();
    while (this.is("op") && ["+", "-"].includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      n = ["bin", op, n, this.pMul()];
    }
    return n;
  }
  private pMul(): Node {
    let n = this.pUnary();
    while (this.is("op") && ["*", "/"].includes(this.peek()[1] as string)) {
      const op = this.eat()[1] as string;
      n = ["bin", op, n, this.pUnary()];
    }
    return n;
  }
  private pUnary(): Node {
    if (this.is("op", "-")) {
      this.eat();
      return ["neg", this.pUnary()];
    }
    if (this.is("kw", "not")) {
      this.eat();
      return ["not", this.pUnary()];
    }
    return this.pPrimary();
  }
  private pPrimary(): Node {
    const tok = this.peek();
    if (tok[0] === "num") {
      this.eat();
      return ["num", tok[1] as number];
    }
    if (tok[0] === "op" && tok[1] === "(") {
      this.eat("(");
      const n = this.pOr();
      this.eat(")");
      return n;
    }
    if (tok[0] === "name") {
      this.eat();
      if (this.is("op", "(")) {
        this.eat("(");
        const args: Node[] = [];
        if (!this.is("op", ")")) {
          args.push(this.pOr());
          while (this.is("op", ",")) {
            this.eat(",");
            args.push(this.pOr());
          }
        }
        this.eat(")");
        return ["call", tok[1] as string, args];
      }
      return ["var", tok[1] as string];
    }
    throw new SyntaxError(`unexpected token ${JSON.stringify(tok)}`);
  }
}

function ev(node: Node, scope: Record<string, number>): number {
  const k = node[0];
  if (k === "num") return node[1];
  if (k === "var") {
    if (!(node[1] in scope)) throw new Error(`unknown name ${node[1]}`);
    return Number(scope[node[1]]);
  }
  if (k === "neg") return -ev(node[1], scope);
  if (k === "not") return ev(node[1], scope) !== 0 ? 0 : 1;
  if (k === "and") return ev(node[1], scope) !== 0 && ev(node[2], scope) !== 0 ? 1 : 0;
  if (k === "or") return ev(node[1], scope) !== 0 || ev(node[2], scope) !== 0 ? 1 : 0;
  if (k === "cmp") {
    const a = ev(node[2], scope), b = ev(node[3], scope);
    const r = { "==": a === b, "!=": a !== b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b }[
      node[1]
    ];
    return r ? 1 : 0;
  }
  if (k === "bin") {
    const a = ev(node[2], scope), b = ev(node[3], scope);
    if (node[1] === "+") return a + b;
    if (node[1] === "-") return a - b;
    if (node[1] === "*") return a * b;
    return a / b;
  }
  // call
  const fn = FUNCS[node[1]];
  if (!fn) throw new Error(`unknown function ${node[1]}`);
  return Number(fn(...node[2].map((a) => ev(a, scope))));
}

const CACHE = new Map<string, Node>();
export function evaluate(expr: string, scope: Record<string, number>): number {
  let ast = CACHE.get(expr);
  if (!ast) {
    ast = new Parser(tokenize(expr)).parse();
    CACHE.set(expr, ast);
  }
  return Number(ev(ast, scope));
}

/**
 * Evaluate a compute block over (row, params) -> pct_vmt_reduction.
 *
 * `constOverrides` (optional) replaces entries in `spec.const` before the scope
 * is assembled, so a caller (project-context "constant override") can substitute
 * a methodology constant — e.g. tmo_coverage's `r_ctr`, the bike `bike_len`, a
 * TOD ceiling — with a project-specific value. Overrides win over `spec.const`
 * but are still shadowed by row/param values that share the name (matching the
 * spread order below), so a const override only takes effect for names that are
 * genuinely spec constants (as computeStrategyRows guarantees by partitioning).
 * Omitting the arg (or passing an empty/undefined map) is byte-for-byte the
 * pre-override behavior.
 */
export function runCompute(
  spec: ComputeSpec,
  row: Record<string, number>,
  params: Record<string, number>,
  constOverrides?: Record<string, number>,
): number {
  const consts =
    constOverrides && Object.keys(constOverrides).length > 0
      ? { ...(spec.const ?? {}), ...constOverrides }
      : (spec.const ?? {});
  const scope: Record<string, number> = {
    ...consts,
    ...(spec.row_defaults ?? {}),
    ...row,
    ...params,
  };
  for (const binding of spec.let ?? []) {
    const [name, expr] = Object.entries(binding)[0];
    scope[name] = evaluate(expr, scope);
  }
  return evaluate(spec.formula, scope);
}
