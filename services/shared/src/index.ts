// Shared types across DashOps services.

export interface CallerIdentity {
  tenantId: string;
  userId: string;
  agentId: string;
  sessionId: string;
  traceId: string;
}

export interface CallToolRequest {
  toolName: string;
  params: Record<string, unknown>;
  identity: CallerIdentity;
  // Set on the retry call after an approval has been granted. Gateway
  // verifies this against the ApprovalService and skips the policy check.
  approvalToken?: string;
  // Set on appeal-retry: middleware names to skip for this call (verified
  // by gateway against the appeal record). Populated by ops-agent after
  // an approver grants an appeal of a previously-blocked call.
  bypassMiddlewares?: string[];
  // Token corresponding to bypassMiddlewares — proves the appeal was
  // granted. Gateway verifies via ApprovalService.
  appealToken?: string;
}

export interface CallToolResponse {
  status: "ok" | "needs_approval" | "blocked";
  toolName: string;
  result?: unknown;
  costCents?: number;
  // populated when status === "needs_approval" (Phase 3)
  approval?: ApprovalDirective;
  // populated when status === "blocked"  (Phase 2)
  blocked?: BlockedReason;
}

export interface ApprovalDirective {
  approverGroup: string;
  actionSummary: string;
  actionFingerprint: string;
}

export interface BlockedReason {
  source: string;
  message: string;
  details?: unknown;
  // Populated when this block can be appealed to a human reviewer.
  // The operator UI surfaces a "request human review" button when this is set.
  appeal?: {
    approverGroup: string;
    summaryHint: string;
    middlewareName: string;     // which middleware blocked; appeal grants bypass for this one only
    actionFingerprint: string;  // binds the appeal to this exact call
  };
}

export interface ToolRegistration {
  name: string;                          // e.g. "delivery_lookup"
  serviceName: string;                   // Restate service name, e.g. "DeliveryLookup"
  handlerName: string;                   // handler on that service (default "execute")
  configuredCostCents: number;
  description: string;
  rateLimit?: { perMinute: number };     // hint for Phase 4
}

export interface ToolPayload {
  params: Record<string, unknown>;
  identity: CallerIdentity;
}

export interface ToolResult {
  result: unknown;
  costCents?: number;     // tool self-reports cost when known
}

// ----- Session (agent <-> UI contract) ---------------------------------------

export type SessionStatus =
  | "idle"
  | "thinking"
  | "calling_tool"
  | "needs_approval"
  | "blocked_appealable"
  | "appeal_pending"
  | "complete"
  | "failed";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
  toolResult?: unknown;
  costCents?: number;
  timestampMs: number;
}

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  messages: SessionMessage[];
  // populated when status === "needs_approval" (Phase 3)
  pendingApproval?: {
    approvalId: string;
    actionSummary: string;
    approverGroup: string;
    toolName: string;
  };
  // populated when status === "blocked_appealable" — the call params kept
  // around so the operator can escalate after the fact.
  pendingAppeal?: {
    toolName: string;
    params: Record<string, unknown>;
    blockSource: string;       // which middleware blocked
    blockReason: string;
    approverGroup: string;
    summaryHint: string;
    actionFingerprint: string;
  };
  failureReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

// ----- Approval service contracts --------------------------------------------

export interface ApprovalRequestPayload {
  awakeableId: string;
  approverGroup: string;
  actionSummary: string;
  actionFingerprint: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  initiator: CallerIdentity;
  // "approval" = standard policy-gated action. "appeal" = operator-requested
  // override of a previously-blocked guardrail. Approver UI displays them
  // differently. Verification flow is identical.
  kind?: "approval" | "appeal";
  // For kind="appeal": which middleware's block this appeal grants bypass for.
  appealBypassMiddleware?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  comment?: string;
  approverUserId?: string;
}

export interface ApprovalRecord {
  approvalId: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "timeout";
  approverGroup: string;
  actionSummary: string;
  actionFingerprint: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  initiator: CallerIdentity;
  decision?: ApprovalDecision;
  createdAtMs: number;
  decidedAtMs?: number;
}

export interface PendingApprovalSummary {
  approvalId: string;
  actionSummary: string;
  initiator: { userId: string; sessionId: string };
  createdAtMs: number;
  toolName: string;
  kind?: "approval" | "appeal";
}
