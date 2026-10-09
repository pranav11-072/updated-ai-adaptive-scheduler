export interface FactorDef {
  factor_id: string;
  key: string;
  name: string;
  rii: number;
}

export const FACTORS: FactorDef[] = [
  { factor_id: 'F01', key: 'material_delivery', name: 'Material delivery delay', rii: 0.82 },
  { factor_id: 'F02', key: 'labour_shortage', name: 'Labour shortage', rii: 0.80 },
  { factor_id: 'F03', key: 'approval_delays', name: 'Approval delays', rii: 0.78 },
  { factor_id: 'F04', key: 'weather', name: 'Weather delay', rii: 0.77 },
  { factor_id: 'F05', key: 'client_change_orders', name: 'Client change orders', rii: 0.76 },
  { factor_id: 'F06', key: 'financial_issues', name: 'Financial issues', rii: 0.75 },
  { factor_id: 'F07', key: 'design_changes', name: 'Design changes', rii: 0.73 },
  { factor_id: 'F08', key: 'subcontractor_delays', name: 'Subcontractor delays', rii: 0.72 },
  { factor_id: 'F09', key: 'contractor_performance', name: 'Contractor performance', rii: 0.70 },
  { factor_id: 'F10', key: 'permit_delays', name: 'Permit delays', rii: 0.68 },
  { factor_id: 'F11', key: 'equipment_breakdown', name: 'Equipment breakdown', rii: 0.65 },
  { factor_id: 'F12', key: 'quality_rework', name: 'Quality rework', rii: 0.64 },
  { factor_id: 'F13', key: 'site_access', name: 'Site access issues', rii: 0.60 },
  { factor_id: 'F14', key: 'utility_issues', name: 'Utility issues', rii: 0.58 },
  { factor_id: 'F15', key: 'safety_incidents', name: 'Safety incidents', rii: 0.55 },
];

export const FACTOR_BY_ID = new Map(FACTORS.map(f => [f.factor_id, f]));
export const RII_TOTAL = FACTORS.reduce((sum, f) => sum + f.rii, 0);
export const RII_STATUS = 'PROVISIONAL - questionnaire survey not yet conducted; not survey-validated';

export class RiskRegister {
  public scores: Record<string, number>;
  public notes: Record<string, string>;

  constructor(scores: Record<string, number>, notes: Record<string, string> = {}) {
    this.scores = { ...scores };
    this.notes = { ...notes };
    for (const f of FACTORS) {
      if (this.scores[f.factor_id] === undefined) {
        this.scores[f.factor_id] = 0;
      }
    }
  }

  public compositeRiskIndex(): number {
    let weighted = 0;
    for (const f of FACTORS) {
      const s = this.scores[f.factor_id] || 0;
      weighted += f.rii * (s / 4.0);
    }
    return weighted / RII_TOTAL;
  }

  public dominantFactors(limit = 3): Array<[string, string, number]> {
    return FACTORS.slice()
      .sort((a, b) => {
        const sa = this.scores[a.factor_id] || 0;
        const sb = this.scores[b.factor_id] || 0;
        return sb - sa || b.rii - a.rii;
      })
      .slice(0, limit)
      .map(f => [f.factor_id, f.name, this.scores[f.factor_id] || 0]);
  }

  public asFrame(): Array<{ factor_id: string; factor: string; rii: number; score: number; note: string }> {
    return FACTORS.map(f => ({
      factor_id: f.factor_id,
      factor: f.name,
      rii: f.rii,
      score: this.scores[f.factor_id] || 0,
      note: this.notes[f.factor_id] || ''
    }));
  }
}
