Attribute VB_Name = "SGSInput"
' =============================================================================
' Spreadsheet Game Studio - in-Excel keyboard capture for the native bridge
' =============================================================================
' Import: Excel > Alt+F11 > File > Import File... > SGSInput.bas, then save the
' workbook as .xlsm. Run SGS_Start (Alt+F8). F12 toggles capture on/off.
'
' How it works
'   The workbook built by scripts/excel/build_workbook.py (or by the bridge)
'   has a hidden sheet INPUT:
'       A: action   B: press counter   C: last press (Timer)   D: OnKey keys ("|" separated)
'   SGS_Start binds every key in column D with Application.OnKey. Each key
'   press increments the action's counter in column B. The Python bridge polls
'   INPUT!A2:B<n> every ~50 ms and sends {"t":"input","action":..,"down":..}
'   messages to the game.
'
' Limits (Application.OnKey)
'   * There is no key-up event. A key counts as held while presses keep
'     arriving (Windows keyboard auto-repeat, ~30/s after an initial ~500 ms
'     delay) and the bridge releases it --input-release-ms (default 600 ms)
'     after the last press. So a quick tap holds the action for ~0.6 s, and
'     holding a key is "on" for the 500 ms auto-repeat gap - fine for driving,
'     too coarse for precise platforming. Lower the release time only if your
'     auto-repeat delay is shorter (Control Panel > Keyboard).
'   * Shift (or Ctrl/Alt) alone cannot be bound. An action whose key list is
'     "+" is a Shift modifier: Shift+<every other bound key> presses both
'     actions (e.g. Shift+W = up + sprint).
'   * Only one key is reported at a time by Windows auto-repeat: holding W and
'     then also D repeats only D, so W is released after the timeout. Diagonal
'     driving therefore pulses. Use the bridge's --global-keys (pynput, real
'     key-up events) when this matters.
'   * OnKey only fires while Excel is in Ready mode (not while you type in a
'     cell) and it intercepts the bound keys everywhere in Excel: press F12
'     to pause capture before typing letters into cells.
'   * Bound keys are global to the Excel instance while capture is on;
'     SGS_Stop (or closing the workbook) restores them.
' =============================================================================
Option Explicit

Private Const INPUT_SHEET As String = "INPUT"
Private mBound As Collection
Private mActive As Boolean

Public Sub SGS_Start()
    Dim ws As Worksheet
    Dim r As Long, lastRow As Long
    Dim action As String, keyList As String, k As Variant
    Dim shiftAction As String
    Dim keys As Collection, acts As Collection, i As Long

    SGS_Stop
    On Error GoTo NoSheet
    Set ws = ThisWorkbook.Worksheets(INPUT_SHEET)
    On Error GoTo 0

    Set mBound = New Collection
    Set keys = New Collection
    Set acts = New Collection
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        action = CStr(ws.Cells(r, 1).Value)
        keyList = CStr(ws.Cells(r, 4).Value)
        If Len(action) > 0 And Len(keyList) > 0 Then
            For Each k In Split(keyList, "|")
                If k = "+" Then
                    shiftAction = action
                ElseIf Len(k) > 0 Then
                    keys.Add CStr(k)
                    acts.Add action
                End If
            Next k
        End If
    Next r

    For i = 1 To keys.Count
        BindKey keys(i), acts(i)
        If Len(shiftAction) > 0 And Len(keys(i)) > 0 Then
            If Left$(keys(i), 1) <> "+" Then BindKey "+" & keys(i), acts(i) & "," & shiftAction
        End If
    Next i
    Application.OnKey "{F12}", "SGS_Toggle"
    mActive = True
    Application.StatusBar = "SGS keyboard capture ON (F12 toggles) - " & keys.Count & " keys"
    Exit Sub
NoSheet:
    MsgBox "Sheet '" & INPUT_SHEET & "' not found. Build the workbook with scripts/excel/build_workbook.py " & _
           "or start the bridge once so it creates the layout.", vbExclamation, "Spreadsheet Game Studio"
End Sub

Public Sub SGS_Stop()
    Dim k As Variant
    If Not mBound Is Nothing Then
        For Each k In mBound
            On Error Resume Next
            Application.OnKey CStr(k)
            On Error GoTo 0
        Next k
    End If
    Set mBound = Nothing
    mActive = False
    Application.StatusBar = False
End Sub

Public Sub SGS_Toggle()
    If mActive Then
        SGS_Stop
        Application.OnKey "{F12}", "SGS_Toggle"
        Application.StatusBar = "SGS keyboard capture OFF (F12 toggles)"
    Else
        SGS_Start
    End If
End Sub

' Called by OnKey with one or more comma-separated actions.
Public Sub SGS_Press(ByVal actions As String)
    Dim ws As Worksheet, a As Variant, r As Variant
    Set ws = ThisWorkbook.Worksheets(INPUT_SHEET)
    For Each a In Split(actions, ",")
        r = Application.Match(CStr(a), ws.Range("A:A"), 0)
        If Not IsError(r) Then
            ws.Cells(r, 2).Value = ws.Cells(r, 2).Value + 1
            ws.Cells(r, 3).Value = Timer
        End If
    Next a
End Sub

Private Sub BindKey(ByVal key As String, ByVal actions As String)
    ' OnKey accepts a macro call with arguments in single quotes: 'SGS_Press "up"'
    Application.OnKey key, "'SGS_Press """ & actions & """'"
    mBound.Add key
End Sub
