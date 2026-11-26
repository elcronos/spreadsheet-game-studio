"""Runs the Fieldbook VBA game inside headless LibreOffice (VBA compatibility mode) against the
real workbook, plays a scripted day on the farm and checks the results.

    python3 scripts/excel/build_fieldbook_xlsx.py && python3 tests/excel/fieldbook_lo_test.py

LibreOffice cannot run the Windows keyboard API or Excel shapes, so the module's platform block is
swapped for stubs and drawing of the night overlay is skipped (test mode). Everything else, the
game rules, the compositor and the cell painting, is the code that ships.
"""
import os, re, subprocess, sys, time, uno
from com.sun.star.beans import PropertyValue

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
XLSX = os.path.join(ROOT, "dist", "fieldbook-excel", "Fieldbook.xlsx")
BAS = os.path.join(ROOT, "examples", "fieldbook", "excel", "Fieldbook.bas")
OUTDIR = os.environ.get("FB_OUT", "/tmp/fieldbook-lo")
os.makedirs(OUTDIR, exist_ok=True)

def P(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

def test_module():
    src = open(BAS, encoding="latin-1").read()
    src = re.sub(r"^Attribute VB_Name.*\n", "", src, flags=re.M)
    stub = "\n".join([
        "Private Function KeyIsDown(ByVal vk As Long) As Boolean", "    KeyIsDown = False", "End Function",
        "Private Function ExcelHasFocus() As Boolean", "    ExcelHasFocus = True", "End Function",
        "Private Function OnMac() As Boolean", "    OnMac = False", "End Function"])
    src = re.sub(r"'@@PLATFORM_BEGIN.*?'@@PLATFORM_END", stub, src, flags=re.S)
    return "Option VBASupport 1\n" + src

port = 2100 + os.getpid() % 500
proc = subprocess.Popen(["soffice", "--headless", "--invisible", "--norestore", "--nologo", f"-env:UserInstallation=file:///tmp/lo-fb-{port}", f"--accept=socket,host=localhost,port={port};urp;"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)
try:
    ctx = None
    for _ in range(120):
        try:
            local = uno.getComponentContext()
            r = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
            ctx = r.resolve(f"uno:socket,host=localhost,port={port};urp;StarOffice.ComponentContext"); break
        except Exception:
            time.sleep(0.5)
    desk = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desk.loadComponentFromURL(uno.systemPathToFileUrl(XLSX), "_blank", 0, (P("MacroExecutionMode", 4),))
    doc.calculateAll()
    libs = doc.BasicLibraries
    if not libs.hasByName("Standard"): libs.createLibrary("Standard")
    lib = libs.getByName("Standard")
    if lib.hasByName("Fieldbook"): lib.removeByName("Fieldbook")
    lib.insertByName("Fieldbook", test_module())
    sp = doc.getScriptProvider()
    def call(fn, *args):
        s = sp.getScript(f"vnd.sun.star.script:Standard.Fieldbook.{fn}?language=Basic&location=document")
        return s.invoke(tuple(args), (), ())[0]
    def state():
        return dict(kv.split("=", 1) for kv in call("FB_TestState").split(";"))
    sheets = doc.Sheets
    def setcell(sheet, name_, value):
        sh = sheets.getByName(sheet)
        for r in range(1, 60):
            if sh.getCellByPosition(3, r).getString() == name_:
                c = sh.getCellByPosition(1, r)
                if isinstance(value, str): c.setString(value)
                else: c.setValue(value)
                return
        raise KeyError(name_)

    t0 = time.time()
    print("begin:", call("FB_TestBegin", 42)); print("bounds:", call("FB_TestBounds"))
    s = state()
    check(s["day"] == "1" and s["season"] == "Spring" and s["tilled"] == "4", f"new game: day 1, spring, 4 tilled plots ({s['day']},{s['season']},{s['tilled']})")
    check(s["hens"] == "3" and s["orders"] == "3", "three hens and three orders")
    writes = call("FB_TestRender")
    check(0 < writes < 600, f"first frame repaints only what moved ({writes} ranges)")

    # walking and collision
    call("FB_TestTeleport", 8, 6, 3)
    x0 = float(state()["x"])
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "right", 1.0).split(";"))
    check(float(s["x"]) > x0 + 20, f"walks right ({x0} -> {s['x']})")
    call("FB_TestTeleport", 4, 6, 1)
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "up", 2.0).split(";"))
    check(float(s["y"]) > 40, f"the cottage blocks walking north ({s['y']})")

    # till, water, plant on the field (row 8 is the first field row)
    call("FB_TestTeleport", 8, 7, 0)
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(s["tilled"] == "5" and float(s["stamina"]) == 98, f"hoe tills a plot for 2 stamina ({s['tilled']}, {s['stamina']})")
    call("FB_TestRun", "tool", 0.1)
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(s["watered"] == "1" and s["can"] == "7", f"can waters it ({s['watered']}, can {s['can']})")
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "seed1", 0.1).split(";"))
    s = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(s["crops"] == "1" and s["seeds0"] == "9", f"plants a carrot ({s['crops']}, seeds {s['seeds0']})")
    check(s["hint"] in ("", "E HARVEST") or "PLANT" not in s["hint"], f"hint updates ({s['hint']})")

    # three watered nights -> ripe carrot
    for night in range(3):
        call("FB_TestTeleport", 8, 7, 0)
        call("FB_TestRun", "tool", 0.1)   # cycle to the can
        st = state()
        while st["tool"] != "1":
            st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "tool", 0.1).split(";"))
        call("FB_TestRun", "use", 0.1)
        call("FB_TestTeleport", 4, 5, 0)
        st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "sleep", 0.1).split(";"))
    check(st["day"] == "4", f"slept three nights (day {st['day']})")
    check(st["ripe"] == "1", f"the carrot is ripe after three watered nights (ripe {st['ripe']})")
    check("DAY 4" in st["banner"], f"morning banner ({st['banner']})")

    call("FB_TestTeleport", 8, 7, 0)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(st["basket0"] == "1" and st["crops"] == "0", f"harvest puts the carrot in the basket ({st['basket0']})")

    # sell at the stall: price comes from the RULES formula
    price = sheets.getByName("RULES").getCellByPosition(1, 3).getValue()
    cash0 = float(st["cash"])
    call("FB_TestTeleport", 10, 15, 0)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(abs(float(st["cash"]) - cash0 - price) < 0.01 and st["basket0"] == "0", f"stall pays the Price_Carrot formula (${price:.0f}; cash {cash0} -> {st['cash']})")
    sold = [sheets.getByName("MARKET").getCellByPosition(1, r).getValue() for r in range(1, 30) if sheets.getByName("MARKET").getCellByPosition(3, r).getString() == "Sold_Carrot"][0]
    check(sold >= 1, f"each sale raises Sold_Carrot ({sold})")

    # the crate sells seed packs at SeedCost, the well refills the can, the board takes orders
    cash0 = float(st["cash"]); seeds0 = float(st["seeds0"])
    call("FB_TestTeleport", 12, 16, 0)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(float(st["seeds0"]) == seeds0 + 5 and float(st["cash"]) == cash0 - 20, f"crate: buys a pack of 5 carrot seeds at SeedCost_Carrot ({st['banner']})")
    call("FB_TestTeleport", 9, 5, 1)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(st["can"] == "8", f"well refills the can ({st['banner']})")
    setcell("FARMER", "Basket_Egg", 5)
    call("FB_TestTeleport", 7, 16, 0)
    cash0 = float(st["cash"])
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(float(st["cash"]) == cash0 + 60 and st["basket4"] == "0", f"board: five eggs typed into the sheet fill the egg order (+$60, {st['banner']})")
    call("FB_TestRender")
    rows = [sheets.getByName("ORDERS").getCellByPosition(6, r).getString() for r in range(1, 6)]
    check("DONE" in rows and rows.count("OPEN") == 3, f"ORDERS sheet shows the done order and a fresh one ({rows})")
    setcell("FARMER", "Cash", 500)
    call("FB_TestTeleport", 25, 4, 1)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "use", 0.1).split(";"))
    check(float(st["cash"]) == 440 and st["can"] == "14", f"shed: can upgrade costs the UpgradeCost_Can formula ($60) and adds UpgradeSize_Can ({st['banner']})")

    # editing the sheets changes the game: rain waters every tilled plot, season edits wither crops
    call("FB_TestTeleport", 8, 7, 0)
    setcell("FARM", "Weather", "Rain")
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "", 0.1).split(";"))
    check(st["watered"] == st["tilled"], f"Weather = Rain in the sheet waters every plot ({st['watered']}/{st['tilled']})")
    setcell("FARMER", "WalkSpeed", 12)
    x0 = float(st["x"])
    call("FB_TestTeleport", 15, 10, 3)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "down", 0.5).split(";"))
    check(float(st["y"]) - (10 * 8 + 6) > 40, f"WalkSpeed = 12 from the sheet makes the farmer fast ({st['y']})")
    setcell("FARMER", "WalkSpeed", 4.5)

    # passing out at 02:00
    setcell("FARM", "Hour", 25.99)
    st = dict(kv.split("=", 1) for kv in call("FB_TestRun", "", 0.2).split(";"))
    check("PASSED OUT" in st["banner"] and st["day"] == "5", f"02:00 knocks you out ({st['banner']}, day {st['day']})")

    # draw and compare: the canvas cells really hold the colours the game composed
    call("FB_TestTeleport", 9, 12, 0)
    call("FB_TestStagePlot", 6, 10, 2, 1.0, True)
    call("FB_TestStagePlot", 7, 10, 1, 0.6, False)
    call("FB_TestRun", "right", 0.4, True)
    dump = call("FB_TestDump").split("|")
    game = sheets.getByName("FIELDBOOK")
    import random
    random.seed(1)
    bad = 0
    for _ in range(300):
        x, y = random.randrange(256), random.randrange(184)
        want = int(dump[y][x * 6:x * 6 + 6], 16)
        rgb = game.getCellByPosition(x, 7 + y).CellBackColor
        bgr = ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)
        if bgr != want: bad += 1
    check(bad == 0, f"300 sampled canvas cells match the composed frame ({bad} mismatches)")
    from PIL import Image
    im = Image.new("RGB", (256, 184))
    for y, ln in enumerate(dump):
        for x in range(256):
            v = int(ln[x * 6:x * 6 + 6], 16)
            im.putpixel((x, y), (v & 255, (v >> 8) & 255, (v >> 16) & 255))
    im.resize((768, 552), Image.NEAREST).save(os.path.join(OUTDIR, "canvas.png"))
    print(f"canvas -> {OUTDIR}/canvas.png   ({time.time() - t0:.1f}s)")
    # the HUD formulas resolve against the defined names
    hudtxt = [game.getCellByPosition(c, r).getString() for r, c in [(0, 64), (0, 168), (0, 212), (1, 0), (1, 100), (1, 160), (2, 0), (2, 128), (3, 0), (4, 0)]]
    for h in hudtxt: print("   HUD:", h)
    check(hudtxt[0].startswith("Day ") and "$" in hudtxt[2] and "carrot $" in hudtxt[8] and "Err" not in "".join(hudtxt), "HUD formulas evaluate (day, cash, live prices)")
    # a picture of the whole sheet, as a spreadsheet app draws it
    try:
        from com.sun.star.table import CellRangeAddress
        ps = doc.StyleFamilies.getByName("PageStyles").getByName(game.PageStyle)
        ps.IsLandscape = True; ps.Width, ps.Height = 29700, 21000
        ps.ScaleToPagesX = 1; ps.ScaleToPagesY = 1
        ps.LeftMargin = ps.RightMargin = ps.TopMargin = ps.BottomMargin = 300
        ps.HeaderIsOn = False; ps.FooterIsOn = False
        a = CellRangeAddress(); a.Sheet = 0; a.StartColumn = 0; a.StartRow = 0; a.EndColumn = 255; a.EndRow = 192
        game.setPrintAreas((a,))
        for i in range(1, sheets.Count): sheets.getByIndex(i).setPrintAreas(())
        pdf = os.path.join(OUTDIR, "sheet.pdf")
        doc.storeToURL(uno.systemPathToFileUrl(pdf), (P("FilterName", "calc_pdf_Export"), P("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", (P("PageRange", "1"),)))))
        subprocess.run(["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", "1", pdf, os.path.join(OUTDIR, "sheet")], check=True)
        print(f"sheet -> {OUTDIR}/sheet-1.png")
    except Exception as e:
        print("   (sheet picture skipped:", e, ")")
    doc.close(True)
finally:
    proc.terminate()
print(f"\n{len(fails)} failed" if fails else "\nall passed")
sys.exit(1 if fails else 0)
