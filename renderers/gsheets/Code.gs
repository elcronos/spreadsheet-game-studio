/**
 * Spreadsheet Game Studio - Google Sheets edition (server half, Apps Script).
 *
 * The game runs in the sidebar (Sidebar.html, a bundled copy of the same
 * engine). Every update it sends the cells that changed; this script paints
 * them into the GAME sheet with Range.setBackgrounds, writes the game's live
 * values into the variable sheets, and returns what the player typed into the
 * sheets (values and RULES formulas) so the game can apply it.
 *
 * Install: Extensions → Apps Script, paste this file as Code.gs and the
 * sidebar as an HTML file named Sidebar, save, reload the spreadsheet, then
 * use the "__TITLE__" menu, then Play.
 */

var GAME = 'GAME';
var HUD_ROWS = 3; // rows 1-3: stats, objective, info; frame starts at A4
var PROP_LAYOUT = 'sgs_layout';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('__TITLE__')
    .addItem('Play', 'showSidebar')
    .addItem('Rebuild sheets', 'rebuildPrompt')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('__TITLE__');
  SpreadsheetApp.getUi().showSidebar(html);
}

function rebuildPrompt() {
  PropertiesService.getDocumentProperties().deleteProperty(PROP_LAYOUT);
  SpreadsheetApp.getUi().alert('Sheets will be rebuilt the next time you press Play.');
}

function sheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureSize_(sh, rows, cols) {
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
}

/**
 * Build (or reuse) the workbook layout from the game's manifest.
 * manifest: { title, width, height, cellPx, variables:[VariableDef], rules:[RuleDef], sheets:[{name, columns}] }
 * Returns { rebuilt: boolean }.
 */
function setupLayout(manifest) {
  var props = PropertiesService.getDocumentProperties();
  var key = manifest.title + ':' + manifest.width + 'x' + manifest.height + ':' + manifest.variables.length + ':' + manifest.rules.length;
  var existing = props.getProperty(PROP_LAYOUT);
  var ss = SpreadsheetApp.getActive();
  if (existing) {
    var lay = JSON.parse(existing);
    if (lay.key === key && ss.getSheetByName(GAME)) return { rebuilt: false };
  }
  // GAME sheet: square cells, HUD rows on top
  var g = sheet_(ss, GAME);
  g.clear();
  ensureSize_(g, HUD_ROWS + manifest.height, manifest.width);
  g.setColumnWidths(1, manifest.width, manifest.cellPx);
  g.setRowHeights(HUD_ROWS + 1, manifest.height, manifest.cellPx);
  g.setRowHeights(1, 3, 22);
  g.getRange(1, 1, 1, manifest.width).setBackground('#1c2033').setFontColor('#e8ebff').setFontWeight('bold');
  g.getRange(2, 1, 1, manifest.width).setBackground('#f3f4fb').setFontColor('#283593').setFontWeight('bold');
  g.getRange(3, 1, 1, manifest.width).setFontColor('#7a808a').setFontStyle('italic');
  g.setFrozenRows(HUD_ROWS);
  var layout = { key: key, width: manifest.width, height: manifest.height, sheets: {}, rules: [] };
  // variable sheets: Variable | Value | Min | Max | Unit | Description | Defined name
  var bySheet = {};
  manifest.variables.forEach(function (v) {
    (bySheet[v.sheet] = bySheet[v.sheet] || []).push(v);
  });
  ss.getNamedRanges().forEach(function (nr) {
    nr.remove();
  });
  Object.keys(bySheet).forEach(function (name) {
    var defs = bySheet[name];
    var sh = sheet_(ss, name);
    sh.clear();
    ensureSize_(sh, defs.length + 1, 7);
    var rows = [['Variable', 'Value', 'Min', 'Max', 'Unit', 'Description', 'Defined name']];
    defs.forEach(function (d) {
      rows.push([d.label + (d.live ? '  ·live' : ''), fmt_(d.default), d.min === undefined ? '' : d.min, d.max === undefined ? '' : d.max, d.unit || (d.options ? d.options.join(' / ') : ''), d.description || '', d.name || '']);
    });
    // values as plain text where needed so Sheets does not reinterpret them
    sh.getRange(1, 1, rows.length, 7).setValues(rows);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#eceef6');
    sh.getRange(2, 2, defs.length, 1).setBackground('#fff8dc').setFontWeight('bold').setFontColor('#1a237e');
    sh.setColumnWidth(1, 260);
    sh.setColumnWidth(6, 380);
    sh.setFrozenRows(1);
    defs.forEach(function (d, i) {
      if (d.name) ss.setNamedRange(d.name, sh.getRange(2 + i, 2));
    });
    layout.sheets[name] = defs.map(function (d) {
      return d.key;
    });
  });
  // RULES: Rule | Formula | Value used by the game | Min | Max | What it drives
  var rs = sheet_(ss, 'RULES');
  rs.clear();
  ensureSize_(rs, manifest.rules.length + 1, 6);
  rs.getRange(1, 1, 1, 6).setValues([['Rule (defined name)', 'Formula (edit me)', 'Value used by the game', 'Min', 'Max', 'What it drives']]).setFontWeight('bold').setBackground('#eceef6');
  manifest.rules.forEach(function (r, i) {
    rs.getRange(2 + i, 1).setValue(r.name);
    rs.getRange(2 + i, 4, 1, 3).setValues([[r.min, r.max, r.description]]);
  });
  // define every rule's name before writing formulas that reference each other
  manifest.rules.forEach(function (r, i) {
    ss.setNamedRange(r.name, rs.getRange(2 + i, 2));
  });
  manifest.rules.forEach(function (r, i) {
    rs.getRange(2 + i, 2).setFormula(r.formula);
  });
  rs.getRange(2, 2, Math.max(1, manifest.rules.length), 1).setBackground('#fff8dc').setFontColor('#1a237e');
  rs.setColumnWidth(1, 200);
  rs.setColumnWidth(2, 380);
  rs.setColumnWidth(6, 360);
  rs.setFrozenRows(1);
  layout.rules = manifest.rules.map(function (r) {
    return r.name;
  });
  (manifest.sheets || []).forEach(function (s) {
    var sh = sheet_(ss, s.name);
    sh.clear();
    ensureSize_(sh, 2, s.columns.length);
    sh.getRange(1, 1, 1, s.columns.length).setValues([s.columns]).setFontWeight('bold').setBackground('#eceef6');
    sh.setFrozenRows(1);
  });
  ss.setActiveSheet(g);
  props.setProperty(PROP_LAYOUT, JSON.stringify(layout));
  return { rebuilt: true };
}

function fmt_(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return v;
}

/**
 * Apply one update from the game and return the player's edits.
 * p: { rects:[{r, c, colors:[[ '#rrggbb' ]]}], hud:{lines:[s1, s2, s3]}|null,
 *      values:{key: value}|null, ruleValues:{name: number}|null, sheets:[{name, columns, rows}]|null }
 * Returns { applyMs, values:{key: value}, formulas:{name: formula} }.
 */
function applyFrame(p) {
  var t0 = Date.now();
  var ss = SpreadsheetApp.getActive();
  var lay = JSON.parse(PropertiesService.getDocumentProperties().getProperty(PROP_LAYOUT));
  var g = ss.getSheetByName(GAME);
  (p.rects || []).forEach(function (rc) {
    var h = rc.colors.length, w = rc.colors[0].length;
    g.getRange(HUD_ROWS + 1 + rc.r, 1 + rc.c, h, w).setBackgrounds(rc.colors);
  });
  if (p.hud) {
    for (var i = 0; i < 3; i++) g.getRange(1 + i, 1).setValue(p.hud.lines[i] || '');
  }
  // Variable sheets: read each Value column once, overlay the game's changed values, write it back once.
  // Rows the player is editing are only overwritten if the game itself changed that value.
  var values = {};
  Object.keys(lay.sheets).forEach(function (name) {
    var keys = lay.sheets[name];
    var sh = ss.getSheetByName(name);
    var rng = sh.getRange(2, 2, keys.length, 1);
    var col = rng.getValues();
    var dirty = false;
    keys.forEach(function (k, i) {
      if (p.values && Object.prototype.hasOwnProperty.call(p.values, k)) {
        col[i][0] = fmt_(p.values[k]);
        dirty = true;
      }
      values[k] = col[i][0];
    });
    if (dirty) rng.setValues(col);
  });
  var rs = ss.getSheetByName('RULES');
  if (p.ruleValues && lay.rules.length) {
    var col = lay.rules.map(function (n) {
      return [p.ruleValues[n] === undefined ? '' : p.ruleValues[n]];
    });
    rs.getRange(2, 3, col.length, 1).setValues(col);
  }
  (p.sheets || []).forEach(function (s) {
    var sh = ss.getSheetByName(s.name);
    if (!sh) return;
    var n = Math.max(1, sh.getLastRow() - 1);
    sh.getRange(2, 1, n, s.columns.length).clearContent();
    if (s.rows.length) {
      ensureSize_(sh, s.rows.length + 1, s.columns.length);
      sh.getRange(2, 1, s.rows.length, s.columns.length).setValues(s.rows);
    }
  });
  var formulas = {};
  if (lay.rules.length) {
    var fs = rs.getRange(2, 2, lay.rules.length, 1).getFormulas();
    lay.rules.forEach(function (n, i) {
      formulas[n] = fs[i][0];
    });
  }
  return { applyMs: Date.now() - t0, values: values, formulas: formulas };
}
