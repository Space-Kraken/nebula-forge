/**
 * Error type for every user-facing failure in forge. The optional hint tells
 * the user how to fix the problem, not just what went wrong.
 *
 * `hint` is declared as a required `string | undefined` (not `hint?`) so the
 * class is structurally distinguishable from Error and instanceof narrowing works.
 */
export class ForgeError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ForgeError';
    this.hint = hint;
  }
}
