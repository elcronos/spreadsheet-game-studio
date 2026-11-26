#!/usr/bin/env python3
"""
Build the Quayside city model from real OpenStreetMap data (Elizabeth Quay, Perth).

Input : examples/quayside/data/osm-eq.txt   (Overpass export, compact; © OpenStreetMap contributors, ODbL)
Output: examples/quayside/data/city.json     buildings, roads, piers, trees, landmarks (local metres)
        examples/quayside/data/ground.png    1 m/px ground classes (indexed PNG, see CLASSES)
        examples/quayside/data/preview.png   coloured preview for humans

Coordinates: x = metres east, y = metres north of lat -31.96225, lon 115.8560.
"""
import json, math, re, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, LineString, Point
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "examples/quayside/data/osm-eq.txt"
OUT = ROOT / "examples/quayside/data"

X0, X1, Y0, Y1 = -1227, 1227, -1354, 1355   # bbox in metres
RES = 1.0                                      # metres per ground pixel
W, H = int((X1 - X0) / RES), int((Y1 - Y0) / RES)

CLASSES = {  # id: (name, preview colour)
    0: ("urban", (196, 190, 178)),      # default paved/urban ground
    1: ("water", (40, 92, 120)),
    2: ("grass", (104, 150, 72)),
    3: ("wood", (66, 108, 52)),
    4: ("sand", (222, 204, 160)),
    5: ("road", (62, 64, 68)),
    6: ("road_major", (54, 56, 60)),
    7: ("path", (176, 166, 150)),
    8: ("plaza", (150, 146, 140)),      # promenades, pedestrian areas
    9: ("pier", (128, 98, 70)),         # timber decks over water
    10: ("rail", (90, 84, 78)),
    11: ("building", (120, 120, 126)),  # footprint (for the Excel engine and collisions)
    12: ("bridge", (110, 110, 112)),    # road deck over water
    13: ("footbridge", (150, 140, 128)),  # footbridge deck over water: walkable, boats pass under
}
LANE = 3.4
DEFAULT_LANES = {"motorway": 3, "trunk": 2, "primary": 2, "secondary": 2, "tertiary": 2, "residential": 2, "unclassified": 2,
                 "motorway_link": 1, "trunk_link": 1, "primary_link": 1, "secondary_link": 1, "service": 1, "living_street": 2}
PATH_W = {"footway": 2.6, "cycleway": 2.6, "path": 2.0, "pedestrian": 5.0, "steps": 2.0, "corridor": 0}
HERITAGE = re.compile(r"court|government|mint|treasury|town hall|cathedral|church|post office|police station|old |museum|house$|hale|parliament|barracks|palace hotel|windsor", re.I)


def parse_points(s):
    """First point absolute, then deltas; '|' marks a gap (points outside the bbox)."""
    out, cur, px, py = [], [], None, None
    for t in s.split(" "):
        if t == "|":
            if cur:
                out.append(cur)
                cur = []
            continue
        if not t:
            continue
        dx, dy = map(int, t.split(","))
        if px is None:
            px, py = dx, dy
        else:
            px, py = px + dx, py + dy
        cur.append((px, py))
    if cur:
        out.append(cur)
    return out


def num(s, default=None):
    m = re.match(r"\s*([0-9.]+)", s or "")
    return float(m.group(1)) if m else default


def to_px(x, y):
    return ((x - X0) / RES, (Y1 - y) / RES)


lines = SRC.read_text().split("\n")[1:]
buildings, parts, roads, areas, nodes, water_edges, rel = [], [], [], [], [], [], None
for l in lines:
    f = l.split("|")
    t = f[0]
    if t == "B":
        pts = parse_points("|".join(f[11:]))
        if not pts or len(pts[0]) < 4:
            continue
        rec = dict(kind=f[1], h=num(f[2]), minh=num(f[3], 0.0), lv=num(f[4]), minlv=num(f[5]), type=f[6], name=f[7], roof=f[8], colour=f[9], material=f[10], ring=pts[0])
        (buildings if f[1] == "b" else parts).append(rec)
    elif t == "H":
        pts = parse_points("|".join(f[10:]))
        roads.append(dict(hw=f[1], name=f[2], lanes=num(f[3]), oneway=f[4], bridge=f[5], tunnel=f[6], layer=f[7], width=num(f[8]), sub=f[9], pts=pts))
    elif t == "A":
        areas.append(dict(tag=f[1], name=f[2], layer=f[3], bridge=f[4], pts=parse_points("|".join(f[5:]))))
    elif t == "N":
        x, y = map(int, f[3].split(","))
        nodes.append(dict(tag=f[1], name=f[2], x=x, y=y, h=num(f[4])))
    elif t == "R":
        rel = dict(tag=f[1], name=f[2], h=num(f[3]), lv=num(f[4]), minh=num(f[5]))
        if rel["tag"].startswith("natural=water"):
            rel["water"] = True
    elif t == "M" and rel is not None:
        pts = parse_points("|".join(f[2:]))
        if rel.get("water"):
            water_edges.extend(pts)
        elif rel["tag"].startswith("building") and f[1] == "outer" and pts and len(pts[0]) >= 4:
            buildings.append(dict(kind="b", h=rel["h"], minh=rel["minh"] or 0.0, lv=rel["lv"], minlv=None, type=rel["tag"].split("=")[1], name=rel["name"], roof="", colour="", material="", ring=pts[0]))

print(f"parsed {len(buildings)} buildings, {len(parts)} parts, {len(roads)} roads, {len(areas)} areas, {len(nodes)} nodes, {len(water_edges)} water edges")

# ---------------------------------------------------------------------------------------- ground raster
img = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(img)


def poly_px(ring):
    return [to_px(x, y) for x, y in ring]


# water: shorelines as barriers, then flood fill from mid-river
barrier = Image.new("L", (W, H), 0)
bd = ImageDraw.Draw(barrier)
for e in water_edges:
    if len(e) >= 2:
        bd.line(poly_px(e), fill=255, width=3)
closed_water = []
for a in areas:
    if a["tag"] == "natural=water":
        for e in a["pts"]:
            if len(e) >= 2:
                bd.line(poly_px(e), fill=255, width=3)
            if len(e) >= 4 and e[0] == e[-1]:
                closed_water.append(e)
seeds = [(0, -400), (-950, -1150)]
for sx, sy in seeds:
    px, py = map(int, to_px(sx, sy))
    if barrier.getpixel((px, py)) == 0:
        ImageDraw.floodfill(barrier, (px, py), 128, thresh=0)
wm = np.array(barrier)
water = wm == 128
# barrier pixels between two water pixels are water too (the shoreline itself)
shore = wm == 255
nb = np.zeros_like(water)
nb[1:, :] |= water[:-1, :]; nb[:-1, :] |= water[1:, :]; nb[:, 1:] |= water[:, :-1]; nb[:, :-1] |= water[:, 1:]
water |= shore & nb
for e in closed_water:
    ImageDraw.Draw(m := Image.new("L", (W, H), 0)).polygon(poly_px(e), fill=1)
    water |= np.array(m) == 1
print(f"water: {water.mean() * 100:.1f}% of the area")

g = np.zeros((H, W), np.uint8)
g[water] = 1


def fill_polys(cls, rings, mask_only_land=False):
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    for r in rings:
        if len(r) >= 3:
            md.polygon(poly_px(r), fill=1)
    sel = np.array(m) == 1
    if mask_only_land:
        sel &= g != 1
    g[sel] = cls


def stroke(cls, polylines, width, only_land=False):
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    for pl in polylines:
        if len(pl) >= 2:
            md.line(poly_px(pl), fill=1, width=max(1, int(round(width / RES))), joint="curve")
            r = width / RES / 2
            for p in poly_px(pl):
                md.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=1)
    sel = np.array(m) == 1
    if only_land:
        sel &= g != 1
    g[sel] = cls


area_cls = {"landuse=grass": 2, "leisure=park": 2, "leisure=garden": 2, "leisure=pitch": 2, "landuse=recreation_ground": 2, "leisure=playground": 2,
            "natural=wood": 3, "natural=scrub": 3, "natural=beach": 4, "natural=sand": 4}
for key in ["leisure=park", "landuse=recreation_ground", "landuse=grass", "leisure=garden", "leisure=pitch", "leisure=playground", "natural=scrub", "natural=wood", "natural=beach", "natural=sand"]:
    fill_polys(area_cls[key], [r for a in areas if a["tag"] == key for r in a["pts"] if len(r) >= 4 and r[0] == r[-1]], mask_only_land=True)

stroke(10, [p for a in areas if a["tag"] == "railway=rail" for p in a["pts"]], 4, only_land=True)
for r in roads:
    if r["tunnel"] in ("yes", "building_passage") or r["layer"].startswith("-"):
        continue
    hw = r["hw"]
    if hw in PATH_W:
        if PATH_W[hw] and r["sub"] != "crossing":
            if r["bridge"] == "yes":
                m = Image.new("L", (W, H), 0)
                md = ImageDraw.Draw(m)
                for pl in r["pts"]:
                    if len(pl) >= 2:
                        md.line(poly_px(pl), fill=1, width=max(1, int(round(PATH_W[hw] + 1))))
                sel = np.array(m) == 1
                g[sel & (g == 1)] = 13
                g[sel & (g != 13)] = 7
            else:
                stroke(7 if hw != "pedestrian" else 8, r["pts"], PATH_W[hw], only_land=True)
for r in roads:
    if r["tunnel"] in ("yes", "building_passage") or r["layer"].startswith("-"):
        continue
    hw = r["hw"]
    if hw in DEFAULT_LANES:
        lanes = r["lanes"] or DEFAULT_LANES[hw]
        w = r["width"] or (lanes * LANE + (0 if r["oneway"] == "yes" else 0))
        cls = 6 if hw in ("motorway", "trunk", "primary", "motorway_link", "trunk_link", "primary_link") else 5
        if r["bridge"] == "yes":
            # road over water: draw the deck as bridge class everywhere it crosses water
            m = Image.new("L", (W, H), 0)
            md = ImageDraw.Draw(m)
            for pl in r["pts"]:
                if len(pl) >= 2:
                    md.line(poly_px(pl), fill=1, width=max(1, int(round(w / RES))))
            sel = np.array(m) == 1
            g[sel & (g == 1)] = 12
            g[sel & (g != 12)] = cls
        else:
            stroke(cls, r["pts"], w, only_land=True)
# pedestrian areas (closed pedestrian ways) and squares
fill_polys(8, [p for r in roads if r["hw"] == "pedestrian" for p in r["pts"] if len(p) >= 4 and p[0] == p[-1]], mask_only_land=True)
# piers: polygons fill, lines stroke 4 m (over water too)
pier_rings = [r for a in areas if a["tag"] == "man_made=pier" for r in a["pts"] if len(r) >= 4 and r[0] == r[-1]]
pier_lines = [r for a in areas if a["tag"] == "man_made=pier" for r in a["pts"] if not (len(r) >= 4 and r[0] == r[-1])]
fill_polys(9, pier_rings)
stroke(9, pier_lines, 4)
fill_polys(9, [r for a in areas if a["tag"] == "man_made=breakwater" for r in a["pts"] if len(r) >= 3])

# ---------------------------------------------------------------------------------------- buildings
def height_of(b, default):
    if b["h"]:
        return b["h"]
    if b["lv"]:
        return b["lv"] * 3.4 + 1.5
    return default


def clean_poly(ring):
    try:
        p = Polygon(ring)
        if not p.is_valid:
            p = make_valid(p)
            if p.geom_type != "Polygon":
                p = max([g for g in getattr(p, "geoms", [p]) if g.geom_type == "Polygon"], key=lambda g: g.area, default=None)
        if p is None or p.area < 6:
            return None
        return p.simplify(0.4, preserve_topology=True)
    except Exception:
        return None


part_polys = []
for pt in parts:
    p = clean_poly(pt["ring"])
    if p is not None:
        part_polys.append((p, pt))
out_b = []


def kind_of(name, typ, h):
    if HERITAGE.search(name or "") or typ in ("church", "cathedral", "government", "civic"):
        return "heritage"
    if typ in ("house", "detached", "terrace", "residential", "apartments") and h < 40:
        return "residential"
    if h >= 70:
        return "tower"
    if h >= 24:
        return "office"
    if typ in ("roof", "shed", "kiosk", "service", "transportation"):
        return "pavilion"
    return "low"


for b in buildings:
    p = clean_poly(b["ring"])
    if p is None:
        continue
    inside = [pp for pp, _ in part_polys if p.buffer(0.5).contains(pp.representative_point())]
    h = height_of(b, 6.0 if b["type"] in ("house", "detached", "roof", "shed") else 9.0)
    if inside and sum(pp.area for pp in inside) > 0.4 * p.area:
        # modelled with building:parts: keep the outline only as a low podium if parts start above ground
        continue
    out_b.append(dict(poly=p, h=h, minh=b["minh"] or (b["minlv"] or 0) * 3.4, name=b["name"], type=b["type"], roof=b["roof"]))
for pp, pt in part_polys:
    h = height_of(pt, 9.0)
    out_b.append(dict(poly=pp, h=h, minh=pt["minh"] or (pt["minlv"] or 0) * 3.4, name=pt["name"], type=pt["type"] or "part", roof=pt["roof"]))
# footprints into the raster (on land and piers)
bm = Image.new("L", (W, H), 0)
bmd = ImageDraw.Draw(bm)
for b in out_b:
    if b["minh"] < 4 and b["h"] > 2.5:
        bmd.polygon(poly_px(list(b["poly"].exterior.coords)), fill=1)
g[(np.array(bm) == 1)] = 11

# ---------------------------------------------------------------------------------------- landmarks and extras
def node(tagname, name=None):
    for n in nodes:
        if n["tag"] == tagname and (name is None or n["name"] == name):
            return n
    return None


bridge_way = next(r for r in roads if r["name"] == "Elizabeth Quay Bridge")
ferry_route = next(a for a in areas if a["tag"] == "route=ferry" and a["name"] == "South Perth Ferry")
bell = next(b for b in out_b if b["name"] == "The Bell Tower")
landmarks = {
    "spanda": {"x": node("tourism=artwork", "Spanda")["x"], "y": node("tourism=artwork", "Spanda")["y"]},
    "firstContact": {"x": node("tourism=artwork", "First Contact")["x"], "y": node("tourism=artwork", "First Contact")["y"]},
    "eqFerry": {"x": node("amenity=ferry_terminal", "Elizabeth Quay Ferry Terminal")["x"], "y": node("amenity=ferry_terminal", "Elizabeth Quay Ferry Terminal")["y"]},
    "mendsFerry": {"x": node("amenity=ferry_terminal", "Mends Street Jetty")["x"], "y": node("amenity=ferry_terminal", "Mends Street Jetty")["y"]},
    "barrackJetty": {"x": node("amenity=ferry_terminal", "Barrack Street Jetty")["x"], "y": node("amenity=ferry_terminal", "Barrack Street Jetty")["y"]},
    "bellTower": {"x": round(bell["poly"].centroid.x, 1), "y": round(bell["poly"].centroid.y, 1), "h": bell["h"]},
    "eqBridge": {"pts": [list(p) for p in bridge_way["pts"][0]]},
    "ferryRoute": {"pts": [list(p) for seg in ferry_route["pts"] for p in seg]},
}
trees = [[n["x"], n["y"]] for n in nodes if n["tag"] == "natural=tree" and g[int(to_px(n["x"], n["y"])[1]) % H, int(to_px(n["x"], n["y"])[0]) % W] not in (1, 11)]
piers = [[list(map(lambda v: round(v, 1), c)) for c in Polygon(r).exterior.coords] for r in pier_rings if Polygon(r).area > 4]
pier_paths = [[list(p) for p in r] for r in pier_lines]

# drivable network (for traffic): main roads, one entry per way
net = []
for r in roads:
    if r["hw"] in DEFAULT_LANES and r["tunnel"] not in ("yes",) and not r["layer"].startswith("-") and r["hw"] not in ("service",):
        for pl in r["pts"]:
            if len(pl) >= 2:
                net.append(dict(hw=r["hw"], name=r["name"], lanes=int(r["lanes"] or DEFAULT_LANES[r["hw"]]), oneway=r["oneway"] == "yes", bridge=r["bridge"] == "yes", pts=[list(p) for p in pl]))


def kind_and_round(b):
    p = b["poly"]
    return dict(p=[[round(x, 1), round(y, 1)] for x, y in list(p.exterior.coords)[:-1]], h=round(b["h"], 1), minh=round(b["minh"], 1),
                k=kind_of(b["name"], b["type"], b["h"]), n=b["name"], roof=b["roof"])


city = dict(
    source="OpenStreetMap contributors (ODbL), Overpass export 2026-11-26",
    origin={"lat": -31.96225, "lon": 115.8560},
    bounds={"x0": X0, "x1": X1, "y0": Y0, "y1": Y1}, groundRes=RES,
    classes={str(k): v[0] for k, v in CLASSES.items()},
    buildings=[kind_and_round(b) for b in out_b if b["poly"].area >= 8],
    roads=net, piers=piers, pierPaths=pier_paths, trees=trees, landmarks=landmarks,
)
(OUT / "city.json").write_text(json.dumps(city, separators=(",", ":")))
Image.fromarray(g, "L").save(OUT / "ground.png", optimize=True)
pal = np.zeros((256, 3), np.uint8)
for k, (_, c) in CLASSES.items():
    pal[k] = c
prev = Image.fromarray(pal[g], "RGB")
prev.save(OUT / "preview.png")
print(f"city.json: {len(city['buildings'])} buildings, {len(net)} road pieces, {len(trees)} trees, {len(piers)} pier decks; "
      f"{(OUT / 'city.json').stat().st_size // 1024} KB")
print("landmarks", {k: (v if 'pts' not in v else f'{len(v["pts"])} pts') for k, v in landmarks.items()})
