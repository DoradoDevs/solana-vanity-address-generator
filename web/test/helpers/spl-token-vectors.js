// Known answers recorded from @solana/spl-token 0.4.15 with
// @solana/web3.js 1.99.0 on 2026-11-16, just before spl-token was removed
// from web/. Every expected value here is spl-token's output (the
// transactions are the old lib/tx.js, which used spl-token), never the code
// under test. Inputs are random apart from the pinned payee and the test
// payer; some owners are program addresses (off the curve). Before these
// were recorded, the new builders were compared with spl-token on 50,000
// random transactions, 50,000 account derivations and 12,500 random cases
// per instruction builder, with no difference. They cannot be regenerated
// without spl-token: keep them as they are.

export const SPL_TOKEN = {
  TOKEN_PROGRAM_ID: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ASSOCIATED_TOKEN_PROGRAM_ID: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  SYSTEM_PROGRAM_ID: "11111111111111111111111111111111",
  ACCOUNT_SIZE: 165,
  AuthorityType: { AccountOwner: 2 },
};

/** getAssociatedTokenAddressSync(mint, owner, true). */
export const ASSOCIATED_ACCOUNTS = [
  // the pinned payee: on the curve, bump 255
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp", address: "5edXXhVJaW3prmqwhfjkSdRNwP4TG7fRiX1YLyfsW8iT" },
  // the test payer: on the curve, bump 254
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt", address: "5BqbvV5otXedd8y1USsemDVWWYDgQ4nx6NLXR4F8iRjX" },
  // the test payer, another mint: on the curve, bump 255
  { mint: "So11111111111111111111111111111111111111112", owner: "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt", address: "GXdQoMK4pxjZKhvmVjzHVsruWAPiHbgru65zAFV1pU6i" },
  // a wallet: on the curve, bump 254
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "5qTXDWUmKzacRhkhgHwqgEXsFDDtPRWNSQX7DBM3dHQh", address: "9f4sCnqCX7kenbz2k9mB547qHHW7sTwxtcc4VQ4N92t9" },
  // a wallet: on the curve, bump 247
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "72MtwYYFU54nMiDP3m8VtUQQYuFDRhZFBZc2ZsLsYgEk", address: "2iGvQq2XrVmbXqeqv7PvS124NRVVxu3EXTkeQjhQENGH" },
  // a program address: off the curve, bump 255
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "7uiVrNtxEmwbVvRuKCwSVMp11g1q2kfzzcp4HbC8sPJm", address: "42Jmu7U43s4ko5a2Fn1T3wimbX1Z9UfqkySamhdyG9nf" },
  // a program address: off the curve, bump 253
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "F4XJBEtBSe1dxtbgJVrpU1R3wKaNbLtBhJZkLgQXdhvR", address: "3sJe94JbKLBTWaVAQsSQPxVWkWQgYyCPaMXzBDqkrhM2" },
  // a program address, another mint: off the curve, bump 254
  { mint: "So11111111111111111111111111111111111111112", owner: "DJJSaGkd5zdwJGJUbttiA6mzUkxHJ96oRaSrJxxLhC2c", address: "CuFSp4kCXoHsjfZ8B9EXdDQFhZ1YjKHYSWK9WJsDAZr4" },
];

/** buildUnsignedTransaction(...) as it was with spl-token: the serialized, unsigned transaction in base64. */
export const TRANSACTIONS = [
  // the test payer to the pinned payee; payer on the curve, bump 254, payee on the curve, bump 255
  {
    payer: "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt",
    payTo: "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp",
    reference: "Go3s18hyb1YgRTfZ5Bm5yrdAjEbHBYWcvDhnwEbrwZFc",
    blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    transaction:
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJTLWr9q15+/WrvMr8wmnYXNJlHtS4hbWGnyQa7fCluik+NYKnxVJeJwnYijzOQ7GXIrKC7bYCAyMjmuven+hmWkUSicNFVYa+9FDPhTqnS1cZrpYaWffqU+CYCxk/OeNIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQkvjA4bEULUhEMTrDzsfEuGM0d6bnVCCx01NxarcI/txvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHqq0HfAj/q+isvcvTZDJHFT2jd/uHh8MHbsMKl6N34zwbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQECBAYAAgUGAwgBAQgFAQYCAAcKDEBCDwAAAAAABg==",
  },
  // a wallet to the pinned payee; payer on the curve, bump 252, payee on the curve, bump 255
  {
    payer: "Ak2LduwmPoCLxnzzoA9xmt2AeKYy6nC5zxTDt3HTv8V3",
    payTo: "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp",
    reference: "9GHfdsexAdmphw1aN4nesg2KaZ4WHhFxSueXsEbxTFpx",
    blockhash: "6BZvKpwjog5RWMtTkjHxo4bPdoGC5QB4svfRhvghW4o5",
    transaction:
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJkL6rryD8C1RxodMT5kMdFuSPJiLR24vVmZ/myaTPUj5EKB1pJsPf34564cnLwUuS9/LKWx8wQHh+wT9myCClQEUSicNFVYa+9FDPhTqnS1cZrpYaWffqU+CYCxk/OeNIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6yA1QJqSDK03eN35T/DN9ZudEl11n/9hHgreIPmae1YyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZCS+MDhsRQtSEQxOsPOx8S4YzR3pudUILHTU3Fqtwj+3G+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpTP92/M4axr9D41sKjOL5AVQ/pAEDXOLRIwrt1I3XdYQCBQYAAgYHAwgBAQgFAQcCAAQKDEBCDwAAAAAABg==",
  },
  // a program address to the pinned payee; payer off the curve, bump 251, payee on the curve, bump 255
  {
    payer: "2nfZ9syePDh9kkBQ6o2fc7QrncLzVa9wDNyPw9q8Dfgo",
    payTo: "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp",
    reference: "2TBsXgk9wfjyFo9e8H7AAxubiDHhSt85pacGsTkuivpF",
    blockhash: "E5ue8nzaqc7Vo3hRKhaeLCfm39YXzccx4DbfnY5KNPtE",
    transaction:
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJGo5quXhWMv6XM1E0r01XmiUt1AxrnyLvcIAQFLBuIqwdnjEeBpbxvvKqCBl/gJvfB/8cMDT9FGazyerkjSjqKUUSicNFVYa+9FDPhTqnS1cZrpYaWffqU+CYCxk/OeNIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVkRR+mPPGBTDz37BugjhFZRX1+2HDdKCuXN0HQ8ylMIyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZCS+MDhsRQtSEQxOsPOx8S4YzR3pudUILHTU3Fqtwj+3G+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpwmnGF4jyNAK1hh+JRPVNKeytsKbKKHNKIYG67dvxH9sCBQYAAgYHAwgBAQgFAQcCAAQKDEBCDwAAAAAABg==",
  },
  // a wallet to a program address; payer on the curve, bump 255, payee off the curve, bump 254
  {
    payer: "DPcdGFqAD56pizJnv8R5C67AZyAM4QnR2Piikj7Ji6T4",
    payTo: "G2oy9Y82sitqUvTCYa5dALnrUMW6NfmNHSCDfjowDLY4",
    reference: "Gn3CQcgZXH8DBRyRJubRqJJ5qAHHkhA8K87Gbu3Qw1xh",
    blockhash: "2ABPXERReHfAgXSUv6MwPrGm3xaQc1FnSV1DazLBwqXT",
    transaction:
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJuBdNb7Wh3vr0SpbdQobn6rOON4WRVhak7Rqr7cQ2dNPunn8zo4UpolyRYbbkS5jzZC6pdr4K10HTq2yD2LSE0Pa6SWARDzHzTpk1rjBJJB9M7FuP+sdwRlbYnh6eMWa4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4Wcb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11h31X93P25ZK+Sm77I8zRd9j/W3XS9pv5fPPwKXCNXkjXqaOyRTgMEWBFTe7PWgRMDEmmMm26dKCMpy7byuHNZvgbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpETWpCPYfw6npAbT6IrDSqGq4oQf3rT9f2+cO6sBE8lYCBAYAAQYFAwgBAQgFAgUBAAcKDEBCDwAAAAAABg==",
  },
  // a program address to a wallet; payer off the curve, bump 255, payee on the curve, bump 255
  {
    payer: "AbdGZ1KZqHapMBGNEkcfNC4WYDmXaxo4rm6EjYhZvmXC",
    payTo: "BzyXYBzpygE4G4r2pu9FQTBnHpU9JYzah3jMeuFWDcKz",
    reference: "E8yQx5Bz35siScSBwD231P942GVTBvz3BZjthk9ML7VK",
    blockhash: "4Vx2QiSxui37Qe7jukvm2StNiDxcmJXuUKkAPKtytpue",
    transaction:
      "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJjpfwOCGdmffsKvPGfLSb4EcabZvK5sdD66EQ0AfgSA/gMWgxzkrbdMK5SE5E1TQ/OABmijuCbiTGdZEdNxZC7gxBnKLSMrwNstTGWvBW0fcCcRgjFN9KRbYwTsjLVTF+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WaNu495uN4BZy1qNp+Xzjnma2xt7Oxb9+zaTMLaPKI0pwzLIMTvVoK1Eo8Sz55kDTDA7veJgjaPi9NaQ2MgeUDrG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpM/2KIwtjWa5unVgeQKJI4K4JX8VL9LIwuBJHXsxFVGECBAYAAQUHAwgBAQgFAgcBAAYKDEBCDwAAAAAABg==",
  },
];

/** One instruction per entry: the builder and its arguments, then the program, [address, signer, writable] per account, and the data in hex. */
export const INSTRUCTIONS = [
  {
    builder: "createAssociatedTokenAccountIdempotentInstruction",
    args: ["HWnh4v3PrLDD1CqduEyqYxt17ztYpGTbTxaqUcHwLLdd", "J8dwvT6ynzK6wiVyaWJ7GLD1vt17RV31YqoyeBTDJpeE", "6egXeC9P5pU2Za4hMiGHCTFFPtnRqER6d39F8uNVW8PB", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    keys: [
      ["HWnh4v3PrLDD1CqduEyqYxt17ztYpGTbTxaqUcHwLLdd", true, true],
      ["J8dwvT6ynzK6wiVyaWJ7GLD1vt17RV31YqoyeBTDJpeE", false, true],
      ["6egXeC9P5pU2Za4hMiGHCTFFPtnRqER6d39F8uNVW8PB", false, false],
      ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, false],
      ["11111111111111111111111111111111", false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ],
    data: "01",
  },
  {
    builder: "createAssociatedTokenAccountIdempotentInstruction",
    args: ["GcKfFD6DNWUosnKBzHxFSkLDMNr75To7FTFvrCgmXRw9", "3i63XxuUiQaFVVT7RhY1XAHFrpqo6sjrNqQnuKYqf2r9", "5aZN66W8JDorQ6JLB6yAkYMJFuRm7TCvvE744eLRaSkk", "So11111111111111111111111111111111111111112"],
    programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    keys: [
      ["GcKfFD6DNWUosnKBzHxFSkLDMNr75To7FTFvrCgmXRw9", true, true],
      ["3i63XxuUiQaFVVT7RhY1XAHFrpqo6sjrNqQnuKYqf2r9", false, true],
      ["5aZN66W8JDorQ6JLB6yAkYMJFuRm7TCvvE744eLRaSkk", false, false],
      ["So11111111111111111111111111111111111111112", false, false],
      ["11111111111111111111111111111111", false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ],
    data: "01",
  },
  {
    builder: "createTransferCheckedInstruction",
    args: ["EWKdBjhWxfPbD49fJ83sEAy9ceJM8z2CTZe59GuDPjFY", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "CEAUwxx3DNjWVuTCQBx36a3BAvgXu3s8f1PXtvHVDMLr", "GSYxKxmGDAtvgLPZufaQEUzfzLx2RrtNdfu4qA4N3hjz", 1000000n, 6],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["EWKdBjhWxfPbD49fJ83sEAy9ceJM8z2CTZe59GuDPjFY", false, true],
      ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, false],
      ["CEAUwxx3DNjWVuTCQBx36a3BAvgXu3s8f1PXtvHVDMLr", false, true],
      ["GSYxKxmGDAtvgLPZufaQEUzfzLx2RrtNdfu4qA4N3hjz", true, false],
    ],
    data: "0c40420f000000000006",
  },
  {
    builder: "createTransferCheckedInstruction",
    args: ["3FLAAWB5dh7izjJ5SEnadivZ979rZJwJE9fWjesa5Gpc", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "8YAGbD12HhgZDmiWkg2etQYfTWpmpocozBTwNyYzXPjQ", "BMsH94gt1Jecps6GNex3Z6GHHSAeXp7wqKkFBiNcjFiK", 0n, 0],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["3FLAAWB5dh7izjJ5SEnadivZ979rZJwJE9fWjesa5Gpc", false, true],
      ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, false],
      ["8YAGbD12HhgZDmiWkg2etQYfTWpmpocozBTwNyYzXPjQ", false, true],
      ["BMsH94gt1Jecps6GNex3Z6GHHSAeXp7wqKkFBiNcjFiK", true, false],
    ],
    data: "0c000000000000000000",
  },
  {
    builder: "createTransferCheckedInstruction",
    args: ["GvgqaTx7PZvED1kPkR5q8JU1NF2wwsSkM7gVChZwvywX", "So11111111111111111111111111111111111111112", "DsD7LmUVrFEmvZSiq5iSiF8njvTC2Yqr9pGvhbFbJven", "6FYARUvuD6m89WE7yvQjaz5F4ukHEi7gwgookx7aUFEJ", 18446744073709551615n, 9],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["GvgqaTx7PZvED1kPkR5q8JU1NF2wwsSkM7gVChZwvywX", false, true],
      ["So11111111111111111111111111111111111111112", false, false],
      ["DsD7LmUVrFEmvZSiq5iSiF8njvTC2Yqr9pGvhbFbJven", false, true],
      ["6FYARUvuD6m89WE7yvQjaz5F4ukHEi7gwgookx7aUFEJ", true, false],
    ],
    data: "0cffffffffffffffff09",
  },
  {
    builder: "createTransferCheckedInstruction",
    args: ["9xx2A2mpbaMUn7Xd215KsnLMjUy4yDzY1tPb3zs9y6QF", "2g7nk8wU94zizHYaydP9JZmbnNBwL1XeYjpcghTLu8h7", "2nWJ71uizm8i9B2rveXAiLpTBQG4ER43zYKEiWbUB7UW", "9AKhb51HUoannEdP7N35GSNqtg2P2RUqLkYzwb5XgPEk", 9223372041183495173n, 255],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["9xx2A2mpbaMUn7Xd215KsnLMjUy4yDzY1tPb3zs9y6QF", false, true],
      ["2g7nk8wU94zizHYaydP9JZmbnNBwL1XeYjpcghTLu8h7", false, false],
      ["2nWJ71uizm8i9B2rveXAiLpTBQG4ER43zYKEiWbUB7UW", false, true],
      ["9AKhb51HUoannEdP7N35GSNqtg2P2RUqLkYzwb5XgPEk", true, false],
    ],
    data: "0c0504030201000080ff",
  },
  {
    builder: "createTransferInstruction",
    args: ["ETLrNHaBue1B9x83nn9Q3YWr4agassfGASHF39yjUpSj", "DdnPXTqKCSSHhMCAgkVuwubLmCFAZjDdr2CGDh4Krx7J", "Dvr8PeQh5fJ7rCFsYCBRM56zcZn1b92QpeFLznMzZJuo", 1000000n],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["ETLrNHaBue1B9x83nn9Q3YWr4agassfGASHF39yjUpSj", false, true],
      ["DdnPXTqKCSSHhMCAgkVuwubLmCFAZjDdr2CGDh4Krx7J", false, true],
      ["Dvr8PeQh5fJ7rCFsYCBRM56zcZn1b92QpeFLznMzZJuo", true, false],
    ],
    data: "0340420f0000000000",
  },
  {
    builder: "createTransferInstruction",
    args: ["C3GJKaqtK9LacNNpbh7HvqyMo4tvTVLbeRE492jRxGTS", "3KiKvRoewbv5oTJwG3fcFsEFLTQiFguVdBwtocJUW3KT", "FEk6YdZJibGrH3c82rHe3wFJBBPAWKy5TpacVQnwjndk", 18446744073709551360n],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["C3GJKaqtK9LacNNpbh7HvqyMo4tvTVLbeRE492jRxGTS", false, true],
      ["3KiKvRoewbv5oTJwG3fcFsEFLTQiFguVdBwtocJUW3KT", false, true],
      ["FEk6YdZJibGrH3c82rHe3wFJBBPAWKy5TpacVQnwjndk", true, false],
    ],
    data: "0300ffffffffffffff",
  },
  {
    builder: "createApproveInstruction",
    args: ["JB91yngXAnrtbjZCT4HeaaxFEcCgheoYoHPiknocZVfn", "GnaDYZb6K3wAnFHqhK2xezC5ENKuKMbTfP3CQhvmVPCj", "2k1VwBEkDGwS4g8SExxffvfYB4goh5833nUdKvULBEsA", 18446744073709551615n],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["JB91yngXAnrtbjZCT4HeaaxFEcCgheoYoHPiknocZVfn", false, true],
      ["GnaDYZb6K3wAnFHqhK2xezC5ENKuKMbTfP3CQhvmVPCj", false, false],
      ["2k1VwBEkDGwS4g8SExxffvfYB4goh5833nUdKvULBEsA", true, false],
    ],
    data: "04ffffffffffffffff",
  },
  {
    builder: "createApproveInstruction",
    args: ["FsSG1b8dvzEpWmxfkGsJuRE6nCPbKveQvQQmZgnqSHRH", "2izUm1M2EMAmgBtKeqYdUjrQFkZmNEoe7tRkgvWVTyBn", "GvYk8phJV9DwxQM2AaJsPGNP19mgQ7H5vuhJB2EGzxsK", 1n],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["FsSG1b8dvzEpWmxfkGsJuRE6nCPbKveQvQQmZgnqSHRH", false, true],
      ["2izUm1M2EMAmgBtKeqYdUjrQFkZmNEoe7tRkgvWVTyBn", false, false],
      ["GvYk8phJV9DwxQM2AaJsPGNP19mgQ7H5vuhJB2EGzxsK", true, false],
    ],
    data: "040100000000000000",
  },
  {
    builder: "createSetAuthorityInstruction",
    args: ["6Bsx2aoVeUHPsKrpeHVQB58SUmEMDk6wWKTauiGT6gzJ", "HVTSzmAzSHk879C1NyE7vznjD6BfgLEuiESzhzH7nNNk", 2, "Ei2pHDeEgaRomWVCohLJTFfNUw5Wdwc8yJWZZxZMJhnb"],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["6Bsx2aoVeUHPsKrpeHVQB58SUmEMDk6wWKTauiGT6gzJ", false, true],
      ["HVTSzmAzSHk879C1NyE7vznjD6BfgLEuiESzhzH7nNNk", true, false],
    ],
    data: "060201cbaacbae5ba9d0876a4ff65bff2ceb83caf0887e968212de0da98eebe9cfdb9c",
  },
  {
    builder: "createSetAuthorityInstruction",
    args: ["8V4AfYLwLUNnMDwFxQpTb2EZVWc2DM7czVa8cof1BSMY", "4roWYhsSY6LrrP6gjqjjRb6BHtMeo612kbqfewyND3ct", 3, null],
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    keys: [
      ["8V4AfYLwLUNnMDwFxQpTb2EZVWc2DM7czVa8cof1BSMY", false, true],
      ["4roWYhsSY6LrrP6gjqjjRb6BHtMeo612kbqfewyND3ct", true, false],
    ],
    data: "060300",
  },
];
