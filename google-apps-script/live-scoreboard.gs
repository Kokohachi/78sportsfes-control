const SCOREBOARD_FIREBASE_PROJECT = "thsportsfes";
const SCOREBOARD_FIREBASE_API_KEY = "AIzaSyAwVUxoXbvTraGUDoLztqqcJx2fIHqUntc";
const SCOREBOARD_DOCS = [
  { id: "ball_day", sheet: "球技日", title: "球技日 組別得点" },
  { id: "team_day", sheet: "団体競技日", title: "団体競技日 組別得点" }
];

function createLiveScoreSpreadsheet() {
  const properties = PropertiesService.getScriptProperties();
  const existingId = properties.getProperty("SCOREBOARD_SPREADSHEET_ID");
  const spreadsheet = existingId
    ? SpreadsheetApp.openById(existingId)
    : SpreadsheetApp.create("第78回体育祭 組別得点");
  properties.setProperty("SCOREBOARD_SPREADSHEET_ID", spreadsheet.getId());
  const first = spreadsheet.getSheets()[0];
  if (!spreadsheet.getSheetByName(SCOREBOARD_DOCS[0].sheet)) first.setName(SCOREBOARD_DOCS[0].sheet);
  SCOREBOARD_DOCS.slice(1).forEach(({ sheet }) => {
    if (!spreadsheet.getSheetByName(sheet)) spreadsheet.insertSheet(sheet);
  });
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === "syncLiveScoreboards")
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("syncLiveScoreboards").timeBased().everyMinutes(1).create();
  syncLiveScoreboards();
  console.log("スプレッドシートURL: " + spreadsheet.getUrl());
  return spreadsheet.getUrl();
}

function syncLiveScoreboards() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SCOREBOARD_SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("先に createLiveScoreSpreadsheet を実行してください。");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  SCOREBOARD_DOCS.forEach((config) => {
    const payload = fetchScoreboard(config.id);
    writeScoreboard(spreadsheet.getSheetByName(config.sheet), config, payload);
  });
}

function fetchScoreboard(documentId) {
  const url = "https://firestore.googleapis.com/v1/projects/" + SCOREBOARD_FIREBASE_PROJECT
    + "/databases/(default)/documents/public_scoreboards/" + encodeURIComponent(documentId)
    + "?key=" + encodeURIComponent(SCOREBOARD_FIREBASE_API_KEY);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) {
    throw new Error("Firestore読み込み失敗: " + response.getResponseCode() + " " + response.getContentText());
  }
  const document = JSON.parse(response.getContentText());
  const payloadJson = document.fields && document.fields.payloadJson && document.fields.payloadJson.stringValue;
  return payloadJson ? JSON.parse(payloadJson) : null;
}

function writeScoreboard(sheet, config, payload) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 6).merge();
  sheet.getRange(1, 1).setValue(config.title);
  sheet.getRange(2, 1).setValue("最終更新");
  sheet.getRange(2, 2).setValue(payload ? payload.updatedAt : "アプリからの初回同期待ち");
  const header = ["競技", "区分", "A組", "B組", "C組", "D組"];
  sheet.getRange(4, 1, 1, header.length).setValues([header]);

  const rows = (payload && Array.isArray(payload.competitions) ? payload.competitions : [])
    .map((item) => [safeCellText(item.sport), safeCellText(item.group), ...["A", "B", "C", "D"].map((team) => Number(item.points && item.points[team]) || 0)]);
  if (rows.length) sheet.getRange(5, 1, rows.length, header.length).setValues(rows);
  const totals = payload && payload.totals ? payload.totals : {};
  const totalRow = 5 + rows.length;
  sheet.getRange(totalRow, 1, 1, header.length).setValues([[
    "合計", "", ...["A", "B", "C", "D"].map((team) => Number(totals[team]) || 0)
  ]]);
  sheet.setFrozenRows(4);
  sheet.getRange(1, 1, 1, header.length).setFontWeight("bold").setFontSize(14);
  sheet.getRange(4, 1, 1, header.length).setFontWeight("bold").setBackground("#dbeafe");
  sheet.getRange(totalRow, 1, 1, header.length).setFontWeight("bold").setBackground("#fef3c7");
  sheet.autoResizeColumns(1, header.length);
}

function safeCellText(value) {
  const text = String(value || "");
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}
