/**
 * Exit codes shared by the entry point, dispatch and command handlers.
 * Kept in a leaf module so commands never import the dispatcher.
 */

/** Success. */
export const EXIT_OK = 0
/** Recognized command that could not complete its job. */
export const EXIT_FAILURE = 1
/** Unknown command, unknown option or malformed arguments. */
export const EXIT_USAGE = 2
/** Deliverable authentication is unavailable; restore pairing before retrying. */
export const EXIT_AUTH = 3
/** Wrong directory/pane/run, or a session/claim that must be reconciled. */
export const EXIT_CONTEXT = 4
/** No trustworthy outcome yet; retry the saved operation unchanged. */
export const EXIT_UNCONFIRMED = 5
/** The submitted input conflicts with a saved operation or server version. */
export const EXIT_CONFLICT = 6
