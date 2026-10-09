export class WorkingCalendar {
  public start: string;
  public workDays: number[]; // 0=Mon, 1=Tue, ..., 5=Sat, 6=Sun
  public holidays: Set<string>;
  public monsoonStart: [number, number]; // [month, day] (1-indexed)
  public monsoonEnd: [number, number];
  private _days: string[] = [];

  constructor(
    startDate: string,
    workDays: number[] = [0, 1, 2, 3, 4, 5],
    holidays: string[] = [],
    monsoon = { start: '06-01', end: '09-30' }
  ) {
    this.start = startDate;
    this.workDays = workDays;
    this.holidays = new Set(holidays);
    const [msM, msD] = monsoon.start.split('-').map(Number);
    const [meM, meD] = monsoon.end.split('-').map(Number);
    this.monsoonStart = [msM, msD];
    this.monsoonEnd = [meM, meD];
  }

  private parseDate(dStr: string): Date {
    const [y, m, d] = dStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  private formatDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  public isWorkingDay(dStr: string): boolean {
    if (this.holidays.has(dStr)) return false;
    const d = this.parseDate(dStr);
    // JS getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat
    // Python weekday: 0=Mon, ..., 5=Sat, 6=Sun
    const pyWeekday = (d.getUTCDay() + 6) % 7;
    return this.workDays.includes(pyWeekday);
  }

  public inMonsoon(dStr: string): boolean {
    const d = this.parseDate(dStr);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const [sM, sD] = this.monsoonStart;
    const [eM, eD] = this.monsoonEnd;

    const afterStart = month > sM || (month === sM && day >= sD);
    const beforeEnd = month < eM || (month === eM && day <= eD);

    if (sM <= eM) {
      return afterStart && beforeEnd;
    } else {
      return afterStart || beforeEnd;
    }
  }

  private extend(count?: number, until?: string): void {
    let curDate: Date;
    if (this._days.length === 0) {
      curDate = this.parseDate(this.start);
    } else {
      const last = this.parseDate(this._days[this._days.length - 1]);
      curDate = new Date(last.getTime() + 86400000);
    }

    const untilDate = until ? this.parseDate(until) : null;

    while (
      (count !== undefined && this._days.length < count) ||
      (untilDate !== null && (this._days.length === 0 || this.parseDate(this._days[this._days.length - 1]) < untilDate))
    ) {
      const formatted = this.formatDate(curDate);
      if (this.isWorkingDay(formatted)) {
        this._days.push(formatted);
      }
      curDate = new Date(curDate.getTime() + 86400000);
    }
  }

  public dateOf(offset: number): string {
    if (offset < 0) throw new Error('offset must be >= 0');
    this.extend(offset + 1);
    return this._days[offset];
  }

  public finishDate(ef: number): string {
    return this.dateOf(Math.max(ef - 1, 0));
  }

  public offsetOf(dStr: string): number {
    this.extend(undefined, dStr);
    const idx = this._days.findIndex(day => day >= dStr);
    return idx === -1 ? this._days.length : idx;
  }

  public elapsedDays(dStr: string): number {
    if (dStr < this.start) return 0;
    this.extend(undefined, dStr);
    let count = 0;
    for (const day of this._days) {
      if (day <= dStr) count++;
      else break;
    }
    return count;
  }

  public span(startOffset: number, endOffset: number): number {
    if (endOffset <= startOffset) return 0;
    const d1 = this.parseDate(this.dateOf(startOffset));
    const d2 = this.parseDate(this.dateOf(endOffset - 1));
    return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
  }

  public monsoonExposure(startOffset: number, endOffset: number): number {
    const n = endOffset - startOffset;
    if (n <= 0) return 0.0;
    let hits = 0;
    for (let k = startOffset; k < endOffset; k++) {
      if (this.inMonsoon(this.dateOf(k))) hits++;
    }
    return hits / n;
  }
}
