"""Two-way sync of variable/rule cells, run inside the sink worker thread.

Writes are always preceded by a read of the editable cells in the same
worker-thread job, so a user edit made since the last poll is detected (and
sent to the game) instead of being overwritten by stale game state.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .layout import RULES, Layout, display_value, normalise_value
from .protocol import msg_edit, msg_rule
from .sinks.base import Sink
from .state import EchoGuard, same_value


class StateSync:
    def __init__(self, sink: Sink, layout: Layout, guard: Optional[EchoGuard] = None, prime: bool = True):
        """Construct in the sink worker thread right after sink.layout(): ``prime`` reads the
        freshly written cells so their canonical form is the baseline (never an edit)."""
        self.sink = sink
        self.layout = layout
        self.guard = guard or EchoGuard()
        self.rule_values: Dict[str, Any] = {}
        self.edits_sent = 0
        self.rules_sent = 0
        self.suppressed = 0
        self._seed_defaults()
        if prime:
            self.prime()

    def prime(self) -> None:
        raw_vars, raw_rules = self.sink.read_editables()
        for key, raw in raw_vars.items():
            v = self.layout.vars_by_key.get(key)
            if v is not None:
                self.guard.sheet_last["var:" + key] = normalise_value(v, raw)
        for name, (formula, _value) in raw_rules.items():
            if formula is not None:
                self.guard.sheet_last["rule:" + name] = formula

    def _seed_defaults(self) -> None:
        """The sink's layout() wrote defaults; record them so they never look like user edits."""
        for v in self.layout.vars_by_key.values():
            shown = normalise_value(v, display_value(v, v.default))
            self.guard.wrote("var:" + v.key, v.default, shown)
        for r in self.layout.rules:
            self.guard.game_last["rule:" + r.name] = r.formula

    def poll(self) -> List[str]:
        """Read editable cells; return outgoing JSON messages for user edits."""
        raw_vars, raw_rules = self.sink.read_editables()
        out: List[str] = []
        g = self.guard
        for key, raw in raw_vars.items():
            v = self.layout.vars_by_key.get(key)
            if v is None:
                continue
            val = normalise_value(v, raw)
            if g.observe("var:" + key, val):
                if v.read_only:
                    g.hold.pop("var:" + key, None)  # revert on next state push
                    self.suppressed += 1
                    continue
                out.append(msg_edit(key, val))
                self.edits_sent += 1
        for name, (formula, value) in raw_rules.items():
            if formula is None:
                continue
            if g.observe("rule:" + name, formula):
                out.append(msg_rule(name, formula, _json_num(value)))
                self.rules_sent += 1
        return out

    def push(self, values: Dict[str, Any], rules: List[Dict[str, Any]]) -> List[str]:
        """Write game state; returns user edits detected just before writing."""
        out = self.poll()
        g = self.guard
        active = self.sink.active_cell()
        writes = []
        for key, gv in values.items():
            v = self.layout.vars_by_key.get(key)
            if v is None:
                continue
            if active is not None and active == (v.sheet, v.row, 2):
                continue  # never overwrite the cell the user has selected / is editing
            if g.want_write("var:" + key, gv):
                writes.append((v, gv))
        if writes:
            self.sink.write_values(writes)
            for v, gv in writes:
                g.wrote("var:" + v.key, gv, normalise_value(v, display_value(v, gv)))
        rv_writes = []
        f_writes = []
        for r in rules or []:
            rr = self.layout.rules_by_name.get(r.get("name"))
            if rr is None:
                continue
            shown = r.get("error") or r.get("value")
            if not same_value(self.rule_values.get(rr.name, object()), shown):
                rv_writes.append((rr, shown))
            f = r.get("formula")
            if isinstance(f, str) and f and not (active == (RULES, rr.row, 2)) and g.want_write("rule:" + rr.name, f):
                f_writes.append((rr, f))
        if rv_writes:
            self.sink.write_rule_values(rv_writes)
            for rr, shown in rv_writes:
                self.rule_values[rr.name] = shown
        if f_writes:
            back = self.sink.write_rule_formulas(f_writes)
            for rr, f in f_writes:
                g.wrote("rule:" + rr.name, f, back.get(rr.name, f))
        return out


def _json_num(v: Any) -> Any:
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    return v


class InputTracker:
    """INPUT-sheet press counters (VBA OnKey) -> input down/up events.

    Application.OnKey has no key-up, so a key counts as held while presses keep
    arriving (keyboard auto-repeat) and is released ``release_s`` after the
    last press. The default 0.6 s covers the usual 500 ms auto-repeat delay.
    """

    def __init__(self, release_s: float = 0.6):
        self.release_s = release_s
        self.counts: Dict[str, float] = {}
        self.last_press: Dict[str, float] = {}
        self.down: Dict[str, bool] = {}

    def update(self, counts: Optional[Dict[str, float]], now: float) -> List[Tuple[str, bool]]:
        events: List[Tuple[str, bool]] = []
        if counts:
            for action, n in counts.items():
                try:
                    n = float(n or 0)
                except (TypeError, ValueError):
                    continue
                prev = self.counts.get(action)
                self.counts[action] = n
                if prev is None:
                    continue  # first observation: baseline
                if n != prev:
                    self.last_press[action] = now
                    if not self.down.get(action):
                        self.down[action] = True
                        events.append((action, True))
        for action, is_down in list(self.down.items()):
            if is_down and now - self.last_press.get(action, now) >= self.release_s:
                self.down[action] = False
                events.append((action, False))
        return events
