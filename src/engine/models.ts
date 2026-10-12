export interface Activity {
  activity_id: string;
  wbs: string;
  name: string;
  activity_type: string;
  duration: number;
  quantity: number;
  unit: string;
  crew_size: number;
  resource: string;
  normal_cost: number;
  crash_duration: number | null;
  crash_cost: number | null;
  percent_complete: number;
  actual_delay_days: number;
  max_crash_days: number;
  cost_slope: number;
  start_date?: string;
  end_date?: string;
  predecessors?: string;
}

export interface Dependency {
  predecessor: string;
  successor: string;
  dep_type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
}

export interface ResourceDef {
  code: string;
  name: string;
  available: number;
}

export interface ProjectMetadata {
  project_id: string;
  name: string;
  start_date: string;
  data_date: string;
  location: string;
  data_source: string;
  description: string;
  work_week: number[];
  holidays: string[];
  monsoon: {
    start: string;
    end: string;
  };
  resources: Record<string, { name: string; available: number }>;
}

export interface ActivitySchedule {
  activity_id: string;
  duration: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  total_float: number;
  free_float: number;
  critical: boolean;
}

export interface CPMResult {
  schedules: Record<string, ActivitySchedule>;
  project_duration: number;
  critical_path: string[];
  start_date: string;
  completion_date: string;
  start_of: (aid: string) => string;
  finish_of: (aid: string) => string;
}
