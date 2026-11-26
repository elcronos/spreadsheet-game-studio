"""Optional global keyboard capture with pynput (Windows / macOS / X11).

Enabled with ``--global-keys``. Keys are mapped to KeyboardEvent.code names
and then to game actions through the hello's ``keyBindings`` (or the default
table in layout.DEFAULT_KEY_BINDINGS). Captures keys system-wide while the
bridge runs, so only enable it while playing. macOS needs the terminal to be
granted Accessibility / Input Monitoring permission.

The in-Excel alternative is renderers/excel/vba/SGSInput.bas
(Application.OnKey -> hidden INPUT sheet, polled by the bridge).
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from .layout import DEFAULT_KEY_BINDINGS

log = logging.getLogger("sgs_bridge.keys")

SPECIAL = {
    "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "space": "Space",
    "shift": "ShiftLeft", "shift_l": "ShiftLeft", "shift_r": "ShiftRight", "enter": "Enter", "esc": "Escape",
    "tab": "Tab", "ctrl": "ControlLeft", "ctrl_l": "ControlLeft", "ctrl_r": "ControlRight", "alt": "AltLeft",
}


def key_to_code(key: Any) -> Optional[str]:
    """pynput Key/KeyCode -> KeyboardEvent.code ('KeyW', 'ArrowUp', 'Space', ...)."""
    ch = getattr(key, "char", None)
    if ch:
        c = ch.upper()
        if "A" <= c <= "Z" and len(c) == 1:
            return "Key" + c
        if c.isdigit():
            return "Digit" + c
        if c == " ":
            return "Space"
        return None
    name = getattr(key, "name", None)
    if name:
        if name.startswith("f") and name[1:].isdigit():
            return name.upper()
        return SPECIAL.get(name)
    return None


class KeyMapper:
    """Maps key events to (action, down) with auto-repeat suppression. Pure; unit-tested."""

    def __init__(self, bindings: Optional[Dict[str, str]] = None):
        self.bindings = dict(bindings or DEFAULT_KEY_BINDINGS)
        self.down_codes: set[str] = set()
        self.action_refs: Dict[str, int] = {}

    def event(self, code: Optional[str], down: bool):
        if code is None or code not in self.bindings:
            return None
        action = self.bindings[code]
        if down:
            if code in self.down_codes:
                return None  # auto-repeat
            self.down_codes.add(code)
            self.action_refs[action] = self.action_refs.get(action, 0) + 1
            return (action, True) if self.action_refs[action] == 1 else None
        if code not in self.down_codes:
            return None
        self.down_codes.discard(code)
        self.action_refs[action] = max(0, self.action_refs.get(action, 1) - 1)
        return (action, False) if self.action_refs[action] == 0 else None


def start_global_capture(layout_getter: Callable[[], Any], emit: Callable[[str, bool], Any]):
    """Start a pynput listener thread. Returns the listener (call .stop())."""
    try:
        from pynput import keyboard
    except ImportError as e:  # pragma: no cover - optional dependency
        raise SystemExit("--global-keys needs pynput: pip install pynput") from e

    mapper = KeyMapper()

    def current() -> KeyMapper:
        lay = layout_getter()
        kb = getattr(lay, "key_bindings", None)
        if kb and kb != mapper.bindings:
            mapper.bindings = dict(kb)
        return mapper

    def on_press(key):
        ev = current().event(key_to_code(key), True)
        if ev:
            emit(*ev)

    def on_release(key):
        ev = current().event(key_to_code(key), False)
        if ev:
            emit(*ev)

    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.daemon = True
    listener.start()
    log.info("global key capture on (pynput)")
    return listener
