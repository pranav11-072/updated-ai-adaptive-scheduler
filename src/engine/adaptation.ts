import { Activity, CPMResult } from './models';
import { CPMEngine } from './cpm';
import { PredictionResult } from './prediction';

export interface InjectedDelay {
  days: number;
  p_delay: number;
  predicted_delay_days: number;
  source: 'observed' | 'prediction';
  capped: boolean;
}

export interface AdaptationResult {
  mode: 'expected' | 'conservative';
  threshold: number;
  injected: Record<string, InjectedDelay>;
  durations: Record<string, number>;
  baseline: CPMResult;
  adapted: CPMResult;
  schedule_variance_days: number;
  calendar_slip_days: number;
  newly_critical: string[];
  left_critical: string[];
  near_critical: string[];
  float_erosion: Record<string, number>;
  critical_path_migrated: boolean;
  eroded: string[];
}

export const ADAPT_CAP_RATIO = 0.50;
export const ADAPT_CAP_DAYS = 30;
export const NEAR_CRITICAL_FLOAT = 5;

export function adapt(
  activities: Activity[],
  engine: CPMEngine,
  baseline: CPMResult,
  predictions: Record<string, PredictionResult>,
  mode: 'expected' | 'conservative' = 'expected',
  threshold = 0.60,
  includeObserved = true
): AdaptationResult {
  const injected: Record<string, InjectedDelay> = {};

  for (const a of activities) {
    const aid = a.activity_id;
    const started = a.percent_complete > 0;

    if (includeObserved && started && a.actual_delay_days > 0) {
      injected[aid] = {
        days: a.actual_delay_days,
        p_delay: 1.0,
        predicted_delay_days: a.actual_delay_days,
        source: 'observed',
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

    const raw = mode === 'expected' ? pr.predicted_delay_days * pr.p_delay : pr.predicted_delay_days;
    let days = Math.ceil(raw - 1e-9);
    const cap = Math.min(Math.ceil(ADAPT_CAP_RATIO * a.duration), ADAPT_CAP_DAYS);
    const capped = days > cap;
    days = Math.min(days, cap);

    if (days > 0) {
      injected[aid] = {
        days,
        p_delay: pr.p_delay,
        predicted_delay_days: pr.predicted_delay_days,
        source: 'prediction',
        capped
      };
    }
  }

  const durations: Record<string, number> = {};
  for (const a of activities) {
    durations[a.activity_id] = a.duration + (injected[a.activity_id]?.days || 0);
  }

  const adapted = engine.compute(durations);

  const baseCrit = new Set(baseline.critical_path);
  const adaptCrit = new Set(adapted.critical_path);

  const newlyCritical = adapted.critical_path.filter(id => !baseCrit.has(id));
  const leftCritical = baseline.critical_path.filter(id => !adaptCrit.has(id));

  const nearCritical = Object.values(adapted.schedules)
    .filter(s => s.total_float > 0 && s.total_float <= NEAR_CRITICAL_FLOAT)
    .map(s => s.activity_id);

  const floatErosion: Record<string, number> = {};
  for (const aid of Object.keys(adapted.schedules)) {
    floatErosion[aid] = baseline.schedules[aid].total_float - adapted.schedules[aid].total_float;
  }

  const eroded = Object.keys(floatErosion)
    .filter(k => floatErosion[k] > 0)
    .sort((a, b) => floatErosion[b] - floatErosion[a]);

  const baseCompDate = new Date(baseline.completion_date).getTime();
  const adaptCompDate = new Date(adapted.completion_date).getTime();
  const calendarSlipDays = Math.round((adaptCompDate - baseCompDate) / 86400000);

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
