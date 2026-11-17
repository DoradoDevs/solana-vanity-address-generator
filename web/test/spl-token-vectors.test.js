// The server builds its transaction without @solana/spl-token. These are the
// checks that it still builds what spl-token built: known answers recorded
// from spl-token (helpers/spl-token-vectors.js) for the program IDs, the
// account derivation, each instruction and whole transactions, byte for byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../netlify/functions/lib/constants.js";
import {
  associatedTokenAddress,
  buildUnsignedTransaction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "../netlify/functions/lib/tx.js";
import {
  AuthorityType,
  createApproveInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
} from "./helpers/token-program.js";
import { ASSOCIATED_ACCOUNTS, INSTRUCTIONS, SPL_TOKEN, TRANSACTIONS } from "./helpers/spl-token-vectors.js";

const key = (address) => new PublicKey(address);
const onCurve = (address) => PublicKey.isOnCurve(key(address).toBytes());

test("the program IDs, the token account size and the authority kind are spl-token's", () => {
  assert.deepEqual(
    {
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      ACCOUNT_SIZE,
      AuthorityType: { AccountOwner: AuthorityType.AccountOwner },
    },
    SPL_TOKEN
  );
  assert.equal(SystemProgram.programId.toBase58(), SYSTEM_PROGRAM_ID);
});

test("associated token accounts are spl-token's, for owners on and off the curve", () => {
  // The recorded owners include program addresses, which only the allow-off-curve derivation accepts.
  assert.ok(ASSOCIATED_ACCOUNTS.filter(({ owner }) => !onCurve(owner)).length >= 2);
  const derived = ASSOCIATED_ACCOUNTS.map(({ mint, owner }) => associatedTokenAddress(key(mint), key(owner)).toBase58());
  assert.deepEqual(derived, ASSOCIATED_ACCOUNTS.map(({ address }) => address));
});

test("each instruction is spl-token's: program, accounts in order with their flags, and data", () => {
  const builders = {
    createAssociatedTokenAccountIdempotentInstruction: (payer, account, owner, mint) =>
      createAssociatedTokenAccountIdempotentInstruction(key(payer), key(account), key(owner), key(mint)),
    createTransferCheckedInstruction: (source, mint, destination, owner, amount, decimals) =>
      createTransferCheckedInstruction(key(source), key(mint), key(destination), key(owner), amount, decimals),
    createTransferInstruction: (source, destination, owner, amount) =>
      createTransferInstruction(key(source), key(destination), key(owner), amount),
    createApproveInstruction: (account, delegate, owner, amount) =>
      createApproveInstruction(key(account), key(delegate), key(owner), amount),
    createSetAuthorityInstruction: (account, current, type, next) =>
      createSetAuthorityInstruction(key(account), key(current), type, next === null ? null : key(next)),
  };
  for (const { builder, args, programId, keys, data } of INSTRUCTIONS) {
    const instruction = builders[builder](...args);
    assert.deepEqual(
      {
        programId: instruction.programId.toBase58(),
        keys: instruction.keys.map(({ pubkey, isSigner, isWritable }) => [pubkey.toBase58(), isSigner, isWritable]),
        data: Buffer.from(instruction.data).toString("hex"),
      },
      { programId, keys, data },
      `${builder}(${args.join(", ")})`
    );
  }
  // Every builder has at least one vector.
  assert.deepEqual([...new Set(INSTRUCTIONS.map(({ builder }) => builder))].sort(), Object.keys(builders).sort());
});

test("the transaction prepare builds is, byte for byte, the one spl-token built", () => {
  assert.ok(TRANSACTIONS.some(({ payer }) => !onCurve(payer)));
  assert.ok(TRANSACTIONS.some(({ payTo }) => !onCurve(payTo)));
  for (const { transaction, ...args } of TRANSACTIONS) {
    assert.equal(buildUnsignedTransaction(args), transaction, JSON.stringify(args));
  }
});
