pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

/*
 * KeepHost — withdrawal circuit.
 *
 * Addresses enter as two 16-byte halves so the encoding stays injective: in one
 * piece they reduce modulo p, letting a relayer redirect to a twin address.
 */

template CommitmentHasher() {
    signal input nullifier;
    signal input secret;
    signal output commitment;
    signal output nullifierHash;

    component c = Poseidon(2);
    c.inputs[0] <== nullifier;
    c.inputs[1] <== secret;
    commitment <== c.out;

    component n = Poseidon(1);
    n.inputs[0] <== nullifier;
    nullifierHash <== n.out;
}

template MerklePath(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    signal cur[levels + 1];
    signal left[levels];
    signal right[levels];

    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[levels];
}

template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipientHi;
    signal input recipientLo;
    signal input relayerHi;
    signal input relayerLo;
    signal input fee;
    signal input poolHi;
    signal input poolLo;

    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hasher = CommitmentHasher();
    hasher.nullifier <== nullifier;
    hasher.secret <== secret;
    hasher.nullifierHash === nullifierHash;

    component tree = MerklePath(levels);
    tree.leaf <== hasher.commitment;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // Squared only so the compiler keeps them in the constraint system;
    // otherwise they are optimized out and a relayer can rewrite them.
    signal recipientHiSq;
    signal recipientLoSq;
    signal relayerHiSq;
    signal relayerLoSq;
    signal feeSq;
    signal poolHiSq;
    signal poolLoSq;
    recipientHiSq <== recipientHi * recipientHi;
    recipientLoSq <== recipientLo * recipientLo;
    relayerHiSq <== relayerHi * relayerHi;
    relayerLoSq <== relayerLo * relayerLo;
    feeSq <== fee * fee;
    poolHiSq <== poolHi * poolHi;
    poolLoSq <== poolLo * poolLo;
}

component main {public [root, nullifierHash, recipientHi, recipientLo, relayerHi, relayerLo, fee, poolHi, poolLo]} = Withdraw(20);
