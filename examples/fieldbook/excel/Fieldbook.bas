Attribute VB_Name = "Fieldbook"
' =============================================================================
' FIELDBOOK for Excel - a real-time farming game drawn in spreadsheet cells
' Part of Spreadsheet Game Studio (MIT). https://github.com/elcronos/spreadsheet-game-studio
' =============================================================================
' Setup (once): open Fieldbook.xlsx, press Alt+F11 (Mac: Tools > Macro > Visual
' Basic Editor), File > Import File... > Fieldbook.bas, close the editor, then
' File > Save As > "Excel Macro-Enabled Workbook (*.xlsm)". Press Alt+F8 (Mac:
' Tools > Macro > Macros), pick FB_Play, Run. After the first run there is a
' Play / Pause button on the sheet, and F12 toggles play.
'
' Keys: WASD or arrows walk, E or Space use the tool / stall / crate / shed /
' well / board, Q cycles the tool, 1-4 pick seeds, R sleeps on the doorstep,
' Esc or F12 pauses. While paused you can edit any sheet: FARMER, FARM, MARKET
' hold the game's variables and RULES holds the price formulas.
'
' How it draws: every cell of the canvas is one pixel. Each frame the game
' composes the picture in memory (background, soil, crops, hens, farmer, rain)
' and only repaints the cells whose colour changed. Night and lamp glow are
' translucent shapes over the canvas.
'
' The art comes from the browser edition's renderer (hidden sheet _ASSETS);
' the rules mirror examples/fieldbook/sim.ts.
' =============================================================================
Option Explicit

'@@PLATFORM_BEGIN
#If Mac Then
Private Function KeyIsDown(ByVal vk As Long) As Boolean
    KeyIsDown = False
End Function
Private Function ExcelHasFocus() As Boolean
    ExcelHasFocus = True
End Function
Private Function OnMac() As Boolean
    OnMac = True
End Function
#Else
#If VBA7 Then
Private Declare PtrSafe Function GetAsyncKeyState Lib "user32" (ByVal vKey As Long) As Integer
Private Declare PtrSafe Function GetForegroundWindow Lib "user32" () As LongPtr
#Else
Private Declare Function GetAsyncKeyState Lib "user32" (ByVal vKey As Long) As Integer
Private Declare Function GetForegroundWindow Lib "user32" () As Long
#End If
Private Function KeyIsDown(ByVal vk As Long) As Boolean
    KeyIsDown = (GetAsyncKeyState(vk) And &H8000) <> 0
End Function
Private Function ExcelHasFocus() As Boolean
    On Error Resume Next
    Dim fg As Variant, hw As Variant
    fg = GetForegroundWindow()
    ExcelHasFocus = True
    hw = Application.ActiveWindow.Hwnd
    If Err.Number <> 0 Then Err.Clear: hw = Application.Hwnd
    If CDbl(fg) <> CDbl(hw) And CDbl(fg) <> CDbl(Application.Hwnd) Then ExcelHasFocus = False
End Function
Private Function OnMac() As Boolean
    OnMac = False
End Function
#End If
'@@PLATFORM_END

' ---- layout ------------------------------------------------------------------
Private Const GAME_SHEET As String = "FIELDBOOK"
Private Const W As Long = 256          ' canvas pixels across (32 tiles of 8)
Private Const H As Long = 184          ' 22 tiles + 8 rows of tree canopy above
Private Const TOPPX As Long = 8
Private Const CR0 As Long = 8          ' first canvas row on the sheet
Private Const CC0 As Long = 1          ' first canvas column
Private Const MAPC As Long = 32
Private Const MAPR As Long = 22
' field, pen, coop, spawn and bed tiles mirror examples/fieldbook/map.ts
Private Const FLD_X As Long = 3, FLD_Y As Long = 8, FLD_W As Long = 9, FLD_H As Long = 5
Private Const PEN_X As Long = 25, PEN_Y As Long = 9, PEN_W As Long = 5, PEN_H As Long = 5
Private Const COOP_X As Long = 28, COOP_Y As Long = 9, COOP_W As Long = 2, COOP_H As Long = 2
Private Const SPAWN_TX As Long = 4, SPAWN_TY As Long = 5
Private Const DAY_START As Double = 6
Private Const PASS_OUT As Double = 26

' actions
Private Const A_UP As Long = 0, A_DOWN As Long = 1, A_LEFT As Long = 2, A_RIGHT As Long = 3
Private Const A_USE As Long = 4, A_TOOL As Long = 5, A_SLEEP As Long = 6
Private Const A_SEED1 As Long = 7, A_PAUSE As Long = 11, A_N As Long = 12

' ---- types -------------------------------------------------------------------
Private Type TPlot
    tilled As Boolean
    watered As Boolean
    crop As Long          ' -1 none, 0 carrot, 1 tomato, 2 pumpkin, 3 cabbage
    growth As Double
    dry As Long
    withered As Boolean
    harvests As Long
End Type
Private Type TChicken
    hx As Double
    hy As Double
    goalX As Double
    goalY As Double
    flipped As Boolean
    idleT As Double
    pecking As Boolean
    anim As Double
End Type
Private Type TOrder
    id As Long
    item As Long          ' 0..3 crops, 4 egg
    qty As Long
    delivered As Long
    due As Long
    reward As Long
    status As Long        ' 0 open, 1 done, 2 late
End Type
Private Type TPart
    x As Double
    y As Double
    vx As Double
    vy As Double
    life As Double
    col As Long
    grav As Double
    floorY As Double
End Type

' ---- assets ------------------------------------------------------------------
Private gA As Variant                 ' _ASSETS A:C
Private gAN As Long
Private gPal() As Long                ' palette, BGR
Private gCv(0 To 255) As Long         ' code char -> 0..63
Private gBg() As Long                 ' current season background (W*H)
Private gObjSortY() As Long, gObjX() As Long, gObjY() As Long, gObjW() As Long, gObjH() As Long, gObjOff() As Long
Private gObjN As Long
Private gSprW() As Long, gSprH() As Long, gSprOff() As Long
Private gSprN As Long
Private gSprPx() As Long, gSprPxN As Long
Private gObjPx() As Long
Private gSoil() As Long               ' 6 layers of field pixels
Private gFW As Long, gFH As Long, gFX As Long, gFY As Long
Private gTile(0 To MAPC - 1, 0 To MAPR - 1) As Long   ' 0 walk, 1 solid, 2 water
Private gProp(0 To MAPC - 1, 0 To MAPR - 1) As String
Private gAmbH() As Double, gAmbC() As Long, gAmbA() As Double, gAmbN As Long
Private gLightX() As Double, gLightY() As Double, gLightR() As Double, gLightC() As Long, gLightN As Long
Private gSFarmer(0 To 3, 0 To 4) As Long
Private gSHen(0 To 1, 0 To 2) As Long
Private gSEgg As Long
Private gSCrop(0 To 3, 0 To 3, 0 To 1) As Long
Private gSHoe(0 To 1) As Long, gSCan(0 To 1) As Long, gSBag(0 To 3) As Long
Private cCream As Long, cShadow As Long, cWaterLight As Long, cGoldLight As Long, cWhite As Long, cRain As Long

' ---- variables (cells are the truth) ------------------------------------------
Private gVName() As String
Private gVSheet() As String
Private gVRow() As Long
Private gVVal() As Variant
Private gVCell() As Variant           ' what the cell held when last read or written
Private gVDef() As Variant
Private gVLive() As Boolean
Private gVN As Long
Private gRName() As String, gRRow() As Long, gRN As Long
Private vCash As Long, vStamina As Long, vMaxStamina As Long, vToolStamina As Long, vWalk As Long
Private vCanCap As Long, vCanWater As Long, vCanLevel As Long
Private vSeeds(0 To 3) As Long, vBasket(0 To 4) As Long
Private vDay As Long, vHour As Long, vSeason As Long, vSeasonLen As Long, vDayLen As Long, vGrowth As Long
Private vRainChance As Long, vWeather As Long, vDrought As Long, vChickens As Long, vEggChance As Long
Private vBase(0 To 4) As Long, vSeedCost(0 To 3) As Long, vRecovery As Long, vSold(0 To 4) As Long
Private rPrice(0 To 4) As Long, rUpgradeCost As Long, rUpgradeSize As Long, rSleepRestore As Long

' ---- game state ---------------------------------------------------------------
Private gPlot(0 To FLD_W * FLD_H - 1) As TPlot
Private gHen() As TChicken, gHenN As Long
Private gEggX(0 To 15) As Long, gEggY(0 To 15) As Long, gEggN As Long
Private gOrd(0 To 19) As TOrder, gOrdN As Long, gNextOrder As Long
Private gPart(0 To 79) As TPart
Private fX As Double, fY As Double, fDir As Long, fMoving As Boolean, fWalkT As Double
Private fTool As Long, fSeed As Long, fActT As Double, fAct As Long, fActTx As Long, fActTy As Long
Private gTime As Double, gBanner As String, gBannerT As Double, gHint As String, gFade As Double
Private gSeasonIdx As Long, gLoadedSeason As Long, gRaining As Boolean
Private gLastHourWrite As Double, gOrdersDirty As Boolean

' ---- rendering / runtime ------------------------------------------------------
Private gFrame() As Long, gShown() As Long
Private gWS As Object
Private gInit As Boolean, gRunning As Boolean, gTest As Boolean
Private gDown(0 To A_N - 1) As Boolean, gPrev(0 To A_N - 1) As Boolean
Private gMacHold(0 To A_N - 1) As Double, gMacPress(0 To A_N - 1) As Long
Private gLastT As Double, gWrites As Long, gAmbIdx As Long, gLastHud As String
Private gHudTool As String, gHudHint As String, gHudStatus As String
Private gStage As String, gDbg As String
Private gCellW As Double, gCellH As Double, gCanvasL As Double, gCanvasT As Double

Private Const SEASON_NAMES As String = "Spring,Summer,Autumn,Winter"
Private Const ITEM_NAMES As String = "Carrot,Tomato,Pumpkin,Cabbage,Egg"
Private Const TOOL_NAMES As String = "HOE,CAN,SEEDS"

' =============================================================================
' Public entry points
' =============================================================================
Public Sub FB_Play()
    If gRunning Then Exit Sub
    On Error GoTo Fail
    If Not gInit Then InitAll
    Set gWS = ThisWorkbook.Worksheets(GAME_SHEET)
    If Not ActiveSheet Is gWS Then gWS.Activate
    Application.Calculation = -4105   ' xlCalculationAutomatic
    gRunning = True
    ClearInput
    UnbindPauseKey
    If OnMac() Then
        BindMacKeys
    Else
        SwallowKeys True
    End If
    SetStatus "PLAYING  -  Esc or F12 pauses"
    SetButton True
    gLastT = Timer
    If OnMac() Then
        Application.OnTime Now, "FB_TickMac"
    Else
        RunLoopWin
    End If
    Exit Sub
Fail:
    gRunning = False
    SetStatus "Error " & Err.Number & ": " & Err.Description
End Sub

Public Sub FB_Pause()
    If Not gRunning Then Exit Sub
    gRunning = False
    On Error Resume Next
    If OnMac() Then
        UnbindMacKeys
    Else
        SwallowKeys False
    End If
    Application.EnableCancelKey = 1   ' xlInterrupt
    SaveState
    SetStatus "PAUSED  -  edit any sheet, then press Play or F12"
    SetButton False
    BindPauseKey
End Sub

Public Sub FB_Toggle()
    If gRunning Then
        FB_Pause
    Else
        FB_Play
    End If
End Sub

Public Sub FB_NewGame()
    Dim wasRunning As Boolean: wasRunning = gRunning
    If gRunning Then FB_Pause
    If Not gInit Then InitAll
    ResetGame
    Render
    SaveState
    SetStatus "NEW GAME  -  press Play"
    If wasRunning Then FB_Play
End Sub

' Repaint every canvas cell (if something else coloured the canvas).
Public Sub FB_Repaint()
    If Not gInit Then InitAll
    Dim i As Long
    For i = 0 To W * H - 1: gShown(i) = -2: Next
    Render
End Sub

' =============================================================================
' Main loops
' =============================================================================
Private Sub RunLoopWin()
    On Error GoTo Fail
    Dim t As Double, dt As Double, t0 As Double
    Application.EnableCancelKey = 2   ' xlErrorHandler: Esc / Ctrl+Break pause instead of breaking into the code
    Do While gRunning
        t0 = Timer
        dt = t0 - gLastT
        If dt < 0 Then dt = dt + 86400
        If dt > 0.1 Then dt = 0.1
        gLastT = t0
        If Not ActiveSheet Is gWS Then Call FB_Pause: Exit Do
        PollInputWin
        If gDown(A_PAUSE) And Not gPrev(A_PAUSE) Then Call FB_Pause: Exit Do
        Tick dt
        Render
        Do
            DoEvents
            t = Timer - t0
            If t < 0 Then t = t + 86400
        Loop While t < 1 / 30 And gRunning
    Loop
    Exit Sub
Fail:
    If Err.Number = 18 Then          ' the cancel key: a normal pause
        gRunning = True
        FB_Pause
        Exit Sub
    End If
    gRunning = False
    SwallowKeys False
    Application.EnableCancelKey = 1
    SetStatus "Paused by an error " & Err.Number & ": " & Err.Description & " [" & gStage & "] (press Play to continue)"
    SetButton False
    BindPauseKey
End Sub

Public Sub FB_TickMac()
    If Not gRunning Then Exit Sub
    On Error GoTo Fail
    Dim t0 As Double, dt As Double
    t0 = Timer
    dt = t0 - gLastT
    If dt < 0 Then dt = dt + 86400
    If dt > 0.15 Then dt = 0.15
    gLastT = t0
    If Not ActiveSheet Is gWS Then Call FB_Pause: Exit Sub
    PollInputMac
    If gDown(A_PAUSE) And Not gPrev(A_PAUSE) Then Call FB_Pause: Exit Sub
    Tick dt
    Render
    If gRunning Then Application.OnTime Now, "FB_TickMac"
    Exit Sub
Fail:
    gRunning = False
    SetStatus "Paused by an error " & Err.Number & ": " & Err.Description
    SetButton False
End Sub

' =============================================================================
' Input
' =============================================================================
Private Sub ClearInput()
    Dim i As Long
    For i = 0 To A_N - 1
        gDown(i) = False: gPrev(i) = False: gMacHold(i) = 0: gMacPress(i) = 0
    Next
End Sub

Private Sub PollInputWin()
    Dim i As Long
    For i = 0 To A_N - 1: gPrev(i) = gDown(i): gDown(i) = False: Next
    If Not ExcelHasFocus() Then Exit Sub
    gDown(A_UP) = KeyIsDown(87) Or KeyIsDown(38)
    gDown(A_DOWN) = KeyIsDown(83) Or KeyIsDown(40)
    gDown(A_LEFT) = KeyIsDown(65) Or KeyIsDown(37)
    gDown(A_RIGHT) = KeyIsDown(68) Or KeyIsDown(39)
    gDown(A_USE) = KeyIsDown(69) Or KeyIsDown(32)
    gDown(A_TOOL) = KeyIsDown(81)
    gDown(A_SLEEP) = KeyIsDown(82)
    For i = 0 To 3: gDown(A_SEED1 + i) = KeyIsDown(49 + i): Next
    gDown(A_PAUSE) = KeyIsDown(27) Or KeyIsDown(123)
End Sub

' Mac: Application.OnKey has no key-up, so a key counts as held for a short time after each press.
Private Sub PollInputMac()
    Dim i As Long, now_ As Double
    now_ = Timer
    For i = 0 To A_N - 1
        gPrev(i) = gDown(i)
        If gMacPress(i) > 0 Then
            gDown(i) = True
            If gPrev(i) And i >= A_USE Then gPrev(i) = False   ' every press of a one-shot key counts
            gMacPress(i) = 0
        Else
            gDown(i) = (now_ < gMacHold(i)) And i <= A_RIGHT
        End If
    Next
End Sub

Private Sub MacKey(ByVal a As Long)
    gMacPress(a) = gMacPress(a) + 1
    gMacHold(a) = Timer + 0.32
End Sub
Public Sub FB_Kup(): MacKey A_UP: End Sub
Public Sub FB_Kdown(): MacKey A_DOWN: End Sub
Public Sub FB_Kleft(): MacKey A_LEFT: End Sub
Public Sub FB_Kright(): MacKey A_RIGHT: End Sub
Public Sub FB_Kuse(): MacKey A_USE: End Sub
Public Sub FB_Ktool(): MacKey A_TOOL: End Sub
Public Sub FB_Ksleep(): MacKey A_SLEEP: End Sub
Public Sub FB_Kseed1(): MacKey A_SEED1: End Sub
Public Sub FB_Kseed2(): MacKey A_SEED1 + 1: End Sub
Public Sub FB_Kseed3(): MacKey A_SEED1 + 2: End Sub
Public Sub FB_Kseed4(): MacKey A_SEED1 + 3: End Sub
Public Sub FB_Kpause(): MacKey A_PAUSE: End Sub

Private Sub BindMacKeys()
    On Error Resume Next
    Dim k As Variant, m As Variant, i As Long
    k = Array("w", "{UP}", "s", "{DOWN}", "a", "{LEFT}", "d", "{RIGHT}", "e", " ", "q", "r", "1", "2", "3", "4", "{ESC}", "{F12}")
    m = Array("FB_Kup", "FB_Kup", "FB_Kdown", "FB_Kdown", "FB_Kleft", "FB_Kleft", "FB_Kright", "FB_Kright", "FB_Kuse", "FB_Kuse", "FB_Ktool", "FB_Ksleep", "FB_Kseed1", "FB_Kseed2", "FB_Kseed3", "FB_Kseed4", "FB_Kpause", "FB_Kpause")
    For i = 0 To UBound(k): Application.OnKey k(i), m(i): Next
End Sub

Private Sub UnbindMacKeys()
    On Error Resume Next
    Dim k As Variant, i As Long
    k = Array("w", "{UP}", "s", "{DOWN}", "a", "{LEFT}", "d", "{RIGHT}", "e", " ", "q", "r", "1", "2", "3", "4", "{ESC}", "{F12}")
    For i = 0 To UBound(k): Application.OnKey k(i): Next
End Sub

Private Sub BindPauseKey()
    On Error Resume Next
    If Not gTest Then Application.OnKey "{F12}", "FB_Toggle"
End Sub
Private Sub UnbindPauseKey()
    On Error Resume Next
    If Not gTest Then Application.OnKey "{F12}"
End Sub

Private Function Pressed(ByVal a As Long) As Boolean
    Pressed = gDown(a) And Not gPrev(a)
End Function

' =============================================================================
' Initialisation
' =============================================================================
Private Sub InitAll()
    Set gWS = ThisWorkbook.Worksheets(GAME_SHEET)
    gStage = "assets"
    LoadAssets
    gStage = "vars"
    LoadVars
    ReDim gFrame(0 To W * H - 1)
    ReDim gShown(0 To W * H - 1)
    gLoadedSeason = -1
    gSeasonIdx = SeasonIndex(VStr(vSeason))
    gStage = "season"
    LoadSeason gSeasonIdx
    gStage = "state"
    If Not LoadState() Then
        ResetGame
    End If
    If Not gTest Then
        SquareCells
        MakeShapes
        FitWindow
    End If
    gAmbIdx = -1
    gInit = True
End Sub

Private Function LastRow(ByVal ws As Object) As Long
    With ws.UsedRange
        LastRow = .Row + .Rows.Count - 1
    End With
End Function

Private Function FindKey(ByVal k As String) As Long
    Dim i As Long
    For i = 1 To gAN
        If gA(i, 1) = k Then FindKey = i: Exit Function
    Next
    FindKey = 0
End Function

Private Sub LoadAssets()
    Dim ws As Object, last As Long, i As Long, j As Long, s As String, parts As Variant
    Set ws = ThisWorkbook.Worksheets("_ASSETS")
    last = LastRow(ws)
    gA = ws.Range("A1:C" & last).Value
    gAN = last
    Dim alpha As String: alpha = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/"
    For i = 1 To 64: gCv(Asc(Mid$(alpha, i, 1))) = i - 1: Next
    gStage = "palette"
    ' palette (stored as BGR longs, ready for Interior.Color)
    parts = Split(CStr(gA(FindKey("palette"), 3)), ",")
    ReDim gPal(0 To UBound(parts))
    For i = 0 To UBound(parts): gPal(i) = CLng(parts(i)): Next
    ' colours
    parts = Split(CStr(gA(FindKey("colors"), 3)), ",")
    cCream = CLng(parts(0)): cShadow = CLng(parts(1)): cWaterLight = CLng(parts(2)): cGoldLight = CLng(parts(3))
    cWhite = RGB(255, 255, 255): cRain = RGB(184, 212, 240)
    gStage = "sprites"
    ' sprites
    ReDim gSprW(0 To 79): ReDim gSprH(0 To 79): ReDim gSprOff(0 To 79)
    gSprN = 0
    ReDim gSprPx(0 To 8191)
    gSprPxN = 0
    Dim d As Variant, nm As Variant
    d = Array("down", "up", "left", "right")
    For i = 0 To 3
        gSFarmer(i, 0) = LoadSprite("farmer_" & d(i) & "_stand")
        For j = 0 To 3: gSFarmer(i, j + 1) = LoadSprite("farmer_" & d(i) & "_walk" & j): Next
    Next
    nm = Array("a", "b", "peck")
    For j = 0 To 2
        gSHen(0, j) = LoadSprite("hen_r_" & nm(j))
        gSHen(1, j) = LoadSprite("hen_l_" & nm(j))
    Next
    gSEgg = LoadSprite("egg")
    Dim crops As Variant: crops = Array("carrot", "tomato", "pumpkin", "cabbage")
    For i = 0 To 3
        For j = 0 To 3
            gSCrop(i, j, 0) = LoadSprite("crop_" & crops(i) & "_" & j)
            gSCrop(i, j, 1) = LoadSprite("crop_" & crops(i) & "_" & j & "_w")
        Next
        gSBag(i) = LoadSprite("bag_" & crops(i))
    Next
    gSHoe(0) = LoadSprite("hoe"): gSHoe(1) = LoadSprite("hoe_l")
    gSCan(0) = LoadSprite("can"): gSCan(1) = LoadSprite("can_l")
    gStage = "soil"
    ' soil layers
    parts = Split(CStr(gA(FindKey("field"), 2)), ",")
    gFX = CLng(parts(0)): gFY = CLng(parts(1)): gFW = CLng(parts(2)): gFH = CLng(parts(3))
    ReDim gSoil(0 To 6 * gFW * gFH - 1)
    Dim names As Variant, L As Long, r0 As Long
    names = Array("dry|normal", "dry|edge", "wet|normal", "wet|edge", "frost|normal", "frost|edge")
    For L = 0 To 5
        r0 = FindKey("soil|" & names(L) & "|0")
        For j = 0 To gFH - 1
            DecodeRow CStr(gA(r0 + j, 3)), gSoil, L * gFW * gFH + j * gFW
        Next
    Next
    gStage = "map"
    ' map
    Dim tx As Long, ty As Long, row As String, kinds As Variant
    r0 = FindKey("tiles|0")
    For ty = 0 To MAPR - 1
        row = CStr(gA(r0 + ty, 3))
        kinds = Split(CStr(gA(r0 + ty, 2)), ",")
        For tx = 0 To MAPC - 1
            gTile(tx, ty) = CLng(Mid$(row, tx + 1, 1))
            gProp(tx, ty) = CStr(kinds(tx))
        Next
    Next
    gStage = "ambient"
    ' ambient light table and glows
    parts = Split(CStr(gA(FindKey("ambient"), 3)), ";")
    gAmbN = UBound(parts) + 1
    ReDim gAmbH(0 To gAmbN - 1): ReDim gAmbC(0 To gAmbN - 1): ReDim gAmbA(0 To gAmbN - 1)
    For i = 0 To gAmbN - 1
        d = Split(parts(i), ":")
        gAmbH(i) = Val(d(0)): gAmbC(i) = CLng(d(1)): gAmbA(i) = Val(d(2))
    Next
    parts = Split(CStr(gA(FindKey("lights"), 3)), ";")
    gLightN = UBound(parts) + 1
    ReDim gLightX(0 To gLightN - 1): ReDim gLightY(0 To gLightN - 1): ReDim gLightR(0 To gLightN - 1): ReDim gLightC(0 To gLightN - 1)
    For i = 0 To gLightN - 1
        d = Split(parts(i), ":")
        gLightX(i) = Val(d(0)): gLightY(i) = Val(d(1)): gLightR(i) = Val(d(2)): gLightC(i) = CLng(d(3))
    Next
End Sub

Private Sub DecodeRow(ByVal s As String, dst() As Long, ByVal offset As Long)
    Dim b() As Byte, i As Long, cnt As Long, c1 As Long
    b = StrConv(s, vbFromUnicode)
    cnt = (UBound(b) + 1) \ 2
    For i = 0 To cnt - 1
        c1 = b(2 * i)
        If c1 = 46 Then
            dst(offset + i) = -1
        Else
            dst(offset + i) = gPal(gCv(c1) * 64 + gCv(b(2 * i + 1)))
        End If
    Next
End Sub

Private Sub DecodeSpriteRow(ByVal s As String, ByVal offset As Long)
    DecodeRow s, gSprPx, offset
End Sub

Private Function LoadSprite(ByVal name As String) As Long
    Dim r As Long, p As Variant
    r = FindKey("spr|" & name)
    If r = 0 Then Err.Raise 5, , "Missing sprite " & name
    p = Split(CStr(gA(r, 2)), ",")
    Dim cnt As Long
    cnt = CLng(p(0)) * CLng(p(1))
    If gSprPxN + cnt > UBound(gSprPx) + 1 Then
        ReDim Preserve gSprPx(0 To gSprPxN + cnt + 4096)
    End If
    DecodeSpriteRow CStr(gA(r, 3)), gSprPxN
    gSprW(gSprN) = CLng(p(0)): gSprH(gSprN) = CLng(p(1)): gSprOff(gSprN) = gSprPxN
    gSprPxN = gSprPxN + cnt
    LoadSprite = gSprN
    gSprN = gSprN + 1
End Function

Private Sub LoadSeason(ByVal si As Long)
    If si = gLoadedSeason Then Exit Sub
    Dim sn As String, r0 As Long, y As Long, i As Long, p As Variant
    sn = Split(SEASON_NAMES, ",")(si)
    ReDim gBg(0 To W * H - 1)
    r0 = FindKey("bg|" & sn & "|0")
    For y = 0 To H - 1: DecodeRow CStr(gA(r0 + y, 3)), gBg, y * W: Next
    r0 = FindKey("obj|" & sn & "|0")
    gObjN = 0
    ReDim gObjSortY(0 To 299): ReDim gObjX(0 To 299): ReDim gObjY(0 To 299): ReDim gObjW(0 To 299): ReDim gObjH(0 To 299): ReDim gObjOff(0 To 299)
    Dim used As Long, total As Long
    i = r0
    Do While i <= gAN
        If Left$(CStr(gA(i, 1)), Len("obj|" & sn & "|")) <> "obj|" & sn & "|" Then Exit Do
        total = total + Len(CStr(gA(i, 3))) \ 2
        i = i + 1
    Loop
    ReDim gObjPx(0 To total)
    i = r0
    Do While i <= gAN
        If Left$(CStr(gA(i, 1)), Len("obj|" & sn & "|")) <> "obj|" & sn & "|" Then Exit Do
        p = Split(CStr(gA(i, 2)), ",")
        DecodeRow CStr(gA(i, 3)), gObjPx, used
        gObjSortY(gObjN) = CLng(p(0)): gObjX(gObjN) = CLng(p(1)): gObjY(gObjN) = CLng(p(2))
        gObjW(gObjN) = CLng(p(3)): gObjH(gObjN) = CLng(p(4)): gObjOff(gObjN) = used
        used = used + CLng(p(3)) * CLng(p(4))
        gObjN = gObjN + 1
        i = i + 1
    Loop
    gLoadedSeason = si
End Sub

' ---- variables ----------------------------------------------------------------
Private Sub LoadVars()
    Dim shNames As Variant, s As Long, ws As Object, last As Long, r As Long, arr As Variant
    shNames = Array("FARMER", "FARM", "MARKET")
    gVN = 0
    ReDim gVName(0 To 79): ReDim gVSheet(0 To 79): ReDim gVRow(0 To 79)
    ReDim gVVal(0 To 79): ReDim gVCell(0 To 79): ReDim gVDef(0 To 79): ReDim gVLive(0 To 79)
    For s = 0 To 2
        Set ws = ThisWorkbook.Worksheets(shNames(s))
        last = LastRow(ws)
        arr = ws.Range("A1:G" & last).Value
        For r = 2 To last
            If Len(CStr(arr(r, 4))) > 0 Then
                gVName(gVN) = CStr(arr(r, 4))
                gVSheet(gVN) = shNames(s)
                gVRow(gVN) = r
                gVVal(gVN) = arr(r, 2)
                gVCell(gVN) = arr(r, 2)
                gVDef(gVN) = arr(r, 5)
                gVLive(gVN) = (CStr(arr(r, 7)) = "live")
                gVN = gVN + 1
            End If
        Next
    Next
    Set ws = ThisWorkbook.Worksheets("RULES")
    last = LastRow(ws)
    arr = ws.Range("A1:A" & last).Value
    gRN = 0
    ReDim gRName(0 To last): ReDim gRRow(0 To last)
    For r = 2 To last
        If Len(CStr(arr(r, 1))) > 0 Then gRName(gRN) = CStr(arr(r, 1)): gRRow(gRN) = r: gRN = gRN + 1
    Next
    vCash = VarId("Cash"): vStamina = VarId("Stamina"): vMaxStamina = VarId("MaxStamina"): vToolStamina = VarId("ToolStamina")
    vWalk = VarId("WalkSpeed"): vCanCap = VarId("CanCapacity"): vCanWater = VarId("CanWater"): vCanLevel = VarId("CanLevel")
    vDay = VarId("Day"): vHour = VarId("Hour"): vSeason = VarId("Season"): vSeasonLen = VarId("SeasonLength")
    vDayLen = VarId("DayLength"): vGrowth = VarId("GrowthSpeed"): vRainChance = VarId("RainChance"): vWeather = VarId("Weather")
    vDrought = VarId("DroughtDays"): vChickens = VarId("Chickens"): vEggChance = VarId("EggChance")
    vRecovery = VarId("DemandRecovery")
    Dim i As Long, nm As String
    For i = 0 To 4
        nm = Split(ITEM_NAMES, ",")(i)
        vBasket(i) = VarId("Basket_" & nm)
        vBase(i) = VarId("BasePrice_" & nm)
        vSold(i) = VarId("Sold_" & nm)
        rPrice(i) = RuleId("Price_" & nm)
        If i < 4 Then vSeeds(i) = VarId("Seeds_" & nm): vSeedCost(i) = VarId("SeedCost_" & nm)
    Next
    rUpgradeCost = RuleId("UpgradeCost_Can"): rUpgradeSize = RuleId("UpgradeSize_Can"): rSleepRestore = RuleId("SleepRestore")
End Sub

Private Function VarId(ByVal nm As String) As Long
    Dim i As Long
    For i = 0 To gVN - 1
        If gVName(i) = nm Then VarId = i: Exit Function
    Next
    Err.Raise 5, , "Variable " & nm & " is missing from FARMER / FARM / MARKET"
End Function

Private Function RuleId(ByVal nm As String) As Long
    Dim i As Long
    For i = 0 To gRN - 1
        If gRName(i) = nm Then RuleId = i: Exit Function
    Next
    Err.Raise 5, , "Rule " & nm & " is missing from RULES"
End Function

' Re-read every variable (picks up edits made in the shNames) and react to the ones that matter.
Private Sub ReadVars()
    Dim shNames As Variant, s As Long, ws As Object, arr As Variant, i As Long, maxRow As Long
    Dim oldSeason As String, oldWeather As String, oldHens As Variant
    oldSeason = VStr(vSeason): oldWeather = VStr(vWeather): oldHens = gVVal(vChickens)
    shNames = Array("FARMER", "FARM", "MARKET")
    For s = 0 To 2
        Set ws = ThisWorkbook.Worksheets(shNames(s))
        maxRow = 2
        For i = 0 To gVN - 1
            If gVSheet(i) = shNames(s) And gVRow(i) > maxRow Then maxRow = gVRow(i)
        Next
        arr = ws.Range("B1:B" & maxRow).Value
        For i = 0 To gVN - 1
            If gVSheet(i) = shNames(s) Then
                ' only a change made in the sheet replaces the game's own value
                If CStr(arr(gVRow(i), 1)) <> CStr(gVCell(i)) Then
                    gVVal(i) = arr(gVRow(i), 1)
                    gVCell(i) = arr(gVRow(i), 1)
                End If
            End If
        Next
    Next
    If VStr(vSeason) <> oldSeason Then
        gSeasonIdx = SeasonIndex(VStr(vSeason))
        WitherOutOfSeason
    End If
    If VStr(vWeather) <> oldWeather And VStr(vWeather) = "Rain" Then RainOnPlots
    If CStr(oldHens) <> CStr(gVVal(vChickens)) Then SyncFlock
    If N(vCanWater) > N(vCanCap) Then SetV vCanWater, N(vCanCap)
End Sub

Private Function N(ByVal i As Long) As Double
    Dim v As Variant: v = gVVal(i)
    If IsNumeric(v) And Not IsEmpty(v) Then
        N = CDbl(v)
    ElseIf IsNumeric(gVDef(i)) Then
        N = CDbl(gVDef(i))
    Else
        N = 0
    End If
End Function

Private Function VStr(ByVal i As Long) As String
    VStr = CStr(gVVal(i))
End Function

Private Sub SetV(ByVal i As Long, ByVal v As Variant)
    gVVal(i) = v
    ThisWorkbook.Worksheets(gVSheet(i)).Cells(gVRow(i), 2).Value = v
    gVCell(i) = ThisWorkbook.Worksheets(gVSheet(i)).Cells(gVRow(i), 2).Value
End Sub

Private Sub AddV(ByVal i As Long, ByVal dv As Double)
    SetV i, N(i) + dv
End Sub

Private Function Rule(ByVal r As Long) As Double
    Dim v As Variant
    v = ThisWorkbook.Worksheets("RULES").Cells(gRRow(r), 2).Value
    If IsNumeric(v) And Not IsEmpty(v) Then
        Rule = CDbl(v)
    Else
        Rule = 0
    End If
End Function

Private Function SeasonIndex(ByVal s As String) As Long
    Select Case LCase$(Trim$(s))
        Case "summer": SeasonIndex = 1
        Case "autumn", "fall": SeasonIndex = 2
        Case "winter": SeasonIndex = 3
        Case Else: SeasonIndex = 0
    End Select
End Function

' =============================================================================
' Crops and items
' =============================================================================
Private Function CropDays(ByVal c As Long) As Double
    CropDays = Choose(c + 1, 3, 5, 7, 4)
End Function
Private Function CropRegrow(ByVal c As Long) As Double
    CropRegrow = Choose(c + 1, 0, 2, 0, 0)
End Function
Private Function CropPack(ByVal c As Long) As Long
    CropPack = Choose(c + 1, 5, 3, 2, 4)
End Function
' bit per season: 1 Spring, 2 Summer, 4 Autumn, 8 Winter
Private Function CropGrowsIn(ByVal c As Long, ByVal si As Long) As Boolean
    Dim mask As Long: mask = Choose(c + 1, 7, 2, 4, 9)
    CropGrowsIn = (mask And (2 ^ si)) <> 0
End Function
Private Function ItemName(ByVal i As Long) As String
    ItemName = Split(ITEM_NAMES, ",")(i)
End Function
Private Function SeasonName(ByVal si As Long) As String
    SeasonName = Split(SEASON_NAMES, ",")(si)
End Function

' =============================================================================
' Game logic (mirrors examples/fieldbook/sim.ts)
' =============================================================================
Private Sub ResetGame()
    Dim i As Long
    For i = 0 To gVN - 1
        If gVLive(i) Then SetV i, gVDef(i)
    Next
    SetV vCanWater, N(vCanCap)
    SetV vStamina, N(vMaxStamina)
    For i = 0 To FLD_W * FLD_H - 1
        With gPlot(i)
            .tilled = False: .watered = False: .crop = -1: .growth = 0: .dry = 0: .withered = False: .harvests = 0
        End With
    Next
    For i = 0 To 3: gPlot(i).tilled = True: Next
    fX = SPAWN_TX * 8 + 4: fY = SPAWN_TY * 8 + 6: fDir = 0: fMoving = False: fWalkT = 0
    fTool = 0: fSeed = 0: fActT = 0: fAct = 0
    gEggN = 0
    gOrdN = 0: gNextOrder = 1
    AddOrder 0, 8, 5, 140
    AddOrder 4, 5, 6, 60
    AddOrder 3, 4, 9, 150
    For i = 0 To 79: gPart(i).life = 0: Next
    gHenN = 0
    SyncFlock
    gSeasonIdx = SeasonIndex(VStr(vSeason))
    ShowBanner "DAY 1 - SPRING", 2.5
    gOrdersDirty = True
    gTime = 0
End Sub

Private Function PlotIdx(ByVal tx As Long, ByVal ty As Long) As Long
    If tx >= FLD_X And ty >= FLD_Y And tx < FLD_X + FLD_W And ty < FLD_Y + FLD_H Then
        PlotIdx = (ty - FLD_Y) * FLD_W + (tx - FLD_X)
    Else
        PlotIdx = -1
    End If
End Function

Private Function IsRipe(ByVal i As Long) As Boolean
    With gPlot(i)
        If .crop >= 0 And Not .withered Then IsRipe = (.growth >= CropDays(.crop))
    End With
End Function

Private Function Stage(ByVal i As Long) As Long
    With gPlot(i)
        If .crop < 0 Then Stage = -1: Exit Function
        If IsRipe(i) Then Stage = 3: Exit Function
        Stage = Int((.growth / CropDays(.crop)) * 3)
        If Stage > 2 Then Stage = 2
    End With
End Function

Private Sub FarmerTile(tx As Long, ty As Long)
    tx = Int(fX / 8): ty = Int((fY - 1) / 8)
End Sub

Private Sub DirVec(ByVal d As Long, dx As Long, dy As Long)
    dx = 0: dy = 0
    Select Case d
        Case 0: dy = 1
        Case 1: dy = -1
        Case 2: dx = -1
        Case 3: dx = 1
    End Select
End Sub

Private Sub TargetTile(tx As Long, ty As Long)
    Dim dx As Long, dy As Long
    FarmerTile tx, ty
    DirVec fDir, dx, dy
    tx = tx + dx: ty = ty + dy
End Sub

Private Function IsSolid(ByVal tx As Long, ByVal ty As Long) As Boolean
    If tx < 0 Or ty < 0 Or tx >= MAPC Or ty >= MAPR Then
        IsSolid = True
    Else
        IsSolid = (gTile(tx, ty) <> 0)
    End If
End Function

Private Function PropAt(ByVal tx As Long, ByVal ty As Long) As String
    If tx < 0 Or ty < 0 Or tx >= MAPC Or ty >= MAPR Then
        PropAt = ""
    Else
        PropAt = gProp(tx, ty)
    End If
End Function

Private Function IsWater(ByVal tx As Long, ByVal ty As Long) As Boolean
    If tx < 0 Or ty < 0 Or tx >= MAPC Or ty >= MAPR Then
        IsWater = False
    Else
        IsWater = (gTile(tx, ty) = 2)
    End If
End Function

Private Function OnBed() As Boolean
    Dim tx As Long, ty As Long
    FarmerTile tx, ty
    OnBed = (ty = 5 And tx >= 3 And tx <= 5)
End Function

Private Sub ShowBanner(ByVal t As String, Optional ByVal secs As Double = 2.2)
    gBanner = t: gBannerT = secs
End Sub

Private Sub Tick(ByVal dt As Double)
    Dim i As Long
    ReadVars
    gRaining = (VStr(vWeather) = "Rain")
    gTime = gTime + dt
    If gBannerT > 0 Then gBannerT = gBannerT - dt
    If gFade > 0 Then gFade = gFade - dt: If gFade < 0 Then gFade = 0
    If fActT > 0 Then fActT = fActT - dt: If fActT < 0 Then fActT = 0
    ' tools and seeds
    For i = 0 To 3
        If Pressed(A_SEED1 + i) Then fSeed = i: fTool = 2
    Next
    If Pressed(A_TOOL) Then fTool = (fTool + 1) Mod 3
    ' walk
    Dim mx As Double, my As Double, ln As Double, sp As Double
    mx = 0: my = 0
    If gDown(A_LEFT) Then mx = mx - 1
    If gDown(A_RIGHT) Then mx = mx + 1
    If gDown(A_UP) Then my = my - 1
    If gDown(A_DOWN) Then my = my + 1
    fMoving = (mx <> 0 Or my <> 0)
    If fMoving Then
        If mx <> 0 And my = 0 Then
            If mx < 0 Then
                fDir = 2
            Else
                fDir = 3
            End If
        ElseIf my <> 0 And mx = 0 Then
            If my < 0 Then
                fDir = 1
            Else
                fDir = 0
            End If
        End If
        ln = Sqr(mx * mx + my * my)
        If ln > 1 Then mx = mx / ln: my = my / ln
        sp = N(vWalk) * 8
        MoveFarmer mx * sp * dt, 0
        MoveFarmer 0, my * sp * dt
        fWalkT = fWalkT + dt
    Else
        fWalkT = 0
    End If
    ' eggs: walk over them
    Dim ftx As Long, fty As Long
    FarmerTile ftx, fty
    For i = 0 To gEggN - 1
        If gEggX(i) = ftx And gEggY(i) = fty Then
            gEggX(i) = gEggX(gEggN - 1): gEggY(i) = gEggY(gEggN - 1): gEggN = gEggN - 1
            AddV vBasket(4), 1
            ShowBanner "+1 EGG", 1.2
            Burst fX, fY - 4 + TOPPX, 6, RGB(220, 244, 255), RGB(76, 201, 242), -1, 30
            Exit For
        End If
    Next
    If Pressed(A_USE) Then UseTool
    If Pressed(A_SLEEP) Then
        If OnBed() Then
            SleepNow False
        Else
            ShowBanner "GO HOME TO SLEEP (DOORSTEP)"
        End If
    End If
    ' clock
    Dim dayLen As Double, hr As Double
    dayLen = N(vDayLen): If dayLen < 1 Then dayLen = 1
    hr = N(vHour) + dt * (PASS_OUT - DAY_START) / dayLen
    If hr >= PASS_OUT Then
        SleepNow True
    Else
        gVVal(vHour) = hr
        If Abs(hr - gLastHourWrite) >= 0.05 Or hr < gLastHourWrite Then SetV vHour, hr: gLastHourWrite = hr
    End If
    UpdateHens dt
    UpdateParticles dt
    gHint = ComputeHint()
End Sub

Private Sub MoveFarmer(ByVal dx As Double, ByVal dy As Double)
    If Not BoxBlocked(fX + dx, fY + dy) Then fX = fX + dx: fY = fY + dy
End Sub

Private Function BoxBlocked(ByVal x As Double, ByVal y As Double) As Boolean
    Dim x0 As Long, x1 As Long, y0 As Long, y1 As Long, tx As Long, ty As Long
    x0 = Int((x - 3) / 8): x1 = Int((x + 3 - 0.001) / 8)
    y0 = Int((y - 3) / 8): y1 = Int((y - 0.001) / 8)
    For ty = y0 To y1
        For tx = x0 To x1
            If IsSolid(tx, ty) Then BoxBlocked = True: Exit Function
        Next
    Next
End Function

Private Function Spend() As Boolean
    Dim cost As Double: cost = N(vToolStamina)
    If N(vStamina) < cost Then ShowBanner "TOO TIRED - GO TO BED (R)": Exit Function
    AddV vStamina, -cost
    Spend = True
End Function

Private Sub Act(ByVal kind As Long, ByVal tx As Long, ByVal ty As Long)
    fAct = kind: fActT = 0.3: fActTx = tx: fActTy = ty
End Sub

Private Function BasketCount() As Long
    Dim i As Long, s As Long
    For i = 0 To 4: s = s + N(vBasket(i)): Next
    BasketCount = s
End Function

Private Function Deliverable() As Long
    Dim i As Long, k As Long, want As Long, have As Long, total As Long
    For i = 0 To 4
        want = 0
        For k = 0 To gOrdN - 1
            If gOrd(k).status = 0 And gOrd(k).item = i Then want = want + gOrd(k).qty - gOrd(k).delivered
        Next
        have = N(vBasket(i))
        If have < want Then
            total = total + have
        Else
            total = total + want
        End If
    Next
    Deliverable = total
End Function

Private Function ComputeHint() As String
    Dim tx As Long, ty As Long, kind As String, p As Long
    TargetTile tx, ty
    kind = PropAt(tx, ty)
    Select Case kind
        Case "stall"
            If BasketCount() > 0 Then
                ComputeHint = "E SELL " & BasketCount()
            Else
                ComputeHint = "STALL: BRING PRODUCE"
            End If
            Exit Function
        Case "crate"
            ComputeHint = "E BUY " & CropPack(fSeed) & " " & UCase$(ItemName(fSeed)) & " $" & Format$(N(vSeedCost(fSeed)) * CropPack(fSeed), "0")
            Exit Function
        Case "shed"
            If N(vCanLevel) >= 6 Then
                ComputeHint = "CAN FULLY UPGRADED"
            Else
                ComputeHint = "E UPGRADE CAN $" & Format$(Rule(rUpgradeCost), "0")
            End If
            Exit Function
        Case "well"
            ComputeHint = "E REFILL CAN": Exit Function
        Case "board"
            If Deliverable() > 0 Then
                ComputeHint = "E DELIVER " & Deliverable()
            Else
                ComputeHint = "E READ ORDERS"
            End If
            Exit Function
    End Select
    If IsWater(tx, ty) Then ComputeHint = "E REFILL CAN": Exit Function
    If OnBed() Then ComputeHint = "R SLEEP": Exit Function
    p = PlotIdx(tx, ty)
    If p >= 0 Then
        With gPlot(p)
            If IsRipe(p) Then
                ComputeHint = "E HARVEST"
            ElseIf .withered Then
                ComputeHint = "E CLEAR"
            ElseIf fTool = 0 And Not .tilled Then
                ComputeHint = "E TILL"
            ElseIf fTool = 1 And .tilled And Not .watered Then
                ComputeHint = "E WATER"
            ElseIf fTool = 2 And .tilled And .crop < 0 Then
                ComputeHint = "E PLANT " & UCase$(ItemName(fSeed))
            End If
        End With
    End If
End Function

Private Sub UseTool()
    Dim tx As Long, ty As Long, kind As String, p As Long, cx As Double, cy As Double, c As Long
    TargetTile tx, ty
    kind = PropAt(tx, ty)
    Select Case kind
        Case "stall": Call SellAll: Exit Sub
        Case "crate": BuySeeds fSeed: Exit Sub
        Case "shed": Call UpgradeCan: Exit Sub
        Case "well": Call Refill: Exit Sub
        Case "board": Call DeliverOrders: Exit Sub
        Case "house", "mat": ShowBanner "STAND ON THE DOORSTEP, PRESS R": Exit Sub
        Case "coop": ShowBanner "HENS LAY IN THE PEN EACH MORNING": Exit Sub
    End Select
    If IsWater(tx, ty) Then Call Refill: Exit Sub
    p = PlotIdx(tx, ty)
    If p < 0 Then
        If fTool = 0 Then ShowBanner "TILL INSIDE THE FENCED FIELD"
        Exit Sub
    End If
    cx = tx * 8 + 4: cy = ty * 8 + 4 + TOPPX
    If IsRipe(p) Then
        c = gPlot(p).crop
        AddV vBasket(c), 1
        gPlot(p).harvests = gPlot(p).harvests + 1
        If CropRegrow(c) > 0 Then
            gPlot(p).growth = CropDays(c) - CropRegrow(c)
        Else
            gPlot(p).crop = -1: gPlot(p).growth = 0
        End If
        Act 4, tx, ty
        ShowBanner "+1 " & UCase$(ItemName(c)), 1.2
        Burst cx, cy, 10, RGB(160, 244, 255), RGB(106, 227, 155), -1, 60
        Exit Sub
    End If
    If gPlot(p).withered Then
        If Not Spend() Then Exit Sub
        gPlot(p).crop = -1: gPlot(p).withered = False: gPlot(p).growth = 0
        Act 1, tx, ty
        Dirt cx, cy
        Exit Sub
    End If
    Select Case fTool
        Case 0
            If gPlot(p).tilled Then
                If gPlot(p).crop >= 0 Then
                    ShowBanner "IT'S GROWING", 1.2
                Else
                    ShowBanner "ALREADY TILLED", 1.2
                End If
                Exit Sub
            End If
            If Not Spend() Then Exit Sub
            gPlot(p).tilled = True
            gPlot(p).watered = gRaining
            Act 1, tx, ty
            Dirt cx, cy
        Case 1
            If Not gPlot(p).tilled Then ShowBanner "TILL THE SOIL FIRST", 1.2: Exit Sub
            If gPlot(p).watered Then ShowBanner "ALREADY WATERED", 1.2: Exit Sub
            If N(vCanWater) <= 0 Then ShowBanner "CAN EMPTY - REFILL AT WELL": Exit Sub
            If Not Spend() Then Exit Sub
            gPlot(p).watered = True
            AddV vCanWater, -1
            Act 2, tx, ty
            Burst cx, cy - 2, 10, RGB(240, 211, 143), RGB(255, 242, 216), 1, 80
        Case 2
            c = fSeed
            If Not gPlot(p).tilled Then ShowBanner "TILL THE SOIL FIRST", 1.2: Exit Sub
            If gPlot(p).crop >= 0 Then ShowBanner "PLOT IS OCCUPIED", 1.2: Exit Sub
            If N(vSeeds(c)) <= 0 Then ShowBanner "NO " & UCase$(ItemName(c)) & " SEEDS - BUY AT CRATE": Exit Sub
            If Not CropGrowsIn(c, gSeasonIdx) Then ShowBanner UCase$(ItemName(c)) & " WON'T GROW IN " & UCase$(SeasonName(gSeasonIdx)): Exit Sub
            If Not Spend() Then Exit Sub
            gPlot(p).crop = c: gPlot(p).growth = 0: gPlot(p).dry = 0: gPlot(p).harvests = 0
            AddV vSeeds(c), -1
            Act 3, tx, ty
            Dirt cx, cy
    End Select
End Sub

Private Sub Dirt(ByVal x As Double, ByVal y As Double)
    Burst x, y, 8, RGB(58, 90, 138), RGB(48, 69, 110), -1, 120
End Sub

Private Sub Refill()
    Dim cap As Double: cap = N(vCanCap)
    If N(vCanWater) >= cap Then ShowBanner "CAN IS FULL", 1.2: Exit Sub
    SetV vCanWater, cap
    ShowBanner "CAN FILLED " & cap & "/" & cap, 1.4
    Dim tx As Long, ty As Long
    TargetTile tx, ty
    Burst tx * 8 + 4, ty * 8 + 4 + TOPPX, 12, RGB(240, 211, 143), RGB(255, 242, 216), -1, 90
End Sub

Private Sub SellAll()
    Dim total As Long, cash As Double, units As Long, i As Long, have As Long
    total = BasketCount()
    If total = 0 Then ShowBanner "BASKET EMPTY - HARVEST FIRST": Exit Sub
    For i = 0 To 4
        have = N(vBasket(i))
        Do While have > 0
            cash = cash + Rule(rPrice(i))
            units = units + 1
            have = have - 1
            AddV vSold(i), 1
        Loop
        If N(vBasket(i)) <> 0 Then SetV vBasket(i), 0
    Next
    AddV vCash, cash
    ShowBanner "SOLD " & units & " FOR $" & Format$(cash, "0"), 2.2
    Burst fX, fY - 12 + TOPPX, 14, RGB(76, 201, 242), RGB(160, 233, 255), -1, 90
End Sub

Private Sub BuySeeds(ByVal c As Long)
    Dim unit As Double, cash As Double, qty As Long
    unit = N(vSeedCost(c)): cash = N(vCash)
    If unit > 0 Then
        qty = Int(cash / unit)
        If qty > CropPack(c) Then qty = CropPack(c)
    Else
        qty = CropPack(c)
    End If
    If qty <= 0 Then ShowBanner "NEED $" & unit & " FOR A SEED": Exit Sub
    AddV vCash, -qty * unit
    AddV vSeeds(c), qty
    ShowBanner "BOUGHT " & qty & " " & UCase$(ItemName(c)) & " SEEDS -$" & Format$(qty * unit, "0")
End Sub

Private Sub UpgradeCan()
    Dim lvl As Double, cost As Double, size As Long
    lvl = N(vCanLevel)
    If lvl >= 6 Then ShowBanner "CAN FULLY UPGRADED": Exit Sub
    cost = Rule(rUpgradeCost)
    If N(vCash) < cost Then ShowBanner "UPGRADE COSTS $" & Format$(cost, "0"): Exit Sub
    size = CLng(Rule(rUpgradeSize))
    AddV vCash, -cost
    SetV vCanLevel, lvl + 1
    SetV vCanCap, N(vCanCap) + size
    SetV vCanWater, N(vCanCap)
    ShowBanner "CAN LV" & (lvl + 1) & ": +" & size & " WATER", 2.5
End Sub

Private Sub DeliverOrders()
    Dim k As Long, give As Long, have As Long, delivered As Long, rewards As Long, done As Long, s As String
    For k = 0 To gOrdN - 1
        If gOrd(k).status = 0 Then
            have = N(vBasket(gOrd(k).item))
            give = gOrd(k).qty - gOrd(k).delivered
            If have < give Then give = have
            If give > 0 Then
                gOrd(k).delivered = gOrd(k).delivered + give
                delivered = delivered + give
                AddV vBasket(gOrd(k).item), -give
                If gOrd(k).delivered >= gOrd(k).qty Then
                    gOrd(k).status = 1: rewards = rewards + gOrd(k).reward: done = done + 1
                End If
            End If
        End If
    Next
    If delivered = 0 Then
        For k = 0 To gOrdN - 1
            If gOrd(k).status = 0 Then s = s & (gOrd(k).qty - gOrd(k).delivered) & " " & UCase$(ItemName(gOrd(k).item)) & " D" & gOrd(k).due & "  "
        Next
        If s = "" Then s = "NO OPEN ORDERS"
        ShowBanner Trim$(s), 3
        Exit Sub
    End If
    gOrdersDirty = True
    If rewards > 0 Then
        AddV vCash, rewards
        If done > 1 Then
            ShowBanner done & " ORDERS DONE! +$" & rewards, 2.6
        Else
            ShowBanner "ORDER DONE! +$" & rewards, 2.6
        End If
        Burst fX, fY - 12 + TOPPX, 18, RGB(76, 201, 242), RGB(74, 84, 217), -1, 80
        TopUpOrders
    Else
        ShowBanner "DELIVERED " & delivered & " - KEEP GOING", 2.2
    End If
End Sub

Private Sub SleepNow(ByVal passedOut As Boolean)
    Dim restore As Double, msg As String, fee As Double, i As Long, speed As Double, drought As Double
    Dim newDay As Long, ln As Long, rain As Boolean, keep As Double
    SetV vHour, N(vHour)
    restore = Rule(rSleepRestore)
    If passedOut Then
        fee = Round(N(vCash) * 0.1, 0)
        AddV vCash, -fee
        restore = N(vMaxStamina) * 0.5
        msg = "PASSED OUT! DOCTOR -$" & fee
    End If
    speed = N(vGrowth): drought = N(vDrought)
    For i = 0 To FLD_W * FLD_H - 1
        With gPlot(i)
            If .crop >= 0 And Not .withered Then
                If .watered Then
                    .growth = .growth + speed
                    If .growth > CropDays(.crop) Then .growth = CropDays(.crop)
                    .dry = 0
                Else
                    .dry = .dry + 1
                    If .dry >= drought Then .withered = True
                End If
            End If
            .watered = False
        End With
    Next
    newDay = N(vDay) + 1
    SetV vDay, newDay
    ln = Round(N(vSeasonLen), 0): If ln < 1 Then ln = 1
    If (newDay - 1) Mod ln = 0 Then
        gSeasonIdx = (gSeasonIdx + 1) Mod 4
        SetV vSeason, SeasonName(gSeasonIdx)
        WitherOutOfSeason
    End If
    rain = (Rnd() < N(vRainChance))
    If rain Then
        SetV vWeather, "Rain"
    Else
        SetV vWeather, "Sunny"
    End If
    gRaining = rain
    If rain Then RainOnPlots
    LayEggs
    keep = 1 - N(vRecovery)
    For i = 0 To 4: SetV vSold(i), Round(N(vSold(i)) * keep * 100, 0) / 100: Next
    For i = 0 To gOrdN - 1
        If gOrd(i).status = 0 And gOrd(i).due < newDay Then gOrd(i).status = 2
    Next
    TopUpOrders
    If passedOut Then
        SetV vStamina, restore
    ElseIf N(vStamina) < restore Then
        SetV vStamina, restore
    End If
    SetV vHour, DAY_START: gLastHourWrite = DAY_START
    fX = SPAWN_TX * 8 + 4: fY = SPAWN_TY * 8 + 6: fDir = 0: fActT = 0
    gFade = 1.4
    gOrdersDirty = True
    If msg = "" Then
        msg = "DAY " & newDay & " - " & UCase$(SeasonName(gSeasonIdx))
        If rain Then
            If gSeasonIdx = 3 Then
                msg = msg & " - SNOW"
            Else
                msg = msg & " - RAIN"
            End If
        End If
    End If
    ShowBanner msg, 2.6
    If Not gTest Then SaveState
End Sub

Private Sub WitherOutOfSeason()
    Dim i As Long
    For i = 0 To FLD_W * FLD_H - 1
        With gPlot(i)
            If .crop >= 0 And Not .withered Then
                If Not CropGrowsIn(.crop, gSeasonIdx) Then .withered = True
            End If
        End With
    Next
End Sub

Private Sub RainOnPlots()
    Dim i As Long
    For i = 0 To FLD_W * FLD_H - 1
        If gPlot(i).tilled Then gPlot(i).watered = True
    Next
End Sub

Private Sub LayEggs()
    Dim i As Long, tries As Long, tx As Long, ty As Long, k As Long, taken As Boolean
    For i = 0 To gHenN - 1
        If Rnd() < N(vEggChance) And gEggN < 12 Then
            For tries = 1 To 8
                tx = PEN_X + Int(Rnd() * PEN_W): ty = PEN_Y + Int(Rnd() * PEN_H)
                taken = IsSolid(tx, ty)
                For k = 0 To gEggN - 1
                    If gEggX(k) = tx And gEggY(k) = ty Then taken = True
                Next
                If Not taken Then gEggX(gEggN) = tx: gEggY(gEggN) = ty: gEggN = gEggN + 1: Exit For
            Next
        End If
    Next
End Sub

Private Sub AddOrder(ByVal item As Long, ByVal qty As Long, ByVal due As Long, ByVal reward As Long)
    If gOrdN > UBound(gOrd) Then Exit Sub
    With gOrd(gOrdN)
        .id = gNextOrder: .item = item: .qty = qty: .delivered = 0: .due = due: .reward = reward: .status = 0
    End With
    gOrdN = gOrdN + 1: gNextOrder = gNextOrder + 1
End Sub

Private Sub TopUpOrders()
    Dim open_ As Long, k As Long, pool(0 To 4) As Long, np As Long, item As Long, lo As Long, hi As Long
    Dim qty As Long, grow As Long, due As Long, baseIx As Double, reward As Long, c As Long
    For k = 0 To gOrdN - 1
        If gOrd(k).status = 0 Then open_ = open_ + 1
    Next
    Do While open_ < 3
        np = 0
        For c = 0 To 3
            If CropGrowsIn(c, gSeasonIdx) Then pool(np) = c: np = np + 1
        Next
        pool(np) = 4: np = np + 1
        item = pool(Int(Rnd() * np) Mod np)
        Select Case item
            Case 2: lo = 2: hi = 5
            Case 1, 4: lo = 4: hi = 9
            Case Else: lo = 5: hi = 12
        End Select
        qty = lo + Int(Rnd() * (hi - lo + 1))
        If item = 4 Then
            grow = 1
        Else
            grow = CropDays(item)
        End If
        due = N(vDay) + grow + 2 + Int(Rnd() * 4)
        baseIx = N(vBase(item))
        reward = Round((qty * baseIx * (1.5 + Rnd() * 0.6)) / 5, 0) * 5
        If reward < 10 Then reward = 10
        ' keep the 3 open orders plus the 7 most recent closed ones
        If gOrdN > UBound(gOrd) Then DropOldestClosed
        AddOrder item, qty, due, reward
        open_ = open_ + 1
    Loop
    Dim closed As Long
    For k = 0 To gOrdN - 1
        If gOrd(k).status <> 0 Then closed = closed + 1
    Next
    Do While closed > 7
        DropOldestClosed
        closed = closed - 1
    Loop
    gOrdersDirty = True
End Sub

Private Sub DropOldestClosed()
    Dim k As Long, j As Long
    For k = 0 To gOrdN - 1
        If gOrd(k).status <> 0 Then
            For j = k To gOrdN - 2: gOrd(j) = gOrd(j + 1): Next
            gOrdN = gOrdN - 1
            Exit Sub
        End If
    Next
End Sub

Private Sub SyncFlock()
    Dim want As Long, i As Long
    want = Round(N(vChickens), 0)
    If want < 0 Then want = 0
    If want > 10 Then want = 10
    If want = 0 Then gHenN = 0: Exit Sub
    If gHenN = 0 Then
        ReDim gHen(0 To 9)
    End If
    Do While gHenN < want
        i = gHenN
        With gHen(i)
            .hx = (PEN_X + (i Mod 3) + 0.5) * 8
            .hy = (PEN_Y + 2 + (i \ 3)) * 8 + 4
            .goalX = .hx: .goalY = .hy: .flipped = (i Mod 2 = 1): .idleT = 0.5 + i * 0.3: .pecking = False: .anim = i * 0.37
        End With
        gHenN = gHenN + 1
    Loop
    gHenN = want
End Sub

Private Sub UpdateHens(ByVal dt As Double)
    Dim i As Long, k As Long, dx As Double, dy As Double, d As Double, sp As Double
    Dim x0 As Double, x1 As Double, y0 As Double, y1 As Double, nx As Double, ny As Double, ntx As Long, nty As Long
    x0 = PEN_X * 8 + 3: x1 = (PEN_X + PEN_W) * 8 - 3
    y0 = PEN_Y * 8 + 5: y1 = (PEN_Y + PEN_H) * 8 - 1
    For i = 0 To gHenN - 1
        With gHen(i)
            .anim = .anim + dt
            .idleT = .idleT - dt
            dx = .goalX - .hx: dy = .goalY - .hy
            d = Sqr(dx * dx + dy * dy)
            If d > 0.5 And Not .pecking Then
                sp = 9 * dt: If sp > d Then sp = d
                .hx = .hx + dx / d * sp: .hy = .hy + dy / d * sp
                If Abs(dx) > 0.2 Then .flipped = (dx < 0)
            End If
            If .idleT <= 0 Then
                If Rnd() < 0.45 Then
                    .pecking = True: .idleT = 0.8 + Rnd() * 1.4
                Else
                    .pecking = False
                    For k = 1 To 6
                        nx = x0 + Rnd() * (x1 - x0): ny = y0 + Rnd() * (y1 - y0)
                        ntx = Int(nx / 8): nty = Int((ny - 1) / 8)
                        If Not (ntx >= COOP_X And nty < COOP_Y + COOP_H And ntx < COOP_X + COOP_W) And Not IsSolid(ntx, nty) Then
                            .goalX = nx: .goalY = ny
                            Exit For
                        End If
                    Next
                    .idleT = 1 + Rnd() * 2
                End If
            End If
        End With
    Next
End Sub

' ---- particles (canvas coordinates) ---------------------------------------------
Private Sub Burst(ByVal x As Double, ByVal y As Double, ByVal count As Long, ByVal c1 As Long, ByVal c2 As Long, ByVal dirY As Long, ByVal grav As Double)
    Dim i As Long, k As Long, a As Double, sp As Double
    For k = 1 To count
        For i = 0 To 79
            If gPart(i).life <= 0 Then Exit For
        Next
        If i > 79 Then Exit Sub
        With gPart(i)
            If dirY < 0 Then
                a = -3.14159 * (0.1 + Rnd() * 0.8)
            Else
                a = 3.14159 * (0.2 + Rnd() * 0.6)
            End If
            sp = 12 + Rnd() * 28
            .x = x: .y = y: .vx = Cos(a) * sp: .vy = Sin(a) * sp
            .life = 0.3 + Rnd() * 0.4
            If Rnd() < 0.5 Then
                .col = c1
            Else
                .col = c2
            End If
            .grav = grav: .floorY = y + 4
        End With
    Next
End Sub

Private Sub UpdateParticles(ByVal dt As Double)
    Dim i As Long
    For i = 0 To 79
        With gPart(i)
            If .life > 0 Then
                .life = .life - dt
                .vy = .vy + .grav * dt
                .x = .x + .vx * dt: .y = .y + .vy * dt
                If .y > .floorY And .vy > 0 Then .y = .floorY: .vy = 0: .vx = .vx * 0.5
            End If
        End With
    Next
End Sub

' =============================================================================
' Rendering
' =============================================================================
Private Function Mix(ByVal a As Long, ByVal b As Long, ByVal t As Double) As Long
    Dim ar As Long, ag As Long, ab As Long, br As Long, bg As Long, bb As Long
    ar = a And &HFF&: ag = (a \ 256) And &HFF&: ab = (a \ 65536) And &HFF&
    br = b And &HFF&: bg = (b \ 256) And &HFF&: bb = (b \ 65536) And &HFF&
    Mix = CLng(ar + (br - ar) * t) + CLng(ag + (bg - ag) * t) * 256& + CLng(ab + (bb - ab) * t) * 65536
End Function

Private Sub PPix(ByVal x As Long, ByVal y As Long, ByVal c As Long)
    If x >= 0 And y >= 0 And x < W And y < H Then gFrame(y * W + x) = c
End Sub

Private Sub PBlend(ByVal x As Long, ByVal y As Long, ByVal c As Long, ByVal a As Double)
    If x >= 0 And y >= 0 And x < W And y < H Then gFrame(y * W + x) = Mix(gFrame(y * W + x), c, a)
End Sub

Private Sub Blit(ByVal si As Long, ByVal x0 As Long, ByVal y0 As Long)
    Dim x As Long, y As Long, c As Long, sw As Long, sh As Long, px As Long, py As Long, o As Long
    sw = gSprW(si): sh = gSprH(si): o = gSprOff(si)
    For y = 0 To sh - 1
        py = y0 + y
        If py >= 0 And py < H Then
            For x = 0 To sw - 1
                c = gSprPx(o + y * sw + x)
                If c <> -1 Then
                    px = x0 + x
                    If px >= 0 And px < W Then gFrame(py * W + px) = c
                End If
            Next
        End If
    Next
End Sub

Private Sub BlitObj(ByVal i As Long, ByVal cx0 As Long, ByVal cy0 As Long, ByVal cx1 As Long, ByVal cy1 As Long)
    ' redraw object i, clipped to the box (cx0,cy0)-(cx1,cy1)
    Dim x As Long, y As Long, c As Long, xa As Long, xb As Long, ya As Long, yb As Long, ow As Long, o As Long
    ow = gObjW(i): o = gObjOff(i)
    xa = gObjX(i): If cx0 > xa Then xa = cx0
    ya = gObjY(i): If cy0 > ya Then ya = cy0
    xb = gObjX(i) + ow - 1: If cx1 < xb Then xb = cx1
    yb = gObjY(i) + gObjH(i) - 1: If cy1 < yb Then yb = cy1
    If xa < 0 Then xa = 0
    If ya < 0 Then ya = 0
    If xb > W - 1 Then xb = W - 1
    If yb > H - 1 Then yb = H - 1
    For y = ya To yb
        For x = xa To xb
            c = gObjPx(o + (y - gObjY(i)) * ow + (x - gObjX(i)))
            If c <> -1 Then gFrame(y * W + x) = c
        Next
    Next
End Sub

Private Sub ShadowEllipse(ByVal cx As Double, ByVal cy As Double, ByVal rx As Double, ByVal ry As Double, ByVal a As Double)
    Dim x As Long, y As Long, dx As Double, dy As Double
    For y = Int(cy - ry) To Int(cy + ry)
        For x = Int(cx - rx) To Int(cx + rx)
            dx = (x + 0.5 - cx) / rx: dy = (y + 0.5 - cy) / ry
            If dx * dx + dy * dy <= 1 Then PBlend x, y, cShadow, a
        Next
    Next
End Sub

Private Function Hash01(ByVal a As Double, ByVal b As Double, ByVal c As Double) As Double
    Dim v As Double
    v = Sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453
    Hash01 = v - Int(v)
End Function

Private Function TilledAt(ByVal px As Long, ByVal py As Long) As Boolean
    If px < 0 Or py < 0 Or px >= FLD_W Or py >= FLD_H Then Exit Function
    TilledAt = gPlot(py * FLD_W + px).tilled
End Function

Private Sub DrawSoil()
    Dim px As Long, py As Long, lx As Long, ly As Long, tU As Boolean, tD As Boolean, tL As Boolean, tR As Boolean
    Dim layer As Long, edge As Boolean, sx As Long, sy As Long, baseIx As Long, ox As Long, oy As Long
    For py = 0 To FLD_H - 1
        For px = 0 To FLD_W - 1
            With gPlot(py * FLD_W + px)
                If .tilled Then
                    If .watered Then
                        layer = 2
                    ElseIf gSeasonIdx = 3 Then
                        layer = 4
                    Else
                        layer = 0
                    End If
                    tU = TilledAt(px, py - 1): tD = TilledAt(px, py + 1): tL = TilledAt(px - 1, py): tR = TilledAt(px + 1, py)
                    ox = gFX + px * 8: oy = gFY + py * 8
                    For ly = 0 To 7
                        For lx = 0 To 7
                            If ((lx = 0 And Not tL) Or (lx = 7 And Not tR)) And ((ly = 0 And Not tU) Or (ly = 7 And Not tD)) Then
                                ' rounded outside corner: leave the grass
                            Else
                                edge = (ly = 7 And Not tD) Or (ly = 0 And Not tU)
                                sx = px * 8 + lx: sy = py * 8 + ly
                                If edge Then
                                    baseIx = (layer + 1) * gFW * gFH
                                Else
                                    baseIx = layer * gFW * gFH
                                End If
                                gFrame((oy + ly) * W + ox + lx) = gSoil(baseIx + sy * gFW + sx)
                            End If
                        Next
                    Next
                End If
            End With
        Next
    Next
End Sub

Private Sub DrawCrop(ByVal p As Long)
    Dim st As Long, si As Long, bx As Long, by As Long, tx As Long, ty As Long, ripe As Boolean, sx As Long, sy As Long, wi As Long
    st = Stage(p)
    With gPlot(p)
        If .withered Then
            wi = 1
        Else
            wi = 0
        End If
        si = gSCrop(.crop, st, wi)
        tx = FLD_X + (p Mod FLD_W): ty = FLD_Y + (p \ FLD_W)
        bx = tx * 8: by = ty * 8 + TOPPX
        ripe = (st >= 3 And Not .withered)
        If st >= 2 Then
            For sx = bx + 1 To bx + 6: PBlend sx, by + 7, cShadow, 0.3: Next
        End If
        Blit si, bx, by + 8 - gSprH(si)
        If ripe Then
            If (Int(gTime * 3 + tx * 1.7 + ty * 2.3) Mod 7) = 0 Then
                sx = bx + 1 + ((tx * 3 + ty) Mod 6): sy = by + 8 - gSprH(si) - 1
                PPix sx, sy, cWhite
                PBlend sx - 1, sy + 1, cGoldLight, 0.7: PBlend sx + 1, sy + 1, cGoldLight, 0.7: PBlend sx, sy + 2, cGoldLight, 0.7
            End If
        End If
        If Not .watered And Not gRaining And N(vHour) > 14 And st < 3 And Not .withered Then
            If (Int(gTime * 2) Mod 2) = 0 Then PPix bx + 7, by, cWaterLight
        End If
    End With
End Sub

Private Sub DrawHen(ByVal i As Long)
    Dim si As Long, fl As Long, moving As Boolean, dx As Double, dy As Double
    With gHen(i)
        If .flipped Then
            fl = 1
        Else
            fl = 0
        End If
        dx = .goalX - .hx: dy = .goalY - .hy
        moving = (Not .pecking) And (Sqr(dx * dx + dy * dy) > 0.5)
        If .pecking Then
            If (Int(.anim * 4) Mod 2) = 1 Then
                si = gSHen(fl, 2)
            Else
                si = gSHen(fl, 0)
            End If
        ElseIf moving And (Int(.anim * 6) Mod 2) = 1 Then
            si = gSHen(fl, 1)
        Else
            si = gSHen(fl, 0)
        End If
        ShadowEllipse .hx, .hy - 0.5 + TOPPX, 3.5, 1.2, 0.3
        Blit si, CLng(Int(.hx + 0.5)) - gSprW(si) \ 2, CLng(Int(.hy + 0.5)) + TOPPX - gSprH(si)
    End With
End Sub

Private Sub DrawFarmer()
    Dim wi As Long, si As Long, bob As Long, dx As Long, dy As Long, hx As Long, hy As Long, fl As Long, ph As Boolean
    wi = Int(fWalkT * 8) Mod 4
    If fMoving Then
        si = gSFarmer(fDir, wi + 1)
    Else
        si = gSFarmer(fDir, 0)
    End If
    If fMoving And (wi = 1 Or wi = 3) Then bob = -1
    ShadowEllipse fX, fY - 0.5 + TOPPX, 4, 1.4, 0.32
    Blit si, CLng(Int(fX + 0.5)) - 5, CLng(Int(fY + 0.5)) + TOPPX - gSprH(si) + bob
    If fActT > 0 Then
        DirVec fDir, dx, dy
        hx = CLng(Int(fX + 0.5)) + dx * 6 - 4: hy = CLng(Int(fY + 0.5)) - 9 + dy * 3 + TOPPX
        ph = fActT > 0.15
        If fDir = 2 Then
            fl = 1
        Else
            fl = 0
        End If
        Select Case fAct
            Case 1: Blit gSHoe(fl), hx, hy + IIf(ph, -3, 0)
            Case 2: Blit gSCan(fl), hx, hy
            Case 3: Blit gSBag(fSeed), hx, hy + IIf(ph, -1, 0)
        End Select
    End If
End Sub

' put static objects that stand in front of an entity back on top of it
Private Sub Occlude(ByVal feetY As Long, ByVal x0 As Long, ByVal y0 As Long, ByVal x1 As Long, ByVal y1 As Long)
    Dim i As Long
    For i = 0 To gObjN - 1
        If gObjSortY(i) > feetY Then
            If gObjX(i) <= x1 And gObjX(i) + gObjW(i) - 1 >= x0 And gObjY(i) <= y1 And gObjY(i) + gObjH(i) - 1 >= y0 Then BlitObj i, x0, y0, x1, y1
        End If
    Next
End Sub

Private Sub Render()
    Dim i As Long, cnt As Long, k As Long, j As Long, tmpY As Double, tmpK As Long, tmpR As Long
    Dim dY(0 To 80) As Double, dK(0 To 80) As Long, dR(0 To 80) As Long
    Dim x As Long, y As Long, tx As Long, ty As Long, ttx As Long, tty As Long
    gStage = "render:season"
    LoadSeason gSeasonIdx
    For i = 0 To W * H - 1: gFrame(i) = gBg(i): Next
    gStage = "render:soil"
    DrawSoil
    gStage = "render:pond"
    ' pond shimmer
    If gSeasonIdx <> 3 Then
        Dim slot As Long, hx As Double, hy As Double
        For ty = 0 To MAPR - 1
            For tx = 0 To MAPC - 1
                If gTile(tx, ty) = 2 Then
                    slot = Int(gTime * 1.5 + Hash01(tx, ty, 60) * 10)
                    For k = 0 To 1
                        If Hash01(tx, ty + k, slot) >= 0.55 Then
                            hx = Hash01(tx * 7 + k, slot, 61): hy = Hash01(ty * 5 + k, slot, 62)
                            x = tx * 8 + 2 + Int(hx * 4): y = ty * 8 + 2 + Int(hy * 4) + TOPPX
                            PPix x, y, cWaterLight: PPix x + 1, y, cWaterLight
                        End If
                    Next
                End If
            Next
        Next
    End If
    ' y-sorted dynamic things: 1 crop, 2 egg, 3 hen, 4 farmer
    gStage = "render:sort"
    cnt = 0
    For i = 0 To FLD_W * FLD_H - 1
        If gPlot(i).crop >= 0 Then dY(cnt) = (FLD_Y + i \ FLD_W) * 8 + 7: dK(cnt) = 1: dR(cnt) = i: cnt = cnt + 1
    Next
    For i = 0 To gEggN - 1
        dY(cnt) = gEggY(i) * 8 + 6: dK(cnt) = 2: dR(cnt) = i: cnt = cnt + 1
    Next
    For i = 0 To gHenN - 1
        dY(cnt) = gHen(i).hy: dK(cnt) = 3: dR(cnt) = i: cnt = cnt + 1
    Next
    dY(cnt) = fY: dK(cnt) = 4: dR(cnt) = 0: cnt = cnt + 1
    gStage = "render:isort"
    For i = 1 To cnt - 1
        tmpY = dY(i): tmpK = dK(i): tmpR = dR(i)
        j = i - 1
        Do While j >= 0
            If dY(j) <= tmpY Then Exit Do
            dY(j + 1) = dY(j): dK(j + 1) = dK(j): dR(j + 1) = dR(j)
            j = j - 1
        Loop
        dY(j + 1) = tmpY: dK(j + 1) = tmpK: dR(j + 1) = tmpR
    Next
    For i = 0 To cnt - 1
        gStage = "render:draw" & dK(i)
        Select Case dK(i)
            Case 1: DrawCrop dR(i)
            Case 2: Blit gSEgg, gEggX(dR(i)) * 8 + 2, gEggY(dR(i)) * 8 + 3 + TOPPX
            Case 3: DrawHen dR(i)
            Case 4: DrawFarmer
        End Select
    Next
    gStage = "render:occlude"
    For i = 0 To gHenN - 1
        x = Int(gHen(i).hx): y = Int(gHen(i).hy) + TOPPX
        Occlude y, x - 5, y - 10, x + 5, y + 1
    Next
    x = Int(fX): y = Int(fY) + TOPPX
    Occlude y, x - 8, y - 20, x + 8, y + 1
    ' target cursor on the field
    If Left$(gHint, 2) = "E " And gFade <= 0 Then
        TargetTile ttx, tty
        If PlotIdx(ttx, tty) >= 0 Then
            x = ttx * 8: y = tty * 8 + TOPPX
            PBlend x, y, cCream, 0.9: PBlend x + 1, y, cCream, 0.9: PBlend x, y + 1, cCream, 0.9
            PBlend x + 7, y, cCream, 0.9: PBlend x + 6, y, cCream, 0.9: PBlend x + 7, y + 1, cCream, 0.9
            PBlend x, y + 7, cCream, 0.9: PBlend x + 1, y + 7, cCream, 0.9: PBlend x, y + 6, cCream, 0.9
            PBlend x + 7, y + 7, cCream, 0.9: PBlend x + 6, y + 7, cCream, 0.9: PBlend x + 7, y + 6, cCream, 0.9
        End If
    End If
    ' particles
    For i = 0 To 79
        If gPart(i).life > 0 Then PPix Int(gPart(i).x), Int(gPart(i).y), gPart(i).col
    Next
    ' weather in the air
    Dim sp As Double, wx As Double, wy As Double
    If gRaining Then
        If gSeasonIdx = 3 Then
            For i = 0 To 59
                sp = 8 + Hash01(i, 21, 1) * 10
                wx = Hash01(i, 22, 1) * W + Sin(gTime + i) * 4 + gTime * 4
                wx = wx - Int(wx / W) * W
                wy = Hash01(i, 23, 1) * H + gTime * sp
                wy = wy - Int(wy / H) * H
                PBlend Int(wx), Int(wy), cWhite, 0.9
            Next
        Else
            For i = 0 To 47
                sp = 110 + Hash01(i, 21, 1) * 50
                wx = Hash01(i, 22, 1) * (W + 40) - gTime * sp * 0.25
                wx = wx - Int(wx / (W + 40)) * (W + 40) - 20
                wy = Hash01(i, 23, 1) * H + gTime * sp
                wy = wy - Int(wy / H) * H
                x = Int(wx): y = Int(wy)
                PBlend x, y, cRain, 0.55: PBlend x, y + 1, cRain, 0.55: PBlend x - 1, y + 2, cRain, 0.55
            Next
        End If
    ElseIf gSeasonIdx = 0 Or gSeasonIdx = 2 Then
        For i = 0 To 9
            sp = 6 + Hash01(i, 3, 2) * 6
            wx = Hash01(i, 1, 2) * (W + 30) + gTime * sp
            wx = wx - Int(wx / (W + 30)) * (W + 30) - 15 + Sin(gTime * 2 + i) * 2
            wy = Hash01(i, 2, 2) * H + gTime * sp * 0.8
            wy = wy - Int(wy / H) * H
            If gSeasonIdx = 2 Then
                PPix Int(wx), Int(wy), Choose((i Mod 3) + 1, RGB(224, 138, 58), RGB(192, 88, 46), RGB(242, 192, 96))
            Else
                PPix Int(wx), Int(wy), Choose((i Mod 2) + 1, RGB(244, 184, 200), RGB(255, 240, 244))
            End If
        Next
    End If
    gStage = "render:flush"
    Flush
    gStage = "render:light"
    UpdateLight
    gStage = "render:hud"
    UpdateHud
    gStage = ""
End Sub

' write only the changed cells; runs of the same colour go out as one range
Private Sub Flush()
    Dim y As Long, x As Long, i As Long, c As Long, x2 As Long
    Dim su As Boolean
    gWrites = 0
    If Not gTest Then su = Application.ScreenUpdating: Application.ScreenUpdating = False
    For y = 0 To H - 1
        x = 0
        Do While x < W
            i = y * W + x
            If gFrame(i) <> gShown(i) Then
                c = gFrame(i)
                x2 = x
                Do While x2 + 1 < W
                    If gFrame(i + x2 + 1 - x) <> c Or gShown(i + x2 + 1 - x) = c Then Exit Do
                    x2 = x2 + 1
                Loop
                gWS.Cells(CR0 + y, CC0 + x).Resize(1, x2 - x + 1).Interior.Color = c
                For x = x To x2: gShown(y * W + x) = c: Next
                gWrites = gWrites + 1
            Else
                x = x + 1
            End If
        Loop
    Next
    If Not gTest Then Application.ScreenUpdating = True
End Sub

' ---- HUD (cells above the canvas) ------------------------------------------------
Private Sub SetNamedCell(ByVal nm As String, ByVal v As String)
    On Error Resume Next
    ThisWorkbook.Names(nm).RefersToRange.Value = v
End Sub

Private Sub SetStatus(ByVal s As String)
    gHudStatus = s
    SetNamedCell "HUD_Status", s
End Sub

Private Sub UpdateHud()
    Dim t As String, msg As String
    Select Case fTool
        Case 0: t = "Tool: HOE   (Q to change)"
        Case 1: t = "Tool: WATERING CAN  " & N(vCanWater) & "/" & N(vCanCap)
        Case 2: t = "Tool: SEEDS  " & UCase$(ItemName(fSeed)) & " x" & N(vSeeds(fSeed)) & "   (1-4 to pick)"
    End Select
    If t <> gHudTool Then gHudTool = t: SetNamedCell "HUD_Tool", t
    If gBannerT > 0 Then
        msg = gBanner
    Else
        msg = gHint
    End If
    If msg <> gHudHint Then gHudHint = msg: SetNamedCell "HUD_Hint", msg
    If gOrdersDirty Then Call WriteOrders: gOrdersDirty = False
End Sub

Private Sub WriteOrders()
    On Error Resume Next
    Dim ws As Object, k As Long, j As Long, arr(1 To 12, 1 To 7) As Variant
    Set ws = ThisWorkbook.Worksheets("ORDERS")
    For k = 0 To 11
        If k < gOrdN Then
            arr(k + 1, 1) = gOrd(k).id
            arr(k + 1, 2) = ItemName(gOrd(k).item)
            arr(k + 1, 3) = gOrd(k).qty
            arr(k + 1, 4) = gOrd(k).delivered
            arr(k + 1, 5) = gOrd(k).due
            arr(k + 1, 6) = gOrd(k).reward
            arr(k + 1, 7) = Choose(gOrd(k).status + 1, "OPEN", "DONE", "LATE")
        Else
            For j = 1 To 7: arr(k + 1, j) = "": Next
        End If
    Next
    ws.Range("A2:G13").Value = arr
End Sub

' Column widths are font dependent; make every canvas cell as wide as it is tall.
Private Sub SquareCells()
    On Error Resume Next
    Dim k As Long, cw As Double, rh As Double
    rh = gWS.Rows(CR0).Height
    For k = 1 To 5
        cw = gWS.Columns(CC0).Width
        If cw <= 0 Or Abs(cw - rh) < 0.15 Then Exit For
        gWS.Range(gWS.Columns(CC0), gWS.Columns(CC0 + W - 1)).ColumnWidth = gWS.Columns(CC0).ColumnWidth * rh / cw
    Next
End Sub

Private Sub FitWindow()
    On Error Resume Next
    If Not ActiveSheet Is gWS Then Exit Sub
    gWS.Range(gWS.Cells(1, CC0), gWS.Cells(CR0 + H, CC0 + W - 1)).Select
    ActiveWindow.Zoom = True
    ActiveWindow.ScrollRow = 1
    ActiveWindow.ScrollColumn = 1
    gWS.Range("A1").Select
End Sub

' While playing, the game keys must not type into cells, move the selection or open
' dialogs (F12 is Save As); Application.OnKey with "" swallows them.
Private Sub SwallowKeys(ByVal swallow As Boolean)
    On Error Resume Next
    If gTest Then Exit Sub
    Dim k As Variant, i As Long
    k = Array("w", "a", "s", "d", "e", "q", "r", "1", "2", "3", "4", " ", "{UP}", "{DOWN}", "{LEFT}", "{RIGHT}", "{F12}", "{ESC}", "+w", "+a", "+s", "+d")
    For i = 0 To UBound(k)
        If swallow Then
            Application.OnKey k(i), ""
        Else
            Application.OnKey k(i)
        End If
    Next
End Sub

' ---- light: one translucent sheet over the canvas, plus lamp glows -----------------
Private Sub MakeShapes()
    On Error Resume Next
    Dim r As Object, shp As Object, i As Long
    Set r = gWS.Range(gWS.Cells(CR0, CC0), gWS.Cells(CR0 + H - 1, CC0 + W - 1))
    gCanvasL = r.Left: gCanvasT = r.Top: gCellW = r.Width / W: gCellH = r.Height / H
    For i = gWS.Shapes.Count To 1 Step -1
        If Left$(gWS.Shapes(i).Name, 3) = "fb_" Then gWS.Shapes(i).Delete
    Next
    For i = 0 To gLightN - 1
        Set shp = gWS.Shapes.AddShape(9, gCanvasL + (gLightX(i) - gLightR(i)) * gCellW, gCanvasT + (gLightY(i) - gLightR(i)) * gCellH, 2 * gLightR(i) * gCellW, 2 * gLightR(i) * gCellH)
        shp.Name = "fb_glow" & i
        shp.Line.Visible = 0
        shp.Fill.ForeColor.RGB = gLightC(i)
        shp.Fill.Transparency = 0.75
        shp.SoftEdge.Radius = gLightR(i) * gCellW * 0.8
        shp.Visible = 0
    Next
    Set shp = gWS.Shapes.AddShape(1, gCanvasL, gCanvasT, r.Width, r.Height)
    shp.Name = "fb_night"
    shp.Line.Visible = 0
    shp.Fill.ForeColor.RGB = 0
    shp.Fill.Transparency = 1
    shp.Visible = 0
    ' glows sit above the night sheet so they read as light
    For i = 0 To gLightN - 1: gWS.Shapes("fb_glow" & i).ZOrder 0: Next
    MakeButton
End Sub

Private Sub MakeButton()
    On Error Resume Next
    Dim shp As Object, anchor As Object
    Set anchor = ThisWorkbook.Names("HUD_Button").RefersToRange
    Set shp = gWS.Shapes.AddShape(5, anchor.Left + 2, anchor.Top + 2, anchor.Width - 4, anchor.Height - 4)
    shp.Name = "fb_button"
    shp.OnAction = "FB_Toggle"
    shp.Fill.ForeColor.RGB = RGB(80, 160, 70)
    shp.Line.Visible = 0
    shp.TextFrame2.TextRange.Font.Size = 12
    shp.TextFrame2.TextRange.Font.Bold = True
    shp.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = RGB(255, 255, 255)
    shp.TextFrame2.VerticalAnchor = 3
    shp.TextFrame2.TextRange.ParagraphFormat.Alignment = 2
    SetButton False
End Sub

Private Sub SetButton(ByVal playing As Boolean)
    On Error Resume Next
    If gTest Then Exit Sub
    With gWS.Shapes("fb_button")
        If playing Then
            .TextFrame2.TextRange.Text = ChrW(10074) & ChrW(10074) & "  Pause (Esc)"
            .Fill.ForeColor.RGB = RGB(70, 90, 200)
        Else
            .TextFrame2.TextRange.Text = ChrW(9654) & "  Play"
            .Fill.ForeColor.RGB = RGB(70, 160, 80)
        End If
    End With
End Sub

Private Sub UpdateLight()
    If gTest Then Exit Sub
    On Error Resume Next
    Dim hr As Double, idx As Long, a As Double, c As Long, i As Long, glow As Double, key As Long
    hr = N(vHour)
    idx = Int((hr - gAmbH(0)) / 0.25)
    If idx < 0 Then idx = 0
    If idx > gAmbN - 1 Then idx = gAmbN - 1
    a = gAmbA(idx): c = gAmbC(idx)
    If gRaining Then a = a + 0.12: If a > 0.8 Then a = 0.8
    If gFade > 0 Then
        Dim fa As Double
        If gFade > 0.8 Then
            fa = 1
        Else
            fa = gFade / 0.8
        End If
        If fa > a Then a = fa: c = RGB(16, 12, 18)
        key = 10000 + Int(fa * 20)
    Else
        key = idx * 2 + IIf(gRaining, 1, 0)
    End If
    If key = gAmbIdx Then Exit Sub
    gAmbIdx = key
    With gWS.Shapes("fb_night")
        If a < 0.01 Then
            .Visible = 0
        Else
            .Visible = -1
            .Fill.ForeColor.RGB = c
            .Fill.Transparency = 1 - a
        End If
    End With
    glow = (a - 0.25) * 2.2
    If gFade > 0 Then glow = 0
    For i = 0 To gLightN - 1
        With gWS.Shapes("fb_glow" & i)
            If glow <= 0 Then
                .Visible = 0
            Else
                If glow > 1 Then glow = 1
                .Visible = -1
                .Fill.Transparency = 1 - 0.55 * glow
            End If
        End With
    Next
End Sub

' =============================================================================
' Save / load (hidden sheet _STATE), so a saved .xlsm resumes where you left it
' =============================================================================
Private Sub SaveState()
    If gTest Then Exit Sub
    On Error Resume Next
    Dim ws As Object, s As String, i As Long, y As Long, x As Long, rows(1 To H, 1 To 1) As Variant, ln As String
    Set ws = ThisWorkbook.Worksheets("_STATE")
    ws.Cells(1, 1).Value = "state"
    ws.Cells(2, 1).Value = "farmer": ws.Cells(2, 2).Value = fX & ";" & fY & ";" & fDir & ";" & fTool & ";" & fSeed
    s = ""
    For i = 0 To FLD_W * FLD_H - 1
        With gPlot(i)
            s = s & IIf(.tilled, 1, 0) & ":" & IIf(.watered, 1, 0) & ":" & .crop & ":" & .growth & ":" & .dry & ":" & IIf(.withered, 1, 0) & ":" & .harvests & ";"
        End With
    Next
    ws.Cells(3, 1).Value = "plots": ws.Cells(3, 2).Value = s
    s = ""
    For i = 0 To gEggN - 1: s = s & gEggX(i) & ":" & gEggY(i) & ";": Next
    ws.Cells(4, 1).Value = "eggs": ws.Cells(4, 2).Value = s
    s = ""
    For i = 0 To gOrdN - 1
        With gOrd(i)
            s = s & .id & ":" & .item & ":" & .qty & ":" & .delivered & ":" & .due & ":" & .reward & ":" & .status & ";"
        End With
    Next
    ws.Cells(5, 1).Value = "orders": ws.Cells(5, 2).Value = s
    ws.Cells(6, 1).Value = "nextorder": ws.Cells(6, 2).Value = gNextOrder
    ' what the canvas shows right now (hex BGR per pixel), so reopening needs no repaint
    For y = 0 To H - 1
        ln = ""
        For x = 0 To W - 1: ln = ln & Right$("00000" & Hex$(gShown(y * W + x)), 6): Next
        rows(y + 1, 1) = ln
    Next
    ws.Cells(7, 1).Value = "shown"
    ws.Range(ws.Cells(1, 3), ws.Cells(H, 3)).Value = rows
End Sub

Private Function LoadState() As Boolean
    Dim ws As Object, v As Variant, p As Variant, q As Variant, i As Long, y As Long, x As Long, ln As String
    On Error GoTo Fresh
    Set ws = ThisWorkbook.Worksheets("_STATE")
    ' the canvas as saved: either a plain season background ("painted") or a pixel snapshot
    If CStr(ws.Cells(1, 1).Value) = "painted" Then
        For i = 0 To W * H - 1: gShown(i) = gBg(i): Next
        LoadState = False
        Exit Function
    End If
    If CStr(ws.Cells(1, 1).Value) <> "state" Then GoTo Fresh
    v = ws.Range(ws.Cells(1, 3), ws.Cells(H, 3)).Value
    For y = 0 To H - 1
        ln = CStr(v(y + 1, 1))
        If Len(ln) <> W * 6 Then GoTo Fresh
        For x = 0 To W - 1: gShown(y * W + x) = CLng(Val("&H" & Mid$(ln, x * 6 + 1, 6) & "&")): Next
    Next
    p = Split(CStr(ws.Cells(2, 2).Value), ";")
    fX = Val(p(0)): fY = Val(p(1)): fDir = CLng(p(2)): fTool = CLng(p(3)): fSeed = CLng(p(4))
    p = Split(CStr(ws.Cells(3, 2).Value), ";")
    For i = 0 To FLD_W * FLD_H - 1
        q = Split(p(i), ":")
        With gPlot(i)
            .tilled = (q(0) = "1"): .watered = (q(1) = "1"): .crop = CLng(q(2)): .growth = Val(q(3))
            .dry = CLng(q(4)): .withered = (q(5) = "1"): .harvests = CLng(q(6))
        End With
    Next
    p = Split(CStr(ws.Cells(4, 2).Value), ";")
    gEggN = 0
    For i = 0 To UBound(p)
        If Len(p(i)) > 0 Then q = Split(p(i), ":"): gEggX(gEggN) = CLng(q(0)): gEggY(gEggN) = CLng(q(1)): gEggN = gEggN + 1
    Next
    p = Split(CStr(ws.Cells(5, 2).Value), ";")
    gOrdN = 0
    For i = 0 To UBound(p)
        If Len(p(i)) > 0 Then
            q = Split(p(i), ":")
            With gOrd(gOrdN)
                .id = CLng(q(0)): .item = CLng(q(1)): .qty = CLng(q(2)): .delivered = CLng(q(3)): .due = CLng(q(4)): .reward = CLng(q(5)): .status = CLng(q(6))
            End With
            gOrdN = gOrdN + 1
        End If
    Next
    gNextOrder = CLng(ws.Cells(6, 2).Value)
    gHenN = 0
    SyncFlock
    gOrdersDirty = True
    LoadState = True
    Exit Function
Fresh:
    For i = 0 To W * H - 1: gShown(i) = -2: Next
    LoadState = False
End Function

' =============================================================================
' Test hooks (used by the automated LibreOffice tests; harmless in Excel)
' =============================================================================
Public Function FB_TestBegin(ByVal seed As Long) As String
    On Error GoTo Fail
    gTest = True
    Rnd -1
    Randomize seed
    gInit = False
    InitAll
    ResetGame
    FB_TestBegin = "ok " & gObjN & " objects, " & gSprN & " sprites; " & FB_TestBounds()
    Exit Function
Fail:
    FB_TestBegin = "ERR " & Err.Number & " " & Err.Description & " @" & gStage
End Function

' Hold the given actions (comma list: up,down,left,right,use,tool,sleep,seed1..seed4) for secs.
Public Function FB_TestRun(ByVal keys As String, ByVal secs As Double, Optional ByVal doRender As Boolean = False) As String
    Dim t As Double, dt As Double, i As Long, k As Variant, nm As Variant
    nm = Array("up", "down", "left", "right", "use", "tool", "sleep", "seed1", "seed2", "seed3", "seed4", "pause")
    dt = 1 / 30
    For t = 0 To secs - dt / 2 Step dt
        For i = 0 To A_N - 1: gPrev(i) = gDown(i): gDown(i) = False: Next
        For Each k In Split(keys, ",")
            For i = 0 To A_N - 1
                If nm(i) = Trim$(k) Then gDown(i) = True
            Next
        Next
        Tick dt
        If doRender Then Render
    Next
    For i = 0 To A_N - 1: gPrev(i) = gDown(i): gDown(i) = False: Next
    FB_TestRun = FB_TestState()
End Function

' every pixel the game believes the canvas shows, as hex BGR (6 chars per pixel)
Public Function FB_TestBounds() As String
    On Error Resume Next
    FB_TestBounds = "spr " & UBound(gSprW) & " n" & gSprN & " sprpx " & UBound(gSprPx) & " obj " & UBound(gObjX) & " objpx " & UBound(gObjPx) & " hen " & UBound(gHen) & " bg " & UBound(gBg) & " frame " & UBound(gFrame) & " pal " & UBound(gPal) & " soil " & UBound(gSoil)
End Function

Public Function FB_TestDump() As String
    Dim y As Long, x As Long, parts() As String, ln As String
    ReDim parts(0 To H - 1)
    For y = 0 To H - 1
        ln = ""
        For x = 0 To W - 1: ln = ln & Right$("00000" & Hex$(gShown(y * W + x)), 6): Next
        parts(y) = ln
    Next
    FB_TestDump = Join(parts, "|")
End Function

Public Function FB_TestRender() As Long
    On Error GoTo Fail
    Render
    FB_TestRender = gWrites
    Exit Function
Fail:
    FB_TestRender = -Err.Number
    ThisWorkbook.Worksheets("_STATE").Cells(1, 6).Value = Err.Description & " @" & gStage
End Function

Public Sub FB_TestTeleport(ByVal tx As Long, ByVal ty As Long, ByVal d As Long)
    fX = tx * 8 + 4: fY = ty * 8 + 6: fDir = d
End Sub

Public Sub FB_TestStagePlot(ByVal tx As Long, ByVal ty As Long, ByVal crop As Long, ByVal growthFrac As Double, ByVal watered As Boolean)
    Dim p As Long: p = PlotIdx(tx, ty)
    gPlot(p).tilled = True: gPlot(p).crop = crop: gPlot(p).watered = watered: gPlot(p).withered = False
    If crop >= 0 Then
        gPlot(p).growth = CropDays(crop) * growthFrac
    Else
        gPlot(p).growth = 0
    End If
End Sub

Public Function FB_TestState() As String
    On Error GoTo Fail
    Dim s As String, i As Long, tilled As Long, watered As Long, crops As Long, ripe As Long
    For i = 0 To FLD_W * FLD_H - 1
        If gPlot(i).tilled Then tilled = tilled + 1
        If gPlot(i).watered Then watered = watered + 1
        If gPlot(i).crop >= 0 Then crops = crops + 1
        If IsRipe(i) Then ripe = ripe + 1
    Next
    s = "x=" & Format$(fX, "0.0") & ";y=" & Format$(fY, "0.0") & ";dir=" & fDir & ";tool=" & fTool & ";seed=" & fSeed
    s = s & ";tilled=" & tilled & ";watered=" & watered & ";crops=" & crops & ";ripe=" & ripe
    s = s & ";cash=" & N(vCash) & ";stamina=" & N(vStamina) & ";can=" & N(vCanWater) & ";day=" & N(vDay)
    s = s & ";hour=" & Format$(N(vHour), "0.00") & ";season=" & VStr(vSeason) & ";weather=" & VStr(vWeather)
    s = s & ";eggs=" & gEggN & ";hens=" & gHenN & ";orders=" & gOrdN & ";hint=" & gHint & ";banner=" & gBanner
    For i = 0 To 4: s = s & ";basket" & i & "=" & N(vBasket(i)): Next
    For i = 0 To 3: s = s & ";seeds" & i & "=" & N(vSeeds(i)): Next
    FB_TestState = s
    Exit Function
Fail:
    FB_TestState = "err=" & Err.Number & " " & Err.Description
End Function
