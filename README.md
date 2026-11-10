# FlowMap

See how data moves through your whole system: **React screen → API call → backend endpoint → other services → database**, across as many repos as you have. Then ask questions about it in plain language, answered by a free local model running in **Ollama**.

Nothing leaves your machine. There is nothing to install besides Node.js and Ollama (no `npm install`).

## Quick start (2 minutes)

You need [Node.js 18+](https://nodejs.org) and, for chat, [Ollama](https://ollama.com).

```bash
# 1. one time: download a model for the chat
ollama pull qwen2.5-coder:7b

# 2. run FlowMap (from this folder)
node flowmap.js
```

Your browser opens at **http://localhost:4321** showing the bundled example (a React shop, an Express order service and a FastAPI inventory service). Click around, then point it at your own code.

## Use it on your own repos

Open `flowmap.config.json` and list your repo folders:

```json
{
  "repos": [
    "E:/work/my-react-app",
    "E:/work/order-service",
    "E:/work/payment-service"
  ],
  "ollama": { "url": "http://localhost:11434", "model": "qwen2.5-coder:7b" },
  "port": 4321
}
```

Then run `node flowmap.js` again (or press **Rescan** in the page).

- On Windows, write paths with forward slashes (`E:/work/app`), or double the backslashes (`E:\\work\\app`).
- All repos in one parent folder? Use `"E:/work/*"` and every sub-folder is treated as a repo.
- To give a repo a nicer name: `{ "name": "orders", "path": "E:/work/order-service" }`.
- Or skip the config: `node flowmap.js E:/work/my-react-app E:/work/order-service`

## Using the page

| You want to… | Do this |
|---|---|
| See the full flow of something | Click its box. The whole path, upstream and downstream, lights up. |
| Know what data is sent | Click an **API call** box: the right panel shows the URL, the body it sends, the response type, the related types and the code. |
| Know what an endpoint does | Click it, then **Explain with Ollama**. |
| Find something | Type in the search box and press Enter. |
| Hide noise | Click a repo chip to hide that repo, or tick **Connected only**. |
| Ask a question | Open the **Chat** tab. If a box is selected, the question is about that box. |

Reading the map, left to right:

- **UI / caller** (purple): the component or function that starts the request
- **API call** (orange): the HTTP request in the code, with its method and path
- **Endpoint** (green): the backend route that receives it
- **Data** (blue): the model or table the endpoint reads or writes
- **Dashed red border**: an API call with no matching endpoint in the scanned repos (an external API, a repo you did not list, or a URL built at runtime)

Good questions for the chat:

- "Explain the full flow when a user places an order"
- "What fields and types does the checkout page send?"
- "Which services talk to inventory-service?"
- "Where is the Order model written?"

Answers end with chips for the items the model used. Click one to jump to it on the map.

## How it works

1. **Scan (no AI).** FlowMap reads the source files and finds, by pattern matching:
   - outgoing HTTP calls: `fetch`, `axios` (including `axios.create` instances and base URLs), Angular `HttpClient`, Python `requests`/`httpx`, Spring `RestTemplate`/`WebClient`/Feign, Go `net/http`
   - backend routes: Express/Fastify-style routers (with `app.use('/prefix', router)`), NestJS, FastAPI, Flask, Spring MVC, Gin/Echo/Chi
   - data: Mongoose, Sequelize, TypeORM, Prisma, SQLAlchemy/Django-style models, JPA entities, GORM, and tables named in raw SQL
   - types: TypeScript interfaces/types, zod/Joi schemas, Pydantic and other Python classes, Java/Kotlin classes and records, Go structs
2. **Connect.** Each call is matched to an endpoint by HTTP method and path (`/orders/${id}` matches `/orders/:id`). Base URLs, ports and service names are used to pick the right service.
3. **Chat.** For each question, only the relevant pieces of the map (connections, code snippets, types) are sent to Ollama. The model explains; it does not guess the structure.

The result is also saved to `.flowmap/graph.json` if you want to use it elsewhere.

## Options

```bash
node flowmap.js --port 5000          # use another port
node flowmap.js --model llama3.1     # use another Ollama model (any model you have pulled)
node flowmap.js --no-open            # do not open the browser
node flowmap.js scan                 # only scan and write .flowmap/graph.json
```

You can also switch between installed models in the dropdown under the chat box. Smaller models (for example `qwen2.5-coder:3b`) answer faster on a laptop without a GPU; larger ones give better answers.

## Limits to know about

- The scan is pattern-based, so it finds the common ways of writing routes and calls, not every possible one. URLs built entirely at runtime, GraphQL, gRPC, message queues (Kafka, RabbitMQ) and RTK Query endpoints are not mapped yet.
- A call is linked to a UI component by following function calls inside the repo. Very indirect wiring (for example through a Redux saga) may show the helper function instead of the screen.
- Test files and folders such as `node_modules`, `dist`, `build` and `venv` are skipped.
- Chat answers come from a small local model. They are grounded in the extracted code, but check the linked file and line for anything important.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Ollama offline" in the top right | Start the Ollama app, or run `ollama serve`. The map works without it. |
| "Ollama does not have the model…" | Run `ollama pull qwen2.5-coder:7b`, or pick an installed model in the dropdown. |
| A repo shows "not found" | Check the path in `flowmap.config.json`. |
| A call has a dashed red border | Its service is not in the config, or the base URL could not be read. Adding a `.env` file with the base URL (for example `REACT_APP_API_URL=http://localhost:4000/api`) helps. |
| Port already in use | `node flowmap.js --port 4322` |

## Project layout

```
flowmap.js            start here: scans, then serves the page
flowmap.config.json   your repos and Ollama settings
src/scan.js           builds the graph and matches calls to endpoints
src/extract.js        per-language pattern matching
src/urls.js           turns URL expressions in code into comparable paths
src/chat.js           picks context for a question and talks to Ollama
public/               the page (plain HTML, CSS and JS)
example/              three tiny repos to try it on
```
