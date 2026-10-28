import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, (info) => console.log(`cx-agent-context-lab API on http://localhost:${info.port}`));
