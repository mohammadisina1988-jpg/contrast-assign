import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { keccak256 } from "viem";
import { chooseAssignment, readPalette, verifyStudy } from "./reference.mjs";

const verify = process.argv.includes("--verify");
const resume = process.argv.includes("--resume");
const journal = verify ? "proofs/studionet.json" : "proofs/work/proof.json";
const endpoint = "https://studio.genlayer.com/api";
const client = createClient({ chain: studionet });
const contractCode = await readFile("contracts/contrast_assign.py");
const fixture = await readFile("fixtures/open-color.json", "utf8");
const upstreamRevision = "3a716ee1f5ff5456db33cb8a6e964afdca1e7bc3";
const source = `https://raw.githubusercontent.com/yeun/open-color/${upstreamRevision}/open-color.json`;
const digest = value => createHash("sha256").update(value).digest("hex");
const sourceHash = digest(contractCode);
const palette = readPalette(JSON.parse(fixture));
const baseline = "012345";
const repaired = chooseAssignment(palette, baseline);
assert(repaired?.moves > 0);
const repairedBaseline = repaired.slots.join("");
const txPlan = [
  { label: "deploy" },
  { label: "repair-baseline", method: "publish", baseline },
  { label: "confirm-zero-move-baseline", method: "publish", baseline: repairedBaseline },
];

async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const result = await response.json();
  assert(!result.error, result.error?.message);
  return result.result;
}

async function read(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 3 || !/429|50[0234]|internal|timeout|fetch failed|temporarily|abort/i.test(String(error))) throw error;
      await sleep(3000 * (attempt + 1));
    }
  }
}

function canonical(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

async function finalized(hash) {
  for (let attempt = 0; attempt < 95; attempt++) {
    let receipt;
    try {
      receipt = await rpc("eth_getTransactionByHash", [hash]);
    } catch (error) {
      if (attempt === 94) throw error;
    }
    const status = receipt?.status_name ?? receipt?.status;
    if (status === "FINALIZED") return receipt;
    assert.notEqual(status, "CANCELED");
    await sleep(5000);
  }
  throw new Error(`Finalization timed out for ${hash}`);
}

function checkReceipt(receipt, entry, address) {
  assert.equal(receipt.hash ?? receipt.tx_id, entry.hash);
  assert.equal((receipt.to_address ?? receipt.recipient).toLowerCase(), address.toLowerCase());
  assert.equal((receipt.from_address ?? receipt.sender).toLowerCase(), entry.sender.toLowerCase());
  assert.equal(receipt.result_name ?? receipt.result, "MAJORITY_AGREE");
  const leader = receipt.consensus_data.leader_receipt[0];
  const votes = Object.values(receipt.consensus_data.votes);
  const agree = votes.filter(vote => vote === "agree").length;
  assert(agree > votes.length / 2);
  assert(["SUCCESS", "FINISHED_WITH_RETURN"].includes(leader.execution_result));
  return { status: "FINALIZED", execution: leader.execution_result, agree, votes: votes.length };
}

assert.equal(await read(() => rpc("eth_chainId")), "0xf22f", "StudioNet only");
if (!verify) assert.equal(BigInt(await read(() => rpc("eth_gasPrice"))), 0n);
const prior = verify || resume ? JSON.parse(await readFile(journal, "utf8")) : null;
const revision = prior?.revision ?? process.env.CONTRAST_ASSIGN_REVISION;
assert.match(revision, /^[a-f0-9]{40}$/);
const upstream = { revision: upstreamRevision, fixture_sha256: digest(fixture) };
const ledger = prior ?? { network: "studionet", revision, source_sha256: sourceHash, upstream, transactions: [] };
assert.equal(ledger.source_sha256, sourceHash);
assert.deepEqual(ledger.upstream, upstream);
const save = () => writeFile(journal, JSON.stringify(ledger, null, 2) + "\n");
if (!prior) {
  await mkdir("proofs/work", { recursive: true });
  await writeFile(journal, JSON.stringify(ledger, null, 2) + "\n", { flag: "wx" });
}
if (verify) assert.deepEqual(ledger.transactions.map(entry => entry.label), txPlan.map(step => step.label));

for (const step of txPlan) {
  let entry = ledger.transactions.find(item => item.label === step.label);
  if (entry?.evm_hash && !entry.hash) {
    const receipt = await read(() => rpc("eth_getTransactionReceipt", [entry.evm_hash]));
    assert.equal(receipt?.status, "0x1", `Inspect the previously signed transaction ${entry.evm_hash}`);
    entry.hash = entry.evm_hash;
  }
  if (!entry?.hash) {
    assert(!verify, "Proof is missing a transaction");
    const account = createAccount();
    await rpc("sim_fundAccount", [account.address, 1e18]);
    const balance = BigInt(await read(() => rpc("eth_getBalance", [account.address, "latest"])));
    assert(balance >= 1_000_000_000_000_000_000n);
    if (!entry) {
      entry = { label: step.label };
      ledger.transactions.push(entry);
    }
    entry.sender = account.address;
    const signer = {
      ...account,
      async signTransaction(transaction) {
        assert.equal(transaction.chainId, studionet.id);
        assert(BigInt(transaction.value ?? 0) <= 250_000_000_000_000_000n);
        const signed = await account.signTransaction(transaction);
        entry.evm_hash = keccak256(signed);
        await save();
        return signed;
      },
    };
    const sender = createClient({ chain: studionet, account: signer });
    const budget = step.method ? { executionBudgetPerRound: 125_000_000_000_000_000n } : {};
    const quote = await read(() => sender.estimateTransactionFees({
      leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n, rotations: [0], ...budget,
    }));
    assert(quote.feeValue <= 250_000_000_000_000_000n);
    entry.test_fee_deposit_wei = quote.feeValue.toString();
    await save();
    const options = { fees: { distribution: quote.distribution, feeValue: quote.feeValue }, consensusMaxRotations: 0 };
    const submit = () => step.method
      ? sender.writeContract({
        ...options, address: ledger.contract, functionName: step.method, args: [upstreamRevision, step.baseline],
        value: 0n,
      })
      : sender.deployContract({ ...options, code: contractCode, args: [] });
    entry.hash = await read(async () => {
      assert(!entry.evm_hash, `Inspect the previously signed transaction ${entry.evm_hash}`);
      return submit();
    });
    assert.match(entry.hash, /^0x[\da-f]{64}$/i);
    await save();
    console.log("Submitted", step.label, entry.hash);
  }
  const receipt = await finalized(entry.hash);
  if (!step.method) {
    const deployed = receipt.to_address ?? receipt.recipient;
    if (ledger.contract) assert.equal(ledger.contract, deployed);
    ledger.contract = deployed;
    assert.deepEqual(Buffer.from(receipt.data.contract_code, "base64"), contractCode);
    assert.equal(await read(() => client.getContractCode(deployed)), contractCode.toString("utf8"));
  }
  const checked = checkReceipt(receipt, entry, ledger.contract);
  if (step.method) {
    checked.baseline = step.baseline;
    checked.return_data = receipt.consensus_data.leader_receipt[0].result;
    assert.equal(typeof checked.return_data, "string");
  }
  if (verify) {
    for (const [key, value] of Object.entries(checked)) assert.equal(entry[key], value);
  } else {
    Object.assign(entry, checked);
    await save();
  }
  console.log("Finalized", step.label, checked.execution, `${checked.agree}/${checked.votes}`);
}

const view = (functionName, args) => read(() => client.readContract({ address: ledger.contract, functionName, args })).then(canonical);
assert.notEqual(ledger.transactions[1].return_data, ledger.transactions[2].return_data);
const readback = [];
for (const input of [baseline, repairedBaseline]) {
  const study = await view("get_study", [upstreamRevision, input]);
  verifyStudy(study, { revision: upstreamRevision, source, baseline: input, palette });
  readback.push(study);
}
assert.equal(readback[1].moves, 0);
assert.equal(await view("get_study", ["0".repeat(40), baseline]), null);
if (verify) {
  assert.deepEqual(canonical(ledger.readback), canonical(readback));
} else {
  ledger.readback = readback;
  await save();
}
console.log("Verified", ledger.contract, `${baseline} → ${repairedBaseline} (${repaired.moves} changes)`);
