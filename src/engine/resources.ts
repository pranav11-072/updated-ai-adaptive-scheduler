import { Activity, CPMResult, ProjectMetadata } from './models';
import { WorkingCalendar } from './calendar';

export interface ResourceSummary {
  resource: string;
  name: string;
  available: number;
  peak_demand: number;
  resource_days: number;
  active_days: number;
  mean_active_demand: number;
  mean_active_utilisation_pct: number;
  utilisation_pct: number;
  over_allocated_days: number;
  shortage_resource_days: number;
}

export interface OverAllocationWindow {
  resource: string;
  start_offset: number;
  end_offset: number;
  start_date: string;
  end_date: string;
  working_days: number;
  available: number;
  peak_demand: number;
  peak_shortage: number;
  shortage_resource_days: number;
}

export interface FloorProgressItem {
  floor: string;
  activity_count: number;
  planned_pct: number;
  actual_pct: number;
  variance_pct: number;
  critical_count: number;
}

export interface ProgressResult {
  data_date: string;
  elapsed_working_days: number;
  weighting: string;
  planned_pct: number;
  actual_pct: number;
  variance_pct: number;
  performance_index: number | null;
  s_curve: Array<{ day: number; planned: number; forecast: number }>;
  activities: Array<{ activity_id: string; name: string; planned_pct: number; actual_pct: number; variance_pct: number }>;
  floor_progress: FloorProgressItem[];
}

export function computeDailyDemand(
  activities: Activity[],
  schedule: CPMResult,
  declaredResources: Record<string, { name: string; available: number }>
): {
  demand: Record<string, number[]>;
  summary: ResourceSummary[];
  windows: OverAllocationWindow[];
} {
  const horizon = Math.max(schedule.project_duration, 1);
  const resourceCodes = Array.from(new Set([
    ...Object.keys(declaredResources),
    ...activities.map(a => a.resource).filter(Boolean)
  ])).sort();

  const demand: Record<string, number[]> = {};
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

  const summary: ResourceSummary[] = [];
  const windows: OverAllocationWindow[] = [];

  for (const code of resourceCodes) {
    const d = demand[code];
    const avail = declaredResources[code]?.available || 0;
    const name = declaredResources[code]?.name || code;

    let peak = 0;
    let total = 0;
    let activeDays = 0;
    let overAllocDays = 0;
    let shortage = 0;

    for (let t = 0; t < horizon; t++) {
      const v = d[t];
      if (v > peak) peak = v;
      total += v;
      if (v > 0) activeDays++;
      if (v > avail) {
        overAllocDays++;
        shortage += (v - avail);
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
      mean_active_utilisation_pct: avail > 0 && activeDays > 0 ? Math.round((100 * meanActive / avail) * 10) / 10 : 0,
      utilisation_pct: avail > 0 && horizon > 0 ? Math.round((100 * total / (avail * horizon)) * 10) / 10 : 0,
      over_allocated_days: overAllocDays,
      shortage_resource_days: shortage
    });

    // Detect over-allocation windows
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
        winShortage += (d[k] - avail);
      }
      windows.push({
        resource: code,
        start_offset: t,
        end_offset: u,
        start_date: schedule.start_of(activities[0].activity_id), // placeholder, updated in pipeline with cal.dateOf
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

export function computeProgress(
  activities: Activity[],
  baseline: CPMResult,
  current: CPMResult,
  calendar: WorkingCalendar,
  dataDateStr: string,
  weighting = 'duration'
): ProgressResult {
  const t = calendar.elapsedDays(dataDateStr);
  const weights = activities.map(a => weighting === 'quantity' && a.quantity > 0 ? a.quantity : a.duration);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

  function fraction(es: number, dur: number, day: number): number {
    if (dur <= 0) return day >= es ? 1.0 : 0.0;
    if (day <= es) return 0.0;
    if (day >= es + dur) return 1.0;
    return (day - es) / dur;
  }

  let plannedNumerator = 0;
  let actualNumerator = 0;
  const actTable: Array<{ activity_id: string; name: string; planned_pct: number; actual_pct: number; variance_pct: number }> = [];

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    const s = baseline.schedules[a.activity_id];
    const plannedFrac = fraction(s.es, s.duration, t);
    const actualFrac = (a.percent_complete || 0) / 100.0;
    const w = weights[i];

    plannedNumerator += w * plannedFrac;
    actualNumerator += w * actualFrac;

    const pPct = Math.round(plannedFrac * 1000) / 10;
    const aPct = Math.round(actualFrac * 1000) / 10;
    actTable.push({
      activity_id: a.activity_id,
      name: a.name,
      planned_pct: pPct,
      actual_pct: aPct,
      variance_pct: Math.round((aPct - pPct) * 10) / 10
    });
  }

  const planned = Math.round((plannedNumerator / totalWeight) * 10000) / 100;
  const actual = Math.round((actualNumerator / totalWeight) * 10000) / 100;
  const variance = Math.round((actual - planned) * 100) / 100;
  const perfIdx = planned > 0 ? Math.round((actual / planned) * 1000) / 1000 : null;

  const horizon = Math.max(baseline.project_duration, current.project_duration);
  const scurve: Array<{ day: number; planned: number; forecast: number }> = [];

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
      planned: Math.round((pNum / totalWeight) * 1000) / 10,
      forecast: Math.round((fNum / totalWeight) * 1000) / 10
    });
  }

  // Floor-wise progress calculation
  const floorMap = new Map<string, { weight: number; plannedNum: number; actualNum: number; count: number; critical: number }>();
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    const s = baseline.schedules[a.activity_id];
    const sc = current.schedules[a.activity_id];
    const fl = a.floor || 'General';
    const w = weights[i];
    const plannedFrac = fraction(s.es, s.duration, t);
    const actualFrac = (a.percent_complete || 0) / 100.0;
    const isCrit = sc ? sc.critical : false;

    if (!floorMap.has(fl)) {
      floorMap.set(fl, { weight: 0, plannedNum: 0, actualNum: 0, count: 0, critical: 0 });
    }
    const entry = floorMap.get(fl)!;
    entry.weight += w;
    entry.plannedNum += w * plannedFrac;
    entry.actualNum += w * actualFrac;
    entry.count++;
    if (isCrit) entry.critical++;
  }

  const floorProgress: FloorProgressItem[] = [];
  for (const [fl, data] of floorMap.entries()) {
    const pP = data.weight > 0 ? Math.round((data.plannedNum / data.weight) * 1000) / 10 : 0;
    const aP = data.weight > 0 ? Math.round((data.actualNum / data.weight) * 1000) / 10 : 0;
    floorProgress.push({
      floor: fl,
      activity_count: data.count,
      planned_pct: pP,
      actual_pct: aP,
      variance_pct: Math.round((aP - pP) * 10) / 10,
      critical_count: data.critical
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
    activities: actTable,
    floor_progress: floorProgress
  };
}
