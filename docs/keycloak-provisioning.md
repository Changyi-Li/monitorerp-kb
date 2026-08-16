# Keycloak provisioning (OIDC sign-in)

The KB's OIDC sign-in (spec #57) is served by Keycloak as the identity
provider: a local instance at `http://127.0.0.1:8081` in development, and a
separate instance on the server in production. Both instances are provisioned
from the **same committed realm artifact**,
[`keycloak/monitorerp-realm.json`](../keycloak/monitorerp-realm.json), which
defines:

- realm `monitorerp` — enabled, self-registration off, **no users, no roles**;
- client `monitorerp-kb` — confidential, standard flow, PKCE S256, with the
  development redirect URI and a **placeholder production redirect URI**
  (`https://kb.monitorerp.example/api/auth/oidc/callback`).

The artifact contains **no users, roles, or secrets**: every instance
generates its own client secret on import, and the secret is never committed.
OIDC is optional at runtime — the API enables it purely through the four
environment variables `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (all four or none; see the API
readme's env vars table). The Keycloak side has no app-created state beyond
the realm and client: users sign in through Keycloak, and the app creates or
links the User's account on first sign-in.

## Development import (manual, once per dev machine)

Verified against the dev instance (`quay.io/keycloak/keycloak:26.7.1` in
Docker Desktop). The dev Keycloak is **not** part of the repo's compose
stack — start it yourself, e.g.:

```bash
docker run -d --name keycloak -p 8081:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.7.1 start-dev
```

1. **Open the admin console** at `http://127.0.0.1:8081/admin` and sign in
   (the dev container above boots with `admin` / `admin`).
2. **Create the realm from the artifact**: on the *Manage realms* page click
   **Create realm**, drag `keycloak/monitorerp-realm.json` onto the upload
   box (or browse for it), confirm the realm name auto-fills to
   `monitorerp`, and click **Create**. The console switches to the new
   `monitorerp` realm.
3. **Copy the instance-generated client secret**: go to **Clients** →
   `monitorerp-kb` → **Credentials** and copy the Client Secret. Every
   instance generates its own secret — keep it out of the repo.
4. **Set the four variables** in `apps/api/.env` (the file is gitignored):

   ```bash
   OIDC_ISSUER_URL=http://127.0.0.1:8081/realms/monitorerp
   OIDC_CLIENT_ID=monitorerp-kb
   OIDC_CLIENT_SECRET=<the copied secret>
   OIDC_REDIRECT_URI=http://localhost:4800/api/auth/oidc/callback
   ```

   The dev redirect URI matches the artifact's dev entry and the web dev
   origin (`localhost:4800`), so no substitution is needed in development.
5. **Restart the API** and verify the feature is on:

   ```bash
   curl http://127.0.0.1:4801/auth/oidc/config
   # {"enabled":true,"loginUrl":"http://localhost:4800/api/auth/oidc/login"}
   curl http://127.0.0.1:8081/realms/monitorerp/.well-known/openid-configuration
   ```

   A partial variable set (or a redirect URI not ending in
   `/auth/oidc/callback`) is a loud boot-time error, never a silent
   half-enabled state.

### Live gate

The web's live OIDC gate (`npm run gate:oidc` from `apps/web`, issues #62,
#63) drives the real round trip against this same development instance — the
button, the Keycloak login page, the signed-in landing, and passwordless
re-entry. It needs the four `OIDC_*` variables set (as above); its preflight
creates an e2e user in the realm via the Keycloak admin API (defaults:
`admin`/`admin` on the issuer's origin — override with
`KEYCLOAK_ADMIN_USER`/`KEYCLOAK_ADMIN_PASSWORD`/`OIDC_E2E_USER`/`OIDC_E2E_PASSWORD`).

## Production import (headless)

### Prerequisites — all three

1. **The issuer is reachable from the browser over public HTTPS.** The
   login redirect must load in a browser, so the Keycloak server needs a
   public HTTPS endpoint (not loopback HTTP).
2. **The issuer is reachable from the API.** The code exchange and the
   JWKS fetch run server-side; the server must be able to reach the same
   issuer (typically the same public URL, from the server's own network).
3. **The registered redirect URI matches the real web origin.** The
   artifact's production redirect URI is a **placeholder**
   (`https://kb.monitorerp.example/api/auth/oidc/callback`) — replace only
   the origin with the real web origin (e.g.
   `https://kb.your-domain.example/api/auth/oidc/callback`), keeping the
   `/api/auth/oidc/callback` suffix, before import; or correct the client's
   redirect URIs afterwards. A mismatched URI makes Keycloak refuse the
   callback with *Invalid redirect_uri*.

### Steps

1. **Prepare the artifact**: copy `keycloak/monitorerp-realm.json` and
   replace the placeholder's origin with the real web origin, keeping the
   `/api/auth/oidc/callback` suffix (e.g.
   `https://kb.your-domain.example/api/auth/oidc/callback`).
2. **Authenticate the admin CLI** against the production Keycloak (run
   `.../bin/kcadm.sh` from the Keycloak server, or
   `/opt/keycloak/bin/kcadm.sh` inside its container; when running inside
   the container, point `--server` at the internal URL — e.g.
   `http://localhost:8080` — not the externally published one):

   ```bash
   kcadm.sh config credentials --server https://keycloak.your-domain.example \
     --realm master --user <admin> --password <password>
   ```

3. **Import the realm**:

   ```bash
   kcadm.sh create realms -f monitorerp-realm.json
   ```

   The realm is created exactly as in development; the client secret is
   generated by this instance. Re-running the import over an existing realm
   fails — delete the realm first (or update the client in place).
4. **Retrieve the instance-generated client secret**:

   ```bash
   KC_ID=$(kcadm.sh get clients -r monitorerp -q clientId=monitorerp-kb \
     --fields id --format csv --noquotes)
   kcadm.sh get clients/$KC_ID/client-secret -r monitorerp
   ```

5. **Set the four variables** in the deployment environment (the deploy
   repo's kb stack), all four together — `OIDC_ISSUER_URL` =
   `https://keycloak.your-domain.example/realms/monitorerp`,
   `OIDC_CLIENT_ID` = `monitorerp-kb`, `OIDC_CLIENT_SECRET` = the secret
   from step 4, `OIDC_REDIRECT_URI` = `https://kb.your-domain.example/api/auth/oidc/callback`.
6. **Verify**: from the server, `curl -f` the issuer's discovery document
   over HTTPS; then check the API's `/auth/oidc/config` reports
   `{"enabled":true,...}`.

### Rotating the secret

The client secret is instance-generated; regenerating it in the console (or
re-importing the realm after deleting it) invalidates the old value. Update
`OIDC_CLIENT_SECRET` in the same breath — a stale secret surfaces as
Keycloak's *Invalid client* at the first sign-in attempt, never as a hang.
