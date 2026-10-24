import { Activity, CPMResult } from './models';
import { WorkingCalendar } from './calendar';
import { getRiskBandBoundaries } from './prediction';

export interface EVMMetrics {
  planned_value: number;          // PV (INR)
  earned_value: number;           // EV (INR)
  actual_cost: number;            // AC (INR)
  schedule_variance: number;      // SV = EV - PV (INR)
  cost_variance: number;          // CV = EV - AC (INR)
  schedule_variance_days: number; // SV in working days = forecast duration - baseline duration
  spi: number;                    // SPI = EV / PV (Schedule Performance Index)
  cpi: number;                    // CPI = EV / AC (Cost Performance Index)
  schedule_status: 'Ahead' | 'On Schedule' | 'Behind';
  cost_status: 'Under Budget' | 'On Budget' | 'Over Budget';
  budget_at_completion: number;   // BAC = total planned budget (INR)
  estimate_at_completion: number; // EAC = BAC / CPI (INR)
  variance_at_completion: number; // VAC = BAC - EAC (INR)
}

export interface ActivityStatusDistribution {
  not_started: number;
  in_progress: number;
  completed: number;
  critical: number;
  near_critical: number;
  delayed: number;
  total: number;
  not_started_pct: number;
  in_progress_pct: number;
  completed_pct: number;
}

export interface FloorAnalyticsItem {
  floor: string;
  total_activities: number;
  completed_activities: number;
  in_progress_activities: number;
  not_started_activities: number;
  critical_activities: number;
  delayed_activities: number;
  total_duration_wd: number;
  planned_pct: number;
  actual_pct: number;
  variance_pct: number;
  budget: number;
  earned_value: number;
}

export interface AnalyticsResult {
  evm: EVMMetrics;
  status_distribution: ActivityStatusDistribution;
  floor_analytics: FloorAnalyticsItem[];
  risk_distribution: Record<'low' | 'medium' | 'high' | 'critical', number>;
  risk_bands?: {
    low: string;
    medium: string;
    high: string;
    critical: string;
  };
  threshold: number;
}

/**
 * Calculates Earned Value Management (EVM) metrics based on project cost and schedules.
 */
export function computeEVM(
  activities: Activity[],
  baseline: CPMResult,
  current: CPMResult,
  calendar: WorkingCalendar,
  dataDateStr: string
): EVMMetrics {
  const t = calendar.elapsedDays(dataDateStr);
  let bac = 0;
  let pv = 0;
  let ev = 0;
  let ac = 0;

  for (const a of activities) {
    const cost = a.normal_cost > 0 ? a.normal_cost : (a.duration * 5000); // realistic fallback cost if unpriced
    bac += cost;

    const s = baseline.schedules[a.activity_id];
    let plannedFraction = 0;
    if (s) {
      if (s.duration <= 0) {
        plannedFraction = t >= s.es ? 1.0 : 0.0;
      } else if (t <= s.es) {
        plannedFraction = 0.0;
      } else if (t >= s.ef) {
        plannedFraction = 1.0;
      } else {
        plannedFraction = (t - s.es) / s.duration;
      }
    }
    pv += cost * plannedFraction;

    const actualFraction = Math.min(1.0, Math.max(0.0, (a.percent_complete || 0) / 100.0));
    ev += cost * actualFraction;

    // Actual cost accounts for work completed plus observed delay overhead
    const delayOverrun = a.actual_delay_days > 0 ? (a.cost_slope > 0 ? a.cost_slope * a.actual_delay_days : a.actual_delay_days * 3500) : 0;
    ac += (cost * actualFraction) + delayOverrun;
  }

  pv = Math.round(pv);
  ev = Math.round(ev);
  ac = Math.round(ac);
  bac = Math.round(bac);

  const sv = ev - pv;
  const cv = ev - ac;
  const svDays = current.project_duration - baseline.project_duration;

  const spi = pv > 0 ? Math.round((ev / pv) * 1000) / 1000 : 1.0;
  const cpi = ac > 0 ? Math.round((ev / ac) * 1000) / 1000 : 1.0;

  const eac = cpi > 0 ? Math.round(bac / cpi) : bac;
  const vac = bac - eac;

  let scheduleStatus: 'Ahead' | 'On Schedule' | 'Behind' = 'On Schedule';
  if (spi > 1.02) scheduleStatus = 'Ahead';
  else if (spi < 0.98) scheduleStatus = 'Behind';

  let costStatus: 'Under Budget' | 'On Budget' | 'Over Budget' = 'On Budget';
  if (cpi > 1.02) costStatus = 'Under Budget';
  else if (cpi < 0.98) costStatus = 'Over Budget';

  return {
    planned_value: pv,
    earned_value: ev,
    actual_cost: ac,
    schedule_variance: sv,
    cost_variance: cv,
    schedule_variance_days: svDays,
    spi,
    cpi,
    schedule_status: scheduleStatus,
    cost_status: costStatus,
    budget_at_completion: bac,
    estimate_at_completion: eac,
    variance_at_completion: vac
  };
}

/**
 * Calculates activity completion and status distribution metrics.
 */
export function computeActivityStatusDistribution(
  activities: Activity[],
  current: CPMResult,
  injectedDelays: Record<string, { days: number; source: string }> = {}
): ActivityStatusDistribution {
  let notStarted = 0;
  let inProgress = 0;
  let completed = 0;
  let critical = 0;
  let nearCritical = 0;
  let delayed = 0;
  const total = activities.length;

  for (const a of activities) {
    const pct = a.percent_complete || 0;
    if (pct >= 100) {
      completed++;
    } else if (pct > 0) {
      inProgress++;
    } else {
      notStarted++;
    }

    const s = current.schedules[a.activity_id];
    if (s) {
      if (s.critical) critical++;
      else if (s.total_float > 0 && s.total_float <= 5) nearCritical++;
    }

    const hasInjected = injectedDelays[a.activity_id] && injectedDelays[a.activity_id].days > 0;
    const hasActualDelay = a.actual_delay_days > 0;
    if (hasInjected || hasActualDelay) {
      delayed++;
    }
  }

  return {
    not_started: notStarted,
    in_progress: inProgress,
    completed,
    critical,
    near_critical: nearCritical,
    delayed,
    total,
    not_started_pct: total > 0 ? Math.round((notStarted / total) * 1000) / 10 : 0,
    in_progress_pct: total > 0 ? Math.round((inProgress / total) * 1000) / 10 : 0,
    completed_pct: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0
  };
}

/**
 * Custom sort order for floor tags:
 * Basements (B5..B1) -> Substructure -> Ground Floor (GF) -> Above ground (1F..60F) -> Terrace -> Finishes -> External -> General
 */
function floorRank(fl: string): number {
  if (fl.startsWith('B')) {
    const num = parseInt(fl.slice(1), 10);
    return isNaN(num) ? 5 : 10 - num; // B2 before B1
  }
  if (fl.toLowerCase().includes('substructure') || fl.toLowerCase().includes('foundation')) return 20;
  if (fl === 'GF' || fl.toLowerCase().includes('ground')) return 30;
  if (fl.endsWith('F')) {
    const num = parseInt(fl.slice(0, -1), 10);
    return isNaN(num) ? 50 : 100 + num; // 1F, 2F, etc.
  }
  if (fl.toLowerCase().includes('terrace') || fl.toLowerCase().includes('roof')) return 500;
  if (fl.toLowerCase().includes('finish')) return 600;
  if (fl.toLowerCase().includes('external')) return 700;
  return 800;
}

/**
 * Calculates floor-wise progress, duration, critical tasks, and budget analytics.
 */
export function computeFloorAnalytics(
  activities: Activity[],
  baseline: CPMResult,
  current: CPMResult,
  calendar: WorkingCalendar,
  dataDateStr: string
): FloorAnalyticsItem[] {
  const t = calendar.elapsedDays(dataDateStr);
  const floorMap = new Map<string, {
    total: number;
    completed: number;
    in_progress: number;
    not_started: number;
    critical: number;
    delayed: number;
    total_dur: number;
    budget: number;
    earned_value: number;
    weight: number;
    planned_weight: number;
    actual_weight: number;
  }>();

  for (const a of activities) {
    const fl = a.floor || 'General';
    if (!floorMap.has(fl)) {
      floorMap.set(fl, {
        total: 0,
        completed: 0,
        in_progress: 0,
        not_started: 0,
        critical: 0,
        delayed: 0,
        total_dur: 0,
        budget: 0,
        earned_value: 0,
        weight: 0,
        planned_weight: 0,
        actual_weight: 0
      });
    }

    const data = floorMap.get(fl)!;
    data.total++;
    data.total_dur += a.duration;
    const cost = a.normal_cost > 0 ? a.normal_cost : (a.duration * 5000);
    data.budget += cost;

    const pct = a.percent_complete || 0;
    if (pct >= 100) data.completed++;
    else if (pct > 0) data.in_progress++;
    else data.not_started++;

    const sCur = current.schedules[a.activity_id];
    if (sCur && sCur.critical) data.critical++;

    if (a.actual_delay_days > 0) data.delayed++;

    const sBase = baseline.schedules[a.activity_id];
    let pFrac = 0;
    if (sBase) {
      if (sBase.duration <= 0) pFrac = t >= sBase.es ? 1.0 : 0.0;
      else if (t <= sBase.es) pFrac = 0.0;
      else if (t >= sBase.ef) pFrac = 1.0;
      else pFrac = (t - sBase.es) / sBase.duration;
    }

    const aFrac = Math.min(1.0, Math.max(0.0, pct / 100.0));
    data.earned_value += cost * aFrac;

    const w = a.duration > 0 ? a.duration : 1;
    data.weight += w;
    data.planned_weight += w * pFrac;
    data.actual_weight += w * aFrac;
  }

  const items: FloorAnalyticsItem[] = [];
  for (const [fl, data] of floorMap.entries()) {
    const pPct = data.weight > 0 ? Math.round((data.planned_weight / data.weight) * 1000) / 10 : 0;
    const aPct = data.weight > 0 ? Math.round((data.actual_weight / data.weight) * 1000) / 10 : 0;
    items.push({
      floor: fl,
      total_activities: data.total,
      completed_activities: data.completed,
      in_progress_activities: data.in_progress,
      not_started_activities: data.not_started,
      critical_activities: data.critical,
      delayed_activities: data.delayed,
      total_duration_wd: data.total_dur,
      planned_pct: pPct,
      actual_pct: aPct,
      variance_pct: Math.round((aPct - pPct) * 10) / 10,
      budget: Math.round(data.budget),
      earned_value: Math.round(data.earned_value)
    });
  }

  return items.sort((a, b) => floorRank(a.floor) - floorRank(b.floor));
}

/**
 * Computes the centralized analytics suite for all charts and KPIs.
 */
export function computeAnalytics(
  activities: Activity[],
  baseline: CPMResult,
  current: CPMResult,
  calendar: WorkingCalendar,
  dataDateStr: string,
  injectedDelays: Record<string, { days: number; source: string }> = {},
  predictions: Record<string, { risk_band: 'low' | 'medium' | 'high' | 'critical' }> = {},
  threshold = 0.60
): AnalyticsResult {
  const evm = computeEVM(activities, baseline, current, calendar, dataDateStr);
  const statusDist = computeActivityStatusDistribution(activities, current, injectedDelays);
  const floorAnalytics = computeFloorAnalytics(activities, baseline, current, calendar, dataDateStr);

  const riskDist: Record<'low' | 'medium' | 'high' | 'critical', number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };

  for (const a of activities) {
    const pr = predictions[a.activity_id];
    if (pr && pr.risk_band && riskDist[pr.risk_band] !== undefined) {
      riskDist[pr.risk_band]++;
    } else {
      // Deterministic risk heuristic based on float if ML prediction unavailable
      const s = current.schedules[a.activity_id];
      if (s) {
        if (s.critical) riskDist.critical++;
        else if (s.total_float <= 5) riskDist.high++;
        else if (s.total_float <= 15) riskDist.medium++;
        else riskDist.low++;
      } else {
        riskDist.low++;
      }
    }
  }

  const boundaries = getRiskBandBoundaries(threshold);

  return {
    evm,
    status_distribution: statusDist,
    floor_analytics: floorAnalytics,
    risk_distribution: riskDist,
    risk_bands: {
      low: boundaries.low.label,
      medium: boundaries.medium.label,
      high: boundaries.high.label,
      critical: boundaries.critical.label
    },
    threshold
  };
}
