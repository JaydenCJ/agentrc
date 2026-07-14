/** Error type for expected, user-facing failures. The CLI prints the message
 *  without a stack trace and exits with `exitCode`. */
export class AgentrcError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "AgentrcError";
    this.exitCode = exitCode;
  }
}
