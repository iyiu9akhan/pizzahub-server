# PizzaHub Server
 
REST API for **PizzaHub**, a role-based pizza ordering and delivery platform. The server handles menu items, orders, reviews, wishlists, dashboard statistics, user moderation, and the Stripe webhook that activates vendor Premium subscriptions.
 
## Table of Contents
 
- [Links](#links)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [System Overview](#system-overview)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Demo Accounts](#demo-accounts)
- [Authentication and Authorization](#authentication-and-authorization)
- [Challenge Implementation](#challenge-implementation)
- [Business Rules](#business-rules)
- [Premium Subscription and Stripe Webhook](#premium-subscription-and-stripe-webhook)
- [Deployment](#deployment)
- [Author](#author)

## Links
 
| Resource | URL |
|---|---|
| Live Website | https://iyiu9akhan-pizzahub.vercel.app/ |
| Live Server | https://iyiu9akhan-pizzahub-server.vercel.app |
| Client Repository | https://github.com/iyiu9akhan/pizzahub |
| Server Repository | https://github.com/iyiu9akhan/pizzahub-server |

## Demo Accounts
 
Use these accounts to test protected routes. Sign in through the [live website](https://iyiu9akhan-pizzahub.vercel.app/) or a local client. All demo accounts share the same password: `Pa$$w0rd!`
 
**Vendors**
 
| Restaurant | Email |
|---|---|
| Dhaka Pizza Co. | dhakapizza@gmail.com |
| Sultan's Pizza Kitchen | sultanpizzakitchen@gmail.com |
| Old Town Pizza House | oldtownpizzahouse@gmail.com |
| Chittagong Pizza Corner | chittagongpizzacorner@gmail.com |
 
**Customers**
 
| Name | Email |
|---|---|
| Mahin Rahman | mahin.rahman@gmail.com |
| Farzana Ahmed | farzana.ahmed@gmail.com |
| Sakib Hasan | sakib.hasan@gmail.com |
| Tasmia Islam | tasmia.islam@gmail.com |
| Tanvir Ahmed  | tanvir.ahmed@example.com |
 
## Features
 
- Role-based access control for Admin, Vendor, and Customer, enforced on the server
- Bearer token verification middleware with `401` and `403` responses
- Menu item management with admin moderation (`pending`, `approved`, `rejected`, `inactive`)
- Server-side search, category and location filters, and price sorting
- Order management with duplicate order prevention
- Free plan limit (3 active items) and unlimited Premium plan per vendor
- Premium activated only after a verified Stripe webhook event
- Read-only transaction history for admins
- Reviews, wishlist, and role-specific dashboard statistics

## Tech Stack
 
| Area | Technology |
|---|---|
| Runtime and framework | Node.js (ES modules), Express 5 |
| Database | MongoDB (native `mongodb` driver) |
| Payments | Stripe |
| Utilities | `cors`, `dotenv` |
| Deployment | Vercel |
 
## System Overview
 
PizzaHub is split into a client and a server that share one MongoDB database.
 
| Part | Responsibility |
|---|---|
| **Client** (Next.js) | UI, Better Auth (email/password and Google OAuth), image uploads via ImgBB, Stripe Checkout Session creation |
| **Server** (this repository) | Session verification, role checks, business rules, data access, Stripe webhook handling |
 
The client creates user accounts and sessions. This server only reads them, so the client must be running to sign in and obtain a session token.
 
Role capabilities at a glance:
 
- **Customer:** browse menu, place and cancel orders, write reviews, manage a wishlist
- **Vendor:** manage menu items, accept or reject orders, upgrade to Premium
- **Admin:** manage users (block and unblock), moderate menu items, view transactions (read-only)

## Getting Started
 
### Prerequisites
 
- Node.js 18 or later
- A MongoDB Atlas cluster
- A Stripe account (test mode) and the [Stripe CLI](https://docs.stripe.com/stripe-cli)
### 1. Run the server
 
```bash
git clone https://github.com/iyiu9akhan/pizzahub-server.git
cd pizzahub-server
npm install
```
 
Create a `.env` file in the project root (see [Environment Variables](#environment-variables)), then start the server:
 
```bash
node index.js
```
 
The server runs at `http://localhost:5000` by default.
 
### 2. Run the client
 
Sessions are created by the client, so run it alongside the server. Follow the setup steps in the [client repository](https://github.com/iyiu9akhan/pizzahub):
 
```bash
git clone https://github.com/iyiu9akhan/pizzahub.git
cd pizzahub
npm install
cp .env.example .env.local
npm run dev
```
 
The client runs at `http://localhost:3000`. Make sure `FRONTEND_URL` in the server `.env` matches this origin.
 
### 3. Run the Stripe webhook locally
 
Keep this running in a separate terminal while testing payments:
 
```bash
stripe login
stripe listen --events checkout.session.completed,charge.refunded --forward-to localhost:5000/payments/webhook
```
 
Copy the `whsec_...` value printed by the CLI into `STRIPE_WEBHOOK_SECRET`, then restart the server.
 
**Stripe test card:** `4242 4242 4242 4242` with any future expiry date and any CVC.
 
## Environment Variables
 
Create a `.env` file in the project root. Never commit it.
 
| Variable | Description |
|---|---|
| `PORT` | Port the server listens on (default `5000`) |
| `MONGODB_USER` | MongoDB database user |
| `MONGODB_PASS` | MongoDB database password |
| `FRONTEND_URL` | Client origin allowed by CORS, for example `http://localhost:3000` |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Stripe webhook |
 
 
## Authentication and Authorization
 
User accounts and sessions are created by Better Auth in the client application and stored in the shared MongoDB database. This server only reads them.
 
1. The client sends the session token in the `Authorization: Bearer <token>` header.
2. `verifyToken` finds the session, rejects missing or expired sessions with `401`, loads the user, and rejects blocked accounts with `403`.
3. `verifyRole` compares the role stored in the database with the roles allowed for the route and returns `403` on a mismatch. Roles sent by the client are never trusted.
4. Update, delete, cancel, and accept or reject operations include the owner in the database filter, so users can only change their own resources.
| Status | Meaning |
|---|---|
| `401` | Token is missing, invalid, or expired |
| `403` | Valid token but wrong role, or the account is blocked |
 
## Challenge Implementation
 
### Advanced search and sorting
 
`GET /items` builds a MongoDB filter from query parameters. The filter always starts with `status: "approved"`, so rejected, pending, and inactive items never reach the public list.
 
| Parameter | Behaviour |
|---|---|
| `q` | Case-insensitive match on item name, description, location, and vendor name. Regex characters are escaped |
| `category` | Exact category match |
| `location` | Exact location match |
| `sort` | `price_asc` or `price_desc`. Any other value falls back to newest first |
| `vendorId` | Items of one vendor |
 
Example:
 
```
GET /items?q=cheese&category=Classic%20Pizzas&location=Dhaka&sort=price_asc
```
 
### Token verification
 
```
Request
  -> verifyToken   (read bearer token, check session and expiry, load user, reject blocked users)
  -> verifyRole    (compare database role with allowed roles)
  -> validId       (reject malformed ObjectIds)
  -> handler       (ownership enforced in the database filter)
```
 
## Business Rules
 
- **Item visibility:** only `approved` items appear publicly and can be ordered. Vendors can toggle their own items between `approved` and `inactive`.
- **Plan limits:** free vendors can have at most 3 active items (`pending` or `approved`). Premium vendors have no limit.
- **Orders:** customer, vendor, and prices come from the token and database, never from the request. A vendor cannot order their own item, and a customer cannot place a second active order for the same item and delivery day.
- **Order status:** only `pending` orders can be accepted, rejected, or cancelled, and only once.
- **Transactions:** no route creates, edits, or deletes transactions, so payment records cannot be changed through the API.
## Premium Subscription and Stripe Webhook
 
The Checkout Session is created by the client application for the logged-in vendor only. This server activates the subscription.
 
1. The vendor completes payment on Stripe Checkout.
2. Stripe sends `checkout.session.completed` to `POST /payments/webhook`.
3. The route verifies the signature with `STRIPE_WEBHOOK_SECRET`. An invalid signature returns `400`.
4. For a paid session, the server confirms that the vendor exists and saves the transaction. A unique index on `stripeSessionId` prevents duplicates when Stripe redelivers an event.
5. The vendor is updated to the Premium plan with an expiry date one year ahead.
6. On `charge.refunded`, the transaction is marked `refunded` and the vendor returns to the free plan.
The success page on the client never activates Premium. Expired subscriptions are downgraded to the free plan the next time they are checked.
 
## Deployment
 
The server is deployed on Vercel using `vercel.json`. Add all environment variables in the Vercel project settings.
 
In the Stripe Dashboard, add a webhook endpoint for:
 
```
https://iyiu9akhan-pizzahub-server.vercel.app/payments/webhook
```
 
Listen to `checkout.session.completed` and `charge.refunded`, and use its signing secret as `STRIPE_WEBHOOK_SECRET`. This is different from the secret printed by the Stripe CLI locally.
 
## Author
 
**Muhammad Sameer Khan**, Full Stack Developer (MERN)
 
- Portfolio: https://iyiu9akhan.vercel.app/
- GitHub: https://github.com/iyiu9akhan
- LinkedIn: https://www.linkedin.com/in/iyiu9akhan/
- Email: iyiu9akhan@gmail.com
 