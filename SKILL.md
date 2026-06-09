I now have comprehensive data from both repos. Here is the full structured knowledge extraction:

---

# SKILL.md â€” Simple Liquidity Sweep Research System

*Extracted 2026-06-08 from `simple_liquidity_sweep_project` (branch `codex/simple-liquidity-sweep-recovery`) and `trade-log` (branch `main`). Be exact â€” no summaries where specifics exist.*

---

## 1. CORE STRATEGY MECHANIC

### Universal Setup Logic

The entire project is built on one mechanic: **sweep + close-back rejection on a 1-minute candle**.

**Short setup** â€” applies to all high-side levels (PDH, ASH, LSH, ONH, PMH, NYORH, NY1H, weekly_high):
```
condition:  candle.high > liquidity_level AND candle.close < liquidity_level
entry:      candle.close  (at candle confirmation)
stop:       candle.high   (sl_buffer_ticks: 0)
direction:  short
risk:       stop - entry
```

**Long setup** â€” applies to all low-side levels (PDL, ASL, LSL, ONL, PML, NYORL, NY1L, weekly_low):
```
condition:  candle.low < liquidity_level AND candle.close > liquidity_level
entry:      candle.close
stop:       candle.low    (sl_buffer_ticks: 0)
direction:  long
risk:       entry - stop
```

**Trade validity guard** (applied before any exit simulation):
```
risk <= 0  â†’ discard trade
```

### Exit Priority (Conservative â€” Default and Frozen)

Within each post-entry 1-minute candle, evaluated in this exact order:
1. If `candle.high >= stop` â†’ exit at `stop` (loss)
2. Else if `candle.low <= target` â†’ exit at `target` (win)  
3. Else if bars elapsed from entry >= `max_hold_minutes (240)` â†’ exit at `candle.close` (timeout)

SL always wins if both SL and TP are touched in the same candle. This is `conservative_intrabar: true` in `config/settings.yaml`.

### Target Selection

Four target models, run independently:
- `fixed_1r`: `entry Â± 1.0 Ã— risk`
- `fixed_2r`: `entry Â± 2.0 Ã— risk`
- `fixed_3r`: `entry Â± 3.0 Ã— risk`
- `opposing_liquidity`: nearest available level on the opposite side, in the same day's level map

For `opposing_liquidity` (short trade example):
```python
candidates = [(name, lvl["price"]) for name, lvl in levels.items()
              if lvl["side"] == "low" and lvl["price"] < entry]
# pick the one closest to entry (smallest gap)
name, price = min(candidates, key=lambda item: entry - item[1])
```
If no opposing target exists â†’ trade discarded.

### R Calculation
```
pnl (short) = entry - exit_price
pnl (long)  = exit_price - entry
result_r    = pnl / risk
```

### ASH Short Quality Filter V1 â€” Entry Variant

The production model does NOT enter at the sweep candle close. Instead:
1. Detect ASH Short sweep candle.
2. On each of the next 1â€“3 **closed** 1-minute candles, evaluate both quality filters.
3. Enter short at the **close of the first candle where both filters simultaneously pass**.
4. If neither filter passes by candle 3 â†’ no trade.
5. Stop remains at the **original sweep candle high** (not updated to later candles).

---

## 2. LIQUIDITY LEVELS CATALOGUE

### Session Windows (all ET / America/New_York)

| Level Name | Window | Available At | Side | Builder Source |
|---|---|---|---|---|
| PDH | Prior RTH: 09:30â€“16:00 prev day | Start of day | high | `rth_by_date` |
| PDL | Prior RTH: 09:30â€“16:00 prev day | Start of day | low | `rth_by_date` |
| ASH | 18:00 prev day â†’ 03:00 current day | 03:00 ET | high | `asianHigh` |
| ASL | 18:00 prev day â†’ 03:00 current day | 03:00 ET | low | `asianLow` |
| LSH / LSL | 03:00 â†’ 08:00 current day | 08:00 ET | high/low | `londonHighWork` |
| ONH / ONL | 18:00 prev day â†’ 09:30 current day | 09:30 ET | high/low | `overnightLowWork` |
| PMH / PML | 04:00 â†’ 09:30 current day | 09:30 ET | high/low | `premarketLowWork` |
| NYORH / NYORL | 09:30 â†’ 09:45 current day | 09:45 ET | high/low | `nyorLowWork` |
| NY1H / NY1L | 09:30 â†’ 10:30 current day | 10:30 ET | high/low | `ny1hLowWork` |
| weekly_high | Current ISO week | Start of week | high | XAU only |
| weekly_low | Current ISO week | Start of week | low | XAU only |

**ASH exact Python calculation** (`build_levels_by_day` in `mnq_liquidity_pool_expansion.py`):
```python
day = pd.Timestamp(date).tz_localize("America/New_York")
asia_start = day - pd.Timedelta(hours=6)   # = 18:00 prior day
asia_end   = day + pd.Timedelta(hours=3)   # = 03:00 current day
asia = df[(df["timestamp"] >= asia_start) & (df["timestamp"] < asia_end)]
ASH = float(asia["high"].max())
ASL = float(asia["low"].min())
```

**Level availability check** (`level_available()` in `mnq_liquidity_pool_expansion.py`):
```python
def level_available(source: str, ts: pd.Timestamp) -> bool:
    m = minute_of_day(ts)
    if source in {"ASH", "ASL"}:            return m >= 3 * 60       # 03:00
    if source in {"LSH", "LSL"}:            return m >= 8 * 60       # 08:00
    if source in {"ONH", "ONL", "PMH", "PML"}: return m >= 9*60+30   # 09:30
    if source in {"NYORH", "NYORL"}:        return m >= 9*60+45      # 09:45
    if source in {"NY1H", "NY1L"}:          return m >= 10*60+30     # 10:30
    return True  # PDH/PDL always available
```

**Pine availability** (`availableAfter(minuteMark)`):
```pine
ashAvailable  = not na(ash) and availableAfter(3 * 60)
lslAvailable  = not na(lsl) and availableAfter(8 * 60)
onlAvailable  = not na(onl) and availableAfter(9 * 60 + 30)
pmlAvailable  = not na(pml) and availableAfter(9 * 60 + 30)
nyorlAvailable = not na(nyorl) and availableAfter(9 * 60 + 45)
ny1lAvailable = not na(ny1l) and availableAfter(10 * 60 + 30)
pdlAvailable  = not na(pdl)     # always once set
```

### Performance by Level (MNQ baseline, opposing_liquidity target)

From the liquidity pool expansion and clean-follow studies:
- **ASH Short** (London + NY): produced the only promoted production candidate.
- **ASL Long**: tested, not promoted â€” insufficient edge in the quality-filter universe.
- **PDL Long**: tested in `clean_follow_delayed_entry_study.py` (family `PDL_Long`), not promoted to production.
- **PDH Short**: tested, not promoted.
- **LSH/LSL, ONL, PML, NYORL, NY1L**: used as opposing **targets** for the ASH Short model, not entry sources.
- **NYORL**: appears as target in 3 of the 20 pine validation reference trades.

### XAU Level Performance

From `reversal_family_discovery_report.md` â€” all reversal families tested, only one had trades:
- **PDL Long (London)**: 50 trades â€” the only active reversal family on XAUUSD.
- PDH Short, ASL Long, ASH Short, NY PDL Long, NY PDH Short: **all 0 trades** (no sweep events qualifying in the London session for those directions/levels).
- Weekly levels: added in `weekly_sweep_reversal_deep_dive.py` â€” produced 26 trades at fixed_2R.

---

## 3. QUALITY FILTERS LIBRARY

### Baseline Filters Tested (from `filter_configs()` in `simple_liquidity_sweep_backtest.py`)

```python
FilterConfig("no_filter")
FilterConfig("london_only",          session="london")
FilterConfig("ny_only",              session="ny")
FilterConfig("first_sweep_of_session_only", first_sweep=True)
FilterConfig("ASH_ASL_only",         sources=("ASH", "ASL"))
FilterConfig("PDH_PDL_only",         sources=("PDH", "PDL"))
FilterConfig("LSH_LSL_only",         sources=("LSH", "LSL"))
FilterConfig("short_only",           direction="short_only")
FilterConfig("long_only",            direction="long_only")
FilterConfig("one_trade_per_liquidity_level_per_session", one_trade_per_level_session=True)
# ATR wick filters:
FilterConfig("min_wick_size_ATR_0.1", min_wick_atr=0.1)
FilterConfig("min_wick_size_ATR_0.2", min_wick_atr=0.2)
FilterConfig("min_wick_size_ATR_0.3", min_wick_atr=0.3)
FilterConfig("min_wick_size_ATR_0.5", min_wick_atr=0.5)
# Max trades per day:
FilterConfig("max_trades_per_day_1",  max_trades_per_day=1)
FilterConfig("max_trades_per_day_2",  max_trades_per_day=2)
FilterConfig("max_trades_per_day_3",  max_trades_per_day=3)
FilterConfig("max_trades_per_day_5",  max_trades_per_day=5)
# Compound:
FilterConfig("ny_first_sweep_wick_0.2_max2",     session="ny",     first_sweep=True, min_wick_atr=0.2, max_trades_per_day=2)
FilterConfig("london_first_sweep_wick_0.2_max2", session="london", first_sweep=True, min_wick_atr=0.2, max_trades_per_day=2)
FilterConfig("ny_PDH_PDL_first_max1",            session="ny",     sources=("PDH","PDL"), first_sweep=True, max_trades_per_day=1)
FilterConfig("ny_ASH_ASL_first_max1",            session="ny",     sources=("ASH","ASL"), first_sweep=True, max_trades_per_day=1)
```

Wick ATR is computed as:
```python
wick = (candle.high - max(candle.open, candle.close))   # short entry
     = (min(candle.open, candle.close) - candle.low)    # long entry
wick_atr = wick / candle.atr14
```
Where `atr14 = rolling(14, min_periods=1).mean()` of true range.

### Production Quality Filters (Frozen, ASH_SHORT_QUALITY_FILTER_V1)

These two filters are evaluated on closed candles only, for post-sweep candles 1â€“3:

**Filter 1: `consecutive_displacement_ge_1`**

```python
# Setup (computed once before the sweep loop):
prior_bodies = [abs(closes[idx] - opens[idx]) for idx in range(max(0, sweep_idx-20), sweep_idx)]
median_body = float(pd.Series(prior_bodies).median())

# Per post-sweep candle:
body       = abs(close - open)
candle_range = high - low
body_ratio = body / candle_range  if candle_range > 0  else 0.0

bearish_displacement = (
    close < open                        and  # bearish candle
    median_body > 0                     and  # valid denominator
    body / median_body >= 1.5           and  # body >= 1.5x median
    body_ratio >= 0.6                        # body >= 60% of range
)

# State tracking:
if close > open:               # bullish = pullback
    pullback_seen = True
    consecutive_displacement = 0
elif bearish_displacement:
    consecutive_displacement += 1
    max_consecutive = max(max_consecutive, consecutive_displacement)
    if max_consecutive >= 1 and displacement_confirmed_at == 0:
        displacement_confirmed_at = delay  # delay = 1, 2, or 3

# Filter passes when: displacement_confirmed_at > 0
```

Pine equivalent:
```pine
medianBody = ta.median(math.abs(close - open), 20)[1]  # [1] = shifted to prev bars
bearishDisplacement = close < open and medianBody > 0
    and candleBody / medianBody >= 1.5 and bodyRatio >= 0.6
```
**Critical**: `[1]` shift is essential â€” uses 20 bars ending at the bar BEFORE current. In Python: `range(max(0, sweep_idx-20), sweep_idx)` excludes the sweep candle.

**Filter 2: `distance_before_pullback_ge_9`**

```python
# Per post-sweep candle, only while no pullback seen:
if not pullback_seen:
    distance_before_pullback = max(distance_before_pullback, sweep_close - low)
    if distance_before_pullback >= 9.0 and distance_confirmed_at == 0:
        distance_confirmed_at = delay

if close > open:  # first bullish candle = pullback, stops measuring
    pullback_seen = True

# Filter passes when: distance_confirmed_at > 0
```

Both filters must be simultaneously true at the same candle close (not independently at different candles). The entry occurs at the close of `max(displacement_confirmed_at, distance_confirmed_at)`.

### Throttles (deployment overlays, not filter changes)

From `ash_quality_filter_paper_trading_readiness_audit.py`:
- `original`: all 301 trades
- `one_trade_per_day`: `first_n_per_day(frame, 1)` â€” sorted by entry_time, head(1) per date
- `two_trades_per_day`: `first_n_per_day(frame, 2)` â€” head(2) per date

These are deployment overlays only. Changing them does NOT change the frozen signal definition.

### Slippage Tested

```python
SLIPPAGE_PER_SIDE = [0.25, 0.5, 1.0, 2.0]  # in points
round_turn_points = per_side * 2
adjusted_result_r = result_r - (round_turn_points / risk)
```

At 0.5 points/side (1 point round-turn): model remains positive (PF still >1.5). Threshold confirmed in `psychology_answer()`.

---

## 4. SESSION KNOWLEDGE

### Session Windows from `config/settings.yaml`

```yaml
sessions:
  asia:
    start: "18:00"
    end: "03:00"      # crosses midnight
  london:
    start: "03:00"
    end: "08:00"
  ny:
    start: "09:30"
    end: "11:30"
  ny_pm:
    start: "13:30"
    end: "16:00"
```

### Session Labels in `session_family()` (`mnq_liquidity_pool_expansion.py`)

```python
def session_family(ts: pd.Timestamp) -> str:
    m = minute_of_day(ts)
    if 3*60 <= m < 8*60:       return "london"
    if 9*60+30 <= m < 10*60+30: return "ny_open"
    if 10*60+30 <= m < 12*60:   return "ny_am"
    if 13*60+30 <= m < 16*60:   return "ny_pm"
    return "other"
```
Trades labeled `"other"` are **skipped** in the clean-follow study.

### ASH Production Model Eligible Sessions (Pine)

```pine
eligibleSession = inLondon
    or (mod >= 9 * 60 + 30 and mod < 12 * 60)      // NY (09:30â€“12:00)
    or (mod >= 13 * 60 + 30 and mod < 16 * 60)     // NY PM (13:30â€“16:00)
```
Note: session window in Pine is wider than config (NY to 12:00 vs 11:30; NY PM from 13:30 to 16:00).

### Candidate V2 Session Windows (Pine, AJ research)

```pine
in_asia    = minute_of_day >= 19*60 and minute_of_day <= 23*60+59   // 19:00â€“23:59
in_london  = minute_of_day >= 2*60  and minute_of_day <= 5*60        // 02:00â€“05:00
in_ny_am   = minute_of_day >= 9*60+30 and minute_of_day <= 11*60+59 // 09:30â€“11:59
in_ny_pm   = minute_of_day >= 13*60   and minute_of_day <= 15*60+59 // 13:00â€“15:59
```
These differ from the production model's session windows. F-block minutes: `29, 35`. S-block minutes: `47, 50, 53, 56`.

### Session Performance by Model

**MNQ ASH Quality Filter V1** â€” all sessions (London, NY, NY PM) included and equal in the frozen spec. No session filter is part of the frozen rule stack.

**XAUUSD London PDL Long** â€” London session only (03:00â€“08:00).

**XAUUSD Weekly Sweep Reversal** (from `weekly_sweep_reversal_deep_dive_report.md`):

| Session bucket | Trades | WR | AvgR | PF |
|---|---|---|---|---|
| ny | 6 | 83% | 1.50R | 10.0 |
| asia | 5 | 60% | 0.80R | 3.0 |
| other | 21 | 57% | 0.71R | 2.67 |
| london | 5 | 20% | -0.40R | 0.5 |
| pre_ny | 2 | 50% | 0.50R | 2.0 |
| ny_pm | 1 | 0% | -1.0R | 0.0 |

London session is **negative** for XAU weekly sweep reversal. NY and Asia are positive.

**XAU Companion London-session models** (from `companion_model_discovery_report.md`): London session continuation variants are largely negative or neutral, despite the confirmed London PDL Long model being London-only. The key difference is the reversal vs continuation direction.

---

## 5. BACKTEST METHODOLOGY

### Anti-Lookahead Rules

**Level builder**: Each level is only made available after its session ends. Code enforces this via `level_available(source, ts)` â€” see Section 2. In Pine: `availableAfter(minuteMark)`.

**ASH specifically**: `ash` is assigned only when `ended(inAsian)` fires (transition out of Asian session at exactly 03:00 ET). Available flag is set via `availableAfter(3 * 60)`.

**Displacement filter**: `medianBody` in Python uses `range(max(0, sweep_idx-20), sweep_idx)` â€” excludes the sweep candle itself. In Pine: `ta.median(..., 20)[1]` â€” the `[1]` shift is critical.

**Distance before pullback**: Only measures candles after the sweep candle closes. Stops accumulating as soon as a bullish candle (close > open) appears.

**Exit simulation**: candles are walked forward from `start_idx + 1`. No simultaneous SL/TP optimization.

**No vectorized shortcuts**: `_first_quality_signal()` in `ash_quality_filter_signal_engine.py` processes each post-sweep candle sequentially (loop over `delay in [1, 2, 3]`). Confirmed state machine architecture, not vectorized pandas operations.

### OOS Split

```python
def train_test(trades: pd.DataFrame) -> dict[str, Any]:
    ordered = trades.sort_values("entry_time")
    split = int(len(ordered) * 0.7)
    return {
        "train": metrics(ordered.iloc[:split]),
        "test":  metrics(ordered.iloc[split:])
    }
```
Split is 70/30, chronological order. No shuffling.

### Robustness Test

```python
def robustness(trades: pd.DataFrame) -> dict[str, Any]:
    for n in [1, 3, 5, 10]:
        trimmed = trades.sort_values("result_r", ascending=False).iloc[n:]
        out[f"remove_top_{n}"] = metrics(trimmed)
    out["tail_fragile_after_top_3"] = bool(
        out["remove_top_3"]["avg_r"] <= 0
        or (out["remove_top_3"]["profit_factor"] in [0, "inf"] and out["remove_top_3"]["avg_r"] <= 0)
    )
```

### Verdict Thresholds (from `verdict()` in `simple_liquidity_sweep_backtest.py`)

```python
"TRADEABLE"    if trades >= 100 and avg_r > 0 and pf > 1.2
               and train.avg_r > 0 and test.avg_r > 0
               and not tail_fragile_after_top_3

"MONITOR_ONLY" if trades >= 50 and avg_r > 0 and pf > 1.05

"RESEARCH_ONLY" if trades >= 20

"DISCARD"       otherwise
```

### Gate System (5 gates for promotion to paper-trade)

1. **Anti-lookahead audit** â€” verify no future data used in level building or filter evaluation. All 13 XAU scripts passed (status: `PASS` in reports). MNQ passed via `mnq_anti_lookahead_audit.py`.

2. **Live-validity audit** â€” verify filters are observable from closed 1-minute OHLC without repainting. ASH model: both filters use only `close < open` and `abs(close-open)` from current and prior closed candles â€” confirmed live-valid in `ash_quality_filter_deployment_reality_study.py`.

3. **Paper-readiness audit** â€” slippage at 0.25/0.5/1.0/2.0 per side, throttle scenarios (1/2/unlimited trades per day), duration distribution, time-of-day distribution, session distribution, PnL simulation, psychology assessment. Located in `ash_quality_filter_paper_trading_readiness_audit.py`.

4. **Production candidate document** â€” frozen spec in markdown listing exact rule stack, exact thresholds, exact filter logic, exact entry/exit logic, state machine diagram, change-control prohibitions. File: `docs/ASH_SHORT_QUALITY_FILTER_PRODUCTION_CANDIDATE.md`.

5. **Parity test** â€” 100% exact match between reusable signal engine and paper-trading artifact. `ash_quality_filter_parity_test.py` compares on 12 numeric fields, 3 integer fields, 3 string fields, 2 boolean fields to `0.0001` tolerance. ASH result: `301/301 exact matches, 0 missing, 0 extra, 0 mismatched`.

**XAU gate status** (as of 2026-06-08): Anti-lookahead gate PASS. Live-validity audit: not done. Paper-readiness audit: not done. Production candidate document: not written. Parity test: not run.

### MNQ Point Value
```python
MNQ_POINT_VALUE = 2.0  # USD per point per contract
# (in webhook.js: POINT_VALUES = {'MNQ1!': 2, 'MGC1!': 10, 'MES1!': 5, 'NQ1!': 20, 'ES1!': 50})
```

---

## 6. CONFIRMED MODELS

### Model 1: ASH_SHORT_QUALITY_FILTER_V1

**Status**: Frozen for paper testing. Parity: 301/301. No changes permitted.

| Parameter | Value |
|---|---|
| Model version | `ASH_SHORT_QUALITY_FILTER_V1` |
| Instrument | MNQ (1-minute candles) |
| Timezone | America/New_York |
| Direction | Short only |
| Liquidity source | ASH only |
| ASH window | 18:00 prev day ET â†’ 03:00 current day ET |
| ASH available | At or after 03:00 ET |
| Sweep condition | `high > ASH and close < ASH` on confirmed candle |
| Stop | `high` of sweep candle (no buffer) |
| Eligible sessions | London (03:00â€“08:00) + NY (09:30â€“12:00) + NY PM (13:30â€“16:00) |
| Post-sweep window | Candles 1â€“3 only |
| Filter 1 threshold | `body/median_body >= 1.5` AND `body/range >= 0.6` AND `close < open`, consecutive >= 1 |
| Median body lookback | 20 candles before sweep candle (not including sweep) |
| Filter 2 threshold | `max(sweep_close - low) >= 9.0 points` before first bullish candle |
| Entry | Close of first candle (1â€“3) where both filters simultaneously pass |
| Target type | Opposing liquidity (nearest low-side level below entry) |
| Target sources | PDL, ASL, LSL, ONL, PML, NYORL, NY1L |
| Max hold | 240 minutes |
| Risk check | `risk = stop - entry > 0` required |
| Target check | `target < entry` required |

**Frozen validation snapshot**:
```
Trades:          301
Win rate:        54.49%
AvgR:            0.5785
Profit factor:   2.2733
Max drawdown:    -10.0R
Losing streak:   10
```

**Signal delay distribution** (from `ash_quality_filter_deployment_reality_study.py`): some signals fire at candle 1, 2, or 3 after the sweep. Median entry delay and missed move are tracked but not frozen constraints.

**Example trades** (from production candidate doc):

| Sweep time | Entry | Stop | Target | Result | R |
|---|---|---|---|---|---|
| 2025-11-17 04:11 ET | 25314.75 | 25333.50 | 25111.75 | target (LSL) | +10.83R |
| 2025-07-03 04:14 ET | 22884.75 | 22890.00 | 22830.00 | target (LSL) | +10.43R |
| 2026-02-19 03:31 ET | 25036.00 | 25048.75 | 24916.25 | target (ASL) | +9.39R |
| 2025-05-19 10:26 ET | 21393.50 | 21420.75 | 21201.50 | stop (NYORL) | -1.0R |

**What is NOT part of this model**: No pivots, no confirmed swings, no MSS, no FVG, no volume filter, no AJ timing, no session filter, no direction filter beyond short-only, no liquidity source filter beyond ASH-only.

---

### Model 2: XAUUSD London PDL Long

**Status**: Reversal family "promote" verdict. **Not yet paper-trade ready** â€” 4 of 5 gates not yet passed.

| Parameter | Value |
|---|---|
| Instrument | XAUUSD (1-minute candles) |
| Direction | Long only |
| Liquidity source | PDL (prior day low) |
| Session | London (03:00â€“08:00 ET) |
| Sweep condition | `low < PDL and close > PDL` |
| Stop | Sweep candle low |
| Target type | Opposing liquidity (nearest high-side level above entry) |
| Min distance to target | â‰¥ 1500 ticks |
| Volatility filter | Exclude "Extreme" volatility (`vol_expansion >= 1.5`) |
| Max hold | 240 minutes |
| Target model tested | `opposing_liquidity` |

**Validation snapshot** (from `reversal_family_discovery_report.md`):
```
Trades:               50
Win rate:             24%
AvgR:                 +3.3546R
Profit factor:        5.414
Max drawdown:         -16R
OOS avg_r:            +1.8005R
In-sample avg_r:      +4.0207R
Anti-lookahead:       PASS
Active months:        7
Positive month rate:  71.43% (5/7)
```

**Monthly results**:
```
2025-03: 1 trade, 100% WR, +11.94R
2025-05: 3 trades, 0% WR, -1.0R
2025-06: 17 trades, 23.5% WR, +1.32R
2025-08: 5 trades, 0% WR, -1.0R
2025-12: 2 trades, 50% WR, +3.0R
2026-01: 9 trades, 44.4% WR, +11.81R
2026-04: 13 trades, 15.4% WR, +2.23R
```

Gates not yet passed: live-validity audit, paper-readiness audit, production candidate document, parity test.

---

## 7. REJECTED MODELS AND WHY

### MNQ â€” Level/Direction Families Tested and Not Promoted

| Family | Outcome | Reason |
|---|---|---|
| ASL Long | Not promoted | Insufficient edge after quality filter; not selected |
| PDL Long (MNQ) | Not promoted | Tested in clean-follow study; not selected for production |
| PDH Short (MNQ) | Not promoted | Not promoted |
| LSH Short (MNQ) | Not promoted | Not promoted |
| All unfiltered baseline | MONITOR_ONLY / RESEARCH_ONLY at best | No filter config reached TRADEABLE verdict |

### XAU â€” Companion Candidates (from `companion_model_discovery_report.md`, all 9 tested)

| Candidate | Trades | WR | AvgR | PF | Max DD | OOS AvgR | Verdict |
|---|---|---|---|---|---|---|---|
| London continuation after PDL sweep | 17 | 29.4% | -0.12R | 0.83 | -5.0R | +0.5R | **reject** |
| London continuation after PDH sweep | 2 | 100% | +2.0R | inf | 0R | +2.0R | **reject** (too few) |
| Asian range sweep to London expansion | 32 | 31.3% | -0.06R | 0.91 | -13R | -0.4R | **reject** |
| London session H/L sweep continuation | 184 | 33.2% | -0.03R | 0.95 | -22.2R | -0.29R | **reject** |
| NY continuation after London range break | 0 | â€” | â€” | â€” | â€” | â€” | **reject** (0 trades) |
| Weekly H/L sweep continuation | 81 | 34.6% | +0.02R | 1.02 | -9R | -0.04R | **reject** (OOS negative) |
| High-volatility Gold expansion | 90 | 36.7% | +0.09R | 1.14 | -8R | -0.07R | **research further** (OOS negative) |
| Low-volatility compression to expansion | 6 | 16.7% | -0.50R | 0.40 | -4R | +0.5R | **reject** (too few, negative expectancy) |
| Weekly H/L sweep reversal | 26 | 50.0% | +0.50R | 2.0 | -3R | +0.5R | **research further** |

### XAU â€” Reversal Families Rejected (from `reversal_family_discovery_report.md`)

| Family | Trades | Reason |
|---|---|---|
| XAUUSD London PDH Short | 0 | No qualifying sweep events in London session |
| XAUUSD London ASL Long | 0 | No qualifying sweep events |
| XAUUSD London ASH Short | 0 | No qualifying sweep events |
| XAUUSD NY PDL Long | 0 | No qualifying sweep events in NY session |
| XAUUSD NY PDH Short | 0 | No qualifying sweep events |

Only London PDL Long generated any trades in the reversal family sweep across all 6 tested families.

---

## 8. RESEARCH STILL OPEN

### Candidate V2 OB-First (AJ Research Lab)

**File**: `tracks/aj-research-lab/external_interpretations/tactile/candidate_v2_ob_first_visualization_v1.pine`

**Status**: Research visualization only. Python detector is source of truth (Python script not in the Pine file path â€” refers to unspecified external Python detector). No backtest results exist. No promotion criteria met.

**Instrument**: MNQ/NQ (tick_size = 0.25, input-configurable)

**Frozen research constants** (inputs):
```pine
body_avg_len               = 20    // displacement body average length
direction_lookback         = 10    // direction lookback minutes
direction_threshold_ticks  = 8     // direction threshold ticks
displacement_min_body_ticks = 4   // min displacement body ticks
displacement_scan_bars     = 20   // scan for displacement
confirmation_scan_bars     = 30   // CISD/MSS scan bars
fvg_scan_bars              = 60   // FVG scan bars
ob_lookback_bars           = 10   // OB lookback bars
horizon_bars               = 60   // research horizon bars
```

**Event sequence**:
1. **F-event** (first event): at minutes `29` or `35` in a session, sweeps prior 5m or 15m swing or session high/low
   - prior_5_high = max of last 5 highs (manual rolling via `enabled_h01` to `enabled_h05`)
   - prior_15_high = max of last 15 highs
2. **S-event** (second event): at minutes `47, 50, 53, 56`, within 40 bars of F-event, opposite sweep direction
3. **Scan phase**: looks for displacement (bearish/bullish body >= avg_body AND body >= 4 ticks) within `displacement_scan_bars=20` bars
4. **OB**: last opposite-direction candle body within `ob_lookback_bars=10` bars before displacement candle
5. **OB-first condition**: OB must be the FIRST of {OB, CISD, MSS, FVG} to appear (tie order: MSS wins â†’ CISD â†’ OB â†’ FVG)
6. **Entry**: OB midpoint retest (`retest_mode = "midpoint"`) or zone retest

**Target guides** (from event_close):
- 25t, 50t, 75t, 100t (in direction of event_direction)
- Equal-sized 100t stop guide (against direction)

**Known negative result**: Pine chart label states explicitly: `"NY_PM was negative at 100t in expanded research."`

**Blockers preventing promotion**:
- No Python backtest script for V2 OB-First exists in the `scripts/` folder
- Python detector is stated as source of truth but is not in the repo
- No anti-lookahead audit completed
- No backtest results (no trades CSV, no summary JSON)
- AJ research lab is isolated â€” cannot import from production candidate

---

### XAU Research Still Open

#### Weekly Sweep Reversal (from `weekly_sweep_reversal_deep_dive_report.md`)

**Final verdict**: `continue research`. Strongest bucket: `150_299` (sweep depth 150â€“299 ticks).

| Parameter | Value |
|---|---|
| Event definition | Weekly high/low swept and close-back rejection (different day) |
| Fixed target tested | fixed_2R |
| Total trades | 26 |
| Win rate | 50% |
| AvgR | +0.50R |
| PF | 2.0 |
| Max DD | -3R |
| top3_removed avg_r | +0.30R |
| OOS avg_r | +0.50R |
| Active weeks | 9 |
| Anti-lookahead | PASS |

**Best sub-buckets** (minimum trades for inclusion: 5):

| Dimension | Bucket | Trades | WR | AvgR | PF |
|---|---|---|---|---|---|
| sweep_depth | 150_299 | 6 | 83% | 1.50R | 10.0 |
| sweep_depth | 300_plus | 13 | 46% | 0.38R | 1.71 |
| time_of_day | ny | 6 | 83% | 1.50R | 10.0 |
| time_of_day | asia | 5 | 60% | 0.80R | 3.0 |
| volatility | Normal | 13 | 69% | 1.08R | 4.5 |
| rejection_speed | 150_plus | 25 | 52% | 0.56R | 2.17 |
| distance_from_pdh_pdl | far | 7 | 71% | 1.14R | 5.0 |

**Portfolio verdict vs Model A (London PDL Long)**: combined max DD = -12R vs Model A alone = -16R. Weekly R correlation = -0.18 (nearly uncorrelated). `"improves frequency and historical max drawdown."`

**Target type comparison** (same 26 weekly sweep events, different targets):
- `fixed_r` (2R): 26 trades, 50% WR, +0.50R PF 2.0 â†? only viable target
- `opposing_daily_liquidity`: 655 trades, 6.7% WR, +0.19R â€” high trade count from looser matching, poor WR
- `opposing_weekly_liquidity`: 1177 trades, 4.7% WR, +0.01R â€” essentially break-even
- `session_midpoint`: 362 trades, 6.6% WR, +0.23R

#### High-Volatility Gold Expansion Model

| Parameter | Value |
|---|---|
| Total trades | 90 |
| Win rate | 36.7% |
| AvgR | +0.09R |
| PF | 1.14 |
| Max DD | -8R |
| OOS avg_r | -0.07R |
| Verdict | research further (but OOS negative) |

OOS is negative â€” this candidate is unlikely to survive further validation.

---

## 9. PINE SCRIPT PATTERNS

### Session Box Building (from Candidate V2 OB-First)

```pine
var box session_box = na
var int active_session_start = na
new_session = session_enabled and not session_enabled[1]
end_session  = not session_enabled and session_enabled[1]

if show_session_boxes and new_session
    session_box := box.new(bar_index, high, bar_index, low,
                           bgcolor=session_color, border_color=color.new(color.gray, 70))
    active_session_start := bar_index

if show_session_boxes and session_enabled and not na(session_box)
    box.set_right(session_box, bar_index)
    box.set_top(session_box, math.max(box.get_top(session_box), high))
    box.set_bottom(session_box, math.min(box.get_bottom(session_box), low))

if end_session
    session_box := na
    active_session_start := na
```

### ASH Level Building (from ASH Pine)

```pine
// started()/ended() helpers:
started(session) => session and not nz(session[1], false)
ended(session)   => not session and nz(session[1], false)

var float asianHigh = na
var float ash = na

if started(inAsian)
    asianHigh := high
else if inAsian
    asianHigh := na(asianHigh) ? high : math.max(asianHigh, high)

if ended(inAsian)
    ash := asianHigh

ashAvailable = not na(ash) and availableAfter(3 * 60)

plot(ashAvailable ? ash : na, "ASH",
     color=color.new(color.orange, 0), linewidth=2, style=plot.style_linebr)
```

Pattern: `style=plot.style_linebr` means the line breaks when `na` â€” levels don't carry forward into irrelevant sessions visually.

### Sweep Detection (from ASH Pine)

```pine
isSweep = barstate.isconfirmed  // only on closed candles
    and state == 0              // not in post-sweep monitoring
    and eligibleSession
    and ashAvailable
    and high > ash
    and close < ash
```
**Critical**: `barstate.isconfirmed` ensures evaluation only at candle close, preventing intrabar false signals.

### Displacement Check in Pine

```pine
medianBody = ta.median(math.abs(close - open), 20)[1]   // [1] = exclude current bar
candleBody = math.abs(close - open)
candleRange = high - low
bodyRatio = candleRange > 0 ? candleBody / candleRange : 0.0
bearishDisplacement = close < open
    and medianBody > 0
    and candleBody / medianBody >= 1.5
    and bodyRatio >= 0.6
```

### State Machine Variables (from ASH Pine)

```pine
var int state = 0          // 0=waiting, 1=post-sweep monitoring
var int postSweepBars = 0  // 1, 2, or 3 post-sweep candles
var float sweepClose = na
var float sweepHigh = na
var float stopLevel = na
var float targetLevel = na
var bool pullbackSeen = false
var float distanceBeforePullback = 0.0
var int consecutiveDisplacement = 0
var int maxConsecutiveDisplacement = 0
var int displacementConfirmedAt = 0  // 0 = not yet confirmed
var int distanceConfirmedAt = 0
```

### Nearest Target Selection (Pine)

```pine
nearestTargetBelow(entryPrice) =>
    float candidate = na
    string name = ""
    if pdlAvailable and pdl < entryPrice
        candidate := pdl
        name := "PDL"
    if aslAvailable and asl < entryPrice and (na(candidate) or entryPrice - asl < entryPrice - candidate)
        candidate := asl
        name := "ASL"
    // repeated for lslAvailable, onlAvailable, pmlAvailable, nyorlAvailable, ny1lAvailable
    [candidate, name]
```
Pattern: start with PDL, override only if new candidate is closer to entry.

### Alert Condition

**ASH V1 Pine** (visual-only, no payload):
```pine
alertcondition(signalThisBar and barstate.isconfirmed,
    "ASH_SHORT_QUALITY_FILTER_V1 signal",
    "ASH_SHORT_QUALITY_FILTER_V1 visual signal. Verify against parity engine before any execution use.")
```
This alert has **no JSON payload** â€” it's for visual validation only, not for the webhook system.

**Candidate V2 research alerts** (also no payload, research-only):
```pine
alertcondition(candidate_event, "Candidate event detected",
    "Candidate v2 research event detected. Research visualization only - not a trading signal.")
alertcondition(ob_retest_entry_candidate, "OB retest entry candidate",
    "Candidate v2 OB-first OB retest entry candidate. Research visualization only - not a trading signal.")
alertcondition(guide25, "25t guide reached", "Candidate v2 OB-first 25 tick guide reached. Research visualization only.")
```

### Known Pine Limitations vs Python Detector

1. **Liquidity age**: `"liquidity age: unavailable in Pine v1"` â€” noted in quality context label. Pine cannot compute how old a liquidity pool is (e.g., how many sessions have it been intact). Python can check this in the level builder.

2. **Historical target reconstruction**: Pine reconstructs targets from chart data. Known 7/301 frozen target approximation mismatches when using `"Frozen parity target approximation"` mode (from PROJECT_STATE_SUMMARY).

3. **Data feeds**: TradingView `CME_MINI:MNQ1!` may differ from local CSV data (different OHLC, different session data availability). Validation requires extended/electronic session enabled.

4. **`request.security()` lookahead**: Not used in either Pine script. Both use only `barstate.isconfirmed` evaluation.

5. **`ta.pivot*` / confirmed swings**: Explicitly prohibited in ASH spec. Candidate V2 uses rolling window arrays for prior 5m/15m highs/lows (no pivot functions).

6. **Signal display mode**: Two modes in ASH Pine: `"Show all historical signals"` (for backtesting visual validation) and `"Show only live-valid signals"` (realtime only). Historical mode is used for parity validation.

---

## 10. INFRASTRUCTURE PATTERNS

### Webhook Payload Schema (from `api/webhook.js` and `CLAUDE.md`)

**Entry payload** (from TradingView alert):
```json
{
  "ticker":    "MNQ1!",
  "action":    "buy",
  "price":     25258.75,
  "qty":       5,
  "sl":        25203.75,
  "tp1":       25280.75,  "tp1_qty": 1,
  "tp2":       25302.75,  "tp2_qty": 0,
  "tp3":       25313.75,  "tp3_qty": 4,
  "chart_url": "{{imageurl}}"
}
```
`action` values: `"buy"` | `"sell"` | `"exit"` | `"sl"`

**Exit/TP payload**:
```json
{
  "ticker":    "MNQ1!",
  "action":    "exit",
  "tp":        "TP1",
  "qty":       1,
  "price":     25280.75,
  "chart_url": "{{imageurl}}"
}
```
`tp` values: `"TP1"` | `"TP2"` | `"TP3"`

**SL payload**:
```json
{
  "ticker":  "MNQ1!",
  "action":  "sl",
  "price":   25203.75,
  "chart_url": "{{imageurl}}"
}
```

**URL parameters**: `?strategy=QT-AMDX` routes to Telegram channel.

### Strategy Routing Pattern

```javascript
const TELEGRAM_CHANNEL_MAP = {
  "qt-amdx":   process.env.TELEGRAM_CHAT_QT_AMDX,
  "ash-sweep": process.env.TELEGRAM_CHAT_ASH_SWEEP,
  "project2":  process.env.TELEGRAM_CHAT_PROJECT2,
  "project3":  process.env.TELEGRAM_CHAT_PROJECT3,
};

function strategyKey(name) {
  return (name || "").toLowerCase().replace(/[\s_]+/g, "-");
}
// "QT-AMDX" â†’ "qt-amdx"
// "ash_sweep" â†’ "ash-sweep"
// "My Strategy" â†’ "my-strategy"

function getTelegramChatId(strategy) {
  return TELEGRAM_CHANNEL_MAP[strategyKey(strategy)]
      || process.env.TELEGRAM_CHAT_DEFAULT
      || null;
}
```

### Screenshot Pipeline

```
TradingView alert fires with "chart_url": "{{imageurl}}"
         â†“
webhook.js receives chart_url (S3 direct image URL, e.g. https://s3.tradingview.com/snapshots/x/XXXX.png)
         â†“
captureScreenshot(chartUrl)
  â†’ ScreenshotOne API: https://api.screenshotone.com/take?access_key={SCREENSHOTONE_KEY}&url={chartUrl}
    &viewport_width=1440&viewport_height=900&full_page=false&format=jpg&image_quality=85
    &delay=3&block_ads=true&block_cookie_banners=true
  â†’ On 200: Buffer.from(arrayBuffer).toString("base64") â†’ {base64, mimeType:"image/jpeg"}
  â†’ On non-200: log error body, return null
         â†“
uploadScreenshotToGitHub(base64, filename)
  â†’ PUT https://api.github.com/repos/{GITHUB_REPO}/contents/docs/screenshots/{ticker}-{Date.now()}.jpg
  â†’ Returns data.content.download_url (raw.githubusercontent.com URL)
         â†“
sendTelegram(chatId, caption, screenshotUrl)
  â†’ If screenshotUrl: POST /sendPhoto {chat_id, photo, caption, parse_mode:"HTML"}
  â†’ If no screenshotUrl: POST /sendMessage {chat_id, text:caption, parse_mode:"HTML"}
```

**Critical**: TradingView chart page URLs (`/chart/XXXX/`) return **403** to ScreenshotOne. Must use `{{imageurl}}` in TradingView alert payload which generates a direct S3 PNG URL. Confirmed by log: `"ScreenshotOne error: 500 {'error_code':'host_returned_error','returned_status_code':403}"`.

**Execution timing**: The screenshot/Telegram block is `await`ed **before** `res.status(200).json()`. Vercel kills function execution after HTTP response â€” fire-and-forget IIFEs are truncated.

### Telegram Caption Format

```javascript
function buildCaption(action, ticker, price, strategy, payload, pnl, result) {
  // emoji: buyâ†’ðŸŸ¢, sellâ†’ðŸ”´, closed winâ†’âœ…, closed lossâ†’â?Œ, otherâ†’ðŸ”?
  let lines = [`${emoji} <b>${action.toUpperCase()} ${ticker}</b>`];
  if (strategy)            lines.push(`Strategy: ${strategy}`);
  lines.push(`Price: ${price}`);
  if (payload.sl != null)  lines.push(`SL: ${payload.sl}`);
  const tps = [payload.tp1, payload.tp2, payload.tp3].filter(v => v != null);
  if (tps.length)          lines.push(`TP: ${tps.join(" / ")}`);
  if (payload.qty != null) lines.push(`Qty: ${payload.qty}`);
  if (pnl !== undefined)   lines.push(`PnL: <b>+${pnl}</b>`);
  lines.push(`<i>${new Date().toUTCString()}</i>`);
  return lines.join("\n");
}
```
Parse mode: HTML. Telegram supports `<b>`, `<i>`, `<code>` tags.

### MT5 Routing Channel

Separate from per-strategy Telegram. Raw JSON signals sent to a fixed MT5-routing channel:
```javascript
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL = process.env.TELEGRAM_CHANNEL_ID;  // e.g. "-1003720726531"

async function sendTelegramJson(obj) {
  // Sends: {tv:"entry", id, ticker, action, price, sl, tp1, tp2, tp3}
  //     or: {tv:"exit",  id, ticker, action:"exit"|"sl", price, tp?}
}
```

### trades.json Schema

```json
{
  "openTrades": {
    "{tradeId}": {
      "id": "MNQ1!-1714000000000",
      "ticker": "MNQ1!",
      "strategy": "QT-AMDX",
      "direction": "buy",
      "entryTime": "ISO8601",
      "entryPrice": 25258.75,
      "qty": 5,
      "exits": [{"price":25280.75,"qty":1,"time":"ISO8601","tp":"TP1"}],
      "status": "open"
    }
  },
  "closedTrades": [
    {
      "id": "...", "closeTime": "ISO8601", "exitPrice": 25302.75,
      "pnl": 237.50, "result": "win", "status": "closed"
      // ...all entry fields preserved
    }
  ],
  "logs": [{"time":"ISO8601","strategy":null,"payload":{},"result":"...","error":null}]
}
```

Key behaviors:
- `openTrades` keyed by `tradeId` (not ticker). `findOpenTrade()` scans for matching ticker, LIFO.
- `closedTrades`: newest-first (`unshift` on close).
- `logs[]`: capped at 100 entries.
- Read-modify-write via GitHub Contents API with `sha` from GET for optimistic concurrency.
- `journal.jsonl` is best-effort (failure doesn't fail the request).

### P&L Calculation (from `webhook.js`)

```javascript
const POINT_VALUES = { 'MNQ1!': 2, 'MGC1!': 10, 'MES1!': 5, 'NQ1!': 20, 'ES1!': 50 };

pnl = Math.round(
  trade.exits.reduce((sum, e) => {
    const pts = trade.direction === "buy"
      ? e.price - trade.entryPrice
      : trade.entryPrice - e.price;
    return sum + pts * e.qty * pointValue;
  }, 0) * 100
) / 100;

result = pnl >= 0 ? "win" : "loss";
```

SL exit: remaining qty (`trade.qty - sum(exits.qty)`) is settled at `slPrice`. Then trade closes.

### Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | webhook.js | PAT with Contents R/W |
| `GITHUB_REPO` | webhook.js | e.g. `anileppakayala88/trade-log` |
| `GITHUB_BRANCH` | webhook.js | default `"main"` |
| `WEBHOOK_SECRET` | webhook.js | Optional header `x-webhook-secret` |
| `TELEGRAM_BOT_TOKEN` | webhook.js | Bot token from BotFather |
| `TELEGRAM_CHANNEL_ID` | webhook.js | MT5 routing channel chat_id |
| `TELEGRAM_CHAT_QT_AMDX` | webhook.js | Per-strategy human channel |
| `TELEGRAM_CHAT_ASH_SWEEP` | webhook.js | Per-strategy human channel |
| `TELEGRAM_CHAT_DEFAULT` | webhook.js | Fallback channel |
| `SCREENSHOTONE_KEY` | webhook.js | ScreenshotOne access key |
| `TELEGRAM_BOT_TOKEN` | paper_signal_runner.py | ASH paper alert runner |

### ASH Paper Signal Runner

```
File:       tracks/mnq-production-candidate/execution/paper_signal_runner.py
Config:     tracks/mnq-production-candidate/config/paper_alert_config.template.json
Mode:       PAPER_ONLY / TELEGRAM_ALERT_ONLY
Safety gates:
  model_version == ASH_SHORT_QUALITY_FILTER_V1
  paper_only == true
  alert_mode == TELEGRAM_ALERT_ONLY
Journals:   tracks/mnq-production-candidate/journals/signals_YYYYMMDD.csv
            tracks/mnq-production-candidate/journals/signals_YYYYMMDD.jsonl
Daily summary: tracks/mnq-production-candidate/reports/paper-monitor/daily_signal_summary.csv
```

### Git Push Pattern (soft-reset to avoid rebase conflicts)

Webhook auto-commits (`trades.json`, `journal.jsonl`) cause remote divergence. Safe push pattern:
```bash
git fetch origin main
git reset --soft origin/main
git add api/webhook.js   # or specific files only
git commit -m "..."
git push origin main
```
Never use `git pull --rebase` when remote has auto-written webhook commits â€” causes merge conflicts on the same file.

---

*End of SKILL.md extraction. Total source files read: README.md, STRATEGY_SPEC.md, ASH_SHORT_QUALITY_FILTER_PRODUCTION_CANDIDATE.md, BRANCH_TRACK_ROADMAP.md, PROJECT_STATE_SUMMARY_2026_06_04.md, config/settings.yaml, PINE_VALIDATION_CHECKLIST.md, ASH_SHORT_QUALITY_FILTER_V1_VISUALIZATION.pine (full), candidate_v2_ob_first_visualization_v1.pine (full), ash_quality_filter_signal_engine.py, ash_quality_filter_deployment_reality_study.py, ash_quality_filter_paper_trading_readiness_audit.py, ash_quality_filter_parity_test.py, mnq_liquidity_pool_expansion.py, clean_follow_delayed_entry_study.py (partial), xau-research-lab/README.md + MANIFEST.md + HANDOFF.md, simple_liquidity_sweep_backtest.py, winner_archetype_study.py, weekly_sweep_reversal_deep_dive.py, companion_model_discovery_study.py (partial), reversal_family_discovery_report.md, companion_model_discovery_report.md, weekly_sweep_reversal_deep_dive_report.md, trade-log/api/webhook.js, trade-log/README.md, trade-log/CLAUDE.md.*