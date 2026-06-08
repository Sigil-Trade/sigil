// TEMPORARY x64-Linux native-module bisection probe (remove after root-cause).
// Requires each native module in turn and checks whether bn.js's toString()
// gets corrupted ("<digits>NaN"), pinpointing which native require poisons it.
const BN = require("bn.js");

function check(label) {
  const v = JSON.stringify(new BN(500000000).toString());
  console.log("PROBE", label, v, v === '"500000000"' ? "OK" : "CORRUPT");
}

console.log("PROBE arch", process.arch, process.platform, process.version);
check("baseline");

const mods = ["bufferutil", "bigint-buffer", "cbor-extract", "litesvm"];
for (const m of mods) {
  try {
    const x = require(m);
    if (m === "litesvm" && x.LiteSVM) {
      const svm = new x.LiteSVM();
      console.log("PROBE litesvm_instantiated ok");
      check("after_litesvm_new");
    }
    check("after_require_" + m);
  } catch (e) {
    console.log("PROBE require_FAILED", m, String(e.message).slice(0, 120));
    check("after_failed_" + m);
  }
}
