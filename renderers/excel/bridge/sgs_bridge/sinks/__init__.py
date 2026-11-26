"""Sink registry. Excel and UNO sinks import their platform modules lazily so the
package (and the mock/snapshot sinks) work on any OS."""
from __future__ import annotations

import importlib
from typing import Any

from .base import ApplyResult, Sink, SinkBusy, SinkError

_SINKS = {
    "mock": ("sgs_bridge.sinks.mock", "MockSink"),
    "snapshot": ("sgs_bridge.sinks.snapshot", "SnapshotSink"),
    "calc-uno": ("sgs_bridge.sinks.uno_calc", "UnoCalcSink"),
    "excel-com": ("sgs_bridge.sinks.excel_com", "ComSink"),
    "excel-xlwings": ("sgs_bridge.sinks.excel_xlwings", "XlwingsSink"),
}
SINK_NAMES = list(_SINKS)


def sink_class(name: str) -> type:
    mod, cls = _SINKS[name]
    return getattr(importlib.import_module(mod), cls)


def create_sink(name: str, **kw: Any) -> Sink:
    if name not in _SINKS:
        raise ValueError(f"unknown sink {name}; choose from {SINK_NAMES}")
    return sink_class(name)(**kw)


__all__ = ["ApplyResult", "Sink", "SinkBusy", "SinkError", "SINK_NAMES", "create_sink", "sink_class"]
