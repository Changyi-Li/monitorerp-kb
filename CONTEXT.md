# MonitorERP Knowledge Base

An app that manages RAG documents for a self-hosted RagFlow instance: users upload, version, and publish documents; a document is parsed by RagFlow only when it is published.

## Language

**User**:
A person with an account in the system, who signs in either with a password or via OIDC.
_Avoid_: account, person

**Member**:
A user with the default role — manages their own documents, views and downloads any document.
_Avoid_: normal user, editor

**Super admin**:
A user with the elevated role — manages users (activation, role changes, deactivation), deletes any document, and configures the RagFlow dataset connection. There may be many super admins; any super admin can promote a Member to super admin, but the last active super admin can never be demoted or deactivated.
_Avoid_: admin

**Activation**:
The act of a super admin enabling a registered but inactive account. Newly signed-up (password) users are inactive until activated; users who sign in via OIDC are active immediately — the identity provider vouches for them; the first account is seeded as an activated super admin.
_Avoid_: approval, verification

**OIDC sign-in**:
Signing in through an external identity provider (Keycloak) instead of a password: the provider vouches for who the user is, and the app creates or links the User's account from the provider's identity. OIDC users start as Members, active immediately; roles are still app-managed.
_Avoid_: SSO, social login, federated login

**Identity link**:
The association between a User's app account and their external identity-provider identity (keyed by the provider's stable subject identifier). Once linked, both doors — password and OIDC — lead to the same account; linking an OIDC identity to an existing password account with the same email is automatic.
_Avoid_: merge, bind, mapping

**Account status**:
Whether a User can sign in: `active`, `pending` (signed up, awaiting activation), or `deactivated` (cannot sign in; reactivation restores access). There is no account deletion in v1 — deactivation is the removal mechanism.
_Avoid_: state, flag

**Document**:
A managed file together with its metadata and history, owned by the user who uploaded it. Only the owner edits, deletes, or changes its status; any user can view or download it.
_Avoid_: doc, file

**Dataset**:
The RagFlow collection a document is published to. A single dataset is configured server-side (via `RAGFLOW_DATASET_ID`); the app never manages datasets. The dataset's display name is read from RagFlow at runtime (issue #40), never baked into a client bundle.
_Avoid_: knowledge base, collection

**Document status**:
The stage of a Document's lifecycle: `draft` (default on upload), `publishing` (transient — sent to RagFlow, parsing), `published` (parse completed OK), `failed` (upload or parse error).
_Avoid_: state, stage

**Publish**:
The act of sending a Document to RagFlow for parsing — the owner of a draft, or any super admin, may publish. A Document is parsed by RagFlow only when it is published; a failed publish can be retried up to three times, then requires withdrawing to draft before it can be published again.
_Avoid_: push, deploy, sync

**Withdraw**:
The act of moving a Document back to draft: the file stays in RagFlow, its parse data (chunks) is removed, and it is parsed again when re-published. Available to the owner for their own Documents and to any super admin; the way to return a failed Document to a publishable state after retries are exhausted, and the way to take a published Document out of retrieval.
_Avoid_: unpublish, retract

**Document history**:
The chronological record of a Document's status transitions — who moved it, from which status to which, when, and why (the note). Shown on the Document detail screen.
_Avoid_: audit log, activity

**Chat session**:
An exchange between a User and the RagFlow agent, owned by that User and visible only to them. The app stores metadata only (our id, owner, the RagFlow session id, a title, timestamps) — messages are never stored; history is fetched live from RagFlow on demand. A session is created lazily on the User's first message and titled from it; its answer streams into the app token by token.
_Avoid_: conversation, dialog
