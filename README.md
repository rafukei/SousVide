# Node-RED PID Temperature Controller with Fixed-Kp Ziegler–Nichols Auto-Tune

A modular **Node-RED control system** for temperature regulation using:

- **Normal PID control**
- **PWM output control**
- **Low-pass filtered temperature input**
- **Fixed-Kp Ziegler–Nichols closed-loop auto-tuning**
- **Clear runtime reporting and status output**

This project is designed for **slow thermal systems** such as:

- induction cookers
- heated water baths
- sous vide systems
- kettles
- tanks with 1–3 L of water
- other temperature processes with high thermal inertia

The controller is split into **four separate Node-RED function nodes**:

1. `INIT`
2. `AUTOTUNE`
3. `PID`
4. `PWM + REPORT`

The design uses **flow context directly** instead of passing a large object through `msg` on every cycle.  
This is intentional because the loop typically runs at about **1 second intervals**, where direct `flow` storage is cleaner and easier to maintain.

---

## Features

### Control features
- Standard **PID temperature control**
- **Derivative smoothing** using a **60-sample moving average**
- **Integral anti-windup** by clamping and decay logic
- **PWM output generation** for slow switching loads
- Optional separate PWM period for auto-tune mode

### Auto-tune features
- Uses **pure P-only closed-loop oscillation test**
- **Fixed manual Kp** during auto-tune
- Detects **setpoint crossings**
- Measures **half-cycles** and oscillation period
- Checks whether oscillation is **stable enough**
- Calculates PID values from **classic Ziegler–Nichols equations**
- Does **not** search or ramp Kp automatically

### Reporting features
- Structured JSON-like status output
- Human-readable text report
- Live Node-RED node status indicator
- Separate outputs for duty, PWM state, status object, and text report

---

## Why Fixed-Kp Auto-Tune?

Earlier versions used automatic Kp stepping, but in slow thermal systems that often produced unreliable results.

This version intentionally uses a **manually chosen fixed proportional gain** during tuning.  
That gives you better control over the oscillation test and avoids problems caused by:

- changing dynamics during long thermal response times
- unstable interpretation of incomplete oscillation cycles
- false tuning results when Kp is changed before the process fully reacts

With this method, you choose a Kp that is close to the oscillation boundary and let the controller **measure the natural oscillation period**.

---

## System Architecture

The flow should run in this exact order:

```text
Temperature input -> INIT -> AUTOTUNE -> PID -> PWM + REPORT
```

### Why this order matters
Each function node reads and writes values directly in `flow` context.

That means:
- `INIT` must always run first
- `AUTOTUNE` must run before `PID`
- `PWM + REPORT` must run last

If the order changes, downstream nodes may read stale values.

---

## Function Node Overview

---

## 1. `INIT`

### Purpose
The `INIT` node prepares all shared runtime values for the control loop.

### Responsibilities
- Read the current process value (`PV`) from `flow.message`
- Read the target setpoint (`SP`) from `flow.setpoint`
- Load PID parameters and system settings
- Apply low-pass filtering to the measured temperature
- Calculate the loop delta time `dt`
- Handle reset logic
- Store all shared values back into `flow`

### Key behavior
- If loop timing becomes abnormal, `dt` is clamped for safety
- Reset clears both PID memory and auto-tune memory
- Filtered temperature is stored for later use by both PID and auto-tune

---

## 2. `AUTOTUNE`

### Purpose
The `AUTOTUNE` node performs a **closed-loop P-only oscillation test** using a **fixed manually selected Kp**.

### Responsibilities
- Run only when `flow.autoTune == true`
- Apply P-only control:
  - `P = Kp * error`
  - `I = 0`
  - `D = 0`
- Limit tuning output with `tuneMaxOutput`
- Detect whether the process is clearly:
  - below setpoint
  - above setpoint
- Record true crossings across the setpoint band
- Measure half-cycle durations
- Check oscillation stability
- Calculate `Ku` and `Pu`
- Calculate final PID values using Ziegler–Nichols

### Important design choice
The auto-tune logic **does not modify Kp automatically**.  
It always uses the manually configured:

```javascript
flow.get("tuneKpManual")
```

---

## 3. `PID`

### Purpose
The `PID` node runs normal control when auto-tune is not active.

### Responsibilities
- Read the current error
- Compute the P term
- Compute the I term with anti-windup
- Compute the D term from filtered temperature slope
- Smooth derivative action with a 60-sample average
- Clamp final output to `0...100 %`

### Derivative behavior
Instead of using a noisy instantaneous derivative, the controller stores the last 60 temperature slope samples and uses their average.

That makes the derivative much more stable for thermal systems.

---

## 4. `PWM + REPORT`

### Purpose
The `PWM + REPORT` node converts controller output into ON/OFF behavior and generates runtime diagnostics.

### Responsibilities
- Convert output percentage to PWM ON-time
- Calculate current PWM state
- Build a structured status object
- Build a text report
- Save status for dashboards, MQTT, or debug use
- Update Node-RED visual status
- Return the 5 outputs

### Outputs
1. `pid_output`
2. `pwm_duty`
3. `pwm_state`
4. `pid_status`
5. `autotune_report`

---

## Control Strategy

---

## Normal PID Mode

When auto-tune is disabled, the controller uses:

```text
Output = P + I + D
```

Where:

- `P = Kp * error`
- `I = accumulated integral term`
- `D = -Kd * average temperature slope`

### Integral logic
The integral is only accumulated when the absolute error is reasonably small.

This helps prevent wind-up when the system is still far from the setpoint.

### Derivative logic
The derivative is calculated from the **filtered process value** rather than the raw temperature input.

This is important because:
- raw sensor values are noisy
- thermal systems are slow
- derivative noise can cause unstable PWM behavior

---

## Auto-Tune Strategy

This project uses a **fixed-Kp Ziegler–Nichols closed-loop method**.

### Step-by-step logic
1. Enable `autoTune`
2. Set `tuneState = "IDLE"`
3. Auto-tune starts with:
   - fixed `Kp = tuneKpManual`
   - `I = 0`
   - `D = 0`
4. The system waits for the process to oscillate around the setpoint
5. Crossings are detected only when the process clearly moves from one side of the band to the other
6. Half-cycle times are measured between crossings
7. When enough half-cycles have been collected, their stability is checked
8. If oscillation is stable enough:
   - `Ku = tuneKpManual`
   - `Pu = averageHalfCycle * 2`
9. PID values are calculated from `Ku` and `Pu`
10. Auto-tune stops and normal PID can begin

---

## Ziegler–Nichols Equations Used

Once stable oscillation is found:

- `Ku` = ultimate gain  
- `Pu` = oscillation period

The controller calculates:

```text
Kp = 0.6 * Ku
Ki = 1.2 * Ku / Pu
Kd = 0.075 * Ku * Pu
```

These are the classic Ziegler–Nichols closed-loop PID rules.

### Notes
This is intentionally simple and widely understood, but ZN often gives fairly aggressive tuning.

For thermal systems, you may later want to reduce aggressiveness manually, for example by:
- lowering `Kp`
- lowering `Ki`
- lowering `Kd`

---

## Flow Variables

Below are the main `flow` variables used by the system.

---

## Core process variables

| Variable | Meaning |
|---|---|
| `message` | Current measured temperature |
| `setpoint` | Target temperature |
| `pv` | Current process value copied from `message` |
| `sp` | Current setpoint copied from `setpoint` |
| `filteredPv` | Low-pass filtered temperature |
| `dt` | Loop delta time in seconds |
| `now` | Current timestamp in seconds |

---

## PID variables

| Variable | Meaning |
|---|---|
| `Kp` | Proportional gain |
| `Ki` | Integral gain |
| `Kd` | Derivative gain |
| `pid_integral` | Stored integral term |
| `prevFilteredPv` | Previous filtered temperature |
| `dHistory` | Recent temperature slope history |
| `P_term` | Current proportional contribution |
| `I_term` | Current integral contribution |
| `D_term` | Current derivative contribution |
| `controlOutput` | Final controller output in % |

---

## PWM variables

| Variable | Meaning |
|---|---|
| `pwmPeriod` | PWM period during normal PID |
| `pwmPeriodTune` | PWM period during auto-tune |
| `minOnTime` | Minimum ON pulse length |
| `pwmStart` | Start timestamp of PWM cycle |
| `pwm_state` | Current ON/OFF state |

---

## Auto-tune variables

| Variable | Meaning |
|---|---|
| `autoTune` | Enables auto-tune when true |
| `tuneState` | Current auto-tune state |
| `tuneOutput` | Output during auto-tune |
| `tuneKpManual` | Fixed Kp used during tuning |
| `tuneMaxOutput` | Maximum output allowed during tuning |
| `znCrossBand` | Dead-band around setpoint |
| `znRequiredHalfCycles` | Required half-cycles for validation |
| `znMaxPeriodVariation` | Max allowed oscillation variation |
| `znMaxTuneTime` | Auto-tune timeout |
| `znKpTest` | Active Kp used during tune |
| `znCrossings` | Crossing history |
| `znPeriods` | Half-cycle durations |
| `znLastSide` | Last detected side of setpoint |
| `znKu` | Measured ultimate gain |
| `znPu` | Measured oscillation period |

---

## Reporting variables

| Variable | Meaning |
|---|---|
| `phaseDetail` | Human-readable current state text |
| `phaseNextAction` | Human-readable next expected action |
| `failReason` | Error text if tune fails |
| `avgHalfPeriod` | Average measured half-cycle |
| `periodVariation` | Relative period variation |
| `autotune_report` | Final report string |

---

## Auto-Tune State Machine

The auto-tune logic uses a simple state machine.

### `IDLE`
Initial waiting state.

When auto-tune is started:
- fixed Kp is loaded
- tuning memory is reset
- controller moves to `ZN_SEARCH`

### `ZN_SEARCH`
Main oscillation measurement state.

The node:
- runs pure P-only control
- detects crossings
- measures half-cycles
- checks oscillation consistency

If stable oscillation is found:
- state changes to `CALCULATE`

If timeout occurs:
- state changes to `FAILED`

### `CALCULATE`
Computes PID values from measured `Ku` and `Pu`.

If valid:
- stores new `Kp`, `Ki`, `Kd`
- moves to `COMPLETE`

If invalid:
- moves to `FAILED`

### `COMPLETE`
Successful end state.

Auto-tune disables itself and the normal PID controller can continue.

### `FAILED`
Unsuccessful end state.

Auto-tune disables itself and the report contains the failure reason.

---

## How Crossing Detection Works

Crossing detection is intentionally conservative.

The controller does **not** count a crossing when temperature only touches the setpoint briefly.

Instead, the process must move clearly outside the configured band:

- `error > znCrossBand` → `BELOW_SP`
- `error < -znCrossBand` → `ABOVE_SP`

A crossing is only recorded when the process changes from one clear side to the other.

This avoids false crossings caused by:
- measurement noise
- small dithering around the setpoint
- filter delay near zero error

---

## How Oscillation Stability Is Checked

The algorithm waits until enough half-cycles have been measured.

Then it computes:

- average half-cycle
- minimum half-cycle
- maximum half-cycle
- relative variation

Variation is computed as:

```text
(maxHalf - minHalf) / avgHalf
```

If the result is less than or equal to:

```text
znMaxPeriodVariation
```

the oscillation is considered stable enough.

---

## Typical Configuration

A reasonable starting configuration for a slow heated water system:

```javascript
flow.set("alpha", 0.4);
flow.set("pwmPeriod", 60);
flow.set("pwmPeriodTune", 60);
flow.set("minOnTime", 1);

flow.set("tuneKpManual", 10);
flow.set("tuneMaxOutput", 25);
flow.set("znCrossBand", 0.10);
flow.set("znRequiredHalfCycles", 4);
flow.set("znMaxPeriodVariation", 0.25);
flow.set("znMaxTuneTime", 7200);
```

You will likely need to adjust `tuneKpManual` for your actual process.

---

## How to Start Auto-Tune

To start a fresh auto-tune run, set:

```javascript
flow.set("autoTune", true);
flow.set("tuneState", "IDLE");
```

This tells the `AUTOTUNE` node to initialize a new tuning cycle.

---

## How to Reset Everything

To clear both PID and auto-tune memory, set:

```javascript
flow.set("resetAutoTune", true);
```

The `INIT` node will then:
- reset PID state
- reset auto-tune state
- clear reports and histories
- restore some default tuning-related values

---

## Expected Loop Timing

This project is intended for a loop that runs roughly every:

```text
1 second
```

That is why:
- `flow` context is used instead of passing a large control object through `msg`
- the derivative moving average uses about 60 seconds of history
- PWM periods are measured in tens of seconds

This approach is best suited for **slow thermal processes**, not fast electromechanical systems.

---

## Safety Notes

This controller can switch real heating hardware.  
Always validate behavior with caution.

### Recommended precautions
- Limit `tuneMaxOutput` during auto-tune
- Use a reasonable maximum process temperature externally
- Add an independent over-temperature shutdown
- Keep PWM periods long for mechanical relays
- Use SSRs or solid-state switching where appropriate
- Test first with water, not food or unattended operation

### Important
This repository does **not** replace proper hardware safety design.

You should still implement:
- watchdog logic
- absolute high-temperature cut-off
- sensor failure detection
- relay fault handling
- dry-run protection if relevant

---

## Tuning Advice

### If auto-tune never crosses the setpoint
Your fixed Kp is probably too low, or `tuneMaxOutput` is too restrictive.

Try:
- increasing `tuneKpManual`
- slightly increasing `tuneMaxOutput`

### If oscillation is very chaotic
Your fixed Kp may be too high, or measurement noise is too strong.

Try:
- reducing `tuneKpManual`
- increasing filtering slightly
- increasing `znCrossBand`

### If tuning takes forever
Thermal systems are slow.

Try:
- reducing the setpoint region where you begin tuning
- increasing `tuneMaxOutput` carefully
- reducing `znRequiredHalfCycles` for quicker validation

### If final PID is too aggressive
Classic ZN often is.

Try manually softening:
- lower `Kp`
- lower `Ki`
- lower `Kd`

---

## Node Outputs

The final `PWM + REPORT` node returns 5 outputs.

### Output 1: `pid_output`
Raw controller output percentage.

### Output 2: `pwm_duty`
Same duty percentage, provided separately for convenience.

### Output 3: `pwm_state`
Current ON/OFF state.

### Output 4: `pid_status`
Structured status object with:
- temperatures
- error
- output
- PID terms
- tune state
- oscillation measurements

### Output 5: `autotune_report`
Human-readable text report.

---

## Example Report

```text
AUTOTUNE STATUS
==============================
State: ZN_SEARCH
Detail: Phase 3/4: collecting half-cycles...
Next: Need 2 more half-cycles before stability check

PV: 59.842 °C
SP: 60.000 °C
Error: 0.158 °C

AutoTune: ON
Output: 12.300 %
PWM: ON
PWM period: 60 s

Fixed Kp: 10.000
Configured manual Kp: 10.000
Crossings: 5
Half cycles: 3/4

Last side: BELOW_SP
Cross band: 0.1 °C

Avg half period: -
Variation: -

Tune max output: 25 %
Max period variation: 25.0 %
Max tune time: 7200 s
```

---

## Recommended Repository Structure

```text
.
├── README.md
├── init.js
├── autotune.js
├── pid.js
── pwm.js
```

If you later export the complete Node-RED flow, add it to the `examples/` folder.

---

## Intended Use Case

This controller is especially suitable when:
- the process is slow
- sensor noise exists
- actuator switching is coarse
- output is implemented with PWM
- the goal is stable thermal control rather than rapid tracking

Typical examples:
- sous vide water bath
- heated pot on induction plate
- thermal reservoir
- low-speed industrial heater

---

## Limitations

This design is intentionally simple and practical, but it has limits:

- Ziegler–Nichols may produce aggressive PID values
- fixed-Kp tuning still depends on good manual Kp selection
- very noisy sensors may still disturb crossing detection
- large dead time processes may require more advanced tuning methods
- thermal lag can make apparent oscillation slower than expected

For demanding systems, you may later want to add:
- feedforward
- gain scheduling
- adaptive output limits
- integral separation
- dead-time compensation
- relay-based auto-tune or model-based tuning

---

## Summary

This project provides a clean and modular Node-RED implementation of:

- a slow-loop PID temperature controller
- fixed-Kp Ziegler–Nichols auto-tuning
- long-window derivative smoothing
- PWM actuation
- structured diagnostics and reporting

The most important design decisions are:

- **4 separate function nodes**
- **direct use of flow context**
- **fixed manual Kp during auto-tune**
- **clear separation of INIT, tuning, control, and PWM/reporting**

That makes the system easier to debug, modify, and extend for real thermal control projects.

---

## License



- MIT

