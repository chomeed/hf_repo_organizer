# HF Organizer

Organize your Hugging Face repositories into **real Hugging Face Collections**, using
drag-and-drop the way you would in Google Drive.

- Imports every model, dataset and Space owned by **`chomeed`** (configurable), following pagination.
- Imports your existing Collections (title, slug, description, visibility and full item lists).
- Drag cards onto collections, multi-select (⌘/Ctrl-click, Shift-click, ⌘/Ctrl+A), bulk add and remove.
- Every change is **staged locally** and undoable. Nothing touches Hugging Face until you review it in
  **Sync** and confirm.
- Includes a fully working **demo mode** with clearly labelled fictional data.

```
hf-organizer/
├── index.html      # app shell (markup)
├── styles.css      # design system, light/dark themes, responsive layout
├── app.js          # client: state, staging, drag & drop, sync engine, demo data
├── server.js       # local Node proxy: static files + authenticated Hub API
├── package.json
├── .env.example
├── test/
│   ├── mock-hub.js      # in-memory imitation of the Hub endpoints used
│   └── server.test.js   # proxy tests (node --test)
└── README.md
```

## Quick start

Requirements: **Node.js 18.17+** (it uses the built-in `fetch`; there are no runtime npm dependencies
besides the two front-end libraries, which also load from a CDN).

```bash
npm install          # installs lucide + sortablejs (served locally if the CDN is blocked)
cp .env.example .env # optional: set HF_TOKEN here
npm start            # → http://localhost:5173
```

Open <http://localhost:5173>. If no token is configured, a connection screen appears. You can paste a
token there or choose **Use demo mode**.

> You can also open `index.html` directly from disk for a backend-free demo. Hugging Face integration
> needs the local server.

## Demo mode

Demo mode starts automatically when the app isn't connected. It loads 46 **fictional**
repositories, such as `chomeed/llama-finetune`, `chomeed/yolo-detection` and
`chomeed/stable-diffusion-demo`, plus five sample collections (LLMs, Computer Vision, Audio, Datasets
and Experiments). A banner, the `Demo` pill and the details panel all say clearly that this data is
not real.

Everything works in demo mode: search, filters, sorting, multi-select, drag-and-drop, creating, editing
and deleting collections, undo, and the sync review. **Apply in demo** only marks changes as synced in
your browser. Demo mode never makes a request to Hugging Face. Use **Reset demo** to start over.

## Connecting to Hugging Face

1. Create a **fine-grained** token at <https://huggingface.co/settings/tokens>.
2. Under **User permissions**, enable:
   - **Collections → Write access to all collections.** Needed to create, edit and delete
     collections and to add or remove items.
   - **Repositories → Read access to contents of all repos.** Needed to include *private*
     repositories in the import.
   - A classic **write** token also works. A **read** token can import but can't sync.
3. Either put it in `.env` as `HF_TOKEN=hf_…` and restart, or paste it on the connection screen.

After connecting, the account dialog (click the avatar) shows which permissions the app detected.
Detection is best effort: the Hub has the final say, and a missing permission appears as a clear
per-operation `403` error during sync.

### Environment variables

| Variable        | Default                  | Purpose |
|-----------------|--------------------------|---------|
| `HF_USERNAME`   | `chomeed`                | Account whose repositories are imported. |
| `HF_TOKEN`      | –                        | Optional access token. Otherwise use the connection screen. |
| `HOST`          | `127.0.0.1`              | Bind address. Keep it local. |
| `PORT`          | `5173`                   | HTTP port. |
| `HF_ENDPOINT`   | `https://huggingface.co` | Hub endpoint (mirror or the mock Hub for testing). |
| `ALLOWED_HOSTS` | –                        | Extra `Host` header values to accept (reverse-proxy setups). |

Collections are read from, and created in, the namespace of the **token's user**. Repositories are
listed for `HF_USERNAME`.

## Security model

- The browser never sees the token. It goes to the local server once (or comes from `.env`), stays in
  server memory, and is never written to disk, returned in responses or printed in logs. Error
  messages are scrubbed of anything that looks like a token.
- Nothing is stored in `localStorage` except UI preferences and your **staged changes** (no
  credentials).
- The server listens on `127.0.0.1` and checks the `Host` header, which blocks DNS rebinding. It also
  requires an `X-HF-Organizer` header and a same-origin `Origin`, which blocks CSRF from other
  websites. It sends a strict Content-Security-Policy.
- Only a small, validated set of Hub calls is proxied: repo IDs, slugs and item IDs are
  pattern-checked. Writes are allowed only in namespaces owned by the token's user or their
  organizations.
- Only the listed front-end files are served; `.env`, `server.js` and the rest are not reachable.

## How staging and sync work

The client keeps two copies of your collections:

- **baseline**: exactly what was last imported from Hugging Face.
- **working**: what you see. Every drag, bulk action, edit or deletion changes only this copy and
  can be undone (⌘/Ctrl+Z, or the **Undo** button on each toast).

The pending changes are always the *difference* between the two. The Sync button shows how many
there are, sidebar collections with unsynced changes get an amber dot, and staged chips are dashed.
Staged changes are saved in the browser, so a reload or crash doesn't lose them. They are
re-applied after every **Refresh**.

Dragging a repository into a collection **adds** it. It is never removed from its other collections;
a repository can belong to as many collections as you like.

When you press **Sync**:

1. **Review.** Every pending change is listed, grouped by collection (`+ Create`, `~ Update`,
   `+ Add`, `− Remove`, `× Delete`).
2. **Conflict check.** Each affected collection is re-fetched from the Hub before anything is
   written:
   - An add that is already on the Hub, or a remove that is already gone, is marked
     *already on Hub* and skipped. This prevents duplicates.
   - A title or description that changed remotely **and** locally is a *conflict*. It is skipped
     and stays staged until you **Refresh and rebase** and review it.
   - Deleting a collection that changed on the Hub after you loaded it is **blocked**.
   - A collection that no longer exists is reported as a conflict.
3. **Deletion protection.** Deleting a collection needs a confirmation when you stage it *and* a
   separate "I understand" checkbox in the sync dialog. Without the checkbox, the deletion stays
   staged and isn't sent.
4. **Execute.** The order is creates → metadata updates → adds → removes → deletes. A progress bar
   and per-change status are shown. Adds into a collection whose creation failed are reported as
   *skipped*, not attempted.
5. **Report.** Successes, failures (with the Hub's error message), skipped items and items kept
   staged are listed separately. Collections are then re-imported. Anything that didn't succeed
   stays staged, ready for **Retry failed**.

Sync never runs automatically.

## Hugging Face API usage

The endpoints were checked against the official `huggingface_hub` client (`HfApi` collection
methods and the `paginate` helper):

| Operation | Endpoint |
|---|---|
| Who am I / token permissions | `GET /api/whoami-v2` |
| List repositories | `GET /api/{models,datasets,spaces}?author=…&limit=100&expand=…` (Link-header pagination) |
| List collections | `GET /api/collections?owner=…` (items truncated to 4, so each one is then fetched in full) |
| Get collection | `GET /api/collections/{slug}` |
| Create collection | `POST /api/collections` `{title, namespace, description?, private}` |
| Update metadata | `PATCH /api/collections/{slug}` `{title?, description?, private?}` |
| Delete collection | `DELETE /api/collections/{slug}` |
| Add item | `POST /api/collections/{slug}/items` `{item: {type, id}}` (`409` = already present) |
| Remove item | `DELETE /api/collections/{slug}/items/{item_object_id}` |

Notes and limits:

- **Items you don't own are preserved.** Papers, other users' repos and nested collections inside
  your collections are never removed. The collection view mentions them, for example "+1 item not
  owned by chomeed".
- **Descriptions** are limited to 150 characters by the Hub. The form enforces this.
- **Not supported by this app:** reordering items, editing item notes, and collection themes. The
  API supports them, but they are outside this tool's scope and are left untouched. There are no
  batch endpoints, so each add or remove is a separate request (run with limited concurrency).
- Hub-side limits, such as maximum items per collection or rate limits, appear as per-operation
  errors and are never hidden.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `Esc` | Close menu or modal → clear search → close details → clear selection |
| `⌘/Ctrl + A` | Select all visible repositories |
| `⌘/Ctrl + Z` | Undo the most recent staged operation |
| Arrow keys | Move between cards (with `Shift` to extend the selection) |
| `Space` / `Enter` | Toggle selection / open details |
| `Shift+F10` / Menu key | Context menu for the focused card or collection |
| `F2` / `Delete` on a collection | Rename / delete |

## Responsive behaviour

- **Desktop:** full sidebar, multi-column grid or list view, full toolbar, docked details panel.
- **Tablet (≤1024px):** collapsible sidebar drawer and a two-column grid.
- **Mobile (≤640px):** drawer navigation, single-column cards, larger touch targets, and a
  bottom-sheet **collection picker** (folder button on each card, or the bulk bar) in place of
  drag-and-drop.

## Development and tests

```bash
npm test                         # proxy tests against the in-memory mock Hub
node test/mock-hub.js            # run the mock Hub on :7860 (token printed on start)
HF_ENDPOINT=http://127.0.0.1:7860 npm start
```

The mock Hub copies the response shapes, pagination and error codes the app relies on. It lets you
try the full connected flow, including failures (a collection titled `FAIL` can't be created), with
no real account.
