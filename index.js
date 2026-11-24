import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import Stripe from "stripe";

// import route from another file
import paymentsRouter from "./routes/payments.js";

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// mongoDB connection
const client = new MongoClient(
  `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASS}@cluster0.joq5z4d.mongodb.net/`,
);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("successfully connected to mongodb");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("pizzahub");

// collections from db
const users = database.collection("user");
const sessions = database.collection("session");
const itemsCollection = database.collection("items");
const ordersCollection = database.collection("orders");
const paymentsCollection = database.collection("payments");
const transactionsCollection = database.collection("transactions");
const reviewsCollection = database.collection("reviews");
const wishlistCollection = database.collection("wishlists");

// indexes (safe to run on every start)
await Promise.all([
  reviewsCollection.createIndex({ itemId: 1, customerId: 1 }, { unique: true }),
  wishlistCollection.createIndex(
    { customerId: 1, itemId: 1 },
    { unique: true },
  ),
  ordersCollection.createIndex({ vendorId: 1 }),
  ordersCollection.createIndex({ customerId: 1 }),
  itemsCollection.createIndex({ vendorId: 1, status: 1 }),
  transactionsCollection.createIndex({ stripeSessionId: 1 }, { unique: true }),
]);

// webhook must receive raw body before express.json() parses anything
app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch (err) {
        return res.status(400).send({ message: `Webhook error: ${err.message}` });
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session.payment_status === "paid") {
          const vendorId = session.metadata?.vendorId;
          if (vendorId) {
            // Better Auth stores _id as a plain string; also try ObjectId for safety
            const idVariants = [vendorId];
            if (ObjectId.isValid(vendorId)) idVariants.push(new ObjectId(vendorId));
            const query = { _id: { $in: idVariants } };
            const vendor = await users.findOne(query);
            if (vendor && vendor.role === "vendor") {
              const now = new Date();
              const currentExpiry =
                vendor.subscriptionExpiresAt instanceof Date
                  ? vendor.subscriptionExpiresAt
                  : vendor.subscriptionExpiresAt
                    ? new Date(vendor.subscriptionExpiresAt)
                    : null;
              // renewal extends from the later of (current expiry, now)
              const base =
                currentExpiry && currentExpiry > now ? currentExpiry : now;
              const expiresAt = new Date(base);
              expiresAt.setFullYear(expiresAt.getFullYear() + 1);

              // idempotent insert via unique stripeSessionId index
              try {
                await transactionsCollection.insertOne({
                  vendorId: String(vendorId),
                  plan: "premium",
                  amount: session.amount_total,
                  currency: session.currency,
                  stripeSessionId: session.id,
                  stripeSubscriptionId: null,
                  paymentIntentId: session.payment_intent ?? null,
                  status: "paid",
                  createdAt: now,
                });
              } catch (e) {
                if (e.code !== 11000) throw e; // ignore duplicate
              }

              await users.updateOne(
                query,
                {
                  $set: {
                    premium: true,
                    subscriptionPlan: "premium",
                    subscriptionExpiresAt: expiresAt,
                    updatedAt: now,
                  },
                },
              );
            }
          }
        }
      } else if (event.type === "charge.refunded") {
        const charge = event.data.object;
        const paymentIntentId = charge.payment_intent;
        if (paymentIntentId) {
          const tx = await transactionsCollection.findOne({ paymentIntentId });
          if (tx) {
            await transactionsCollection.updateOne(
              { _id: tx._id },
              { $set: { status: "refunded" } },
            );
            if (tx.vendorId) {
              const refundIdVariants = [tx.vendorId];
              if (ObjectId.isValid(tx.vendorId)) refundIdVariants.push(new ObjectId(tx.vendorId));
              const refundQuery = { _id: { $in: refundIdVariants } };
              await users.updateOne(
                refundQuery,
                {
                  $set: {
                    premium: false,
                    subscriptionPlan: "free",
                    subscriptionExpiresAt: null,
                    updatedAt: new Date(),
                  },
                },
              );
            }
          }
        }
      }

      res.status(200).send({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.status(500).send({ success: false, message: "Something went wrong" });
    }
  },
);

// middleware
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));

const ALLOWED_ROLES = ["customer", "vendor", "admin"];

// isPremiumActive: true only if premium flag is set and expiry is in the future (or no expiry)
const isPremiumActive = async (user) => {
  if (!user || user.premium !== true) return false;
  const expiry = user.subscriptionExpiresAt;
  if (!expiry) return true; // legacy records with no expiry: still active
  const expiryDate = expiry instanceof Date ? expiry : new Date(expiry);
  if (expiryDate <= new Date()) {
    // downgrade expired vendor
    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          premium: false,
          subscriptionPlan: "free",
          subscriptionExpiresAt: null,
          updatedAt: new Date(),
        },
      },
    );
    return false;
  }
  return true;
};
const ITEM_FIELDS = [
  "itemName",
  "category",
  "description",
  "price",
  "location",
  "images",
];
const FREE_LIMIT = 3;

const handle = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`${req.method} ${req.originalUrl}`, err);
    res.status(500).send({ success: false, message: "Something went wrong" });
  });

const uid = (req) => req.user._id.toString(); // logged in user id (from token)
const pick = (obj, keys) =>
  Object.fromEntries(
    keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]),
  );

// token
const getUserFromToken = async (req) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;

  const session = await sessions.findOne({ token });
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  if (!ObjectId.isValid(String(session.userId))) return null;

  return users.findOne({ _id: new ObjectId(String(session.userId)) });
};

// login required
const verifyToken = handle(async (req, res, next) => {
  const user = await getUserFromToken(req);
  if (!user) {
    return res
      .status(401)
      .send({ message: "Unauthorized", code: "UNAUTHORIZED" });
  }
  if (user.banned) {
    return res.status(403).send({
      message: "Your account has been restricted",
      code: "ACCOUNT_RESTRICTED",
    });
  }
  req.user = user;
  next();
});

// login optional
const optionalAuth = handle(async (req, res, next) => {
  const user = await getUserFromToken(req);
  if (user && !user.banned) req.user = user;
  next();
});

// role check. always use after verifyToken
const verifyRole =
  (...roles) =>
    (req, res, next) =>
      roles.includes(req.user?.role)
        ? next()
        : res.status(403).send({ message: "Forbidden", code: "FORBIDDEN" });

const validId = (req, res, next) =>
  ObjectId.isValid(req.params.id)
    ? next()
    : res.status(400).send({ message: "Invalid id" });

// payment routes
app.use("/payments", paymentsRouter(paymentsCollection, stripe, verifyToken));

//root route
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>PizzaHub Server</title>

        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #f4f7f5;
            font-family: Arial, sans-serif;
            color: #263b32;
          }

          .container {
            text-align: center;
          }

          h1 {
            font-size: 28px;
            margin-bottom: 12px;
          }

          p {
            color: #64756c;
            font-size: 15px;
          }

          .status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            margin-top: 20px;
            padding: 10px 16px;
            background: #e6f5eb;
            color: #23834b;
            border-radius: 30px;
            font-size: 14px;
            font-weight: 600;
          }

          .dot {
            width: 8px;
            height: 8px;
            background: #22c55e;
            border-radius: 50%;
          }
        </style>
      </head>

      <body>
        <div class="container">
          <h1>🍕 PizzaHub Server</h1>
          <p>Your backend server is running successfully.</p>

          <div class="status">
            <span class="dot"></span>
            Server is running
          </div>
        </div>
      </body>
    </html>
  `);
});

// get all users (admin only)
app.get(
  "/users",
  verifyToken,
  verifyRole("admin"),
  handle(async (req, res) => {
    res.send(await users.find({}).toArray());
  }),
);

// premium status: only the user himself or an admin
app.get(
  "/users/:id/premium",
  verifyToken,
  validId,
  handle(async (req, res) => {
    const { id } = req.params;
    if (id !== uid(req) && req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden" });
    }
    const user = await users.findOne(
      { _id: new ObjectId(id) },
      { projection: { premium: 1, role: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } },
    );
    if (!user) return res.status(404).send({ message: "User not found" });

    const isVendor = user.role === "vendor";
    const premium = isVendor && (await isPremiumActive(user));
    res.send({
      isVendor,
      premium,
      plan: premium ? "premium" : "free",
      expiresAt: premium ? (user.subscriptionExpiresAt ?? null) : null,
    });
  }),
);

// update user role
app.patch(
  "/users/:id/role",
  verifyToken,
  verifyRole("admin"),
  validId,
  handle(async (req, res) => {
    const { role } = req.body;
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).send({ success: false, message: "Invalid role" });
    }
    if (req.params.id === uid(req)) {
      return res
        .status(400)
        .send({ success: false, message: "You can't change your own role" });
    }
    const result = await users.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { role, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res
        .status(404)
        .send({ success: false, message: "User not found" });
    }
    res.send({ success: true, modifiedCount: result.modifiedCount });
  }),
);

// restrict / unrestrict a user (admin only)
app.patch(
  "/users/:id/restrict",
  verifyToken,
  verifyRole("admin"),
  validId,
  handle(async (req, res) => {
    const { restricted, reason } = req.body;
    const id = req.params.id;

    if (typeof restricted !== "boolean") {
      return res
        .status(400)
        .send({ success: false, message: "restricted must be true or false" });
    }
    if (id === uid(req)) {
      return res
        .status(400)
        .send({ success: false, message: "You can't restrict yourself" });
    }
    const target = await users.findOne({ _id: new ObjectId(id) });
    if (!target)
      return res
        .status(404)
        .send({ success: false, message: "User not found" });
    if (target.role === "admin") {
      return res
        .status(400)
        .send({ success: false, message: "Admins can't be restricted" });
    }

    if (restricted) {
      await users.updateOne(
        { _id: target._id },
        {
          $set: {
            banned: true,
            banReason: reason || "Restricted by admin",
            banExpires: null,
            updatedAt: new Date(),
          },
        },
      );
      // log the user out everywhere (session.userId may be string or ObjectId)
      await sessions.deleteMany({ userId: { $in: [id, new ObjectId(id)] } });
    } else {
      await users.updateOne(
        { _id: target._id },
        {
          $set: { banned: false, updatedAt: new Date() },
          $unset: { banReason: "", banExpires: "" },
        },
      );
    }
    res.send({ success: true });
  }),
);

// Visibility rules:
// - public (Home, Browse Menu): only "approved" items
// - vendor: only his own items (any status) -> /items/manage
// - admin: all items (any status) -> /items/manage

// public list: approved only (with search, category, location, and sort)
app.get(
  "/items",
  handle(async (req, res) => {
    const filter = { status: "approved" };
    if (req.query.vendorId) filter.vendorId = req.query.vendorId;

    if (req.query.category && req.query.category !== "All") {
      filter.category = req.query.category;
    }

    if (req.query.location) {
      filter.location = req.query.location;
    }

    if (req.query.q) {
      const q = String(req.query.q).trim();
      if (q) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        filter.$or = [
          { itemName: regex },
          { description: regex },
          { location: regex },
          { vendorName: regex },
        ];
      }
    }

    let sort = { _id: -1 };
    if (req.query.sort === "price_asc") {
      sort = { price: 1, _id: -1 };
    } else if (req.query.sort === "price_desc") {
      sort = { price: -1, _id: -1 };
    }

    const items = await itemsCollection.find(filter).sort(sort).toArray();
    res.send(await enrichItemsWithPremium(items));
  }),
);

// helper: batch-enrich items with vendorPremium flag
async function enrichItemsWithPremium(items) {
  if (!items.length) return items;
  const vendorIds = [...new Set(items.map((i) => i.vendorId).filter(Boolean))];
  const objectIds = vendorIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  const vendorDocs = await users
    .find({ _id: { $in: [...objectIds, ...vendorIds] } })
    .project({ _id: 1, premium: 1, subscriptionExpiresAt: 1 })
    .toArray();
  const premiumSet = new Set();
  for (const v of vendorDocs) {
    if (await isPremiumActive(v)) {
      premiumSet.add(v._id.toString());
    }
  }
  return items.map((item) => ({
    ...item,
    vendorPremium: item.vendorId ? premiumSet.has(String(item.vendorId)) : false,
  }));
}

// vendor: own items / Admin: all items (id comes from the token, not the client)
app.get(
  "/items/manage",
  verifyToken,
  verifyRole("vendor", "admin"),
  handle(async (req, res) => {
    const filter = req.user.role === "vendor" ? { vendorId: uid(req) } : {};
    res.send(await itemsCollection.find(filter).sort({ _id: -1 }).toArray());
  }),
);

// count of the logged in vendor's items (free limit: pending or approved)
app.get(
  "/items/count",
  verifyToken,
  verifyRole("vendor"),
  handle(async (req, res) => {
    const count = await itemsCollection.countDocuments({
      vendorId: uid(req),
      status: { $in: ["pending", "approved"] },
    });
    res.send({ count });
  }),
);

// create item (vendor only). vendorId from token, status always "pending"
app.post(
  "/items",
  verifyToken,
  verifyRole("vendor"),
  handle(async (req, res) => {
    const vendorId = uid(req);

    // req.user is fresh from the DB, so premium is already here
    if (!(await isPremiumActive(req.user))) {
      const count = await itemsCollection.countDocuments({
        vendorId,
        status: { $in: ["pending", "approved"] },
      });
      if (count >= FREE_LIMIT) {
        return res.status(403).send({
          success: false,
          code: "LIMIT_REACHED",
          message:
            "LIMIT_REACHED: Free plan limit reached. Upgrade to Premium.",
        });
      }
    }

    const data = pick(req.body, ITEM_FIELDS);
    if (!data.itemName || !(Number(data.price) > 0)) {
      return res.status(400).send({
        success: false,
        message: "itemName and a valid price are required",
      });
    }
    data.price = Number(data.price);

    const item = {
      ...data,
      vendorId,
      vendorName: req.user.businessName || req.user.name,
      status: "pending",
      ratingAvg: 0,
      ratingCount: 0,
      createdAt: new Date(),
    };
    const result = await itemsCollection.insertOne(item);
    res.status(201).send({
      success: true,
      message: "Item created successfully",
      insertedId: result.insertedId,
    });
  }),
);

// distinct locations of approved items (registered before /items/:id)
app.get(
  "/items/locations",
  handle(async (req, res) => {
    const locations = await itemsCollection.distinct("location", {
      status: "approved",
      location: { $exists: true, $ne: "" },
    });
    const cleaned = locations
      .filter((loc) => typeof loc === "string" && loc.trim())
      .map((l) => l.trim());
    res.send([...new Set(cleaned)].sort());
  }),
);

// single item. not approved items are visible only to the owner vendor and admins
app.get(
  "/items/:id",
  optionalAuth,
  validId,
  handle(async (req, res) => {
    const item = await itemsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!item) return res.status(404).send({ message: "Item not found" });

    const isAdmin = req.user?.role === "admin";
    const isOwner = req.user && item.vendorId === uid(req);
    if (item.status !== "approved" && !isAdmin && !isOwner) {
      return res.status(404).send({ message: "Item not found" });
    }
    const [enriched] = await enrichItemsWithPremium([item]);
    res.send(enriched);
  }),
);

// edit item: vendor (own item only) or admin (any item)
app.put(
  "/items/:id",
  verifyToken,
  verifyRole("vendor", "admin"),
  validId,
  handle(async (req, res) => {
    const data = pick(req.body, ITEM_FIELDS);
    if (data.price !== undefined) data.price = Number(data.price);

    const filter = { _id: new ObjectId(req.params.id) };
    if (req.user.role === "vendor") filter.vendorId = uid(req); // ownership

    const result = await itemsCollection.updateOne(filter, {
      $set: { ...data, updatedAt: new Date() },
    });
    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Item not found" });
    }
    res.send(result);
  }),
);

// vendor availability toggle (approved <-> inactive)
app.patch(
  "/items/:id/availability",
  verifyToken,
  verifyRole("vendor"),
  validId,
  handle(async (req, res) => {
    const { status } = req.body;
    if (!["approved", "inactive"].includes(status)) {
      return res.status(400).send({
        success: false,
        message: "Status must be either 'approved' or 'inactive'",
      });
    }

    const vendorId = uid(req);
    const item = await itemsCollection.findOne({
      _id: new ObjectId(req.params.id),
      vendorId,
    });
    if (!item) {
      return res.status(404).send({ success: false, message: "Item not found" });
    }

    // Allowed only between approved and inactive
    if (!["approved", "inactive"].includes(item.status)) {
      return res.status(400).send({
        success: false,
        message: "Only approved or inactive items can toggle availability",
      });
    }

    if (item.status === status) {
      return res.send({ success: true, status });
    }

    // Free plan limit counts items with status "pending" or "approved"
    if (status === "approved" && !(await isPremiumActive(req.user))) {
      const count = await itemsCollection.countDocuments({
        vendorId,
        status: { $in: ["pending", "approved"] },
      });
      if (count >= FREE_LIMIT) {
        return res.status(403).send({
          success: false,
          code: "LIMIT_REACHED",
          message:
            "LIMIT_REACHED: Free plan limit reached. Upgrade to Premium.",
        });
      }
    }

    await itemsCollection.updateOne(
      { _id: new ObjectId(req.params.id), vendorId },
      { $set: { status, updatedAt: new Date() } },
    );

    res.send({ success: true, status });
  }),
);

// approve / reject / inactive an item (admin only)
app.patch(
  "/items/:id/status",
  verifyToken,
  verifyRole("admin"),
  validId,
  handle(async (req, res) => {
    const { status } = req.body;
    if (!["pending", "approved", "rejected", "inactive"].includes(status)) {
      return res.status(400).send({ message: "Invalid status" });
    }
    const result = await itemsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Item not found" });
    }
    res.send({ success: true });
  }),
);

// delete item: vendor (own item only) or admin (any item)
app.delete(
  "/items/:id",
  verifyToken,
  verifyRole("vendor", "admin"),
  validId,
  handle(async (req, res) => {
    const filter = { _id: new ObjectId(req.params.id) };
    if (req.user.role === "vendor") filter.vendorId = uid(req); // ownership

    const result = await itemsCollection.deleteOne(filter);
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Item not found" });
    }
    // clean up related data
    await Promise.all([
      reviewsCollection.deleteMany({ itemId: req.params.id }),
      wishlistCollection.deleteMany({ itemId: req.params.id }),
    ]);
    res.send(result);
  }),
);

// pplace an order (customer only)
app.post(
  ["/order", "/orders"],
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    const { items, deliveryAddress, customerPhone, deliveryDate, message } = req.body;

    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res
        .status(400)
        .send({ success: false, message: "Order needs 1 to 20 items" });
    }
    if (!deliveryAddress || typeof deliveryAddress !== "string" || !deliveryAddress.trim()) {
      return res
        .status(400)
        .send({ success: false, message: "Delivery address is required" });
    }
    if (!deliveryDate) {
      return res
        .status(400)
        .send({ success: false, message: "Delivery date is required" });
    }
    const parsedDeliveryDate = new Date(deliveryDate);
    if (isNaN(parsedDeliveryDate.getTime())) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid delivery date" });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDeliveryDate = new Date(parsedDeliveryDate);
    checkDeliveryDate.setHours(0, 0, 0, 0);
    if (checkDeliveryDate < today) {
      return res
        .status(400)
        .send({ success: false, message: "Delivery date cannot be in the past" });
    }
    if (message !== undefined && message !== null) {
      if (typeof message !== "string") {
        return res
          .status(400)
          .send({ success: false, message: "Message must be a string" });
      }
      if (message.trim().length > 500) {
        return res
          .status(400)
          .send({ success: false, message: "Message cannot exceed 500 characters" });
      }
    }
    const trimmedMessage = typeof message === "string" ? message.trim() : "";

    const badLine = items.some(
      (i) =>
        !ObjectId.isValid(i?.itemId) ||
        !Number.isInteger(i?.quantity) ||
        i.quantity < 1 ||
        i.quantity > 20,
    );
    if (badLine) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid order items" });
    }

    // prices come from the DB, never from the client
    const ids = [...new Set(items.map((i) => i.itemId))];
    const dbItems = await itemsCollection
      .find({
        _id: { $in: ids.map((i) => new ObjectId(i)) },
        status: "approved",
      })
      .toArray();
    if (dbItems.length !== ids.length) {
      return res.status(404).send({
        success: false,
        message: "Some items are no longer available",
      });
    }

    // 403 if item.vendorId === uid(req)
    if (dbItems.some((item) => item.vendorId === uid(req))) {
      return res.status(403).send({
        success: false,
        message: "You cannot order your own menu items",
      });
    }

    const vendorIds = new Set(dbItems.map((i) => i.vendorId));
    if (vendorIds.size > 1) {
      return res.status(400).send({
        success: false,
        message: "Order items from one vendor at a time",
      });
    }

    // Duplicate check: same customer, same itemId, same delivery day, existing order with status pending or accepted = 409
    const dayStart = new Date(parsedDeliveryDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(parsedDeliveryDate);
    dayEnd.setHours(23, 59, 59, 999);

    const duplicateOrder = await ordersCollection.findOne({
      customerId: uid(req),
      status: { $in: ["pending", "accepted"] },
      $or: [
        { deliveryDate: { $gte: dayStart, $lte: dayEnd } },
        { deliveryDate: { $regex: `^${dayStart.toISOString().slice(0, 10)}` } },
      ],
      "items.itemId": { $in: ids },
    });

    if (duplicateOrder) {
      return res.status(409).send({
        success: false,
        code: "DUPLICATE_ORDER",
        message: "You already have a pending or accepted order for this item on that delivery date",
      });
    }

    const byId = new Map(dbItems.map((i) => [i._id.toString(), i]));
    const lines = items.map((i) => {
      const db = byId.get(i.itemId);
      return {
        itemId: i.itemId,
        itemName: db.itemName,
        image: db.images?.[0] ?? null,
        price: db.price,
        quantity: i.quantity,
      };
    });
    const totalAmount = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

    const order = {
      customerId: uid(req),
      customerName: req.user.name,
      customerEmail: req.user.email,
      customerPhone: customerPhone || "",
      deliveryAddress: deliveryAddress.trim(),
      deliveryDate: parsedDeliveryDate,
      message: trimmedMessage,
      items: lines,
      totalAmount,
      vendorId: dbItems[0].vendorId,
      vendorName: dbItems[0].vendorName,
      status: "pending",
      createdAt: new Date(),
    };
    const result = await ordersCollection.insertOne(order);
    res.status(201).send({
      success: true,
      message: "Order placed successfully",
      insertedId: result.insertedId,
    });
  }),
);

// orders by role.
// app.get(
//   ["/orders", "/orders/vendor", "/orders/customer"],
//   verifyToken,
//   handle(async (req, res) => {
//     const id = uid(req);
//     let filter;

//     if (req.user.role === "vendor") filter = { vendorId: id };
//     else if (req.user.role === "customer") filter = { customerId: id };
//     else if (req.user.role === "admin") {
//       filter = {};
//       if (req.query.vendorId) filter.vendorId = req.query.vendorId;
//       if (req.query.customerId) filter.customerId = req.query.customerId;
//       if (req.query.status) filter.status = req.query.status;
//     } else {
//       return res.status(403).send({ message: "Forbidden" });
//     }

//     res.send(await ordersCollection.find(filter).sort({ _id: -1 }).toArray());
//   }),
// );


app.get(
  ["/orders", "/orders/vendor", "/orders/customer"],
  verifyToken,
  handle(async (req, res) => {
    const id = uid(req);
    let filter;

    if (req.user.role === "vendor") {
      filter = { vendorId: id };
    } else if (req.user.role === "customer") {
      filter = { customerId: id };
    } else if (req.user.role === "admin") {
      filter = {};

      if (req.query.vendorId) filter.vendorId = req.query.vendorId;
      if (req.query.customerId) filter.customerId = req.query.customerId;
      if (req.query.status) filter.status = req.query.status;
    } else {
      return res.status(403).send({ message: "Forbidden" });
    }

    // Get orders
    const orders = await ordersCollection
      .find(filter)
      .sort({ _id: -1 })
      .toArray();

    if (!orders.length) {
      return res.send([]);
    }

    // Collect unique customer IDs
    const customerIds = [
      ...new Set(
        orders
          .map((order) => order.customerId)
          .filter(Boolean)
          .map(String)
      ),
    ];

    // Support string IDs and ObjectIds
    const idVariants = customerIds.flatMap((customerId) =>
      ObjectId.isValid(customerId)
        ? [customerId, new ObjectId(customerId)]
        : [customerId]
    );

    // Fetch latest customer profiles
    const customers = await users
      .find(
        { _id: { $in: idVariants } },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
          },
        }
      )
      .toArray();

    const customerMap = new Map(
      customers.map((customer) => [
        String(customer._id),
        customer,
      ])
    );

    // Enrich orders with latest customer profile data
    const updatedOrders = orders.map((order) => {
      const customer = customerMap.get(String(order.customerId));

      return {
        ...order,
        customerName: customer?.name ?? order.customerName,
        customerEmail: customer?.email ?? order.customerEmail,
        customerImage: customer?.image ?? order.customerImage ?? null,
      };
    });

    return res.send(updatedOrders);
  })
);


// update an order: vendor (own orders) or admin (any order), same rules for both
app.patch(
  "/orders/:id",
  verifyToken,
  verifyRole("vendor", "admin"),
  validId,
  handle(async (req, res) => {
    const { status, fulfillmentStatus } = req.body;
    const base = { _id: new ObjectId(req.params.id) };
    if (req.user.role === "vendor") base.vendorId = uid(req); // ownership

    let filter;
    let update;

    if (status === "accepted" || status === "rejected") {
      filter = { ...base, status: "pending" };
      update = { status };
    } else if (fulfillmentStatus) {
      const previous = {
        cooking: null,
        on_the_way: "cooking",
        delivered: "on_the_way",
      };
      if (!(fulfillmentStatus in previous)) {
        return res.status(400).send({ message: "Invalid fulfillment status" });
      }
      filter = {
        ...base,
        status: "accepted",
        fulfillmentStatus: previous[fulfillmentStatus],
      };
      update = { fulfillmentStatus };
    } else {
      return res.status(400).send({ message: "Invalid update" });
    }

    const result = await ordersCollection.updateOne(filter, {
      $set: { ...update, updatedAt: new Date() },
    });
    if (result.matchedCount === 0) {
      return res.status(409).send({ message: "Order cannot be updated" });
    }
    res.send(result);
  }),
);

// customer cancels his own order (only while still "pending")
app.patch(
  "/orders/:id/cancel",
  verifyToken,
  verifyRole("customer"),
  validId,
  handle(async (req, res) => {
    const result = await ordersCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
        customerId: uid(req),
        status: "pending",
      },
      { $set: { status: "cancelled", updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(409).send({ message: "Order cannot be cancelled" });
    }
    res.send({ success: true });
  }),
);

const refreshRating = async (itemId) => {
  const [agg] = await reviewsCollection
    .aggregate([
      { $match: { itemId } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ])
    .toArray();
  await itemsCollection.updateOne(
    { _id: new ObjectId(itemId) },
    {
      $set: {
        ratingAvg: agg ? Math.round(agg.avg * 10) / 10 : 0,
        ratingCount: agg?.count ?? 0,
      },
    },
  );
};

// reviews of an item (public)
app.get(
  "/items/:id/reviews",
  validId,
  handle(async (req, res) => {
    const reviews = await reviewsCollection
      .find({ itemId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const ids = [...new Set(reviews.map((r) => r.customerId))]
      .filter((i) => ObjectId.isValid(i))
      .map((i) => new ObjectId(i));
    const authors = await users
      .find({ _id: { $in: ids } }, { projection: { name: 1, image: 1 } })
      .toArray();
    const byId = new Map(authors.map((u) => [u._id.toString(), u]));

    res.send(
      reviews.map((r) => ({
        ...r,
        customerName: byId.get(r.customerId)?.name ?? r.customerName,
        customerImage: byId.get(r.customerId)?.image ?? null,
      })),
    );
  }),
);

// add or update my review (customer who received this item). One review per item
app.post(
  "/reviews",
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    const { itemId, rating, comment = "" } = req.body;

    if (!ObjectId.isValid(itemId)) {
      return res.status(400).send({ message: "Invalid itemId" });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).send({ message: "Rating must be 1 to 5" });
    }
    if (typeof comment !== "string" || comment.length > 1000) {
      return res.status(400).send({ message: "Comment is too long" });
    }
    const item = await itemsCollection.findOne({ _id: new ObjectId(itemId) });
    if (!item) return res.status(404).send({ message: "Item not found" });

    // Verified purchase: must have a delivered order with this item
    const bought = await ordersCollection.findOne({
      customerId: uid(req),
      fulfillmentStatus: "delivered",
      "items.itemId": itemId,
    });
    if (!bought) {
      return res
        .status(403)
        .send({ message: "You can review only items you have received" });
    }

    const now = new Date();
    await reviewsCollection.updateOne(
      { itemId, customerId: uid(req) },
      {
        $set: {
          rating,
          comment: comment.trim(),
          customerName: req.user.name,
          customerImage: req.user.image ?? null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    await refreshRating(itemId);
    res.status(201).send({ success: true });
  }),
);

// delete a review: owner or admin
app.delete(
  "/reviews/:id",
  verifyToken,
  validId,
  handle(async (req, res) => {
    const review = await reviewsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!review) return res.status(404).send({ message: "Review not found" });
    if (review.customerId !== uid(req) && req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden" });
    }
    await reviewsCollection.deleteOne({ _id: review._id });
    await refreshRating(review.itemId);
    res.send({ success: true });
  }),
);

//wishlist
app.get(
  "/wishlist",
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    const rows = await wishlistCollection
      .find({ customerId: uid(req) })
      .sort({ createdAt: -1 })
      .toArray();
    const ids = rows.map((r) => new ObjectId(r.itemId));
    res.send(
      await itemsCollection
        .find({ _id: { $in: ids }, status: "approved" })
        .toArray(),
    );
  }),
);

app.post(
  "/wishlist",
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    const { itemId } = req.body;
    if (!ObjectId.isValid(itemId))
      return res.status(400).send({ message: "Invalid itemId" });

    const item = await itemsCollection.findOne({
      _id: new ObjectId(itemId),
      status: "approved",
    });
    if (!item) return res.status(404).send({ message: "Item not found" });

    await wishlistCollection.updateOne(
      { customerId: uid(req), itemId },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    res.status(201).send({ success: true });
  }),
);

app.delete(
  "/wishlist/:itemId",
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    await wishlistCollection.deleteOne({
      customerId: uid(req),
      itemId: req.params.itemId,
    });
    res.send({ success: true });
  }),
);

//transactions
app.get(
  "/transactions",
  verifyToken,
  verifyRole("admin"),
  handle(async (req, res) => {
    const rows = await transactionsCollection.find({}).sort({ _id: -1 }).toArray();
    // batch vendor lookup
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter(Boolean))];
    const objectIds = vendorIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    const vendorDocs = await users
      .find(
        { _id: { $in: [...objectIds, ...vendorIds] } },
        { projection: { name: 1, email: 1, businessName: 1 } },
      )
      .toArray();
    const byId = new Map(vendorDocs.map((u) => [u._id.toString(), u]));

    res.send(
      rows.map((r) => {
        const v = byId.get(r.vendorId?.toString()) ?? {};
        return {
          ...r,
          vendorName: v.businessName || v.name || null,
          name: v.name || null,
          vendorEmail: v.email || null,
          email: v.email || null,
          businessName: v.businessName || null,
        };
      }),
    );
  }),
);

//dashboard stats
const amount = {
  $convert: { input: "$totalAmount", to: "double", onError: 0, onNull: 0 },
};

// group count by a field -> { pending: 2, accepted: 1 }
const countBy = async (collection, filter, field) => {
  const rows = await collection
    .aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id ?? "none", r.count]));
};

const ordersPerDay = async (filter, days = 7) => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);

  const rows = await ordersCollection
    .aggregate([
      { $match: filter },
      { $addFields: { _at: { $ifNull: ["$createdAt", { $toDate: "$_id" }] } } },
      { $match: { _at: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$_at" } },
          orders: { $sum: 1 },
          revenue: { $sum: amount },
        },
      },
    ])
    .toArray();
  const map = new Map(rows.map((r) => [r._id, r]));

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    return {
      date,
      orders: map.get(date)?.orders ?? 0,
      revenue: map.get(date)?.revenue ?? 0,
    };
  });
};

const sumAmount = async (filter) => {
  const [row] = await ordersCollection
    .aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: amount } } },
    ])
    .toArray();
  return row?.total ?? 0;
};

app.get(
  "/stats/vendor",
  verifyToken,
  verifyRole("vendor"),
  handle(async (req, res) => {
    const vendorId = uid(req);
    const [orderStatus, itemStatus, delivered, revenue, daily, topItems] =
      await Promise.all([
        countBy(ordersCollection, { vendorId }, "status"),
        countBy(itemsCollection, { vendorId }, "status"),
        ordersCollection.countDocuments({
          vendorId,
          fulfillmentStatus: "delivered",
        }),
        sumAmount({ vendorId, fulfillmentStatus: "delivered" }),
        ordersPerDay({ vendorId }, 7),
        ordersCollection
          .aggregate([
            { $match: { vendorId } },
            { $unwind: "$items" },
            {
              $group: {
                _id: "$items.itemName",
                sold: { $sum: "$items.quantity" },
              },
            },
            { $sort: { sold: -1 } },
            { $limit: 5 },
          ])
          .toArray(),
      ]);

    res.send({
      cards: {
        totalOrders: Object.values(orderStatus).reduce((a, b) => a + b, 0),
        pendingOrders: orderStatus.pending ?? 0,
        deliveredOrders: delivered,
        revenue,
        totalItems: Object.values(itemStatus).reduce((a, b) => a + b, 0),
      },
      charts: {
        ordersByStatus: orderStatus,
        itemsByStatus: itemStatus,
        daily, // [{ date, orders, revenue }]
        topItems: topItems.map((t) => ({ name: t._id, sold: t.sold })),
      },
    });
  }),
);

app.get(
  "/stats/customer",
  verifyToken,
  verifyRole("customer"),
  handle(async (req, res) => {
    const customerId = uid(req);
    const [orderStatus, delivered, spent, daily, wishlist, reviews] =
      await Promise.all([
        countBy(ordersCollection, { customerId }, "status"),
        ordersCollection.countDocuments({
          customerId,
          fulfillmentStatus: "delivered",
        }),
        sumAmount({ customerId, status: { $in: ["pending", "accepted"] } }),
        ordersPerDay({ customerId }, 7),
        wishlistCollection.countDocuments({ customerId }),
        reviewsCollection.countDocuments({ customerId }),
      ]);

    res.send({
      cards: {
        totalOrders: Object.values(orderStatus).reduce((a, b) => a + b, 0),
        pendingOrders: orderStatus.pending ?? 0,
        deliveredOrders: delivered,
        totalSpent: spent,
        wishlistCount: wishlist,
        reviewsCount: reviews,
      },
      charts: { ordersByStatus: orderStatus, daily },
    });
  }),
);

app.get(
  "/stats/admin",
  verifyToken,
  verifyRole("admin"),
  handle(async (req, res) => {
    const [
      usersByRole,
      restricted,
      itemStatus,
      orderStatus,
      delivered,
      orderRevenue,
      daily,
      subs,
    ] = await Promise.all([
      countBy(users, {}, "role"),
      users.countDocuments({ banned: true }),
      countBy(itemsCollection, {}, "status"),
      countBy(ordersCollection, {}, "status"),
      ordersCollection.countDocuments({ fulfillmentStatus: "delivered" }),
      sumAmount({ fulfillmentStatus: "delivered" }),
      ordersPerDay({}, 7),
      transactionsCollection
        .aggregate([
          { $match: { status: "paid" } },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

    res.send({
      cards: {
        totalUsers: Object.values(usersByRole).reduce((a, b) => a + b, 0),
        restrictedUsers: restricted,
        totalItems: Object.values(itemStatus).reduce((a, b) => a + b, 0),
        pendingItems: itemStatus.pending ?? 0,
        totalOrders: Object.values(orderStatus).reduce((a, b) => a + b, 0),
        deliveredOrders: delivered,
        orderRevenue,
        subscriptionRevenue: (subs[0]?.total ?? 0) / 100,
        subscriptions: subs[0]?.count ?? 0,
        totalTransactions: subs[0]?.count ?? 0,
      },
      charts: {
        usersByRole,
        itemsByStatus: itemStatus,
        ordersByStatus: orderStatus,
        daily,
      },
    });
  }),
);

app.use((req, res) => {
  res.status(404).send({ message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send({ success: false, message: "Something went wrong" });
});

// Start server
app.listen(port, () => {
  console.log(`pizzahub-server listening on port ${port}`);
});

export default app;
