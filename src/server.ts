import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCycle, CycleData } from './engine/pipeline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static file serving
app.use('/static', express.static(path.join(ROOT, 'public')));
app.use('/figures', express.static(path.join(ROOT, 'artifacts/figures')));

const PAGES: Array<[string, string, string]> = [
  ['dashboard', 'Dashboard', '/'],
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
      res.render(name, {
        c: cycle,
        pages: PAGES,
        active: name,
        query: queryStr,
        generated: req.query.generated as string || null
      });
    } catch (err) {
      next(err);
    }
  });
}

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Adaptive Scheduler server listening on http://0.0.0.0:${PORT}`);
});
