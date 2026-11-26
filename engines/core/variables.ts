/**
 * Editable simulation state exposed to spreadsheets.
 *
 * Games declare variables (grouped by worksheet) and rules (named formulas).
 * Spreadsheet backends render them as rows of cells and send edits back as
 * StatePatches. Every edit is validated; invalid input is rejected with a
 * message and never reaches the simulation.
 */
import { compileFormula, CompiledFormula, FormulaError } from "./formula";

export type VarType = "number" | "int" | "bool" | "enum" | "text";

export interface VariableDef {
  /** Stable key, e.g. "player.health". */
  key: string;
  /** Worksheet the variable lives on, e.g. "PLAYER". */
  sheet: string;
  label: string;
  /** Defined name used in formulas and Excel workbooks, e.g. "AlertLevel". */
  name?: string;
  type: VarType;
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
  /** Simulation-owned value shown for information (e.g. position). Still editable unless readOnly. */
  live?: boolean;
  readOnly?: boolean;
  description?: string;
}

export interface RuleDef {
  /** Defined name, e.g. "PoliceBudget". */
  name: string;
  formula: string;
  min: number;
  max: number;
  description: string;
}

export type StateValue = number | boolean | string;
export type StatePatch = Record<string, StateValue>;
export interface StateSnapshot {
  version: number;
  values: Record<string, StateValue>;
  rules: { name: string; formula: string; value: number; error?: string }[];
}

export interface EditResult {
  ok: boolean;
  value?: StateValue;
  error?: string;
}

export class VariableRegistry {
  readonly defs: VariableDef[] = [];
  private byKey = new Map<string, VariableDef>();
  private byName = new Map<string, VariableDef>();
  private values = new Map<string, StateValue>();
  private rules = new Map<string, { def: RuleDef; compiled?: CompiledFormula; value: number; error?: string }>();
  private ruleOrder: string[] = [];
  version = 0;
  private listeners: ((key: string, v: StateValue, source: string) => void)[] = [];

  define(defs: VariableDef[]): this {
    for (const d of defs) {
      if (this.byKey.has(d.key)) throw new Error(`Duplicate variable ${d.key}`);
      this.defs.push(d);
      this.byKey.set(d.key, d);
      if (d.name) this.byName.set(d.name.toLowerCase(), d);
      this.values.set(d.key, d.default);
    }
    return this;
  }

  defineRules(rules: RuleDef[]): this {
    for (const r of rules) this.rules.set(r.name.toLowerCase(), { def: { ...r }, value: r.min });
    for (const r of rules) {
      const res = this.setRuleFormula(r.name, r.formula);
      if (!res.ok) throw new Error(`Rule ${r.name}: ${res.error}`);
    }
    return this;
  }

  def(key: string): VariableDef | undefined {
    return this.byKey.get(key);
  }

  onChange(fn: (key: string, v: StateValue, source: string) => void): void {
    this.listeners.push(fn);
  }

  get(key: string): StateValue {
    const v = this.values.get(key);
    if (v === undefined) throw new Error(`Unknown variable ${key}`);
    return v;
  }
  num(key: string): number {
    const v = this.get(key);
    return typeof v === "number" ? v : v === true ? 1 : v === false ? 0 : parseFloat(v) || 0;
  }
  bool(key: string): boolean {
    return !!this.get(key);
  }
  str(key: string): string {
    return String(this.get(key));
  }

  /** Simulation-side write (no validation messages, just clamping). Rules are not recomputed here
   * (it runs every step); call recomputeRules() at a cadence that suits the game. */
  setLive(key: string, v: StateValue): void {
    const d = this.byKey.get(key);
    if (!d) throw new Error(`Unknown variable ${key}`);
    const r = this.coerce(d, v);
    if (r.ok && r.value !== this.values.get(key)) {
      this.values.set(key, r.value!);
      this.version++;
    }
  }

  /** User-side edit from a spreadsheet. Validated; returns error text for display. */
  edit(key: string, raw: unknown, source = "sheet"): EditResult {
    const d = this.byKey.get(key);
    if (!d) return { ok: false, error: `Unknown variable ${key}` };
    if (d.readOnly) return { ok: false, error: `${d.label} is read-only` };
    const r = this.coerce(d, raw, true);
    if (!r.ok) return r;
    this.values.set(key, r.value!);
    this.version++;
    this.recomputeRules();
    for (const l of this.listeners) l(key, r.value!, source);
    return r;
  }

  private coerce(d: VariableDef, raw: unknown, strict = false): EditResult {
    switch (d.type) {
      case "number":
      case "int": {
        // strict: "5abc" or "0x5" are errors; currency symbols, thousands separators and a trailing % unit are tolerated
        let n = typeof raw === "number" ? raw : typeof raw === "boolean" ? (raw ? 1 : 0) : (() => {
          const t = String(raw).trim().replace(/^\$/, "").replace(/,/g, "").replace(/\s*%$/, "");
          return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN;
        })();
        if (!Number.isFinite(n)) return { ok: false, error: `${d.label} must be a number` };
        if (d.type === "int") n = Math.round(n);
        if (strict && ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)))
          return { ok: false, error: `${d.label} must be between ${d.min} and ${d.max}` };
        if (d.min !== undefined) n = Math.max(d.min, n);
        if (d.max !== undefined) n = Math.min(d.max, n);
        return { ok: true, value: n };
      }
      case "bool": {
        if (typeof raw === "boolean") return { ok: true, value: raw };
        const s = String(raw).trim().toUpperCase();
        if (["TRUE", "1", "YES", "ON"].includes(s)) return { ok: true, value: true };
        if (["FALSE", "0", "NO", "OFF"].includes(s)) return { ok: true, value: false };
        return { ok: false, error: `${d.label} must be TRUE or FALSE` };
      }
      case "enum": {
        const s = String(raw).trim();
        const hit = d.options?.find((o) => o.toLowerCase() === s.toLowerCase());
        if (!hit) return { ok: false, error: `${d.label} must be one of: ${d.options?.join(", ")}` };
        return { ok: true, value: hit };
      }
      case "text": {
        const s = String(raw).slice(0, 120);
        return { ok: true, value: s };
      }
    }
  }

  // ---- rules ----------------------------------------------------------
  private knownName = (n: string) => this.byName.has(n.toLowerCase()) || this.rules.has(n.toLowerCase());

  private lookup = (n: string): number | string | undefined => {
    const l = n.toLowerCase();
    const v = this.byName.get(l);
    if (v) return v.type === "enum" || v.type === "text" ? this.str(v.key) : this.num(v.key);
    const r = this.rules.get(l);
    return r ? r.value : undefined;
  };

  setRuleFormula(name: string, formula: string): EditResult {
    const r = this.rules.get(name.toLowerCase());
    if (!r) return { ok: false, error: `Unknown rule ${name}` };
    let compiled: CompiledFormula;
    try {
      compiled = compileFormula(formula, this.knownName);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const prev = { compiled: r.compiled, formula: r.def.formula };
    r.compiled = compiled;
    r.def.formula = formula.trim().startsWith("=") ? formula.trim() : "=" + formula.trim();
    const order = this.topo();
    if (!order) {
      r.compiled = prev.compiled;
      r.def.formula = prev.formula;
      return { ok: false, error: "Circular reference between rules" };
    }
    this.ruleOrder = order;
    this.recomputeRules();
    this.version++;
    return { ok: true, value: r.value };
  }

  private topo(): string[] | null {
    const out: string[] = [];
    const state = new Map<string, number>();
    const visit = (n: string): boolean => {
      const s = state.get(n);
      if (s === 2) return true;
      if (s === 1) return false;
      state.set(n, 1);
      const r = this.rules.get(n);
      for (const dep of r?.compiled?.names ?? []) {
        const d = dep.toLowerCase();
        if (this.rules.has(d) && !visit(d)) return false;
      }
      state.set(n, 2);
      out.push(n);
      return true;
    };
    for (const n of this.rules.keys()) if (!visit(n)) return null;
    return out;
  }

  recomputeRules(): void {
    for (const n of this.ruleOrder) {
      const r = this.rules.get(n)!;
      if (!r.compiled) continue;
      try {
        const v = r.compiled.evaluate(this.lookup);
        r.value = Math.max(r.def.min, Math.min(r.def.max, v));
        r.error = undefined;
      } catch (e) {
        // keep last good value; surface the spreadsheet-style error
        r.error = e instanceof FormulaError ? e.message : "#ERROR!";
      }
    }
  }

  rule(name: string): number {
    const r = this.rules.get(name.toLowerCase());
    if (!r) throw new Error(`Unknown rule ${name}`);
    return r.value;
  }

  ruleDefs(): RuleDef[] {
    return [...this.rules.values()].map((r) => r.def);
  }

  snapshot(): StateSnapshot {
    const values: Record<string, StateValue> = {};
    for (const [k, v] of this.values) values[k] = v;
    return {
      version: this.version,
      values,
      rules: [...this.rules.values()].map((r) => ({ name: r.def.name, formula: r.def.formula, value: r.value, error: r.error })),
    };
  }

  sheets(): string[] {
    return [...new Set(this.defs.map((d) => d.sheet))];
  }
}
