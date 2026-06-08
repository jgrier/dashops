import * as restate from "@restatedev/restate-sdk";
import { session } from "./session.js";

const port = parseInt(process.env.PORT ?? "9083", 10);
restate.serve({ services: [session], port });
console.log(`Ops-agent (Session VO) listening on :${port}`);
