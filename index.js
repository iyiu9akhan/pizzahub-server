import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

// mongodb connection string
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
const users = database.collection("user");
const itemsCollection = database.collection("items");

app.get("/", (req, res) => {
  res.send("pizzahub-server is running");
});

// get users data from db
app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

// new item post api
app.post("/items", async (req, res) => {
  try {
    const item = req.body;

    const result = await itemsCollection.insertOne(item);

    res.status(201).send({
      success: true,
      message: "Item created successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("POST /items error:", error);

    res.status(500).send({
      success: false,
      message: error.message,
    });
  }
});


app.listen(port, () => {
  console.log(`pizzahub-server listening on port ${port}`);
});
