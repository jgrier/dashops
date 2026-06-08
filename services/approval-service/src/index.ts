import * as restate from "@restatedev/restate-sdk";
import { approvalService } from "./approval.js";
import { pendingApprovalsIndex } from "./pending-index.js";
import { decidedApprovalsIndex } from "./decided-index.js";

const port = parseInt(process.env.PORT ?? "9085", 10);

restate.serve({
  services: [approvalService, pendingApprovalsIndex, decidedApprovalsIndex],
  port,
});
console.log(
  `Approval-service (ApprovalService, PendingApprovalsIndex, DecidedApprovalsIndex) listening on :${port}`
);
