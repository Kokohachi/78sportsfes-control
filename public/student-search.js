(() => {
  "use strict";

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAwVUxoXbvTraGUDoLztqqcJx2fIHqUntc",
    authDomain: "thsportsfes.firebaseapp.com",
    databaseURL: "https://thsportsfes-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "thsportsfes",
    storageBucket: "thsportsfes.firebasestorage.app",
    messagingSenderId: "96596815858",
    appId: "1:96596815858:web:5f85526bf785ccc5d8056b",
    measurementId: "G-TCPMRTY3P1"
  };
  const AUTHORIZED_EMAILS = new Set([
    "jh62220120@s.musashi.ed.jp", "jh62220340@s.musashi.ed.jp", "jh62220140@s.musashi.ed.jp",
    "jh62231310@s.musashi.ed.jp", "jh62230450@s.musashi.ed.jp", "jh62220250@s.musashi.ed.jp",
    "jh62230440@s.musashi.ed.jp", "jh62220030@s.musashi.ed.jp", "jh62231560@s.musashi.ed.jp",
    "jh62230600@s.musashi.ed.jp", "jh62220260@s.musashi.ed.jp"
  ]);
  // Enable only after merging the matching rule into Firebase Console and checking for broad wildcard grants.
  const FIRESTORE_RULES_READY = true;
  const DIRECTORY_DOC = "student_directory/current";
  const MAX_DIRECTORY_BYTES = 850_000;
  const ID_HINT = /4桁番号|学籍番号|生徒番号|個人番号|student.?id|^id$/i;
  const SENSITIVE_HINT = /mail|メール|メアド|gmail|電話|phone|住所|address/i;
  const FREE_TEXT_FILTER_HINT = /4桁番号|四桁番号|学籍番号|生徒番号|個人番号|名字|姓|名前|氏名|メアド|メール|gmail|e-mail|^名$/i;
  const SPORT_HINT = /球技|競技|種目|sport/i;
  const ATTENDANCE_HALVES = "__attendance_number_halves__";
  const state = { rows: [], fields: [], filters: {}, staged: null, selectedStudentIndices: new Set(), lockTimer: 0, db: null, auth: null, user: null, unsubscribe: null };
  const $ = (id) => document.getElementById(id);

  const encoder = new TextEncoder();
  async function loadCloudDirectory() {
    state.unsubscribe?.();
    await new Promise((resolve, reject) => {
      let initialSnapshot = true;
      state.unsubscribe = state.db.doc(DIRECTORY_DOC).onSnapshot((snapshot) => {
        const payload = snapshot.exists ? snapshot.data() : {};
        state.rows = Array.isArray(payload.rows) ? payload.rows : [];
        state.fields = Array.isArray(payload.fields) ? payload.fields : [];
        renderDirectory();
        if (initialSnapshot) resolve();
        initialSnapshot = false;
      }, (error) => {
        if (initialSnapshot) reject(error);
        else setMessage("importStatus", "共有名簿との接続が切れました。再読み込みしてください。", true);
      });
    });
    $("unlockPanel").classList.add("hidden");
    $("directoryPanel").classList.remove("hidden");
    $("lockButton").classList.remove("hidden");
    renderDirectory();
    resetLockTimer();
  }

  async function persist() {
    const payload = { rows: state.rows, fields: state.fields };
    const bytes = encoder.encode(JSON.stringify(payload)).length;
    if (bytes > MAX_DIRECTORY_BYTES) throw new Error("名簿が大きすぎます。項目を整理してから再度お試しください。");
    await state.db.doc(DIRECTORY_DOC).set({
      ...payload,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: state.user.email
    });
  }

  async function lock() {
    clearTimeout(state.lockTimer);
    state.unsubscribe?.();
    state.unsubscribe = null;
    state.rows = [];
    state.fields = [];
    state.staged = null;
    state.selectedStudentIndices.clear();
    $("directoryPanel").classList.add("hidden");
    $("lockButton").classList.add("hidden");
    $("unlockPanel").classList.remove("hidden");
    $("unlockMessage").textContent = "ロックしました。";
    $("results").replaceChildren();
    $("query").value = "";
    state.filters = {};
    if (state.auth?.currentUser) await state.auth.signOut();
  }

  function resetLockTimer() {
    clearTimeout(state.lockTimer);
    state.lockTimer = setTimeout(() => lock(), 15 * 60 * 1000);
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
    const sourceHeaders = grid[headerIndex];
    const sourceRows = grid.slice(headerIndex + 1);
    const activeColumns = sourceHeaders.map((_, index) => index).filter((index) =>
      String(sourceHeaders[index] ?? "").trim() || sourceRows.some((row) => String(row?.[index] ?? "").trim())
    );
    const headers = activeColumns.map((index) => {
      const header = String(sourceHeaders[index] ?? "").trim();
      if (header) return header;
      if (index > 0 && /読み|よみ|ふりがな/i.test(String(sourceHeaders[index - 1] ?? ""))) return "名前読み";
      return `列${index + 1}`;
    });
    const records = sourceRows.map((values) => Object.fromEntries(activeColumns.map((sourceIndex, index) =>
      [headers[index], String(values?.[sourceIndex] ?? "").trim()]
    ))).filter((record) => Object.values(record).some(Boolean));
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
    $("importMode").value = state.rows.length ? "merge" : "replace";
    $("keyField").closest("label").classList.toggle("hidden", $("importMode").value !== "merge");
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
    const previousRows = state.rows;
    const previousFields = state.fields;
    if (mode === "merge") {
      const mergedRows = state.rows.map((record) => ({ ...record }));
      const indexByKey = new Map();
      mergedRows.forEach((record, index) => {
        const key = String(record[keyField] ?? "").trim();
        if (key && !indexByKey.has(key)) indexByKey.set(key, index);
      });
      sheet.records.forEach((incoming) => {
        const key = String(incoming[keyField] ?? "").trim();
        if (key && indexByKey.has(key)) Object.assign(mergedRows[indexByKey.get(key)], incoming);
        else {
          const index = mergedRows.push(incoming) - 1;
          if (key) indexByKey.set(key, index);
        }
      });
      state.rows = mergedRows;
      state.fields = [...new Set([...state.fields, ...sheet.headers])];
    } else {
      state.rows = sheet.records;
      state.fields = sheet.headers;
    }
    try {
      await persist();
    } catch (error) {
      state.rows = previousRows;
      state.fields = previousFields;
      throw error;
    }
    $("importOptions").classList.add("hidden");
    $("importFile").value = "";
    state.staged = null;
    $("importStatus").textContent = `${state.rows.length.toLocaleString()}人分を共有名簿へ保存しました。`;
    renderDirectory();
  }

  function setMessage(id, text, error = false) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("error", error);
  }

  function renderDirectory() {
    $("datasetSummary").textContent = state.rows.length ? `${state.rows.length.toLocaleString()}人 / ${state.fields.length}項目　（共有名簿）` : "名簿はまだありません。ExcelまたはCSVを選択して読み込んでください。";
    renderFilters();
    renderExportFields();
    renderAssignmentFields();
    renderResults();
  }

  function studentDisplayName(record) {
    const full = state.fields.find((field) => /^(氏名|生徒氏名|名前（フル）)$/.test(field.trim()));
    const family = state.fields.find((field) => /^(名字|姓|姓（漢字）|名字（漢字）)$/.test(field.trim()));
    const given = state.fields.find((field) => /^(名前|名|名（漢字）)$/.test(field.trim()));
    return full ? String(record[full] ?? "（氏名なし）")
      : family || given ? [record[family] ?? "", record[given] ?? ""].filter(Boolean).join(" ")
        : String(record[state.fields[0]] ?? "生徒");
  }

  function renderAssignmentFields() {
    const select = $("assignmentField");
    const previous = select.value;
    select.replaceChildren(...state.fields.map((field) => new Option(field, field)));
    if (state.fields.includes(previous)) select.value = previous;
    $("assignValueButton").disabled = state.selectedStudentIndices.size === 0 || !select.value;
    $("assignValueButton").textContent = `選択した${state.selectedStudentIndices.size}人に追加`;
  }

  function renderStudentCandidates() {
    const container = $("studentCandidates"); container.replaceChildren();
    const query = $("studentPickerSearch").value.trim().normalize("NFKC").toLocaleLowerCase("ja");
    $("selectedStudent").textContent = state.selectedStudentIndices.size ? `${state.selectedStudentIndices.size}人を選択中。検索語を変えて追加選択できます。` : "候補から生徒を選択してください。";
    if (query.length < 1) { renderAssignmentFields(); return; }
    const matches = state.rows.map((record, index) => ({ record, index })).filter(({ record }) =>
      state.fields.filter((field) => !SENSITIVE_HINT.test(field)).some((field) => String(record[field] ?? "").normalize("NFKC").toLocaleLowerCase("ja").includes(query))
    ).slice(0, 20);
    matches.forEach(({ record, index }) => {
      const label = document.createElement("label"); label.className = "student-candidate";
      const details = state.fields.filter((field) => /番号|学年|組|クラス/.test(field) && !SENSITIVE_HINT.test(field) && record[field]).map((field) => `${field}: ${record[field]}`).join(" / ");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.selectedStudentIndices.has(index);
      const name = document.createElement("span"); name.textContent = details ? `${studentDisplayName(record)}　${details}` : studentDisplayName(record);
      if (checkbox.checked) label.classList.add("selected");
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedStudentIndices.add(index); else state.selectedStudentIndices.delete(index);
        label.classList.toggle("selected", checkbox.checked);
        $("selectedStudent").textContent = state.selectedStudentIndices.size ? `${state.selectedStudentIndices.size}人を選択中。検索語を変えて追加選択できます。` : "候補から生徒を選択してください。";
        renderAssignmentFields();
      });
      label.append(checkbox, name); container.append(label);
    });
    if (!matches.length) { const note = document.createElement("p"); note.className = "muted"; note.textContent = "該当する生徒が見つかりません。"; container.append(note); }
    else if (matches.length === 20) { const note = document.createElement("p"); note.className = "muted"; note.textContent = "候補は20人まで表示しています。検索語を追加してください。"; container.append(note); }
    renderAssignmentFields();
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
      if (FREE_TEXT_FILTER_HINT.test(field)) {
        input = document.createElement("input");
        input.type = "search";
        input.placeholder = `${field}で検索`;
      } else {
        input = document.createElement("select");
        input.add(new Option("すべて", ""));
        distinct.forEach((value) => input.add(new Option(String(value), String(value))));
      }
      input.dataset.field = field;
      input.value = state.filters[field] ?? "";
      input.addEventListener("input", () => { state.filters[field] = input.value; renderResults(); renderExportGroupValues(); resetLockTimer(); });
      label.append(input);
      container.append(label);
    });
    const groupFields = $("exportGroupFields");
    const previousGroupFields = new Set([...groupFields.selectedOptions].map((option) => option.value));
    const attendanceField = state.fields.find((field) => /出席番号|出席no|attendance.?number/i.test(field));
    const attendanceOption = new Option("出席番号（1〜22 / 23以降）", ATTENDANCE_HALVES);
    attendanceOption.disabled = !attendanceField;
    const options = [
      attendanceOption,
      ...state.fields.map((field) => new Option(field, field))
    ];
    groupFields.replaceChildren(...options);
    [...groupFields.options].forEach((option) => { option.selected = !option.disabled && previousGroupFields.has(option.value); });
    $("exportGroupHint").textContent = attendanceField
      ? "条件を選ばない場合は1シート、複数条件を選ぶと値の組み合わせごとにシートを作成します。"
      : "条件を選ばない場合は1シート、複数条件を選ぶと値の組み合わせごとにシートを作成します。出席番号の前半・後半分けには「出席番号」列が必要です。";
    renderExportGroupValues();
  }

  function renderExportGroupValues() {
    const selectedFields = [...$("exportGroupFields").selectedOptions].map((option) => option.value);
    const field = selectedFields[0], select = $("exportGroupValues");
    const previous = new Set([...select.selectedOptions].map((option) => option.value));
    const attendanceField = state.fields.find((name) => /出席番号|出席no|attendance.?number/i.test(name));
    const values = selectedFields.length === 1 && field === ATTENDANCE_HALVES
      ? ["前半（1〜22）", "後半（23以降）"].filter((half) => filteredRows().some((row) => attendanceHalf(row[attendanceField]) === half))
      : selectedFields.length === 1
        ? [...new Set(filteredRows().map((row) => String(row[field] ?? "")).filter((value) => value.trim()))].sort((a, b) => a.localeCompare(b, "ja"))
        : [];
    select.replaceChildren(...values.map((value) => new Option(value, value)));
    [...select.options].forEach((option) => { option.selected = previous.has(option.value); });
    const singleCondition = selectedFields.length === 1;
    $("exportGroupValuesLabel").classList.toggle("hidden", !singleCondition);
    select.disabled = !singleCondition;
    if (selectedFields.length > 1) $("exportGroupHint").textContent = "選択した条件の値の組み合わせごとにシートを作成します。";
    else if (selectedFields.length === 1) $("exportGroupHint").textContent = "出力する値を選択してください。";
    else $("exportGroupHint").textContent = "条件を選ばない場合は1シートで出力します。";
  }

  function attendanceHalf(value) {
    const match = String(value ?? "").normalize("NFKC").match(/\d+/);
    const number = match ? Number(match[0]) : NaN;
    if (!Number.isInteger(number) || number < 1) return "";
    return number <= 22 ? "前半（1〜22）" : "後半（23以降）";
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
    const fullNameField = displayFields.find((field) => /^(氏名|生徒氏名|名前（フル）)$/.test(field.trim()));
    const familyField = displayFields.find((field) => /^(名字|姓|姓（漢字）|名字（漢字）)$/.test(field.trim()));
    const givenField = displayFields.find((field) => /^(名前|名|名（漢字）)$/.test(field.trim()));
    const makeName = (record) => fullNameField ? String(record[fullNameField] ?? "（氏名なし）")
      : familyField || givenField ? [record[familyField] ?? "", record[givenField] ?? ""].filter(Boolean).join(" ")
        : String(record[displayFields[0]] ?? "生徒");
    if ($("viewMode").value === "table") {
      const wrapper = document.createElement("div"); wrapper.className = "table-scroll";
      const table = document.createElement("table"); table.className = "student-table";
      const head = document.createElement("thead"), headRow = document.createElement("tr");
      displayFields.forEach((field) => { const th = document.createElement("th"); th.textContent = field; headRow.append(th); });
      head.append(headRow); table.append(head);
      const body = document.createElement("tbody");
      results.slice(0, 300).forEach((record) => {
        const row = document.createElement("tr");
        displayFields.forEach((field) => {
          const cell = document.createElement("td"), input = document.createElement("input");
          input.type = "text"; input.value = String(record[field] ?? ""); input.setAttribute("aria-label", `${makeName(record)} ${field}`);
          input.addEventListener("change", async () => {
            const previousValue = record[field] ?? "";
            record[field] = input.value.trim();
            try { await persist(); setMessage("editStatus", "変更を保存しました。"); resetLockTimer(); }
            catch (error) { record[field] = previousValue; input.value = String(previousValue); setMessage("editStatus", `保存できませんでした: ${error.message}`, true); }
          });
          cell.append(input); row.append(cell);
        });
        body.append(row);
      });
      table.append(body); wrapper.append(table); container.append(wrapper);
    } else results.slice(0, 300).forEach((record) => {
      const article = document.createElement("article"); article.className = "student-card";
      const title = document.createElement("h3"); title.textContent = makeName(record); article.append(title);
      const details = document.createElement("dl");
      displayFields.filter((field) => field !== fullNameField && record[field] !== "").forEach((field) => {
        const dt = document.createElement("dt"); dt.textContent = field;
        const dd = document.createElement("dd"); dd.textContent = String(record[field]); details.append(dt, dd);
      });
      article.append(details); container.append(article);
    });
    if (results.length > 300) {
      const note = document.createElement("p"); note.className = "muted"; note.textContent = "先頭300件を表示しています。絞り込んでください。"; container.append(note);
    }
  }

  function excelText(value) {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function exportAttendanceWorkbook() {
    const records = filteredRows();
    const fields = [...$("exportFields").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    const attendanceFields = $("includeAttendance").checked ? ["競技前", "競技後"] : [];
    if (!records.length) return alert("出力する生徒がいません。");
    if (!fields.length && !attendanceFields.length) return alert("出力する項目を選択してください。");
    const headers = [...fields, ...attendanceFields];
    if (!window.XLSX) return alert("Excel出力ライブラリを読み込めませんでした。ページを再読み込みしてください。");
    const groupFields = [...$("exportGroupFields").selectedOptions].map((option) => option.value);
    const selectedValues = [...$("exportGroupValues").selectedOptions].map((option) => option.value);
    if (groupFields.includes(ATTENDANCE_HALVES) && !state.fields.some((field) => /出席番号|出席no|attendance.?number/i.test(field))) return alert("出席番号列が見つかりません。");
    if (groupFields.length === 1 && !selectedValues.length) return alert("シートに分ける値を1つ以上選択してください。");
    const groups = [];
    if (groupFields.length === 1) {
      const field = groupFields[0];
      const attendanceField = state.fields.find((name) => /出席番号|出席no|attendance.?number/i.test(name));
      groups.push(...selectedValues.map((value) => ({
        name: `${value}名簿`,
        rows: records.filter((record) => (field === ATTENDANCE_HALVES ? attendanceHalf(record[attendanceField]) : String(record[field] ?? "")) === value)
      })));
    } else if (groupFields.length > 1) {
      const attendanceField = state.fields.find((name) => /出席番号|出席no|attendance.?number/i.test(name));
      const groupedRows = new Map();
      records.forEach((record) => {
        const values = groupFields.map((field) => field === ATTENDANCE_HALVES
          ? attendanceHalf(record[attendanceField])
          : String(record[field] ?? "").trim());
        if (values.some((value) => !value)) return;
        const key = JSON.stringify(values);
        if (!groupedRows.has(key)) groupedRows.set(key, { name: `${values.join("_")}名簿`, rows: [] });
        groupedRows.get(key).rows.push(record);
      });
      groups.push(...groupedRows.values());
    } else groups.push({ name: "名簿", rows: records });
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set();
    groups.forEach(({ name, rows }) => {
      if (!rows.length) return;
      const safeName = (base, index = 1) => {
        const normalizedBase = String(base).replace(/[\u0000-\u001f:\/?*\[\]]/g, "_").replace(/^'+|'+$/g, "").trim() || "名簿";
        const candidate = `${normalizedBase.slice(0, 31 - (index > 1 ? String(index).length + 1 : 0))}${index > 1 ? `_${index}` : ""}`;
        if (!usedNames.has(candidate)) { usedNames.add(candidate); return candidate; }
        return safeName(normalizedBase, index + 1);
      };
      const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows.map((record) => [...fields.map((field) => String(record[field] ?? "")), ...attendanceFields.map(() => "")])], { cellDates: false });
      sheet["!cols"] = headers.map(() => ({ wch: 16 }));
      XLSX.utils.book_append_sheet(workbook, sheet, safeName(name));
    });
    XLSX.writeFile(workbook, "第78回体育祭名簿.xlsx");
    resetLockTimer();
  }

  async function signIn() {
    try {
      await state.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (error) {
      const message = error.code === "auth/popup-blocked" ? "ポップアップがブロックされました。ブラウザーで許可してください。" : "Googleログインに失敗しました。ページを再読み込みしてお試しください。";
      setMessage("unlockMessage", message, true);
    }
  }

  try {
    if (!FIRESTORE_RULES_READY) {
      setMessage("unlockMessage", "FirebaseのFirestoreルール設定が未確認のため、生徒照会を停止しています。設定手順は firebase/student-directory.rules.fragment を確認してください。", true);
      $("googleLoginButton").disabled = true;
      return;
    }
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
    state.auth = firebase.auth(app);
    state.db = firebase.firestore(app);
    $("googleLoginButton").addEventListener("click", signIn);
    state.auth.onAuthStateChanged(async (user) => {
      clearTimeout(state.lockTimer);
      state.user = user;
      if (!user) {
        state.rows = [];
        state.fields = [];
        state.selectedStudentIndices.clear();
        $("directoryPanel").classList.add("hidden");
        $("unlockPanel").classList.remove("hidden");
        $("lockButton").classList.add("hidden");
        $("results").replaceChildren();
        return;
      }
      if (!user.emailVerified || !AUTHORIZED_EMAILS.has(user.email?.toLowerCase())) {
        setMessage("unlockMessage", `このページを利用できるのは許可されたGoogleアカウントのみです。現在のアカウント: ${user.email ?? "不明"}`, true);
        await state.auth.signOut();
        return;
      }
      try {
        setMessage("unlockMessage", "共有名簿を読み込んでいます…");
        await loadCloudDirectory();
        $("unlockMessage").textContent = "";
      } catch (error) {
        $("directoryPanel").classList.add("hidden");
        $("unlockPanel").classList.remove("hidden");
        const message = error.code === "permission-denied"
          ? "Firebaseの読み取りルールで拒否されました。Firestoreルールを設定してから再度お試しください。"
          : "共有名簿を読み込めませんでした。ネットワークとFirebase設定を確認してください。";
        setMessage("unlockMessage", message, true);
      }
    });
  } catch (error) {
    setMessage("unlockMessage", "Firebaseを初期化できませんでした。ネットワーク接続を確認してください。", true);
    $("googleLoginButton").disabled = true;
  }
  $("importFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = await readFile(file);
      stageImport(imported.sheets);
    } catch (error) {
      console.error("Excel/CSVの読み込みに失敗しました:", error);
      $("importOptions").classList.add("hidden");
      $("importFile").value = "";
      const detail = String(error?.message || error || "不明なエラー").slice(0, 180);
      const hint = detail.toLowerCase().includes("password") || detail.toLowerCase().includes("encrypted")
        ? "パスワードなしの.xlsxまたはCSV UTF-8で保存し直してください。"
        : "対応形式はCSVまたは.xlsxです。詳細を確認して再度お試しください。";
      setMessage("importStatus", `読み込み失敗: ${detail}。${hint}`, true);
    }
  });
  $("sheetSelect").addEventListener("change", updateImportKeyOptions);
  $("importMode").addEventListener("change", () => $("keyField").closest("label").classList.toggle("hidden", $("importMode").value !== "merge"));
  $("confirmImport").addEventListener("click", () => commitImport().catch((error) => setMessage("importStatus", error.message || "Firebaseへの保存に失敗しました。アクセスルールと接続を確認してください。", true)));
  $("cancelImport").addEventListener("click", () => { state.staged = null; $("importOptions").classList.add("hidden"); $("importFile").value = ""; });
  $("query").addEventListener("input", () => { renderResults(); renderExportGroupValues(); resetLockTimer(); });
  $("exportGroupFields").addEventListener("change", renderExportGroupValues);
  $("exportButton").addEventListener("click", exportAttendanceWorkbook);
  $("viewMode").addEventListener("change", renderResults);
  $("viewMode").addEventListener("change", () => document.body.classList.toggle("wide-table-view", $("viewMode").value === "table"));
  $("studentPickerSearch").addEventListener("input", renderStudentCandidates);
  $("assignmentField").addEventListener("change", renderAssignmentFields);
  $("assignValueButton").addEventListener("click", async () => {
    const indices = [...state.selectedStudentIndices].filter((index) => state.rows[index]), field = $("assignmentField").value, value = $("assignmentValue").value.trim();
    if (!indices.length || !field) return;
    if (!value) return setMessage("editStatus", "追加する文字列を入力してください。", true);
    const previousValues = indices.map((index) => state.rows[index][field] ?? "");
    indices.forEach((index) => { state.rows[index][field] = value; });
    try {
      await persist(); setMessage("editStatus", `選択した${indices.length}人の「${field}」を保存しました。`); $("assignmentValue").value = ""; state.selectedStudentIndices.clear(); renderStudentCandidates(); renderResults(); resetLockTimer();
    } catch (error) {
      indices.forEach((index, i) => { state.rows[index][field] = previousValues[i]; }); setMessage("editStatus", `保存できませんでした: ${error.message}`, true);
    }
  });
  $("addFieldForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = $("newFieldName").value.trim();
    if (!field) return;
    if (state.fields.includes(field)) return setMessage("editStatus", "同じ名前の項目がすでにあります。", true);
    const oldFields = state.fields, oldRows = state.rows.map((row) => ({ ...row }));
    state.fields = [...state.fields, field]; state.rows.forEach((row) => { row[field] = ""; });
    try {
      await persist(); $("newFieldName").value = ""; setMessage("editStatus", `「${field}」を追加して保存しました。`); renderDirectory(); $("assignmentField").value = field; renderAssignmentFields();
    } catch (error) {
      state.fields = oldFields; state.rows = oldRows; setMessage("editStatus", `保存できませんでした: ${error.message}`, true);
    }
  });
  $("lockButton").addEventListener("click", () => lock());
  ["pointerdown", "keydown"].forEach((eventName) => document.addEventListener(eventName, () => { if (state.user) resetLockTimer(); }, { passive: true }));
})();
