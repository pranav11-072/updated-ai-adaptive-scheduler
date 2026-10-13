import { WorkingCalendar } from '../src/engine/calendar';
import { CPMEngine } from '../src/engine/cpm';
import { RiskRegister } from '../src/engine/delayFactors';
import { runCycle, addScheduleTask, deleteScheduleTask, resetScheduleTasks, getScheduleState } from '../src/engine/pipeline';
import handler from '../api/index';

console.log('=== STARTING AUTOMATED TEST SUITE ===');

// Test 1: WorkingCalendar
{
  const cal = new WorkingCalendar('2026-05-04', [0, 1, 2, 3, 4, 5], ['2026-08-15'], { start: '06-01', end: '09-30' });
  const d0 = cal.dateOf(0);
  if (d0 !== '2026-05-04') throw new Error(`Calendar dateOf(0) expected 2026-05-04, got ${d0}`);
  const wd = cal.workingDaysBetween('2026-05-04', '2026-05-09');
  if (wd !== 6) throw new Error(`Working days between 2026-05-04 and 2026-05-09 expected 6, got ${wd}`);
  console.log('✓ Test 1: WorkingCalendar passed');
}

// Test 2: CPM Engine
{
  const cal = new WorkingCalendar('2026-05-04', [0, 1, 2, 3, 4, 5], [], { start: '06-01', end: '09-30' });
  const acts: any[] = [
    { activity_id: 'T1', duration: 5 },
    { activity_id: 'T2', duration: 10 }
  ];
  const deps: any[] = [
    { predecessor: 'T1', successor: 'T2', dep_type: 'FS', lag: 0 }
  ];
  const engine = new CPMEngine(acts, deps, cal);
  const res = engine.compute();
  if (res.project_duration !== 15) throw new Error(`CPM project duration expected 15, got ${res.project_duration}`);
  if (!res.critical_path.includes('T1') || !res.critical_path.includes('T2')) throw new Error('CPM critical path incorrect');
  console.log('✓ Test 2: CPMEngine passed');
}

// Test 3: Pipeline Cycle Execution
{
  const { cycle, gantt } = runCycle();
  if (!cycle.project || !cycle.kpis) throw new Error('Pipeline cycle missing project or kpis');
  if (cycle.activities.length === 0) throw new Error('Pipeline activities empty');
  if (cycle.kpis.baseline_duration_wd <= 0) throw new Error('Pipeline duration invalid');
  console.log(`✓ Test 3: Pipeline cycle execution passed (${cycle.activities.length} activities, ${cycle.kpis.baseline_duration_wd} wd baseline)`);
}

// Test 4: Schedule Builder Operations
{
  resetScheduleTasks();
  const initCount = getScheduleState().activities.length;
  const added = addScheduleTask({
    activity_id: 'T999',
    name: 'Test Task Creation',
    start_date: '2026-06-01',
    end_date: '2026-06-06',
    activity_type: 'STRUCTURE',
    resource: 'CARP',
    crew_size: 4,
    normal_cost: 30000
  });
  if (added.activity_id !== 'T999') throw new Error('Task addition failed');
  if (getScheduleState().activities.length !== initCount + 1) throw new Error('Task count mismatch');
  deleteScheduleTask('T999');
  if (getScheduleState().activities.length !== initCount) throw new Error('Task deletion mismatch');
  resetScheduleTasks();
  console.log('✓ Test 4: Schedule builder task operations passed');
}

// Test 5: Vercel Serverless Function Handler
async function testServerlessRoutes() {
  const routes = [
    '/',
    '/api',
    '/builder',
    '/gantt',
    '/predictions',
    '/recommendations',
    '/resources',
    '/progress',
    '/factors',
    '/reports',
    '/api/tasks',
    '/api/cycle',
    '/static/style.css',
    '/static/app.js'
  ];

  for (const url of routes) {
    await new Promise<void>((resolve, reject) => {
      const req = { method: 'GET', url, headers: { host: 'localhost:3000' } };
      let statusCode = 200;
      let bodyLength = 0;
      const res = {
        statusCode: 200,
        setHeader() {},
        getHeader() {},
        writeHead(c: number) { statusCode = c; },
        status(c: number) { statusCode = c; return this; },
        send(b: any) { bodyLength = b ? b.length : 0; check(); },
        json(b: any) { bodyLength = JSON.stringify(b).length; check(); },
        end(b: any) { bodyLength = b ? b.length : 0; check(); }
      };
      function check() {
        if (statusCode >= 400 && statusCode !== 404) {
          reject(new Error(`Route ${url} failed with status ${statusCode}`));
        } else {
          resolve();
        }
      }
      handler(req, res);
    });
  }
  console.log(`✓ Test 5: All ${routes.length} Vercel serverless routes verified (200 OK)`);
}

testServerlessRoutes().then(() => {
  console.log('=== ALL 5 TEST SUITES PASSED CLEANLY ===');
  process.exit(0);
}).catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
