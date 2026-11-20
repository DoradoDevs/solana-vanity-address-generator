/**
 * What the console says about a job before it grinds, as [text, tone] pairs.
 * A search for a pattern has no fixed length, so nothing here is a time: the
 * odds, a horizon in attempts, and the rate this device measured. Pure, so it
 * is tested without a page.
 */
import { attemptsForChance, formatAttempts, formatOdds } from "../../shared/grind-math.js";

/** describeJob's warnings, less the ones built on an assumed rate: those are times. */
export function consoleWarnings(warnings) {
  return warnings.filter((warning) => !/assumed rate/.test(warning));
}

/**
 * The job, as the console prints it once Start grinding is pressed.
 * @param {{ pattern: string, position: string, caseSensitive: boolean, threads: number, batch: number, attempts: number }} job
 * @param {{ narrow: boolean }} options
 * @returns {Array<[string, string]>}
 */
export function planLines(job, { narrow }) {
  const caseWord = job.caseSensitive ? "sensitive" : "insensitive";
  const odds = formatOdds(job.attempts);
  const half = attemptsForChance(0.5, job.attempts);
  const horizon = Number.isFinite(half) ? `~${formatAttempts(half)} attempts` : "never";
  const lines = narrow
    ? [
        [`  Pattern: "${job.pattern}"`, ""],
        [`  Position: ${job.position}`, ""],
        [`  Case: ${caseWord}`, ""],
        [`  Threads: ${job.threads}`, ""],
        [`  Matches: ${job.batch}`, ""],
        [`  Odds: ${odds}`, "dim"],
        [`  50% chance by: ${horizon}`, "dim"],
      ]
    : [
        [`  Pattern:    "${job.pattern}"`, ""],
        [`  Position:   ${job.position}`, ""],
        [`  Case:       ${caseWord}`, ""],
        [`  Threads:    ${job.threads}`, ""],
        [`  Matches:    ${job.batch}`, ""],
        [`  Odds:       ${odds} per key`, "dim"],
        [`  50% chance: by ${horizon}`, "dim"],
      ];
  if (job.batch > 1) lines.push(["  Each further match needs about as many attempts again.", "dim"]);
  return lines;
}

/**
 * The rate this device measured, or why there is none.
 * @param {number | null} perWorker keys a second for one worker, or null
 * @param {number} threads
 * @param {{ narrow: boolean }} options
 * @returns {Array<[string, string]>}
 */
export function deviceLines(perWorker, threads, { narrow }) {
  if (!perWorker) return [["  Could not measure this device. The readouts show its rate once the grind starts.", "warn"]];
  const each = formatAttempts(perWorker);
  const all = formatAttempts(perWorker * threads);
  return narrow
    ? [
        [`  This device: ${each} keys/s per worker`, ""],
        [`  Across ${threads}: ~${all}/s`, ""],
      ]
    : [[`  This device: ${each} keys/s per worker, ~${all}/s across ${threads}`, ""]];
}
