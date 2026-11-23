// Idempotent migration: copies payments → transactions.
// Skips documents whose stripeSessionId already exists in transactions.
// Run once: node scripts/migrate-payments-to-transactions.js
// Do NOT run automatically on server start.

import { MongoClient } from "mongodb";
import "dotenv/config";

const client = new MongoClient(
  `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@cluster0.joq5z4d.mongodb.net/`,
);

await client.connect();
const db = client.db("pizzahub");
const payments = db.collection("payments");
const transactions = db.collection("transactions");

// Ensure unique index exists
await transactions.createIndex({ stripeSessionId: 1 }, { unique: true });

const all = await payments.find({}).toArray();
let inserted = 0;
let skipped = 0;

for (const p of all) {
  const sessionId = p.sessionId || p.stripeSessionId;
  if (!sessionId) { skipped++; continue; }

  const existing = await transactions.findOne({ stripeSessionId: sessionId });
  if (existing) { skipped++; continue; }

  await transactions.insertOne({
    vendorId: p.userId || p.vendorId || null,
    plan: "premium",
    amount: p.amount,
    currency: p.currency || "usd",
    stripeSessionId: sessionId,
    stripeSubscriptionId: null,
    paymentIntentId: p.payment_intent?.id ?? p.payment_intent ?? null,
    status: p.payment_status === "paid" || p.status === "complete" ? "paid" : "failed",
    createdAt: p.createdAt || new Date(),
  });
  inserted++;
}

console.log(`Migration complete: ${inserted} inserted, ${skipped} skipped.`);
await client.close();
