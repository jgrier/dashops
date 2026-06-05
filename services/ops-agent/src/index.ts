import * as restate from "@restatedev/restate-sdk";
import { session } from "./session.js";
import { startWebBridge } from "./web.js";

const port = parseInt(process.env.PORT ?? "9083", 10);
const webPort = parseInt(process.env.WEB_PORT ?? "3000", 10);

restate.serve({ services: [session], port });
console.log(`Ops-agent (Session VO) listening on :${port}`);

startWebBridge(webPort);
