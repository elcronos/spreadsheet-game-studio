"""Builds Fieldbook for Excel: a workbook whose cells are the game's pixels.

    npx tsx scripts/excel/export-fieldbook-assets.ts      # art -> assets.json
    python3 scripts/excel/build_fieldbook_xlsx.py          # -> dist/fieldbook-excel/

Output: Fieldbook.xlsx (opens showing the farm, with every variable and price formula
live in its sheets) and Fieldbook.bas (the game, imported once into the workbook).
"""
import json, os, shutil, sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "examples", "fieldbook", "excel")
OUT = os.path.join(ROOT, "dist", "fieldbook-excel")
A = json.load(open(os.path.join(SRC, "assets.json")))
W, H, CR0 = A["width"], A["height"], 8
ALPHA = A["alphabet"]
SEASONS = ["Spring", "Summer", "Autumn", "Winter"]

def bgr(rgb):
    return ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)

def hexrgb(rgb):
    return "FF%06X" % rgb

def decode(s):
    pal = A["palette"]
    return [None if s[i:i + 2] == ".." else pal[ALPHA.index(s[i]) * 64 + ALPHA.index(s[i + 1])] for i in range(0, len(s), 2)]

wb = Workbook()
names = {}
def name(nm, ref):
    dn = DefinedName(nm, attr_text=ref)
    wb.defined_names[nm] = dn
    names[nm] = ref

INK = "2B1D16"
HEAD = Font(name="Calibri", bold=True, color="FFFFFF", size=11)
HEAD_FILL = PatternFill("solid", fgColor="3B2A20")
thin = Side(style="thin", color="D9CBB0")

# ---- variable sheets ---------------------------------------------------------------
VAR_NAMES = {"farm.season": "Season", "farm.weather": "Weather"}
TINT = {"FARMER": "FFF8E1", "FARM": "F1F8E9", "MARKET": "E3F2FD", "RULES": "FCE4EC"}
var_sheets = {}

def sheet_header(ws, cols, widths):
    for i, (c, w) in enumerate(zip(cols, widths), 1):
        cell = ws.cell(row=1, column=i, value=c)
        cell.font = HEAD
        cell.fill = HEAD_FILL
        ws.column_dimensions[L(i)].width = w
    ws.freeze_panes = "A2"

game = wb.active
game.title = "FIELDBOOK"
for sh in ["FARMER", "FARM", "MARKET"]:
    ws = wb.create_sheet(sh)
    ws.sheet_properties.tabColor = TINT[sh]
    sheet_header(ws, ["Variable", "Value", "Unit", "Name", "Default", "What it does", "Changes in play"], [30, 14, 8, 18, 10, 64, 14])
    var_sheets[sh] = ws
rows_used = {k: 1 for k in var_sheets}
dv_season = DataValidation(type="list", formula1='"Spring,Summer,Autumn,Winter"', allow_blank=False)
dv_weather = DataValidation(type="list", formula1='"Sunny,Rain"', allow_blank=False)
var_sheets["FARM"].add_data_validation(dv_season)
var_sheets["FARM"].add_data_validation(dv_weather)

for v in A["variables"]:
    ws = var_sheets[v["sheet"]]
    r = rows_used[v["sheet"]] + 1
    rows_used[v["sheet"]] = r
    nm = v.get("name") or VAR_NAMES[v["key"]]
    ws.cell(row=r, column=1, value=v["label"])
    val = ws.cell(row=r, column=2)
    if v.get("readOnly"):
        if nm == "SeasonNo":
            val.value = '=MATCH(Season,{"Spring","Summer","Autumn","Winter"},0)'
        val.fill = PatternFill("solid", fgColor="EEEEEE")
    else:
        val.value = v["default"]
        val.fill = PatternFill("solid", fgColor=TINT[v["sheet"]])
    val.font = Font(bold=True, color=INK)
    val.alignment = Alignment(horizontal="right")
    ws.cell(row=r, column=3, value=v.get("unit", ""))
    ws.cell(row=r, column=4, value=nm).font = Font(name="Consolas", color="7A5A42")
    ws.cell(row=r, column=5, value=v["default"]).font = Font(color="999999")
    ws.cell(row=r, column=6, value=v.get("description", "")).font = Font(color="555555")
    ws.cell(row=r, column=7, value="live" if v.get("live") and not v.get("readOnly") else ("formula" if v.get("readOnly") else "")).font = Font(color="999999", italic=True)
    if nm == "Season":
        dv_season.add(val)
    if nm == "Weather":
        dv_weather.add(val)
    name(nm, f"{v['sheet']}!$B${r}")

# ---- RULES --------------------------------------------------------------------------
rules = wb.create_sheet("RULES")
rules.sheet_properties.tabColor = TINT["RULES"]
sheet_header(rules, ["Rule", "Value", "Formula (edit column B to change the game)", "What it does"], [22, 12, 64, 60])
for i, rdef in enumerate(A["rules"], 2):
    rules.cell(row=i, column=1, value=rdef["name"]).font = Font(name="Consolas", bold=True, color="7A5A42")
    c = rules.cell(row=i, column=2, value=rdef["formula"])
    c.font = Font(bold=True, color=INK)
    c.fill = PatternFill("solid", fgColor=TINT["RULES"])
    t = rules.cell(row=i, column=3, value=rdef["formula"])
    t.data_type = "s"
    t.font = Font(name="Consolas", color="555555")
    rules.cell(row=i, column=4, value=rdef.get("description", "")).font = Font(color="555555")
    name(rdef["name"], f"RULES!$B${i}")

# ---- ORDERS ---------------------------------------------------------------------------
orders = wb.create_sheet("ORDERS")
orders.sheet_properties.tabColor = "EDE7F6"
sheet_header(orders, ["#", "Item", "Qty", "Delivered", "Due day", "Reward $", "Status"], [6, 12, 8, 11, 10, 11, 10])
for i, (item, qty, due, rew) in enumerate([("Carrot", 8, 5, 140), ("Egg", 5, 6, 60), ("Cabbage", 4, 9, 150)], 2):
    for j, v in enumerate([i - 1, item, qty, 0, due, rew, "OPEN"], 1):
        orders.cell(row=i, column=j, value=v)

# ---- HOW TO PLAY ------------------------------------------------------------------------
how = wb.create_sheet("HOW TO PLAY")
how.sheet_properties.tabColor = "F2C94C"
how.column_dimensions["A"].width = 4
how.column_dimensions["B"].width = 110
text = [
    ("FIELDBOOK for Excel", 20, True),
    ("A real-time farming game. Every cell of the FIELDBOOK sheet is one pixel.", 12, False),
    ("", 11, False),
    ("ONE-TIME SETUP (about 30 seconds)", 13, True),
    ("1.  Put Fieldbook.bas next to this workbook (it comes with it).", 11, False),
    ("2.  Windows: press Alt+F11.   Mac: Tools > Macro > Visual Basic Editor.", 11, False),
    ("3.  In the editor: File > Import File...  and choose Fieldbook.bas. Close the editor.", 11, False),
    ("4.  File > Save As > Excel Macro-Enabled Workbook (*.xlsm). Reopen it if Excel asks, and enable macros.", 11, False),
    ("5.  Go to the FIELDBOOK sheet. Press Alt+F8 (Mac: Tools > Macro > Macros), choose FB_Play, Run.", 11, False),
    ("    From then on there is a Play / Pause button on the sheet, and F12 toggles play.", 11, False),
    ("", 11, False),
    ("CONTROLS", 13, True),
    ("W A S D or arrow keys     walk", 11, False),
    ("E or Space               use the tool on the tile in front; sell at the stall, buy seeds at the crate,", 11, False),
    ("                         upgrade the can at the shed, refill at the well or pond, deliver at the order board", 11, False),
    ("Q                        cycle the tool: hoe, watering can, seeds", 11, False),
    ("1 2 3 4                  pick carrot, tomato, pumpkin or cabbage seeds", 11, False),
    ("R                        sleep (stand on the cottage doorstep)", 11, False),
    ("Esc or F12               pause. While paused you can edit any sheet; press Play to carry on", 11, False),
    ("", 11, False),
    ("THE LOOP", 13, True),
    ("Till the soil inside the fenced field, plant seeds, water them, sleep. A watered plot grows each night.", 11, False),
    ("Sell at the market stall: every unit is priced by the Price_ formulas on RULES at the moment of sale,", 11, False),
    ("and each sale lowers demand, so spread your sales. Orders on the ORDERS sheet pay a lump sum.", 11, False),
    ("Hens lay eggs in the pen each morning: walk over them to collect. You pass out at 02:00.", 11, False),
    ("", 11, False),
    ("CHANGE THE GAME FROM THE SHEETS", 13, True),
    ("FARMER, FARM and MARKET hold the variables (walk speed, day length, rain chance, prices...).", 11, False),
    ("RULES holds the formulas. Try: Season = Winter.  Weather = Rain.  Price_Pumpkin = 500.  WalkSpeed = 12.", 11, False),
    ("", 11, False),
    ("NOTES", 13, True),
    ("Windows Excel reads the keyboard directly. On a Mac, keys go through Application.OnKey, which has no", 11, False),
    ("key-up event, so walking is a little less smooth; it is the experimental path.", 11, False),
    ("The art is drawn by the same renderer as the browser edition. Spreadsheet Game Studio, MIT licence.", 11, False),
]
for i, (t, size, bold) in enumerate(text, 2):
    c = how.cell(row=i, column=2, value=t)
    c.font = Font(name="Consolas" if t.startswith(("W A S D", "E or", "Q ", "1 2", "R ", "Esc", "   ")) else "Calibri", size=size, bold=bold, color=INK)
how.sheet_view.showGridLines = False

# ---- FIELDBOOK: HUD + canvas ----------------------------------------------------------------
game.sheet_view.showGridLines = False
game.sheet_view.showRowColHeaders = False
game.sheet_view.zoomScale = 100
for c in range(1, W + 1):
    game.column_dimensions[L(c)].width = 0.33
for r in range(1, 8):
    game.row_dimensions[r].height = 22
game.row_dimensions[5].height = 30
game.row_dimensions[6].height = 18
game.row_dimensions[7].height = 6
for r in range(CR0, CR0 + H):
    game.row_dimensions[r].height = 3
game.row_dimensions[CR0 + H].height = 6
game.row_dimensions[CR0 + H + 1].height = 20

HUD_BG = PatternFill("solid", fgColor="3B2A20")
def hud(row, c0, c1, value, size=12, bold=False, color="FFF4DC", align="left", nm=None, fill=HUD_BG):
    rng = f"{L(c0)}{row}:{L(c1)}{row}"
    game.merge_cells(rng)
    cell = game.cell(row=row, column=c0, value=value)
    cell.font = Font(name="Calibri", size=size, bold=bold, color=color)
    cell.alignment = Alignment(horizontal=align, vertical="center", indent=1)
    for c in range(c0, c1 + 1):
        game.cell(row=row, column=c).fill = fill
    if nm == "HUD_Button":
        name(nm, f"FIELDBOOK!${L(c0)}${row}:${L(c1)}${row}")
    elif nm:
        name(nm, f"FIELDBOOK!${L(c0)}${row}")

hud(1, 1, 64, "FIELDBOOK", 16, True, "F2C94C")
hud(1, 65, 168, '="Day "&Day&"     "&Season&"     "&TEXT(MOD(INT(Hour),24),"00")&":"&TEXT(INT((Hour-INT(Hour))*6)*10,"00")', 14, True)
hud(1, 169, 212, '=IF(Weather="Rain",IF(Season="Winter","Snowing","Raining"),"Sunny")', 12)
hud(1, 213, 256, '="$"&TEXT(Cash,"#,##0")', 16, True, "F2C94C", "right")
hud(2, 1, 100, '="Stamina  "&REPT("' + "█" + '",ROUND(16*MIN(1,Stamina/MaxStamina),0))&REPT("' + "░" + '",16-ROUND(16*MIN(1,Stamina/MaxStamina),0))&"  "&ROUND(Stamina,0)', 11)
hud(2, 101, 160, '="Can  "&CanWater&" / "&CanCapacity&"   (level "&CanLevel&")"', 11)
hud(2, 161, 256, "Tool: HOE   (Q to change)", 11, True, "FFE9A0", nm="HUD_Tool")
hud(3, 1, 128, '="Seeds    carrot "&Seeds_Carrot&"   tomato "&Seeds_Tomato&"   pumpkin "&Seeds_Pumpkin&"   cabbage "&Seeds_Cabbage', 11)
hud(3, 129, 256, '="Basket    "&Basket_Carrot&" carrot   "&Basket_Tomato&" tomato   "&Basket_Pumpkin&" pumpkin   "&Basket_Cabbage&" cabbage   "&Basket_Egg&" egg"', 11)
hud(4, 1, 256, '="Market now (RULES formulas):   carrot $"&Price_Carrot&"   tomato $"&Price_Tomato&"   pumpkin $"&Price_Pumpkin&"   cabbage $"&Price_Cabbage&"   egg $"&Price_Egg&"      can upgrade $"&UpgradeCost_Can', 11, False, "D6C7AB")
hud(5, 1, 200, "To play: see the HOW TO PLAY tab (import Fieldbook.bas once), then press Play.", 13, True, "FFF4DC", nm="HUD_Hint", fill=PatternFill("solid", fgColor="5A4030"))
hud(5, 201, 256, "", 12, True, "FFFFFF", "center", nm="HUD_Button", fill=PatternFill("solid", fgColor="5A4030"))
hud(6, 1, 256, "Paused. WASD walk, E use, Q tool, 1-4 seeds, R sleep, Esc pause. Edit FARMER / FARM / MARKET / RULES while paused.", 10, False, "B8A890", nm="HUD_Status", fill=PatternFill("solid", fgColor="2B1D16"))
for c in range(1, W + 1):
    game.cell(row=7, column=c).fill = PatternFill("solid", fgColor="2B1D16")
    game.cell(row=CR0 + H, column=c).fill = PatternFill("solid", fgColor="2B1D16")
game.merge_cells(f"A{CR0 + H + 1}:{L(W)}{CR0 + H + 1}")
foot = game.cell(row=CR0 + H + 1, column=1, value="Fieldbook  -  Spreadsheet Game Studio  -  every cell above is one pixel. Art and rules shared with the browser edition.")
foot.font = Font(size=9, color="8A7764", italic=True)

# canvas: paint the spring farm so the workbook opens on it
fills = {}
bgrows = A["seasons"]["Spring"]["bg"]
for y, row in enumerate(bgrows):
    for x, c in enumerate(decode(row)):
        f = fills.get(c)
        if f is None:
            f = fills[c] = PatternFill("solid", fgColor=hexrgb(c))
        game.cell(row=CR0 + y, column=1 + x).fill = f

# ---- _ASSETS ----------------------------------------------------------------------------
assets = wb.create_sheet("_ASSETS")
arow = [0]
def put(key, meta, data):
    arow[0] += 1
    r = arow[0]
    assets.cell(row=r, column=1, value=key)
    if meta != "":
        assets.cell(row=r, column=2, value=meta).data_type = "s"
    c = assets.cell(row=r, column=3, value=data)
    c.data_type = "s"
    if len(str(data)) > 32000:
        raise SystemExit(f"cell too long: {key}")

put("palette", len(A["palette"]), ",".join(str(bgr(c)) for c in A["palette"]))
col = A["colors"]
put("colors", "cream,shadow,waterLight,goldLight", ",".join(str(bgr(col[k])) for k in ["cream", "shadow", "waterLight", "goldLight"]))
f = A["field"]
put("field", f"{f['x']},{f['y']},{f['w']},{f['h']}", "")
for s in SEASONS:
    for y, row in enumerate(A["seasons"][s]["bg"]):
        put(f"bg|{s}|{y}", "", row)
for s in SEASONS:
    for i, o in enumerate(A["seasons"][s]["objects"]):
        put(f"obj|{s}|{i}", f"{o['base']},{o['x']},{o['y']},{o['w']},{o['h']}", o["px"])
for nm, sp in A["sprites"].items():
    put(f"spr|{nm}", f"{sp['w']},{sp['h']}", sp["px"])
for t in ["dry", "wet", "frost"]:
    for kind in ["normal", "edge"]:
        for y, row in enumerate(A["soil"][t][kind]):
            put(f"soil|{t}|{kind}|{y}", "", row)
for ty, row in enumerate(A["map"]["tiles"]):
    put(f"tiles|{ty}", A["map"]["propKinds"][ty], row)
put("ambient", "hour:colorBGR:alpha", ";".join(f"{a['hour']}:{bgr(a['color'])}:{a['alpha']}" for a in A["ambient"]))
put("lights", "x:y:r:colorBGR", ";".join(f"{l['x']}:{l['y']}:{l['r']}:{bgr(l['color'])}" for l in A["lights"]))
assets.sheet_state = "hidden"

state = wb.create_sheet("_STATE")
state.cell(row=1, column=1, value="painted")
state.cell(row=1, column=2, value="Spring")
state.sheet_state = "hidden"

wb.calculation.fullCalcOnLoad = True
os.makedirs(OUT, exist_ok=True)
xlsx = os.path.join(OUT, "Fieldbook.xlsx")
wb.save(xlsx)
# the VBA editor's Import File expects Windows line endings and ANSI text
bas = open(os.path.join(SRC, "Fieldbook.bas"), encoding="ascii").read().replace("\r\n", "\n").replace("\n", "\r\n")
for d in [OUT, os.path.join(ROOT, "downloads")]:
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "Fieldbook.bas"), "w", encoding="ascii", newline="") as fh:
        fh.write(bas)
shutil.copy(xlsx, os.path.join(ROOT, "downloads", "Fieldbook.xlsx"))
print(f"wrote {xlsx} ({os.path.getsize(xlsx) // 1024} KB), {arow[0]} asset rows, {len(fills)} fills")
