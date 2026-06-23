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
  accessRole: null, // 'edit' | 'view' | 'part' (비밀번호 로그인 후)
  pendingApprovals: [], // 4001→1144 승인 대기 목록
};

const ACCESS_EDIT = "1144";
const ACCESS_VIEW = "1004";
const ACCESS_PART = "4001";
function canEdit() { return STATE.accessRole === "edit"; }
function canEditPart() { return STATE.accessRole === "edit" || STATE.accessRole === "part"; }

/* ---------- 유틸 ---------- */
function cssVar(name) {
  const key = name.startsWith("--") ? name : `--${name}`;
  return getComputedStyle(document.documentElement).getPropertyValue(key).trim();
}
function chartColor(token) {
  const key = token.startsWith("--") ? token : `--${token}`;
  const v = cssVar(key);
  if (v) return v;
  const fallbacks = {
    "--chart-1": "oklch(0.6731 0.1624 144.2083)",
    "--chart-3": "oklch(0.5234 0.1347 144.1672)",
    "--chart-5": "oklch(0.2157 0.0453 145.7256)",
    "--chart-7": "oklch(0.6200 0.1450 55.0000)",
    "--accent": "oklch(0.8952 0.0504 146.0366)",
  };
  return fallbacks[key] || "oklch(0.52 0.13 144)";
}
function companyName(id) { return STATE.companyMap[id]?.name || id; }
function companyColor(id) {
  const c = STATE.companyMap[id]?.color || "chart-1";
  return chartColor(`--${c}`);
}
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

function inventorsOf(patent) {
  const raw = (patent.inventor || "").trim();
  if (!raw) return [];
  return raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
}

function patentsByInventor(name) {
  const n = (name || "").trim();
  if (!n) return [];
  return STATE.data.patents.filter(p => inventorsOf(p).includes(n));
}

function inventorCellHtml(inventor) {
  const name = (inventor || "").trim();
  if (!name) return "—";
  return `<button type="button" class="inventor-link" data-inventor="${esc(name)}" title="${esc(name)} 출원 목록 보기">${esc(name)}</button>`;
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
function emptyNames() { return { pending: [], disclosure: [], idea: [] }; }
function emptyMetric() {
  return { pending: 0, disclosure: 0, idea: 0, target: [0, 0, 0, 0], a1Target: [0, 0, 0, 0], names: emptyNames() };
}
function normalizeStage(item) {
  if (!item || typeof item !== "object") return null;
  const text = String(item.text ?? item.stage ?? "").trim();
  const date = String(item.date || "").trim();
  if (!text && !date) return null;
  return { text, date };
}
function normalizeStages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeStage).filter(Boolean);
}
function normalizePerson(item) {
  if (typeof item === "string") {
    const name = item.trim();
    return name ? { name, title: "", reviewDate: "", stages: [], completed: false } : null;
  }
  if (item && typeof item === "object") {
    const name = String(item.name || "").trim();
    if (!name) return null;
    return {
      name,
      title: String(item.title || "").trim(),
      reviewDate: String(item.reviewDate || "").trim(),
      stages: normalizeStages(item.stages),
      completed: !!item.completed,
      patent: !!(item._patent || item.patent),
    };
  }
  return null;
}
function formatReviewDateLabel(dateStr) {
  const d = String(dateStr || "").trim();
  return d || "미정";
}
function personDisplay(p) {
  const norm = normalizePerson(p);
  if (!norm) return "—";
  const parts = [norm.name];
  if (norm.title) parts.push(norm.title);
  parts.push(`작성완료 목표 ${formatReviewDateLabel(norm.reviewDate)}`);
  return parts.join(" · ");
}
/* 포트폴리오 막대 호버 — 이름·제목만 */
function personBarPopoverHtml(p) {
  const norm = normalizePerson(p);
  if (!norm) return "";
  let inner = `<span class="bpp-name">${esc(norm.name)}</span>`;
  if (norm.title) inner += `<span class="bpp-title-text">${esc(norm.title)}</span>`;
  return `<li class="bpp-person">${inner}</li>`;
}
function normalizeNames(n) {
  const base = emptyNames();
  if (n && typeof n === "object") {
    ["pending", "disclosure", "idea"].forEach(k => {
      if (Array.isArray(n[k])) {
        base[k] = n[k].map(normalizePerson).filter(Boolean);
      }
    });
  }
  return base;
}
function metricCountsFromNames(names) {
  const n = normalizeNames(names);
  return {
    pending: n.pending.length,
    disclosure: n.disclosure.length,
    idea: n.idea.length,
  };
}
function metricPeopleCount(companyId, key) {
  return metricCountsFromNames(partMetric(companyId).names)[key] || 0;
}
function applyMetricCountsFromNames(metric) {
  const m = Object.assign(emptyMetric(), metric);
  m.names = normalizeNames(m.names);
  Object.assign(m, metricCountsFromNames(m.names));
  return m;
}
function syncPartMetricCounts(companyId) {
  STATE.partMetrics[companyId] = applyMetricCountsFromNames(partMetric(companyId));
  return STATE.partMetrics[companyId];
}
function syncAllPartMetricCounts() {
  (STATE.data?.companies || []).forEach(c => syncPartMetricCounts(c.id));
}
function loadPartMetrics() {
  let saved = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_METRICS);
    if (raw) saved = JSON.parse(raw);
  } catch {}
  const out = {};
  STATE.data.companies.forEach(c => {
    out[c.id] = applyMetricCountsFromNames(saved[c.id] || {});
    if (!Array.isArray(out[c.id].target)) out[c.id].target = [0, 0, 0, 0];
    if (!Array.isArray(out[c.id].a1Target)) out[c.id].a1Target = [0, 0, 0, 0];
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
  return STATE.data.companies.reduce((s, c) => s + metricPeopleCount(c.id, key), 0);
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
    out[r.company_id] = applyMetricCountsFromNames({
      pending: r.pending || 0, disclosure: r.disclosure || 0, idea: r.idea || 0,
      target: [r.t1 || 0, r.t2 || 0, r.t3 || 0, r.t4 || 0],
      a1Target: [r.a1_t1 || 0, r.a1_t2 || 0, r.a1_t3 || 0, r.a1_t4 || 0],
      names: r.names,
    });
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
  const rows = Object.entries(map).map(([cid, m]) => {
    const synced = applyMetricCountsFromNames(m);
    return {
      company_id: cid,
      pending: synced.pending, disclosure: synced.disclosure, idea: synced.idea,
      t1: (synced.target || [])[0] || 0, t2: (synced.target || [])[1] || 0,
      t3: (synced.target || [])[2] || 0, t4: (synced.target || [])[3] || 0,
      a1_t1: (synced.a1Target || [])[0] || 0, a1_t2: (synced.a1Target || [])[1] || 0,
      a1_t3: (synced.a1Target || [])[2] || 0, a1_t4: (synced.a1Target || [])[3] || 0,
      names: synced.names,
    };
  });
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
      STATE.data.companies.forEach(c => {
        if (metrics[c.id]) STATE.partMetrics[c.id] = Object.assign(emptyMetric(), STATE.partMetrics[c.id], metrics[c.id]);
      });
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
    if (canEdit()) {
      await cloudSavePatents(STATE.data.patents);
      await cloudSaveMetrics(STATE.partMetrics);
      await cloudSaveGroupGoals();
    } else if (canEditPart()) {
      await cloudSaveMetrics(STATE.partMetrics);
    }
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

/* ============================================================
   승인 요청 워크플로 (4001 파트 → 1144 편집 승인)
   - 4001 사용자가 담당자 수정 후 "저장 및 승인 요청" → pending 저장
   - 1144 사용자 접속 시 배지 표시, 모달에서 기존/변경 비교 후 승인·미승인
   ============================================================ */
const STORAGE_KEY_APPROVALS = "amd_pending_approvals_v1";

function localLoadPendingApprovals() {
  try { const r = localStorage.getItem(STORAGE_KEY_APPROVALS); return r ? JSON.parse(r) : []; } catch { return []; }
}
function localSavePendingApprovals(list) {
  try { localStorage.setItem(STORAGE_KEY_APPROVALS, JSON.stringify(list)); } catch {}
}

async function cloudLoadPendingApprovals() {
  try {
    const res = await fetch(`${SB_REST}/pending_approvals?select=*&order=requested_at.asc`, { headers: SB_HEADERS });
    if (!res.ok) return null;
    return (await res.json()).map(r => ({
      id: r.id, companyId: r.company_id, companyName: r.company_name,
      requestedAt: r.requested_at, beforeData: r.before_data, afterData: r.after_data,
    }));
  } catch { return null; }
}
async function cloudSavePendingApproval(item) {
  try {
    const res = await fetch(`${SB_REST}/pending_approvals`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: item.id, company_id: item.companyId, company_name: item.companyName,
        requested_at: item.requestedAt, before_data: item.beforeData, after_data: item.afterData,
      }),
    });
    return res.ok;
  } catch { return false; }
}
async function cloudDeletePendingApproval(id) {
  try {
    const res = await fetch(`${SB_REST}/pending_approvals?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE", headers: SB_HEADERS,
    });
    return res.ok;
  } catch { return false; }
}

async function loadPendingApprovals() {
  const cloud = await cloudLoadPendingApprovals();
  if (cloud) {
    STATE.pendingApprovals = cloud;
    localSavePendingApprovals(cloud);
  } else {
    STATE.pendingApprovals = localLoadPendingApprovals();
  }
  updateApprovalBadge();
}

async function requestApprovalChange(companyId, beforeData, afterData) {
  if (!STATE.pendingApprovals) STATE.pendingApprovals = [];
  const existing = STATE.pendingApprovals.find(a => a.companyId === companyId);
  if (existing) cloudDeletePendingApproval(existing.id);
  STATE.pendingApprovals = STATE.pendingApprovals.filter(a => a.companyId !== companyId);
  const item = {
    id: `apv_${companyId}_${Date.now()}`,
    companyId, companyName: companyName(companyId),
    requestedAt: new Date().toISOString(),
    beforeData, afterData,
  };
  STATE.pendingApprovals.push(item);
  localSavePendingApprovals(STATE.pendingApprovals);
  cloudSavePendingApproval(item);
  updateApprovalBadge();
  showApprovalToast(`${companyName(companyId)} 파트 수정이 승인 요청되었습니다.`);
}

function updateApprovalBadge() {
  const btn = document.getElementById("approvalBtn");
  const cnt = document.getElementById("approvalCount");
  if (!btn) return;
  const list = STATE.pendingApprovals || [];
  if (STATE.accessRole === "edit" && list.length > 0) {
    btn.hidden = false;
    if (cnt) cnt.textContent = list.length;
  } else {
    btn.hidden = true;
  }
}

function showApprovalToast(msg) {
  let el = document.getElementById("approvalToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "approvalToast";
    el.className = "approval-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("visible"), 3500);
}

function diffPersonRow(p, cls) {
  const n = normalizePerson(p);
  if (!n) return "";
  let html = `<div class="diff-person ${cls}"><span class="diff-name">${esc(n.name)}</span>`;
  if (n.title) html += ` <span class="diff-title">${esc(n.title)}</span>`;
  if (n.reviewDate) html += ` <span class="diff-review">${esc(formatReviewDateLabel(n.reviewDate))}</span>`;
  return html + `</div>`;
}

function diffCategoryHtml(bNames, aNames, key) {
  const bList = (bNames?.[key] || []).map(normalizePerson).filter(Boolean);
  const aList = (aNames?.[key] || []).map(normalizePerson).filter(Boolean);
  const bSet = new Set(bList.map(p => p.name));
  const aSet = new Set(aList.map(p => p.name));
  const changed = bList.length !== aList.length || bList.some(p => !aSet.has(p.name)) || aList.some(p => !bSet.has(p.name));
  const bHtml = bList.map(p => diffPersonRow(p, aSet.has(p.name) ? "" : "diff-removed")).join("") || '<div class="diff-empty">없음</div>';
  const aHtml = aList.map(p => diffPersonRow(p, bSet.has(p.name) ? "" : "diff-added")).join("") || '<div class="diff-empty">없음</div>';
  return `<div class="diff-category${changed ? "" : " diff-unchanged"}">
    <div class="diff-cat-label">${catLabel(key)}
      ${changed
        ? `<span class="diff-badge diff-badge-changed">${bList.length} → ${aList.length}명</span>`
        : `<span class="diff-badge diff-badge-same">${bList.length}명 (변경 없음)</span>`}
    </div>
    <div class="diff-cols">
      <div class="diff-col diff-col-before"><div class="diff-col-head">기존</div>${bHtml}</div>
      <div class="diff-col diff-col-after"><div class="diff-col-head">변경</div>${aHtml}</div>
    </div>
  </div>`;
}

function openApprovalModal() {
  if (!canEdit()) return;
  renderApprovalModal();
  showModal(document.getElementById("approvalModal"));
}

function renderApprovalModal() {
  const body = document.getElementById("approvalModalBody");
  if (!body) return;
  const list = STATE.pendingApprovals || [];
  if (!list.length) {
    body.innerHTML = '<div class="empty" style="padding:2rem">대기 중인 승인 요청이 없습니다.</div>';
    return;
  }
  body.innerHTML = list.map(item => `
    <div class="approval-item" data-id="${esc(item.id)}">
      <div class="approval-item-head">
        <span class="approval-part-name">${esc(item.companyName)} 파트 수정 요청</span>
        <span class="approval-time">${esc(fmtDateTime(item.requestedAt))}</span>
      </div>
      ${METRIC_PEOPLE_KEYS.map(k => diffCategoryHtml(item.beforeData?.names, item.afterData?.names, k)).join("")}
      <div class="approval-actions">
        <button class="btn approval-reject" data-id="${esc(item.id)}">미승인</button>
        <button class="btn primary approval-approve" data-id="${esc(item.id)}">승인</button>
      </div>
    </div>`).join('<div class="approval-sep"></div>');
}

async function approveChange(id) {
  const item = (STATE.pendingApprovals || []).find(a => a.id === id);
  if (!item) return;
  const m = partMetric(item.companyId);
  STATE.partMetrics[item.companyId] = applyMetricCountsFromNames(
    Object.assign(emptyMetric(), m, { names: normalizeNames(item.afterData?.names) })
  );
  STATE.pendingApprovals = (STATE.pendingApprovals || []).filter(a => a.id !== id);
  localSavePendingApprovals(STATE.pendingApprovals);
  await cloudDeletePendingApproval(id);
  commitChange();
  updateApprovalBadge();
  renderApprovalModal();
  if (!(STATE.pendingApprovals || []).length) hideModal(document.getElementById("approvalModal"));
  showApprovalToast(`${item.companyName} 파트 수정이 승인되었습니다.`);
}

async function rejectChange(id) {
  const item = (STATE.pendingApprovals || []).find(a => a.id === id);
  STATE.pendingApprovals = (STATE.pendingApprovals || []).filter(a => a.id !== id);
  localSavePendingApprovals(STATE.pendingApprovals);
  await cloudDeletePendingApproval(id);
  updateApprovalBadge();
  renderApprovalModal();
  if (!(STATE.pendingApprovals || []).length) hideModal(document.getElementById("approvalModal"));
  showApprovalToast(`${item?.companyName || ""} 파트 수정 요청이 미승인 처리되었습니다.`);
}

function bindApprovalEvents() {
  document.getElementById("approvalBtn")?.addEventListener("click", openApprovalModal);
  document.getElementById("approvalClose")?.addEventListener("click", () => hideModal(document.getElementById("approvalModal")));
  document.getElementById("approvalModal")?.addEventListener("click", (e) => {
    if (e.target.id === "approvalModal") hideModal(document.getElementById("approvalModal"));
  });
  document.addEventListener("keydown", (e) => {
    const m = document.getElementById("approvalModal");
    if (e.key === "Escape" && m && !m.hidden) hideModal(m);
  });
  document.getElementById("approvalModalBody")?.addEventListener("click", (e) => {
    const apBtn = e.target.closest(".approval-approve");
    if (apBtn) { approveChange(apBtn.dataset.id); return; }
    const rjBtn = e.target.closest(".approval-reject");
    if (rjBtn) { rejectChange(rjBtn.dataset.id); }
  });
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
  const full = canEdit();
  const partOnly = canEditPart() && !full;
  if (!full && !partOnly) return;
  if (full) {
    savePatents();
    savePartMetrics();
    saveGroupGoals();
  } else {
    savePartMetrics();
  }
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
  if (!canEdit()) return;
  STATE.data.patents = JSON.parse(JSON.stringify(snap.patents));
  STATE.partMetrics = JSON.parse(JSON.stringify(snap.partMetrics));
  syncAllPartMetricCounts();
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
  syncAllPartMetricCounts();
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
  bindPeopleEvents();
  bindGoalsEvents();
  bindInventorEvents();
  bindKpiPeopleEvents();
  refreshAll();
  updateDataMeta();
  updateHistButtons();
  applyAccessUI();
  if (canEdit()) await loadPendingApprovals();
  bindApprovalEvents();
  if (typeof initFloatingCards === "function") initFloatingCards();
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
function partA1Progress(companyId) {
  const g = partQuarterlyCumByGrade(companyId);
  const m = partMetric(companyId);
  const a1Target = m.a1Target || [0, 0, 0, 0];
  const done = g.a1[3];
  const annual = a1Target[a1Target.length - 1] || 0;
  const pct = annual ? Math.round((done / annual) * 100) : null;
  return { done, annual, pct };
}
// A 등급(전체 = A1+A) 진행 — 그룹 KPI와 동일한 집계 규칙
function partAProgress(companyId) {
  const g = partQuarterlyCumByGrade(companyId);
  const m = partMetric(companyId);
  const target = m.target || [0, 0, 0, 0];
  const done = g.a1[3] + g.a[3];
  const annual = target[target.length - 1] || 0;
  const pct = annual ? Math.round((done / annual) * 100) : null;
  return { done, annual, pct };
}
function progressLabel(prefix, p) {
  if (p.annual) return `${prefix} ${p.done}/${p.annual} (${p.pct}%)`;
  return `${prefix} ${p.done}`;
}

function buildCompanyNav() {
  const wrap = document.getElementById("companyNav");
  const editable = canEditPart();
  wrap.innerHTML = STATE.data.companies.map(c => {
    const a1 = partA1Progress(c.id);
    const a = partAProgress(c.id);
    const icoColor = chartColor(`--${c.color}`);
    return `
    <a href="#" data-company="${c.id}" title="${STATE.accessRole ? "클릭하여 파트 상세 보기" : "로그인 필요"}">
      <span class="ico" style="color:${icoColor}">●</span>
      ${c.name}
      ${editable ? '<span class="part-edit">✎</span>' : ""}
      <span class="nav-badge" title="A1·A 달성/목표">
        <span>${progressLabel("A1", a1)}</span>
        <span>${progressLabel("A", a)}</span>
      </span>
    </a>`;
  }).join("");
  if (!STATE.accessRole) return;
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
    return kpiHTML(c.icon, c.label, `${done} <span class="kpi-unit">/ ${target}</span>`, extra, canEdit(), "kpi-major", c.grade);
    }
    if (c.type === "metric") {
      const n = sumMetric(c.metric);
      return kpiHTML(c.icon, c.label, n, c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "", false, "kpi-minor");
    }
    if (c.type === "status") {
      const n = STATE.data.patents.filter(p => p.status === c.status).length;
      return kpiHTML(c.icon, c.label, n, c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "", false, "kpi-minor");
    }
    // manual
    const extra = c.sub ? `<div class="kpi-delta up">${c.sub}</div>` : "";
    return kpiHTML(c.icon, c.label, c.value ?? 0, extra, false, "kpi-minor");
  }).join("");
}

function kpiHTML(icon, label, value, extra, editable, variant, kpiKey) {
  const cls = ["kpi", variant || "", editable ? "kpi-editable" : ""].filter(Boolean).join(" ");
  const attrs = editable ? ' role="button" tabindex="0" data-goal-edit title="클릭하여 그룹 목표 수정"' : "";
  const hoverAttr = kpiKey ? ` data-kpi="${kpiKey}"` : "";
  return `
    <div class="${cls}"${attrs}${hoverAttr}>
      <div class="kpi-icon">${icon || "📌"}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${extra || ""}
    </div>`;
}

/* KPI 호버 — A1/A 등급 발명자 (동명이면 N건) */
function collectKpiPeopleRaw(kpiKey) {
  if (kpiKey !== "A1" && kpiKey !== "A") return [];
  const year = STATE.data.goals?.year;
  const items = [];
  STATE.data.patents.forEach(p => {
    if (!matchGrade(p, kpiKey)) return;
    if (p.filingDate && year && fiscalYearOf(p.filingDate) !== year) return;
    inventorsOf(p).forEach(name => items.push({ name }));
  });
  return items;
}
function formatKpiPeopleLabels(items) {
  const counts = new Map();
  items.forEach(item => {
    const n = normalizePerson(item);
    if (!n?.name) return;
    counts.set(n.name, (counts.get(n.name) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ko"))
    .map(([name, count]) => count > 1 ? `${name} (${count}건)` : name);
}
function kpiPeopleList(kpiKey) {
  return formatKpiPeopleLabels(collectKpiPeopleRaw(kpiKey));
}
function getKpiPeoplePopover() {
  let el = document.getElementById("kpiPeoplePopover");
  if (!el) {
    el = document.createElement("div");
    el.id = "kpiPeoplePopover";
    el.className = "bar-people-popover kpi-people-popover";
    el.hidden = true;
    el.style.cssText = [
      "position:fixed", "z-index:2000", "min-width:200px", "max-width:300px",
      "padding:0.45rem 0.55rem", "font-size:0.72rem", "pointer-events:none",
      "border-radius:10px", "border:1px solid var(--border,#ddd)",
      "background:var(--popover,#fff)", "color:var(--popover-foreground,#111)",
      "box-shadow:0 8px 24px -8px rgba(0,0,0,0.35)",
    ].join(";");
    document.body.appendChild(el);
  }
  return el;
}
function showKpiPeoplePopover(card) {
  const key = card.dataset.kpi;
  if (!key) return;
  const names = kpiPeopleList(key);
  const label = card.querySelector(".kpi-label")?.textContent || key;
  const pop = getKpiPeoplePopover();
  const listHtml = names.length
    ? `<ul class="bpp-list bpp-list-cols3">${names.map(n => `<li class="bpp-person"><span class="bpp-name">${esc(n)}</span></li>`).join("")}</ul>`
    : `<div class="bpp-empty">등록된 발명자 없음</div>`;
  pop.innerHTML = `
    <div class="bpp-head">${esc(label)} <span>${names.length}명</span></div>
    ${listHtml}`;
  pop.hidden = false;
  const r = card.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
  if (top < 8) top = Math.max(8, window.innerHeight - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
function hideKpiPeoplePopover() {
  const el = document.getElementById("kpiPeoplePopover");
  if (el) el.hidden = true;
}
function bindKpiPeopleEvents() {
  const grid = document.getElementById("overview");
  if (!grid || grid.dataset.kpiPeopleBound) return;
  grid.dataset.kpiPeopleBound = "1";
  grid.addEventListener("mouseover", (e) => {
    const card = e.target.closest('.kpi[data-kpi="A1"], .kpi[data-kpi="A"]');
    if (card && grid.contains(card)) showKpiPeoplePopover(card);
  });
  grid.addEventListener("mouseout", (e) => {
    const card = e.target.closest('.kpi[data-kpi="A1"], .kpi[data-kpi="A"]');
    const to = e.relatedTarget;
    if (card && (!to || !card.contains(to))) hideKpiPeoplePopover();
  });
}

/* ---------- 목표 달성 계산 (리스트 데이터 기반, 자동 연동) ---------- */
/* 회계 분기: ISO(달력) 기준에서 1개월 당김
   1분기 = 12월~2월 / 2분기 = 3월~5월 / 3분기 = 6월~8월 / 4분기 = 9월~11월
   12월은 다음 회계연도 1분기에 속한다. */
function fiscalQuarterInfo(dateStr) {
  const d = new Date(dateStr);
  const m = d.getMonth(); // 0(1월) ~ 11(12월)
  const y = d.getFullYear();
  if (m === 11) return { fy: y + 1, q: 1 }; // 12월 → 다음 해 1분기
  if (m <= 1) return { fy: y, q: 1 };       // 1~2월
  if (m <= 4) return { fy: y, q: 2 };       // 3~5월
  if (m <= 7) return { fy: y, q: 3 };       // 6~8월
  return { fy: y, q: 4 };                    // 9~11월
}
function quarterOf(dateStr) { return fiscalQuarterInfo(dateStr).q; }
function fiscalYearOf(dateStr) { return fiscalQuarterInfo(dateStr).fy; }

function currentQuarterForYear(year) {
  const { fy, q } = fiscalQuarterInfo(new Date());
  if (fy > year) return 4;
  if (fy < year) return 0;
  return q;
}

// A 등급은 전체 특허, A1 등급은 grade가 "A1"인 특허를 집계
function matchGrade(p, gradeId) { return gradeId === "A" ? true : p.grade === gradeId; }

function gradeAchievement(gradeId) {
  const year = STATE.data.goals?.year;
  const perQ = [0, 0, 0, 0];
  STATE.data.patents.forEach(p => {
    if (!p.filingDate) return;
    const { fy, q } = fiscalQuarterInfo(p.filingDate);
    if (fy !== year) return;
    if (!matchGrade(p, gradeId)) return;
    perQ[q - 1]++;
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
      ctx.fillStyle = Array.isArray(ds.borderColor)
        ? (ds.borderColor[qIdx] || ds._baseColor || "#333")
        : ds.borderColor;
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
  // 목표 달성 시 파트색 유지, 미달 시 빨간색
  const RED = chartColor("--destructive") || "oklch(0.58 0.22 27)";
  goals.grades.forEach(g => {
    const ach = gradeAchievement(g.id);
    const base = cssVar("--" + g.color);
    const data = ach.cum.map((v, i) => (i < maxQ ? v : null));
    const reached = (i) => ach.cum[i] >= (g.quarterlyTarget[i] || 0);
    datasets.push({
      type: "bar",
      label: g.id + " 달성",
      data,
      backgroundColor: data.map((v, i) => v == null ? "transparent" : withAlpha(reached(i) ? base : RED, 0.55)),
      borderColor: data.map((v, i) => v == null ? "transparent" : (reached(i) ? base : RED)),
      borderWidth: 1.5, borderRadius: 4, borderSkipped: false, order: 1,
      _target: g.quarterlyTarget,
      _baseColor: base,
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
    if (!meta?.data?.length) return;
    const ctx = chart.ctx;
    const total = ds.data.reduce((s, v) => s + (Number(v) || 0), 0);
    meta.data.forEach((arc, i) => {
      const val = Number(ds.data[i]) || 0;
      if (val <= 0 || !arc) return;
      const pos = arc.tooltipPosition();
      const pct = total ? Math.round((val / total) * 100) : 0;
      const text = val >= 3 || pct >= 8 ? String(val) : `${val}`;
      ctx.save();
      ctx.font = `bold 12px ${cssVar("--font-sans") || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.strokeText(text, pos.x, pos.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, pos.x, pos.y);
      ctx.restore();
    });
  },
};
if (typeof Chart !== "undefined") Chart.register(doughnutValueLabel);

// 그룹 상태별 분포 — 등록을 A1/A 등급으로 분리 + 심사중·직발서·아이디어
const STATUS_CHART_COLORS = [
  "oklch(0.2157 0.0453 145.7256)", // A1 등록 (진한 초록)
  "oklch(0.6731 0.1624 144.2083)", // A 등록 (초록)
  "oklch(0.5234 0.1347 144.1672)", // 심사중
  "oklch(0.4254 0.1159 144.3078)", // 직발서
  "oklch(0.8952 0.0504 146.0366)", // 아이디어
];
function gradePatentCount(gradeId) {
  return (STATE.data?.patents || []).filter(p => p.grade === gradeId).length;
}
const STATUS_CATS = [
  { key: "a1", label: "A1 등록", value: () => gradePatentCount("A1") },
  { key: "a", label: "A 등록", value: () => gradePatentCount("A") },
  { key: "pending", label: "심사중", value: () => sumMetric("pending") },
  { key: "disclosure", label: "직발서", value: () => sumMetric("disclosure") },
  { key: "idea", label: "아이디어", value: () => sumMetric("idea") },
];

function statusPartBreakdown(catKey) {
  if (!STATE.data?.companies) return [];
  return STATE.data.companies.map(c => {
    let v = 0;
    if (catKey === "a1") v = STATE.data.patents.filter(p => p.company === c.id && p.grade === "A1").length;
    else if (catKey === "a") v = STATE.data.patents.filter(p => p.company === c.id && p.grade === "A").length;
    else v = metricPeopleCount(c.id, catKey);
    return { name: c.name, value: v };
  }).filter(x => x.value > 0);
}

function renderStatusChart() {
  const ctx = document.getElementById("statusChart");
  if (!ctx) return;
  if (STATE.charts.status) STATE.charts.status.destroy();

  const dist = STATUS_CATS.map((c, i) => ({
    label: c.label,
    value: Math.max(0, Number(c.value()) || 0),
    color: STATUS_CHART_COLORS[i] || STATUS_CHART_COLORS[0],
  }));
  const total = dist.reduce((s, d) => s + d.value, 0);
  const subEl = document.getElementById("statusSub");
  if (subEl) {
    subEl.textContent = total
      ? dist.map(d => `${d.label} ${d.value}`).join(" · ")
      : "A1·A 등록·심사중·직발서·아이디어";
  }

  const cardBg = cssVar("--card") || "#ffffff";
  STATE.charts.status = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: dist.map(d => d.label),
      datasets: [{
        data: dist.map(d => d.value),
        backgroundColor: dist.map(d => d.color),
        borderColor: cardBg,
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "58%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            padding: 14,
            usePointStyle: true,
            pointStyle: "circle",
            generateLabels(chart) {
              const ds = chart.data.datasets[0];
              return chart.data.labels.map((label, i) => ({
                text: `${label} ${ds.data[i]}건`,
                fillStyle: ds.backgroundColor[i],
                strokeStyle: ds.borderColor,
                lineWidth: 0,
                hidden: false,
                index: i,
              }));
            },
          },
        },
        tooltip: {
          backgroundColor: cssVar("--popover"), titleColor: cssVar("--popover-foreground"),
          bodyColor: cssVar("--popover-foreground"), borderColor: cssVar("--border"), borderWidth: 1,
          padding: 12, cornerRadius: 8,
          callbacks: {
            label: (i) => {
              const v = i.parsed || 0;
              const sum = i.dataset.data.reduce((a, b) => a + b, 0);
              const pct = sum ? Math.round((v / sum) * 100) : 0;
              return ` ${i.label}: ${v}건 (${pct}%)`;
            },
            afterBody: (items) => {
              if (!items.length) return [];
              const cat = STATUS_CATS[items[0].dataIndex];
              if (!cat) return [];
              const parts = statusPartBreakdown(cat.key);
              if (!parts.length) return ["", "  파트별: 없음"];
              return ["", "  파트별", ...parts.map(p => `  ${p.name} ${p.value}건`)];
            },
          },
        },
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
    if (!p.filingDate) return;
    const { fy, q } = fiscalQuarterInfo(p.filingDate);
    if (fy !== year) return;
    perQ[q - 1]++;
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
    if (!p.filingDate) return;
    const { fy, q } = fiscalQuarterInfo(p.filingDate);
    if (fy !== year) return;
    if (p.grade === "A1") a1[q - 1]++; else a[q - 1]++;
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
function destroyPartProgressChart(chartKey) {
  if (STATE.charts[chartKey]) {
    STATE.charts[chartKey].destroy();
    delete STATE.charts[chartKey];
  }
}

function renderPartProgressChart(companyId, canvasId, chartKey, metaId) {
  const goals = STATE.data.goals;
  const canvas = document.getElementById(canvasId);
  if (!goals || !canvas) return;

  destroyPartProgressChart(chartKey);

  const labels = ["1Q", "2Q", "3Q", "4Q"];
  const maxQ = currentQuarterForYear(goals.year);
  const a1Color = cssVar("--chart-5");
  const aColor = chartColor("--chart-1");
  const g = partQuarterlyCumByGrade(companyId);
  const m = partMetric(companyId);
  const target = m.target;
  const a1Target = m.a1Target || [0, 0, 0, 0];
  const hasTarget = target.some(v => v > 0);
  const hasA1Target = a1Target.some(v => v > 0);
  const cap = (arr) => arr.map((v, i) => (i < maxQ ? v : null));

  const annual = target[target.length - 1] || 0;
  const done = g.a1[3] + g.a[3];
  const a1Done = g.a1[3];
  const a1Annual = a1Target[a1Target.length - 1] || 0;
  const meta = metaId ? document.getElementById(metaId) : document.getElementById("meta_" + companyId);
  if (meta) {
    const a1Txt = a1Annual ? `A1 ${a1Done}/${a1Annual}` : `A1 ${a1Done}`;
    const allTxt = annual ? `전체 ${done}/${annual}` : `전체 ${done}`;
    meta.textContent = `${a1Txt} · ${allTxt}`;
  }

  const RED = chartColor("--destructive") || "oklch(0.5386 0.1937 26.7249)";
  const belowA1 = (i) => i < maxQ && hasA1Target && (g.a1[i] < (a1Target[i] || 0));
  const belowAll = (i) => i < maxQ && hasTarget && ((g.a1[i] + g.a[i]) < (target[i] || 0));
  const a1Border = labels.map((_, i) => belowA1(i) ? RED : a1Color);
  const a1BorderW = labels.map((_, i) => belowA1(i) ? 2 : 1);
  const aBorder = labels.map((_, i) => belowAll(i) ? RED : aColor);
  const aBorderW = labels.map((_, i) => belowAll(i) ? 2 : 1);

  const datasets = [
    {
      type: "bar", label: "A1", data: cap(g.a1),
      backgroundColor: a1Color, borderColor: a1Border, borderWidth: a1BorderW,
      stack: "ach", borderRadius: 2, borderSkipped: false,
    },
    {
      type: "bar", label: "A", data: cap(g.a),
      backgroundColor: withAlpha(aColor, 0.55), borderColor: aBorder, borderWidth: aBorderW,
      stack: "ach", borderRadius: 2, borderSkipped: false,
    },
  ];
  if (hasA1Target) {
    datasets.push({
      type: "line", label: "A1 목표", data: a1Target, stack: "t_a1",
      borderColor: a1Color, backgroundColor: "transparent",
      borderWidth: 1.5, borderDash: [3, 3], tension: 0,
      pointStyle: "triangle", pointRadius: 3, fill: false,
    });
  }
  if (hasTarget) {
    datasets.push({
      type: "line", label: "전체 목표", data: target, stack: "t_all",
      borderColor: cssVar("--muted-foreground"), backgroundColor: "transparent",
      borderWidth: 1.5, borderDash: [4, 3], tension: 0,
      pointStyle: "rectRot", pointRadius: 2.5, fill: false,
    });
  }

  STATE.charts[chartKey] = new Chart(canvas, {
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
}

function renderMetricProgressChart(companyId) {
  const wrap = document.getElementById("metricProgressChart");
  const c = STATE.data.companies.find(x => x.id === companyId);
  if (!wrap || !c) return;
  wrap.innerHTML = `
    <div class="mini-card">
      <div class="mini-title">
        <span class="swatch" style="background:${chartColor("--" + c.color)}"></span>${esc(c.name)}
        <span class="mini-meta" id="metricProgressMeta"></span>
      </div>
      <div class="mini-chart"><canvas id="metricProgressCanvas"></canvas></div>
    </div>`;
  renderPartProgressChart(companyId, "metricProgressCanvas", "metric_prog", "metricProgressMeta");
}

function renderProgressChart() {
  const goals = STATE.data.goals;
  const grid = document.getElementById("progressGrid");
  if (!goals || !grid) return;

  const subEl = document.getElementById("progressSub");
  if (subEl) subEl.textContent = `${goals.year}년 · 파트별 분기 누적 (■ A1 진한초록 / ■ A 초록 / ┄ 전체목표 / ┄ A1목표)`;

  grid.innerHTML = STATE.data.companies.map(c => `
    <div class="mini-card">
      <div class="mini-title">
        <span class="swatch" style="background:${chartColor("--" + c.color)}"></span>${c.name}
        <span class="mini-meta" id="meta_${c.id}"></span>
      </div>
      <div class="mini-chart"><canvas id="prog_${c.id}"></canvas></div>
    </div>`).join("");

  STATE.data.companies.forEach(c => {
    renderPartProgressChart(c.id, "prog_" + c.id, "prog_" + c.id, "meta_" + c.id);
  });

  const metricModal = document.getElementById("metricModal");
  const companyId = document.getElementById("metricForm")?.companyId?.value;
  if (metricModal && !metricModal.hidden && companyId) renderMetricProgressChart(companyId);
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
// 이름·제목 수동 입력 가능 (특허 제외 — 출원 목록 연동)
const METRIC_PEOPLE_KEYS = ["pending", "disclosure", "idea"];
const METRIC_STAGE_NEXT = { idea: "disclosure", disclosure: "pending" };

function nextMetricStageKey(key) {
  return METRIC_STAGE_NEXT[key] || null;
}

function refreshMetricModalIfOpen(companyId) {
  const metricModal = document.getElementById("metricModal");
  if (metricModal && !metricModal.hidden) {
    fillMetricCountSummary(companyId);
    fillMetricA1Summary(companyId);
    renderMetricProgressChart(companyId);
    renderMetricPeopleSections(companyId);
  }
}

function partCatValues(companyId) {
  const counts = metricCountsFromNames(partMetric(companyId).names);
  return {
    patent: STATE.data.patents.filter(p => p.company === companyId).length, // A1 + A
    pending: counts.pending,
    disclosure: counts.disclosure,
    idea: counts.idea,
  };
}

function catLabel(key) { return (PORTFOLIO_CATS.find(c => c.key === key) || {}).label || key; }

// 카테고리별 담당자: 특허=출원목록 발명자·특허명(읽기전용), 나머지=수동 입력(이름·제목)
function partCatNames(companyId, key) {
  if (key === "patent") {
    const out = [];
    STATE.data.patents.filter(p => p.company === companyId).forEach(p => {
      inventorsOf(p).forEach(name => {
        out.push({ name, title: p.title || "", _patent: true });
      });
    });
    return out;
  }
  if (!METRIC_PEOPLE_KEYS.includes(key)) return [];
  return (partMetric(companyId).names?.[key] || []).map(normalizePerson).filter(Boolean);
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

  // 파트별 진행 현황과 동일 — companies 배열 순서 유지
  const editable = canEditPart();
  const bars = rows.map(({ c, vals, total }) => {
    // 각 구간 너비 = 건수 / 전체 최댓값 → 합계가 클수록 막대가 길어짐
    const segs = PORTFOLIO_CATS.map(cat => {
      const v = vals[cat.key];
      const isMetric = METRIC_PEOPLE_KEYS.includes(cat.key);
      if (!v && !isMetric) return "";
      const share = total ? Math.round((v / total) * 100) : 0;
      const canEditCat = isMetric && editable;
      const cls = `seg seg-people${canEditCat ? " seg-editable" : ""}${!v && isMetric ? " seg-zero" : ""}`;
      let style = `background:${cssVar(cat.color)}`;
      if (v) style += `;width:${(v / maxTotal) * 100}%`;
      else if (isMetric) style += ";flex:0 0 30px;width:30px;min-width:30px";
      return `<div class="${cls}" style="${style}" data-company="${c.id}" data-cat="${cat.key}" aria-label="${cat.label} ${v}건 (${share}%)"><span class="seg-num">${v}</span></div>`;
    }).join("");
    const breakdown = PORTFOLIO_CATS.filter(cat => vals[cat.key] || METRIC_PEOPLE_KEYS.includes(cat.key))
      .map(cat => `${cat.label} ${vals[cat.key]}`).join(" · ") || "데이터 없음";
    return `<div class="bar-row">
      <div class="bar-top">
        <span class="name"><span class="company-tag"><span class="swatch" style="background:${chartColor("--" + c.color)}"></span>${c.name}</span></span>
        <span class="val">${total}건</span>
      </div>
      <div class="bar-track stacked">${segs}</div>
      <div class="bar-breakdown">${breakdown}</div>
    </div>`;
  }).join("");

  wrap.innerHTML = legend + bars;
  bindBarPeopleEvents();
}

/* ---------- 포트폴리오 막대: 담당자 호버 표시 + 클릭 편집 ---------- */
let barPeopleHideTimer = null;
function cancelBarPeopleHide() {
  if (barPeopleHideTimer) {
    clearTimeout(barPeopleHideTimer);
    barPeopleHideTimer = null;
  }
}
function scheduleBarPeopleHide(ms = 160) {
  cancelBarPeopleHide();
  barPeopleHideTimer = setTimeout(hideBarPeoplePopover, ms);
}
function isBarPeoplePopoverNode(node) {
  const pop = document.getElementById("barPeoplePopover");
  return !!(pop && node && (pop === node || pop.contains(node)));
}
function getBarPeoplePopover() {
  let el = document.getElementById("barPeoplePopover");
  if (!el) {
    el = document.createElement("div");
    el.id = "barPeoplePopover";
    el.className = "bar-people-popover";
    el.hidden = true;
    // 핵심 스타일은 인라인으로도 지정 (styles.css 캐시 대비)
    el.style.cssText = [
      "position:fixed", "z-index:2000", "min-width:220px", "max-width:320px",
      "padding:0.45rem 0.55rem", "font-size:0.72rem", "pointer-events:none",
      "border-radius:10px", "border:1px solid var(--border,#ddd)",
      "background:var(--popover,#fff)", "color:var(--popover-foreground,#111)",
      "box-shadow:0 8px 24px -8px rgba(0,0,0,0.35)",
    ].join(";");
    el.addEventListener("mouseover", (e) => {
      if (e.target.closest(".bpp-list, .bpp-empty")) cancelBarPeopleHide();
    });
    el.addEventListener("mouseout", (e) => {
      const zone = e.target.closest(".bpp-list, .bpp-empty");
      if (!zone) return;
      const to = e.relatedTarget;
      if (!to || !zone.contains(to)) scheduleBarPeopleHide();
    });
    document.body.appendChild(el);
  }
  return el;
}

function positionBarPeoplePopover(pop, seg) {
  const r = seg.getBoundingClientRect();
  const row = seg.closest(".bar-row");
  const rowR = row?.getBoundingClientRect() || r;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const gap = 8;
  const edge = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(edge, Math.min(left, vw - pw - edge));
  let top = rowR.bottom + gap;

  if (top + ph > vh - edge) top = Math.max(edge, vh - ph - edge);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function showBarPeoplePopover(seg) {
  const companyId = seg.dataset.company;
  const key = seg.dataset.cat;
  const names = partCatNames(companyId, key);
  const pop = getBarPeoplePopover();
  cancelBarPeopleHide();
  const listHtml = names.length
    ? `<ul class="bpp-list">${names.map(p => personBarPopoverHtml(p)).join("")}</ul>`
    : `<div class="bpp-empty">담당자 미입력</div>`;
  pop.innerHTML = `
    <div class="bpp-head">${companyName(companyId)} · ${catLabel(key)} <span>${names.length}명</span></div>
    ${listHtml}`;
  pop.hidden = false;
  positionBarPeoplePopover(pop, seg);
}

function hideBarPeoplePopover() {
  cancelBarPeopleHide();
  const el = document.getElementById("barPeoplePopover");
  if (el) el.hidden = true;
}

// 이벤트 위임: #companyBars 재렌더와 무관하게 한 번만 바인딩
function bindBarPeopleEvents() {
  const wrap = document.getElementById("companyBars");
  if (!wrap || wrap.dataset.peopleBound) return;
  wrap.dataset.peopleBound = "1";
  wrap.addEventListener("mouseover", (e) => {
    const seg = e.target.closest(".seg-people");
    if (seg && wrap.contains(seg)) {
      cancelBarPeopleHide();
      showBarPeoplePopover(seg);
    }
  });
  wrap.addEventListener("mouseout", (e) => {
    const seg = e.target.closest(".seg-people");
    if (!seg) return;
    const to = e.relatedTarget;
    if (to && (seg.contains(to) || isBarPeoplePopoverNode(to))) return;
    scheduleBarPeopleHide();
  });
  wrap.addEventListener("mousedown", (e) => {
    const seg = e.target.closest(".seg-people");
    if (seg && wrap.contains(seg)) hideBarPeoplePopover();
  });
  wrap.addEventListener("click", (e) => {
    const seg = e.target.closest(".seg-editable");
    if (!seg || !wrap.contains(seg)) return;
    hideBarPeoplePopover();
    openPeopleModal(seg.dataset.company, seg.dataset.cat);
  });
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

  const editable = canEdit();
  if (!rows.length) {
    const hint = editable
      ? "등록된 특허가 없습니다. 우측 상단의 “＋ 특허 추가”로 입력하면 분기 그래프가 자동 갱신됩니다."
      : "등록된 특허가 없습니다.";
    body.innerHTML = `<tr><td colspan="7" class="empty">${hint}</td></tr>`;
  } else {
    body.innerHTML = visible.map(p => `
      <tr class="${editable ? "row-edit" : ""}" data-id="${esc(p.id)}"${editable ? ' title="클릭하여 수정"' : ""}>
        <td class="mono">${p.id}</td>
        <td class="cell-title">${esc(p.title)}</td>
        <td class="cell-inventor">${inventorCellHtml(p.inventor)}</td>
        <td><span class="company-tag"><span class="swatch" style="background:${companyColor(p.company)}"></span>${companyName(p.company)}</span></td>
        <td><span class="badge ${p.grade === "A1" ? "primary" : "outline"}">${p.grade || "—"}</span></td>
        <td class="mono">${fmtDate(p.filingDate)}</td>
        <td class="col-actions">${editable ? `<button class="btn icon row-del" data-id="${esc(p.id)}" title="삭제">🗑</button>` : ""}</td>
      </tr>`).join("");
    if (editable) {
      body.querySelectorAll("tr.row-edit").forEach(tr =>
        tr.addEventListener("click", () => {
          const p = STATE.data.patents.find(x => x.id === tr.dataset.id);
          if (p) openModal(p);
        }));
      body.querySelectorAll(".row-del").forEach(btn =>
        btn.addEventListener("click", (e) => { e.stopPropagation(); deletePatent(btn.dataset.id); }));
    }
    body.querySelectorAll(".inventor-link").forEach(btn =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openInventorModal(btn.dataset.inventor);
      }));
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

  // 사이드바 active 표시 + 앵커 스크롤
  document.querySelectorAll(".nav a[href^='#']").forEach(a => {
    a.addEventListener("click", (e) => {
      document.querySelectorAll(".nav a").forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      const href = a.getAttribute("href");
      if (href === "#overview") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (href === "#partProgress") {
        e.preventDefault();
        scrollSectionToTop(document.getElementById("partProgress"));
      } else if (href === "#list") {
        e.preventDefault();
        scrollSectionToTop(document.getElementById("list"));
      }
    });
  });
}

function scrollSectionToTop(el) {
  if (!el) return;
  const topbar = document.querySelector(".topbar");
  const gap = 8;
  const offset = topbar ? topbar.getBoundingClientRect().height + gap : gap;
  const y = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
}

/* ---------- 특허 추가/수정/삭제 (직접 입력 → 그래프 자동 연동) ---------- */
let editingId = null;

function openModal(patent) {
  if (!canEdit()) return;
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
  if (!canEdit()) return;
  const p = STATE.data.patents.find(x => x.id === id);
  if (!confirm(`'${p ? p.title : id}' 특허를 삭제할까요?`)) return;
  STATE.data.patents = STATE.data.patents.filter(x => x.id !== id);
  commitChange();
}

/* ---------- 파트별 지표 입력 (심사중/직발서/아이디어 + 분기 목표) ---------- */
function patentsByCompany(companyId) {
  return (STATE.data?.patents || []).filter(p => p.company === companyId);
}

function renderMetricPatentList(companyId) {
  const list = patentsByCompany(companyId)
    .sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")));
  const countEl = document.getElementById("metricPatentCount");
  const ul = document.getElementById("metricPatentList");
  if (countEl) {
    countEl.textContent = list.length
      ? `총 ${list.length}건 (A1 ${list.filter(p => p.grade === "A1").length} · A ${list.filter(p => p.grade === "A").length})`
      : "등록된 출원이 없습니다.";
  }
  if (!ul) return;
  if (!list.length) {
    ul.innerHTML = '<li class="inventor-patent-empty">이 파트의 특허가 없습니다.</li>';
    return;
  }
  const editable = canEdit();
  ul.innerHTML = list.map(p => `
    <li class="inventor-patent-item${editable ? " is-clickable" : ""}" data-id="${esc(p.id)}"${editable ? ' title="클릭하여 수정"' : ""}>
      <div class="ip-title">${esc(p.title)}</div>
      <div class="ip-meta">
        <span>${esc(p.id)}</span>
        <span>발명자 ${esc((p.inventor || "").trim() || "—")}</span>
        <span>등급 ${esc(p.grade || "—")}</span>
        <span>${statusLabel(p.status)}</span>
        <span>출원 ${fmtDate(p.filingDate)}</span>
      </div>
    </li>`).join("");
  if (editable) {
    ul.querySelectorAll(".inventor-patent-item.is-clickable").forEach(li => {
      li.addEventListener("click", () => {
        const p = STATE.data.patents.find(x => x.id === li.dataset.id);
        if (p) {
          closeMetricModal();
          openModal(p);
        }
      });
    });
  }
}

function fillMetricA1Summary(companyId) {
  const el = document.getElementById("metricA1Summary");
  if (!el) return;
  const a1 = partA1Progress(companyId);
  const a = partAProgress(companyId);
  el.className = "metric-a1-summary kpi-grid";
  const card = (icon, label, prog) => {
    const target = prog.annual || 0;
    const pct = prog.pct ?? 0;
    const tone = pct >= 100 ? "up" : "";
    const extra = `<div class="kpi-delta ${tone}">목표 ${target || "—"} · 달성률 ${prog.pct != null ? pct + "%" : "—"}</div>
      <div class="kpi-progress"><span style="width:${prog.pct != null ? Math.min(pct, 100) : 0}%"></span></div>`;
    return kpiHTML(icon, label, `${prog.done} <span class="kpi-unit">/ ${target || "—"}</span>`, extra, false, "kpi-major");
  };
  el.innerHTML = card("🏅", "A1 등급", a1) + card("🥇", "A 등급", a);
}

function fillMetricCountSummary(companyId) {
  const counts = metricCountsFromNames(partMetric(companyId).names);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("metricPendingCount", counts.pending);
  set("metricDisclosureCount", counts.disclosure);
  set("metricIdeaCount", counts.idea);
}

function openMetricModal(companyId) {
  if (!STATE.accessRole) return;
  const m = partMetric(companyId);
  const form = document.getElementById("metricForm");
  const ro = !canEditPart();
  document.getElementById("metricPartName").textContent = companyName(companyId);
  form.companyId.value = companyId;
  fillMetricCountSummary(companyId);
  form.a1t1.value = (m.a1Target || [])[0] || 0;
  form.a1t2.value = (m.a1Target || [])[1] || 0;
  form.a1t3.value = (m.a1Target || [])[2] || 0;
  form.a1t4.value = (m.a1Target || [])[3] || 0;
  form.t1.value = m.target[0] || 0;
  form.t2.value = m.target[1] || 0;
  form.t3.value = m.target[2] || 0;
  form.t4.value = m.target[3] || 0;
  // 목표(A1·전체 분기 목표)는 편집(1144) 권한만 수정 가능. 4001(파트)은 실적만 입력
  const canEditTargets = canEdit();
  const targetNames = ["a1t1", "a1t2", "a1t3", "a1t4", "t1", "t2", "t3", "t4"];
  form.querySelectorAll("input[type=number]").forEach(inp => {
    const isTarget = targetNames.includes(inp.name);
    inp.disabled = ro || (isTarget && !canEditTargets);
  });
  form.querySelectorAll(".metric-target-section").forEach(sec => {
    sec.classList.toggle("is-readonly", !canEditTargets);
  });
  const submitBtn = document.getElementById("metricSubmit");
  if (submitBtn) submitBtn.hidden = ro;
  fillMetricA1Summary(companyId);
  renderMetricProgressChart(companyId);
  renderMetricPatentList(companyId);
  renderMetricPeopleSections(companyId);
  const hasPending = (STATE.pendingApprovals || []).some(a => a.companyId === companyId);
  const pendingNotice = document.getElementById("metricPendingNotice");
  if (pendingNotice) pendingNotice.hidden = !(STATE.accessRole === "part" && hasPending);
  document.getElementById("metricModal").hidden = false;
}
function closeMetricModal() {
  destroyPartProgressChart("metric_prog");
  document.getElementById("metricModal").hidden = true;
}

function csvCell(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}
function csvRow(cells) { return cells.map(csvCell).join(","); }
function exportMetricModalCSV() {
  const form = document.getElementById("metricForm");
  const companyId = form?.companyId?.value;
  if (!companyId) return;
  const partName = companyName(companyId);
  const counts = metricCountsFromNames(partMetric(companyId).names);
  const pending = counts.pending;
  const disclosure = counts.disclosure;
  const idea = counts.idea;
  const num = (v) => Math.max(0, parseInt(v, 10) || 0);
  const a1Target = [num(form.a1t1?.value), num(form.a1t2?.value), num(form.a1t3?.value), num(form.a1t4?.value)];
  const target = [num(form.t1?.value), num(form.t2?.value), num(form.t3?.value), num(form.t4?.value)];
  const a1 = partA1Progress(companyId);
  const a = partAProgress(companyId);
  const year = STATE.data?.goals?.year || "";
  const lines = [];
  lines.push(csvRow(["파트", partName]));
  lines.push("");
  lines.push(csvRow(["구분", "항목", "값"]));
  lines.push(csvRow(["목표 달성", `${year}년 A1 달성`, a1.done]));
  lines.push(csvRow(["목표 달성", `${year}년 A1 목표`, a1.annual ?? ""]));
  lines.push(csvRow(["목표 달성", `${year}년 A1 달성률`, a1.pct != null ? `${a1.pct}%` : ""]));
  lines.push(csvRow(["목표 달성", "전체(A) 달성", a.done]));
  lines.push(csvRow(["목표 달성", "전체(A) 목표", a.annual ?? ""]));
  lines.push(csvRow(["목표 달성", "전체(A) 달성률", a.pct != null ? `${a.pct}%` : ""]));
  lines.push("");
  lines.push(csvRow(["지표", "심사중", pending]));
  lines.push(csvRow(["지표", "직발서", disclosure]));
  lines.push(csvRow(["지표", "아이디어", idea]));
  lines.push("");
  lines.push(csvRow(["담당자"]));
  lines.push(csvRow(["구분", "이름", "제목", "작성완료 목표", "진행 단계"]));
  METRIC_PEOPLE_KEYS.forEach(key => {
    partCatNames(companyId, key).forEach(p => {
      const n = normalizePerson(p);
      const stages = n.stages.map(s => `${s.text || "—"} (${formatReviewDateLabel(s.date)})`).join("; ");
      lines.push(csvRow([catLabel(key), n.name, n.title, formatReviewDateLabel(n.reviewDate), stages]));
    });
  });
  lines.push("");
  lines.push(csvRow(["A1 분기별 목표", "1분기", "2분기", "3분기", "4분기"]));
  lines.push(csvRow(["A1", ...a1Target]));
  lines.push(csvRow(["전체(A)", ...target]));
  lines.push("");
  lines.push(csvRow(["출원 목록"]));
  lines.push(csvRow(["관리번호", "특허명", "발명자", "등급", "상태", "출원일"]));
  patentsByCompany(companyId)
    .sort((x, y) => String(y.filingDate || "").localeCompare(String(x.filingDate || "")))
    .forEach(p => {
      lines.push(csvRow([p.id, p.title, (p.inventor || "").trim(), p.grade || "", statusLabel(p.status), p.filingDate || ""]));
    });
  const stamp = new Date().toISOString().slice(0, 10);
  const csv = "\uFEFF" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${partName}_지표_${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* 파트 모달 — 심사중·직발서·아이디어 담당자(이름·제목) 미리보기 */
function renderMetricPeopleSections(companyId) {
  const wrap = document.getElementById("metricPeopleSections");
  if (!wrap) return;
  const editable = canEditPart();
  wrap.innerHTML = METRIC_PEOPLE_KEYS.map(key => {
    const people = partCatNames(companyId, key);
    const preview = people.length
      ? people.map(p => {
          const n = normalizePerson(p);
          const stages = n.stages.length
            ? `<span class="mpp-stages">${n.stages.map(s =>
                `<span class="mpp-stage">${esc(s.text || "—")} · ${esc(formatReviewDateLabel(s.date))}</span>`
              ).join("")}</span>`
            : "";
          return `<li class="mpp-item">
            <div class="mpp-line mpp-line-name"><strong>${esc(n.name)}</strong></div>
            <div class="mpp-line mpp-line-title">${n.title ? esc(n.title) : "—"}</div>
            <div class="mpp-line mpp-line-meta">
              <span class="mpp-review">작성완료 목표 ${esc(formatReviewDateLabel(n.reviewDate))}</span>
              ${stages}
            </div>
          </li>`;
        }).join("")
      : `<li class="metric-people-empty">담당자 없음</li>`;
    return `
    <div class="metric-people-block">
      <div class="metric-people-head">
        <span>${catLabel(key)} <em class="metric-people-count">${people.length}명</em></span>
        ${editable ? `<button type="button" class="btn sm metric-people-edit" data-cat="${key}">담당자 편집</button>` : ""}
      </div>
      <ul class="metric-people-preview">${preview}</ul>
    </div>`;
  }).join("");
}

/* ---------- 발명자별 출원 목록 ---------- */
function openInventorModal(name) {
  const n = (name || "").trim();
  if (!n) return;
  const modal = document.getElementById("inventorModal");
  const list = patentsByInventor(n);
  document.getElementById("inventorModalName").textContent = n;
  document.getElementById("inventorModalCount").textContent =
    list.length ? `총 ${list.length}건의 출원` : "등록된 출원이 없습니다.";
  const ul = document.getElementById("inventorPatentList");
  if (!list.length) {
    ul.innerHTML = '<li class="inventor-patent-empty">해당 발명자의 특허가 없습니다.</li>';
  } else {
    const editable = canEdit();
    ul.innerHTML = list
      .sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")))
      .map(p => `
        <li class="inventor-patent-item${editable ? " is-clickable" : ""}" data-id="${esc(p.id)}"${editable ? ' title="클릭하여 수정"' : ""}>
          <div class="ip-title">${esc(p.title)}</div>
          <div class="ip-meta">
            <span>${esc(p.id)}</span>
            <span>${companyName(p.company)}</span>
            <span>등급 ${esc(p.grade || "—")}</span>
            <span>출원 ${fmtDate(p.filingDate)}</span>
          </div>
        </li>`).join("");
    if (editable) {
      ul.querySelectorAll(".inventor-patent-item.is-clickable").forEach(li => {
        li.addEventListener("click", () => {
          const p = STATE.data.patents.find(x => x.id === li.dataset.id);
          if (p) {
            closeInventorModal();
            openModal(p);
          }
        });
      });
    }
  }
  showModal(modal);
}

function closeInventorModal() {
  hideModal(document.getElementById("inventorModal"));
}

function bindInventorEvents() {
  if (bindInventorEvents._bound) return;
  bindInventorEvents._bound = true;
  document.getElementById("inventorClose")?.addEventListener("click", closeInventorModal);
  document.getElementById("inventorModal")?.addEventListener("click", (e) => {
    if (e.target.id === "inventorModal") closeInventorModal();
  });
  document.addEventListener("keydown", (e) => {
    const m = document.getElementById("inventorModal");
    if (e.key === "Escape" && m && !m.hidden) closeInventorModal();
  });
}

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
  if (!canEdit()) return;
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
      if (canEdit()) openGoalsModal();
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
  document.getElementById("metricExportCsv")?.addEventListener("click", exportMetricModalCSV);
  document.getElementById("metricCancel")?.addEventListener("click", closeMetricModal);
  document.getElementById("metricModal")?.addEventListener("click", (e) => {
    if (e.target.id === "metricModal") closeMetricModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("metricModal").hidden) closeMetricModal();
  });
  document.getElementById("metricForm")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".metric-people-edit");
    if (!btn) return;
    const companyId = document.getElementById("metricForm")?.companyId?.value;
    if (companyId) openPeopleModal(companyId, btn.dataset.cat);
  });
  document.getElementById("metricForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.companyId.value;
    const num = (v) => Math.max(0, parseInt(v, 10) || 0);
    const prev = partMetric(id);
    // 목표는 편집(1144) 권한만 변경 가능. 그 외(4001)는 기존 목표 유지
    const a1Target = canEdit()
      ? [num(f.a1t1.value), num(f.a1t2.value), num(f.a1t3.value), num(f.a1t4.value)]
      : (prev.a1Target || [0, 0, 0, 0]).slice();
    const target = canEdit()
      ? [num(f.t1.value), num(f.t2.value), num(f.t3.value), num(f.t4.value)]
      : (prev.target || [0, 0, 0, 0]).slice();
    STATE.partMetrics[id] = applyMetricCountsFromNames({
      ...prev,
      a1Target,
      target,
      names: normalizeNames(prev.names),
    });
    commitChange();
    closeMetricModal();
  });
}

/* ---------- 담당자(사람) 편집 모달 ---------- */
function openPeopleModal(companyId, key) {
  if (key === "patent") return;        // 특허는 발명자 자동 집계 (편집 X)
  if (!canEditPart()) return;
  const cur = (partMetric(companyId).names?.[key] || []).map(normalizePerson).filter(Boolean);
  STATE.peopleEdit = { companyId, key, names: cur };
  document.getElementById("peopleModalTitle").textContent =
    `${companyName(companyId)} · ${catLabel(key)} 담당자`;
  const nameInput = document.getElementById("peopleNameInput");
  const titleInput = document.getElementById("peopleTitleInput");
  const reviewInput = document.getElementById("peopleReviewInput");
  if (nameInput) nameInput.value = "";
  if (titleInput) titleInput.value = "";
  if (reviewInput) reviewInput.value = "";
  renderPeopleList();
  const saveBtn = document.getElementById("peopleSave");
  if (saveBtn) saveBtn.textContent = STATE.accessRole === "part" ? "저장 및 승인 요청" : "저장";
  showModal(document.getElementById("peopleModal"));
  setTimeout(() => nameInput?.focus(), 50);
}
function closePeopleModal() {
  hideModal(document.getElementById("peopleModal"));
  STATE.peopleEdit = null;
}
function renderPeopleAdvanceActions(i, person, key) {
  if (person.completed && key === "pending") {
    return `
      <div class="people-advance-row">
        <button type="button" class="btn sm people-advance-done" disabled>완료</button>
        <button type="button" class="btn sm people-done-remove" data-i="${i}">삭제</button>
      </div>`;
  }
  const nextKey = nextMetricStageKey(key);
  if (!nextKey && key !== "pending") return "";
  const hint = nextKey ? ` → ${catLabel(nextKey)}` : "";
  return `
    <div class="people-advance-row">
      <button type="button" class="btn sm primary people-advance-next" data-i="${i}">다음 단계로 이동${hint}</button>
    </div>`;
}
function syncPersonFromInputs(i) {
  if (!STATE.peopleEdit || i < 0 || i >= STATE.peopleEdit.names.length) return;
  const person = STATE.peopleEdit.names[i];
  const titleInp = document.getElementById(`peopleTitle_${i}`);
  const reviewInp = document.getElementById(`peopleReview_${i}`);
  if (titleInp) person.title = titleInp.value.trim();
  if (reviewInp) person.reviewDate = reviewInp.value.trim();
  document.querySelectorAll(`.people-stage-text[data-i="${i}"], .people-stage-date[data-i="${i}"]`).forEach(el => {
    syncPeopleFieldFromInput(el);
  });
}
function movePersonToNextStage(i) {
  if (!STATE.peopleEdit || i < 0 || i >= STATE.peopleEdit.names.length) return;
  syncPersonFromInputs(i);
  const { companyId, key, names } = STATE.peopleEdit;
  const person = normalizePerson(names[i]);
  if (!person) return;

  if (key === "pending") {
    person.completed = true;
    names[i] = person;
    renderPeopleList();
    return;
  }

  const nextKey = nextMetricStageKey(key);
  if (!nextKey) return;

  names.splice(i, 1);
  const m = partMetric(companyId);
  const next = normalizeNames(m.names);
  next[key] = names.map(normalizePerson).filter(Boolean);
  next[nextKey] = [...(next[nextKey] || []), person];
  if (STATE.accessRole === "part") {
    const beforeData = { names: JSON.parse(JSON.stringify(normalizeNames(m.names))) };
    const afterData = { names: JSON.parse(JSON.stringify(next)) };
    requestApprovalChange(companyId, beforeData, afterData);
    closePeopleModal();
    closeMetricModal();
    return;
  }
  STATE.partMetrics[companyId] = applyMetricCountsFromNames(Object.assign(emptyMetric(), m, { names: next }));
  commitChange();
  refreshMetricModalIfOpen(companyId);
  renderPeopleList();
}
function renderPeopleStages(i, stages) {
  const list = stages.length ? stages : [];
  const rows = list.map((s, si) => `
    <div class="people-stage-row">
      <input type="text" class="input people-stage-text" data-i="${i}" data-si="${si}" value="${esc(s.text)}" placeholder="진행 단계" />
      <input type="date" class="input people-stage-date" data-i="${i}" data-si="${si}" value="${esc(s.date)}" title="날짜" />
      <button type="button" class="btn icon people-stage-remove" data-i="${i}" data-si="${si}" title="단계 삭제">✕</button>
    </div>`).join("");
  return `
    <div class="people-stages-block">
      <div class="people-stages-head">
        <span class="people-field-label">진행 단계</span>
        <button type="button" class="btn sm people-stage-add" data-i="${i}">+ 추가</button>
      </div>
      <div class="people-stages-list">${rows || '<div class="people-stages-empty">진행 단계 없음 — 추가 버튼으로 입력</div>'}</div>
    </div>`;
}
function renderPeopleList() {
  const ul = document.getElementById("peopleNameList");
  if (!ul || !STATE.peopleEdit) return;
  const names = STATE.peopleEdit.names;
  const key = STATE.peopleEdit.key;
  ul.innerHTML = names.length
    ? names.map((p, i) => {
      const completed = p.completed && key === "pending";
      return `
      <li class="people-name-item${completed ? " is-completed" : ""}">
        <div class="people-item-fields">
          <div class="people-field-row people-field-main">
            <span class="people-field-label">이름</span>
            <strong class="people-item-name">${esc(p.name)}</strong>
          </div>
          <div class="people-field-row">
            <label class="people-field-label" for="peopleTitle_${i}">제목</label>
            <input class="input people-title-input" id="peopleTitle_${i}" data-i="${i}" value="${esc(p.title)}" placeholder="제목 입력"${completed ? " disabled" : ""} />
          </div>
          <div class="people-field-row people-field-review">
            <label class="people-field-label" for="peopleReview_${i}">작성완료 목표</label>
            <input type="date" class="input people-review-date" id="peopleReview_${i}" data-i="${i}" value="${esc(p.reviewDate)}" title="작성완료 목표 (비우면 미정)"${completed ? " disabled" : ""} />
          </div>
          ${completed ? "" : renderPeopleStages(i, p.stages || [])}
          ${renderPeopleAdvanceActions(i, p, key)}
        </div>
        ${completed ? "" : `<button type="button" class="btn icon people-remove" data-i="${i}" title="담당자 삭제">✕</button>`}
      </li>`;
    }).join("")
    : '<li class="inventor-patent-empty">담당자가 없습니다. 이름·제목·작성완료 목표를 추가하세요.</li>';
}
function syncPeopleFieldFromInput(el) {
  if (!STATE.peopleEdit || !el) return;
  const i = parseInt(el.dataset.i, 10);
  if (i < 0 || i >= STATE.peopleEdit.names.length) return;
  const person = STATE.peopleEdit.names[i];
  if (el.classList.contains("people-title-input")) {
    person.title = el.value.trim();
  } else if (el.classList.contains("people-review-date")) {
    person.reviewDate = el.value.trim();
  } else if (el.classList.contains("people-stage-text") || el.classList.contains("people-stage-date")) {
    const si = parseInt(el.dataset.si, 10);
    if (!person.stages[si]) person.stages[si] = { text: "", date: "" };
    if (el.classList.contains("people-stage-text")) person.stages[si].text = el.value.trim();
    else person.stages[si].date = el.value.trim();
  }
}
function addPeopleStage(i) {
  if (!STATE.peopleEdit || i < 0 || i >= STATE.peopleEdit.names.length) return;
  if (!Array.isArray(STATE.peopleEdit.names[i].stages)) STATE.peopleEdit.names[i].stages = [];
  STATE.peopleEdit.names[i].stages.push({ text: "", date: "" });
  renderPeopleList();
  const inp = document.querySelector(`.people-stage-text[data-i="${i}"][data-si="${STATE.peopleEdit.names[i].stages.length - 1}"]`);
  inp?.focus();
}
function removePeopleStage(i, si) {
  if (!STATE.peopleEdit || i < 0 || i >= STATE.peopleEdit.names.length) return;
  const stages = STATE.peopleEdit.names[i].stages;
  if (!Array.isArray(stages) || si < 0 || si >= stages.length) return;
  stages.splice(si, 1);
  renderPeopleList();
}
function addPeopleName() {
  if (!STATE.peopleEdit) return;
  const nameInput = document.getElementById("peopleNameInput");
  const titleInput = document.getElementById("peopleTitleInput");
  const reviewInput = document.getElementById("peopleReviewInput");
  const raw = (nameInput?.value || "").trim();
  if (!raw) return;
  const title = (titleInput?.value || "").trim();
  const reviewDate = (reviewInput?.value || "").trim();
  raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean).forEach(name => {
    STATE.peopleEdit.names.push({ name, title, reviewDate, stages: [], completed: false });
  });
  if (nameInput) nameInput.value = "";
  if (titleInput) titleInput.value = "";
  if (reviewInput) reviewInput.value = "";
  renderPeopleList();
  nameInput?.focus();
}
async function savePeopleNames() {
  if (!STATE.peopleEdit) return;
  const { companyId, key, names } = STATE.peopleEdit;
  const m = partMetric(companyId);
  const next = normalizeNames(m.names);
  next[key] = names.map(normalizePerson).filter(Boolean);
  if (STATE.accessRole === "part") {
    const beforeData = { names: JSON.parse(JSON.stringify(normalizeNames(m.names))) };
    const afterData = { names: JSON.parse(JSON.stringify(next)) };
    await requestApprovalChange(companyId, beforeData, afterData);
    closePeopleModal();
    closeMetricModal();
    return;
  }
  STATE.partMetrics[companyId] = applyMetricCountsFromNames(Object.assign(emptyMetric(), m, { names: next }));
  commitChange();
  closePeopleModal();
  refreshMetricModalIfOpen(companyId);
}
function bindPeopleEvents() {
  document.getElementById("peopleClose")?.addEventListener("click", closePeopleModal);
  document.getElementById("peopleCancel")?.addEventListener("click", closePeopleModal);
  document.getElementById("peopleModal")?.addEventListener("click", (e) => {
    if (e.target.id === "peopleModal") closePeopleModal();
  });
  document.addEventListener("keydown", (e) => {
    const m = document.getElementById("peopleModal");
    if (e.key === "Escape" && m && !m.hidden) closePeopleModal();
  });
  document.getElementById("peopleAddBtn")?.addEventListener("click", addPeopleName);
  document.getElementById("peopleNameInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addPeopleName(); }
  });
  document.getElementById("peopleTitleInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addPeopleName(); }
  });
  document.getElementById("peopleSave")?.addEventListener("click", savePeopleNames);
  document.getElementById("peopleNameList")?.addEventListener("click", (e) => {
    const advance = e.target.closest(".people-advance-next");
    if (advance && STATE.peopleEdit) {
      movePersonToNextStage(parseInt(advance.dataset.i, 10));
      return;
    }
    const doneRemove = e.target.closest(".people-done-remove");
    if (doneRemove && STATE.peopleEdit) {
      const i = parseInt(doneRemove.dataset.i, 10);
      if (i >= 0) {
        STATE.peopleEdit.names.splice(i, 1);
        const { companyId, key } = STATE.peopleEdit;
        const m = partMetric(companyId);
        const next = normalizeNames(m.names);
        next[key] = STATE.peopleEdit.names.map(normalizePerson).filter(Boolean);
        if (STATE.accessRole === "part") {
          const beforeData = { names: JSON.parse(JSON.stringify(normalizeNames(m.names))) };
          const afterData = { names: JSON.parse(JSON.stringify(next)) };
          requestApprovalChange(companyId, beforeData, afterData);
          closePeopleModal();
          closeMetricModal();
          return;
        }
        STATE.partMetrics[companyId] = applyMetricCountsFromNames(Object.assign(emptyMetric(), m, { names: next }));
        commitChange();
        refreshMetricModalIfOpen(companyId);
        renderPeopleList();
      }
      return;
    }
    const btn = e.target.closest(".people-remove");
    if (btn && STATE.peopleEdit) {
      const i = parseInt(btn.dataset.i, 10);
      if (i >= 0) {
        STATE.peopleEdit.names.splice(i, 1);
        renderPeopleList();
      }
      return;
    }
    const addStage = e.target.closest(".people-stage-add");
    if (addStage && STATE.peopleEdit) {
      addPeopleStage(parseInt(addStage.dataset.i, 10));
      return;
    }
    const rmStage = e.target.closest(".people-stage-remove");
    if (rmStage && STATE.peopleEdit) {
      removePeopleStage(parseInt(rmStage.dataset.i, 10), parseInt(rmStage.dataset.si, 10));
    }
  });
  document.getElementById("peopleNameList")?.addEventListener("input", (e) => {
    syncPeopleFieldFromInput(e.target);
  });
  document.getElementById("peopleNameList")?.addEventListener("change", (e) => {
    syncPeopleFieldFromInput(e.target);
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

/* ---------- 비밀번호 잠금 · 권한 ---------- */
let appStarted = false;

function applyAccessUI() {
  const role = STATE.accessRole;
  const edit = role === "edit";
  const part = role === "part";
  document.body.classList.toggle("readonly-mode", role === "view");
  document.body.classList.toggle("part-edit-mode", part);
  const badge = document.getElementById("accessBadge");
  if (badge) {
    const labels = { edit: "편집 권한", part: "파트 편집", view: "보기 전용" };
    badge.textContent = labels[role] || "보기 전용";
    badge.className = "access-badge " + (role || "view");
    badge.hidden = false;
  }
  const addBtn = document.getElementById("addBtn");
  if (addBtn) addBtn.hidden = !edit;
  const goalsBtn = document.getElementById("editGoalsBtn");
  if (goalsBtn) goalsBtn.hidden = !edit;
  const hist = document.querySelector(".hist-controls");
  if (hist) hist.hidden = !edit;
  document.querySelectorAll(".th-actions").forEach(el => { el.hidden = !edit; });
  updateApprovalBadge();
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  const dark = document.documentElement.classList.contains("dark");
  const themeBtn = document.getElementById("themeToggle");
  if (themeBtn) themeBtn.textContent = dark ? "☀️" : "🌙";
  await init();
  applyAccessUI();
}

function unlockApp(role) {
  STATE.accessRole = role;
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
    const pw = input.value.trim();
    if (pw === ACCESS_EDIT) {
      err.hidden = true;
      unlockApp("edit");
    } else if (pw === ACCESS_VIEW) {
      err.hidden = true;
      unlockApp("view");
    } else if (pw === ACCESS_PART) {
      err.hidden = true;
      unlockApp("part");
    } else {
      err.hidden = false;
      input.value = "";
      input.focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", setupLock);
