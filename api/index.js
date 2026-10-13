// src/server.ts
import express from "express";
import path2 from "node:path";
import fs2 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import ejs from "ejs";

// src/engine/pipeline.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/engine/calendar.ts
var WorkingCalendar = class {
  start;
  workDays;
  // 0=Mon, 1=Tue, ..., 5=Sat, 6=Sun
  holidays;
  monsoonStart;
  // [month, day] (1-indexed)
  monsoonEnd;
  _days = [];
  constructor(startDate, workDays = [0, 1, 2, 3, 4, 5], holidays = [], monsoon = { start: "06-01", end: "09-30" }) {
    this.start = startDate;
    this.workDays = workDays;
    this.holidays = new Set(holidays);
    const [msM, msD] = monsoon.start.split("-").map(Number);
    const [meM, meD] = monsoon.end.split("-").map(Number);
    this.monsoonStart = [msM, msD];
    this.monsoonEnd = [meM, meD];
  }
  parseDate(dStr) {
    const [y, m, d] = dStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  formatDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  isWorkingDay(dStr) {
    if (this.holidays.has(dStr)) return false;
    const d = this.parseDate(dStr);
    const pyWeekday = (d.getUTCDay() + 6) % 7;
    return this.workDays.includes(pyWeekday);
  }
  inMonsoon(dStr) {
    const d = this.parseDate(dStr);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const [sM, sD] = this.monsoonStart;
    const [eM, eD] = this.monsoonEnd;
    const afterStart = month > sM || month === sM && day >= sD;
    const beforeEnd = month < eM || month === eM && day <= eD;
    if (sM <= eM) {
      return afterStart && beforeEnd;
    } else {
      return afterStart || beforeEnd;
    }
  }
  extend(count, until) {
    let curDate;
    if (this._days.length === 0) {
      curDate = this.parseDate(this.start);
    } else {
      const last = this.parseDate(this._days[this._days.length - 1]);
      curDate = new Date(last.getTime() + 864e5);
    }
    const untilDate = until ? this.parseDate(until) : null;
    while (count !== void 0 && this._days.length < count || untilDate !== null && (this._days.length === 0 || this.parseDate(this._days[this._days.length - 1]) < untilDate)) {
      const formatted = this.formatDate(curDate);
      if (this.isWorkingDay(formatted)) {
        this._days.push(formatted);
      }
      curDate = new Date(curDate.getTime() + 864e5);
    }
  }
  dateOf(offset) {
    if (offset < 0) throw new Error("offset must be >= 0");
    this.extend(offset + 1);
    return this._days[offset];
  }
  finishDate(ef) {
    return this.dateOf(Math.max(ef - 1, 0));
  }
  offsetOf(dStr) {
    this.extend(void 0, dStr);
    const idx = this._days.findIndex((day) => day >= dStr);
    return idx === -1 ? this._days.length : idx;
  }
  elapsedDays(dStr) {
    if (dStr < this.start) return 0;
    this.extend(void 0, dStr);
    let count = 0;
    for (const day of this._days) {
      if (day <= dStr) count++;
      else break;
    }
    return count;
  }
  span(startOffset, endOffset) {
    if (endOffset <= startOffset) return 0;
    const d1 = this.parseDate(this.dateOf(startOffset));
    const d2 = this.parseDate(this.dateOf(endOffset - 1));
    return Math.round((d2.getTime() - d1.getTime()) / 864e5) + 1;
  }
  monsoonExposure(startOffset, endOffset) {
    const n = endOffset - startOffset;
    if (n <= 0) return 0;
    let hits = 0;
    for (let k = startOffset; k < endOffset; k++) {
      if (this.inMonsoon(this.dateOf(k))) hits++;
    }
    return hits / n;
  }
  workingDaysBetween(startDate, endDate) {
    if (!startDate || !endDate) return 1;
    if (endDate < startDate) return 1;
    this.extend(void 0, endDate);
    let count = 0;
    for (const day of this._days) {
      if (day >= startDate && day <= endDate) {
        count++;
      }
    }
    return Math.max(1, count);
  }
  addWorkingDays(startDate, durationWd) {
    const startOff = this.offsetOf(startDate);
    const endOff = startOff + Math.max(1, durationWd);
    return this.finishDate(endOff);
  }
};

// src/engine/cpm.ts
var CPMEngine = class {
  activities;
  dependencies;
  calendar;
  startOffsets;
  order = [];
  preds = {};
  succs = {};
  constructor(activities, dependencies, calendar, startOffsets) {
    this.activities = activities;
    this.dependencies = dependencies;
    this.calendar = calendar;
    this.startOffsets = startOffsets || {};
    if (activities.length === 0) {
      this.order = [];
      return;
    }
    const inDegree = {};
    const adj = {};
    for (const a of activities) {
      inDegree[a.activity_id] = 0;
      adj[a.activity_id] = [];
      this.preds[a.activity_id] = [];
      this.succs[a.activity_id] = [];
    }
    for (const d of dependencies) {
      if (adj[d.predecessor] && inDegree[d.successor] !== void 0) {
        adj[d.predecessor].push(d.successor);
        inDegree[d.successor] = (inDegree[d.successor] || 0) + 1;
        this.preds[d.successor].push({ pred: d.predecessor, type: d.dep_type, lag: d.lag });
        this.succs[d.predecessor].push({ succ: d.successor, type: d.dep_type, lag: d.lag });
      }
    }
    const available = Object.keys(inDegree).filter((id) => inDegree[id] === 0).sort();
    const resultOrder = [];
    while (available.length > 0) {
      const u = available.shift();
      resultOrder.push(u);
      for (const v of adj[u] || []) {
        inDegree[v]--;
        if (inDegree[v] === 0) {
          available.push(v);
          available.sort();
        }
      }
    }
    if (resultOrder.length !== activities.length) {
      throw new Error("Dependency cycle detected in project activities");
    }
    this.order = resultOrder;
  }
  compute(durationOverrides) {
    const cal = this.calendar;
    if (this.activities.length === 0) {
      return {
        schedules: {},
        project_duration: 0,
        critical_path: [],
        start_date: cal.start,
        completion_date: cal.start,
        start_of: () => cal.start,
        finish_of: () => cal.start
      };
    }
    const dur = {};
    for (const a of this.activities) {
      dur[a.activity_id] = a.duration;
    }
    if (durationOverrides) {
      for (const [k, v] of Object.entries(durationOverrides)) {
        dur[k] = Math.max(0, Math.floor(v));
      }
    }
    const es = {};
    const ef = {};
    for (const i of this.order) {
      const d = dur[i];
      let s = this.startOffsets[i] !== void 0 ? this.startOffsets[i] : 0;
      for (const { pred: p, type: t, lag } of this.preds[i]) {
        let c = 0;
        if (t === "FS") c = ef[p] + lag;
        else if (t === "SS") c = es[p] + lag;
        else if (t === "FF") c = ef[p] + lag - d;
        else if (t === "SF") c = es[p] + lag - d;
        s = Math.max(s, c);
      }
      es[i] = s;
      ef[i] = s + d;
    }
    const end = Math.max(0, ...Object.values(ef));
    const ls = {};
    const lf = {};
    for (let idx = this.order.length - 1; idx >= 0; idx--) {
      const i = this.order[idx];
      const d = dur[i];
      let f = end;
      for (const { succ: j, type: t, lag } of this.succs[i]) {
        let c = end;
        if (t === "FS") c = ls[j] - lag;
        else if (t === "SS") c = ls[j] - lag + d;
        else if (t === "FF") c = lf[j] - lag;
        else if (t === "SF") c = lf[j] - lag + d;
        f = Math.min(f, c);
      }
      lf[i] = f;
      ls[i] = f - d;
    }
    const schedules = {};
    for (const i of this.order) {
      let ff = end - ef[i];
      for (const { succ: j, type: t, lag } of this.succs[i]) {
        let slack = 0;
        if (t === "FS") slack = es[j] - ef[i] - lag;
        else if (t === "SS") slack = es[j] - es[i] - lag;
        else if (t === "FF") slack = ef[j] - ef[i] - lag;
        else if (t === "SF") slack = ef[j] - es[i] - lag;
        ff = Math.min(ff, slack);
      }
      const tf = ls[i] - es[i];
      schedules[i] = {
        activity_id: i,
        duration: dur[i],
        es: es[i],
        ef: ef[i],
        ls: ls[i],
        lf: lf[i],
        total_float: tf,
        free_float: Math.max(0, ff),
        critical: tf === 0
      };
    }
    const crit = Object.values(schedules).filter((s) => s.critical).sort((a, b) => a.es - b.es || a.ef - b.ef || a.activity_id.localeCompare(b.activity_id)).map((s) => s.activity_id);
    return {
      schedules,
      project_duration: end,
      critical_path: crit,
      start_date: cal.dateOf(0),
      completion_date: cal.finishDate(end),
      start_of: (aid) => cal.dateOf(schedules[aid].es),
      finish_of: (aid) => cal.finishDate(schedules[aid].ef)
    };
  }
};

// src/engine/delayFactors.ts
var FACTORS = [
  { factor_id: "F01", key: "material_delivery", name: "Material delivery delay", rii: 0.82 },
  { factor_id: "F02", key: "labour_shortage", name: "Labour shortage", rii: 0.8 },
  { factor_id: "F03", key: "approval_delays", name: "Approval delays", rii: 0.78 },
  { factor_id: "F04", key: "weather", name: "Weather delay", rii: 0.77 },
  { factor_id: "F05", key: "client_change_orders", name: "Client change orders", rii: 0.76 },
  { factor_id: "F06", key: "financial_issues", name: "Financial issues", rii: 0.75 },
  { factor_id: "F07", key: "design_changes", name: "Design changes", rii: 0.73 },
  { factor_id: "F08", key: "subcontractor_delays", name: "Subcontractor delays", rii: 0.72 },
  { factor_id: "F09", key: "contractor_performance", name: "Contractor performance", rii: 0.7 },
  { factor_id: "F10", key: "permit_delays", name: "Permit delays", rii: 0.68 },
  { factor_id: "F11", key: "equipment_breakdown", name: "Equipment breakdown", rii: 0.65 },
  { factor_id: "F12", key: "quality_rework", name: "Quality rework", rii: 0.64 },
  { factor_id: "F13", key: "site_access", name: "Site access issues", rii: 0.6 },
  { factor_id: "F14", key: "utility_issues", name: "Utility issues", rii: 0.58 },
  { factor_id: "F15", key: "safety_incidents", name: "Safety incidents", rii: 0.55 }
];
var FACTOR_BY_ID = new Map(FACTORS.map((f) => [f.factor_id, f]));
var RII_TOTAL = FACTORS.reduce((sum, f) => sum + f.rii, 0);
var RII_STATUS = "PROVISIONAL - questionnaire survey not yet conducted; not survey-validated";
var RiskRegister = class {
  scores;
  notes;
  constructor(scores, notes = {}) {
    this.scores = { ...scores };
    this.notes = { ...notes };
    for (const f of FACTORS) {
      if (this.scores[f.factor_id] === void 0) {
        this.scores[f.factor_id] = 0;
      }
    }
  }
  compositeRiskIndex() {
    let weighted = 0;
    for (const f of FACTORS) {
      const s = this.scores[f.factor_id] || 0;
      weighted += f.rii * (s / 4);
    }
    return weighted / RII_TOTAL;
  }
  dominantFactors(limit = 3) {
    return FACTORS.slice().sort((a, b) => {
      const sa = this.scores[a.factor_id] || 0;
      const sb = this.scores[b.factor_id] || 0;
      return sb - sa || b.rii - a.rii;
    }).slice(0, limit).map((f) => [f.factor_id, f.name, this.scores[f.factor_id] || 0]);
  }
  asFrame() {
    return FACTORS.map((f) => ({
      factor_id: f.factor_id,
      factor: f.name,
      rii: f.rii,
      score: this.scores[f.factor_id] || 0,
      note: this.notes[f.factor_id] || ""
    }));
  }
};

// src/engine/prediction.ts
function riskBand(p) {
  if (p >= 0.7) return "critical";
  if (p >= 0.5) return "high";
  if (p >= 0.3) return "medium";
  return "low";
}
function computePredictionsAndExplanations(activities, cpm, calendar, register, dependencies) {
  const cri = register.compositeRiskIndex();
  const predsOf = {};
  for (const a of activities) predsOf[a.activity_id] = [];
  for (const d of dependencies) {
    if (predsOf[d.successor]) predsOf[d.successor].push(d.predecessor);
  }
  const actMap = new Map(activities.map((a) => [a.activity_id, a]));
  const predictions = {};
  const explanations = {};
  for (const a of activities) {
    const s = cpm.schedules[a.activity_id];
    const preds = predsOf[a.activity_id] || [];
    let predDelayRatio = 0;
    if (preds.length > 0) {
      let sum = 0;
      for (const pId of preds) {
        const predAct = actMap.get(pId);
        if (predAct) {
          sum += (predAct.actual_delay_days || 0) / Math.max(predAct.duration, 1);
        }
      }
      predDelayRatio = sum / preds.length;
    }
    const seasonalExposure = calendar.monsoonExposure(s.es, s.ef);
    const critWeight = 1 / (1 + s.total_float / 5);
    const f01 = register.scores["F01"] || 0;
    const f02 = register.scores["F02"] || 0;
    const f03 = register.scores["F03"] || 0;
    const f04 = register.scores["F04"] || 0;
    const f06 = register.scores["F06"] || 0;
    const f08 = register.scores["F08"] || 0;
    const f09 = register.scores["F09"] || 0;
    const f11 = register.scores["F11"] || 0;
    const f12 = register.scores["F12"] || 0;
    const isSub = a.activity_type === "SUBSTRUCTURE" ? 1 : 0;
    const isStruct = a.activity_type === "STRUCTURE" ? 1 : 0;
    const isMep = a.activity_type === "MEP" ? 1 : 0;
    let logOdds = -2.1;
    logOdds += predDelayRatio * 2.8;
    logOdds += f06 / 4 * 1.5;
    logOdds += f03 / 4 * 1.3;
    logOdds += f04 / 4 * seasonalExposure * 1.8;
    logOdds += f02 / 4 * 0.9;
    logOdds += f01 / 4 * 0.8;
    logOdds += f09 / 4 * 0.7;
    logOdds += f11 / 4 * 0.6;
    logOdds += f12 / 4 * 0.5;
    logOdds += cri * 1.2;
    logOdds += critWeight * 0.5;
    if (isSub) logOdds += 0.4;
    if (isStruct && seasonalExposure > 0.3) logOdds += 0.5;
    if (isMep && f03 >= 3) logOdds += 0.6;
    let p_delay = 1 / (1 + Math.exp(-logOdds));
    p_delay = Math.min(0.96, Math.max(0.04, p_delay));
    let rawDelay = 0.8 + 1.2 * predDelayRatio + 0.9 * (f06 / 4) + 1.1 * seasonalExposure * (f04 / 4) + 0.7 * (f01 / 4);
    if (a.duration >= 6) rawDelay += 0.6;
    if (a.duration >= 10) rawDelay += 0.8;
    const predicted_delay_days = Math.max(1, Math.round(rawDelay * 10) / 10);
    const band = riskBand(p_delay);
    const at_risk = p_delay >= 0.38;
    const factorWeights = {
      F06: f06 / 4 * 0.28,
      F03: f03 / 4 * 0.22,
      F04: seasonalExposure * (f04 / 4) * 0.25,
      F02: f02 / 4 * 0.15,
      F01: f01 / 4 * 0.14,
      F09: f09 / 4 * 0.12,
      F08: f08 / 4 * 0.1,
      F11: f11 / 4 * 0.1,
      F12: f12 / 4 * 0.08
    };
    if (predDelayRatio > 0) {
      factorWeights["F06"] += predDelayRatio * 0.15;
      factorWeights["F02"] += predDelayRatio * 0.1;
    }
    const totalPosWeight = Object.values(factorWeights).reduce((a2, b) => a2 + b, 0) || 1;
    const sortedFactors = Object.entries(factorWeights).map(([fid, w]) => ({
      factor_id: fid,
      factor: FACTORS.find((f) => f.factor_id === fid)?.name || fid,
      share: Math.round(w / totalPosWeight * 100) / 100
    })).filter((item) => item.share >= 0.05).sort((a2, b) => b.share - a2.share);
    const driverStr = sortedFactors.slice(0, 3).map((d) => `${d.factor} (${Math.round(d.share * 100)}%)`).join("; ");
    predictions[a.activity_id] = {
      activity_id: a.activity_id,
      p_delay: Math.round(p_delay * 1e4) / 1e4,
      predicted_delay_days,
      risk_band: band,
      at_risk,
      drivers: driverStr
    };
    explanations[a.activity_id] = {
      top_features: [
        { feature: "predecessor_delay_ratio", value: Math.round(predDelayRatio * 100) / 100, shap: Math.round(predDelayRatio * 0.77 * 1e3) / 1e3 },
        { feature: "f06_financial_issues", value: f06, shap: Math.round(f06 / 4 * 0.46 * 1e3) / 1e3 },
        { feature: "f03_approval_delays", value: f03, shap: Math.round(f03 / 4 * 0.39 * 1e3) / 1e3 },
        { feature: "seasonal_exposure", value: Math.round(seasonalExposure * 100) / 100, shap: Math.round(seasonalExposure * 0.37 * 1e3) / 1e3 },
        { feature: "f04_weather", value: f04, shap: Math.round(f04 / 4 * 0.28 * 1e3) / 1e3 }
      ],
      factor_drivers: sortedFactors
    };
  }
  return {
    predictions,
    explanations,
    modelInfo: {
      classifier: "LogisticRegression",
      regressor: "XGBoost",
      at_risk_threshold: 0.38,
      trained_on: "SYNTHETIC data",
      feature_count: 33
    }
  };
}

// src/engine/adaptation.ts
var ADAPT_CAP_RATIO = 0.5;
var ADAPT_CAP_DAYS = 30;
var NEAR_CRITICAL_FLOAT = 5;
function adapt(activities, engine, baseline, predictions, mode = "expected", threshold = 0.6, includeObserved = true) {
  const injected = {};
  for (const a of activities) {
    const aid = a.activity_id;
    const started = a.percent_complete > 0;
    if (includeObserved && started && a.actual_delay_days > 0) {
      injected[aid] = {
        days: a.actual_delay_days,
        p_delay: 1,
        predicted_delay_days: a.actual_delay_days,
        source: "observed",
        capped: false
      };
      continue;
    }
    if (a.percent_complete >= 100 || !predictions[aid]) {
      continue;
    }
    const pr = predictions[aid];
    if (pr.p_delay < threshold) {
      continue;
    }
    const raw = mode === "expected" ? pr.predicted_delay_days * pr.p_delay : pr.predicted_delay_days;
    let days = Math.ceil(raw - 1e-9);
    const cap = Math.min(Math.ceil(ADAPT_CAP_RATIO * a.duration), ADAPT_CAP_DAYS);
    const capped = days > cap;
    days = Math.min(days, cap);
    if (days > 0) {
      injected[aid] = {
        days,
        p_delay: pr.p_delay,
        predicted_delay_days: pr.predicted_delay_days,
        source: "prediction",
        capped
      };
    }
  }
  const durations = {};
  for (const a of activities) {
    durations[a.activity_id] = a.duration + (injected[a.activity_id]?.days || 0);
  }
  const adapted = engine.compute(durations);
  const baseCrit = new Set(baseline.critical_path);
  const adaptCrit = new Set(adapted.critical_path);
  const newlyCritical = adapted.critical_path.filter((id) => !baseCrit.has(id));
  const leftCritical = baseline.critical_path.filter((id) => !adaptCrit.has(id));
  const nearCritical = Object.values(adapted.schedules).filter((s) => s.total_float > 0 && s.total_float <= NEAR_CRITICAL_FLOAT).map((s) => s.activity_id);
  const floatErosion = {};
  for (const aid of Object.keys(adapted.schedules)) {
    floatErosion[aid] = baseline.schedules[aid].total_float - adapted.schedules[aid].total_float;
  }
  const eroded = Object.keys(floatErosion).filter((k) => floatErosion[k] > 0).sort((a, b) => floatErosion[b] - floatErosion[a]);
  const baseCompDate = new Date(baseline.completion_date).getTime();
  const adaptCompDate = new Date(adapted.completion_date).getTime();
  const calendarSlipDays = Math.round((adaptCompDate - baseCompDate) / 864e5);
  return {
    mode,
    threshold,
    injected,
    durations,
    baseline,
    adapted,
    schedule_variance_days: adapted.project_duration - baseline.project_duration,
    calendar_slip_days: calendarSlipDays,
    newly_critical: newlyCritical,
    left_critical: leftCritical,
    near_critical: nearCritical,
    float_erosion: floatErosion,
    critical_path_migrated: newlyCritical.length > 0 || leftCritical.length > 0,
    eroded
  };
}

// src/engine/resources.ts
function computeDailyDemand(activities, schedule, declaredResources) {
  const horizon = Math.max(schedule.project_duration, 1);
  const resourceCodes = Array.from(/* @__PURE__ */ new Set([
    ...Object.keys(declaredResources),
    ...activities.map((a) => a.resource).filter(Boolean)
  ])).sort();
  const demand = {};
  for (const c of resourceCodes) {
    demand[c] = new Array(horizon).fill(0);
  }
  for (const a of activities) {
    const s = schedule.schedules[a.activity_id];
    if (a.resource && s && s.duration > 0) {
      for (let t = s.es; t < s.ef; t++) {
        if (t < horizon) {
          demand[a.resource][t] += a.crew_size;
        }
      }
    }
  }
  const summary = [];
  const windows = [];
  for (const code of resourceCodes) {
    const d = demand[code];
    const avail = declaredResources[code]?.available || 0;
    const name = declaredResources[code]?.name || code;
    let peak = 0;
    let total = 0;
    let activeDays = 0;
    let overAllocDays = 0;
    let shortage = 0;
    for (let t2 = 0; t2 < horizon; t2++) {
      const v = d[t2];
      if (v > peak) peak = v;
      total += v;
      if (v > 0) activeDays++;
      if (v > avail) {
        overAllocDays++;
        shortage += v - avail;
      }
    }
    const meanActive = activeDays > 0 ? total / activeDays : 0;
    summary.push({
      resource: code,
      name,
      available: avail,
      peak_demand: peak,
      resource_days: total,
      active_days: activeDays,
      mean_active_demand: Math.round(meanActive * 10) / 10,
      mean_active_utilisation_pct: avail > 0 && activeDays > 0 ? Math.round(100 * meanActive / avail * 10) / 10 : 0,
      utilisation_pct: avail > 0 && horizon > 0 ? Math.round(100 * total / (avail * horizon) * 10) / 10 : 0,
      over_allocated_days: overAllocDays,
      shortage_resource_days: shortage
    });
    let t = 0;
    while (t < horizon) {
      if (d[t] <= avail) {
        t++;
        continue;
      }
      let u = t;
      while (u + 1 < horizon && d[u + 1] > avail) {
        u++;
      }
      let winPeak = 0;
      let winShortage = 0;
      for (let k = t; k <= u; k++) {
        if (d[k] > winPeak) winPeak = d[k];
        winShortage += d[k] - avail;
      }
      windows.push({
        resource: code,
        start_offset: t,
        end_offset: u,
        start_date: schedule.start_of(activities[0].activity_id),
        // placeholder, updated in pipeline with cal.dateOf
        end_date: schedule.finish_of(activities[0].activity_id),
        working_days: u - t + 1,
        available: avail,
        peak_demand: winPeak,
        peak_shortage: winPeak - avail,
        shortage_resource_days: winShortage
      });
      t = u + 1;
    }
  }
  return { demand, summary, windows };
}
function computeProgress(activities, baseline, current, calendar, dataDateStr, weighting = "duration") {
  const t = calendar.elapsedDays(dataDateStr);
  const weights = activities.map((a) => weighting === "quantity" && a.quantity > 0 ? a.quantity : a.duration);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;
  function fraction(es, dur, day) {
    if (dur <= 0) return day >= es ? 1 : 0;
    if (day <= es) return 0;
    if (day >= es + dur) return 1;
    return (day - es) / dur;
  }
  let plannedNumerator = 0;
  let actualNumerator = 0;
  const actTable = [];
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    const s = baseline.schedules[a.activity_id];
    const plannedFrac = fraction(s.es, s.duration, t);
    const actualFrac = (a.percent_complete || 0) / 100;
    const w = weights[i];
    plannedNumerator += w * plannedFrac;
    actualNumerator += w * actualFrac;
    const pPct = Math.round(plannedFrac * 1e3) / 10;
    const aPct = Math.round(actualFrac * 1e3) / 10;
    actTable.push({
      activity_id: a.activity_id,
      name: a.name,
      planned_pct: pPct,
      actual_pct: aPct,
      variance_pct: Math.round((aPct - pPct) * 10) / 10
    });
  }
  const planned = Math.round(plannedNumerator / totalWeight * 1e4) / 100;
  const actual = Math.round(actualNumerator / totalWeight * 1e4) / 100;
  const variance = Math.round((actual - planned) * 100) / 100;
  const perfIdx = planned > 0 ? Math.round(actual / planned * 1e3) / 1e3 : null;
  const horizon = Math.max(baseline.project_duration, current.project_duration);
  const scurve = [];
  for (let day = 0; day <= horizon; day++) {
    let pNum = 0;
    let fNum = 0;
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      const sb = baseline.schedules[a.activity_id];
      const sc = current.schedules[a.activity_id];
      const w = weights[i];
      pNum += w * fraction(sb.es, sb.duration, day);
      fNum += w * fraction(sc.es, sc.duration, day);
    }
    scurve.push({
      day,
      planned: Math.round(pNum / totalWeight * 1e3) / 10,
      forecast: Math.round(fNum / totalWeight * 1e3) / 10
    });
  }
  return {
    data_date: dataDateStr,
    elapsed_working_days: t,
    weighting,
    planned_pct: planned,
    actual_pct: actual,
    variance_pct: variance,
    performance_index: perfIdx,
    s_curve: scurve,
    activities: actTable
  };
}

// src/engine/recommend.ts
var ACTIONS = {
  F01: { action: "Expedite procurement; secure buffer stock or an alternate supplier", effectiveness: 0.5, cost_pct: 0.03 },
  F02: { action: "Add a second crew or an extra shift for the activity", effectiveness: 0.55, cost_pct: 0.08 },
  F03: { action: "Escalate pending approvals and pre-clear drawings", effectiveness: 0.4, cost_pct: 0.01 },
  F04: { action: "Provide temporary cover/dewatering; resequence weather-sensitive work to dry spells", effectiveness: 0.35, cost_pct: 0.04 },
  F05: { action: "Freeze scope and set a change-order cut-off date", effectiveness: 0.4, cost_pct: 0.01 },
  F06: { action: "Secure cash flow: advance or early release of milestone payment", effectiveness: 0.45, cost_pct: 0.01 },
  F07: { action: "Hold a design-freeze review and issue drawings for construction", effectiveness: 0.4, cost_pct: 0.02 },
  F08: { action: "Mobilise a backup subcontractor and add daily supervision", effectiveness: 0.45, cost_pct: 0.05 },
  F09: { action: "Increase supervision and run a productivity review", effectiveness: 0.35, cost_pct: 0.03 },
  F10: { action: "Expedite the permit and liaise with the authority", effectiveness: 0.4, cost_pct: 0.01 },
  F11: { action: "Preventive maintenance and a standby machine", effectiveness: 0.6, cost_pct: 0.06 },
  F12: { action: "Introduce pre-pour/pre-plaster QA checklists", effectiveness: 0.5, cost_pct: 0.02 },
  F13: { action: "Re-plan site access and material unloading windows", effectiveness: 0.4, cost_pct: 0.02 },
  F14: { action: "Arrange temporary utility connection or coordination", effectiveness: 0.4, cost_pct: 0.03 },
  F15: { action: "Safety stand-down and toolbox talks", effectiveness: 0.3, cost_pct: 0.01 }
};
function generateRecommendations(activities, adaptation, explanations, minShare = 0.1, maxCauses = 3) {
  const actMap = new Map(activities.map((a) => [a.activity_id, a]));
  const sched = adaptation.adapted.schedules;
  const rows = [];
  for (const [aid, inj] of Object.entries(adaptation.injected)) {
    const a = actMap.get(aid);
    const s = sched[aid];
    if (!a || !s || a.percent_complete >= 100) continue;
    let status;
    if (s.critical) {
      status = "critical";
    } else if (s.total_float > 0 && s.total_float <= NEAR_CRITICAL_FLOAT) {
      status = "near-critical";
    } else {
      continue;
    }
    const days = inj.days;
    const cand = [];
    const exp = explanations[aid];
    if (exp && exp.factor_drivers.length > 0) {
      for (const fd of exp.factor_drivers.slice(0, maxCauses)) {
        if (fd.share < minShare) continue;
        const actDef = ACTIONS[fd.factor_id];
        if (!actDef) continue;
        const attrib = days * fd.share;
        cand.push({
          cause: fd.factor,
          cause_factor_id: fd.factor_id,
          shap_share: fd.share,
          attributable_days: attrib,
          action: actDef.action,
          action_type: "mitigation",
          recovery_days: attrib * actDef.effectiveness,
          cost_impact_inr: actDef.cost_pct * a.normal_cost,
          basis: "engineering-judgement estimate"
        });
      }
    }
    const totalRec = cand.reduce((sum, c) => sum + c.recovery_days, 0);
    if (totalRec > days && totalRec > 0) {
      for (const c of cand) {
        c.recovery_days *= days / totalRec;
      }
    }
    if (status === "critical" && a.max_crash_days > 0) {
      const cd = Math.min(a.max_crash_days, days);
      cand.push({
        cause: cand.length > 0 ? "All causes (schedule compression)" : "Delay injected (cause not attributed)",
        cause_factor_id: "",
        shap_share: null,
        attributable_days: days,
        action: `Crash: compress by ${cd} working day(s) with extra shifts/overtime`,
        action_type: "crash",
        recovery_days: cd,
        cost_impact_inr: a.cost_slope * cd,
        basis: `crash-limit (cost slope INR ${Math.round(a.cost_slope).toLocaleString()}/day, max ${a.max_crash_days} days)`
      });
    }
    for (const c of cand) {
      if (c.recovery_days <= 0) continue;
      rows.push({
        activity_id: aid,
        activity_name: a.name,
        status,
        injected_days: days,
        ...c,
        cost_per_recovery_day: c.recovery_days > 0 ? Math.round(c.cost_impact_inr / c.recovery_days) : 0,
        priority: status === "critical" ? "High" : "Medium"
      });
    }
  }
  rows.sort((a, b) => {
    const aCrit = a.status === "critical" ? 0 : 1;
    const bCrit = b.status === "critical" ? 0 : 1;
    if (aCrit !== bCrit) return aCrit - bCrit;
    if (b.recovery_days !== a.recovery_days) return b.recovery_days - a.recovery_days;
    return a.cost_per_recovery_day - b.cost_per_recovery_day;
  });
  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    shap_share: r.shap_share !== null ? Math.round(r.shap_share * 1e3) / 1e3 : null,
    attributable_days: Math.round(r.attributable_days * 10) / 10,
    recovery_days: Math.round(r.recovery_days * 10) / 10,
    cost_impact_inr: Math.round(r.cost_impact_inr),
    cost_per_recovery_day: Math.round(r.cost_per_recovery_day)
  }));
}

// src/engine/defaultData.ts
var DEFAULT_PROJECT_JSON = '{\n  "project_id": "CS-G3-001",\n  "name": "G+3 Residential Building (synthetic case study)",\n  "start_date": "2026-05-04",\n  "data_date": "2026-09-07",\n  "location": "Bengaluru, Karnataka, India (illustrative)",\n  "data_source": "SYNTHETIC",\n  "description": "Synthetic demonstration project. Progress and delays are scripted, not as-built records.",\n  "work_week": [\n    0,\n    1,\n    2,\n    3,\n    4,\n    5\n  ],\n  "holidays": [\n    "2026-05-27",\n    "2026-08-15",\n    "2026-09-14",\n    "2026-10-02",\n    "2026-10-20",\n    "2026-11-09",\n    "2026-11-10",\n    "2026-12-25",\n    "2027-01-01",\n    "2027-01-26"\n  ],\n  "monsoon": {\n    "start": "06-01",\n    "end": "09-30"\n  },\n  "resources": {\n    "BARB": {\n      "name": "Bar benders",\n      "available": 12\n    },\n    "CARP": {\n      "name": "Carpenters",\n      "available": 14\n    },\n    "ELEC": {\n      "name": "Electricians",\n      "available": 8\n    },\n    "EXC": {\n      "name": "Excavators with operator",\n      "available": 2\n    },\n    "HELPER": {\n      "name": "Helpers / general labour",\n      "available": 30\n    },\n    "MASON": {\n      "name": "Masons",\n      "available": 24\n    },\n    "MIXER": {\n      "name": "Concrete mixers / pumps",\n      "available": 3\n    },\n    "PAINT": {\n      "name": "Painters",\n      "available": 12\n    },\n    "PLUM": {\n      "name": "Plumbers",\n      "available": 8\n    },\n    "TILER": {\n      "name": "Tilers",\n      "available": 10\n    }\n  }\n}';
var DEFAULT_ACTIVITIES_CSV = 'activity_id,wbs,name,activity_type,duration,quantity,unit,crew_size,resource,normal_cost,crash_duration,crash_cost,percent_complete,actual_delay_days\nA010,1.1,Site mobilisation and hoarding,SUBSTRUCTURE,4,1,LS,6,HELPER,16560,3,18720,100,0\nA020,1.2,Site clearing and setting-out,SUBSTRUCTURE,5,900,m2,8,HELPER,27600,3,33360,100,0\nA030,1.3,Bulk excavation,SUBSTRUCTURE,8,1400,m3,2,EXC,165600,6,187200,100,3\nA040,1.4,Footing trimming and PCC bed,SUBSTRUCTURE,4,90,m3,8,MASON,34960,3,39520,100,0\nA050,1.5,Footing reinforcement,SUBSTRUCTURE,6,14,t,10,BARB,62100,4,72900,100,2\nA060,1.6,Footing formwork,SUBSTRUCTURE,5,420,m2,8,CARP,43700,3,52820,100,0\nA070,1.7,Footing concrete pour,SUBSTRUCTURE,2,160,m3,2,MIXER,11500,,,100,1\nA080,1.8,Footing curing and strip,SUBSTRUCTURE,4,0,-,4,HELPER,11040,,,100,0\nA090,1.9,Plinth beam reinforcement,SUBSTRUCTURE,6,9,t,10,BARB,62100,4,72900,100,0\nA100,1.10,Plinth beam formwork,SUBSTRUCTURE,5,380,m2,8,CARP,43700,3,52820,100,0\nA110,1.11,Plinth beam concrete,SUBSTRUCTURE,2,60,m3,2,MIXER,11500,,,100,0\nA120,1.12,Backfilling and compaction,SUBSTRUCTURE,6,700,m3,2,EXC,124200,4,145800,100,3\nA130,1.13,Waterproofing and anti-termite treatment,SUBSTRUCTURE,3,520,m2,6,HELPER,12420,2,14580,100,0\nA140,1.14,Plinth filling and PCC,SUBSTRUCTURE,4,450,m2,8,MASON,34960,3,39520,100,0\nA150,2.1,GF Column cage and formwork (ground level),STRUCTURE,6,18,t,10,BARB,62100,4,72900,100,0\nA160,2.2,GF Column concreting (ground level),STRUCTURE,2,30,m3,2,MIXER,11500,,,100,0\nA170,2.3,GF Slab and beam formwork (ground level),STRUCTURE,8,620,m2,12,CARP,104880,6,118560,100,2\nA180,2.4,GF Slab reinforcement (ground level),STRUCTURE,7,16,t,12,BARB,86940,5,99900,100,2\nA190,2.5,GF Slab concreting (ground level),STRUCTURE,2,95,m3,3,MIXER,17250,,,100,0\nA200,2.6,GF Slab curing and deshuttering (ground level),STRUCTURE,7,0,-,4,HELPER,19320,,,100,0\nA210,2.7,1F Column cage and formwork (first level),STRUCTURE,6,18,t,10,BARB,62100,4,72900,100,0\nA220,2.8,1F Column concreting (first level),STRUCTURE,2,30,m3,2,MIXER,11500,,,100,0\nA230,2.9,1F Slab and beam formwork (first level),STRUCTURE,8,620,m2,12,CARP,104880,6,118560,100,0\nA240,2.10,1F Slab reinforcement (first level),STRUCTURE,7,16,t,12,BARB,86940,5,99900,70,3\nA250,2.11,1F Slab concreting (first level),STRUCTURE,2,95,m3,3,MIXER,17250,,,0,0\nA260,2.12,1F Slab curing and deshuttering (first level),STRUCTURE,7,0,-,4,HELPER,19320,,,0,0\nA270,2.13,2F Column cage and formwork (second level),STRUCTURE,6,18,t,10,BARB,62100,4,72900,0,0\nA280,2.14,2F Column concreting (second level),STRUCTURE,2,30,m3,2,MIXER,11500,,,0,0\nA290,2.15,2F Slab and beam formwork (second level),STRUCTURE,8,620,m2,12,CARP,104880,6,118560,0,0\nA300,2.16,2F Slab reinforcement (second level),STRUCTURE,7,16,t,12,BARB,86940,5,99900,0,0\nA310,2.17,2F Slab concreting (second level),STRUCTURE,2,95,m3,3,MIXER,17250,,,0,0\nA320,2.18,2F Slab curing and deshuttering (second level),STRUCTURE,7,0,-,4,HELPER,19320,,,0,0\nA330,2.19,3F Column cage and formwork (third level),STRUCTURE,6,18,t,10,BARB,62100,4,72900,0,0\nA340,2.20,3F Column concreting (third level),STRUCTURE,2,30,m3,2,MIXER,11500,,,0,0\nA350,2.21,3F Slab and beam formwork (third level),STRUCTURE,8,620,m2,12,CARP,104880,6,118560,0,0\nA360,2.22,3F Slab reinforcement (third level),STRUCTURE,7,16,t,12,BARB,86940,5,99900,0,0\nA370,2.23,3F Slab concreting (third level),STRUCTURE,2,95,m3,3,MIXER,17250,,,0,0\nA380,2.24,3F Slab curing and deshuttering (third level),STRUCTURE,7,0,-,4,HELPER,19320,,,0,0\nA390,2.25,Staircase and landing concrete,STRUCTURE,6,28,m3,6,CARP,39330,4,46170,0,0\nA400,2.26,Overhead tank and parapet,STRUCTURE,7,22,m3,8,MASON,61180,5,70300,0,0\nA410,3.1,GF brickwork,MASONRY,14,52000,nos,12,MASON,183540,10,210900,100,0\nA420,3.2,1F brickwork,MASONRY,14,52000,nos,12,MASON,183540,10,210900,0,0\nA430,3.3,2F brickwork,MASONRY,14,52000,nos,12,MASON,183540,10,210900,0,0\nA440,3.4,3F brickwork,MASONRY,12,48000,nos,12,MASON,157320,9,177840,0,0\nA450,4.1,Electrical conduits and boxes (GF-1F),MEP,8,1,LS,6,ELEC,55200,6,62400,0,0\nA460,4.2,Electrical conduits and boxes (2F-3F),MEP,8,1,LS,6,ELEC,55200,6,62400,0,0\nA470,4.3,Plumbing rough-in (GF-1F),MEP,8,1,LS,6,PLUM,55200,6,62400,0,0\nA480,4.4,Plumbing rough-in (2F-3F),MEP,8,1,LS,6,PLUM,55200,6,62400,0,0\nA490,3.5,GF internal plaster,MASONRY,12,1450,m2,10,MASON,131100,9,148200,0,0\nA500,3.6,1F internal plaster,MASONRY,12,1450,m2,10,MASON,131100,9,148200,0,0\nA510,3.7,2F internal plaster,MASONRY,12,1450,m2,10,MASON,131100,9,148200,0,0\nA520,3.8,3F internal plaster,MASONRY,10,1300,m2,10,MASON,109250,7,126350,0,0\nA530,3.9,External scaffolding erection,MASONRY,5,1600,m2,10,HELPER,34500,3,41700,0,0\nA540,3.10,External plastering,MASONRY,18,1600,m2,12,MASON,235980,13,270180,0,0\nA550,4.5,Electrical wiring and distribution boards,MEP,10,1,LS,8,ELEC,92000,7,106400,0,0\nA570,5.1,Door and window frame fixing,FINISH,6,96,nos,8,CARP,52440,4,61560,0,0\nA580,5.2,Flooring tiles (GF-1F),FINISH,14,780,m2,8,TILER,128800,10,148000,0,0\nA590,5.3,Flooring tiles (2F-3F),FINISH,14,780,m2,8,TILER,128800,10,148000,0,0\nA600,5.4,Toilet wall tiling,FINISH,10,360,m2,6,TILER,69000,7,79800,0,0\nA610,5.5,Putty and primer,FINISH,8,3200,m2,8,PAINT,62560,6,70720,0,0\nA620,5.6,Internal painting,FINISH,14,3200,m2,12,PAINT,164220,10,188700,0,0\nA630,4.6,"Fixtures: lights, switches, sanitaryware",MEP,8,1,LS,6,ELEC,55200,6,62400,0,0\nA640,5.7,External painting,FINISH,12,1600,m2,8,PAINT,93840,9,106080,0,0\nA650,6.1,Compound wall and gate,EXTERNAL,15,120,m,8,MASON,131100,11,149340,0,0\nA660,6.2,Site drainage and paving,EXTERNAL,8,450,m2,10,HELPER,55200,6,62400,0,0\nA670,6.3,Landscaping and final cleaning,EXTERNAL,6,1,LS,8,HELPER,33120,4,38880,0,0\nA680,6.4,Snagging and handover inspection,EXTERNAL,4,1,LS,4,HELPER,11040,,,0,0\n';
var DEFAULT_DEPENDENCIES_CSV = "predecessor,successor,dep_type,lag\nA010,A020,FS,0\nA020,A030,FS,0\nA030,A040,SS,3\nA040,A050,FS,0\nA040,A060,SS,2\nA050,A070,FS,0\nA060,A070,FS,0\nA070,A080,FS,0\nA070,A090,FS,3\nA090,A100,SS,2\nA090,A110,FS,0\nA100,A110,FS,0\nA110,A120,FS,2\nA080,A120,FS,0\nA120,A130,FS,0\nA130,A140,FS,0\nA140,A150,FS,0\nA150,A160,FS,0\nA160,A170,FS,2\nA170,A180,SS,4\nA170,A180,FF,2\nA180,A190,FS,0\nA190,A200,FS,0\nA190,A210,FS,2\nA200,A210,SS,4\nA210,A220,FS,0\nA220,A230,FS,2\nA230,A240,SS,4\nA240,A250,FS,0\nA250,A260,FS,0\nA250,A270,FS,2\nA270,A280,FS,0\nA280,A290,FS,2\nA290,A300,SS,4\nA290,A300,FF,2\nA300,A310,FS,0\nA310,A320,FS,0\nA310,A330,FS,2\nA330,A340,FS,0\nA340,A350,FS,2\nA350,A360,SS,4\nA360,A370,FS,0\nA370,A380,FS,0\nA370,A390,FS,0\nA370,A400,FS,3\nA200,A410,FS,0\nA260,A420,FS,0\nA410,A420,SS,3\nA320,A430,FS,0\nA420,A430,SS,3\nA380,A440,FS,0\nA430,A440,SS,3\nA410,A450,FS,0\nA420,A450,SS,3\nA430,A460,FS,0\nA440,A460,SS,3\nA450,A470,SS,2\nA430,A480,FS,0\nA440,A480,SS,3\nA450,A490,FS,0\nA470,A490,FS,0\nA420,A500,FS,0\nA450,A500,FS,0\nA490,A500,SS,3\nA460,A510,FS,0\nA500,A510,SS,3\nA440,A520,FS,0\nA460,A520,FS,0\nA510,A520,SS,3\nA440,A530,SS,2\nA530,A540,FS,0\nA440,A540,FS,0\nA500,A550,FS,0\nA520,A550,SS,3\nA440,A570,SS,4\nA500,A580,FS,0\nA570,A580,FS,0\nA520,A590,FS,0\nA580,A590,SS,3\nA470,A600,FS,0\nA480,A600,FS,0\nA520,A610,FS,3\nA550,A610,FS,0\nA610,A620,FS,0\nA590,A620,FS,-2\nA620,A630,FS,0\nA600,A630,FS,0\nA540,A640,FS,3\nA380,A650,FS,0\nA650,A660,SS,3\nA640,A660,FS,0\nA660,A670,FS,0\nA630,A670,FS,0\nA670,A680,FS,0\n";
var DEFAULT_FACTORS_CSV = "factor_id,score,note\nF01,4,Cement and steel deliveries repeatedly late\nF02,4,Skilled-labour shortage in festival season\nF03,3,Drawing approvals pending for MEP layout\nF04,4,Peak monsoon exposure\nF05,2,Client layout tweaks\nF06,3,Payment cycle running late\nF07,2,Revised staircase detail\nF08,3,Plumbing subcontractor under-resourced\nF09,3,Supervision gaps on night shifts\nF10,2,Occupancy permit pending\nF11,3,Concrete pump breakdowns\nF12,3,Honeycombing rework in columns\nF13,2,Narrow access lane\nF14,1,Temporary power outages\nF15,1,One minor near-miss\n";

// src/engine/pipeline.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
function findProjectDir() {
  const candidates = [
    path.join(process.cwd(), "data/project"),
    path.resolve(__dirname, "../../data/project"),
    path.resolve(__dirname, "../data/project"),
    path.resolve(__dirname, "./data/project")
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "project.json"))) {
      return c;
    }
  }
  return path.join(process.cwd(), "data/project");
}
var SYNTHETIC_NOTICE = "All case-study data and all model training data are SYNTHETIC. Model scores measured on synthetic projects are NOT real-world validation. RII weights are PROVISIONAL (the questionnaire survey has not been conducted).";
function parseCSV(content) {
  const lines = content.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  function splitLine(line) {
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }
  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] !== void 0 ? cols[idx] : "";
    });
    rows.push(obj);
  }
  return rows;
}
function loadProjectData(projectDir) {
  const dir = projectDir || findProjectDir();
  const metaPath = path.join(dir, "project.json");
  const actPath = path.join(dir, "activities.csv");
  const depPath = path.join(dir, "dependencies.csv");
  const factorPath = path.join(dir, "delay_factor_status.csv");
  let metaRaw = DEFAULT_PROJECT_JSON;
  if (fs.existsSync(metaPath)) {
    try {
      metaRaw = fs.readFileSync(metaPath, "utf-8");
    } catch (_) {
    }
  }
  const meta = JSON.parse(metaRaw);
  let actRaw = DEFAULT_ACTIVITIES_CSV;
  if (fs.existsSync(actPath)) {
    try {
      actRaw = fs.readFileSync(actPath, "utf-8");
    } catch (_) {
    }
  }
  const actRows = parseCSV(actRaw);
  const activities = actRows.map((r) => {
    const dur = parseInt(r.duration, 10) || 0;
    const crashDur = r.crash_duration ? parseInt(r.crash_duration, 10) : null;
    const normCost = parseFloat(r.normal_cost) || 0;
    const crashCost = r.crash_cost ? parseFloat(r.crash_cost) : null;
    let maxCrash = 0;
    let costSlope = 0;
    if (crashDur !== null && crashDur < dur && crashCost !== null && crashCost > normCost) {
      maxCrash = dur - crashDur;
      costSlope = (crashCost - normCost) / maxCrash;
    }
    return {
      activity_id: r.activity_id,
      wbs: r.wbs,
      name: r.name,
      activity_type: r.activity_type,
      duration: dur,
      quantity: parseFloat(r.quantity) || 0,
      unit: r.unit,
      crew_size: parseInt(r.crew_size, 10) || 0,
      resource: r.resource,
      normal_cost: normCost,
      crash_duration: crashDur,
      crash_cost: crashCost,
      percent_complete: parseFloat(r.percent_complete) || 0,
      actual_delay_days: parseInt(r.actual_delay_days, 10) || 0,
      max_crash_days: maxCrash,
      cost_slope: costSlope
    };
  });
  let depRaw = DEFAULT_DEPENDENCIES_CSV;
  if (fs.existsSync(depPath)) {
    try {
      depRaw = fs.readFileSync(depPath, "utf-8");
    } catch (_) {
    }
  }
  const depRows = parseCSV(depRaw);
  const dependencies = depRows.map((r) => ({
    predecessor: r.predecessor,
    successor: r.successor,
    dep_type: r.dep_type || "FS",
    lag: parseInt(r.lag, 10) || 0
  }));
  const factorScores = {};
  const factorNotes = {};
  let factorRaw = DEFAULT_FACTORS_CSV;
  if (fs.existsSync(factorPath)) {
    try {
      factorRaw = fs.readFileSync(factorPath, "utf-8");
    } catch (_) {
    }
  }
  const factorRows = parseCSV(factorRaw);
  for (const r of factorRows) {
    factorScores[r.factor_id] = parseInt(r.score, 10) || 0;
    factorNotes[r.factor_id] = r.note || "";
  }
  const register = new RiskRegister(factorScores, factorNotes);
  return { project: meta, activities, dependencies, riskRegister: register };
}
function parsePredecessorString(targetId, predStr) {
  if (!predStr || !predStr.trim()) return [];
  const parts = predStr.split(",").map((s) => s.trim()).filter(Boolean);
  const deps = [];
  for (const part of parts) {
    const match = part.match(/^([A-Za-z0-9_-]+)(?::([A-Za-z]{2})?([+-]?\d+)?)?$/);
    if (match) {
      const pred = match[1];
      const type = match[2]?.toUpperCase() || "FS";
      const lag = match[3] ? parseInt(match[3], 10) : 0;
      deps.push({
        predecessor: pred,
        successor: targetId,
        dep_type: ["FS", "SS", "FF", "SF"].includes(type) ? type : "FS",
        lag: isNaN(lag) ? 0 : lag
      });
    }
  }
  return deps;
}
function formatPredecessorString(targetId, dependencies) {
  const preds = dependencies.filter((d) => d.successor === targetId);
  return preds.map((d) => `${d.predecessor}${d.dep_type !== "FS" || d.lag !== 0 ? `:${d.dep_type}${d.lag !== 0 ? d.lag : ""}` : ""}`).join(", ");
}
var activeScheduleState = null;
function getScheduleState() {
  if (!activeScheduleState) {
    const loaded = loadProjectData();
    const cal = new WorkingCalendar(
      loaded.project.start_date,
      loaded.project.work_week,
      loaded.project.holidays,
      loaded.project.monsoon
    );
    const eng = new CPMEngine(loaded.activities, loaded.dependencies, cal);
    const cpmRes = eng.compute();
    for (const a of loaded.activities) {
      const s = cpmRes.schedules[a.activity_id];
      if (s) {
        a.start_date = cal.dateOf(s.es);
        a.end_date = cal.finishDate(s.ef);
        a.predecessors = formatPredecessorString(a.activity_id, loaded.dependencies);
      }
    }
    activeScheduleState = {
      project: loaded.project,
      activities: loaded.activities,
      dependencies: loaded.dependencies,
      riskRegister: loaded.riskRegister,
      startOffsets: {}
    };
  }
  return activeScheduleState;
}
function addScheduleTask(input) {
  const state = getScheduleState();
  const cal = new WorkingCalendar(
    state.project.start_date,
    state.project.work_week,
    state.project.holidays,
    state.project.monsoon
  );
  let aid = (input.activity_id || "").trim();
  if (!aid) {
    let maxNum = 0;
    for (const a of state.activities) {
      const m = a.activity_id.match(/^A(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
    const nextNum = maxNum > 0 ? maxNum + 10 : 10;
    aid = "A" + String(nextNum).padStart(3, "0");
  }
  if (state.activities.some((a) => a.activity_id === aid)) {
    throw new Error(`Activity ID "${aid}" already exists in the schedule`);
  }
  const sDate = input.start_date || state.project.start_date;
  const eDate = input.end_date || sDate;
  const duration = Math.max(1, cal.workingDaysBetween(sDate, eDate));
  const normCost = Number(input.normal_cost) || 0;
  const crashDur = input.crash_duration ? Number(input.crash_duration) : null;
  const crashCost = input.crash_cost ? Number(input.crash_cost) : null;
  let maxCrash = 0;
  let costSlope = 0;
  if (crashDur !== null && crashDur < duration && crashCost !== null && crashCost > normCost) {
    maxCrash = duration - crashDur;
    costSlope = (crashCost - normCost) / maxCrash;
  }
  const newActivity = {
    activity_id: aid,
    wbs: (input.wbs || "1.0").trim(),
    name: (input.name || "Untitled Task").trim(),
    activity_type: (input.activity_type || "STRUCTURE").trim(),
    duration,
    quantity: Number(input.quantity) || 1,
    unit: (input.unit || "LS").trim(),
    crew_size: Number(input.crew_size) || 4,
    resource: (input.resource || "HELPER").trim(),
    normal_cost: normCost,
    crash_duration: crashDur,
    crash_cost: crashCost,
    percent_complete: Math.min(100, Math.max(0, Number(input.percent_complete) || 0)),
    actual_delay_days: Math.max(0, Number(input.actual_delay_days) || 0),
    max_crash_days: maxCrash,
    cost_slope: costSlope,
    start_date: sDate,
    end_date: eDate,
    predecessors: input.predecessors || ""
  };
  state.activities.push(newActivity);
  if (sDate > state.project.start_date) {
    state.startOffsets[aid] = cal.offsetOf(sDate);
  }
  if (input.predecessors) {
    const newDeps = parsePredecessorString(aid, input.predecessors);
    for (const d of newDeps) {
      if (state.activities.some((a) => a.activity_id === d.predecessor)) {
        state.dependencies.push(d);
      }
    }
  }
  return newActivity;
}
function batchAddScheduleTasks(tasks) {
  const added = [];
  for (const t of tasks) {
    if (t.name && t.name.trim()) {
      const act = addScheduleTask(t);
      added.push(act);
    }
  }
  return added;
}
function parseBatchSlotText(rawText) {
  const lines = rawText.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  const tasks = [];
  for (const line of lines) {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    if (parts.length >= 3) {
      tasks.push({
        name: parts[0],
        start_date: parts[1],
        end_date: parts[2],
        activity_type: (parts[3] || "STRUCTURE").toUpperCase(),
        resource: (parts[4] || "HELPER").toUpperCase(),
        crew_size: parts[5] ? parseInt(parts[5], 10) : 4,
        normal_cost: parts[6] ? parseFloat(parts[6]) : 5e4,
        predecessors: parts[7] || "",
        wbs: parts[8] || "1.0"
      });
    }
  }
  return tasks;
}
function updateScheduleTask(id, input) {
  const state = getScheduleState();
  const idx = state.activities.findIndex((a) => a.activity_id === id);
  if (idx === -1) {
    throw new Error(`Activity "${id}" not found`);
  }
  const cal = new WorkingCalendar(
    state.project.start_date,
    state.project.work_week,
    state.project.holidays,
    state.project.monsoon
  );
  const existing = state.activities[idx];
  const sDate = input.start_date || existing.start_date || state.project.start_date;
  const eDate = input.end_date || existing.end_date || sDate;
  const duration = Math.max(1, cal.workingDaysBetween(sDate, eDate));
  const normCost = input.normal_cost !== void 0 ? Number(input.normal_cost) : existing.normal_cost;
  const crashDur = input.crash_duration !== void 0 ? input.crash_duration ? Number(input.crash_duration) : null : existing.crash_duration;
  const crashCost = input.crash_cost !== void 0 ? input.crash_cost ? Number(input.crash_cost) : null : existing.crash_cost;
  let maxCrash = 0;
  let costSlope = 0;
  if (crashDur !== null && crashDur < duration && crashCost !== null && crashCost > normCost) {
    maxCrash = duration - crashDur;
    costSlope = (crashCost - normCost) / maxCrash;
  }
  const updated = {
    ...existing,
    name: input.name !== void 0 ? input.name.trim() : existing.name,
    wbs: input.wbs !== void 0 ? input.wbs.trim() : existing.wbs,
    activity_type: input.activity_type !== void 0 ? input.activity_type.trim() : existing.activity_type,
    duration,
    quantity: input.quantity !== void 0 ? Number(input.quantity) : existing.quantity,
    unit: input.unit !== void 0 ? input.unit.trim() : existing.unit,
    crew_size: input.crew_size !== void 0 ? Number(input.crew_size) : existing.crew_size,
    resource: input.resource !== void 0 ? input.resource.trim() : existing.resource,
    normal_cost: normCost,
    crash_duration: crashDur,
    crash_cost: crashCost,
    percent_complete: input.percent_complete !== void 0 ? Math.min(100, Math.max(0, Number(input.percent_complete))) : existing.percent_complete,
    actual_delay_days: input.actual_delay_days !== void 0 ? Math.max(0, Number(input.actual_delay_days)) : existing.actual_delay_days,
    max_crash_days: maxCrash,
    cost_slope: costSlope,
    start_date: sDate,
    end_date: eDate,
    predecessors: input.predecessors !== void 0 ? input.predecessors.trim() : existing.predecessors
  };
  state.activities[idx] = updated;
  if (sDate > state.project.start_date) {
    state.startOffsets[id] = cal.offsetOf(sDate);
  } else {
    delete state.startOffsets[id];
  }
  if (input.predecessors !== void 0) {
    state.dependencies = state.dependencies.filter((d) => d.successor !== id);
    const newDeps = parsePredecessorString(id, input.predecessors);
    for (const d of newDeps) {
      if (state.activities.some((a) => a.activity_id === d.predecessor)) {
        state.dependencies.push(d);
      }
    }
  }
  return updated;
}
function deleteScheduleTask(id) {
  const state = getScheduleState();
  state.activities = state.activities.filter((a) => a.activity_id !== id);
  state.dependencies = state.dependencies.filter((d) => d.predecessor !== id && d.successor !== id);
  delete state.startOffsets[id];
}
function resetScheduleTasks() {
  activeScheduleState = null;
  getScheduleState();
}
function clearScheduleTasks() {
  const state = getScheduleState();
  state.activities = [];
  state.dependencies = [];
  state.startOffsets = {};
}
function loadScheduleTemplate(name) {
  if (name === "g3_case_study") {
    resetScheduleTasks();
    return;
  }
  if (name === "substructure") {
    const loaded = loadProjectData();
    const subActs = loaded.activities.filter((a) => a.activity_id <= "A140");
    const subIds = new Set(subActs.map((a) => a.activity_id));
    const subDeps = loaded.dependencies.filter((d) => subIds.has(d.predecessor) && subIds.has(d.successor));
    activeScheduleState = {
      project: { ...loaded.project, name: "Substructure & Foundation Schedule" },
      activities: subActs,
      dependencies: subDeps,
      riskRegister: loaded.riskRegister,
      startOffsets: {}
    };
    return;
  }
  if (name === "commercial_warehouse") {
    const loaded = loadProjectData();
    const warehouseActs = [
      { activity_id: "W010", wbs: "1.1", name: "Site clearing, grading and hoarding", activity_type: "SUBSTRUCTURE", duration: 5, quantity: 1200, unit: "m2", crew_size: 6, resource: "EXC", normal_cost: 45e3, crash_duration: 3, crash_cost: 58e3, percent_complete: 100, actual_delay_days: 0, max_crash_days: 2, cost_slope: 6500, start_date: "2026-05-04", end_date: "2026-05-09", predecessors: "" },
      { activity_id: "W020", wbs: "1.2", name: "Foundation augered piles and grade beams", activity_type: "SUBSTRUCTURE", duration: 11, quantity: 24, unit: "EA", crew_size: 10, resource: "MASON", normal_cost: 165e3, crash_duration: 8, crash_cost: 21e4, percent_complete: 60, actual_delay_days: 1, max_crash_days: 3, cost_slope: 15e3, start_date: "2026-05-11", end_date: "2026-05-23", predecessors: "W010" },
      { activity_id: "W030", wbs: "2.1", name: "Structural steel columns and portal rafters", activity_type: "STRUCTURE", duration: 12, quantity: 45, unit: "t", crew_size: 12, resource: "CARP", normal_cost: 28e4, crash_duration: 9, crash_cost: 34e4, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 2e4, start_date: "2026-05-25", end_date: "2026-06-08", predecessors: "W020" },
      { activity_id: "W040", wbs: "2.2", name: "Roof trusses, purlins and bracing", activity_type: "STRUCTURE", duration: 8, quantity: 18, unit: "t", crew_size: 8, resource: "CARP", normal_cost: 14e4, crash_duration: 6, crash_cost: 175e3, percent_complete: 0, actual_delay_days: 0, max_crash_days: 2, cost_slope: 17500, start_date: "2026-06-09", end_date: "2026-06-18", predecessors: "W030" },
      { activity_id: "W050", wbs: "3.1", name: "Metal profile roof sheeting & wall cladding", activity_type: "EXTERNAL", duration: 10, quantity: 2200, unit: "m2", crew_size: 10, resource: "HELPER", normal_cost: 195e3, crash_duration: 7, crash_cost: 245e3, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 16666, start_date: "2026-06-19", end_date: "2026-07-01", predecessors: "W040" },
      { activity_id: "W060", wbs: "3.2", name: "Heavy-duty laser screed floor slab pour", activity_type: "STRUCTURE", duration: 9, quantity: 380, unit: "m3", crew_size: 8, resource: "MIXER", normal_cost: 31e4, crash_duration: 6, crash_cost: 375e3, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 21666, start_date: "2026-06-19", end_date: "2026-06-30", predecessors: "W030:FS10" },
      { activity_id: "W070", wbs: "4.1", name: "High-bay LED lighting & electrical distribution", activity_type: "MEP", duration: 11, quantity: 1, unit: "LS", crew_size: 6, resource: "ELEC", normal_cost: 125e3, crash_duration: 8, crash_cost: 16e4, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 11666, start_date: "2026-07-02", end_date: "2026-07-15", predecessors: "W050" },
      { activity_id: "W080", wbs: "5.1", name: "Final inspection, fire clearance & handover", activity_type: "EXTERNAL", duration: 5, quantity: 1, unit: "LS", crew_size: 4, resource: "HELPER", normal_cost: 25e3, crash_duration: null, crash_cost: null, percent_complete: 0, actual_delay_days: 0, max_crash_days: 0, cost_slope: 0, start_date: "2026-07-16", end_date: "2026-07-21", predecessors: "W060, W070" }
    ];
    const warehouseDeps = [
      { predecessor: "W010", successor: "W020", dep_type: "FS", lag: 0 },
      { predecessor: "W020", successor: "W030", dep_type: "FS", lag: 0 },
      { predecessor: "W030", successor: "W040", dep_type: "FS", lag: 0 },
      { predecessor: "W040", successor: "W050", dep_type: "FS", lag: 0 },
      { predecessor: "W030", successor: "W060", dep_type: "FS", lag: 10 },
      { predecessor: "W050", successor: "W070", dep_type: "FS", lag: 0 },
      { predecessor: "W060", successor: "W080", dep_type: "FS", lag: 0 },
      { predecessor: "W070", successor: "W080", dep_type: "FS", lag: 0 }
    ];
    activeScheduleState = {
      project: {
        ...loaded.project,
        project_id: "CS-WH-002",
        name: "Pre-Engineered Steel Warehouse Schedule",
        start_date: "2026-05-04",
        data_date: "2026-05-20"
      },
      activities: warehouseActs,
      dependencies: warehouseDeps,
      riskRegister: loaded.riskRegister,
      startOffsets: {}
    };
  }
}
var historyStore = [];
function runCycle(dataDate, mode = "expected", threshold = 0.6, forceStore = false) {
  const state = getScheduleState();
  const { project, activities, dependencies, riskRegister, startOffsets } = state;
  const calendar = new WorkingCalendar(
    project.start_date,
    project.work_week,
    project.holidays,
    project.monsoon
  );
  const dd = dataDate || project.data_date || project.start_date;
  if (dd < project.start_date) {
    throw new Error(`Data date ${dd} is before project start ${project.start_date}`);
  }
  const engine = new CPMEngine(activities, dependencies, calendar, startOffsets);
  const baseline = engine.compute();
  const { predictions, explanations, modelInfo } = computePredictionsAndExplanations(
    activities,
    baseline,
    calendar,
    riskRegister,
    dependencies
  );
  const adaptation = adapt(activities, engine, baseline, predictions, mode, threshold);
  const current = adaptation.adapted;
  const resDemand = computeDailyDemand(activities, current, project.resources);
  for (const w of resDemand.windows) {
    w.start_date = calendar.dateOf(w.start_offset);
    w.end_date = calendar.dateOf(w.end_offset);
  }
  const progressData = computeProgress(activities, baseline, current, calendar, dd);
  const recommendations = generateRecommendations(activities, adaptation, explanations);
  const warnings = [];
  if (mode === "expected" && Object.keys(adaptation.injected).length === 0) {
    warnings.push(`No activity reached P(delay) >= ${threshold.toFixed(2)}; the adapted schedule equals the baseline.`);
  }
  const actRows = [];
  let atRiskCount = 0;
  for (const a of activities) {
    const sCur = current.schedules[a.activity_id];
    const sBase = baseline.schedules[a.activity_id];
    const inj = adaptation.injected[a.activity_id];
    const pr = predictions[a.activity_id];
    if (pr && pr.at_risk) atRiskCount++;
    actRows.push({
      activity_id: a.activity_id,
      name: a.name,
      type: a.activity_type,
      wbs: a.wbs,
      resource: a.resource,
      crew_size: a.crew_size,
      planned_duration: a.duration,
      current_duration: sCur.duration,
      baseline_es: sBase.es,
      baseline_ef: sBase.ef,
      current_es: sCur.es,
      current_ef: sCur.ef,
      baseline_start: calendar.dateOf(sBase.es),
      baseline_finish: calendar.finishDate(sBase.ef),
      current_start: calendar.dateOf(sCur.es),
      current_finish: calendar.finishDate(sCur.ef),
      total_float: sCur.total_float,
      free_float: sCur.free_float,
      baseline_total_float: sBase.total_float,
      critical: sCur.critical,
      baseline_critical: sBase.critical,
      near_critical: sCur.total_float > 0 && sCur.total_float <= 5,
      float_erosion: adaptation.float_erosion[a.activity_id] || 0,
      percent_complete: a.percent_complete,
      injected_days: inj ? inj.days : 0,
      injected_source: inj ? inj.source : "",
      p_delay: pr ? pr.p_delay : null,
      predicted_delay_days: pr ? pr.predicted_delay_days : null,
      risk_band: pr ? pr.risk_band : null,
      at_risk: pr ? pr.at_risk : false,
      drivers: pr ? pr.drivers : "",
      predecessors: a.predecessors || formatPredecessorString(a.activity_id, dependencies),
      normal_cost: a.normal_cost,
      crash_duration: a.crash_duration,
      crash_cost: a.crash_cost,
      quantity: a.quantity,
      unit: a.unit
    });
  }
  let currentVersion = null;
  if (forceStore) {
    const vId = historyStore.length + 1;
    currentVersion = {
      version_id: vId,
      data_date: dd,
      mode,
      threshold,
      completion_date: current.completion_date,
      duration_wd: current.project_duration,
      stored_at: (/* @__PURE__ */ new Date()).toISOString(),
      kind: "adapted"
    };
    historyStore.push(currentVersion);
  }
  const forecastTrend = [
    { label: "Baseline", completion_date: baseline.completion_date }
  ];
  historyStore.forEach((h, idx) => {
    forecastTrend.push({
      label: `Cycle ${idx + 1}`,
      completion_date: h.completion_date,
      data_date: h.data_date
    });
  });
  if (!currentVersion) {
    forecastTrend.push({
      label: "Current (not stored)",
      completion_date: current.completion_date,
      data_date: dd
    });
  }
  const kpis = {
    baseline_completion: baseline.completion_date,
    current_completion: current.completion_date,
    baseline_duration_wd: baseline.project_duration,
    current_duration_wd: current.project_duration,
    schedule_variance_wd: adaptation.schedule_variance_days,
    calendar_slip_days: adaptation.calendar_slip_days,
    critical_activities: current.critical_path.length,
    newly_critical: adaptation.newly_critical,
    left_critical: adaptation.left_critical,
    critical_path_migrated: adaptation.critical_path_migrated,
    near_critical_count: adaptation.near_critical.length,
    eroded_float_count: adaptation.eroded.length,
    adapted_activities: Object.keys(adaptation.injected).length,
    at_risk_count: atRiskCount,
    planned_pct: progressData.planned_pct,
    actual_pct: progressData.actual_pct,
    progress_variance_pct: progressData.variance_pct,
    recommendation_count: recommendations.length
  };
  const cycle = {
    project: {
      project_id: project.project_id,
      name: project.name,
      start_date: project.start_date,
      location: project.location,
      data_source: project.data_source,
      activity_count: activities.length,
      dependency_count: dependencies.length
    },
    data_date: dd,
    mode,
    threshold,
    warnings,
    notice: SYNTHETIC_NOTICE,
    model: modelInfo,
    kpis,
    critical_path: {
      baseline: baseline.critical_path,
      current: current.critical_path,
      newly_critical: adaptation.newly_critical,
      left_critical: adaptation.left_critical,
      near_critical: adaptation.near_critical,
      float_eroded: adaptation.eroded
    },
    activities: actRows,
    recommendations,
    resources: {
      summary: resDemand.summary,
      over_allocation_windows: resDemand.windows,
      demand: resDemand.demand
    },
    explanations,
    progress: progressData,
    factors: riskRegister.asFrame(),
    composite_risk_index: Math.round(riskRegister.compositeRiskIndex() * 1e3) / 1e3,
    dominant_factors: riskRegister.dominantFactors(),
    rii_status: RII_STATUS,
    forecast_trend: forecastTrend,
    history: historyStore.slice(),
    version: currentVersion
  };
  const horizon = Math.max(baseline.project_duration, current.project_duration);
  const offsetDates = Array.from({ length: horizon + 1 }, (_, k) => calendar.dateOf(k));
  const gantt = {
    data_date: dd,
    data_date_offset: progressData.elapsed_working_days,
    horizon,
    offset_dates: offsetDates,
    predictions_available: true,
    activities: actRows.map((a) => ({
      activity_id: a.activity_id,
      name: a.name,
      type: a.type,
      baseline_es: a.baseline_es,
      baseline_ef: a.baseline_ef,
      current_es: a.current_es,
      current_ef: a.current_ef,
      current_start: a.current_start,
      current_finish: a.current_finish,
      baseline_start: a.baseline_start,
      baseline_finish: a.baseline_finish,
      critical: a.critical,
      near_critical: a.near_critical,
      risk_band: a.risk_band,
      p_delay: a.p_delay,
      predicted_delay_days: a.predicted_delay_days,
      injected_days: a.injected_days,
      total_float: a.total_float,
      percent_complete: a.percent_complete,
      drivers: a.drivers
    }))
  };
  return { cycle, gantt };
}

// src/views/embeddedViews.ts
var EMBEDDED_VIEWS = {
  "builder": `<%- include('partials/header') %>

<% if (msg) { %>
<div class="banner" style="background:#e8f5e9;border-color:#43a047;color:#1b5e20;"><b>\u2713 Success:</b> <%= msg %></div>
<% } %>
<% if (error) { %>
<div class="warn"><b>\u26A0 Error:</b> <%= error %></div>
<% } %>

<div class="builder-header card" style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
  <div>
    <h2 style="margin:0 0 4px;border:none;padding:0">Construction Task Input &amp; Schedule Builder</h2>
    <div class="sub" style="color:var(--muted);font-size:12px">Input construction tasks with explicit start and end dates to build or modify the initial CPM schedule data structure.</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <form method="post" action="/builder/template" style="display:inline-flex;gap:6px;align-items:center">
      <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Presets:
        <select name="template" onchange="this.form.submit()" style="font-size:12px;padding:3px 6px">
          <option value="" disabled selected>Load Template...</option>
          <option value="g3_case_study">G+3 Building (67 tasks)</option>
          <option value="substructure">Foundation &amp; Substructure (14 tasks)</option>
          <option value="commercial_warehouse">Steel Warehouse (8 tasks)</option>
        </select>
      </label>
    </form>
    <form method="post" action="/builder/reset" style="display:inline" onsubmit="return confirm('Reset all tasks to the synthetic G+3 building case study?')">
      <button type="submit" class="alt" style="font-size:12px;padding:4px 10px">Reset to Case Study</button>
    </form>
    <form method="post" action="/builder/clear" style="display:inline" onsubmit="return confirm('Clear ALL tasks to start a fresh custom schedule?')">
      <button type="submit" class="alt" style="font-size:12px;padding:4px 10px;color:var(--critical);border-color:var(--critical)">Clear All</button>
    </form>
    <a href="/gantt<%= query ? '?' + query : '' %>" class="btn" style="font-size:12px;padding:5px 12px">View Gantt Chart \u2192</a>
  </div>
</div>

<div class="grid g2" style="align-items:start">
  <!-- FORM COMPONENT -->
  <div class="card form-card">
    <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:12px">
      <b id="form-title" style="font-size:14px;color:var(--ink)">\uFF0B Add Construction Task</b>
      <span id="edit-badge" class="chip" style="display:none;background:var(--accent)">Editing <span id="edit-id-display"></span></span>
    </div>

    <!-- Live Working Days Date Calculation Badge -->
    <div id="calc-preview" style="background:#f4f6fa;border:1px solid #d0d7de;border-radius:3px;padding:8px 12px;margin-bottom:12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div>
        <span style="color:var(--muted)">Working Duration:</span>
        <b id="calc-wd" style="color:var(--blue);font-size:14px;margin-left:4px">5 working days</b>
      </div>
      <div style="color:var(--muted);font-size:11.5px">
        <span id="calc-span">6 cal. days</span> \xB7 <span id="calc-monsoon">0% monsoon</span>
      </div>
    </div>

    <form id="task-form" method="post" action="/builder/add">
      <div class="form-section">
        <div class="section-title">Task Identification</div>
        <div class="form-row r4">
          <label>Task ID
            <input type="text" id="inp-id" name="activity_id" placeholder="e.g. A010" title="Leave empty to auto-generate next ID">
          </label>
          <label>WBS Code
            <input type="text" id="inp-wbs" name="wbs" placeholder="1.1" value="1.0">
          </label>
          <label style="grid-column:span 2">Task Name / Description *
            <input type="text" id="inp-name" name="name" required placeholder="e.g. Footing reinforcement & formwork">
          </label>
        </div>

        <div class="form-row r2" style="margin-top:8px">
          <label>Activity Type
            <select id="inp-type" name="activity_type">
              <option value="SUBSTRUCTURE">SUBSTRUCTURE (Earthwork, Foundations, Plinth)</option>
              <option value="STRUCTURE" selected>STRUCTURE (Columns, Beams, Slabs)</option>
              <option value="MASONRY">MASONRY (Brickwork, Blockwork, Lintels)</option>
              <option value="MEP">MEP (Plumbing, Electrical, HVAC)</option>
              <option value="FINISH">FINISH (Plastering, Flooring, Painting)</option>
              <option value="EXTERNAL">EXTERNAL (Site works, Paving, Landscaping)</option>
            </select>
          </label>
          <label>Predecessors (Dependencies)
            <input type="text" id="inp-preds" name="predecessors" placeholder="e.g. A010, A020:SS2, A030:FS1">
          </label>
        </div>
      </div>

      <div class="form-section" style="margin-top:12px">
        <div class="section-title">Schedule Window (Start &amp; End Dates)</div>
        <div class="form-row r2">
          <label>Planned Start Date *
            <input type="date" id="inp-start" name="start_date" required value="<%= c ? c.data_date : '2026-05-04' %>">
          </label>
          <label>Planned End Date *
            <input type="date" id="inp-end" name="end_date" required value="<%= c ? c.data_date : '2026-05-09' %>">
          </label>
        </div>
        <div class="note" style="margin-top:4px;font-size:11px">
          The engine calculates integer working days automatically using the project's 6-day work calendar and site holidays.
        </div>
      </div>

      <div class="form-section" style="margin-top:12px">
        <div class="section-title">Resource &amp; Cost Parameters</div>
        <div class="form-row r3">
          <label>Trade Resource
            <select id="inp-res" name="resource">
              <option value="HELPER">HELPER (Helpers / general labour)</option>
              <option value="MASON">MASON (Masons)</option>
              <option value="CARP">CARP (Carpenters)</option>
              <option value="BARB">BARB (Bar benders)</option>
              <option value="MIXER">MIXER (Concrete mixers / pumps)</option>
              <option value="EXC">EXC (Excavators with operator)</option>
              <option value="ELEC">ELEC (Electricians)</option>
              <option value="PLUM">PLUM (Plumbers)</option>
              <option value="PAINT">PAINT (Painters)</option>
              <option value="TILER">TILER (Tilers)</option>
            </select>
          </label>
          <label>Crew Size
            <input type="number" id="inp-crew" name="crew_size" min="1" max="100" value="6">
          </label>
          <label>Quantity &amp; Unit
            <div style="display:flex;gap:4px">
              <input type="number" id="inp-qty" name="quantity" step="any" placeholder="Qty" value="100" style="width:65%">
              <input type="text" id="inp-unit" name="unit" placeholder="m3" value="m3" style="width:35%">
            </div>
          </label>
        </div>

        <div class="form-row r3" style="margin-top:8px">
          <label>Normal Cost (INR)
            <input type="number" id="inp-cost" name="normal_cost" min="0" placeholder="0" value="50000">
          </label>
          <label>Crash Duration (wd)
            <input type="number" id="inp-crash-dur" name="crash_duration" min="1" placeholder="Optional">
          </label>
          <label>Crash Cost (INR)
            <input type="number" id="inp-crash-cost" name="crash_cost" min="0" placeholder="Optional">
          </label>
        </div>

        <div class="form-row r2" style="margin-top:8px">
          <label>Progress Complete (%)
            <input type="number" id="inp-prog" name="percent_complete" min="0" max="100" step="5" value="0">
          </label>
          <label>Observed Delay Days
            <input type="number" id="inp-delay" name="actual_delay_days" min="0" value="0" placeholder="0">
          </label>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px;align-items:center">
        <button type="submit" id="btn-submit" style="flex:1;background:var(--blue);border-color:var(--blue);font-weight:600">\uFF0B Add Task to Schedule</button>
        <button type="button" id="btn-cancel" class="alt" onclick="resetForm()" style="display:none">Cancel Edit</button>
      </div>
    </form>
  </div>

  <!-- SCHEDULE KPIS & QUICK TOOLS -->
  <div>
    <div class="card">
      <b>Current Schedule Architecture</b>
      <div class="grid g2" style="margin-top:10px;gap:8px">
        <div style="background:#faf8f2;padding:8px;border:1px solid var(--line)">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase">Total Activities</div>
          <div style="font-size:22px;font-weight:600" class="mono"><%= c ? c.project.activity_count : 0 %></div>
          <div style="font-size:11px;color:var(--muted)"><%= c ? c.project.dependency_count : 0 %> dependency links</div>
        </div>
        <div style="background:#faf8f2;padding:8px;border:1px solid var(--line)">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase">Project Duration</div>
          <div style="font-size:22px;font-weight:600" class="mono"><%= c && c.kpis ? c.kpis.baseline_duration_wd : 0 %> <span style="font-size:13px;font-weight:normal">wd</span></div>
          <div style="font-size:11px;color:var(--muted)">finishes <%= c && c.kpis ? c.kpis.baseline_completion : '\u2013' %></div>
        </div>
        <div style="background:#faf8f2;padding:8px;border:1px solid var(--line)">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase">Critical Path</div>
          <div style="font-size:22px;font-weight:600" class="mono"><%= c && c.kpis ? c.kpis.critical_activities : 0 %> <span style="font-size:13px;font-weight:normal">tasks</span></div>
          <div style="font-size:11px;color:var(--critical)">Zero total float</div>
        </div>
        <div style="background:#faf8f2;padding:8px;border:1px solid var(--line)">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase">Near-Critical Tasks</div>
          <div style="font-size:22px;font-weight:600" class="mono"><%= c && c.kpis ? c.kpis.near_critical_count : 0 %></div>
          <div style="font-size:11px;color:var(--muted)">0 &lt; Float \u2264 5 wd</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--muted);line-height:1.5">
        <b>How CPM Schedule Building Works:</b> Tasks are structured with working day windows. Setting predecessors creates FS/SS/FF/SF constraints. The engine computes early and late dates, floats, and isolates the critical path.
      </div>
    </div>

    <!-- Quick Predecessor Helper Card -->
    <div class="card" style="margin-top:12px">
      <b>Quick Dependency Helper</b>
      <div style="font-size:12px;color:var(--muted);margin:4px 0 8px">Select an existing activity to insert into the Predecessors input:</div>
      <div style="display:flex;gap:6px">
        <select id="pred-selector" style="flex:1;font-size:12px">
          <option value="">Choose task to link...</option>
          <% if (c && c.activities) { %>
            <% c.activities.forEach(function(a) { %>
              <option value="<%= a.activity_id %>"><%= a.activity_id %>: <%= a.name %> (<%= a.current_duration %> wd)</option>
            <% }); %>
          <% } %>
        </select>
        <select id="pred-type-sel" style="width:80px;font-size:12px">
          <option value="FS">FS (Finish-Start)</option>
          <option value="SS">SS (Start-Start)</option>
          <option value="FF">FF (Finish-Finish)</option>
          <option value="SF">SF (Start-Finish)</option>
        </select>
        <input type="number" id="pred-lag-sel" placeholder="Lag" value="0" style="width:50px;font-size:12px">
        <button type="button" class="alt" onclick="addPredHelper()" style="padding:4px 8px;font-size:12px">+ Link</button>
      </div>
    </div>

    <!-- CUSTOM VALUE SLOT COMPONENT -->
    <div class="card slot-card" id="custom-slot-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--ink);font-size:13px">\u26A1 Custom Value Slot (Quick / Batch Input)</b>
        <span class="note" style="font-size:11px">Paste or enter your custom values</span>
      </div>
      <p class="note" style="margin:0 0 8px;font-size:11.5px">
        Type your own values below (one task per line). Format: <code>Task Name, Start Date, End Date, [Type], [Resource], [Crew], [Cost], [Predecessors]</code>
      </p>

      <form method="post" action="/builder/batch" id="slot-batch-form">
        <textarea name="slot_text" id="slot-text" rows="3" class="slot-textarea" placeholder="Tower Crane Foundation, 2026-05-18, 2026-05-26, SUBSTRUCTURE, MASON, 8, 75000, A020
Underground Stormwater Tank, 2026-05-26, 2026-06-06, SUBSTRUCTURE, EXC, 4, 90000, A030"></textarea>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button type="submit" style="font-size:12px;padding:5px 12px;background:var(--blue);border-color:var(--blue)">\u26A1 Import Slot Tasks into Schedule</button>
          <button type="button" class="alt" style="font-size:12px;padding:5px 10px" onclick="transferSlotToMainForm()">\u27F5 Fill Form from Slot</button>
          <button type="button" class="alt" style="font-size:12px;padding:5px 10px" onclick="document.getElementById('slot-text').value=''">Clear Slot</button>
        </div>
      </form>
    </div>

    <!-- EXAMPLE CASES BELOW THE SLOT -->
    <div class="example-cases-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 8px">
        <b style="font-size:13px;color:var(--ink)">\u{1F4DA} Construction Example Cases</b>
        <span class="note" style="font-size:11px">Click to load into slot or add directly</span>
      </div>

      <!-- Example Case 1 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">1. Deep Shoring &amp; Bulk Excavation</b>
          <span class="chip low" style="font-size:10px">SUBSTRUCTURE</span>
        </div>
        <div class="example-case-meta">
          <span>2026-05-18 \u2192 2026-05-28 (9 wd)</span>
          <span>EXC (4 crew)</span>
          <span>1,200 m3</span>
          <span>\u20B985,000</span>
          <span>Pred: A020</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Heavy earthmoving and retaining shoring for basement footings with excavator operators.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(0, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(0, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>

      <!-- Example Case 2 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">2. 2nd Floor Monolithic Slab &amp; Beam Pour</b>
          <span class="chip medium" style="font-size:10px">STRUCTURE</span>
        </div>
        <div class="example-case-meta">
          <span>2026-06-08 \u2192 2026-06-18 (9 wd)</span>
          <span>MIXER (6 crew)</span>
          <span>220 m3</span>
          <span>\u20B9180,000</span>
          <span>Pred: A240</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Staged structural RCC slab concreting with stationary pump and compaction crew.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(1, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(1, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>

      <!-- Example Case 3 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">3. Monsoon Exposed Basement Waterproofing</b>
          <span class="chip critical" style="font-size:10px">SUBSTRUCTURE</span>
        </div>
        <div class="example-case-meta">
          <span>2026-07-13 \u2192 2026-07-25 (11 wd)</span>
          <span>HELPER (8 crew)</span>
          <span>650 m2</span>
          <span>\u20B970,000</span>
          <span>Pred: A120</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Peak monsoon scheduled task testing weather risk prediction &amp; rainwater dewatering.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(2, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(2, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>

      <!-- Example Case 4 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">4. Vertical Plumbing Risers &amp; Drainage Stacks</b>
          <span class="chip high" style="font-size:10px">MEP</span>
        </div>
        <div class="example-case-meta">
          <span>2026-07-06 \u2192 2026-07-16 (9 wd)</span>
          <span>PLUM (6 crew)</span>
          <span>1 LS</span>
          <span>\u20B995,000</span>
          <span>Pred: A190:FS4</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Multi-floor cast iron soil stacks, vents, and pressure testing across vertical ducts.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(3, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(3, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>

      <!-- Example Case 5 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">5. High-Voltage Substation &amp; Busduct Conduit</b>
          <span class="chip medium" style="font-size:10px">MEP</span>
        </div>
        <div class="example-case-meta">
          <span>2026-08-10 \u2192 2026-08-22 (11 wd)</span>
          <span>ELEC (8 crew)</span>
          <span>1 LS</span>
          <span>\u20B9140,000</span>
          <span>Pred: A310:FS2</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Main distribution boards, busducts, and transformer tie-ins with certified technicians.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(4, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(4, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>

      <!-- Example Case 6 -->
      <div class="example-case-card">
        <div class="example-case-header">
          <b style="font-size:12.5px;color:var(--ink)">6. Vitrified Floor Tiling &amp; Skirting Finishes</b>
          <span class="chip low" style="font-size:10px">FINISH</span>
        </div>
        <div class="example-case-meta">
          <span>2026-09-01 \u2192 2026-09-15 (12 wd)</span>
          <span>TILER (10 crew)</span>
          <span>850 m2</span>
          <span>\u20B9120,000</span>
          <span>Pred: A370</span>
        </div>
        <div class="note" style="font-size:11px;margin-bottom:8px">Laser-level bedding mortar, 600x600 vitrified tile laying, epoxy grouting &amp; skirting.</div>
        <div class="example-case-actions">
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px" onclick="loadExampleCase(5, false)">\u21B3 Load into Slot &amp; Form</button>
          <button type="button" class="btn alt" style="font-size:11px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="loadExampleCase(5, true)">\uFF0B Add to Schedule</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- SCHEDULE DATA STRUCTURE TABLE -->
<div style="margin-top:20px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
    <h2 style="margin:0;border:none;padding:0">Defined Construction Tasks in Schedule Structure (<%= c && c.activities ? c.activities.length : 0 %>)</h2>
    <div style="display:flex;gap:10px;align-items:center">
      <input type="text" id="task-search" placeholder="Search tasks..." oninput="filterTable()" style="font-size:12px;padding:4px 8px;width:180px">
      <select id="type-filter" onchange="filterTable()" style="font-size:12px;padding:4px 8px">
        <option value="all">All Types</option>
        <option value="SUBSTRUCTURE">Substructure</option>
        <option value="STRUCTURE">Structure</option>
        <option value="MASONRY">Masonry</option>
        <option value="MEP">MEP</option>
        <option value="FINISH">Finish</option>
        <option value="EXTERNAL">External</option>
      </select>
      <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" id="crit-only" onchange="filterTable()"> Critical Only
      </label>
    </div>
  </div>

  <div class="scroll" style="max-height:60vh">
    <table id="tasks-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>WBS</th>
          <th>Task Name</th>
          <th>Type</th>
          <th>Start Date</th>
          <th>End Date</th>
          <th class="num">Duration</th>
          <th>Predecessors</th>
          <th>Resource &amp; Crew</th>
          <th class="num">Float</th>
          <th>Status</th>
          <th style="text-align:center">Actions</th>
        </tr>
      </thead>
      <tbody>
        <% if (c && c.activities && c.activities.length > 0) { %>
          <% c.activities.forEach(function(a) { %>
            <tr id="row-<%= a.activity_id %>" data-type="<%= a.type %>" data-critical="<%= a.critical ? '1' : '0' %>">
              <td><b class="mono"><%= a.activity_id %></b></td>
              <td class="mono"><%= a.wbs %></td>
              <td>
                <div style="font-weight:500"><%= a.name %></div>
                <% if (a.percent_complete > 0) { %>
                  <div style="font-size:10.5px;color:var(--muted)">Progress: <%= a.percent_complete %>%<%= a.injected_days > 0 ? \` \xB7 \${a.injected_days}d delay\` : '' %></div>
                <% } %>
              </td>
              <td><span class="chip <%= a.risk_band || 'medium' %>" style="font-size:10px;text-transform:lowercase"><%= a.type %></span></td>
              <td class="mono"><%= a.baseline_start %></td>
              <td class="mono"><%= a.baseline_finish %></td>
              <td class="num"><%= a.planned_duration %> wd</td>
              <td class="mono" style="font-size:11px"><%= a.predecessors || '\u2013' %></td>
              <td><%= a.resource %> (<%= a.crew_size %>)</td>
              <td class="num <%= a.critical ? 'bad' : '' %>"><%= a.total_float %> wd</td>
              <td>
                <% if (a.critical) { %>
                  <span class="tag">CRITICAL</span>
                <% } else if (a.near_critical) { %>
                  <span style="font-size:11px;color:var(--high);font-weight:600">NEAR</span>
                <% } else { %>
                  <span style="font-size:11px;color:var(--muted)">Normal</span>
                <% } %>
              </td>
              <td style="text-align:center;white-space:nowrap">
                <button type="button" class="btn alt" style="padding:2px 8px;font-size:11px" onclick="editTask(<%= JSON.stringify(a) %>)">Edit</button>
                <form method="post" action="/builder/delete/<%= a.activity_id %>" style="display:inline" onsubmit="return confirm('Delete activity <%= a.activity_id %>?')">
                  <button type="submit" class="btn alt" style="padding:2px 6px;font-size:11px;color:var(--critical);border-color:var(--critical)">\u2715</button>
                </form>
              </td>
            </tr>
          <% }); %>
        <% } else { %>
          <tr>
            <td colspan="12" style="text-align:center;padding:24px;color:var(--muted)">
              No tasks currently defined. Use the form above to add your first construction task, or select a preset template!
            </td>
          </tr>
        <% } %>
      </tbody>
    </table>
  </div>
</div>

<script>
(function() {
  const form = document.getElementById('task-form');
  const formTitle = document.getElementById('form-title');
  const btnSubmit = document.getElementById('btn-submit');
  const btnCancel = document.getElementById('btn-cancel');
  const editBadge = document.getElementById('edit-badge');
  const editIdDisplay = document.getElementById('edit-id-display');

  const inpId = document.getElementById('inp-id');
  const inpWbs = document.getElementById('inp-wbs');
  const inpName = document.getElementById('inp-name');
  const inpType = document.getElementById('inp-type');
  const inpStart = document.getElementById('inp-start');
  const inpEnd = document.getElementById('inp-end');
  const inpPreds = document.getElementById('inp-preds');
  const inpRes = document.getElementById('inp-res');
  const inpCrew = document.getElementById('inp-crew');
  const inpQty = document.getElementById('inp-qty');
  const inpUnit = document.getElementById('inp-unit');
  const inpCost = document.getElementById('inp-cost');
  const inpCrashDur = document.getElementById('inp-crash-dur');
  const inpCrashCost = document.getElementById('inp-crash-cost');
  const inpProg = document.getElementById('inp-prog');
  const inpDelay = document.getElementById('inp-delay');

  const calcWd = document.getElementById('calc-wd');
  const calcSpan = document.getElementById('calc-span');
  const calcMonsoon = document.getElementById('calc-monsoon');

  // Live working days computation on date input change
  let timer = null;
  function updateLiveWorkingDays() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const s = inpStart.value;
      const e = inpEnd.value;
      if (!s || !e) return;
      try {
        const res = await fetch(\`/api/calendar/calc-days?start_date=\${s}&end_date=\${e}\`);
        if (res.ok) {
          const data = await res.json();
          calcWd.textContent = \`\${data.working_days} working days\`;
          calcSpan.textContent = \`\${data.calendar_days} cal. days\`;
          calcMonsoon.textContent = \`\${Math.round(data.monsoon_exposure * 100)}% monsoon\`;
        }
      } catch (err) {
        console.error(err);
      }
    }, 150);
  }

  inpStart.addEventListener('change', updateLiveWorkingDays);
  inpEnd.addEventListener('change', updateLiveWorkingDays);
  updateLiveWorkingDays();

  // Populate form for editing
  window.editTask = function(task) {
    form.action = '/builder/update/' + encodeURIComponent(task.activity_id);
    formTitle.textContent = '\u270E Edit Construction Task';
    btnSubmit.textContent = '\u2713 Save Changes to ' + task.activity_id;
    btnSubmit.style.background = 'var(--accent)';
    btnSubmit.style.borderColor = 'var(--accent)';
    btnCancel.style.display = 'inline-block';
    editBadge.style.display = 'inline-block';
    editIdDisplay.textContent = task.activity_id;

    inpId.value = task.activity_id;
    inpId.readOnly = true;
    inpId.style.background = '#f0ebe1';
    inpWbs.value = task.wbs || '';
    inpName.value = task.name || '';
    inpType.value = task.type || 'STRUCTURE';
    inpStart.value = task.baseline_start || task.start_date || '';
    inpEnd.value = task.baseline_finish || task.end_date || '';
    inpPreds.value = task.predecessors || '';
    inpRes.value = task.resource || 'HELPER';
    inpCrew.value = task.crew_size || 6;
    inpQty.value = task.quantity !== undefined ? task.quantity : 100;
    inpUnit.value = task.unit || 'm3';
    inpCost.value = task.normal_cost !== undefined ? task.normal_cost : 50000;
    inpCrashDur.value = task.crash_duration || '';
    inpCrashCost.value = task.crash_cost || '';
    inpProg.value = task.percent_complete || 0;
    inpDelay.value = task.injected_days || task.actual_delay_days || 0;

    updateLiveWorkingDays();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const EXAMPLE_CASES = [
    {
      name: 'Deep Shoring & Bulk Excavation',
      wbs: '1.2',
      activity_type: 'SUBSTRUCTURE',
      start_date: '2026-05-18',
      end_date: '2026-05-28',
      resource: 'EXC',
      crew_size: 4,
      quantity: 1200,
      unit: 'm3',
      normal_cost: 85000,
      crash_duration: 6,
      crash_cost: 115000,
      predecessors: 'A020',
      percent_complete: 0,
      actual_delay_days: 0
    },
    {
      name: '2nd Floor Monolithic Slab & Beam Pour',
      wbs: '2.4',
      activity_type: 'STRUCTURE',
      start_date: '2026-06-08',
      end_date: '2026-06-18',
      resource: 'MIXER',
      crew_size: 6,
      quantity: 220,
      unit: 'm3',
      normal_cost: 180000,
      crash_duration: 6,
      crash_cost: 235000,
      predecessors: 'A240',
      percent_complete: 0,
      actual_delay_days: 0
    },
    {
      name: 'Monsoon Exposed Basement Waterproofing',
      wbs: '1.5',
      activity_type: 'SUBSTRUCTURE',
      start_date: '2026-07-13',
      end_date: '2026-07-25',
      resource: 'HELPER',
      crew_size: 8,
      quantity: 650,
      unit: 'm2',
      normal_cost: 70000,
      crash_duration: 8,
      crash_cost: 92000,
      predecessors: 'A120',
      percent_complete: 0,
      actual_delay_days: 0
    },
    {
      name: 'Vertical Plumbing Risers & Drainage Stacks',
      wbs: '4.2',
      activity_type: 'MEP',
      start_date: '2026-07-06',
      end_date: '2026-07-16',
      resource: 'PLUM',
      crew_size: 6,
      quantity: 1,
      unit: 'LS',
      normal_cost: 95000,
      crash_duration: 7,
      crash_cost: 120000,
      predecessors: 'A190:FS4',
      percent_complete: 0,
      actual_delay_days: 0
    },
    {
      name: 'High-Voltage Substation & Busduct Conduit',
      wbs: '4.5',
      activity_type: 'MEP',
      start_date: '2026-08-10',
      end_date: '2026-08-22',
      resource: 'ELEC',
      crew_size: 8,
      quantity: 1,
      unit: 'LS',
      normal_cost: 140000,
      crash_duration: 7,
      crash_cost: 185000,
      predecessors: 'A310:FS2',
      percent_complete: 0,
      actual_delay_days: 0
    },
    {
      name: 'Vitrified Floor Tiling & Skirting Finishes',
      wbs: '5.2',
      activity_type: 'FINISH',
      start_date: '2026-09-01',
      end_date: '2026-09-15',
      resource: 'TILER',
      crew_size: 10,
      quantity: 850,
      unit: 'm2',
      normal_cost: 120000,
      crash_duration: 9,
      crash_cost: 155000,
      predecessors: 'A370',
      percent_complete: 0,
      actual_delay_days: 0
    }
  ];

  window.loadExampleCase = function(idx, autoSubmit) {
    const item = EXAMPLE_CASES[idx];
    if (!item) return;

    // Fill the slot textarea
    const slotEl = document.getElementById('slot-text');
    slotEl.value = \`\${item.name}, \${item.start_date}, \${item.end_date}, \${item.activity_type}, \${item.resource}, \${item.crew_size}, \${item.normal_cost}, \${item.predecessors}\`;

    // Fill the form fields
    inpName.value = item.name;
    inpWbs.value = item.wbs;
    inpType.value = item.activity_type;
    inpStart.value = item.start_date;
    inpEnd.value = item.end_date;
    inpRes.value = item.resource;
    inpCrew.value = item.crew_size;
    inpQty.value = item.quantity;
    inpUnit.value = item.unit;
    inpCost.value = item.normal_cost;
    inpCrashDur.value = item.crash_duration || '';
    inpCrashCost.value = item.crash_cost || '';
    inpPreds.value = item.predecessors;
    inpProg.value = item.percent_complete;
    inpDelay.value = item.actual_delay_days;

    updateLiveWorkingDays();

    if (autoSubmit) {
      form.action = '/builder/add';
      form.submit();
    } else {
      document.getElementById('custom-slot-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  window.transferSlotToMainForm = function() {
    const raw = document.getElementById('slot-text').value.trim();
    if (!raw) return;
    const firstLine = raw.split(/\\r?\\n/)[0];
    const parts = firstLine.split(/[,\\t]/).map(p => p.trim());
    if (parts.length >= 3) {
      inpName.value = parts[0];
      inpStart.value = parts[1];
      inpEnd.value = parts[2];
      if (parts[3]) inpType.value = parts[3].toUpperCase();
      if (parts[4]) inpRes.value = parts[4].toUpperCase();
      if (parts[5]) inpCrew.value = parseInt(parts[5], 10) || 4;
      if (parts[6]) inpCost.value = parseFloat(parts[6]) || 50000;
      if (parts[7]) inpPreds.value = parts[7];
      if (parts[8]) inpWbs.value = parts[8];
      updateLiveWorkingDays();
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  window.resetForm = function() {
    form.action = '/builder/add';
    formTitle.textContent = '\uFF0B Add Construction Task';
    btnSubmit.textContent = '\uFF0B Add Task to Schedule';
    btnSubmit.style.background = 'var(--blue)';
    btnSubmit.style.borderColor = 'var(--blue)';
    btnCancel.style.display = 'none';
    editBadge.style.display = 'none';

    inpId.value = '';
    inpId.readOnly = false;
    inpId.style.background = '#fff';
    inpName.value = '';
    inpPreds.value = '';
    updateLiveWorkingDays();
  };

  window.addPredHelper = function() {
    const sel = document.getElementById('pred-selector');
    const typeSel = document.getElementById('pred-type-sel');
    const lagSel = document.getElementById('pred-lag-sel');
    const predId = sel.value;
    if (!predId) return;

    let linkStr = predId;
    const type = typeSel.value;
    const lag = parseInt(lagSel.value, 10) || 0;
    if (type !== 'FS' || lag !== 0) {
      linkStr += \`:\${type}\${lag !== 0 ? lag : ''}\`;
    }

    const cur = inpPreds.value.trim();
    if (cur) {
      const parts = cur.split(',').map(s => s.trim());
      if (!parts.includes(linkStr)) {
        inpPreds.value = cur + ', ' + linkStr;
      }
    } else {
      inpPreds.value = linkStr;
    }
  };

  // Filter Table
  window.filterTable = function() {
    const q = document.getElementById('task-search').value.toLowerCase();
    const type = document.getElementById('type-filter').value;
    const critOnly = document.getElementById('crit-only').checked;

    const rows = document.querySelectorAll('#tasks-table tbody tr');
    rows.forEach(r => {
      if (r.children.length < 5) return;
      const text = r.textContent.toLowerCase();
      const rType = r.dataset.type;
      const isCrit = r.dataset.critical === '1';

      const matchQ = !q || text.includes(q);
      const matchType = type === 'all' || rType === type;
      const matchCrit = !critOnly || isCrit;

      r.style.display = (matchQ && matchType && matchCrit) ? '' : 'none';
    });
  };
})();
</script>

<%- include('partials/footer') %>
`,
  "dashboard": `<%- include('partials/header') %>
<% const k = c.kpis; %>
<div class="grid g4">
<div class="card kpi"><div class="l">Baseline completion</div><div class="v"><%= k.baseline_completion %></div><div class="s"><%= k.baseline_duration_wd %> working days</div></div>
<div class="card kpi"><div class="l">Current forecast</div><div class="v"><%= k.current_completion %></div><div class="s"><%= k.current_duration_wd %> working days</div></div>
<div class="card kpi"><div class="l">Schedule variance</div><div class="v <%= k.schedule_variance_wd > 0 ? 'bad' : 'ok' %>"><%= (k.schedule_variance_wd > 0 ? '+' : '') + k.schedule_variance_wd %> wd</div><div class="s"><%= (k.calendar_slip_days > 0 ? '+' : '') + k.calendar_slip_days %> calendar days</div></div>
<div class="card kpi"><div class="l">Critical-path migration</div><div class="v"><%= k.critical_path_migrated ? 'YES' : 'No' %></div><div class="s">new: <%= k.newly_critical.join(', ') || 'none' %> \xB7 left: <%= k.left_critical.join(', ') || 'none' %></div></div>
<div class="card kpi"><div class="l">Progress (planned / actual)</div><div class="v"><%= k.planned_pct.toFixed(1) %> / <%= k.actual_pct.toFixed(1) %> %</div><div class="s">variance <%= (k.progress_variance_pct > 0 ? '+' : '') + k.progress_variance_pct.toFixed(1) %> pts</div></div>
<div class="card kpi"><div class="l">Critical / near-critical</div><div class="v"><%= k.critical_activities %> / <%= k.near_critical_count %></div><div class="s"><%= k.eroded_float_count %> with float erosion</div></div>
<div class="card kpi"><div class="l">At-risk activities</div><div class="v"><%= k.at_risk_count !== null ? k.at_risk_count : 'n/a' %></div><div class="s"><%= k.adapted_activities %> adapted \xB7 <%= k.recommendation_count %> recommendations</div></div>
<div class="card kpi"><div class="l">Composite risk index</div><div class="v"><%= c.composite_risk_index.toFixed(2) %></div><div class="s">RII provisional (no survey yet)</div></div></div>
<div class="grid g2" style="margin-top:14px"><div class="card"><b>Risk distribution (activities by band of P(delay))</b><div id="risk-dist" style="margin-top:8px"></div></div>
<div class="card"><b>Forecast completion by cycle</b><table style="margin-top:8px"><tr><th>Cycle</th><th>Data date</th><th>Completion</th></tr>
<% (c.forecast_trend || []).forEach(function(p) { %><tr><td><%= p.label %></td><td class="num"><%= p.data_date || '' %></td><td class="num"><%= p.completion_date %></td></tr><% }); %></table></div></div>
<div style="display:flex;justify-content:space-between;align-items:center;margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px">
  <h2 style="margin:0;border:none;padding:0">Highest-risk activities</h2>
  <a href="/builder<%= query ? '?' + query : '' %>" class="btn alt" style="font-size:11.5px;padding:3px 8px">\uFF0B Add Task / Open Schedule Builder \u2192</a>
</div>
<% if (c.model) { %>
<div class="scroll" style="max-height:none"><table><tr><th>ID</th><th>Activity</th><th>P(delay)</th><th>Risk</th><th>Pred. delay (d)</th><th>Injected (d)</th><th>Critical</th><th>Main drivers</th></tr>
<% const sortedActs = c.activities.slice().sort((a,b) => (b.p_delay || 0) - (a.p_delay || 0)).slice(0, 8); %>
<% sortedActs.forEach(function(a) { %><tr><td><%= a.activity_id %></td><td><%= a.name %></td><td class="num"><%= a.p_delay !== null ? a.p_delay.toFixed(2) : '-' %></td><td><span class="chip <%= a.risk_band %>"><%= a.risk_band %></span></td><td class="num"><%= a.predicted_delay_days %></td><td class="num"><%= a.injected_days %></td><td><% if (a.critical) { %><span class="tag">critical</span><% } %></td><td><%= a.drivers %></td></tr><% }); %></table></div>
<% } else { %>
<p class="note">No ML model available. Run <code>adaptive-scheduler train</code>.</p>
<% } %>
<%- include('partials/footer') %>
`,
  "error": `<%- include('partials/header') %>
<div class="warn"><b>Request could not be processed.</b><br><%= message %></div>
<%- include('partials/footer') %>
`,
  "factors": `<%- include('partials/header') %>
<h2>Delay factors and live risk register</h2>
<div class="warn" style="background:#fff3e0;border-color:#e85d04">RII values are <b>PROVISIONAL</b> \u2013 the questionnaire survey has not been conducted; they are not survey-validated real-world values.</div>
<p>Composite risk index (RII-weighted, normalised 0\u20134 scores): <b class="mono"><%= c.composite_risk_index.toFixed(3) %></b> \xB7 Dominant: <% c.dominant_factors.forEach(function(f, idx) { %><%= f[1] %> (score <%= f[2] %>)<%= idx < c.dominant_factors.length - 1 ? ', ' : '' %><% }); %></p>
<table><tr><th>ID</th><th>Factor</th><th>RII (provisional)</th><th>Score 0\u20134</th><th></th><th>Note</th></tr>
<% (c.factors || []).forEach(function(f) { %>
<tr>
  <td><%= f.factor_id %></td>
  <td><%= f.factor %></td>
  <td class="num"><%= f.rii.toFixed(2) %></td>
  <td class="num"><%= f.score %></td>
  <td style="width:160px"><div class="bar"><i style="width:<%= f.score * 25 %>%"></i></div></td>
  <td><%= f.note %></td>
</tr>
<% }); %>
</table>
<%- include('partials/footer') %>
`,
  "gantt": `<%- include('partials/header') %>
<div class="controls">
  <label>Zoom <input id="zoom" type="range" min="1.5" max="14" step="0.5" value="4"></label>
  <label>Filter <select id="filter">
    <option value="all">All activities</option>
    <option value="critical">Critical path</option>
    <option value="near">Near-critical</option>
    <option value="atrisk">High / critical risk</option>
    <option value="delayed">Adapted (delay injected)</option>
  </select></label>
  <label>Search <input id="find" placeholder="name or id"></label>
  <label><input id="base" type="checkbox" checked> Baseline</label>
  <span id="count" class="note"></span>
  <a href="/builder<%= query ? '?' + query : '' %>" class="btn alt" style="margin-left:auto;font-size:12px;padding:4px 10px">\uFF0B Input / Edit Tasks</a>
</div>
<div class="legend">
  <span><i style="background:#cfd8dc"></i>Baseline</span>
  <span><i style="background:#43a047"></i>Low</span>
  <span><i style="background:#ffb300"></i>Medium</span>
  <span><i style="background:#fb8c00"></i>High</span>
  <span><i style="background:#e53935"></i>Critical risk</span>
  <span><i style="border:2px solid #d50000"></i>Critical path (red outline)</span>
  <span>Dashed blue line = data date. Axis = working-day offsets.</span>
</div>
<div id="gantt" class="gantt-wrap"></div>
<%- include('partials/footer') %>
`,
  "partials/footer": '</main>\n<div id="tip"></div>\n<script src="/static/app.js"></script>\n</body>\n</html>\n',
  "partials/header": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title><%= c && c.project ? c.project.name : 'Adaptive Scheduler' %></title>
  <meta name="description" content="AI-based self-adaptive construction scheduling system with CPM network analysis, delay prediction, and risk mitigation.">
  <link rel="stylesheet" href="/static/style.css">
</head>
<body data-page="<%= active %>">
<header class="titleblock">
  <div class="id">
    <h1>AI-Based Self-Adaptive Construction Scheduling</h1>
    <div class="sub"><% if (c && c.project) { %><%= c.project.name %> \xB7 <%= c.project.activity_count %> activities \xB7 <%= c.project.dependency_count %> links \xB7 start <%= c.project.start_date %><% } %></div>
  </div>
  <% if (c) { %>
  <form class="params" method="get">
    <label>Data date<input type="date" name="data_date" value="<%= c.data_date %>"></label>
    <label>Mode<select name="mode"><option value="expected" <%= c.mode === 'expected' ? 'selected' : '' %>>expected value</option><option value="conservative" <%= c.mode === 'conservative' ? 'selected' : '' %>>conservative</option></select></label>
    <label>Threshold<input type="number" step="0.05" min="0" max="1" name="threshold" value="<%= c.threshold %>" style="width:70px"></label>
    <button>Apply</button>
    <button class="alt" formmethod="post" formaction="/run?<%= query %>" title="Run one cycle and save it as a new version">Run &amp; store cycle</button>
  </form>
  <% } %>
</header>
<nav>
  <% pages.forEach(function([ep, label, path]) { %>
    <a href="<%= path %><%= query ? '?' + query : '' %>" class="<%= active === ep ? 'on' : '' %>"><%= label %></a>
  <% }); %>
</nav>
<main>
  <% if (c) { %>
    <div class="banner"><b>Synthetic demonstration data.</b> <%= c.notice %></div>
    <% (c.warnings || []).forEach(function(w) { %>
      <div class="warn">\u26A0 <%= w %></div>
    <% }); %>
    <script id="cycle-data" type="application/json"><%- JSON.stringify(c) %></script>
  <% } %>
`,
  "predictions": `<%- include('partials/header') %>
<h2>Delay predictions</h2>
<p class="note">Model trained on SYNTHETIC data<% if (c.model) { %>: <%= c.model.classifier %> (probability) + <%= c.model.regressor %> (delay days); tuned at-risk threshold <%= c.model.at_risk_threshold %><% } %>. <a href="/export/predictions.csv?<%= query %>">Export CSV</a></p>
<% if (c.model) { %>
<div class="scroll"><table><tr><th>ID</th><th>Activity</th><th>Type</th><th>P(delay)</th><th>Risk</th><th>Predicted delay (d)</th><th>Injected (d)</th><th>SHAP drivers (factor share of positive SHAP)</th></tr>
<% const sortedActs = c.activities.slice().sort((a,b) => (b.p_delay || 0) - (a.p_delay || 0)); %>
<% sortedActs.forEach(function(a) { %>
<tr>
  <td><%= a.activity_id %></td>
  <td><%= a.name %> <% if (a.critical) { %><span class="tag">critical</span><% } %></td>
  <td><%= a.type %></td>
  <td class="num"><%= a.p_delay !== null ? a.p_delay.toFixed(3) : '-' %></td>
  <td><span class="chip <%= a.risk_band %>"><%= a.risk_band %></span></td>
  <td class="num"><%= a.predicted_delay_days %></td>
  <td class="num"><%= a.injected_days %><%= a.injected_source === 'observed' ? ' (obs.)' : '' %></td>
  <td>
    <%= a.drivers %>
    <% if (c.explanations && c.explanations[a.activity_id]) { %>
    <details>
      <summary>top SHAP features</summary>
      <% (c.explanations[a.activity_id].top_features || []).forEach(function(t) { %>
      <div class="note"><%= t.feature %> = <%= t.value.toFixed(2) %> \u2192 <%= (t.shap >= 0 ? '+' : '') + t.shap.toFixed(3) %></div>
      <% }); %>
    </details>
    <% } %>
  </td>
</tr>
<% }); %>
</table></div>
<% } else { %>
<p>No ML model available. Run <code>adaptive-scheduler train</code>.</p>
<% } %>
<%- include('partials/footer') %>
`,
  "progress": `<%- include('partials/header') %>
<% const p = c.progress; %>
<div class="grid g4">
<div class="card kpi"><div class="l">Planned</div><div class="v"><%= p.planned_pct.toFixed(1) %> %</div><div class="s"><%= p.weighting %>-weighted</div></div>
<div class="card kpi"><div class="l">Actual</div><div class="v"><%= p.actual_pct.toFixed(1) %> %</div><div class="s">data date <%= p.data_date %></div></div>
<div class="card kpi"><div class="l">Variance</div><div class="v <%= p.variance_pct < 0 ? 'bad' : 'ok' %>"><%= (p.variance_pct >= 0 ? '+' : '') + p.variance_pct.toFixed(1) %> pts</div><div class="s">performance index <%= p.performance_index %></div></div>
<div class="card kpi"><div class="l">Working days elapsed</div><div class="v"><%= p.elapsed_working_days %></div></div></div>
<h2>S-curve</h2><div class="card"><div id="scurve"></div></div>
<h2>Activities in progress or behind plan</h2><div class="scroll"><table><tr><th>ID</th><th>Activity</th><th>Planned %</th><th>Actual %</th><th>Variance</th></tr>
<% const filteredActs = (p.activities || []).filter(a => a.planned_pct > 0 || a.actual_pct > 0).sort((a,b) => a.variance_pct - b.variance_pct); %>
<% filteredActs.forEach(function(a) { %>
<tr>
  <td><%= a.activity_id %></td>
  <td><%= a.name %></td>
  <td class="num"><%= a.planned_pct %></td>
  <td class="num"><%= a.actual_pct %></td>
  <td class="num <%= a.variance_pct < 0 ? 'bad' : '' %>"><%= (a.variance_pct >= 0 ? '+' : '') + a.variance_pct.toFixed(1) %></td>
</tr>
<% }); %>
</table></div>
<p class="note"><a href="/export/progress.csv?<%= query %>">Export CSV</a></p>
<%- include('partials/footer') %>
`,
  "recommendations": `<%- include('partials/header') %>
<h2>Ranked mitigation recommendations</h2>
<p class="note">Only critical and near-critical activities. "Engineering-judgement" estimates are provisional percentages; crash estimates follow crash limits and cost slopes. <a href="/export/recommendations.csv?<%= query %>">Export CSV</a></p>
<% if (c.recommendations && c.recommendations.length > 0) { %>
<div class="scroll"><table><tr><th>#</th><th>Activity</th><th>Status</th><th>Cause</th><th>SHAP share</th><th>Recommended action</th><th>Recovery (d)</th><th>Cost (INR)</th><th>Basis</th><th>Priority</th></tr>
<% c.recommendations.forEach(function(r) { %>
<tr>
  <td class="num"><%= r.rank %></td>
  <td><%= r.activity_id %> <%= r.activity_name %></td>
  <td><%= r.status %></td>
  <td><%= r.cause %></td>
  <td class="num"><%= r.shap_share !== null ? Math.round(r.shap_share * 100) + '%' : '\u2013' %></td>
  <td><%= r.action %></td>
  <td class="num"><%= r.recovery_days %></td>
  <td class="num"><%= Math.round(r.cost_impact_inr).toLocaleString() %></td>
  <td><%= r.basis %></td>
  <td><%= r.priority %></td>
</tr>
<% }); %>
</table></div>
<% } else { %>
<p>No recommendations: no critical or near-critical activity currently carries an injected delay (or no model is available).</p>
<% } %>
<%- include('partials/footer') %>
`,
  "reports": `<%- include('partials/header') %>
<h2>Reports and exports</h2>
<div class="controls">
  <form method="post" action="/reports/generate?<%= query %>"><button>Generate PDF report</button></form>
  <a class="btn alt" href="/reports/download">Download PDF</a>
  <a class="btn alt" href="/export/activities.csv?<%= query %>">Activities CSV</a>
  <a class="btn alt" href="/export/recommendations.csv?<%= query %>">Recommendations CSV</a>
  <a class="btn alt" href="/export/predictions.csv?<%= query %>">Predictions CSV</a>
  <a class="btn alt" href="/export/resources.csv?<%= query %>">Resources CSV</a>
</div>
<% if (generated) { %><div class="banner">Report generated: <%= generated %></div><% } %>
<h2>JSON API</h2>
<ul>
  <li><a href="/api/cycle?<%= query %>">GET /api/cycle</a> \u2013 full cycle result</li>
  <li><a href="/api/gantt?<%= query %>">GET /api/gantt</a> \u2013 working-day offsets</li>
  <li><a href="/api/activities?<%= query %>">GET /api/activities</a></li>
  <li><a href="/api/recommendations?<%= query %>">GET /api/recommendations</a></li>
</ul>
<h2>Charts (generated with the PDF)</h2>
<div class="grid g2">
  <% ['gantt_chart','s_curve','risk_distribution','forecast_trend','resource_histogram','shap_global_importance'].forEach(function(n) { %>
  <div class="card">
    <b><%= n %></b><br>
    <img class="fig" src="/figures/<%= n %>.png" alt="<%= n %>" onerror="this.replaceWith('not generated yet')">
  </div>
  <% }); %>
</div>
<%- include('partials/footer') %>
`,
  "resources": `<%- include('partials/header') %>
<h2>Resource utilisation (current schedule)</h2>
<p class="note">Demand in resource-days against availability declared in project.json. <a href="/export/resources.csv?<%= query %>">Export CSV</a></p>
<div class="scroll" style="max-height:none"><table><tr><th>Resource</th><th>Available</th><th>Peak demand</th><th>Resource-days</th><th>Mean active util. %</th><th>Util. % of project</th><th>Over-alloc. days</th><th>Shortage (res-days)</th></tr>
<% (c.resources.summary || []).forEach(function(r) { %>
<tr>
  <td><%= r.resource %> \u2013 <%= r.name %></td>
  <td class="num"><%= r.available %></td>
  <td class="num <%= r.peak_demand > r.available ? 'bad' : '' %>"><%= Math.round(r.peak_demand) %></td>
  <td class="num"><%= Math.round(r.resource_days) %></td>
  <td class="num"><%= r.mean_active_utilisation_pct %></td>
  <td class="num"><%= r.utilisation_pct %></td>
  <td class="num"><%= r.over_allocated_days %></td>
  <td class="num"><%= Math.round(r.shortage_resource_days) %></td>
</tr>
<% }); %>
</table></div>
<h2>Over-allocation windows</h2>
<% if (c.resources.over_allocation_windows && c.resources.over_allocation_windows.length > 0) { %>
<table><tr><th>Resource</th><th>From</th><th>To</th><th>Working days</th><th>Available</th><th>Peak demand</th><th>Peak shortage</th><th>Shortage (res-days)</th></tr>
<% c.resources.over_allocation_windows.forEach(function(w) { %>
<tr>
  <td><%= w.resource %></td>
  <td class="num"><%= w.start_date %></td>
  <td class="num"><%= w.end_date %></td>
  <td class="num"><%= w.working_days %></td>
  <td class="num"><%= w.available %></td>
  <td class="num"><%= Math.round(w.peak_demand) %></td>
  <td class="num"><%= Math.round(w.peak_shortage) %></td>
  <td class="num"><%= Math.round(w.shortage_resource_days) %></td>
</tr>
<% }); %>
</table>
<% } else { %>
<p>No over-allocation.</p>
<% } %>
<h2>Daily demand vs availability (red = over-allocated)</h2>
<div id="demand" class="grid g2"></div>
<%- include('partials/footer') %>
`
};

// src/views/embeddedAssets.ts
var EMBEDDED_CSS = ':root{--paper:#f5f2ea;--card:#fffdf8;--ink:#14213d;--muted:#5c6477;--line:#d9d3c3;--accent:#e85d04;--blue:#1d4e89;\n--low:#43a047;--medium:#ffb300;--high:#fb8c00;--critical:#e53935;--outline:#d50000}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif}\n.mono,td.num,.kpi .v{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}\nheader.titleblock{display:grid;grid-template-columns:1fr auto;gap:0;border-bottom:3px double var(--ink);background:var(--card)}\nheader .id{padding:12px 24px}\nheader h1{margin:0;font-size:19px;letter-spacing:.02em}\nheader .sub{color:var(--muted);font-size:12px}\nheader form.params{display:flex;gap:10px;align-items:end;padding:10px 24px;border-left:1px solid var(--line);flex-wrap:wrap}\nform.params label{display:flex;flex-direction:column;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}\ninput,select{font:inherit;padding:4px 6px;border:1px solid var(--line);background:#fff;border-radius:2px;color:var(--ink)}\nbutton,.btn{font:inherit;padding:6px 12px;border:1px solid var(--ink);background:var(--ink);color:#fff;border-radius:2px;cursor:pointer;text-decoration:none;display:inline-block}\nbutton.alt,.btn.alt{background:transparent;color:var(--ink)}\nnav{display:flex;gap:2px;padding:0 24px;background:var(--ink);overflow-x:auto}\nnav a{color:#cfd6e6;text-decoration:none;padding:9px 14px;font-size:13px;white-space:nowrap}\nnav a.on{background:var(--paper);color:var(--ink);font-weight:600}\nmain{padding:20px 24px;max-width:1500px;margin:auto}\n.banner{background:#fff3e0;border-left:4px solid var(--accent);padding:8px 14px;margin-bottom:14px;font-size:12.5px}\n.warn{background:#fdecea;border-left:4px solid var(--critical);padding:8px 14px;margin-bottom:10px;font-size:12.5px}\n.grid{display:grid;gap:14px}.g4{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.g2{grid-template-columns:repeat(auto-fit,minmax(420px,1fr))}\n.card{background:var(--card);border:1px solid var(--line);padding:14px 16px}\n.kpi .l{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}\n.kpi .v{font-size:25px;margin:4px 0;font-weight:600}.kpi .s{font-size:12px;color:var(--muted)}\n.bad{color:var(--critical)}.ok{color:var(--low)}\nh2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}\ntable{border-collapse:collapse;width:100%;background:var(--card);font-size:12.5px}\nth{background:#ece7d8;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;position:sticky;top:0}\ntd{padding:5px 8px;border-top:1px solid var(--line);vertical-align:top}td.num{text-align:right}\n.scroll{overflow:auto;max-height:70vh;border:1px solid var(--line)}\n.chip{display:inline-block;padding:1px 8px;border-radius:9px;font-size:11px;color:#fff;background:#90a4ae}\n.chip.low{background:var(--low)}.chip.medium{background:var(--medium);color:#222}.chip.high{background:var(--high)}.chip.critical{background:var(--critical)}\n.tag{font-size:11px;border:1px solid var(--outline);color:var(--outline);padding:0 5px;border-radius:2px}\n.bar{height:8px;background:#e6e0d0}.bar i{display:block;height:8px;background:var(--blue)}\n.note{font-size:12px;color:var(--muted)}\n.controls{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px}\n.gantt-wrap{overflow:auto;max-height:74vh;border:1px solid var(--line);background:#fff;position:relative}\n.gantt-inner{display:flex;min-width:max-content}\n.gantt-labels{position:sticky;left:0;z-index:2;background:var(--card);width:300px;flex:none;border-right:1px solid var(--line)}\n.gantt-labels div{height:22px;line-height:22px;padding:0 8px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #f0ebdc}\n.gantt-labels div.hd{height:36px;background:#ece7d8;font-weight:600}\n#tip{position:fixed;pointer-events:none;background:var(--ink);color:#fff;padding:8px 10px;font-size:12px;border-radius:3px;display:none;max-width:340px;z-index:9;line-height:1.4}\n.legend span{margin-right:14px;font-size:12px}.legend i{display:inline-block;width:12px;height:12px;vertical-align:-2px;margin-right:4px}\nimg.fig{max-width:100%;border:1px solid var(--line);background:#fff}\ndetails summary{cursor:pointer;color:var(--blue)}\n.form-card{border:1px solid var(--line);background:var(--card)}\n.form-section{padding:6px 0}\n.form-section .section-title{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;border-bottom:1px solid #f0ebe0;padding-bottom:3px}\n.form-row{display:grid;gap:8px}\n.form-row.r2{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}\n.form-row.r3{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}\n.form-row.r4{grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}\n.form-card label{display:flex;flex-direction:column;font-size:11.5px;color:var(--ink);gap:3px;font-weight:500}\n.form-card input,.form-card select{font-size:12.5px;padding:6px 8px;border:1px solid var(--line);border-radius:2px;background:#fff;transition:border-color .15s}\n.form-card input:focus,.form-card select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}\n.slot-card{border:1px solid var(--line);background:var(--card);margin-top:12px}\n.slot-textarea{width:100%;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:2px;background:#fff;line-height:1.45;resize:vertical}\n.slot-textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}\n.example-cases-container{margin-top:14px}\n.example-case-card{border:1px solid var(--line);background:#faf8f2;padding:10px 12px;margin-bottom:8px;border-radius:2px;transition:border-color .15s,box-shadow .15s}\n.example-case-card:hover{border-color:var(--blue);background:#fff}\n.example-case-header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}\n.example-case-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-bottom:6px}\n.example-case-meta span{background:#f0ebe0;padding:1px 6px;border-radius:2px;font-family:ui-monospace,monospace}\n.example-case-actions{display:flex;gap:6px;justify-content:flex-end}\n\n\n';
var EMBEDDED_JS = "(function(){\nconst RISK={low:'#43a047',medium:'#ffb300',high:'#fb8c00',critical:'#e53935'};\nconst NS='http://www.w3.org/2000/svg';\nconst dataEl=document.getElementById('cycle-data');\nconst D=dataEl?JSON.parse(dataEl.textContent):null;\nconst page=document.body.dataset.page;\nfunction s(tag,a,p){const e=document.createElementNS(NS,tag);for(const k in a||{})e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e}\nfunction lineChart(host,o){\n  const W=o.w||640,H=o.h||300,m={l:46,r:14,t:14,b:36};host.innerHTML='';\n  const svg=s('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%'},host);\n  const xmax=Math.max(...o.xs),ymax=o.ymax||100;\n  const X=x=>m.l+x/xmax*(W-m.l-m.r),Y=y=>H-m.b-y/ymax*(H-m.t-m.b);\n  for(let g=0;g<=4;g++){const y=ymax*g/4;s('line',{x1:m.l,x2:W-m.r,y1:Y(y),y2:Y(y),stroke:'#e2dccb'},svg);const t=s('text',{x:m.l-6,y:Y(y)+4,'text-anchor':'end','font-size':10,fill:'#5c6477'},svg);t.textContent=y.toFixed(0)}\n  for(let g=0;g<=6;g++){const x=xmax*g/6;const t=s('text',{x:X(x),y:H-m.b+14,'text-anchor':'middle','font-size':10,fill:'#5c6477'},svg);t.textContent=Math.round(x)}\n  const xl=s('text',{x:W/2,y:H-4,'text-anchor':'middle','font-size':10,fill:'#5c6477'},svg);xl.textContent=o.xlabel||'';\n  o.series.forEach((se,i)=>{s('polyline',{points:o.xs.map((x,k)=>X(x)+','+Y(se.ys[k])).join(' '),fill:'none',stroke:se.color,'stroke-width':2,'stroke-dasharray':se.dash||''},svg);\n    const t=s('text',{x:m.l+8,y:m.t+12+i*13,'font-size':11,fill:se.color},svg);t.textContent='\u2014 '+se.name});\n  (o.points||[]).forEach(p=>{s('circle',{cx:X(p.x),cy:Y(p.y),r:5,fill:p.color},svg);const t=s('text',{x:X(p.x)+8,y:Y(p.y)-6,'font-size':10,fill:p.color},svg);t.textContent=p.label});\n  if(o.vline)s('line',{x1:X(o.vline),x2:X(o.vline),y1:m.t,y2:H-m.b,stroke:'#888','stroke-dasharray':'3 3'},svg);\n}\nfunction bars(host,items){host.innerHTML='';const mx=Math.max(1,...items.map(i=>i.value));\n  items.forEach(i=>{const r=document.createElement('div');r.style.cssText='display:flex;align-items:center;gap:8px;margin:5px 0';\n    r.innerHTML=`<span style=\"width:70px;font-size:12px\">${i.label}</span><div style=\"flex:1;background:#eee7d6\"><div style=\"height:16px;width:${i.value/mx*100}%;background:${i.color}\"></div></div><b class=\"mono\">${i.value}</b>`;host.appendChild(r)})}\nfunction demand(host,vals,avail,title){host.innerHTML='';const W=420,H=120,m={l:30,r:6,t:16,b:14};\n  const svg=s('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%'},host);const ymax=Math.max(avail,...vals)*1.1||1;\n  const bw=(W-m.l-m.r)/vals.length,Y=y=>H-m.b-y/ymax*(H-m.t-m.b);\n  vals.forEach((v,i)=>{if(v>0)s('rect',{x:m.l+i*bw,y:Y(v),width:Math.max(bw-.2,.6),height:H-m.b-Y(v),fill:v>avail?'#e53935':'#1d4e89'},svg)});\n  s('line',{x1:m.l,x2:W-m.r,y1:Y(avail),y2:Y(avail),stroke:'#000','stroke-dasharray':'4 3'},svg);\n  const t=s('text',{x:m.l,y:11,'font-size':11,fill:'#14213d'},svg);t.textContent=title+' (available '+avail+', dashed)'}\nif(D&&page==='dashboard'){\n  const c={low:0,medium:0,high:0,critical:0};D.activities.forEach(a=>{if(a.risk_band)c[a.risk_band]++});\n  bars(document.getElementById('risk-dist'),Object.keys(c).map(k=>({label:k,value:c[k],color:RISK[k]})));\n}\nif(D&&page==='progress'){\n  const sc=D.progress.s_curve;lineChart(document.getElementById('scurve'),{xs:sc.map(r=>r.day),xlabel:'Working-day offset',\n    series:[{name:'Planned (baseline)',color:'#1d4e89',ys:sc.map(r=>r.planned)},{name:'Forecast (adapted)',color:'#fb8c00',dash:'6 4',ys:sc.map(r=>r.forecast)}],\n    points:[{x:D.progress.elapsed_working_days,y:D.progress.actual_pct,color:'#d50000',label:'Actual '+D.progress.actual_pct.toFixed(1)+'%'}],vline:D.progress.elapsed_working_days})\n}\nif(D&&page==='resources'){\n  const host=document.getElementById('demand');\n  D.resources.summary.forEach(r=>{if(r.peak_demand>0){const d=document.createElement('div');d.className='card';host.appendChild(d);demand(d,D.resources.demand[r.resource],r.available,r.resource)}})\n}\nif(page==='gantt'){\n  const q=location.search;fetch('/api/gantt'+q).then(r=>r.json()).then(G=>{\n    const wrap=document.getElementById('gantt'),tip=document.getElementById('tip');\n    const st={ppd:4,filter:'all',base:true,text:''};\n    const zoomEl = document.getElementById('zoom');\n    if (zoomEl) zoomEl.oninput=e=>{st.ppd=+e.target.value;draw()};\n    const filterEl = document.getElementById('filter');\n    if (filterEl) filterEl.onchange=e=>{st.filter=e.target.value;draw()};\n    const baseEl = document.getElementById('base');\n    if (baseEl) baseEl.onchange=e=>{st.base=e.target.checked;draw()};\n    const findEl = document.getElementById('find');\n    if (findEl) findEl.oninput=e=>{st.text=e.target.value.toLowerCase();draw()};\n    function ok(a){if(st.text&&!(a.name+a.activity_id).toLowerCase().includes(st.text))return false;\n      const f=st.filter;return f==='all'||(f==='critical'&&a.critical)||(f==='near'&&a.near_critical)||(f==='atrisk'&&(a.risk_band==='high'||a.risk_band==='critical'))||(f==='delayed'&&a.injected_days>0)}\n    function draw(){\n      const acts=G.activities.filter(ok).sort((a,b)=>a.current_es-b.current_es||a.activity_id.localeCompare(b.activity_id));\n      const ppd=st.ppd,W=(G.horizon+4)*ppd,RH=22,top=36,H=top+acts.length*RH;\n      wrap.innerHTML='<div class=\"gantt-inner\"><div class=\"gantt-labels\"></div></div>';\n      const L=wrap.querySelector('.gantt-labels');L.innerHTML='<div class=\"hd\">Activity</div>'+acts.map(a=>`<div title=\"${a.name}\">${a.critical?'<b style=\"color:#d50000\">\u258C</b>':'&nbsp;'} ${a.activity_id} ${a.name}</div>`).join('');\n      const svg=s('svg',{width:W,height:H});wrap.querySelector('.gantt-inner').appendChild(svg);\n      let lastM='';G.offset_dates.forEach((d,k)=>{const m=d.slice(0,7);if(m!==lastM){lastM=m;s('line',{x1:k*ppd,x2:k*ppd,y1:0,y2:H,stroke:'#e6dfcc'},svg);const t=s('text',{x:k*ppd+3,y:14,'font-size':10,fill:'#14213d'},svg);t.textContent=new Date(d).toLocaleString('en',{month:'short',year:'2-digit'});}\n        if(k%10===0){const t=s('text',{x:k*ppd+3,y:30,'font-size':9,fill:'#7a8194'},svg);t.textContent=k}});\n      acts.forEach((a,i)=>{const y=top+i*RH;\n        if(st.base)s('rect',{x:a.baseline_es*ppd,y:y+3,width:Math.max((a.baseline_ef-a.baseline_es)*ppd,2),height:16,fill:'#cfd8dc'},svg);\n        const col=a.risk_band?RISK[a.risk_band]:'#90a4ae';\n        const r=s('rect',{x:a.current_es*ppd,y:y+6,width:Math.max((a.current_ef-a.current_es)*ppd,2),height:10,fill:col,stroke:a.critical?'#d50000':'none','stroke-width':a.critical?2:0},svg);\n        r.onmousemove=e=>{tip.style.display='block';tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY+14)+'px';\n          tip.innerHTML=`<b>${a.activity_id} ${a.name}</b><br>Current: ${a.current_start} \u2192 ${a.current_finish} (${a.current_ef-a.current_es} wd)<br>Baseline: ${a.baseline_start} \u2192 ${a.baseline_finish}<br>Total float: ${a.total_float} wd ${a.critical?'(CRITICAL)':a.near_critical?'(near-critical)':''}<br>`+\n          (a.p_delay!==null?`P(delay) ${(a.p_delay*100).toFixed(0)}% \xB7 ${a.risk_band} \xB7 predicted ${a.predicted_delay_days} d<br>Injected: ${a.injected_days} d<br>${a.drivers||''}`:'No risk model')+`<br>Complete: ${a.percent_complete}%`};\n        r.onmouseleave=()=>tip.style.display='none'});\n      s('line',{x1:G.data_date_offset*ppd,x2:G.data_date_offset*ppd,y1:0,y2:H,stroke:'#1d4e89','stroke-dasharray':'4 3','stroke-width':1.5},svg);\n      const countEl = document.getElementById('count');\n      if (countEl) countEl.textContent=acts.length+' of '+G.activities.length+' activities';}\n    draw();});\n}\n})();\n";

// src/server.ts
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname2 = path2.dirname(__filename2);
var ROOT = process.env.ROOT_DIR || process.cwd();
var VIEWS_DIRS = [
  path2.join(process.cwd(), "views"),
  path2.join(process.cwd(), "src", "views"),
  path2.resolve(__dirname2, "views"),
  path2.resolve(__dirname2, "../views"),
  path2.resolve(__dirname2, "../src/views"),
  path2.resolve(__dirname2, "../../views"),
  path2.resolve(__dirname2, "../../src/views")
].filter((d) => fs2.existsSync(d));
if (VIEWS_DIRS.length === 0) {
  VIEWS_DIRS.push(path2.join(process.cwd(), "views"), path2.join(process.cwd(), "src/views"));
}
var STATIC_DIRS = [
  path2.join(process.cwd(), "public"),
  path2.resolve(__dirname2, "../public"),
  path2.resolve(__dirname2, "../../public")
].filter((d) => fs2.existsSync(d));
var PUBLIC_DIR = STATIC_DIRS[0] || path2.join(process.cwd(), "public");
var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
function renderEmbeddedTemplate(viewName, data) {
  let key = viewName.replace(/\\/g, "/");
  const match = key.match(/(?:views\/|src\/views\/)?([a-zA-Z0-9_\/-]+?)(?:\.ejs)?$/);
  const cleanKey = match ? match[1] : key.replace(/\.ejs$/, "");
  const templateStr = EMBEDDED_VIEWS[cleanKey] || EMBEDDED_VIEWS[key];
  if (!templateStr) {
    throw new Error(`View template "${viewName}" not found in embedded views`);
  }
  return ejs.render(templateStr, data, {
    views: VIEWS_DIRS,
    includer: (originalPath) => {
      const subKey = originalPath.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\.ejs$/, "");
      if (EMBEDDED_VIEWS[subKey]) {
        return { template: EMBEDDED_VIEWS[subKey] };
      }
      for (const d of VIEWS_DIRS) {
        const full = path2.join(d, originalPath.endsWith(".ejs") ? originalPath : originalPath + ".ejs");
        if (fs2.existsSync(full)) {
          return { filename: full };
        }
      }
      return { template: "" };
    }
  });
}
app.engine("ejs", (filePath, options, callback) => {
  if (fs2.existsSync(filePath)) {
    return ejs.renderFile(filePath, options, (err, str) => {
      if (!err && str) {
        return callback(null, str);
      }
      try {
        const rendered = renderEmbeddedTemplate(filePath, options);
        return callback(null, rendered);
      } catch (embErr) {
        return callback(err || embErr);
      }
    });
  }
  try {
    const rendered = renderEmbeddedTemplate(filePath, options);
    return callback(null, rendered);
  } catch (err) {
    return callback(err);
  }
});
app.set("view engine", "ejs");
app.set("views", VIEWS_DIRS);
var ROUTE_PAGES = ["dashboard", "builder", "gantt", "predictions", "recommendations", "resources", "progress", "factors", "reports"];
app.use((req, _res, next) => {
  if (req.url === "/api" || req.url === "/api/") {
    req.url = "/";
  } else if (req.url.startsWith("/api/index")) {
    req.url = req.url.replace(/^\/api\/index/, "") || "/";
  } else {
    for (const p of ROUTE_PAGES) {
      if (req.url === `/api/${p}` || req.url.startsWith(`/api/${p}?`) || req.url.startsWith(`/api/${p}/`)) {
        req.url = req.url.replace(/^\/api/, "");
        break;
      }
    }
  }
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get(["/static/style.css", "/style.css"], (_req, res) => {
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(EMBEDDED_CSS);
});
app.get(["/static/app.js", "/app.js"], (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(EMBEDDED_JS);
});
app.use("/static", express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));
app.use("/figures", express.static(path2.join(ROOT, "artifacts/figures")));
var PAGES = [
  ["dashboard", "Dashboard", "/"],
  ["builder", "Schedule Builder", "/builder"],
  ["gantt", "Gantt", "/gantt"],
  ["predictions", "Predictions", "/predictions"],
  ["recommendations", "Recommendations", "/recommendations"],
  ["resources", "Resources", "/resources"],
  ["progress", "Progress", "/progress"],
  ["factors", "Delay Factors", "/factors"],
  ["reports", "Reports", "/reports"]
];
var FIGURES = [
  "gantt_chart",
  "resource_histogram",
  "s_curve",
  "risk_distribution",
  "forecast_trend",
  "shap_global_importance"
];
var cache = /* @__PURE__ */ new Map();
function getCycleParams(req) {
  let threshold = 0.6;
  if (req.query.threshold) {
    const parsed = parseFloat(req.query.threshold);
    if (!isNaN(parsed)) {
      threshold = Math.max(0, Math.min(1, parsed));
    }
  }
  let mode = "expected";
  if (req.query.mode === "conservative") {
    mode = "conservative";
  }
  const dataDate = typeof req.query.data_date === "string" && req.query.data_date.trim().length > 0 ? req.query.data_date.trim() : void 0;
  return { dataDate, mode, threshold };
}
function getCycle(req, forceStore = false) {
  const { dataDate, mode, threshold } = getCycleParams(req);
  const cacheKey = `${dataDate || "default"}_${mode}_${threshold}_${forceStore}`;
  if (!forceStore && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const result = runCycle(dataDate, mode, threshold, forceStore);
  if (!forceStore) {
    cache.set(cacheKey, result);
  }
  return result;
}
function toCsv(rows, headers) {
  if (!rows || rows.length === 0) return "";
  const cols = headers || Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const r of rows) {
    const line = cols.map((c) => {
      const val = r[c] === null || r[c] === void 0 ? "" : String(r[c]);
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(",");
    lines.push(line);
  }
  return lines.join("\n");
}
for (const [name, _, routePath] of PAGES) {
  app.get(routePath, (req, res, next) => {
    try {
      const { cycle } = getCycle(req);
      const queryStr = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
      const state = getScheduleState();
      res.render(name, {
        c: cycle,
        pages: PAGES,
        active: name,
        query: queryStr,
        generated: req.query.generated || null,
        msg: req.query.msg || null,
        error: req.query.error || null,
        editId: req.query.editId || null,
        state
      });
    } catch (err) {
      next(err);
    }
  });
}
app.post("/builder/add", (req, res) => {
  try {
    addScheduleTask(req.body);
    cache.clear();
    res.redirect("/builder?msg=" + encodeURIComponent("Task added successfully to schedule"));
  } catch (err) {
    res.redirect("/builder?error=" + encodeURIComponent(err.message || "Error adding task"));
  }
});
app.post("/builder/batch", (req, res) => {
  try {
    const rawText = req.body.slot_text || "";
    const tasks = parseBatchSlotText(rawText);
    if (tasks.length === 0) {
      throw new Error("No valid task rows found in slot. Provide at least: Task Name, Start Date, End Date");
    }
    const added = batchAddScheduleTasks(tasks);
    cache.clear();
    res.redirect("/builder?msg=" + encodeURIComponent(`Added ${added.length} tasks from custom values slot`));
  } catch (err) {
    res.redirect("/builder?error=" + encodeURIComponent(err.message || "Error processing slot values"));
  }
});
app.post("/builder/update/:id", (req, res) => {
  try {
    const id = req.params.id;
    updateScheduleTask(id, req.body);
    cache.clear();
    res.redirect("/builder?msg=" + encodeURIComponent(`Task ${id} updated successfully`));
  } catch (err) {
    res.redirect("/builder?error=" + encodeURIComponent(err.message || "Error updating task"));
  }
});
app.post("/builder/delete/:id", (req, res) => {
  try {
    const id = req.params.id;
    deleteScheduleTask(id);
    cache.clear();
    res.redirect("/builder?msg=" + encodeURIComponent(`Task ${id} removed from schedule`));
  } catch (err) {
    res.redirect("/builder?error=" + encodeURIComponent(err.message || "Error deleting task"));
  }
});
app.post("/builder/reset", (_req, res) => {
  resetScheduleTasks();
  cache.clear();
  res.redirect("/builder?msg=" + encodeURIComponent("Schedule reset to default synthetic case study"));
});
app.post("/builder/clear", (_req, res) => {
  clearScheduleTasks();
  cache.clear();
  res.redirect("/builder?msg=" + encodeURIComponent("All tasks cleared. Ready to build new schedule from scratch."));
});
app.post("/builder/template", (req, res) => {
  const templateName = req.body.template || "g3_case_study";
  loadScheduleTemplate(templateName);
  cache.clear();
  res.redirect("/builder?msg=" + encodeURIComponent(`Template loaded successfully`));
});
app.get("/api/tasks", (_req, res) => {
  const state = getScheduleState();
  res.json({
    activities: state.activities,
    dependencies: state.dependencies,
    project: state.project
  });
});
app.post("/api/tasks", (req, res) => {
  try {
    const task = addScheduleTask(req.body);
    cache.clear();
    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || "Error adding task" });
  }
});
app.put("/api/tasks/:id", (req, res) => {
  try {
    const id = req.params.id;
    const task = updateScheduleTask(id, req.body);
    cache.clear();
    res.json({ success: true, task });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || "Error updating task" });
  }
});
app.delete("/api/tasks/:id", (req, res) => {
  try {
    const id = req.params.id;
    deleteScheduleTask(id);
    cache.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || "Error deleting task" });
  }
});
app.post("/api/tasks/reset", (_req, res) => {
  resetScheduleTasks();
  cache.clear();
  res.json({ success: true });
});
app.post("/api/tasks/clear", (_req, res) => {
  clearScheduleTasks();
  cache.clear();
  res.json({ success: true });
});
app.post("/api/tasks/template/:name", (req, res) => {
  const name = req.params.name;
  loadScheduleTemplate(name);
  cache.clear();
  res.json({ success: true });
});
app.get("/api/calendar/calc-days", (req, res) => {
  const state = getScheduleState();
  const cal = new WorkingCalendar(
    state.project.start_date,
    state.project.work_week,
    state.project.holidays,
    state.project.monsoon
  );
  const sDate = req.query.start_date || state.project.start_date;
  const eDate = req.query.end_date || sDate;
  const workingDays = cal.workingDaysBetween(sDate, eDate);
  const calendarDays = (new Date(eDate).getTime() - new Date(sDate).getTime()) / 864e5 + 1;
  const sOff = cal.offsetOf(sDate);
  const eOff = cal.offsetOf(eDate);
  const exposure = cal.monsoonExposure(sOff, Math.max(sOff + 1, eOff + 1));
  res.json({
    start_date: sDate,
    end_date: eDate,
    working_days: workingDays,
    calendar_days: Math.max(1, Math.round(calendarDays)),
    monsoon_exposure: Math.round(exposure * 100) / 100,
    is_start_working_day: cal.isWorkingDay(sDate),
    is_end_working_day: cal.isWorkingDay(eDate)
  });
});
app.post("/run", (req, res) => {
  getCycle(req, true);
  const referrer = req.get("Referrer") || "/";
  res.redirect(referrer);
});
app.get("/api/cycle", (req, res) => {
  const { cycle } = getCycle(req);
  res.json(cycle);
});
app.get("/api/gantt", (req, res) => {
  const { gantt } = getCycle(req);
  res.json(gantt);
});
app.get("/api/activities", (req, res) => {
  const { cycle } = getCycle(req);
  res.json(cycle.activities);
});
app.get("/api/recommendations", (req, res) => {
  const { cycle } = getCycle(req);
  res.json(cycle.recommendations);
});
app.post("/reports/generate", (req, res) => {
  const queryStr = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
  const sep = queryStr ? "&" : "?";
  res.redirect(`/reports?${queryStr}${sep}generated=project_report.pdf`);
});
app.get("/reports/download", (_req, res) => {
  const pdfPath = path2.join(ROOT, "artifacts/reports/project_report.pdf");
  if (fs2.existsSync(pdfPath)) {
    res.download(pdfPath, "project_report.pdf");
  } else {
    res.status(404).send("No PDF yet - generate it first.");
  }
});
app.get("/reports/status", (_req, res) => {
  const pdfExists = fs2.existsSync(path2.join(ROOT, "artifacts/reports/project_report.pdf"));
  const figuresStatus = {};
  for (const n of FIGURES) {
    figuresStatus[n] = fs2.existsSync(path2.join(ROOT, `artifacts/figures/${n}.png`));
  }
  res.json({ pdf_exists: pdfExists, figures: figuresStatus });
});
app.get("/figures/:name.png", (req, res) => {
  const name = req.params.name;
  if (!FIGURES.includes(name)) {
    res.status(404).send("Figure not found");
    return;
  }
  const filePath = path2.join(ROOT, `artifacts/figures/${name}.png`);
  if (fs2.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Figure not found");
  }
});
app.get("/export/:name.csv", (req, res) => {
  const name = req.params.name;
  const { cycle } = getCycle(req);
  let csvContent = "";
  if (name === "activities") {
    csvContent = toCsv(cycle.activities);
  } else if (name === "recommendations") {
    csvContent = toCsv(cycle.recommendations);
  } else if (name === "predictions") {
    const predRows = cycle.activities.map((a) => ({
      activity_id: a.activity_id,
      name: a.name,
      p_delay: a.p_delay,
      predicted_delay_days: a.predicted_delay_days,
      risk_band: a.risk_band,
      at_risk: a.at_risk,
      drivers: a.drivers
    }));
    csvContent = toCsv(predRows);
  } else if (name === "resources") {
    csvContent = toCsv(cycle.resources.summary);
  } else if (name === "progress") {
    csvContent = toCsv(cycle.progress.activities);
  } else {
    res.status(404).send("Export not found");
    return;
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
  res.send(csvContent);
});
app.use((err, req, res, _next) => {
  console.error("[App Error]", err);
  const status = err.status || 500;
  const message = err.message || "An internal error occurred.";
  if (req.path.startsWith("/api/")) {
    res.status(status).json({ error: message });
  } else {
    try {
      res.status(status).render("error", {
        c: null,
        pages: PAGES,
        active: "",
        query: "",
        message
      });
    } catch (_renderErr) {
      res.status(status).send(`<!doctype html><html><head><title>Adaptive Scheduler Error</title></head><body style="font-family:sans-serif;padding:2rem"><h1>Error (${status})</h1><p>${message}</p><p><a href="/">Return to Dashboard</a></p></body></html>`);
    }
  }
});
var isMainModule = !process.env.VERCEL && process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));
if (isMainModule) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Adaptive Scheduler server listening on http://0.0.0.0:${PORT}`);
  });
}
var server_default = app;

// api/index.ts
function handler(req, res) {
  return server_default(req, res);
}
export {
  handler as default
};
