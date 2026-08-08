# RagFlow as a File Store — Feasibility Research

**Date:** 2026-08-08 · **Design question:** can we store document files in RagFlow itself — uploaded unparsed, parsed on publish, and "withdrawn" (parse data removed, file kept) on unpublish?

**Verdict: VIABLE, with one design constraint.** Upload-without-parse, deferred parse-on-demand, and un-parse-withdraw all work in v0.26.4 and were verified live. The only wrinkle: the withdraw path is a side effect of changing the document's `chunk_method` (or `pipeline_id`) via the update endpoint — there is no dedicated "clear parse data" API — so the app must remember/restore the doc's chunk method on re-publish, and withdraw is only reachable by PUTting a *different* parser id than the current one. Deleting chunks alone (`DELETE .../chunks`) empties the chunk store but leaves the doc `DONE`, which is *not* an unparsed state.

---

## Sources & verification status

| Source | Identity | Use |
|---|---|---|
| Live instance `http://101.132.20.133/` | **v0.26.4** (`GET /api/v1/system/version` → `{"code":0,"data":"v0.26.4"}`) | All "live-verified" claims |
| Local checkout `D:\src\githubs\ragflow` | **v0.26.4** (`git describe` → `v0.26.4`) — **matches deployed version exactly**, no mismatch to reconcile | Source citations below are relative to this root |
| Official HTTP API reference https://ragflow.io/docs/http_api_reference (renders `docs/references/http_api_reference.md` in the repo, v0.26.4) | — | Where noted |

**Live-verified vs source-only:** A1, A3, B, C, D (retrieval emptiness) were live-verified. A2, E, F are source/docs-based (E: absence of webhooks established by source + docs; F: limits are deployment-config env vars, not observable via API).

**Live test cleanup:** throwaway dataset `kb-app-smoke-test` created and DELETEd at the end (`DELETE /api/v1/datasets` → `{"code":0,"data":{"success_count":1}}`; name-filtered list afterwards → 0 matches). The `monitorerp-china-internal` dataset was never mutated (read-only list only).

---

## A. Store files unparsed (core feasibility)

### A1. Upload endpoint — `POST /api/v1/datasets/{dataset_id}/documents`

- Multipart, form field `file=@...` (multiple files allowed), optional `type=local|web|empty` query param (default `local`). Source: `api/apps/restful_apis/document_api.py:427-519, 632-700`.
- **`run` parameter: does not exist in v0.26.4.** The handler reads only `parser_config` (JSON, restricted to keys `table_column_mode`/`table_column_roles`) and `parent_path` from the form (`document_api.py:649-671`). Uploading with `run=false` (or `run=true`) has no effect — **no parse task is ever queued on upload in v0.26.4** (`FileService.upload_document` stores the blob and inserts a Document row; no `queue_tasks` call, no `run` field set — `api/db/services/file_service.py:514-627`). The upload response hardcodes `run:"UNSTART"` (`document_api.py:692`).
- `name`: not settable on `type=local` upload — it's the file's filename (validated ≤ 255 UTF-8 bytes; `api/db/services/file_service.py:534`, `api/constants.py:26`). `name` is only settable for `type=web` (form field) and `type=empty` (JSON `{"name": ...}`) uploads.
- `parser_id` (chunk method): **not settable on upload in v0.26.4.** It is auto-derived per file type (`get_parser`: ppt/pptx→`presentation`, images→`picture`, audio→`audio`, eml/msg→`email`, else the dataset's default — `file_service.py:658-662`) or inherited from the dataset (`kb.parser_id`). Per-document override happens later via `PUT`.
- Where the file goes: object storage via `settings.STORAGE_IMPL` (backend selected at startup from config — minio/oss/gcs/opendal factory; `common/settings.py:358-368`; `conf/service_conf.yaml:16` defines the minio section; docker deployment ships MinIO). Object key = document `location` field, bucket = dataset id (`STORAGE_IMPL.put(kb.id, location, blob)` — `file_service.py:589`). Upload response exposes `location` (live: `"location":"kb-smoke.md"`).
- Live-verified: upload of a 160-byte markdown with `-F file=@... -F run=false` → `{"code":0,"data":[{...,"run":"UNSTART","size":160,"location":"kb-smoke.md",...}]}`. Document list shows `run:UNSTART, progress:0.0, progress_msg:"", chunk_count:0, token_count:0`. So: yes, the doc appears unparsed with zero chunks.
- **Note (docs vs implementation):** neither the online nor the in-repo HTTP API reference documents `run`/`parser_id`/`parser_config` on this endpoint (`docs/references/http_api_reference.md:1450-1620`, upload section; the endpoint's documented body params are `file`, `name`, `url`, `type`). Older RagFlow releases (≤ v0.16 era) did accept a `run` boolean on upload; on v0.26.4 it is inert. Behavior is authoritative: unparsed-by-default upload works.

### A2. Triggering parse later — dedicated parse endpoints exist (two of them)

**Option 1 (used in live test): `POST /api/v1/datasets/{dataset_id}/documents/parse`** — body `{"document_ids": ["<id>", ...]}`. Source: `api/apps/restful_apis/document_api.py:1508-1618`. Sets `run=RUNNING, progress=0`, deletes existing index chunks + tasks for the doc, calls `DocumentService.run` (queues parse tasks). **If the doc was previously DONE, it first clears the old chunks** (`clear_chunk_num_when_rerun`, `progress_msg=""`, `chunk_num=0`, `token_num=0` — `document_api.py:1590-1596`), so re-parse is idempotent. Rejects nothing about UNSTART docs — works from any non-RUNNING state.

**Option 2 (the one documented in the HTTP API reference): `POST /api/v1/datasets/{dataset_id}/chunks`** — body `{"document_ids": [...]}`. Source: `api/apps/restful_apis/chunk_api.py:183-256`. Same effect (`run:"1"`, deletes existing index chunks, `queue_tasks(doc, bucket, name, 0)`); refuses only if the doc is currently RUNNING; rejected for pipeline datasets (`kb.pipeline_id` set) — those must use `POST /api/v1/documents/ingest`.

Live-verified with Option 1: `{"code":0,"data":{"success_count":1}}`, then polling showed `DONE, progress 1.0, chunk_count 1`.

### A3. Run status values & exposure

`TaskStatus` enum (`common/constants.py:90-97`): `UNSTART="0"`, `RUNNING="1"`, `CANCEL="2"`, `DONE="3"`, `FAIL="4"` (plus `SCHEDULE="5"` for pipelines).

Exposed on every document object returned by `GET /api/v1/datasets/{dataset_id}/documents` as `run` (text form via `_process_run_mapping` — `api/apps/services/document_api_service.py:287-310`), alongside `progress` (0.0–1.0 float), `progress_msg` (task log text), `chunk_count` (`chunk_num`), `token_count` (`token_num`) — key mapping in `document_api_service.py:257-284`; model defaults `run="0"`, `chunk_num=0`, `token_num=0` in `api/db/db_models.py` (Document, fields at ~lines 880-905).

Polling filter: the list endpoint accepts `run` as a repeated query param in either numeric (`0`-`4`) or text (`UNSTART`,`RUNNING`,`CANCEL`,`DONE`,`FAIL`) form — `document_api.py:964-970`, documented in `docs/references/http_api_reference.md:1740-1810`. Live-verified: `run:"UNSTART","progress":0.0,"progress_msg":"","chunk_count":0,"token_count":0` pre-parse; post-parse `run:"DONE","progress":1.0,"chunk_count":1,"token_count":49`, `progress_msg` ending in `"15:51:58 Page(1~100000001): Task done (1.00s)"`.

---

## B. Download

- The document object has **no `url` field** in v0.26.4 (live upload/list responses contain no `url`; source confirms `map_doc_keys` has no url mapping — `document_api_service.py:257-284`).
- Download mechanism: **`GET /api/v1/datasets/{dataset_id}/documents/{document_id}`** — streams the stored blob directly (`settings.STORAGE_IMPL.get(doc_id, doc_location)`) with `Content-Disposition: attachment`. **No run-status or chunk-count check anywhere in the handler** — it works in any parse state. Source: `api/apps/restful_apis/document_api.py:2089-2148` (dataset-scoped) and a tenant-scoped twin `GET /api/v1/documents/{document_id}` at `document_api.py:2151-2208`. Auth: the same Bearer key (no signed URLs, no public/expiring links).
- **Live-verified while unparsed (run=UNSTART, chunk_count=0):** `GET .../documents/015c622a...` → `HTTP 200`, `Content-Type: text/markdown; charset=utf-8`, `Content-Length: 160`, `content-disposition: attachment; filename=kb-smoke.md`, body byte-identical to the uploaded file.

---

## C. Un-parse / withdraw (the critical question)

Three candidate mechanisms, all examined in source and the promising ones live-tested:

### C1. `DELETE /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks` — chunk deletion only, NOT a withdraw
Body `{"chunk_ids":[...]}` or `{"delete_all":true}`. Source: `api/apps/restful_apis/chunk_api.py:931-985`. Deletes chunks from the doc-store index (condition `{"doc_id": id, "must_not": {"exists": "compile_kwd"}}` for delete_all — i.e. it preserves knowledge-graph/compilation chunks), deletes chunk images, decrements the doc's `chunk_num` (but **not** `token_num`), and **does not touch the `run` field**.

- **Live-verified:** after DONE (chunk_count 1), `DELETE .../chunks` `{"delete_all":true}` → `{"code":0}`; doc then reads `run:"DONE", progress:1.0, chunk_count:0, token_count:48`. So the doc is *not* unparsed — it is "parsed with zero chunks". Not a withdraw.

### C2. `PUT /api/v1/datasets/{dataset_id}/documents/{document_id}` with a different `chunk_method` — THE withdraw path (live-verified)
Changing `chunk_method` triggers `reset_document_for_reparse` (`api/apps/services/document_api_service.py:65-88, 92-149`), which:
- sets `run=UNSTART, progress=0, progress_msg=""` (and the new `parser_id`);
- deletes all chunks from the index (`docStoreConn.delete({"doc_id": doc.id}, ...)`) and decrements kb counts;
- deletes chunk images;
- **never touches `location`/the stored file**.

- **Live-verified (doc was DONE, chunk_count 1):** `PUT .../documents/015c622a...` with `{"chunk_method":"one"}` → `200`; doc reads `run:"UNSTART", progress:0.0, progress_msg:"", chunk_count:0, token_count:0, chunk_method:"one"`; `GET` download still returns the original 160 bytes. Round-trip re-parse works (`POST .../documents/parse` → `DONE, chunk_count:1`), and switching back `PUT {"chunk_method":"naive"}` withdraws again, re-parse → `DONE, chunk_count:1, token_count:49`.
- Constraints: the PUT is only acted on when the new `chunk_method` **differs** from the current one (`document_api_service.py:70`: `if doc.parser_id.lower() != req["chunk_method"].lower()`). Allowed values (validation set in `api/utils/validation_utils.py:493`): `naive, manual, qa, table, paper, book, laws, presentation, picture, one, knowledge_graph, email, tag`. So the app's withdraw must set a parser id different from the doc's current one and restore the desired one on publish. Alternatively `PUT {"pipeline_id": ...}` triggers the same reset (`document_api.py:276-278`) — only relevant for pipeline datasets.
- There is also a private-ish `PATCH /api/v1/datasets/{dataset_id}/documents/{document_id}` (`document_api.py:170-304`) with the same semantics for built-in chunking.

### C3. Cancel semantics — NOT a withdraw
- `DELETE /api/v1/datasets/{dataset_id}/chunks` (body `{"document_ids":[...]}`) — **only works while `run == RUNNING`** (`chunk_api.py:258-310`; error otherwise, live response text: "You can only stop parsing..." equivalent guard in source `DOC_STOP_PARSING_INVALID_STATE_MESSAGE`). Sets `run=CANCEL, progress=0, chunk_num=0` and deletes index chunks.
- `POST /api/v1/datasets/{dataset_id}/documents/stop` — same, requires RUNNING (`document_api.py:1621-1734`).
- `POST /api/v1/documents/ingest` with `{"doc_ids":[...], "run":"2"}` — cancel for pipeline datasets; `run:"1"` + `"delete":true` reruns and deletes prior tasks/chunks (`document_api.py:1431-1505`).
- Net: CANCEL exists only to abort an in-flight parse, not to remove parse data from a finished doc.

**Bottom line for C:** "return a parsed doc to unparsed while keeping the file" = PUT a different `chunk_method` (or `pipeline_id`). File survives (live-verified), doc returns to UNSTART/0 chunks (live-verified). Chunk deletion alone does not reset run status. There is no other supported path in v0.26.4.

---

## D. RAG outcome

- Retrieval only ever reads the chunk index: `POST /api/v1/retrieval` → `settings.retriever.retrieval(...)` (`api/apps/restful_apis/chunk_api.py:311-440`). The query is built in `rag/nlp/search.py:549-610` with `"available_int": 1` (line 588) and `kb_ids`/`doc_ids` — **there is no run-status or chunk-count filter and no per-document lookup**: docs with zero chunks in the index simply cannot match. The SDK retrieval endpoint has no run filter either.
- No code path in the endpoint, retriever, or dialog/chat search filters documents by `run` status before querying; nothing iterates unparsed docs, so they cause no errors, no wasted work, and no side effects.
- Chat assistants: same chunk-index path (`api/db/services/dialog_service.py` does no `run==DONE` filtering — the status-based exclusion is purely "no chunks in index").
- **Live-verified:** after withdrawing the parsed doc (UNSTART, 0 chunks), `POST /api/v1/retrieval` with `{"question":"ZEBRA-7Q-X42 unique marker","dataset_ids":["<test-dataset>"]}` → `{"code":0,"data":{"chunks":[],"doc_aggs":[],"total":0}}` — empty, no error.

---

## E. Sync mechanism (parse-completion notifications)

- **No dataset- or document-level webhook exists.** The HTTP API reference lists no webhook endpoints (fetched page, "Webhook configuration — None exists"). The only webhook in the codebase is agent-scoped: `POST/GET/PUT/PATCH/DELETE/HEAD /api/v1/agents/<agent_id>/webhook` (`api/apps/restful_apis/agent_api.py:1679-1684`) — unrelated to parse completion.
- The dataset object has no webhook config fields (live create-dataset response confirms: no webhook keys).
- **Supported pattern: polling** `GET /api/v1/datasets/{dataset_id}/documents` (optionally filtered `?run=RUNNING` / `run=UNSTART`) for `run`/`progress`/`progress_msg` to reach a terminal state (DONE/FAIL/CANCEL). This is also what the web UI does. Poll interval is a product decision; `progress` and `progress_msg` give incremental feedback.

---

## F. Limits & types

**File size / quotas (deployment-configurable env vars; defaults below are source defaults, not observable via API):**
- Request body limit `MAX_CONTENT_LENGTH` default **1 GiB** (`api/apps/__init__.py:81`), nginx `client_max_body_size 1024M` (`docker/nginx/nginx.conf:29`); docker `.env` documents "1GB file size limit" (`docker/.env:212-214`). This is the effective per-request upload cap; per-file cap is the same since one file per request. Neither value can be queried via API — confirm on the target deployment.
- Doc count: `MAX_FILE_NUM_PER_USER` env, default 0 = unlimited (`api/db/services/document_service.py:115-118`). Name length: 255 UTF-8 bytes.
- Parse concurrency: `MAX_CONCURRENT_TASKS` default **5**, `MAX_CONCURRENT_CHUNK_BUILDERS` default 1, `MAX_CONCURRENT_MINIO` default 10 (`rag/svr/task_executor_limiter.py:20-28`). Large PDFs are split into page-range tasks, xlsx into 3000-row tasks (`api/db/services/task_service.py:431-500`).
- No API-enforced per-dataset document quota found.

**Supported file suffixes** (`api/utils/file_utils.py:58-78`): pdf; msg, eml, doc, docx, ppt, pptx, yml, xml, htm, json, jsonl, ldjson, csv, txt, ini, xls, xlsx, wps, rtf, hlp, pages, numbers, key, md, mdx, py, js, java, c, cpp, h, php, go, ts, sh, cs, kt, html, sql, epub; audio wav/flac/ape/alac/wavpack/wv/mp3/aac/ogg/vorbis/opus; visual jpg/jpeg/png/tif/gif/pcx/tga/exif/fpx/svg/psd/cdr/pcd/dxf/ufo/eps/ai/raw/WMF/webp/avif/apng/icon/ico/mpg/mpeg/avi/rm/rmvb/mov/wmv/asf/dat/asx/wvx/mpe/mpa/mp4/mkv. Unknown types are rejected at upload (`FileType.OTHER` → "This type of file has not been supported yet!" — `file_service.py:556-558`).

**Parser ids (`chunk_method`)** — `ParserType` enum (`common/constants.py:107-125`): `presentation, laws, manual, paper, resume, book, qa, table, naive, picture, one, audio, email, knowledge_graph, tag`. For document PUT, the allowed set is `{naive, manual, qa, table, paper, book, laws, presentation, picture, one, knowledge_graph, email, tag}` (`validation_utils.py:493`). For the common cases: markdown/txt → `naive` (or `one`, `qa`, `knowledge_graph`, `manual`); pdf → `naive/paper/book/laws/manual/qa/one/knowledge_graph/tag`; docx/xlsx/pptx → `naive/table/qa/one/knowledge_graph` (pptx defaults to `presentation` on upload); images → `picture`; audio → `audio`.

---

## Live test log (exact requests → responses, condensed)

All against `http://101.132.20.133` with `Authorization: Bearer ragflow-VX1PrEJDHuu6UPzxvLQqRruVyzQjyYGhGaOHCvtrl0c`. Test dataset `ff1fc52e92fd11f181a2493b86811cba` (name `kb-app-smoke-test`, `chunk_method: naive`).

1. `GET /api/v1/system/version` → `{"code":0,"data":"v0.26.4"}` — deployed version matches local source.
2. `POST /api/v1/datasets` `{"name":"kb-app-smoke-test","chunk_method":"naive"}` → `{"code":0,"data":{...,"id":"ff1fc52e92fd11f181a2493b86811cba",...}}`.
3. `POST /api/v1/datasets/ff1fc.../documents` `-F file=@kb-smoke.md -F run=false` → `{"code":0,"data":[{...,"id":"015c622a92fe11f181a2493b86811cba","run":"UNSTART","size":160,"location":"kb-smoke.md","chunk_method":"naive"}]}`. List: `run:"UNSTART", progress:0.0, progress_msg:"", chunk_count:0, token_count:0`.
4. `GET .../documents/015c622a...` (unparsed) → HTTP 200, `text/markdown`, `Content-Length:160`, exact original bytes.
5. `POST /api/v1/datasets/ff1fc.../documents/parse` `{"document_ids":["015c622a..."]}` → `{"code":0,"data":{"success_count":1}}`. Poll (3-4s cadence) → `DONE 1.0 1` (`chunk_count:1, token_count:49`, progress_msg "Task done (1.00s)").
6. `GET .../documents/015c622a.../chunks?page_size=10` → `{"total":1}` with the expected chunk content.
7. `DELETE .../documents/015c622a.../chunks` `{"delete_all":true}` → `{"code":0}`; doc now `run:"DONE", chunk_count:0, token_count:48` — **chunk deletion does not un-parse**.
8. `PUT .../documents/015c622a...` `{"chunk_method":"one"}` → `200`; doc now `run:"UNSTART", progress:0.0, progress_msg:"", chunk_count:0, token_count:0, chunk_method:"one"`; download still returns 160 bytes — **withdraw works, file survives**.
9. `POST .../documents/parse` again → `success_count:1`; poll → `DONE, chunk_count:1` (chunk_method "one").
10. `PUT .../documents/015c622a...` `{"chunk_method":"naive"}` → `200`; doc `UNSTART, 0/0`; parse → `DONE, chunk_count:1, token_count:49` — full round-trip.
11. `PUT {"chunk_method":"one"}` (withdraw) then `POST /api/v1/retrieval` `{"question":"ZEBRA-7Q-X42 unique marker","dataset_ids":["ff1fc..."]}` → `{"code":0,"data":{"chunks":[],"doc_aggs":[],"total":0}}` — unparsed doc contributes nothing, no error.
12. `DELETE /api/v1/datasets` `{"ids":["ff1fc52e92fd11f181a2493b86811cba"]}` → `{"code":0,"data":{"success_count":1}}`; `GET /api/v1/datasets?name=kb-app-smoke-test` → 0 matches. **Cleanup succeeded.**

---

## Design implications (facts only)

- Upload is unparsed-by-default in v0.26.4; the `run:false` in the proposal is harmless but unnecessary on this version (and ignored).
- Publish = `POST /api/v1/datasets/{id}/documents/parse` (or `POST .../chunks`) with `document_ids`; poll `GET .../documents?run=RUNNING` for `DONE/FAIL`.
- Withdraw = `PUT /api/v1/datasets/{id}/documents/{doc_id}` with a `chunk_method` different from current (set to, e.g., `"one"` or the doc's other parser), which resets to UNSTART and purges chunks/images while keeping the file. Re-publish must PUT the desired `chunk_method` back before parsing (that PUT also resets, so order: PUT parser → POST parse).
- If you need "withdraw without changing parser id": not available — the same-parser PUT is a no-op. (A future enhancement request could be to make `reset_document_for_reparse` reachable explicitly.)
- No webhooks; polling is the only completion signal.
- File identity/round-trip integrity: `content_hash` (xxhash128 of bytes) is stored per doc (`file_service.py:601-604`) and can be used to verify byte-integrity after download.
- Deployed-instance check needed at integration time: upload body limit (1 GiB default) and `MAX_CONCURRENT_TASKS` (5 default) are env-config on the server and not API-visible; also verify the deployed version stays ≥ v0.26.4 (older versions had a `run` param on upload and different endpoint semantics).
