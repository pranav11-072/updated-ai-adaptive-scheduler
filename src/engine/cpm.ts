import { Activity, Dependency, ActivitySchedule, CPMResult } from './models';
import { WorkingCalendar } from './calendar';

export class CPMEngine {
  public activities: Activity[];
  public dependencies: Dependency[];
  public calendar: WorkingCalendar;
  public startOffsets: Record<string, number>;
  private order: string[] = [];
  private preds: Record<string, Array<{ pred: string; type: string; lag: number }>> = {};
  private succs: Record<string, Array<{ succ: string; type: string; lag: number }>> = {};

  constructor(
    activities: Activity[],
    dependencies: Dependency[],
    calendar: WorkingCalendar,
    startOffsets?: Record<string, number>
  ) {
    this.activities = activities;
    this.dependencies = dependencies;
    this.calendar = calendar;
    this.startOffsets = startOffsets || {};

    if (activities.length === 0) {
      this.order = [];
      return;
    }

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

  public compute(
    durationOverrides?: Record<string, number>,
    dataDateOffset?: number,
    completedIds?: Set<string>,
    inProgressProgress?: Record<string, number>
  ): CPMResult {
    const cal = this.calendar;
    if (this.activities.length === 0) {
      return {
        schedules: {},
        project_duration: 0,
        critical_path: [],
        start_date: cal.start,
        completion_date: cal.start,
        start_of: () => cal.start,
        finish_of: () => cal.start
      };
    }

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
      let s = this.startOffsets[i] !== undefined ? this.startOffsets[i] : 0;
      for (const { pred: p, type: t, lag } of this.preds[i]) {
        let c = 0;
        if (t === 'FS') c = ef[p] + lag;
        else if (t === 'SS') c = es[p] + lag;
        else if (t === 'FF') c = ef[p] + lag - d;
        else if (t === 'SF') c = es[p] + lag - d;
        s = Math.max(s, c);
      }

      if (dataDateOffset !== undefined && dataDateOffset > 0) {
        const isCompleted = completedIds ? completedIds.has(i) : false;
        if (!isCompleted) {
          const pct = inProgressProgress ? (inProgressProgress[i] || 0) : 0;
          if (pct > 0 && pct < 100) {
            // Activity in progress: remaining work must finish on or after dataDateOffset
            const remDur = Math.max(1, Math.ceil(d * (1 - pct / 100) - 1e-9));
            const minFinish = dataDateOffset + remDur;
            if (s + d < minFinish) {
              s = Math.max(s, minFinish - d);
            }
          } else {
            // Activity not started: cannot start before dataDateOffset
            s = Math.max(s, dataDateOffset);
          }
        }
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
