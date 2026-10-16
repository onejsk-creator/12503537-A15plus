/* A15+ | 여의도·이태원 2부지 최종 의사결정 모델 — 12503537 정승원 (AI부동산금융모델링 7주차) */

/* ===== engine.js ===== */
/* =====================================================================
 * A15+ 계산엔진  (Google Apps Script V8 · Node 공용 순수 JavaScript)
 * 단위: 금액 = 억원 · 단가 = 만원/평 · 면적 = 평 · 비율 = 소수(0.60)
 * ---------------------------------------------------------------------
 *  교수님 A15 로직(월별 CF · 0.5×신규Debt 이자 · 이자 Equity 부담 ·
 *  최종월 일괄상환 · Bisection Goal Seek · 5×5 민감도)을 그대로 두고
 *  아래를 확장했다.
 *   ① 수입 3유형: SALE(분양/통매각) · LEASE(임대→Cap 환원) · HOTEL(객실→NOI→Cap)
 *   ② 공사비 = 용도 기준단가(교수님 가이드) × 부지 할증계수(지하·굴토)
 *   ③ 준공 후 안정화기간(임대·운영 NOI 램프업) 후 Exit
 *   ④ 균등 / S-Curve 집행, 일괄 / 분할(10·60·30) 분양대금
 *   ⑤ 몬테카를로(시드 고정) → 목표 IRR 달성확률 · 80% 안전 매입가
 * ===================================================================== */
 
var USE_PRESETS = {
  // 교수님 가이드: 오피스텔 ≈ 800만원/평, 호텔은 그보다 약 30% 높게(≈1,040)
  '오피스텔':      { cost: 800,  otherRate: 0.15 },
  '오피스':        { cost: 900,  otherRate: 0.15 },
  '리테일+오피스': { cost: 900,  otherRate: 0.15 },
  '호텔':          { cost: 1040, otherRate: 0.20 }
};
 
function a15Clone(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }
 
/* ---------- 1. 개발규모 ---------- */
function a15Scale(a) {
  var buildArea = a.siteArea * a.bcr;
  var farGFA = a.siteArea * a.far;
  var costGFA = farGFA * (1 + a.exclRate);
  return { buildArea: buildArea, farGFA: farGFA, costGFA: costGFA };
}
 
/* ---------- 2. 단가 ---------- */
function a15UnitCost(a) {            // 만원/평
  return (a.buildCost != null) ? a.buildCost : USE_PRESETS[a.use].cost * a.siteCostFactor;
}
 
/* ---------- 3. 수입 ---------- */
function a15Revenue(a, s, pf, capShift) {
  pf = pf || 1; capShift = capShift || 0;
  var cap = a.capRate + capShift;
  if (a.revType === 'HOTEL') {
    var rooms = Math.floor(s.farGFA / a.gfaPerRoom);
    var roomRev = rooms * 365 * a.occ * a.adr * pf / 10000;       // 억원/년
    var totalRev = roomRev / a.roomShare;
    var noi = totalRev * a.noiMargin;
    var gross = noi / cap;
    return { exit: gross * (1 - a.saleCostRate), noi: noi, gross: gross, rooms: rooms,
             perRoom: rooms ? gross / rooms : 0, cap: cap, salesArea: 0 };
  }
  if (a.revType === 'LEASE') {
    var nla = s.farGFA * a.leaseRatio;                            // 임대면적
    var rent = a.rent * pf * Math.pow(1 + a.rentGrowth, (a.constMonths + a.stabMonths) / 12);
    var noiL = nla * rent * 12 / 10000 * (1 - a.vacancy) * (1 - a.opexRate);
    var grossL = noiL / cap;
    return { exit: grossL * (1 - a.saleCostRate), noi: noiL, gross: grossL, nla: nla,
             cap: cap, salesArea: 0 };
  }
  var salesArea = s.costGFA * a.salesRatio;
  return { exit: salesArea * a.salePrice * pf / 10000, salesArea: salesArea, noi: 0 };
}
 
/* ---------- 4. 금리 Index ---------- */
function a15Rate(a, t, rateShift) {
  return a.baseRate + a.spread + a.scenShift + (rateShift || 0) + a.trend * t / 12;
}
 
/* ---------- 5. 집행 가중치 ---------- */
function a15Weights(n, mode) {
  var w = [], sum = 0, t;
  for (t = 1; t <= n; t++) {
    var v = (mode === 'SCURVE') ? Math.sin(Math.PI * (t - 0.5) / n) : 1;
    w.push(v); sum += v;
  }
  for (t = 0; t < n; t++) w[t] /= sum;
  return w;
}
 
/* ---------- 6. 월별 Projection ---------- */
function a15Project(a, opt) {
  opt = opt || {};
  var pf = opt.priceFactor || 1, cf = opt.costFactor || 1;
  var land = (opt.land != null) ? opt.land : a.landPrice;
  var delay = opt.delay || 0, rateShift = opt.rateShift || 0, capShift = opt.capShift || 0;
  var s = a15Scale(a);
  var rev = a15Revenue(a, s, pf, capShift);
  var unit = a15UnitCost(a) * cf;
  var direct = s.costGFA * unit / 10000;
  var other = direct * a.otherRate;
  var acq = land * a.acqRate;
  var C = a.constMonths + delay;                                   // 준공월
  var L = (a.revType === 'SALE') ? 0 : a.stabMonths;              // 안정화기간
  var N = C + L;                                                   // Exit월
  var w = a15Weights(C, a.costCurve);
 
  var inflow = []; for (var i = 0; i <= N; i++) inflow.push(0);
  if (a.revType === 'SALE' && a.saleSchedule === 'SPLIT') {
    var k = Math.max(1, Math.min(a.saleStart, N - 2));
    inflow[k] += rev.exit * 0.10;
    var mids = N - 1 - k;
    for (var m = k + 1; m <= N - 1; m++) inflow[m] += rev.exit * 0.60 / mids;
    inflow[N] += rev.exit * 0.30;
  } else {
    inflow[N] += rev.exit;
  }
  var opNOI = 0;
  for (var j = 1; j <= L; j++) {                                  // 운영 NOI 선형 램프업
    var v = rev.noi / 12 * (j / L);
    inflow[C + j] += v; opNOI += v;
  }
 
  var rows = [], debt = land * a.ltv, totInt = 0, peakDebt = debt;
  rows.push({ t: 0, rate: a15Rate(a, 0, rateShift), cost: land + acq, newDebt: debt,
              interest: 0, repay: 0, debtEnd: debt, inflow: inflow[0],
              projCF: -(land + acq) + inflow[0], eqCF: -(land + acq) + debt + inflow[0] });
  for (var t = 1; t <= N; t++) {
    var dc = (t <= C) ? (direct + other) * w[t - 1] : 0;
    // 유입(분양대금·운영NOI)은 ① 당월 사업비 충당 → ② Debt 조기상환 → ③ 잔여만 Equity 귀속
    var avail = inflow[t];
    var useCost = Math.min(avail, dc); avail -= useCost;
    var uncovered = dc - useCost;
    var nd = uncovered * a.ltv;
    var r = a15Rate(a, t, rateShift);
    var intr = (debt + 0.5 * nd) * r / 12;
    var before = debt + nd;
    peakDebt = Math.max(peakDebt, before);
    var repay = (t === N) ? before : Math.min(avail, before);
    var fromInflow = Math.min(avail, repay); avail -= fromInflow;
    debt = before - repay;
    totInt += intr;
    rows.push({ t: t, rate: r, cost: dc, newDebt: nd, interest: intr, repay: repay,
                debtEnd: debt, inflow: inflow[t],
                projCF: -dc + inflow[t],
                eqCF: -(uncovered - nd) - intr - (repay - fromInflow) + avail });
  }
  var projCF = rows.map(function (x) { return x.projCF; });
  var eqCF = rows.map(function (x) { return x.eqCF; });
  var totalIn = rev.exit + opNOI;
  var profit = totalIn - land - acq - direct - other - totInt;
  var eqIn = 0, eqOut = 0, cum = 0, peak = 0;
  eqCF.forEach(function (x) { if (x < 0) eqIn -= x; else eqOut += x; cum += x; peak = Math.min(peak, cum); });
 
  return { scale: s, rev: rev, unitCost: unit, direct: direct, other: other, acq: acq,
           land: land, interest: totInt, opNOI: opNOI, totalIn: totalIn,
           peakDebt: peakDebt, months: N, buildMonths: C, rows: rows,
           projCF: projCF, eqCF: eqCF,
           projIRR: opt.noIRR ? null : a15AnnualIRR(projCF),
           eqIRR: opt.noIRR ? null : a15AnnualIRR(eqCF),
           profit: profit, margin: totalIn ? profit / totalIn : 0,
           equityMultiple: eqIn ? eqOut / eqIn : 0, peakEquity: -peak };
}
 
/* ---------- 7. IRR / NPV ---------- */
function a15NPV(cfs, mr) {
  var v = 0, d = 1, k = 1 / (1 + mr);
  for (var i = 0; i < cfs.length; i++) { v += cfs[i] * d; d *= k; }
  return v;
}
function a15AnnualIRR(cfs) {
  var lo = -0.5, hi = 0.5, flo = a15NPV(cfs, lo), fhi = a15NPV(cfs, hi);
  if (flo * fhi > 0) return null;
  for (var k = 0; k < 60; k++) {
    var mid = (lo + hi) / 2, fm = a15NPV(cfs, mid);
    if (flo * fm <= 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return Math.pow(1 + (lo + hi) / 2, 12) - 1;
}
 
/* ---------- 8. 목표 Equity IRR 기준 최대 매입가능 토지가격 ---------- */
function a15MaxLand(a, opt) {
  opt = opt || {};
  var mr = Math.pow(1 + a.targetIRR, 1 / 12) - 1;
  var f = function (Lp) { var o = a15Clone(opt); o.land = Lp; o.noIRR = true; return a15NPV(a15Project(a, o).eqCF, mr); };
  var o0 = a15Clone(opt); o0.noIRR = true;
  var lo = 0, hi = Math.max(a15Project(a, o0).totalIn, 1);
  if (f(lo) < 0) return 0;
  while (f(hi) > 0) hi *= 2;
  for (var i = 0; i < 60 && hi - lo > 0.01; i++) {
    var mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
 
/* ---------- 9. Sensitivity 5×5 (수입단가 × 공사비) ---------- */
function a15Sensitivity(a) {
  var steps = [-0.10, -0.05, 0, 0.05, 0.10], maxLand = [], irr = [];
  steps.forEach(function (dp) {
    var r1 = [], r2 = [];
    steps.forEach(function (dc) {
      var o = { priceFactor: 1 + dp, costFactor: 1 + dc };
      r1.push(a15MaxLand(a, o)); r2.push(a15Project(a, o).eqIRR);
    });
    maxLand.push(r1); irr.push(r2);
  });
  return { steps: steps, maxLand: maxLand, irr: irr };
}
 
/* ---------- 10. 몬테카를로 ---------- */
function a15Rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function a15Normal(rng) { var u = 1 - rng(), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function a15Tri(rng, lo, mode, hi) {
  if (hi <= lo) return lo;
  var u = rng(), f = (mode - lo) / (hi - lo);
  return u < f ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
}
function a15MonteCarlo(a, n, seed) {
  var rng = a15Rng(seed || 20261017), irrs = [], lands = [], ok = 0, loss = 0, landOk = 0;
  for (var i = 0; i < n; i++) {
    var o = {
      priceFactor: 1 + a.mcPriceSd * a15Normal(rng),
      costFactor: 1 + a15Tri(rng, -0.05, 0, a.mcCostUp),
      rateShift: a.mcRateSd * a15Normal(rng),
      capShift: (a.revType === 'SALE') ? 0 : a.mcCapSd * a15Normal(rng),
      delay: Math.round(a15Tri(rng, 0, 0, a.mcDelayMax))
    };
    var p = a15Project(a, o), irr = (p.eqIRR == null) ? -1 : p.eqIRR;
    irrs.push(irr);
    if (irr >= a.targetIRR) ok++;
    if (p.profit < 0) loss++;
    var ml = a15MaxLand(a, o); lands.push(ml);
    if (ml >= a.landPrice) landOk++;
  }
  var sI = irrs.slice().sort(function (x, y) { return x - y; });
  var sL = lands.slice().sort(function (x, y) { return x - y; });
  var q = function (arr, p) { return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]; };
  return { n: n, irrs: irrs, probTarget: ok / n, probLoss: loss / n, probLandOk: landOk / n,
           irrP10: q(sI, 0.10), irrP50: q(sI, 0.50), irrP90: q(sI, 0.90),
           safeLand80: q(sL, 0.20), landP50: q(sL, 0.50) };
}
 
/* ---------- 11. 의사결정 ---------- */
function a15Decision(base, maxLand, mc, a) {
  var irrOK = base.eqIRR != null && base.eqIRR >= a.targetIRR;
  var probOK = mc.probTarget >= 0.70;
  var v;
  if (irrOK && probOK) v = 'GO';
  else if (irrOK || maxLand >= a.landPrice * 0.90) v = 'CONDITIONAL GO';
  else v = 'NO-GO';
  return { verdict: v, headroom: maxLand - a.landPrice,
           headroomPct: a.landPrice ? (maxLand - a.landPrice) / a.landPrice : 0,
           bidCeiling: maxLand, bidTarget: mc.safeLand80 };
}
 
/* ---------- 12. 용도 대안 비교(최유효이용 정량화) ---------- */
function a15UseMix(site) {
  return site.alternatives.map(function (alt) {
    var a = a15Clone(site.base); for (var k in alt) if (k !== 'label' && k !== 'blocked') a[k] = alt[k];
    a.buildCost = null;                                   // 용도 기준단가 × 할증계수
    if (alt.blocked) return { label: alt.label, use: a.use, blocked: alt.blocked };
    var p = a15Project(a, {});
    return { label: alt.label, use: a.use, far: a.far, unitCost: p.unitCost,
             revenue: p.totalIn, eqIRR: p.eqIRR, maxLand: a15MaxLand(a, {}), blocked: '' };
  });
}
 
/* ---------- 13. 한 부지 전체 분석 ---------- */
function a15Analyze(a, mcN) {
  var base = a15Project(a, {});
  var maxLand = a15MaxLand(a, {});
  var mc = a15MonteCarlo(a, mcN || 400, a.seed);
  return { base: base, maxLand: maxLand, sens: a15Sensitivity(a), mc: mc,
           decision: a15Decision(base, maxLand, mc, a) };
}
 
 
/* ===== sites.js ===== */
/* =====================================================================
 * 부지별 입력가정 (3·4주차 검토보고서 v2 + 2026 시장자료 기반, 검토자 결정값)
 * ===================================================================== */
var PY = 3.3058;   // ㎡ → 평
 
var COMMON = {
  bcr: 0.60, acqRate: 0.05, baseRate: 0.030, scenShift: 0, trend: 0,
  costCurve: 'SCURVE', saleSchedule: 'LUMP', saleStart: 3, buildCost: null,
  targetIRR: 0.12, seed: 20261017,
  mcPriceSd: 0.07, mcCostUp: 0.15, mcRateSd: 0.0075, mcCapSd: 0.0025, mcDelayMax: 6,
  // 미사용 필드 기본값
  salesRatio: 1.0, salePrice: 0, gfaPerRoom: 11, adr: 0, occ: 0, roomShare: 0.75,
  noiMargin: 0.30, capRate: 0.05, saleCostRate: 0.015, leaseRatio: 1, rent: 0,
  rentGrowth: 0.02, vacancy: 0.07, opexRate: 0.10, stabMonths: 12
};
function mergeSite(extra) { var o = {}; var k; for (k in COMMON) o[k] = COMMON[k]; for (k in extra) o[k] = extra[k]; return o; }
 
var SITES = {
  YD: {
    key: 'YD', name: '여의도 48-1·48-5', subtitle: '일반상업 · 지구단위 · 샛강역 4번 출구',
    base: mergeSite({
      siteArea: 1210 / PY, far: 9.74, exclRate: 0.50,          // 허가 연면적 17,646㎡와 0.2% 차이
      use: '오피스', siteCostFactor: 1.3333,                   // 900 × 1.333 = 1,200 (지하 7층·31m 굴토)
      otherRate: 0.15, revType: 'SALE', salesRatio: 1.0, salePrice: 3600,   // 연면적 기준 통매각
      landPrice: 732,                                           // 2022.08 실거래(현재 검토가)
      ltv: 0.70, spread: 0.035, constMonths: 42
    }),
    alternatives: [
      { label: '업무시설+근생 (3주차 채택)', use: '오피스' },
      { label: '오피스텔 (주거용 용적률 400% 이하)', use: '오피스텔', far: 4.00,
        revType: 'SALE', salePrice: 4800, saleSchedule: 'SPLIT' },
      { label: '비즈니스 호텔 (Cap 환원)', use: '호텔', revType: 'HOTEL',
        gfaPerRoom: 11, adr: 24, occ: 0.792, roomShare: 0.75, noiMargin: 0.30,
        capRate: 0.05, otherRate: 0.20, stabMonths: 12 }
    ]
  },
  IT: {
    key: 'IT', name: '이태원 124-3·124-4', subtitle: '2종일반+준주거 · 고도지구 15m · 이태원역 2~3분',
    base: mergeSite({
      siteArea: 996.4 / PY, far: 2.12, exclRate: 1.2502,       // 지하 B4 798.9평 / 용적률 639.0평
      use: '리테일+오피스', siteCostFactor: 1.2713,            // 900 × 1.271 ≈ 1,144 (지상950·지하1,300 가중)
      otherRate: 0.15, revType: 'LEASE', leaseRatio: 1.313,     // 임대면적 839평(B1 포함)
      rent: 21.69, rentGrowth: 0.02, vacancy: 0.07, opexRate: 0.10,
      capRate: 0.035, saleCostRate: 0.015, stabMonths: 12,
      landPrice: 449.7,                                         // 5회차 공매 최저가(현재 검토가)
      ltv: 0.60, spread: 0.040, constMonths: 30                 // 사전 6 + 공사 24
    }),
    alternatives: [
      { label: '리테일+크리에이티브 오피스 (4주차 채택)', use: '리테일+오피스' },
      { label: '오피스텔 분양 (고도 15m · 4층)', use: '오피스텔', revType: 'SALE',
        salesRatio: 0.90, salePrice: 4000, saleSchedule: 'SPLIT' },
      { label: '호텔', use: '호텔', blocked: '2종일반주거 포함 → 숙박시설 불가' }
    ]
  }
};
 
// 교수님 A15 Base Case (엔진 검증용 체크포인트)
var PROF_BASE = mergeSite({
  siteArea: 1000, bcr: 0.60, far: 8.0, exclRate: 0.20, use: '오피스', siteCostFactor: 1,
  buildCost: 1000, otherRate: 0.15, revType: 'SALE', salesRatio: 7000 / 9600, salePrice: 5000,
  landPrice: 1000, ltv: 0.60, spread: 0.025, constMonths: 36, costCurve: 'EVEN', targetIRR: 0.15
});
 
 
/* ===== sheet_glue.js ===== */
/* =====================================================================
 * A15+ 스프레드시트 · Web App 연결부
 * 메뉴: [A15+ 의사결정 모델] → ① 초기화 → (노란 셀 수정) → ② 계산 새로고침
 * ===================================================================== */
 
var SHEET = { START: 'START_HERE', ASM: 'Assumption', IDX: 'Index', PJ_YD: 'Projection_여의도',
              PJ_IT: 'Projection_이태원', SENS: 'Sensitivity', USE: 'UseMix', RISK: 'Risk_MC',
              DEC: 'Decision', LOG: 'Log' };
var COLOR = { navy: '#1F3A5F', yellow: '#FFF2CC', grey: '#F3F3F3', green: '#D9EAD3',
              amber: '#FCE5CD', red: '#F4CCCC', line: '#B7B7B7' };
 
// [키, 항목, 단위, 형식, 근거·출처]
var ASM_ROWS = [
  ['§', '1. 부지와 상품'],
  ['use', '개발용도', '텍스트', 'text', '오피스텔·오피스·리테일+오피스·호텔 중 선택(공사비 프리셋 연동)'],
  ['revType', '수입유형', 'SALE/LEASE/HOTEL', 'text', 'SALE=분양·통매각 · LEASE=임대 NOI÷Cap · HOTEL=객실 NOI÷Cap'],
  ['siteArea', '대지면적', '평', '#,##0.0', '여의도 1,210㎡ · 이태원 996.4㎡ (토지대장, ÷3.3058)'],
  ['bcr', '건폐율', '%', '0.0%', '허가안 각 59.87%·59.93% → 60%'],
  ['far', '용적률', '%', '0%', '여의도 974%(기준800+인센티브, 허가 11,787.7㎡) · 이태원 212%(고도 15m 실질한계)'],
  ['exclRate', '용적률 제외면적비율', '%', '0.0%', '여의도 지하7층 49.7%→50% · 이태원 지하B4 798.9평÷639.0평'],
  ['§', '2. 사업비'],
  ['siteCostFactor', '공사비 할증계수(지하·굴토)', '배', '0.000', '용도 기준단가(교수님 가이드) × 계수 = 평당 공사비'],
  ['buildCost', '평당 공사비 직접입력', '만원/평', '#,##0', '비워두면 프리셋×계수 자동 (오피스텔 800 · 오피스 900 · 호텔 1,040)'],
  ['otherRate', '기타사업비율', '%', '0.0%', '설계·감리·대행 15% · 호텔은 FF&E·개업비 포함 20%'],
  ['§', '3. 수입'],
  ['salesRatio', '분양(매각)면적비율', '공사비면적 대비', '0.000', '여의도 연면적 기준 통매각 1.0'],
  ['salePrice', '평당 분양(매각)단가', '만원/평', '#,##0', '여의도 3,600 (하나증권빌딩 3,840 대비 6% 할인)'],
  ['saleSchedule', '분양대금 수령방식', 'LUMP/SPLIT', 'text', 'LUMP=최종월 일괄(교수님) · SPLIT=계약10·중도60·잔금30'],
  ['leaseRatio', '임대면적비율', '용적률면적 대비', '0.000', '이태원 임대 839평(B1 포함) ÷ 639.0평'],
  ['rent', '월 평균 임대료', '만원/평·월', '#,##0.00', '이태원 층별 합계 1.82억/월 ÷ 839평'],
  ['rentGrowth', '임대료 상승률', '%/년', '0.0%', '연 2%'],
  ['vacancy', '공실률', '%', '0.0%', '이태원 평균 14.4% 대비 신축 7%'],
  ['opexRate', '운영비율', '%', '0.0%', 'NOI 산정용 10%'],
  ['gfaPerRoom', '객실당 연면적', '평/실', '0.0', '호텔 대안용'],
  ['adr', 'ADR', '만원', '#,##0.0', '호텔 대안용 (STR 서울 ADR 약 24.7만원)'],
  ['occ', '객실점유율', '%', '0.0%', '호텔 대안용 (2025 서울 79.2%)'],
  ['roomShare', '객실매출 비중', '%', '0.0%', '호텔 대안용'],
  ['noiMargin', 'NOI 마진', '%', '0.0%', '호텔 대안용'],
  ['capRate', 'Exit Cap Rate', '%', '0.00%', '이태원 3.5%(4주차) · 호텔 5%대(KB증권)'],
  ['saleCostRate', '매각비용률', '%', '0.0%', '1.5%'],
  ['stabMonths', '준공 후 안정화기간', '개월', '0', 'LEASE·HOTEL만 적용 (NOI 선형 램프업 후 Exit)'],
  ['§', '4. 토지와 금융'],
  ['landPrice', '현재 검토 토지가격', '억원', '#,##0.0', '여의도 2022 실거래 732억 · 이태원 5회차 공매최저 449.7억'],
  ['acqRate', '토지 취득부대비율', '%', '0.0%', '취득세 등 5%'],
  ['ltv', '차입비율(LTV)', '%', '0.0%', '여의도 70%(3주차) · 이태원 60%(4주차)'],
  ['baseRate', '기준금리', '%', '0.00%', '교수님 기본 3.0%'],
  ['spread', 'Spread', '%p', '0.00%', '여의도 3.5%p→6.5% · 이태원 4.0%p→7.0%'],
  ['scenShift', 'Scenario Shift', '%p', '0.00%', '금리 스트레스 즉시 반영'],
  ['trend', '금리 Trend', '%p/년', '0.00%', '시간에 따른 점진 변화'],
  ['constMonths', '공사기간(준공월)', '개월', '0', '여의도 42(지하7층) · 이태원 30(사전6+공사24)'],
  ['costCurve', '공사비 집행방식', 'EVEN/SCURVE', 'text', 'EVEN=균등(교수님) · SCURVE=공정률 S-Curve'],
  ['targetIRR', '목표 Equity IRR', '%', '0.0%', '3주차 검증 기준 12%'],
  ['§', '5. 리스크 시뮬레이션(몬테카를로)'],
  ['mcPriceSd', '수입단가 표준편차', '%', '0.0%', '정규분포'],
  ['mcCostUp', '공사비 상방 최대', '%', '0.0%', '삼각분포(-5%, 0, +상방)'],
  ['mcRateSd', '금리 충격 표준편차', '%p', '0.00%', '정규분포'],
  ['mcCapSd', 'Cap Rate 충격 표준편차', '%p', '0.00%', 'LEASE·HOTEL만'],
  ['mcDelayMax', '준공 지연 최대', '개월', '0', '삼각분포(0,0,최대)']
];
 
/* ---------- 메뉴 ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('A15+ 의사결정 모델')
    .addItem('① 초기화 (시트 생성)', 'initializeA15Plus')
    .addItem('② 계산 새로고침', 'refreshAll')
    .addSeparator()
    .addItem('Assumption 기본값 복원', 'resetAssumptions')
    .addToUi();
}
 
/* ---------- ① 초기화 ---------- */
function initializeA15Plus() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET.START, SHEET.ASM, SHEET.IDX, SHEET.PJ_YD, SHEET.PJ_IT, SHEET.SENS, SHEET.USE,
   SHEET.RISK, SHEET.DEC, SHEET.LOG].forEach(function (n) { if (!ss.getSheetByName(n)) ss.insertSheet(n); });
  buildStart_();
  resetAssumptions();
  var log = ss.getSheetByName(SHEET.LOG);
  if (log.getLastRow() === 0) {
    log.appendRow(['실행시각', '실행자', '학번', '이름', '부지', '시나리오', '용도', '토지가격(억)',
                   '수입단가', '공사비(만원/평)', 'Project IRR', 'Equity IRR', '최대매입가(억)',
                   '목표IRR 달성확률', '80% 안전매입가(억)', '판정']);
    header_(log.getRange(1, 1, 1, 16));
  }
  refreshAll();
  ss.setActiveSheet(ss.getSheetByName(SHEET.DEC));
}
 
function buildStart_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.START);
  sh.clear();
  var rows = [
    ['A15+ | 여의도 · 이태원 2부지 최종 의사결정 모델', ''],
    ['', ''],
    ['딱 3단계', '① Assumption 노란 셀 입력 → ② 메뉴 [A15+ 의사결정 모델 → ② 계산 새로고침] → ③ Decision 시트에서 판정 확인'],
    ['', ''],
    ['교수님 A15와 같은 점', '월별 CF · 이자 = (기초Debt + 0.5×신규Debt) × 금리/12 · 이자 Equity 부담 · 최종월 일괄상환 · Bisection Goal Seek · 5×5 민감도 · Web App · Log'],
    ['A15+ 확장 ①', '실제 2개 필지(3·4주차 검토 부지)를 같은 엔진으로 비교 → 자본배분 의사결정'],
    ['A15+ 확장 ②', '공사비 = 용도 기준단가(오피스텔 800 · 호텔 1,040=+30%) × 부지 할증계수(지하·굴토)'],
    ['A15+ 확장 ③', 'UseMix: 허용 용도별 최대 매입가 비교 → 최유효이용(HBU) 정량 검증'],
    ['A15+ 확장 ④', '수입 3유형(분양·임대Cap·호텔Cap) · 준공 후 안정화 · S-Curve · 분할분양 · 유입 우선 충당/조기상환'],
    ['A15+ 확장 ⑤', 'Risk_MC: 몬테카를로(시드 고정 재현) → 목표 IRR 달성확률 · 80% 안전 매입가'],
    ['', ''],
    ['입력 규칙', '비율은 소수(60% → 0.60) · 금액 억원 · 단가 만원/평 · 면적 평'],
    ['주의', '교육용 예비검토 모델입니다. 가정값은 검토자 결정값이며 법적 권리·인허가·거래가격을 확정하지 않습니다.']
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange('A1:B1').merge().setBackground(COLOR.navy).setFontColor('white').setFontSize(14).setFontWeight('bold');
  sh.getRange('A3:B3').setBackground(COLOR.green).setFontWeight('bold');
  sh.getRange('A5:A13').setFontWeight('bold');
  sh.getRange('A13:B13').setBackground(COLOR.yellow);
  sh.setColumnWidth(1, 170); sh.setColumnWidth(2, 820);
}
 
/* ---------- Assumption ---------- */
function resetAssumptions() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.ASM);
  sh.clear();
  sh.getRange('A1:E1').merge().setValue('Assumption | 노란 셀만 입력하세요').setBackground(COLOR.navy)
    .setFontColor('white').setFontWeight('bold').setFontSize(13);
  sh.getRange('A2:E2').setValues([['항목', '단위', SITES.YD.name, SITES.IT.name, '근거 · 출처(검토자 결정)']]);
  header_(sh.getRange('A2:E2'));
  var out = [], fmts = [];
  ASM_ROWS.forEach(function (r) {
    if (r[0] === '§') { out.push([r[1], '', '', '', '']); fmts.push('@'); return; }
    var y = SITES.YD.base[r[0]], i = SITES.IT.base[r[0]];
    out.push([r[1], r[2], y == null ? '' : y, i == null ? '' : i, r[4]]);
    fmts.push(r[3] === 'text' ? '@' : r[3]);
  });
  sh.getRange(3, 1, out.length, 5).setValues(out);
  for (var k = 0; k < ASM_ROWS.length; k++) {
    var row = 3 + k;
    if (ASM_ROWS[k][0] === '§') {
      sh.getRange(row, 1, 1, 5).setBackground(COLOR.grey).setFontWeight('bold');
    } else {
      sh.getRange(row, 3, 1, 2).setBackground(COLOR.yellow).setNumberFormat(fmts[k]);
    }
  }
  // 학생 · 프로젝트 정보 (교수님 A15 위치 G4:G8 유지)
  sh.getRange('G3:H3').setValues([['학생·프로젝트 정보', '']]).setFontWeight('bold');
  sh.getRange('G4:H8').setValues([
    ['학번', '12503537'], ['학생명', '정승원'],
    ['프로젝트명', '여의도·이태원 2부지 최종 의사결정'], ['사업유형', 'Office / Retail Development'],
    ['프로젝트 설명', '3·4주차 검토 부지를 A15 엔진으로 재평가하고 자본배분 결정']]);
  sh.getRange('H4').setNumberFormat('@');
  sh.getRange('H4:H8').setBackground(COLOR.yellow);
  sh.setColumnWidth(1, 210); sh.setColumnWidth(2, 120); sh.setColumnWidth(3, 150);
  sh.setColumnWidth(4, 150); sh.setColumnWidth(5, 470); sh.setColumnWidth(7, 110); sh.setColumnWidth(8, 300);
  sh.setFrozenRows(2);
}
 
function readAssumptions_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.ASM);
  var vals = sh.getRange(3, 1, ASM_ROWS.length, 4).getValues();
  var yd = a15Clone(SITES.YD.base), it = a15Clone(SITES.IT.base);
  ASM_ROWS.forEach(function (r, k) {
    if (r[0] === '§') return;
    var vy = vals[k][2], vi = vals[k][3];
    yd[r[0]] = (vy === '' ? null : vy); it[r[0]] = (vi === '' ? null : vi);
  });
  var info = sh.getRange('H4:H8').getValues().map(function (x) { return String(x[0]); });
  return { YD: yd, IT: it, student: { id: info[0], name: info[1], project: info[2] } };
}
 
/* ---------- ② 계산 새로고침 ---------- */
function refreshAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var A = readAssumptions_();
  var res = {};
  ['YD', 'IT'].forEach(function (k) {
    var site = { base: A[k], alternatives: SITES[k].alternatives };
    res[k] = a15Analyze(A[k], 1000);
    res[k].useMix = a15UseMix(site);
  });
  writeIndex_(ss, A, res);
  writeProjection_(ss.getSheetByName(SHEET.PJ_YD), SITES.YD.name, A.YD, res.YD);
  writeProjection_(ss.getSheetByName(SHEET.PJ_IT), SITES.IT.name, A.IT, res.IT);
  writeSensitivity_(ss.getSheetByName(SHEET.SENS), A, res);
  writeUseMix_(ss.getSheetByName(SHEET.USE), A, res);
  writeRisk_(ss.getSheetByName(SHEET.RISK), A, res);
  writeDecision_(ss.getSheetByName(SHEET.DEC), A, res);
  ['YD', 'IT'].forEach(function (k) { appendLog_(A.student, SITES[k].name, '시트 Base', A[k], res[k]); });
  SpreadsheetApp.getActive().toast('계산 완료 — Decision 시트를 확인하세요.', 'A15+', 5);
}
 
function writeIndex_(ss, A, res) {
  var sh = ss.getSheetByName(SHEET.IDX); sh.clear();
  sh.getRange('A1:C1').setValues([['Month', '적용금리 · ' + SITES.YD.name, '적용금리 · ' + SITES.IT.name]]);
  header_(sh.getRange('A1:C1'));
  var n = Math.max(res.YD.base.rows.length, res.IT.base.rows.length), out = [];
  for (var t = 0; t < n; t++) {
    var y = res.YD.base.rows[t], i = res.IT.base.rows[t];
    out.push([t, y ? y.rate : '', i ? i.rate : '']);
  }
  sh.getRange(2, 1, n, 3).setValues(out);
  sh.getRange(2, 2, n, 2).setNumberFormat('0.00%');
  sh.setColumnWidths(1, 3, 190);
}
 
function writeProjection_(sh, name, a, r) {
  sh.clear();
  var b = r.base;
  sh.getRange('A1:J1').merge().setValue('Projection | ' + name + ' · ' + a.use + ' · ' + a.revType)
    .setBackground(COLOR.navy).setFontColor('white').setFontWeight('bold');
  var kpi = [
    ['용적률 연면적(평)', b.scale.farGFA, '공사비 산정면적(평)', b.scale.costGFA, '평당 공사비(만원)', b.unitCost],
    ['총수입(Exit+운영NOI, 억)', b.totalIn, '직접공사비(억)', b.direct, '기타사업비(억)', b.other],
    ['금융비용(억)', b.interest, '사업이익(억)', b.profit, '이익률', b.margin],
    ['Project IRR', b.projIRR, 'Equity IRR', b.eqIRR, '최대 매입가능 토지가격(억)', r.maxLand]
  ];
  sh.getRange(2, 1, 4, 6).setValues(kpi.map(function (row) { return row.map(nz_); }));
  sh.getRange('A2:A5').setFontWeight('bold'); sh.getRange('C2:C5').setFontWeight('bold'); sh.getRange('E2:E5').setFontWeight('bold');
  sh.getRange('B2:B5').setNumberFormat('#,##0.0'); sh.getRange('D2:D5').setNumberFormat('#,##0.0'); sh.getRange('F2:F5').setNumberFormat('#,##0.0');
  sh.getRange('F4').setNumberFormat('0.0%'); sh.getRange('B5').setNumberFormat('0.00%'); sh.getRange('D5').setNumberFormat('0.00%');
  var head = ['Month', '적용금리', '사업비(토지·공사)', '신규 Debt', '이자', '원금상환', '기말 Debt', '유입(분양·NOI·매각)', 'Project CF', 'Equity CF'];
  sh.getRange(7, 1, 1, 10).setValues([head]); header_(sh.getRange(7, 1, 1, 10));
  var out = b.rows.map(function (x) {
    return [x.t, x.rate, x.cost, x.newDebt, x.interest, x.repay, x.debtEnd, x.inflow, x.projCF, x.eqCF];
  });
  var sum = ['합계', '', 0, 0, 0, 0, '', 0, 0, 0];
  out.forEach(function (x) { [2, 3, 4, 5, 7, 8, 9].forEach(function (c) { sum[c] += x[c]; }); });
  out.push(sum);
  sh.getRange(8, 1, out.length, 10).setValues(out);
  sh.getRange(8, 2, out.length, 1).setNumberFormat('0.00%');
  sh.getRange(8, 3, out.length, 8).setNumberFormat('#,##0.00;[Red]-#,##0.00');
  sh.getRange(8 + out.length - 1, 1, 1, 10).setFontWeight('bold').setBackground(COLOR.grey);
  sh.setFrozenRows(7); sh.setColumnWidths(1, 10, 125);
}
 
function writeSensitivity_(sh, A, res) {
  sh.clear();
  var row = 1;
  ['YD', 'IT'].forEach(function (k) {
    var s = res[k].sens, a = A[k];
    var lab = (a.revType === 'SALE') ? '분양(매각)단가' : (a.revType === 'LEASE' ? '임대료' : 'ADR');
    [['① 최대 매입가능 토지가격(억) — 목표 Equity IRR ' + pct_(a.targetIRR), s.maxLand, '#,##0.0'],
     ['② 현재 토지가격 ' + a.landPrice + '억 기준 Equity IRR', s.irr, '0.0%']].forEach(function (blk) {
      sh.getRange(row, 1, 1, 6).merge().setValue(SITES[k].name + ' | ' + blk[0]).setBackground(COLOR.navy)
        .setFontColor('white').setFontWeight('bold');
      sh.getRange(row + 1, 1, 1, 6).setValues([[lab + ' \\ 공사비'].concat(s.steps.map(sgn_))]);
      header_(sh.getRange(row + 1, 1, 1, 6));
      var m = blk[1].map(function (r, i) { return [sgn_(s.steps[i])].concat(r.map(nz_)); });
      sh.getRange(row + 2, 1, 5, 6).setValues(m);
      sh.getRange(row + 2, 2, 5, 5).setNumberFormat(blk[2]);
      sh.getRange(row + 2, 1, 5, 1).setFontWeight('bold').setBackground(COLOR.grey);
      // 목표 미달 경계선 색칠
      for (var i = 0; i < 5; i++) for (var j = 0; j < 5; j++) {
        var v = blk[1][i][j], good = (blk[2] === '0.0%') ? (v != null && v >= a.targetIRR) : (v >= a.landPrice);
        sh.getRange(row + 2 + i, 2 + j).setBackground(good ? COLOR.green : COLOR.red);
      }
      sh.getRange(row + 4, 4).setFontWeight('bold').setBorder(true, true, true, true, false, false);
      row += 9;
    });
  });
  sh.getRange(row, 1).setValue('초록 = 목표 충족(현재가 이상 매입 가능 / 목표 IRR 이상) · 빨강 = 목표 미달 · 굵은 테두리 = Base');
  sh.setColumnWidths(1, 6, 140);
}
 
function writeUseMix_(sh, A, res) {
  sh.clear();
  sh.getRange('A1:G1').merge().setValue('UseMix | 용도 대안별 최대 매입가 — 최유효이용(HBU) 정량 검증')
    .setBackground(COLOR.navy).setFontColor('white').setFontWeight('bold');
  var head = ['부지', '용도 대안', '용적률', '평당 공사비(만원)', '총수입(억)', '현재가 기준 Equity IRR', '최대 매입가(억)'];
  sh.getRange(2, 1, 1, 7).setValues([head]); header_(sh.getRange(2, 1, 1, 7));
  var out = [], best = [];
  ['YD', 'IT'].forEach(function (k) {
    var mx = -1, bi = -1;
    res[k].useMix.forEach(function (u, i) {
      if (u.blocked) out.push([SITES[k].name, u.label, '불가', u.blocked, '', '', '']);
      else {
        out.push([SITES[k].name, u.label, u.far, u.unitCost, u.revenue, nz_(u.eqIRR), u.maxLand]);
        if (u.maxLand > mx) { mx = u.maxLand; bi = out.length - 1; }
      }
    });
    best.push(bi);
  });
  sh.getRange(3, 1, out.length, 7).setValues(out);
  sh.getRange(3, 3, out.length, 1).setNumberFormat('0%');
  sh.getRange(3, 4, out.length, 2).setNumberFormat('#,##0');
  sh.getRange(3, 6, out.length, 1).setNumberFormat('0.0%');
  sh.getRange(3, 7, out.length, 1).setNumberFormat('#,##0.0');
  best.forEach(function (i) { if (i >= 0) sh.getRange(3 + i, 1, 1, 7).setBackground(COLOR.green).setFontWeight('bold'); });
  sh.getRange(4 + out.length, 1).setValue('초록 = 부지별 최대 매입가가 가장 높은 용도(최유효이용). 공사비는 용도 기준단가 × 부지 할증계수로 자동 산정.');
  sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 300); sh.setColumnWidths(3, 5, 150);
}
 
function writeRisk_(sh, A, res) {
  sh.clear(); sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.getRange('A1:F1').merge().setValue('Risk_MC | 몬테카를로 ' + res.YD.mc.n + '회 (시드 고정 · 재현 가능)')
    .setBackground(COLOR.navy).setFontColor('white').setFontWeight('bold');
  var rows = [['지표', SITES.YD.name, SITES.IT.name]];
  var m1 = res.YD.mc, m2 = res.IT.mc;
  rows.push(['목표 Equity IRR 달성확률', m1.probTarget, m2.probTarget]);
  rows.push(['손실(사업이익<0) 확률', m1.probLoss, m2.probLoss]);
  rows.push(['현재가 매입 정당화 확률', m1.probLandOk, m2.probLandOk]);
  rows.push(['Equity IRR P10', m1.irrP10, m2.irrP10]);
  rows.push(['Equity IRR P50', m1.irrP50, m2.irrP50]);
  rows.push(['Equity IRR P90', m1.irrP90, m2.irrP90]);
  rows.push(['최대매입가 중앙값(억)', m1.landP50, m2.landP50]);
  rows.push(['80% 안전 매입가(억)', m1.safeLand80, m2.safeLand80]);
  sh.getRange(3, 1, rows.length, 3).setValues(rows);
  header_(sh.getRange(3, 1, 1, 3));
  sh.getRange(4, 2, 6, 2).setNumberFormat('0.0%');
  sh.getRange(10, 2, 2, 2).setNumberFormat('#,##0.0');
  // 히스토그램 데이터 (Equity IRR 구간별 빈도)
  var bins = [], lo = -0.40, step = 0.05;
  for (var b = 0; b < 14; b++) bins.push([pct_(lo + b * step) + '~', 0, 0]);
  [[m1.irrs, 1], [m2.irrs, 2]].forEach(function (pair) {
    pair[0].forEach(function (v) {
      var idx = Math.max(0, Math.min(13, Math.floor((v - lo) / step))); bins[idx][pair[1]]++;
    });
  });
  sh.getRange(14, 1, 1, 3).setValues([['Equity IRR 구간', SITES.YD.name, SITES.IT.name]]);
  header_(sh.getRange(14, 1, 1, 3));
  sh.getRange(15, 1, bins.length, 3).setValues(bins);
  var chart = sh.newChart().asColumnChart().addRange(sh.getRange(14, 1, bins.length + 1, 3))
    .setPosition(3, 5, 0, 0).setOption('title', 'Equity IRR 분포 (몬테카를로)')
    .setOption('legend', { position: 'bottom' }).setNumHeaders(1).build();
  sh.insertChart(chart);
  var notes = [['분포 가정'], ['수입단가 ~ 정규(0, 표준편차)'], ['공사비 ~ 삼각(-5%, 0, +상방) — 상방 꼬리'],
               ['금리 ~ 정규(0, 표준편차) · Cap ~ 정규(LEASE·HOTEL)'], ['준공지연 ~ 삼각(0, 0, 최대)개월'],
               ['80% 안전 매입가 = 최대매입가 분포의 하위 20% 값']];
  sh.getRange(31, 1, notes.length, 1).setValues(notes);
  sh.setColumnWidth(1, 210); sh.setColumnWidths(2, 2, 160);
}
 
function writeDecision_(sh, A, res) {
  sh.clear();
  sh.getRange('A1:D1').merge().setValue('Decision | 투자심의 요약 (IC Memo) — ' + A.student.id + ' ' + A.student.name)
    .setBackground(COLOR.navy).setFontColor('white').setFontWeight('bold').setFontSize(13);
  var y = res.YD, i = res.IT, ay = A.YD, ai = A.IT;
  var rows = [
    ['항목', SITES.YD.name, SITES.IT.name, '해석'],
    ['판정', y.decision.verdict, i.decision.verdict, 'GO: 목표IRR 충족 & 달성확률 70%↑ · CONDITIONAL: 한쪽 충족 · NO-GO: 둘 다 미달'],
    ['개발용도', ay.use, ai.use, 'UseMix 시트에서 최유효이용 검증'],
    ['현재 검토 토지가격(억)', ay.landPrice, ai.landPrice, '여의도 2022 실거래 · 이태원 5회차 공매 최저가'],
    ['Project IRR', nz_(y.base.projIRR), nz_(i.base.projIRR), '사업 자체 수익률(금융 제외)'],
    ['Equity IRR', nz_(y.base.eqIRR), nz_(i.base.eqIRR), '목표 ' + pct_(ay.targetIRR) + ' 대비'],
    ['레버리지 효과(Equity−Project)', lev_(y.base), lev_(i.base), '양(+)이면 차입이 수익률 확대, 음(−)이면 손실 확대'],
    ['최대 매입가능 토지가격(억)', y.maxLand, i.maxLand, '목표 Equity IRR 기준 Bisection'],
    ['현재가 대비 여유(억)', y.decision.headroom, i.decision.headroom, '양수 = 가격 여유'],
    ['목표 IRR 달성확률', y.mc.probTarget, i.mc.probTarget, '몬테카를로'],
    ['① 협상 상한(억)', y.decision.bidCeiling, i.decision.bidCeiling, 'Base Case 최대 매입가'],
    ['② 목표 제시가(억)', y.decision.bidTarget, i.decision.bidTarget, '80% 확률로 목표 IRR을 지키는 가격'],
    ['최대 자기자본 투입(억)', y.base.peakEquity, i.base.peakEquity, '누적 Equity CF 최저점'],
    ['Equity Multiple', y.base.equityMultiple, i.base.equityMultiple, '회수액 ÷ 투입액']
  ];
  sh.getRange(3, 1, rows.length, 4).setValues(rows);
  header_(sh.getRange(3, 1, 1, 4));
  sh.getRange(3, 1, rows.length, 1).setFontWeight('bold');
  // 행 번호: 4 판정 · 5 용도 · 6 토지가 · 7~9 IRR · 10 최대매입가 · 11 여유 · 12 확률 · 13~15 억원 · 16 배수
  sh.getRange(6, 2, 1, 2).setNumberFormat('#,##0.0');
  sh.getRange(7, 2, 3, 2).setNumberFormat('0.00%');
  sh.getRange(10, 2, 1, 2).setNumberFormat('#,##0.0');
  sh.getRange(11, 2, 1, 2).setNumberFormat('#,##0.0;[Red]-#,##0.0');
  sh.getRange(12, 2, 1, 2).setNumberFormat('0.0%');
  sh.getRange(13, 2, 3, 2).setNumberFormat('#,##0.0');
  sh.getRange(16, 2, 1, 2).setNumberFormat('0.00"x"');
  [['B4', y.decision.verdict], ['C4', i.decision.verdict]].forEach(function (p) {
    var c = p[1] === 'GO' ? COLOR.green : (p[1] === 'NO-GO' ? COLOR.red : COLOR.amber);
    sh.getRange(p[0]).setBackground(c).setFontWeight('bold').setFontSize(12);
  });
  var memo = [
    ['자본배분 결론'],
    [allocation_(A, res)],
    [''],
    ['※ 교육용 예비검토. 가정값은 검토자 결정값이며 Assumption 시트에서 조정 가능합니다.']
  ];
  sh.getRange(18, 1, memo.length, 1).setValues(memo);
  sh.getRange('A18').setFontWeight('bold');
  sh.getRange('A19:D19').merge().setWrap(true).setBackground(COLOR.yellow);
  sh.setRowHeight(19, 90);
  sh.setColumnWidth(1, 230); sh.setColumnWidths(2, 2, 170); sh.setColumnWidth(4, 470);
}
 
function allocation_(A, res) {
  var y = res.YD, i = res.IT;
  var f = function (v) { return Math.round(v * 10) / 10; };
  var s = '여의도: ' + y.decision.verdict + ' — 현재가 ' + A.YD.landPrice + '억 대비 최대 매입가 ' + f(y.maxLand) +
    '억, 80% 안전가 ' + f(y.mc.safeLand80) + '억(목표 IRR 달성확률 ' + Math.round(y.mc.probTarget * 100) + '%). ';
  s += '이태원: ' + i.decision.verdict + ' — 공매 최저가 ' + A.IT.landPrice + '억 대비 최대 매입가 ' + f(i.maxLand) +
    '억(여유 ' + f(i.decision.headroom) + '억). ';
  var pick = (y.decision.headroom >= i.decision.headroom) ? '여의도' : '이태원';
  s += '→ 제한된 자기자본은 ' + pick + '에 우선 배분하고, 다른 부지는 협상가가 최대 매입가 이하로 내려올 때까지 보류합니다.';
  return s;
}
 
function appendLog_(stu, siteName, scen, a, r) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.LOG);
  var who = ''; try { who = Session.getActiveUser().getEmail(); } catch (e) {}
  var price = a.revType === 'SALE' ? a.salePrice : (a.revType === 'LEASE' ? a.rent : a.adr);
  sh.appendRow([new Date(), who, "'" + stu.id, stu.name, siteName, scen, a.use, a.landPrice, price,
                Math.round(r.base.unitCost), nz_(r.base.projIRR), nz_(r.base.eqIRR), Math.round(r.maxLand * 10) / 10,
                r.mc.probTarget, Math.round(r.mc.safeLand80 * 10) / 10, r.decision.verdict]);
}
 
/* ---------- Web App ---------- */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('A15+ 2부지 의사결정').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
 
function getModel() {
  var A = readAssumptions_();
  return { sites: { YD: { name: SITES.YD.name, subtitle: SITES.YD.subtitle, a: A.YD },
                    IT: { name: SITES.IT.name, subtitle: SITES.IT.subtitle, a: A.IT } },
           presets: USE_PRESETS, student: A.student };
}
 
// What-if: Assumption 시트를 훼손하지 않고 계산만 수행
function runWhatIf(siteKey, overrides, scenario, runMC) {
  var A = readAssumptions_();
  var a = a15Clone(A[siteKey]);
  for (var k in overrides) a[k] = overrides[k];
  var base = a15Project(a, {});
  var maxLand = a15MaxLand(a, {});
  var sens = a15Sensitivity(a);
  var mc = runMC ? a15MonteCarlo(a, 1000, a.seed) : null;
  var dec = a15Decision(base, maxLand, mc || { probTarget: 0, safeLand80: 0 }, a);
  var r = { base: base, maxLand: maxLand, mc: mc || { probTarget: null, safeLand80: null }, decision: dec };
  if (runMC) appendLog_(A.student, SITES[siteKey].name, scenario, a, r);
  return {
    a: a, maxLand: maxLand, decision: dec,
    kpi: { projIRR: base.projIRR, eqIRR: base.eqIRR, totalIn: base.totalIn, direct: base.direct,
           other: base.other, interest: base.interest, profit: base.profit, margin: base.margin,
           unitCost: base.unitCost, farGFA: base.scale.farGFA, costGFA: base.scale.costGFA,
           peakEquity: base.peakEquity, em: base.equityMultiple, noi: base.rev.noi || 0,
           rooms: base.rev.rooms || 0, perRoom: base.rev.perRoom || 0 },
    eqCF: base.eqCF, sens: sens,
    mc: mc ? { probTarget: mc.probTarget, probLoss: mc.probLoss, irrP10: mc.irrP10, irrP50: mc.irrP50,
               irrP90: mc.irrP90, safeLand80: mc.safeLand80, irrs: mc.irrs } : null
  };
}
 
/* ---------- 유틸 ---------- */
function header_(rng) { rng.setBackground(COLOR.navy).setFontColor('white').setFontWeight('bold').setHorizontalAlignment('center'); }
function nz_(v) { return (v == null || (typeof v === 'number' && !isFinite(v))) ? 'n/a' : v; }
function pct_(v) { return (Math.round(v * 1000) / 10) + '%'; }
function sgn_(v) { return (v > 0 ? '+' : '') + Math.round(v * 100) + '%'; }
function lev_(b) { return (b.eqIRR == null || b.projIRR == null) ? 'n/a' : b.eqIRR - b.projIRR; }
 
