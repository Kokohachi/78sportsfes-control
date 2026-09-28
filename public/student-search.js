(() => {
  "use strict";

  const STORE_KEY = "gym78_student_directory_encrypted_v1";
  const PBKDF2_SALT = "iJSecYXaw1RlynAHfyM4kA==";
  const EXPECTED_KEY = "8r8vQqiBEOFzp7c/zSQ8wWV7HwLUZaUUXJQH/+JsGKk=";
  const ITERATIONS = 310000;
  const ID_HINT = /4桁番号|学籍番号|生徒番号|個人番号|student.?id|^id$/i;
  const SENSITIVE_HINT = /mail|メール|電話|phone|住所|address/i;
  const SPORT_HINT = /球技|競技|種目|sport/i;
  const state = { key: null, rows: [], fields: [], filters: {}, staged: null, lockTimer: 0 };
  const $ = (id) => document.getElementById(id);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const toBase64 = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));

  async function deriveKey(password) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromBase64(PBKDF2_SALT), iterations: ITERATIONS, hash: "SHA-256" }, material, 256);
    return new Uint8Array(bits);
  }

  async function unlock(password) {
    const rawKey = await deriveKey(password);
    if (toBase64(rawKey) !== EXPECTED_KEY) throw new Error("パスワードを確認してください。");
    state.key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      const encrypted = JSON.parse(saved);
      const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(encrypted.iv) }, state.key, fromBase64(encrypted.data));
      const payload = JSON.parse(decoder.decode(clear));
      state.rows = payload.rows ?? [];
      state.fields = payload.fields ?? [];
    }
    $("unlockPanel").classList.add("hidden");
    $("directoryPanel").classList.remove("hidden");
    $("lockButton").classList.remove("hidden");
    renderDirectory();
    resetLockTimer();
  }

  async function persist() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const clear = encoder.encode(JSON.stringify({ rows: state.rows, fields: state.fields }));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.key, clear);
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, iv: toBase64(iv), data: toBase64(encrypted) }));
  }

  function lock() {
    clearTimeout(state.lockTimer);
    state.key = null;
    state.rows = [];
    state.fields = [];
    state.staged = null;
    $("directoryPanel").classList.add("hidden");
    $("lockButton").classList.add("hidden");
    $("unlockPanel").classList.remove("hidden");
    $("accessPassword").value = "";
    $("unlockMessage").textContent = "ロックしました。";
    $("results").replaceChildren();
    $("query").value = "";
    state.filters = {};
  }

  function resetLockTimer() {
    clearTimeout(state.lockTimer);
    state.lockTimer = setTimeout(lock, 15 * 60 * 1000);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const source = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(cell); cell = ""; }
      else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += char;
    }
    if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  function cleanGrid(grid) {
    const headerIndex = grid.findIndex((row) => row?.some((value) => String(value ?? "").trim()));
    if (headerIndex < 0) throw new Error("列名を読み取れませんでした。");
    const headers = grid[headerIndex].map((value, index) => String(value ?? "").trim() || `列${index + 1}`);
    const records = grid.slice(headerIndex + 1).map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values?.[index] ?? "").trim()]))).filter((record) => Object.values(record).some(Boolean));
    if (!records.length) throw new Error("名簿の行が見つかりませんでした。");
    return { headers, records };
  }

  async function readFile(file) {
    if (file.name.toLowerCase().endsWith(".csv")) return { sheets: [{ name: "CSV", ...cleanGrid(parseCsv(await file.text())) }] };
    if (!window.XLSX) throw new Error("Excel読込ライブラリが読み込めませんでした。ページを再読み込みしてください。");
    const bytes = await file.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
    if (file.name.toLowerCase().endsWith(".xlsx") && signature[0] === 0xd0 && signature[1] === 0xcf) throw new Error("encrypted workbook");
    const workbook = XLSX.read(bytes, { type: "array", raw: false });
    return { sheets: workbook.SheetNames.map((name) => ({ name, ...cleanGrid(XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false })) })) };
  }

  function suggestedKey(headers) {
    return headers.find((header) => ID_HINT.test(header)) ?? headers.find((header) => /番号|number/i.test(header)) ?? headers[0];
  }

  function stageImport(sheets) {
    state.staged = sheets;
    $("sheetSelect").innerHTML = sheets.map((sheet, index) => `<option value="${index}">${escapeHtml(sheet.name)}（${sheet.records.length}人 / ${sheet.headers.length}項目）</option>`).join("");
    const sportSheet = sheets.findIndex((sheet) => sheet.headers.some((header) => SPORT_HINT.test(header)));
    if (sportSheet >= 0) $("sheetSelect").value = String(sportSheet);
    updateImportKeyOptions();
    $("importOptions").classList.remove("hidden");
    $("importStatus").textContent = "シートと更新方法を選んで「この内容で更新」を押してください。名簿の氏名やメールアドレスはプレビュー表示しません。";
  }

  function updateImportKeyOptions() {
    const sheet = state.staged?.[Number($("sheetSelect").value)];
    if (!sheet) return;
    $("keyField").innerHTML = sheet.headers.map((header) => `<option value="${escapeHtml(header)}">${escapeHtml(header)}</option>`).join("");
    $("keyField").value = suggestedKey(sheet.headers);
    $("importMode").value = "replace";
    $("keyField").closest("label").classList.add("hidden");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  async function commitImport() {
    const sheet = state.staged?.[Number($("sheetSelect").value)];
    if (!sheet) return;
    const mode = $("importMode").value;
    const keyField = $("keyField").value;
    if (mode === "merge" && !keyField) return setMessage("importStatus", "照合キーを選択してください。", true);
    if (mode === "merge") {
      const byKey = new Map(state.rows.map((record) => [String(record[keyField] ?? "").trim(), record]).filter(([key]) => key));
      sheet.records.forEach((incoming) => {
        const key = String(incoming[keyField] ?? "").trim();
        if (key && byKey.has(key)) Object.assign(byKey.get(key), incoming);
        else byKey.set(key || `__row_${crypto.randomUUID()}`, incoming);
      });
      state.rows = [...byKey.values()];
      state.fields = [...new Set([...state.fields, ...sheet.headers])];
    } else {
      state.rows = sheet.records;
      state.fields = sheet.headers;
    }
    await persist();
    $("importOptions").classList.add("hidden");
    $("importFile").value = "";
    state.staged = null;
    $("importStatus").textContent = `${sheet.records.length.toLocaleString()}人分を端末内に暗号化して保存しました。`;
    renderDirectory();
  }

  function setMessage(id, text, error = false) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("error", error);
  }

  function renderDirectory() {
    $("datasetSummary").textContent = state.rows.length ? `${state.rows.length.toLocaleString()}人 / ${state.fields.length}項目　（このブラウザー内に暗号化保存）` : "名簿はまだありません。ExcelまたはCSVを選択して読み込んでください。";
    renderFilters();
    renderExportFields();
    renderResults();
  }

  function renderFilters() {
    const container = $("filters");
    container.replaceChildren();
    state.fields.forEach((field) => {
      const distinct = [...new Set(state.rows.map((row) => row[field]).filter((value) => String(value ?? "").trim()))].sort((a, b) => String(a).localeCompare(String(b), "ja"));
      const label = document.createElement("label");
      label.className = "filter-control";
      label.textContent = field;
      let input;
      if (distinct.length <= 80) {
        input = document.createElement("select");
        input.add(new Option("すべて", ""));
        distinct.forEach((value) => input.add(new Option(String(value), String(value))));
      } else {
        input = document.createElement("input");
        input.type = "search";
        input.placeholder = `${field}で絞り込み`;
      }
      input.dataset.field = field;
      input.value = state.filters[field] ?? "";
      input.addEventListener("input", () => { state.filters[field] = input.value; renderResults(); resetLockTimer(); });
      label.append(input);
      container.append(label);
    });
  }

  function renderExportFields() {
    const container = $("exportFields");
    container.replaceChildren();
    state.fields.forEach((field) => {
      const label = document.createElement("label");
      label.className = "check-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = field;
      input.checked = !SENSITIVE_HINT.test(field) && (/番号|学年|組|クラス|名字|姓|名前|氏名|球技|競技|種目|パート|所属|担当/i.test(field));
      label.append(input, document.createTextNode(field));
      container.append(label);
    });
  }

  function filteredRows() {
    const tokens = $("query").value.normalize("NFKC").toLocaleLowerCase("ja").split(/\s+/).filter(Boolean);
    return state.rows.filter((row) => {
      if (!state.fields.every((field) => !state.filters[field] || String(row[field] ?? "").toLocaleLowerCase("ja").includes(String(state.filters[field]).toLocaleLowerCase("ja")))) return false;
      const content = state.fields.map((field) => row[field] ?? "").join(" ").normalize("NFKC").toLocaleLowerCase("ja");
      return tokens.every((token) => content.includes(token));
    });
  }

  function renderResults() {
    const results = filteredRows();
    $("resultCount").textContent = `${results.length.toLocaleString()}人を表示`;
    const container = $("results");
    container.replaceChildren();
    const displayFields = state.fields.filter((field) => !SENSITIVE_HINT.test(field));
    results.slice(0, 300).forEach((record) => {
      const article = document.createElement("article");
      article.className = "student-card";
      const nameField = displayFields.find((field) => /氏名/.test(field));
      const familyField = displayFields.find((field) => /名字|姓/.test(field));
      const givenField = displayFields.find((field) => /^名前$|名/.test(field));
      const title = document.createElement("h3");
      title.textContent = nameField ? String(record[nameField] ?? "（氏名なし）") : familyField || givenField ? `${record[familyField] ?? ""} ${record[givenField] ?? ""}`.trim() : String(record[displayFields[0]] ?? "生徒");
      article.append(title);
      const details = document.createElement("dl");
      displayFields.filter((field) => field !== nameField && field !== familyField && field !== givenField && record[field] !== "").forEach((field) => {
        const dt = document.createElement("dt"); dt.textContent = field;
        const dd = document.createElement("dd"); dd.textContent = String(record[field]);
        details.append(dt, dd);
      });
      article.append(details);
      container.append(article);
    });
    if (results.length > 300) {
      const note = document.createElement("p"); note.className = "muted"; note.textContent = "先頭300件を表示しています。絞り込んでください。"; container.append(note);
    }
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const records = filteredRows();
    const fields = [...$("exportFields").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!records.length) return alert("出力する生徒がいません。");
    if (!fields.length && !$("includeAttendance").checked) return alert("CSVに出力する項目を選択してください。");
    const headers = [...fields, ...($("includeAttendance").checked ? ["出欠"] : [])];
    const lines = [headers, ...records.map((record) => [...fields.map((field) => record[field] ?? ""), ...($("includeAttendance").checked ? [""] : [])])];
    const blob = new Blob(["\uFEFF" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `出欠名簿_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    resetLockTimer();
  }

  $("unlockForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await unlock($("accessPassword").value);
      $("unlockMessage").textContent = "";
    } catch {
      setMessage("unlockMessage", "パスワードが違うか、保存データを復号できません。", true);
    }
  });
  $("importFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      stageImport(await readFile(file));
    } catch (error) {
      $("importOptions").classList.add("hidden");
      $("importFile").value = "";
      setMessage("importStatus", error.message?.includes("password") || error.message?.includes("encrypted") ? "このExcelはパスワード付きです。ExcelでローカルにCSV UTF-8またはパスワードなし.xlsxとして保存してから読み込んでください。" : "ファイルを読み込めませんでした。CSV UTF-8またはパスワードなしの.xlsxを選択してください。", true);
    }
  });
  $("sheetSelect").addEventListener("change", updateImportKeyOptions);
  $("importMode").addEventListener("change", () => $("keyField").closest("label").classList.toggle("hidden", $("importMode").value !== "merge"));
  $("confirmImport").addEventListener("click", () => commitImport().catch(() => setMessage("importStatus", "保存できませんでした。空き容量を確認してください。", true)));
  $("cancelImport").addEventListener("click", () => { state.staged = null; $("importOptions").classList.add("hidden"); $("importFile").value = ""; });
  $("query").addEventListener("input", () => { renderResults(); resetLockTimer(); });
  $("exportButton").addEventListener("click", exportCsv);
  $("lockButton").addEventListener("click", lock);
  ["pointerdown", "keydown"].forEach((eventName) => document.addEventListener(eventName, () => { if (state.key) resetLockTimer(); }, { passive: true }));
})();
