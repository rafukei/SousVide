// ============================================================
// PID CONTROLLER
// ============================================================
// This function runs the normal PID controller when auto-tune
// is not active.
//
// Main responsibilities:
// 1. Read current process state from flow context
// 2. Compute P, I and D terms
// 3. Use a 60-sample moving average for derivative smoothing
// 4. Clamp controller output to 0...100 %
// 5. Store all controller terms back to flow context
//
// This node should run after AUTOTUNE.
// ============================================================

// -------------------- SKIP NORMAL PID DURING AUTO-TUNE --------------------
let autoTune = Boolean(flow.get("autoTune") || false);
if (autoTune) {
    return msg;
}

// -------------------- LOAD SHARED VALUES --------------------
let pv = Number(flow.get("pv") || 0);
let sp = Number(flow.get("sp") || 60);
let filteredPv = Number(flow.get("filteredPv") || pv);
let dt = Number(flow.get("dt") || 1);

let Kp = Number(flow.get("Kp") || 8.5);
let Ki = Number(flow.get("Ki") || 0.025);
let Kd = Number(flow.get("Kd") || 45);

// Control error = target - measured value
let error = sp - filteredPv;

// Load integral memory from previous cycles.
let integral = Number(flow.get("pid_integral") || 0);

// Load previous filtered temperature for derivative calculation.
let prevFilteredPv = flow.get("prevFilteredPv");
if (prevFilteredPv === undefined || prevFilteredPv === null) {
    prevFilteredPv = filteredPv;
} else {
    prevFilteredPv = Number(prevFilteredPv);
}

// -------------------- PROPORTIONAL TERM --------------------
// Proportional term reacts immediately to the current error.
let P = Kp * error;

// -------------------- INTEGRAL TERM --------------------
// Integral term is accumulated only when the error is reasonably small.
// This reduces wind-up when the process is far from setpoint.
if (Math.abs(error) < 5) {
    integral += Ki * error * dt;

    // Clamp integral to keep it under control.
    integral = Math.max(-30, Math.min(30, integral));
} else {
    // Slowly decay integral when far from setpoint.
    integral *= 0.98;
}

let I = integral;

// -------------------- DERIVATIVE TERM --------------------
// Use derivative of the filtered process value instead of raw PV.
// Then smooth the temperature slope with a 60-sample moving average.
//
// dT represents temperature change rate in °C/s.
let dT = (filteredPv - prevFilteredPv) / dt;

// Keep a history of recent slopes.
let dHistory = flow.get("dHistory") || [];
dHistory.push(dT);

// Keep only the most recent 60 samples.
// With a 1-second loop, this is roughly a 60-second moving average.
if (dHistory.length > 60) {
    dHistory.shift();
}

flow.set("dHistory", dHistory);

// Average the slope values.
let dSum = dHistory.reduce((a, b) => a + b, 0);
let dAvg = dSum / dHistory.length;

// Derivative acts against rapid temperature rise or fall.
let D = (Kd > 0) ? (-Kd * dAvg) : 0;

// -------------------- TOTAL CONTROLLER OUTPUT --------------------
let output = P + I + D;

// Clamp output to valid PWM duty range.
output = Math.max(0, Math.min(100, output));

// -------------------- SAVE CONTROLLER STATE --------------------
flow.set("pid_integral", I);
flow.set("prevFilteredPv", filteredPv);
flow.set("prevPv", pv);

flow.set("P_term", P);
flow.set("I_term", I);
flow.set("D_term", D);
flow.set("controlOutput", output);

// Update status text fields used in report generation.
flow.set("phaseDetail", "Normal PID control");
flow.set("phaseNextAction", "Hold process at setpoint");

return msg;
