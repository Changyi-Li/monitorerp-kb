# MonitorERP Knowledge Base

An app that manages RAG documents for a self-hosted RagFlow instance: users upload, version, and publish documents; a document is parsed by RagFlow only when it is published.

## Language

**User**:
A person with an account in the system.
_Avoid_: account, person

**Member**:
A user with the default role — manages their own documents, views and downloads any document.
_Avoid_: normal user, editor

**Super admin**:
A user with the elevated role — manages users (activation, role changes, deactivation), deletes any document, and configures the RagFlow dataset connection. There may be many super admins; any super admin can promote a Member to super admin, but the last active super admin can never be demoted or deactivated.
_Avoid_: admin

**Activation**:
The act of a super admin enabling a registered but inactive account. Newly signed-up users are inactive until activated; the first account is seeded as an activated super admin.
_Avoid_: approval, verification

**Document**:
A managed file together with its metadata and history, owned by the user who uploaded it. Only the owner edits, deletes, or changes its status; any user can view or download it.
_Avoid_: doc, file

**Dataset**:
The RagFlow collection a document is published to. A single dataset is configured server-side (currently `monitorerp-china-internal`); the app never manages datasets.
_Avoid_: knowledge base, collection

**Document status**:
The stage of a Document's lifecycle: `draft` (default on upload), `ready` (owner marked it publishable), `publishing` (transient — sent to RagFlow, parsing), `published` (parse completed OK), `failed` (upload or parse error).
_Avoid_: state, stage

**Publish**:
The act of sending a ready Document to RagFlow for parsing. A Document is parsed by RagFlow only when it is published; a failed publish can be retried up to three times, then requires withdrawing to draft and re-promoting.
_Avoid_: push, deploy, sync

**Withdraw**:
The act of moving a Document back to draft: the file stays in RagFlow, its parse data (chunks) is removed, and it is parsed again when re-published. Available to the owner for their own Documents and to any super admin; the way to return a failed Document to `ready` after retries are exhausted, and the way to take a published Document out of retrieval.
_Avoid_: unpublish, retract
