"use strict";
// TEMPORARY x64-Linux diagnostic (remove after root-cause).
// Mocha root-hook plugin: after every test it checks whether bn.js's decimal
// toString has been corrupted (the "<digits>NaN" failure seen only in the full
// LiteSVM suite on x64-Linux). Logs the FIRST test that corrupts it and
// classifies the corruption (which numeric base/path is broken, and whether
// BN.prototype.toString was monkey-patched vs an internal-array corruption).
// Read-only: never mutates BN or any test state.

let BN, anchorBN, resolvePath, loadErr;
try {
  BN = require("bn.js");
  resolvePath = require.resolve("bn.js");
} catch (e) {
  loadErr = "bn.js:" + e.message;
}
try {
  anchorBN = require("@coral-xyz/anchor").BN;
} catch (e) {
  /* anchor not resolvable from here is fine */
}

function snapshot() {
  const r = {};
  const tries = {
    b10_500m: () => new BN(500000000).toString(), // expect "500000000"
    b10_50m: () => new BN(50000000).toString(), // expect "50000000"
    b16_500m: () => new BN(500000000).toString(16), // expect "1dcd6500" (hex path)
    small: () => new BN(5).toString(), // expect "5"
    num: () => String(new BN(500000000).toNumber()), // expect "500000000" (number path)
    anchor_b10: () => (anchorBN ? new anchorBN(500000000).toString() : "n/a"),
  };
  for (const k of Object.keys(tries)) {
    try {
      r[k] = tries[k]();
    } catch (e) {
      r[k] = "THROW:" + (e && e.message ? e.message.slice(0, 60) : e);
    }
  }
  return r;
}

function isOk(s) {
  return s.b10_500m === "500000000" && s.b10_50m === "50000000";
}

function toStringSrc() {
  try {
    return BN.prototype.toString.toString().replace(/\s+/g, " ").slice(0, 120);
  } catch (e) {
    return "ERR:" + e.message;
  }
}

let flagged = false;

function checkOnce(label) {
  if (flagged) return;
  const s = snapshot();
  if (!isOk(s)) {
    flagged = true;
    let testName, fileName;
    try {
      testName = this && this.currentTest && this.currentTest.fullTitle();
      fileName = this && this.currentTest && this.currentTest.file;
    } catch (e) {
      /* ignore */
    }
    console.log(
      "\n[CANARY] >>>>>>>> FIRST bn.js CORRUPTION (" + label + ") <<<<<<<<",
    );
    console.log("[CANARY] snapshot=", JSON.stringify(s));
    console.log("[CANARY] after_test=", testName || "(unknown)");
    console.log("[CANARY] file=", fileName || "(unknown)");
    console.log("[CANARY] toString_src=", toStringSrc());
    console.log(
      "[CANARY] toString_isNativeCode=",
      /\[native code\]/.test(BN.prototype.toString.toString()),
    );
    console.log("[CANARY] bn_resolved=", resolvePath);
  }
}

exports.mochaHooks = {
  beforeAll() {
    const s = snapshot();
    console.log(
      "[CANARY] init resolve=",
      resolvePath,
      "loadErr=",
      loadErr || "none",
    );
    console.log("[CANARY] baseline=", JSON.stringify(s), "ok=", isOk(s));
    console.log("[CANARY] toString_src=", toStringSrc());
  },
  beforeEach() {
    checkOnce.call(this, "beforeEach");
  },
  afterEach() {
    checkOnce.call(this, "afterEach");
  },
  afterAll() {
    if (!flagged) {
      console.log("[CANARY] NO corruption detected across the entire suite.");
    }
  },
};
