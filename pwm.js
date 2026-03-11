// ============================================================
// PWM + REPORT
// ============================================================
// This function converts controller output into a PWM state,
// creates status information, updates node status, and returns
// the final outputs.
//
// Main responsibilities:
// 1. Read current controller output from flow context
// 2. Convert output percentage into PWM ON/OFF state
// 3. Build a structured status object
// 4. Build a human-readable auto-tune report string
// 5. Update Node-RED node status
// 6. Return 5 outputs
//
// Output 1 = pid_output
// Output 2 = pwm_duty
// Output 3 = pwm_state
// Output 4 = pid_status
// Output 5 = autotune_report
// ============================================================

// -------------------- LOAD SHARED VALUES --------------------
let pv = Number(flow.get("pv") || 0);
let sp = Number(flow.get("sp") || 60);
let filteredPv = Number(flow.get("filteredPv") || pv);
let now = Number(flow.get("now") || (Date.now() / 1000));

let autoTune = Boolean(flow.get("autoTune") || false);
let tuneState = flow.get("tuneState") || "IDLE";

// Read controller output and term values.
let output = Number(flow.get("controlOutput") || 0);

let P = Number(flow.get("P_term") || 0);
let I = Number(flow.get("I_term") || 0);
let D = Number(flow.get("D_term") || 0);

// Read PWM settings.
let pwmPeriod = Number(flow.get("pwmPeriod") || 60);
let pwmPeriodTune = Number(flow.get("pwmPeriodTune") || 60);
let minOnTime = Number(flow.get("minOnTime") || 1);

// Read auto-tune settings and state for reporting.
let tuneKpManual = Number(flow.get("tuneKpManual") || 10);
let tuneMaxOutput = Number(flow.get("tuneMaxOutput") || 25);
let znCrossBand = Number(flow.get("znCrossBand") || 0.15);
let znRequiredHalfCycles = Number(flow.get("znRequiredHalfCycles") || 4);
let znMaxPeriodVariation = Number(flow.get("znMaxPeriodVariation") || 0.25);
let znMaxTuneTime = Number(flow.get("znMaxTuneTime") || 7200);

let znKpTest = flow.get("znKpTest");
let znKu = flow.get("znKu");
let znPu = flow.get("znPu");
let znCrossings = flow.get("znCrossings") || [];
let znPeriods = flow.get("znPeriods") || [];
let znLastSide = flow.get("znLastSide");

let avgHalfPeriod = flow.get("avgHalfPeriod");
let periodVariation = flow.get("periodVariation");

let failReason = flow.get("failReason") || "";
let phaseDetail = flow.get("phaseDetail") || "";
let phaseNextAction = flow.get("phaseNextAction") || "";

// -------------------- CALCULATE PWM STATE --------------------
// Use a separate PWM period during auto-tune if desired.
let activePwmPeriod = autoTune ? pwmPeriodTune : pwmPeriod;

// pwmStart marks the beginning of the repeating PWM cycle.
let pwmStart = flow.get("pwmStart");
if (pwmStart === undefined || pwmStart === null || pwmStart > now) {
    pwmStart = now;
    flow.set("pwmStart", pwmStart);
}

// Convert output percentage into ON time within one PWM cycle.
let onTime = (output / 100) * activePwmPeriod;

// Enforce a minimum ON time for very small but non-zero outputs.
if (output > 0 && onTime < minOnTime) onTime = minOnTime;

// Zero output means fully OFF.
if (output === 0) onTime = 0;

// Prevent ON time from exceeding the full period.
if (onTime > activePwmPeriod) onTime = activePwmPeriod;

// Determine current position inside PWM cycle.
let cyclePos = (now - pwmStart) % activePwmPeriod;

// If current cycle position is inside ON window, PWM is ON.
let pwmState = (cyclePos < onTime) ? "ON" : "OFF";

// -------------------- BUILD STRUCTURED STATUS OBJECT --------------------
// This object is useful for dashboards, debug nodes, MQTT, or logging.
let statusMsg = {
    timestamp: new Date().toISOString(),
    pv: Number(pv.toFixed(3)),
    pv_f: Number(filteredPv.toFixed(3)),
    sp: Number(sp.toFixed(3)),
    error: Number((sp - filteredPv).toFixed(3)),
    output: Number(output.toFixed(3)),
    pwm: pwmState,
    P: Number(P.toFixed(3)),
    I: Number(I.toFixed(3)),
    D: Number(D.toFixed(3)),
    tune_state: tuneState,
    autoTune: autoTune,
    znKpTest: znKpTest !== null && znKpTest !== undefined ? Number(Number(znKpTest).toFixed(3)) : null,
    znKu: znKu !== null && znKu !== undefined ? Number(Number(znKu).toFixed(3)) : null,
    znPu: znPu !== null && znPu !== undefined ? Number(Number(znPu).toFixed(3)) : null,
    znCrossings: znCrossings.length,
    znPeriods: znPeriods.length,
    avgHalfPeriod: avgHalfPeriod !== null && avgHalfPeriod !== undefined ? Number(Number(avgHalfPeriod).toFixed(2)) : null,
    periodVariationPct: periodVariation !== null && periodVariation !== undefined ? Number((Number(periodVariation) * 100).toFixed(1)) : null,
    failReason: failReason || null,
    phaseDetail: phaseDetail,
    phaseNextAction: phaseNextAction,
    lastSide: znLastSide || null
};

// -------------------- BUILD HUMAN-READABLE REPORT --------------------
// This is a plain text summary of the current controller and auto-tune state.
let report =
`AUTOTUNE STATUS
==============================
State: ${tuneState}
Detail: ${phaseDetail}
Next: ${phaseNextAction}

PV: ${filteredPv.toFixed(3)} °C
SP: ${sp.toFixed(3)} °C
Error: ${(sp - filteredPv).toFixed(3)} °C

AutoTune: ${autoTune ? "ON" : "OFF"}
Output: ${output.toFixed(3)} %
PWM: ${pwmState}
PWM period: ${activePwmPeriod} s

Fixed Kp: ${znKpTest !== null && znKpTest !== undefined ? Number(znKpTest).toFixed(3) : "-"}
Configured manual Kp: ${tuneKpManual.toFixed(3)}
Crossings: ${znCrossings.length}
Half cycles: ${znPeriods.length}/${znRequiredHalfCycles}

Last side: ${znLastSide || "-"}
Cross band: ${znCrossBand} °C

Avg half period: ${avgHalfPeriod !== null && avgHalfPeriod !== undefined ? Number(avgHalfPeriod).toFixed(1) + " s" : "-"}
Variation: ${periodVariation !== null && periodVariation !== undefined ? (Number(periodVariation) * 100).toFixed(1) + " %" : "-"}

Tune max output: ${tuneMaxOutput} %
Max period variation: ${(znMaxPeriodVariation * 100).toFixed(1)} %
Max tune time: ${znMaxTuneTime} s

${failReason ? "FAIL REASON: " + failReason : ""}
`;

// -------------------- SAVE FINAL OUTPUT STATE --------------------
flow.set("pwm_state", pwmState);
flow.set("autotune_report", report);

// -------------------- UPDATE NODE STATUS --------------------
// This gives a compact visual indicator directly in Node-RED.
let statusColor = "green";
let statusText = `${filteredPv.toFixed(2)}°C ${output.toFixed(0)}%`;

if (autoTune) {
    statusColor = "blue";
    statusText =
        `🔧 ${tuneState} | Kp:${znKpTest !== null ? Number(znKpTest).toFixed(2) : "-"} ` +
        `| X:${znCrossings.length} HP:${znPeriods.length}`;
} else if (tuneState === "FAILED") {
    statusColor = "red";
    statusText = "❌ FAILED";
} else if (Math.abs(sp - filteredPv) > 5) {
    statusColor = "red";
    statusText = `🔥 ${filteredPv.toFixed(2)}°C ${output.toFixed(0)}%`;
} else if (Math.abs(sp - filteredPv) < 0.5) {
    statusColor = "green";
    statusText = `✅ ${filteredPv.toFixed(2)}°C ${output.toFixed(0)}%`;
} else {
    statusColor = "yellow";
    statusText = `🌡️ ${filteredPv.toFixed(2)}°C ${output.toFixed(0)}%`;
}

node.status({
    fill: statusColor,
    shape: "dot",
    text: statusText
});

// -------------------- RETURN 5 OUTPUTS --------------------
// Output 1: raw controller output percentage
// Output 2: PWM duty percentage
// Output 3: current PWM state (ON/OFF)
// Output 4: structured status object
// Output 5: text report
return [
    { payload: output, topic: "pid_output" },
    { payload: output, topic: "pwm_duty" },
    { payload: pwmState, topic: "pwm_state" },
    { payload: statusMsg, topic: "pid_status" },
    { payload: report, topic: "autotune_report" }
];
