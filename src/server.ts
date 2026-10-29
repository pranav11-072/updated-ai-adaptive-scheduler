import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
  runCycle,
  CycleData,
  getScheduleState,
  addScheduleTask,
  batchAddScheduleTasks,
  parseBatchSlotText,
  updateScheduleTask,
  deleteScheduleTask,
  resetScheduleTasks,
  clearScheduleTasks,
  loadScheduleTemplate,
  applyBuildingConfiguration
} from './engine/pipeline';
import { validateBuildingConfig } from './engine/floorGenerator';
import { WorkingCalendar } from './engine/calendar';
import { generateFigureSvg } from './engine/chartGenerator';
import { EMBEDDED_VIEWS } from './views/embeddedViews';
import { EMBEDDED_CSS, EMBEDDED_JS } from './views/embeddedAssets';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.env.ROOT_DIR || process.cwd();

const VIEWS_DIRS = [
  path.join(process.cwd(), 'views'),
  path.join(process.cwd(), 'src', 'views'),
  path.resolve(__dirname, 'views'),
  path.resolve(__dirname, '../views'),
  path.resolve(__dirname, '../src/views'),
  path.resolve(__dirname, '../../views'),
  path.resolve(__dirname, '../../src/views'),
].filter(d => fs.existsSync(d));

if (VIEWS_DIRS.length === 0) {
  VIEWS_DIRS.push(path.join(process.cwd(), 'views'), path.join(process.cwd(), 'src/views'));
}

const STATIC_DIRS = [
  path.join(process.cwd(), 'public'),
  path.resolve(__dirname, '../public'),
  path.resolve(__dirname, '../../public'),
].filter(d => fs.existsSync(d));
const PUBLIC_DIR = STATIC_DIRS[0] || path.join(process.cwd(), 'public');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function renderEmbeddedTemplate(viewName: string, data: any): string {
  let key = viewName.replace(/\\/g, '/');
  const match = key.match(/(?:views\/|src\/views\/)?([a-zA-Z0-9_\/-]+?)(?:\.ejs)?$/);
  const cleanKey = match ? match[1] : key.replace(/\.ejs$/, '');

  const templateStr = EMBEDDED_VIEWS[cleanKey] || EMBEDDED_VIEWS[key];
  if (!templateStr) {
    throw new Error(`View template "${viewName}" not found in embedded views`);
  }

  return ejs.render(templateStr, data, {
    views: VIEWS_DIRS,
    includer: (originalPath: string): any => {
      const subKey = originalPath.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.ejs$/, '');
      if (EMBEDDED_VIEWS[subKey]) {
        return { template: EMBEDDED_VIEWS[subKey] };
      }
      for (const d of VIEWS_DIRS) {
        const full = path.join(d, originalPath.endsWith('.ejs') ? originalPath : originalPath + '.ejs');
        if (fs.existsSync(full)) {
          return { filename: full };
        }
      }
      return { template: '' };
    }
  });
}

// In-memory + disk EJS engine
app.engine('ejs', (filePath: string, options: any, callback: (err: any, str?: string) => void) => {
  if (fs.existsSync(filePath)) {
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

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIRS);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Embedded static asset routes with disk-first serving
app.get(['/static/style.css', '/style.css'], (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  const diskPath = path.join(PUBLIC_DIR, 'style.css');
  if (fs.existsSync(diskPath)) {
    return res.sendFile(diskPath);
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(EMBEDDED_CSS);
});

app.get(['/static/app.js', '/app.js'], (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  const diskPath = path.join(PUBLIC_DIR, 'app.js');
  if (fs.existsSync(diskPath)) {
    return res.sendFile(diskPath);
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(EMBEDDED_JS);
});

// Static file serving fallbacks
app.use('/static', express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));
app.use('/figures', express.static(path.join(ROOT, 'artifacts/figures')));

const PAGES: Array<[string, string, string]> = [
  ['dashboard', 'Dashboard', '/'],
  ['builder', 'Schedule Builder', '/builder'],
  ['gantt', 'Gantt', '/gantt'],
  ['predictions', 'Predictions', '/predictions'],
  ['recommendations', 'Recommendations', '/recommendations'],
  ['resources', 'Resources', '/resources'],
  ['progress', 'Progress', '/progress'],
  ['factors', 'Delay Factors', '/factors'],
  ['reports', 'Reports', '/reports']
];

const FIGURES = [
  'gantt_chart',
  'resource_histogram',
  's_curve',
  'risk_distribution',
  'forecast_trend',
  'shap_global_importance'
];

interface CycleCacheEntry {
  cycle: CycleData;
  gantt: any;
}

const cache = new Map<string, CycleCacheEntry>();

function getCycleParams(req: Request): { dataDate?: string; mode: 'expected' | 'conservative'; threshold: number } {
  let threshold = 0.60;
  const rawThresh = req.query.threshold !== undefined
    ? req.query.threshold
    : (req.body && req.body.threshold !== undefined ? req.body.threshold : undefined);

  if (rawThresh !== undefined && rawThresh !== null && String(rawThresh).trim() !== '') {
    const parsed = parseFloat(String(rawThresh));
    if (!isNaN(parsed)) {
      threshold = Math.max(0, Math.min(1, parsed));
    }
  }

  let mode: 'expected' | 'conservative' = 'expected';
  const rawMode = (req.body && req.body.mode) || req.query.mode;
  if (rawMode === 'conservative') {
    mode = 'conservative';
  }

  const bodyDate = req.body && typeof req.body.data_date === 'string' && req.body.data_date.trim().length > 0
    ? req.body.data_date.trim()
    : undefined;
  const queryDate = typeof req.query.data_date === 'string' && req.query.data_date.trim().length > 0
    ? req.query.data_date.trim()
    : undefined;
  const rawDate = bodyDate || queryDate;

  return { dataDate: rawDate, mode, threshold };
}

function getCycle(req: Request, forceStore = false, bypassCache = false): CycleCacheEntry {
  const { dataDate, mode, threshold } = getCycleParams(req);
  const cacheKey = `${dataDate || 'default'}_${mode}_${threshold}_${forceStore}`;

  if (!forceStore && !bypassCache && !req.query.nocache && cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const result = runCycle(dataDate, mode, threshold, forceStore);
  if (!forceStore) {
    cache.set(cacheKey, result);
  }
  return result;
}

function toCsv(rows: Array<Record<string, any>>, headers?: string[]): string {
  if (!rows || rows.length === 0) return '';
  const cols = headers || Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) {
    const line = cols.map(c => {
      const val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

// Register page routes
for (const [name, _, routePath] of PAGES) {
  app.get(routePath, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycle, gantt } = getCycle(req);
      const queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const state = getScheduleState();
      res.render(name, {
        c: cycle,
        gantt,
        pages: PAGES,
        active: name,
        query: queryStr,
        generated: req.query.generated as string || null,
        msg: req.query.msg as string || null,
        error: req.query.error as string || null,
        editId: req.query.editId as string || null,
        state,
        generateFigureSvg
      });
    } catch (err) {
      next(err);
    }
  });
}

// Schedule Builder HTML Form Handlers
app.post('/builder/add', (req: Request, res: Response) => {
  try {
    addScheduleTask(req.body);
    cache.clear();
    res.redirect('/builder?msg=' + encodeURIComponent('Task added successfully to schedule'));
  } catch (err: any) {
    res.redirect('/builder?error=' + encodeURIComponent(err.message || 'Error adding task'));
  }
});

app.post('/builder/batch', (req: Request, res: Response) => {
  try {
    const rawText = (req.body.slot_text as string) || '';
    const tasks = parseBatchSlotText(rawText);
    if (tasks.length === 0) {
      throw new Error('No valid task rows found in slot. Provide at least: Task Name, Start Date, End Date');
    }
    const added = batchAddScheduleTasks(tasks);
    cache.clear();
    res.redirect('/builder?msg=' + encodeURIComponent(`Added ${added.length} tasks from custom values slot`));
  } catch (err: any) {
    res.redirect('/builder?error=' + encodeURIComponent(err.message || 'Error processing slot values'));
  }
});

app.post('/builder/update/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    updateScheduleTask(id, req.body);
    cache.clear();
    res.redirect('/builder?msg=' + encodeURIComponent(`Task ${id} updated successfully`));
  } catch (err: any) {
    res.redirect('/builder?error=' + encodeURIComponent(err.message || 'Error updating task'));
  }
});

app.post('/builder/delete/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    deleteScheduleTask(id);
    cache.clear();
    res.redirect('/builder?msg=' + encodeURIComponent(`Task ${id} removed from schedule`));
  } catch (err: any) {
    res.redirect('/builder?error=' + encodeURIComponent(err.message || 'Error deleting task'));
  }
});

app.post('/builder/reset', (_req: Request, res: Response) => {
  resetScheduleTasks();
  cache.clear();
  res.redirect('/builder?msg=' + encodeURIComponent('Schedule reset to default synthetic case study'));
});

app.post('/builder/clear', (_req: Request, res: Response) => {
  clearScheduleTasks();
  cache.clear();
  res.redirect('/builder?msg=' + encodeURIComponent('All tasks cleared. Ready to build new schedule from scratch.'));
});

app.post('/builder/template', (req: Request, res: Response) => {
  const templateName = req.body.template as string || 'g3_case_study';
  loadScheduleTemplate(templateName);
  cache.clear();
  res.redirect('/builder?msg=' + encodeURIComponent(`Template loaded successfully`));
});

app.post('/builder/generate-floors', (req: Request, res: Response) => {
  try {
    const hasGround = req.body.has_ground_floor === 'true' || req.body.has_ground_floor === 'on' || req.body.has_ground_floor === true || req.body.has_ground_floor === '1';
    const floorsAbove = parseInt(req.body.floors_above_ground ?? '3', 10);
    const basements = parseInt(req.body.basement_floors ?? '0', 10);
    const method = (req.body.construction_method as any) || 'rcc_framed';
    const bType = (req.body.building_type as any) || 'residential';

    const validation = validateBuildingConfig({
      has_ground_floor: hasGround,
      floors_above_ground: isNaN(floorsAbove) ? 3 : floorsAbove,
      basement_floors: isNaN(basements) ? 0 : basements,
      construction_method: method,
      building_type: bType
    });
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const generated = applyBuildingConfiguration(validation.config);
    cache.clear();
    res.redirect('/builder?msg=' + encodeURIComponent(`Generated ${validation.config.config_label} schedule with ${generated.activities.length} activities and ${generated.dependencies.length} dependencies`));
  } catch (err: any) {
    res.redirect('/builder?error=' + encodeURIComponent(err.message || 'Error generating floor schedule'));
  }
});

// Schedule Builder REST API Handlers
app.get('/api/project/config', (_req: Request, res: Response) => {
  const state = getScheduleState();
  res.json({
    building_config: state.project.building_config,
    project: state.project
  });
});

app.post('/api/project/generate-floors', (req: Request, res: Response) => {
  try {
    const raw = req.body || {};
    const hasGround = raw.has_ground_floor !== undefined ? (raw.has_ground_floor === true || raw.has_ground_floor === 'true' || raw.has_ground_floor === 1) : true;
    const floorsAbove = typeof raw.floors_above_ground === 'number' ? raw.floors_above_ground : parseInt(raw.floors_above_ground ?? '3', 10);
    const basements = typeof raw.basement_floors === 'number' ? raw.basement_floors : parseInt(raw.basement_floors ?? '0', 10);

    const validation = validateBuildingConfig({
      has_ground_floor: hasGround,
      floors_above_ground: isNaN(floorsAbove) ? 3 : floorsAbove,
      basement_floors: isNaN(basements) ? 0 : basements,
      construction_method: raw.construction_method || 'rcc_framed',
      building_type: raw.building_type || 'residential'
    });
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const generated = applyBuildingConfiguration(validation.config);
    cache.clear();
    res.status(200).json({
      success: true,
      config: generated.project.building_config,
      activity_count: generated.activities.length,
      dependency_count: generated.dependencies.length,
      activities: generated.activities,
      dependencies: generated.dependencies
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Error generating floor configuration' });
  }
});
app.get('/api/tasks', (_req: Request, res: Response) => {
  const state = getScheduleState();
  res.json({
    activities: state.activities,
    dependencies: state.dependencies,
    project: state.project
  });
});

app.post('/api/tasks', (req: Request, res: Response) => {
  try {
    const task = addScheduleTask(req.body);
    cache.clear();
    res.status(201).json({ success: true, task });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Error adding task' });
  }
});

app.put('/api/tasks/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const task = updateScheduleTask(id, req.body);
    cache.clear();
    res.json({ success: true, task });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Error updating task' });
  }
});

app.delete('/api/tasks/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    deleteScheduleTask(id);
    cache.clear();
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Error deleting task' });
  }
});

app.post('/api/tasks/reset', (_req: Request, res: Response) => {
  resetScheduleTasks();
  cache.clear();
  res.json({ success: true });
});

app.post('/api/tasks/clear', (_req: Request, res: Response) => {
  clearScheduleTasks();
  cache.clear();
  res.json({ success: true });
});

app.post('/api/tasks/template/:name', (req: Request, res: Response) => {
  const name = req.params.name as string;
  loadScheduleTemplate(name);
  cache.clear();
  res.json({ success: true });
});

app.get('/api/calendar/calc-days', (req: Request, res: Response) => {
  const state = getScheduleState();
  const cal = new WorkingCalendar(
    state.project.start_date,
    state.project.work_week,
    state.project.holidays,
    state.project.monsoon
  );
  const sDate = (req.query.start_date as string) || state.project.start_date;
  const eDate = (req.query.end_date as string) || sDate;
  const workingDays = cal.workingDaysBetween(sDate, eDate);
  const calendarDays = (new Date(eDate).getTime() - new Date(sDate).getTime()) / 86400000 + 1;
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

// POST /run
app.post('/run', (req: Request, res: Response) => {
  getCycle(req, true);
  const referrer = req.get('Referrer') || '/';
  res.redirect(referrer);
});

// Dynamic recalculation API endpoint (supports Threshold updates in real-time)
app.post('/api/recalculate', (req: Request, res: Response) => {
  try {
    const rawThresh = req.body && req.body.threshold !== undefined ? req.body.threshold : req.query.threshold;
    if (rawThresh === undefined || rawThresh === null || String(rawThresh).trim() === '') {
      res.status(400).json({
        success: false,
        error: 'Threshold parameter is required. Please provide a decimal between 0.00 and 1.00 (e.g., 0.3, 0.5, 0.7, 0.9).'
      });
      return;
    }

    const parsedThresh = parseFloat(String(rawThresh));
    if (isNaN(parsedThresh) || parsedThresh < 0.0 || parsedThresh > 1.0) {
      res.status(400).json({
        success: false,
        error: `Invalid threshold "${rawThresh}". Threshold must be a numerical value between 0.00 and 1.00.`
      });
      return;
    }

    const { dataDate, mode } = getCycleParams(req);
    const threshold = parsedThresh;

    // Purge cached entry to force fresh calculation pipeline execution
    const cacheKey = `${dataDate || 'default'}_${mode}_${threshold}_false`;
    cache.delete(cacheKey);

    const { cycle, gantt } = runCycle(dataDate, mode, threshold, false);
    cache.set(cacheKey, { cycle, gantt });

    res.json({
      success: true,
      cycle,
      gantt,
      analytics: cycle.analytics,
      kpis: cycle.kpis,
      threshold
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.message || 'Recalculation error'
    });
  }
});

// JSON API
app.get('/api/cycle', (req: Request, res: Response) => {
  const { cycle } = getCycle(req);
  res.json(cycle);
});

app.get('/api/gantt', (req: Request, res: Response) => {
  const { gantt } = getCycle(req);
  res.json(gantt);
});

app.get('/api/activities', (req: Request, res: Response) => {
  const { cycle } = getCycle(req);
  res.json(cycle.activities);
});

app.get('/api/recommendations', (req: Request, res: Response) => {
  const { cycle } = getCycle(req);
  res.json(cycle.recommendations);
});

app.get('/api/analytics', (req: Request, res: Response) => {
  const { cycle } = getCycle(req);
  res.json(cycle.analytics);
});

// Reports endpoints
app.post('/reports/generate', (req: Request, res: Response) => {
  const queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  const sep = queryStr ? '&' : '?';
  res.redirect(`/reports?${queryStr}${sep}generated=project_report.pdf`);
});

app.get('/reports/download', (_req: Request, res: Response) => {
  const pdfPath = path.join(ROOT, 'artifacts/reports/project_report.pdf');
  if (fs.existsSync(pdfPath)) {
    res.download(pdfPath, 'project_report.pdf');
  } else {
    res.status(404).send('No PDF yet - generate it first.');
  }
});

app.get('/reports/status', (_req: Request, res: Response) => {
  const pdfExists = fs.existsSync(path.join(ROOT, 'artifacts/reports/project_report.pdf'));
  const figuresStatus: Record<string, boolean> = {};
  for (const n of FIGURES) {
    figuresStatus[n] = fs.existsSync(path.join(ROOT, `artifacts/figures/${n}.png`));
  }
  res.json({ pdf_exists: pdfExists, figures: figuresStatus });
});

app.get(['/figures/:name.svg', '/figures/:name.png', '/figures/:name'], (req: Request, res: Response) => {
  const rawParam = req.params.name as string;
  const cleanName = rawParam.replace(/\.(svg|png)$/, '');
  if (!FIGURES.includes(cleanName)) {
    res.status(404).send('Figure not found');
    return;
  }
  try {
    const { cycle, gantt } = getCycle(req);
    const svg = generateFigureSvg(cleanName, cycle, gantt);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (err: any) {
    res.status(500).send(`Error generating chart: ${err.message || 'Unknown error'}`);
  }
});

// CSV Exports
app.get('/export/:name.csv', (req: Request, res: Response) => {
  const name = req.params.name as string;
  const { cycle } = getCycle(req);

  let csvContent = '';
  if (name === 'activities' || name === 'schedule' || name === 'tasks') {
    csvContent = toCsv(cycle.activities);
  } else if (name === 'factors') {
    csvContent = toCsv((cycle.factors || []) as any);
  } else if (name === 'recommendations') {
    csvContent = toCsv(cycle.recommendations as any);
  } else if (name === 'predictions') {
    const predRows = cycle.activities.map(a => ({
      activity_id: a.activity_id,
      name: a.name,
      p_delay: a.p_delay,
      predicted_delay_days: a.predicted_delay_days,
      risk_band: a.risk_band,
      at_risk: a.at_risk,
      drivers: a.drivers
    }));
    csvContent = toCsv(predRows);
  } else if (name === 'resources') {
    csvContent = toCsv(cycle.resources.summary as any);
  } else if (name === 'progress') {
    csvContent = toCsv(cycle.progress.activities as any);
  } else {
    res.status(404).send('Export not found');
    return;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(csvContent);
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error('[App Error]', err);
  const status = err.status || 500;
  const message = err.message || 'An internal error occurred.';
  if (req.path.startsWith('/api/')) {
    res.status(status).json({ error: message });
  } else {
    try {
      res.status(status).render('error', {
        c: null,
        pages: PAGES,
        active: '',
        query: '',
        message
      });
    } catch (_renderErr) {
      res.status(status).send(`<!doctype html><html><head><title>Adaptive Scheduler Error</title></head><body style="font-family:sans-serif;padding:2rem"><h1>Error (${status})</h1><p>${message}</p><p><a href="/">Return to Dashboard</a></p></body></html>`);
    }
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Adaptive Scheduler server listening on http://0.0.0.0:${PORT}`);
  });
}

export { app };
export default app;
