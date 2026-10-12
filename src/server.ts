import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  loadScheduleTemplate
} from './engine/pipeline';
import { WorkingCalendar } from './engine/calendar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.env.ROOT_DIR || process.cwd();
const VIEWS_DIR = fs.existsSync(path.join(__dirname, 'views'))
  ? path.join(__dirname, 'views')
  : path.join(ROOT, 'src/views');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static file serving
app.use('/static', express.static(path.join(ROOT, 'public')));
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
  if (req.query.threshold) {
    const parsed = parseFloat(req.query.threshold as string);
    if (!isNaN(parsed)) {
      threshold = Math.max(0, Math.min(1, parsed));
    }
  }

  let mode: 'expected' | 'conservative' = 'expected';
  if (req.query.mode === 'conservative') {
    mode = 'conservative';
  }

  const dataDate = typeof req.query.data_date === 'string' && req.query.data_date.trim().length > 0
    ? req.query.data_date.trim()
    : undefined;

  return { dataDate, mode, threshold };
}

function getCycle(req: Request, forceStore = false): CycleCacheEntry {
  const { dataDate, mode, threshold } = getCycleParams(req);
  const cacheKey = `${dataDate || 'default'}_${mode}_${threshold}_${forceStore}`;

  if (!forceStore && cache.has(cacheKey)) {
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
      const { cycle } = getCycle(req);
      const queryStr = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const state = getScheduleState();
      res.render(name, {
        c: cycle,
        pages: PAGES,
        active: name,
        query: queryStr,
        generated: req.query.generated as string || null,
        msg: req.query.msg as string || null,
        error: req.query.error as string || null,
        editId: req.query.editId as string || null,
        state
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

// Schedule Builder REST API Handlers
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

app.get('/figures/:name.png', (req: Request, res: Response) => {
  const name = req.params.name as string;
  if (!FIGURES.includes(name)) {
    res.status(404).send('Figure not found');
    return;
  }
  const filePath = path.join(ROOT, `artifacts/figures/${name}.png`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Figure not found');
  }
});

// CSV Exports
app.get('/export/:name.csv', (req: Request, res: Response) => {
  const name = req.params.name as string;
  const { cycle } = getCycle(req);

  let csvContent = '';
  if (name === 'activities') {
    csvContent = toCsv(cycle.activities);
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
    res.status(status).render('error', {
      c: null,
      pages: PAGES,
      active: '',
      query: '',
      message
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Adaptive Scheduler server listening on http://0.0.0.0:${PORT}`);
  });
}

export { app };
export default app;
