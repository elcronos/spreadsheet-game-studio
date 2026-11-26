"""Tiny VBA lint for the Excel editions: finds locals/params that shadow module-level names
(VBA is case-insensitive), undeclared identifiers are left to the LibreOffice run."""
import re, sys
src = open(sys.argv[1], encoding="latin-1").read()
lines = src.splitlines()
mod = set()
for ln in lines:
    m = re.match(r"\s*(?:Private|Public|Dim)\s+(?:Const\s+)?(.*)", ln)
    if m and not re.match(r"\s*(Private|Public)\s+(Sub|Function|Type|Declare)", ln) and not ln.startswith(" "):
        for part in m.group(1).split(","):
            nm = re.match(r"\s*(\w+)", part)
            if nm: mod.add(nm.group(1).lower())
    m = re.match(r"(?:Private|Public)\s+(?:Sub|Function)\s+(\w+)", ln)
    if m: mod.add(m.group(1).lower())
problems = 0
proc = None
for i, ln in enumerate(lines, 1):
    m = re.match(r"(?:Private|Public)\s+(?:Sub|Function)\s+(\w+)\((.*?)\)", ln)
    if m:
        proc = m.group(1)
        for part in m.group(2).split(","):
            nm = re.match(r"\s*(?:Optional\s+)?(?:ByVal\s+|ByRef\s+)?(\w+)", part)
            if nm and nm.group(1).lower() in mod:
                print(f"{i}: param {nm.group(1)} in {proc} shadows a module name"); problems += 1
    if proc and re.match(r"\s+Dim\s", ln):
        for part in re.sub(r"\(.*?\)", "", ln.strip()[4:]).split(","):
            nm = re.match(r"\s*(\w+)", part)
            if nm and nm.group(1).lower() in mod:
                print(f"{i}: local {nm.group(1)} in {proc} shadows a module name"); problems += 1
    if re.match(r"End (Sub|Function)", ln): proc = None
# non-ASCII would break Import File on Windows (ANSI)
for i, ln in enumerate(lines, 1):
    if any(ord(ch) > 126 for ch in ln): print(f"{i}: non-ASCII character"); problems += 1
print("problems:", problems)
