/**
 * Password policy constants shared by the server and the browser.
 *
 * Kept in `lib/` rather than `server/auth/password.ts` deliberately: that module
 * imports `node:crypto`, and a Client Component importing it would drag Node
 * built-ins into the browser bundle (or fail the build outright).
 *
 * Only the numbers live here. The actual screening runs server-side, because a
 * client-side check is a convenience for the user, never a control.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
