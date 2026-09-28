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
  const AUTHORIZED_EMAIL = "jh62231310@s.musashi.ed.jp";
  // Enable only after merging the matching rule into Firebase Console and checking for broad wildcard grants.
  const FIRESTORE_RULES_READY = false;
  const DIRECTORY_DOC = "student_directory/current";
  const MAX_DIRECTORY_BYTES = 850_000;
  const ID_HINT = /4桁番号|学籍番号|生徒番号|個人番号|student.?id|^id$/i;
  const SENSITIVE_HINT = /mail|メール|電話|phone|住所|address/i;
  const SPORT_HINT = /球技|競技|種目|sport/i;
  const state = { rows: [], fields: [], filters: {}, staged: null, lockTimer: 0, db: null, auth: null, user: null, unsubscribe: null };
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
    const previousRows = state.rows;
    const previousFields = state.fields;
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
        $("directoryPanel").classList.add("hidden");
        $("unlockPanel").classList.remove("hidden");
        $("lockButton").classList.add("hidden");
        $("results").replaceChildren();
        return;
      }
      if (!user.emailVerified || user.email?.toLowerCase() !== AUTHORIZED_EMAIL) {
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
      stageImport(await readFile(file));
    } catch (error) {
      $("importOptions").classList.add("hidden");
      $("importFile").value = "";
      setMessage("importStatus", error.message?.includes("password") || error.message?.includes("encrypted") ? "このExcelはパスワード付きです。ExcelでローカルにCSV UTF-8またはパスワードなし.xlsxとして保存してから読み込んでください。" : "ファイルを読み込めませんでした。CSV UTF-8またはパスワードなしの.xlsxを選択してください。", true);
    }
  });
  $("sheetSelect").addEventListener("change", updateImportKeyOptions);
  $("importMode").addEventListener("change", () => $("keyField").closest("label").classList.toggle("hidden", $("importMode").value !== "merge"));
  $("confirmImport").addEventListener("click", () => commitImport().catch((error) => setMessage("importStatus", error.message || "Firebaseへの保存に失敗しました。アクセスルールと接続を確認してください。", true)));
  $("cancelImport").addEventListener("click", () => { state.staged = null; $("importOptions").classList.add("hidden"); $("importFile").value = ""; });
  $("query").addEventListener("input", () => { renderResults(); resetLockTimer(); });
  $("exportButton").addEventListener("click", exportCsv);
  $("lockButton").addEventListener("click", () => lock());
  ["pointerdown", "keydown"].forEach((eventName) => document.addEventListener(eventName, () => { if (state.user) resetLockTimer(); }, { passive: true }));
})();
