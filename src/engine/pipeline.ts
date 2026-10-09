import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Activity, Dependency, ProjectMetadata, ActivitySchedule } from './models';
import { WorkingCalendar } from './calendar';
import { CPMEngine } from './cpm';
import { RiskRegister, RII_STATUS } from './delayFactors';
import { computePredictionsAndExplanations, PredictionResult, ExplanationResult } from './prediction';
import { adapt, AdaptationResult } from './adaptation';
import { computeDailyDemand, computeProgress, ProgressResult, ResourceSummary, OverAllocationWindow } from './resources';
import { generateRecommendations, RecommendationRow } from './recommend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const PROJECT_DIR = path.join(ROOT, 'data/project');

export const SYNTHETIC_NOTICE =
  'All case-study data and all model training data are SYNTHETIC. Model scores measured on ' +
  'synthetic projects are NOT real-world validation. RII weights are PROVISIONAL ' +
  '(the questionnaire survey has not been conducted).';

function parseCSV(content: string): Array<Record<string, string>> {
  const lines = content.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];

  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let cur = '';
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
      } else if (ch === ',' && !inQuotes) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  const headers = splitLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] !== undefined ? cols[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

export function loadProjectData(projectDir = PROJECT_DIR): {
  project: ProjectMetadata;
  activities: Activity[];
  dependencies: Dependency[];
  riskRegister: RiskRegister;
} {
  const metaPath = path.join(projectDir, 'project.json');
  const actPath = path.join(projectDir, 'activities.csv');
  const depPath = path.join(projectDir, 'dependencies.csv');
  const factorPath = path.join(projectDir, 'delay_factor_status.csv');

  const metaRaw = fs.readFileSync(metaPath, 'utf-8');
  const meta: ProjectMetadata = JSON.parse(metaRaw);

  const actRaw = fs.readFileSync(actPath, 'utf-8');
  const actRows = parseCSV(actRaw);
  const activities: Activity[] = actRows.map(r => {
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

  const depRaw = fs.readFileSync(depPath, 'utf-8');
  const depRows = parseCSV(depRaw);
  const dependencies: Dependency[] = depRows.map(r => ({
    predecessor: r.predecessor,
    successor: r.successor,
    dep_type: (r.dep_type || 'FS') as any,
    lag: parseInt(r.lag, 10) || 0
  }));

  const factorScores: Record<string, number> = {};
  const factorNotes: Record<string, string> = {};
  if (fs.existsSync(factorPath)) {
    const factorRaw = fs.readFileSync(factorPath, 'utf-8');
    const factorRows = parseCSV(factorRaw);
    for (const r of factorRows) {
      factorScores[r.factor_id] = parseInt(r.score, 10) || 0;
      factorNotes[r.factor_id] = r.note || '';
    }
  }

  const register = new RiskRegister(factorScores, factorNotes);
  return { project: meta, activities, dependencies, riskRegister: register };
}

// In-memory store of cycle history
export interface CycleVersion {
  version_id: number;
  data_date: string;
  mode: string;
  threshold: number;
  completion_date: string;
  duration_wd: number;
  stored_at: string;
  kind: 'baseline' | 'adapted';
}

const historyStore: CycleVersion[] = [];

export interface CycleData {
  project: {
    project_id: string;
    name: string;
    start_date: string;
    location: string;
    data_source: string;
    activity_count: number;
    dependency_count: number;
  };
  data_date: string;
  mode: 'expected' | 'conservative';
  threshold: number;
  warnings: string[];
  notice: string;
  model: {
    classifier: string;
    regressor: string;
    at_risk_threshold: number;
    trained_on: string;
    feature_count: number;
  };
  kpis: {
    baseline_completion: string;
    current_completion: string;
    baseline_duration_wd: number;
    current_duration_wd: number;
    schedule_variance_wd: number;
    calendar_slip_days: number;
    critical_activities: number;
    newly_critical: string[];
    left_critical: string[];
    critical_path_migrated: boolean;
    near_critical_count: number;
    eroded_float_count: number;
    adapted_activities: number;
    at_risk_count: number;
    planned_pct: number;
    actual_pct: number;
    progress_variance_pct: number;
    recommendation_count: number;
  };
  critical_path: {
    baseline: string[];
    current: string[];
    newly_critical: string[];
    left_critical: string[];
    near_critical: string[];
    float_eroded: string[];
  };
  activities: Array<Record<string, any>>;
  recommendations: RecommendationRow[];
  resources: {
    summary: ResourceSummary[];
    over_allocation_windows: OverAllocationWindow[];
    demand: Record<string, number[]>;
  };
  explanations: Record<string, ExplanationResult>;
  progress: ProgressResult;
  factors: Array<{ factor_id: string; factor: string; rii: number; score: number; note: string }>;
  composite_risk_index: number;
  dominant_factors: Array<[string, string, number]>;
  rii_status: string;
  forecast_trend: Array<{ label: string; completion_date: string; data_date?: string }>;
  history: CycleVersion[];
  version: CycleVersion | null;
}

export function runCycle(
  dataDate?: string,
  mode: 'expected' | 'conservative' = 'expected',
  threshold = 0.60,
  forceStore = false
): { cycle: CycleData; gantt: any } {
  const { project, activities, dependencies, riskRegister } = loadProjectData();
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

  const engine = new CPMEngine(activities, dependencies, calendar);
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
  // fix window start/end dates with actual calendar dates
  for (const w of resDemand.windows) {
    w.start_date = calendar.dateOf(w.start_offset);
    w.end_date = calendar.dateOf(w.end_offset);
  }

  const progressData = computeProgress(activities, baseline, current, calendar, dd);
  const recommendations = generateRecommendations(activities, adaptation, explanations);

  const warnings: string[] = [];
  if (mode === 'expected' && Object.keys(adaptation.injected).length === 0) {
    warnings.push(`No activity reached P(delay) >= ${threshold.toFixed(2)}; the adapted schedule equals the baseline.`);
  }

  const actRows: Array<Record<string, any>> = [];
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
      injected_source: inj ? inj.source : '',
      p_delay: pr ? pr.p_delay : null,
      predicted_delay_days: pr ? pr.predicted_delay_days : null,
      risk_band: pr ? pr.risk_band : null,
      at_risk: pr ? pr.at_risk : false,
      drivers: pr ? pr.drivers : ''
    });
  }

  let currentVersion: CycleVersion | null = null;
  if (forceStore) {
    const vId = historyStore.length + 1;
    currentVersion = {
      version_id: vId,
      data_date: dd,
      mode,
      threshold,
      completion_date: current.completion_date,
      duration_wd: current.project_duration,
      stored_at: new Date().toISOString(),
      kind: 'adapted'
    };
    historyStore.push(currentVersion);
  }

  const forecastTrend: Array<{ label: string; completion_date: string; data_date?: string }> = [
    { label: 'Baseline', completion_date: baseline.completion_date }
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
      label: 'Current (not stored)',
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

  const cycle: CycleData = {
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
    composite_risk_index: Math.round(riskRegister.compositeRiskIndex() * 1000) / 1000,
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
    activities: actRows.map(a => ({
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
