# AI-Based Self-Adaptive Construction Scheduling System

A runnable Python system that builds a CPM schedule for a construction project, predicts which activities are likely to be delayed,
**re-plans the schedule automatically** from those predictions, explains the predictions with SHAP, and recommends mitigation actions.
Built for a civil-engineering planner: everything is available from a CLI, a local web app, JSON APIs and a PDF report.

> **Read this first - honesty notes**
> * `Implementation_Report.pdf` was **not available** when this system was built. The architecture (M1-M8), formulas and constraints follow the
>   written brief. Every parameter that the brief did not fix is marked **PROVISIONAL** (see *Provisional assumptions*) and must be reconciled with the report.
> * The case study and **all training data are SYNTHETIC**. Scores measured on synthetic projects (ROC-AUC 0.81 on the synthetic test projects) are
>   **not real-world validation**. No as-built records were used.
> * RII values are **provisional** - the questionnaire survey has not been conducted.

## Problem and objective
Construction schedules slip because of weather, material supply, labour, approvals, finance and similar factors. A static CPM baseline cannot react.
This system closes the loop (MAPE-K): monitor delay-factor scores, predict P(delay) and delay days per activity, adapt activity durations, recompute CPM,
and give ranked, explainable recommendations - while the **baseline is never overwritten**.

## Architecture
```
M1 Project/WBS  ->  M2 CPM  ->  M3 Delay factors  ->  M4 AI prediction + SHAP  ->  M5 Self-adaptive rescheduling
   ->  M6 Decision support  ->  M7 Resources + Progress  ->  M8 Charts + Web + PDF  ->  SQLite version store
```
| Module | File(s) | Responsibility |
|---|---|---|
| M1 | `models.py` `wbs.py` `calendars.py` | Frozen models; strict validation (no silent repair); working calendar (6-day week, holidays, monsoon) |
| M2 | `cpm.py` | NetworkX activity-on-node CPM; FS/SS/FF/SF with +/- lags; ES/EF/LS/LF/TF/FF; `compute(duration_overrides)` never mutates the Project |
| M3 | `delay_factors.py` | 15 factors, 0-4 scores, RII (provisional), live register, composite risk index, dominant factors |
| M4 | `dataset.py` `features.py` `ml/train.py` `ml/predict.py` `ml/explain.py` | Synthetic dataset, ONE shared feature builder, training, inference, SHAP |
| M5 | `adaptation.py` | Expected-value / conservative adaptation, critical-path migration, float erosion |
| M6 | `recommend.py` | Positive-SHAP attribution, ranked mitigation + crash recommendations |
| M7 | `resources.py` | Resource demand/utilisation/over-allocation windows; planned vs actual progress; S-curve |
| M8 | `visuals.py` `reporting.py` `web/` | Charts, ReportLab PDF, Flask app |
| Store | `store.py` | SQLite `project`, `schedule_version`, `activity_schedule`, `prediction`; baseline protected by triggers |
| Pipeline | `pipeline.py` | **`run_cycle()`** - the single cycle used by both CLI and Flask |

Key formulas (documented in the module docstrings):
* Composite risk index = sum(RII_f x score_f/4) / sum(RII_f)
* Expected value: `Dur_adaptive = Dur_planned + D x P(delay)`; conservative: `Dur_planned + D`; only if `P >= 0.60`; rounded **up**; capped
* `share(f) = positive_SHAP(f) / sum positive factor SHAP`; `attributable_days = injected_days x share`; `recovery = attributable x effectiveness`
* `cost_slope = (crash_cost - normal_cost) / (normal_duration - crash_duration)`; crash limits respected

## Technology stack
Python 3.11+, pandas, NumPy, NetworkX, scikit-learn, XGBoost, imbalanced-learn, SHAP, SciPy, joblib, Matplotlib (headless), Seaborn, ReportLab, Flask, SQLite, pytest, HTML/CSS/JavaScript. CPU only.

## Installation (project-local virtual environment)
```bash
cd adaptive-scheduler
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
pip install -r requirements-dev.txt       # optional: install test dependencies
pip install -e .                     # installs the `adaptive-scheduler` command
```

## Quick start (exact commands)
```bash
adaptive-scheduler make-case-study            # write the synthetic G+3 input files (67 activities, 94 links)
adaptive-scheduler validate                   # strict validation of data/project/*
adaptive-scheduler schedule                   # baseline CPM
adaptive-scheduler make-dataset               # SYNTHETIC dataset (45 projects) -> data/dataset/
adaptive-scheduler train                      # full grid search, ~1-2 min on a laptop CPU
adaptive-scheduler explain --activity A240    # SHAP global + local
adaptive-scheduler predict --at-risk-only
adaptive-scheduler adapt --data-date 2026-09-07
adaptive-scheduler recommend --data-date 2026-09-07
adaptive-scheduler resources
adaptive-scheduler progress --data-date 2026-09-07
adaptive-scheduler report --data-date 2026-09-07      # charts + artifacts/reports/project_report.pdf
adaptive-scheduler history
adaptive-scheduler serve                      # http://127.0.0.1:5000
```
Common options: `--help --json --data-date YYYY-MM-DD --threshold 0.60 --mode expected|conservative --no-explain --no-store --project-dir --models-dir --db`.
Try `adaptive-scheduler adapt --threshold 0.45` to see more activities adapted, or `--mode conservative`.

### Dataset and model training
`make-dataset` simulates 45 synthetic projects by perturbing the case-study network (durations, quantities, crews, start month) with monsoon/weather,
material, financial, approval/permit, contractor, rework and subcontractor effects, predecessor-delay propagation, activity criticality and a hidden
project-competence effect. `train` uses a **project-wise split (31 train / 7 validation / 7 test)**, correlation screening at |r| > 0.85
(training rows only), SMOTE inside training folds only, grid search with **5-fold CV grouped by project** (ROC-AUC for classifiers, MAE for regressors),
threshold tuning on validation (max F2 s.t. precision >= 0.60), regression on delayed activities only, and Platt calibration on validation projects.
Outputs: `artifacts/models/{classifier.joblib, regressor.joblib, feature_spec.json}`, `artifacts/reports/{model_metrics.json, shap_global_ranking.json}`.
Training and inference both call `features.build_feature_frame()` and the persisted `feature_spec.json`.

Result of the shipped run (SYNTHETIC test projects): classifier LogisticRegression, ROC-AUC 0.81, precision 0.64, recall 0.74 at threshold 0.38;
regressor XGBoost, MAE 0.91 days. Features dropped by screening: `active_factor_count` (r=0.96 with composite index), `type_mep` (r=0.87).

### CPM, adaptation, recommendations
* CPM works on integer working-day offsets; dates come from the calendar (`date_of`, `offset_of`, `span`, `elapsed_days`, `monsoon_exposure`).
* Adaptation recomputes CPM from the **original** durations with overrides, so baseline and project objects are untouched. It reports schedule variance (working and
  calendar days), newly critical / left-critical activities, critical-path migration, near-critical activities and float erosion. Activities that already carry an
  *observed* delay (`actual_delay_days`) are adapted with the observed value (flagged `observed`); finished activities get no prediction-based delay.
* Recommendations cover critical and near-critical activities only. Mitigation estimates are **engineering-judgement**; crash estimates are **crash-limit based**
  and labelled as such in the `basis` column.

### Resources and progress
Demand is in resource-days against availability declared in `project.json`. Consecutive over-allocated days are merged into windows. Progress is duration-weighted by
default (`--weighting quantity` available; note quantities have mixed units). `percent_complete` in `activities.csv` is the actual progress at the data date.

## Web application and API
`adaptive-scheduler serve` -> **http://127.0.0.1:5000** (local, single user, no authentication).
Pages: Dashboard, Gantt (zoom, filter, search, hover, baseline toggle; drawn in the browser from working-day offsets), Predictions, Recommendations, Resources,
Progress, Delay Factors, Reports (generate/download PDF, CSV exports). Data date, mode and threshold are editable at the top; "Run & store cycle" saves a version.

| Endpoint | Description |
|---|---|
| `GET /api/cycle` | full cycle result |
| `GET /api/gantt` | activities with baseline/current working-day offsets |
| `GET /api/activities` | per-activity schedule, risk, drivers |
| `GET /api/recommendations` | ranked recommendations |
| `POST /reports/generate`, `GET /reports/download`, `GET /export/<name>.csv` | PDF and CSV |

All accept `?data_date=YYYY-MM-DD&mode=...&threshold=...`. Flask contains no scheduling, prediction or adaptation logic - it calls `pipeline.run_cycle()`.
If models are missing the app still shows the baseline schedule, resources, progress and charts with a warning.

## PDF report
`adaptive-scheduler report` writes `artifacts/reports/project_report.pdf` (project summary, progress, baseline vs current, critical path, at-risk register,
SHAP explanations, recommendations, resource utilisation, methodology and limitations). Text is ASCII-only.

## Testing
```bash
pytest            # 113 tests: M1-M8, integration, DB versioning, no-model degradation, CLI, Flask
```
Tests train a small "fast" model in a temp folder; they do not touch `artifacts/`.

## Provisional assumptions (not from the report - please reconcile)
RII values and ordering; risk-band cut-offs on P(delay) (0.30 / 0.50 / 0.70); near-critical float <= 5 working days; adaptation cap (50 % of planned duration, 30 days);
mitigation effectiveness and cost percentages; synthetic generator coefficients; criticality weight `1/(1+TF/5)`; "active factor" = score >= 2; probability calibration;
case-study holidays, rates, crash costs and scripted delays; use of observed delays in adaptation.

## Limitations
* Synthetic data only; no real-world validation. Probabilities are meaningful only inside the synthetic data-generating process.
* `predecessor_delay_ratio` uses observed predecessor delays; for activities whose predecessors have not finished it understates risk.
* The case-study register is outside the typical synthetic training range, so model output there is extrapolation.
* Each activity uses one resource type; CPM adaptation ignores resource levelling; no re-baselining workflow.
* Cost figures are order-of-magnitude INR estimates.

## Future improvements
Collect as-built records and run the RII questionnaire; retrain and validate on real projects; resource-constrained scheduling; per-activity-type factor scores;
multi-resource activities; re-baselining with approval; richer progress history for the S-curve.
