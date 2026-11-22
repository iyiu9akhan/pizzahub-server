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

// middleware
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));

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
]);

// payment routes
app.use("/payments", paymentsRouter(paymentsCollection, stripe));

const ALLOWED_ROLES = ["customer", "vendor", "admin"];
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

app.get("/", (req, res) => {
  res.send("pizzahub-server is running");
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
      { projection: { premium: 1, role: 1 } },
    );
    if (!user) return res.status(404).send({ message: "User not found" });

    const isVendor = user.role === "vendor";
    res.send({ isVendor, premium: isVendor && user.premium === true });
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

// public list: approved only
app.get(
  "/items",
  handle(async (req, res) => {
    const filter = { status: "approved" };
    if (req.query.vendorId) filter.vendorId = req.query.vendorId;
    res.send(await itemsCollection.find(filter).sort({ _id: -1 }).toArray());
  }),
);

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

// count of the logged in vendor's items (free limit)
app.get(
  "/items/count",
  verifyToken,
  verifyRole("vendor"),
  handle(async (req, res) => {
    const count = await itemsCollection.countDocuments({ vendorId: uid(req) });
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
    if (req.user.premium !== true) {
      const count = await itemsCollection.countDocuments({ vendorId });
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
    res.send(item);
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

// approve / reject an item (admin only)
app.patch(
  "/items/:id/status",
  verifyToken,
  verifyRole("admin"),
  validId,
  handle(async (req, res) => {
    const { status } = req.body;
    if (!["pending", "approved", "rejected"].includes(status)) {
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
    const { items, deliveryAddress, customerPhone } = req.body;

    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res
        .status(400)
        .send({ success: false, message: "Order needs 1 to 20 items" });
    }
    if (!deliveryAddress || typeof deliveryAddress !== "string") {
      return res
        .status(400)
        .send({ success: false, message: "Delivery address is required" });
    }
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
    const vendorIds = new Set(dbItems.map((i) => i.vendorId));
    if (vendorIds.size > 1) {
      return res.status(400).send({
        success: false,
        message: "Order items from one vendor at a time",
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
      deliveryAddress,
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
app.get(
  ["/orders", "/orders/vendor", "/orders/customer"],
  verifyToken,
  handle(async (req, res) => {
    const id = uid(req);
    let filter;

    if (req.user.role === "vendor") filter = { vendorId: id };
    else if (req.user.role === "customer") filter = { customerId: id };
    else if (req.user.role === "admin") {
      filter = {};
      if (req.query.vendorId) filter.vendorId = req.query.vendorId;
      if (req.query.customerId) filter.customerId = req.query.customerId;
      if (req.query.status) filter.status = req.query.status;
    } else {
      return res.status(403).send({ message: "Forbidden" });
    }

    res.send(await ordersCollection.find(filter).sort({ _id: -1 }).toArray());
  }),
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
    res.send(await paymentsCollection.find({}).sort({ _id: -1 }).toArray());
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

// last N days, empty days filled with 0 (ready for a line / bar chart)
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
      // payments.amount is in cents (2900 = $29)
      paymentsCollection
        .aggregate([
          { $match: { payment_status: "paid" } },
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
