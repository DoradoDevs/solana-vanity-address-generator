// Token program instructions that only the tests build, as the attacks the
// page's check must refuse. Same names, argument order and bytes as
// @solana/spl-token's; spl-token-vectors.test.js checks them against bytes
// spl-token produced.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "../../../shared/payment.js";

const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);

/** The one SetAuthority kind the tests use. */
export const AuthorityType = { AccountOwner: 2 };

/** An opcode followed by a little-endian u64. */
function opcodeAndAmount(opcode, amount) {
  const data = Buffer.alloc(9);
  data.writeUInt8(opcode, 0);
  data.writeBigUInt64LE(amount, 1);
  return data;
}

const writable = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey) => ({ pubkey, isSigner: true, isWritable: false });

/** Transfer (3): no mint, no decimals. */
export function createTransferInstruction(source, destination, owner, amount) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [writable(source), writable(destination), signer(owner)],
    data: opcodeAndAmount(3, amount),
  });
}

/** Approve (4): lets the delegate move up to amount from the account. */
export function createApproveInstruction(account, delegate, owner, amount) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [writable(account), readonly(delegate), signer(owner)],
    data: opcodeAndAmount(4, amount),
  });
}

/** SetAuthority (6): the authority kind, then an optional new authority (1 and the key, or 0). */
export function createSetAuthorityInstruction(account, currentAuthority, authorityType, newAuthority) {
  const option = newAuthority ? [1, ...newAuthority.toBytes()] : [0];
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [writable(account), signer(currentAuthority)],
    data: Buffer.from([6, authorityType, ...option]),
  });
}
