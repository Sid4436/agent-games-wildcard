pragma circom 2.0.0;

/*
 * DemoPolicyProof — DEMO ONLY, not the official Agent Games circuit.
 *
 * A locally compiled policy circuit with the SAME public interface as the
 * official vfy-policy circuit (commitment, matchId, turnNumber, selfBalance,
 * opponentBalance, action, amount, circuitVersion public; strategyParams[8]
 * and salt private; one public output `binding`). It proves the agent's
 * Steal-the-VFY move follows the committed threshold strategy, using a
 * DOCUMENTED strategy and a DOCUMENTED commitment construction:
 *
 *   commitment = Poseidon(strategyParams[0..7], salt)
 *   binding    = Poseidon(commitment, matchId, turnNumber, action, amount)
 *
 * The official vfy-policy circuit's strategy semantics are unpublished, so
 * its proof cannot be produced from public material (see
 * circuits/CIRCUITS.md). This demo circuit exists so the policy-proof flow
 * (decide -> prove -> verify -> submit) can be demonstrated end-to-end.
 * NEVER present a demo-circuit proof as an official-circuit proof: the
 * verification keys differ, and the platform verifies against its own
 * registered key.
 *
 * Strategy (same as strategy/strategy.md):
 *   params[0] extractThreshold   - extract when opponentBalance > this
 *   params[1] fortifyThreshold   - fortify when selfBalance < this
 *   params[2] extractAmount      - how much to extract (1..10)
 *   params[3] endgameTurn        - from this turn on, extract whenever possible
 *   params[4] minOpponentBalance - never drive the opponent below this
 *   params[5] fortifyCost        - protocol cost of FORTIFY (2, informational)
 *   params[6] reserved (0)
 *   params[7] reserved (0)
 *
 *   canExtract = (opponentBalance > p0 || turnNumber >= p3)
 *                && selfBalance >= p1
 *                && opponentBalance - p2 >= p4
 *   canFortify = selfBalance < p1 && opponentBalance > p4
 *   expectedAction = canExtract ? 2 : (canFortify ? 1 : 0)   // 2 EXTRACT, 1 FORTIFY, 0 HOLD
 *   expectedAmount = canExtract ? p2 : 0
 *
 * All compared values are game state bounded by the protocol (balances
 * 0..200, turns 1..20, params small), so 64-bit comparators are used.
 */

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

template DemoPolicyProof() {
    // Public inputs (same order/names as the official vfy-policy circuit).
    signal input commitment;
    signal input matchId;
    signal input turnNumber;
    signal input selfBalance;
    signal input opponentBalance;
    signal input action;
    signal input amount;
    signal input circuitVersion;

    // Private inputs.
    signal input strategyParams[8];
    signal input salt;

    // Public output: binding commitment for this turn.
    signal output binding;

    // --- circuit version must be 1 ("v1") ---
    circuitVersion === 1;

    // --- ranges: action in 0..2, amount in 0..10 ---
    component actionRange = LessThan(64);
    actionRange.in[0] <== action;
    actionRange.in[1] <== 3;
    actionRange.out === 1;

    component amountRange = LessThan(64);
    amountRange.in[0] <== amount;
    amountRange.in[1] <== 11;
    amountRange.out === 1;

    // --- commitment binding: commitment = Poseidon(strategyParams, salt) ---
    component poseidonCommit = Poseidon(9);
    for (var i = 0; i < 8; i++) {
        poseidonCommit.inputs[i] <== strategyParams[i];
    }
    poseidonCommit.inputs[8] <== salt;
    commitment === poseidonCommit.out;

    // --- strategy computation (all comparator outputs are 0/1) ---
    component oppRich = GreaterThan(64);
    oppRich.in[0] <== opponentBalance;
    oppRich.in[1] <== strategyParams[0];

    component endgame = GreaterEqThan(64);
    endgame.in[0] <== turnNumber;
    endgame.in[1] <== strategyParams[3];

    component healthy = GreaterEqThan(64);
    healthy.in[0] <== selfBalance;
    healthy.in[1] <== strategyParams[1];

    component leavesFloor = GreaterEqThan(64);
    leavesFloor.in[0] <== opponentBalance;
    leavesFloor.in[1] <== strategyParams[2] + strategyParams[4];

    component oppGtFloor = GreaterThan(64);
    oppGtFloor.in[0] <== opponentBalance;
    oppGtFloor.in[1] <== strategyParams[4];

    // canExtract = (oppRich || endgame) && healthy && leavesFloor
    // (split into two quadratic steps: circom forbids cubic terms)
    signal oppRichOrEndgame <== oppRich.out + endgame.out - oppRich.out * endgame.out;
    signal tmpExtract <== oppRichOrEndgame * healthy.out;
    signal canExtract <== tmpExtract * leavesFloor.out;

    // canFortify = !healthy && oppGtFloor
    signal notHealthy <== 1 - healthy.out;
    signal canFortify <== notHealthy * oppGtFloor.out;

    // expectedAction = 2*canExtract + 1*canFortify (mutually exclusive:
    // canExtract needs healthy=1, canFortify needs healthy=0)
    signal expectedAction <== 2 * canExtract + canFortify;
    action === expectedAction;

    // expectedAmount = canExtract ? extractAmount : 0
    signal expectedAmount <== canExtract * strategyParams[2];
    amount === expectedAmount;

    // --- output binding ---
    component poseidonBinding = Poseidon(5);
    poseidonBinding.inputs[0] <== commitment;
    poseidonBinding.inputs[1] <== matchId;
    poseidonBinding.inputs[2] <== turnNumber;
    poseidonBinding.inputs[3] <== action;
    poseidonBinding.inputs[4] <== amount;
    binding <== poseidonBinding.out;
}

component main {public [commitment, matchId, turnNumber, selfBalance, opponentBalance, action, amount, circuitVersion]} = DemoPolicyProof();
