# AI-Based Self-Adaptive Construction Scheduling System

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.2+-lightgrey.svg)](https://expressjs.com/)
[![Tests](https://img.shields.io/badge/Tests-8%20Passing-brightgreen.svg)](./tests/verify.ts)

A production-grade, full-stack civil engineering construction scheduling and analytics platform. Built with **real mathematical calculations**, the system computes Critical Path Method (CPM) schedules, monitors delay factors, predicts delay probabilities $P(\text{delay})$, dynamically recalculates risk bands and adapted forecast schedules in real time, and renders **every chart, graph, and timeline directly from live calculated project data**.

* **Live Application:** [https://updated-ai-adaptive-scheduler.onrender.com/](https://updated-ai-adaptive-scheduler.onrender.com/)
* **GitHub Repository:** [https://github.com/pranav11-072/updated-ai-adaptive-scheduler](https://github.com/pranav11-072/updated-ai-adaptive-scheduler)

---

## Key Features & Capabilities

### 1. Real Critical Path Method (CPM) Engine
* **Rigorous Network Analysis:** Performs complete forward and backward passes across all activities and dependency links.
* **Complex Dependency Support:** Full support for `FS` (Finish-to-Start), `SS` (Start-to-Start), `FF` (Finish-to-Finish), and `SF` (Start-to-Finish) relationships with positive or negative lead/lag offsets.
* **Schedule Slack & Float:** Exact working-day calculation of Early Start (ES), Early Finish (EF), Late Start (LS), Late Finish (LF), Total Float (TF), and Free Float (FF).
* **Baseline Integrity:** The planned baseline is preserved and never overwritten. Adaptation recalculations generate separate forecast schedules, measuring schedule variance (working days and calendar days), critical path migration, and float erosion.

### 2. Live Calculated Graphs & Visualizations
Every visualization in the system is generated dynamically from live calculated project data with zero mock or hardcoded values:
* **Progress S-Curve:** Cumulative project progress percentage plotted across working days. Compares Planned Baseline vs. Adapted Forecast, with a dynamic vertical Data Date line and Actual Progress marker.
* **Interactive Gantt Chart:** High-performance, client-and-server synchronized vector Gantt chart with interactive zoom slider, critical-path highlights, floor filters, task search, baseline comparison bars, and detailed tooltips.
* **Activity Status Distribution:** Real-time breakdown of tasks into Completed, In Progress, Not Started, Critical Path, Near-Critical, and Delayed.
* **Risk Distribution Graph:** Real-time activity counts categorized across Low, Medium, High, and Critical risk bands based on delay probability $P(\text{delay})$ and the user-selected threshold.
* **Floor-wise Progress Breakdown:** Dual horizontal progress bars (Planned % vs. Actual %) per building floor level.
* **Forecast Completion Trend:** Visual progression tracking how completion dates adapt across scheduling revision cycles.
* **Daily Resource Demand Histograms:** Daily demand curves for manpower and equipment (Masons, Carpenters, Steel Benders, Concrete Mixers, Labor) against declared capacity limits, highlighting over-allocation windows in red.
* **Delay Drivers / Feature Importance:** Visual ranking of site risk factors by provisional Relative Importance Index (RII) and severity score.
* **Dynamic Vector SVG Figure Endpoints:** Direct vector endpoints (`/figures/:name.svg`) for all charts with live query parameter updates.

### 3. Dynamic Real-Time Risk Threshold Recalculation
* **Configurable Decision Threshold:** Users can adjust the risk threshold slider or input (e.g., `0.30`, `0.50`, `0.70`, `0.90`) and click **Apply**.
* **Zero-Reload Dynamic Updates:** Immediately triggers `POST /api/recalculate`, re-evaluating each activity's risk classification, updating at-risk activity counts, adapting durations, and refreshing all dashboard KPIs and graphs on the fly.
* **Consistent Risk Bands:**
  $$\text{Critical: } P(\text{delay}) \ge \text{threshold}$$
  $$\text{High: } 0.75 \times \text{threshold} \le P(\text{delay}) < \text{threshold}$$
  $$\text{Medium: } 0.45 \times \text{threshold} \le P(\text{delay}) < 0.75 \times \text{threshold}$$
  $$\text{Low: } P(\text{delay}) < 0.45 \times \text{threshold}$$

### 4. Real Earned Value Management (EVM) Calculation Suite
Calculated at each project Data Date using individual task costs and progress percentages:
* **Planned Value (PV):** $\sum (\text{Task Budget} \times \text{Planned Fraction})$
* **Earned Value (EV):** $\sum (\text{Task Budget} \times \text{Percent Complete})$
* **Actual Cost (AC):** Cumulative expenditure to date
* **Schedule Variance (SV):** $EV - PV$
* **Cost Variance (CV):** $EV - AC$
* **Schedule Performance Index (SPI):** $EV / PV$
* **Cost Performance Index (CPI):** $EV / AC$
* **Budget at Completion (BAC)** and **Estimate at Completion (EAC):** $BAC / CPI$

### 5. Dynamic G+N Building Height & Floor Generator
Generates realistic multi-story construction schedules on demand:
* **Any Height:** Configure Ground Floor toggle, above-ground floors ($N = 0$ to $60$), and basement levels ($B = 0$ to $5$).
* **Construction Methods:** RCC Cast-In-Situ Framed, Precast Modular Concrete, and Structural Steel Composite.
* **Vertical Flow & Pipelining:** Enforces structural cycle dependencies (Columns $\to$ Slab & Beam $\to$ Concrete Pour $\to$ Curing) while allowing architectural, MEP, and finishes to pipeline upward concurrently with realistic Start-to-Start lags (`SS 3`).

### 6. Interactive Construction Schedule Builder
* **Custom Value Slot:** Fast batch text slot to paste task definitions in the format:  
  `Task Name, Start Date, End Date, [Type], [Resource], [Crew], [Cost], [Predecessors]`
* **Task Input & Editing Form:** Add or edit tasks with working calendar duration previews and dependency linkers.
* **Civil Construction Example Cases:** Built-in one-click presets for deep shoring, monolithic slab pours, monsoon basement waterproofing, vertical plumbing risers, HV substations, and vitrified tiling.

---

## System Architecture

```
src/
├── server.ts                  # Express 5 server, REST endpoints, SVG chart delivery, and EJS rendering
├── engine/
│   ├── cpm.ts                 # CPM engine (forward/backward pass, float calculation, critical path)
│   ├── calendar.ts            # Working calendar (6-day work week, holidays, monsoon exposure)
│   ├── analyticsEngine.ts     # EVM metrics, status distribution, floor-wise analytics
│   ├── chartGenerator.ts      # Live SVG generation for S-Curves, Gantt, Risk, and Resource Histograms
│   ├── floorGenerator.ts      # Multi-story building schedule generator (G+N levels)
│   ├── pipeline.ts            # Centralized cycle orchestration (runCycle, schedule mutations)
│   ├── prediction.ts          # Delay probability calibration, risk banding, and drivers
│   ├── adaptation.ts          # Self-adaptive rescheduling from predictions
│   ├── resources.ts           # Resource demand curves, over-allocation windows, S-curve points
│   ├── recommend.ts           # Mitigation & crash recommendations
│   ├── delayFactors.ts        # Risk register and Relative Importance Index (RII)
│   └── models.ts              # Data contracts and TypeScript interfaces
└── views/                     # EJS templates with embedded SVG graph components
```

---

## Quick Start & Installation

### Prerequisites
* **Node.js** (v18.0.0 or higher)
* **npm** (v9.0.0 or higher)

### Installation
```bash
# 1. Clone the repository
git clone https://github.com/pranav11-072/updated-ai-adaptive-scheduler.git
cd updated-ai-adaptive-scheduler

# 2. Install dependencies
npm install

# 3. Start the development server
npm run dev
```

The application will be available at: **http://localhost:3000**

### Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs the development server with live TypeScript compilation (`tsx`) on port 3000 |
| `npm test` | Executes the automated 8-part test suite validating CPM, EVM, G+N, and thresholds |
| `npm run build` | Compiles TypeScript code using `tsc` |
| `npm start` | Starts the production server using `tsx src/server.ts` |

---

## REST API Reference

All endpoints accept query parameters: `?data_date=YYYY-MM-DD&threshold=0.60&mode=expected|conservative`.

### Calculation & Data Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/recalculate` | Recomputes CPM, risk classifications, EVM, and adaptation for a given `{ threshold, data_date, mode }` without page reload |
| `GET` | `/api/cycle` | Returns the complete scheduling cycle object including KPIs, activities, EVM, and analytics |
| `GET` | `/api/gantt` | Returns working-day offsets, critical path flags, and horizon dates for the Gantt chart |
| `GET` | `/api/activities` | Returns all activities with calculated $P(\text{delay})$, risk bands, and float |
| `GET` | `/api/analytics` | Returns calculated EVM metrics, status distributions, and floor analytics |
| `GET` | `/api/recommendations` | Returns prioritized schedule recovery and crashing actions |
| `GET` | `/api/tasks` | Returns raw activity and dependency structures |
| `POST` | `/api/tasks` | Adds a new activity to the schedule structure |
| `PUT` | `/api/tasks/:id` | Updates an existing activity |
| `DELETE` | `/api/tasks/:id` | Deletes an activity from the schedule |
| `POST` | `/api/project/generate-floors` | Generates a new G+N multi-story building schedule |

### Dynamic Vector Chart Endpoints

| Endpoint | Visual Output |
|---|---|
| `GET /figures/s_curve.svg` | Cumulative Planned Baseline vs. Adapted Forecast S-Curve |
| `GET /figures/gantt_chart.svg` | Master Schedule and Critical Path Gantt Timeline |
| `GET /figures/risk_distribution.svg` | Activity Risk Distribution across calibrated risk bands |
| `GET /figures/forecast_trend.svg` | Project completion forecast progression by cycle |
| `GET /figures/resource_histogram.svg` | Daily manpower/equipment demand histograms vs. capacity |
| `GET /figures/shap_global_importance.svg` | Construction delay risk driver ranking by impact score |

### Export Endpoints

* `GET /export/activities.csv` — Full activity schedule CSV
* `GET /export/recommendations.csv` — Schedule mitigation recommendations CSV
* `GET /export/predictions.csv` — Risk predictions and delay probability CSV
* `GET /export/resources.csv` — Resource utilization summary CSV

---

## Automated Verification Suite

Run the full automated test suite anytime using:
```bash
npm test
```

The test runner (`tests/verify.ts`) validates:
1. **Working Calendar:** Date offsets, 6-day work weeks, and monsoon exposure calculations.
2. **CPM Engine:** Forward/backward pass, total float, and critical path accuracy.
3. **Pipeline Cycle:** Full execution of synthetic case study data without regression.
4. **Schedule Builder:** Dynamic addition, deletion, and reset of tasks.
5. **Dynamic G+N Building Generator:** Schedule generation across `G+0`, `G+2`, `G+3`, `G+10`, `G+20`, and `B1+G+5` configurations.
6. **EVM Metrics:** Verified PV, EV, AC, SPI, and CPI calculations.
7. **HTTP Endpoints:** Health checks across all 21 REST and view routes.
8. **Threshold Mathematical Reclassification:** Verifies activity migration across risk bands for thresholds `0.30`, `0.50`, `0.70`, and `0.90`.

---

## License

This project is licensed under the MIT License.
