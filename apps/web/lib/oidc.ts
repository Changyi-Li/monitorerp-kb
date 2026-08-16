/**
 * The OIDC failure contract shared by the web's sign-in surfaces (issue #62).
 *
 * The API's callback (issue #61) redirects a failed sign-in to the web origin
 * with this query parameter (its own copy lives in
 * apps/api/src/routes/oidc.ts); the proxy, the sign-in page, and the e2e
 * assertions all read it from here so a rename can't silently drift.
 */
export const OIDC_ERROR_PARAM = "oidc_failed";
