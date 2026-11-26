/**
 * A small, safe spreadsheet formula language.
 *
 * Grammar (Excel-compatible subset, so the same text works in a real workbook
 * where the names are defined names):
 *   expr    := compare
 *   compare := sum (( "=" | "<>" | "<" | ">" | "<=" | ">=" ) sum)?
 *   sum     := term (("+" | "-" | "&") term)*
 *   term    := power (("*" | "/") power)*
 *   power   := unary ("^" unary)*
 *   unary   := ("-" | "+") unary | primary
 *   primary := number | "string" | name | name "(" args ")" | "(" expr ")" | TRUE | FALSE
 *
 * There is no property access, no eval, no host functions beyond the
 * whitelist below. Unknown names are compile errors. Results are finite
 * numbers (NaN/Infinity become errors), so an edited formula can never crash
 * the simulation: callers fall back to the last good value.
 */

export type Value = number | string | boolean;

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "name"; v: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

export class FormulaError extends Error {}

const FUNCS: Record<string, { min: number; max: number; f: (...a: number[]) => number }> = {
  MIN: { min: 1, max: 32, f: (...a) => Math.min(...a) },
  MAX: { min: 1, max: 32, f: (...a) => Math.max(...a) },
  ABS: { min: 1, max: 1, f: (a) => Math.abs(a) },
  SQRT: { min: 1, max: 1, f: (a) => (a < 0 ? NaN : Math.sqrt(a)) },
  // Excel rounds half away from zero
  ROUND: { min: 1, max: 2, f: (a, d = 0) => (Math.sign(a) * Math.round(Math.abs(a) * 10 ** d)) / 10 ** d },
  // FLOOR(x[, significance]) / CEILING(x[, significance]); significance defaults to 1 (as FLOOR.MATH)
  FLOOR: { min: 1, max: 2, f: (a, s = 1) => (s === 0 ? 0 : Math.floor(a / s) * s) },
  CEILING: { min: 1, max: 2, f: (a, s = 1) => (s === 0 ? 0 : Math.ceil(a / s) * s) },
  INT: { min: 1, max: 1, f: (a) => Math.floor(a) },
  POWER: { min: 2, max: 2, f: (a, b) => a ** b },
  MOD: { min: 2, max: 2, f: (a, b) => (b === 0 ? NaN : a - b * Math.floor(a / b)) },
  SIN: { min: 1, max: 1, f: Math.sin },
  COS: { min: 1, max: 1, f: Math.cos },
  PI: { min: 0, max: 0, f: () => Math.PI },
  AVERAGE: { min: 1, max: 32, f: (...a) => a.reduce((s, x) => s + x, 0) / a.length },
  SUM: { min: 1, max: 32, f: (...a) => a.reduce((s, x) => s + x, 0) },
  // CLAMP is not an Excel builtin; MEDIAN(lo, x, hi) is the portable equivalent and is also supported.
  MEDIAN: {
    min: 1,
    max: 32,
    f: (...a) => {
      const s = [...a].sort((x, y) => x - y);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
  },
  IF: { min: 2, max: 3, f: (c, a, b = 0) => (c ? a : b) },
  AND: { min: 1, max: 32, f: (...a) => (a.every(Boolean) ? 1 : 0) },
  OR: { min: 1, max: 32, f: (...a) => (a.some(Boolean) ? 1 : 0) },
  NOT: { min: 1, max: 1, f: (a) => (a ? 0 : 1) },
};

export const SUPPORTED_FUNCTIONS = Object.keys(FUNCS);
const MAX_LEN = 400;
const MAX_DEPTH = 40;

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*|<>|<=|>=|[-+*/^(),=<>&])/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new FormulaError(`Unexpected character at ${i + 1}: "${src[i]}"`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

export interface CompiledFormula {
  source: string;
  names: string[];
  evaluate(lookup: (name: string) => number | string | undefined): number;
}

export function compileFormula(source: string, knownNames: (n: string) => boolean): CompiledFormula {
  let src = source.trim();
  if (src.startsWith("=")) src = src.slice(1);
  if (!src) throw new FormulaError("Empty formula");
  if (src.length > MAX_LEN) throw new FormulaError(`Formula longer than ${MAX_LEN} characters`);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const names = new Set<string>();
  const peek = () => toks[p];
  const eat = (t?: string) => {
    const v = toks[p];
    if (t !== undefined && v !== t) throw new FormulaError(`Expected "${t}" but found "${v ?? "end of formula"}"`);
    p++;
    return v;
  };
  const guard = () => {
    if (++depth > MAX_DEPTH) throw new FormulaError("Formula nested too deeply");
  };
  const expr = (): Node => {
    guard();
    let a = sum();
    const op = peek();
    if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      eat();
      a = { k: "bin", op, a, b: sum() };
    }
    depth--;
    return a;
  };
  const sum = (): Node => {
    let a = term();
    while (peek() === "+" || peek() === "-" || peek() === "&") {
      const op = eat();
      a = { k: "bin", op, a, b: term() };
    }
    return a;
  };
  const term = (): Node => {
    let a = power();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      a = { k: "bin", op, a, b: power() };
    }
    return a;
  };
  const power = (): Node => {
    let a = unary();
    while (peek() === "^") {
      eat();
      a = { k: "bin", op: "^", a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (peek() === "-" || peek() === "+") {
      const op = eat();
      guard();
      const n: Node = { k: "un", op, a: unary() };
      depth--;
      return n;
    }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (t === undefined) throw new FormulaError("Formula ends unexpectedly");
    if (t === "(") {
      eat();
      const e = expr();
      eat(")");
      return e;
    }
    if (/^[\d.]/.test(t)) {
      eat();
      return { k: "num", v: parseFloat(t) };
    }
    if (t.startsWith('"')) {
      eat();
      return { k: "str", v: t.slice(1, -1) };
    }
    if (/^[A-Za-z_]/.test(t)) {
      eat();
      const up = t.toUpperCase();
      if (peek() === "(") {
        const f = FUNCS[up];
        if (!f) throw new FormulaError(`Unknown function ${t}(). Supported: ${SUPPORTED_FUNCTIONS.join(", ")}`);
        eat("(");
        const args: Node[] = [];
        if (peek() !== ")") {
          args.push(expr());
          while (peek() === ",") {
            eat();
            args.push(expr());
          }
        }
        eat(")");
        if (args.length < f.min || args.length > f.max) throw new FormulaError(`${up}() takes ${f.min === f.max ? f.min : `${f.min}-${f.max}`} arguments`);
        return { k: "call", fn: up, args };
      }
      if (up === "TRUE") return { k: "num", v: 1 };
      if (up === "FALSE") return { k: "num", v: 0 };
      if (!knownNames(t)) throw new FormulaError(`Unknown name "${t}"`);
      names.add(t);
      return { k: "name", v: t };
    }
    throw new FormulaError(`Unexpected "${t}"`);
  };
  const root = expr();
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p]}"`);

  const ev = (n: Node, look: (name: string) => number | string | undefined): Value => {
    switch (n.k) {
      case "num":
        return n.v;
      case "str":
        return n.v;
      case "name": {
        const v = look(n.v);
        if (typeof v === "string") return v;
        if (v === undefined || !Number.isFinite(v)) throw new FormulaError(`#REF! ${n.v}`);
        return v;
      }
      case "un": {
        const a = num(ev(n.a, look));
        return n.op === "-" ? -a : a;
      }
      case "call": {
        // IF / AND / OR evaluate lazily like Excel, so =IF(x=0, 0, 1/x) is fine
        if (n.fn === "IF") return num(ev(n.args[0], look)) ? ev(n.args[1], look) : n.args[2] ? ev(n.args[2], look) : 0;
        if (n.fn === "AND") {
          for (const a of n.args) if (!num(ev(a, look))) return 0;
          return 1;
        }
        if (n.fn === "OR") {
          for (const a of n.args) if (num(ev(a, look))) return 1;
          return 0;
        }
        return chk(FUNCS[n.fn].f(...n.args.map((x) => num(ev(x, look)))));
      }
      case "bin": {
        const a = ev(n.a, look);
        const b = ev(n.b, look);
        switch (n.op) {
          case "+": return chk(num(a) + num(b));
          case "-": return chk(num(a) - num(b));
          case "*": return chk(num(a) * num(b));
          case "/": {
            const d = num(b);
            if (d === 0) throw new FormulaError("#DIV/0!");
            return chk(num(a) / d);
          }
          case "^": return chk(num(a) ** num(b));
          case "&": return String(a) + String(b);
          case "=": return eq(a, b) ? 1 : 0;
          case "<>": return eq(a, b) ? 0 : 1;
          case "<": return num(a) < num(b) ? 1 : 0;
          case ">": return num(a) > num(b) ? 1 : 0;
          case "<=": return num(a) <= num(b) ? 1 : 0;
          case ">=": return num(a) >= num(b) ? 1 : 0;
        }
      }
    }
    throw new FormulaError("Bad node");
  };
  const eq = (a: Value, b: Value): boolean => (typeof a === "string" || typeof b === "string" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const num = (v: Value): number => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const t = v.trim();
    const f = t === "" ? 0 : Number(t);
    if (!Number.isFinite(f)) throw new FormulaError("#VALUE!");
    return f;
  };
  const chk = (v: number): number => {
    if (!Number.isFinite(v)) throw new FormulaError("#NUM!");
    return v;
  };
  return {
    source,
    names: [...names],
    evaluate(look) {
      const r = num(ev(root, look));
      if (!Number.isFinite(r)) throw new FormulaError("#NUM!");
      return r;
    },
  };
}
