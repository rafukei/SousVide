// ============================================================
// PURE ZN AUTO-TUNE WITH FIXED MANUAL KP
// ============================================================
// This function performs a P-only oscillation test using a
// manually selected proportional gain.
//
// Main idea:
// - Use only the proportional term
// - Keep Kp fixed during the entire test
// - Detect crossings around the setpoint
// - Measure half-cycles
// - Check whether oscillation is stable enough
// - If stable, calculate Ku and Pu
// - Then calculate PID values using classic Ziegler-Nichols
//
// This node should run after INIT and before PID.
// ============================================================

// -------------------- CHECK WHETHER AUTO-TUNE IS ACTIVE --------------------
let autoTune = Boolean(flow.get("autoTune") || false);
if (!autoTune) {
    return msg;
}

// -------------------- LOAD SHARED VALUES --------------------
let pv = Number(flow.get("pv") || 0);
let sp = Number(flow.get("sp") || 60);
let filteredPv = Number(flow.get("filteredPv") || pv);
let now = Number(flow.get("now") || (Date.now() / 1000));

// Current auto-tune state machine state
let tuneState = flow.get("tuneState") || "IDLE";
let tuneOutput = Number(flow.get("tuneOutput") || 0);

// Fixed auto-tune settings
let tuneKpManual = Number(flow.get("tuneKpManual") || 10);
let tuneMaxOutput = Number(flow.get("tuneMaxOutput") || 25);
let znCrossBand = Number(flow.get("znCrossBand") || 0.15);
let znRequiredHalfCycles = Number(flow.get("znRequiredHalfCycles") || 4);
let znMaxPeriodVariation = Number(flow.get("znMaxPeriodVariation") || 0.25);
let znMaxTuneTime = Number(flow.get("znMaxTuneTime") || 7200);

// Auto-tune memory from previous loop cycles
let znKpTest = flow.get("znKpTest");
let znStartTime = flow.get("znStartTime");
let znCrossings = flow.get("znCrossings") || [];
let znPeriods = flow.get("znPeriods") || [];
let znLastSide = flow.get("znLastSide");
let znPrevError = flow.get("znPrevError");
let znKu = flow.get("znKu");
let znPu = flow.get("znPu");

// Reporting fields
let failReason = flow.get("failReason") || "";
let phaseDetail = "";
let phaseNextAction = "";
let avgHalfPeriod = null;
let periodVariation = null;

// Controller terms used during auto-tune
let P = 0;
let I = 0;
let D = 0;
let output = 0;

// -------------------- AUTO-TUNE STATE MACHINE --------------------
switch (tuneState) {

    case "IDLE":
        // Initialize a fresh fixed-Kp oscillation test.
        node.warn("Starting pure ZN auto-tune with fixed manual Kp");

        tuneState = "ZN_SEARCH";
        tuneOutput = 0;

        znKpTest = tuneKpManual;
        znStartTime = now;
        znCrossings = [];
        znPeriods = [];
        znLastSide = null;
        znPrevError = sp - filteredPv;
        znKu = null;
        znPu = null;
        failReason = "";

        // Reset PID integral so normal PID history does not
        // interfere after auto-tune has completed.
        flow.set("pid_integral", 0);

        phaseDetail =
            `Auto-tune started. Fixed Kp=${znKpTest.toFixed(3)}, max output=${tuneMaxOutput}%`;
        phaseNextAction =
            "Waiting for PV to cross the setpoint band";
        break;

    case "ZN_SEARCH": {
        // Calculate current control error.
        let error = sp - filteredPv;

        // During tuning, use P-only control.
        P = znKpTest * error;
        I = 0;
        D = 0;

        // Limit output to a safe maximum during the test.
        output = Math.max(0, Math.min(tuneMaxOutput, P));
        tuneOutput = output;

        // Determine which side of the setpoint band the process is on.
        // BELOW_SP means temperature is clearly below setpoint.
        // ABOVE_SP means temperature is clearly above setpoint.
        // CENTER means inside dead-band, so no crossing is recorded.
        let side = null;
        if (error > znCrossBand) side = "BELOW_SP";
        else if (error < -znCrossBand) side = "ABOVE_SP";

        node.warn(
            `ZN DBG | state=${tuneState} | PV=${filteredPv.toFixed(3)}°C | SP=${sp.toFixed(3)}°C | ` +
            `err=${error.toFixed(3)}°C | side=${side || "CENTER"} | lastSide=${znLastSide || "-"} | ` +
            `X=${znCrossings.length} | HP=${znPeriods.length} | Kp=${Number(znKpTest).toFixed(3)} | ` +
            `out=${output.toFixed(3)}%`
        );

        // Record crossings only when the process clearly changes side.
        if (side !== null) {
            if (znLastSide === null) {
                // First time the process is clearly on one side.
                znLastSide = side;
                node.warn(
                    `First side recorded | side=${side} | PV=${filteredPv.toFixed(3)}°C | SP=${sp.toFixed(3)}°C`
                );
            } else if (side !== znLastSide) {
                // Real crossing detected: process moved from one side to the other.
                let fromSide = znLastSide;

                znCrossings.push({
                    time: now,
                    side: side,
                    kp: znKpTest,
                    temp: filteredPv
                });

                node.warn(
                    `Crossing detected | #${znCrossings.length} | from=${fromSide} -> to=${side} | ` +
                    `PV=${filteredPv.toFixed(3)}°C | SP=${sp.toFixed(3)}°C | ` +
                    `error=${error.toFixed(3)}°C | Kp=${Number(znKpTest).toFixed(3)}`
                );

                // Once at least two crossings exist, measure half-cycle time.
                if (znCrossings.length >= 2) {
                    let last = znCrossings[znCrossings.length - 1];
                    let prev = znCrossings[znCrossings.length - 2];
                    let halfPeriod = last.time - prev.time;

                    // Ignore unrealistically short half-cycles.
                    if (halfPeriod > 2) {
                        znPeriods.push(halfPeriod);

                        // Keep history bounded.
                        if (znPeriods.length > 50) znPeriods.shift();

                        let lastHalf = znPeriods[znPeriods.length - 1];
                        node.warn(
                            `Half-cycle stored | #${znPeriods.length} | duration=${lastHalf.toFixed(1)} s | ` +
                            `required=${znRequiredHalfCycles}`
                        );
                    }
                }

                znLastSide = side;
            }
        }

        // Create human-readable status text.
        let sideText = "CENTER";
        if (side === "BELOW_SP") sideText = "BELOW_SP";
        else if (side === "ABOVE_SP") sideText = "ABOVE_SP";

        let lastSideText = znLastSide || "-";

        if (znCrossings.length === 0) {
            phaseDetail =
                `Phase 1/4: waiting for first crossing. PV=${filteredPv.toFixed(3)}°C, SP=${sp.toFixed(3)}°C, ` +
                `error=${error.toFixed(3)}°C, side=${sideText}, lastSide=${lastSideText}, ` +
                `Kp=${Number(znKpTest).toFixed(3)}, output=${output.toFixed(3)}%`;

            phaseNextAction = "Wait for the process to cross the setpoint band";
        }
        else if (znPeriods.length === 0) {
            phaseDetail =
                `Phase 2/4: first crossing detected. Crossings=${znCrossings.length}, but no half-cycle yet. ` +
                `PV=${filteredPv.toFixed(3)}°C, side=${sideText}, lastSide=${lastSideText}, Kp=${Number(znKpTest).toFixed(3)}`;

            phaseNextAction = "Wait for the next crossing to measure the first half-cycle";
        }
        else if (znPeriods.length < znRequiredHalfCycles) {
            let lastHalf = znPeriods[znPeriods.length - 1];

            phaseDetail =
                `Phase 3/4: collecting half-cycles. Crossings=${znCrossings.length}, ` +
                `HalfCycles=${znPeriods.length}/${znRequiredHalfCycles}, latest half-cycle=${lastHalf.toFixed(1)} s, ` +
                `PV=${filteredPv.toFixed(3)}°C, side=${sideText}, Kp=${Number(znKpTest).toFixed(3)}, ` +
                `output=${output.toFixed(3)}%`;

            phaseNextAction =
                `Need ${znRequiredHalfCycles - znPeriods.length} more half-cycles before stability check`;
        }
        else {
            // Once enough half-cycles exist, check whether oscillation is stable.
            let recent = znPeriods.slice(-znRequiredHalfCycles);
            let avgHalf = recent.reduce((a, b) => a + b, 0) / recent.length;
            let minHalf = Math.min(...recent);
            let maxHalf = Math.max(...recent);
            let variation = avgHalf > 0 ? ((maxHalf - minHalf) / avgHalf) : 999;

            avgHalfPeriod = avgHalf;
            periodVariation = variation;

            phaseDetail =
                `Phase 4/4: checking oscillation stability. Crossings=${znCrossings.length}, ` +
                `HalfCycles=${znPeriods.length}, avgHalf=${avgHalf.toFixed(1)} s, ` +
                `variation=${(variation * 100).toFixed(1)}%, limit=${(znMaxPeriodVariation * 100).toFixed(1)}%, ` +
                `Kp=${Number(znKpTest).toFixed(3)}`;

            if (variation <= znMaxPeriodVariation) {
                // Stable oscillation found.
                // With fixed-Kp tuning, the selected Kp is treated as Ku.
                znKu = znKpTest;
                znPu = avgHalf * 2;

                node.warn(
                    `Sustained oscillation found | Ku=${znKu.toFixed(3)} | Pu=${znPu.toFixed(1)} s | ` +
                    `variation=${(variation * 100).toFixed(1)}%`
                );

                tuneState = "CALCULATE";
                tuneOutput = 0;
                output = 0;

                phaseDetail =
                    `Oscillation found. Ku=${znKu.toFixed(3)}, Pu=${znPu.toFixed(1)} s`;
                phaseNextAction = "Calculating PID parameters";
                break;
            } else {
                phaseNextAction =
                    "Oscillation is not stable enough yet. Continue measuring with the same fixed Kp";
            }
        }

        // Stop auto-tune if it runs too long without success.
        if ((now - znStartTime) > znMaxTuneTime) {
            failReason = `Timeout ${znMaxTuneTime} s without stable oscillation`;
            node.warn(`Auto-tune failed | ${failReason}`);
            tuneState = "FAILED";
            tuneOutput = 0;
            output = 0;
        }

        znPrevError = error;
        break;
    }

    case "CALCULATE": {
        // Convert Ku and Pu into PID parameters using
        // classic Ziegler-Nichols closed-loop tuning rules.
        node.warn("Calculating PID parameters using Ziegler-Nichols");

        if (znKu !== null && znPu !== null && znKu > 0 && znPu > 1) {
            let newKp = 0.6 * znKu;
            let newKi = 1.2 * znKu / znPu;
            let newKd = 0.075 * znKu * znPu;

            // Clamp to reasonable limits to avoid invalid values.
            newKp = Math.max(0.01, Math.min(500, newKp));
            newKi = Math.max(0.00001, Math.min(10, newKi));
            newKd = Math.max(0, Math.min(5000, newKd));

            flow.set("Kp", newKp);
            flow.set("Ki", newKi);
            flow.set("Kd", newKd);

            node.warn(`Auto-tune results | Ku=${znKu.toFixed(3)} | Pu=${znPu.toFixed(1)} s`);
            node.warn(`New PID | Kp=${newKp.toFixed(3)} | Ki=${newKi.toFixed(5)} | Kd=${newKd.toFixed(3)}`);

            tuneState = "COMPLETE";
            phaseDetail = "PID parameters calculated successfully";
            phaseNextAction = "Auto-tune will stop";
        } else {
            failReason = "Ku/Pu missing or invalid";
            node.warn(failReason);
            tuneState = "FAILED";
            phaseDetail = "PID calculation failed";
            phaseNextAction = failReason;
        }

        tuneOutput = 0;
        output = 0;
        break;
    }

    case "COMPLETE":
        // Auto-tune has finished successfully.
        autoTune = false;
        tuneOutput = 0;
        output = 0;
        phaseDetail = "Auto-tune complete";
        phaseNextAction = "Normal PID mode";
        break;

    case "FAILED":
        // Auto-tune ended unsuccessfully.
        autoTune = false;
        tuneOutput = 0;
        output = 0;
        phaseDetail = "Auto-tune failed";
        phaseNextAction = failReason || "Check settings";
        break;

    default:
        // Unknown state: recover safely by returning to IDLE.
        node.warn(`Unknown tune state: ${tuneState}`);
        tuneState = "IDLE";
        tuneOutput = 0;
        output = 0;
        phaseDetail = "Unknown state";
        phaseNextAction = "Returning to IDLE";
        break;
}

// -------------------- SAVE UPDATED AUTO-TUNE STATE --------------------
flow.set("autoTune", autoTune);
flow.set("tuneState", tuneState);
flow.set("tuneOutput", tuneOutput);

flow.set("znKpTest", znKpTest);
flow.set("znStartTime", znStartTime);
flow.set("znCrossings", znCrossings);
flow.set("znPeriods", znPeriods);
flow.set("znLastSide", znLastSide);
flow.set("znPrevError", znPrevError);
flow.set("znKu", znKu);
flow.set("znPu", znPu);

flow.set("failReason", failReason);
flow.set("phaseDetail", phaseDetail);
flow.set("phaseNextAction", phaseNextAction);
flow.set("avgHalfPeriod", avgHalfPeriod);
flow.set("periodVariation", periodVariation);

// Store the active controller terms for reporting.
flow.set("P_term", P);
flow.set("I_term", I);
flow.set("D_term", D);
flow.set("controlOutput", tuneOutput);

return msg;
