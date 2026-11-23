# PizzaHub Server — Agent Memory File
> Express ESM + MongoDB + Stripe backend service for PizzaHub.

## Architecture & Authentication
- Framework: Express ESM, MongoDB Native Driver, Stripe SDK.
- Auth: Tokens resolved via `session` collection; `getUserFromToken`, `verifyToken`, `verifyRole("admin" | "vendor" | "customer")`.
- Helper `isPremiumActive(user)`: checks `premium: true` and non-expired `subscriptionExpiresAt`; auto-downgrades expired accounts to free.

## Core Rules & Endpoints
- **Premium Subscription**: Activated strictly via verified Stripe webhook `POST /payments/webhook` (`checkout.session.completed` with `payment_status === "paid"`). Premium lasts 1 year (renewals extend from max(expiry, now)). On `charge.refunded`, transaction marked refunded and user downgraded.
- **Transactions Collection**: Replaces payments. Fields: `vendorId`, `plan`, `amount` (cents), `currency`, `stripeSessionId` (unique index), `stripeSubscriptionId`, `paymentIntentId`, `status`, `createdAt`. Read-only admin endpoint `GET /transactions`.
- **Menu Items**:
  - `GET /items`: public approved items with `q` (regex on name/desc/location/vendor), `category`, `location`, `sort` (`price_asc`, `price_desc`, newest), `vendorId`; batch-enriches with `vendorPremium`.
  - `GET /items/locations`: distinct locations of approved items.
  - `PATCH /items/:id/availability`: vendor toggles between `approved` and `inactive` (checks free plan limit on reactivation).
  - `PATCH /items/:id/status`: admin updates status (`pending`, `approved`, `rejected`, `inactive`).
  - Free limit: max 3 active items (status `pending` or `approved`).
- **Orders**: `POST /order` validates `deliveryDate` (stored as Date, today or later), `deliveryAddress`, and `message` (max 500). Prevents self-ordering (403) and same-day duplicate items for customer (409). DB filters enforce ownership on updates/cancellations.
