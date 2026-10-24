import { Activity, Dependency, ProjectMetadata } from './models';
import { WorkingCalendar } from './calendar';

export interface BuildingConfig {
  has_ground_floor: boolean;
  floors_above_ground: number; // N, e.g. 0, 2, 3, 10, 20
  basement_floors: number; // e.g. 0, 1, 2
  construction_method: 'rcc_framed' | 'precast' | 'steel_composite';
  building_type: 'residential' | 'commercial' | 'mixed_use' | 'institutional';
  building_name?: string;
  total_levels: number;
  config_label: string; // e.g. "G+0", "G+2", "G+3", "G+10", "G+20", "B1+G+10"
}

export interface GeneratedSchedule {
  project: ProjectMetadata;
  activities: Activity[];
  dependencies: Dependency[];
  building_config: BuildingConfig;
}

export function formatConfigLabel(basements: number, hasGround: boolean, aboveGround: number): string {
  const parts: string[] = [];
  if (basements > 0) {
    parts.push(`B${basements}`);
  }
  if (hasGround) {
    parts.push(`G+${aboveGround}`);
  } else {
    parts.push(`${aboveGround} Levels`);
  }
  return parts.join('+');
}

export function validateBuildingConfig(input: Partial<BuildingConfig>): {
  valid: boolean;
  error?: string;
  config: BuildingConfig;
} {
  const hasGround = input.has_ground_floor !== undefined ? Boolean(input.has_ground_floor) : true;
  const rawAbove = input.floors_above_ground !== undefined ? Number(input.floors_above_ground) : 3;
  const rawBasement = input.basement_floors !== undefined ? Number(input.basement_floors) : 0;

  if (isNaN(rawAbove) || rawAbove < 0 || !Number.isInteger(rawAbove)) {
    return { valid: false, error: 'Number of floors above ground must be a non-negative integer (e.g. 0, 2, 3, 10, 20).', config: null as any };
  }
  if (rawAbove > 60) {
    return { valid: false, error: 'Configurable building limit is 60 floors above ground.', config: null as any };
  }
  if (isNaN(rawBasement) || rawBasement < 0 || !Number.isInteger(rawBasement)) {
    return { valid: false, error: 'Basement floors must be a non-negative integer (0 to 5).', config: null as any };
  }
  if (rawBasement > 5) {
    return { valid: false, error: 'Maximum supported basement levels is 5.', config: null as any };
  }

  const totalLevels = (rawBasement) + (hasGround ? 1 : 0) + rawAbove;
  if (totalLevels < 1) {
    return { valid: false, error: 'Building must have at least one level (Ground floor, basement, or 1st floor).', config: null as any };
  }

  const method = input.construction_method || 'rcc_framed';
  const type = input.building_type || 'residential';
  const label = formatConfigLabel(rawBasement, hasGround, rawAbove);

  const typeName = type.charAt(0).toUpperCase() + type.slice(1);
  const name = input.building_name || `${label} ${typeName} Building`;

  return {
    valid: true,
    config: {
      has_ground_floor: hasGround,
      floors_above_ground: rawAbove,
      basement_floors: rawBasement,
      construction_method: method,
      building_type: type,
      building_name: name,
      total_levels: totalLevels,
      config_label: label
    }
  };
}

export function generateGNProjectSchedule(
  inputConfig: Partial<BuildingConfig>,
  baseMetadata?: ProjectMetadata
): GeneratedSchedule {
  const validation = validateBuildingConfig(inputConfig);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const cfg = validation.config;

  const startDate = baseMetadata?.start_date || '2026-05-04';
  const dataDate = baseMetadata?.data_date || '2026-05-20';
  const location = baseMetadata?.location || 'Bengaluru, Karnataka, India (illustrative)';

  const workWeek = baseMetadata?.work_week || [0, 1, 2, 3, 4, 5];
  const holidays = baseMetadata?.holidays || [
    '2026-05-27', '2026-08-15', '2026-09-14', '2026-10-02', '2026-10-20',
    '2026-11-09', '2026-11-10', '2026-12-25', '2027-01-01', '2027-01-26'
  ];
  const monsoon = baseMetadata?.monsoon || { start: '06-01', end: '09-30' };

  // Scaled resource capacity for tall buildings so higher floors don't bottleneck unrealistically
  const scale = cfg.total_levels > 10 ? 1.5 : cfg.total_levels > 5 ? 1.2 : 1.0;
  const resources = baseMetadata?.resources || {
    BARB: { name: 'Bar benders', available: Math.round(12 * scale) },
    CARP: { name: 'Carpenters', available: Math.round(14 * scale) },
    ELEC: { name: 'Electricians', available: Math.round(8 * scale) },
    EXC: { name: 'Excavators with operator', available: Math.round(2 * scale) },
    HELPER: { name: 'Helpers / general labour', available: Math.round(30 * scale) },
    MASON: { name: 'Masons', available: Math.round(24 * scale) },
    MIXER: { name: 'Concrete mixers / pumps', available: Math.round(3 * scale) },
    PAINT: { name: 'Painters', available: Math.round(12 * scale) },
    PLUM: { name: 'Plumbers', available: Math.round(8 * scale) },
    TILER: { name: 'Tilers', available: Math.round(10 * scale) }
  };

  const activities: Activity[] = [];
  const dependencies: Dependency[] = [];

  let actNum = 10;
  function nextId(): string {
    const s = String(actNum).padStart(3, '0');
    actNum += 10;
    return `A${s}`;
  }

  function addAct(a: {
    wbs: string;
    name: string;
    activity_type: any;
    duration: number;
    quantity: number;
    unit: string;
    crew_size: number;
    resource: string;
    normal_cost: number;
    crash_duration?: number | null;
    crash_cost?: number | null;
    percent_complete?: number;
    actual_delay_days?: number;
    max_crash_days?: number;
    cost_slope?: number;
    start_date?: string;
    end_date?: string;
    predecessors?: string;
    floor?: string;
    id?: string;
  }): string {
    const aid = a.id || nextId();
    activities.push({
      activity_id: aid,
      wbs: a.wbs,
      name: a.name,
      activity_type: a.activity_type,
      duration: a.duration,
      quantity: a.quantity,
      unit: a.unit,
      crew_size: a.crew_size,
      resource: a.resource,
      normal_cost: a.normal_cost,
      crash_duration: a.crash_duration ?? null,
      crash_cost: a.crash_cost ?? null,
      percent_complete: a.percent_complete ?? 0,
      actual_delay_days: a.actual_delay_days ?? 0,
      max_crash_days: a.max_crash_days ?? (a.crash_duration && a.crash_duration < a.duration ? a.duration - a.crash_duration : 0),
      cost_slope: a.cost_slope ?? (a.crash_duration && a.crash_duration < a.duration && a.crash_cost ? (a.crash_cost - a.normal_cost) / (a.duration - a.crash_duration) : 0),
      start_date: a.start_date,
      end_date: a.end_date,
      predecessors: a.predecessors || '',
      floor: a.floor
    });
    return aid;
  }

  function addDep(pred: string, succ: string, dep_type: 'FS' | 'SS' | 'FF' | 'SF' = 'FS', lag = 0) {
    if (!pred || !succ || pred === succ) return;
    if (dependencies.some(d => d.predecessor === pred && d.successor === succ && d.dep_type === dep_type)) return;
    dependencies.push({ predecessor: pred, successor: succ, dep_type, lag });
  }

  // Build floor list from bottom to top
  // e.g. [ { code: 'B2', name: 'Basement 2' }, { code: 'B1', name: 'Basement 1' }, { code: 'GF', name: 'Ground Floor' }, { code: '1F', name: 'First Floor' }, ... ]
  interface FloorItem {
    code: string;
    name: string;
    isBasement: boolean;
    isGround: boolean;
    isTop: boolean;
    levelIndex: number;
  }
  const floorList: FloorItem[] = [];

  for (let b = cfg.basement_floors; b >= 1; b--) {
    floorList.push({
      code: `B${b}`,
      name: `Basement ${b}`,
      isBasement: true,
      isGround: false,
      isTop: false,
      levelIndex: floorList.length
    });
  }

  if (cfg.has_ground_floor) {
    floorList.push({
      code: 'GF',
      name: 'Ground Floor',
      isBasement: false,
      isGround: true,
      isTop: cfg.floors_above_ground === 0,
      levelIndex: floorList.length
    });
  }

  for (let f = 1; f <= cfg.floors_above_ground; f++) {
    floorList.push({
      code: `${f}F`,
      name: f === 1 ? 'First Floor' : f === 2 ? 'Second Floor' : f === 3 ? 'Third Floor' : `Floor ${f}`,
      isBasement: false,
      isGround: false,
      isTop: f === cfg.floors_above_ground,
      levelIndex: floorList.length
    });
  }

  // 1. SUBSTRUCTURE ACTIVITIES (Project-Level, once)
  const aMob = addAct({ wbs: '1.1', name: 'Site mobilisation and hoarding', activity_type: 'SUBSTRUCTURE', duration: 4, quantity: 1, unit: 'LS', crew_size: 6, resource: 'HELPER', normal_cost: 16560, crash_duration: 3, crash_cost: 18720, percent_complete: 100, floor: 'Substructure' });
  const aSet = addAct({ wbs: '1.2', name: 'Site clearing and setting-out', activity_type: 'SUBSTRUCTURE', duration: 5, quantity: 900, unit: 'm2', crew_size: 8, resource: 'HELPER', normal_cost: 27600, crash_duration: 3, crash_cost: 33360, percent_complete: 100, floor: 'Substructure' });
  addDep(aMob, aSet, 'FS', 0);

  const excavDur = cfg.basement_floors > 0 ? 8 + cfg.basement_floors * 4 : 8;
  const aExc = addAct({ wbs: '1.3', name: cfg.basement_floors > 0 ? `Deep bulk excavation and earth retention (${cfg.basement_floors} basements)` : 'Bulk excavation', activity_type: 'SUBSTRUCTURE', duration: excavDur, quantity: 1400 * (1 + cfg.basement_floors * 0.8), unit: 'm3', crew_size: 4, resource: 'EXC', normal_cost: 165600 + cfg.basement_floors * 80000, crash_duration: Math.max(5, excavDur - 3), crash_cost: 190000 + cfg.basement_floors * 90000, percent_complete: 100, actual_delay_days: 2, floor: 'Substructure' });
  addDep(aSet, aExc, 'FS', 0);

  const aPcc = addAct({ wbs: '1.4', name: 'Footing trimming and PCC bed', activity_type: 'SUBSTRUCTURE', duration: 4, quantity: 90, unit: 'm3', crew_size: 8, resource: 'MASON', normal_cost: 34960, crash_duration: 3, crash_cost: 39520, percent_complete: 100, floor: 'Substructure' });
  addDep(aExc, aPcc, 'SS', 3);

  const aFootRebar = addAct({ wbs: '1.5', name: 'Footing reinforcement', activity_type: 'SUBSTRUCTURE', duration: 6, quantity: 14, unit: 't', crew_size: 10, resource: 'BARB', normal_cost: 62100, crash_duration: 4, crash_cost: 72900, percent_complete: 100, actual_delay_days: 1, floor: 'Substructure' });
  addDep(aPcc, aFootRebar, 'FS', 0);

  const aFootForm = addAct({ wbs: '1.6', name: 'Footing formwork', activity_type: 'SUBSTRUCTURE', duration: 5, quantity: 420, unit: 'm2', crew_size: 8, resource: 'CARP', normal_cost: 43700, crash_duration: 3, crash_cost: 52820, percent_complete: 100, floor: 'Substructure' });
  addDep(aPcc, aFootForm, 'SS', 2);

  const aFootPour = addAct({ wbs: '1.7', name: 'Footing concrete pour', activity_type: 'SUBSTRUCTURE', duration: 2, quantity: 160, unit: 'm3', crew_size: 4, resource: 'MIXER', normal_cost: 11500, percent_complete: 100, floor: 'Substructure' });
  addDep(aFootRebar, aFootPour, 'FS', 0);
  addDep(aFootForm, aFootPour, 'FS', 0);

  const aFootCure = addAct({ wbs: '1.8', name: 'Footing curing and strip', activity_type: 'SUBSTRUCTURE', duration: 4, quantity: 0, unit: '-', crew_size: 4, resource: 'HELPER', normal_cost: 11040, percent_complete: 100, floor: 'Substructure' });
  addDep(aFootPour, aFootCure, 'FS', 0);

  const aPlinthRebar = addAct({ wbs: '1.9', name: 'Plinth beam reinforcement', activity_type: 'SUBSTRUCTURE', duration: 6, quantity: 9, unit: 't', crew_size: 10, resource: 'BARB', normal_cost: 62100, crash_duration: 4, crash_cost: 72900, percent_complete: 100, floor: 'Substructure' });
  addDep(aFootPour, aPlinthRebar, 'FS', 3);

  const aPlinthForm = addAct({ wbs: '1.10', name: 'Plinth beam formwork', activity_type: 'SUBSTRUCTURE', duration: 5, quantity: 380, unit: 'm2', crew_size: 8, resource: 'CARP', normal_cost: 43700, crash_duration: 3, crash_cost: 52820, percent_complete: 100, floor: 'Substructure' });
  addDep(aPlinthRebar, aPlinthForm, 'SS', 2);

  const aPlinthPour = addAct({ wbs: '1.11', name: 'Plinth beam concrete', activity_type: 'SUBSTRUCTURE', duration: 2, quantity: 60, unit: 'm3', crew_size: 3, resource: 'MIXER', normal_cost: 11500, percent_complete: 100, floor: 'Substructure' });
  addDep(aPlinthRebar, aPlinthPour, 'FS', 0);
  addDep(aPlinthForm, aPlinthPour, 'FS', 0);

  const aBackfill = addAct({ wbs: '1.12', name: 'Backfilling and compaction', activity_type: 'SUBSTRUCTURE', duration: 6, quantity: 700, unit: 'm3', crew_size: 4, resource: 'EXC', normal_cost: 124200, crash_duration: 4, crash_cost: 145800, percent_complete: 100, actual_delay_days: 2, floor: 'Substructure' });
  addDep(aPlinthPour, aBackfill, 'FS', 2);
  addDep(aFootCure, aBackfill, 'FS', 0);

  const aWaterproof = addAct({ wbs: '1.13', name: 'Waterproofing and anti-termite treatment', activity_type: 'SUBSTRUCTURE', duration: 3, quantity: 520, unit: 'm2', crew_size: 6, resource: 'HELPER', normal_cost: 12420, crash_duration: 2, crash_cost: 14580, percent_complete: 100, floor: 'Substructure' });
  addDep(aBackfill, aWaterproof, 'FS', 0);

  const aPlinthPcc = addAct({ wbs: '1.14', name: 'Plinth filling and PCC', activity_type: 'SUBSTRUCTURE', duration: 4, quantity: 450, unit: 'm2', crew_size: 8, resource: 'MASON', normal_cost: 34960, crash_duration: 3, crash_cost: 39520, percent_complete: 100, floor: 'Substructure' });
  addDep(aWaterproof, aPlinthPcc, 'FS', 0);

  // 2. FLOOR-BY-FLOOR STRUCTURAL WORK
  interface FloorStructIds {
    floor: FloorItem;
    colRebarForm: string;
    colPour: string;
    slabForm: string;
    slabRebar: string;
    slabPour: string;
    slabCure: string;
  }
  const structMap: Record<string, FloorStructIds> = {};
  let lastSlabPour = aPlinthPcc;
  let lastSlabCure = aPlinthPcc;

  floorList.forEach((fl, idx) => {
    const colRebarForm = addAct({
      wbs: `2.${idx * 6 + 1}`,
      name: `${fl.code} Column cage and formwork (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 6,
      quantity: 18,
      unit: 't',
      crew_size: 10,
      resource: 'BARB',
      normal_cost: 62100,
      crash_duration: 4,
      crash_cost: 72900,
      percent_complete: idx === 0 ? 100 : idx === 1 ? 70 : 0,
      actual_delay_days: 0,
      floor: fl.code
    });

    // Progression from previous floor
    if (idx === 0) {
      addDep(aPlinthPcc, colRebarForm, 'FS', 0);
    } else {
      addDep(lastSlabPour, colRebarForm, 'FS', 2);
      addDep(lastSlabCure, colRebarForm, 'SS', 4);
    }

    const colPour = addAct({
      wbs: `2.${idx * 6 + 2}`,
      name: `${fl.code} Column concreting (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 2,
      quantity: 30,
      unit: 'm3',
      crew_size: 3,
      resource: 'MIXER',
      normal_cost: 11500,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });
    addDep(colRebarForm, colPour, 'FS', 0);

    const slabForm = addAct({
      wbs: `2.${idx * 6 + 3}`,
      name: `${fl.code} Slab and beam formwork (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 8,
      quantity: 620,
      unit: 'm2',
      crew_size: 12,
      resource: 'CARP',
      normal_cost: 104880,
      crash_duration: 6,
      crash_cost: 118560,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });
    addDep(colPour, slabForm, 'FS', 2);

    const slabRebar = addAct({
      wbs: `2.${idx * 6 + 4}`,
      name: `${fl.code} Slab reinforcement (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 7,
      quantity: 16,
      unit: 't',
      crew_size: 12,
      resource: 'BARB',
      normal_cost: 86940,
      crash_duration: 5,
      crash_cost: 99900,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });
    addDep(slabForm, slabRebar, 'SS', 4);
    addDep(slabForm, slabRebar, 'FF', 2);

    const slabPour = addAct({
      wbs: `2.${idx * 6 + 5}`,
      name: `${fl.code} Slab concreting (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 2,
      quantity: 95,
      unit: 'm3',
      crew_size: 3,
      resource: 'MIXER',
      normal_cost: 17250,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });
    addDep(slabRebar, slabPour, 'FS', 0);

    const slabCure = addAct({
      wbs: `2.${idx * 6 + 6}`,
      name: `${fl.code} Slab curing and deshuttering (${fl.name.toLowerCase()})`,
      activity_type: 'STRUCTURE',
      duration: 7,
      quantity: 0,
      unit: '-',
      crew_size: 4,
      resource: 'HELPER',
      normal_cost: 19320,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });
    addDep(slabPour, slabCure, 'FS', 0);

    structMap[fl.code] = {
      floor: fl,
      colRebarForm,
      colPour,
      slabForm,
      slabRebar,
      slabPour,
      slabCure
    };

    lastSlabPour = slabPour;
    lastSlabCure = slabCure;
  });

  // Top Terrace Structure
  const aStair = addAct({ wbs: '2.90', name: 'Staircase and landing concrete', activity_type: 'STRUCTURE', duration: 6, quantity: 28, unit: 'm3', crew_size: 6, resource: 'CARP', normal_cost: 39330, crash_duration: 4, crash_cost: 46170, floor: 'Terrace' });
  addDep(lastSlabPour, aStair, 'FS', 0);

  const aOht = addAct({ wbs: '2.91', name: 'Overhead tank and parapet', activity_type: 'STRUCTURE', duration: 7, quantity: 22, unit: 'm3', crew_size: 8, resource: 'MASON', normal_cost: 61180, crash_duration: 5, crash_cost: 70300, floor: 'Terrace' });
  addDep(lastSlabPour, aOht, 'FS', 3);

  // 3. ARCHITECTURAL / MASONRY PER FLOOR
  const brickMap: Record<string, string> = {};
  let prevBrick = '';
  floorList.forEach((fl, idx) => {
    const dur = idx === floorList.length - 1 ? 12 : 14;
    const aBrick = addAct({
      wbs: `3.${idx + 1}`,
      name: `${fl.code} brickwork`,
      activity_type: 'MASONRY',
      duration: dur,
      quantity: 52000,
      unit: 'nos',
      crew_size: 12,
      resource: 'MASON',
      normal_cost: 183540,
      crash_duration: 10,
      crash_cost: 210900,
      percent_complete: idx === 0 ? 100 : 0,
      floor: fl.code
    });

    // Masonry starts after the floor's own slab has cured
    addDep(structMap[fl.code].slabCure, aBrick, 'FS', 0);
    // Pipelined between consecutive floors
    if (prevBrick) {
      addDep(prevBrick, aBrick, 'SS', 3);
    }
    brickMap[fl.code] = aBrick;
    prevBrick = aBrick;
  });

  // 4. MEP CONDUITING & PLUMBING PER FLOOR (Or grouped 2-floor blocks for large projects)
  const elecCondMap: Record<string, string> = {};
  const plumRoughMap: Record<string, string> = {};
  floorList.forEach((fl, idx) => {
    const aElec = addAct({
      wbs: `4.1.${idx + 1}`,
      name: `Electrical conduits and boxes (${fl.code})`,
      activity_type: 'MEP',
      duration: 8,
      quantity: 1,
      unit: 'LS',
      crew_size: 6,
      resource: 'ELEC',
      normal_cost: 55200,
      crash_duration: 6,
      crash_cost: 62400,
      floor: fl.code
    });
    addDep(brickMap[fl.code], aElec, 'FS', 0);
    elecCondMap[fl.code] = aElec;

    const aPlum = addAct({
      wbs: `4.2.${idx + 1}`,
      name: `Plumbing rough-in (${fl.code})`,
      activity_type: 'MEP',
      duration: 8,
      quantity: 1,
      unit: 'LS',
      crew_size: 6,
      resource: 'PLUM',
      normal_cost: 55200,
      crash_duration: 6,
      crash_cost: 62400,
      floor: fl.code
    });
    addDep(aElec, aPlum, 'SS', 2);
    plumRoughMap[fl.code] = aPlum;
  });

  // 5. INTERNAL PLASTERING PER FLOOR
  const plasterMap: Record<string, string> = {};
  let prevPlast = '';
  floorList.forEach((fl, idx) => {
    const aPlast = addAct({
      wbs: `3.20.${idx + 1}`,
      name: `${fl.code} internal plaster`,
      activity_type: 'MASONRY',
      duration: idx === floorList.length - 1 ? 10 : 12,
      quantity: 1450,
      unit: 'm2',
      crew_size: 10,
      resource: 'MASON',
      normal_cost: 131100,
      crash_duration: 9,
      crash_cost: 148200,
      floor: fl.code
    });
    addDep(elecCondMap[fl.code], aPlast, 'FS', 0);
    addDep(plumRoughMap[fl.code], aPlast, 'FS', 0);
    if (prevPlast) {
      addDep(prevPlast, aPlast, 'SS', 3);
    }
    plasterMap[fl.code] = aPlast;
    prevPlast = aPlast;
  });

  // External Scaffolding and Plaster
  const topBrick = brickMap[floorList[floorList.length - 1].code];
  const aScaff = addAct({ wbs: '3.30', name: 'External scaffolding erection', activity_type: 'MASONRY', duration: 5, quantity: 1600, unit: 'm2', crew_size: 10, resource: 'HELPER', normal_cost: 34500, crash_duration: 3, crash_cost: 41700, floor: 'External' });
  addDep(topBrick, aScaff, 'SS', 2);

  const aExtPlast = addAct({ wbs: '3.31', name: 'External plastering', activity_type: 'MASONRY', duration: 18, quantity: 1600, unit: 'm2', crew_size: 12, resource: 'MASON', normal_cost: 235980, crash_duration: 13, crash_cost: 270180, floor: 'External' });
  addDep(aScaff, aExtPlast, 'FS', 0);
  addDep(topBrick, aExtPlast, 'FS', 0);

  // Electrical Wiring
  const aElecWiring = addAct({ wbs: '4.50', name: 'Electrical wiring and distribution boards', activity_type: 'MEP', duration: 10, quantity: 1, unit: 'LS', crew_size: 8, resource: 'ELEC', normal_cost: 92000, crash_duration: 7, crash_cost: 106400, floor: 'MEP' });
  const midFloorIndex = Math.floor(floorList.length / 2);
  const midPlast = plasterMap[floorList[midFloorIndex].code];
  addDep(midPlast, aElecWiring, 'FS', 0);
  addDep(prevPlast, aElecWiring, 'SS', 3);

  // 6. FINISHES & TILING PER FLOOR
  const aDoorFrames = addAct({ wbs: '5.10', name: 'Door and window frame fixing', activity_type: 'FINISH', duration: 6, quantity: 24 * floorList.length, unit: 'nos', crew_size: 8, resource: 'CARP', normal_cost: 52440, crash_duration: 4, crash_cost: 61560, floor: 'Finishes' });
  addDep(topBrick, aDoorFrames, 'SS', 4);

  const tileMap: Record<string, string> = {};
  let prevTile = '';
  floorList.forEach((fl, idx) => {
    const aTile = addAct({
      wbs: `5.20.${idx + 1}`,
      name: `Flooring tiles (${fl.code})`,
      activity_type: 'FINISH',
      duration: 14,
      quantity: 780,
      unit: 'm2',
      crew_size: 8,
      resource: 'TILER',
      normal_cost: 128800,
      crash_duration: 10,
      crash_cost: 148000,
      floor: fl.code
    });
    addDep(plasterMap[fl.code], aTile, 'FS', 0);
    addDep(aDoorFrames, aTile, 'FS', 0);
    if (prevTile) {
      addDep(prevTile, aTile, 'SS', 3);
    }
    tileMap[fl.code] = aTile;
    prevTile = aTile;
  });

  const aToiletTiles = addAct({ wbs: '5.30', name: 'Toilet wall tiling & waterproofing inspection', activity_type: 'FINISH', duration: 10, quantity: 90 * floorList.length, unit: 'm2', crew_size: 6, resource: 'TILER', normal_cost: 69000, crash_duration: 7, crash_cost: 79800, floor: 'Finishes' });
  addDep(plumRoughMap[floorList[floorList.length - 1].code], aToiletTiles, 'FS', 0);

  const aPutty = addAct({ wbs: '5.40', name: 'Putty and primer', activity_type: 'FINISH', duration: 8, quantity: 800 * floorList.length, unit: 'm2', crew_size: 8, resource: 'PAINT', normal_cost: 62560, crash_duration: 6, crash_cost: 70720, floor: 'Finishes' });
  addDep(prevPlast, aPutty, 'FS', 3);
  addDep(aElecWiring, aPutty, 'FS', 0);

  const aPaintInt = addAct({ wbs: '5.50', name: 'Internal painting', activity_type: 'FINISH', duration: 14, quantity: 800 * floorList.length, unit: 'm2', crew_size: 12, resource: 'PAINT', normal_cost: 164220, crash_duration: 10, crash_cost: 188700, floor: 'Finishes' });
  addDep(aPutty, aPaintInt, 'FS', 0);
  addDep(prevTile, aPaintInt, 'FS', -2);

  const aFixtures = addAct({ wbs: '4.60', name: 'Fixtures: lights, switches, sanitaryware', activity_type: 'MEP', duration: 8, quantity: 1, unit: 'LS', crew_size: 6, resource: 'ELEC', normal_cost: 55200, crash_duration: 6, crash_cost: 62400, floor: 'Finishes' });
  addDep(aPaintInt, aFixtures, 'FS', 0);
  addDep(aToiletTiles, aFixtures, 'FS', 0);

  const aPaintExt = addAct({ wbs: '5.70', name: 'External painting', activity_type: 'FINISH', duration: 12, quantity: 1600, unit: 'm2', crew_size: 8, resource: 'PAINT', normal_cost: 93840, crash_duration: 9, crash_cost: 106080, floor: 'External' });
  addDep(aExtPlast, aPaintExt, 'FS', 3);

  // 7. EXTERNAL WORKS & HANDOVER
  const aCompound = addAct({ wbs: '6.10', name: 'Compound wall and gate', activity_type: 'EXTERNAL', duration: 15, quantity: 120, unit: 'm', crew_size: 8, resource: 'MASON', normal_cost: 131100, crash_duration: 11, crash_cost: 149340, floor: 'External' });
  addDep(aOht, aCompound, 'FS', 0);

  const aDrain = addAct({ wbs: '6.20', name: 'Site drainage and paving', activity_type: 'EXTERNAL', duration: 8, quantity: 450, unit: 'm2', crew_size: 10, resource: 'HELPER', normal_cost: 55200, crash_duration: 6, crash_cost: 62400, floor: 'External' });
  addDep(aCompound, aDrain, 'SS', 3);
  addDep(aPaintExt, aDrain, 'FS', 0);

  const aLandscape = addAct({ wbs: '6.30', name: 'Landscaping and final cleaning', activity_type: 'EXTERNAL', duration: 6, quantity: 1, unit: 'LS', crew_size: 8, resource: 'HELPER', normal_cost: 33120, crash_duration: 4, crash_cost: 38880, floor: 'External' });
  addDep(aDrain, aLandscape, 'FS', 0);
  addDep(aFixtures, aLandscape, 'FS', 0);

  const aHandover = addAct({ wbs: '6.40', name: 'Snagging and handover inspection', activity_type: 'EXTERNAL', duration: 4, quantity: 1, unit: 'LS', crew_size: 4, resource: 'HELPER', normal_cost: 11040, floor: 'External' });
  addDep(aLandscape, aHandover, 'FS', 0);

  // Project Metadata
  const project: ProjectMetadata = {
    project_id: `CS-${cfg.config_label.replace(/[^a-zA-Z0-9]/g, '')}-001`,
    name: cfg.building_name || `${cfg.config_label} Construction Schedule`,
    start_date: startDate,
    data_date: dataDate,
    location,
    data_source: 'DYNAMIC_GENERATOR',
    description: `Dynamically generated construction schedule for ${cfg.config_label} (${cfg.total_levels} total levels: ${cfg.basement_floors} basements, ${cfg.has_ground_floor ? 'Ground floor' : 'no ground'}, ${cfg.floors_above_ground} upper floors). Method: ${cfg.construction_method}.`,
    work_week: workWeek,
    holidays,
    monsoon,
    resources,
    building_config: cfg
  };

  return {
    project,
    activities,
    dependencies,
    building_config: cfg
  };
}
