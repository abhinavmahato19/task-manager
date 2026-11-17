# GlassTask Manager + IBM Cloudant

The page still handles the form, filters, progress, and dark mode. Task records are stored in IBM Cloudant. A small Node.js server in this folder is the only thing that talks to Cloudant, so the API key never goes into the browser.

## 1. Create Cloudant on IBM Cloud

1. Sign in at [https://cloud.ibm.com](https://cloud.ibm.com). A Lite account is enough.
2. Open the catalog, search **Cloudant**, choose the **Lite** plan, and create an instance (for example `glasstask-cloudant`). Any nearby region is fine.
3. Open that instance, go to **Service credentials**, and create a credential with the **Manager** role.
4. From the credential JSON, copy only `apikey` and `url`. The URL looks like `https://<account>.cloudantnosqldb.appdomain.cloud`.

Do not paste that JSON into `index.html`, GitHub, or a chat. It belongs only in a local `.env` file.

You do not need to create the database by hand. On startup the server creates a database named `tasks` if it is missing.

## 2. Configure and run

Install Node.js 22 or 24 (the Cloudant SDK's supported lines). Node 25 can load the SDK, but if `npm start` fails on it, switch to Node 22. Then in this folder:

```bash
npm install
copy .env.example .env
```

Edit `.env` and set `CLOUDANT_URL` and `CLOUDANT_APIKEY` from the credential JSON. Leave `CLOUDANT_DB` as `tasks` unless you want a different database name.

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## 3. Check that Cloudant has the tasks

1. Add a task, mark one complete, delete one, then refresh the page. The list should come back from Cloudant.
2. In the IBM Cloud Cloudant dashboard, open the `tasks` database. The same documents should be there. Each document has `type`, `text`, `dueDate`, `priority`, `completed`, and `createdAt`.

If this browser already had tasks in `localStorage`, the first successful load copies them into Cloudant once, then removes that `tasks` key so they are not imported again.

Dark mode still uses `localStorage`. It is only a display preference.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Create a task (`text`, `dueDate`, `priority`) |
| PATCH | `/api/tasks/:id` | Flip completed |
| DELETE | `/api/tasks/:id` | Delete a task |

GitHub Pages only publishes the static files. API calls from that URL will fail because Pages does not run this Node server. Use `npm start` for the demo.
