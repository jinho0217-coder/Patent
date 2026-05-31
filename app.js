/* ============================================================
   한빛그룹 특허 현황 대시보드
   - data/patents.json 을 불러와 통계/차트/테이블을 렌더링
   ============================================================ */

const STATE = {
  data: null,
  companyMap: {},   // id -> company
  statusMap: {},    // id -> statusMeta
  filtered: [],
  sort: { key: "filingDate", dir: "desc" },
  charts: {},
  partMetrics: {},  // companyId -> { pending, disclosure, idea, target:[q1,q2,q3,q4] }
  history: [],      // 데이터 수정 스냅샷 (현재 + 최대 3단계 이전)
  histIndex: -1,
  showAll: false,   // 특허 목록 전체 표시 여부
};

/* ---------- 유틸 ---------- */
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
function companyName(id) { return STATE.companyMap[id]?.name || id; }
function companyColor(id) { return cssVar("--" + (STATE.companyMap[id]?.color || "chart-1")); }
function statusLabel(id) { return STATE.statusMap[id]?.label || id; }
function withAlpha(oklchStr, a) {
  // "oklch(0.52 0.13 144)" -> "oklch(0.52 0.13 144 / a)"
  const m = oklchStr.match(/^oklch\(([^)]+)\)$/);
  return m ? `oklch(${m[1]} / ${a})` : oklchStr;
}
function statusTone(id) { return STATE.statusMap[id]?.tone || "muted"; }
function fmtDate(d) { return d ? d : "—"; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const COUNTRY_FLAG = { KR: "🇰🇷", US: "🇺🇸", EP: "🇪🇺", JP: "🇯🇵", CN: "🇨🇳" };

/* ISO 8601 주차 계산 */
function isoWeek(date) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = t.getUTCDay() || 7;        // 월=1 … 일=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // 해당 주의 목요일
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}
// 오늘 기준 제목 문자열: "그룹 2026년 2Q W22 특허 현황"
function buildPeriodTitle() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  const w = isoWeek(now);
  return `그룹 ${now.getFullYear()}년 ${q}Q W${w} 특허 현황`;
}

/* ---------- 데이터 로드 ---------- */
async function loadData() {
  try {
    const res = await fetch("data/patents.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    console.error("데이터 로드 실패:", err);
    document.querySelector(".content").innerHTML =
      `<div class="card"><div class="card-body empty">
        <h3>데이터를 불러올 수 없습니다.</h3>
        <p style="margin-top:.5rem">로컬 파일을 직접 열면 브라우저 보안 정책(CORS)으로 JSON 로드가 차단됩니다.<br>
        프로젝트 폴더에서 로컬 서버를 실행해 주세요. 예) <code>python -m http.server 5500</code></p>
       </div></div>`;
    return null;
  }
}

/* ---------- 로컬 저장 (직접 입력 데이터 영속화) ---------- */
const STORAGE_KEY = "amd_patents_v1";
function loadSavedPatents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePatents() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.data.patents)); } catch {}
}

/* ---------- 파트별 지표(심사중/직발서/아이디어/분기목표) 저장 ---------- */
const STORAGE_KEY_METRICS = "amd_part_metrics_v1";
function emptyMetric() { return { pending: 0, disclosure: 0, idea: 0, target: [0, 0, 0, 0] }; }
function loadPartMetrics() {
  let saved = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_METRICS);
    if (raw) saved = JSON.parse(raw);
  } catch {}
  const out = {};
  STATE.data.companies.forEach(c => {
    out[c.id] = Object.assign(emptyMetric(), saved[c.id] || {});
    if (!Array.isArray(out[c.id].target)) out[c.id].target = [0, 0, 0, 0];
  });
  return out;
}
function savePartMetrics() {
  try { localStorage.setItem(STORAGE_KEY_METRICS, JSON.stringify(STATE.partMetrics)); } catch {}
}
function partMetric(id) { return STATE.partMetrics[id] || emptyMetric(); }

/* ---------- 그룹 분기별 목표 (A1 / A) ---------- */
const STORAGE_KEY_GOALS = "amd_group_goals_v1";
function getGroupGoalsSnapshot() {
  const goals = STATE.data?.goals;
  if (!goals) return null;
  return {
    year: goals.year,
    grades: goals.grades.map(g => ({ id: g.id, quarterlyTarget: [...g.quarterlyTarget] })),
  };
}
function applyGroupGoals(saved) {
  if (!saved?.grades || !STATE.data?.goals) return;
  if (saved.year) STATE.data.goals.year = saved.year;
  saved.grades.forEach(og => {
    const g = STATE.data.goals.grades.find(x => x.id === og.id);
    if (g && Array.isArray(og.quarterlyTarget)) g.quarterlyTarget = [...og.quarterlyTarget];
  });
}
function loadSavedGroupGoals() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GOALS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveGroupGoals() {
  const snap = getGroupGoalsSnapshot();
  if (!snap) return;
  try { localStorage.setItem(STORAGE_KEY_GOALS, JSON.stringify(snap)); } catch {}
}
function sumMetric(key) {
  return STATE.data.companies.reduce((s, c) => s + (partMetric(c.id)[key] || 0), 0);
}

/* ============================================================
   Supabase 클라우드 동기화
   - 특허/파트지표를 클라우드 DB에 저장 → 기기/브라우저 간 공유
   - 네트워크 실패 시 localStorage 캐시로 폴백
   ============================================================ */
const SUPABASE_URL = "https://mxwvbrvwrlknbklcuiuj.supabase.co";
const SUPABASE_KEY = "sb_publishable_tagVH6ooA_ihiaNF8uG72Q_etZiIVkK";
const SB_REST = SUPABASE_URL + "/rest/v1";
const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

function rowToPatent(r) {
  return {
    id: r.id,
    title: r.title || "",
    inventor: r.inventor || "",
    company: r.company || "",
    grade: r.grade || "",
    status: r.status || "pending",
    filingDate: r.filing_date || null,
    field: "", country: "KR", appNo: null, regDate: null, regNo: null,
  };
}
function patentToRow(p) {
  return {
    id: p.id,
    title: p.title || null,
    inventor: p.inventor || null,
    company: p.company || null,
    grade: p.grade || null,
    status: p.status || "pending",
    filing_date: p.filingDate || null,
  };
}

async function cloudLoadPatents() {
  const res = await fetch(`${SB_REST}/patents?select=*&order=filing_date.desc`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error("load patents " + res.status);
  return (await res.json()).map(rowToPatent);
}
async function cloudLoadMetrics() {
  const res = await fetch(`${SB_REST}/part_metrics?select=*`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error("load metrics " + res.status);
  const out = {};
  (await res.json()).forEach(r => {
    out[r.company_id] = {
      pending: r.pending || 0, disclosure: r.disclosure || 0, idea: r.idea || 0,
      target: [r.t1 || 0, r.t2 || 0, r.t3 || 0, r.t4 || 0],
    };
  });
  return out;
}
async function cloudSavePatents(list) {
  const rows = list.filter(p => p.id).map(patentToRow);
  if (rows.length) {
    const res = await fetch(`${SB_REST}/patents`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error("upsert patents " + res.status + " " + (await res.text()));
  }
  // 현재 목록에 없는 행은 클라우드에서 삭제
  const ids = rows.map(r => `"${encodeURIComponent(r.id)}"`);
  const url = ids.length
    ? `${SB_REST}/patents?id=not.in.(${ids.join(",")})`
    : `${SB_REST}/patents?id=not.is.null`;
  const del = await fetch(url, { method: "DELETE", headers: SB_HEADERS });
  if (!del.ok) throw new Error("delete patents " + del.status);
}
async function cloudSaveMetrics(map) {
  const rows = Object.entries(map).map(([cid, m]) => ({
    company_id: cid,
    pending: m.pending || 0, disclosure: m.disclosure || 0, idea: m.idea || 0,
    t1: (m.target || [])[0] || 0, t2: (m.target || [])[1] || 0,
    t3: (m.target || [])[2] || 0, t4: (m.target || [])[3] || 0,
  }));
  if (!rows.length) return;
  const res = await fetch(`${SB_REST}/part_metrics`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("upsert metrics " + res.status + " " + (await res.text()));
}
async function cloudLoadGroupGoals() {
  const res = await fetch(`${SB_REST}/group_goals?select=*`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error("load group_goals " + res.status);
  const rows = await res.json();
  if (!rows.length) return null;
  return {
    year: rows[0].year,
    grades: rows.map(r => ({
      id: r.grade_id,
      quarterlyTarget: [r.t1 || 0, r.t2 || 0, r.t3 || 0, r.t4 || 0],
    })),
  };
}
async function cloudSaveGroupGoals() {
  const goals = STATE.data?.goals;
  if (!goals) return;
  const rows = goals.grades.map(g => ({
    grade_id: g.id,
    year: goals.year,
    t1: g.quarterlyTarget[0] || 0,
    t2: g.quarterlyTarget[1] || 0,
    t3: g.quarterlyTarget[2] || 0,
    t4: g.quarterlyTarget[3] || 0,
  }));
  if (!rows.length) return;
  const res = await fetch(`${SB_REST}/group_goals`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("upsert group_goals " + res.status + " " + (await res.text()));
}

// 초기 클라우드 로드. 클라우드가 비어있고 로컬 데이터가 있으면 1회 업로드(이전).
async function cloudInit() {
  try {
    const [patents, metrics, cloudGoals] = await Promise.all([
      cloudLoadPatents(), cloudLoadMetrics(), cloudLoadGroupGoals(),
    ]);
    const cloudEmpty = patents.length === 0 && Object.keys(metrics).length === 0 && !cloudGoals;
    const localPatents = loadSavedPatents();
    const localGoals = loadSavedGroupGoals();
    const hasLocal = (localPatents && localPatents.length) ||
      Object.values(STATE.partMetrics).some(m => m.pending || m.disclosure || m.idea || (m.target || []).some(Boolean)) ||
      localGoals;
    if (cloudEmpty && hasLocal) {
      if (localPatents) STATE.data.patents = localPatents;
      if (localGoals) applyGroupGoals(localGoals);
      await syncCloud();
    } else {
      STATE.data.patents = patents;
      STATE.data.companies.forEach(c => { if (metrics[c.id]) STATE.partMetrics[c.id] = metrics[c.id]; });
      if (cloudGoals) applyGroupGoals(cloudGoals);
      else if (localGoals) applyGroupGoals(localGoals);
    }
    saveGroupGoals();
    STATE.cloudOk = true;
  } catch (e) {
    console.warn("클라우드 연결 실패 → 로컬 데이터 사용:", e);
    const localPatents = loadSavedPatents();
    if (localPatents) STATE.data.patents = localPatents;
    const localGoals = loadSavedGroupGoals();
    if (localGoals) applyGroupGoals(localGoals);
    STATE.cloudOk = false;
  }
  updateCloudStatus();
}

// 현재 상태 전체를 클라우드에 반영 (비동기, 실패해도 UI 유지)
async function syncCloud() {
  if (!SUPABASE_URL) return;
  try {
    await cloudSavePatents(STATE.data.patents);
    await cloudSaveMetrics(STATE.partMetrics);
    await cloudSaveGroupGoals();
    STATE.cloudOk = true;
  } catch (e) {
    console.warn("클라우드 저장 실패:", e);
    STATE.cloudOk = false;
  }
  updateCloudStatus();
}

function updateCloudStatus() {
  const el = document.getElementById("cloudStatus");
  if (!el) return;
  if (STATE.cloudOk) { el.textContent = "● 클라우드 동기화됨"; el.style.color = "var(--chart-1)"; }
  else { el.textContent = "● 오프라인 (로컬 저장)"; el.style.color = "var(--muted-foreground)"; }
}

/* ---------- 버전 히스토리 (3단계 되돌리기/앞으로) ---------- */
const STORAGE_KEY_HISTORY = "amd_history_v1";
const HISTORY_MAX = 4; // 현재 + 3단계 이전
function cloneSnapshot() {
  return {
    patents: JSON.parse(JSON.stringify(STATE.data.patents)),
    partMetrics: JSON.parse(JSON.stringify(STATE.partMetrics)),
    goals: getGroupGoalsSnapshot(),
    savedAt: new Date().toISOString(),
  };
}
function persistHistory() {
  try {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify({ history: STATE.history, histIndex: STATE.histIndex }));
  } catch {}
}
function initHistory() {
  let saved = null;
  try { const raw = localStorage.getItem(STORAGE_KEY_HISTORY); if (raw) saved = JSON.parse(raw); } catch {}
  if (saved && Array.isArray(saved.history) && saved.history.length) {
    STATE.history = saved.history;
    STATE.histIndex = Math.min(saved.histIndex ?? saved.history.length - 1, saved.history.length - 1);
  } else {
    const snap = cloneSnapshot();
    if (STATE.data.group.updatedAt) snap.savedAt = new Date(STATE.data.group.updatedAt).toISOString();
    STATE.history = [snap];
    STATE.histIndex = 0;
    persistHistory();
  }
}
// 날짜 키 (YYYY-MM-DD)
function dateKey(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 데이터 변경 확정 → "수정일(날짜)" 기준 스냅샷 기록
function commitChange() {
  savePatents();
  savePartMetrics();
  saveGroupGoals();
  const snap = cloneSnapshot();               // savedAt = 현재 시각
  const today = dateKey(snap.savedAt);
  STATE.history = STATE.history.slice(0, STATE.histIndex + 1); // redo 분기 제거
  const last = STATE.history[STATE.history.length - 1];
  if (last && dateKey(last.savedAt) === today) {
    // 같은 날짜면 그날의 마지막 수정 시각으로 갱신 (버전 추가 X)
    STATE.history[STATE.history.length - 1] = snap;
  } else {
    // 새로운 날짜면 새 버전 추가
    STATE.history.push(snap);
    if (STATE.history.length > HISTORY_MAX) STATE.history = STATE.history.slice(-HISTORY_MAX);
  }
  STATE.histIndex = STATE.history.length - 1;
  persistHistory();
  refreshAll();
  updateDataMeta();
  updateHistButtons();
  syncCloud();
}
function applySnapshot(snap) {
  STATE.data.patents = JSON.parse(JSON.stringify(snap.patents));
  STATE.partMetrics = JSON.parse(JSON.stringify(snap.partMetrics));
  if (snap.goals) applyGroupGoals(snap.goals);
  savePatents();
  savePartMetrics();
  saveGroupGoals();
  refreshAll();
  updateDataMeta();
  updateHistButtons();
  syncCloud();
}
function undoChange() {
  if (STATE.histIndex <= 0) return;
  STATE.histIndex--;
  persistHistory();
  applySnapshot(STATE.history[STATE.histIndex]);
}
function redoChange() {
  if (STATE.histIndex >= STATE.history.length - 1) return;
  STATE.histIndex++;
  persistHistory();
  applySnapshot(STATE.history[STATE.histIndex]);
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function updateDataMeta() {
  const snap = STATE.history[STATE.histIndex];
  const el = document.getElementById("updatedAt");
  if (el && snap) el.textContent = fmtDateTime(snap.savedAt);
}
function updateHistButtons() {
  const u = document.getElementById("undoBtn"), r = document.getElementById("redoBtn");
  if (u) u.disabled = STATE.histIndex <= 0;
  if (r) r.disabled = STATE.histIndex >= STATE.history.length - 1;
}

/* ---------- 초기화 ---------- */
async function init() {
  const data = await loadData();
  if (!data) return;
  STATE.data = data;
  data.companies.forEach(c => STATE.companyMap[c.id] = c);
  data.statusMeta.forEach(s => STATE.statusMap[s.id] = s);
  STATE.partMetrics = loadPartMetrics();
  // 클라우드(Supabase)에서 공용 데이터 로드 (실패 시 로컬 캐시 사용)
  await cloudInit();
  // 클라우드가 정상이면 클라우드 상태를 기준으로 히스토리를 새로 시작
  if (STATE.cloudOk) {
    STATE.history = []; STATE.histIndex = -1;
    try { localStorage.removeItem(STORAGE_KEY_HISTORY); } catch {}
  }
  initHistory();

  // 헤더 정보
  document.getElementById("brandName").textContent = data.group.name;
  document.getElementById("brandLogo").textContent = data.group.name.charAt(0);
  document.getElementById("subTitle").textContent = buildPeriodTitle();
  document.getElementById("footBrand").textContent = `${data.group.name} IP 관리시스템`;
  document.title = `${data.group.name} 특허 현황 대시보드`;

  ensureGroupGoals();
  buildStaticFilters();
  buildFormOptions();
  try { bindEvents(); } catch (e) { console.error("bindEvents:", e); }
  bindFormEvents();
  bindMetricEvents();
  bindGoalsEvents();
  refreshAll();
  updateDataMeta();
  updateHistButtons();
}

/* ---------- 데이터 변경 후 전체 갱신 (분기 그래프 자동 연동) ---------- */
function refreshAll() {
  buildCompanyNav();
  rebuildFieldFilter();
  renderKPIs();
  renderCharts();
  renderCompanyBars();
  applyFilters();
}

/* ---------- 사이드바 파트 (클릭 시 지표 입력) ---------- */
function buildCompanyNav() {
  const wrap = document.getElementById("companyNav");
  wrap.innerHTML = STATE.data.companies.map(c => {
    const m = partMetric(c.id);
    const annual = m.target[m.target.length - 1] || 0;
    const done = partQuarterlyCum(c.id)[3];
    const badge = annual ? `${done}/${annual}` : `${done}`;
    return `
    <a href="#" data-company="${c.id}" title="클릭하여 지표 입력">
      <span class="ico" style="color:${cssVar("--" + c.color)}">●</span>
      ${c.name}
      <span class="part-edit">✎</span>
      <span style="margin-left:auto;color:var(--muted-foreground);font-size:.78rem">${badge}</span>
    </a>`;
  }).join("");
  wrap.querySelectorAll("a").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openMetricModal(a.dataset.company);
    });
  });
}

/* ---------- 필터 옵션 ---------- */
function buildStaticFilters() {
  const cf = document.getElementById("companyFilter");
  STATE.data.companies.forEach(c => {
    cf.insertAdjacentHTML("beforeend", `<option value="${c.id}">${c.name}</option>`);
  });
  const sf = document.getElementById("statusFilter");
  STATE.data.statusMeta.forEach(s => {
    sf.insertAdjacentHTML("beforeend", `<option value="${s.id}">${s.label}</option>`);
  });
}

// 기술 분야는 입력 데이터에 따라 변하므로 매번 다시 생성
function rebuildFieldFilter() {
  const ff = document.getElementById("fieldFilter");
  const cur = ff.value;
  const fields = [...new Set(STATE.data.patents.map(p => p.field).filter(Boolean))].sort();
  ff.innerHTML = `<option value="">전체</option>` +
    fields.map(f => `<option value="${f}">${f}</option>`).join("");
  if (fields.includes(cur)) ff.value = cur;
}

// 추가 모달의 파트/상태 셀렉트 채우기
function buildFormOptions() {
  const fc = document.getElementById("formCompany");
  if (fc) fc.innerHTML = STATE.data.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
  const fs = document.getElementById("formStatus");
  if (fs) fs.innerHTML = STATE.data.statusMeta.map(s => `<option value="${s.id}">${s.label}</option>`).join("");
}

/* ---------- 집계 헬퍼 ---------- */
function countBy(arr, key) {
  return arr.reduce((acc, x) => { acc[x[key]] = (acc[x[key]] || 0) + 1; return acc; }, {});
}

/* ---------- KPI ---------- */
function renderKPIs() {
  const cards = STATE.data.kpis || [];
  document.getElementById("overview").innerHTML = cards.map(c => {
    if (c.type === "goal") {
      const g = STATE.data.goals?.grades.find(x => x.id === c.grade);
      const target = g ? g.quarterlyTarget[g.quarterlyTarget.length - 1] : 0;
      const done = gradeAchievement(c.grade).total;
      const pct = target ? Math.round((done / target) * 100) : 0;
      const tone = pct >= 100 ? "up" : "";
      const extra = `<div class="kpi-delta ${tone}">목표 ${target} · 달성률 ${pct}%</div>
        <div class="kpi-progress"><span style="width:${Math.min(pct, 100)}%"></span></div>`;
      return kpiHTML(c.icon, c.label, `${done} <span class="kpi-unit">/ ${target}</span>`, extra, true);
    }
    if (c.type === "metric") {
      const n = sumMetric(c.metric);
      return kpiHTML(c.icon, c.label, n, c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "");
    }
    if (c.type === "status") {
      const n = STATE.data.patents.filter(p => p.status === c.status).length;
      return kpiHTML(c.icon, c.label, n, c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "");
    }
    // manual
    const extra = c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "";
    return kpiHTML(c.icon, c.label, c.value ?? 0, extra);
  }).join("");
}

function kpiHTML(icon, label, value, extra, editable) {
  const cls = editable ? "kpi kpi-editable" : "kpi";
  const attrs = editable ? ' role="button" tabindex="0" data-goal-edit title="클릭하여 그룹 목표 수정"' : "";
  return `
    <div class="${cls}"${attrs}>
      <div class="kpi-icon">${icon || "📌"}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${extra || ""}
    </div>`;
}

/* ---------- 목표 달성 계산 (리스트 데이터 기반, 자동 연동) ---------- */
function quarterOf(dateStr) { return Math.floor(new Date(dateStr).getMonth() / 3) + 1; }

function currentQuarterForYear(year) {
  const now = new Date();
  if (now.getFullYear() > year) return 4;
  if (now.getFullYear() < year) return 0;
  return Math.floor(now.getMonth() / 3) + 1;
}

// A 등급은 전체 특허, A1 등급은 grade가 "A1"인 특허를 집계
function matchGrade(p, gradeId) { return gradeId === "A" ? true : p.grade === gradeId; }

function gradeAchievement(gradeId) {
  const year = STATE.data.goals?.year;
  const perQ = [0, 0, 0, 0];
  STATE.data.patents.forEach(p => {
    if (!p.filingDate) return;
    if (new Date(p.filingDate).getFullYear() !== year) return;
    if (!matchGrade(p, gradeId)) return;
    perQ[quarterOf(p.filingDate) - 1]++;
  });
  const cum = []; let s = 0;
  for (let i = 0; i < 4; i++) { s += perQ[i]; cum.push(s); }
  return { perQ, cum, total: s };
}

/* ---------- 차트 ---------- */
function chartDefaults() {
  Chart.defaults.font.family = cssVar("--font-sans") || "sans-serif";
  Chart.defaults.color = cssVar("--muted-foreground");
  Chart.defaults.borderColor = cssVar("--border");
}

function renderCharts() {
  chartDefaults();
  Object.values(STATE.charts).forEach(c => c.destroy());
  STATE.charts = {};
  renderTrendChart();
  renderStatusChart();
  renderProgressChart();
}

// 오늘 기준 분기의 달성값/달성률을 막대 위에 숫자로 표기하는 플러그인
const currentQuarterLabel = {
  id: "currentQuarterLabel",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins.currentQuarterLabel || {};
    const qIdx = opt.qIndex;
    if (qIdx == null || qIdx < 0) return;
    const ctx = chart.ctx;
    chart.data.datasets.forEach((ds, di) => {
      if (!ds._target) return; // 달성(막대) 데이터셋만
      const meta = chart.getDatasetMeta(di);
      const el = meta.data[qIdx];
      const val = ds.data[qIdx];
      if (!el || val == null) return;
      const t = ds._target[qIdx];
      const pct = t ? Math.round((val / t) * 100) : 0;
      ctx.save();
      ctx.font = `bold 12px ${cssVar("--font-sans") || "sans-serif"}`;
      ctx.fillStyle = ds.borderColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${val} (${pct}%)`, el.x, el.y - 5);
      ctx.restore();
    });
  },
};

function renderTrendChart() {
  const goals = STATE.data.goals;
  const ctx = document.getElementById("trendChart");
  if (!goals) return;

  const labels = ["1분기", "2분기", "3분기", "4분기"];
  const maxQ = currentQuarterForYear(goals.year);
  const datasets = [];

  // 분기별 누적 목표 (점선)
  goals.grades.forEach(g => {
    datasets.push({
      type: "line",
      label: g.label,
      data: g.quarterlyTarget,
      borderColor: cssVar("--" + g.color),
      backgroundColor: "transparent",
      borderDash: [6, 4], borderWidth: 2, tension: 0,
      pointStyle: "rectRot", pointRadius: 4, pointHoverRadius: 6,
      fill: false, order: 0,
    });
  });

  // 분기별 누적 달성 (막대) — 현재 분기까지만 표시, 리스트 데이터와 자동 연동
  goals.grades.forEach(g => {
    const ach = gradeAchievement(g.id);
    datasets.push({
      type: "bar",
      label: g.id + " 달성",
      data: ach.cum.map((v, i) => (i < maxQ ? v : null)),
      backgroundColor: withAlpha(cssVar("--" + g.color), 0.55),
      borderColor: cssVar("--" + g.color), borderWidth: 1.5,
      borderRadius: 4, borderSkipped: false, order: 1,
      _target: g.quarterlyTarget,
    });
  });

  // 부제: 연간 달성률 요약
  const sub = goals.grades.map(g => {
    const t = g.quarterlyTarget[g.quarterlyTarget.length - 1];
    const done = gradeAchievement(g.id).total;
    const pct = t ? Math.round((done / t) * 100) : 0;
    return `${g.id} ${done}/${t} (${pct}%)`;
  }).join(" · ");
  const subEl = document.getElementById("trendSub");
  if (subEl) subEl.textContent = `${goals.year}년 · ${sub}`;

  STATE.charts.trend = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    plugins: [currentQuarterLabel],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 20 } },
      plugins: {
        currentQuarterLabel: { qIndex: maxQ - 1 },
        legend: { position: "bottom", labels: { padding: 12, usePointStyle: true, pointStyle: "circle" } },
        tooltip: {
          backgroundColor: cssVar("--popover"), titleColor: cssVar("--popover-foreground"),
          bodyColor: cssVar("--popover-foreground"), borderColor: cssVar("--border"), borderWidth: 1,
          padding: 10, cornerRadius: 8,
          callbacks: {
            afterLabel: (item) => {
              const ds = item.dataset;
              if (ds._target && item.parsed.y != null) {
                const t = ds._target[item.dataIndex];
                const pct = t ? Math.round((item.parsed.y / t) * 100) : 0;
                return `  → 분기목표 ${t} · 달성률 ${pct}%`;
              }
              return "";
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "누적 건수" } },
        x: { grid: { display: false } },
      },
    },
  });
}

// 도넛 각 조각에 값을 숫자로 표시
const doughnutValueLabel = {
  id: "doughnutValueLabel",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const ds = chart.data.datasets[0];
    const ctx = chart.ctx;
    meta.data.forEach((arc, i) => {
      const val = ds.data[i];
      if (!val) return;
      const pos = arc.tooltipPosition();
      ctx.save();
      ctx.font = `bold 13px ${cssVar("--font-sans") || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.strokeText(String(val), pos.x, pos.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(val), pos.x, pos.y);
      ctx.restore();
    });
  },
};

function renderStatusChart() {
  const patents = STATE.data.patents;
  const dist = [
    { label: "등록", value: patents.filter(p => p.status === "registered").length, color: "--chart-1" },
    { label: "심사중", value: sumMetric("pending"), color: "--chart-3" },
    { label: "직발서", value: sumMetric("disclosure"), color: "--chart-5" },
    { label: "아이디어", value: sumMetric("idea"), color: "--accent" },
  ];
  STATE.charts.status = new Chart(document.getElementById("statusChart"), {
    type: "doughnut",
    data: {
      labels: dist.map(d => d.label),
      datasets: [{
        data: dist.map(d => d.value),
        backgroundColor: dist.map(d => cssVar(d.color)),
        borderColor: cssVar("--card"), borderWidth: 3, hoverOffset: 8,
      }],
    },
    plugins: [doughnutValueLabel],
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: {
        legend: { position: "bottom", labels: { padding: 14, usePointStyle: true, pointStyle: "circle" } },
        tooltip: { callbacks: { label: (i) => ` ${i.label}: ${i.parsed}건` } },
      },
    },
  });
}

/* 파트별 분기 누적 출원 건수 (goal 연도 기준) */
function partQuarterlyCum(companyId) {
  const year = STATE.data.goals?.year;
  const perQ = [0, 0, 0, 0];
  STATE.data.patents.forEach(p => {
    if (p.company !== companyId) return;
    if (!p.filingDate || new Date(p.filingDate).getFullYear() !== year) return;
    perQ[quarterOf(p.filingDate) - 1]++;
  });
  const cum = []; let s = 0;
  for (let i = 0; i < 4; i++) { s += perQ[i]; cum.push(s); }
  return cum;
}

/* 파트별 분기 누적 출원을 등급(A1/A)별로 분리 */
function partQuarterlyCumByGrade(companyId) {
  const year = STATE.data.goals?.year;
  const a1 = [0, 0, 0, 0], a = [0, 0, 0, 0];
  STATE.data.patents.forEach(p => {
    if (p.company !== companyId) return;
    if (!p.filingDate || new Date(p.filingDate).getFullYear() !== year) return;
    const q = quarterOf(p.filingDate) - 1;
    if (p.grade === "A1") a1[q]++; else a[q]++;
  });
  const cum = (arr) => { const o = []; let s = 0; for (let i = 0; i < 4; i++) { s += arr[i]; o.push(s); } return o; };
  return { a1: cum(a1), a: cum(a) };
}

// 누적 막대(스택) 위에 현재 분기 합계를 숫자로 표기
const miniQuarterLabel = {
  id: "miniQuarterLabel",
  afterDatasetsDraw(chart) {
    const qIdx = (chart.options.plugins.miniQuarterLabel || {}).qIndex;
    if (qIdx == null || qIdx < 0) return;
    const ctx = chart.ctx;
    let total = 0, topY = Infinity, x = null;
    chart.data.datasets.forEach((ds, di) => {
      if (ds.type === "line") return;
      const v = ds.data[qIdx];
      if (v == null) return;
      total += v;
      const el = chart.getDatasetMeta(di).data[qIdx];
      if (el && el.y < topY) { topY = el.y; x = el.x; }
    });
    if (x == null || total === 0) return;
    ctx.save();
    ctx.font = `bold 12px ${cssVar("--font-sans") || "sans-serif"}`;
    ctx.fillStyle = cssVar("--foreground");
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(total), x, topY - 4);
    ctx.restore();
  },
};

/* 파트별 진행 현황: 파트마다 개별 미니 차트 (A1·A 누적 스택 + 목표 점선) */
function renderProgressChart() {
  const goals = STATE.data.goals;
  const grid = document.getElementById("progressGrid");
  if (!goals || !grid) return;

  const labels = ["1Q", "2Q", "3Q", "4Q"];
  const maxQ = currentQuarterForYear(goals.year);
  const a1Color = cssVar("--chart-5"); // 진한 초록 = A1

  const subEl = document.getElementById("progressSub");
  if (subEl) subEl.textContent = `${goals.year}년 · 파트별 분기 누적 (■ A1 진한초록 / ■ A 파트색 / ┄ 목표)`;

  // 각 파트 카드 DOM 생성
  grid.innerHTML = STATE.data.companies.map(c => `
    <div class="mini-card">
      <div class="mini-title">
        <span class="swatch" style="background:${cssVar("--" + c.color)}"></span>${c.name}
        <span class="mini-meta" id="meta_${c.id}"></span>
      </div>
      <div class="mini-chart"><canvas id="prog_${c.id}"></canvas></div>
    </div>`).join("");

  STATE.data.companies.forEach(c => {
    const g = partQuarterlyCumByGrade(c.id);
    const target = partMetric(c.id).target;
    const hasTarget = target.some(v => v > 0);
    const color = cssVar("--" + c.color);
    const cap = (arr) => arr.map((v, i) => (i < maxQ ? v : null));

    // 메타: 연간 실적/목표 (달성률)
    const annual = target[target.length - 1] || 0;
    const done = g.a1[3] + g.a[3];
    const meta = document.getElementById("meta_" + c.id);
    if (meta) meta.textContent = annual ? `${done}/${annual} · ${Math.round((done / annual) * 100)}%` : `${done}건`;

    const datasets = [
      {
        type: "bar", label: "A1", data: cap(g.a1),
        backgroundColor: a1Color, borderColor: a1Color, borderWidth: 1,
        stack: "ach", borderRadius: 2, borderSkipped: false,
      },
      {
        type: "bar", label: "A", data: cap(g.a),
        backgroundColor: withAlpha(color, 0.55), borderColor: color, borderWidth: 1,
        stack: "ach", borderRadius: 2, borderSkipped: false,
      },
    ];
    if (hasTarget) {
      datasets.push({
        type: "line", label: "목표", data: target,
        borderColor: cssVar("--muted-foreground"), backgroundColor: "transparent",
        borderWidth: 1.5, borderDash: [4, 3], tension: 0,
        pointStyle: "rectRot", pointRadius: 2.5, fill: false,
      });
    }

    STATE.charts["prog_" + c.id] = new Chart(document.getElementById("prog_" + c.id), {
      data: { labels, datasets },
      plugins: [miniQuarterLabel],
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 16 } },
        plugins: {
          miniQuarterLabel: { qIndex: maxQ - 1 },
          legend: { display: false },
          tooltip: {
            backgroundColor: cssVar("--popover"), titleColor: cssVar("--popover-foreground"),
            bodyColor: cssVar("--popover-foreground"), borderColor: cssVar("--border"), borderWidth: 1,
            padding: 8, cornerRadius: 6,
            callbacks: {
              label: (item) => item.parsed.y == null ? null : ` ${item.dataset.label}: ${item.parsed.y}건`,
            },
          },
        },
        scales: {
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 9 } } },
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  });
}

function baseOptions({ legend }) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: legend ? { position: "bottom", labels: { padding: 12, usePointStyle: true, pointStyle: "circle" } } : { display: false },
      tooltip: {
        backgroundColor: cssVar("--popover"), titleColor: cssVar("--popover-foreground"),
        bodyColor: cssVar("--popover-foreground"), borderColor: cssVar("--border"), borderWidth: 1,
        padding: 10, cornerRadius: 8,
      },
    },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
  };
}

/* ---------- 파트 포트폴리오 바 (특허·심사중·직발서·아이디어 구성비) ---------- */
const PORTFOLIO_CATS = [
  { key: "patent", label: "특허", color: "--chart-1" },
  { key: "pending", label: "심사중", color: "--chart-3" },
  { key: "disclosure", label: "직발서", color: "--chart-5" },
  { key: "idea", label: "아이디어", color: "--accent" },
];

function partCatValues(companyId) {
  const m = partMetric(companyId);
  return {
    patent: STATE.data.patents.filter(p => p.company === companyId).length, // A1 + A
    pending: m.pending || 0,
    disclosure: m.disclosure || 0,
    idea: m.idea || 0,
  };
}

function renderCompanyBars() {
  const wrap = document.getElementById("companyBars");
  const legend = `<div class="legend">${PORTFOLIO_CATS.map(cat =>
    `<span class="item"><span class="swatch" style="background:${cssVar(cat.color)}"></span>${cat.label}</span>`).join("")}</div>`;

  const rows = STATE.data.companies.map(c => {
    const vals = partCatValues(c.id);
    const total = PORTFOLIO_CATS.reduce((s, cat) => s + vals[cat.key], 0);
    return { c, vals, total };
  });
  // 막대 길이를 절대 건수에 비례시키기 위한 최댓값 (파트 간 수량 비교 가능)
  const maxTotal = Math.max(1, ...rows.map(r => r.total));

  const bars = rows.sort((a, b) => b.total - a.total).map(({ c, vals, total }) => {
    // 각 구간 너비 = 건수 / 전체 최댓값 → 합계가 클수록 막대가 길어짐
    const segs = PORTFOLIO_CATS.map(cat => {
      const v = vals[cat.key];
      if (!v) return "";
      const w = (v / maxTotal) * 100;
      const share = total ? Math.round((v / total) * 100) : 0;
      return `<div class="seg" style="width:${w}%;background:${cssVar(cat.color)}" title="${cat.label} ${v}건 (${share}%)"><span class="seg-num">${v}</span></div>`;
    }).join("");
    const breakdown = PORTFOLIO_CATS.filter(cat => vals[cat.key])
      .map(cat => `${cat.label} ${vals[cat.key]}`).join(" · ") || "데이터 없음";
    return `<div class="bar-row">
      <div class="bar-top">
        <span class="name"><span class="company-tag"><span class="swatch" style="background:${cssVar("--" + c.color)}"></span>${c.name}</span></span>
        <span class="val">${total}건</span>
      </div>
      <div class="bar-track stacked">${segs}</div>
      <div class="bar-breakdown">${breakdown}</div>
    </div>`;
  }).join("");

  wrap.innerHTML = legend + bars;
}

/* ---------- 필터 & 테이블 ---------- */
function applyFilters() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const cf = document.getElementById("companyFilter").value;
  const sf = document.getElementById("statusFilter").value;
  const ff = document.getElementById("fieldFilter").value;

  STATE.filtered = STATE.data.patents.filter(p => {
    if (cf && p.company !== cf) return false;
    if (sf && p.status !== sf) return false;
    if (ff && p.field !== ff) return false;
    if (q) {
      const hay = `${p.id} ${p.title} ${p.inventor} ${p.appNo || ""} ${p.regNo || ""} ${companyName(p.company)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  sortFiltered();
  renderTable();
}

function sortFiltered() {
  const { key, dir } = STATE.sort;
  const mul = dir === "asc" ? 1 : -1;
  STATE.filtered.sort((a, b) => {
    let va = a[key] ?? "", vb = b[key] ?? "";
    if (key === "company") { va = companyName(a.company); vb = companyName(b.company); }
    if (key === "status") { va = statusLabel(a.status); vb = statusLabel(b.status); }
    return String(va).localeCompare(String(vb), "ko", { numeric: true }) * mul;
  });
}

const TABLE_PAGE = 7; // 기본 표시 개수

function renderTable() {
  const body = document.getElementById("tableBody");
  const rows = STATE.filtered;
  const visible = STATE.showAll ? rows : rows.slice(0, TABLE_PAGE);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">등록된 특허가 없습니다. 우측 상단의 “＋ 특허 추가”로 입력하면 분기 그래프가 자동 갱신됩니다.</td></tr>`;
  } else {
    body.innerHTML = visible.map(p => `
      <tr class="row-edit" data-id="${esc(p.id)}" title="클릭하여 수정">
        <td class="mono">${p.id}</td>
        <td class="cell-title">${esc(p.title)}</td>
        <td>${esc(p.inventor) || "—"}</td>
        <td><span class="company-tag"><span class="swatch" style="background:${companyColor(p.company)}"></span>${companyName(p.company)}</span></td>
        <td><span class="badge ${p.grade === "A1" ? "primary" : "outline"}">${p.grade || "—"}</span></td>
        <td class="mono">${fmtDate(p.filingDate)}</td>
        <td><button class="btn icon row-del" data-id="${esc(p.id)}" title="삭제">🗑</button></td>
      </tr>`).join("");
    body.querySelectorAll("tr.row-edit").forEach(tr =>
      tr.addEventListener("click", () => {
        const p = STATE.data.patents.find(x => x.id === tr.dataset.id);
        if (p) openModal(p);
      }));
    body.querySelectorAll(".row-del").forEach(btn =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); deletePatent(btn.dataset.id); }));
  }

  // "모두 보기" 버튼 표시/문구
  const more = document.getElementById("tableMore");
  const toggle = document.getElementById("toggleAllBtn");
  if (more && toggle) {
    if (rows.length > TABLE_PAGE) {
      more.hidden = false;
      toggle.textContent = STATE.showAll ? "접기 ▲" : `모두 보기 (${rows.length}건) ▼`;
    } else {
      more.hidden = true;
    }
  }

  const shown = visible.length;
  document.getElementById("resultCount").textContent =
    STATE.showAll || rows.length <= TABLE_PAGE ? `총 ${rows.length}건 표시` : `총 ${rows.length}건 중 ${shown}건 표시`;
  document.getElementById("listSub").textContent =
    rows.length === STATE.data.patents.length ? "전체 특허" : `필터 적용됨 (${rows.length}건)`;
  updateSortArrows();
}

function updateSortArrows() {
  document.querySelectorAll("thead th.sortable").forEach(th => {
    const arrow = th.querySelector(".arrow");
    if (th.dataset.sort === STATE.sort.key) arrow.textContent = STATE.sort.dir === "asc" ? "▲" : "▼";
    else arrow.textContent = "";
  });
}

/* ---------- 이벤트 ---------- */
function bindEvents() {
  document.getElementById("searchInput").addEventListener("input", debounce(applyFilters, 200));
  ["companyFilter", "statusFilter", "fieldFilter"].forEach(id =>
    document.getElementById(id).addEventListener("change", applyFilters));

  document.querySelectorAll("thead th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === "asc" ? "desc" : "asc";
      else { STATE.sort.key = key; STATE.sort.dir = "asc"; }
      sortFiltered();
      renderTable();
    });
  });

  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("undoBtn")?.addEventListener("click", undoChange);
  document.getElementById("redoBtn")?.addEventListener("click", redoChange);

  document.getElementById("toggleAllBtn")?.addEventListener("click", () => {
    STATE.showAll = !STATE.showAll;
    renderTable();
  });

  // 사이드바 active 표시
  document.querySelectorAll(".nav a[href^='#']").forEach(a => {
    a.addEventListener("click", (e) => {
      document.querySelectorAll(".nav a").forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      // 대시보드 클릭 시 페이지 최상단으로 스크롤
      if (a.getAttribute("href") === "#overview") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  });
}

/* ---------- 특허 추가/수정/삭제 (직접 입력 → 그래프 자동 연동) ---------- */
let editingId = null;

function openModal(patent) {
  const m = document.getElementById("addModal");
  const form = document.getElementById("addForm");
  const idInput = form.querySelector('[name="id"]');
  form.reset();
  if (patent) {
    // 수정 모드
    editingId = patent.id;
    document.getElementById("addModalTitle").textContent = "특허 수정";
    idInput.value = patent.id;
    idInput.readOnly = false;
    form.querySelector('[name="filingDate"]').value = patent.filingDate || "";
    form.querySelector('[name="title"]').value = patent.title || "";
    form.querySelector('[name="company"]').value = patent.company || "";
    form.querySelector('[name="grade"]').value = patent.grade || "A1";
    form.querySelector('[name="inventor"]').value = patent.inventor || "";
  } else {
    // 추가 모드
    editingId = null;
    document.getElementById("addModalTitle").textContent = "특허 추가";
    idInput.readOnly = false;
    idInput.value = suggestId();
  }
  m.hidden = false;
  setTimeout(() => form.querySelector('[name="title"]').focus(), 50);
}
function closeModal() {
  document.getElementById("addModal").hidden = true;
  editingId = null;
}

function suggestId() {
  const year = STATE.data.goals?.year || new Date().getFullYear();
  const nums = STATE.data.patents
    .map(p => (p.id || "").match(new RegExp(`P-${year}-(\\d+)`)))
    .filter(Boolean).map(m => parseInt(m[1], 10));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `P-${year}-${String(next).padStart(3, "0")}`;
}

function bindFormEvents() {
  const addBtn = document.getElementById("addBtn");
  if (addBtn) addBtn.addEventListener("click", openModal);
  document.getElementById("modalClose")?.addEventListener("click", closeModal);
  document.getElementById("modalCancel")?.addEventListener("click", closeModal);
  document.getElementById("addModal")?.addEventListener("click", (e) => {
    if (e.target.id === "addModal") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("addModal").hidden) closeModal();
  });
  document.getElementById("addForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const p = Object.fromEntries(fd.entries());

    if (editingId) {
      // 수정: 기존 항목의 폼에 없는 필드(상태/분야/국가/번호 등)는 보존
      const idx = STATE.data.patents.findIndex(x => x.id === editingId);
      if (idx < 0) { closeModal(); return; }
      // 관리번호를 바꾼 경우 중복 검사
      if (p.id !== editingId && STATE.data.patents.some(x => x.id === p.id)) {
        alert("이미 존재하는 관리번호입니다.");
        return;
      }
      const cur = STATE.data.patents[idx];
      STATE.data.patents[idx] = {
        ...cur,
        id: p.id,
        filingDate: p.filingDate,
        title: p.title,
        company: p.company,
        grade: p.grade,
        inventor: p.inventor || "",
      };
      commitChange();
      closeModal();
      return;
    }

    // 추가
    if (STATE.data.patents.some(x => x.id === p.id)) {
      alert("이미 존재하는 관리번호입니다.");
      return;
    }
    // 폼에서 제거된 항목은 기본값으로 채움 (신규 출원 = 심사중)
    p.status = p.status || "pending";
    p.field = p.field || "";
    p.country = p.country || "KR";
    p.appNo = p.appNo || null;
    p.regDate = p.regDate || null;
    p.regNo = p.regNo || null;
    addPatent(p);
    closeModal();
  });
}

function addPatent(p) {
  STATE.data.patents.push(p);
  commitChange();
}

function deletePatent(id) {
  const p = STATE.data.patents.find(x => x.id === id);
  if (!confirm(`'${p ? p.title : id}' 특허를 삭제할까요?`)) return;
  STATE.data.patents = STATE.data.patents.filter(x => x.id !== id);
  commitChange();
}

/* ---------- 파트별 지표 입력 (심사중/직발서/아이디어 + 분기 목표) ---------- */
function openMetricModal(companyId) {
  const m = partMetric(companyId);
  const form = document.getElementById("metricForm");
  document.getElementById("metricPartName").textContent = companyName(companyId);
  form.companyId.value = companyId;
  form.pending.value = m.pending || 0;
  form.disclosure.value = m.disclosure || 0;
  form.idea.value = m.idea || 0;
  form.t1.value = m.target[0] || 0;
  form.t2.value = m.target[1] || 0;
  form.t3.value = m.target[2] || 0;
  form.t4.value = m.target[3] || 0;
  document.getElementById("metricModal").hidden = false;
}
function closeMetricModal() { document.getElementById("metricModal").hidden = true; }

/* ---------- 그룹 분기별 출원 목표 입력 ---------- */
function ensureGroupGoals() {
  if (!STATE.data) return;
  if (STATE.data.goals?.grades?.length >= 2) return;
  STATE.data.goals = {
    year: STATE.data.goals?.year || new Date().getFullYear(),
    grades: [
      { id: "A1", label: "A1 목표", color: "chart-5", quarterlyTarget: [8, 12, 17, 20] },
      { id: "A", label: "A 목표", color: "chart-2", quarterlyTarget: [20, 30, 35, 42] },
    ],
  };
}
function setGoalInput(form, name, value) {
  const el = form.elements.namedItem(name);
  if (el) el.value = value;
}
function readGoalInput(form, name) {
  const el = form.elements.namedItem(name);
  return Math.max(0, parseInt(el?.value, 10) || 0);
}
function showModal(el) {
  if (!el) return;
  el.hidden = false;
  el.removeAttribute("hidden");
}
function hideModal(el) {
  if (!el) return;
  el.hidden = true;
  el.setAttribute("hidden", "");
}

function openGoalsModal() {
  if (!STATE.data) {
    alert("데이터를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
    return;
  }
  ensureGroupGoals();
  const modal = document.getElementById("goalsModal");
  const form = document.getElementById("goalsForm");
  if (!modal || !form) {
    alert("목표 입력 창을 찾을 수 없습니다. 페이지를 새로고침해 주세요.");
    return;
  }
  showModal(modal);
  const goals = STATE.data.goals;
  const a1 = goals.grades.find(g => g.id === "A1");
  const a = goals.grades.find(g => g.id === "A");
  const q = (g, i) => (g?.quarterlyTarget || [])[i] || 0;
  if (a1) {
    setGoalInput(form, "a1_t1", q(a1, 0)); setGoalInput(form, "a1_t2", q(a1, 1));
    setGoalInput(form, "a1_t3", q(a1, 2)); setGoalInput(form, "a1_t4", q(a1, 3));
  }
  if (a) {
    setGoalInput(form, "a_t1", q(a, 0)); setGoalInput(form, "a_t2", q(a, 1));
    setGoalInput(form, "a_t3", q(a, 2)); setGoalInput(form, "a_t4", q(a, 3));
  }
  setTimeout(() => form.elements.namedItem("a1_t1")?.focus(), 50);
}
function closeGoalsModal() {
  hideModal(document.getElementById("goalsModal"));
}

function bindGoalsEvents() {
  if (bindGoalsEvents._bound) return;
  bindGoalsEvents._bound = true;

  // 버튼이 나중에 그려져도 동작하도록 document 위임
  document.addEventListener("click", (e) => {
    if (e.target.closest("#editGoalsBtn")) {
      e.preventDefault();
      e.stopPropagation();
      openGoalsModal();
    }
  });

  document.getElementById("goalsClose")?.addEventListener("click", closeGoalsModal);
  document.getElementById("goalsCancel")?.addEventListener("click", closeGoalsModal);
  document.getElementById("goalsModal")?.addEventListener("click", (e) => {
    if (e.target.id === "goalsModal") closeGoalsModal();
  });
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("goalsModal");
    if (e.key === "Escape" && modal && !modal.hidden) closeGoalsModal();
  });
  document.getElementById("goalsForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    ensureGroupGoals();
    const goals = STATE.data.goals;
    const a1 = goals.grades.find(g => g.id === "A1");
    const a = goals.grades.find(g => g.id === "A");
    const targets = (prefix) => [
      readGoalInput(form, `${prefix}_t1`),
      readGoalInput(form, `${prefix}_t2`),
      readGoalInput(form, `${prefix}_t3`),
      readGoalInput(form, `${prefix}_t4`),
    ];
    if (a1) a1.quarterlyTarget = targets("a1");
    if (a) a.quarterlyTarget = targets("a");
    commitChange();
    closeGoalsModal();
  });
  document.getElementById("overview")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-goal-edit]")) {
      e.preventDefault();
      openGoalsModal();
    }
  });
  document.getElementById("overview")?.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-goal-edit]")) {
      e.preventDefault();
      openGoalsModal();
    }
  });
}

function bindMetricEvents() {
  document.getElementById("metricClose")?.addEventListener("click", closeMetricModal);
  document.getElementById("metricCancel")?.addEventListener("click", closeMetricModal);
  document.getElementById("metricModal")?.addEventListener("click", (e) => {
    if (e.target.id === "metricModal") closeMetricModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("metricModal").hidden) closeMetricModal();
  });
  document.getElementById("metricForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.companyId.value;
    const num = (v) => Math.max(0, parseInt(v, 10) || 0);
    STATE.partMetrics[id] = {
      pending: num(f.pending.value),
      disclosure: num(f.disclosure.value),
      idea: num(f.idea.value),
      target: [num(f.t1.value), num(f.t2.value), num(f.t3.value), num(f.t4.value)],
    };
    commitChange();
    closeMetricModal();
  });
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle("dark");
  document.getElementById("themeToggle").textContent = dark ? "☀️" : "🌙";
  localStorage.setItem("theme", dark ? "dark" : "light");
  renderCharts();          // 색상 토큰 갱신
  renderCompanyBars();
  buildCompanyNav();
  renderTable();
}

function exportCSV() {
  const headers = ["관리번호", "특허명", "파트", "분야", "상태", "국가", "발명자", "출원일", "등록일", "출원번호", "등록번호"];
  const lines = STATE.filtered.map(p => [
    p.id, p.title, companyName(p.company), p.field, statusLabel(p.status),
    p.country, p.inventor, p.filingDate || "", p.regDate || "", p.appNo || "", p.regNo || "",
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = "\uFEFF" + [headers.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${STATE.data.group.name}_특허목록_${STATE.data.group.updatedAt}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- 테마 초기 적용 ---------- */
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  if (saved === "dark" || (!saved && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
})();

/* ---------- 비밀번호 잠금 ---------- */
const ACCESS_PASSWORD = "1004";
let appStarted = false;

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  const dark = document.documentElement.classList.contains("dark");
  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) themeBtn.textContent = dark ? "☀️" : "🌙";
  await init();
}

function unlockApp() {
  document.body.classList.remove("locked");
  document.getElementById("lockScreen")?.classList.add("hidden");
  startApp();
}

function setupLock() {
  bindGoalsEvents(); // 목표 수정 버튼은 페이지 로드 직후부터 연결
  // 매 접속마다 비밀번호 필요 (대시보드는 잠금 해제 전까지 숨김)
  document.body.classList.add("locked");
  const form = document.getElementById("lockForm");
  const input = document.getElementById("lockInput");
  const err = document.getElementById("lockError");
  if (!form || !input) return;

  input.value = "";
  err.hidden = true;
  setTimeout(() => input.focus(), 50);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value === ACCESS_PASSWORD) {
      err.hidden = true;
      unlockApp();
    } else {
      err.hidden = false;
      input.value = "";
      input.focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", setupLock);
