// Delivery-domain mock data. Same delivery_id always returns the same record
// so calls are reproducible without a database. Customer-side data lives in
// customer-svc; we only carry IDs across the boundary.

export interface Delivery {
  deliveryId: string;
  customerId: string;
  merchantId: string;
  driverId: string;
  status: "delivered" | "cancelled" | "in_progress";
  scheduledAt: string;
  completedAt?: string;
  issues: string[];
  totalCents: number;
}

export interface EscalationEntry {
  ts: string;
  channel: "chat" | "phone" | "email";
  category: string;
  resolution: string;
  satisfaction?: 1 | 2 | 3 | 4 | 5;
}

const deliveries: Record<string, Delivery> = {
  "12345": {
    deliveryId: "12345",
    customerId: "C-901",
    merchantId: "M-44",
    driverId: "D-1108",
    status: "delivered",
    scheduledAt: "2026-06-04T18:10:00Z",
    completedAt: "2026-06-04T19:42:00Z",
    issues: ["arrived_late", "items_missing", "spilled"],
    totalCents: 4250,
  },
  "12346": {
    deliveryId: "12346",
    customerId: "C-712",
    merchantId: "M-08",
    driverId: "D-2210",
    status: "delivered",
    scheduledAt: "2026-06-04T19:00:00Z",
    completedAt: "2026-06-04T19:31:00Z",
    issues: [],
    totalCents: 2890,
  },
  "12399": {
    deliveryId: "12399",
    customerId: "C-555",
    merchantId: "M-21",
    driverId: "D-9001",
    status: "delivered",
    scheduledAt: "2026-06-04T20:15:00Z",
    completedAt: "2026-06-04T21:07:00Z",
    issues: ["cold_food", "wrong_address_attempted"],
    totalCents: 3175,
  },
};

const escalations: Record<string, EscalationEntry[]> = {
  "12345": [
    {
      ts: "2026-06-04T19:48:00Z",
      channel: "chat",
      category: "items_missing",
      resolution: "agent apologized, no credit issued",
      satisfaction: 1,
    },
    {
      ts: "2026-06-04T20:14:00Z",
      channel: "phone",
      category: "spilled",
      resolution: "escalated to tier-2, no resolution recorded",
      satisfaction: 2,
    },
    {
      ts: "2026-06-04T20:51:00Z",
      channel: "chat",
      category: "follow_up",
      resolution: "customer hung up frustrated",
      satisfaction: 1,
    },
  ],
  "12399": [
    {
      ts: "2026-06-04T21:15:00Z",
      channel: "chat",
      category: "cold_food",
      resolution: "agent offered 10% off next order; customer rejected as insufficient",
      satisfaction: 2,
    },
  ],
};

export function getDelivery(id: string): Delivery | null {
  return deliveries[id] ?? null;
}

export function getEscalations(deliveryId: string): EscalationEntry[] {
  return escalations[deliveryId] ?? [];
}
