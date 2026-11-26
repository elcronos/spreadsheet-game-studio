"""Excel sink over COM with pywin32 (Windows only). NATIVE EXCEL UNVERIFIED here.

    pip install pywin32 websockets numpy openpyxl
    python -m sgs_bridge --sink excel-com --workbook C:\\path\\game.xlsx

Attaches to a running Excel (or starts one), finds the workbook if already
open, otherwise opens it (creating it first with openpyxl when missing).
"""
from __future__ import annotations

import os
from typing import Any, Optional

from .excel_base import ComOps, ExcelOps, ExcelSinkBase


class ComSink(ExcelSinkBase):
    name = "excel-com"

    def __init__(self, strategy: str = "auto", workbook: Optional[str] = None, visible: bool = True, app: Any = None, book: Any = None, **opts: Any):
        super().__init__(strategy, workbook, visible, **opts)
        self._app, self._book = app, book  # injectable (tests use a fake COM model)
        self._com_init = False

    def thread_init(self) -> None:
        if self._app is None:
            import pythoncom  # pywin32

            pythoncom.CoInitialize()
            self._com_init = True

    def _connect(self) -> ExcelOps:
        if self._app is not None:
            return ComOps(self._app, self._book)
        import win32com.client as win32  # lazy: Windows only

        try:
            app = win32.GetActiveObject("Excel.Application")
        except Exception:
            app = win32.Dispatch("Excel.Application")
        app.Visible = bool(self.visible)
        book = None
        path = os.path.abspath(self.workbook) if self.workbook else None
        if path:
            for i in range(1, app.Workbooks.Count + 1):
                wb = app.Workbooks(i)
                if os.path.normcase(str(wb.FullName)) == os.path.normcase(path):
                    book = wb
                    break
        if book is None:
            if path and not os.path.exists(path):
                # created lazily by layout() once the hello arrives; start from a blank book now
                book = app.Workbooks.Add()
                book.SaveAs(path, 52 if path.lower().endswith(".xlsm") else 51)
            elif path:
                book = app.Workbooks.Open(path)
            else:
                book = app.Workbooks.Add()
        self._app, self._book = app, book
        return ComOps(app, book)

    def close(self) -> None:
        # Keep Excel and the workbook open for the user; just release COM.
        self.ops = None
        self._app = self._book = None
        if self._com_init:
            try:
                import pythoncom

                pythoncom.CoUninitialize()
            except Exception:
                pass
