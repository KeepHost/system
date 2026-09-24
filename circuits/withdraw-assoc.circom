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
    // The root of the association set this withdrawal claims membership of.
    // Published, so whoever cares can see WHICH set was used and decide what
    // that set is worth to them.
    signal input assocRoot;

    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    // The path of the same commitment inside the association set. The set is
    // a second tree over a subset of the deposits, built by anyone and
    // published; proving membership of it proves nothing about which deposit.
    signal input assocPathElements[levels];
    signal input assocPathIndices[levels];

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

    // Second inclusion: the same commitment, inside the chosen set. A user who
    // cannot be in a set simply cannot produce this proof — and nobody learns
    // which leaf they are, in either tree.
    component assoc = MerklePath(levels);
    assoc.leaf <== hasher.commitment;
    for (var i = 0; i < levels; i++) {
        assoc.pathElements[i] <== assocPathElements[i];
        assoc.pathIndices[i] <== assocPathIndices[i];
    }
    assoc.root === assocRoot;

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

component main {public [root, nullifierHash, recipientHi, recipientLo, relayerHi, relayerLo, fee, poolHi, poolLo, assocRoot]} = Withdraw(20);
