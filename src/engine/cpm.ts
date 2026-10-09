import { Activity, Dependency, ActivitySchedule, CPMResult } from './models';
import { WorkingCalendar } from './calendar';

export class CPMEngine {
  public activities: Activity[];
  public dependencies: Dependency[];
  public calendar: WorkingCalendar;
  private order: string[] = [];
  private preds: Record<string, Array<{ pred: string; type: string; lag: number }>> = {};
  private succs: Record<string, Array<{ succ: string; type: string; lag: number }>> = {};

  constructor(activities: Activity[], dependencies: Dependency[], calendar: WorkingCalendar) {
    this.activities = activities;
    this.dependencies = dependencies;
    this.calendar = calendar;

    const inDegree: Record<string, number> = {};
    const adj: Record<string, string[]> = {};

    for (const a of activities) {
      inDegree[a.activity_id] = 0;
      adj[a.activity_id] = [];
      this.preds[a.activity_id] = [];
      this.succs[a.activity_id] = [];
    }

    for (const d of dependencies) {
      if (adj[d.predecessor] && inDegree[d.successor] !== undefined) {
        adj[d.predecessor].push(d.successor);
        inDegree[d.successor] = (inDegree[d.successor] || 0) + 1;
        this.preds[d.successor].push({ pred: d.predecessor, type: d.dep_type, lag: d.lag });
        this.succs[d.predecessor].push({ succ: d.successor, type: d.dep_type, lag: d.lag });
      }
    }

    // Lexicographical topological sort (using priority queue or sorted queue)
    const available = Object.keys(inDegree).filter(id => inDegree[id] === 0).sort();
    const resultOrder: string[] = [];

    while (available.length > 0) {
      const u = available.shift()!;
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
      throw new Error('Dependency cycle detected in project activities');
    }

    this.order = resultOrder;
  }

  public compute(durationOverrides?: Record<string, number>): CPMResult {
    const dur: Record<string, number> = {};
    for (const a of this.activities) {
      dur[a.activity_id] = a.duration;
    }
    if (durationOverrides) {
      for (const [k, v] of Object.entries(durationOverrides)) {
        dur[k] = Math.max(0, Math.floor(v));
      }
    }

    // Forward pass
    const es: Record<string, number> = {};
    const ef: Record<string, number> = {};

    for (const i of this.order) {
      const d = dur[i];
      let s = 0;
      for (const { pred: p, type: t, lag } of this.preds[i]) {
        let c = 0;
        if (t === 'FS') c = ef[p] + lag;
        else if (t === 'SS') c = es[p] + lag;
        else if (t === 'FF') c = ef[p] + lag - d;
        else if (t === 'SF') c = es[p] + lag - d;
        s = Math.max(s, c);
      }
      es[i] = s;
      ef[i] = s + d;
    }

    const end = Math.max(0, ...Object.values(ef));

    // Backward pass
    const ls: Record<string, number> = {};
    const lf: Record<string, number> = {};

    for (let idx = this.order.length - 1; idx >= 0; idx--) {
      const i = this.order[idx];
      const d = dur[i];
      let f = end;
      for (const { succ: j, type: t, lag } of this.succs[i]) {
        let c = end;
        if (t === 'FS') c = ls[j] - lag;
        else if (t === 'SS') c = ls[j] - lag + d;
        else if (t === 'FF') c = lf[j] - lag;
        else if (t === 'SF') c = lf[j] - lag + d;
        f = Math.min(f, c);
      }
      lf[i] = f;
      ls[i] = f - d;
    }

    // Float calculation
    const schedules: Record<string, ActivitySchedule> = {};
    for (const i of this.order) {
      let ff = end - ef[i];
      for (const { succ: j, type: t, lag } of this.succs[i]) {
        let slack = 0;
        if (t === 'FS') slack = es[j] - ef[i] - lag;
        else if (t === 'SS') slack = es[j] - es[i] - lag;
        else if (t === 'FF') slack = ef[j] - ef[i] - lag;
        else if (t === 'SF') slack = ef[j] - es[i] - lag;
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

    const crit = Object.values(schedules)
      .filter(s => s.critical)
      .sort((a, b) => a.es - b.es || a.ef - b.ef || a.activity_id.localeCompare(b.activity_id))
      .map(s => s.activity_id);

    const cal = this.calendar;
    return {
      schedules,
      project_duration: end,
      critical_path: crit,
      start_date: cal.dateOf(0),
      completion_date: cal.finishDate(end),
      start_of: (aid: string) => cal.dateOf(schedules[aid].es),
      finish_of: (aid: string) => cal.finishDate(schedules[aid].ef)
    };
  }
}
