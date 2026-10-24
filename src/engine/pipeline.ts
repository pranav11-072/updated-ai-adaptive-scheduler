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
import {
  DEFAULT_PROJECT_JSON,
  DEFAULT_ACTIVITIES_CSV,
  DEFAULT_DEPENDENCIES_CSV,
  DEFAULT_FACTORS_CSV
} from './defaultData';
import {
  generateGNProjectSchedule,
  BuildingConfig,
  validateBuildingConfig,
  GeneratedSchedule,
  formatConfigLabel
} from './floorGenerator';
import { computeAnalytics, AnalyticsResult } from './analyticsEngine';

export function inferFloor(name: string, wbs = ''): string {
  const n = name.toUpperCase();
  if (/\b(B2|BASEMENT\s*2)\b/.test(n)) return 'B2';
  if (/\b(B1|BASEMENT\s*1|BASEMENT)\b/.test(n)) return 'B1';
  if (/\b(GF|GROUND\s*LEVEL|GROUND\s*FLOOR|GROUND)\b/.test(n)) return 'GF';
  const floorMatch = n.match(/\b(\d+)\s*F\b/) || n.match(/\bFLOOR\s*(\d+)\b/);
  if (floorMatch) return `${floorMatch[1]}F`;
  if (/\bFIRST\b/.test(n)) return '1F';
  if (/\bSECOND\b/.test(n)) return '2F';
  if (/\bTHIRD\b/.test(n)) return '3F';
  if (/\b(FOOTING|EXCAVATION|PLINTH|SUBSTRUCTURE|PCC|BACKFILL|WATERPROOF)\b/.test(n)) return 'Substructure';
  if (/\b(STAIRCASE|OVERHEAD\s*TANK|PARAPET|TERRACE|ROOF)\b/.test(n)) return 'Terrace';
  if (/\b(COMPOUND|DRAINAGE|LANDSCAPING|HANDOVER|SNAGGING|EXTERNAL)\b/.test(n)) return 'External';
  return 'General';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectDir(): string {
  const candidates = [
    path.join(process.cwd(), 'data/project'),
    path.resolve(__dirname, '../../data/project'),
    path.resolve(__dirname, '../data/project'),
    path.resolve(__dirname, './data/project'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'project.json'))) {
      return c;
    }
  }
  return path.join(process.cwd(), 'data/project');
}

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

export function loadProjectData(projectDir?: string): {
  project: ProjectMetadata;
  activities: Activity[];
  dependencies: Dependency[];
  riskRegister: RiskRegister;
} {
  const dir = projectDir || findProjectDir();
  const metaPath = path.join(dir, 'project.json');
  const actPath = path.join(dir, 'activities.csv');
  const depPath = path.join(dir, 'dependencies.csv');
  const factorPath = path.join(dir, 'delay_factor_status.csv');

  let metaRaw = DEFAULT_PROJECT_JSON;
  if (fs.existsSync(metaPath)) {
    try {
      metaRaw = fs.readFileSync(metaPath, 'utf-8');
    } catch (_) {}
  }
  const meta: ProjectMetadata = JSON.parse(metaRaw);

  let actRaw = DEFAULT_ACTIVITIES_CSV;
  if (fs.existsSync(actPath)) {
    try {
      actRaw = fs.readFileSync(actPath, 'utf-8');
    } catch (_) {}
  }
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

  let depRaw = DEFAULT_DEPENDENCIES_CSV;
  if (fs.existsSync(depPath)) {
    try {
      depRaw = fs.readFileSync(depPath, 'utf-8');
    } catch (_) {}
  }
  const depRows = parseCSV(depRaw);
  const dependencies: Dependency[] = depRows.map(r => ({
    predecessor: r.predecessor,
    successor: r.successor,
    dep_type: (r.dep_type || 'FS') as any,
    lag: parseInt(r.lag, 10) || 0
  }));

  const factorScores: Record<string, number> = {};
  const factorNotes: Record<string, string> = {};
  let factorRaw = DEFAULT_FACTORS_CSV;
  if (fs.existsSync(factorPath)) {
    try {
      factorRaw = fs.readFileSync(factorPath, 'utf-8');
    } catch (_) {}
  }
  const factorRows = parseCSV(factorRaw);
  for (const r of factorRows) {
    factorScores[r.factor_id] = parseInt(r.score, 10) || 0;
    factorNotes[r.factor_id] = r.note || '';
  }

  const register = new RiskRegister(factorScores, factorNotes);
  return { project: meta, activities, dependencies, riskRegister: register };
}

export interface TaskInput {
  activity_id?: string;
  wbs?: string;
  name: string;
  activity_type?: string;
  start_date: string;
  end_date: string;
  predecessors?: string;
  resource?: string;
  crew_size?: number;
  quantity?: number;
  unit?: string;
  normal_cost?: number;
  crash_duration?: number | null;
  crash_cost?: number | null;
  percent_complete?: number;
  actual_delay_days?: number;
}

export function parsePredecessorString(targetId: string, predStr?: string): Dependency[] {
  if (!predStr || !predStr.trim()) return [];
  const parts = predStr.split(',').map(s => s.trim()).filter(Boolean);
  const deps: Dependency[] = [];
  for (const part of parts) {
    const match = part.match(/^([A-Za-z0-9_-]+)(?::([A-Za-z]{2})?([+-]?\d+)?)?$/);
    if (match) {
      const pred = match[1];
      const type = (match[2]?.toUpperCase() as any) || 'FS';
      const lag = match[3] ? parseInt(match[3], 10) : 0;
      deps.push({
        predecessor: pred,
        successor: targetId,
        dep_type: (['FS', 'SS', 'FF', 'SF'].includes(type) ? type : 'FS') as any,
        lag: isNaN(lag) ? 0 : lag
      });
    }
  }
  return deps;
}

export function formatPredecessorString(targetId: string, dependencies: Dependency[]): string {
  const preds = dependencies.filter(d => d.successor === targetId);
  return preds.map(d => `${d.predecessor}${d.dep_type !== 'FS' || d.lag !== 0 ? `:${d.dep_type}${d.lag !== 0 ? d.lag : ''}` : ''}`).join(', ');
}

export interface ScheduleState {
  project: ProjectMetadata;
  activities: Activity[];
  dependencies: Dependency[];
  riskRegister: RiskRegister;
  startOffsets: Record<string, number>;
}

let activeScheduleState: ScheduleState | null = null;

export function getScheduleState(): ScheduleState {
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

    if (!loaded.project.building_config) {
      loaded.project.building_config = {
        has_ground_floor: true,
        floors_above_ground: 3,
        basement_floors: 0,
        construction_method: 'rcc_framed',
        building_type: 'residential',
        total_levels: 4,
        config_label: 'G+3'
      };
    }

    for (const a of loaded.activities) {
      const s = cpmRes.schedules[a.activity_id];
      if (s) {
        a.start_date = cal.dateOf(s.es);
        a.end_date = cal.finishDate(s.ef);
        a.predecessors = formatPredecessorString(a.activity_id, loaded.dependencies);
      }
      if (!a.floor) {
        a.floor = inferFloor(a.name, a.wbs);
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

export function applyBuildingConfiguration(config: Partial<BuildingConfig>): GeneratedSchedule {
  const current = getScheduleState();
  const generated = generateGNProjectSchedule(config, current.project);

  const cal = new WorkingCalendar(
    generated.project.start_date,
    generated.project.work_week,
    generated.project.holidays,
    generated.project.monsoon
  );
  const eng = new CPMEngine(generated.activities, generated.dependencies, cal);
  const cpmRes = eng.compute();

  for (const a of generated.activities) {
    const s = cpmRes.schedules[a.activity_id];
    if (s) {
      a.start_date = cal.dateOf(s.es);
      a.end_date = cal.finishDate(s.ef);
      a.predecessors = formatPredecessorString(a.activity_id, generated.dependencies);
    }
  }

  activeScheduleState = {
    project: generated.project,
    activities: generated.activities,
    dependencies: generated.dependencies,
    riskRegister: current.riskRegister,
    startOffsets: {}
  };

  return generated;
}

export function addScheduleTask(input: TaskInput): Activity {
  const state = getScheduleState();
  const cal = new WorkingCalendar(
    state.project.start_date,
    state.project.work_week,
    state.project.holidays,
    state.project.monsoon
  );

  let aid = (input.activity_id || '').trim();
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
    aid = 'A' + String(nextNum).padStart(3, '0');
  }

  if (state.activities.some(a => a.activity_id === aid)) {
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

  const newActivity: Activity = {
    activity_id: aid,
    wbs: (input.wbs || '1.0').trim(),
    name: (input.name || 'Untitled Task').trim(),
    activity_type: (input.activity_type || 'STRUCTURE').trim(),
    duration,
    quantity: Number(input.quantity) || 1,
    unit: (input.unit || 'LS').trim(),
    crew_size: Number(input.crew_size) || 4,
    resource: (input.resource || 'HELPER').trim(),
    normal_cost: normCost,
    crash_duration: crashDur,
    crash_cost: crashCost,
    percent_complete: Math.min(100, Math.max(0, Number(input.percent_complete) || 0)),
    actual_delay_days: Math.max(0, Number(input.actual_delay_days) || 0),
    max_crash_days: maxCrash,
    cost_slope: costSlope,
    start_date: sDate,
    end_date: eDate,
    predecessors: input.predecessors || ''
  };

  state.activities.push(newActivity);

  if (sDate > state.project.start_date) {
    state.startOffsets[aid] = cal.offsetOf(sDate);
  }

  if (input.predecessors) {
    const newDeps = parsePredecessorString(aid, input.predecessors);
    for (const d of newDeps) {
      if (state.activities.some(a => a.activity_id === d.predecessor)) {
        state.dependencies.push(d);
      }
    }
  }

  return newActivity;
}

export function batchAddScheduleTasks(tasks: TaskInput[]): Activity[] {
  const added: Activity[] = [];
  for (const t of tasks) {
    if (t.name && t.name.trim()) {
      const act = addScheduleTask(t);
      added.push(act);
    }
  }
  return added;
}

export function parseBatchSlotText(rawText: string): TaskInput[] {
  const lines = rawText.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  const tasks: TaskInput[] = [];
  for (const line of lines) {
    const parts = line.split(/[,\t]/).map(p => p.trim());
    if (parts.length >= 3) {
      tasks.push({
        name: parts[0],
        start_date: parts[1],
        end_date: parts[2],
        activity_type: (parts[3] || 'STRUCTURE').toUpperCase(),
        resource: (parts[4] || 'HELPER').toUpperCase(),
        crew_size: parts[5] ? parseInt(parts[5], 10) : 4,
        normal_cost: parts[6] ? parseFloat(parts[6]) : 50000,
        predecessors: parts[7] || '',
        wbs: parts[8] || '1.0'
      });
    }
  }
  return tasks;
}

export function updateScheduleTask(id: string, input: TaskInput): Activity {
  const state = getScheduleState();
  const idx = state.activities.findIndex(a => a.activity_id === id);
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

  const normCost = input.normal_cost !== undefined ? Number(input.normal_cost) : existing.normal_cost;
  const crashDur = input.crash_duration !== undefined ? (input.crash_duration ? Number(input.crash_duration) : null) : existing.crash_duration;
  const crashCost = input.crash_cost !== undefined ? (input.crash_cost ? Number(input.crash_cost) : null) : existing.crash_cost;

  let maxCrash = 0;
  let costSlope = 0;
  if (crashDur !== null && crashDur < duration && crashCost !== null && crashCost > normCost) {
    maxCrash = duration - crashDur;
    costSlope = (crashCost - normCost) / maxCrash;
  }

  const updated: Activity = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    wbs: input.wbs !== undefined ? input.wbs.trim() : existing.wbs,
    activity_type: input.activity_type !== undefined ? input.activity_type.trim() : existing.activity_type,
    duration,
    quantity: input.quantity !== undefined ? Number(input.quantity) : existing.quantity,
    unit: input.unit !== undefined ? input.unit.trim() : existing.unit,
    crew_size: input.crew_size !== undefined ? Number(input.crew_size) : existing.crew_size,
    resource: input.resource !== undefined ? input.resource.trim() : existing.resource,
    normal_cost: normCost,
    crash_duration: crashDur,
    crash_cost: crashCost,
    percent_complete: input.percent_complete !== undefined ? Math.min(100, Math.max(0, Number(input.percent_complete))) : existing.percent_complete,
    actual_delay_days: input.actual_delay_days !== undefined ? Math.max(0, Number(input.actual_delay_days)) : existing.actual_delay_days,
    max_crash_days: maxCrash,
    cost_slope: costSlope,
    start_date: sDate,
    end_date: eDate,
    predecessors: input.predecessors !== undefined ? input.predecessors.trim() : existing.predecessors
  };

  state.activities[idx] = updated;

  if (sDate > state.project.start_date) {
    state.startOffsets[id] = cal.offsetOf(sDate);
  } else {
    delete state.startOffsets[id];
  }

  if (input.predecessors !== undefined) {
    state.dependencies = state.dependencies.filter(d => d.successor !== id);
    const newDeps = parsePredecessorString(id, input.predecessors);
    for (const d of newDeps) {
      if (state.activities.some(a => a.activity_id === d.predecessor)) {
        state.dependencies.push(d);
      }
    }
  }

  return updated;
}

export function deleteScheduleTask(id: string): void {
  const state = getScheduleState();
  state.activities = state.activities.filter(a => a.activity_id !== id);
  state.dependencies = state.dependencies.filter(d => d.predecessor !== id && d.successor !== id);
  delete state.startOffsets[id];
}

export function resetScheduleTasks(): void {
  activeScheduleState = null;
  getScheduleState();
}

export function clearScheduleTasks(): void {
  const state = getScheduleState();
  state.activities = [];
  state.dependencies = [];
  state.startOffsets = {};
}

export function loadScheduleTemplate(name: string): void {
  if (name === 'g3_case_study') {
    resetScheduleTasks();
    return;
  }

  if (name === 'g0_building') {
    applyBuildingConfiguration({ floors_above_ground: 0, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'g2_building') {
    applyBuildingConfiguration({ floors_above_ground: 2, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'g3_building') {
    applyBuildingConfiguration({ floors_above_ground: 3, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'g5_building') {
    applyBuildingConfiguration({ floors_above_ground: 5, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'g10_tower') {
    applyBuildingConfiguration({ floors_above_ground: 10, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'g20_skyscraper') {
    applyBuildingConfiguration({ floors_above_ground: 20, has_ground_floor: true, basement_floors: 0 });
    return;
  }

  if (name === 'b1_g10_tower') {
    applyBuildingConfiguration({ floors_above_ground: 10, has_ground_floor: true, basement_floors: 1 });
    return;
  }

  if (name === 'substructure') {
    const loaded = loadProjectData();
    const subActs = loaded.activities.filter(a => a.activity_id <= 'A140');
    const subIds = new Set(subActs.map(a => a.activity_id));
    const subDeps = loaded.dependencies.filter(d => subIds.has(d.predecessor) && subIds.has(d.successor));
    activeScheduleState = {
      project: { ...loaded.project, name: 'Substructure & Foundation Schedule' },
      activities: subActs,
      dependencies: subDeps,
      riskRegister: loaded.riskRegister,
      startOffsets: {}
    };
    return;
  }

  if (name === 'commercial_warehouse') {
    const loaded = loadProjectData();
    const warehouseActs: Activity[] = [
      { activity_id: 'W010', wbs: '1.1', name: 'Site clearing, grading and hoarding', activity_type: 'SUBSTRUCTURE', duration: 5, quantity: 1200, unit: 'm2', crew_size: 6, resource: 'EXC', normal_cost: 45000, crash_duration: 3, crash_cost: 58000, percent_complete: 100, actual_delay_days: 0, max_crash_days: 2, cost_slope: 6500, start_date: '2026-05-04', end_date: '2026-05-09', predecessors: '' },
      { activity_id: 'W020', wbs: '1.2', name: 'Foundation augered piles and grade beams', activity_type: 'SUBSTRUCTURE', duration: 11, quantity: 24, unit: 'EA', crew_size: 10, resource: 'MASON', normal_cost: 165000, crash_duration: 8, crash_cost: 210000, percent_complete: 60, actual_delay_days: 1, max_crash_days: 3, cost_slope: 15000, start_date: '2026-05-11', end_date: '2026-05-23', predecessors: 'W010' },
      { activity_id: 'W030', wbs: '2.1', name: 'Structural steel columns and portal rafters', activity_type: 'STRUCTURE', duration: 12, quantity: 45, unit: 't', crew_size: 12, resource: 'CARP', normal_cost: 280000, crash_duration: 9, crash_cost: 340000, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 20000, start_date: '2026-05-25', end_date: '2026-06-08', predecessors: 'W020' },
      { activity_id: 'W040', wbs: '2.2', name: 'Roof trusses, purlins and bracing', activity_type: 'STRUCTURE', duration: 8, quantity: 18, unit: 't', crew_size: 8, resource: 'CARP', normal_cost: 140000, crash_duration: 6, crash_cost: 175000, percent_complete: 0, actual_delay_days: 0, max_crash_days: 2, cost_slope: 17500, start_date: '2026-06-09', end_date: '2026-06-18', predecessors: 'W030' },
      { activity_id: 'W050', wbs: '3.1', name: 'Metal profile roof sheeting & wall cladding', activity_type: 'EXTERNAL', duration: 10, quantity: 2200, unit: 'm2', crew_size: 10, resource: 'HELPER', normal_cost: 195000, crash_duration: 7, crash_cost: 245000, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 16666, start_date: '2026-06-19', end_date: '2026-07-01', predecessors: 'W040' },
      { activity_id: 'W060', wbs: '3.2', name: 'Heavy-duty laser screed floor slab pour', activity_type: 'STRUCTURE', duration: 9, quantity: 380, unit: 'm3', crew_size: 8, resource: 'MIXER', normal_cost: 310000, crash_duration: 6, crash_cost: 375000, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 21666, start_date: '2026-06-19', end_date: '2026-06-30', predecessors: 'W030:FS10' },
      { activity_id: 'W070', wbs: '4.1', name: 'High-bay LED lighting & electrical distribution', activity_type: 'MEP', duration: 11, quantity: 1, unit: 'LS', crew_size: 6, resource: 'ELEC', normal_cost: 125000, crash_duration: 8, crash_cost: 160000, percent_complete: 0, actual_delay_days: 0, max_crash_days: 3, cost_slope: 11666, start_date: '2026-07-02', end_date: '2026-07-15', predecessors: 'W050' },
      { activity_id: 'W080', wbs: '5.1', name: 'Final inspection, fire clearance & handover', activity_type: 'EXTERNAL', duration: 5, quantity: 1, unit: 'LS', crew_size: 4, resource: 'HELPER', normal_cost: 25000, crash_duration: null, crash_cost: null, percent_complete: 0, actual_delay_days: 0, max_crash_days: 0, cost_slope: 0, start_date: '2026-07-16', end_date: '2026-07-21', predecessors: 'W060, W070' }
    ];

    const warehouseDeps: Dependency[] = [
      { predecessor: 'W010', successor: 'W020', dep_type: 'FS', lag: 0 },
      { predecessor: 'W020', successor: 'W030', dep_type: 'FS', lag: 0 },
      { predecessor: 'W030', successor: 'W040', dep_type: 'FS', lag: 0 },
      { predecessor: 'W040', successor: 'W050', dep_type: 'FS', lag: 0 },
      { predecessor: 'W030', successor: 'W060', dep_type: 'FS', lag: 10 },
      { predecessor: 'W050', successor: 'W070', dep_type: 'FS', lag: 0 },
      { predecessor: 'W060', successor: 'W080', dep_type: 'FS', lag: 0 },
      { predecessor: 'W070', successor: 'W080', dep_type: 'FS', lag: 0 }
    ];

    activeScheduleState = {
      project: {
        ...loaded.project,
        project_id: 'CS-WH-002',
        name: 'Pre-Engineered Steel Warehouse Schedule',
        start_date: '2026-05-04',
        data_date: '2026-05-20'
      },
      activities: warehouseActs,
      dependencies: warehouseDeps,
      riskRegister: loaded.riskRegister,
      startOffsets: {}
    };
  }
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
    building_config?: BuildingConfig;
    floors?: string[];
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
  analytics: AnalyticsResult;
}

export function runCycle(
  dataDate?: string,
  mode: 'expected' | 'conservative' = 'expected',
  threshold = 0.60,
  forceStore = false
): { cycle: CycleData; gantt: any } {
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
    dependencies,
    threshold
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
  const analytics = computeAnalytics(
    activities,
    baseline,
    current,
    calendar,
    dd,
    adaptation.injected,
    predictions as any,
    threshold
  );

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
      drivers: pr ? pr.drivers : '',
      predecessors: a.predecessors || formatPredecessorString(a.activity_id, dependencies),
      normal_cost: a.normal_cost,
      crash_duration: a.crash_duration,
      crash_cost: a.crash_cost,
      quantity: a.quantity,
      unit: a.unit,
      floor: a.floor || inferFloor(a.name, a.wbs)
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
    recommendation_count: recommendations.length,
    spi: analytics.evm.spi,
    cpi: analytics.evm.cpi,
    planned_value: analytics.evm.planned_value,
    earned_value: analytics.evm.earned_value,
    actual_cost: analytics.evm.actual_cost,
    cost_variance: analytics.evm.cost_variance,
    schedule_variance_cost: analytics.evm.schedule_variance,
    budget_at_completion: analytics.evm.budget_at_completion,
    estimate_at_completion: analytics.evm.estimate_at_completion,
    schedule_status: analytics.evm.schedule_status,
    cost_status: analytics.evm.cost_status
  };

  const detectedFloors = Array.from(new Set(actRows.map(r => r.floor).filter(Boolean)));

  const cycle: CycleData = {
    project: {
      project_id: project.project_id,
      name: project.name,
      start_date: project.start_date,
      location: project.location,
      data_source: project.data_source,
      activity_count: activities.length,
      dependency_count: dependencies.length,
      building_config: project.building_config,
      floors: detectedFloors
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
    version: currentVersion,
    analytics
  };

  const horizon = Math.max(baseline.project_duration, current.project_duration);
  const offsetDates = Array.from({ length: horizon + 1 }, (_, k) => calendar.dateOf(k));

  const gantt = {
    data_date: dd,
    data_date_offset: progressData.elapsed_working_days,
    horizon,
    offset_dates: offsetDates,
    predictions_available: true,
    floors: detectedFloors,
    activities: actRows.map(a => ({
      activity_id: a.activity_id,
      name: a.name,
      type: a.type,
      floor: a.floor,
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
