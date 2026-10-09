import { Activity } from './models';
import { AdaptationResult, NEAR_CRITICAL_FLOAT } from './adaptation';
import { ExplanationResult } from './prediction';
import { FACTOR_BY_ID } from './delayFactors';

export interface ActionDef {
  action: string;
  effectiveness: number;
  cost_pct: number;
}

export const ACTIONS: Record<string, ActionDef> = {
  F01: { action: 'Expedite procurement; secure buffer stock or an alternate supplier', effectiveness: 0.50, cost_pct: 0.03 },
  F02: { action: 'Add a second crew or an extra shift for the activity', effectiveness: 0.55, cost_pct: 0.08 },
  F03: { action: 'Escalate pending approvals and pre-clear drawings', effectiveness: 0.40, cost_pct: 0.01 },
  F04: { action: 'Provide temporary cover/dewatering; resequence weather-sensitive work to dry spells', effectiveness: 0.35, cost_pct: 0.04 },
  F05: { action: 'Freeze scope and set a change-order cut-off date', effectiveness: 0.40, cost_pct: 0.01 },
  F06: { action: 'Secure cash flow: advance or early release of milestone payment', effectiveness: 0.45, cost_pct: 0.01 },
  F07: { action: 'Hold a design-freeze review and issue drawings for construction', effectiveness: 0.40, cost_pct: 0.02 },
  F08: { action: 'Mobilise a backup subcontractor and add daily supervision', effectiveness: 0.45, cost_pct: 0.05 },
  F09: { action: 'Increase supervision and run a productivity review', effectiveness: 0.35, cost_pct: 0.03 },
  F10: { action: 'Expedite the permit and liaise with the authority', effectiveness: 0.40, cost_pct: 0.01 },
  F11: { action: 'Preventive maintenance and a standby machine', effectiveness: 0.60, cost_pct: 0.06 },
  F12: { action: 'Introduce pre-pour/pre-plaster QA checklists', effectiveness: 0.50, cost_pct: 0.02 },
  F13: { action: 'Re-plan site access and material unloading windows', effectiveness: 0.40, cost_pct: 0.02 },
  F14: { action: 'Arrange temporary utility connection or coordination', effectiveness: 0.40, cost_pct: 0.03 },
  F15: { action: 'Safety stand-down and toolbox talks', effectiveness: 0.30, cost_pct: 0.01 },
};

export interface RecommendationRow {
  rank?: number;
  activity_id: string;
  activity_name: string;
  status: 'critical' | 'near-critical';
  cause: string;
  cause_factor_id: string;
  shap_share: number | null;
  injected_days: number;
  attributable_days: number;
  action: string;
  action_type: 'mitigation' | 'crash';
  recovery_days: number;
  cost_impact_inr: number;
  cost_per_recovery_day: number;
  basis: string;
  priority: 'High' | 'Medium';
}

export function generateRecommendations(
  activities: Activity[],
  adaptation: AdaptationResult,
  explanations: Record<string, ExplanationResult>,
  minShare = 0.10,
  maxCauses = 3
): RecommendationRow[] {
  const actMap = new Map(activities.map(a => [a.activity_id, a]));
  const sched = adaptation.adapted.schedules;
  const rows: RecommendationRow[] = [];

  for (const [aid, inj] of Object.entries(adaptation.injected)) {
    const a = actMap.get(aid);
    const s = sched[aid];
    if (!a || !s || a.percent_complete >= 100) continue;

    let status: 'critical' | 'near-critical';
    if (s.critical) {
      status = 'critical';
    } else if (s.total_float > 0 && s.total_float <= NEAR_CRITICAL_FLOAT) {
      status = 'near-critical';
    } else {
      continue;
    }

    const days = inj.days;
    const cand: Array<{
      cause: string;
      cause_factor_id: string;
      shap_share: number | null;
      attributable_days: number;
      action: string;
      action_type: 'mitigation' | 'crash';
      recovery_days: number;
      cost_impact_inr: number;
      basis: string;
    }> = [];

    const exp = explanations[aid];
    if (exp && exp.factor_drivers.length > 0) {
      for (const fd of exp.factor_drivers.slice(0, maxCauses)) {
        if (fd.share < minShare) continue;
        const actDef = ACTIONS[fd.factor_id];
        if (!actDef) continue;
        const attrib = days * fd.share;
        cand.push({
          cause: fd.factor,
          cause_factor_id: fd.factor_id,
          shap_share: fd.share,
          attributable_days: attrib,
          action: actDef.action,
          action_type: 'mitigation',
          recovery_days: attrib * actDef.effectiveness,
          cost_impact_inr: actDef.cost_pct * a.normal_cost,
          basis: 'engineering-judgement estimate'
        });
      }
    }

    const totalRec = cand.reduce((sum, c) => sum + c.recovery_days, 0);
    if (totalRec > days && totalRec > 0) {
      for (const c of cand) {
        c.recovery_days *= days / totalRec;
      }
    }

    if (status === 'critical' && a.max_crash_days > 0) {
      const cd = Math.min(a.max_crash_days, days);
      cand.push({
        cause: cand.length > 0 ? 'All causes (schedule compression)' : 'Delay injected (cause not attributed)',
        cause_factor_id: '',
        shap_share: null,
        attributable_days: days,
        action: `Crash: compress by ${cd} working day(s) with extra shifts/overtime`,
        action_type: 'crash',
        recovery_days: cd,
        cost_impact_inr: a.cost_slope * cd,
        basis: `crash-limit (cost slope INR ${Math.round(a.cost_slope).toLocaleString()}/day, max ${a.max_crash_days} days)`
      });
    }

    for (const c of cand) {
      if (c.recovery_days <= 0) continue;
      rows.push({
        activity_id: aid,
        activity_name: a.name,
        status,
        injected_days: days,
        ...c,
        cost_per_recovery_day: c.recovery_days > 0 ? Math.round(c.cost_impact_inr / c.recovery_days) : 0,
        priority: status === 'critical' ? 'High' : 'Medium'
      });
    }
  }

  // Sort: critical first, then recovery_days desc, cost_per_recovery_day asc
  rows.sort((a, b) => {
    const aCrit = a.status === 'critical' ? 0 : 1;
    const bCrit = b.status === 'critical' ? 0 : 1;
    if (aCrit !== bCrit) return aCrit - bCrit;
    if (b.recovery_days !== a.recovery_days) return b.recovery_days - a.recovery_days;
    return a.cost_per_recovery_day - b.cost_per_recovery_day;
  });

  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    shap_share: r.shap_share !== null ? Math.round(r.shap_share * 1000) / 1000 : null,
    attributable_days: Math.round(r.attributable_days * 10) / 10,
    recovery_days: Math.round(r.recovery_days * 10) / 10,
    cost_impact_inr: Math.round(r.cost_impact_inr),
    cost_per_recovery_day: Math.round(r.cost_per_recovery_day)
  }));
}
