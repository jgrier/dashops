// Customer-domain mock data. Owned by customer-svc; delivery-svc only carries
// customer IDs across the boundary.

export interface Customer {
  customerId: string;
  name: string;
  email: string;
  phone: string;
  loyaltyTier: "standard" | "gold" | "platinum";
  recentOrderCount: number;
}

const customers: Record<string, Customer> = {
  "C-901": {
    customerId: "C-901",
    name: "Aiyana Patel",
    email: "aiyana.p@example.com",
    phone: "415-555-0142",
    loyaltyTier: "gold",
    recentOrderCount: 23,
  },
  "C-712": {
    customerId: "C-712",
    name: "Marcus Webb",
    email: "marcus.webb@example.com",
    phone: "415-555-0188",
    loyaltyTier: "standard",
    recentOrderCount: 4,
  },
  "C-555": {
    customerId: "C-555",
    name: "Hira Nasir",
    email: "hira.n@example.com",
    phone: "415-555-0205",
    loyaltyTier: "platinum",
    recentOrderCount: 61,
  },
};

export function getCustomer(id: string): Customer | null {
  return customers[id] ?? null;
}
