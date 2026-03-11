// ============================================================
// INIT
// ============================================================
// This function prepares all shared runtime values for the
// control loop.
//
// Main responsibilities:
// 1. Read process value (PV) and setpoint (SP) from flow context
// 2. Load controller and auto-tune settings
// 3. Apply low-pass filtering to the measured temperature
// 4. Calculate loop delta time (dt)
// 5. Handle optional reset of PID and auto-tune state
// 6. Store all shared values back to flow context
//
// This node should run first in the chain.
// ============================================================

// -------------------- READ PROCESS VALUES --------------------
// PV = current process value (measured temperature)
// SP = target temperature
let pv = Number(flow.get("message") || 0);
let sp = Number(flow.get("setpoint") || 60);

// -------------------- LOAD PID PARAMETERS --------------------
// These are the active PID tuning values used during normal control.
let Kp = Number(flow.get("Kp") || 8.5);
let Ki = Number(flow.get("Ki") || 0.025);
let Kd = Number(flow.get("Kd") || 45);

// -------------------- LOAD GENERAL SETTINGS --------------------
// alpha          = filter strength for the measured PV
// pwmPeriod      = PWM cycle length during normal PID operation
// minOnTime      = minimum ON pulse length when output > 0
// pwmPeriodTune  = optional separate PWM cycle during auto-tune
let alpha = Number(flow.get("alpha") || 0.4);

let pwmPeriod = Number(flow.get("pwmPeriod") || 60);
let minOnTime = Number(flow.get("minOnTime") || 1);
let pwmPeriodTune = Number(flow.get("pwmPeriodTune") || 60);

// -------------------- LOAD FIXED AUTO-TUNE SETTINGS --------------------
// Auto-tune uses a manually selected fixed proportional gain.
// The algorithm does NOT search for Kp automatically.
let tuneKpManual = Number(flow.get("tuneKpManual") || 10);
let tuneMaxOutput = Number(flow.get("tuneMaxOutput") || 25);
let znCrossBand = Number(flow.get("znCrossBand") || 0.15);
let znRequiredHalfCycles = Number(flow.get("znRequiredHalfCycles") || 4);
let znMaxPeriodVariation = Number(flow.get("znMaxPeriodVariation") || 0.25);
let znMaxTuneTime = Number(flow.get("znMaxTuneTime") || 7200);

// -------------------- FILTER PROCESS VALUE --------------------
// A simple first-order low-pass filter is used to reduce
// sensor noise before the control logic uses the temperature.
let filteredPvPrev = flow.get("filteredPv");
let filteredPv = (filteredPvPrev === undefined || filteredPvPrev === null)
    ? pv
    : Number(filteredPvPrev);

filteredPv = alpha * pv + (1 - alpha) * filteredPv;

// -------------------- CALCULATE LOOP DELTA TIME --------------------
// dt is clamped to avoid unstable controller behavior if the loop
// runs too fast or too slowly.
let now = Date.now() / 1000;
let lastTime = flow.get("lastTime");
if (lastTime === undefined || lastTime === null) lastTime = now;

let dt = now - lastTime;

// If the loop has paused for too long, force dt to 1 second
// so the controller does not react too aggressively.
if (dt > 5) {
    node.warn(`Long time gap detected: ${dt.toFixed(1)} s - forcing dt=1 s`);
    dt = 1;
}

// Clamp dt to a safe range.
dt = Math.max(0.1, Math.min(2, dt));
flow.set("lastTime", now);

// -------------------- HANDLE FULL RESET --------------------
// If resetAutoTune is true, clear both auto-tune and PID memory.
// This gives a clean starting point for a new run.
if (flow.get("resetAutoTune")) {
    node.warn("Resetting auto-tune and PID state");

    // Auto-tune state
    flow.set("autoTune", false);
    flow.set("tuneState", "IDLE");
    flow.set("tuneOutput", 0);

    // PID memory
    flow.set("pid_integral", 0);
    flow.set("prevPv", null);
    flow.set("prevFilteredPv", null);
    flow.set("filteredPv", null);
    flow.set("dHistory", []);

    // Ziegler-Nichols oscillation measurement memory
    flow.set("znKpTest", null);
    flow.set("znStartTime", null);
    flow.set("znCrossings", []);
    flow.set("znPeriods", []);
    flow.set("znLastSide", null);
    flow.set("znPrevError", null);
    flow.set("znKu", null);
    flow.set("znPu", null);

    // Stored controller terms and output
    flow.set("P_term", 0);
    flow.set("I_term", 0);
    flow.set("D_term", 0);
    flow.set("controlOutput", 0);

    // Reporting state
    flow.set("failReason", "");
    flow.set("phaseDetail", "Reset done");
    flow.set("phaseNextAction", "Waiting for autoTune=true");

    // Optional defaults restored after reset
    flow.set("tuneKpManual", 10);
    flow.set("tuneMaxOutput", 25);
    flow.set("znCrossBand", 0.10);
    flow.set("znRequiredHalfCycles", 4);
    flow.set("znMaxPeriodVariation", 0.25);
    flow.set("znMaxTuneTime", 7200);

    flow.set("resetAutoTune", false);

    node.warn("Reset complete");
}

// -------------------- STORE SHARED RUNTIME VALUES --------------------
// These values are read by the following function nodes.
// This avoids passing large objects through msg on every loop.
flow.set("pv", pv);
flow.set("sp", sp);
flow.set("filteredPv", filteredPv);
flow.set("dt", dt);
flow.set("now", now);

flow.set("Kp", Kp);
flow.set("Ki", Ki);
flow.set("Kd", Kd);

flow.set("alpha", alpha);
flow.set("pwmPeriod", pwmPeriod);
flow.set("minOnTime", minOnTime);
flow.set("pwmPeriodTune", pwmPeriodTune);

flow.set("tuneKpManual", tuneKpManual);
flow.set("tuneMaxOutput", tuneMaxOutput);
flow.set("znCrossBand", znCrossBand);
flow.set("znRequiredHalfCycles", znRequiredHalfCycles);
flow.set("znMaxPeriodVariation", znMaxPeriodVariation);
flow.set("znMaxTuneTime", znMaxTuneTime);

// Pass message forward unchanged.
return msg;
