const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🔥 YOUR NEW FIREBASE CODE (REPLACE):
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.nkuntqh.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("parcelDB");
    const usersCollection = database.collection("users");
    const parcelsCollection = database.collection("parcels");
    const paymentsCollection = database.collection("payments");
    const ridersCollection = database.collection("riders");
    await parcelsCollection.createIndex({ trackingId: 1 }, { unique: true });
    await usersCollection.createIndex({ uid: 1 }, { unique: true });
    await usersCollection.createIndex(
      { email: 1 },
      { unique: true, sparse: true },
    );
    await ridersCollection.createIndex(
      { phone: 1 },
      { unique: true, sparse: true },
    );
    await ridersCollection.createIndex(
      { nid: 1 },
      { unique: true, sparse: true },
    );

    // Custom Middleware
    const verifyFBToken = async (req, res, next) => {
      // console.log('Header in middleware ', req.headers);
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // admin
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email;
        if (!email) return res.status(401).send({ message: "Unauthorized" });

        const user = await usersCollection.findOne({ email });
        if (!user || user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden (admin only)" });
        }

        next();
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    };

    // Create user if not exists, otherwise update lastLogin + profile
    app.post("/users", async (req, res) => {
      try {
        const { uid, email, name, photoURL, provider } = req.body;

        if (!uid) return res.status(400).send({ message: "uid required" });

        const now = new Date();

        const existing = await usersCollection.findOne({ uid });

        if (existing) {
          // Update login + latest profile info (NO role change here)
          await usersCollection.updateOne(
            { uid },
            {
              $set: {
                email: email ?? existing.email ?? null,
                name: name ?? existing.name ?? "",
                photoURL: photoURL ?? existing.photoURL ?? "",
                provider: provider ?? existing.provider ?? "unknown",
                lastLoginAt: now,
                updatedAt: now,
              },
            },
          );

          return res.send({
            message: "User exists, login updated",
            isNewUser: false,
          });
        }

        // Insert new user
        const userDoc = {
          uid,
          email: email || null,
          name: name || "",
          photoURL: photoURL || "",
          provider: provider || "unknown",

          role: "user", // default role
          status: "active",

          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        };

        const result = await usersCollection.insertOne(userDoc);

        res.status(201).send({
          message: "New user created",
          isNewUser: true,
          insertedId: result.insertedId,
        });
      } catch (err) {
        if (String(err?.code) === "11000") {
          return res
            .status(409)
            .send({ message: "User already exists (duplicate)" });
        }
        res.status(500).send({ message: err.message });
      }
    });

    //admin
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const q = String(req.query.q || "").trim();
        const limit = Math.min(parseInt(req.query.limit || "10"), 20);

        if (!q || q.length < 2) {
          return res.send({ users: [] });
        }

        const query = {
          $or: [
            { email: { $regex: q, $options: "i" } },
            { name: { $regex: q, $options: "i" } },
          ],
        };

        const users = await usersCollection
          .find(query, {
            projection: { email: 1, name: 1, role: 1, status: 1, createdAt: 1 },
          })
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray();

        res.send({ users });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid user ID" });
          }

          const allowed = ["user", "admin", "rider"];
          if (!allowed.includes(role)) {
            return res.status(400).send({ message: "Invalid role" });
          }

          // Optional safety: prevent removing your own admin
          const me = req.decoded?.email;
          const target = await usersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!target)
            return res.status(404).send({ message: "User not found" });

          if (target.email === me && role !== "admin") {
            return res
              .status(400)
              .send({ message: "You cannot remove your own admin role" });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role, updatedAt: new Date() } },
          );

          res.send({
            success: true,
            message: `Role updated to ${role}`,
            modifiedCount: result.modifiedCount,
          });
        } catch (err) {
          res.status(500).send({ message: err.message });
        }
      },
    );

    app.get("/parcels", verifyFBToken, async (req, res) => {
      const cursor = parcelsCollection.find();
      const parcels = await cursor.toArray();
      res.send(parcels);
    });

    // Parcels api
    app.get("/parcels/user", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res
          .status(400)
          .send({ error: "Email query parameter is required" });
      }

      const cursor = parcelsCollection
        .find({ "createdBy.email": email })
        .sort({ createdAtISO: -1 });

      const parcels = await cursor.toArray();
      res.send(parcels);
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error("Get parcel error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    //payment get
    app.get("/payments", verifyFBToken, async (req, res) => {
      // console.log('Headers in payment',req.headers);
      try {
        const userEmail = req.query.email; // ideally from req.user.email
        if (!userEmail)
          return res.status(400).send({ message: "email required" });

        const payments = await paymentsCollection
          .find({ userEmail })
          .sort({ createdAt: -1 }) // ✅ latest first
          .toArray();

        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // Track parcel by trackingId (public id)
    app.get("/parcels/track/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;

        if (!trackingId) {
          return res.status(400).send({ message: "trackingId is required" });
        }

        const parcel = await parcelsCollection.findOne({ trackingId });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        // Return only what's needed for tracking UI
        res.send({
          _id: parcel._id,
          trackingId: parcel.trackingId,
          parcelTitle: parcel.parcelTitle,
          parcelType: parcel.parcelType,
          paymentType: parcel.paymentType,
          deliveryCost: parcel.deliveryCost,
          codAmount: parcel.codAmount,

          senderRegion: parcel.senderRegion,
          senderCenter: parcel.senderCenter,
          receiverRegion: parcel.receiverRegion,
          receiverCenter: parcel.receiverCenter,

          status: parcel.status,
          statusHistory: parcel.statusHistory || [],
          createdAtISO: parcel.createdAtISO,
        });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      console.log("New parcel added:", parcel);
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // payment

    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    //Update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, paymentIntentId, userName, userEmail } = req.body;

        if (!parcelId || !paymentIntentId || !userEmail) {
          return res
            .status(400)
            .send({ message: "parcelId, paymentIntentId, userEmail required" });
        }

        // 1) Load parcel from DB
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });
        if (!parcel)
          return res.status(404).send({ message: "Parcel not found" });
        // 2) Verify payment with Stripe (IMPORTANT)
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== "succeeded") {
          return res
            .status(400)
            .send({ message: "Payment not succeeded", status: pi.status });
        }

        // 3) Verify amount matches parcel (IMPORTANT)
        const expectedAmountInCents = Math.round((parcel.codAmount || 0) * 100);
        if (pi.amount !== expectedAmountInCents) {
          return res.status(400).send({
            message: "Amount mismatch",
            expected: expectedAmountInCents,
            got: pi.amount,
          });
        }

        // 4) Update parcel -> paid
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentType: "paid",
              paidAt: new Date(),
              transactionId: pi.id,
            },
          },
        );

        // 5) Insert payment history (one per parcel)
        const paymentDoc = {
          parcelId: new ObjectId(parcelId),
          userEmail,
          userName: userName || "",
          parcelName: parcel.parcelTitle,

          amount: pi.amount / 100,
          amountInCents: pi.amount,
          currency: pi.currency,

          provider: "stripe",
          paymentIntentId: pi.id,
          paymentMethod:
            (pi.payment_method_types && pi.payment_method_types[0]) || "card",
          status: pi.status,

          createdAt: new Date(),
        };

        // If you used unique index on parcelId, this prevents duplicates
        await paymentsCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded & parcel marked paid",
          parcelUpdated: updateResult.modifiedCount === 1,
          payment: paymentDoc,
        });
      } catch (err) {
        // Handle duplicate insert (if user calls API twice)
        if (String(err?.code) === "11000") {
          return res
            .status(409)
            .send({ message: "Payment already recorded for this parcel" });
        }
        res.status(500).send({ message: err.message });
      }
    });

    app.post("/riders", verifyFBToken, async (req, res) => {
      // ✅ Add auth
      try {
        const rider = req.body;

        // ✅ Check for duplicates
        const existingPhone = await ridersCollection.findOne({
          phone: rider.phone,
        });
        if (existingPhone) {
          return res.status(409).send({
            message: "Phone number already registered",
          });
        }

        const existingNID = await ridersCollection.findOne({ nid: rider.nid });
        if (existingNID) {
          return res.status(409).send({
            message: "NID already registered",
          });
        }

        const result = await ridersCollection.insertOne(rider);
        res.send(result);
      } catch (err) {
        if (String(err?.code) === "11000") {
          return res.status(409).send({
            message: "Phone or NID already exists",
          });
        }
        console.error("Rider creation error:", err);
        res.status(500).send({ message: err.message });
      }
    });

    // GET /pending-riders - Fetch all pending riders
    app.get("/pending-riders", async (req, res) => {
      try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const riders = await ridersCollection
          .find({ status: "pending" })
          .sort({ createdAtISO: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await ridersCollection.countDocuments({
          status: "pending",
        });

        console.log(`📋 Found ${riders.length} pending riders`);
        res.send({
          riders,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("❌ Pending riders error:", error);
        res.status(500).send({ error: "Failed to fetch riders" });
      }
    });

    // 🔥 APPROVE RIDER - PATCH /riders/:id/approve
    app.patch("/riders/:id/approve", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider ID" });
        }

        // 1) Find the pending rider first
        const rider = await ridersCollection.findOne({
          _id: new ObjectId(id),
          status: "pending",
        });

        if (!rider) {
          return res.status(404).send({
            message: "Rider not found or already processed",
          });
        }

        const email = rider?.createdBy?.email;
        if (!email) {
          return res.status(400).send({ message: "Rider email not found" });
        }

        const now = new Date();

        // 2) Approve rider
        const riderUpdate = await ridersCollection.updateOne(
          { _id: new ObjectId(id), status: "pending" },
          {
            $set: {
              status: "approved",
              approvedAt: now,
            },
          },
        );

        // 3) Update user role by email ✅
        const userUpdate = await usersCollection.updateOne(
          { email },
          {
            $set: {
              role: "rider",
              updatedAt: now,
            },
          },
        );

        if (userUpdate.matchedCount === 0) {
          return res.status(404).send({
            message: `User not found in users collection for email: ${email}`,
          });
        }

        res.send({
          success: true,
          message: "Rider approved & user role updated to rider",
          riderModified: riderUpdate.modifiedCount,
          userMatched: userUpdate.matchedCount,
          userModified: userUpdate.modifiedCount,
        });
      } catch (error) {
        console.error("Approve error:", error);
        res.status(500).send({ message: "Failed to approve rider" });
      }
    });

    // 🔥 REJECT RIDER - PATCH /riders/:id/reject
    app.patch("/riders/:id/reject", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider ID" });
        }

        const result = await ridersCollection.updateOne(
          {
            _id: new ObjectId(id),
            status: "pending", // Only reject pending riders
          },
          {
            $set: {
              status: "rejected",
              rejectedAt: new Date().toISOString(),
            },
          },
        );

        if (result.modifiedCount === 0) {
          return res.status(404).send({
            message: "Rider not found or already processed",
          });
        }

        console.log(`❌ Rider rejected: ${id}`);
        res.json({
          success: true,
          message: "Rider rejected successfully!",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("❌ Reject error:", error);
        res.status(500).json({ error: "Failed to reject rider" });
      }
    });
    // 🔥 GET ACTIVE RIDERS (status: "approved")
    app.get("/active-riders", async (req, res) => {
      try {
        const { page = 1, limit = 10, search = "" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = { status: "approved" };
        if (search) {
          query.$or = [
            { name: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
          ];
        }

        const riders = await ridersCollection
          .find(query)
          .sort({ approvedAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await ridersCollection.countDocuments(query);

        console.log(`📋 Found ${riders.length} active riders`);
        res.send({
          riders,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("Active riders error:", error);
        res.status(500).send({ error: "Failed to fetch active riders" });
      }
    });

    // 🔥 DEACTIVATE RIDER - PATCH /riders/:id/deactivate
    app.patch("/riders/:id/deactivate", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider ID" });
        }

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id), status: "approved" },
          {
            $set: {
              status: "deactivated",
              deactivatedAt: new Date().toISOString(),
            },
          },
        );

        if (result.modifiedCount === 0) {
          return res.status(404).send({ message: "Active rider not found" });
        }

        console.log(`⛔ Rider deactivated: ${id}`);
        res.json({
          success: true,
          message: "Rider deactivated successfully!",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Deactivate error:", error);
        res.status(500).json({ error: "Failed to deactivate rider" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Fast Trust Server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
